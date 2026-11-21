import type { CriticSource, CriticTier } from '../../contracts/critic';
import type { ReviewScoreRoute } from '../../contracts/override';
import { isOpenCriticHostUrl, isValidMetacriticHostUrl } from '../common/storeUrlUtils';

export interface ReviewCandidateOption {
  id: string; // e.g. 'anchor-metacritic', 'mc-metascore', 'mc-userscore', 'opencritic', 'steam-community', 'gog-stars', 'xbox-stars', 'active-override'
  source: CriticSource;
  sourceLabel: string; // e.g. "Metacritic Metascore", "Metacritic User Score", "OpenCritic", "Steam Community Reviews", "GOG Star Rating", "Xbox Store Rating", "Current Custom Override"
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

const ANCHOR_BOILERPLATE_SUMMARY_RE = /^Verified by official .+ store review anchor\.$/i;

function isAnchorBoilerplateSummary(summary?: string): boolean {
  return Boolean(summary && ANCHOR_BOILERPLATE_SUMMARY_RE.test(summary.trim()));
}

/**
 * Losslessly chooses the richer summary when merging duplicate candidates,
 * preferring live non-boilerplate critic summaries over generic anchor stub text.
 */
function chooseRicherSummary(
  existingSummary?: string,
  incomingSummary?: string
): string | undefined {
  const cleanExisting = existingSummary?.trim() || '';
  const cleanIncoming = incomingSummary?.trim() || '';
  if (!cleanExisting && !cleanIncoming) return undefined;
  if (!cleanExisting) return cleanIncoming;
  if (!cleanIncoming) return cleanExisting;

  const existingBoilerplate = isAnchorBoilerplateSummary(cleanExisting);
  const incomingBoilerplate = isAnchorBoilerplateSummary(cleanIncoming);
  if (existingBoilerplate && !incomingBoilerplate) {
    return cleanIncoming;
  }
  if (!existingBoilerplate && incomingBoilerplate) {
    return cleanExisting;
  }
  return cleanIncoming.length > cleanExisting.length ? cleanIncoming : cleanExisting;
}

/**
 * Scores URL canonicality for a given critic source so canonical review pages
 * (e.g. `/critic-reviews/` or `/game/<id>/<slug>`) beat generic store links during merges.
 */
function scoreReviewUrlSpecificity(url: string | undefined, source: CriticSource): number {
  const trimmed = url?.trim();
  if (!trimmed) return 0;

  if (source === 'metacritic' || source === 'metacritic_user') {
    if (isValidMetacriticHostUrl(trimmed)) {
      const lower = trimmed.toLowerCase();
      if (
        (source === 'metacritic' && lower.includes('/critic-reviews')) ||
        (source === 'metacritic_user' && lower.includes('/user-reviews'))
      ) {
        return 4;
      }
      if (lower.includes('/game/')) {
        return 3;
      }
      return 2;
    }
    return 1;
  }

  if (source === 'opencritic') {
    if (isOpenCriticHostUrl(trimmed)) {
      if (/\/game\/\d+\/[^/?#]+/i.test(trimmed)) {
        return 4;
      }
      if (/\/game\/\d+/i.test(trimmed)) {
        return 3;
      }
      return 2;
    }
    return 1;
  }

  return 2;
}

function chooseCanonicalReviewUrl(
  existingUrl: string | undefined,
  incomingUrl: string | undefined,
  source: CriticSource
): string | undefined {
  const existingScore = scoreReviewUrlSpecificity(existingUrl, source);
  const incomingScore = scoreReviewUrlSpecificity(incomingUrl, source);
  if (incomingScore > existingScore) {
    return incomingUrl;
  }
  return existingUrl || incomingUrl;
}

function mergeReviewRoutes(
  existingRoute: ReviewScoreRoute | undefined,
  incomingRoute: ReviewScoreRoute | undefined,
  chosenUrl: string | undefined
): ReviewScoreRoute | undefined {
  if (!existingRoute && !incomingRoute) return undefined;
  const base = existingRoute || incomingRoute!;
  const other = existingRoute ? incomingRoute : undefined;
  return {
    ...other,
    ...base,
    url: chosenUrl || base.url || other?.url,
    metacriticSlug: base.metacriticSlug || other?.metacriticSlug,
    openCriticId: base.openCriticId ?? other?.openCriticId,
    steamAppId: base.steamAppId ?? other?.steamAppId,
    gogId: base.gogId || other?.gogId,
    epicId: base.epicId || other?.epicId,
    xboxProductId: base.xboxProductId || other?.xboxProductId,
    targetTitle: base.targetTitle || other?.targetTitle,
  };
}

function getRankOrder(o: ReviewCandidateOption): number {
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
  if (o.source === 'gog' || o.source === 'epic' || o.source === 'xbox') return 6;
  return 7;
}

/**
 * Deduplicates options by source and score, losslessly merging richer live metadata
 * (non-boilerplate summary, canonical critic-reviews URL, higher review count) while preserving
 * `isRecommended`, `groundTruthSource`, and `anchor-*` ID priority, then ranks hierarchically:
 * 1. Storefront ground truth anchor (isRecommended)
 * 2. Tier 1 Metacritic Press Metascore
 * 3. Tier 2 OpenCritic Top Critic Average
 * 4. Tier 3 Metacritic User Score
 * 5. Tier 4 Steam Community Sentiment
 * 6. Tier 5 Storefront Star Rating
 */
export function deduplicateAndRankReviewCandidates(
  options: ReviewCandidateOption[]
): ReviewCandidateOption[] {
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
      const url = chooseCanonicalReviewUrl(existing.url, opt.url, existing.source);
      const summary = chooseRicherSummary(existing.summary, opt.summary);
      const numReviews = Math.max(existing.numReviews || 0, opt.numReviews || 0) || undefined;
      const userScoreRaw = existing.userScoreRaw ?? opt.userScoreRaw;
      const starRatingRaw = existing.starRatingRaw ?? opt.starRatingRaw;
      const percentRecommended = existing.percentRecommended ?? opt.percentRecommended;
      const badgeText = existing.badgeText || opt.badgeText;
      const reviewRoute = mergeReviewRoutes(existing.reviewRoute, opt.reviewRoute, url);

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
        isSynthetic: isVerified ? false : Boolean(existing.isSynthetic || opt.isSynthetic),
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
