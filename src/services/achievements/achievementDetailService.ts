import axios from 'axios';
import { CanonicalGame, GamePlatformOwnership, StoreAchievementSummary } from '../../contracts/game';
import {
  DetailedAchievement,
  StorefrontAchievementsData,
  MultiStoreAchievementsMap,
  AchievementRarityTier,
  AchievementProgress,
} from '../../contracts/achievement';
import { requestScheduler, RequestPriority } from '../network/requestScheduler';
import { onlineLifecycleManager } from '../network/onlineLifecycleManager';
import { vaultGet, vaultSet } from '../storage/indexedDbVault';
import { steamAchievementsService } from '../steam/steamAchievementsService';
import { steamMatcher } from '../steam/steamMatcher';
import {
  KNOWN_USER_STEAM_ACHIEVEMENTS,
  KNOWN_USER_GOG_ACHIEVEMENTS,
  KNOWN_USER_EPIC_ACHIEVEMENTS,
  KNOWN_USER_XBOX_ACHIEVEMENTS,
  getKnownSteamAchievements,
  getKnownGogAchievements,
  getKnownEpicAchievements,
  getKnownXboxAchievements,
} from '../storage/knownGameAchievements';
import knownAchievementsJson from '../storage/knownGameAchievements.json';

interface SteamGlobalPctItem {
  name?: string;
  percent?: string | number;
}

interface RawRewardItem {
  type?: string;
  value?: string | number;
}

interface RawMediaAsset {
  url?: string;
}

interface RawStoreAchievementRecord {
  id?: string;
  apiName?: string;
  achievementId?: string;
  achievement_id?: string;
  achievement_key?: string;
  name?: string;
  title?: string;
  unlockedDisplayName?: string;
  description?: string;
  unlockedDescription?: string;
  lockedDescription?: string;
  unlocked?: boolean;
  isUnlocked?: boolean;
  progressState?: string;
  state?: string;
  unlockedAt?: string | number;
  date_unlocked?: string | number | null;
  progression?: { timeUnlocked?: string };
  iconUnlockedUrl?: string;
  unlockedIconUrl?: string;
  image_url_unlocked?: string;
  iconLockedUrl?: string;
  lockedIconUrl?: string;
  image_url_locked?: string;
  mediaAssets?: RawMediaAsset[];
  globalPercentage?: number;
  rarityPercent?: number;
  rarity?: number | { currentPercentage?: number };
  xp?: number;
  gamerscore?: number;
  rewards?: RawRewardItem[];
  progress?: AchievementProgress;
  hidden?: boolean;
  isHidden?: boolean;
  isSecret?: boolean;
  visible?: boolean;
}

interface StoreAchievementsEnvelope {
  achievements?: RawStoreAchievementRecord[];
  items?: RawStoreAchievementRecord[];
  totalCount?: number;
  unlockedCount?: number;
  totalGamerscore?: number;
  earnedGamerscore?: number;
  gamerscore?: { earned?: number; total?: number };
  totalXp?: number;
  earnedXp?: number;
  xp?: { earned?: number; total?: number };
  syncedAt?: string;
}

function getErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function normalizeAchievementMatchKey(raw?: string | number | null): string {
  if (raw === undefined || raw === null) return '';
  return String(raw)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

function isViteBrowserDev(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.location !== 'undefined' &&
    window.location.protocol.startsWith('http') &&
    (window.location.port === '3000' || window.location.port === '5173') &&
    typeof navigator !== 'undefined' &&
    !navigator.userAgent?.includes('jsdom') &&
    !navigator.userAgent?.includes('Node')
  );
}

/**
 * Classifies an achievement's rarity tier based on global unlock percentage.
 */
export function classifyRarityTier(percentage?: number | null): AchievementRarityTier {
  if (percentage === undefined || percentage === null || isNaN(percentage)) {
    return 'common';
  }
  if (percentage < 10.0) return 'ultra_rare';
  if (percentage < 25.0) return 'rare';
  if (percentage < 50.0) return 'uncommon';
  return 'common';
}

/**
 * Parses XML CDATA or plain text safely.
 */
function extractXmlTag(xml: string, tag: string): string {
  const cdataRegex = new RegExp(`<${tag}><!\\[CDATA\\[([\\s\\S]*?)\\]\\]><\\/${tag}>`, 'i');
  const cdataMatch = xml.match(cdataRegex);
  if (cdataMatch) return cdataMatch[1].trim();

  const plainRegex = new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`, 'i');
  const plainMatch = xml.match(plainRegex);
  if (plainMatch) return plainMatch[1].trim();

  return '';
}

function extractLiveAchievementsList(
  raw: unknown
): { list: RawStoreAchievementRecord[] | null; envelope: StoreAchievementsEnvelope | null } {
  if (Array.isArray(raw)) {
    return { list: raw as RawStoreAchievementRecord[], envelope: null };
  }
  if (raw && typeof raw === 'object') {
    const env = raw as StoreAchievementsEnvelope;
    if (Array.isArray(env.achievements)) {
      return { list: env.achievements, envelope: env };
    }
    if (Array.isArray(env.items)) {
      return { list: env.items, envelope: env };
    }
    return { list: null, envelope: env };
  }
  return { list: null, envelope: null };
}

export class AchievementDetailService {
  public static readonly MAX_MEMORY_CACHE_ENTRIES = 60;
  private inMemoryCache = new Map<string, MultiStoreAchievementsMap>();
  private schemaCache = new Map<string, DetailedAchievement[]>();

  public get memoryCache(): Map<string, MultiStoreAchievementsMap> {
    return this.inMemoryCache;
  }

  private setMemoryCacheEntry(gameId: string, data: MultiStoreAchievementsMap): void {
    if (this.inMemoryCache.has(gameId)) {
      this.inMemoryCache.delete(gameId);
    }
    this.inMemoryCache.set(gameId, data);
    while (this.inMemoryCache.size > AchievementDetailService.MAX_MEMORY_CACHE_ENTRIES) {
      const oldestKey = this.inMemoryCache.keys().next().value;
      if (oldestKey === undefined) break;
      this.inMemoryCache.delete(oldestKey);
    }
  }

  private setSchemaCacheEntry(cacheKey: string, schema: DetailedAchievement[]): void {
    if (this.schemaCache.has(cacheKey)) {
      this.schemaCache.delete(cacheKey);
    }
    this.schemaCache.set(cacheKey, schema);
    while (this.schemaCache.size > AchievementDetailService.MAX_MEMORY_CACHE_ENTRIES) {
      const oldestKey = this.schemaCache.keys().next().value;
      if (oldestKey === undefined) break;
      this.schemaCache.delete(oldestKey);
    }
  }

  private getCommunityBaseUrl(): string {
    if (isViteBrowserDev()) {
      return '/api/steam-community';
    }
    return 'https://steamcommunity.com';
  }

  private getSteamApiBaseUrl(): string {
    if (isViteBrowserDev()) {
      return '/api/steam-api';
    }
    return 'https://api.steampowered.com';
  }

  /**
   * Clears in-memory cache.
   */
  clearCache(): void {
    this.inMemoryCache.clear();
    this.schemaCache.clear();
  }

  /**
   * Loads cached detailed achievements from localStorage.
   */
  getCachedMultiStoreAchievements(gameId: string): MultiStoreAchievementsMap | null {
    if (this.inMemoryCache.has(gameId)) {
      const hit = this.inMemoryCache.get(gameId)!;
      this.setMemoryCacheEntry(gameId, hit);
      return hit;
    }

    if (typeof localStorage !== 'undefined') {
      try {
        const raw = localStorage.getItem(`antigravity_detailed_achievements_${gameId}`);
        if (raw) {
          const parsed: unknown = JSON.parse(raw);
          if (parsed && typeof parsed === 'object') {
            const typed = parsed as MultiStoreAchievementsMap;
            this.setMemoryCacheEntry(gameId, typed);
            return typed;
          }
        }
      } catch {}
    }
    return null;
  }

  /**
   * Persists detailed achievements to memory, IndexedDB vault, and localStorage.
   */
  setCachedMultiStoreAchievements(gameId: string, data: MultiStoreAchievementsMap): void {
    if (!data || Object.keys(data).length === 0) return;
    if (Object.values(data).some((entry) => entry?.schemaUnavailableOffline === true)) {
      return;
    }
    this.setMemoryCacheEntry(gameId, data);
    void vaultSet(`detailed_achievements:${gameId}`, data);
    if (typeof window !== 'undefined' && window.electronAPI?.offlineVault?.saveGameDetail) {
      try {
        void window.electronAPI.offlineVault
          .saveGameDetail({ gameId, achievements: data })
          ?.catch?.(() => {});
      } catch {}
    }
    if (typeof localStorage !== 'undefined') {
      try {
        localStorage.setItem(`antigravity_detailed_achievements_${gameId}`, JSON.stringify(data));
      } catch {
        // QuotaExceededError: detailed schema remains persisted in IndexedDB vault
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
    const vaultHit = await vaultGet<MultiStoreAchievementsMap>(`detailed_achievements:${gameId}`);
    if (
      vaultHit &&
      typeof vaultHit === 'object' &&
      Object.keys(vaultHit).length > 0 &&
      !Object.values(vaultHit).some((s) => s?.schemaUnavailableOffline)
    ) {
      this.setMemoryCacheEntry(gameId, vaultHit);
      return vaultHit;
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
          this.setMemoryCacheEntry(gameId, vaultAch);
          return vaultAch;
        }
      } catch {}
    }
    return null;
  }

  /**
   * Fetches global achievement percentages for a Steam Game.
   */
  async fetchSteamGlobalPercentages(appId: number): Promise<Map<string, number>> {
    const map = new Map<string, number>();
    try {
      const url = `${this.getSteamApiBaseUrl()}/ISteamUserStats/GetGlobalAchievementPercentagesForApp/v0002/?gameid=${appId}`;
      const res = await requestScheduler.schedule(
        url,
        () => axios.get(url, { timeout: 6000 }),
        RequestPriority.P0_INTERACTIVE,
        'api.steampowered.com'
      );
      const list = (
        res.data as { achievementpercentages?: { achievements?: SteamGlobalPctItem[] } } | undefined
      )?.achievementpercentages?.achievements;
      if (Array.isArray(list)) {
        for (const item of list) {
          if (item.name) {
            const pct = parseFloat(String(item.percent ?? ''));
            const rounded = !isNaN(pct) ? Math.round(pct * 10) / 10 : 0;
            map.set(item.name.toLowerCase(), rounded);
          }
        }
      }
    } catch (err: unknown) {
      console.warn(
        `[AchievementDetailService] Global percentages fetch warning for Steam ${appId}:`,
        getErrorMessage(err)
      );
    }
    return map;
  }

  /**
   * Resolves canonical achievement definitions for a game across all storefronts.
   * Ensures games owned on GOG or Epic have complete sets of possible achievements
   * even when unplayed by the user.
   */
  async getCanonicalGameSchema(game: CanonicalGame): Promise<DetailedAchievement[]> {
    if (!game) return [];
    const titleLower = (game.title || '').toLowerCase().trim();

    // Check schema memory cache
    const cacheKey = game.steamAppId ? `id:${game.steamAppId}` : `title:${titleLower}`;
    if (this.schemaCache.has(cacheKey)) {
      const hit = this.schemaCache.get(cacheKey)!;
      this.setSchemaCacheEntry(cacheKey, hit);
      return hit;
    }

    if (!onlineLifecycleManager.isOnline()) {
      return [];
    }

    // Dynamic resolution via Steam AppID (either explicit or matched from title across GOG/Epic)
    const appId = game.steamAppId || steamMatcher.matchGameToSteamInstant(game.title);
    if (appId) {
      // Check known zero-achievement status
      const knownCount = (knownAchievementsJson as Record<string, number>)[String(appId)];
      if (knownCount === 0) {
        this.setSchemaCacheEntry(cacheKey, []);
        return [];
      }

      // Try fetching live public Steam community achievements HTML (zero-auth public schema)
      try {
        const liveHtmlUrl = `${this.getCommunityBaseUrl()}/stats/${appId}/achievements/`;
        const res = await requestScheduler.schedule(
          liveHtmlUrl,
          () => axios.get(liveHtmlUrl, { timeout: 4000, responseType: 'text' }),
          RequestPriority.P0_INTERACTIVE,
          'steamcommunity.com'
        );
        const html = typeof res.data === 'string' ? res.data : '';
        if (html.includes('achieveRow')) {
          const parsed = this.parseSteamCommunityHtml(html, appId);
          if (parsed.length > 0) {
            this.setSchemaCacheEntry(cacheKey, parsed);
            return parsed;
          }
        }
      } catch (err: unknown) {
        console.warn(
          `[AchievementDetailService] Live public schema fetch warning for AppID ${appId}:`,
          getErrorMessage(err)
        );
      }

      // Secondary zero-auth official fallback: ISteamUserStats/GetGlobalAchievementPercentagesForApp/v0002/
      try {
        const url = `${this.getSteamApiBaseUrl()}/ISteamUserStats/GetGlobalAchievementPercentagesForApp/v0002/?gameid=${appId}`;
        const apiRes = await requestScheduler.schedule(
          url,
          () => axios.get(url, { timeout: 6000 }),
          RequestPriority.P0_INTERACTIVE,
          'api.steampowered.com'
        );
        const apiList = (
          apiRes.data as { achievementpercentages?: { achievements?: SteamGlobalPctItem[] } } | undefined
        )?.achievementpercentages?.achievements;
        if (Array.isArray(apiList) && apiList.length > 0) {
          const parsedFromApi: DetailedAchievement[] = apiList.map(
            (item: SteamGlobalPctItem, idx: number) => {
              const rawApiName = String(item.name || `ACH_${idx + 1}`);
              const strippedApi = rawApiName.replace(/^ACH_/i, '');
              const rawPct = parseFloat(String(item.percent ?? ''));
              const pctVal = !isNaN(rawPct) ? Math.round(rawPct * 10) / 10 : undefined;
              const humanName = strippedApi
                .replace(/_/g, ' ')
                .replace(/([a-z])([A-Z])/g, '$1 $2')
                .replace(/\b\w/g, (c) => c.toUpperCase());
              const iconUrl = `https://shared.fastly.steamstatic.com/community_assets/images/apps/${appId}/header.jpg`;

              return {
                id: `steam:${appId}:${rawApiName.toLowerCase().replace(/[^a-z0-9]/g, '_')}`,
                apiName: rawApiName,
                name: humanName,
                description: undefined,
                unlocked: false,
                iconUnlockedUrl: iconUrl,
                iconLockedUrl: iconUrl,
                globalPercentage: pctVal,
                rarityTier: pctVal !== undefined ? classifyRarityTier(pctVal) : undefined,
                isSecret: false,
                storefrontId: 'steam',
              };
            }
          );
          this.setSchemaCacheEntry(cacheKey, parsedFromApi);
          return parsedFromApi;
        }
      } catch {}
    }

    return [];
  }

  private parseSteamCommunityHtml(html: string, appId: number): DetailedAchievement[] {
    const results: DetailedAchievement[] = [];
    const rowMatches = html.split(/<div class="achieveRow\s*"/i);
    for (let i = 1; i < rowMatches.length; i++) {
      const block = rowMatches[i];
      const imgMatch = block.match(/<img[^>]+src="([^">]+)"/i);
      const nameMatch = block.match(/<h3>([^<]+)<\/h3>/i);
      const descMatch = block.match(/<h5>([^<]*)<\/h5>/i);
      const pctMatch = block.match(/<div class="achievePercent">([0-9.]+)%<\/div>/i);

      if (nameMatch) {
        const name = nameMatch[1].trim();
        const desc = descMatch ? descMatch[1].trim() : '';
        const icon = imgMatch
          ? imgMatch[1].trim()
          : `https://shared.fastly.steamstatic.com/community_assets/images/apps/${appId}/header.jpg`;
        const pctVal = pctMatch ? parseFloat(pctMatch[1]) : undefined;

        results.push({
          id: `steam:${appId}:${name.toLowerCase().replace(/[^a-z0-9]/g, '_')}`,
          apiName: name.toUpperCase().replace(/[^A-Z0-9]/g, '_'),
          name,
          description: desc || undefined,
          unlocked: false,
          iconUnlockedUrl: icon,
          iconLockedUrl: icon,
          globalPercentage: pctVal,
          rarityTier: pctVal !== undefined ? classifyRarityTier(pctVal) : undefined,
          isSecret: !desc,
          storefrontId: 'steam',
        });
      }
    }
    return results;
  }

  /**
   * Fetches detailed Steam achievements using Community Stats XML + Global Rarity.
   */
  async fetchSteamDetailedAchievements(
    appId: number,
    gameTitle: string,
    existingSummary?: StoreAchievementSummary,
    canonicalSchema?: DetailedAchievement[]
  ): Promise<StorefrontAchievementsData | null> {
    const knownJsonCount = (knownAchievementsJson as Record<string, number>)[String(appId)];
    if (knownJsonCount === 0) {
      return {
        storefrontId: 'steam',
        storefrontName: 'Steam',
        total: 0,
        unlocked: 0,
        percentage: 0,
        isMastered: false,
        achievements: [],
        supportsAchievements: false,
        source: 'schema_fallback',
        unlockPrecision: 'exact',
      };
    }

    if (onlineLifecycleManager.isOnline()) {
      const creds = steamAchievementsService.getActiveSteamCredentials();
      const steamId = creds.steamId;

      let globalPercentages = new Map<string, number>();
      try {
        globalPercentages = await this.fetchSteamGlobalPercentages(appId);
      } catch {}

      if (steamId) {
        const isNumeric = /^\d{17}$/.test(steamId);
        const pathSegment = isNumeric ? `profiles/${steamId}` : `id/${steamId}`;
        const xmlUrl = `${this.getCommunityBaseUrl()}/${pathSegment}/stats/${appId}/?xml=1`;

        try {
          const res = await requestScheduler.schedule(
            xmlUrl,
            () => axios.get(xmlUrl, { timeout: 8000, responseType: 'text' }),
            RequestPriority.P0_INTERACTIVE,
            'steamcommunity.com'
          );
          let xml = typeof res.data === 'string' ? res.data : '';

          // Handle older Steam titles with custom Steam Community friendlyURL redirects (e.g. 20920 -> TheWitcher2)
          if (!xml.includes('<achievement closed=') && !xml.includes('<achievements>')) {
            const friendlyMatch = xml.match(/steamcommunity\.com\/stats\/([^/"'?]+)\/achievements/i);
            if (friendlyMatch?.[1]) {
              try {
                const friendlyUrl = `${this.getCommunityBaseUrl()}/${pathSegment}/stats/${encodeURIComponent(friendlyMatch[1])}/?xml=1`;
                const friendlyRes = await requestScheduler.schedule(
                  friendlyUrl,
                  () => axios.get(friendlyUrl, { timeout: 8000, responseType: 'text' }),
                  RequestPriority.P0_INTERACTIVE,
                  'steamcommunity.com'
                );
                if (typeof friendlyRes.data === 'string') {
                  xml = friendlyRes.data;
                }
              } catch {}
            }
          }

          if (xml.includes('<achievement closed=') || xml.includes('<achievements>')) {
            const achievementBlocks = xml.split('<achievement closed="');
            const achievements: DetailedAchievement[] = [];

            for (let i = 1; i < achievementBlocks.length; i++) {
              const rawBlock = achievementBlocks[i];
              const isClosed = rawBlock.charAt(0) === '1';
              const innerBlock = rawBlock.substring(rawBlock.indexOf('>') + 1);

              const name = extractXmlTag(innerBlock, 'name');
              const apiName = extractXmlTag(innerBlock, 'apiname');
              const description = extractXmlTag(innerBlock, 'description');
              const iconClosed = extractXmlTag(innerBlock, 'iconClosed');
              const iconOpen = extractXmlTag(innerBlock, 'iconOpen');
              const unlockTimestampRaw = extractXmlTag(innerBlock, 'unlockTimestamp');
              const unlockTimestamp = unlockTimestampRaw ? parseInt(unlockTimestampRaw, 10) : undefined;

              let progress: DetailedAchievement['progress'] = undefined;
              const progressMatch = innerBlock.match(/<progress[^>]*>(\d+)\s*\/\s*(\d+)<\/progress>/i);
              if (progressMatch) {
                const current = parseInt(progressMatch[1], 10);
                const max = parseInt(progressMatch[2], 10);
                progress = {
                  current,
                  max,
                  percentage: max > 0 ? Math.round((current / max) * 100) : 0,
                };
              }

              const cleanKey = (apiName || name).toLowerCase().replace(/[^a-z0-9]/g, '');
              let globalPct: number | undefined = undefined;
              for (const [k, v] of globalPercentages.entries()) {
                if (k.replace(/[^a-z0-9]/g, '') === cleanKey) {
                  globalPct = v;
                  break;
                }
              }

              achievements.push({
                id: `steam:${appId}:${apiName || name}`,
                apiName: apiName || name,
                name: name || apiName || `Achievement #${i}`,
                description: description || undefined,
                unlocked: isClosed,
                unlockedAt: unlockTimestamp && unlockTimestamp > 0 ? unlockTimestamp * 1000 : undefined,
                iconUnlockedUrl: iconClosed || iconOpen,
                iconLockedUrl: iconOpen || iconClosed,
                globalPercentage: globalPct,
                rarityTier: globalPct !== undefined ? classifyRarityTier(globalPct) : undefined,
                progress,
                isSecret: !description && !name,
                storefrontId: 'steam',
              });
            }

            const total = achievements.length;
            const unlocked = achievements.filter((a) => a.unlocked).length;
            const percentage = total > 0 ? Math.round((unlocked / total) * 100) : 0;

            return {
              storefrontId: 'steam',
              storefrontName: 'Steam',
              total,
              unlocked,
              percentage,
              isMastered: total > 0 && unlocked >= total,
              achievements,
              syncedAt: new Date().toISOString(),
              source: 'live_cloud',
              unlockPrecision: 'exact',
              supportsAchievements: true,
            };
          }
        } catch (err: unknown) {
          console.warn(
            `[AchievementDetailService] Steam XML stats fetch failed for ${appId}:`,
            getErrorMessage(err)
          );
        }
      }
    }

    // Fallback: If live XML failed or profile is private, use canonical schema without fabricating per-item unlocks
    const schema =
      canonicalSchema && canonicalSchema.length > 0
        ? canonicalSchema
        : onlineLifecycleManager.isOnline()
          ? await this.getCanonicalGameSchema({
              id: `steam-${appId}`,
              title: gameTitle,
              sortTitle: gameTitle,
              steamAppId: appId,
              platforms: [],
              headerImage: '',
              capsuleImage: '',
              developers: [],
              publishers: [],
              genres: [],
              tags: [],
            })
          : [];

    const knownUser =
      getKnownSteamAchievements(appId) ||
      steamAchievementsService.getCachedAchievements(appId) ||
      KNOWN_USER_STEAM_ACHIEVEMENTS[appId];
    const unlockedCount = Math.max(existingSummary?.unlocked ?? 0, knownUser ? knownUser.unlocked : 0);
    const totalCount =
      schema.length > 0
        ? schema.length
        : existingSummary?.total ??
          (knownUser ? knownUser.total : typeof knownJsonCount === 'number' ? knownJsonCount : 0);

    if (schema.length > 0) {
      const achievements: DetailedAchievement[] = schema.map((baseAch, idx) => ({
        ...baseAch,
        id: `steam:${appId}:${baseAch.apiName || idx}`,
        unlocked: Boolean(baseAch.unlocked),
        unlockedAt: baseAch.unlockedAt,
        storefrontId: 'steam',
      }));

      const exactUnlocked = achievements.filter((a) => a.unlocked).length;
      const effectiveUnlocked = exactUnlocked > 0 ? exactUnlocked : unlockedCount;
      const unlockPrecision: 'exact' | 'summary_count_only' =
        effectiveUnlocked > 0 && exactUnlocked === 0 ? 'summary_count_only' : 'exact';
      const percentage = totalCount > 0 ? Math.round((effectiveUnlocked / totalCount) * 100) : 0;

      return {
        storefrontId: 'steam',
        storefrontName: 'Steam',
        total: totalCount,
        unlocked: effectiveUnlocked,
        percentage,
        isMastered: totalCount > 0 && effectiveUnlocked >= totalCount,
        achievements,
        syncedAt: existingSummary?.syncedAt || new Date().toISOString(),
        source: exactUnlocked > 0 ? 'live_cloud' : 'schema_fallback',
        unlockPrecision,
        supportsAchievements: true,
      };
    }

    const isOffline = !onlineLifecycleManager.isOnline();
    const hasKnownSteamAchievements = totalCount > 0 || unlockedCount > 0;
    const percentage = totalCount > 0 ? Math.round((unlockedCount / totalCount) * 100) : 0;
    return {
      storefrontId: 'steam',
      storefrontName: 'Steam',
      total: totalCount,
      unlocked: unlockedCount,
      percentage,
      isMastered: totalCount > 0 && unlockedCount >= totalCount,
      achievements: [],
      syncedAt: existingSummary?.syncedAt,
      source: 'schema_fallback',
      unlockPrecision: unlockedCount > 0 ? 'summary_count_only' : 'exact',
      supportsAchievements: hasKnownSteamAchievements || isOffline,
      schemaUnavailableOffline: hasKnownSteamAchievements || isOffline,
    };
  }

  /**
   * Fetches detailed Epic Games achievements without fabricating unlocks, rarity, or XP.
   */
  async fetchEpicDetailedAchievements(
    game: CanonicalGame,
    platformGameId?: string,
    existingSummary?: StoreAchievementSummary,
    canonicalSchema?: DetailedAchievement[]
  ): Promise<StorefrontAchievementsData | null> {
    const epicPlatform = game.platforms.find((p) => p.platformId === 'epic');
    const targetId = platformGameId || epicPlatform?.platformGameId || game.id;
    const titleLower = (game.title || '').toLowerCase().trim();
    const epicNamespace = (epicPlatform as GamePlatformOwnership & { namespace?: string } | undefined)
      ?.namespace;

    let schema: DetailedAchievement[] | null = null;
    let schemaHasAuthoritativeUnlocks = false;

    if (typeof window !== 'undefined' && window.electronAPI?.fetchEpicGameSchema) {
      try {
        const schemaRes = await window.electronAPI.fetchEpicGameSchema({
          appName: targetId,
          namespace: epicNamespace,
          title: game.title,
        });
        const { list: rawSchemaList } = extractLiveAchievementsList(schemaRes);
        if (rawSchemaList && rawSchemaList.length > 0) {
          schemaHasAuthoritativeUnlocks = rawSchemaList.some(
            (r) => typeof r.unlocked === 'boolean' || Boolean(r.unlockedAt)
          );
          schema = rawSchemaList.map((rawAch: RawStoreAchievementRecord, idx: number): DetailedAchievement => {
            const globalPct =
              typeof rawAch.globalPercentage === 'number'
                ? rawAch.globalPercentage
                : typeof rawAch.rarityPercent === 'number'
                  ? rawAch.rarityPercent
                  : typeof rawAch.rarity === 'number'
                    ? rawAch.rarity
                    : undefined;
            const unlockedIcon =
              rawAch.iconUnlockedUrl || rawAch.unlockedIconUrl || game.headerImage || '';
            return {
              id: rawAch.id || `epic:${targetId}:${rawAch.apiName || rawAch.achievementId || idx}`,
              apiName: String(rawAch.apiName || rawAch.achievementId || `EPIC_ACH_${idx + 1}`),
              name:
                rawAch.name ||
                rawAch.unlockedDisplayName ||
                rawAch.title ||
                `${game.title} Achievement #${idx + 1}`,
              description:
                rawAch.description ||
                rawAch.unlockedDescription ||
                rawAch.lockedDescription ||
                undefined,
              isSecret: Boolean(rawAch.hidden || rawAch.isHidden || rawAch.isSecret),
              unlocked: Boolean(rawAch.unlocked || rawAch.unlockedAt),
              unlockedAt: rawAch.unlockedAt || undefined,
              iconUnlockedUrl: unlockedIcon,
              iconLockedUrl: rawAch.iconLockedUrl || rawAch.lockedIconUrl || unlockedIcon,
              globalPercentage: globalPct,
              rarityTier: globalPct !== undefined ? classifyRarityTier(globalPct) : undefined,
              xp: typeof rawAch.xp === 'number' && Number.isFinite(rawAch.xp) ? rawAch.xp : undefined,
              storefrontId: 'epic',
            };
          });
        }
      } catch {
        // Fall back to canonical game schema
      }
    }

    const summary = existingSummary || epicPlatform?.achievements;
    const cachedUserEpic = getKnownEpicAchievements(targetId, game.title);
    const userEpic =
      (cachedUserEpic && (!summary || cachedUserEpic.unlocked >= (summary.unlocked || 0))
        ? cachedUserEpic
        : summary) ||
      KNOWN_USER_EPIC_ACHIEVEMENTS[targetId] ||
      KNOWN_USER_EPIC_ACHIEVEMENTS[`epic-${targetId}`] ||
      KNOWN_USER_EPIC_ACHIEVEMENTS[titleLower] ||
      summary;

    const summaryUnlockedCount = userEpic?.unlocked || 0;

    if (!schema || schema.length === 0) {
      schema =
        canonicalSchema && canonicalSchema.length > 0
          ? canonicalSchema
          : onlineLifecycleManager.isOnline()
            ? await this.getCanonicalGameSchema(game)
            : [];
    }

    if (!schema || schema.length === 0) {
      const fallbackTotal = userEpic?.total || 0;
      const fallbackPct = fallbackTotal > 0 ? Math.round((summaryUnlockedCount / fallbackTotal) * 100) : 0;
      const isOffline = !onlineLifecycleManager.isOnline();
      const hasKnownEpicAchievements =
        fallbackTotal > 0 ||
        summaryUnlockedCount > 0 ||
        (userEpic?.xp?.total ?? 0) > 0 ||
        (userEpic?.xp?.earned ?? 0) > 0;
      return {
        storefrontId: 'epic',
        storefrontName: 'Epic Games',
        total: fallbackTotal,
        unlocked: summaryUnlockedCount,
        percentage: fallbackPct,
        isMastered: fallbackTotal > 0 && summaryUnlockedCount >= fallbackTotal,
        ...(userEpic?.xp?.total !== undefined ? { totalXp: userEpic.xp.total } : {}),
        ...(userEpic?.xp?.earned !== undefined ? { earnedXp: userEpic.xp.earned } : {}),
        achievements: [],
        syncedAt: userEpic?.syncedAt,
        source: 'schema_fallback',
        unlockPrecision: summaryUnlockedCount > 0 ? 'summary_count_only' : 'exact',
        supportsAchievements: hasKnownEpicAchievements || isOffline,
        schemaUnavailableOffline: hasKnownEpicAchievements || isOffline,
      };
    }

    const totalCount = userEpic?.total && userEpic.total > 0 ? userEpic.total : schema.length;
    const effectiveSchema = totalCount < schema.length ? schema.slice(0, totalCount) : [...schema];

    let sumSchemaXp = 0;
    let sumEarnedSchemaXp = 0;
    let hasSchemaXp = false;

    const achievements: DetailedAchievement[] = effectiveSchema.map((baseAch, index) => {
      const isUnlocked = Boolean(baseAch.unlocked);
      const xpVal =
        typeof baseAch.xp === 'number' && Number.isFinite(baseAch.xp) ? baseAch.xp : undefined;

      if (xpVal !== undefined) {
        hasSchemaXp = true;
        sumSchemaXp += xpVal;
        if (isUnlocked) sumEarnedSchemaXp += xpVal;
      }

      return {
        ...baseAch,
        id: `epic:${targetId}:${baseAch.apiName || baseAch.name || index}`,
        unlocked: isUnlocked,
        unlockedAt: baseAch.unlockedAt,
        ...(xpVal !== undefined ? { xp: xpVal } : {}),
        storefrontId: 'epic',
      };
    });

    const exactUnlocked = achievements.filter((a) => a.unlocked).length;
    const hasExactUnlocks = schemaHasAuthoritativeUnlocks || exactUnlocked > 0;
    const effectiveUnlocked = hasExactUnlocks ? exactUnlocked : summaryUnlockedCount;
    const unlockPrecision: 'exact' | 'summary_count_only' =
      effectiveUnlocked > 0 && !hasExactUnlocks ? 'summary_count_only' : 'exact';
    const percentage = totalCount > 0 ? Math.round((effectiveUnlocked / totalCount) * 100) : 0;
    const isMastered = totalCount > 0 && effectiveUnlocked >= totalCount;

    const resolvedTotalXp = userEpic?.xp?.total ?? (hasSchemaXp ? sumSchemaXp : undefined);
    const resolvedEarnedXp =
      userEpic?.xp?.earned ?? (hasExactUnlocks && hasSchemaXp ? sumEarnedSchemaXp : undefined);

    return {
      storefrontId: 'epic',
      storefrontName: 'Epic Games',
      total: totalCount,
      unlocked: effectiveUnlocked,
      percentage,
      isMastered,
      ...(resolvedTotalXp !== undefined ? { totalXp: resolvedTotalXp } : {}),
      ...(resolvedEarnedXp !== undefined ? { earnedXp: resolvedEarnedXp } : {}),
      achievements,
      syncedAt: userEpic?.syncedAt || new Date().toISOString(),
      source: hasExactUnlocks ? 'live_cloud' : 'schema_fallback',
      unlockPrecision,
      supportsAchievements: true,
    };
  }

  /**
   * Fetches detailed GOG Galaxy achievements, reconciling live per-achievement unlock records
   * from `window.electronAPI.getStoreAchievements` against GOG / canonical schemas without fabrication.
   */
  async fetchGogDetailedAchievements(
    game: CanonicalGame,
    platformGameId?: string,
    existingSummary?: StoreAchievementSummary,
    canonicalSchema?: DetailedAchievement[]
  ): Promise<StorefrontAchievementsData | null> {
    const gogPlatform = game.platforms.find((p) => p.platformId === 'gog');
    const targetId = platformGameId || gogPlatform?.platformGameId || game.id;
    const titleLower = (game.title || '').toLowerCase().trim();

    const summary = existingSummary || gogPlatform?.achievements;
    const cachedUserGog = getKnownGogAchievements(targetId, game.title);
    const userGog =
      (cachedUserGog && (!summary || cachedUserGog.unlocked >= (summary.unlocked || 0))
        ? cachedUserGog
        : summary) ||
      KNOWN_USER_GOG_ACHIEVEMENTS[targetId] ||
      KNOWN_USER_GOG_ACHIEVEMENTS[`gog-${targetId}`] ||
      KNOWN_USER_GOG_ACHIEVEMENTS[titleLower] ||
      summary;

    // 1. Live GOG Gameplay API per-achievement records via Electron IPC getStoreAchievements
    let liveGogItems: RawStoreAchievementRecord[] | null = null;
    let liveGogEnvelope: StoreAchievementsEnvelope | null = null;

    if (typeof window !== 'undefined' && window.electronAPI?.getStoreAchievements) {
      try {
        const ipcFn = window.electronAPI.getStoreAchievements as unknown as (
          first: unknown,
          second?: unknown
        ) => Promise<unknown>;
        const rawLiveRes =
          ipcFn.length >= 2
            ? await ipcFn('gog', gogPlatform?.platformGameId || targetId)
            : await window.electronAPI.getStoreAchievements({
                platformId: 'gog',
                storefrontId: 'gog',
                gameId: game.id,
                platformGameId: gogPlatform?.platformGameId || targetId,
                title: game.title,
              });
        const extracted = extractLiveAchievementsList(rawLiveRes);
        liveGogItems = extracted.list;
        liveGogEnvelope = extracted.envelope;
      } catch {
        // Fall through to schema reconciliation
      }
    }

    const schema =
      canonicalSchema && canonicalSchema.length > 0
        ? canonicalSchema
        : onlineLifecycleManager.isOnline()
          ? await this.getCanonicalGameSchema(game)
          : [];

    if (liveGogItems && liveGogItems.length > 0) {
      // Build canonical enrichment lookup by key/name for any missing icons or descriptions
      const schemaByKey = new Map<string, DetailedAchievement>();
      for (const sAch of schema) {
        const k1 = normalizeAchievementMatchKey(sAch.apiName);
        const k2 = normalizeAchievementMatchKey(sAch.name);
        if (k1 && !schemaByKey.has(k1)) schemaByKey.set(k1, sAch);
        if (k2 && !schemaByKey.has(k2)) schemaByKey.set(k2, sAch);
      }

      const hasFullLiveSchema =
        liveGogItems.some((item) => !item.date_unlocked && !item.unlocked && !item.isUnlocked) ||
        liveGogItems.length >= Math.max(schema.length, userGog?.total || 0);

      if (hasFullLiveSchema || schema.length === 0) {
        const achievements: DetailedAchievement[] = liveGogItems.map(
          (rawAch: RawStoreAchievementRecord, idx: number): DetailedAchievement => {
            const rawKey = String(
              rawAch.achievement_key ||
                rawAch.apiName ||
                rawAch.achievement_id ||
                rawAch.achievementId ||
                rawAch.id ||
                `GOG_ACH_${idx + 1}`
            );
            const fallbackSchemaAch =
              schemaByKey.get(normalizeAchievementMatchKey(rawKey)) ||
              schemaByKey.get(normalizeAchievementMatchKey(rawAch.name || rawAch.title));

            const unlockedTimestamp = rawAch.date_unlocked ?? rawAch.unlockedAt ?? undefined;
            const isUnlocked = Boolean(
              rawAch.unlocked || rawAch.isUnlocked || Boolean(rawAch.date_unlocked)
            );
            const globalPct =
              typeof rawAch.rarity === 'number'
                ? rawAch.rarity
                : typeof rawAch.globalPercentage === 'number'
                  ? rawAch.globalPercentage
                  : typeof rawAch.rarityPercent === 'number'
                    ? rawAch.rarityPercent
                    : fallbackSchemaAch?.globalPercentage;
            const unlockedIcon =
              rawAch.image_url_unlocked ||
              rawAch.iconUnlockedUrl ||
              rawAch.unlockedIconUrl ||
              fallbackSchemaAch?.iconUnlockedUrl ||
              game.headerImage ||
              '';
            const lockedIcon =
              rawAch.image_url_locked ||
              rawAch.iconLockedUrl ||
              rawAch.lockedIconUrl ||
              fallbackSchemaAch?.iconLockedUrl ||
              unlockedIcon;

            return {
              id: `gog:${targetId}:${rawAch.achievement_id || rawKey || idx}`,
              apiName: rawKey,
              name:
                rawAch.name ||
                rawAch.title ||
                fallbackSchemaAch?.name ||
                `${game.title} Achievement #${idx + 1}`,
              description:
                rawAch.description ||
                rawAch.unlockedDescription ||
                rawAch.lockedDescription ||
                fallbackSchemaAch?.description ||
                undefined,
              unlocked: isUnlocked,
              unlockedAt: unlockedTimestamp || undefined,
              iconUnlockedUrl: unlockedIcon,
              iconLockedUrl: lockedIcon,
              globalPercentage: globalPct,
              rarityTier: globalPct !== undefined ? classifyRarityTier(globalPct) : undefined,
              isSecret:
                rawAch.visible === false ||
                Boolean(rawAch.isSecret || rawAch.hidden || rawAch.isHidden),
              storefrontId: 'gog',
            };
          }
        );

        const total =
          typeof liveGogEnvelope?.totalCount === 'number' &&
          liveGogEnvelope.totalCount >= achievements.length
            ? liveGogEnvelope.totalCount
            : achievements.length;
        const unlocked = achievements.filter((a) => a.unlocked).length;
        const percentage = total > 0 ? Math.round((unlocked / total) * 100) : 0;

        return {
          storefrontId: 'gog',
          storefrontName: 'GOG GALAXY',
          total,
          unlocked,
          percentage,
          isMastered: total > 0 && unlocked >= total,
          achievements,
          syncedAt: liveGogEnvelope?.syncedAt || new Date().toISOString(),
          source: 'live_cloud',
          unlockPrecision: 'exact',
          supportsAchievements: true,
        };
      }

      // Partial live unlock list: reconcile unlocked IDs/keys against canonical schema
      const unlockedLookup = new Map<string, string | number | undefined>();
      for (const rawAch of liveGogItems) {
        const isUnlocked = Boolean(
          rawAch.unlocked || rawAch.isUnlocked || Boolean(rawAch.date_unlocked)
        );
        if (!isUnlocked) continue;
        const ts = rawAch.date_unlocked ?? rawAch.unlockedAt ?? undefined;
        for (const candidateKey of [
          rawAch.achievement_id,
          rawAch.achievement_key,
          rawAch.apiName,
          rawAch.achievementId,
          rawAch.id,
          rawAch.name,
          rawAch.title,
        ]) {
          const normKey = normalizeAchievementMatchKey(candidateKey);
          if (normKey && !unlockedLookup.has(normKey)) {
            unlockedLookup.set(normKey, ts || undefined);
          }
        }
      }

      const reconciledAchievements: DetailedAchievement[] = schema.map((baseAch, index) => {
        const apiKey = normalizeAchievementMatchKey(baseAch.apiName);
        const nameKey = normalizeAchievementMatchKey(baseAch.name);
        const matchedUnlocked = unlockedLookup.has(apiKey) || unlockedLookup.has(nameKey);
        const matchedTs = unlockedLookup.get(apiKey) ?? unlockedLookup.get(nameKey);
        return {
          ...baseAch,
          id: `gog:${targetId}:${baseAch.apiName || baseAch.name || index}`,
          unlocked: matchedUnlocked,
          unlockedAt: matchedUnlocked ? matchedTs : undefined,
          storefrontId: 'gog',
        };
      });

      const total = schema.length;
      const unlocked = reconciledAchievements.filter((a) => a.unlocked).length;
      const percentage = total > 0 ? Math.round((unlocked / total) * 100) : 0;

      return {
        storefrontId: 'gog',
        storefrontName: 'GOG GALAXY',
        total,
        unlocked,
        percentage,
        isMastered: total > 0 && unlocked >= total,
        achievements: reconciledAchievements,
        syncedAt: liveGogEnvelope?.syncedAt || new Date().toISOString(),
        source: 'live_cloud',
        unlockPrecision: 'exact',
        supportsAchievements: true,
      };
    }

    const summaryUnlockedCount = userGog?.unlocked || 0;

    if (!schema || schema.length === 0) {
      const fallbackTotal = userGog?.total || 0;
      const fallbackPct =
        fallbackTotal > 0 ? Math.round((summaryUnlockedCount / fallbackTotal) * 100) : 0;
      const isOffline = !onlineLifecycleManager.isOnline();
      const hasKnownGogAchievements = fallbackTotal > 0 || summaryUnlockedCount > 0;
      return {
        storefrontId: 'gog',
        storefrontName: 'GOG GALAXY',
        total: fallbackTotal,
        unlocked: summaryUnlockedCount,
        percentage: fallbackPct,
        isMastered: fallbackTotal > 0 && summaryUnlockedCount >= fallbackTotal,
        achievements: [],
        syncedAt: userGog?.syncedAt,
        source: 'schema_fallback',
        unlockPrecision: summaryUnlockedCount > 0 ? 'summary_count_only' : 'exact',
        supportsAchievements: hasKnownGogAchievements || isOffline,
        schemaUnavailableOffline: hasKnownGogAchievements || isOffline,
      };
    }

    const totalCount = userGog?.total && userGog.total > 0 ? userGog.total : schema.length;
    const effectiveSchema = totalCount < schema.length ? schema.slice(0, totalCount) : [...schema];

    const achievements: DetailedAchievement[] = effectiveSchema.map((baseAch, index) => ({
      ...baseAch,
      id: `gog:${targetId}:${baseAch.apiName || baseAch.name || index}`,
      unlocked: Boolean(baseAch.unlocked),
      unlockedAt: baseAch.unlockedAt,
      storefrontId: 'gog',
    }));

    const exactUnlocked = achievements.filter((a) => a.unlocked).length;
    const hasExactUnlocks = exactUnlocked > 0;
    const effectiveUnlocked = hasExactUnlocks ? exactUnlocked : summaryUnlockedCount;
    const unlockPrecision: 'exact' | 'summary_count_only' =
      effectiveUnlocked > 0 && !hasExactUnlocks ? 'summary_count_only' : 'exact';
    const percentage = totalCount > 0 ? Math.round((effectiveUnlocked / totalCount) * 100) : 0;
    const isMastered = totalCount > 0 && effectiveUnlocked >= totalCount;

    return {
      storefrontId: 'gog',
      storefrontName: 'GOG GALAXY',
      total: totalCount,
      unlocked: effectiveUnlocked,
      percentage,
      isMastered,
      achievements,
      syncedAt: userGog?.syncedAt || new Date().toISOString(),
      source: hasExactUnlocks ? 'live_cloud' : 'schema_fallback',
      unlockPrecision,
      supportsAchievements: true,
    };
  }

  /**
   * Fetches detailed Xbox Live / Microsoft Store achievements with Gamerscore breakdowns.
   * Uses official Xbox Achievements v2 / DisplayCatalog via Electron IPC when available,
   * without fabricating unlocks or synthetic 1000G Gamerscore splits.
   */
  async fetchXboxDetailedAchievements(
    game: CanonicalGame,
    xboxPlatform?: GamePlatformOwnership,
    existingSummary?: StoreAchievementSummary,
    canonicalSchema?: DetailedAchievement[]
  ): Promise<StorefrontAchievementsData | null> {
    const plat = xboxPlatform || game.platforms.find((p) => p.platformId === 'xbox');
    const targetId =
      plat?.xboxProductId ||
      plat?.platformGameId ||
      plat?.xboxTitleId ||
      plat?.packageFamilyName ||
      game.id;
    const titleLower = (game.title || '').toLowerCase().trim();

    const summary = existingSummary || plat?.achievements;
    const cachedUserXbox = getKnownXboxAchievements(targetId, game.title);
    const userXbox =
      (cachedUserXbox &&
      (!summary ||
        cachedUserXbox.unlocked >= (summary.unlocked || 0) ||
        (cachedUserXbox.gamerscore?.earned ?? 0) >= (summary.gamerscore?.earned ?? 0))
        ? cachedUserXbox
        : summary) ||
      KNOWN_USER_XBOX_ACHIEVEMENTS[targetId] ||
      KNOWN_USER_XBOX_ACHIEVEMENTS[`xbox-${targetId}`] ||
      KNOWN_USER_XBOX_ACHIEVEMENTS[titleLower] ||
      summary;

    // 1. Live Xbox Achievements v2 via Electron IPC getStoreAchievements
    if (typeof window !== 'undefined' && window.electronAPI?.getStoreAchievements) {
      try {
        const liveRes = await window.electronAPI.getStoreAchievements({
          platformId: 'xbox',
          storefrontId: 'xbox',
          gameId: game.id,
          platformGameId: plat?.platformGameId || targetId,
          xboxProductId: plat?.xboxProductId,
          xboxTitleId: plat?.xboxTitleId,
          packageFamilyName: plat?.packageFamilyName,
          title: game.title,
        });
        const { list: rawLiveList, envelope: liveEnvelope } = extractLiveAchievementsList(liveRes);
        if (rawLiveList && rawLiveList.length > 0) {
          let sumEarnedG = 0;
          let sumTotalG = 0;
          const achievements: DetailedAchievement[] = rawLiveList.map(
            (rawAch: RawStoreAchievementRecord, idx: number): DetailedAchievement => {
              const isUnlocked = Boolean(
                rawAch.unlocked ||
                  rawAch.progressState === 'Achieved' ||
                  rawAch.state === 'Achieved'
              );
              const rawRewardVal =
                typeof rawAch.gamerscore === 'number'
                  ? rawAch.gamerscore
                  : Array.isArray(rawAch.rewards) && rawAch.rewards.length > 0
                    ? Number(
                        rawAch.rewards.find(
                          (r: RawRewardItem) =>
                            !r?.type || String(r.type).toLowerCase() === 'gamerscore'
                        )?.value ?? rawAch.rewards[0]?.value
                      )
                    : undefined;
              const gVal =
                typeof rawRewardVal === 'number' && Number.isFinite(rawRewardVal) && rawRewardVal >= 0
                  ? Math.round(rawRewardVal)
                  : undefined;
              if (gVal !== undefined) {
                sumTotalG += gVal;
                if (isUnlocked) sumEarnedG += gVal;
              }
              const rarityObj =
                rawAch.rarity && typeof rawAch.rarity === 'object' ? rawAch.rarity : undefined;
              const globalPct =
                typeof rawAch.globalPercentage === 'number'
                  ? rawAch.globalPercentage
                  : typeof rarityObj?.currentPercentage === 'number'
                    ? rarityObj.currentPercentage
                    : typeof rawAch.rarityPercent === 'number'
                      ? rawAch.rarityPercent
                      : undefined;
              const unlockedIcon =
                rawAch.iconUnlockedUrl ||
                rawAch.unlockedIconUrl ||
                rawAch.mediaAssets?.[0]?.url ||
                game.headerImage ||
                '';
              return {
                id:
                  rawAch.id ||
                  `xbox:${targetId}:${rawAch.apiName || rawAch.achievementId || idx}`,
                apiName: String(
                  rawAch.apiName || rawAch.achievementId || rawAch.id || `XBOX_ACH_${idx + 1}`
                ),
                name:
                  rawAch.name ||
                  rawAch.title ||
                  rawAch.unlockedDisplayName ||
                  `${game.title} Achievement #${idx + 1}`,
                description:
                  rawAch.description ||
                  (isUnlocked ? rawAch.unlockedDescription : rawAch.lockedDescription) ||
                  rawAch.unlockedDescription ||
                  rawAch.lockedDescription ||
                  undefined,
                unlocked: isUnlocked,
                unlockedAt: rawAch.unlockedAt || rawAch.progression?.timeUnlocked || undefined,
                iconUnlockedUrl: unlockedIcon,
                iconLockedUrl: rawAch.iconLockedUrl || rawAch.lockedIconUrl || unlockedIcon,
                globalPercentage: globalPct,
                rarityTier: globalPct !== undefined ? classifyRarityTier(globalPct) : undefined,
                progress:
                  rawAch.progress &&
                  typeof rawAch.progress.current === 'number' &&
                  typeof rawAch.progress.max === 'number'
                    ? rawAch.progress
                    : undefined,
                isSecret: Boolean(rawAch.isSecret || rawAch.isHidden || rawAch.hidden),
                gamerscore: gVal,
                storefrontId: 'xbox',
              };
            }
          );

          const total = achievements.length;
          const unlocked = achievements.filter((a) => a.unlocked).length;
          const percentage = total > 0 ? Math.round((unlocked / total) * 100) : 0;
          const totalGamerscore =
            (typeof liveEnvelope?.totalGamerscore === 'number' && liveEnvelope.totalGamerscore > 0
              ? liveEnvelope.totalGamerscore
              : undefined) ??
            (typeof liveEnvelope?.gamerscore?.total === 'number' && liveEnvelope.gamerscore.total > 0
              ? liveEnvelope.gamerscore.total
              : undefined) ??
            (sumTotalG > 0 ? sumTotalG : userXbox?.gamerscore?.total);
          const earnedGamerscore =
            (typeof liveEnvelope?.earnedGamerscore === 'number'
              ? liveEnvelope.earnedGamerscore
              : undefined) ??
            (typeof liveEnvelope?.gamerscore?.earned === 'number'
              ? liveEnvelope.gamerscore.earned
              : undefined) ??
            (sumTotalG > 0 ? sumEarnedG : userXbox?.gamerscore?.earned);

          return {
            storefrontId: 'xbox',
            storefrontName: 'Xbox',
            total,
            unlocked,
            percentage,
            isMastered: total > 0 && unlocked >= total,
            ...(totalGamerscore !== undefined ? { totalGamerscore } : {}),
            ...(earnedGamerscore !== undefined ? { earnedGamerscore } : {}),
            achievements,
            syncedAt: liveEnvelope?.syncedAt || new Date().toISOString(),
            source: 'live_cloud',
            unlockPrecision: 'exact',
            supportsAchievements: true,
          };
        }
      } catch {
        // Fall through to Xbox game schema / canonical schema fallback
      }
    }

    // 2. Try Xbox Game Schema via IPC if available
    let schema: DetailedAchievement[] | null = null;
    let schemaHasAuthoritativeUnlocks = false;

    if (typeof window !== 'undefined' && window.electronAPI?.fetchXboxGameSchema) {
      try {
        const schemaRes = await window.electronAPI.fetchXboxGameSchema({
          gameId: game.id,
          platformGameId: plat?.platformGameId || targetId,
          xboxProductId: plat?.xboxProductId,
          xboxTitleId: plat?.xboxTitleId,
          packageFamilyName: plat?.packageFamilyName,
        });
        const { list: rawSchemaList } = extractLiveAchievementsList(schemaRes);
        if (rawSchemaList && rawSchemaList.length > 0) {
          schemaHasAuthoritativeUnlocks = rawSchemaList.some(
            (r) => typeof r.unlocked === 'boolean' || Boolean(r.unlockedAt)
          );
          schema = rawSchemaList.map(
            (rawAch: RawStoreAchievementRecord, idx: number): DetailedAchievement => {
              const globalPct =
                typeof rawAch.globalPercentage === 'number'
                  ? rawAch.globalPercentage
                  : typeof rawAch.rarityPercent === 'number'
                    ? rawAch.rarityPercent
                    : undefined;
              const gVal =
                typeof rawAch.gamerscore === 'number' && Number.isFinite(rawAch.gamerscore)
                  ? rawAch.gamerscore
                  : undefined;
              const unlockedIcon =
                rawAch.iconUnlockedUrl || rawAch.unlockedIconUrl || game.headerImage || '';
              return {
                id: rawAch.id || `xbox:${targetId}:${rawAch.apiName || idx}`,
                apiName: String(rawAch.apiName || rawAch.id || `XBOX_ACH_${idx + 1}`),
                name: rawAch.name || rawAch.title || `${game.title} Achievement #${idx + 1}`,
                description:
                  rawAch.description ||
                  rawAch.unlockedDescription ||
                  rawAch.lockedDescription ||
                  undefined,
                isSecret: Boolean(rawAch.isSecret || rawAch.hidden || rawAch.isHidden),
                unlocked: Boolean(rawAch.unlocked || rawAch.unlockedAt),
                unlockedAt: rawAch.unlockedAt || undefined,
                iconUnlockedUrl: unlockedIcon,
                iconLockedUrl: rawAch.iconLockedUrl || rawAch.lockedIconUrl || unlockedIcon,
                globalPercentage: globalPct,
                rarityTier: globalPct !== undefined ? classifyRarityTier(globalPct) : undefined,
                gamerscore: gVal,
                storefrontId: 'xbox',
              };
            }
          );
        }
      } catch {
        // Fall back to canonical game schema
      }
    }

    const summaryUnlockedCount = userXbox?.unlocked || 0;

    if (!schema || schema.length === 0) {
      schema =
        canonicalSchema && canonicalSchema.length > 0
          ? canonicalSchema
          : onlineLifecycleManager.isOnline()
            ? await this.getCanonicalGameSchema(game)
            : [];
    }

    if (!schema || schema.length === 0) {
      const fallbackTotal = userXbox?.total || 0;
      const fallbackPct =
        fallbackTotal > 0 ? Math.round((summaryUnlockedCount / fallbackTotal) * 100) : 0;
      const hasSummaryProgress =
        summaryUnlockedCount > 0 || (userXbox?.gamerscore?.earned ?? 0) > 0;
      const isOffline = !onlineLifecycleManager.isOnline();
      const hasKnownXboxAchievements =
        fallbackTotal > 0 || hasSummaryProgress || (userXbox?.gamerscore?.total ?? 0) > 0;
      return {
        storefrontId: 'xbox',
        storefrontName: 'Xbox',
        total: fallbackTotal,
        unlocked: summaryUnlockedCount,
        percentage: fallbackPct,
        isMastered: fallbackTotal > 0 && summaryUnlockedCount >= fallbackTotal,
        ...(userXbox?.gamerscore?.total !== undefined
          ? { totalGamerscore: userXbox.gamerscore.total }
          : {}),
        ...(userXbox?.gamerscore?.earned !== undefined
          ? { earnedGamerscore: userXbox.gamerscore.earned }
          : {}),
        achievements: [],
        syncedAt: userXbox?.syncedAt,
        source: 'schema_fallback',
        unlockPrecision: hasSummaryProgress ? 'summary_count_only' : 'exact',
        supportsAchievements: hasKnownXboxAchievements || isOffline,
        schemaUnavailableOffline: hasKnownXboxAchievements || isOffline,
      };
    }

    const totalCount = userXbox?.total && userXbox.total > 0 ? userXbox.total : schema.length;
    const effectiveSchema = totalCount < schema.length ? schema.slice(0, totalCount) : [...schema];

    let sumSchemaTotalG = 0;
    let sumSchemaEarnedG = 0;
    let hasSchemaGamerscore = false;

    const achievements: DetailedAchievement[] = effectiveSchema.map((baseAch, index) => {
      const isUnlocked = Boolean(baseAch.unlocked);
      const gVal =
        typeof baseAch.gamerscore === 'number' &&
        Number.isFinite(baseAch.gamerscore) &&
        baseAch.gamerscore >= 0
          ? baseAch.gamerscore
          : undefined;

      if (gVal !== undefined) {
        hasSchemaGamerscore = true;
        sumSchemaTotalG += gVal;
        if (isUnlocked) sumSchemaEarnedG += gVal;
      }

      return {
        ...baseAch,
        id: `xbox:${targetId}:${baseAch.apiName || baseAch.name || index}`,
        unlocked: isUnlocked,
        unlockedAt: baseAch.unlockedAt,
        ...(gVal !== undefined ? { gamerscore: gVal } : {}),
        storefrontId: 'xbox',
      };
    });

    const exactUnlocked = achievements.filter((a) => a.unlocked).length;
    const hasExactUnlocks = schemaHasAuthoritativeUnlocks || exactUnlocked > 0;
    const effectiveUnlocked = hasExactUnlocks ? exactUnlocked : summaryUnlockedCount;
    const hasSummaryProgress =
      effectiveUnlocked > 0 || (userXbox?.gamerscore?.earned ?? 0) > 0;
    const unlockPrecision: 'exact' | 'summary_count_only' =
      hasSummaryProgress && !hasExactUnlocks ? 'summary_count_only' : 'exact';
    const percentage = totalCount > 0 ? Math.round((effectiveUnlocked / totalCount) * 100) : 0;
    const isMastered = totalCount > 0 && effectiveUnlocked >= totalCount;

    const totalGamerscore =
      userXbox?.gamerscore?.total ?? (hasSchemaGamerscore ? sumSchemaTotalG : undefined);
    const earnedGamerscore =
      userXbox?.gamerscore?.earned ??
      (hasExactUnlocks && hasSchemaGamerscore ? sumSchemaEarnedG : undefined);

    return {
      storefrontId: 'xbox',
      storefrontName: 'Xbox',
      total: totalCount,
      unlocked: effectiveUnlocked,
      percentage,
      isMastered,
      ...(totalGamerscore !== undefined ? { totalGamerscore } : {}),
      ...(earnedGamerscore !== undefined ? { earnedGamerscore } : {}),
      achievements,
      syncedAt: userXbox?.syncedAt || new Date().toISOString(),
      source: hasExactUnlocks ? 'live_cloud' : 'schema_fallback',
      unlockPrecision,
      supportsAchievements: true,
    };
  }

  /**
   * Main entry point: Fetches and aggregates complete detailed achievements across all
   * storefront platforms the game is owned on.
   */
  async fetchGameAchievements(
    game: CanonicalGame,
    forceRefresh: boolean = false
  ): Promise<MultiStoreAchievementsMap> {
    if (!game) return {};

    const steamPlat = game.platforms.find((p) => p.platformId === 'steam');
    const epicPlat = game.platforms.find((p) => p.platformId === 'epic');
    const gogPlat = game.platforms.find((p) => p.platformId === 'gog');
    const xboxPlat = game.platforms.find((p) => p.platformId === 'xbox');

    const cached =
      this.getCachedMultiStoreAchievements(game.id) ||
      (await this.getVaultCachedMultiStoreAchievements(game.id));
    const hasUsableCached = Boolean(
      cached &&
        Object.keys(cached).length > 0 &&
        !Object.values(cached).some((s) => s?.schemaUnavailableOffline === true)
    );

    if (hasUsableCached && !onlineLifecycleManager.isOnline()) {
      return cached!;
    }

    // Check cached records first, invalidating if any platform has newly unlocked trophies
    if (!forceRefresh && hasUsableCached && cached) {
      const steamStale = (steamPlat?.achievements?.unlocked || 0) > (cached.steam?.unlocked || 0);
      const epicStale = (epicPlat?.achievements?.unlocked || 0) > (cached.epic?.unlocked || 0);
      const gogStale = (gogPlat?.achievements?.unlocked || 0) > (cached.gog?.unlocked || 0);
      const xboxStale =
        (xboxPlat?.achievements?.unlocked || 0) > (cached.xbox?.unlocked || 0) ||
        (xboxPlat?.achievements?.gamerscore?.earned || 0) > (cached.xbox?.earnedGamerscore || 0);
      if (!steamStale && !epicStale && !gogStale && !xboxStale) {
        return cached;
      }
    }

    const result: MultiStoreAchievementsMap = {};
    const fetchPromises: Promise<void>[] = [];

    // Resolve unified canonical schema once for all storefronts
    const schema = onlineLifecycleManager.isOnline() ? await this.getCanonicalGameSchema(game) : [];

    // 1. Steam platform
    const targetSteamAppId =
      game.steamAppId ||
      (steamPlat?.platformGameId ? parseInt(steamPlat.platformGameId, 10) : undefined);

    if (targetSteamAppId) {
      fetchPromises.push(
        this.fetchSteamDetailedAchievements(
          targetSteamAppId,
          game.title,
          steamPlat?.achievements,
          schema
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
          schema
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
          schema
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
        this.fetchXboxDetailedAchievements(game, xboxPlat, xboxPlat.achievements, schema)
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

    if (Object.keys(result).length > 0 && !hasOfflineUnavailable) {
      this.setCachedMultiStoreAchievements(game.id, result);
    }

    return result;
  }
}

export const achievementDetailService = new AchievementDetailService();
