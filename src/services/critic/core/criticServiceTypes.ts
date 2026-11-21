import {
  CRITIC_STORAGE_PREFIX,
  type CriticScoreData,
} from '../../../contracts/critic';
import steamEnrichedCache from '../../storage/steamEnrichedCache.json';
import type { UserGameOverride } from '../../../contracts/override';
import type { MutabilityTier } from '../../storage/stagedCacheService';
import { KNOWN_CRITIC_SCORES } from '../knownCriticScores';

export const STORAGE_PREFIX = CRITIC_STORAGE_PREFIX;
export const PREV_STORAGE_PREFIX = 'antigravity_critic_v7_';
export const LEGACY_STORAGE_PREFIX = 'antigravity_critic_score_';
export const CRITIC_SCHEMA_V16_KEY = 'antigravity_critic_schema_v16';
export const LAZY_MIGRATION_CHUNK_SIZE = 100;
export const MAX_NON_CRITIC_TTL_MS = 14 * 24 * 60 * 60 * 1000; // 14 days
export const MAX_TRANSIENT_FALLBACK_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours
export const SELF_HEAL_FALLBACK_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
export const VAULT_WRITE_THROUGH_DEBOUNCE_MS = 250;

export const NON_GAME_ADDON_OR_BETA_REGEX =
  /\b(public testing|tech beta|playtest|test branch|alpha version|beta version|closed beta|open beta|official walkthrough|walkthrough|digital goodies|digital comics|pre-game editor|resource archiver|playable teaser|bonus content)\b|\bcontent$/i;

export const NON_CRITIC_FALLBACK_SOURCES: ReadonlySet<CriticScoreData['source']> = new Set([
  'metacritic_user',
  'steam',
  'gog',
  'epic',
  'xbox',
]);

export const NON_OVERRIDE_EVENT_TYPES: ReadonlySet<string> = new Set([
  'confirmed-non-game',
  'confirmed-non-game-batch',
  'batch-confirmed-non-game',
  'unconfirmed-non-game',
  'hidden',
  'unhidden',
]);

export interface CriticEntitlementPlatform {
  platformId: string;
  platformGameId?: string;
  xboxProductId?: string;
  storefrontAppId?: string;
}

export interface CriticScoreContext {
  gameId?: string;
  platforms?: CriticEntitlementPlatform[];
}

export interface EnrichedSteamCriticCacheEntry {
  name?: string;
  releaseDate?: string;
  release_date?: string;
  genres?: string[];
  enrichedSource?: string;
  metadataQuality?: string;
  metacritic?: {
    score?: number;
    url?: string;
  };
  reviewSummary?: {
    positivePercent?: number;
    totalReviews?: number;
  };
}

export interface CompiledReviewOverrideIndex {
  hasAnyReviewOverride: boolean;
  byKey: Map<string, UserGameOverride>;
  byGameId: Map<string, UserGameOverride[]>;
  bySteamId: Map<number, UserGameOverride[]>;
  byLowerTitle: Map<string, UserGameOverride[]>;
  byNormTitle: Map<string, UserGameOverride[]>;
}

export interface MigrationV8Record {
  key: string;
  rawKey: string;
  appId?: number;
  effectiveTitle: string;
  normGroup: string;
  data: CriticScoreData | null;
  tier: MutabilityTier;
  cachedAt: number;
  ttlMs: number;
  rank: number;
  isOverride: boolean;
}

export interface PendingVaultCriticWrite {
  gameId: string;
  steamAppId?: number | null;
  canonicalTitle?: string;
  criticScore: CriticScoreData;
}

export const STEAM_ENRICHED_CRITIC_MAP: Record<string, EnrichedSteamCriticCacheEntry> =
  steamEnrichedCache;

export const STEAM_APP_ID_TO_TITLE = new Map<number, string>();
for (const [idStr, info] of Object.entries(STEAM_ENRICHED_CRITIC_MAP)) {
  if (info?.name) {
    STEAM_APP_ID_TO_TITLE.set(Number(idStr), String(info.name));
  }
}

/**
 * O(1) short-circuit guard for mutated-in-test `KNOWN_CRITIC_SCORES` table.
 */
export function hasAnyKnownCriticScore(): boolean {
  for (const key in KNOWN_CRITIC_SCORES) {
    if (Object.prototype.hasOwnProperty.call(KNOWN_CRITIC_SCORES, key)) {
      return true;
    }
  }
  return false;
}

/**
 * O(1) short-circuit guard for `STEAM_ENRICHED_CRITIC_MAP`.
 */
export function hasAnySteamEnrichedCriticEntry(): boolean {
  for (const key in STEAM_ENRICHED_CRITIC_MAP) {
    if (Object.prototype.hasOwnProperty.call(STEAM_ENRICHED_CRITIC_MAP, key)) {
      return true;
    }
  }
  return false;
}
