import {
  CanonicalGame,
  GamePlatformOwnership,
  StoreAchievementSummary,
} from '../../contracts/game';
import {
  DetailedAchievement,
  MultiStoreAchievementsMap,
  StorefrontAchievementsData,
} from '../../contracts/achievement';
import { LruMap } from '../common/lruMap';
import { getSafeLocalStorage } from '../common/runtimeEnv';
import { onlineLifecycleManager } from '../network/onlineLifecycleManager';
import { steamMatcher } from '../steam/steamMatcher';
import {
  isIndexedDbAvailable,
  vaultDelete,
  vaultEntries,
  vaultGet,
  vaultSet,
} from '../storage/indexedDbVault';
import {
  ACHIEVEMENT_CACHE_VERSION,
  classifyRarityTier,
  deduplicateDetailedAchievements,
  normalizeMultiStoreAchievementsMap,
} from './achievementNormalizer';
import { fetchEpicDetailedAchievementsProvider } from './epicAchievementProvider';
import { fetchGogDetailedAchievementsProvider } from './gogAchievementProvider';
import {
  fetchSteamCanonicalSchemaForAppId,
  fetchSteamDetailedAchievementsProvider,
  fetchSteamGlobalPercentages as fetchSteamGlobalPercentagesProvider,
} from './steamAchievementProvider';
import { fetchXboxDetailedAchievementsProvider } from './xboxAchievementProvider';

export { classifyRarityTier, deduplicateDetailedAchievements };

export type AchievementDetailStorefrontId = 'steam' | 'gog' | 'epic' | 'xbox';

const LEGACY_LS_DETAILED_PREFIX = 'antigravity_detailed_achievements_';
const IDB_DETAILED_PREFIX = 'detailed_achievements:';
const ZERO_ACHIEVEMENT_REVALIDATE_AGE_MS = 5 * 60 * 1000;

function isZeroAchievementEntryStale(entry?: StorefrontAchievementsData): boolean {
  if (!entry) return false;
  if ((entry.total || 0) > 0 || (entry.achievements?.length || 0) > 0) return false;
  if (!entry.syncedAt) return true;
  const syncedMs = Date.parse(entry.syncedAt);
  if (Number.isNaN(syncedMs)) return true;
  return Date.now() - syncedMs > ZERO_ACHIEVEMENT_REVALIDATE_AGE_MS;
}

function filterMapToOwnedStorefronts(
  map: MultiStoreAchievementsMap,
  game: CanonicalGame
): MultiStoreAchievementsMap {
  if (!game.platforms || game.platforms.length === 0) {
    return map;
  }
  const owned = new Set<string>(game.platforms.map((p) => p.platformId));
  let pruned = false;
  const filtered: MultiStoreAchievementsMap = {};
  for (const key of Object.keys(map) as Array<keyof MultiStoreAchievementsMap>) {
    const entry = map[key];
    if (!entry) continue;
    if (owned.has(key)) {
      filtered[key] = entry;
    } else {
      pruned = true;
    }
  }
  return pruned ? filtered : map;
}

export class AchievementDetailService {
  public static readonly MAX_MEMORY_CACHE_ENTRIES = 60;
  public static readonly CURRENT_CACHE_VERSION = ACHIEVEMENT_CACHE_VERSION;

  private inMemoryCache = new LruMap<string, MultiStoreAchievementsMap>(
    AchievementDetailService.MAX_MEMORY_CACHE_ENTRIES
  );
  private schemaCache = new LruMap<string, DetailedAchievement[]>(
    AchievementDetailService.MAX_MEMORY_CACHE_ENTRIES
  );
  private gameIdToSchemaKeys = new Map<string, Set<string>>();
  private inFlightFetches = new Map<string, Promise<MultiStoreAchievementsMap>>();
  private cacheGeneration = 0;

  public get memoryCache(): LruMap<string, MultiStoreAchievementsMap> {
    return this.inMemoryCache;
  }

  private setMemoryCacheEntry(gameId: string, data: MultiStoreAchievementsMap): void {
    this.inMemoryCache.set(gameId, data);
  }

  private setSchemaCacheEntry(
    cacheKey: string,
    schema: DetailedAchievement[],
    gameId?: string
  ): void {
    this.schemaCache.set(cacheKey, schema);
    if (gameId) {
      let keys = this.gameIdToSchemaKeys.get(gameId);
      if (!keys) {
        keys = new Set<string>();
        this.gameIdToSchemaKeys.set(gameId, keys);
      }
      keys.add(cacheKey);
    }
  }

  /**
   * Clears in-memory cache and schema cache.
   */
  clearCache(): void {
    this.cacheGeneration += 1;
    this.inMemoryCache.clear();
    this.schemaCache.clear();
    this.gameIdToSchemaKeys.clear();
    this.inFlightFetches.clear();
  }

  /**
   * Clears cached detailed achievements for a specific storefront across RAM, schemaCache,
   * legacy localStorage keys, IndexedDB vault, and SQLite offlineVault (for storefront disconnect).
   */
  clearStorefrontCache(storefrontId: AchievementDetailStorefrontId): void {
    this.cacheGeneration += 1;

    // 1. Prune storefront from in-memory LRU cache
    const memUpdates: Array<{ gameId: string; next: MultiStoreAchievementsMap | null }> = [];
    for (const [gameId, map] of this.inMemoryCache.entries()) {
      if (map && Object.prototype.hasOwnProperty.call(map, storefrontId)) {
        const copy: MultiStoreAchievementsMap = { ...map };
        delete copy[storefrontId];
        memUpdates.push({
          gameId,
          next: Object.keys(copy).length > 0 ? copy : null,
        });
      }
    }
    for (const { gameId, next } of memUpdates) {
      if (next === null) {
        this.inMemoryCache.delete(gameId);
      } else {
        this.inMemoryCache.set(gameId, next);
      }
    }

    // 2. Clear schemaCache & in-flight map
    this.schemaCache.clear();
    this.gameIdToSchemaKeys.clear();
    this.inFlightFetches.clear();

    // 3. Prune / remove legacy localStorage keys for this storefront
    const storage = getSafeLocalStorage();
    if (storage) {
      try {
        const legacyKeys: string[] = [];
        for (let i = 0; i < storage.length; i++) {
          const k = storage.key(i);
          if (k && k.startsWith(LEGACY_LS_DETAILED_PREFIX)) {
            legacyKeys.push(k);
          }
        }
        for (const key of legacyKeys) {
          try {
            const raw = storage.getItem(key);
            if (!raw) continue;
            const parsed: unknown = JSON.parse(raw);
            if (
              parsed &&
              typeof parsed === 'object' &&
              Object.prototype.hasOwnProperty.call(parsed, storefrontId)
            ) {
              const copy: MultiStoreAchievementsMap = {
                ...(parsed as MultiStoreAchievementsMap),
              };
              delete copy[storefrontId];
              if (Object.keys(copy).length === 0) {
                storage.removeItem(key);
              } else {
                storage.setItem(key, JSON.stringify(copy));
              }
            }
          } catch {
            storage.removeItem(key);
          }
        }
      } catch {
        // Ignore restricted storage iteration errors
      }
    }

    // 4. Asynchronously prune IndexedDB & SQLite offlineVault entries for this storefront
    if (isIndexedDbAvailable()) {
      void vaultEntries<string, MultiStoreAchievementsMap>()
        .then(async (entries) => {
          for (const [key, val] of entries) {
            if (typeof key !== 'string' || !key.startsWith(IDB_DETAILED_PREFIX)) continue;
            if (!val || typeof val !== 'object') continue;
            if (!Object.prototype.hasOwnProperty.call(val, storefrontId)) continue;
            const gameId = key.slice(IDB_DETAILED_PREFIX.length);
            const copy: MultiStoreAchievementsMap = { ...val };
            delete copy[storefrontId];
            if (Object.keys(copy).length === 0) {
              await vaultDelete(key);
            } else {
              await vaultSet(key, copy);
            }
            if (
              typeof window !== 'undefined' &&
              window.electronAPI?.offlineVault?.saveGameDetail
            ) {
              try {
                await window.electronAPI.offlineVault
                  .saveGameDetail({ gameId, achievements: copy })
                  ?.catch?.(() => {});
              } catch {
                // Ignore SQLite mirror errors
              }
            }
          }
        })
        .catch(() => {});
    }
  }

  /**
   * Synchronously peeks cached multi-store detailed achievements (memory or legacy localStorage)
   * so the Achievements modal can paint immediately on open without flashing a spinner.
   */
  peekCachedGameAchievements(gameId: string): MultiStoreAchievementsMap | null {
    if (!gameId) return null;
    const hit = this.getCachedMultiStoreAchievements(gameId);
    if (
      hit &&
      Object.keys(hit).length > 0 &&
      !Object.values(hit).some((s) => s?.schemaUnavailableOffline === true)
    ) {
      return hit;
    }
    return null;
  }

  /**
   * Evicts a single game's detailed achievement cache across memory, schemaCache,
   * legacy localStorage, IndexedDB, and SQLite offlineVault.
   */
  async invalidateGame(gameId: string): Promise<void> {
    if (!gameId) return;
    this.cacheGeneration += 1;
    this.inMemoryCache.delete(gameId);

    // Clear tracked schemaCache keys + deterministic Steam ID schema key
    const trackedKeys = this.gameIdToSchemaKeys.get(gameId);
    if (trackedKeys) {
      for (const k of trackedKeys) {
        this.schemaCache.delete(k);
      }
      this.gameIdToSchemaKeys.delete(gameId);
    }
    const steamIdMatch = gameId.match(/^steam-(\d+)$/);
    if (steamIdMatch?.[1]) {
      this.schemaCache.delete(`id:${steamIdMatch[1]}`);
    }

    // Remove legacy localStorage key if present
    const storage = getSafeLocalStorage();
    if (storage) {
      try {
        storage.removeItem(`${LEGACY_LS_DETAILED_PREFIX}${gameId}`);
      } catch {
        // Ignore restricted storage errors
      }
    }

    await vaultDelete(`${IDB_DETAILED_PREFIX}${gameId}`);

    // Clear SQLite offlineVault achievements_json so stale SQLite rows cannot resurrect on next read
    if (typeof window !== 'undefined' && window.electronAPI?.offlineVault?.saveGameDetail) {
      try {
        await window.electronAPI.offlineVault
          .saveGameDetail({ gameId, achievements: {} })
          ?.catch?.(() => {});
      } catch {
        // Ignore SQLite vault write errors
      }
    }
  }

  /**
   * Loads cached detailed achievements from RAM LRU or legacy localStorage, automatically
   * self-healing any legacy duplicate-ID entries (e.g., doubled GOG pagination payloads).
   */
  getCachedMultiStoreAchievements(gameId: string): MultiStoreAchievementsMap | null {
    const memHit = this.inMemoryCache.get(gameId);
    if (memHit) {
      const { normalized, changed } = normalizeMultiStoreAchievementsMap(memHit);
      if (changed) {
        this.setMemoryCacheEntry(gameId, normalized);
        this.setCachedMultiStoreAchievements(gameId, normalized);
      }
      return normalized;
    }

    const storage = getSafeLocalStorage();
    if (storage) {
      try {
        const legacyKey = `${LEGACY_LS_DETAILED_PREFIX}${gameId}`;
        const raw = storage.getItem(legacyKey);
        if (raw) {
          const parsed: unknown = JSON.parse(raw);
          if (parsed && typeof parsed === 'object') {
            const typed = parsed as MultiStoreAchievementsMap;
            const { normalized, changed } = normalizeMultiStoreAchievementsMap(typed);
            this.setMemoryCacheEntry(gameId, normalized);
            if (isIndexedDbAvailable()) {
              // Migrate legacy localStorage entry into IndexedDB and remove unbounded LS key
              void vaultSet(`${IDB_DETAILED_PREFIX}${gameId}`, normalized);
              try {
                storage.removeItem(legacyKey);
              } catch {
                // Ignore removal failure
              }
              if (changed) {
                this.mirrorToOfflineVault(gameId, normalized);
              }
            } else if (changed) {
              this.setCachedMultiStoreAchievements(gameId, normalized);
            }
            return normalized;
          }
        }
      } catch {
        // Ignore malformed legacy storage entry
      }
    }
    return null;
  }

  private mirrorToOfflineVault(gameId: string, normalized: MultiStoreAchievementsMap): void {
    if (typeof window !== 'undefined' && window.electronAPI?.offlineVault?.saveGameDetail) {
      try {
        void window.electronAPI.offlineVault
          .saveGameDetail({ gameId, achievements: normalized })
          ?.catch?.(() => {});
      } catch {
        // Ignore SQLite vault write errors
      }
    }
  }

  /**
   * Persists detailed achievements to bounded 60-entry RAM LRU, IndexedDB vault, and SQLite vault.
   * Avoids polluting `localStorage` when IndexedDB is available (only falls back to `localStorage`
   * in restricted environments where IndexedDB does not exist).
   */
  setCachedMultiStoreAchievements(gameId: string, data: MultiStoreAchievementsMap): void {
    if (!data || Object.keys(data).length === 0) return;
    if (Object.values(data).some((entry) => entry?.schemaUnavailableOffline === true)) {
      return;
    }
    const { normalized } = normalizeMultiStoreAchievementsMap(data);
    this.setMemoryCacheEntry(gameId, normalized);
    this.mirrorToOfflineVault(gameId, normalized);

    if (isIndexedDbAvailable()) {
      void vaultSet(`${IDB_DETAILED_PREFIX}${gameId}`, normalized);
      // Clean up any legacy localStorage key for this game so 5MB catalog quota stays clean
      const storage = getSafeLocalStorage();
      if (storage) {
        try {
          storage.removeItem(`${LEGACY_LS_DETAILED_PREFIX}${gameId}`);
        } catch {
          // Ignore storage cleanup errors
        }
      }
      return;
    }

    // Fallback for environments without IndexedDB (e.g. Node unit tests / restricted contexts)
    const storage = getSafeLocalStorage();
    if (storage) {
      try {
        storage.setItem(`${LEGACY_LS_DETAILED_PREFIX}${gameId}`, JSON.stringify(normalized));
      } catch {
        // QuotaExceededError: data remains safely in bounded RAM LRU
      }
    }
  }

  async getVaultCachedMultiStoreAchievements(
    gameId: string
  ): Promise<MultiStoreAchievementsMap | null> {
    const syncHit = this.getCachedMultiStoreAchievements(gameId);
    if (syncHit && !Object.values(syncHit).some((s) => s?.schemaUnavailableOffline)) {
      return syncHit;
    }
    const vaultHit = await vaultGet<MultiStoreAchievementsMap>(`${IDB_DETAILED_PREFIX}${gameId}`);
    if (
      vaultHit &&
      typeof vaultHit === 'object' &&
      Object.keys(vaultHit).length > 0 &&
      !Object.values(vaultHit).some((s) => s?.schemaUnavailableOffline)
    ) {
      const { normalized, changed } = normalizeMultiStoreAchievementsMap(vaultHit);
      this.setMemoryCacheEntry(gameId, normalized);
      if (changed) {
        this.setCachedMultiStoreAchievements(gameId, normalized);
      }
      return normalized;
    }
    if (typeof window !== 'undefined' && window.electronAPI?.offlineVault?.getGameDetail) {
      try {
        const detail = await window.electronAPI.offlineVault.getGameDetail(gameId);
        const vaultAch = detail?.achievements as MultiStoreAchievementsMap | undefined;
        if (
          vaultAch &&
          typeof vaultAch === 'object' &&
          Object.keys(vaultAch).length > 0 &&
          !Object.values(vaultAch).some((s) => s?.schemaUnavailableOffline)
        ) {
          const { normalized, changed } = normalizeMultiStoreAchievementsMap(vaultAch);
          this.setMemoryCacheEntry(gameId, normalized);
          if (changed) {
            this.setCachedMultiStoreAchievements(gameId, normalized);
          }
          return normalized;
        }
      } catch {
        // Ignore SQLite vault read errors
      }
    }
    return null;
  }

  /**
   * Fetches global achievement percentages for a Steam Game.
   */
  async fetchSteamGlobalPercentages(appId: number): Promise<Map<string, number>> {
    return fetchSteamGlobalPercentagesProvider(appId);
  }

  /**
   * Resolves canonical achievement definitions for a game across all storefronts.
   * Ensures games owned on GOG or Epic have complete sets of possible achievements
   * even when unplayed by the user.
   */
  async getCanonicalGameSchema(game: CanonicalGame): Promise<DetailedAchievement[]> {
    if (!game) return [];
    const titleLower = (game.title || '').toLowerCase().trim();

    const cacheKey = game.steamAppId ? `id:${game.steamAppId}` : `title:${titleLower}`;
    const cachedHit = this.schemaCache.get(cacheKey);
    if (cachedHit) {
      return cachedHit;
    }

    if (!onlineLifecycleManager.isOnline()) {
      return [];
    }

    const appId = game.steamAppId || steamMatcher.matchGameToSteamInstant(game.title);
    if (appId) {
      const parsed = await fetchSteamCanonicalSchemaForAppId(appId);
      if (parsed.length > 0) {
        this.setSchemaCacheEntry(cacheKey, parsed, game.id);
        return parsed;
      }
    }

    return [];
  }

  /**
   * Fetches detailed Steam achievements via Electron main-process provider,
   * falling back to Community XML + canonical schema in non-Electron environments.
   */
  async fetchSteamDetailedAchievements(
    appId: number,
    gameTitle: string,
    existingSummary?: StoreAchievementSummary,
    canonicalSchema?: DetailedAchievement[],
    lazyCanonicalSchema?: () => Promise<DetailedAchievement[]>
  ): Promise<StorefrontAchievementsData | null> {
    return fetchSteamDetailedAchievementsProvider(
      appId,
      gameTitle,
      {
        fetchGlobalPercentages: (id) => this.fetchSteamGlobalPercentages(id),
        getCanonicalSchema: (g) => this.getCanonicalGameSchema(g),
      },
      existingSummary,
      canonicalSchema,
      lazyCanonicalSchema
    );
  }

  /**
   * Fetches detailed Epic Games achievements via unified cloud IPC with schema fallback.
   */
  async fetchEpicDetailedAchievements(
    game: CanonicalGame,
    platformGameId?: string,
    existingSummary?: StoreAchievementSummary,
    canonicalSchema?: DetailedAchievement[],
    lazyCanonicalSchema?: () => Promise<DetailedAchievement[]>
  ): Promise<StorefrontAchievementsData | null> {
    return fetchEpicDetailedAchievementsProvider(
      game,
      (g) => this.getCanonicalGameSchema(g),
      platformGameId,
      existingSummary,
      canonicalSchema,
      lazyCanonicalSchema
    );
  }

  /**
   * Fetches detailed GOG Galaxy achievements, reconciling live records against canonical schemas.
   */
  async fetchGogDetailedAchievements(
    game: CanonicalGame,
    platformGameId?: string,
    existingSummary?: StoreAchievementSummary,
    canonicalSchema?: DetailedAchievement[],
    lazyCanonicalSchema?: () => Promise<DetailedAchievement[]>
  ): Promise<StorefrontAchievementsData | null> {
    return fetchGogDetailedAchievementsProvider(
      game,
      (g) => this.getCanonicalGameSchema(g),
      platformGameId,
      existingSummary,
      canonicalSchema,
      lazyCanonicalSchema
    );
  }

  /**
   * Fetches detailed Xbox Live / Microsoft Store achievements with Gamerscore breakdowns.
   */
  async fetchXboxDetailedAchievements(
    game: CanonicalGame,
    xboxPlatform?: GamePlatformOwnership,
    existingSummary?: StoreAchievementSummary,
    canonicalSchema?: DetailedAchievement[],
    lazyCanonicalSchema?: () => Promise<DetailedAchievement[]>
  ): Promise<StorefrontAchievementsData | null> {
    return fetchXboxDetailedAchievementsProvider(
      game,
      (g) => this.getCanonicalGameSchema(g),
      xboxPlatform,
      existingSummary,
      canonicalSchema,
      lazyCanonicalSchema
    );
  }

  /**
   * Main entry point: Fetches and aggregates complete detailed achievements across all
   * storefront platforms the game is actually owned on, with per-(gameId, forceRefresh)
   * in-flight request coalescing.
   */
  async fetchGameAchievements(
    game: CanonicalGame,
    forceRefresh: boolean = false
  ): Promise<MultiStoreAchievementsMap> {
    if (!game) return {};

    const flightKey = `${game.id}:${forceRefresh ? '1' : '0'}`;
    const existingFlight = this.inFlightFetches.get(flightKey);
    if (existingFlight) {
      return existingFlight;
    }

    const capturedGen = this.cacheGeneration;
    const flight = this.runFetchGameAchievementsInternal(game, forceRefresh, capturedGen);
    this.inFlightFetches.set(flightKey, flight);
    try {
      return await flight;
    } finally {
      if (this.inFlightFetches.get(flightKey) === flight) {
        this.inFlightFetches.delete(flightKey);
      }
    }
  }

  private async runFetchGameAchievementsInternal(
    game: CanonicalGame,
    forceRefresh: boolean,
    capturedGen: number
  ): Promise<MultiStoreAchievementsMap> {
    const steamPlat = game.platforms.find((p) => p.platformId === 'steam');
    const epicPlat = game.platforms.find((p) => p.platformId === 'epic');
    const gogPlat = game.platforms.find((p) => p.platformId === 'gog');
    const xboxPlat = game.platforms.find((p) => p.platformId === 'xbox');

    const rawCached =
      this.getCachedMultiStoreAchievements(game.id) ||
      (await this.getVaultCachedMultiStoreAchievements(game.id));
    const cached = rawCached ? filterMapToOwnedStorefronts(rawCached, game) : null;
    const hasUsableCached = Boolean(
      cached &&
        Object.keys(cached).length > 0 &&
        !Object.values(cached).some((s) => s?.schemaUnavailableOffline === true)
    );

    if (hasUsableCached && !onlineLifecycleManager.isOnline()) {
      return cached!;
    }

    const hasElectronIpc =
      typeof window !== 'undefined' && Boolean(window.electronAPI?.getStoreAchievements);
    if (!forceRefresh && hasUsableCached && cached) {
      const steamStale =
        (steamPlat?.achievements?.unlocked || 0) > (cached.steam?.unlocked || 0) ||
        (steamPlat?.achievements?.total || 0) > (cached.steam?.total || 0);
      const epicStale =
        (epicPlat?.achievements?.unlocked || 0) > (cached.epic?.unlocked || 0) ||
        (epicPlat?.achievements?.total || 0) > (cached.epic?.total || 0) ||
        isZeroAchievementEntryStale(cached.epic);
      const gogStale =
        (gogPlat?.achievements?.unlocked || 0) > (cached.gog?.unlocked || 0) ||
        (gogPlat?.achievements?.total || 0) > (cached.gog?.total || 0);
      const xboxStale =
        (xboxPlat?.achievements?.unlocked || 0) > (cached.xbox?.unlocked || 0) ||
        (xboxPlat?.achievements?.total || 0) > (cached.xbox?.total || 0) ||
        (xboxPlat?.achievements?.gamerscore?.earned || 0) > (cached.xbox?.earnedGamerscore || 0);
      const ipcUpgradeNeeded =
        hasElectronIpc &&
        Object.values(cached).some(
          (entry) =>
            Boolean(entry) &&
            (entry.unlockPrecision === 'summary_count_only' ||
              (entry.cacheVersion ?? 0) < AchievementDetailService.CURRENT_CACHE_VERSION ||
              (Array.isArray(entry.achievements) &&
                entry.achievements.length > 0 &&
                entry.total !== entry.achievements.length))
        );
      if (!steamStale && !epicStale && !gogStale && !xboxStale && !ipcUpgradeNeeded) {
        return cached;
      }
    }

    const result: MultiStoreAchievementsMap = {};
    const fetchPromises: Promise<void>[] = [];

    // Lazy shared canonical schema promise: native store APIs never block on a serial Steam schema request
    let sharedCanonicalSchemaPromise: Promise<DetailedAchievement[]> | null = null;
    const getSharedCanonicalSchema = (): Promise<DetailedAchievement[]> => {
      if (!onlineLifecycleManager.isOnline()) return Promise.resolve([]);
      if (!sharedCanonicalSchemaPromise) {
        sharedCanonicalSchemaPromise = this.getCanonicalGameSchema(game).catch(() => []);
      }
      return sharedCanonicalSchemaPromise;
    };

    // 1. Steam platform — P0-2 CRITICAL GATE: ONLY fetch Steam achievements when the user ACTUALLY OWNS Steam!
    // Never bleed a phantom Steam tab onto GOG/Epic/Xbox-only games that merely have a cross-referenced `steamAppId`.
    const targetSteamAppId =
      game.steamAppId ||
      (steamPlat?.platformGameId ? parseInt(steamPlat.platformGameId, 10) : undefined);

    if (steamPlat && targetSteamAppId) {
      fetchPromises.push(
        this.fetchSteamDetailedAchievements(
          targetSteamAppId,
          game.title,
          steamPlat.achievements,
          undefined,
          getSharedCanonicalSchema
        )
          .then((data) => {
            if (data) result.steam = data;
          })
          .catch(() => {})
      );
    }

    // 2. Epic platform
    if (epicPlat) {
      fetchPromises.push(
        this.fetchEpicDetailedAchievements(
          game,
          epicPlat.platformGameId,
          epicPlat.achievements,
          undefined,
          getSharedCanonicalSchema
        )
          .then((data) => {
            if (data) result.epic = data;
          })
          .catch(() => {})
      );
    }

    // 3. GOG platform
    if (gogPlat) {
      fetchPromises.push(
        this.fetchGogDetailedAchievements(
          game,
          gogPlat.platformGameId,
          gogPlat.achievements,
          undefined,
          getSharedCanonicalSchema
        )
          .then((data) => {
            if (data) result.gog = data;
          })
          .catch(() => {})
      );
    }

    // 4. Xbox platform
    if (xboxPlat) {
      fetchPromises.push(
        this.fetchXboxDetailedAchievements(
          game,
          xboxPlat,
          xboxPlat.achievements,
          undefined,
          getSharedCanonicalSchema
        )
          .then((data) => {
            if (data) result.xbox = data;
          })
          .catch(() => {})
      );
    }

    await Promise.all(fetchPromises);

    if (hasUsableCached && cached) {
      for (const storeKey of ['steam', 'epic', 'gog', 'xbox'] as const) {
        const cachedEntry = cached[storeKey];
        const liveEntry = result[storeKey];
        if (
          cachedEntry &&
          !cachedEntry.schemaUnavailableOffline &&
          (!liveEntry || liveEntry.schemaUnavailableOffline)
        ) {
          result[storeKey] = cachedEntry;
        }
      }
      if (Object.keys(result).length === 0) {
        return cached;
      }
    }

    const hasOfflineUnavailable = Object.values(result).some(
      (entry) => entry?.schemaUnavailableOffline === true
    );

    if (
      capturedGen === this.cacheGeneration &&
      Object.keys(result).length > 0 &&
      !hasOfflineUnavailable
    ) {
      this.setCachedMultiStoreAchievements(game.id, result);
    }

    return result;
  }
}

export const achievementDetailService = new AchievementDetailService();
