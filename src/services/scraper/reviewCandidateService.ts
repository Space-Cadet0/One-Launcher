import type { CriticSource, CriticTier, CriticScoreData, StorefrontReviewAnchor } from '../../contracts/critic';
import type { CanonicalGame } from '../../contracts/game';
import type {
  SearchMatchCandidate,
  ScrapedMetadataBundle,
  ReviewScoreRoute,
} from '../../contracts/override';
import {
  calculateSyntheticSteamScore,
  calculateTier,
  normalizeCriticTitleKey,
  stripEditionSuffix,
  isSequelMismatch,
} from '../critic/criticUtils';
import { KNOWN_CRITIC_SCORES } from '../critic/knownCriticScores';
import { metacriticResolver, isTitleCompatible } from '../critic/metacriticResolver';
import { steamReviewResolver } from '../critic/steamReviewResolver';
import { storefrontStarResolver } from '../critic/storefrontStarResolver';
import { storefrontReviewHarvester } from '../critic/storefrontReviewHarvester';
import { requestScheduler, Priority } from '../network/requestScheduler';
import { loadStagedCache } from '../storage/stagedCacheService';
import { loadUserOverrides, getUserOverrideForGame } from '../storage/userOverrideStorage';
import { steamMatcher } from '../steam/steamMatcher';
import { metadataScraperService } from './metadataScraperService';
import steamEnrichedCache from '../storage/steamEnrichedCache.json';

export interface ReviewCandidateOption {
  id: string; // e.g. 'anchor-metacritic', 'mc-metascore', 'mc-userscore', 'opencritic', 'steam-community', 'gog-stars', 'active-override'
  source: CriticSource;
  sourceLabel: string; // e.g. "Metacritic Metascore", "Metacritic User Score", "OpenCritic", "Steam Community Reviews", "GOG Star Rating", "Current Custom Override"
  score: number; // 0-100
  tier: CriticTier; // 'Mighty' | 'Strong' | 'Fair' | 'Weak'
  url?: string;
  summary?: string;
  numReviews?: number;
  userScoreRaw?: number;
  starRatingRaw?: number;
  percentRecommended?: number;
  isVerified: boolean;
  isSynthetic?: boolean;
  isRecommended?: boolean;
  badgeText?: string; // e.g. "Verified Press Consensus", "Player Community Sentiment", "Storefront Rating"
  groundTruthSource?: string; // e.g. "Verified by Steam Store Link"
  reviewRoute?: ReviewScoreRoute;
}

export interface ReviewDiscoveryResult {
  candidates: ReviewCandidateOption[];
  recommendedCandidateId?: string;
  isLoading: boolean;
  error?: string;
}

const OPENCRITIC_BEARER_TOKEN = 'Bearer R2tBRkdvUU9WSHpoUXpaSXVYa2g5cGU5NEFsWUgyeXQ=';

/**
 * Safe timeout wrapper that returns fallback value if promise does not settle within ms.
 */
async function withTimeout<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  let timer: any;
  const timeoutPromise = new Promise<T>((resolve) => {
    timer = setTimeout(() => resolve(fallback), ms);
  });
  try {
    return await Promise.race([promise, timeoutPromise]);
  } catch {
    return fallback;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Returns user-friendly source label for display in UI options.
 */
function getSourceLabel(source: CriticSource, isActiveOverride = false): string {
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
    case 'custom':
      return 'Custom Score';
    default:
      return 'Critic Review';
  }
}

/**
 * Returns badge descriptor text for UI presentation.
 */
function getBadgeText(source: CriticSource, isVerified: boolean, isSynthetic?: boolean): string {
  if (isVerified) return 'Verified Press Consensus';
  if (isSynthetic || source === 'steam' || source === 'metacritic_user') return 'Player Community Sentiment';
  if (source === 'gog' || source === 'epic') return 'Storefront Rating';
  return 'Review Score';
}

/**
 * Builds a structured ReviewScoreRoute for a review candidate option.
 */
function buildCandidateRoute(
  opt: ReviewCandidateOption,
  ctx: {
    title: string;
    steamAppId?: number;
    gogId?: string;
    epicId?: string;
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
    targetTitle: ctx.title,
  };
}

export class ReviewCandidateService {
  /**
   * Discovers and aggregates review score candidates for a game from local caches,
   * ground truth storefront links, and live external APIs (Metacritic, OpenCritic, Steam, GOG, Epic).
   *
   * @param game The CanonicalGame from local library.
   * @param candidate Optional SearchMatchCandidate selected in Fix Match or search modal.
   * @param scrapedBundle Optional ScrapedMetadataBundle containing scraped metadata and storefrontAnchor.
   * @param customSearchQuery Optional custom search query for Stage 3 independent review discovery.
   * @returns Deduplicated, ranked array of ReviewCandidateOption.
   */
  public async discoverReviewCandidates(
    game: CanonicalGame,
    candidate?: SearchMatchCandidate | null,
    scrapedBundle?: ScrapedMetadataBundle | null,
    customSearchQuery?: string
  ): Promise<ReviewCandidateOption[]> {
    const rawCandidates: ReviewCandidateOption[] = [];

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
        const steamSearchResults = await withTimeout(
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
          const steamSearchResults = await withTimeout(
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

    const gogPlat = game.platforms?.find((p) => p.platformId === 'gog' || p.platformId?.toLowerCase() === 'gog');
    const gogId = isDifferentQueryTitle
      ? undefined
      : candidate?.gogId
      ? String(candidate.gogId)
      : (scrapedBundle?.matchedStore === 'gog' ? String(scrapedBundle.matchedId) : undefined) ||
        scrapedBundle?.metadataRoute?.gogId ||
        gogPlat?.platformGameId ||
        (game.id?.startsWith('gog-') ? game.id.replace('gog-', '') : undefined);

    const epicPlat = game.platforms?.find((p) => p.platformId === 'epic' || p.platformId?.toLowerCase() === 'epic');
    const epicId = isDifferentQueryTitle
      ? undefined
      : (scrapedBundle?.matchedStore === 'epic' ? String(scrapedBundle.matchedId) : undefined) ||
        epicPlat?.platformGameId ||
        (game.id?.startsWith('epic-') ? game.id.replace('epic-', '') : undefined);

    let releaseYear: number | undefined;
    const yearCandidate = isDifferentQueryTitle
      ? undefined
      : scrapedBundle?.releaseDate || candidate?.year || game.releaseDate;
    if (yearCandidate) {
      const m = String(yearCandidate).match(/\b(19\d\d|20\d\d)\b/);
      if (m) releaseYear = parseInt(m[1], 10);
    }

    // =========================================================================
    // STEP A: Instant Local & Cached Collection (0ms, 0 network requests)
    // =========================================================================

    // 1. Check active reviewScoreOverride on game or user overrides storage (skip if custom query for different title)
    if (!isDifferentQueryTitle) {
      let activeOverride: CriticScoreData | null | undefined = game.reviewScoreOverride;
      if (activeOverride === undefined) {
        try {
          const overrides = loadUserOverrides();
          const matching = getUserOverrideForGame(game, overrides);
          if (matching?.reviewScoreOverride !== undefined) {
            activeOverride = matching.reviewScoreOverride;
          }
        } catch {}
      }

      if (activeOverride && typeof activeOverride.score === 'number' && activeOverride.score > 0) {
        rawCandidates.push({
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

    // 2. Check KNOWN_CRITIC_SCORES by steamAppId and normalized title keys
    const lowerTitle = title.toLowerCase().trim();
    const normKey = normalizeCriticTitleKey(title);
    const strippedKey = stripEditionSuffix(title);

    let knownMatch: CriticScoreData | undefined;
    if (steamAppId && KNOWN_CRITIC_SCORES[steamAppId]) {
      knownMatch = KNOWN_CRITIC_SCORES[steamAppId];
    } else if (lowerTitle && KNOWN_CRITIC_SCORES[lowerTitle]) {
      knownMatch = KNOWN_CRITIC_SCORES[lowerTitle];
    } else if (normKey && KNOWN_CRITIC_SCORES[normKey]) {
      knownMatch = KNOWN_CRITIC_SCORES[normKey];
    } else if (strippedKey && strippedKey !== normKey && KNOWN_CRITIC_SCORES[strippedKey]) {
      knownMatch = KNOWN_CRITIC_SCORES[strippedKey];
    }

    if (knownMatch && typeof knownMatch.score === 'number' && knownMatch.score > 0) {
      const id =
        knownMatch.source === 'metacritic'
          ? 'mc-metascore'
          : knownMatch.source === 'metacritic_user'
          ? 'mc-userscore'
          : knownMatch.source === 'steam'
          ? 'steam-community'
          : knownMatch.source === 'gog'
          ? 'gog-stars'
          : knownMatch.source === 'epic'
          ? 'epic-stars'
          : 'opencritic';

      rawCandidates.push({
        id,
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
        badgeText: getBadgeText(knownMatch.source, Boolean(knownMatch.isVerified), knownMatch.isSynthetic),
      });
    }

    // 3. Check stagedCacheService for cached score
    const cacheKey = steamAppId ? `id:${steamAppId}` : `title:${lowerTitle}`;
    const stagedKey = `antigravity_critic_v8_${cacheKey}`;
    try {
      const staged = loadStagedCache<CriticScoreData>(stagedKey, false);
      if (staged.data && typeof staged.data.score === 'number' && staged.data.score > 0) {
        const data = staged.data;
        const id =
          data.source === 'metacritic'
            ? 'mc-metascore'
            : data.source === 'metacritic_user'
            ? 'mc-userscore'
            : data.source === 'steam'
            ? 'steam-community'
            : data.source === 'gog'
            ? 'gog-stars'
            : data.source === 'epic'
            ? 'epic-stars'
            : 'opencritic';

        rawCandidates.push({
          id,
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
    } catch {}

    // =========================================================================
    // STEP B: Storefront Ground Truth Anchor
    // =========================================================================
    let anchor: StorefrontReviewAnchor | null | undefined = isDifferentQueryTitle
      ? undefined
      : scrapedBundle?.storefrontAnchor;
    if (!anchor) {
      try {
        anchor = await withTimeout(
          storefrontReviewHarvester.getStorefrontAnchor({
            title,
            steamAppId,
            platforms: isDifferentQueryTitle ? undefined : game.platforms,
            id: isDifferentQueryTitle ? undefined : game.id,
          }),
          4000,
          null
        );
      } catch {
        anchor = null;
      }
    }

    if (anchor) {
      const storeName =
        anchor.storefront === 'steam'
          ? 'Steam'
          : anchor.storefront === 'gog'
          ? 'GOG'
          : 'Epic';

      // 1. If anchor has metacriticScore or metacriticSlug, build verified Metacritic candidate and mark isRecommended: true
      if (typeof anchor.metacriticScore === 'number' && anchor.metacriticScore > 0) {
        const mcUrl =
          anchor.metacriticUrl ||
          (anchor.metacriticSlug ? `https://www.metacritic.com/game/${anchor.metacriticSlug}/critic-reviews/` : undefined);

        rawCandidates.push({
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

      // 2. If anchor has openCriticScore (e.g. GOG/Epic anchor), build verified OpenCritic candidate and mark isRecommended: true
      if (typeof anchor.openCriticScore === 'number' && anchor.openCriticScore > 0) {
        const ocUrl =
          anchor.openCriticUrl ||
          (anchor.openCriticId ? `https://opencritic.com/game/${anchor.openCriticId}` : undefined) ||
          anchor.rawStoreUrl;

        rawCandidates.push({
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
    }

    // =========================================================================
    // STEP C & D: Live Storefronts with requestScheduler (Priority.P0_INTERACTIVE)
    // Run in parallel with Promise.allSettled and safe maximum 4000ms timeouts
    // =========================================================================

    // Metacritic Task
    const fetchMetacriticTask = async (): Promise<{ critic: ReviewCandidateOption | null; user: ReviewCandidateOption | null }> => {
      if (!title) return { critic: null, user: null };
      try {
        const bundle = await (metacriticResolver.resolveMetacritic as any)(
          title,
          releaseYear,
          anchor,
          Priority.P0_INTERACTIVE
        );

        let criticOption: ReviewCandidateOption | null = null;
        let userOption: ReviewCandidateOption | null = null;

        if (bundle?.critic && typeof bundle.critic.score === 'number' && bundle.critic.score > 0) {
          const titleYearMatch = title.match(/\((?:[^)]*,\s*)?((?:19|20)\d{2})[^)]*\)/);
          const resolvedYearSuffixedSlug = Boolean(
            titleYearMatch &&
            anchor?.metacriticSlug &&
            !anchor.metacriticSlug.endsWith(titleYearMatch[1]) &&
            bundle.critic.url?.includes(`${anchor.metacriticSlug}-${titleYearMatch[1]}`)
          );

          const isSameScoreAsAnchor = Boolean(
            anchor?.metacriticSlug &&
            (!anchor?.metacriticScore || anchor.metacriticScore === bundle.critic.score)
          );
          const isAnchorLinked = isSameScoreAsAnchor || resolvedYearSuffixedSlug;
          const storeName = anchor?.storefront === 'steam' ? 'Steam' : (anchor?.storefront === 'gog' ? 'GOG' : 'Epic');

          if (resolvedYearSuffixedSlug) {
            const existingIdx = rawCandidates.findIndex((c) => c.id === 'anchor-metacritic');
            if (existingIdx !== -1) {
              rawCandidates.splice(existingIdx, 1);
            }
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
            groundTruthSource: isAnchorLinked && anchor ? `Verified by ${storeName} Store Link` : undefined,
          };
        }

        if (bundle?.user && typeof bundle.user.score === 'number' && bundle.user.score > 0) {
          const rawScore =
            bundle.user.userScoreRaw ??
            Math.round((bundle.user.score / 10) * 10) / 10;

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

        return { critic: criticOption, user: userOption };
      } catch {
        return { critic: null, user: null };
      }
    };

    // OpenCritic Task
    const fetchOpenCriticTask = async (): Promise<ReviewCandidateOption | null> => {
      if (!title) return null;
      try {
        const cleanTitle = title
          .replace(/[™®©]/g, '')
          .replace(
            /\b(standard|deluxe|gold|silver|platinum|diamond|collector'?s|ultimate|complete|special|limited|definitive|enhanced|anniversary|directors-cut|director'?s cut|goty|game of the year|remastered|remake)( edition)?\b/gi,
            ''
          )
          .trim();

        const baseUrl =
          typeof window !== 'undefined' && window.location?.hostname === 'localhost'
            ? '/api/opencritic'
            : 'https://api.opencritic.com';

        const searchUrl = `${baseUrl}/api/game/search?criteria=${encodeURIComponent(cleanTitle || title)}`;
        const headers: Record<string, string> = {
          Authorization: OPENCRITIC_BEARER_TOKEN,
          Referer: 'https://opencritic.com/',
        };

        const candidates = await requestScheduler.schedule(
          'api.opencritic.com',
          async () => {
            const res = await fetch(searchUrl, {
              headers,
              signal: typeof AbortSignal !== 'undefined' && 'timeout' in AbortSignal ? AbortSignal.timeout(3500) : undefined,
            });
            if (!res.ok) return null;
            return (await res.json()) as Array<{ id: number; name: string; dist?: number }>;
          },
          Priority.P0_INTERACTIVE
        );

        if (!Array.isArray(candidates) || candidates.length === 0) return null;

        let best: { id: number; name: string; dist?: number } | null = null;
        if (anchor?.openCriticId) {
          best = candidates.find((c) => c.id === anchor.openCriticId) || null;
        }

        if (!best) {
          for (const c of candidates) {
            if (typeof c.dist === 'number' && c.dist <= 0.35) {
              if (
                !isSequelMismatch(cleanTitle || title, c.name) &&
                isTitleCompatible(cleanTitle || title, c.name)
              ) {
                best = c;
                break;
              }
            }
          }
        }

        if (!best) return null;

        const detailsUrl = `${baseUrl}/api/game/${best.id}`;
        const data = await requestScheduler.schedule(
          'api.opencritic.com',
          async () => {
            const res = await fetch(detailsUrl, {
              headers,
              signal: typeof AbortSignal !== 'undefined' && 'timeout' in AbortSignal ? AbortSignal.timeout(3500) : undefined,
            });
            if (!res.ok) return null;
            return await res.json();
          },
          Priority.P0_INTERACTIVE
        );

        if (!data || typeof data.topCriticScore !== 'number' || data.topCriticScore <= 0) {
          return null;
        }

        if (releaseYear && data.firstReleaseDate) {
          const hasYearInTitle = /\b(19\d\d|20\d\d)\b/.test(title);
          const targetYrMatch = String(releaseYear).match(/\b(19\d\d|20\d\d)\b/);
          const ocYrMatch = String(data.firstReleaseDate).match(/\b(19\d\d|20\d\d)\b/);
          const isRemaster =
            /\b(remastered|remaster|definitive|enhanced|anniversary|complete|goty|director'?s cut|redux|remake)\b/i.test(
              title
            );
          if (targetYrMatch && ocYrMatch) {
            const targetYr = parseInt(targetYrMatch[1], 10);
            const ocYr = parseInt(ocYrMatch[1], 10);
            if ((hasYearInTitle || targetYr <= 2020) && Math.abs(targetYr - ocYr) >= 4 && !isRemaster) {
              return null;
            }
          }
        }

        const score = Math.round(data.topCriticScore);
        const percentRecommended =
          typeof data.percentRecommended === 'number' ? Math.round(data.percentRecommended) : undefined;
        const tier = (data.tier as CriticTier) || calculateTier(score, percentRecommended);
        const slug = (data.name || best.name)
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, '-')
          .replace(/^-|-$/g, '');
        const canonicalUrl = anchor?.openCriticUrl || `https://opencritic.com/game/${best.id}/${slug}`;
        const isAnchorMatched = Boolean(
          anchor?.openCriticScore || (anchor?.openCriticId && anchor.openCriticId === best.id)
        );
        const storeName = anchor?.storefront === 'steam' ? 'Steam' : (anchor?.storefront === 'gog' ? 'GOG' : 'Epic');

        return {
          id: isAnchorMatched ? 'anchor-opencritic' : 'opencritic',
          source: 'opencritic',
          sourceLabel: 'OpenCritic',
          score,
          tier,
          percentRecommended,
          numReviews: typeof data.numReviews === 'number' ? data.numReviews : 25,
          url: canonicalUrl,
          summary:
            data.reviewSummary?.summary ||
            (isAnchorMatched && anchor ? `Verified by official ${storeName} store review anchor.` : undefined),
          isVerified: true,
          isRecommended: isAnchorMatched,
          badgeText: 'Verified Press Consensus',
          groundTruthSource: isAnchorMatched && anchor ? `Verified by ${storeName} Store Link` : undefined,
        };
      } catch {
        return null;
      }
    };

    // Steam Community Sentiment Task
    const fetchSteamTask = async (): Promise<ReviewCandidateOption | null> => {
      if (!steamAppId) return null;
      try {
        let positive: number | undefined = !isDifferentQueryTitle
          ? game.reviewSummary?.positivePercent
          : undefined;
        let totalReviews: number | undefined = !isDifferentQueryTitle
          ? game.reviewSummary?.totalReviews
          : undefined;

        if (positive === undefined && steamEnrichedCache) {
          const enriched = (steamEnrichedCache as Record<string, any>)[String(steamAppId)];
          if (enriched?.reviewSummary) {
            positive = enriched.reviewSummary.positivePercent;
            totalReviews = enriched.reviewSummary.totalReviews;
          }
        }

        if (positive === undefined) {
          const steamResult = await steamReviewResolver.resolveScore(title, steamAppId);
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
            numReviews: totalReviews || 50,
            url: `https://store.steampowered.com/app/${steamAppId}`,
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
    };

    // GOG / Epic Storefront Star Task
    const fetchStorefrontStarTask = async (): Promise<ReviewCandidateOption | null> => {
      const hasGog = Boolean(
        gogId ||
          candidate?.source === 'gog' ||
          scrapedBundle?.matchedStore === 'gog' ||
          game.platforms?.some((p) => p.platformId === 'gog')
      );
      const hasEpic = Boolean(
        epicId ||
          candidate?.source === 'epic' ||
          scrapedBundle?.matchedStore === 'epic' ||
          game.platforms?.some((p) => p.platformId === 'epic')
      );

      if (!hasGog && !hasEpic && !hasCustomQuery) return null;

      try {
        const starResult = await storefrontStarResolver.resolveStorefrontScore(title);

        if (starResult && starResult.score > 0) {
          const source: CriticSource =
            !isDifferentQueryTitle && hasEpic && !hasGog ? 'epic' : starResult.source || 'gog';
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
    };

    // Execute in parallel with Promise.allSettled and safe 7500ms timeouts
    const [mcSettled, ocSettled, steamSettled, starSettled] = await Promise.allSettled([
      withTimeout(fetchMetacriticTask(), 7500, { critic: null, user: null }),
      withTimeout(fetchOpenCriticTask(), 7500, null),
      withTimeout(fetchSteamTask(), 7500, null),
      withTimeout(fetchStorefrontStarTask(), 7500, null),
    ]);

    if (mcSettled.status === 'fulfilled' && mcSettled.value) {
      if (mcSettled.value.critic) rawCandidates.push(mcSettled.value.critic);
      if (mcSettled.value.user) rawCandidates.push(mcSettled.value.user);
    }

    if (ocSettled.status === 'fulfilled' && ocSettled.value) {
      rawCandidates.push(ocSettled.value);
    }

    if (steamSettled.status === 'fulfilled' && steamSettled.value) {
      rawCandidates.push(steamSettled.value);
    }

    if (starSettled.status === 'fulfilled' && starSettled.value) {
      rawCandidates.push(starSettled.value);
    }

    const routeCtx = {
      title,
      steamAppId,
      gogId: gogId ? String(gogId) : undefined,
      epicId: epicId ? String(epicId) : undefined,
      anchor,
    };

    const routedCandidates = rawCandidates.map((opt) => ({
      ...opt,
      reviewRoute: opt.reviewRoute || buildCandidateRoute(opt, routeCtx),
    }));

    // =========================================================================
    // STEP E: Deduplication & Ranking
    // =========================================================================
    return this.deduplicateAndRank(routedCandidates);
  }

  /**
   * Helper that discovers candidates and returns full ReviewDiscoveryResult with recommendedCandidateId.
   */
  public async discoverReviews(
    game: CanonicalGame,
    candidate?: SearchMatchCandidate | null,
    scrapedBundle?: ScrapedMetadataBundle | null,
    customSearchQuery?: string
  ): Promise<ReviewDiscoveryResult> {
    try {
      const candidates = await this.discoverReviewCandidates(
        game,
        candidate,
        scrapedBundle,
        customSearchQuery
      );
      const recommended = candidates.find((c) => c.isRecommended) || candidates[0];
      return {
        candidates,
        recommendedCandidateId: recommended?.id,
        isLoading: false,
      };
    } catch (err: any) {
      return {
        candidates: [],
        isLoading: false,
        error: err?.message || 'Failed to discover review candidates',
      };
    }
  }

  /**
   * Deduplicates options by source and score, merging richer metadata, and ranks them:
   * 1. Storefront ground truth anchor (isRecommended)
   * 2. Tier 1 Metacritic Press Metascore
   * 3. Tier 2 OpenCritic Top Critic Average
   * 4. Tier 3 Metacritic User Score
   * 5. Tier 4 Steam Community Sentiment
   * 6. Tier 5 Storefront Star Rating
   */
  public deduplicateAndRank(options: ReviewCandidateOption[]): ReviewCandidateOption[] {
    const sourceScoreMap = new Map<string, ReviewCandidateOption>();

    for (const opt of options) {
      if (!opt || typeof opt.score !== 'number' || opt.score <= 0) continue;

      // Preserve active-override separately, otherwise key by source:score
      const key = opt.id === 'active-override' ? 'active-override' : `${opt.source}:${opt.score}`;
      const existing = sourceScoreMap.get(key);

      if (!existing) {
        sourceScoreMap.set(key, { ...opt });
      } else {
        const isRecommended = Boolean(existing.isRecommended || opt.isRecommended);
        const isVerified = Boolean(existing.isVerified || opt.isVerified);
        const groundTruthSource = existing.groundTruthSource || opt.groundTruthSource;
        const url = existing.url || opt.url;
        const summary = existing.summary || opt.summary;
        const numReviews = Math.max(existing.numReviews || 0, opt.numReviews || 0) || undefined;
        const userScoreRaw = existing.userScoreRaw ?? opt.userScoreRaw;
        const starRatingRaw = existing.starRatingRaw ?? opt.starRatingRaw;
        const percentRecommended = existing.percentRecommended ?? opt.percentRecommended;
        const badgeText = existing.badgeText || opt.badgeText;
        const reviewRoute = existing.reviewRoute || opt.reviewRoute;

        let id = existing.id;
        if (opt.isRecommended && !existing.isRecommended) {
          id = opt.id;
        } else if (opt.id.startsWith('anchor-') && !existing.id.startsWith('anchor-')) {
          id = opt.id;
        }

        sourceScoreMap.set(key, {
          ...existing,
          ...opt,
          id,
          isRecommended,
          isVerified,
          groundTruthSource,
          url,
          summary,
          numReviews,
          userScoreRaw,
          starRatingRaw,
          percentRecommended,
          badgeText,
          reviewRoute,
        });
      }
    }

    // Deduplicate if identical ID exists with divergent score, keeping the recommended or higher-reviewed one
    const idMap = new Map<string, ReviewCandidateOption>();
    for (const opt of sourceScoreMap.values()) {
      if (opt.id === 'active-override') {
        idMap.set(opt.id, opt);
        continue;
      }
      const existing = idMap.get(opt.id);
      if (!existing) {
        idMap.set(opt.id, opt);
      } else {
        if (opt.isRecommended && !existing.isRecommended) {
          idMap.set(opt.id, opt);
        } else if (!existing.isRecommended && (opt.numReviews || 0) > (existing.numReviews || 0)) {
          idMap.set(opt.id, opt);
        }
      }
    }

    const result = Array.from(idMap.values());

    const getRankOrder = (o: ReviewCandidateOption): number => {
      // 1. Storefront ground truth anchor (isRecommended)
      if (o.isRecommended) return 1;
      // Active override ranks immediately after recommended anchor (or #1 if unanchored)
      if (o.id === 'active-override') return 1.5;
      // 2. Tier 1 Metacritic Press Metascore
      if (o.source === 'metacritic' && o.isVerified) return 2;
      // 3. Tier 2 OpenCritic Top Critic Average
      if (o.source === 'opencritic') return 3;
      // 4. Tier 3 Metacritic User Score
      if (o.source === 'metacritic_user') return 4;
      // 5. Tier 4 Steam Community Sentiment
      if (o.source === 'steam') return 5;
      // 6. Tier 5 Storefront Star Rating
      if (o.source === 'gog' || o.source === 'epic') return 6;
      return 7;
    };

    result.sort((a, b) => {
      const rankA = getRankOrder(a);
      const rankB = getRankOrder(b);
      if (rankA !== rankB) {
        return rankA - rankB;
      }
      return b.score - a.score;
    });

    return result;
  }
}

export const reviewCandidateService = new ReviewCandidateService();
