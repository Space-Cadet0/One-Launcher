import { CriticScoreData, OpenCriticData, StorefrontReviewAnchor } from '../../contracts/critic';
import type { CanonicalGame } from '../../contracts/game';
import type { ReviewScoreRoute, UserGameOverride } from '../../contracts/override';
import { extractParentheticalReleaseYear } from '../common/titleUtils';
import { onlineLifecycleManager } from '../network/onlineLifecycleManager';
import {
  MutabilityTier,
  TIER_TTLS,
  clearExpiredStagedCache,
  determineGameMutabilityTier,
  evictStagedCache,
  isCacheEntryValid,
  isStagedVaultHydrationComplete,
  loadStagedCache,
  saveStagedCache,
} from '../storage/stagedCacheService';
import {
  inferReviewRouteFromOverride,
  patchUserOverrideReviewScore,
} from '../storage/userOverrideStorage';
import {
  calculateSyntheticSteamScore,
  calculateTier,
  getReviewSourceAuthorityRank,
  getReviewSourceDisplayMeta,
  getTierColor,
  isSequelMismatch,
  normalizeCriticTitleKey,
  stripEditionSuffix,
} from './criticUtils';
import { KNOWN_CRITIC_SCORES, KNOWN_UNRATED_TITLES } from './knownCriticScores';
import { metacriticResolver } from './metacriticResolver';
import { openCriticResolver } from './openCriticResolver';
import { steamReviewResolver } from './steamReviewResolver';
import { storefrontReviewHarvester } from './storefrontReviewHarvester';
import { storefrontStarResolver } from './storefrontStarResolver';
import { wikidataBridge } from './wikidataBridge';
import {
  collectGameEvictionTargets,
  purgeAllCriticKeysFromStorage,
  purgeLegacyCriticKeysFromStorage,
  purgeNegativeCriticKeysFromStorage,
} from './core/criticCacheEviction';
import {
  type DynamicCascadeOptions,
  runDynamicCriticCascade,
} from './core/criticDynamicCascade';
import {
  extractValidGameOverrideFromEventDetail,
  findMatchingUserOverrideWithMemo,
  resolveRoutedCriticScore,
} from './core/criticOverrideBridge';
import {
  type CriticMigrationCallbacks,
  createEmptyMigrationCatalogMaps,
  finalizeSchemaV16Migration,
  isLegacyCriticStorageKey,
  populateCatalogMapsForMigration,
  runSchemaV16MigrationSync,
  shouldEvictV8KeyDuringMigration,
} from './core/criticSchemaMigration';
import { validateScoreSemanticCompatibilityWithMemo } from './core/criticSemanticValidator';
import {
  CRITIC_SCHEMA_V16_KEY,
  type CompiledReviewOverrideIndex,
  type CriticEntitlementPlatform,
  type CriticScoreContext,
  LAZY_MIGRATION_CHUNK_SIZE,
  MAX_NON_CRITIC_TTL_MS,
  MAX_TRANSIENT_FALLBACK_TTL_MS,
  type MigrationV8Record,
  NON_GAME_ADDON_OR_BETA_REGEX,
  NON_OVERRIDE_EVENT_TYPES,
  PREV_STORAGE_PREFIX,
  STEAM_ENRICHED_CRITIC_MAP,
  STORAGE_PREFIX,
  hasAnyKnownCriticScore,
  hasAnySteamEnrichedCriticEntry,
} from './core/criticServiceTypes';
import { CriticVaultWriteThroughQueue } from './core/criticVaultWriteThrough';

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
export type { CriticEntitlementPlatform, CriticScoreContext };

/**
 * Unified Critic Score Service with Cascading Live Multi-Tier Resolution:
 * 1. Instant Memory Cache & Master Dataset (0ms, zero sync `localStorage` on warm hits).
 * 2. Tier 1: Metacritic Live Critic Metascore (verified press consensus, >= 4 reviews).
 * 3. Tier 2: OpenCritic Live SSR (verified press consensus, >= 4 reviews).
 * 4. Tier 3: Metacritic Live User Score (authentic player sentiment, >= 4 user reviews).
 * 5. Tier 4: Steam Live Community Reviews (authentic player sentiment, >= 10 reviews).
 * 6. Tier 5: Storefront Star Rating (GOG/Epic/Xbox 5-star rating converted to 0-100, >= 4 reviews).
 * 7. Tier 6: Null / Truly Unrated (betas, dev tools, internal playtests).
 */
export class CriticScoreService {
  public static readonly MAX_IN_MEMORY_CACHE_SIZE = 4096;
  public static readonly EVICT_TARGET_CACHE_SIZE = 3500;
  private inMemoryCache = new Map<string, CriticScoreData | null>();
  private tier0OverrideKeys = new Set<string>();
  private semanticValidationMemo = new WeakMap<CriticScoreData, Map<string, boolean>>();
  private compiledOverrideIndexMemo = new WeakMap<object, CompiledReviewOverrideIndex>();
  private inFlightResolutions = new Map<string, Promise<CriticScoreData | null>>();
  private pendingPassiveTriggers = new Map<string, Promise<CriticScoreData | null>>();
  private attemptedDynamicResolutions = new Set<string>();
  private stubPinnedKeys = new Set<string>();
  private transientFailureCounts = new Map<string, number>();
  private pendingStorageTasks = new Map<string, () => void>();
  private vaultWriteThrough = new CriticVaultWriteThroughQueue();
  private storageFlushScheduled = false;
  private isPassiveRenderTrigger = false;
  private lazyMigrationTimer: ReturnType<typeof setTimeout> | null = null;
  private listenersInitialized = false;
  private listenerCleanups: Array<() => void> = [];
  private storageHydrated = false;
  private cacheEpoch = 0;
  private keyEpochs = new Map<string, number>();

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
        this.tier0OverrideKeys.delete(oldestKey);
      }
    }
  }

  private isEpochCurrent(
    capturedEpoch: number,
    key: string,
    capturedKeyEpoch: number
  ): boolean {
    return (
      capturedEpoch === this.cacheEpoch &&
      (this.keyEpochs.get(key) ?? 0) === capturedKeyEpoch
    );
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

  private buildMigrationCallbacks(): CriticMigrationCallbacks {
    return {
      validateSemantic: (title, scoreData, steamAppId) =>
        this.validateScoreSemanticCompatibility(title, scoreData, steamAppId),
      findMatchingOverride: (steamAppId, title) =>
        this.findMatchingUserOverride(steamAppId, title),
      onEvictRawKey: (rawKey) => {
        this.keyEpochs.set(rawKey, (this.keyEpochs.get(rawKey) ?? 0) + 1);
        this.inMemoryCache.delete(rawKey);
        this.tier0OverrideKeys.delete(rawKey);
        this.attemptedDynamicResolutions.delete(rawKey);
      },
      onPromoteRawKey: (rawKey, data, gameId, steamAppId, effectiveTitle) => {
        this.setInMemoryCache(rawKey, data);
        this.attemptedDynamicResolutions.delete(rawKey);
        if (gameId) {
          this.vaultWriteThrough.schedule(gameId, data, steamAppId, effectiveTitle);
        }
      },
    };
  }

  constructor() {
    this.initEventListeners();
  }

  private ensureHydrated(): void {
    if (this.storageHydrated) return;
    this.storageHydrated = true;
    if (typeof localStorage === 'undefined') return;
    try {
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
        const legacyKeys: string[] = [];
        const v8Keys: string[] = [];
        for (let i = 0; i < totalKeys; i++) {
          const key = localStorage.key(i);
          if (!key) continue;
          if (isLegacyCriticStorageKey(key)) {
            legacyKeys.push(key);
          } else if (key.startsWith(STORAGE_PREFIX)) {
            v8Keys.push(key);
          }
        }

        const maps = createEmptyMigrationCatalogMaps();
        if (v8Keys.length > 0) {
          populateCatalogMapsForMigration(maps);
        }

        const callbacks = this.buildMigrationCallbacks();
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
              if (shouldEvictV8KeyDuringMigration(key, maps, siblingGroups, callbacks)) {
                v8Remove.push(key);
              }
            }
            if (legacyIdx < legacyKeys.length || v8Idx < v8Keys.length) {
              scheduleChunk(runNextChunk);
              return;
            }
            finalizeSchemaV16Migration(v8Remove, siblingGroups, maps, callbacks, {
              clearExpiredStaged: true,
            });
          } catch {}
        };

        runNextChunk();
      } catch {}
    });
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
    const targets = collectGameEvictionTargets(gameId, title, steamAppId, extra);

    for (const key of targets.keysToEvict) {
      this.keyEpochs.set(key, (this.keyEpochs.get(key) ?? 0) + 1);
      this.inMemoryCache.delete(key);
      this.tier0OverrideKeys.delete(key);
      this.attemptedDynamicResolutions.delete(key);
      this.inFlightResolutions.delete(key);
      this.pendingPassiveTriggers.delete(key);
      this.stubPinnedKeys.delete(key);
      this.transientFailureCounts.delete(key);
      this.vaultWriteThrough.delete(key);
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
    if (gameId) this.vaultWriteThrough.delete(gameId);
    if (extra?.oldOverride?.gameId) this.vaultWriteThrough.delete(extra.oldOverride.gameId);
    if (extra?.oldGame?.id) this.vaultWriteThrough.delete(extra.oldGame.id);
    if (Array.isArray(extra?.deletedKeys)) {
      for (const dk of extra.deletedKeys) {
        if (dk) this.vaultWriteThrough.delete(dk);
      }
    }

    for (const t of targets.titlesToEvict) {
      metacriticResolver.evictForGame(t);
      steamReviewResolver.evictForGame(t, null);
      storefrontStarResolver.evictForGame(t, null);
      storefrontReviewHarvester.evictForGame({ gameId, title: t, platforms: extra?.platforms });
      wikidataBridge.evictForGame({ title: t });
    }
    for (const sid of targets.steamIdsToEvict) {
      steamReviewResolver.evictForGame(null, sid);
      storefrontReviewHarvester.evictForGame({ gameId, steamAppId: sid, platforms: extra?.platforms });
      wikidataBridge.evictForGame({ steamAppId: sid });
    }
    for (const gslug of targets.gogSlugsToEvict) {
      wikidataBridge.evictForGame({ gogSlug: gslug });
    }
    for (const ocId of targets.openCriticIdsToEvict) {
      openCriticResolver.evictId(ocId);
    }
    if (gameId || (extra?.platforms && extra.platforms.length > 0)) {
      storefrontReviewHarvester.evictForGame({ gameId, title, steamAppId, platforms: extra?.platforms });
    }
    for (const xid of targets.xboxIdsToEvict) {
      storefrontStarResolver.evictForGame(null, xid);
    }
  }

  public initEventListeners(): void {
    if (this.listenersInitialized) return;
    if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
      const onOverrideUpdated = ((e: CustomEvent) => {
        if (
          e.detail &&
          typeof e.detail === 'object' &&
          (e.detail as { hydratedFromVault?: boolean }).hydratedFromVault
        ) {
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

          const vaultGameId = (gameId || oldOverride?.gameId || oldGame?.id || '').trim();
          if (
            vaultGameId &&
            typeof window !== 'undefined' &&
            typeof window.electronAPI?.offlineVault?.saveGameDetail === 'function'
          ) {
            this.vaultWriteThrough.delete(vaultGameId);
            try {
              void window.electronAPI.offlineVault
                .saveGameDetail({
                  gameId: vaultGameId,
                  clearCriticScore: true,
                })
                ?.catch?.(() => {});
            } catch {}
          }

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
          if (v === null && !this.tier0OverrideKeys.has(k)) {
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
    this.vaultWriteThrough.clear();
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

    const vaultGameId = (override.gameId || oldGame?.id || '').trim();
    const targetTitle = (override.title || oldGame?.title || '').trim();
    const targetSteamId =
      typeof override.steamAppId === 'number' && override.steamAppId > 0
        ? override.steamAppId
        : undefined;
    const cacheKey = targetSteamId ? `id:${targetSteamId}` : `title:${targetTitle.toLowerCase()}`;
    const stagedKey = `${STORAGE_PREFIX}${cacheKey}`;

    const persistOverrideCriticToVault = (
      mode: 'clear' | 'write',
      scoreData?: CriticScoreData | null
    ) => {
      if (
        !vaultGameId ||
        typeof window === 'undefined' ||
        typeof window.electronAPI?.offlineVault?.saveGameDetail !== 'function'
      ) {
        return;
      }
      this.vaultWriteThrough.delete(vaultGameId);
      try {
        if (mode === 'clear') {
          void window.electronAPI.offlineVault
            .saveGameDetail({
              gameId: vaultGameId,
              ...(targetSteamId ? { steamAppId: targetSteamId } : {}),
              ...(targetTitle ? { canonicalTitle: targetTitle } : {}),
              clearCriticScore: true,
            })
            ?.catch?.(() => {});
        } else if (scoreData && typeof scoreData.score === 'number' && scoreData.score > 0) {
          void window.electronAPI.offlineVault
            .saveGameDetail({
              gameId: vaultGameId,
              ...(targetSteamId ? { steamAppId: targetSteamId } : {}),
              ...(targetTitle ? { canonicalTitle: targetTitle } : {}),
              criticScore: { ...scoreData },
              forceCriticScore: true,
            })
            ?.catch?.(() => {});
        }
      } catch {}
    };

    const route = inferReviewRouteFromOverride(override);
    if (route) {
      const keysToSet = new Set<string>();
      if (cacheKey) keysToSet.add(cacheKey);
      if (targetTitle) keysToSet.add(`title:${targetTitle.toLowerCase()}`);

      if (route.mode === 'unrated') {
        this.setInMemoryCache(cacheKey, null);
        this.tier0OverrideKeys.add(cacheKey);
        saveStagedCache<CriticScoreData>(stagedKey, null, MutabilityTier.TIER_0_USER_OVERRIDE);
        for (const k of keysToSet) {
          if (k !== cacheKey) {
            this.setInMemoryCache(k, null);
            this.tier0OverrideKeys.add(k);
          }
        }
        persistOverrideCriticToVault('clear');
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
        this.tier0OverrideKeys.add(cacheKey);
        saveStagedCache<CriticScoreData>(stagedKey, staticData, MutabilityTier.TIER_0_USER_OVERRIDE);
        for (const k of keysToSet) {
          if (k !== cacheKey) {
            this.setInMemoryCache(k, staticData);
            this.tier0OverrideKeys.add(k);
          }
        }
        if (staticData && typeof staticData.score === 'number' && staticData.score > 0) {
          persistOverrideCriticToVault('write', staticData);
        } else {
          persistOverrideCriticToVault('clear');
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
        persistOverrideCriticToVault('write', override.reviewScoreOverride);
        if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
          window.dispatchEvent(
            new CustomEvent('antigravity_critic_updated', {
              detail: {
                cacheKey,
                title: targetTitle,
                steamAppId: targetSteamId,
                data: override.reviewScoreOverride,
              },
            })
          );
        }
        return;
      }

      if (route.mode === 'routed') {
        persistOverrideCriticToVault('clear');
      }
    }

    if (targetTitle) {
      this.resolveDynamicScore(targetTitle, targetSteamId, undefined, override.storefrontAnchor).catch(
        () => {}
      );
    }
  }

  public async resolveRoutedScore(
    route: ReviewScoreRoute,
    fallbackTitle: string,
    releaseYear?: number | string | null,
    fallbackScore?: CriticScoreData | null
  ): Promise<CriticScoreData | null> {
    return resolveRoutedCriticScore(route, fallbackTitle, releaseYear, fallbackScore);
  }

  public findMatchingUserOverride(
    steamAppId?: number | null,
    title?: string,
    gameId?: string,
    platforms?: CriticEntitlementPlatform[]
  ): UserGameOverride | undefined {
    return findMatchingUserOverrideWithMemo(
      this.compiledOverrideIndexMemo,
      steamAppId,
      title,
      gameId,
      platforms
    );
  }

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

  private validateScoreSemanticCompatibility(
    rawTitle: string,
    scoreData: CriticScoreData | null | undefined,
    steamAppId?: number | null,
    verifiedAnchorSlug?: string | null
  ): boolean {
    return validateScoreSemanticCompatibilityWithMemo(
      this.semanticValidationMemo,
      rawTitle,
      scoreData,
      steamAppId,
      verifiedAnchorSlug
    );
  }

  public purgeLegacyScores(): void {
    this.storageHydrated = true;
    clearExpiredStagedCache({ onlyNegativeAndTransient: true });
    purgeLegacyCriticKeysFromStorage();
  }

  public purgeAllScoreCache(): void {
    this.storageHydrated = true;
    this.cacheEpoch += 1;
    this.keyEpochs.clear();
    this.cancelLazyMigrationTimer();
    this.vaultWriteThrough.clear();
    this.pendingStorageTasks.clear();
    this.inMemoryCache.clear();
    this.tier0OverrideKeys.clear();
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
    purgeAllCriticKeysFromStorage();
  }

  public purgeStaleNullScores(): void {
    this.storageHydrated = true;
    this.cancelLazyMigrationTimer();
    if (typeof localStorage === 'undefined') return;
    try {
      const schemaUpgraded = localStorage.getItem(CRITIC_SCHEMA_V16_KEY) === '1';
      if (!schemaUpgraded) {
        runSchemaV16MigrationSync(this.buildMigrationCallbacks());
      }

      if (!onlineLifecycleManager.isOnline()) {
        return;
      }

      const keysToRemove: string[] = [];
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (key && (key.startsWith(STORAGE_PREFIX) || isLegacyCriticStorageKey(key))) {
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
          this.tier0OverrideKeys.delete(rawKey);
          this.attemptedDynamicResolutions.delete(rawKey);
        }
      }
      if (!schemaUpgraded && keysToRemove.length > 0) {
        this.inMemoryCache.clear();
        this.tier0OverrideKeys.clear();
        this.attemptedDynamicResolutions.clear();
      }
    } catch {}
  }

  clearCache(): void {
    this.cacheEpoch += 1;
    this.keyEpochs.clear();
    this.cancelLazyMigrationTimer();
    this.vaultWriteThrough.clear();
    this.pendingStorageTasks.clear();
    this.inMemoryCache.clear();
    this.tier0OverrideKeys.clear();
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

  public prepareForIncrementalRefresh(): void {
    this.attemptedDynamicResolutions.clear();
    this.transientFailureCounts.clear();
    this.stubPinnedKeys.clear();
    for (const [key, value] of this.inMemoryCache.entries()) {
      if (value === null && !this.tier0OverrideKeys.has(key)) {
        this.keyEpochs.set(key, (this.keyEpochs.get(key) ?? 0) + 1);
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
    purgeNegativeCriticKeysFromStorage();
  }

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
    if (
      userOverride &&
      (userOverride.reviewScoreOverride !== undefined || userOverride.reviewRoute !== undefined)
    ) {
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
   * Retrieves verified critic consensus data for a game, checking in-memory cache + Tier-0
   * memory state BEFORE touching synchronous `localStorage.getItem` (`P0-11`), while deferring
   * storage writes and dynamic resolution onto a deduplicated microtask scheduler (H7).
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
        cachedAposStripped =
          lowerTitle.includes("'") || /[’ʼ`]/.test(lowerTitle)
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
          this.resolveDynamicScore(resolveTitle, resolveSteamId, resolveYear, resolveAnchor).catch(
            () => {}
          );
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
    if (
      userOverride &&
      (userOverride.reviewScoreOverride !== undefined || userOverride.reviewRoute !== undefined)
    ) {
      const route = inferReviewRouteFromOverride(userOverride);
      if (route?.mode === 'unrated') {
        this.attemptedDynamicResolutions.add(cacheKey);
        if (lowerTitle) this.attemptedDynamicResolutions.add(`title:${lowerTitle}`);
        this.setInMemoryCache(cacheKey, null);
        this.tier0OverrideKeys.add(cacheKey);
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
        this.tier0OverrideKeys.add(cacheKey);
        this.scheduleDeferredStorageTask(`save:${stagedKey}`, () => {
          saveStagedCache<CriticScoreData>(
            stagedKey,
            staticScore,
            MutabilityTier.TIER_0_USER_OVERRIDE
          );
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

    // 0a. Fast in-memory Tier-0 override hit (ZERO synchronous localStorage reads!)
    if (this.tier0OverrideKeys.has(cacheKey) && this.inMemoryCache.has(cacheKey)) {
      this.attemptedDynamicResolutions.add(cacheKey);
      if (lowerTitle) this.attemptedDynamicResolutions.add(`title:${lowerTitle}`);
      return this.inMemoryCache.get(cacheKey) ?? null;
    }

    let year = releaseYear;
    let enrichedReleaseDate: string | undefined;
    let enrichedGenres: string[] | undefined;
    if (steamAppId && hasAnySteamEnrichedCriticEntry()) {
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

    // 1. P0-11: Check in-memory cache BEFORE any synchronous `loadStagedCache` / `localStorage.getItem`!
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

    // 0b. Cold-miss Tier 0 staged override check (only reached on inMemoryCache miss or bypassTTL)
    const stagedTier0 = loadStagedCache<CriticScoreData>(stagedKey, false);
    if (
      stagedTier0.entry &&
      (stagedTier0.entry.tier === MutabilityTier.TIER_0_USER_OVERRIDE ||
        stagedTier0.entry.tier === 'override')
    ) {
      this.attemptedDynamicResolutions.add(cacheKey);
      if (lowerTitle) this.attemptedDynamicResolutions.add(`title:${lowerTitle}`);
      this.tier0OverrideKeys.add(cacheKey);
      if (stagedTier0.entry.data === null) {
        this.setInMemoryCache(cacheKey, null);
        return null;
      }
      if (stagedTier0.entry.data) {
        this.setInMemoryCache(cacheKey, stagedTier0.entry.data);
        return stagedTier0.entry.data;
      }
    }

    // 2. Direct lookup in master verified dataset (O(1) short-circuit when empty)
    let verifiedMatch: CriticScoreData | undefined;
    if (!isNonGameAddonOrBeta && hasAnyKnownCriticScore()) {
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
      const existingStaged = !bypassTTL
        ? stagedTier0
        : loadStagedCache<CriticScoreData>(stagedKey, bypassTTL);
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

    let bestStagedRank = staged.entry && staged.data ? getReviewSourceAuthorityRank(staged.data) : 0;
    let promotedFromSibling = false;

    const considerSiblingStagedKey = (fallbackKey: string) => {
      const altStaged = loadStagedCache<CriticScoreData>(fallbackKey, bypassTTL);
      if (!altStaged.entry) return;
      if (altStaged.data && !isScoreSemanticallyCompatible(altStaged.data)) {
        this.scheduleDeferredStorageTask(`evict:${fallbackKey}`, () => {
          evictStagedCache(fallbackKey);
        });
        return;
      }
      if (altStaged.data) {
        const altRank = getReviewSourceAuthorityRank(altStaged.data);
        const canPromoteOverPrimary =
          !staged.entry ||
          staged.entry.data === null ||
          altRank > bestStagedRank ||
          (altRank === bestStagedRank && altStaged.valid && !staged.valid);
        if (canPromoteOverPrimary) {
          staged = altStaged;
          bestStagedRank = altRank;
          promotedFromSibling = true;
        }
      } else if (altStaged.entry.data === null && !staged.entry) {
        staged = altStaged;
        bestStagedRank = 0;
      }
    };

    if (bestStagedRank < 3) {
      const siblingStagedKeys: string[] = [];
      if (lowerTitle && cacheKey !== `title:${lowerTitle}`) {
        siblingStagedKeys.push(`${STORAGE_PREFIX}title:${lowerTitle}`);
      }
      const aposStrippedTitle = getAposStrippedTitle();
      if (
        aposStrippedTitle &&
        aposStrippedTitle !== lowerTitle &&
        cacheKey !== `title:${aposStrippedTitle}`
      ) {
        siblingStagedKeys.push(`${STORAGE_PREFIX}title:${aposStrippedTitle}`);
      }
      const normalizedKey = getNormalizedKey();
      if (
        normalizedKey &&
        normalizedKey !== lowerTitle &&
        normalizedKey !== aposStrippedTitle &&
        cacheKey !== `title:${normalizedKey}`
      ) {
        siblingStagedKeys.push(`${STORAGE_PREFIX}title:${normalizedKey}`);
      }
      for (const sKey of siblingStagedKeys) {
        considerSiblingStagedKey(sKey);
      }
    }

    if (
      promotedFromSibling &&
      staged.entry &&
      staged.data &&
      steamAppId &&
      cacheKey === `id:${steamAppId}` &&
      !staged.isCompactStub &&
      isStagedVaultHydrationComplete()
    ) {
      const altData = staged.data;
      const altTier = staged.entry.tier;
      const altDynamic = Boolean(staged.entry.dynamicResolved);
      this.setInMemoryCache(`id:${steamAppId}`, altData);
      this.scheduleDeferredStorageTask(`save:${stagedKey}`, () => {
        saveStagedCache<CriticScoreData>(stagedKey, altData, altTier, {
          source: altData.source,
          isVerified: altData.isVerified,
          dynamicResolved: altDynamic,
        });
      });
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

    // Early explicit unrated check (O(1) short-circuit when KNOWN_UNRATED_TITLES is empty)
    const isExplicitlyUnrated =
      isNonGameAddonOrBeta ||
      (KNOWN_UNRATED_TITLES.size > 0 &&
        (KNOWN_UNRATED_TITLES.has(lowerTitle) ||
          (Boolean(getNormalizedKey()) && KNOWN_UNRATED_TITLES.has(getNormalizedKey()))));
    if (isExplicitlyUnrated) {
      this.attemptedDynamicResolutions.add(cacheKey);
      if (lowerTitle) this.attemptedDynamicResolutions.add(`title:${lowerTitle}`);
      let positive = steamAppId ? steamPositivePercent : undefined;
      let totalReviews: number | undefined;
      if (positive === undefined && steamAppId && hasAnySteamEnrichedCriticEntry()) {
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
    let positive = steamAppId ? steamPositivePercent : undefined;
    let totalReviews: number | undefined;

    if (positive === undefined && steamAppId && hasAnySteamEnrichedCriticEntry()) {
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

    return null;
  }

  async resolveDynamicScore(
    rawTitle: string,
    steamAppId?: number | null,
    releaseYear?: number | string | null,
    storefrontAnchor?: StorefrontReviewAnchor | null,
    options?: DynamicCascadeOptions
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
      let scheduled!: Promise<CriticScoreData | null>;
      scheduled = Promise.resolve().then(() => {
        if (this.pendingPassiveTriggers.get(deferredKey) === scheduled) {
          this.pendingPassiveTriggers.delete(deferredKey);
        }
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

  private async executeDynamicScoreResolution(
    rawTitle: string,
    steamAppId?: number | null,
    releaseYear?: number | string | null,
    storefrontAnchor?: StorefrontReviewAnchor | null,
    options?: DynamicCascadeOptions
  ): Promise<CriticScoreData | null> {
    this.ensureHydrated();
    const title = (rawTitle || '').trim();
    if (!title) return null;

    let year = releaseYear;
    let enrichedReleaseDate: string | undefined;
    let enrichedGenres: string[] | undefined = options?.genres;
    if (steamAppId && hasAnySteamEnrichedCriticEntry()) {
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
    if (
      userOverride &&
      (userOverride.reviewScoreOverride !== undefined || userOverride.reviewRoute !== undefined)
    ) {
      const route = inferReviewRouteFromOverride(userOverride);
      if (route?.mode === 'unrated') {
        this.setInMemoryCache(cacheKey, null);
        this.tier0OverrideKeys.add(cacheKey);
        saveStagedCache<CriticScoreData>(stagedKey, null, MutabilityTier.TIER_0_USER_OVERRIDE);
        return null;
      }
      if (route?.mode === 'static') {
        const staticScore = userOverride.reviewScoreOverride ?? null;
        this.setInMemoryCache(cacheKey, staticScore);
        this.tier0OverrideKeys.add(cacheKey);
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
        const capturedEpoch = this.cacheEpoch;
        const capturedKeyEpoch = this.keyEpochs.get(cacheKey) ?? 0;
        this.attemptedDynamicResolutions.add(cacheKey);
        if (title) this.attemptedDynamicResolutions.add(`title:${title.toLowerCase()}`);
        const refreshed = await this.resolveRoutedScore(
          route,
          title,
          year,
          userOverride.reviewScoreOverride
        );
        if (!this.isEpochCurrent(capturedEpoch, cacheKey, capturedKeyEpoch)) {
          return null;
        }
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
            saveStagedCache<CriticScoreData>(
              `${STORAGE_PREFIX}title:${lower}`,
              refreshed,
              dynamicTier,
              {
                source: refreshed.source,
                isVerified: refreshed.isVerified,
                dynamicResolved: true,
                cachedAt: savedRouted.cachedAt,
                customTtlMs: savedRouted.ttlMs,
              }
            );
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
          const routedVaultGameId = (options?.gameId || userOverride.gameId || '').trim();
          if (
            routedVaultGameId &&
            typeof window !== 'undefined' &&
            typeof window.electronAPI?.offlineVault?.saveGameDetail === 'function'
          ) {
            this.vaultWriteThrough.delete(routedVaultGameId);
            try {
              void window.electronAPI.offlineVault
                .saveGameDetail({
                  gameId: routedVaultGameId,
                  ...(typeof steamAppId === 'number' && steamAppId > 0 ? { steamAppId } : {}),
                  ...(title ? { canonicalTitle: title } : {}),
                  criticScore: { ...refreshed },
                  forceCriticScore: true,
                })
                ?.catch?.(() => {});
            } catch {}
          }
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

    // 0. Check Tier 0 User Override (in-memory first, then staged fallback)
    if (this.tier0OverrideKeys.has(cacheKey) && this.inMemoryCache.has(cacheKey)) {
      return this.inMemoryCache.get(cacheKey) ?? null;
    }

    const stagedTier0 = loadStagedCache<CriticScoreData>(stagedKey, false);
    if (
      stagedTier0.entry &&
      (stagedTier0.entry.tier === MutabilityTier.TIER_0_USER_OVERRIDE ||
        stagedTier0.entry.tier === 'override')
    ) {
      this.tier0OverrideKeys.add(cacheKey);
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
    if (
      this.inMemoryCache.has(cacheKey) ||
      (lowerTitleKey && this.inMemoryCache.has(lowerTitleKey))
    ) {
      const existing =
        this.inMemoryCache.get(cacheKey) ??
        (lowerTitleKey ? this.inMemoryCache.get(lowerTitleKey) : undefined);
      if (
        !options?.bypassAttempted &&
        !stagedTier0.stale &&
        existing?.isVerified &&
        existing.source === 'metacritic'
      ) {
        if (this.validateScoreSemanticCompatibility(title, existing, steamAppId)) {
          // Stop redundant disk writes on fresh verified memory hits when staged cache is already current
          if (!stagedTier0.valid || !stagedTier0.entry?.dynamicResolved) {
            this.cacheResult(cacheKey, existing, effectiveReleaseDate, enrichedGenres, {
              dynamicResolved: true,
              aliasTitle: title,
            });
          }
          if (lowerTitleKey && lowerTitleKey !== cacheKey && !this.inMemoryCache.has(lowerTitleKey)) {
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

    const capturedEpoch = this.cacheEpoch;
    const capturedKeyEpoch = this.keyEpochs.get(cacheKey) ?? 0;

    let promise!: Promise<CriticScoreData | null>;
    promise = (async (): Promise<CriticScoreData | null> => {
      try {
        return await runDynamicCriticCascade({
          cacheKey,
          stagedKey,
          title,
          steamAppId,
          year,
          effectiveReleaseDate,
          enrichedGenres,
          storefrontAnchor,
          options,
          isEpochCurrent: () => this.isEpochCurrent(capturedEpoch, cacheKey, capturedKeyEpoch),
          validateSemantic: (rawT, scoreD, appId, anchorSlug) =>
            this.validateScoreSemanticCompatibility(rawT, scoreD, appId, anchorSlug),
          findMatchingUserOverride: (appId, t, gId, plats) =>
            this.findMatchingUserOverride(appId, t, gId, plats),
          getInMemoryCache: (k) => this.inMemoryCache.get(k),
          setInMemoryCache: (k, v) => this.setInMemoryCache(k, v),
          deleteAttempted: (k) => {
            this.attemptedDynamicResolutions.delete(k);
          },
          getTransientFailureCount: (k) => this.transientFailureCounts.get(k) || 0,
          setTransientFailureCount: (k, count) => {
            this.transientFailureCounts.set(k, count);
          },
          deleteTransientFailureCount: (k) => {
            this.transientFailureCounts.delete(k);
          },
          cacheResult: (k, d, rel, gen, opts) => this.cacheResult(k, d, rel, gen, opts),
          scheduleVaultWriteThrough: (gId, score, appId, canonTitle) =>
            this.vaultWriteThrough.schedule(gId, score, appId, canonTitle),
        });
      } catch {
        return this.inMemoryCache.get(cacheKey) ?? null;
      } finally {
        if (this.inFlightResolutions.get(cacheKey) === promise) {
          this.inFlightResolutions.delete(cacheKey);
        }
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
      (existingStaged.entry.tier === MutabilityTier.TIER_0_USER_OVERRIDE ||
        existingStaged.entry.tier === 'override')
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
      if (
        !existing.valid ||
        !existing.data ||
        typeof existing.data.score !== 'number' ||
        existing.data.score <= 0
      ) {
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

      if (tier === MutabilityTier.TIER_0_USER_OVERRIDE) {
        this.tier0OverrideKeys.add(rawKey);
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
