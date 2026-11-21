import axios from 'axios';
import { CanonicalGame, StoreAchievementSummary } from '../../contracts/game';
import { StorefrontCredentials } from '../../contracts/integration';
import {
  cacheUserGogAchievements,
  getKnownAchievementTotal,
} from '../storage/knownGameAchievements';
import { reconcileAchievementSummaries } from '../storage/achievementReconciliation';
import { getAlphabeticalTitleSortKey } from '../common/titleSortUtils';
import { hasElectronBridge } from '../common/runtimeEnv';
import { getDevProxyBaseForRoute } from '../network/browserDevProxy';

const GOG_PLACEHOLDER_ACCOUNT_NAME = 'GOG User';
const GOG_WEB_ACHIEVEMENT_CONCURRENCY = 4;
const GOG_JWT_PATTERN = /^[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}$/;

export interface GogProductItem {
  id: number;
  title: string;
  image?: string;
  slug?: string;
  worksOn?: {
    Windows?: boolean;
    Mac?: boolean;
    Linux?: boolean;
  };
  category?: string;
  rating?: number;
  isHidden?: boolean;
}

export interface GogAvatarMap {
  menu_user_av_big2?: string;
  menu_user_av_big?: string;
  large_2x?: string;
  large?: string;
  sdk_img_184?: string;
  medium_2x?: string;
  medium?: string;
  menu_big_2?: string;
  menu_big?: string;
  menu_user_av_small2?: string;
  menu_user_av_small?: string;
  small_2x?: string;
  small?: string;
  [key: string]: unknown;
}

interface GogProfileAchievementEntry {
  stats?: Record<string, { isUnlocked?: boolean } | null | undefined>;
}

interface GogUserStatEntry {
  playtime?: number;
  lastSession?: string | null;
  achievementsPercentage?: number;
}

interface GogProfileStatsItem {
  game?: {
    id?: string | number;
    title?: string;
    image?: string;
  };
  stats?: Record<string, GogUserStatEntry> | GogUserStatEntry[];
}

interface GogStatsRecord {
  playtime?: number;
  lastSession?: string;
}

interface AxiosErrorLike {
  message?: string;
  code?: string;
  response?: {
    status?: number;
    data?: unknown;
  };
}

interface GogIpcAchievementCandidate {
  unlocked?: unknown;
  total?: unknown;
  percentage?: unknown;
  isMastered?: unknown;
}

function isPlaceholderGogUsername(username?: string | null): boolean {
  const trimmed = typeof username === 'string' ? username.trim() : '';
  return !trimmed || trimmed === GOG_PLACEHOLDER_ACCOUNT_NAME;
}

function normalizeGogBearerToken(rawToken: string): string {
  const trimmed = rawToken.trim();
  if (/^bearer\s+/i.test(trimmed)) {
    return trimmed.replace(/^bearer\s+/i, '').trim();
  }
  return trimmed;
}

/**
 * Classifies whether a user-supplied `gogToken` value is an OAuth authorization code
 * (redirect URL or `code=...` query string) rather than an already-exchanged access token
 * (JWT, `Bearer ...` token, `'saved_in_electron'`, or opaque access token).
 */
function isLikelyGogAuthorizationCode(rawInput: string): boolean {
  const trimmed = rawInput.trim();
  if (!trimmed || trimmed === 'saved_in_electron') return false;
  if (/^bearer\s+/i.test(trimmed)) return false;
  if (GOG_JWT_PATTERN.test(trimmed)) return false;
  if (/^https?:\/\/.*(?:on_login_success|[?&]code=)/i.test(trimmed)) {
    return true;
  }
  if (/^[?&]?code=[A-Za-z0-9._\-!*]{16,}$/i.test(trimmed)) {
    return true;
  }
  return false;
}

function formatSafeGogError(err: unknown): string {
  if (err && typeof err === 'object') {
    const axErr = err as AxiosErrorLike;
    const parts: string[] = [];
    if (typeof axErr.response?.status === 'number') {
      parts.push(`HTTP ${axErr.response.status}`);
    }
    if (typeof axErr.code === 'string' && axErr.code.trim()) {
      parts.push(axErr.code.trim());
    }
    if (typeof axErr.message === 'string' && axErr.message.trim()) {
      parts.push(axErr.message.trim());
    }
    if (parts.length > 0) {
      return parts.join(' - ');
    }
  }
  if (typeof err === 'string' && err.trim()) {
    return err.trim();
  }
  return 'GOG request failed';
}

async function runWithConcurrency<T>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T) => Promise<void>
): Promise<void> {
  if (items.length === 0) return;
  const limit = Math.max(1, Math.min(concurrency, items.length));
  let nextIndex = 0;
  const workers = Array.from({ length: limit }, async () => {
    while (nextIndex < items.length) {
      const idx = nextIndex++;
      await worker(items[idx]);
    }
  });
  await Promise.all(workers);
}

function recordGogStatEntry(
  statsMap: Record<string, GogStatsRecord>,
  rawGameId: string | number,
  rawStat: unknown
): boolean {
  if (!rawStat || typeof rawStat !== 'object') return false;
  const statObj = rawStat as GogUserStatEntry;
  const playtime =
    typeof statObj.playtime === 'number' && Number.isFinite(statObj.playtime)
      ? statObj.playtime
      : undefined;
  const lastSession =
    typeof statObj.lastSession === 'string' && statObj.lastSession.trim()
      ? statObj.lastSession.trim()
      : undefined;
  if (playtime === undefined && lastSession === undefined) return false;

  const cleanId = String(rawGameId).replace(/^gog-/i, '').trim();
  if (!cleanId) return false;
  const entry: GogStatsRecord = { playtime, lastSession };
  statsMap[cleanId] = entry;
  statsMap[`gog-${cleanId}`] = entry;
  return true;
}

function extractGogIpcAchievementsAndStats(ipcRaw: unknown): {
  achievements: Record<string, StoreAchievementSummary>;
  stats: Record<string, GogStatsRecord>;
  achievementsCount: number;
  statsCount: number;
} {
  const achievements: Record<string, StoreAchievementSummary> = {};
  const stats: Record<string, GogStatsRecord> = {};
  let achievementsCount = 0;
  let statsCount = 0;

  if (!ipcRaw || typeof ipcRaw !== 'object') {
    return { achievements, stats, achievementsCount, statsCount };
  }

  const rawObj = ipcRaw as Record<string, unknown>;
  const hasEnvelope =
    ('achievements' in rawObj &&
      rawObj.achievements !== null &&
      typeof rawObj.achievements === 'object') ||
    ('stats' in rawObj && rawObj.stats !== null && typeof rawObj.stats === 'object');

  const achSource = hasEnvelope
    ? (rawObj.achievements as Record<string, unknown> | undefined)
    : rawObj;

  if (achSource && typeof achSource === 'object') {
    const nowIso = new Date().toISOString();
    for (const [k, rawVal] of Object.entries(achSource)) {
      if (!rawVal || typeof rawVal !== 'object') continue;
      const val = rawVal as GogIpcAchievementCandidate;
      if (typeof val.unlocked === 'number' && typeof val.total === 'number') {
        const percentage =
          typeof val.percentage === 'number' && Number.isFinite(val.percentage)
            ? val.percentage
            : val.total > 0
            ? Math.round((val.unlocked / val.total) * 100)
            : 0;
        achievements[k] = {
          unlocked: val.unlocked,
          total: val.total,
          percentage,
          isMastered: Boolean(val.isMastered) || (val.total > 0 && val.unlocked >= val.total),
          source: 'live_cloud_api',
          syncedAt: nowIso,
        };
        achievementsCount++;
      }
    }
  }

  if (hasEnvelope && rawObj.stats) {
    const rawStats = rawObj.stats;
    if (rawStats instanceof Map) {
      for (const [k, v] of rawStats.entries()) {
        if (recordGogStatEntry(stats, String(k), v)) {
          statsCount++;
        }
      }
    } else if (typeof rawStats === 'object' && !Array.isArray(rawStats)) {
      for (const [k, v] of Object.entries(rawStats as Record<string, unknown>)) {
        if (recordGogStatEntry(stats, k, v)) {
          statsCount++;
        }
      }
    }
  }

  return { achievements, stats, achievementsCount, statsCount };
}

export function normalizeGogAvatarUrl(
  rawAvatar?: string | GogAvatarMap | null,
  avatarsObj?: GogAvatarMap | null
): string | undefined {
  const candidates: unknown[] = [];
  if (avatarsObj && typeof avatarsObj === 'object') {
    candidates.push(
      avatarsObj.menu_user_av_big2,
      avatarsObj.menu_user_av_big,
      avatarsObj.large_2x,
      avatarsObj.large,
      avatarsObj.sdk_img_184,
      avatarsObj.medium_2x,
      avatarsObj.medium,
      avatarsObj.menu_big_2,
      avatarsObj.menu_big,
      avatarsObj.menu_user_av_small2,
      avatarsObj.menu_user_av_small,
      avatarsObj.small_2x,
      avatarsObj.small
    );
  }
  if (rawAvatar && typeof rawAvatar === 'object') {
    candidates.push(
      rawAvatar.large_2x,
      rawAvatar.large,
      rawAvatar.sdk_img_184,
      rawAvatar.medium_2x,
      rawAvatar.medium,
      rawAvatar.menu_big_2,
      rawAvatar.menu_big,
      rawAvatar.menu_user_av_big2,
      rawAvatar.menu_user_av_big,
      rawAvatar.small_2x,
      rawAvatar.small
    );
  } else if (typeof rawAvatar === 'string' && rawAvatar.trim()) {
    candidates.push(rawAvatar.trim());
  }

  for (const cand of candidates) {
    if (typeof cand !== 'string' || !cand.trim()) continue;
    let url = cand.trim();
    if (url.startsWith('//')) {
      url = `https:${url}`;
    } else if (url.startsWith('http://')) {
      url = `https://${url.slice(7)}`;
    }
    if (/^https:\/\/images\.gog(-statics)?\.com\/[0-9a-f]{32,64}$/i.test(url)) {
      url = `${url}_menu_user_av_big2.jpg`;
    }
    return url;
  }
  return undefined;
}

export class GogIntegrationService {
  private getEmbedBaseUrl(): string {
    return getDevProxyBaseForRoute('gogEmbed');
  }

  private getMenuBaseUrl(): string {
    return getDevProxyBaseForRoute('gogMenu');
  }

  private getProfileBaseUrl(): string {
    return getDevProxyBaseForRoute('gogProfile');
  }

  /**
   * Exchanges an authorization code from embed.gog.com/on_login_success for a session via
   * Main-Process IPC so OAuth client secrets are never bundled into the renderer.
   */
  async exchangeCodeForToken(
    authorizationCode: string
  ): Promise<{ accessToken: string; userId?: string } | null> {
    try {
      const cleanCode = authorizationCode.trim();
      if (!cleanCode) return null;

      if (hasElectronBridge() && window.electronAPI?.exchangeCode) {
        const res = await window.electronAPI.exchangeCode('gog', cleanCode);
        if (res?.success) {
          const tokenData = res.tokenData;
          return {
            accessToken: tokenData?.access_token || 'saved_in_electron',
            userId: tokenData?.user_id || res.accountId,
          };
        }
      }
    } catch (err: unknown) {
      console.warn('GOG token exchange failed:', formatSafeGogError(err));
    }
    return null;
  }

  /**
   * Normalize GOG avatar URLs (handling protocol-relative //images.gog-statics.com/<hash>
   * which returns 404 without a size suffix + .jpg extension, as well as avatars maps).
   */
  normalizeAvatarUrl(
    rawAvatar?: string | GogAvatarMap | null,
    avatarsObj?: GogAvatarMap | null
  ): string | undefined {
    return normalizeGogAvatarUrl(rawAvatar, avatarsObj);
  }

  /**
   * Fetches the user profile details using their bearer token
   */
  async fetchUserData(
    accessToken: string
  ): Promise<{ username: string; avatarUrl?: string; userId?: string } | null> {
    const cleanToken = normalizeGogBearerToken(accessToken || '');
    if (!cleanToken || cleanToken === 'saved_in_electron') return null;
    try {
      const res = await axios.get<{
        username?: string;
        userId?: string;
        avatar?: string | GogAvatarMap;
        avatars?: GogAvatarMap;
      }>(`${this.getMenuBaseUrl()}/v1/account/basic`, {
        headers: { Authorization: `Bearer ${cleanToken}` },
        timeout: 8000,
      });
      if (res.data?.username) {
        return {
          username: res.data.username,
          userId: res.data.userId,
          avatarUrl: normalizeGogAvatarUrl(res.data.avatar, res.data.avatars),
        };
      }
    } catch {
      // Fallback to userData.json
      try {
        const res = await axios.get<{
          username?: string;
          userId?: string;
          avatar?: string | GogAvatarMap;
          avatars?: GogAvatarMap;
        }>(`${this.getEmbedBaseUrl()}/userData.json`, {
          headers: { Authorization: `Bearer ${cleanToken}` },
          timeout: 8000,
        });
        if (res.data?.username) {
          return {
            username: res.data.username,
            userId: res.data.userId,
            avatarUrl: normalizeGogAvatarUrl(res.data.avatar, res.data.avatars),
          };
        }
      } catch (err: unknown) {
        console.warn('Failed to fetch GOG user data:', formatSafeGogError(err));
      }
    }
    return null;
  }

  /**
   * Fetches the user profile details from public GOG profile
   */
  async fetchUserProfile(
    username: string
  ): Promise<{ username: string; avatarUrl?: string; userId?: string } | null> {
    if (isPlaceholderGogUsername(username)) return null;
    try {
      const cleanUser = username.trim();
      const res = await axios.get<string>(
        `${this.getProfileBaseUrl()}/u/${encodeURIComponent(cleanUser)}`,
        {
          timeout: 10000,
        }
      );
      const html = typeof res.data === 'string' ? res.data : '';
      const match = html.match(/profilesData\.profileUser\s*=\s*(\{[\s\S]*?\});/);
      if (match) {
        const user = JSON.parse(match[1]) as {
          username?: string;
          userId?: string;
          avatar?: string | GogAvatarMap;
          avatars?: GogAvatarMap;
        };
        return {
          username: user.username || cleanUser,
          userId: user.userId,
          avatarUrl: normalizeGogAvatarUrl(user.avatar, user.avatars),
        };
      }
    } catch (err: unknown) {
      console.warn('Failed to fetch public GOG user profile:', formatSafeGogError(err));
    }
    return null;
  }

  /**
   * Fetches exact achievements for a single GOG game from user's profile page
   */
  async fetchGameAchievements(
    username: string,
    gameId: string | number,
    gameTitle?: string,
    fallbackPercentage?: number,
    accessToken?: string
  ): Promise<StoreAchievementSummary | null> {
    if (!isPlaceholderGogUsername(username)) {
      try {
        const cleanId = String(gameId).replace(/^gog-/, '');
        const headers: Record<string, string> = {};
        const cleanToken = accessToken ? normalizeGogBearerToken(accessToken) : '';
        if (cleanToken && cleanToken !== 'saved_in_electron') {
          headers.Authorization = `Bearer ${cleanToken}`;
        }
        const res = await axios.get<string>(
          `${this.getProfileBaseUrl()}/u/${encodeURIComponent(username.trim())}/game/${encodeURIComponent(cleanId)}`,
          { timeout: 10000, headers }
        );
        const html = typeof res.data === 'string' ? res.data : '';
        const match = html.match(
          /window\.profilesData\.achievements\s*=\s*(\[[\s\S]*?\]);\s*window\.profilesData\.matchedGame/
        );
        if (match) {
          const list = JSON.parse(match[1]) as GogProfileAchievementEntry[];
          const total = list.length;
          const unlocked = list.filter((a) => {
            if (!a.stats) return false;
            return Object.values(a.stats).some((s) => Boolean(s && s.isUnlocked));
          }).length;
          const percentage = total > 0 ? Math.round((unlocked / total) * 100) : 0;
          return {
            unlocked,
            total,
            percentage,
            isMastered: total > 0 && unlocked >= total,
            source: 'live_cloud_xml',
            syncedAt: new Date().toISOString(),
          };
        }
      } catch (err: unknown) {
        console.warn(
          `Failed to fetch GOG game achievements page for ${gameId}:`,
          formatSafeGogError(err)
        );
      }
    }

    // Fallback if detailed page parsing failed: use verified total and fallback percentage
    const knownTotal = getKnownAchievementTotal(undefined, String(gameId), gameTitle);
    if (knownTotal !== undefined && knownTotal > 0 && fallbackPercentage !== undefined) {
      const unlocked = Math.round((knownTotal * fallbackPercentage) / 100);
      return {
        unlocked,
        total: knownTotal,
        percentage: fallbackPercentage,
        isMastered: knownTotal > 0 && unlocked >= knownTotal,
        source: 'live_cloud_xml',
        syncedAt: new Date().toISOString(),
      };
    }

    return null;
  }

  /**
   * Fetches playtime and lastSession stats from public GOG profile stats pages without scraping
   * per-game achievement pages (used to supplement Electron achievement-only payloads).
   */
  private async fetchProfilePlaytimeStats(
    username: string,
    accessToken?: string
  ): Promise<Record<string, GogStatsRecord>> {
    const statsMap: Record<string, GogStatsRecord> = {};
    if (isPlaceholderGogUsername(username)) {
      return statsMap;
    }

    const cleanUser = username.trim();
    const headers: Record<string, string> = {};
    const cleanToken = accessToken ? normalizeGogBearerToken(accessToken) : '';
    if (cleanToken && cleanToken !== 'saved_in_electron') {
      headers.Authorization = `Bearer ${cleanToken}`;
    }

    try {
      let currentPage = 1;
      let totalPages = 1;
      while (currentPage <= totalPages && currentPage <= 5) {
        const res = await axios.get<{
          pages?: number;
          _embedded?: { items?: GogProfileStatsItem[] };
        }>(
          `${this.getProfileBaseUrl()}/u/${encodeURIComponent(cleanUser)}/games/stats?sort=recent_playtime&order=desc&page=${currentPage}`,
          { timeout: 10000, headers }
        );
        totalPages = typeof res.data?.pages === 'number' && res.data.pages > 0 ? res.data.pages : 1;
        const items = Array.isArray(res.data?._embedded?.items) ? res.data._embedded.items : [];
        if (items.length === 0) break;

        for (const item of items) {
          const game = item.game;
          if (!game?.id) continue;
          const statsObj = item.stats;
          const userStat =
            statsObj && !Array.isArray(statsObj) ? Object.values(statsObj)[0] : undefined;
          if (userStat) {
            recordGogStatEntry(statsMap, game.id, userStat);
          }
        }
        currentPage++;
      }
    } catch (err: unknown) {
      console.warn('Failed fetching supplemental GOG playtime stats:', formatSafeGogError(err));
    }

    return statsMap;
  }

  /**
   * Dynamic scanner: fetches achievements and play statistics for any user's GOG account
   */
  async fetchUserAchievementsAndStats(
    username: string,
    accessToken?: string,
    userId?: string
  ): Promise<{
    achievements: Record<string, StoreAchievementSummary>;
    stats: Record<string, GogStatsRecord>;
  }> {
    const achievementsMap: Record<string, StoreAchievementSummary> = {};
    const statsMap: Record<string, GogStatsRecord> = {};
    const cleanUsername = (username || '').trim();
    const normalizedToken = accessToken ? normalizeGogBearerToken(accessToken) : undefined;

    // 1. In Electron, delegate to native main-process GOG achievement fetcher (avoids CORS & 403 and uses gameplay.gog.com API)
    if (hasElectronBridge() && window.electronAPI?.fetchGogAchievements) {
      try {
        const ipcAch = await window.electronAPI.fetchGogAchievements(
          cleanUsername || undefined,
          normalizedToken,
          userId
        );
        const extracted = extractGogIpcAchievementsAndStats(ipcAch);
        Object.assign(achievementsMap, extracted.achievements);
        Object.assign(statsMap, extracted.stats);

        if (extracted.achievementsCount > 0 || extracted.statsCount > 0) {
          if (extracted.achievementsCount > 0) {
            cacheUserGogAchievements(achievementsMap);
          }
          // Preserve playtime/lastSession when Electron IPC returned flat achievements without stats
          if (extracted.statsCount === 0 && !isPlaceholderGogUsername(cleanUsername)) {
            const supplementalStats = await this.fetchProfilePlaytimeStats(
              cleanUsername,
              normalizedToken
            );
            Object.assign(statsMap, supplementalStats);
          }
          return { achievements: achievementsMap, stats: statsMap };
        }
      } catch (err: unknown) {
        console.warn('Electron GOG achievement fetch fallback:', formatSafeGogError(err));
      }
    }

    if (isPlaceholderGogUsername(cleanUsername)) {
      return { achievements: achievementsMap, stats: statsMap };
    }

    try {
      let currentPage = 1;
      let totalPages = 1;
      let keepPaging = true;
      const headers: Record<string, string> = {};
      if (normalizedToken && normalizedToken !== 'saved_in_electron') {
        headers.Authorization = `Bearer ${normalizedToken}`;
      }

      const pendingAchievementFetches: Array<{
        gameId: string;
        title?: string;
        pct: number;
      }> = [];

      while (currentPage <= totalPages && keepPaging && currentPage <= 10) {
        const res = await axios.get<{
          pages?: number;
          _embedded?: { items?: GogProfileStatsItem[] };
        }>(
          `${this.getProfileBaseUrl()}/u/${encodeURIComponent(cleanUsername)}/games/stats?sort=percent_of_unlocked_achievements&order=desc&page=${currentPage}`,
          { timeout: 10000, headers }
        );

        totalPages = typeof res.data?.pages === 'number' && res.data.pages > 0 ? res.data.pages : 1;
        const items: GogProfileStatsItem[] = Array.isArray(res.data?._embedded?.items)
          ? res.data._embedded.items
          : [];
        if (items.length === 0) break;

        for (const item of items) {
          const game = item.game;
          if (!game?.id) continue;

          const statsObj = item.stats;
          let userStat: GogUserStatEntry | undefined = undefined;
          if (statsObj && !Array.isArray(statsObj)) {
            userStat = Object.values(statsObj)[0];
          }

          if (userStat) {
            recordGogStatEntry(statsMap, game.id, userStat);
          }

          const pct = userStat?.achievementsPercentage;
          if (pct !== undefined && pct > 0) {
            pendingAchievementFetches.push({
              gameId: String(game.id),
              title: game.title,
              pct,
            });
          } else if (pct === 0 || !userStat) {
            // Because items are sorted by percent_of_unlocked_achievements descending,
            // once we hit 0 achievements, all subsequent items have 0 achievements.
            keepPaging = false;
          }
        }

        currentPage++;
      }

      // Bounded concurrency pool instead of unbounded sequential N+1 requests
      await runWithConcurrency(
        pendingAchievementFetches,
        GOG_WEB_ACHIEVEMENT_CONCURRENCY,
        async (entry) => {
          const detail = await this.fetchGameAchievements(
            cleanUsername,
            entry.gameId,
            entry.title,
            entry.pct,
            normalizedToken
          );
          if (detail) {
            achievementsMap[entry.gameId] = detail;
            achievementsMap[`gog-${entry.gameId}`] = detail;
            if (entry.title) {
              achievementsMap[entry.title.toLowerCase().trim()] = detail;
              const normTitle = entry.title
                .toLowerCase()
                .replace(/[:\-–—]/g, ' ')
                .replace(/\s+/g, ' ')
                .trim();
              achievementsMap[normTitle] = detail;
            }
          }
        }
      );
    } catch (err: unknown) {
      console.warn('Failed fetching GOG user achievements and stats:', formatSafeGogError(err));
    }

    // Persist achievements to localStorage cache
    if (Object.keys(achievementsMap).length > 0) {
      cacheUserGogAchievements(achievementsMap);
    }

    return { achievements: achievementsMap, stats: statsMap };
  }

  /**
   * Fetches owned games from public GOG profile when OAuth token is not provided
   */
  async fetchProfileGames(username: string): Promise<CanonicalGame[]> {
    if (isPlaceholderGogUsername(username)) {
      return [];
    }

    const cleanUser = username.trim();
    const games: CanonicalGame[] = [];
    try {
      let currentPage = 1;
      let totalPages = 1;

      while (currentPage <= totalPages && currentPage <= 20) {
        const res = await axios.get<{
          pages?: number;
          _embedded?: { items?: GogProfileStatsItem[] };
        }>(
          `${this.getProfileBaseUrl()}/u/${encodeURIComponent(cleanUser)}/games/stats?page=${currentPage}`,
          { timeout: 10000 }
        );

        totalPages = typeof res.data?.pages === 'number' && res.data.pages > 0 ? res.data.pages : 1;
        const items: GogProfileStatsItem[] = Array.isArray(res.data?._embedded?.items)
          ? res.data._embedded.items
          : [];
        if (items.length === 0) break;

        for (const item of items) {
          const g = item.game;
          if (!g?.id || !g.title) continue;

          const statsObj = item.stats;
          let userStat: GogUserStatEntry | undefined = undefined;
          if (statsObj && !Array.isArray(statsObj)) {
            userStat = Object.values(statsObj)[0];
          }

          const coverUrl = g.image
            ? g.image.startsWith('http')
              ? g.image
              : `https:${g.image}`
            : undefined;
          const cleanTitle = g.title.trim();

          games.push({
            id: `gog-${g.id}`,
            title: cleanTitle,
            sortTitle: getAlphabeticalTitleSortKey(cleanTitle, true),
            isVerifiedEntitlement: true,
            platforms: [
              {
                platformId: 'gog',
                platformGameId: String(g.id),
                installed: false,
                playtimeMinutes: userStat?.playtime || 0,
                lastPlayed:
                  typeof userStat?.lastSession === 'string' && userStat.lastSession.trim()
                    ? userStat.lastSession
                    : undefined,
              },
            ],
            headerImage: coverUrl || '',
            capsuleImage: '',
            shortDescription: '',
            releaseDate: '',
            developers: [],
            publishers: [],
            genres: [],
            tags: [],
          });
        }

        currentPage++;
      }
    } catch (err: unknown) {
      console.warn('Failed fetching profile games from GOG:', formatSafeGogError(err));
    }

    return games;
  }

  /**
   * Fetches the user's complete library across all paginated products from getFilteredProducts,
   * tracking whether all pages finished cleanly with verified response shapes and zero errors.
   */
  async fetchOwnedGamesDetailed(
    accessToken: string
  ): Promise<{ games: CanonicalGame[]; authoritativeComplete: boolean }> {
    const cleanToken = normalizeGogBearerToken(accessToken || '');
    if (!cleanToken || cleanToken === 'saved_in_electron') {
      return { games: [], authoritativeComplete: false };
    }
    const games: CanonicalGame[] = [];
    let completedAllPages = false;
    try {
      let currentPage = 1;
      let totalPages = 1;
      let allPagesValid = true;
      let fetchedAnyPage = false;

      while (currentPage <= totalPages && currentPage <= 100) {
        const res = await axios.get<{
          products?: GogProductItem[];
          totalPages?: number;
        }>(
          `${this.getEmbedBaseUrl()}/account/getFilteredProducts?hiddenFlag=0&mediaType=1&page=${currentPage}&sortBy=title`,
          {
            headers: { Authorization: `Bearer ${cleanToken}` },
            timeout: 10000,
          }
        );

        // Fail closed on HTTP 200 HTML login redirects or malformed non-object payloads
        const payload = res.data;
        const hasValidProducts = Boolean(
          payload && typeof payload === 'object' && Array.isArray(payload.products)
        );
        const rawTotalPages =
          payload && typeof payload === 'object' ? payload.totalPages : undefined;
        const hasValidTotalPages =
          typeof rawTotalPages === 'number' &&
          Number.isFinite(rawTotalPages) &&
          rawTotalPages >= 0;

        if (!hasValidProducts || !hasValidTotalPages) {
          allPagesValid = false;
          console.warn(
            `GOG getFilteredProducts page ${currentPage} returned malformed or non-JSON payload; marking sync non-authoritative.`
          );
          break;
        }

        fetchedAnyPage = true;
        const products: GogProductItem[] = payload.products as GogProductItem[];
        totalPages = rawTotalPages;

        for (const p of products) {
          if (p.isHidden === true) continue;
          const gameTitle = p.title?.trim();
          if (!gameTitle) continue;

          const coverUrl = p.image
            ? p.image.startsWith('http')
              ? p.image
              : `https:${p.image}.jpg`
            : undefined;

          games.push({
            id: `gog-${p.id}`,
            title: gameTitle,
            sortTitle: getAlphabeticalTitleSortKey(gameTitle, true),
            isVerifiedEntitlement: true,
            platforms: [
              {
                platformId: 'gog',
                platformGameId: String(p.id),
                installed: false,
                playtimeMinutes: 0,
              },
            ],
            headerImage: coverUrl || '',
            capsuleImage: '',
            shortDescription: '',
            releaseDate: '',
            developers: [],
            publishers: [],
            genres: p.category ? [p.category] : [],
            tags: [],
          });
        }

        currentPage++;
      }

      completedAllPages = fetchedAnyPage && allPagesValid && currentPage > totalPages;
    } catch (err: unknown) {
      completedAllPages = false;
      console.warn('Failed fetching paginated GOG products:', formatSafeGogError(err));
    }

    return { games, authoritativeComplete: completedAllPages };
  }

  /**
   * Fetches the user's complete library across all paginated products from getFilteredProducts
   */
  async fetchOwnedGames(accessToken: string): Promise<CanonicalGame[]> {
    const { games } = await this.fetchOwnedGamesDetailed(accessToken);
    return games;
  }

  /**
   * Connect and synchronize GOG account
   */
  async connectAccount(
    credentials: StorefrontCredentials
  ): Promise<{
    accountName: string;
    avatarUrl?: string;
    games: CanonicalGame[];
    authoritativeComplete?: boolean;
  }> {
    const rawInput = (credentials.gogUsername || '').trim();
    let accountName = GOG_PLACEHOLDER_ACCOUNT_NAME;
    let avatarUrl: string | undefined = undefined;
    let resolvedUserId: string | undefined = undefined;
    let resolvedAccessToken: string | undefined = undefined;

    // Parse GOG username or profile link if provided
    if (rawInput) {
      if (rawInput.includes('/u/')) {
        const match = rawInput.match(/\/u\/([^/?]+)/);
        if (match) accountName = match[1];
      } else {
        accountName = rawInput;
      }
    }

    // Try OAuth authorization code exchange only for explicit authorization codes/URLs
    let liveGames: CanonicalGame[] = [];
    let authoritativeComplete = false;
    let isElectronTransientOffline = false;
    if (credentials.gogToken) {
      let accessToken = credentials.gogToken.trim();
      if (isLikelyGogAuthorizationCode(accessToken)) {
        const tokenRes = await this.exchangeCodeForToken(accessToken);
        if (tokenRes?.accessToken) {
          accessToken = tokenRes.accessToken;
        }
        if (tokenRes?.userId) {
          resolvedUserId = tokenRes.userId;
        }
      } else if (accessToken !== 'saved_in_electron') {
        accessToken = normalizeGogBearerToken(accessToken);
      }

      resolvedAccessToken = accessToken || undefined;

      if (
        accessToken === 'saved_in_electron' &&
        hasElectronBridge() &&
        window.electronAPI?.syncStore
      ) {
        try {
          const ipcSync = await window.electronAPI.syncStore('gog');
          if (ipcSync?.accountName) accountName = ipcSync.accountName;
          if (ipcSync?.avatarUrl) avatarUrl = ipcSync.avatarUrl;
          if (ipcSync?.accountId) {
            resolvedUserId = ipcSync.accountId;
          }
          if (ipcSync?.transientOffline) {
            isElectronTransientOffline = true;
          } else if (ipcSync?.success) {
            if (Array.isArray(ipcSync.games)) liveGames = ipcSync.games;
            authoritativeComplete = Boolean(ipcSync.authoritativeComplete);
          }
        } catch (ipcErr: unknown) {
          console.warn('Electron GOG sync fallback failed:', formatSafeGogError(ipcErr));
        }
      } else if (accessToken) {
        // Fetch live user info with access token
        const userInfo = await this.fetchUserData(accessToken);
        if (userInfo?.username) {
          accountName = userInfo.username;
          if (userInfo.avatarUrl) avatarUrl = userInfo.avatarUrl;
        }
        if (userInfo?.userId) {
          resolvedUserId = userInfo.userId;
        }

        // Fetch all real owned products
        const ownedRes = await this.fetchOwnedGamesDetailed(accessToken);
        liveGames = ownedRes.games;
        authoritativeComplete = ownedRes.authoritativeComplete;
      }
    } else if (!isPlaceholderGogUsername(accountName)) {
      // Fetch public profile user details (avatar, username confirmation)
      const profileUser = await this.fetchUserProfile(accountName);
      if (profileUser) {
        if (profileUser.username) accountName = profileUser.username;
        if (profileUser.avatarUrl) avatarUrl = profileUser.avatarUrl;
        if (profileUser.userId) resolvedUserId = profileUser.userId;
      }
    }

    if (isElectronTransientOffline) {
      return {
        accountName,
        avatarUrl,
        games: [],
        authoritativeComplete: false,
      };
    }

    let games: CanonicalGame[];
    if (liveGames.length > 0 || authoritativeComplete) {
      games = liveGames;
    } else {
      authoritativeComplete = false;
      let profileGames: CanonicalGame[] = [];
      if (!isPlaceholderGogUsername(accountName)) {
        try {
          profileGames = await this.fetchProfileGames(accountName);
        } catch (err: unknown) {
          console.warn('Failed fetching profile games from GOG:', formatSafeGogError(err));
        }
      }
      games = profileGames.map((g) => ({
        ...g,
        isVerifiedEntitlement: true,
      }));
    }

    // Dynamic scan and sync of user achievements and play statistics
    const canScanAchievements =
      !isPlaceholderGogUsername(accountName) ||
      (hasElectronBridge() &&
        Boolean(window.electronAPI?.fetchGogAchievements) &&
        Boolean(resolvedAccessToken || resolvedUserId));

    if (canScanAchievements) {
      try {
        const { achievements, stats } = await this.fetchUserAchievementsAndStats(
          accountName,
          resolvedAccessToken,
          resolvedUserId
        );
        // Attach to returned games
        for (const game of games) {
          const gogPlatform = game.platforms.find((p) => p.platformId === 'gog');
          if (gogPlatform) {
            const gameId = gogPlatform.platformGameId || game.id.replace(/^gog-/, '');
            const ach =
              achievements[gameId] ||
              achievements[`gog-${gameId}`] ||
              (game.title ? achievements[game.title.toLowerCase().trim()] : undefined);
            if (ach) {
              gogPlatform.achievements =
                reconcileAchievementSummaries(gogPlatform.achievements, ach, {
                  title: game.title,
                  store: 'gog',
                }) || ach;
            }
            const st = stats[gameId] || stats[`gog-${gameId}`];
            if (st) {
              if (st.playtime !== undefined && st.playtime > 0) {
                gogPlatform.playtimeMinutes = Math.max(
                  gogPlatform.playtimeMinutes || 0,
                  st.playtime
                );
              }
              if (st.lastSession) {
                gogPlatform.lastPlayed = st.lastSession;
              }
            }
          }
        }
      } catch (scanErr: unknown) {
        console.warn(
          'Failed to dynamically scan GOG achievements/stats:',
          formatSafeGogError(scanErr)
        );
      }
    }

    return {
      accountName,
      avatarUrl,
      games,
      authoritativeComplete,
    };
  }
}

export const gogIntegration = new GogIntegrationService();
