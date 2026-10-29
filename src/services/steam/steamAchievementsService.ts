import axios from 'axios';
import { CanonicalGame, StoreAchievementSummary } from '../../contracts/game';
import { loadIntegrations } from '../integrations/integrationStorage';
import { KNOWN_USER_STEAM_ACHIEVEMENTS } from '../storage/knownGameAchievements';
import { reconcileAchievementSummaries } from '../storage/achievementReconciliation';
import { vaultGet, vaultSet } from '../storage/indexedDbVault';
import { requestScheduler, Priority } from '../network/requestScheduler';

const STORAGE_KEY_ACHIEVEMENTS_SUMMARY = 'antigravity_steam_achievements';
const IDB_KEY_ACHIEVEMENTS_SUMMARY = 'idb_steam_achievements_summary_v1';
const STORAGE_KEY_ACHIEVEMENTS_LAST_SYNC = 'antigravity_steam_achievements_last_sync_ts';
const DEFAULT_ACHIEVEMENTS_SYNC_COOLDOWN_MS = 6 * 60 * 60 * 1000; // 6 hours
const ACHIEVEMENTS_SAVE_DEBOUNCE_MS = 250;

export class SteamAchievementsService {
  private inMemoryCache = new Map<number, StoreAchievementSummary>();
  private persistedDictCache: Record<string, StoreAchievementSummary> | null = null;
  private lastRawStorageRef: string | null = null;
  private isDictDirty = false;
  private pendingFlushTimer: ReturnType<typeof setTimeout> | null = null;

  constructor() {
    if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
      window.addEventListener('beforeunload', () => {
        this.flushPendingSave();
      });
    }
    void this.hydrateFromIndexedDb();
  }

  private async hydrateFromIndexedDb(): Promise<void> {
    const stored = await vaultGet<Record<string, StoreAchievementSummary>>(
      IDB_KEY_ACHIEVEMENTS_SUMMARY
    );
    if (!stored || typeof stored !== 'object') return;
    const dict = this.ensurePersistedDict();
    let added = false;
    for (const [key, val] of Object.entries(stored)) {
      if (!dict[key] && val && typeof val.unlocked === 'number' && typeof val.total === 'number') {
        dict[key] = val;
        const appId = Number(key);
        if (appId > 0 && !this.inMemoryCache.has(appId)) {
          this.inMemoryCache.set(appId, val);
        }
        added = true;
      }
    }
    if (added) {
      this.scheduleDebouncedSave();
    }
  }

  private ensurePersistedDict(): Record<string, StoreAchievementSummary> {
    if (this.isDictDirty && this.persistedDictCache) {
      return this.persistedDictCache;
    }
    if (typeof localStorage !== 'undefined') {
      try {
        const raw = localStorage.getItem(STORAGE_KEY_ACHIEVEMENTS_SUMMARY);
        if (this.persistedDictCache !== null && raw === this.lastRawStorageRef) {
          return this.persistedDictCache;
        }
        if (raw === null && this.lastRawStorageRef !== null) {
          this.inMemoryCache.clear();
        }
        this.lastRawStorageRef = raw;
        const parsed = raw ? JSON.parse(raw) : {};
        const nextDict: Record<string, StoreAchievementSummary> =
          parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
        this.persistedDictCache = nextDict;
        return nextDict;
      } catch {
        const fallbackDict: Record<string, StoreAchievementSummary> =
          this.persistedDictCache ?? {};
        this.persistedDictCache = fallbackDict;
        return fallbackDict;
      }
    }
    if (!this.persistedDictCache) {
      this.persistedDictCache = {};
    }
    return this.persistedDictCache;
  }

  public flushPendingSave(): void {
    if (this.pendingFlushTimer !== null) {
      clearTimeout(this.pendingFlushTimer);
      this.pendingFlushTimer = null;
    }
    if (!this.isDictDirty || !this.persistedDictCache) return;
    this.isDictDirty = false;
    const snapshot = { ...this.persistedDictCache };
    void vaultSet(IDB_KEY_ACHIEVEMENTS_SUMMARY, snapshot);
    if (typeof localStorage !== 'undefined') {
      try {
        const serialized = JSON.stringify(snapshot);
        localStorage.setItem(STORAGE_KEY_ACHIEVEMENTS_SUMMARY, serialized);
        this.lastRawStorageRef = serialized;
      } catch {
        // QuotaExceededError: full dictionary remains in memory and IndexedDB vault
      }
    }
  }

  private scheduleDebouncedSave(): void {
    this.isDictDirty = true;
    const isVitest =
      typeof process !== 'undefined' &&
      Boolean((process as { env?: Record<string, string | undefined> }).env?.VITEST);
    if (isVitest) {
      if (this.pendingFlushTimer === null) {
        this.pendingFlushTimer = setTimeout(() => {
          this.flushPendingSave();
        }, 10);
      }
      return;
    }
    if (this.pendingFlushTimer === null) {
      this.pendingFlushTimer = setTimeout(() => {
        this.flushPendingSave();
      }, ACHIEVEMENTS_SAVE_DEBOUNCE_MS);
    }
  }

  /**
   * Checks whether a full library achievement sync has completed within the cooldown window.
   */
  hasRecentFullSync(cooldownMs: number = DEFAULT_ACHIEVEMENTS_SYNC_COOLDOWN_MS): boolean {
    if (typeof localStorage === 'undefined') return false;
    try {
      const raw = localStorage.getItem(STORAGE_KEY_ACHIEVEMENTS_LAST_SYNC);
      if (!raw) return false;
      const ts = Number(raw);
      return Boolean(ts > 0 && Date.now() - ts < cooldownMs);
    } catch {
      return false;
    }
  }

  /**
   * Records that a full library achievement sync has completed.
   */
  recordFullSyncCompleted(timestamp: number = Date.now()): void {
    if (typeof localStorage === 'undefined') return;
    try {
      localStorage.setItem(STORAGE_KEY_ACHIEVEMENTS_LAST_SYNC, String(timestamp));
    } catch {}
  }

  /**
   * Retrieves the connected user's active SteamID64 and optional API key.
   */
  getActiveSteamCredentials(): { steamId: string; apiKey?: string } {
    try {
      const integrations = loadIntegrations();
      const steamInteg = integrations.find((i) => i.storefrontId === 'steam' && i.isConnected);
      const steamId =
        steamInteg?.credentials?.steamId ||
        steamInteg?.accountId ||
        '';
      const apiKey = steamInteg?.credentials?.apiKey;
      return { steamId, apiKey };
    } catch {
      return { steamId: '' };
    }
  }

  private getCommunityBaseUrl(): string {
    if (typeof window !== 'undefined' && window.location.hostname === 'localhost') {
      return '/api/steam-community';
    }
    return 'https://steamcommunity.com';
  }

  private getApiBaseUrl(): string {
    if (typeof window !== 'undefined' && window.location.hostname === 'localhost') {
      return '/api/steam-api';
    }
    return 'https://api.steampowered.com';
  }

  /**
   * Reads cached achievements from in-memory cache or persisted dictionary.
   */
  getCachedAchievements(appId: number): StoreAchievementSummary | null {
    const dict = this.ensurePersistedDict();
    if (this.inMemoryCache.has(appId)) {
      return this.inMemoryCache.get(appId)!;
    }

    const found = dict[String(appId)];
    if (found && typeof found.unlocked === 'number' && typeof found.total === 'number') {
      const summary: StoreAchievementSummary = {
        unlocked: found.unlocked,
        total: found.total,
        percentage:
          found.percentage ??
          (found.total > 0 ? Math.round((found.unlocked / found.total) * 100) : 0),
        isMastered: found.total > 0 && found.unlocked >= found.total,
        source: found.source || 'local_client_cache',
        syncedAt: found.syncedAt,
        hasConflict: found.hasConflict,
        conflictDetails: found.conflictDetails,
      };
      this.inMemoryCache.set(appId, summary);
      return summary;
    }

    // Check verified built-in user baseline
    if (KNOWN_USER_STEAM_ACHIEVEMENTS[appId]) {
      const b = KNOWN_USER_STEAM_ACHIEVEMENTS[appId];
      const summary: StoreAchievementSummary = {
        unlocked: b.unlocked,
        total: b.total,
        percentage: b.percentage,
        isMastered: b.total > 0 && b.unlocked >= b.total,
        source: 'baseline_fallback',
      };
      this.inMemoryCache.set(appId, summary);
      return summary;
    }

    return null;
  }

  /**
   * Caches an achievement record in memory and schedules a debounced persistent flush.
   */
  setCachedAchievement(appId: number, summary: StoreAchievementSummary): void {
    const dict = this.ensurePersistedDict();
    this.inMemoryCache.set(appId, summary);
    dict[String(appId)] = summary;
    this.scheduleDebouncedSave();
  }

  /**
   * Hydrates game platforms with cached or baseline achievements.
   */
  hydrateGamePlatformAchievements(game: CanonicalGame): CanonicalGame {
    const targetAppId = game.steamAppId;
    if (!targetAppId) return game;

    const cached = this.getCachedAchievements(targetAppId);
    if (!cached) return game;

    let changed = false;
    const updatedPlatforms = game.platforms.map((p) => {
      if (p.platformId === 'steam') {
        const reconciled = reconcileAchievementSummaries(p.achievements, cached, {
          appId: targetAppId,
          title: game.title,
          store: 'steam',
        });
        if (
          reconciled &&
          (!p.achievements ||
            p.achievements.unlocked !== reconciled.unlocked ||
            p.achievements.total !== reconciled.total ||
            p.achievements.hasConflict !== reconciled.hasConflict)
        ) {
          changed = true;
          return {
            ...p,
            achievements: reconciled,
          };
        }
      }
      return p;
    });

    return changed ? { ...game, platforms: updatedPlatforms } : game;
  }

  /**
   * Fetches accurate player achievements for a specific game on Steam.
   * Uses authoritative live Steam Community stats XML or Steam Web API,
   * falling back to local client librarycache and verified baselines.
   */
  async fetchPlayerGameAchievements(
    appId: number,
    explicitSteamId?: string,
    explicitApiKey?: string
  ): Promise<StoreAchievementSummary | null> {
    const creds = this.getActiveSteamCredentials();
    const steamId = explicitSteamId || creds.steamId;
    const apiKey = explicitApiKey || creds.apiKey;
    const existingCached = this.getCachedAchievements(appId) || undefined;

    const gameKey = `steam:${appId}`;

    // 1. If Steam Web API key is configured, try ISteamUserStats/GetPlayerAchievements
    if (apiKey && steamId) {
      try {
        const url = `${this.getApiBaseUrl()}/ISteamUserStats/GetPlayerAchievements/v0001/?appid=${appId}&key=${apiKey}&steamid=${steamId}`;
        const canonicalApiUrl = `https://api.steampowered.com/ISteamUserStats/GetPlayerAchievements/v0001/?appid=${appId}`;
        const res = await requestScheduler.schedule(
          canonicalApiUrl,
          () =>
            axios.get<{
              playerstats?: {
                achievements?: Array<{ achieved?: number }>;
                error?: string;
              };
            }>(url, { timeout: 5000 }),
          Priority.LOW,
          'api.steampowered.com',
          gameKey
        );
        const list = res.data?.playerstats?.achievements;
        if (Array.isArray(list)) {
          if (list.length === 0 && (!existingCached || existingCached.total === 0)) {
            const zeroSummary: StoreAchievementSummary = {
              unlocked: 0,
              total: 0,
              percentage: 0,
              isMastered: false,
              source: 'live_cloud_api',
              syncedAt: new Date().toISOString(),
            };
            this.setCachedAchievement(appId, zeroSummary);
            return zeroSummary;
          }
          const total = list.length;
          const unlocked = list.filter((a) => a.achieved === 1).length;
          const percentage = total > 0 ? Math.round((unlocked / total) * 100) : 0;
          const liveSummary: StoreAchievementSummary = {
            unlocked,
            total,
            percentage,
            isMastered: total > 0 && unlocked >= total,
            source: 'live_cloud_api',
            syncedAt: new Date().toISOString(),
          };
          const reconciled =
            reconcileAchievementSummaries(existingCached, liveSummary, {
              appId,
              store: 'steam',
            }) || liveSummary;
          this.setCachedAchievement(appId, reconciled);
          return reconciled;
        } else if (
          res.data?.playerstats?.error === 'Requested app has no stats' &&
          (!existingCached || existingCached.total === 0)
        ) {
          const zeroSummary: StoreAchievementSummary = {
            unlocked: 0,
            total: 0,
            percentage: 0,
            isMastered: false,
            source: 'live_cloud_api',
            syncedAt: new Date().toISOString(),
          };
          this.setCachedAchievement(appId, zeroSummary);
          return zeroSummary;
        }
      } catch (err: unknown) {
        const errData =
          err && typeof err === 'object' && 'response' in err
            ? (err as { response?: { data?: { playerstats?: { error?: string } } } }).response?.data
            : undefined;
        if (
          errData?.playerstats?.error === 'Requested app has no stats' &&
          (!existingCached || existingCached.total === 0)
        ) {
          const zeroSummary: StoreAchievementSummary = {
            unlocked: 0,
            total: 0,
            percentage: 0,
            isMastered: false,
            source: 'live_cloud_api',
            syncedAt: new Date().toISOString(),
          };
          this.setCachedAchievement(appId, zeroSummary);
          return zeroSummary;
        }
        // Fall back to community XML
      }
    }

    // 2. Try official Steam Community XML stats endpoint (works for any public profile without API key)
    if (steamId) {
      try {
        const isNumeric = /^\d{17}$/.test(steamId);
        const pathSegment = isNumeric ? `profiles/${steamId}` : `id/${steamId}`;
        const url = `${this.getCommunityBaseUrl()}/${pathSegment}/stats/${appId}/?xml=1`;
        const canonicalXmlUrl = `https://steamcommunity.com/${pathSegment}/stats/${appId}/?xml=1`;
        const res = await requestScheduler.schedule(
          canonicalXmlUrl,
          () => axios.get<string>(url, { timeout: 6000, responseType: 'text' }),
          Priority.LOW,
          'steamcommunity.com',
          gameKey
        );
        let xml = typeof res.data === 'string' ? res.data : '';

        // Older Steam titles with a custom Steam Community friendlyURL (e.g. 20920 -> TheWitcher2, 223850 -> 3DMark)
        // HTTP-302 redirect /stats/{appId}/?xml=1 -> /stats/{friendlyName} stripping the ?xml=1 query parameter.
        if (!xml.includes('<achievements>') && !xml.includes('<achievement closed=')) {
          const htmlSummaryMatch =
            xml.match(/id="topSummaryAchievements"[^>]*>\s*(\d+)\s+of\s+(\d+)\s+\(\d+%\)\s+Achievements\s+Earned/i) ||
            xml.match(/content="(\d+)\s+of\s+(\d+)\s+\(\d+%\)\s+achievements\s+earned/i);
          if (htmlSummaryMatch) {
            const unlocked = Number(htmlSummaryMatch[1]);
            const total = Number(htmlSummaryMatch[2]);
            if (total > 0 || unlocked > 0) {
              const percentage = total > 0 ? Math.round((unlocked / total) * 100) : 0;
              const liveSummary: StoreAchievementSummary = {
                unlocked,
                total,
                percentage,
                isMastered: total > 0 && unlocked >= total,
                source: 'live_cloud_xml',
                syncedAt: new Date().toISOString(),
              };
              const reconciled =
                reconcileAchievementSummaries(existingCached, liveSummary, {
                  appId,
                  store: 'steam',
                }) || liveSummary;
              this.setCachedAchievement(appId, reconciled);
              return reconciled;
            }
          }

          const friendlyMatch = xml.match(/steamcommunity\.com\/stats\/([^/"'?]+)\/achievements/i);
          if (friendlyMatch?.[1]) {
            try {
              const encodedFriendly = encodeURIComponent(friendlyMatch[1]);
              const friendlyUrl = `${this.getCommunityBaseUrl()}/${pathSegment}/stats/${encodedFriendly}/?xml=1`;
              const canonicalFriendlyUrl = `https://steamcommunity.com/${pathSegment}/stats/${encodedFriendly}/?xml=1`;
              const friendlyRes = await requestScheduler.schedule(
                canonicalFriendlyUrl,
                () => axios.get<string>(friendlyUrl, { timeout: 6000, responseType: 'text' }),
                Priority.LOW,
                'steamcommunity.com',
                gameKey
              );
              if (typeof friendlyRes.data === 'string') {
                xml = friendlyRes.data;
              }
            } catch {}
          }
        }

        if (xml.includes('<achievements>') || xml.includes('<achievement closed=')) {
          const allMatches = xml.match(/<achievement closed="/g) || [];
          const unlockedMatches = xml.match(/<achievement closed="1">/g) || [];
          const total = allMatches.length;
          const unlocked = unlockedMatches.length;

          // Note: total > 0 is valid authoritative data even if unlocked is 0
          if (total > 0 || unlocked > 0) {
            const percentage = total > 0 ? Math.round((unlocked / total) * 100) : 0;
            const liveSummary: StoreAchievementSummary = {
              unlocked,
              total,
              percentage,
              isMastered: total > 0 && unlocked >= total,
              source: 'live_cloud_xml',
              syncedAt: new Date().toISOString(),
            };
            const reconciled =
              reconcileAchievementSummaries(existingCached, liveSummary, {
                appId,
                store: 'steam',
              }) || liveSummary;
            this.setCachedAchievement(appId, reconciled);
            return reconciled;
          } else if (
            res.status === 200 &&
            xml.includes('<playerstats>') &&
            !xml.includes('<privacyState>private') &&
            !xml.includes('<error>') &&
            (!existingCached || existingCached.total === 0)
          ) {
            const zeroSummary: StoreAchievementSummary = {
              unlocked: 0,
              total: 0,
              percentage: 0,
              isMastered: false,
              source: 'live_cloud_xml',
              syncedAt: new Date().toISOString(),
            };
            this.setCachedAchievement(appId, zeroSummary);
            return zeroSummary;
          }
        } else if (
          res.status === 200 &&
          xml.includes('<playerstats>') &&
          !xml.includes('<privacyState>private') &&
          !xml.includes('<error>') &&
          (!existingCached || existingCached.total === 0)
        ) {
          const zeroSummary: StoreAchievementSummary = {
            unlocked: 0,
            total: 0,
            percentage: 0,
            isMastered: false,
            source: 'live_cloud_xml',
            syncedAt: new Date().toISOString(),
          };
          this.setCachedAchievement(appId, zeroSummary);
          return zeroSummary;
        }
      } catch {
        // Fall through to cached data
      }
    }

    // 3. Fallback to cached or verified baseline
    return existingCached || this.getCachedAchievements(appId);
  }

  /**
   * Performs an automated live synchronization of player achievements directly from Steam
   * across owned games, prioritizing played titles with playtime > 0.
   */
  async syncUserLibraryAchievements(
    games: CanonicalGame[],
    onProgress?: (completed: number, total: number, currentTitle?: string) => void,
    options?: {
      forceRefresh?: boolean;
      includeUnplayed?: boolean;
      onBatchUpdated?: (partialResults: Record<number, StoreAchievementSummary>) => void;
    }
  ): Promise<Record<number, StoreAchievementSummary>> {
    const creds = this.getActiveSteamCredentials();
    let activeSteamId = creds.steamId;
    const results: Record<number, StoreAchievementSummary> = {};

    // Filter games that belong to Steam and have steamAppId
    const steamGames = games.filter((g) =>
      Boolean(g.steamAppId && g.platforms.some((p) => p.platformId === 'steam'))
    );

    if (steamGames.length === 0) return results;

    // 1. Fast Native Batch Sync via Electron (IPlayerService/GetAchievementsProgress/v1 + local Steam librarycache)
    const batchSolvedAppIds = new Set<number>();
    if (typeof window !== 'undefined' && window.electronAPI?.fetchSteamBatchAchievements) {
      try {
        const allAppIds = steamGames.map((g) => g.steamAppId!).filter((id) => id > 0);
        const batchRes = await window.electronAPI.fetchSteamBatchAchievements(allAppIds);
        if (batchRes?.steamId && !activeSteamId) {
          activeSteamId = batchRes.steamId;
        }
        if (batchRes?.success && batchRes.achievements) {
          const nowIso = new Date().toISOString();
          for (const [rawId, data] of Object.entries(batchRes.achievements)) {
            const appId = Number(rawId);
            if (!appId || !data || typeof data.unlocked !== 'number' || typeof data.total !== 'number') continue;
            if (data.total <= 0 && data.unlocked <= 0) continue;
            const existing = this.getCachedAchievements(appId) || undefined;
            const incoming: StoreAchievementSummary = {
              unlocked: data.unlocked,
              total: data.total,
              percentage: data.percentage ?? (data.total > 0 ? Math.round((data.unlocked / data.total) * 100) : 0),
              isMastered: Boolean(data.isMastered) || (data.total > 0 && data.unlocked >= data.total),
              source: 'live_cloud_api',
              syncedAt: nowIso,
            };
            const reconciled =
              reconcileAchievementSummaries(existing, incoming, {
                appId,
                store: 'steam',
              }) || incoming;
            results[appId] = reconciled;
            this.setCachedAchievement(appId, reconciled);
            batchSolvedAppIds.add(appId);
          }
          if (Object.keys(results).length > 0) {
            options?.onBatchUpdated?.({ ...results });
          }
        }
      } catch {}
    }

    // 2. Filter candidate games for Community XML stats verification:
    // By default, only query games with playtime > 0 or existing unlocked > 0 (avoiding 400+ unplayed 0-min games)
    const candidatesForXml = steamGames.filter((g) => {
      const appId = g.steamAppId!;
      const steamPlat = g.platforms.find((p) => p.platformId === 'steam');
      const playtime = steamPlat?.playtimeMinutes || 0;
      const existingUnlocked =
        results[appId]?.unlocked ||
        steamPlat?.achievements?.unlocked ||
        this.getCachedAchievements(appId)?.unlocked ||
        0;
      const isPlayed = playtime > 0 || existingUnlocked > 0 || Boolean(options?.includeUnplayed);
      if (!isPlayed) return false;
      // If batch API already resolved authoritative total > 0 and not forcing a full XML pass, skip redundant XML fetch
      if (batchSolvedAppIds.has(appId) && !options?.forceRefresh) {
        return false;
      }
      return true;
    });

    // Prioritize titles with highest playtime
    const prioritized = [...candidatesForXml].sort((a, b) => {
      const aPlaytime = a.platforms.find((p) => p.platformId === 'steam')?.playtimeMinutes || 0;
      const bPlaytime = b.platforms.find((p) => p.platformId === 'steam')?.playtimeMinutes || 0;
      return bPlaytime - aPlaytime;
    });

    if (prioritized.length === 0) {
      onProgress?.(steamGames.length, steamGames.length);
      this.recordFullSyncCompleted();
      return results;
    }

    // Process in concurrent batches of 8 for optimal speed and reliability
    const batchSize = 8;
    let completed = 0;

    for (let i = 0; i < prioritized.length; i += batchSize) {
      const batch = prioritized.slice(i, i + batchSize);
      let batchAdded = false;
      await Promise.all(
        batch.map(async (game) => {
          if (!game.steamAppId) return;
          try {
            const cached = this.getCachedAchievements(game.steamAppId);
            if (
              !options?.forceRefresh &&
              cached &&
              (cached.source === 'live_cloud_xml' || cached.source === 'live_cloud_api') &&
              cached.syncedAt &&
              Date.now() - new Date(cached.syncedAt).getTime() < 6 * 3600 * 1000
            ) {
              results[game.steamAppId] = cached;
              return;
            }
            const ach = await this.fetchPlayerGameAchievements(
              game.steamAppId,
              activeSteamId,
              creds.apiKey
            );
            if (ach) {
              results[game.steamAppId] = ach;
              batchAdded = true;
            }
          } catch {}
        })
      );
      completed = Math.min(prioritized.length, completed + batch.length);
      onProgress?.(completed, prioritized.length, batch[0]?.title);
      if (batchAdded) {
        options?.onBatchUpdated?.({ ...results });
      }
    }

    // Persist full synchronized dictionary in a single flush
    if (Object.keys(results).length > 0) {
      const dict = this.ensurePersistedDict();
      for (const [appIdKey, summary] of Object.entries(results)) {
        dict[appIdKey] = summary;
      }
      this.isDictDirty = true;
      this.flushPendingSave();
    }

    if (Object.keys(results).length > 0 || steamGames.length > 0) {
      this.recordFullSyncCompleted();
    }

    return results;
  }
}

export const steamAchievementsService = new SteamAchievementsService();
