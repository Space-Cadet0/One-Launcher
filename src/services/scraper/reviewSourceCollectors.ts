import {
  CRITIC_STORAGE_PREFIX,
  type CriticScoreData,
  type CriticSource,
  type StorefrontReviewAnchor,
} from '../../contracts/critic';
import { withTimeoutFallback } from '../../utils/asyncUtils';
import { isXboxStoreUrl } from '../common/storeUrlUtils';
import { extractParentheticalReleaseYear } from '../common/titleUtils';
import {
  calculateSyntheticSteamScore,
  calculateTier,
  normalizeCriticTitleKey,
  stripEditionSuffix,
} from '../critic/criticUtils';
import { KNOWN_CRITIC_SCORES } from '../critic/knownCriticScores';
import { metacriticResolver } from '../critic/metacriticResolver';
import { openCriticResolver } from '../critic/openCriticResolver';
import { steamReviewResolver } from '../critic/steamReviewResolver';
import { storefrontReviewHarvester } from '../critic/storefrontReviewHarvester';
import { storefrontStarResolver } from '../critic/storefrontStarResolver';
import { wikidataBridge } from '../critic/wikidataBridge';
import { Priority } from '../network/requestScheduler';
import { loadStagedCache } from '../storage/stagedCacheService';
import steamEnrichedCache from '../storage/steamEnrichedCache.json';
import { loadUserOverrides, getUserOverrideForGame } from '../storage/userOverrideStorage';
import type { ReviewCandidateOption } from './reviewCandidateRanker';
import {
  type ResolvedReviewDiscoveryContext,
  buildCandidateRoute,
  extractGogSlugCandidate,
  getAnchorStoreName,
  getBadgeText,
  getCandidateIdForSource,
  getSourceLabel,
} from './reviewDiscoveryContext';

interface SteamEnrichedReviewEntry {
  reviewSummary?: {
    positivePercent?: number;
    totalReviews?: number;
  };
}

const STEAM_ENRICHED_REVIEW_MAP: Record<string, SteamEnrichedReviewEntry> =
  steamEnrichedCache || {};

export interface MetacriticFetchResult {
  critic: ReviewCandidateOption | null;
  user: ReviewCandidateOption | null;
  replacesAnchorMetacritic?: boolean;
}

/**
 * Resolves a direct OpenCritic URL/ID custom search query.
 */
export async function resolveDirectOpenCriticCandidate(
  directOpenCriticId: number,
  targetTitle: string
): Promise<ReviewCandidateOption | null> {
  const ocData = await withTimeoutFallback(
    openCriticResolver.resolveById(directOpenCriticId, {
      priority: Priority.P0_INTERACTIVE,
      bypassCache: true,
    }),
    7500,
    null
  );
  if (!ocData || typeof ocData.score !== 'number' || ocData.score <= 0) {
    return null;
  }
  const option: ReviewCandidateOption = {
    id: 'opencritic',
    source: 'opencritic',
    sourceLabel: 'OpenCritic',
    score: ocData.score,
    tier: ocData.tier || calculateTier(ocData.score, ocData.percentRecommended),
    percentRecommended: ocData.percentRecommended,
    numReviews: ocData.numReviews,
    url: ocData.url || `https://opencritic.com/game/${directOpenCriticId}/game`,
    summary: ocData.summary,
    isVerified: true,
    badgeText: 'Verified Press Consensus',
  };
  return {
    ...option,
    reviewRoute: buildCandidateRoute(option, {
      title: targetTitle,
    }),
  };
}

/**
 * Step A: Instant Local & Cached Collection (0ms, 0 network requests).
 */
export function collectLocalReviewCandidates(
  ctx: ResolvedReviewDiscoveryContext
): ReviewCandidateOption[] {
  const candidates: ReviewCandidateOption[] = [];

  // 1. Active reviewScoreOverride on game or user overrides storage (skip if custom query for different title)
  if (!ctx.isDifferentQueryTitle) {
    let activeOverride: CriticScoreData | null | undefined = ctx.game.reviewScoreOverride;
    if (activeOverride === undefined) {
      try {
        const overrides = loadUserOverrides();
        const matching = getUserOverrideForGame(ctx.game, overrides);
        if (matching?.reviewScoreOverride !== undefined) {
          activeOverride = matching.reviewScoreOverride;
        }
      } catch {
        // Ignore storage read errors in restricted environments
      }
    }

    if (activeOverride && typeof activeOverride.score === 'number' && activeOverride.score > 0) {
      candidates.push({
        id: 'active-override',
        source: activeOverride.source,
        sourceLabel: getSourceLabel(activeOverride.source, true),
        score: activeOverride.score,
        tier: activeOverride.tier || calculateTier(activeOverride.score, activeOverride.percentRecommended),
        url: activeOverride.url,
        summary: activeOverride.summary,
        numReviews: activeOverride.numReviews,
        userScoreRaw: activeOverride.userScoreRaw,
        starRatingRaw: activeOverride.starRatingRaw,
        percentRecommended: activeOverride.percentRecommended,
        isVerified: Boolean(activeOverride.isVerified),
        isSynthetic: Boolean(activeOverride.isSynthetic),
        badgeText: activeOverride.source === 'custom' ? 'Custom Override' : 'Active Override',
      });
    }
  }

  // 2. Check KNOWN_CRITIC_SCORES by steamAppId and normalized title keys (O(1) empty guard)
  const lowerTitle = ctx.title.toLowerCase().trim();
  if (Object.keys(KNOWN_CRITIC_SCORES).length > 0) {
    const normKey = normalizeCriticTitleKey(ctx.title);
    const strippedKey = stripEditionSuffix(ctx.title);

    let knownMatch: CriticScoreData | undefined;
    if (ctx.steamAppId && KNOWN_CRITIC_SCORES[ctx.steamAppId]) {
      knownMatch = KNOWN_CRITIC_SCORES[ctx.steamAppId];
    } else if (lowerTitle && KNOWN_CRITIC_SCORES[lowerTitle]) {
      knownMatch = KNOWN_CRITIC_SCORES[lowerTitle];
    } else if (normKey && KNOWN_CRITIC_SCORES[normKey]) {
      knownMatch = KNOWN_CRITIC_SCORES[normKey];
    } else if (strippedKey && strippedKey !== normKey && KNOWN_CRITIC_SCORES[strippedKey]) {
      knownMatch = KNOWN_CRITIC_SCORES[strippedKey];
    }

    if (knownMatch && typeof knownMatch.score === 'number' && knownMatch.score > 0) {
      candidates.push({
        id: getCandidateIdForSource(knownMatch.source),
        source: knownMatch.source,
        sourceLabel: getSourceLabel(knownMatch.source),
        score: knownMatch.score,
        tier: knownMatch.tier || calculateTier(knownMatch.score, knownMatch.percentRecommended),
        url: knownMatch.url,
        summary: knownMatch.summary,
        numReviews: knownMatch.numReviews,
        userScoreRaw: knownMatch.userScoreRaw,
        starRatingRaw: knownMatch.starRatingRaw,
        percentRecommended: knownMatch.percentRecommended,
        isVerified: Boolean(knownMatch.isVerified),
        isSynthetic: Boolean(knownMatch.isSynthetic),
        badgeText: getBadgeText(
          knownMatch.source,
          Boolean(knownMatch.isVerified),
          knownMatch.isSynthetic
        ),
      });
    }
  }

  // 3. Check stagedCacheService for cached score using canonical CRITIC_STORAGE_PREFIX
  const cacheKey = ctx.steamAppId ? `id:${ctx.steamAppId}` : `title:${lowerTitle}`;
  const stagedKey = `${CRITIC_STORAGE_PREFIX}${cacheKey}`;
  try {
    const staged = loadStagedCache<CriticScoreData>(stagedKey, false);
    if (staged.data && typeof staged.data.score === 'number' && staged.data.score > 0) {
      const data = staged.data;
      candidates.push({
        id: getCandidateIdForSource(data.source),
        source: data.source,
        sourceLabel: getSourceLabel(data.source),
        score: data.score,
        tier: data.tier || calculateTier(data.score, data.percentRecommended),
        url: data.url,
        summary: data.summary,
        numReviews: data.numReviews,
        userScoreRaw: data.userScoreRaw,
        starRatingRaw: data.starRatingRaw,
        percentRecommended: data.percentRecommended,
        isVerified: Boolean(data.isVerified),
        isSynthetic: Boolean(data.isSynthetic),
        badgeText: getBadgeText(data.source, Boolean(data.isVerified), data.isSynthetic),
      });
    }
  } catch {
    // Ignore storage read errors in restricted environments
  }

  return candidates;
}

/**
 * Step B: Resolves Storefront Ground Truth Anchor (zero wait if already present on scrapedBundle).
 */
export async function resolveStorefrontAnchor(
  ctx: ResolvedReviewDiscoveryContext
): Promise<StorefrontReviewAnchor | null> {
  if (!ctx.isDifferentQueryTitle && ctx.scrapedBundle?.storefrontAnchor) {
    return ctx.scrapedBundle.storefrontAnchor;
  }
  return withTimeoutFallback(
    storefrontReviewHarvester.getStorefrontAnchor({
      title: ctx.title,
      steamAppId: ctx.steamAppId,
      platforms: ctx.isDifferentQueryTitle ? undefined : ctx.game.platforms,
      id: ctx.isDifferentQueryTitle ? undefined : ctx.game.id,
    }),
    4000,
    null
  );
}

/**
 * Converts a resolved StorefrontReviewAnchor into verified review candidates.
 */
export function buildAnchorReviewCandidates(
  anchor: StorefrontReviewAnchor | null | undefined
): ReviewCandidateOption[] {
  if (!anchor) return [];
  const candidates: ReviewCandidateOption[] = [];
  const storeName = getAnchorStoreName(anchor.storefront);

  if (typeof anchor.metacriticScore === 'number' && anchor.metacriticScore > 0) {
    const mcUrl =
      anchor.metacriticUrl ||
      (anchor.metacriticSlug
        ? `https://www.metacritic.com/game/${anchor.metacriticSlug}/critic-reviews/`
        : undefined);

    candidates.push({
      id: 'anchor-metacritic',
      source: 'metacritic',
      sourceLabel: 'Metacritic Metascore',
      score: anchor.metacriticScore,
      tier: calculateTier(anchor.metacriticScore),
      url: mcUrl,
      summary: `Verified by official ${storeName} store review anchor.`,
      isVerified: true,
      isRecommended: true,
      badgeText: 'Verified Press Consensus',
      groundTruthSource: `Verified by ${storeName} Store Link`,
    });
  }

  if (typeof anchor.openCriticScore === 'number' && anchor.openCriticScore > 0) {
    const ocUrl =
      anchor.openCriticUrl ||
      (anchor.openCriticId ? `https://opencritic.com/game/${anchor.openCriticId}` : undefined) ||
      anchor.rawStoreUrl;

    candidates.push({
      id: 'anchor-opencritic',
      source: 'opencritic',
      sourceLabel: 'OpenCritic',
      score: anchor.openCriticScore,
      tier: calculateTier(anchor.openCriticScore),
      url: ocUrl,
      summary: `Verified by official ${storeName} store review anchor.`,
      isVerified: true,
      isRecommended: true,
      badgeText: 'Verified Press Consensus',
      groundTruthSource: `Verified by ${storeName} Store Link`,
    });
  }

  return candidates;
}

/**
 * Live Metacritic collector — pure and race-free (signals anchor replacement via return value
 * instead of mutating shared candidate arrays during concurrent execution).
 */
export async function fetchMetacriticReviewCandidates(
  ctx: ResolvedReviewDiscoveryContext,
  anchor: StorefrontReviewAnchor | null
): Promise<MetacriticFetchResult> {
  if (!ctx.title) return { critic: null, user: null };
  try {
    const bundle = await metacriticResolver.resolveMetacritic(
      ctx.title,
      ctx.releaseYear,
      anchor,
      Priority.P0_INTERACTIVE
    );

    let criticOption: ReviewCandidateOption | null = null;
    let userOption: ReviewCandidateOption | null = null;
    let replacesAnchorMetacritic = false;

    if (bundle?.critic && typeof bundle.critic.score === 'number' && bundle.critic.score > 0) {
      const titleParenYear = extractParentheticalReleaseYear(ctx.title);
      const titleParenYearStr = titleParenYear !== null ? String(titleParenYear) : null;
      const resolvedYearSuffixedSlug = Boolean(
        titleParenYearStr &&
          anchor?.metacriticSlug &&
          !anchor.metacriticSlug.endsWith(titleParenYearStr) &&
          bundle.critic.url?.includes(`${anchor.metacriticSlug}-${titleParenYearStr}`)
      );

      const isSameScoreAsAnchor = Boolean(
        anchor?.metacriticSlug &&
          (!anchor?.metacriticScore || anchor.metacriticScore === bundle.critic.score)
      );
      const isAnchorLinked = isSameScoreAsAnchor || resolvedYearSuffixedSlug;
      const storeName = getAnchorStoreName(anchor?.storefront);

      if (resolvedYearSuffixedSlug) {
        replacesAnchorMetacritic = true;
      }

      criticOption = {
        id: isAnchorLinked ? 'anchor-metacritic' : 'mc-metascore',
        source: 'metacritic',
        sourceLabel: 'Metacritic Metascore',
        score: bundle.critic.score,
        tier: bundle.critic.tier || calculateTier(bundle.critic.score),
        url: bundle.critic.url,
        summary: bundle.critic.summary,
        numReviews: bundle.critic.numReviews,
        isVerified: true,
        isRecommended: isAnchorLinked,
        badgeText: 'Verified Press Consensus',
        groundTruthSource:
          isAnchorLinked && anchor ? `Verified by ${storeName} Store Link` : undefined,
      };
    }

    if (bundle?.user && typeof bundle.user.score === 'number' && bundle.user.score > 0) {
      const rawScore =
        bundle.user.userScoreRaw ?? Math.round((bundle.user.score / 10) * 10) / 10;

      userOption = {
        id: 'mc-userscore',
        source: 'metacritic_user',
        sourceLabel: 'Metacritic User Score',
        score: bundle.user.score,
        userScoreRaw: rawScore,
        tier: bundle.user.tier || calculateTier(bundle.user.score),
        url: bundle.user.url,
        summary:
          bundle.user.summary ||
          `Metacritic player user score (${rawScore}/10 based on ${bundle.user.numReviews || 'multiple'} ratings).`,
        numReviews: bundle.user.numReviews,
        isVerified: false,
        badgeText: 'Player Community Sentiment',
      };
    }

    return { critic: criticOption, user: userOption, replacesAnchorMetacritic };
  } catch {
    return { critic: null, user: null };
  }
}

/**
 * Live OpenCritic collector (Wikidata CC0 P2864 bridge + OpenCritic SSR resolver).
 */
export async function fetchOpenCriticReviewCandidate(
  ctx: ResolvedReviewDiscoveryContext,
  anchor: StorefrontReviewAnchor | null
): Promise<ReviewCandidateOption | null> {
  if (!ctx.title) return null;
  try {
    let resolvedOpenCriticId: number | undefined =
      typeof anchor?.openCriticId === 'number' && anchor.openCriticId > 0
        ? anchor.openCriticId
        : undefined;
    const isAnchorId = resolvedOpenCriticId !== undefined;

    if (resolvedOpenCriticId === undefined) {
      const gogSlug = extractGogSlugCandidate({
        gogId: ctx.gogId,
        candidateStoreUrl: ctx.candidate?.storeUrl,
        anchorRawStoreUrl: anchor?.rawStoreUrl,
        availableMetadataSources: ctx.scrapedBundle?.availableMetadataSources,
      });
      const wikidataLinks = await wikidataBridge.resolveForGame({
        steamAppId: ctx.steamAppId,
        gogSlug,
        title: ctx.title,
        releaseYear: ctx.releaseYear,
        priority: Priority.P0_INTERACTIVE,
      });
      if (
        typeof wikidataLinks?.openCriticId === 'number' &&
        wikidataLinks.openCriticId > 0
      ) {
        resolvedOpenCriticId = wikidataLinks.openCriticId;
      }
    }

    if (resolvedOpenCriticId === undefined) {
      return null;
    }

    const ocData = await openCriticResolver.resolveById(resolvedOpenCriticId, {
      expectedTitle: ctx.title,
      releaseYear: ctx.releaseYear,
      priority: Priority.P0_INTERACTIVE,
      isVerifiedAnchor: isAnchorId,
      anchorScore: isAnchorId ? anchor?.openCriticScore : undefined,
      anchorStorefront: isAnchorId ? anchor?.storefront : undefined,
      anchorUrl: isAnchorId ? anchor?.openCriticUrl : undefined,
      bypassCache: true,
    });

    if (!ocData || typeof ocData.score !== 'number' || ocData.score <= 0) {
      return null;
    }

    const isAnchorMatched = Boolean(
      anchor?.openCriticScore ||
        (anchor?.openCriticId && anchor.openCriticId === resolvedOpenCriticId)
    );
    const storeName = getAnchorStoreName(anchor?.storefront);

    return {
      id: isAnchorMatched ? 'anchor-opencritic' : 'opencritic',
      source: 'opencritic',
      sourceLabel: 'OpenCritic',
      score: ocData.score,
      tier: ocData.tier || calculateTier(ocData.score, ocData.percentRecommended),
      percentRecommended: ocData.percentRecommended,
      numReviews: ocData.numReviews,
      url:
        ocData.url ||
        anchor?.openCriticUrl ||
        `https://opencritic.com/game/${resolvedOpenCriticId}/game`,
      summary:
        ocData.summary ||
        (isAnchorMatched && anchor
          ? `Verified by official ${storeName} store review anchor.`
          : undefined),
      isVerified: true,
      isRecommended: isAnchorMatched,
      badgeText: 'Verified Press Consensus',
      groundTruthSource:
        isAnchorMatched && anchor ? `Verified by ${storeName} Store Link` : undefined,
    };
  } catch {
    return null;
  }
}

/**
 * Live Steam Community Sentiment collector.
 */
export async function fetchSteamReviewCandidate(
  ctx: ResolvedReviewDiscoveryContext
): Promise<ReviewCandidateOption | null> {
  if (!ctx.steamAppId) return null;
  try {
    let positive: number | undefined = !ctx.isDifferentQueryTitle
      ? ctx.game.reviewSummary?.positivePercent
      : undefined;
    let totalReviews: number | undefined = !ctx.isDifferentQueryTitle
      ? ctx.game.reviewSummary?.totalReviews
      : undefined;

    if (positive === undefined && Object.keys(STEAM_ENRICHED_REVIEW_MAP).length > 0) {
      const enriched = STEAM_ENRICHED_REVIEW_MAP[String(ctx.steamAppId)];
      if (enriched?.reviewSummary) {
        positive = enriched.reviewSummary.positivePercent;
        totalReviews = enriched.reviewSummary.totalReviews;
      }
    }

    if (positive === undefined) {
      const steamResult = await steamReviewResolver.resolveScore(ctx.title, ctx.steamAppId);
      if (steamResult && steamResult.score > 0) {
        return {
          id: 'steam-community',
          source: 'steam',
          sourceLabel: 'Steam Community Reviews',
          score: steamResult.score,
          tier: steamResult.tier,
          percentRecommended: steamResult.percentRecommended,
          numReviews: steamResult.numReviews,
          url: steamResult.url,
          summary: steamResult.summary,
          isVerified: false,
          isSynthetic: true,
          badgeText: 'Player Community Sentiment',
          groundTruthSource: 'Steam Store Review Summary',
        };
      }
    }

    if (positive !== undefined && positive > 0) {
      const synthetic = calculateSyntheticSteamScore(positive, totalReviews);
      return {
        id: 'steam-community',
        source: 'steam',
        sourceLabel: 'Steam Community Reviews',
        score: synthetic.score,
        tier: synthetic.tier,
        percentRecommended: synthetic.percentRecommended,
        numReviews: totalReviews && totalReviews > 0 ? totalReviews : undefined,
        url: `https://store.steampowered.com/app/${ctx.steamAppId}`,
        summary: `Based on Steam community player reviews (${positive}% positive).`,
        isVerified: false,
        isSynthetic: true,
        badgeText: 'Player Community Sentiment',
        groundTruthSource: 'Steam Store Review Summary',
      };
    }
  } catch {
    return null;
  }
  return null;
}

/**
 * Live GOG / Epic / Xbox Storefront Star Rating collector.
 */
export async function fetchStorefrontStarCandidate(
  ctx: ResolvedReviewDiscoveryContext
): Promise<ReviewCandidateOption | null> {
  const hasGog = Boolean(
    ctx.gogId ||
      ctx.candidate?.source === 'gog' ||
      ctx.scrapedBundle?.matchedStore === 'gog' ||
      ctx.game.platforms?.some((p) => p.platformId === 'gog')
  );
  const hasEpic = Boolean(
    ctx.epicId ||
      ctx.candidate?.source === 'epic' ||
      ctx.scrapedBundle?.matchedStore === 'epic' ||
      ctx.game.platforms?.some((p) => p.platformId === 'epic')
  );
  const hasXbox = Boolean(
    ctx.xboxCandidateId ||
      ctx.scrapedBundle?.matchedStore === 'xbox' ||
      String(ctx.candidate?.id || '').toLowerCase().startsWith('xbox-') ||
      String(ctx.scrapedBundle?.matchedId || '').toLowerCase().startsWith('xbox-') ||
      Boolean(ctx.xboxPlat)
  );

  if (!hasGog && !hasEpic && !hasXbox && !ctx.hasCustomQuery) return null;

  try {
    const starResult = await storefrontStarResolver.resolveStorefrontScore({
      title: ctx.title,
      xboxProductId: ctx.xboxCandidateId,
    });

    if (starResult && starResult.score > 0) {
      const isXboxResult =
        starResult.source === 'xbox' ||
        String(starResult.id || '').toLowerCase().startsWith('xbox-') ||
        isXboxStoreUrl(starResult.url);

      if (isXboxResult) {
        return {
          id: String(starResult.id || 'xbox-stars'),
          source: 'xbox',
          sourceLabel: 'Xbox Store Rating',
          score: starResult.score,
          tier: starResult.tier,
          starRatingRaw: starResult.starRatingRaw,
          numReviews: starResult.numReviews,
          url: starResult.url,
          summary: starResult.summary,
          isVerified: false,
          isSynthetic: false,
          badgeText: 'Storefront Rating',
          groundTruthSource: 'Xbox / Microsoft Store Star Rating',
        };
      }

      const source: CriticSource =
        !ctx.isDifferentQueryTitle && hasEpic && !hasGog ? 'epic' : starResult.source || 'gog';
      const isEpic = source === 'epic';
      return {
        id: isEpic ? 'epic-stars' : 'gog-stars',
        source,
        sourceLabel: isEpic ? 'Epic Games Rating' : 'GOG Star Rating',
        score: starResult.score,
        tier: starResult.tier,
        starRatingRaw: starResult.starRatingRaw,
        numReviews: starResult.numReviews,
        url: starResult.url,
        summary: starResult.summary,
        isVerified: false,
        isSynthetic: false,
        badgeText: 'Storefront Rating',
        groundTruthSource: isEpic ? 'Epic Games Store Review Rating' : 'GOG Store Star Rating',
      };
    }
  } catch {
    return null;
  }
  return null;
}
