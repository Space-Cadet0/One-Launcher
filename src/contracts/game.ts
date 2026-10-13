import { StorefrontId } from './platform';
import { SteamEnrichedMetadata, SteamReviewSummary } from './steam';
import type { CriticScoreData } from './critic';

export type AchievementDataSource =
  | 'live_cloud_api'
  | 'live_cloud_xml'
  | 'live_cloud_graphql'
  | 'local_client_cache'
  | 'baseline_fallback';

export interface StoreAchievementSummary {
  unlocked: number;
  total: number;
  percentage: number;
  gamerscore?: { earned: number; total: number }; // For Xbox (e.g. 850 / 1000 G)
  xp?: { earned: number; total: number };         // For Epic Games (e.g. 600 / 1000 XP)
  isMastered?: boolean;                           // 100% unlocked
  lastUnlockedAt?: string;
  source?: AchievementDataSource;
  syncedAt?: string;                              // ISO 8601 timestamp
  hasConflict?: boolean;
  conflictDetails?: string;
}

export interface GamePlatformOwnership {
  platformId: StorefrontId;
  platformGameId: string;
  installed: boolean;
  installPath?: string;
  lastPlayed?: string;
  playtimeMinutes?: number;
  achievements?: StoreAchievementSummary;
}

export interface CanonicalGame {
  id: string; // canonical slug / uuid
  title: string;
  sortTitle: string;
  steamAppId?: number;
  isExplicitNonSteam?: boolean;
  platforms: GamePlatformOwnership[];
  headerImage: string;
  capsuleImage?: string;
  iconUrl?: string;
  shortDescription?: string;
  detailedDescription?: string;
  releaseDate?: string;
  developers: string[];
  publishers: string[];
  genres: string[];
  tags: string[];
  reviewSummary?: SteamReviewSummary;
  enrichedMetadata?: SteamEnrichedMetadata;
  reviewScoreOverride?: CriticScoreData | null;
  lastSyncedAt?: string;
  matchConfidence?: number;
  needsMatchReview?: boolean;
  isVerifiedEntitlement?: boolean;
}

