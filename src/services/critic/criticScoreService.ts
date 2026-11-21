import { CriticScoreData, OpenCriticData, StorefrontReviewAnchor } from '../../contracts/critic';
import { classifyNetworkError } from '../../contracts/network';
import type { CanonicalGame, GamePlatformOwnership } from '../../contracts/game';
import type { StorefrontId } from '../../contracts/platform';
import type { UserGameOverride, ReviewScoreRoute } from '../../contracts/override';
import { KNOWN_CRITIC_SCORES, KNOWN_UNRATED_TITLES } from './knownCriticScores';
import steamEnrichedCache from '../storage/steamEnrichedCache.json';
import { FULL_USER_STEAM_GAMES } from '../storage/fullUserSteamGames';
import {
  determineGameMutabilityTier,
  saveStagedCache,
  loadStagedCache,
  evictStagedCache,
  clearExpiredStagedCache,
  isCacheEntryValid,
  isStagedVaultHydrationComplete,
  TIER_TTLS,
  MutabilityTier,
} from '../storage/stagedCacheService';
import {
  getUserOverrideForGame,
  loadUserOverrides,
  inferReviewRouteFromOverride,
  patchUserOverrideReviewScore,
} from '../storage/userOverrideStorage';
import {
  calculateSyntheticSteamScore,
  calculateTier,
  getTierColor,
  getReviewSourceAuthorityRank,
  getReviewSourceDisplayMeta,
  normalizeCriticTitleKey,
  stripEditionSuffix,
  isSequelMismatch,
} from './criticUtils';
import {
  extractParentheticalReleaseYear,
  normalizeTitleForStoreSearch,
} from '../common/titleUtils';
import {
  metacriticResolver,
  isTitleCompatible,
  isAnchorMatch,
  isAnchorSlugCompatible,
  sanitizeMetacriticDescription,
  hasExplicitClassicOrOriginalEditionTag,
} from './metacriticResolver';
import { steamReviewResolver } from './steamReviewResolver';
import { storefrontStarResolver } from './storefrontStarResolver';
import {
  storefrontReviewHarvester,
  extractMetacriticSlugFromUrl,
} from './storefrontReviewHarvester';
import { wikidataBridge, normalizeWikidataGogSlug } from './wikidataBridge';
import { openCriticResolver } from './openCriticResolver';
import { Priority } from '../network/requestScheduler';
import { onlineLifecycleManager } from '../network/onlineLifecycleManager';

const NON_OVERRIDE_EVENT_TYPES: ReadonlySet<string> = new Set([
  'confirmed-non-game',
  'confirmed-non-game-batch',
  'batch-confirmed-non-game',
  'unconfirmed-non-game',
  'hidden',
  'unhidden',
]);

function extractValidGameOverrideFromEventDetail(
  detail: unknown
): { override: UserGameOverride; oldGame?: CanonicalGame } | null {
  if (!detail || typeof detail !== 'object') return null;
  const record = detail as Record<string, unknown>;
  const hasExplicitOverride = Boolean(record.override && typeof record.override === 'object');
  if (
    !hasExplicitOverride &&
    ('isHidden' in record ||
      'hiddenGameId' in record ||
      'unhiddenKey' in record ||
      (typeof record.type === 'string' && NON_OVERRIDE_EVENT_TYPES.has(record.type)))
  ) {
    return null;
  }

  const candidate = (hasExplicitOverride ? record.override : record) as Partial<UserGameOverride> & {
    type?: unknown;
  };
  if (!candidate || typeof candidate !== 'object') return null;
  if (typeof candidate.type === 'string' && NON_OVERRIDE_EVENT_TYPES.has(candidate.type)) {
    return null;
  }

  const hasValidIdentifier =
    (typeof candidate.gameId === 'string' && candidate.gameId.trim().length > 0) ||
    (typeof candidate.title === 'string' && candidate.title.trim().length > 0) ||
    (typeof candidate.steamAppId === 'number' && candidate.steamAppId > 0) ||
    (typeof candidate.platformGameId === 'string' && candidate.platformGameId.trim().length > 0);
  if (!hasValidIdentifier) {
    return null;
  }

  const oldGame =
    record.oldGame && typeof record.oldGame === 'object'
      ? (record.oldGame as CanonicalGame)
      : undefined;
  return { override: candidate as UserGameOverride, oldGame };
}
// Re-export master dataset, utilities and exclusions for consumers and tests
export {
  KNOWN_CRITIC_SCORES,
  KNOWN_UNRATED_TITLES,
  calculateSyntheticSteamScore,
  calculateTier,
  getTierColor,
  getReviewSourceAuthorityRank,
  getReviewSourceDisplayMeta,
  normalizeCriticTitleKey,
  stripEditionSuffix,
  isSequelMismatch,
  storefrontStarResolver,
};

interface EnrichedSteamCriticCacheEntry {
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

const STEAM_ENRICHED_CRITIC_MAP: Record<string, EnrichedSteamCriticCacheEntry> = steamEnrichedCache;

function isUrlHostMatching(rawUrl: string | undefined, expectedDomain: string): boolean {
  if (!rawUrl || typeof rawUrl !== 'string') return false;
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    const target = expectedDomain.toLowerCase();
    return host === target || host.endsWith(`.${target}`);
  } catch {
    return false;
  }
}

const STEAM_APP_ID_TO_TITLE = new Map<number, string>();
for (const [idStr, info] of Object.entries(STEAM_ENRICHED_CRITIC_MAP)) {
  if (info?.name) {
    STEAM_APP_ID_TO_TITLE.set(Number(idStr), String(info.name));
  }
}
for (const g of FULL_USER_STEAM_GAMES) {
  if (g.steamAppId && g.title && !STEAM_APP_ID_TO_TITLE.has(g.steamAppId)) {
    STEAM_APP_ID_TO_TITLE.set(g.steamAppId, g.title);
  }
}

const NON_GAME_ADDON_OR_BETA_REGEX =
  /\b(public testing|tech beta|playtest|test branch|alpha version|beta version|closed beta|open beta|official walkthrough|walkthrough|digital goodies|digital comics|pre-game editor|resource archiver|playable teaser|bonus content)\b|\bcontent$/i;

/**
 * Unified Critic Score Service with Cascading Live Multi-Tier Resolution:
 * 1. Instant Cache & Master Dataset (0ms).
 * 2. Tier 1: Metacritic Live Critic Metascore (verified press consensus, >= 4 reviews).
 * 3. Tier 2: OpenCritic Live API (verified press consensus, >= 4 reviews).
 * 4. Tier 3: Metacritic Live User Score (authentic player sentiment, >= 4 user reviews).
 * 5. Tier 4: Steam Live Community Reviews (authentic player sentiment, >= 10 reviews).
 * 6. Tier 5: Storefront Star Rating (GOG/Epic 5-star rating converted to 0-100, >= 4 reviews).
 * 7. Tier 6: Null / Truly Unrated (betas, dev tools, internal playtests).
 */
const STORAGE_PREFIX = 'antigravity_critic_v8_';
const PREV_STORAGE_PREFIX = 'antigravity_critic_v7_';
const LEGACY_STORAGE_PREFIX = 'antigravity_critic_score_';

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

function parseOverrideUpdatedAt(ov?: UserGameOverride): number {
  if (!ov || typeof ov.updatedAt !== 'string') return 0;
  const parsed = Date.parse(ov.updatedAt);
  return Number.isFinite(parsed) ? parsed : 0;
}

interface CompiledReviewOverrideIndex {
  hasAnyReviewOverride: boolean;
  byKey: Map<string, UserGameOverride>;
  byGameId: Map<string, UserGameOverride[]>;
  bySteamId: Map<number, UserGameOverride[]>;
  byLowerTitle: Map<string, UserGameOverride[]>;
  byNormTitle: Map<string, UserGameOverride[]>;
}

const CRITIC_SCHEMA_V16_KEY = 'antigravity_critic_schema_v16';
const LAZY_MIGRATION_CHUNK_SIZE = 100;
const MAX_NON_CRITIC_TTL_MS = 14 * 24 * 60 * 60 * 1000; // 14 days
const MAX_TRANSIENT_FALLBACK_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours
const SELF_HEAL_FALLBACK_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const VAULT_WRITE_THROUGH_DEBOUNCE_MS = 250;

const NON_CRITIC_FALLBACK_SOURCES: ReadonlySet<CriticScoreData['source']> = new Set([
  'metacritic_user',
  'steam',
  'gog',
  'epic',
  'xbox',
]);

interface MigrationV8Record {
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

interface PendingVaultCriticWrite {
  gameId: string;
  steamAppId?: number | null;
  canonicalTitle?: string;
  criticScore: CriticScoreData;
}

export class CriticScoreService {
  public static readonly MAX_IN_MEMORY_CACHE_SIZE = 4096;
  public static readonly EVICT_TARGET_CACHE_SIZE = 3500;
  private inMemoryCache = new Map<string, CriticScoreData | null>();
  private semanticValidationMemo = new WeakMap<CriticScoreData, Map<string, boolean>>();
  private compiledOverrideIndexMemo = new WeakMap<object, CompiledReviewOverrideIndex>();
  private inFlightResolutions = new Map<string, Promise<CriticScoreData | null>>();
  private pendingPassiveTriggers = new Map<string, Promise<CriticScoreData | null>>();
  private attemptedDynamicResolutions = new Set<string>();
  private stubPinnedKeys = new Set<string>();
  private transientFailureCounts = new Map<string, number>();
  private pendingStorageTasks = new Map<string, () => void>();
  private pendingVaultCriticWrites = new Map<string, PendingVaultCriticWrite>();
  private vaultWriteThroughTimer: ReturnType<typeof setTimeout> | null = null;
  private storageFlushScheduled = false;
  private isPassiveRenderTrigger = false;
  private lazyMigrationTimer: ReturnType<typeof setTimeout> | null = null;
  private listenersInitialized = false;
  private listenerCleanups: Array<() => void> = [];
  private storageHydrated = false;

  private setInMemoryCache(key: string, value: CriticScoreData | null): void {
    if (this.inMemoryCache.has(key)) {
      this.inMemoryCache.delete(key);
    }
    this.inMemoryCache.set(key, value);
    if (this.inMemoryCache.size > CriticScoreService.MAX_IN_MEMORY_CACHE_SIZE) {
      while (this.inMemoryCache.size > CriticScoreService.EVICT_TARGET_CACHE_SIZE) {
        const oldestKey = this.inMemoryCache.keys().next().value;
        if (oldestKey === undefined) break;
        this.inMemoryCache.delete(oldestKey);
      }
    }
  }

  private scheduleDeferredStorageTask(dedupKey: string, task: () => void): void {
    this.pendingStorageTasks.set(dedupKey, task);
    if (this.storageFlushScheduled) return;
    this.storageFlushScheduled = true;
    const flush = () => {
      this.storageFlushScheduled = false;
      const entries = Array.from(this.pendingStorageTasks.entries());
      this.pendingStorageTasks.clear();
      for (const [, fn] of entries) {
        try {
          fn();
        } catch {}
      }
    };
    if (typeof queueMicrotask === 'function') {
      queueMicrotask(flush);
    } else {
      Promise.resolve().then(flush);
    }
  }

  private cancelDeferredStorageTasksForKey(rawKey: string): void {
    if (!rawKey) return;
    const stagedKey = rawKey.startsWith(STORAGE_PREFIX) ? rawKey : `${STORAGE_PREFIX}${rawKey}`;
    this.pendingStorageTasks.delete(rawKey);
    this.pendingStorageTasks.delete(stagedKey);
    this.pendingStorageTasks.delete(`save:${rawKey}`);
    this.pendingStorageTasks.delete(`save:${stagedKey}`);
    this.pendingStorageTasks.delete(`evict:${rawKey}`);
    this.pendingStorageTasks.delete(`evict:${stagedKey}`);
  }

  private cancelLazyMigrationTimer(): void {
    if (this.lazyMigrationTimer !== null) {
      clearTimeout(this.lazyMigrationTimer);
      this.lazyMigrationTimer = null;
    }
  }

  private clearPendingVaultWrites(): void {
    if (this.vaultWriteThroughTimer !== null) {
      clearTimeout(this.vaultWriteThroughTimer);
      this.vaultWriteThroughTimer = null;
    }
    this.pendingVaultCriticWrites.clear();
  }

  private scheduleVaultCriticWriteThrough(
    gameId: string,
    criticScore: CriticScoreData,
    steamAppId?: number | null,
    canonicalTitle?: string
  ): void {
    if (!gameId || !criticScore || typeof criticScore.score !== 'number' || criticScore.score <= 0) {
      return;
    }
    if (
      typeof window === 'undefined' ||
      typeof window.electronAPI?.offlineVault?.saveGameDetail !== 'function'
    ) {
      return;
    }

    const existing = this.pendingVaultCriticWrites.get(gameId);
    if (existing) {
      const existingRank = getReviewSourceAuthorityRank(existing.criticScore);
      const incomingRank = getReviewSourceAuthorityRank(criticScore);
      if (incomingRank < existingRank) {
        return;
      }
    }

    this.pendingVaultCriticWrites.set(gameId, {
      gameId,
      steamAppId: typeof steamAppId === 'number' && steamAppId > 0 ? steamAppId : null,
      canonicalTitle: canonicalTitle?.trim() || undefined,
      criticScore,
    });

    if (this.vaultWriteThroughTimer !== null) {
      return;
    }

    const handle = setTimeout(() => {
      this.vaultWriteThroughTimer = null;
      if (
        typeof window === 'undefined' ||
        typeof window.electronAPI?.offlineVault?.saveGameDetail !== 'function'
      ) {
        this.pendingVaultCriticWrites.clear();
        return;
      }
      const batch = Array.from(this.pendingVaultCriticWrites.values());
      this.pendingVaultCriticWrites.clear();
      for (const item of batch) {
        try {
          void window.electronAPI.offlineVault
            .saveGameDetail({
              gameId: item.gameId,
              steamAppId: item.steamAppId ?? null,
              canonicalTitle: item.canonicalTitle,
              criticScore: { ...item.criticScore } as unknown as Record<string, unknown>,
            })
            ?.catch?.(() => {});
        } catch {}
      }
    }, VAULT_WRITE_THROUGH_DEBOUNCE_MS);
    if (handle && typeof (handle as { unref?: () => void }).unref === 'function') {
      (handle as { unref: () => void }).unref();
    }
    this.vaultWriteThroughTimer = handle;
  }

  constructor() {
    this.initEventListeners();
  }

  private ensureHydrated(): void {
    if (this.storageHydrated) return;
    this.storageHydrated = true;
    if (typeof localStorage === 'undefined') return;
    try {
      // M2: Fast O(1) short-circuit once v16 schema migration has completed —
      // zero synchronous full-storage scans and zero 12 MB catalog JSON.parse on startup.
      if (localStorage.getItem(CRITIC_SCHEMA_V16_KEY) === '1') {
        return;
      }
    } catch {
      return;
    }
    this.scheduleLazySchemaMigration();
  }

  private scheduleLazySchemaMigration(): void {
    if (this.lazyMigrationTimer !== null || typeof localStorage === 'undefined') return;
    const scheduleChunk = (fn: () => void) => {
      const handle = setTimeout(fn, 0);
      if (handle && typeof (handle as { unref?: () => void }).unref === 'function') {
        (handle as { unref: () => void }).unref();
      }
      this.lazyMigrationTimer = handle;
    };

    scheduleChunk(() => {
      this.lazyMigrationTimer = null;
      if (typeof localStorage === 'undefined') return;
      try {
        if (localStorage.getItem(CRITIC_SCHEMA_V16_KEY) === '1') {
          return;
        }
        const totalKeys = localStorage.length;
        if (totalKeys === 0) {
          localStorage.setItem(CRITIC_SCHEMA_V16_KEY, '1');
          return;
        }
        const allKeys: string[] = [];
        for (let i = 0; i < totalKeys; i++) {
          const k = localStorage.key(i);
          if (k) allKeys.push(k);
        }
        const legacyKeys: string[] = [];
        const v8Keys: string[] = [];
        for (const key of allKeys) {
          if (
            key.startsWith(LEGACY_STORAGE_PREFIX) ||
            key.startsWith(PREV_STORAGE_PREFIX) ||
            key.startsWith('antigravity_critic_v6_') ||
            key.startsWith('antigravity_critic_v5_')
          ) {
            legacyKeys.push(key);
          } else if (key.startsWith(STORAGE_PREFIX)) {
            v8Keys.push(key);
          }
        }

        // Only parse the catalog if v8 critic entries actually exist to validate / self-heal
        const catalogTitleByAppId = new Map<number, string>();
        const catalogAppIdByTitle = new Map<string, number>();
        const catalogGameIdByAppId = new Map<number, string>();
        const catalogGameIdByNormTitle = new Map<string, string>();
        if (v8Keys.length > 0) {
          this.populateCatalogMapsForMigration(
            catalogTitleByAppId,
            catalogAppIdByTitle,
            catalogGameIdByAppId,
            catalogGameIdByNormTitle
          );
        }

        let legacyIdx = 0;
        let v8Idx = 0;
        const v8Remove: string[] = [];
        const siblingGroups = new Map<string, MigrationV8Record[]>();

        const runNextChunk = () => {
          this.lazyMigrationTimer = null;
          if (typeof localStorage === 'undefined') return;
          try {
            if (localStorage.getItem(CRITIC_SCHEMA_V16_KEY) === '1') {
              return;
            }
            let processed = 0;
            while (legacyIdx < legacyKeys.length && processed < LAZY_MIGRATION_CHUNK_SIZE) {
              try {
                localStorage.removeItem(legacyKeys[legacyIdx]);
              } catch {}
              legacyIdx += 1;
              processed += 1;
            }
            while (v8Idx < v8Keys.length && processed < LAZY_MIGRATION_CHUNK_SIZE) {
              const key = v8Keys[v8Idx];
              v8Idx += 1;
              processed += 1;
              if (
                this.shouldEvictV8KeyDuringMigration(
                  key,
                  catalogTitleByAppId,
                  catalogAppIdByTitle,
                  siblingGroups
                )
              ) {
                v8Remove.push(key);
              }
            }
            if (legacyIdx < legacyKeys.length || v8Idx < v8Keys.length) {
              scheduleChunk(runNextChunk);
              return;
            }
            for (const k of v8Remove) {
              localStorage.removeItem(k);
              if (k.startsWith(STORAGE_PREFIX)) {
                const rawKey = k.slice(STORAGE_PREFIX.length);
                this.inMemoryCache.delete(rawKey);
                this.attemptedDynamicResolutions.delete(rawKey);
              }
            }
            const promotedCount = this.promoteShadowedAliasesDuringV16Migration(
              siblingGroups,
              catalogGameIdByAppId,
              catalogGameIdByNormTitle
            );
            this.cleanStaleSteamMatcherEntries();
            clearExpiredStagedCache({ onlyNegativeAndTransient: true });
            localStorage.setItem('antigravity_critic_schema_v9', '1');
            localStorage.setItem('antigravity_critic_schema_v10', '1');
            localStorage.setItem('antigravity_critic_schema_v11', '1');
            localStorage.setItem('antigravity_critic_schema_v12', '1');
            localStorage.setItem('antigravity_critic_schema_v13', '1');
            localStorage.setItem('antigravity_critic_schema_v14', '1');
            localStorage.setItem('antigravity_critic_schema_v15', '1');
            localStorage.setItem(CRITIC_SCHEMA_V16_KEY, '1');
            if (
              promotedCount > 0 &&
              typeof window !== 'undefined' &&
              typeof window.dispatchEvent === 'function'
            ) {
              try {
                window.dispatchEvent(
                  new CustomEvent('antigravity_critic_updated', {
                    detail: { hydratedFromVault: true },
                  })
                );
              } catch {}
            }
          } catch {}
        };

        runNextChunk();
      } catch {}
    });
  }

  private populateCatalogMapsForMigration(
    catalogTitleByAppId: Map<number, string>,
    catalogAppIdByTitle: Map<string, number>,
    catalogGameIdByAppId?: Map<number, string>,
    catalogGameIdByNormTitle?: Map<string, string>
  ): void {
    try {
      const rawCat = localStorage.getItem('universal_game_library_catalog');
      if (!rawCat) return;
      const parsedCat: unknown = JSON.parse(rawCat);
      if (!Array.isArray(parsedCat)) return;
      for (const item of parsedCat) {
        if (!item || typeof item !== 'object') continue;
        const g = item as { title?: unknown; steamAppId?: unknown; id?: unknown };
        if (typeof g.title !== 'string' || !g.title) continue;
        const normTitle = normalizeCriticTitleKey(g.title);
        const gameId = typeof g.id === 'string' && g.id.trim() ? g.id.trim() : '';
        if (gameId && normTitle && catalogGameIdByNormTitle) {
          catalogGameIdByNormTitle.set(normTitle, gameId);
        }
        const sid =
          typeof g.steamAppId === 'number' && g.steamAppId > 0
            ? g.steamAppId
            : typeof g.id === 'string' && g.id.startsWith('steam-')
            ? Number(g.id.slice(6))
            : 0;
        if (sid > 0) {
          catalogTitleByAppId.set(sid, g.title);
          catalogAppIdByTitle.set(g.title.toLowerCase().trim(), sid);
          if (normTitle) {
            catalogAppIdByTitle.set(normTitle, sid);
          }
          if (gameId && catalogGameIdByAppId) {
            catalogGameIdByAppId.set(sid, gameId);
          }
        }
      }
    } catch {}
  }

  private shouldEvictV8KeyDuringMigration(
    key: string,
    catalogTitleByAppId: Map<number, string>,
    catalogAppIdByTitle: Map<string, number>,
    siblingGroups?: Map<string, MigrationV8Record[]>
  ): boolean {
    const val = localStorage.getItem(key);
    if (!val) return true;
    try {
      const parsed = JSON.parse(val) as Record<string, unknown> & {
        data?: CriticScoreData | null;
        tier?: string;
        summary?: string;
        cachedAt?: number;
        ttlMs?: number;
        ttl?: number;
        dynamicResolved?: boolean;
      };
      const isStaged = Boolean(parsed && typeof parsed === 'object' && 'data' in parsed);
      const data: CriticScoreData | null = isStaged
        ? (parsed.data ?? null)
        : (parsed as unknown as CriticScoreData);
      const tier = isStaged ? parsed.tier : undefined;
      const rawKey = key.slice(STORAGE_PREFIX.length);
      const titleFromKey = rawKey.startsWith('title:') ? rawKey.slice(6).toLowerCase().trim() : '';
      const appId = rawKey.startsWith('id:')
        ? Number(rawKey.slice(3))
        : titleFromKey
        ? catalogAppIdByTitle.get(titleFromKey)
        : undefined;
      const effectiveTitle = rawKey.startsWith('title:')
        ? rawKey.slice(6)
        : appId
        ? STEAM_APP_ID_TO_TITLE.get(appId) || catalogTitleByAppId.get(appId) || ''
        : '';
      const normGroup = effectiveTitle ? normalizeCriticTitleKey(effectiveTitle) : '';

      const recordSibling = (entry: MigrationV8Record) => {
        if (!siblingGroups || !entry.normGroup) return;
        const list = siblingGroups.get(entry.normGroup);
        if (list) {
          list.push(entry);
        } else {
          siblingGroups.set(entry.normGroup, [entry]);
        }
      };

      if (tier === MutabilityTier.TIER_0_USER_OVERRIDE || tier === 'override') {
        recordSibling({
          key,
          rawKey,
          appId,
          effectiveTitle,
          normGroup,
          data,
          tier: MutabilityTier.TIER_0_USER_OVERRIDE,
          cachedAt: typeof parsed.cachedAt === 'number' ? parsed.cachedAt : Date.now(),
          ttlMs: Infinity,
          rank: 5,
          isOverride: true,
        });
        return false;
      }
      if (
        isStaged &&
        data === null &&
        (tier === 'negative' || tier === 'transient_error') &&
        isCacheEntryValid(parsed as unknown as Parameters<typeof isCacheEntryValid>[0])
      ) {
        return false;
      }

      if (
        data &&
        typeof data.score === 'number' &&
        data.score > 0 &&
        (data.source === 'metacritic' ||
          data.source === 'opencritic' ||
          data.source === 'metacritic_user' ||
          data.source === 'steam' ||
          data.source === 'gog' ||
          data.source === 'epic' ||
          data.source === 'xbox')
      ) {
        const origSummary = data.summary;
        if (effectiveTitle && !this.validateScoreSemanticCompatibility(effectiveTitle, data, appId)) {
          return true;
        }
        let mutated = false;
        if (origSummary && (data.source === 'metacritic' || data.source === 'metacritic_user')) {
          const sanitized = sanitizeMetacriticDescription(origSummary, data.numReviews || 20);
          if (sanitized !== origSummary) {
            data.summary = sanitized;
            if (isStaged && 'summary' in parsed) {
              parsed.summary = sanitized;
            }
            mutated = true;
          }
        }

        // Stage 0 v16 non-destructive fallback TTL un-pinning:
        // Cap any non-override MCU/STM/GOG/EGS/XBX entry with ttlMs > 14d down to 7d
        // without deleting the score (zero UI blanking while unlocking background upgrade).
        let effectiveTier: MutabilityTier =
          tier === 'immutable' ||
          tier === 'mature' ||
          tier === 'fresh' ||
          tier === 'early_access' ||
          tier === 'negative' ||
          tier === 'transient_error'
            ? tier
            : MutabilityTier.TIER_2_MATURE;
        const rawTtl =
          typeof parsed.ttlMs === 'number'
            ? parsed.ttlMs
            : typeof parsed.ttl === 'number'
            ? parsed.ttl
            : TIER_TTLS[effectiveTier];
        let effectiveTtlMs = rawTtl;
        const effectiveCachedAt = typeof parsed.cachedAt === 'number' ? parsed.cachedAt : Date.now();

        if (
          isStaged &&
          NON_CRITIC_FALLBACK_SOURCES.has(data.source) &&
          typeof rawTtl === 'number' &&
          rawTtl > MAX_NON_CRITIC_TTL_MS
        ) {
          effectiveTtlMs = SELF_HEAL_FALLBACK_TTL_MS;
          if (effectiveTier === MutabilityTier.TIER_1_IMMUTABLE) {
            effectiveTier = MutabilityTier.TIER_2_MATURE;
          }
          const fullDataForSave = parsed.__vaultFull
            ? (loadStagedCache<CriticScoreData>(key, false).data ?? data)
            : data;
          saveStagedCache<CriticScoreData>(key, fullDataForSave, effectiveTier, {
            source: fullDataForSave.source,
            isVerified: fullDataForSave.isVerified,
            dynamicResolved: parsed.dynamicResolved === true,
            cachedAt: effectiveCachedAt,
            customTtlMs: SELF_HEAL_FALLBACK_TTL_MS,
          });
          mutated = false;
        } else if (mutated) {
          localStorage.setItem(key, JSON.stringify(parsed));
        }

        recordSibling({
          key,
          rawKey,
          appId,
          effectiveTitle,
          normGroup,
          data,
          tier: effectiveTier,
          cachedAt: effectiveCachedAt,
          ttlMs: effectiveTtlMs,
          rank: getReviewSourceAuthorityRank(data),
          isOverride: false,
        });
        return false;
      }
      return true;
    } catch {
      return true;
    }
  }

  private promoteShadowedAliasesDuringV16Migration(
    siblingGroups: Map<string, MigrationV8Record[]>,
    catalogGameIdByAppId: Map<number, string>,
    catalogGameIdByNormTitle: Map<string, string>
  ): number {
    let promotedCount = 0;
    for (const group of siblingGroups.values()) {
      if (group.length < 2) continue;

      let bestDonor: MigrationV8Record | null = null;
      for (const entry of group) {
        if (entry.isOverride || !entry.data) continue;
        const isVerifiedPressCritic =
          entry.data.isVerified === true &&
          (entry.data.source === 'metacritic' || entry.data.source === 'opencritic') &&
          entry.rank >= 3;
        if (!isVerifiedPressCritic) continue;
        if (
          !bestDonor ||
          entry.rank > bestDonor.rank ||
          (entry.rank === bestDonor.rank && entry.cachedAt > bestDonor.cachedAt)
        ) {
          bestDonor = entry;
        }
      }

      if (!bestDonor || !bestDonor.data) continue;

      for (const target of group) {
        if (target.isOverride || target.rank >= bestDonor.rank) continue;
        const targetOverride = this.findMatchingUserOverride(target.appId, target.effectiveTitle);
        if (
          targetOverride &&
          (targetOverride.reviewScoreOverride !== undefined ||
            targetOverride.reviewRoute !== undefined)
        ) {
          continue;
        }
        if (
          target.effectiveTitle &&
          !this.validateScoreSemanticCompatibility(target.effectiveTitle, bestDonor.data, target.appId)
        ) {
          continue;
        }

        saveStagedCache<CriticScoreData>(target.key, bestDonor.data, bestDonor.tier, {
          source: bestDonor.data.source,
          isVerified: bestDonor.data.isVerified,
          dynamicResolved: true,
          cachedAt: bestDonor.cachedAt,
          customTtlMs: bestDonor.ttlMs,
        });
        this.setInMemoryCache(target.rawKey, bestDonor.data);
        this.attemptedDynamicResolutions.delete(target.rawKey);

        const gameId =
          (target.appId ? catalogGameIdByAppId.get(target.appId) : undefined) ||
          catalogGameIdByNormTitle.get(target.normGroup);
        if (gameId) {
          this.scheduleVaultCriticWriteThrough(
            gameId,
            bestDonor.data,
            target.appId ?? null,
            target.effectiveTitle || bestDonor.effectiveTitle
          );
        }
        promotedCount += 1;
      }
    }
    return promotedCount;
  }

  private cleanStaleSteamMatcherEntries(): void {
    const rawMatched = localStorage.getItem('antigravity_steam_matched_app_ids');
    if (!rawMatched) return;
    try {
      const parsedMatched = JSON.parse(rawMatched) as Record<string, unknown>;
      if (parsedMatched && typeof parsedMatched === 'object') {
        let changed = false;
        for (const [mk, mv] of Object.entries(parsedMatched)) {
          if (mv === null || typeof mv === 'object') {
            delete parsedMatched[mk];
            changed = true;
          } else if (typeof mv === 'number') {
            const enrichedName = STEAM_ENRICHED_CRITIC_MAP[String(mv)]?.name;
            if (
              enrichedName &&
              (isSequelMismatch(mk, enrichedName) || !isTitleCompatible(mk, enrichedName))
            ) {
              delete parsedMatched[mk];
              changed = true;
            }
          }
        }
        if (changed) {
          localStorage.setItem('antigravity_steam_matched_app_ids', JSON.stringify(parsedMatched));
        }
      }
    } catch {}
  }

  /**
   * O(1) targeted eviction of cached critic scores and sub-resolver entries for a single game,
   * replacing nuclear `clearCache()` on single-game override updates or removals (H4).
   */
  public evictCriticCacheForGame(
    gameId?: string | null,
    title?: string | null,
    steamAppId?: number | null,
    extra?: {
      deletedKeys?: string[];
      oldOverride?: Partial<UserGameOverride> | null;
      oldGame?: Partial<CanonicalGame> | null;
      platforms?: CriticEntitlementPlatform[];
    }
  ): void {
    const keysToEvict = new Set<string>();
    const titlesToEvict = new Set<string>();
    const steamIdsToEvict = new Set<number>();
    const xboxIdsToEvict = new Set<string>();

    const addTitleKeys = (rawTitle?: string | null) => {
      if (!rawTitle || typeof rawTitle !== 'string') return;
      const trimmed = rawTitle.trim();
      const lower = trimmed.toLowerCase();
      if (!lower) return;
      titlesToEvict.add(trimmed);
      titlesToEvict.add(lower);
      keysToEvict.add(`title:${lower}`);
      const aposStripped = lower.replace(/['’ʼ`]/g, '');
      if (aposStripped && aposStripped !== lower) {
        keysToEvict.add(`title:${aposStripped}`);
      }
      const norm = normalizeCriticTitleKey(trimmed);
      if (norm) {
        titlesToEvict.add(norm);
        keysToEvict.add(`title:${norm}`);
      }
      const stripped = stripEditionSuffix(trimmed);
      if (stripped) {
        keysToEvict.add(`title:${stripped}`);
      }
    };

    const addSteamIdKeys = (rawAppId?: number | null) => {
      if (typeof rawAppId === 'number' && Number.isFinite(rawAppId) && rawAppId > 0) {
        steamIdsToEvict.add(rawAppId);
        keysToEvict.add(`id:${rawAppId}`);
        keysToEvict.add(`steam-${rawAppId}`);
        keysToEvict.add(String(rawAppId));
      }
    };

    const addIdKeys = (rawId?: string | number | null) => {
      if (rawId === undefined || rawId === null) return;
      const str = String(rawId).trim();
      if (!str) return;
      keysToEvict.add(str);
      const cleanId = str.replace(/^steam[-_:]/i, '');
      if (cleanId) {
        keysToEvict.add(`id:${cleanId}`);
        if (/^\d+$/.test(cleanId)) {
          const parsedNum = Number(cleanId);
          if (parsedNum > 0) steamIdsToEvict.add(parsedNum);
        }
      }
      const xboxMatch = str.match(/^xbox[-_:]([a-z0-9]{12})$/i);
      if (xboxMatch?.[1]) {
        xboxIdsToEvict.add(xboxMatch[1]);
      } else if (/^[a-z0-9]{12}$/i.test(str) && !/^\d+$/.test(str)) {
        xboxIdsToEvict.add(str);
      }
      addTitleKeys(str);
    };

    const addPlatforms = (plats?: Array<{ platformId?: string; platformGameId?: string; xboxProductId?: string }>) => {
      if (!Array.isArray(plats)) return;
      for (const p of plats) {
        if (!p) continue;
        if (p.platformId === 'steam' && p.platformGameId && /^\d+$/.test(String(p.platformGameId))) {
          addSteamIdKeys(Number(p.platformGameId));
        } else if (p.platformId === 'xbox') {
          const xid = p.xboxProductId || p.platformGameId;
          if (xid) xboxIdsToEvict.add(String(xid));
        }
        if (p.platformId && p.platformGameId) {
          keysToEvict.add(`${p.platformId}:${p.platformGameId}`);
          keysToEvict.add(`${p.platformId}-${p.platformGameId}`);
        }
      }
    };

    addIdKeys(gameId);
    addTitleKeys(title);
    addSteamIdKeys(steamAppId);
    addPlatforms(extra?.platforms);

    if (Array.isArray(extra?.deletedKeys)) {
      for (const dk of extra.deletedKeys) {
        addIdKeys(dk);
      }
    }

    const oldOverride = extra?.oldOverride;
    if (oldOverride) {
      addIdKeys(oldOverride.gameId);
      addSteamIdKeys(oldOverride.steamAppId);
      if (oldOverride.matchedId !== undefined) {
        addIdKeys(oldOverride.matchedId);
      }
      if (oldOverride.platformId && oldOverride.platformGameId) {
        addPlatforms([{ platformId: oldOverride.platformId, platformGameId: oldOverride.platformGameId }]);
      }
      addSteamIdKeys(oldOverride.nativeBaseline?.steamAppId);
      addIdKeys(oldOverride.nativeBaseline?.id);
      addTitleKeys(oldOverride.title);
      addTitleKeys(oldOverride.originalSourceTitle);
      addTitleKeys(oldOverride.nativeBaseline?.title);
      if (oldOverride.reviewRoute) {
        addTitleKeys(oldOverride.reviewRoute.targetTitle);
        addSteamIdKeys(oldOverride.reviewRoute.steamAppId);
        if (oldOverride.reviewRoute.xboxProductId) {
          xboxIdsToEvict.add(oldOverride.reviewRoute.xboxProductId);
        }
      }
    }

    const oldGame = extra?.oldGame;
    if (oldGame) {
      addIdKeys(oldGame.id);
      addSteamIdKeys(oldGame.steamAppId);
      addTitleKeys(oldGame.title);
      addTitleKeys(oldGame.originalStoreTitle);
      addPlatforms(oldGame.platforms);
    }

    for (const key of keysToEvict) {
      this.inMemoryCache.delete(key);
      this.attemptedDynamicResolutions.delete(key);
      this.inFlightResolutions.delete(key);
      this.pendingPassiveTriggers.delete(key);
      this.stubPinnedKeys.delete(key);
      this.transientFailureCounts.delete(key);
      this.cancelDeferredStorageTasksForKey(key);
      evictStagedCache(`${STORAGE_PREFIX}${key}`);
      evictStagedCache(`${PREV_STORAGE_PREFIX}${key}`);
      evictStagedCache(key);
      if (typeof localStorage !== 'undefined') {
        try {
          localStorage.removeItem(`${STORAGE_PREFIX}${key}`);
          localStorage.removeItem(`${PREV_STORAGE_PREFIX}${key}`);
        } catch {}
      }
    }

    for (const t of titlesToEvict) {
      metacriticResolver.evictForGame(t);
      steamReviewResolver.evictForGame(t, null);
      storefrontStarResolver.evictForGame(t, null);
      storefrontReviewHarvester.evictForGame({ gameId, title: t, platforms: extra?.platforms });
    }
    for (const sid of steamIdsToEvict) {
      steamReviewResolver.evictForGame(null, sid);
      storefrontReviewHarvester.evictForGame({ gameId, steamAppId: sid, platforms: extra?.platforms });
    }
    if (gameId || (extra?.platforms && extra.platforms.length > 0)) {
      storefrontReviewHarvester.evictForGame({ gameId, title, steamAppId, platforms: extra?.platforms });
    }
    for (const xid of xboxIdsToEvict) {
      storefrontStarResolver.evictForGame(null, xid);
    }
  }

  public initEventListeners(): void {
    if (this.listenersInitialized) return;
    if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
      const onOverrideUpdated = ((e: CustomEvent) => {
        if (e.detail && typeof e.detail === 'object' && (e.detail as { hydratedFromVault?: boolean }).hydratedFromVault) {
          return;
        }
        const extracted = extractValidGameOverrideFromEventDetail(e.detail);
        if (!extracted) return;
        this.handleUserOverride(extracted.override, extracted.oldGame);
      }) as EventListener;

      const onStagedVaultHydrated = (() => {
        const hadStubs = this.stubPinnedKeys.size > 0;
        if (hadStubs) {
          for (const stubKey of this.stubPinnedKeys) {
            this.inMemoryCache.delete(stubKey);
          }
          this.stubPinnedKeys.clear();
        }
        if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
          try {
            window.dispatchEvent(
              new CustomEvent('antigravity_critic_updated', {
                detail: { hydratedFromVault: true },
              })
            );
          } catch {}
        }
      }) as EventListener;

      const onOverrideRemoved = ((e: CustomEvent) => {
        const detail = (e.detail || {}) as {
          gameId?: string;
          deletedKeys?: string[];
          removedOverride?: UserGameOverride;
          oldOverride?: UserGameOverride;
          oldGame?: Partial<CanonicalGame>;
        };
        const gameId = detail.gameId;
        const oldOverride = detail.removedOverride ?? detail.oldOverride;
        const oldGame = detail.oldGame;
        const deletedKeys = Array.isArray(detail.deletedKeys) ? detail.deletedKeys : [];

        if (gameId || oldOverride || oldGame || deletedKeys.length > 0) {
          this.evictCriticCacheForGame(
            gameId,
            oldOverride?.title || oldGame?.title,
            oldOverride?.steamAppId ?? oldGame?.steamAppId,
            {
              deletedKeys,
              oldOverride,
              oldGame,
            }
          );

          if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
            try {
              window.dispatchEvent(new CustomEvent('antigravity_critic_updated'));
            } catch {}
          }
        }
      }) as EventListener;

      window.addEventListener('antigravity:user-override-updated', onOverrideUpdated);
      window.addEventListener('antigravity:user-override-removed', onOverrideRemoved);
      window.addEventListener('antigravity:staged-vault-hydrated', onStagedVaultHydrated);
      const unsubscribeOnline = onlineLifecycleManager.onOnline(() => {
        this.attemptedDynamicResolutions.clear();
        for (const [k, v] of this.inMemoryCache.entries()) {
          if (v === null) {
            this.inMemoryCache.delete(k);
          }
        }
      });
      this.listenersInitialized = true;
      this.listenerCleanups.push(() => {
        window.removeEventListener('antigravity:user-override-updated', onOverrideUpdated);
        window.removeEventListener('antigravity:user-override-removed', onOverrideRemoved);
        window.removeEventListener('antigravity:staged-vault-hydrated', onStagedVaultHydrated);
        unsubscribeOnline();
      });
    }
  }

  public disposeEventListeners(): void {
    this.cancelLazyMigrationTimer();
    this.clearPendingVaultWrites();
    for (const cleanup of this.listenerCleanups) {
      try {
        cleanup();
      } catch {}
    }
    this.listenerCleanups = [];
    this.listenersInitialized = false;
  }

  /**
   * Responds to user game overrides by evicting stale cached entries across memory and localStorage,
   * invalidating storefrontReviewHarvester cache, and proactively initiating dynamic score resolution.
   */
  public handleUserOverride(override: UserGameOverride, oldGame?: CanonicalGame): void {
    if (!override || typeof override !== 'object') return;
    const candidateType = (override as Partial<UserGameOverride> & { type?: unknown }).type;
    if (typeof candidateType === 'string' && NON_OVERRIDE_EVENT_TYPES.has(candidateType)) {
      return;
    }
    const hasIdentifierOrOldGame =
      (typeof override.gameId === 'string' && override.gameId.trim().length > 0) ||
      (typeof override.title === 'string' && override.title.trim().length > 0) ||
      (typeof override.steamAppId === 'number' && override.steamAppId > 0) ||
      (typeof override.platformGameId === 'string' && override.platformGameId.trim().length > 0) ||
      Boolean(oldGame?.title) ||
      Boolean(typeof oldGame?.steamAppId === 'number' && oldGame.steamAppId > 0);
    if (!hasIdentifierOrOldGame) {
      return;
    }

    this.ensureHydrated();
    this.evictCriticCacheForGame(
      override.gameId || oldGame?.id,
      override.title || oldGame?.title,
      typeof override.steamAppId === 'number' && override.steamAppId > 0
        ? override.steamAppId
        : oldGame?.steamAppId,
      {
        oldOverride: override,
        oldGame,
      }
    );

    const targetTitle = (override.title || oldGame?.title || '').trim();
    const targetSteamId = typeof override.steamAppId === 'number' && override.steamAppId > 0 ? override.steamAppId : undefined;
    const cacheKey = targetSteamId ? `id:${targetSteamId}` : `title:${targetTitle.toLowerCase()}`;
    const stagedKey = `${STORAGE_PREFIX}${cacheKey}`;

    const route = inferReviewRouteFromOverride(override);
    if (route) {
      const keysToSet = new Set<string>();
      if (cacheKey) keysToSet.add(cacheKey);
      if (targetTitle) keysToSet.add(`title:${targetTitle.toLowerCase()}`);

      if (route.mode === 'unrated') {
        this.setInMemoryCache(cacheKey, null);
        saveStagedCache<CriticScoreData>(stagedKey, null, MutabilityTier.TIER_0_USER_OVERRIDE);
        for (const k of keysToSet) {
          if (k !== cacheKey) {
            this.setInMemoryCache(k, null);
          }
        }
        if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
          window.dispatchEvent(
            new CustomEvent('antigravity_critic_updated', {
              detail: { cacheKey, title: targetTitle, steamAppId: targetSteamId, data: null },
            })
          );
        }
        return;
      }

      if (route.mode === 'static') {
        const staticData = override.reviewScoreOverride ?? null;
        this.setInMemoryCache(cacheKey, staticData);
        saveStagedCache<CriticScoreData>(stagedKey, staticData, MutabilityTier.TIER_0_USER_OVERRIDE);
        for (const k of keysToSet) {
          if (k !== cacheKey) {
            this.setInMemoryCache(k, staticData);
          }
        }
        if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
          window.dispatchEvent(
            new CustomEvent('antigravity_critic_updated', {
              detail: { cacheKey, title: targetTitle, steamAppId: targetSteamId, data: staticData },
            })
          );
        }
        return;
      }

      if (route.mode === 'routed' && override.reviewScoreOverride) {
        const dynamicTier = determineGameMutabilityTier({
          releaseDate: override.releaseDate || oldGame?.releaseDate,
          isOverride: false,
        });
        this.setInMemoryCache(cacheKey, override.reviewScoreOverride);
        saveStagedCache<CriticScoreData>(stagedKey, override.reviewScoreOverride, dynamicTier, {
          source: override.reviewScoreOverride.source,
          isVerified: override.reviewScoreOverride.isVerified,
        });
        for (const k of keysToSet) {
          if (k !== cacheKey) {
            this.setInMemoryCache(k, override.reviewScoreOverride);
          }
        }
        if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
          window.dispatchEvent(
            new CustomEvent('antigravity_critic_updated', {
              detail: { cacheKey, title: targetTitle, steamAppId: targetSteamId, data: override.reviewScoreOverride },
            })
          );
        }
        return;
      }
    }

    if (targetTitle) {
      this.resolveDynamicScore(targetTitle, targetSteamId, undefined, override.storefrontAnchor).catch(() => {});
    }
  }

  /**
   * Resolves a routed review score dynamically from its pinned provider, falling back to fallbackScore if offline/unreachable.
   */
  public async resolveRoutedScore(
    route: ReviewScoreRoute,
    fallbackTitle: string,
    releaseYear?: number | string | null,
    fallbackScore?: CriticScoreData | null
  ): Promise<CriticScoreData | null> {
    if (!route || route.mode === 'unrated') {
      return null;
    }
    if (route.mode === 'static') {
      return fallbackScore ?? null;
    }

    const targetTitle = (route.targetTitle || fallbackTitle || '').trim();
    const yearNum =
      typeof releaseYear === 'number'
        ? releaseYear
        : releaseYear
        ? parseInt(String(releaseYear).match(/\b(19\d\d|20\d\d)\b/)?.[1] || '', 10) || undefined
        : undefined;

    try {
      if (route.source === 'metacritic' || route.source === 'metacritic_user') {
        const slug =
          route.metacriticSlug ||
          route.url?.match(/metacritic\.com\/game\/(?:pc\/)?([^/?#]+)/i)?.[1];
        const anchorArg = slug
          ? ({
              gameId: slug,
              storefront: 'steam',
              metacriticSlug: slug,
              metacriticUrl: route.url,
            } as StorefrontReviewAnchor & { gameId?: string })
          : undefined;
        const bundle = await metacriticResolver.resolveMetacritic(
          targetTitle,
          yearNum,
          anchorArg,
          Priority.P1_VIEWPORT
        );
        if (route.source === 'metacritic' && bundle?.critic && bundle.critic.score > 0) {
          return bundle.critic;
        }
        if (route.source === 'metacritic_user' && bundle?.user && bundle.user.score > 0) {
          return bundle.user;
        }
      } else if (route.source === 'opencritic') {
        const routeWithExternal = route as ReviewScoreRoute & { externalId?: string | number };
        const rawExternalId =
          routeWithExternal.externalId !== undefined && routeWithExternal.externalId !== null
            ? Number(String(routeWithExternal.externalId).trim())
            : 0;
        const urlOcId = Number(route.url?.match(/\/game\/(\d+)/i)?.[1] || 0);
        const ocId =
          (typeof route.openCriticId === 'number' &&
          Number.isSafeInteger(route.openCriticId) &&
          route.openCriticId > 0
            ? route.openCriticId
            : 0) ||
          (Number.isSafeInteger(urlOcId) && urlOcId > 0 ? urlOcId : 0) ||
          (Number.isSafeInteger(rawExternalId) && rawExternalId > 0 ? rawExternalId : 0);

        const ocResolved =
          ocId > 0
            ? await openCriticResolver.resolveById(ocId, {
                expectedTitle: targetTitle || undefined,
                releaseYear: yearNum ?? releaseYear,
                priority: Priority.P1_VIEWPORT,
                isVerifiedAnchor: true,
                anchorUrl: route.url,
                bypassCache: true,
              })
            : targetTitle
            ? await openCriticResolver.resolveForGame({
                title: targetTitle,
                steamAppId: route.steamAppId ?? null,
                gogSlug: normalizeWikidataGogSlug(route.gogId) ?? null,
                releaseYear: yearNum ?? releaseYear,
                priority: Priority.P1_VIEWPORT,
                bypassCache: true,
              })
            : null;

        if (ocResolved && ocResolved.score > 0) {
          return {
            ...ocResolved,
            url: route.url || ocResolved.url,
            numReviews: ocResolved.numReviews ?? fallbackScore?.numReviews,
            summary: ocResolved.summary || fallbackScore?.summary,
          };
        }
      } else if (route.source === 'steam') {
        const appId =
          route.steamAppId ||
          Number(route.url?.match(/store\.steampowered\.com\/app\/(\d+)/i)?.[1] || 0);
        if (appId > 0) {
          const steamRes = await steamReviewResolver.resolveScore(targetTitle, appId);
          if (steamRes && steamRes.score > 0) {
            return steamRes;
          }
        }
      } else if (route.source === 'gog' || route.source === 'epic' || route.source === 'xbox') {
        const starRes = await storefrontStarResolver.resolveScore({
          title: targetTitle,
          gogId: route.gogId,
          epicId: route.epicId,
          xboxProductId: route.xboxProductId,
        });
        if (starRes && starRes.score > 0) {
          return {
            ...starRes,
            source: route.source,
          };
        }
      }
    } catch {}

    return fallbackScore ?? null;
  }

  private getCompiledReviewOverrideIndex(
    overrides: Record<string, UserGameOverride>
  ): CompiledReviewOverrideIndex {
    const existing = this.compiledOverrideIndexMemo.get(overrides);
    if (existing) return existing;

    const byKey = new Map<string, UserGameOverride>();
    const byGameId = new Map<string, UserGameOverride[]>();
    const bySteamId = new Map<number, UserGameOverride[]>();
    const byLowerTitle = new Map<string, UserGameOverride[]>();
    const byNormTitle = new Map<string, UserGameOverride[]>();
    let hasAnyReviewOverride = false;

    const pushUnique = <K>(map: Map<K, UserGameOverride[]>, key: K, ov: UserGameOverride) => {
      let list = map.get(key);
      if (!list) {
        list = [];
        map.set(key, list);
      }
      if (!list.includes(ov)) {
        list.push(ov);
      }
    };

    for (const [k, ov] of Object.entries(overrides)) {
      if (!ov || (ov.reviewScoreOverride === undefined && ov.reviewRoute === undefined)) {
        continue;
      }
      hasAnyReviewOverride = true;
      byKey.set(k, ov);
      if (ov.gameId) {
        pushUnique(byGameId, ov.gameId, ov);
      }
      if (typeof ov.steamAppId === 'number' && ov.steamAppId > 0) {
        pushUnique(bySteamId, ov.steamAppId, ov);
      }
      if (ov.title) {
        const lower = ov.title.toLowerCase().trim();
        if (lower) {
          pushUnique(byLowerTitle, lower, ov);
        }
        const norm = normalizeCriticTitleKey(ov.title);
        if (norm) {
          pushUnique(byNormTitle, norm, ov);
        }
      }
    }

    const sortNewestFirst = (a: UserGameOverride, b: UserGameOverride) =>
      parseOverrideUpdatedAt(b) - parseOverrideUpdatedAt(a);
    for (const list of byGameId.values()) list.sort(sortNewestFirst);
    for (const list of bySteamId.values()) list.sort(sortNewestFirst);
    for (const list of byLowerTitle.values()) list.sort(sortNewestFirst);
    for (const list of byNormTitle.values()) list.sort(sortNewestFirst);

    const compiled: CompiledReviewOverrideIndex = {
      hasAnyReviewOverride,
      byKey,
      byGameId,
      bySteamId,
      byLowerTitle,
      byNormTitle,
    };
    this.compiledOverrideIndexMemo.set(overrides, compiled);
    return compiled;
  }

  /**
   * Helper to locate an active user override matching the provided game by steamAppId, title, or platform combinations.
   * Respects full entitlement context (`platforms`) when provided and breaks ties deterministically by newest `updatedAt`.
   */
  public findMatchingUserOverride(
    steamAppId?: number | null,
    title?: string,
    gameId?: string,
    platforms?: CriticEntitlementPlatform[]
  ): UserGameOverride | undefined {
    try {
      const overrides = loadUserOverrides();
      if (!overrides) return undefined;

      const idx = this.getCompiledReviewOverrideIndex(overrides);
      if (!idx.hasAnyReviewOverride) return undefined;

      const normalizedPlatforms: GamePlatformOwnership[] = Array.isArray(platforms)
        ? platforms
            .filter((p) => Boolean(p && p.platformId))
            .map((p) => ({
              platformId: p.platformId as StorefrontId,
              platformGameId: String(p.platformGameId || p.xboxProductId || p.storefrontAppId || ''),
              storefrontAppId: p.storefrontAppId,
              installed: false,
            }))
        : [];
      const hasPlatforms = normalizedPlatforms.length > 0;
      const parsedGameIdPlatform = (() => {
        if (!gameId) return null;
        const m = gameId.match(/^(steam|gog|epic|xbox|ea|ubisoft|battlenet|itch)[-_:](\S+)$/i);
        if (!m) return null;
        return { platformId: m[1].toLowerCase(), platformGameId: m[2].toLowerCase() };
      })();

      const isOverrideCompatible = (ov?: UserGameOverride): boolean => {
        if (!ov) return false;
        if (ov.splitFromMerged) {
          if (!hasPlatforms || normalizedPlatforms.length !== 1) return false;
          const p = normalizedPlatforms[0];
          if (ov.platformId && String(p.platformId).toLowerCase() !== String(ov.platformId).toLowerCase()) {
            return false;
          }
          if (
            ov.platformGameId &&
            String(p.platformGameId).toLowerCase() !== String(ov.platformGameId).toLowerCase()
          ) {
            return false;
          }
          return true;
        }

        if (hasPlatforms && ov.platformId && ov.platformGameId) {
          const ovPlat = String(ov.platformId).toLowerCase();
          const ovPlatGame = String(ov.platformGameId).toLowerCase();
          const ownsMatchingPlat = normalizedPlatforms.some(
            (p) =>
              String(p.platformId).toLowerCase() === ovPlat &&
              String(p.platformGameId).toLowerCase() === ovPlatGame
          );
          if (ownsMatchingPlat) return true;
          if (gameId && ov.gameId && gameId === ov.gameId) {
            const onlyConflictingStore = normalizedPlatforms.every(
              (p) => String(p.platformId).toLowerCase() !== ovPlat
            );
            if (onlyConflictingStore) return false;
            return true;
          }
          return false;
        }

        if (!hasPlatforms && parsedGameIdPlatform && ov.platformId && ov.platformGameId) {
          if (gameId && ov.gameId && gameId === ov.gameId) return true;
          const ovPlat = String(ov.platformId).toLowerCase();
          const ovPlatGame = String(ov.platformGameId).toLowerCase();
          if (
            parsedGameIdPlatform.platformId !== ovPlat ||
            parsedGameIdPlatform.platformGameId !== ovPlatGame
          ) {
            return false;
          }
        }

        return true;
      };

      const pickNewestCompatible = (candidates: Iterable<UserGameOverride | undefined>): UserGameOverride | undefined => {
        let best: UserGameOverride | undefined;
        let bestTs = -1;
        for (const cand of candidates) {
          if (!cand || !isOverrideCompatible(cand)) continue;
          const ts = parseOverrideUpdatedAt(cand);
          if (!best || ts > bestTs) {
            best = cand;
            bestTs = ts;
          }
        }
        return best;
      };

      const synthGame: CanonicalGame = {
        id: gameId || (steamAppId ? `steam-${steamAppId}` : (title ? `game-${title.toLowerCase().trim()}` : '')),
        title: title || '',
        sortTitle: title || '',
        steamAppId: typeof steamAppId === 'number' && steamAppId > 0 ? steamAppId : undefined,
        platforms: normalizedPlatforms,
        headerImage: '',
        developers: [],
        publishers: [],
        genres: [],
        tags: [],
      };
      const directMatch = getUserOverrideForGame(synthGame, overrides);
      if (
        directMatch &&
        (directMatch.reviewScoreOverride !== undefined || directMatch.reviewRoute !== undefined) &&
        isOverrideCompatible(directMatch)
      ) {
        return directMatch;
      }

      if (gameId) {
        const directGameCandidates: Array<UserGameOverride | undefined> = [
          idx.byKey.get(gameId),
          ...(idx.byGameId.get(gameId) || []),
        ];
        const byGame = pickNewestCompatible(directGameCandidates);
        if (byGame) return byGame;
      }

      if (hasPlatforms) {
        const platCandidates: Array<UserGameOverride | undefined> = [];
        for (const p of normalizedPlatforms) {
          if (!p.platformGameId) continue;
          const pId = String(p.platformId);
          const pLower = pId.toLowerCase();
          const bare = String(p.platformGameId);
          const bareLower = bare.toLowerCase();
          platCandidates.push(
            idx.byKey.get(`${pId}:${bare}`),
            idx.byKey.get(`${pLower}:${bareLower}`),
            idx.byKey.get(`${pId}-${bare}`),
            idx.byKey.get(`${pLower}-${bareLower}`),
            ...(pLower === 'xbox' ? [idx.byKey.get(`xbox:${bare.toUpperCase()}`)] : [])
          );
        }
        const byPlat = pickNewestCompatible(platCandidates);
        if (byPlat) return byPlat;
      }

      if (typeof steamAppId === 'number' && steamAppId > 0) {
        const steamCandidates: Array<UserGameOverride | undefined> = [
          idx.byKey.get(`steam-${steamAppId}`),
          idx.byKey.get(String(steamAppId)),
          ...(idx.bySteamId.get(steamAppId) || []),
        ];
        const bySteam = pickNewestCompatible(steamCandidates);
        if (bySteam) return bySteam;
      }

      const lower = title ? title.toLowerCase().trim() : '';
      const normSearchTitle = title ? normalizeCriticTitleKey(title) : '';
      const titleFallbackCandidates: Array<UserGameOverride | undefined> = [];
      if (lower) {
        titleFallbackCandidates.push(
          idx.byKey.get(lower),
          idx.byKey.get(`title:${lower}`),
          ...(idx.byLowerTitle.get(lower) || [])
        );
      }
      if (normSearchTitle) {
        titleFallbackCandidates.push(...(idx.byNormTitle.get(normSearchTitle) || []));
      }
      const byTitle = pickNewestCompatible(titleFallbackCandidates);
      if (byTitle) return byTitle;
    } catch {}
    return undefined;
  }

  /**
   * Public semantic compatibility guard for unified callers (`reviewScoreResolver`, vault hydration).
   */
  public isScoreSemanticallyCompatible(
    rawTitle: string,
    scoreData: CriticScoreData | null | undefined,
    steamAppId?: number | null,
    verifiedAnchorSlug?: string | null
  ): boolean {
    return this.validateScoreSemanticCompatibility(
      rawTitle,
      scoreData,
      steamAppId,
      verifiedAnchorSlug
    );
  }

  /**
   * Universal semantic compatibility validator for cached or candidate critic scores.
   * Memoizes validation outcomes per `CriticScoreData` object reference (`WeakMap`) so hot-path
   * cache hits run in O(1) without repeating regex/slug/summary passes.
   */
  private validateScoreSemanticCompatibility(
    rawTitle: string,
    scoreData: CriticScoreData | null | undefined,
    steamAppId?: number | null,
    verifiedAnchorSlug?: string | null
  ): boolean {
    if (!scoreData || typeof scoreData.score !== 'number' || scoreData.score <= 0) return false;

    const memoKey = `${steamAppId ?? ''}|${verifiedAnchorSlug ?? ''}|${rawTitle}`;
    let byQuery = this.semanticValidationMemo.get(scoreData);
    if (byQuery && byQuery.has(memoKey)) {
      return byQuery.get(memoKey)!;
    }

    const recordValidation = (valid: boolean): boolean => {
      if (!byQuery) {
        byQuery = new Map<string, boolean>();
        this.semanticValidationMemo.set(scoreData, byQuery);
      } else if (byQuery.size >= 32) {
        const oldest = byQuery.keys().next().value;
        if (oldest !== undefined) byQuery.delete(oldest);
      }
      byQuery.set(memoKey, valid);
      return valid;
    };

    const isNonGameAddonOrBeta = NON_GAME_ADDON_OR_BETA_REGEX.test(rawTitle);
    if (isNonGameAddonOrBeta && !scoreData.isSynthetic) {
      return recordValidation(false);
    }
    if (
      rawTitle &&
      (KNOWN_UNRATED_TITLES.has(rawTitle.toLowerCase().trim()) ||
        KNOWN_UNRATED_TITLES.has(normalizeCriticTitleKey(rawTitle))) &&
      !scoreData.isSynthetic
    ) {
      return recordValidation(false);
    }
    if (scoreData.source === 'steam' && scoreData.url?.includes('/search/?term=') && !steamAppId) {
      return recordValidation(false);
    }
    if (scoreData.source === 'opencritic' && isUrlHostMatching(scoreData.url, 'gog.com') && steamAppId) {
      return recordValidation(false);
    }

    if (scoreData.url && rawTitle) {
      const slugMatch = scoreData.url.match(/\/game\/(?:[0-9]+\/)?([^\/?#]+)/);
      const slug = slugMatch ? slugMatch[1] : '';
      if (slug && !(scoreData.source === 'opencritic' && slug.toLowerCase() === 'game')) {
        const compatQueryTitle =
          scoreData.source === 'gog' ? rawTitle.replace(/\bplus\b/gi, '').trim() || rawTitle : rawTitle;
        const parenYear = extractParentheticalReleaseYear(rawTitle);
        const buildSlugTitles = (rawSlug: string): { fullTitle: string; strippedTitle: string } => {
          const fullTitle = rawSlug.replace(/[_-]/g, ' ').trim();
          const trailingYearMatch = rawSlug.match(/^(.*)[-_]((?:19|20)\d{2})$/);
          if (!trailingYearMatch || !trailingYearMatch[1]) {
            return { fullTitle, strippedTitle: fullTitle };
          }
          const trailingYear = trailingYearMatch[2];
          const yearPresentInTitle = new RegExp(`\\b${trailingYear}\\b`).test(rawTitle);
          const shouldStrip =
            (parenYear !== null && String(parenYear) === trailingYear) || !yearPresentInTitle;
          const strippedTitle = shouldStrip
            ? trailingYearMatch[1].replace(/[_-]/g, ' ').trim()
            : fullTitle;
          return { fullTitle, strippedTitle };
        };

        if (scoreData.source === 'gog') {
          const nonGameGog = /\b(demo|prologue|soundtrack|ost|artbook|dlc|upgrade|walkthrough)\b/i;
          if (nonGameGog.test(slug.replace(/_/g, ' ')) && !nonGameGog.test(rawTitle)) {
            return recordValidation(false);
          }
          const gogTitles = buildSlugTitles(slug);
          const gogVariants = Array.from(new Set([gogTitles.strippedTitle, gogTitles.fullTitle]));
          const gogCompatible = gogVariants.some(
            (gt) =>
              !isSequelMismatch(compatQueryTitle, gt) &&
              isTitleCompatible(compatQueryTitle, gt) &&
              isTitleCompatible(gt, compatQueryTitle)
          );
          if (!gogCompatible) {
            return recordValidation(false);
          }
        }

        const normalizedSlug = !/\b(season|episode)\b/i.test(rawTitle)
          ? slug.replace(/-episode-(?:1|one)\b.*$/i, '')
          : slug;
        const { fullTitle: fullSlugTitle, strippedTitle: slugTitle } = buildSlugTitles(normalizedSlug);

        let corroboratedMcAnchorSlug: string | undefined = verifiedAnchorSlug || undefined;
        if (!corroboratedMcAnchorSlug && scoreData.source === 'metacritic') {
          const wdCachedSlug = wikidataBridge.getCachedLinks({
            steamAppId,
            title: rawTitle,
          })?.metacriticSlug;
          if (wdCachedSlug) {
            corroboratedMcAnchorSlug = wdCachedSlug;
          } else if (steamAppId) {
            const enrichedMcUrl = STEAM_ENRICHED_CRITIC_MAP[String(steamAppId)]?.metacritic?.url;
            const enrichedSlug = extractMetacriticSlugFromUrl(enrichedMcUrl);
            if (enrichedSlug) {
              corroboratedMcAnchorSlug = enrichedSlug;
            } else {
              const knownEntry = KNOWN_CRITIC_SCORES[steamAppId];
              if (knownEntry?.source === 'metacritic' && knownEntry.url) {
                corroboratedMcAnchorSlug = extractMetacriticSlugFromUrl(knownEntry.url);
              }
            }
          }
        }

        const isVerifiedMetacriticAnchor = Boolean(
          scoreData.source === 'metacritic' &&
            scoreData.isVerified &&
            isAnchorSlugCompatible(rawTitle, slug) &&
            (scoreData.summary?.includes('store review anchor') ||
              (corroboratedMcAnchorSlug && isAnchorMatch(slug, corroboratedMcAnchorSlug)))
        );

        const isVerifiedStoreAnchor =
          isVerifiedMetacriticAnchor ||
          Boolean(
            scoreData.summary?.includes('store review anchor') && isAnchorSlugCompatible(rawTitle, slug)
          );

        const asciiProjectedQueryTitle =
          scoreData.source === 'opencritic'
            ? compatQueryTitle.replace(/[^\x00-\x7f]+/g, ' ').replace(/\s+/g, ' ').trim()
            : '';

        const slugTitleVariants = Array.from(
          new Set([
            slugTitle,
            fullSlugTitle,
            slugTitle.replace(/^([a-z0-9]+)\s+(a|an|the)\s+/i, '$1: $2 '),
            fullSlugTitle.replace(/^([a-z0-9]+)\s+(a|an|the)\s+/i, '$1: $2 '),
          ])
        );

        const passesSequelCheck =
          isVerifiedStoreAnchor ||
          slugTitleVariants.some((st) => !isSequelMismatch(compatQueryTitle, st)) ||
          Boolean(
            asciiProjectedQueryTitle &&
              asciiProjectedQueryTitle !== compatQueryTitle &&
              slugTitleVariants.some((st) => !isSequelMismatch(asciiProjectedQueryTitle, st))
          );
        if (!passesSequelCheck) {
          return recordValidation(false);
        }

        const passesTitleCompatibility =
          isVerifiedStoreAnchor ||
          slugTitleVariants.some((st) => isTitleCompatible(compatQueryTitle, st)) ||
          Boolean(
            asciiProjectedQueryTitle &&
              asciiProjectedQueryTitle !== compatQueryTitle &&
              slugTitleVariants.some((st) => isTitleCompatible(asciiProjectedQueryTitle, st))
          );

        if (!passesTitleCompatibility) {
          return recordValidation(false);
        }

        // Guard against explicit first-installment or retro classic matching an unnumbered modern reboot
        const titleNoYear = rawTitle.replace(/\s*\((?:19|20)\d{2}\)/g, '').trim();
        const isFirstInstallment = /\b(?:1|i)\b/i.test(titleNoYear) && !/\b(?:1|i)\b/i.test(slugTitle);
        const isExplicitRetro =
          (hasExplicitClassicOrOriginalEditionTag(titleNoYear) ||
            /\b(plus|dos)\b/i.test(titleNoYear)) &&
          !/\b(classic|original|plus|dos)\b/i.test(slugTitle);

        if (
          (isFirstInstallment || isExplicitRetro) &&
          (scoreData.source === 'opencritic' ||
            /[-_](200[89]|201\d|202\d)$/.test(slug) ||
            /\b(reimagination|reimagining|remake of the|modern reboot|reboot of the|completely remastered|playstation 5|xbox series)\b/i.test(
              scoreData.summary || ''
            ))
        ) {
          return recordValidation(false);
        }

        // Guard against franchise spinoff subtitle collisions on base-title review URLs
        const summaryText = scoreData.summary || '';
        const escapedBase = titleNoYear.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        if (escapedBase && !rawTitle.includes(':')) {
          const spinoffColonRe = new RegExp(`\\b${escapedBase}:\\s+([A-Z][A-Za-z0-9'\\s-]{2,})`, 'i');
          const spinoffMatch = summaryText.match(spinoffColonRe);
          if (spinoffMatch?.[1]) {
            const subLower = spinoffMatch[1].trim().toLowerCase();
            if (subLower && !rawTitle.toLowerCase().includes(subLower)) {
              return recordValidation(false);
            }
          }
        }
      }
    }

    if (scoreData.summary && scoreData.source === 'metacritic') {
      scoreData.summary = sanitizeMetacriticDescription(scoreData.summary, scoreData.numReviews || 20);
    }
    return recordValidation(true);
  }

  /**
   * Cleanses all stale unversioned and previous version score keys from localStorage.
   */
  public purgeLegacyScores(): void {
    this.storageHydrated = true;
    clearExpiredStagedCache({ onlyNegativeAndTransient: true });
    if (typeof localStorage === 'undefined') return;
    try {
      const keysToRemove: string[] = [];
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (
          key &&
          (key.startsWith(LEGACY_STORAGE_PREFIX) ||
            key.startsWith(PREV_STORAGE_PREFIX) ||
            key.startsWith('antigravity_critic_v6_') ||
            key.startsWith('antigravity_critic_v5_'))
        ) {
          keysToRemove.push(key);
        }
      }
      for (const k of keysToRemove) {
        localStorage.removeItem(k);
      }
    } catch {}
  }

  /**
   * Completely purges all stored critic scores in localStorage and memory.
   */
  public purgeAllScoreCache(): void {
    this.storageHydrated = true;
    this.cancelLazyMigrationTimer();
    this.clearPendingVaultWrites();
    this.pendingStorageTasks.clear();
    this.inMemoryCache.clear();
    this.inFlightResolutions.clear();
    this.pendingPassiveTriggers.clear();
    this.attemptedDynamicResolutions.clear();
    metacriticResolver.clearCache();
    openCriticResolver.clearCache();
    wikidataBridge.clearCache();
    steamReviewResolver.clearCache();
    storefrontStarResolver.clearCache();
    storefrontReviewHarvester.clearCache();
    clearExpiredStagedCache();
    if (typeof localStorage === 'undefined') return;
    try {
      const keysToRemove: string[] = [];
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (
          key &&
          (key.startsWith(STORAGE_PREFIX) ||
            key.startsWith(PREV_STORAGE_PREFIX) ||
            key.startsWith('antigravity_critic_v6_') ||
            key.startsWith('antigravity_critic_v5_') ||
            key.startsWith(LEGACY_STORAGE_PREFIX))
        ) {
          keysToRemove.push(key);
        }
      }
      for (const k of keysToRemove) {
        localStorage.removeItem(k);
      }
    } catch {}
  }

  /**
   * Purges legacy or stale "null" strings and semantically poisoned entries from localStorage.
   * Preserves valid StagedCacheEntry negative records (< 7 days) and purges expired ones.
   */
  public purgeStaleNullScores(): void {
    this.storageHydrated = true;
    this.cancelLazyMigrationTimer();
    if (typeof localStorage === 'undefined') return;
    try {
      const schemaUpgraded = localStorage.getItem(CRITIC_SCHEMA_V16_KEY) === '1';
      if (!schemaUpgraded) {
        const v8Keys: string[] = [];
        for (let i = 0; i < localStorage.length; i++) {
          const key = localStorage.key(i);
          if (key && key.startsWith(STORAGE_PREFIX)) {
            v8Keys.push(key);
          }
        }
        const catalogTitleByAppId = new Map<number, string>();
        const catalogAppIdByTitle = new Map<string, number>();
        const catalogGameIdByAppId = new Map<number, string>();
        const catalogGameIdByNormTitle = new Map<string, string>();
        if (v8Keys.length > 0) {
          this.populateCatalogMapsForMigration(
            catalogTitleByAppId,
            catalogAppIdByTitle,
            catalogGameIdByAppId,
            catalogGameIdByNormTitle
          );
        }

        const v16Remove: string[] = [];
        const siblingGroups = new Map<string, MigrationV8Record[]>();
        for (const key of v8Keys) {
          if (
            this.shouldEvictV8KeyDuringMigration(
              key,
              catalogTitleByAppId,
              catalogAppIdByTitle,
              siblingGroups
            )
          ) {
            v16Remove.push(key);
          }
        }
        for (const k of v16Remove) {
          localStorage.removeItem(k);
          if (k.startsWith(STORAGE_PREFIX)) {
            const rawKey = k.slice(STORAGE_PREFIX.length);
            this.inMemoryCache.delete(rawKey);
            this.attemptedDynamicResolutions.delete(rawKey);
          }
        }

        const promotedCount = this.promoteShadowedAliasesDuringV16Migration(
          siblingGroups,
          catalogGameIdByAppId,
          catalogGameIdByNormTitle
        );

        // Clean stale negative or semantically incompatible Steam matcher entries
        this.cleanStaleSteamMatcherEntries();

        localStorage.setItem('antigravity_critic_schema_v9', '1');
        localStorage.setItem('antigravity_critic_schema_v10', '1');
        localStorage.setItem('antigravity_critic_schema_v11', '1');
        localStorage.setItem('antigravity_critic_schema_v12', '1');
        localStorage.setItem('antigravity_critic_schema_v13', '1');
        localStorage.setItem('antigravity_critic_schema_v14', '1');
        localStorage.setItem('antigravity_critic_schema_v15', '1');
        localStorage.setItem(CRITIC_SCHEMA_V16_KEY, '1');

        if (
          promotedCount > 0 &&
          typeof window !== 'undefined' &&
          typeof window.dispatchEvent === 'function'
        ) {
          try {
            window.dispatchEvent(
              new CustomEvent('antigravity_critic_updated', {
                detail: { hydratedFromVault: true },
              })
            );
          } catch {}
        }
      }

      if (!onlineLifecycleManager.isOnline()) {
        return;
      }

      const keysToRemove: string[] = [];
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (
          key &&
          (key.startsWith(STORAGE_PREFIX) ||
            key.startsWith(PREV_STORAGE_PREFIX) ||
            key.startsWith('antigravity_critic_v6_') ||
            key.startsWith('antigravity_critic_v5_') ||
            key.startsWith(LEGACY_STORAGE_PREFIX))
        ) {
          const val = localStorage.getItem(key);
          if (!val || val === 'null' || val === 'undefined') {
            keysToRemove.push(key);
          } else {
            try {
              const parsed = JSON.parse(val);
              if (parsed && typeof parsed === 'object' && typeof parsed.cachedAt === 'number') {
                const isPositiveScore =
                  parsed.data &&
                  typeof parsed.data === 'object' &&
                  typeof parsed.data.score === 'number' &&
                  parsed.data.score > 0;
                if (!isPositiveScore && !isCacheEntryValid(parsed)) {
                  keysToRemove.push(key);
                }
              } else if (!parsed || typeof parsed.score !== 'number' || parsed.score <= 0) {
                keysToRemove.push(key);
              }
            } catch {
              keysToRemove.push(key);
            }
          }
        }
      }
      for (const k of keysToRemove) {
        localStorage.removeItem(k);
        if (k.startsWith(STORAGE_PREFIX)) {
          const rawKey = k.slice(STORAGE_PREFIX.length);
          this.inMemoryCache.delete(rawKey);
          this.attemptedDynamicResolutions.delete(rawKey);
        }
      }
      if (!schemaUpgraded && keysToRemove.length > 0) {
        this.inMemoryCache.clear();
        this.attemptedDynamicResolutions.clear();
      }
    } catch {}
  }

  /**
   * Clears memory cache and resets attempted resolution state.
   */
  clearCache(): void {
    this.cancelLazyMigrationTimer();
    this.clearPendingVaultWrites();
    this.pendingStorageTasks.clear();
    this.inMemoryCache.clear();
    this.stubPinnedKeys.clear();
    this.transientFailureCounts.clear();
    this.inFlightResolutions.clear();
    this.pendingPassiveTriggers.clear();
    this.attemptedDynamicResolutions.clear();
    metacriticResolver.clearCache();
    openCriticResolver.clearCache();
    wikidataBridge.clearCache();
    steamReviewResolver.clearCache();
    storefrontStarResolver.clearCache();
    storefrontReviewHarvester.clearCache();
    this.purgeStaleNullScores();
  }

  /**
   * Non-destructive refresh preparation: clears negative, transient, and attempted resolution
   * sets plus negative sub-resolver misses WITHOUT wiping verified Metacritic/OpenCritic scores.
   */
  public prepareForIncrementalRefresh(): void {
    this.attemptedDynamicResolutions.clear();
    this.transientFailureCounts.clear();
    this.stubPinnedKeys.clear();
    for (const [key, value] of this.inMemoryCache.entries()) {
      if (value === null) {
        this.inMemoryCache.delete(key);
      }
    }
    openCriticResolver.clearCache({ negativesOnly: true });
    wikidataBridge.clearCache({ negativesOnly: true });
    metacriticResolver.clearCache();
    steamReviewResolver.clearCache();
    storefrontStarResolver.clearCache();
    storefrontReviewHarvester.clearCache();
    clearExpiredStagedCache({ onlyNegativeAndTransient: true });
    if (typeof localStorage !== 'undefined') {
      try {
        const negativeKeysToClear: string[] = [];
        for (let i = 0; i < localStorage.length; i++) {
          const key = localStorage.key(i);
          if (!key || !key.startsWith(STORAGE_PREFIX)) continue;
          const raw = localStorage.getItem(key);
          if (!raw) continue;
          try {
            const parsed = JSON.parse(raw) as { tier?: string; data?: unknown };
            if (
              parsed &&
              typeof parsed === 'object' &&
              (parsed.tier === MutabilityTier.TIER_4B_NEGATIVE_CACHE ||
                parsed.tier === MutabilityTier.TIER_4C_TRANSIENT_ERROR ||
                parsed.tier === 'negative' ||
                parsed.tier === 'transient_error') &&
              parsed.data === null
            ) {
              negativeKeysToClear.push(key);
            }
          } catch {}
        }
        for (const k of negativeKeysToClear) {
          evictStagedCache(k);
          localStorage.removeItem(k);
        }
      } catch {}
    }
  }

  /**
   * Returns true when the game already holds an unexpired, semantically valid verified press-critic
   * score (`metacritic` or `opencritic`, or `metacritic`-only when `context?.metacriticOnly === true`).
   */
  public hasFreshVerifiedPressCriticScore(
    title: string,
    context?: CriticScoreContext & { steamAppId?: number | null; metacriticOnly?: boolean }
  ): boolean {
    this.ensureHydrated();
    const rawTitle = (title || '').trim();
    const lowerTitle = rawTitle.toLowerCase();
    const normTitle = rawTitle ? normalizeCriticTitleKey(rawTitle) : '';
    const steamAppId = context?.steamAppId ?? null;
    const metacriticOnly = Boolean(context?.metacriticOnly);

    const candidateKeys: string[] = [];
    if (typeof steamAppId === 'number' && steamAppId > 0) {
      candidateKeys.push(`${STORAGE_PREFIX}id:${steamAppId}`);
    }
    if (lowerTitle) {
      candidateKeys.push(`${STORAGE_PREFIX}title:${lowerTitle}`);
    }
    if (normTitle && normTitle !== lowerTitle) {
      candidateKeys.push(`${STORAGE_PREFIX}title:${normTitle}`);
    }

    for (const key of candidateKeys) {
      const staged = loadStagedCache<CriticScoreData>(key, false);
      if (!staged.valid || !staged.data || staged.data.score <= 0) continue;
      if (staged.data.isVerified !== true) continue;
      const isMatchingSource = metacriticOnly
        ? staged.data.source === 'metacritic'
        : staged.data.source === 'metacritic' || staged.data.source === 'opencritic';
      if (!isMatchingSource) continue;
      if (rawTitle && !this.validateScoreSemanticCompatibility(rawTitle, staged.data, steamAppId)) {
        continue;
      }
      return true;
    }

    return false;
  }

  public clearAttemptedResolutions(): void {
    this.attemptedDynamicResolutions.clear();
  }

  public hasAttemptedDynamicResolution(steamAppId?: number | null, title?: string): boolean {
    const rawTitle = (title || '').trim().toLowerCase();
    if (steamAppId && this.attemptedDynamicResolutions.has(`id:${steamAppId}`)) {
      return true;
    }
    if (rawTitle && this.attemptedDynamicResolutions.has(`title:${rawTitle}`)) {
      return true;
    }
    return false;
  }

  public hasValidCachedResolution(steamAppId?: number | null, title?: string): boolean {
    this.ensureHydrated();
    if (this.hasAttemptedDynamicResolution(steamAppId, title)) {
      return true;
    }
    const rawTitle = (title || '').trim();
    const userOverride = this.findMatchingUserOverride(steamAppId, rawTitle);
    if (userOverride && (userOverride.reviewScoreOverride !== undefined || userOverride.reviewRoute !== undefined)) {
      const route = inferReviewRouteFromOverride(userOverride);
      if (route?.mode === 'unrated' || route?.mode === 'static') {
        return true;
      }
    }

    const primaryIdKey = steamAppId ? `${STORAGE_PREFIX}id:${steamAppId}` : '';
    const candidateKeys: string[] = [];
    if (primaryIdKey) {
      candidateKeys.push(primaryIdKey);
    }
    const lowerTitle = rawTitle ? rawTitle.toLowerCase() : '';
    if (rawTitle) {
      candidateKeys.push(`${STORAGE_PREFIX}title:${lowerTitle}`);
      const norm = normalizeCriticTitleKey(rawTitle);
      if (norm && norm !== lowerTitle) {
        candidateKeys.push(`${STORAGE_PREFIX}title:${norm}`);
      }
    }

    let expiredPrimaryIdCachedAt: number | null = null;

    const backfillTitleAliasIfNeeded = (
      sourceKey: string,
      stagedEntry: NonNullable<ReturnType<typeof loadStagedCache<CriticScoreData>>['entry']>,
      resolvedData: CriticScoreData | null
    ) => {
      if (!primaryIdKey || sourceKey !== primaryIdKey || !lowerTitle) return;
      const titleAliasKey = `${STORAGE_PREFIX}title:${lowerTitle}`;
      const existingAlias = loadStagedCache<CriticScoreData>(titleAliasKey, false);
      if (existingAlias.valid && existingAlias.entry?.dynamicResolved === true) {
        return;
      }
      if (
        existingAlias.entry &&
        (existingAlias.entry.tier === MutabilityTier.TIER_0_USER_OVERRIDE ||
          existingAlias.entry.tier === 'override')
      ) {
        return;
      }
      saveStagedCache<CriticScoreData>(titleAliasKey, resolvedData, stagedEntry.tier, {
        source: stagedEntry.source,
        isVerified: stagedEntry.isVerified,
        failureReason: stagedEntry.failureReason,
        dynamicResolved: true,
        cachedAt: stagedEntry.cachedAt,
        customTtlMs: stagedEntry.ttlMs,
      });
    };

    for (const key of candidateKeys) {
      const staged = loadStagedCache<CriticScoreData>(key, false);
      if (!staged.entry) continue;
      if (
        staged.entry.tier === MutabilityTier.TIER_0_USER_OVERRIDE ||
        staged.entry.tier === 'override'
      ) {
        return true;
      }
      if (
        expiredPrimaryIdCachedAt !== null &&
        key !== primaryIdKey &&
        (staged.entry.cachedAt || 0) <= expiredPrimaryIdCachedAt
      ) {
        continue;
      }
      if (!onlineLifecycleManager.isOnline()) {
        if (
          staged.data &&
          staged.data.score > 0 &&
          (!rawTitle || this.validateScoreSemanticCompatibility(rawTitle, staged.data, steamAppId))
        ) {
          return true;
        }
      }
      if (staged.entry.dynamicResolved === true) {
        if (isCacheEntryValid(staged.entry)) {
          if (staged.entry.data === null) {
            backfillTitleAliasIfNeeded(key, staged.entry, null);
            return true;
          }
          if (
            staged.data &&
            staged.data.score > 0 &&
            (!rawTitle || this.validateScoreSemanticCompatibility(rawTitle, staged.data, steamAppId))
          ) {
            backfillTitleAliasIfNeeded(key, staged.entry, staged.data);
            return true;
          }
        } else if (key === primaryIdKey) {
          expiredPrimaryIdCachedAt = staged.entry.cachedAt || 0;
        }
      }
    }

    return false;
  }

  /**
   * Seeds an authoritative critic score hydrated from the Electron SQLite vault when no
   * equal-or-higher-authority valid staged cache entry or user override already exists.
   * Returns true if the cache was seeded or monotonically upgraded.
   */
  public seedFromVaultIfMissing(
    steamAppId: number | null | undefined,
    title: string | undefined,
    scoreData: CriticScoreData | null | undefined,
    releaseDate?: string | number | null,
    genres?: string[] | null,
    context?: CriticScoreContext
  ): boolean {
    if (!scoreData || typeof scoreData.score !== 'number' || scoreData.score <= 0) return false;
    this.ensureHydrated();
    const rawTitle = (title || '').trim();
    const userOverride = this.findMatchingUserOverride(
      steamAppId,
      rawTitle,
      context?.gameId,
      context?.platforms
    );
    if (
      userOverride &&
      (userOverride.reviewScoreOverride !== undefined || userOverride.reviewRoute !== undefined)
    ) {
      return false;
    }
    if (rawTitle && !this.validateScoreSemanticCompatibility(rawTitle, scoreData, steamAppId)) {
      return false;
    }
    const cacheKey =
      typeof steamAppId === 'number' && steamAppId > 0
        ? `id:${steamAppId}`
        : rawTitle
        ? `title:${rawTitle.toLowerCase()}`
        : '';
    if (!cacheKey) return false;

    const incomingRank = getReviewSourceAuthorityRank(scoreData);
    if (this.hasValidCachedResolution(steamAppId, rawTitle)) {
      const stagedPrimary = loadStagedCache<CriticScoreData>(`${STORAGE_PREFIX}${cacheKey}`, false);
      const stagedTitle = rawTitle
        ? loadStagedCache<CriticScoreData>(`${STORAGE_PREFIX}title:${rawTitle.toLowerCase()}`, false)
        : { valid: false, data: null, entry: undefined };
      const existingData =
        (stagedPrimary.valid ? stagedPrimary.data : null) ??
        (stagedTitle.valid ? stagedTitle.data : null) ??
        this.inMemoryCache.get(cacheKey) ??
        null;
      const existingRank = getReviewSourceAuthorityRank(existingData);
      if (existingRank >= incomingRank) {
        return false;
      }
    }

    return this.cacheResult(cacheKey, scoreData, releaseDate, genres, {
      dynamicResolved: true,
      aliasTitle: rawTitle || undefined,
      titleForValidation: rawTitle || undefined,
      steamAppIdForValidation: steamAppId,
    });
  }

  /**
   * Retrieves verified critic consensus data for a game, or derives a synthetic score from Steam reviews
   * if no verified critic consensus exists, while deferring storage writes and dynamic resolution
   * onto a deduplicated microtask scheduler outside synchronous React render (H7).
   */
  getCriticScore(
    steamAppId?: number | null,
    title?: string,
    steamPositivePercent?: number,
    releaseYear?: number | string | null,
    storefrontAnchor?: StorefrontReviewAnchor | null,
    bypassTTL: boolean = false,
    skipBackgroundTrigger: boolean = false,
    context?: CriticScoreContext
  ): CriticScoreData | null {
    this.ensureHydrated();
    const rawTitle = (title || '').trim();
    const lowerTitle = rawTitle.toLowerCase();
    let cachedAposStripped: string | undefined;
    let cachedNormalizedKey: string | undefined;
    let cachedStrippedKey: string | undefined;
    const getAposStrippedTitle = (): string => {
      if (cachedAposStripped === undefined) {
        cachedAposStripped = lowerTitle.includes("'") || /[’ʼ`]/.test(lowerTitle)
          ? lowerTitle.replace(/['’ʼ`]/g, '')
          : lowerTitle;
      }
      return cachedAposStripped;
    };
    const getNormalizedKey = (): string => {
      if (cachedNormalizedKey === undefined) {
        cachedNormalizedKey = normalizeCriticTitleKey(rawTitle);
      }
      return cachedNormalizedKey;
    };
    const getStrippedKey = (): string => {
      if (cachedStrippedKey === undefined) {
        cachedStrippedKey = stripEditionSuffix(rawTitle);
      }
      return cachedStrippedKey;
    };

    const cacheKey = steamAppId ? `id:${steamAppId}` : `title:${lowerTitle}`;
    const stagedKey = `${STORAGE_PREFIX}${cacheKey}`;
    const hasEntitlementContext = Boolean(
      context && (context.gameId || (Array.isArray(context.platforms) && context.platforms.length > 0))
    );

    const schedulePassiveDynamicResolution = (
      resolveTitle: string,
      resolveSteamId: number | null | undefined,
      resolveYear?: number | string | null,
      resolveAnchor?: StorefrontReviewAnchor | null
    ) => {
      const prevPassive = this.isPassiveRenderTrigger;
      this.isPassiveRenderTrigger = true;
      try {
        const resolveOptions = hasEntitlementContext
          ? { gameId: context?.gameId, platforms: context?.platforms }
          : undefined;
        if (resolveOptions) {
          this.resolveDynamicScore(
            resolveTitle,
            resolveSteamId,
            resolveYear,
            resolveAnchor,
            resolveOptions
          ).catch(() => {});
        } else if (resolveAnchor !== undefined) {
          this.resolveDynamicScore(resolveTitle, resolveSteamId, resolveYear, resolveAnchor).catch(() => {});
        } else if (resolveYear !== undefined && resolveYear !== null) {
          this.resolveDynamicScore(resolveTitle, resolveSteamId, resolveYear).catch(() => {});
        } else {
          this.resolveDynamicScore(resolveTitle, resolveSteamId).catch(() => {});
        }
      } finally {
        this.isPassiveRenderTrigger = prevPassive;
      }
    };

    const userOverride = this.findMatchingUserOverride(
      steamAppId,
      rawTitle,
      context?.gameId,
      context?.platforms
    );
    if (userOverride && (userOverride.reviewScoreOverride !== undefined || userOverride.reviewRoute !== undefined)) {
      const route = inferReviewRouteFromOverride(userOverride);
      if (route?.mode === 'unrated') {
        this.attemptedDynamicResolutions.add(cacheKey);
        if (lowerTitle) this.attemptedDynamicResolutions.add(`title:${lowerTitle}`);
        this.setInMemoryCache(cacheKey, null);
        this.scheduleDeferredStorageTask(`save:${stagedKey}`, () => {
          saveStagedCache<CriticScoreData>(stagedKey, null, MutabilityTier.TIER_0_USER_OVERRIDE);
        });
        return null;
      }
      if (route?.mode === 'static') {
        this.attemptedDynamicResolutions.add(cacheKey);
        if (lowerTitle) this.attemptedDynamicResolutions.add(`title:${lowerTitle}`);
        const staticScore = userOverride.reviewScoreOverride ?? null;
        this.setInMemoryCache(cacheKey, staticScore);
        this.scheduleDeferredStorageTask(`save:${stagedKey}`, () => {
          saveStagedCache<CriticScoreData>(stagedKey, staticScore, MutabilityTier.TIER_0_USER_OVERRIDE);
        });
        return staticScore;
      }
      if (route?.mode === 'routed') {
        if (bypassTTL && onlineLifecycleManager.isOnline()) {
          this.inMemoryCache.delete(cacheKey);
          this.attemptedDynamicResolutions.delete(cacheKey);
          if (lowerTitle) this.attemptedDynamicResolutions.delete(`title:${lowerTitle}`);
        }
        const staged = loadStagedCache<CriticScoreData>(stagedKey, bypassTTL);
        if ((staged.valid || !onlineLifecycleManager.isOnline()) && staged.data) {
          if (staged.valid) {
            this.attemptedDynamicResolutions.add(cacheKey);
            if (lowerTitle) this.attemptedDynamicResolutions.add(`title:${lowerTitle}`);
          }
          if (!staged.isCompactStub) {
            this.setInMemoryCache(cacheKey, staged.data);
          } else {
            this.stubPinnedKeys.add(cacheKey);
          }
          return staged.data;
        }
        if (
          onlineLifecycleManager.isOnline() &&
          !skipBackgroundTrigger &&
          !this.attemptedDynamicResolutions.has(cacheKey)
        ) {
          schedulePassiveDynamicResolution(
            rawTitle || userOverride.title || '',
            steamAppId,
            releaseYear,
            storefrontAnchor
          );
        }
        return staged.data || userOverride.reviewScoreOverride || null;
      }
    }

    // 0. Check Tier 0 User Override (Absolute human authority, skips network/heuristic tiers)
    const stagedTier0 = loadStagedCache<CriticScoreData>(stagedKey, false);
    if (
      stagedTier0.entry &&
      (stagedTier0.entry.tier === MutabilityTier.TIER_0_USER_OVERRIDE || stagedTier0.entry.tier === 'override')
    ) {
      this.attemptedDynamicResolutions.add(cacheKey);
      if (lowerTitle) this.attemptedDynamicResolutions.add(`title:${lowerTitle}`);
      if (stagedTier0.entry.data === null) {
        this.setInMemoryCache(cacheKey, null);
        return null;
      }
      if (stagedTier0.entry.data) {
        this.setInMemoryCache(cacheKey, stagedTier0.entry.data);
        return stagedTier0.entry.data;
      }
    }

    let year = releaseYear;
    let enrichedReleaseDate: string | undefined;
    let enrichedGenres: string[] | undefined;
    if (steamAppId) {
      const enriched = STEAM_ENRICHED_CRITIC_MAP[String(steamAppId)];
      enrichedReleaseDate = enriched?.releaseDate || enriched?.release_date;
      enrichedGenres = enriched?.genres;
      if (!year && enrichedReleaseDate) {
        const m = String(enrichedReleaseDate).match(/\b(19\d\d|20\d\d)\b/);
        if (m) year = parseInt(m[1], 10);
      }
    }
    const effectiveReleaseDate = enrichedReleaseDate || (year ? String(year) : undefined);

    const triggerDynamicResolution = () => {
      if (skipBackgroundTrigger) return;
      if (!onlineLifecycleManager.isOnline()) return;
      if (rawTitle && !this.attemptedDynamicResolutions.has(cacheKey)) {
        schedulePassiveDynamicResolution(rawTitle, steamAppId, year, storefrontAnchor);
      }
    };

    const isNonGameAddonOrBeta = NON_GAME_ADDON_OR_BETA_REGEX.test(rawTitle);

    const isScoreSemanticallyCompatible = (scoreData: CriticScoreData | null | undefined): boolean =>
      this.validateScoreSemanticCompatibility(
        rawTitle,
        scoreData,
        steamAppId,
        storefrontAnchor?.metacriticSlug
      );

    if (bypassTTL) {
      this.inMemoryCache.delete(cacheKey);
      this.attemptedDynamicResolutions.delete(cacheKey);
      if (lowerTitle) this.attemptedDynamicResolutions.delete(`title:${lowerTitle}`);
    }

    // 1. Check in-memory cache across primary and normalized title keys (monotonically preferring highest authority)
    if (!bypassTTL) {
      const readValidMemKey = (mKey: string): CriticScoreData | null | undefined => {
        if (!this.inMemoryCache.has(mKey)) return undefined;
        const cached = this.inMemoryCache.get(mKey);
        if (cached === null) {
          return null;
        }
        if (cached && isScoreSemanticallyCompatible(cached)) {
          return cached;
        } else if (cached && mKey === cacheKey) {
          this.inMemoryCache.delete(cacheKey);
        }
        return undefined;
      };

      const directHit = readValidMemKey(cacheKey);
      if (directHit === null) {
        return null;
      }

      let bestMemHit: CriticScoreData | undefined = directHit;
      let bestMemKey: string | undefined = directHit ? cacheKey : undefined;
      let bestMemRank = bestMemHit ? getReviewSourceAuthorityRank(bestMemHit) : 0;

      if (bestMemRank < 3) {
        const siblingMemKeys: string[] = [];
        if (lowerTitle && cacheKey !== `title:${lowerTitle}`) {
          siblingMemKeys.push(`title:${lowerTitle}`);
        }
        const aposStrippedTitle = getAposStrippedTitle();
        if (aposStrippedTitle && aposStrippedTitle !== lowerTitle) {
          siblingMemKeys.push(`title:${aposStrippedTitle}`);
        }
        const normalizedKey = getNormalizedKey();
        if (normalizedKey && normalizedKey !== lowerTitle && normalizedKey !== aposStrippedTitle) {
          siblingMemKeys.push(`title:${normalizedKey}`);
        }
        for (const sKey of siblingMemKeys) {
          const sib = readValidMemKey(sKey);
          if (sib === null && bestMemHit === undefined) {
            return null;
          }
          if (sib) {
            const sibRank = getReviewSourceAuthorityRank(sib);
            if (!bestMemHit || sibRank > bestMemRank) {
              bestMemHit = sib;
              bestMemKey = sKey;
              bestMemRank = sibRank;
            }
          }
        }
      }

      if (bestMemHit) {
        if (bestMemKey !== cacheKey) {
          this.setInMemoryCache(cacheKey, bestMemHit);
        }
        if (bestMemHit.isSynthetic || bestMemHit.source === 'opencritic') {
          triggerDynamicResolution();
        }
        return bestMemHit;
      }
    }

    // 2. Direct lookup in master verified dataset (Authoritative compiled data takes precedence over unverified localStorage)
    let verifiedMatch: CriticScoreData | undefined;
    if (!isNonGameAddonOrBeta) {
      if (steamAppId && KNOWN_CRITIC_SCORES[steamAppId]) {
        verifiedMatch = KNOWN_CRITIC_SCORES[steamAppId];
      } else if (lowerTitle && KNOWN_CRITIC_SCORES[lowerTitle]) {
        verifiedMatch = KNOWN_CRITIC_SCORES[lowerTitle];
      } else {
        const normalizedKey = getNormalizedKey();
        if (normalizedKey && KNOWN_CRITIC_SCORES[normalizedKey]) {
          verifiedMatch = KNOWN_CRITIC_SCORES[normalizedKey];
        } else {
          const strippedKey = getStrippedKey();
          if (strippedKey && strippedKey !== normalizedKey && KNOWN_CRITIC_SCORES[strippedKey]) {
            verifiedMatch = KNOWN_CRITIC_SCORES[strippedKey];
          }
        }
      }
    }

    if (verifiedMatch && isScoreSemanticallyCompatible(verifiedMatch)) {
      const existingStaged = !bypassTTL ? stagedTier0 : loadStagedCache<CriticScoreData>(stagedKey, bypassTTL);
      if (existingStaged.valid && !bypassTTL && existingStaged.entry?.dynamicResolved) {
        this.attemptedDynamicResolutions.add(cacheKey);
        if (lowerTitle) this.attemptedDynamicResolutions.add(`title:${lowerTitle}`);
        if (existingStaged.data && isScoreSemanticallyCompatible(existingStaged.data)) {
          if (!existingStaged.isCompactStub) {
            this.setInMemoryCache(cacheKey, existingStaged.data);
          }
          return existingStaged.data;
        }
      }
      if (!verifiedMatch.isSynthetic && verifiedMatch.source === 'metacritic') {
        this.attemptedDynamicResolutions.add(cacheKey);
        if (lowerTitle) this.attemptedDynamicResolutions.add(`title:${lowerTitle}`);
      }
      this.setInMemoryCache(cacheKey, verifiedMatch);
      if (!skipBackgroundTrigger && isStagedVaultHydrationComplete()) {
        const dynamicResolvedFlag =
          existingStaged.valid && !bypassTTL ? existingStaged.entry?.dynamicResolved : undefined;
        this.scheduleDeferredStorageTask(`save:${stagedKey}`, () => {
          this.cacheResult(cacheKey, verifiedMatch, effectiveReleaseDate, enrichedGenres, {
            dynamicResolved: dynamicResolvedFlag,
            aliasTitle: rawTitle || undefined,
          });
        });
      } else if (!isStagedVaultHydrationComplete()) {
        this.stubPinnedKeys.add(cacheKey);
      }
      if (
        (verifiedMatch.isSynthetic || verifiedMatch.source === 'opencritic') &&
        !this.attemptedDynamicResolutions.has(cacheKey)
      ) {
        triggerDynamicResolution();
      }
      return verifiedMatch;
    }

    // 3. Check staged localStorage cache across primary and normalized title keys (reuse stagedTier0 when !bypassTTL)
    let staged = !bypassTTL ? stagedTier0 : loadStagedCache<CriticScoreData>(stagedKey, bypassTTL);
    if (staged.entry && staged.data && !isScoreSemanticallyCompatible(staged.data)) {
      this.scheduleDeferredStorageTask(`evict:${stagedKey}`, () => {
        evictStagedCache(stagedKey);
      });
      staged = { valid: false, data: null, entry: undefined };
    }

    const tryFallbackStagedKey = (fallbackKey: string) => {
      const altStaged = loadStagedCache<CriticScoreData>(fallbackKey, bypassTTL);
      if (altStaged.entry) {
        if (altStaged.data && !isScoreSemanticallyCompatible(altStaged.data)) {
          this.scheduleDeferredStorageTask(`evict:${fallbackKey}`, () => {
            evictStagedCache(fallbackKey);
          });
          return;
        }
        if (altStaged.data || altStaged.entry.data === null) {
          staged = altStaged;
          if (
            altStaged.data &&
            steamAppId &&
            cacheKey === `id:${steamAppId}` &&
            !altStaged.isCompactStub &&
            isStagedVaultHydrationComplete()
          ) {
            const altData = altStaged.data;
            const altTier = altStaged.entry.tier;
            const altDynamic = Boolean(altStaged.entry.dynamicResolved);
            this.setInMemoryCache(`id:${steamAppId}`, altData);
            this.scheduleDeferredStorageTask(`save:${stagedKey}`, () => {
              saveStagedCache<CriticScoreData>(stagedKey, altData, altTier, {
                source: altData.source,
                isVerified: altData.isVerified,
                dynamicResolved: altDynamic,
              });
            });
          }
        }
      }
    };

    if (!staged.entry && lowerTitle && cacheKey !== `title:${lowerTitle}`) {
      tryFallbackStagedKey(`${STORAGE_PREFIX}title:${lowerTitle}`);
    }
    if (!staged.entry) {
      const aposStrippedTitle = getAposStrippedTitle();
      if (
        aposStrippedTitle &&
        aposStrippedTitle !== lowerTitle &&
        cacheKey !== `title:${aposStrippedTitle}`
      ) {
        tryFallbackStagedKey(`${STORAGE_PREFIX}title:${aposStrippedTitle}`);
      }
    }
    if (!staged.entry) {
      const normalizedKey = getNormalizedKey();
      if (normalizedKey && cacheKey !== `title:${normalizedKey}`) {
        tryFallbackStagedKey(`${STORAGE_PREFIX}title:${normalizedKey}`);
      }
    }

    if (staged.entry) {
      if (staged.entry.data === null) {
        if (staged.valid && !bypassTTL) {
          this.setInMemoryCache(cacheKey, null);
          this.attemptedDynamicResolutions.add(cacheKey);
          if (lowerTitle) this.attemptedDynamicResolutions.add(`title:${lowerTitle}`);
          return null;
        } else {
          this.inMemoryCache.delete(cacheKey);
          this.attemptedDynamicResolutions.delete(cacheKey);
          if (lowerTitle) this.attemptedDynamicResolutions.delete(`title:${lowerTitle}`);
          triggerDynamicResolution();
          return null;
        }
      } else if (staged.data && isScoreSemanticallyCompatible(staged.data)) {
        if (!onlineLifecycleManager.isOnline()) {
          if (!staged.isCompactStub) {
            this.setInMemoryCache(cacheKey, staged.data);
          }
          return staged.data;
        }
        if (staged.valid && !bypassTTL) {
          if (!staged.isCompactStub) {
            this.setInMemoryCache(cacheKey, staged.data);
          }
          if (staged.data.isSynthetic && !staged.entry.dynamicResolved) {
            // Synchronous pre-resolution synthetic score that hasn't completed dynamic cascade yet
            triggerDynamicResolution();
            return staged.data;
          } else {
            this.attemptedDynamicResolutions.add(cacheKey);
            if (lowerTitle) this.attemptedDynamicResolutions.add(`title:${lowerTitle}`);
            return staged.data;
          }
        } else {
          this.inMemoryCache.delete(cacheKey);
          this.attemptedDynamicResolutions.delete(cacheKey);
          if (lowerTitle) this.attemptedDynamicResolutions.delete(`title:${lowerTitle}`);
          triggerDynamicResolution();
          return staged.data;
        }
      } else {
        this.scheduleDeferredStorageTask(`evict:${stagedKey}`, () => {
          evictStagedCache(stagedKey);
        });
      }
    }

    // Early explicit unrated check (betas, editors, demos, unrated classics)
    const isExplicitlyUnrated =
      isNonGameAddonOrBeta ||
      KNOWN_UNRATED_TITLES.has(lowerTitle) ||
      (Boolean(getNormalizedKey()) && KNOWN_UNRATED_TITLES.has(getNormalizedKey()));
    if (isExplicitlyUnrated) {
      this.attemptedDynamicResolutions.add(cacheKey);
      if (lowerTitle) this.attemptedDynamicResolutions.add(`title:${lowerTitle}`);
      let positive = steamAppId ? steamPositivePercent : undefined;
      let totalReviews: number | undefined;
      if (positive === undefined && steamAppId) {
        const enriched = STEAM_ENRICHED_CRITIC_MAP[String(steamAppId)];
        if (enriched?.reviewSummary?.positivePercent !== undefined) {
          positive = enriched.reviewSummary.positivePercent;
          totalReviews = enriched.reviewSummary.totalReviews;
        }
      }
      if (positive !== undefined && positive > 0) {
        const synthetic = calculateSyntheticSteamScore(positive, totalReviews);
        const syntheticData: CriticScoreData = {
          id: steamAppId ? `steam-${steamAppId}` : undefined,
          source: 'steam',
          score: synthetic.score,
          percentRecommended: synthetic.percentRecommended,
          tier: synthetic.tier,
          numReviews: totalReviews || 50,
          url: steamAppId
            ? `https://store.steampowered.com/app/${steamAppId}`
            : `https://store.steampowered.com/search/?term=${encodeURIComponent(rawTitle)}`,
          summary: `Based on Steam community player reviews (${positive}% positive).`,
          isVerified: false,
          isSynthetic: true,
        };
        this.setInMemoryCache(cacheKey, syntheticData);
        if (!skipBackgroundTrigger && isStagedVaultHydrationComplete()) {
          this.scheduleDeferredStorageTask(`save:${stagedKey}`, () => {
            this.cacheResult(cacheKey, syntheticData, effectiveReleaseDate, enrichedGenres, {
              dynamicResolved: true,
              aliasTitle: rawTitle || undefined,
            });
          });
        } else if (!isStagedVaultHydrationComplete()) {
          this.stubPinnedKeys.add(cacheKey);
        }
        return syntheticData;
      }
      if (!skipBackgroundTrigger && isStagedVaultHydrationComplete()) {
        this.scheduleDeferredStorageTask(`save:${stagedKey}`, () => {
          this.cacheResult(cacheKey, null, effectiveReleaseDate, enrichedGenres, {
            dynamicResolved: true,
            aliasTitle: rawTitle || undefined,
          });
        });
      }
      return null;
    }

    // 4. Trigger cascading dynamic live resolution in background when not skipped
    triggerDynamicResolution();

    // 5. Look for authentic Steam review sentiment to construct immediate synthetic score
    // IMPORTANT: Only use review percentages if tied to a legitimate Steam App ID to avoid GOG star-rating contamination!
    let positive = steamAppId ? steamPositivePercent : undefined;
    let totalReviews: number | undefined;

    if (positive === undefined && steamAppId) {
      const enriched = STEAM_ENRICHED_CRITIC_MAP[String(steamAppId)];
      if (enriched?.reviewSummary?.positivePercent !== undefined) {
        positive = enriched.reviewSummary.positivePercent;
        totalReviews = enriched.reviewSummary.totalReviews;
      }
    }

    if (positive !== undefined && positive > 0 && steamAppId) {
      const synthetic = calculateSyntheticSteamScore(positive, totalReviews);
      const syntheticData: CriticScoreData = {
        id: `steam-${steamAppId}`,
        source: 'steam',
        score: synthetic.score,
        percentRecommended: synthetic.percentRecommended,
        tier: synthetic.tier,
        numReviews: totalReviews || 50,
        url: `https://store.steampowered.com/app/${steamAppId}`,
        summary: `Based on Steam community player reviews (${positive}% positive).`,
        isVerified: false,
        isSynthetic: true,
      };

      this.setInMemoryCache(cacheKey, syntheticData);
      if (!skipBackgroundTrigger && isStagedVaultHydrationComplete()) {
        this.scheduleDeferredStorageTask(`save:${stagedKey}`, () => {
          this.cacheResult(cacheKey, syntheticData, effectiveReleaseDate, enrichedGenres, {
            titleForValidation: rawTitle || undefined,
            steamAppIdForValidation: steamAppId,
          });
        });
      } else if (!isStagedVaultHydrationComplete()) {
        this.stubPinnedKeys.add(cacheKey);
      }
      return syntheticData;
    }

    // 6. Explicit unrated exclusion check (strictly null when no Steam reviews exist)
    if (KNOWN_UNRATED_TITLES.has(lowerTitle) || KNOWN_UNRATED_TITLES.has(getNormalizedKey())) {
      this.attemptedDynamicResolutions.add(cacheKey);
      if (lowerTitle) this.attemptedDynamicResolutions.add(`title:${lowerTitle}`);
      if (!skipBackgroundTrigger && isStagedVaultHydrationComplete()) {
        this.scheduleDeferredStorageTask(`save:${stagedKey}`, () => {
          this.cacheResult(cacheKey, null, effectiveReleaseDate, enrichedGenres, {
            dynamicResolved: true,
            aliasTitle: rawTitle || undefined,
          });
        });
      }
      return null;
    }

    // Non-blocking initial return: null until dynamic resolution completes
    return null;
  }

  /**
   * Dynamically resolves an authentic score via the 3-tier cascade:
   * Tier 1: Metacritic Live JSON-LD Scraper (verified press consensus, >= 4 reviews)
   * Tier 2: OpenCritic Live API (verified press consensus, >= 4 reviews)
   * Tier 3: Steam Live Community Reviews (authentic player sentiment, >= 10 reviews)
   */
  async resolveDynamicScore(
    rawTitle: string,
    steamAppId?: number | null,
    releaseYear?: number | string | null,
    storefrontAnchor?: StorefrontReviewAnchor | null,
    options?: {
      bypassAttempted?: boolean;
      platforms?: CriticEntitlementPlatform[];
      gameId?: string;
      genres?: string[];
      steamPositivePercent?: number;
    }
  ): Promise<CriticScoreData | null> {
    if (this.isPassiveRenderTrigger) {
      const deferredTitle = (rawTitle || '').trim();
      if (!deferredTitle) return null;
      const deferredKey = steamAppId ? `id:${steamAppId}` : `title:${deferredTitle.toLowerCase()}`;
      if (this.inFlightResolutions.has(deferredKey)) {
        return this.inFlightResolutions.get(deferredKey)!;
      }
      if (this.pendingPassiveTriggers.has(deferredKey)) {
        return this.pendingPassiveTriggers.get(deferredKey)!;
      }
      const scheduled = Promise.resolve().then(() => {
        this.pendingPassiveTriggers.delete(deferredKey);
        return this.executeDynamicScoreResolution(
          rawTitle,
          steamAppId,
          releaseYear,
          storefrontAnchor,
          options
        );
      });
      this.pendingPassiveTriggers.set(deferredKey, scheduled);
      return scheduled;
    }
    return this.executeDynamicScoreResolution(
      rawTitle,
      steamAppId,
      releaseYear,
      storefrontAnchor,
      options
    );
  }

  private extractGogSlugFromContext(
    platforms?: CriticEntitlementPlatform[],
    anchor?: StorefrontReviewAnchor | null
  ): string | undefined {
    if (anchor?.storefront === 'gog' && anchor.rawStoreUrl) {
      const fromAnchor = normalizeWikidataGogSlug(anchor.rawStoreUrl);
      if (fromAnchor) return fromAnchor;
    }
    if (Array.isArray(platforms)) {
      for (const p of platforms) {
        if (p?.platformId?.toLowerCase() === 'gog') {
          const fromPlat =
            normalizeWikidataGogSlug(p.platformGameId) ||
            normalizeWikidataGogSlug(p.storefrontAppId);
          if (fromPlat) return fromPlat;
        }
      }
    }
    return undefined;
  }

  private async executeDynamicScoreResolution(
    rawTitle: string,
    steamAppId?: number | null,
    releaseYear?: number | string | null,
    storefrontAnchor?: StorefrontReviewAnchor | null,
    options?: {
      bypassAttempted?: boolean;
      platforms?: CriticEntitlementPlatform[];
      gameId?: string;
      genres?: string[];
      steamPositivePercent?: number;
    }
  ): Promise<CriticScoreData | null> {
    this.ensureHydrated();
    const title = (rawTitle || '').trim();
    if (!title) return null;

    let year = releaseYear;
    let enrichedReleaseDate: string | undefined;
    let enrichedGenres: string[] | undefined = options?.genres;
    if (steamAppId) {
      const enriched = STEAM_ENRICHED_CRITIC_MAP[String(steamAppId)];
      enrichedReleaseDate = enriched?.releaseDate || enriched?.release_date;
      enrichedGenres = enriched?.genres || enrichedGenres;
      if (!year && enrichedReleaseDate) {
        const m = String(enrichedReleaseDate).match(/\b(19\d\d|20\d\d)\b/);
        if (m) year = parseInt(m[1], 10);
      }
    }
    if (!year && title) {
      const parenYear = extractParentheticalReleaseYear(title);
      if (parenYear !== null) year = parenYear;
    }
    const effectiveReleaseDate = enrichedReleaseDate || (year ? String(year) : undefined);

    const cacheKey = steamAppId ? `id:${steamAppId}` : `title:${title.toLowerCase()}`;
    const stagedKey = `${STORAGE_PREFIX}${cacheKey}`;

    if (options?.bypassAttempted) {
      this.attemptedDynamicResolutions.delete(cacheKey);
      if (title) this.attemptedDynamicResolutions.delete(`title:${title.toLowerCase()}`);
    }

    const userOverride = this.findMatchingUserOverride(
      steamAppId,
      title,
      options?.gameId,
      options?.platforms
    );
    if (userOverride && (userOverride.reviewScoreOverride !== undefined || userOverride.reviewRoute !== undefined)) {
      const route = inferReviewRouteFromOverride(userOverride);
      if (route?.mode === 'unrated') {
        this.setInMemoryCache(cacheKey, null);
        saveStagedCache<CriticScoreData>(stagedKey, null, MutabilityTier.TIER_0_USER_OVERRIDE);
        return null;
      }
      if (route?.mode === 'static') {
        const staticScore = userOverride.reviewScoreOverride ?? null;
        this.setInMemoryCache(cacheKey, staticScore);
        saveStagedCache<CriticScoreData>(stagedKey, staticScore, MutabilityTier.TIER_0_USER_OVERRIDE);
        return staticScore;
      }
      if (route?.mode === 'routed') {
        const stagedRouted = loadStagedCache<CriticScoreData>(stagedKey, false);
        if (!onlineLifecycleManager.isOnline()) {
          const fallbackVal = stagedRouted.data || userOverride.reviewScoreOverride || null;
          if (fallbackVal) {
            this.setInMemoryCache(cacheKey, fallbackVal);
          }
          return fallbackVal;
        }
        this.attemptedDynamicResolutions.add(cacheKey);
        if (title) this.attemptedDynamicResolutions.add(`title:${title.toLowerCase()}`);
        const refreshed = await this.resolveRoutedScore(route, title, year, userOverride.reviewScoreOverride);
        if (refreshed) {
          const dynamicTier = determineGameMutabilityTier({
            releaseDate: userOverride.releaseDate || effectiveReleaseDate,
            isOverride: false,
          });
          this.setInMemoryCache(cacheKey, refreshed);
          const savedRouted = saveStagedCache<CriticScoreData>(stagedKey, refreshed, dynamicTier, {
            source: refreshed.source,
            isVerified: refreshed.isVerified,
            dynamicResolved: true,
          });
          const lower = title.toLowerCase();
          if (lower && cacheKey !== `title:${lower}`) {
            this.setInMemoryCache(`title:${lower}`, refreshed);
            saveStagedCache<CriticScoreData>(`${STORAGE_PREFIX}title:${lower}`, refreshed, dynamicTier, {
              source: refreshed.source,
              isVerified: refreshed.isVerified,
              dynamicResolved: true,
              cachedAt: savedRouted.cachedAt,
              customTtlMs: savedRouted.ttlMs,
            });
          }
          try {
            const overrideLookupKey =
              userOverride.gameId ||
              (userOverride.platformId && userOverride.platformGameId
                ? `${userOverride.platformId}:${userOverride.platformGameId}`
                : options?.gameId || '');
            if (overrideLookupKey) {
              patchUserOverrideReviewScore(overrideLookupKey, refreshed);
            }
          } catch {}
          if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
            window.dispatchEvent(
              new CustomEvent('antigravity_critic_updated', {
                detail: { cacheKey, title, steamAppId, data: refreshed },
              })
            );
          }
          return refreshed;
        }
        const fallbackVal = stagedRouted.data || userOverride.reviewScoreOverride || null;
        if (fallbackVal) {
          this.setInMemoryCache(cacheKey, fallbackVal);
        }
        return fallbackVal;
      }
    }

    // 0. Check Tier 0 User Override (Absolute human authority, skips dynamic resolution)
    const stagedTier0 = loadStagedCache<CriticScoreData>(stagedKey, false);
    if (
      stagedTier0.entry &&
      (stagedTier0.entry.tier === MutabilityTier.TIER_0_USER_OVERRIDE || stagedTier0.entry.tier === 'override')
    ) {
      if (stagedTier0.entry.data === null) {
        this.setInMemoryCache(cacheKey, null);
        return null;
      }
      if (stagedTier0.entry.data) {
        this.setInMemoryCache(cacheKey, stagedTier0.entry.data);
        return stagedTier0.entry.data;
      }
    }

    const lowerTitleKey = title ? `title:${title.toLowerCase()}` : '';
    if (this.inMemoryCache.has(cacheKey) || (lowerTitleKey && this.inMemoryCache.has(lowerTitleKey))) {
      const existing =
        this.inMemoryCache.get(cacheKey) ??
        (lowerTitleKey ? this.inMemoryCache.get(lowerTitleKey) : undefined);
      // Only short-circuit if already verified Tier 1 Metacritic AND not stale/forced; if OpenCritic or stale, allow dynamic refresh/upgrade
      if (
        !options?.bypassAttempted &&
        !stagedTier0.stale &&
        existing?.isVerified &&
        existing.source === 'metacritic'
      ) {
        if (this.validateScoreSemanticCompatibility(title, existing, steamAppId)) {
          this.cacheResult(cacheKey, existing, effectiveReleaseDate, enrichedGenres, {
            dynamicResolved: true,
            aliasTitle: title,
          });
          if (lowerTitleKey && lowerTitleKey !== cacheKey) {
            this.setInMemoryCache(lowerTitleKey, existing);
          }
          return existing;
        } else {
          this.inMemoryCache.delete(cacheKey);
          if (lowerTitleKey) this.inMemoryCache.delete(lowerTitleKey);
          this.attemptedDynamicResolutions.delete(cacheKey);
          if (lowerTitleKey) this.attemptedDynamicResolutions.delete(lowerTitleKey);
        }
      } else if (existing && this.validateScoreSemanticCompatibility(title, existing, steamAppId)) {
        if (!this.inMemoryCache.has(cacheKey)) {
          this.cacheResult(cacheKey, existing, effectiveReleaseDate, enrichedGenres, {
            titleForValidation: title,
            steamAppIdForValidation: steamAppId,
          });
        }
        if (lowerTitleKey && lowerTitleKey !== cacheKey && !this.inMemoryCache.has(lowerTitleKey)) {
          this.setInMemoryCache(lowerTitleKey, existing);
        }
      }
    }

    if (this.inFlightResolutions.has(cacheKey)) {
      return this.inFlightResolutions.get(cacheKey)!;
    }

    if (this.attemptedDynamicResolutions.has(cacheKey)) {
      const existing = this.inMemoryCache.get(cacheKey);
      if (existing && title) {
        if (!this.validateScoreSemanticCompatibility(title, existing, steamAppId)) {
          this.inMemoryCache.delete(cacheKey);
          this.attemptedDynamicResolutions.delete(cacheKey);
          if (title) this.attemptedDynamicResolutions.delete(`title:${title.toLowerCase()}`);
        } else {
          return existing;
        }
      } else {
        return existing ?? null;
      }
    }
    this.attemptedDynamicResolutions.add(cacheKey);
    if (title) this.attemptedDynamicResolutions.add(`title:${title.toLowerCase()}`);

    const promise = (async (): Promise<CriticScoreData | null> => {
      try {
        const cleanTitle =
          normalizeTitleForStoreSearch(title, { stripEditions: true }) ||
          normalizeTitleForStoreSearch(title);

        const lower = title.toLowerCase();
        const normKey = normalizeCriticTitleKey(title);

        const isCandidateValid = (
          candidate: CriticScoreData | null | undefined,
          verifiedAnchorSlug?: string | null
        ): candidate is CriticScoreData =>
          candidate
            ? this.validateScoreSemanticCompatibility(
                title,
                candidate,
                steamAppId,
                verifiedAnchorSlug
              )
            : false;

        let priorPositiveScore: CriticScoreData | null = null;
        let priorPositiveIsFresh = false;
        const priorKeys = [stagedKey];
        if (lower && stagedKey !== `${STORAGE_PREFIX}title:${lower}`) {
          priorKeys.push(`${STORAGE_PREFIX}title:${lower}`);
        }
        if (normKey && stagedKey !== `${STORAGE_PREFIX}title:${normKey}`) {
          priorKeys.push(`${STORAGE_PREFIX}title:${normKey}`);
        }
        for (const pKey of priorKeys) {
          const priorStaged = loadStagedCache<CriticScoreData>(pKey, false);
          if (
            priorStaged.data &&
            typeof priorStaged.data.score === 'number' &&
            priorStaged.data.score > 0 &&
            isCandidateValid(priorStaged.data, storefrontAnchor?.metacriticSlug)
          ) {
            const candRank = getReviewSourceAuthorityRank(priorStaged.data);
            const curRank = getReviewSourceAuthorityRank(priorPositiveScore);
            if (!priorPositiveScore || candRank > curRank || (candRank === curRank && priorStaged.valid && !priorPositiveIsFresh)) {
              priorPositiveScore = priorStaged.data;
              priorPositiveIsFresh = priorStaged.valid;
            }
          }
        }
        if (!priorPositiveScore) {
          const memExisting = this.inMemoryCache.get(cacheKey);
          if (
            memExisting &&
            typeof memExisting.score === 'number' &&
            memExisting.score > 0 &&
            isCandidateValid(memExisting, storefrontAnchor?.metacriticSlug)
          ) {
            priorPositiveScore = memExisting;
          } else if (
            steamAppId &&
            typeof options?.steamPositivePercent === 'number' &&
            options.steamPositivePercent > 0
          ) {
            const synthetic = calculateSyntheticSteamScore(options.steamPositivePercent);
            priorPositiveScore = {
              id: `steam-${steamAppId}`,
              source: 'steam',
              score: synthetic.score,
              percentRecommended: synthetic.percentRecommended,
              tier: synthetic.tier,
              numReviews: 50,
              url: `https://store.steampowered.com/app/${steamAppId}`,
              summary: `Based on Steam community player reviews (${options.steamPositivePercent}% positive).`,
              isVerified: false,
              isSynthetic: true,
            };
          }
        }

        const retainExplicitUnrated = () => {
          const current = this.inMemoryCache.get(cacheKey);
          if (current?.isSynthetic && isCandidateValid(current)) {
            this.cacheResult(cacheKey, current, effectiveReleaseDate, enrichedGenres, {
              dynamicResolved: true,
              aliasTitle: title,
              titleForValidation: title,
              steamAppIdForValidation: steamAppId,
            });
            if (lower && cacheKey !== `title:${lower}`) {
              this.setInMemoryCache(`title:${lower}`, current);
            }
            if (normKey && cacheKey !== `title:${normKey}`) {
              this.setInMemoryCache(`title:${normKey}`, current);
            }
            return current;
          }
          this.cacheResult(cacheKey, null, effectiveReleaseDate, enrichedGenres, {
            dynamicResolved: true,
            allowOverwritePositive: true,
            allowAuthorityDowngrade: true,
            aliasTitle: title,
            titleForValidation: title,
            steamAppIdForValidation: steamAppId,
          });
          if (lower && cacheKey !== `title:${lower}`) {
            this.setInMemoryCache(`title:${lower}`, null);
          }
          if (normKey && cacheKey !== `title:${normKey}`) {
            this.setInMemoryCache(`title:${normKey}`, null);
          }
          return null;
        };

        if (
          KNOWN_UNRATED_TITLES.has(lower) ||
          (Boolean(normKey) && KNOWN_UNRATED_TITLES.has(normKey)) ||
          NON_GAME_ADDON_OR_BETA_REGEX.test(title)
        ) {
          return retainExplicitUnrated();
        }

        if (!onlineLifecycleManager.isOnline()) {
          this.attemptedDynamicResolutions.delete(cacheKey);
          if (lower) this.attemptedDynamicResolutions.delete(`title:${lower}`);
          if (priorPositiveScore) {
            this.setInMemoryCache(cacheKey, priorPositiveScore);
            if (lower && cacheKey !== `title:${lower}`) {
              this.setInMemoryCache(`title:${lower}`, priorPositiveScore);
            }
            if (normKey && cacheKey !== `title:${normKey}`) {
              this.setInMemoryCache(`title:${normKey}`, priorPositiveScore);
            }
            return priorPositiveScore;
          }
          const current = this.inMemoryCache.get(cacheKey);
          if (current && isCandidateValid(current)) {
            return current;
          }
          return null;
        }

        let hadTransientError = false;

        const retainSyntheticOrNull = () => {
          if (priorPositiveScore) {
            if (priorPositiveScore.isSynthetic && onlineLifecycleManager.isOnline()) {
              this.cacheResult(cacheKey, priorPositiveScore, effectiveReleaseDate, enrichedGenres, {
                dynamicResolved: true,
                aliasTitle: title,
                hadTransientError,
                titleForValidation: title,
                steamAppIdForValidation: steamAppId,
              });
            }
            this.setInMemoryCache(cacheKey, priorPositiveScore);
            if (lower && cacheKey !== `title:${lower}`) {
              this.setInMemoryCache(`title:${lower}`, priorPositiveScore);
            }
            if (normKey && cacheKey !== `title:${normKey}`) {
              this.setInMemoryCache(`title:${normKey}`, priorPositiveScore);
            }
            return priorPositiveScore;
          }

          const current = this.inMemoryCache.get(cacheKey);
          if (current?.isSynthetic && isCandidateValid(current)) {
            if (onlineLifecycleManager.isOnline()) {
              this.cacheResult(cacheKey, current, effectiveReleaseDate, enrichedGenres, {
                dynamicResolved: true,
                aliasTitle: title,
                hadTransientError,
                titleForValidation: title,
                steamAppIdForValidation: steamAppId,
              });
            }
            if (lower && cacheKey !== `title:${lower}`) {
              this.setInMemoryCache(`title:${lower}`, current);
            }
            if (normKey && cacheKey !== `title:${normKey}`) {
              this.setInMemoryCache(`title:${normKey}`, current);
            }
            return current;
          }

          if (!onlineLifecycleManager.isOnline()) {
            this.attemptedDynamicResolutions.delete(cacheKey);
            if (lower) this.attemptedDynamicResolutions.delete(`title:${lower}`);
            return null;
          }

          if (hadTransientError) {
            const prevFailures = this.transientFailureCounts.get(cacheKey) || 0;
            const nextFailures = prevFailures + 1;
            this.transientFailureCounts.set(cacheKey, nextFailures);
            const TWO_HOURS_MS = 2 * 60 * 60 * 1000;
            const TWENTY_FOUR_HOURS_MS = 24 * 60 * 60 * 1000;
            const backoffTtlMs = Math.min(
              TWENTY_FOUR_HOURS_MS,
              TWO_HOURS_MS * Math.pow(2, nextFailures - 1)
            );
            const savedTransient = saveStagedCache<CriticScoreData>(
              stagedKey,
              null,
              'transient_error',
              {
                failureReason: 'network_error',
                dynamicResolved: true,
                customTtlMs: backoffTtlMs,
              }
            );
            if (lower && stagedKey !== `${STORAGE_PREFIX}title:${lower}`) {
              const titleStagedKey = `${STORAGE_PREFIX}title:${lower}`;
              const existingTitleStaged = loadStagedCache<CriticScoreData>(titleStagedKey, false);
              if (
                !existingTitleStaged.entry ||
                (existingTitleStaged.entry.tier !== MutabilityTier.TIER_0_USER_OVERRIDE &&
                  existingTitleStaged.entry.tier !== 'override')
              ) {
                const hasPositiveTitle =
                  existingTitleStaged.valid &&
                  existingTitleStaged.data &&
                  typeof existingTitleStaged.data.score === 'number' &&
                  existingTitleStaged.data.score > 0;
                if (!hasPositiveTitle) {
                  saveStagedCache<CriticScoreData>(titleStagedKey, null, 'transient_error', {
                    failureReason: 'network_error',
                    dynamicResolved: true,
                    cachedAt: savedTransient.cachedAt,
                    customTtlMs: backoffTtlMs,
                  });
                }
              }
            }
            return null;
          }

          this.transientFailureCounts.delete(cacheKey);
          this.cacheResult(cacheKey, null, effectiveReleaseDate, enrichedGenres, {
            dynamicResolved: true,
            aliasTitle: title,
            titleForValidation: title,
            steamAppIdForValidation: steamAppId,
          });
          if (lower && cacheKey !== `title:${lower}`) {
            this.setInMemoryCache(`title:${lower}`, null);
          }
          if (normKey && cacheKey !== `title:${normKey}`) {
            this.setInMemoryCache(`title:${normKey}`, null);
          }
          return null;
        };

        // Harvest storefront ground truth anchor if not passed in
        let anchor = storefrontAnchor;
        if (!anchor) {
          try {
            anchor = await storefrontReviewHarvester.getStorefrontAnchor({
              title,
              steamAppId,
              platforms: options?.platforms,
              id: options?.gameId,
            });
          } catch (anchorErr: unknown) {
            if (classifyNetworkError(anchorErr).status === 'transient_error') {
              hadTransientError = true;
            }
            anchor = null;
          }
        }

        const gogSlug = this.extractGogSlugFromContext(options?.platforms, anchor);
        const buildAnchorWithWikidataSlug = (
          baseAnchor: StorefrontReviewAnchor | null | undefined,
          mcSlug: string
        ): StorefrontReviewAnchor => ({
          ...(baseAnchor ?? { storefront: gogSlug ? 'gog' : 'steam' }),
          metacriticSlug: mcSlug,
          metacriticUrl:
            baseAnchor?.metacriticUrl ||
            `https://www.metacritic.com/game/${mcSlug}/critic-reviews/`,
          isVerifiedGroundTruth: true,
        });

        // Pre-check cached Wikidata links (populated by Stage 1 batch SPARQL pre-pass or prior lookups)
        let wdLinks = wikidataBridge.getCachedLinks({
          steamAppId,
          gogSlug,
          title: cleanTitle || title,
        });

        const broadcastUpdate = (
          data: CriticScoreData,
          verifiedAnchorSlug?: string | null
        ): CriticScoreData => {
          if (!isCandidateValid(data, verifiedAnchorSlug)) {
            return priorPositiveScore ?? data;
          }
          const userOverride = this.findMatchingUserOverride(
            steamAppId,
            title,
            options?.gameId,
            options?.platforms
          );
          if (userOverride && userOverride.reviewScoreOverride !== undefined) {
            return userOverride.reviewScoreOverride ?? data;
          }

          // Monotonic Source-Authority Lattice guard: never overwrite an existing non-expired,
          // semantically valid cached score with a lower-authority source.
          const incomingRank = getReviewSourceAuthorityRank(data);
          let highestExisting: CriticScoreData | null = null;
          let highestExistingRank = 0;

          const considerExisting = (cand: CriticScoreData | null | undefined) => {
            if (!cand || typeof cand.score !== 'number' || cand.score <= 0) return;
            if (!isCandidateValid(cand, verifiedAnchorSlug)) return;
            const rank = getReviewSourceAuthorityRank(cand);
            if (rank > highestExistingRank) {
              highestExistingRank = rank;
              highestExisting = cand;
            }
          };

          for (const pKey of priorKeys) {
            const existingStaged = loadStagedCache<CriticScoreData>(pKey, false);
            if (existingStaged.valid && existingStaged.data) {
              considerExisting(existingStaged.data);
            }
          }
          if (priorPositiveScore && (priorPositiveIsFresh || hadTransientError)) {
            considerExisting(priorPositiveScore);
          }
          const memCandidate = this.inMemoryCache.get(cacheKey);
          const stagedForMem = loadStagedCache<CriticScoreData>(stagedKey, false);
          if (memCandidate && !stagedForMem.stale) {
            considerExisting(memCandidate);
          }

          if (highestExisting && incomingRank < highestExistingRank) {
            this.setInMemoryCache(cacheKey, highestExisting);
            if (lower && cacheKey !== `title:${lower}`) {
              this.setInMemoryCache(`title:${lower}`, highestExisting);
            }
            if (normKey && cacheKey !== `title:${normKey}`) {
              this.setInMemoryCache(`title:${normKey}`, highestExisting);
            }
            return highestExisting;
          }

          this.transientFailureCounts.delete(cacheKey);
          const wrote = this.cacheResult(cacheKey, data, effectiveReleaseDate, enrichedGenres, {
            dynamicResolved: true,
            aliasTitle: title,
            hadTransientError,
            titleForValidation: title,
            steamAppIdForValidation: steamAppId,
          });
          if (!wrote && highestExisting) {
            return highestExisting;
          }
          if (lower && cacheKey !== `title:${lower}`) {
            this.setInMemoryCache(`title:${lower}`, data);
          }
          if (normKey && cacheKey !== `title:${normKey}`) {
            this.setInMemoryCache(`title:${normKey}`, data);
          }
          const baseKey = stripEditionSuffix(title);
          if (baseKey && baseKey !== normKey && cacheKey !== `title:${baseKey}`) {
            this.setInMemoryCache(`title:${baseKey}`, data);
          }
          if (options?.gameId) {
            this.scheduleVaultCriticWriteThrough(options.gameId, data, steamAppId, title);
          }
          if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
            window.dispatchEvent(
              new CustomEvent('antigravity_critic_updated', {
                detail: { cacheKey, title, steamAppId, data },
              })
            );
          }
          return data;
        };

        // ==========================================
        // TIER 1: Metacritic Live Composer / HTML Resolution
        // ==========================================
        const tier1Anchor =
          !anchor?.metacriticSlug && wdLinks?.metacriticSlug
            ? buildAnchorWithWikidataSlug(anchor, wdLinks.metacriticSlug)
            : anchor;
        let mcBundle: import('./metacriticResolver').MetacriticBundle | null = null;
        try {
          mcBundle = await metacriticResolver.resolveMetacritic(
            title,
            year,
            tier1Anchor,
            Priority.P1_VIEWPORT
          );
          if (metacriticResolver.hadRecentTransientFailure(title)) {
            hadTransientError = true;
          }
          if (
            mcBundle?.critic &&
            mcBundle.critic.isVerified &&
            mcBundle.critic.score > 0 &&
            isCandidateValid(mcBundle.critic, tier1Anchor?.metacriticSlug)
          ) {
            return broadcastUpdate(mcBundle.critic, tier1Anchor?.metacriticSlug);
          }
        } catch (mcErr: unknown) {
          if (classifyNetworkError(mcErr).status === 'transient_error') {
            hadTransientError = true;
          }
          console.warn(
            `[CriticScoreService] Metacritic check warning for "${title}":`,
            mcErr instanceof Error ? mcErr.message : String(mcErr)
          );
        }

        // Wikidata CC0 Bridge lookup when Tier 1 produced no critic score:
        // Discovers canonical P12054 Metacritic slug and/or P2864 OpenCritic ID.
        if (!wdLinks) {
          try {
            wdLinks = await wikidataBridge.resolveForGame({
              steamAppId,
              gogSlug,
              title: cleanTitle || title,
              releaseYear: year,
              priority: Priority.P1_VIEWPORT,
            });
            const wdFailKeys = [
              steamAppId ? `steam:${steamAppId}` : '',
              gogSlug ? `gog:${gogSlug}` : '',
              normKey ? `title:${normKey}` : '',
            ].filter(Boolean);
            if (wdFailKeys.some((k) => wikidataBridge.hadRecentTransientFailure(k))) {
              hadTransientError = true;
            }
          } catch (wdErr: unknown) {
            if (classifyNetworkError(wdErr).status === 'transient_error') {
              hadTransientError = true;
            }
          }
        }

        if (
          wdLinks?.metacriticSlug &&
          wdLinks.metacriticSlug !== tier1Anchor?.metacriticSlug
        ) {
          const wdMcAnchor = buildAnchorWithWikidataSlug(anchor, wdLinks.metacriticSlug);
          try {
            const wdMcBundle = await metacriticResolver.resolveMetacritic(
              cleanTitle || title,
              year,
              wdMcAnchor,
              Priority.P1_VIEWPORT
            );
            if (metacriticResolver.hadRecentTransientFailure(cleanTitle || title)) {
              hadTransientError = true;
            }
            if (
              wdMcBundle?.critic &&
              wdMcBundle.critic.isVerified &&
              wdMcBundle.critic.score > 0 &&
              isCandidateValid(wdMcBundle.critic, wdLinks.metacriticSlug)
            ) {
              return broadcastUpdate(wdMcBundle.critic, wdLinks.metacriticSlug);
            }
            if (!mcBundle?.user && wdMcBundle?.user) {
              mcBundle = wdMcBundle;
            }
          } catch (wdMcErr: unknown) {
            if (classifyNetworkError(wdMcErr).status === 'transient_error') {
              hadTransientError = true;
            }
          }
        }

        // Rule 1 Fallback: If Metacritic scrape failed or was blocked, but storefrontAnchor contains verified metacriticScore
        if (anchor?.metacriticScore !== undefined && typeof anchor.metacriticScore === 'number' && anchor.metacriticScore > 0) {
          const mcSlug =
            anchor.metacriticSlug ||
            cleanTitle.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
          if (isAnchorSlugCompatible(title, mcSlug)) {
            const mcUrl =
              anchor.metacriticUrl ||
              `https://www.metacritic.com/game/${mcSlug}/critic-reviews/`;
            const anchorMcResult: CriticScoreData = {
              id: `mc-${mcSlug}`,
              source: 'metacritic',
              score: anchor.metacriticScore,
              tier: calculateTier(anchor.metacriticScore),
              numReviews: 20,
              url: mcUrl,
              summary: `Verified by official ${anchor.storefront.toUpperCase()} store review anchor.`,
              isVerified: true,
              isSynthetic: false,
            };
            if (isCandidateValid(anchorMcResult, mcSlug)) {
              return broadcastUpdate(anchorMcResult, mcSlug);
            }
          }
        }

        // If we already have a verified OpenCritic score, and Metacritic didn't produce a Tier 1 score,
        // PRESERVE the verified OpenCritic score! DO NOT downgrade to Tier 3 user score or Tier 4 Steam!
        const existingPreSeeded =
          this.inMemoryCache.get(cacheKey) ||
          (steamAppId ? KNOWN_CRITIC_SCORES[steamAppId] : undefined) ||
          KNOWN_CRITIC_SCORES[title.toLowerCase()] ||
          (normKey ? KNOWN_CRITIC_SCORES[normKey] : undefined);

        if (existingPreSeeded?.isVerified && existingPreSeeded.source === 'opencritic' && isCandidateValid(existingPreSeeded)) {
          this.cacheResult(cacheKey, existingPreSeeded, effectiveReleaseDate, enrichedGenres, {
            dynamicResolved: true,
            aliasTitle: title,
            titleForValidation: title,
            steamAppIdForValidation: steamAppId,
          });
          if (lower && cacheKey !== `title:${lower}`) {
            this.setInMemoryCache(`title:${lower}`, existingPreSeeded);
          }
          if (normKey && cacheKey !== `title:${normKey}`) {
            this.setInMemoryCache(`title:${normKey}`, existingPreSeeded);
          }
          return existingPreSeeded;
        }

        // ==========================================
        // TIER 2: OpenCritic SSR Resolution (via Wikidata P2864 / Storefront Anchor)
        // ==========================================
        try {
          const resolvedOcId = anchor?.openCriticId ?? wdLinks?.openCriticId ?? null;
          const ocResult = await openCriticResolver.resolveForGame({
            title: cleanTitle || title,
            steamAppId,
            gogSlug,
            releaseYear: year,
            openCriticId: resolvedOcId,
            storefrontAnchor: anchor,
            priority: Priority.P1_VIEWPORT,
          });

          const ocTransient =
            openCriticResolver.hadRecentTransientFailure(cleanTitle || title) ||
            openCriticResolver.hadRecentTransientFailure(title) ||
            (steamAppId ? openCriticResolver.hadRecentTransientFailure(String(steamAppId)) : false) ||
            (resolvedOcId ? openCriticResolver.hadRecentTransientFailure(String(resolvedOcId)) : false);
          if (ocTransient) {
            hadTransientError = true;
          }

          if (ocResult && ocResult.score > 0) {
            const isVerifiedStorefrontOcAnchor = Boolean(
              !steamAppId &&
                anchor?.isVerifiedGroundTruth &&
                ocResult.summary?.includes('store review anchor')
            );
            const isDisallowedGogOcOnSteam = Boolean(
              steamAppId &&
                anchor?.storefront === 'gog' &&
                !anchor.openCriticId &&
                isUrlHostMatching(ocResult.url, 'gog.com')
            );
            if (!isDisallowedGogOcOnSteam && (isCandidateValid(ocResult) || isVerifiedStorefrontOcAnchor)) {
              return broadcastUpdate(ocResult);
            }
          }
        } catch (ocErr: unknown) {
          if (classifyNetworkError(ocErr).status === 'transient_error') {
            hadTransientError = true;
          }
          console.warn(
            `[CriticScoreService] OpenCritic check warning for "${title}":`,
            ocErr instanceof Error ? ocErr.message : String(ocErr)
          );
        }

        // ==========================================
        // TIER 3 & 4: Metacritic User Score & Steam Live Community Reviews
        // Sample-Size Weighting: High-sample verified Steam consensus beats tiny (<25) Metacritic user ratings
        // ==========================================
        if (mcBundle?.user && mcBundle.user.score > 0 && isCandidateValid(mcBundle.user)) {
          const mcUserCount = mcBundle.user.numReviews || 0;
          if (mcUserCount >= 25 || !steamAppId) {
            return broadcastUpdate(mcBundle.user);
          }

          try {
            const steamResult = await steamReviewResolver.resolveScore(title, steamAppId);
            if (
              steamResult &&
              steamResult.score > 0 &&
              isCandidateValid(steamResult) &&
              (steamResult.numReviews || 0) >= Math.max(100, mcUserCount * 5)
            ) {
              return broadcastUpdate(steamResult);
            }
          } catch (steamErr: unknown) {
            console.warn(
              `[CriticScoreService] Steam live reviews check warning for "${title}":`,
              steamErr instanceof Error ? steamErr.message : String(steamErr)
            );
          }

          return broadcastUpdate(mcBundle.user);
        }

        // ==========================================
        // TIER 4: Steam Live Community Reviews Resolver
        // ==========================================
        try {
          const steamResult = await steamReviewResolver.resolveScore(title, steamAppId);
          if (steamReviewResolver.hadTransientError(title, steamAppId)) {
            hadTransientError = true;
          }
          if (steamResult && steamResult.isSynthetic && steamResult.score > 0 && isCandidateValid(steamResult)) {
            return broadcastUpdate(steamResult);
          }
        } catch (steamErr: unknown) {
          if (classifyNetworkError(steamErr).status === 'transient_error') {
            hadTransientError = true;
          }
          console.warn(
            `[CriticScoreService] Steam live reviews check warning for "${title}":`,
            steamErr instanceof Error ? steamErr.message : String(steamErr)
          );
        }

        // ==========================================
        // TIER 5: Storefront Star Rating (GOG / Epic / Xbox, >= 4 reviews)
        // ==========================================
        try {
          const xboxPlat = options?.platforms?.find((p) => p.platformId === 'xbox') as
            | { platformId: string; platformGameId?: string; xboxProductId?: string }
            | undefined;
          const xboxProductId =
            xboxPlat?.xboxProductId ||
            (/^[A-Z0-9]{12}$/i.test(String(xboxPlat?.platformGameId || ''))
              ? xboxPlat?.platformGameId
              : undefined);
          const storefrontResult = await storefrontStarResolver.resolveStorefrontScore(
            xboxProductId ? { title, xboxProductId } : title
          );
          if (storefrontStarResolver.hadRecentTransientFailure(title)) {
            hadTransientError = true;
          }
          if (storefrontResult && storefrontResult.score > 0 && isCandidateValid(storefrontResult)) {
            return broadcastUpdate(storefrontResult);
          }
        } catch (sfErr: unknown) {
          if (classifyNetworkError(sfErr).status === 'transient_error') {
            hadTransientError = true;
          }
          console.warn(
            `[CriticScoreService] Storefront star check warning for "${title}":`,
            sfErr instanceof Error ? sfErr.message : String(sfErr)
          );
        }

        // ==========================================
        // TIER 6: Truly Unrated
        // ==========================================
        return retainSyntheticOrNull();
      } catch {
        return this.inMemoryCache.get(cacheKey) ?? null;
      } finally {
        this.inFlightResolutions.delete(cacheKey);
      }
    })();

    this.inFlightResolutions.set(cacheKey, promise);
    return promise;
  }

  private cacheResult(
    key: string,
    data: CriticScoreData | null,
    releaseDate?: string | Date | number | null,
    genres?: string[] | string | null,
    options?: {
      dynamicResolved?: boolean;
      allowOverwritePositive?: boolean;
      allowAuthorityDowngrade?: boolean;
      aliasTitle?: string;
      customTtlMs?: number;
      cachedAt?: number;
      hadTransientError?: boolean;
      titleForValidation?: string;
      steamAppIdForValidation?: number | null;
    }
  ): boolean {
    const stagedKey = key.startsWith(STORAGE_PREFIX) ? key : `${STORAGE_PREFIX}${key}`;
    const existingStaged = loadStagedCache<CriticScoreData>(stagedKey, false);
    if (
      existingStaged.entry &&
      (existingStaged.entry.tier === MutabilityTier.TIER_0_USER_OVERRIDE || existingStaged.entry.tier === 'override')
    ) {
      return false;
    }
    const rawKey = key.startsWith(STORAGE_PREFIX) ? key.slice(STORAGE_PREFIX.length) : key;
    const validationTitle =
      options?.titleForValidation ||
      options?.aliasTitle ||
      (rawKey.startsWith('title:') ? rawKey.slice(6) : '');
    const validationSteamId =
      options?.steamAppIdForValidation ??
      (rawKey.startsWith('id:') ? Number(rawKey.slice(3)) || null : null);

    const isExistingEntryProtected = (
      existing: ReturnType<typeof loadStagedCache<CriticScoreData>>,
      incoming: CriticScoreData | null
    ): boolean => {
      if (options?.allowAuthorityDowngrade) return false;
      if (!existing.valid || !existing.data || typeof existing.data.score !== 'number' || existing.data.score <= 0) {
        return false;
      }
      if (
        validationTitle &&
        !this.validateScoreSemanticCompatibility(validationTitle, existing.data, validationSteamId)
      ) {
        return false;
      }
      const existingRank = getReviewSourceAuthorityRank(existing.data);
      const incomingRank = getReviewSourceAuthorityRank(incoming);
      return incomingRank < existingRank;
    };

    if (data && typeof data.score === 'number' && data.score > 0) {
      if (isExistingEntryProtected(existingStaged, data)) {
        if (existingStaged.data) {
          this.setInMemoryCache(rawKey, existingStaged.data);
        }
        return false;
      }

      this.setInMemoryCache(rawKey, data);
      const overrideMeta = data as CriticScoreData & { isUserOverride?: boolean };
      const isOverrideScore = Boolean(
        overrideMeta.isUserOverride || (data.tier as string) === 'override'
      );
      let tier = determineGameMutabilityTier({
        releaseDate,
        genres,
        isOverride: isOverrideScore,
      });

      const isVerifiedPressCritic =
        data.isVerified === true && (data.source === 'metacritic' || data.source === 'opencritic');
      let effectiveCustomTtlMs = options?.customTtlMs;

      if (tier !== MutabilityTier.TIER_0_USER_OVERRIDE && !isVerifiedPressCritic) {
        const baseTtl = effectiveCustomTtlMs ?? TIER_TTLS[tier] ?? TIER_TTLS.mature;
        if (options?.hadTransientError) {
          tier = MutabilityTier.TIER_3_FRESH;
          effectiveCustomTtlMs = Math.min(baseTtl, MAX_TRANSIENT_FALLBACK_TTL_MS);
        } else {
          effectiveCustomTtlMs = Math.min(baseTtl, MAX_NON_CRITIC_TTL_MS);
          if (tier === MutabilityTier.TIER_1_IMMUTABLE) {
            tier = MutabilityTier.TIER_2_MATURE;
          }
        }
      }

      const savedEntry = saveStagedCache<CriticScoreData>(stagedKey, data, tier, {
        source: data.source,
        isVerified: data.isVerified,
        dynamicResolved: options?.dynamicResolved,
        customTtlMs: effectiveCustomTtlMs,
        cachedAt: options?.cachedAt,
      });
      if (options?.dynamicResolved && rawKey.startsWith('id:') && options?.aliasTitle) {
        const lowerAlias = options.aliasTitle.trim().toLowerCase();
        if (lowerAlias) {
          const titleStagedKey = `${STORAGE_PREFIX}title:${lowerAlias}`;
          const existingTitleStaged = loadStagedCache<CriticScoreData>(titleStagedKey, false);
          const isTitleTier0 = Boolean(
            existingTitleStaged.entry &&
              (existingTitleStaged.entry.tier === MutabilityTier.TIER_0_USER_OVERRIDE ||
                existingTitleStaged.entry.tier === 'override')
          );
          if (!isTitleTier0 && !isExistingEntryProtected(existingTitleStaged, data)) {
            this.setInMemoryCache(`title:${lowerAlias}`, data);
            saveStagedCache<CriticScoreData>(titleStagedKey, data, tier, {
              source: data.source,
              isVerified: data.isVerified,
              dynamicResolved: true,
              cachedAt: savedEntry.cachedAt,
              customTtlMs: savedEntry.ttlMs,
            });
          }
        }
      }
      if (rawKey.startsWith('title:')) {
        const normKey = normalizeCriticTitleKey(rawKey.slice(6));
        if (normKey) {
          const normStagedKey = `${STORAGE_PREFIX}title:${normKey}`;
          if (normStagedKey !== stagedKey) {
            const existingNorm = this.inMemoryCache.get(`title:${normKey}`);
            if (
              !existingNorm ||
              getReviewSourceAuthorityRank(data) >= getReviewSourceAuthorityRank(existingNorm)
            ) {
              this.setInMemoryCache(`title:${normKey}`, data);
            }
          }
        }
      }
      return true;
    } else {
      if (
        isExistingEntryProtected(existingStaged, null) ||
        (!options?.allowOverwritePositive &&
          existingStaged.data &&
          typeof existingStaged.data.score === 'number' &&
          existingStaged.data.score > 0)
      ) {
        if (existingStaged.data) {
          this.setInMemoryCache(rawKey, existingStaged.data);
        }
        return false;
      }
      if (!onlineLifecycleManager.isOnline() && !options?.allowOverwritePositive) {
        return false;
      }
      this.setInMemoryCache(rawKey, null);
      const savedNeg = saveStagedCache<CriticScoreData>(stagedKey, null, 'negative', {
        failureReason: 'not_found',
        dynamicResolved: options?.dynamicResolved,
        customTtlMs: options?.customTtlMs,
        cachedAt: options?.cachedAt,
      });
      if (options?.dynamicResolved && rawKey.startsWith('id:') && options?.aliasTitle) {
        const lowerAlias = options.aliasTitle.trim().toLowerCase();
        if (lowerAlias) {
          const titleStagedKey = `${STORAGE_PREFIX}title:${lowerAlias}`;
          const existingTitleStaged = loadStagedCache<CriticScoreData>(titleStagedKey, false);
          if (
            !existingTitleStaged.entry ||
            (existingTitleStaged.entry.tier !== MutabilityTier.TIER_0_USER_OVERRIDE &&
              existingTitleStaged.entry.tier !== 'override')
          ) {
            const hasPositiveTitle =
              isExistingEntryProtected(existingTitleStaged, null) ||
              (!options?.allowOverwritePositive &&
                existingTitleStaged.data &&
                typeof existingTitleStaged.data.score === 'number' &&
                existingTitleStaged.data.score > 0);
            if (!hasPositiveTitle) {
              this.setInMemoryCache(`title:${lowerAlias}`, null);
              saveStagedCache<CriticScoreData>(titleStagedKey, null, 'negative', {
                failureReason: 'not_found',
                dynamicResolved: true,
                cachedAt: savedNeg.cachedAt,
                customTtlMs: savedNeg.ttlMs,
              });
            }
          }
        }
      }
      return true;
    }
  }
}

export const criticScoreService = new CriticScoreService();

/**
 * Backward compatibility function for existing components.
 */
export function getOpenCriticData(
  steamAppId?: number | null,
  title?: string,
  steamPositivePercent?: number,
  releaseYear?: number | string | null,
  storefrontAnchor?: StorefrontReviewAnchor | null,
  bypassTTL: boolean = false,
  skipBackgroundTrigger: boolean = false,
  context?: CriticScoreContext
): OpenCriticData | null {
  return criticScoreService.getCriticScore(
    steamAppId,
    title,
    steamPositivePercent,
    releaseYear,
    storefrontAnchor,
    bypassTTL,
    skipBackgroundTrigger,
    context
  );
}
