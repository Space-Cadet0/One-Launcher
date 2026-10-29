import { StorefrontId } from './platform';

/**
 * Global unlock rarity classification.
 */
export type AchievementRarityTier = 'ultra_rare' | 'rare' | 'uncommon' | 'common';

/**
 * Quantified progress towards completing an achievement.
 */
export interface AchievementProgress {
  current: number;
  max: number;
  percentage: number;
  unit?: string;
}

/**
 * Unified individual achievement model across Steam, GOG, Epic, and other storefronts.
 */
export interface DetailedAchievement {
  /** Unique composite identifier (e.g., 'steam:1091500:thefool' or 'epic:sandboxId:ach1') */
  id: string;

  /** Internal API name from store schema (e.g., 'thefool', 'ACH_KILL_100') */
  apiName: string;

  /** Human-readable display name */
  name: string;

  /** Description of unlock conditions */
  description?: string;

  /** True if the authenticated user has unlocked this achievement */
  unlocked: boolean;

  /** ISO 8601 string or Unix timestamp of when it was unlocked */
  unlockedAt?: string | number;

  /** Full color icon URL for unlocked state */
  iconUnlockedUrl: string;

  /** Desaturated / grayscale / locked icon URL provided by store */
  iconLockedUrl?: string;

  /** Global player unlock percentage (0.0% - 100.0%) */
  globalPercentage?: number;

  /** Rarity tier based on globalPercentage */
  rarityTier?: AchievementRarityTier;

  /** Partial progress towards completion if tracked */
  progress?: AchievementProgress;

  /** True if the achievement details are hidden by developers until unlocked */
  isSecret?: boolean;

  /** Optional Epic XP value (e.g., 20, 50, 100 XP) */
  xp?: number;

  /** Optional Xbox/Windows Gamerscore (e.g., 10G, 25G) */
  gamerscore?: number;

  /** Storefront where this achievement record originated */
  storefrontId: StorefrontId;
}

/**
 * Container for a game's complete achievements set on a specific storefront.
 */
export interface StorefrontAchievementsData {
  storefrontId: StorefrontId;
  storefrontName: string;
  total: number;
  unlocked: number;
  percentage: number;
  isMastered: boolean;
  totalXp?: number;
  earnedXp?: number;
  totalGamerscore?: number;
  earnedGamerscore?: number;
  achievements: DetailedAchievement[];
  syncedAt?: string;
  source: 'live_cloud' | 'local_cache' | 'schema_fallback';
  unlockPrecision?: 'exact' | 'summary_count_only';
  supportsAchievements?: boolean;
  schemaUnavailableOffline?: boolean;
}

export type AchievementLoadResult = StorefrontAchievementsData;

/**
 * Maps storefront IDs to their respective detailed achievements collection.
 */
export type MultiStoreAchievementsMap = Partial<Record<StorefrontId, StorefrontAchievementsData>>;
