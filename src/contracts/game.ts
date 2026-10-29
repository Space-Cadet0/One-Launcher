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

export type NativeOsPlatform = 'windows' | 'mac';

export type XboxOwnershipType = 'owned' | 'subscription' | 'owned_and_subscription';

export type XboxGamePassSyncMode =
  | 'owned_and_played'
  | 'full_pc_game_pass'
  | 'owned_only';

export type XboxBottleCompatibilityTier =
  | 'tier_a_supported'
  | 'tier_b_legacy_uwp'
  | 'tier_c_kernel_anticheat'
  | 'tier_c_external_launcher';

export interface XboxSubscriptionSummary {
  hasActiveSubscription: boolean;
  hasPcCatalogAccess: boolean;
  primaryProductId?: string;
  tierId?:
    | 'ultimate'
    | 'pc'
    | 'premium'
    | 'essential'
    | 'ea_play'
    | 'console_only'
    | 'none';
  tierDisplayName: string;
  status?: string;
  endDate?: string;
  autoRenew?: boolean;
  activeProductIds?: string[];
}

export interface GamePlatformOwnership {
  platformId: StorefrontId;
  platformGameId: string;
  storefrontAppId?: string;
  namespace?: string;
  catalogItemId?: string;
  originalTitle?: string;
  installed: boolean;
  installPath?: string;
  executablePath?: string;
  launchArguments?: string;
  installSize?: number;
  version?: string;
  runner?: string;
  isWindowsBinaryOnMac?: boolean;
  platforms?: {
    windows?: boolean;
    mac?: boolean;
    linux?: boolean;
  };
  xboxProductId?: string;
  packageFamilyName?: string;
  appUserModelId?: string;
  xboxTitleId?: string;
  scid?: string;
  msaAppId?: string;
  ownershipType?: XboxOwnershipType;
  gamePassTier?: string;
  isLeavingSoon?: boolean;
  isRecentlyAddedToGamePass?: boolean;
  subscriptionExpired?: boolean;
  externalStorefrontHandoff?: StorefrontId | 'riot';
  xboxBottleCompatibilityTier?: XboxBottleCompatibilityTier;
  packageFormat?: 'uwp' | 'gdk' | 'win32' | string;
  lastPlayed?: string;
  playtimeMinutes?: number;
  achievements?: StoreAchievementSummary;
}

export type PlatformOwnership = GamePlatformOwnership;

export interface CanonicalGame {
  id: string; // canonical slug / uuid
  title: string;
  originalStoreTitle?: string;
  sortTitle: string;
  steamAppId?: number;
  isExplicitNonSteam?: boolean;
  platforms: GamePlatformOwnership[];
  nativePlatforms?: NativeOsPlatform[];
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
  controllerSupport?: string;
  hdrSupport?: boolean;
  worksOn?: {
    windows?: boolean;
    mac?: boolean;
    linux?: boolean;
    Windows?: boolean;
    Mac?: boolean;
    Linux?: boolean;
  };
  platforms_os?: {
    windows?: boolean;
    mac?: boolean;
    linux?: boolean;
  };
  reviewScoreOverride?: CriticScoreData | null;
  lastSyncedAt?: string;
  matchConfidence?: number;
  needsMatchReview?: boolean;
  isVerifiedEntitlement?: boolean;
}

