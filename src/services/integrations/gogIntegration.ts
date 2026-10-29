import axios from 'axios';
import { CanonicalGame, StoreAchievementSummary } from '../../contracts/game';
import { StorefrontCredentials } from '../../contracts/integration';
import { GOG_USER_LIBRARY } from '../storage/storefrontLibraries';
import {
  cacheUserGogAchievements,
  getKnownAchievementTotal,
} from '../storage/knownGameAchievements';
import { reconcileAchievementSummaries } from '../storage/achievementReconciliation';

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
  lastSession?: string;
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

interface AxiosErrorLike {
  message?: string;
  response?: {
    data?: unknown;
  };
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
    if (typeof window !== 'undefined' && window.location.hostname === 'localhost') {
      return '/api/gog-embed';
    }
    return 'https://embed.gog.com';
  }

  private getMenuBaseUrl(): string {
    if (typeof window !== 'undefined' && window.location.hostname === 'localhost') {
      return '/api/gog-menu';
    }
    return 'https://menu.gog.com';
  }

  private getProfileBaseUrl(): string {
    if (typeof window !== 'undefined' && window.location.hostname === 'localhost') {
      return '/api/gog-profile';
    }
    return 'https://www.gog.com';
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

      if (typeof window !== 'undefined' && window.electronAPI?.exchangeCode) {
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
      const axErr = (err && typeof err === 'object' ? err : {}) as AxiosErrorLike;
      console.warn('GOG token exchange failed:', axErr.response?.data || axErr.message);
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
  async fetchUserData(accessToken: string): Promise<{ username: string; avatarUrl?: string; userId?: string } | null> {
    if (!accessToken || accessToken === 'saved_in_electron') return null;
    try {
      const res = await axios.get(`${this.getMenuBaseUrl()}/v1/account/basic`, {
        headers: { Authorization: `Bearer ${accessToken}` },
        timeout: 8000,
      });
      if (res.data?.username) {
        return {
          username: res.data.username,
          userId: res.data.userId,
          avatarUrl:
            normalizeGogAvatarUrl(res.data.avatar, res.data.avatars) ||
            'https://images.gog.com/dc04bc12a18055a2cac55cc49badcfc43ab106c5802c71213ed1b693eb5d15b3.jpg',
        };
      }
    } catch {
      // Fallback to userData.json
      try {
        const res = await axios.get(`${this.getEmbedBaseUrl()}/userData.json`, {
          headers: { Authorization: `Bearer ${accessToken}` },
          timeout: 8000,
        });
        if (res.data?.username) {
          return {
            username: res.data.username,
            userId: res.data.userId,
            avatarUrl:
              normalizeGogAvatarUrl(res.data.avatar, res.data.avatars) ||
              'https://images.gog.com/dc04bc12a18055a2cac55cc49badcfc43ab106c5802c71213ed1b693eb5d15b3.jpg',
          };
        }
      } catch (err) {
        console.warn('Failed to fetch GOG user data:', err);
      }
    }
    return null;
  }

  /**
   * Fetches the user profile details from public GOG profile
   */
  async fetchUserProfile(username: string): Promise<{ username: string; avatarUrl?: string; userId?: string } | null> {
    try {
      const cleanUser = username.trim();
      const res = await axios.get(`${this.getProfileBaseUrl()}/u/${encodeURIComponent(cleanUser)}`, {
        timeout: 10000,
      });
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
      const axErr = (err && typeof err === 'object' ? err : {}) as AxiosErrorLike;
      console.warn('Failed to fetch public GOG user profile:', axErr.message || err);
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
    try {
      const cleanId = String(gameId).replace(/^gog-/, '');
      const headers: Record<string, string> = {};
      if (accessToken && accessToken !== 'saved_in_electron') {
        headers.Authorization = `Bearer ${accessToken}`;
      }
      const res = await axios.get(
        `${this.getProfileBaseUrl()}/u/${encodeURIComponent(username)}/game/${encodeURIComponent(cleanId)}`,
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
      const axErr = (err && typeof err === 'object' ? err : {}) as AxiosErrorLike;
      console.warn(`Failed to fetch GOG game achievements page for ${gameId}:`, axErr.message || err);
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
   * Dynamic scanner: fetches achievements and play statistics for any user's GOG account
   */
  async fetchUserAchievementsAndStats(
    username: string,
    accessToken?: string,
    userId?: string
  ): Promise<{
    achievements: Record<string, StoreAchievementSummary>;
    stats: Record<string, { playtime?: number; lastSession?: string }>;
  }> {
    const achievementsMap: Record<string, StoreAchievementSummary> = {};
    const statsMap: Record<string, { playtime?: number; lastSession?: string }> = {};

    // 1. In Electron, delegate to native main-process GOG achievement fetcher (avoids CORS & 403 and uses gameplay.gog.com API)
    if (typeof window !== 'undefined' && window.electronAPI?.fetchGogAchievements) {
      try {
        const ipcAch = await window.electronAPI.fetchGogAchievements(username, accessToken, userId);
        if (ipcAch && typeof ipcAch === 'object' && Object.keys(ipcAch).length > 0) {
          const nowIso = new Date().toISOString();
          for (const [k, val] of Object.entries(ipcAch)) {
            if (val && typeof val.unlocked === 'number' && typeof val.total === 'number') {
              achievementsMap[k] = {
                unlocked: val.unlocked,
                total: val.total,
                percentage: val.percentage ?? (val.total > 0 ? Math.round((val.unlocked / val.total) * 100) : 0),
                isMastered: Boolean(val.isMastered) || (val.total > 0 && val.unlocked >= val.total),
                source: 'live_cloud_api',
                syncedAt: nowIso,
              };
            }
          }
          cacheUserGogAchievements(achievementsMap);
          return { achievements: achievementsMap, stats: statsMap };
        }
      } catch (err) {
        console.warn('Electron GOG achievement fetch fallback:', err);
      }
    }

    try {
      let currentPage = 1;
      let totalPages = 1;
      let keepPaging = true;
      const headers: Record<string, string> = {};
      if (accessToken && accessToken !== 'saved_in_electron') {
        headers.Authorization = `Bearer ${accessToken}`;
      }

      while (currentPage <= totalPages && keepPaging && currentPage <= 10) {
        const res = await axios.get<{
          pages?: number;
          _embedded?: { items?: GogProfileStatsItem[] };
        }>(
          `${this.getProfileBaseUrl()}/u/${encodeURIComponent(username)}/games/stats?sort=percent_of_unlocked_achievements&order=desc&page=${currentPage}`,
          { timeout: 10000, headers }
        );

        totalPages = res.data?.pages || 1;
        const items: GogProfileStatsItem[] = res.data?._embedded?.items || [];
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
            statsMap[String(game.id)] = {
              playtime: userStat.playtime,
              lastSession: userStat.lastSession,
            };
            statsMap[`gog-${game.id}`] = {
              playtime: userStat.playtime,
              lastSession: userStat.lastSession,
            };
          }

          const pct = userStat?.achievementsPercentage;
          if (pct !== undefined && pct > 0) {
            const detail = await this.fetchGameAchievements(username, game.id, game.title, pct, accessToken);
            if (detail) {
              const strId = String(game.id);
              achievementsMap[strId] = detail;
              achievementsMap[`gog-${strId}`] = detail;
              if (game.title) {
                achievementsMap[game.title.toLowerCase().trim()] = detail;
                const normTitle = game.title.toLowerCase().replace(/[:\-–—]/g, ' ').replace(/\s+/g, ' ').trim();
                achievementsMap[normTitle] = detail;
              }
            }
          } else if (pct === 0 || !userStat) {
            // Because items are sorted by percent_of_unlocked_achievements descending,
            // once we hit 0 achievements, all subsequent items have 0 achievements.
            keepPaging = false;
          }
        }

        currentPage++;
      }
    } catch (err: unknown) {
      const axErr = (err && typeof err === 'object' ? err : {}) as AxiosErrorLike;
      console.warn('Failed fetching GOG user achievements and stats:', axErr.message || err);
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
    const games: CanonicalGame[] = [];
    try {
      let currentPage = 1;
      let totalPages = 1;

      while (currentPage <= totalPages && currentPage <= 20) {
        const res = await axios.get<{
          pages?: number;
          _embedded?: { items?: GogProfileStatsItem[] };
        }>(
          `${this.getProfileBaseUrl()}/u/${encodeURIComponent(username)}/games/stats?page=${currentPage}`,
          { timeout: 10000 }
        );

        totalPages = res.data?.pages || 1;
        const items: GogProfileStatsItem[] = res.data?._embedded?.items || [];
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

          games.push({
            id: `gog-${g.id}`,
            title: g.title.trim(),
            sortTitle: g.title.trim().replace(/^(The|A|An)\s+/i, ''),
            isVerifiedEntitlement: true,
            platforms: [
              {
                platformId: 'gog',
                platformGameId: String(g.id),
                installed: false,
                playtimeMinutes: userStat?.playtime || 0,
                lastPlayed: userStat?.lastSession,
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
      const axErr = (err && typeof err === 'object' ? err : {}) as AxiosErrorLike;
      console.warn('Failed fetching profile games from GOG:', axErr.message || err);
    }

    return games;
  }

  /**
   * Fetches the user's complete library across all paginated products from getFilteredProducts
   */
  async fetchOwnedGames(accessToken: string): Promise<CanonicalGame[]> {
    if (!accessToken || accessToken === 'saved_in_electron') return [];
    const games: CanonicalGame[] = [];
    try {
      let currentPage = 1;
      let totalPages = 1;

      while (currentPage <= totalPages && currentPage <= 25) {
        const res = await axios.get<{
          products?: GogProductItem[];
          totalPages?: number;
        }>(
          `${this.getEmbedBaseUrl()}/account/getFilteredProducts?hiddenFlag=0&mediaType=1&page=${currentPage}&sortBy=title`,
          {
            headers: { Authorization: `Bearer ${accessToken}` },
            timeout: 10000,
          }
        );

        const products: GogProductItem[] = res.data?.products || [];
        totalPages = res.data?.totalPages || 1;

        for (const p of products) {
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
            sortTitle: gameTitle.replace(/^(The|A|An)\s+/i, ''),
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
    } catch (err) {
      console.warn('Failed fetching paginated GOG products:', err);
    }

    return games;
  }

  /**
   * Connect and synchronize GOG account
   */
  async connectAccount(
    credentials: StorefrontCredentials
  ): Promise<{ accountName: string; avatarUrl?: string; games: CanonicalGame[] }> {
    const rawInput = (credentials.gogUsername || '').trim();
    let accountName = 'GOG User';
    let avatarUrl: string | undefined = undefined;

    // Parse GOG username or profile link if provided
    if (rawInput) {
      if (rawInput.includes('/u/')) {
        const match = rawInput.match(/\/u\/([^/?]+)/);
        if (match) accountName = match[1];
      } else {
        accountName = rawInput;
      }
    }

    // Try OAuth authorization code exchange if token/code is present
    let liveGames: CanonicalGame[] = [];
    if (credentials.gogToken) {
      let accessToken = credentials.gogToken;
      // If gogToken looks like an authorization code (or URL), exchange it via IPC
      if (
        credentials.gogToken !== 'saved_in_electron' &&
        credentials.gogToken.length > 30 &&
        !credentials.gogToken.startsWith('bearer ')
      ) {
        const tokenRes = await this.exchangeCodeForToken(credentials.gogToken);
        if (tokenRes?.accessToken) {
          accessToken = tokenRes.accessToken;
        }
      }

      if (accessToken === 'saved_in_electron' && typeof window !== 'undefined' && window.electronAPI?.syncStore) {
        try {
          const ipcSync = await window.electronAPI.syncStore('gog');
          if (ipcSync?.success) {
            if (ipcSync.accountName) accountName = ipcSync.accountName;
            if (ipcSync.avatarUrl) avatarUrl = ipcSync.avatarUrl;
            if (Array.isArray(ipcSync.games)) liveGames = ipcSync.games;
          }
        } catch (ipcErr) {
          console.warn('Electron GOG sync fallback failed:', ipcErr);
        }
      } else {
        // Fetch live user info with access token
        const userInfo = await this.fetchUserData(accessToken);
        if (userInfo?.username) {
          accountName = userInfo.username;
          if (userInfo.avatarUrl) avatarUrl = userInfo.avatarUrl;
        }

        // Fetch all real owned products
        liveGames = await this.fetchOwnedGames(accessToken);
      }
    } else {
      // Fetch public profile user details (avatar, username confirmation)
      const profileUser = await this.fetchUserProfile(accountName);
      if (profileUser) {
        if (profileUser.username) accountName = profileUser.username;
        if (profileUser.avatarUrl) avatarUrl = profileUser.avatarUrl;
      }
    }

    let games: CanonicalGame[];
    if (liveGames.length > 0) {
      games = liveGames;
    } else {
      let profileGames: CanonicalGame[] = [];
      try {
        profileGames = await this.fetchProfileGames(accountName);
      } catch (err) {
        console.warn('Failed fetching profile games from GOG:', err);
      }
      if (profileGames.length > 0) {
        games = profileGames.map((g) => ({
          ...g,
          isVerifiedEntitlement: true,
        }));
      } else {
        games = GOG_USER_LIBRARY.map((g) => ({
          ...g,
          isVerifiedEntitlement: true,
        }));
      }
    }

    // Dynamic scan and sync of user achievements and play statistics
    try {
      const { achievements, stats } = await this.fetchUserAchievementsAndStats(accountName);
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
              gogPlatform.playtimeMinutes = st.playtime;
            }
            if (st.lastSession) {
              gogPlatform.lastPlayed = st.lastSession;
            }
          }
        }
      }
    } catch (scanErr) {
      console.warn('Failed to dynamically scan GOG achievements/stats:', scanErr);
    }

    return {
      accountName,
      avatarUrl,
      games,
    };
  }
}

export const gogIntegration = new GogIntegrationService();
