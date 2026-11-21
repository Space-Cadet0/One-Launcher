import { CriticScoreData, CriticSource } from '../../../contracts/critic';
import {
  MetadataSourceOption,
  ReviewScoreRoute,
  ScrapedCoverOption,
  ScrapedMetadataBundle,
  UserGameOverride,
} from '../../../contracts/override';
import { calculateTier } from '../../../services/critic/criticUtils';
import { sanitizeAllowedStoreUri } from '../../../services/common/htmlSanitizer';
import { ReviewCandidateOption } from '../../../services/scraper/reviewCandidateService';
import { SourceFilterTab } from './fixMatchTypes';

export function toReviewScoreDataFromOption(opt: ReviewCandidateOption): CriticScoreData {
  return {
    id: opt.id,
    source: opt.source,
    score: opt.score,
    tier: opt.tier,
    url: opt.url || '',
    summary: opt.summary,
    numReviews: opt.numReviews,
    userScoreRaw: opt.userScoreRaw,
    starRatingRaw: opt.starRatingRaw,
    percentRecommended: opt.percentRecommended,
    isVerified: opt.isVerified,
    isSynthetic: opt.isSynthetic,
  };
}

export interface ResolvedReviewSelection {
  optionId: string;
  reviewData: CriticScoreData | null;
  reviewRoute: ReviewScoreRoute;
  customFields?: {
    score: number;
    source: CriticSource;
    url: string;
    summary: string;
    numReviews: number | string;
  };
}

export function resolveDiscoveredReviewSelection(params: {
  discovered: ReviewCandidateOption[];
  recommendedCandidateId?: string;
  customQuery?: string;
  existingOverride?: UserGameOverride;
  fallbackTargetTitle: string;
}): ResolvedReviewSelection {
  const { discovered, recommendedCandidateId, customQuery, existingOverride, fallbackTargetTitle } =
    params;

  if (!customQuery && existingOverride && existingOverride.reviewScoreOverride !== undefined) {
    if (existingOverride.reviewScoreOverride === null) {
      return {
        optionId: 'unrated',
        reviewData: null,
        reviewRoute: { mode: 'unrated' },
      };
    }
    const activeOpt = discovered.find((c) => c.id === 'active-override');
    if (activeOpt) {
      return {
        optionId: activeOpt.id,
        reviewData: toReviewScoreDataFromOption(activeOpt),
        reviewRoute: activeOpt.reviewRoute || {
          mode: 'routed',
          source: activeOpt.source,
          url: activeOpt.url,
          targetTitle: fallbackTargetTitle,
        },
      };
    }
    const ex = existingOverride.reviewScoreOverride;
    return {
      optionId: 'custom',
      reviewData: ex,
      reviewRoute: existingOverride.reviewRoute || {
        mode: 'static',
        source: ex.source,
        url: ex.url,
      },
      customFields: {
        score: ex.score,
        source: ex.source,
        url: ex.url || '',
        summary: ex.summary || '',
        numReviews: ex.numReviews ?? '',
      },
    };
  }

  if (!customQuery) {
    const activeCand = discovered.find((c) => c.id === 'active-override');
    if (activeCand) {
      return {
        optionId: activeCand.id,
        reviewData: toReviewScoreDataFromOption(activeCand),
        reviewRoute: activeCand.reviewRoute || {
          mode: 'routed',
          source: activeCand.source,
          url: activeCand.url,
          targetTitle: fallbackTargetTitle,
        },
      };
    }
  }

  const recommended =
    (recommendedCandidateId ? discovered.find((c) => c.id === recommendedCandidateId) : null) ||
    discovered.find((c) => c.isRecommended) ||
    discovered[0];

  if (recommended) {
    return {
      optionId: recommended.id,
      reviewData: toReviewScoreDataFromOption(recommended),
      reviewRoute: recommended.reviewRoute || {
        mode: 'routed',
        source: recommended.source,
        url: recommended.url,
        targetTitle: customQuery?.trim() || fallbackTargetTitle,
      },
    };
  }

  return {
    optionId: 'unrated',
    reviewData: null,
    reviewRoute: { mode: 'unrated' },
  };
}

export function buildCustomReviewState(
  val: string | number,
  src: CriticSource,
  url: string,
  summary: string,
  numReviews: string | number
): { reviewData: CriticScoreData | null; reviewRoute: ReviewScoreRoute } {
  const rawVal = typeof val === 'string' ? val.trim() : String(val);
  const parsedScore = parseInt(rawVal, 10);
  const safeUrl = url.trim() ? sanitizeAllowedStoreUri(url.trim()) : '';

  let reviewData: CriticScoreData | null = null;
  if (!isNaN(parsedScore) && parsedScore >= 0 && parsedScore <= 100) {
    const tier = calculateTier(parsedScore);
    const parsedReviews =
      typeof numReviews === 'string' ? parseInt(numReviews.trim(), 10) : numReviews;
    const count = !isNaN(parsedReviews) && parsedReviews > 0 ? parsedReviews : undefined;
    reviewData = {
      source: src,
      score: parsedScore,
      tier,
      url: safeUrl,
      summary: summary.trim() || undefined,
      numReviews: count,
      isVerified: src === 'metacritic' || src === 'opencritic',
      isSynthetic: src === 'steam',
    };
  }

  return {
    reviewData,
    reviewRoute: { mode: 'static', source: src, url: safeUrl || undefined },
  };
}

export function filterAndDeduplicateCovers(
  extraCovers: ScrapedCoverOption[],
  scrapedBundle: ScrapedMetadataBundle | null,
  coverSourceTab: SourceFilterTab,
  selectedCoverUrl: string
): ScrapedCoverOption[] {
  const raw = [...extraCovers, ...(scrapedBundle?.availableCovers || [])];
  const seen = new Set<string>();
  const deduped: ScrapedCoverOption[] = [];
  for (const cov of raw) {
    if (!cov || !cov.url || seen.has(cov.url)) continue;
    seen.add(cov.url);
    deduped.push(cov);
  }
  if (coverSourceTab === 'All') return deduped;
  if (coverSourceTab === 'Xbox') {
    return deduped.filter(
      (c) =>
        c.label.toLowerCase().startsWith('xbox') ||
        c.url.toLowerCase().includes('s-microsoft.com') ||
        c.url === selectedCoverUrl
    );
  }
  const targetSource = coverSourceTab.toLowerCase();
  return deduped.filter(
    (c) => c.source.toLowerCase() === targetSource || c.url === selectedCoverUrl
  );
}

export function mergeDeduplicatedMetadataSources(
  incoming: MetadataSourceOption[],
  existing: MetadataSourceOption[]
): MetadataSourceOption[] {
  const combined = [...incoming, ...existing];
  const seen = new Set<string>();
  return combined.filter((item) => {
    if (!item || seen.has(item.id)) return false;
    seen.add(item.id);
    return true;
  });
}
