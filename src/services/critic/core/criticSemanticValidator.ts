import type { CriticScoreData } from '../../../contracts/critic';
import { isGogStoreUrl } from '../../common/storeUrlUtils';
import {
  hasExplicitClassicOrOriginalEditionTag,
  isTitleCompatible,
} from '../../common/titleMatching';
import {
  extractParentheticalReleaseYear,
  extractTrailingDelimitedReleaseYear,
} from '../../common/titleUtils';
import { isSequelMismatch, normalizeCriticTitleKey } from '../criticUtils';
import { KNOWN_CRITIC_SCORES, KNOWN_UNRATED_TITLES } from '../knownCriticScores';
import {
  isAnchorMatch,
  isAnchorSlugCompatible,
} from '../metacritic/metacriticTitleMatching';
import {
  hasConflictingColonSpinoffInDescription,
  sanitizeMetacriticDescription,
} from '../metacritic/metacriticYearGuard';
import { extractMetacriticSlugFromUrl } from '../storefrontReviewHarvester';
import { wikidataBridge } from '../wikidataBridge';
import {
  NON_GAME_ADDON_OR_BETA_REGEX,
  STEAM_ENRICHED_CRITIC_MAP,
  hasAnyKnownCriticScore,
  hasAnySteamEnrichedCriticEntry,
} from './criticServiceTypes';

/**
 * Universal semantic compatibility validator for cached or candidate critic scores.
 * Memoizes validation outcomes per `CriticScoreData` object reference (`WeakMap`) so hot-path
 * cache hits run in O(1) without repeating regex/slug/summary passes.
 */
export function validateScoreSemanticCompatibilityWithMemo(
  memo: WeakMap<CriticScoreData, Map<string, boolean>>,
  rawTitle: string,
  scoreData: CriticScoreData | null | undefined,
  steamAppId?: number | null,
  verifiedAnchorSlug?: string | null
): boolean {
  if (!scoreData || typeof scoreData.score !== 'number' || scoreData.score <= 0) return false;

  const memoKey = `${steamAppId ?? ''}|${verifiedAnchorSlug ?? ''}|${rawTitle}`;
  let byQuery = memo.get(scoreData);
  if (byQuery && byQuery.has(memoKey)) {
    return byQuery.get(memoKey)!;
  }

  const recordValidation = (valid: boolean): boolean => {
    if (!byQuery) {
      byQuery = new Map<string, boolean>();
      memo.set(scoreData, byQuery);
    } else if (byQuery.size >= 32) {
      const oldest = byQuery.keys().next().value;
      if (oldest !== undefined) byQuery.delete(oldest);
    }
    byQuery.set(memoKey, valid);
    return valid;
  };

  const isNonGameAddonOrBeta = NON_GAME_ADDON_OR_BETA_REGEX.test(rawTitle);
  if (isNonGameAddonOrBeta && !scoreData.isSynthetic) {
    return recordValidation(false);
  }
  if (rawTitle && KNOWN_UNRATED_TITLES.size > 0 && !scoreData.isSynthetic) {
    if (
      KNOWN_UNRATED_TITLES.has(rawTitle.toLowerCase().trim()) ||
      KNOWN_UNRATED_TITLES.has(normalizeCriticTitleKey(rawTitle))
    ) {
      return recordValidation(false);
    }
  }
  if (scoreData.source === 'steam' && scoreData.url?.includes('/search/?term=') && !steamAppId) {
    return recordValidation(false);
  }
  if (scoreData.source === 'opencritic' && isGogStoreUrl(scoreData.url) && steamAppId) {
    return recordValidation(false);
  }

  if (scoreData.url && rawTitle) {
    const slugMatch = scoreData.url.match(/\/game\/(?:[0-9]+\/)?([^\/?#]+)/);
    const slug = slugMatch ? slugMatch[1] : '';
    if (slug && !(scoreData.source === 'opencritic' && slug.toLowerCase() === 'game')) {
      const compatQueryTitle =
        scoreData.source === 'gog' ? rawTitle.replace(/\bplus\b/gi, '').trim() || rawTitle : rawTitle;
      const parenYear = extractParentheticalReleaseYear(rawTitle);
      const trailingDelimYear = extractTrailingDelimitedReleaseYear(rawTitle);
      const buildSlugTitles = (rawSlug: string): { fullTitle: string; strippedTitle: string } => {
        const fullTitle = rawSlug.replace(/[_-]/g, ' ').trim();
        const trailingYearMatch = rawSlug.match(/^(.*)[-_]((?:19|20)\d{2})$/);
        if (!trailingYearMatch || !trailingYearMatch[1]) {
          return { fullTitle, strippedTitle: fullTitle };
        }
        const trailingYear = trailingYearMatch[2];
        const yearPresentInTitle = new RegExp(`\\b${trailingYear}\\b`).test(rawTitle);
        const shouldStrip =
          (parenYear !== null && String(parenYear) === trailingYear) ||
          (trailingDelimYear !== null && String(trailingDelimYear) === trailingYear) ||
          !yearPresentInTitle;
        const strippedTitle = shouldStrip
          ? trailingYearMatch[1].replace(/[_-]/g, ' ').trim()
          : fullTitle;
        return { fullTitle, strippedTitle };
      };

      if (scoreData.source === 'gog') {
        const nonGameGog = /\b(demo|prologue|soundtrack|ost|artbook|dlc|upgrade|walkthrough)\b/i;
        if (nonGameGog.test(slug.replace(/_/g, ' ')) && !nonGameGog.test(rawTitle)) {
          return recordValidation(false);
        }
        const gogTitles = buildSlugTitles(slug);
        const gogVariants = Array.from(new Set([gogTitles.strippedTitle, gogTitles.fullTitle]));
        const gogCompatible = gogVariants.some(
          (gt) =>
            !isSequelMismatch(compatQueryTitle, gt) &&
            isTitleCompatible(compatQueryTitle, gt) &&
            isTitleCompatible(gt, compatQueryTitle)
        );
        if (!gogCompatible) {
          return recordValidation(false);
        }
      }

      const normalizedSlug = !/\b(season|episode)\b/i.test(rawTitle)
        ? slug.replace(/-episode-(?:1|one)\b.*$/i, '')
        : slug;
      const { fullTitle: fullSlugTitle, strippedTitle: slugTitle } = buildSlugTitles(normalizedSlug);

      let corroboratedMcAnchorSlug: string | undefined = verifiedAnchorSlug || undefined;
      if (!corroboratedMcAnchorSlug && scoreData.source === 'metacritic') {
        const wdCachedSlug = wikidataBridge.getCachedLinks({
          steamAppId,
          title: rawTitle,
        })?.metacriticSlug;
        if (wdCachedSlug) {
          corroboratedMcAnchorSlug = wdCachedSlug;
        } else if (steamAppId) {
          const enrichedMcUrl = hasAnySteamEnrichedCriticEntry()
            ? STEAM_ENRICHED_CRITIC_MAP[String(steamAppId)]?.metacritic?.url
            : undefined;
          const enrichedSlug = extractMetacriticSlugFromUrl(enrichedMcUrl);
          if (enrichedSlug) {
            corroboratedMcAnchorSlug = enrichedSlug;
          } else if (hasAnyKnownCriticScore()) {
            const knownEntry = KNOWN_CRITIC_SCORES[steamAppId];
            if (knownEntry?.source === 'metacritic' && knownEntry.url) {
              corroboratedMcAnchorSlug = extractMetacriticSlugFromUrl(knownEntry.url);
            }
          }
        }
      }

      const isVerifiedMetacriticAnchor = Boolean(
        scoreData.source === 'metacritic' &&
          scoreData.isVerified &&
          isAnchorSlugCompatible(rawTitle, slug) &&
          (scoreData.summary?.includes('store review anchor') ||
            (corroboratedMcAnchorSlug && isAnchorMatch(slug, corroboratedMcAnchorSlug)))
      );

      const isVerifiedStoreAnchor =
        isVerifiedMetacriticAnchor ||
        Boolean(
          scoreData.summary?.includes('store review anchor') && isAnchorSlugCompatible(rawTitle, slug)
        );

      const asciiProjectedQueryTitle =
        scoreData.source === 'opencritic'
          ? compatQueryTitle.replace(/[^\x00-\x7f]+/g, ' ').replace(/\s+/g, ' ').trim()
          : '';

      const slugTitleVariants = Array.from(
        new Set([
          slugTitle,
          fullSlugTitle,
          slugTitle.replace(/^([a-z0-9]+)\s+(a|an|the)\s+/i, '$1: $2 '),
          fullSlugTitle.replace(/^([a-z0-9]+)\s+(a|an|the)\s+/i, '$1: $2 '),
        ])
      );

      const passesSequelCheck =
        isVerifiedStoreAnchor ||
        slugTitleVariants.some((st) => !isSequelMismatch(compatQueryTitle, st)) ||
        Boolean(
          asciiProjectedQueryTitle &&
            asciiProjectedQueryTitle !== compatQueryTitle &&
            slugTitleVariants.some((st) => !isSequelMismatch(asciiProjectedQueryTitle, st))
        );
      if (!passesSequelCheck) {
        return recordValidation(false);
      }

      const passesTitleCompatibility =
        isVerifiedStoreAnchor ||
        slugTitleVariants.some((st) => isTitleCompatible(compatQueryTitle, st)) ||
        Boolean(
          asciiProjectedQueryTitle &&
            asciiProjectedQueryTitle !== compatQueryTitle &&
            slugTitleVariants.some((st) => isTitleCompatible(asciiProjectedQueryTitle, st))
        );

      if (!passesTitleCompatibility) {
        return recordValidation(false);
      }

      // Guard against explicit first-installment or retro classic matching an unnumbered modern reboot
      const titleNoYear = rawTitle.replace(/\s*\((?:19|20)\d{2}\)/g, '').trim();
      const isFirstInstallment = /\b(?:1|i)\b/i.test(titleNoYear) && !/\b(?:1|i)\b/i.test(slugTitle);
      const isExplicitRetro =
        (hasExplicitClassicOrOriginalEditionTag(titleNoYear) ||
          /\b(plus|dos)\b/i.test(titleNoYear)) &&
        !/\b(classic|original|plus|dos)\b/i.test(slugTitle);

      if (
        (isFirstInstallment || isExplicitRetro) &&
        (scoreData.source === 'opencritic' ||
          /[-_](200[89]|201\d|202\d)$/.test(slug) ||
          /\b(reimagination|reimagining|remake of the|modern reboot|reboot of the|completely remastered|playstation 5|xbox series)\b/i.test(
            scoreData.summary || ''
          ))
      ) {
        return recordValidation(false);
      }

      // Guard against franchise spinoff subtitle collisions on base-title review URLs
      if (hasConflictingColonSpinoffInDescription(rawTitle, titleNoYear, scoreData.summary)) {
        return recordValidation(false);
      }
    }
  }

  if (scoreData.summary && scoreData.source === 'metacritic') {
    scoreData.summary = sanitizeMetacriticDescription(scoreData.summary, scoreData.numReviews || 20);
  }
  return recordValidation(true);
}
