import axios from 'axios';
import { CanonicalGame, StoreAchievementSummary } from '../../contracts/game';
import { getSafeLocalStorage } from '../common/runtimeEnv';
import { loadIntegrations } from '../integrations/integrationStorage';
import {
  KNOWN_USER_STEAM_ACHIEVEMENTS,
  cacheUserSteamAchievements,
  type CachedAchievementEntry,
} from '../storage/knownGameAchievements';
import {
  STORAGE_KEY_STEAM_ACHIEVEMENTS_LAST_SYNC,
  achievementSummaryStore,
} from '../storage/achievementSummaryStore';
import { reconcileAchievementSummaries } from '../storage/achievementReconciliation';
import { getDevProxyBaseForRoute } from '../network/browserDevProxy';
import { requestScheduler, Priority } from '../network/requestScheduler';
import { scanLocalSteamAchievements } from '../system/localSystemScanner';

const DEFAULT_ACHIEVEMENTS_SYNC_COOLDOWN_MS = 6 * 60 * 60 * 1000; // 6 hours

export class SteamAchievementsService {
  private static readonly LOCAL_SCAN_STARTUP_WINDOW_MS = 30_000;
  private inFlightLibrarySyncPromise: Promise<Record<number, StoreAchievementSummary>> | null = null;
  private inFlightLocalScanPromise: Promise<Record<number, CachedAchievementEntry>> | null = null;
  private lastLocalScanAt = 0;
  private lastLocalScanResults: Record<number, CachedAchievementEntry> = {};

  public flushPendingSave(): void {
    achievementSummaryStore.flush('steam');
  }

  /**
   * Checks whether a full library achievement sync has completed within the cooldown window.
   */
  hasRecentFullSync(cooldownMs: number = DEFAULT_ACHIEVEMENTS_SYNC_COOLDOWN_MS): boolean {
    const storage = getSafeLocalStorage();
    if (!storage) return false;
    try {
      const raw = storage.getItem(STORAGE_KEY_STEAM_ACHIEVEMENTS_LAST_SYNC);
      if (!raw) return false;
      const ts = Number(raw);
      return Boolean(Number.isFinite(ts) && ts > 0 && Date.now() - ts < cooldownMs);
    } catch {
      return false;
    }
  }

  /**
   * Records that a full library achievement sync has completed.
   */
  recordFullSyncCompleted(timestamp: number = Date.now()): void {
    const storage = getSafeLocalStorage();
    if (!storage) return;
    try {
      storage.setItem(STORAGE_KEY_STEAM_ACHIEVEMENTS_LAST_SYNC, String(timestamp));
    } catch {
      // Ignore storage quota errors
    }
  }

  /**
   * Single-flight local Steam achievement scan per startup window so cold boot and React StrictMode
   * invoke `scanLocalSteamAchievements()` at most once instead of redundantly scanning disk twice.
   */
  async scanLocalAchievementsSingleFlight(
    force = false
  ): Promise<Record<number, CachedAchievementEntry>> {
    if (!force && this.inFlightLocalScanPromise) {
      return this.inFlightLocalScanPromise;
    }
    if (
      !force &&
      this.lastLocalScanAt > 0 &&
      Date.now() - this.lastLocalScanAt < SteamAchievementsService.LOCAL_SCAN_STARTUP_WINDOW_MS
    ) {
      return { ...this.lastLocalScanResults };
    }

    const flight = (async (): Promise<Record<number, CachedAchievementEntry>> => {
      try {
        const scanned = await scanLocalSteamAchievements();
        const normalized: Record<number, CachedAchievementEntry> =
          scanned && typeof scanned === 'object' ? scanned : {};
        this.lastLocalScanResults = normalized;
        this.lastLocalScanAt = Date.now();
        if (Object.keys(normalized).length > 0) {
          cacheUserSteamAchievements(normalized);
        }
        return { ...normalized };
      } catch {
        return {};
      }
    })();

    this.inFlightLocalScanPromise = flight;
    try {
      return await flight;
    } finally {
      if (this.inFlightLocalScanPromise === flight) {
        this.inFlightLocalScanPromise = null;
      }
    }
  }

  /**
   * Ingests batch achievements already obtained during Steam storefront sync (`syncStore('steam')`)
   * and updates `antigravity_steam_achievements_last_sync_ts` so cold boot does not re-run a duplicate
   * `fetchSteamBatchAchievements` Web API pass immediately afterwards.
   */
  ingestBatchAchievements(
    rawAchievements: Record<string | number, CachedAchievementEntry>,
    options?: { markFullSyncComplete?: boolean }
  ): Record<number, StoreAchievementSummary> {
    const ingested: Record<number, StoreAchievementSummary> = {};
    if (!rawAchievements || typeof rawAchievements !== 'object') {
      return ingested;
    }
    const nowIso = new Date().toISOString();
    for (const [rawId, data] of Object.entries(rawAchievements)) {
      const appId = Number(rawId);
      if (
        !Number.isFinite(appId) ||
        appId <= 0 ||
        !data ||
        typeof data.unlocked !== 'number' ||
        typeof data.total !== 'number'
      ) {
        continue;
      }
      if (data.total <= 0 && data.unlocked <= 0) continue;
      const existing = this.getCachedAchievements(appId) || undefined;
      const incoming: StoreAchievementSummary = {
        unlocked: data.unlocked,
        total: data.total,
        percentage:
          data.percentage ?? (data.total > 0 ? Math.round((data.unlocked / data.total) * 100) : 0),
        isMastered: Boolean(data.isMastered) || (data.total > 0 && data.unlocked >= data.total),
        ...(data.lastUnlockedAt ? { lastUnlockedAt: data.lastUnlockedAt } : {}),
        source: data.source || 'live_cloud_api',
        syncedAt: data.syncedAt || nowIso,
      };
      const reconciled =
        reconcileAchievementSummaries(existing, incoming, {
          appId,
          store: 'steam',
        }) || incoming;
      ingested[appId] = reconciled;
      this.setCachedAchievement(appId, reconciled);
    }

    if (options?.markFullSyncComplete !== false && Object.keys(ingested).length > 0) {
      this.recordFullSyncCompleted();
    }
    return ingested;
  }

  public resetForTests(): void {
    achievementSummaryStore.resetForTests('steam');
    this.inFlightLibrarySyncPromise = null;
    this.inFlightLocalScanPromise = null;
    this.lastLocalScanAt = 0;
    this.lastLocalScanResults = {};
  }

  /**
   * Retrieves the connected user's active SteamID64 and optional API key.
   */
  getActiveSteamCredentials(): { steamId: string; apiKey?: string } {
    try {
      const integrations = loadIntegrations();
      const steamInteg = integrations.find((i) => i.storefrontId === 'steam' && i.isConnected);
      const steamId = steamInteg?.credentials?.steamId || steamInteg?.accountId || '';
      const apiKey = steamInteg?.credentials?.apiKey;
      return { steamId, apiKey };
    } catch {
      return { steamId: '' };
    }
  }

  private getCommunityBaseUrl(): string {
    return getDevProxyBaseForRoute('steamCommunity');
  }

  private getApiBaseUrl(): string {
    return getDevProxyBaseForRoute('steamApi');
  }

  /**
   * Reads cached achievements from the unified AchievementSummaryStore or verified baseline.
   */
  getCachedAchievements(appId: number): StoreAchievementSummary | null {
    if (!Number.isFinite(appId) || appId <= 0) return null;
    const found = achievementSummaryStore.get('steam', Math.trunc(appId));
    if (found && typeof found.unlocked === 'number' && typeof found.total === 'number') {
      return {
        unlocked: found.unlocked,
        total: found.total,
        percentage:
          found.percentage ??
          (found.total > 0 ? Math.round((found.unlocked / found.total) * 100) : 0),
        isMastered: found.total > 0 && found.unlocked >= found.total,
        ...(found.lastUnlockedAt ? { lastUnlockedAt: found.lastUnlockedAt } : {}),
        source: found.source || 'local_client_cache',
        syncedAt: found.syncedAt,
        hasConflict: found.hasConflict,
        conflictDetails: found.conflictDetails,
      };
    }

    // Check verified built-in user baseline
    if (KNOWN_USER_STEAM_ACHIEVEMENTS[appId]) {
      const b = KNOWN_USER_STEAM_ACHIEVEMENTS[appId];
      return {
        unlocked: b.unlocked,
        total: b.total,
        percentage: b.percentage,
        isMastered: b.total > 0 && b.unlocked >= b.total,
        ...(b.lastUnlockedAt ? { lastUnlockedAt: b.lastUnlockedAt } : {}),
        source: 'baseline_fallback',
      };
    }

    return null;
  }

  /**
   * Caches an achievement record in the unified store and schedules a debounced persistent flush.
   */
  setCachedAchievement(appId: number, summary: StoreAchievementSummary): void {
    if (!Number.isFinite(appId) || appId <= 0) return;
    achievementSummaryStore.set('steam', Math.trunc(appId), summary, {
      immediate: false,
      reconcile: false,
    });
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
            p.achievements.hasConflict !== reconciled.hasConflict ||
            p.achievements.lastUnlockedAt !== reconciled.lastUnlockedAt)
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
    explicitApiKey?: string,
    priority: number = Priority.LOW
  ): Promise<StoreAchievementSummary | null> {
    const creds = this.getActiveSteamCredentials();
    const steamId = explicitSteamId || creds.steamId;
    const apiKey = explicitApiKey || creds.apiKey;
    const existingCached = this.getCachedAchievements(appId) || undefined;

    const gameKey = `steam:${appId}`;

    // 1. If Steam Web API key is configured, try ISteamUserStats/GetPlayerAchievements
    if (apiKey && steamId) {
      try {
        const url = `${this.getApiBaseUrl()}/ISteamUserStats/GetPlayerAchievements/v0001/?appid=${encodeURIComponent(
          String(appId)
        )}&key=${encodeURIComponent(apiKey)}&steamid=${encodeURIComponent(steamId)}`;
        const canonicalApiUrl = `https://api.steampowered.com/ISteamUserStats/GetPlayerAchievements/v0001/?appid=${appId}`;
        const res = await requestScheduler.schedule(
          canonicalApiUrl,
          () =>
            axios.get<{
              playerstats?: {
                achievements?: Array<{ achieved?: number; unlocktime?: number }>;
                error?: string;
              };
            }>(url, { timeout: 5000 }),
          priority,
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
          const unlockedItems = list.filter((a) => a.achieved === 1);
          const unlocked = unlockedItems.length;
          let maxUnlockSec = 0;
          for (const item of unlockedItems) {
            if (typeof item.unlocktime === 'number' && item.unlocktime > maxUnlockSec) {
              maxUnlockSec = item.unlocktime;
            }
          }
          const lastUnlockedAt =
            maxUnlockSec > 0 ? new Date(maxUnlockSec * 1000).toISOString() : undefined;
          const percentage = total > 0 ? Math.round((unlocked / total) * 100) : 0;
          const liveSummary: StoreAchievementSummary = {
            unlocked,
            total,
            percentage,
            isMastered: total > 0 && unlocked >= total,
            ...(lastUnlockedAt ? { lastUnlockedAt } : {}),
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
        const pathSegment = isNumeric
          ? `profiles/${steamId}`
          : `id/${encodeURIComponent(steamId)}`;
        const url = `${this.getCommunityBaseUrl()}/${pathSegment}/stats/${appId}/?xml=1`;
        const canonicalXmlUrl = `https://steamcommunity.com/${pathSegment}/stats/${appId}/?xml=1`;
        const res = await requestScheduler.schedule(
          canonicalXmlUrl,
          () => axios.get<string>(url, { timeout: 6000, responseType: 'text' }),
          priority,
          'steamcommunity.com',
          gameKey
        );
        let xml = typeof res.data === 'string' ? res.data : '';

        // Older Steam titles with a custom Steam Community friendlyURL redirect stripping ?xml=1
        if (!xml.includes('<achievements>') && !xml.includes('<achievement closed=')) {
          const htmlSummaryMatch =
            xml.match(
              /id="topSummaryAchievements"[^>]*>\s*(\d+)\s+of\s+(\d+)\s+\(\d+%\)\s+Achievements\s+Earned/i
            ) ||
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
                priority,
                'steamcommunity.com',
                gameKey
              );
              if (typeof friendlyRes.data === 'string') {
                xml = friendlyRes.data;
              }
            } catch {
              // Ignore friendly redirect retry errors
            }
          }
        }

        if (xml.includes('<achievements>') || xml.includes('<achievement closed=')) {
          const allMatches = xml.match(/<achievement closed="/g) || [];
          const unlockedMatches = xml.match(/<achievement closed="1">/g) || [];
          const total = allMatches.length;
          const unlocked = unlockedMatches.length;

          // Extract latest unlockTimestamp from XML if present
          let maxUnlockSec = 0;
          if (unlocked > 0) {
            const tsRegex = /<unlockTimestamp>(\d+)<\/unlockTimestamp>/gi;
            let tsMatch: RegExpExecArray | null;
            while ((tsMatch = tsRegex.exec(xml)) !== null) {
              const sec = Number.parseInt(tsMatch[1], 10);
              if (Number.isFinite(sec) && sec > maxUnlockSec) {
                maxUnlockSec = sec;
              }
            }
          }
          const lastUnlockedAt =
            maxUnlockSec > 0 ? new Date(maxUnlockSec * 1000).toISOString() : undefined;

          // Note: total > 0 is valid authoritative data even if unlocked is 0
          if (total > 0 || unlocked > 0) {
            const percentage = total > 0 ? Math.round((unlocked / total) * 100) : 0;
            const liveSummary: StoreAchievementSummary = {
              unlocked,
              total,
              percentage,
              isMastered: total > 0 && unlocked >= total,
              ...(lastUnlockedAt ? { lastUnlockedAt } : {}),
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
   * Single-flight guarded per startup window so concurrent callers share one batch Web API pass.
   */
  async syncUserLibraryAchievements(
    games: CanonicalGame[],
    onProgress?: (completed: number, total: number, currentTitle?: string) => void,
    options?: {
      forceRefresh?: boolean;
      includeUnplayed?: boolean;
      priority?: number;
      onBatchUpdated?: (partialResults: Record<number, StoreAchievementSummary>) => void;
    }
  ): Promise<Record<number, StoreAchievementSummary>> {
    if (!options?.forceRefresh && this.inFlightLibrarySyncPromise) {
      return this.inFlightLibrarySyncPromise;
    }

    const steamGames = games.filter((g) =>
      Boolean(g.steamAppId && g.platforms.some((p) => p.platformId === 'steam'))
    );
    if (steamGames.length === 0) return {};

    if (!options?.forceRefresh && this.hasRecentFullSync()) {
      const cachedMap: Record<number, StoreAchievementSummary> = {};
      for (const game of steamGames) {
        if (!game.steamAppId) continue;
        const cached = this.getCachedAchievements(game.steamAppId);
        if (cached) {
          cachedMap[game.steamAppId] = cached;
        }
      }
      onProgress?.(steamGames.length, steamGames.length);
      return cachedMap;
    }

    const flight = this.runSyncUserLibraryAchievementsInternal(steamGames, onProgress, options);
    if (!options?.forceRefresh) {
      this.inFlightLibrarySyncPromise = flight;
    }
    try {
      return await flight;
    } finally {
      if (this.inFlightLibrarySyncPromise === flight) {
        this.inFlightLibrarySyncPromise = null;
      }
    }
  }

  private async runSyncUserLibraryAchievementsInternal(
    steamGames: CanonicalGame[],
    onProgress?: (completed: number, total: number, currentTitle?: string) => void,
    options?: {
      forceRefresh?: boolean;
      includeUnplayed?: boolean;
      priority?: number;
      onBatchUpdated?: (partialResults: Record<number, StoreAchievementSummary>) => void;
    }
  ): Promise<Record<number, StoreAchievementSummary>> {
    const creds = this.getActiveSteamCredentials();
    let activeSteamId = creds.steamId;
    const results: Record<number, StoreAchievementSummary> = {};

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
            if (
              !Number.isFinite(appId) ||
              appId <= 0 ||
              !data ||
              typeof data.unlocked !== 'number' ||
              typeof data.total !== 'number'
            ) {
              continue;
            }
            if (data.total <= 0 && data.unlocked <= 0) continue;
            const existing = this.getCachedAchievements(appId) || undefined;
            const rawLastUnlockedAt = (data as { lastUnlockedAt?: unknown }).lastUnlockedAt;
            const incoming: StoreAchievementSummary = {
              unlocked: data.unlocked,
              total: data.total,
              percentage:
                data.percentage ??
                (data.total > 0 ? Math.round((data.unlocked / data.total) * 100) : 0),
              isMastered:
                Boolean(data.isMastered) || (data.total > 0 && data.unlocked >= data.total),
              ...(typeof rawLastUnlockedAt === 'string' && rawLastUnlockedAt
                ? { lastUnlockedAt: rawLastUnlockedAt }
                : {}),
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
            // Mark batch Web API sync completed only when at least one game resolved
            this.recordFullSyncCompleted();
          }
        }
      } catch {
        // Fall through to Community XML sync
      }
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
    const prioritized = candidatesForXml.toSorted((a, b) => {
      const aPlaytime = a.platforms.find((p) => p.platformId === 'steam')?.playtimeMinutes || 0;
      const bPlaytime = b.platforms.find((p) => p.platformId === 'steam')?.playtimeMinutes || 0;
      return bPlaytime - aPlaytime;
    });

    if (prioritized.length === 0) {
      onProgress?.(steamGames.length, steamGames.length);
      if (Object.keys(results).length > 0 || steamGames.length === 0) {
        this.recordFullSyncCompleted();
      }
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
              Date.now() - Date.parse(cached.syncedAt) < 6 * 3600 * 1000
            ) {
              results[game.steamAppId] = cached;
              return;
            }
            const ach = await this.fetchPlayerGameAchievements(
              game.steamAppId,
              activeSteamId,
              creds.apiKey,
              options?.priority ?? Priority.LOW
            );
            if (ach) {
              results[game.steamAppId] = ach;
              batchAdded = true;
            }
          } catch {
            // Skip failed title and continue batch
          }
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
      const batchToMerge: Record<string, StoreAchievementSummary> = {};
      for (const [appIdKey, summary] of Object.entries(results)) {
        batchToMerge[appIdKey] = summary;
      }
      achievementSummaryStore.mergeBatch('steam', batchToMerge, { immediate: true });
    }

    // P0-4: Never stamp 6-hour cooldown when every request failed offline / rate-limited!
    if (Object.keys(results).length > 0 || steamGames.length === 0) {
      this.recordFullSyncCompleted();
    }

    return results;
  }
}

export const steamAchievementsService = new SteamAchievementsService();
