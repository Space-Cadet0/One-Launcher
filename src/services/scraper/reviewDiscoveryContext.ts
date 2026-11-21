import type { CriticSource, StorefrontReviewAnchor } from '../../contracts/critic';
import type { CanonicalGame, GamePlatformOwnership } from '../../contracts/game';
import type {
  SearchMatchCandidate,
  ScrapedMetadataBundle,
  ReviewScoreRoute,
} from '../../contracts/override';
import { withTimeoutFallback } from '../../utils/asyncUtils';
import { isTitleCompatible } from '../common/titleMatching';
import { isSequelMismatch } from '../critic/criticUtils';
import { normalizeWikidataGogSlug } from '../critic/wikidataBridge';
import { steamMatcher } from '../steam/steamMatcher';
import { metadataScraperService } from './metadataScraperService';
import type { ReviewCandidateOption } from './reviewCandidateRanker';

export interface ResolvedReviewDiscoveryContext {
  game: CanonicalGame;
  candidate?: SearchMatchCandidate | null;
  scrapedBundle?: ScrapedMetadataBundle | null;
  title: string;
  hasCustomQuery: boolean;
  isDifferentQueryTitle: boolean;
  steamAppId?: number;
  gogId?: string;
  epicId?: string;
  xboxCandidateId?: string;
  xboxPlat?: GamePlatformOwnership;
  releaseYear?: number;
}

export function extractDirectOpenCriticId(rawInput?: string | null): number | null {
  if (!rawInput || typeof rawInput !== 'string') return null;
  const trimmed = rawInput.trim();
  const match = trimmed.match(
    /^(?:https?:\/\/)?(?:www\.)?opencritic\.com\/game\/(\d+)(?:\/[^?#\s]*)?(?:[?#].*)?$/i
  );
  if (!match?.[1]) return null;
  const parsed = Number.parseInt(match[1], 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

export function extractGogSlugCandidate(params: {
  gogId?: string;
  candidateStoreUrl?: string;
  anchorRawStoreUrl?: string;
  availableMetadataSources?: ScrapedMetadataBundle['availableMetadataSources'];
}): string | undefined {
  const fromGogId = normalizeWikidataGogSlug(params.gogId);
  if (fromGogId) return fromGogId;

  const fromCandidateUrl = normalizeWikidataGogSlug(params.candidateStoreUrl);
  if (fromCandidateUrl) return fromCandidateUrl;

  const fromAnchorUrl = normalizeWikidataGogSlug(params.anchorRawStoreUrl);
  if (fromAnchorUrl) return fromAnchorUrl;

  if (Array.isArray(params.availableMetadataSources)) {
    for (const src of params.availableMetadataSources) {
      if (src.source === 'gog') {
        const fromSourceUrl = normalizeWikidataGogSlug(src.storeUrl);
        if (fromSourceUrl) return fromSourceUrl;
        const fromSourceId = normalizeWikidataGogSlug(src.gogId);
        if (fromSourceId) return fromSourceId;
      }
    }
  }

  return undefined;
}

export function getAnchorStoreName(storefront?: StorefrontReviewAnchor['storefront']): string {
  switch (storefront) {
    case 'steam':
      return 'Steam';
    case 'gog':
      return 'GOG';
    case 'xbox':
      return 'Xbox';
    default:
      return 'Epic';
  }
}

export function getCandidateIdForSource(source: CriticSource): string {
  switch (source) {
    case 'metacritic':
      return 'mc-metascore';
    case 'metacritic_user':
      return 'mc-userscore';
    case 'steam':
      return 'steam-community';
    case 'gog':
      return 'gog-stars';
    case 'epic':
      return 'epic-stars';
    case 'xbox':
      return 'xbox-stars';
    default:
      return 'opencritic';
  }
}

/**
 * Returns user-friendly source label for display in UI options.
 */
export function getSourceLabel(source: CriticSource, isActiveOverride = false): string {
  if (isActiveOverride) {
    return source === 'custom' ? 'Current Custom Override' : 'Current Active Override';
  }
  switch (source) {
    case 'metacritic':
      return 'Metacritic Metascore';
    case 'metacritic_user':
      return 'Metacritic User Score';
    case 'opencritic':
      return 'OpenCritic';
    case 'steam':
      return 'Steam Community Reviews';
    case 'gog':
      return 'GOG Star Rating';
    case 'epic':
      return 'Epic Games Rating';
    case 'xbox':
      return 'Xbox Store Rating';
    case 'custom':
      return 'Custom Score';
    default:
      return 'Critic Review';
  }
}

/**
 * Returns badge descriptor text for UI presentation.
 */
export function getBadgeText(
  source: CriticSource,
  isVerified: boolean,
  isSynthetic?: boolean
): string {
  if (isVerified) return 'Verified Press Consensus';
  if (isSynthetic || source === 'steam' || source === 'metacritic_user') {
    return 'Player Community Sentiment';
  }
  if (source === 'gog' || source === 'epic' || source === 'xbox') return 'Storefront Rating';
  return 'Review Score';
}

/**
 * Builds a structured ReviewScoreRoute for a review candidate option.
 */
export function buildCandidateRoute(
  opt: ReviewCandidateOption,
  ctx: {
    title: string;
    steamAppId?: number;
    gogId?: string;
    epicId?: string;
    xboxProductId?: string;
    anchor?: StorefrontReviewAnchor | null;
  }
): ReviewScoreRoute {
  if (opt.source === 'custom') {
    return {
      mode: 'static',
      source: 'custom',
      url: opt.url,
      targetTitle: ctx.title,
    };
  }
  const urlXboxBigId = opt.url
    ?.match(/xbox\.com\/(?:[a-z]{2}-[a-z]{2}\/)?games\/store\/[^/]+\/([A-Z0-9]{12})/i)?.[1]
    ?.toUpperCase();
  const idXboxBigId = /^xbox-([A-Z0-9]{12})$/i.test(opt.id)
    ? opt.id.replace(/^xbox-/i, '').toUpperCase()
    : undefined;
  return {
    mode: 'routed',
    source: opt.source,
    url: opt.url,
    metacriticSlug:
      opt.url?.match(/metacritic\.com\/game\/(?:pc\/)?([^/?#]+)/i)?.[1] ||
      ctx.anchor?.metacriticSlug,
    openCriticId:
      Number(opt.url?.match(/opencritic\.com\/game\/(\d+)/i)?.[1] || 0) ||
      ctx.anchor?.openCriticId ||
      undefined,
    steamAppId:
      Number(opt.url?.match(/store\.steampowered\.com\/app\/(\d+)/i)?.[1] || 0) ||
      ctx.steamAppId,
    gogId: ctx.gogId ? String(ctx.gogId) : undefined,
    epicId: ctx.epicId ? String(ctx.epicId) : undefined,
    xboxProductId: urlXboxBigId || idXboxBigId || ctx.xboxProductId || undefined,
    targetTitle: ctx.title,
  };
}

/**
 * Resolves storefront IDs, query flags, and release year for a review discovery session.
 */
export async function resolveReviewDiscoveryContext(
  game: CanonicalGame,
  candidate?: SearchMatchCandidate | null,
  scrapedBundle?: ScrapedMetadataBundle | null,
  customSearchQuery?: string
): Promise<ResolvedReviewDiscoveryContext> {
  const hasCustomQuery = Boolean(customSearchQuery && customSearchQuery.trim());
  const title = (
    customSearchQuery?.trim() ||
    scrapedBundle?.title ||
    candidate?.title ||
    game.title ||
    ''
  ).trim();
  const isDifferentQueryTitle =
    hasCustomQuery && title.toLowerCase() !== (game.title || '').trim().toLowerCase();

  let steamAppId: number | undefined;
  if (isDifferentQueryTitle) {
    const instantId = steamMatcher.matchGameToSteamInstant(title);
    if (typeof instantId === 'number' && instantId > 0) {
      steamAppId = instantId;
    } else {
      const steamSearchResults = await withTimeoutFallback(
        metadataScraperService.searchStorefronts(title, 'steam'),
        3500,
        []
      );
      const topSteam = steamSearchResults.find(
        (c) =>
          typeof c.steamAppId === 'number' &&
          c.steamAppId > 0 &&
          !isSequelMismatch(title, c.title) &&
          isTitleCompatible(title, c.title)
      );
      if (topSteam?.steamAppId) {
        steamAppId = topSteam.steamAppId;
      }
    }
  } else {
    if (typeof scrapedBundle?.steamAppId === 'number' && scrapedBundle.steamAppId > 0) {
      steamAppId = scrapedBundle.steamAppId;
    } else {
      const crossSteamSource = scrapedBundle?.availableMetadataSources?.find(
        (s) => s.source === 'steam' && typeof s.steamAppId === 'number' && s.steamAppId > 0
      );
      if (crossSteamSource?.steamAppId) {
        steamAppId = crossSteamSource.steamAppId;
      } else if (
        typeof scrapedBundle?.metadataRoute?.steamAppId === 'number' &&
        scrapedBundle.metadataRoute.steamAppId > 0
      ) {
        steamAppId = scrapedBundle.metadataRoute.steamAppId;
      } else if (typeof candidate?.steamAppId === 'number' && candidate.steamAppId > 0) {
        steamAppId = candidate.steamAppId;
      } else if (typeof game.steamAppId === 'number' && game.steamAppId > 0) {
        steamAppId = game.steamAppId;
      } else {
        const steamPlat = game.platforms?.find(
          (p) => p.platformId === 'steam' && p.platformGameId
        );
        if (steamPlat) {
          const parsed = parseInt(steamPlat.platformGameId, 10);
          if (!isNaN(parsed) && parsed > 0) steamAppId = parsed;
        }
      }

      if (!steamAppId && title) {
        const instantId = steamMatcher.matchGameToSteamInstant(title);
        if (typeof instantId === 'number' && instantId > 0) {
          steamAppId = instantId;
        }
      }

      if (!steamAppId && hasCustomQuery && title) {
        const steamSearchResults = await withTimeoutFallback(
          metadataScraperService.searchStorefronts(title, 'steam'),
          3500,
          []
        );
        const topSteam = steamSearchResults.find(
          (c) =>
            typeof c.steamAppId === 'number' &&
            c.steamAppId > 0 &&
            !isSequelMismatch(title, c.title) &&
            isTitleCompatible(title, c.title)
        );
        if (topSteam?.steamAppId) {
          steamAppId = topSteam.steamAppId;
        }
      }
    }
  }

  const gogPlat = game.platforms?.find(
    (p) => p.platformId === 'gog' || p.platformId?.toLowerCase() === 'gog'
  );
  const gogId = isDifferentQueryTitle
    ? undefined
    : candidate?.gogId
    ? String(candidate.gogId)
    : (scrapedBundle?.matchedStore === 'gog' ? String(scrapedBundle.matchedId) : undefined) ||
      scrapedBundle?.metadataRoute?.gogId ||
      gogPlat?.platformGameId ||
      (game.id?.startsWith('gog-') ? game.id.replace('gog-', '') : undefined);

  const epicPlat = game.platforms?.find(
    (p) => p.platformId === 'epic' || p.platformId?.toLowerCase() === 'epic'
  );
  const epicId = isDifferentQueryTitle
    ? undefined
    : (scrapedBundle?.matchedStore === 'epic' ? String(scrapedBundle.matchedId) : undefined) ||
      epicPlat?.platformGameId ||
      (game.id?.startsWith('epic-') ? game.id.replace('epic-', '') : undefined);

  const xboxPlat = game.platforms?.find((p) => p.platformId === 'xbox');
  const xboxCandidateId = !isDifferentQueryTitle
    ? (candidate?.source === 'xbox' ||
      String(candidate?.id || '').toLowerCase().startsWith('xbox-')
        ? String(candidate?.id || '').replace(/^xbox-/i, '') || undefined
        : undefined) ||
      (scrapedBundle?.matchedStore === 'xbox' ||
      String(scrapedBundle?.matchedId || '').toLowerCase().startsWith('xbox-')
        ? String(scrapedBundle?.matchedId || '').replace(/^xbox-/i, '') || undefined
        : undefined) ||
      (scrapedBundle?.metadataRoute?.matchedId &&
      (scrapedBundle.metadataRoute.source === 'custom' ||
        scrapedBundle.metadataRoute.source === 'xbox') &&
      /^[A-Z0-9]{12}$/i.test(String(scrapedBundle.metadataRoute.matchedId))
        ? String(scrapedBundle.metadataRoute.matchedId).toUpperCase()
        : undefined) ||
      xboxPlat?.xboxProductId ||
      (/^[A-Z0-9]{12}$/i.test(String(xboxPlat?.platformGameId || '').trim())
        ? String(xboxPlat?.platformGameId).trim().toUpperCase()
        : undefined)
    : undefined;

  let releaseYear: number | undefined;
  const yearCandidate = isDifferentQueryTitle
    ? undefined
    : scrapedBundle?.releaseDate || candidate?.year || game.releaseDate;
  if (yearCandidate) {
    const m = String(yearCandidate).match(/\b(19\d\d|20\d\d)\b/);
    if (m) releaseYear = parseInt(m[1], 10);
  }

  return {
    game,
    candidate,
    scrapedBundle,
    title,
    hasCustomQuery,
    isDifferentQueryTitle,
    steamAppId,
    gogId,
    epicId,
    xboxCandidateId,
    xboxPlat,
    releaseYear,
  };
}
