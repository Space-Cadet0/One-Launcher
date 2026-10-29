/**
 * Critic Scoring Contracts & Data Models
 * Supports OpenCritic (primary) and Metacritic (fallback) with verified metrics.
 */

export type CriticTier = 'Mighty' | 'Strong' | 'Fair' | 'Weak';
export type CriticSource =
  | 'opencritic'
  | 'metacritic'
  | 'metacritic_user'
  | 'steam'
  | 'gog'
  | 'epic'
  | 'xbox'
  | 'custom';

export interface CriticScoreData {
  /** Optional provider ID (e.g. OpenCritic numeric ID 8450 or Metacritic/GOG slug) */
  id?: number | string;

  /** Which aggregator verified or supplied this score */
  source: CriticSource;

  /** Top Critic Average (OpenCritic), Metascore (Metacritic), normalized community score, or converted 5-star rating (0-100) */
  score: number;

  /** Raw Metacritic user score on 0-10 scale (e.g. 7.8) when source is 'metacritic_user' */
  userScoreRaw?: number;

  /** Raw Storefront star rating on 0-5 scale (e.g. 4.1) when source is 'gog' or 'epic' */
  starRatingRaw?: number;

  /** Percentage of critics recommending the game (0-100), if provided by OpenCritic */
  percentRecommended?: number;

  /** Tier classification based on score and recommendation ratio */
  tier: CriticTier;

  /** Total number of reviews counted (critic reviews or user reviews) */
  numReviews?: number;

  /** Direct canonical URL to the game's review page (never an empty search route) */
  url: string;

  /** Critic consensus summary or user sentiment blurb */
  summary?: string;

  /** Percentile ranking compared to all reviewed titles (e.g. 93rd percentile) */
  percentile?: number;

  /** True when the score originates from genuine verified professional critical reviews */
  isVerified: boolean;

  /** True when the score is synthetic, derived from Steam community sentiment */
  isSynthetic?: boolean;
}

/** Backward compatibility aliases for existing imports */
export type OpenCriticTier = CriticTier;
export type OpenCriticData = CriticScoreData;

/**
 * Direct review signal or link embedded directly within the official store listing page (Steam, GOG, Epic).
 * Used as an authoritative Ground Truth Anchor to verify or corroborate Metacritic / OpenCritic scores.
 */
export interface StorefrontReviewAnchor {
  storefront: 'steam' | 'gog' | 'epic' | 'xbox';
  metacriticUrl?: string;
  metacriticScore?: number;
  metacriticSlug?: string;
  openCriticId?: number;
  openCriticUrl?: string;
  openCriticScore?: number;
  rawStoreUrl?: string;
  isVerifiedGroundTruth?: boolean;
}

