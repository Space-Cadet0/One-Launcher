import { CriticScoreData, CriticSource, CriticTier } from '../../contracts/critic';

/**
 * Computes an authentic synthetic score calibrated from Steam positive review percentage.
 */
export function calculateSyntheticSteamScore(
  positivePercent: number,
  _totalReviews?: number
): {
  score: number;
  percentRecommended: number;
  tier: CriticTier;
} {
  const positive = Math.max(0, Math.min(100, Math.round(positivePercent)));
  let score: number;
  let percentRecommended: number;

  if (positive >= 95) {
    score = Math.min(95, 88 + Math.round((positive - 95) * 1.4));
    percentRecommended = Math.min(99, 92 + Math.round((positive - 95) * 1.4));
  } else if (positive >= 90) {
    score = 84 + Math.round((positive - 90) * 0.8);
    percentRecommended = 86 + Math.round((positive - 90) * 1.2);
  } else if (positive >= 80) {
    score = 77 + Math.round((positive - 80) * 0.7);
    percentRecommended = 74 + Math.round((positive - 80) * 1.2);
  } else if (positive >= 70) {
    score = 70 + Math.round((positive - 70) * 0.7);
    percentRecommended = 55 + Math.round((positive - 70) * 1.9);
  } else {
    score = Math.max(35, positive - 5);
    percentRecommended = Math.max(10, positive - 10);
  }

  const tier = calculateTier(score, percentRecommended);
  return { score, percentRecommended, tier };
}

/**
 * Calculates the tier rating according to OpenCritic / Metacritic standards.
 */
export function calculateTier(score: number, percentRecommended?: number): CriticTier {
  if (score >= 84 && (percentRecommended === undefined || percentRecommended >= 85)) {
    return 'Mighty';
  }
  if (score >= 74) return 'Strong';
  if (score >= 66) return 'Fair';
  return 'Weak';
}

/**
 * Returns Tailwind design tokens for styling critic badges according to tier.
 */
export function getTierColor(tier?: CriticTier) {
  switch (tier) {
    case 'Mighty':
      return {
        badgeBg: 'bg-[#3b1261]/90',
        badgeBorder: 'border-[#a855f7]/70',
        badgeText: 'text-[#d8b4fe]',
        scoreBg: 'bg-gradient-to-br from-[#9333ea] to-[#6b21a8]',
        accentText: 'text-[#c084fc]',
        glow: 'shadow-[0_0_16px_rgba(168,85,247,0.35)]',
        cardGlow: 'shadow-[0_0_20px_rgba(168,85,247,0.25)]',
      };
    case 'Strong':
      return {
        badgeBg: 'bg-[#064e3b]/90',
        badgeBorder: 'border-[#10b981]/70',
        badgeText: 'text-[#6ee7b7]',
        scoreBg: 'bg-gradient-to-br from-[#059669] to-[#047857]',
        accentText: 'text-[#34d399]',
        glow: 'shadow-[0_0_16px_rgba(16,185,129,0.35)]',
        cardGlow: 'shadow-[0_0_20px_rgba(16,185,129,0.25)]',
      };
    case 'Fair':
      return {
        badgeBg: 'bg-[#78350f]/90',
        badgeBorder: 'border-[#f59e0b]/70',
        badgeText: 'text-[#fde68a]',
        scoreBg: 'bg-gradient-to-br from-[#d97706] to-[#b45309]',
        accentText: 'text-[#fbbf24]',
        glow: 'shadow-[0_0_16px_rgba(245,158,11,0.35)]',
        cardGlow: 'shadow-[0_0_20px_rgba(245,158,11,0.25)]',
      };
    case 'Weak':
    default:
      return {
        badgeBg: 'bg-[#7f1d1d]/90',
        badgeBorder: 'border-[#ef4444]/70',
        badgeText: 'text-[#fca5a5]',
        scoreBg: 'bg-gradient-to-br from-[#dc2626] to-[#991b1b]',
        accentText: 'text-[#f87171]',
        glow: 'shadow-[0_0_16px_rgba(239,68,68,0.35)]',
        cardGlow: 'shadow-[0_0_20px_rgba(239,68,68,0.25)]',
      };
  }
}

import {
  normalizeTitleKey,
  stripEditionSuffix as commonStripEditionSuffix,
  isSequelMismatch as commonIsSequelMismatch,
  ROMAN_TO_ARABIC,
} from '../common/titleUtils';

export { ROMAN_TO_ARABIC };

/**
 * Normalizes title string for robust aggregator matching.
 */
export function normalizeCriticTitleKey(title: string): string {
  return normalizeTitleKey(title);
}

/**
 * Strips edition suffixes (e.g. Definitive Edition, Deluxe, Gold, Remastered) for base title fallback.
 */
export function stripEditionSuffix(title: string): string {
  return commonStripEditionSuffix(title);
}

/**
 * Detects whether a search candidate is a numbered or Roman numeral sequel to prevent false-positive matching.
 */
export function isSequelMismatch(query: string, candidateName: string): boolean {
  return commonIsSequelMismatch(query, candidateName);
}

export type ReviewSourceShortTag = 'MC' | 'OC' | 'MCU' | 'STM' | 'GOG' | 'EGS' | 'XBX' | 'CST';

export interface ReviewSourceDisplayMeta {
  shortTag: ReviewSourceShortTag;
  label: string;
  shortLabel: string;
  cardHeading: string;
  actionLabel: string;
  externalLinkPrefix: string;
  isPressCritic: boolean;
  isStoreRating: boolean;
  authorityRank: number;
  ariaLabel: string;
}

const VALID_CRITIC_SOURCES: ReadonlySet<CriticSource> = new Set([
  'opencritic',
  'metacritic',
  'metacritic_user',
  'steam',
  'gog',
  'epic',
  'xbox',
  'custom',
]);

const VALID_CRITIC_TIERS: ReadonlySet<CriticTier> = new Set([
  'Mighty',
  'Strong',
  'Fair',
  'Weak',
]);

function isXboxStoreHostUrl(url?: string): boolean {
  if (!url || typeof url !== 'string') return false;
  try {
    const host = new URL(url.trim()).hostname.toLowerCase();
    return host === 'xbox.com' || host.endsWith('.xbox.com');
  } catch {
    return false;
  }
}

function isOpenCriticHostUrl(url?: string): boolean {
  if (!url || typeof url !== 'string') return false;
  try {
    const host = new URL(url.trim()).hostname.toLowerCase();
    return host === 'opencritic.com' || host.endsWith('.opencritic.com');
  } catch {
    return false;
  }
}

function isMetacriticHostUrl(url?: string): boolean {
  if (!url || typeof url !== 'string') return false;
  try {
    const host = new URL(url.trim()).hostname.toLowerCase();
    return host === 'metacritic.com' || host.endsWith('.metacritic.com');
  } catch {
    return false;
  }
}

function resolveCanonicalCriticSource(score: CriticScoreData): CriticSource {
  const rawSource =
    typeof score.source === 'string' ? score.source.trim().toLowerCase() : '';
  switch (rawSource) {
    case 'metacritic':
    case 'opencritic':
    case 'metacritic_user':
    case 'steam':
    case 'gog':
    case 'epic':
    case 'xbox':
    case 'custom':
      return rawSource;
    default:
      if (
        String(score.id || '').toLowerCase().startsWith('xbox-') ||
        isXboxStoreHostUrl(score.url)
      ) {
        return 'xbox';
      }
      if (isOpenCriticHostUrl(score.url)) {
        return 'opencritic';
      }
      return 'custom';
  }
}

/**
 * Parses and normalizes a raw `critic_json` payload hydrated from SQLite `vault_games`.
 * Preserves all numeric ratings, review counts, and verification flags losslessly while
 * classifying unknown/untagged legacy entries consistently with authority ranking.
 */
export function parseVaultCriticScore(raw: unknown): CriticScoreData | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const candidate = raw as Record<string, unknown>;
  const rawScore = candidate.score;
  if (typeof rawScore !== 'number' || !Number.isFinite(rawScore) || rawScore <= 0) {
    return null;
  }

  const rawId = candidate.id;
  const rawUrl = typeof candidate.url === 'string' ? candidate.url.trim() : '';
  const rawSource =
    typeof candidate.source === 'string' ? candidate.source.trim().toLowerCase() : '';
  const resolvedSource: CriticSource = VALID_CRITIC_SOURCES.has(rawSource as CriticSource)
    ? (rawSource as CriticSource)
    : String(rawId || '').toLowerCase().startsWith('xbox-') || isXboxStoreHostUrl(rawUrl)
    ? 'xbox'
    : isOpenCriticHostUrl(rawUrl)
    ? 'opencritic'
    : isMetacriticHostUrl(rawUrl)
    ? 'metacritic'
    : 'custom';

  const rawPercent = candidate.percentRecommended;
  const percentRecommended =
    typeof rawPercent === 'number' && Number.isFinite(rawPercent) ? rawPercent : undefined;

  const rawTier = candidate.tier;
  const resolvedTier: CriticTier =
    typeof rawTier === 'string' && VALID_CRITIC_TIERS.has(rawTier as CriticTier)
      ? (rawTier as CriticTier)
      : calculateTier(rawScore, percentRecommended);

  const rawUserScore = candidate.userScoreRaw;
  const rawStarRating = candidate.starRatingRaw;
  const rawNumReviews = candidate.numReviews;
  const rawPercentile = candidate.percentile;
  const rawSummary = candidate.summary;
  const rawVerified = candidate.isVerified;
  const rawSynthetic = candidate.isSynthetic;

  return {
    ...(typeof rawId === 'string' || typeof rawId === 'number' ? { id: rawId } : {}),
    source: resolvedSource,
    score: rawScore,
    tier: resolvedTier,
    ...(typeof rawUserScore === 'number' && Number.isFinite(rawUserScore)
      ? { userScoreRaw: rawUserScore }
      : {}),
    ...(typeof rawStarRating === 'number' && Number.isFinite(rawStarRating)
      ? { starRatingRaw: rawStarRating }
      : {}),
    ...(typeof rawNumReviews === 'number' && Number.isFinite(rawNumReviews)
      ? { numReviews: rawNumReviews }
      : {}),
    ...(percentRecommended !== undefined ? { percentRecommended } : {}),
    ...(typeof rawPercentile === 'number' && Number.isFinite(rawPercentile)
      ? { percentile: rawPercentile }
      : {}),
    url: rawUrl,
    ...(typeof rawSummary === 'string' ? { summary: rawSummary } : {}),
    isVerified:
      typeof rawVerified === 'boolean'
        ? rawVerified
        : resolvedSource === 'metacritic' || resolvedSource === 'opencritic',
    ...(typeof rawSynthetic === 'boolean' ? { isSynthetic: rawSynthetic } : {}),
  };
}

/**
 * Computes the monotonic authority rank of a critic or community review score:
 * - 5: Tier 0 user override (explicit human override with valid score)
 * - 4: Verified Metacritic Metascore ('metacritic')
 * - 3: Verified OpenCritic Top Critic Average ('opencritic')
 * - 2: High-sample community consensus ('metacritic_user' >= 25 reviews or 'steam' >= 10 reviews)
 * - 1: Storefront star ratings ('gog' / 'epic' / 'xbox'), 'custom', or low-sample 'metacritic_user'/'steam'
 * - 0: Missing / null / non-positive score
 */
export function getReviewSourceAuthorityRank(
  score: CriticScoreData | null | undefined,
  options?: { isUserOverride?: boolean }
): number {
  if (
    !score ||
    typeof score !== 'object' ||
    Array.isArray(score) ||
    typeof score.score !== 'number' ||
    !Number.isFinite(score.score) ||
    score.score <= 0
  ) {
    return 0;
  }

  const metaFields = score as unknown as {
    isUserOverride?: unknown;
    userOverride?: unknown;
    tier?: unknown;
    reviewCount?: unknown;
  };
  if (
    Boolean(
      options?.isUserOverride ||
        metaFields.isUserOverride === true ||
        metaFields.userOverride === true ||
        metaFields.tier === 'override'
    )
  ) {
    return 5;
  }

  const rawReviews =
    typeof score.numReviews === 'number' && Number.isFinite(score.numReviews)
      ? score.numReviews
      : typeof metaFields.reviewCount === 'number' && Number.isFinite(metaFields.reviewCount)
        ? metaFields.reviewCount
        : 0;
  const numReviews = rawReviews > 0 ? rawReviews : 0;

  switch (resolveCanonicalCriticSource(score)) {
    case 'metacritic':
      return 4;
    case 'opencritic':
      return 3;
    case 'metacritic_user':
      return numReviews >= 25 ? 2 : 1;
    case 'steam':
      return numReviews >= 10 ? 2 : 1;
    case 'gog':
    case 'epic':
    case 'xbox':
    case 'custom':
      return 1;
  }
}

function buildAccessibleScoreSummary(label: string, score: CriticScoreData): string {
  const tierSuffix = score.tier ? `, ${score.tier}` : '';
  const source = resolveCanonicalCriticSource(score);
  if (
    source === 'metacritic_user' &&
    typeof score.userScoreRaw === 'number' &&
    Number.isFinite(score.userScoreRaw)
  ) {
    return `${label}: ${score.userScoreRaw} out of 10 (${score.score} out of 100)${tierSuffix}`;
  }
  if (
    (source === 'gog' || source === 'epic' || source === 'xbox') &&
    typeof score.starRatingRaw === 'number' &&
    Number.isFinite(score.starRatingRaw)
  ) {
    return `${label}: ${score.starRatingRaw} out of 5 stars (${score.score} out of 100)${tierSuffix}`;
  }
  const recSuffix =
    typeof score.percentRecommended === 'number' && Number.isFinite(score.percentRecommended)
      ? `, ${score.percentRecommended}% recommended`
      : '';
  return `${label}: ${score.score} out of 100${tierSuffix}${recSuffix}`;
}

/**
 * Single source of truth for display tags, headings, link labels, authority rank, and WCAG aria labels
 * across all 8 CriticSource values ('metacritic', 'opencritic', 'metacritic_user', 'steam', 'gog',
 * 'epic', 'xbox', 'custom').
 */
export function getReviewSourceDisplayMeta(score: CriticScoreData): ReviewSourceDisplayMeta {
  const source = resolveCanonicalCriticSource(score);
  const authorityRank = getReviewSourceAuthorityRank(score);

  switch (source) {
    case 'metacritic': {
      const label = 'Metacritic Metascore';
      return {
        shortTag: 'MC',
        label,
        shortLabel: 'Metacritic',
        cardHeading: 'Metacritic Reviews',
        actionLabel: 'View on Metacritic',
        externalLinkPrefix: 'View Metacritic reviews for',
        isPressCritic: true,
        isStoreRating: false,
        authorityRank,
        ariaLabel: buildAccessibleScoreSummary(label, score),
      };
    }
    case 'opencritic': {
      const label = 'OpenCritic';
      return {
        shortTag: 'OC',
        label,
        shortLabel: 'OpenCritic',
        cardHeading: 'OpenCritic Reviews',
        actionLabel: 'View on OpenCritic',
        externalLinkPrefix: 'View OpenCritic reviews for',
        isPressCritic: true,
        isStoreRating: false,
        authorityRank,
        ariaLabel: buildAccessibleScoreSummary(label, score),
      };
    }
    case 'metacritic_user': {
      const label = 'Metacritic User Score';
      return {
        shortTag: 'MCU',
        label,
        shortLabel: 'MC User Score',
        cardHeading: 'Metacritic User Score',
        actionLabel: 'View Metacritic User Reviews',
        externalLinkPrefix: 'View Metacritic user reviews for',
        isPressCritic: false,
        isStoreRating: false,
        authorityRank,
        ariaLabel: buildAccessibleScoreSummary(label, score),
      };
    }
    case 'steam': {
      const label = 'Steam Community';
      return {
        shortTag: 'STM',
        label,
        shortLabel: 'Steam Community',
        cardHeading: 'Steam Community Score',
        actionLabel: 'View on Steam Store',
        externalLinkPrefix: 'View Steam reviews for',
        isPressCritic: false,
        isStoreRating: false,
        authorityRank,
        ariaLabel: buildAccessibleScoreSummary(label, score),
      };
    }
    case 'gog': {
      const label = 'GOG Player Rating';
      return {
        shortTag: 'GOG',
        label,
        shortLabel: 'GOG Rating',
        cardHeading: 'GOG Player Rating',
        actionLabel: 'View on GOG',
        externalLinkPrefix: 'View GOG ratings for',
        isPressCritic: false,
        isStoreRating: true,
        authorityRank,
        ariaLabel: buildAccessibleScoreSummary(label, score),
      };
    }
    case 'epic': {
      const label = 'Epic Store Rating';
      return {
        shortTag: 'EGS',
        label,
        shortLabel: 'Epic Rating',
        cardHeading: 'Epic Store Rating',
        actionLabel: 'View on Epic Store',
        externalLinkPrefix: 'View Epic Store ratings for',
        isPressCritic: false,
        isStoreRating: true,
        authorityRank,
        ariaLabel: buildAccessibleScoreSummary(label, score),
      };
    }
    case 'xbox': {
      const label = 'Xbox Store Rating';
      return {
        shortTag: 'XBX',
        label,
        shortLabel: 'Xbox Rating',
        cardHeading: 'Xbox Store Rating',
        actionLabel: 'View on Xbox Store',
        externalLinkPrefix: 'View Xbox Store ratings for',
        isPressCritic: false,
        isStoreRating: true,
        authorityRank,
        ariaLabel: buildAccessibleScoreSummary(label, score),
      };
    }
    case 'custom': {
      const label = 'Custom Score';
      return {
        shortTag: 'CST',
        label,
        shortLabel: 'Custom Score',
        cardHeading: 'Custom Review Score',
        actionLabel: 'View Review Source',
        externalLinkPrefix: 'View custom review source for',
        isPressCritic: false,
        isStoreRating: false,
        authorityRank,
        ariaLabel: buildAccessibleScoreSummary(label, score),
      };
    }
  }
}

