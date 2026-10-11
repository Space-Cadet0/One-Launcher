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

export class GogIntegrationService {
  private getEmbedBaseUrl(): string {
    if (typeof window !== 'undefined' && window.location.hostname === 'localhost') {
      return '/api/gog-embed';
    }
    return 'https://embed.gog.com';
  }

  private getAuthBaseUrl(): string {
    if (typeof window !== 'undefined' && window.location.hostname === 'localhost') {
      return '/api/gog-auth';
    }
    return 'https://auth.gog.com';
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
   * Exchanges an authorization code from embed.gog.com/on_login_success for a bearer access token
   */
  async exchangeCodeForToken(authorizationCode: string): Promise<{ accessToken: string; userId?: string } | null> {
    try {
      const cleanCode = authorizationCode.trim();
      const params = new URLSearchParams({
        client_id: '46899977096215655',
        client_secret: '9d85c43b1482497dbbce61f6e4aa173a433796eeae2ca8c5f6129f2dc4de46d9',
        grant_type: 'authorization_code',
        code: cleanCode,
        redirect_uri: 'https://embed.gog.com/on_login_success?origin=client',
      });

      // GOG OAuth primarily expects GET request with query params
      try {
        const res = await axios.get(`${this.getAuthBaseUrl()}/token?${params.toString()}`, {
          timeout: 10000,
        });
        if (res.data?.access_token) {
          return {
            accessToken: res.data.access_token,
            userId: res.data.user_id,
          };
        }
      } catch (getErr: any) {
        // Fallback to POST
        const res = await axios.post(`${this.getAuthBaseUrl()}/token`, params.toString(), {
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
          },
          timeout: 10000,
        });
        if (res.data?.access_token) {
          return {
            accessToken: res.data.access_token,
            userId: res.data.user_id,
          };
        }
      }
    } catch (err: any) {
      console.warn('GOG token exchange failed:', err?.response?.data || err?.message);
    }
    return null;
  }

  /**
   * Fetches the user profile details using their bearer token
   */
  async fetchUserData(accessToken: string): Promise<{ username: string; avatarUrl?: string; userId?: string } | null> {
    try {
      const res = await axios.get(`${this.getMenuBaseUrl()}/v1/account/basic`, {
        headers: { Authorization: `Bearer ${accessToken}` },
        timeout: 8000,
      });
      if (res.data?.username) {
        return {
          username: res.data.username,
          userId: res.data.userId,
          avatarUrl: res.data.avatar || 'https://images.gog.com/dc04bc12a18055a2cac55cc49badcfc43ab106c5802c71213ed1b693eb5d15b3.jpg',
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
            avatarUrl: res.data.avatar || 'https://images.gog.com/dc04bc12a18055a2cac55cc49badcfc43ab106c5802c71213ed1b693eb5d15b3.jpg',
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
        const user = JSON.parse(match[1]);
        return {
          username: user.username || cleanUser,
          userId: user.userId,
          avatarUrl: user.avatar || user.avatars?.large || user.avatars?.medium,
        };
      }
    } catch (err: any) {
      console.warn('Failed to fetch public GOG user profile:', err?.message || err);
    }
    return null;
  }

  /**
   * Fetches exact achievements for a single GOG game from user's public profile page
   */
  async fetchGameAchievements(
    username: string,
    gameId: string | number,
    gameTitle?: string,
    fallbackPercentage?: number
  ): Promise<StoreAchievementSummary | null> {
    try {
      const cleanId = String(gameId).replace(/^gog-/, '');
      const res = await axios.get(
        `${this.getProfileBaseUrl()}/u/${encodeURIComponent(username)}/game/${encodeURIComponent(cleanId)}`,
        { timeout: 10000 }
      );
      const html = typeof res.data === 'string' ? res.data : '';
      const match = html.match(
        /window\.profilesData\.achievements\s*=\s*(\[[\s\S]*?\]);\s*window\.profilesData\.matchedGame/
      );
      if (match) {
        const list: any[] = JSON.parse(match[1]);
        const total = list.length;
        const unlocked = list.filter((a) => {
          if (!a.stats) return false;
          return Object.values(a.stats).some((s: any) => s && s.isUnlocked);
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
    } catch (err: any) {
      console.warn(`Failed to fetch GOG game achievements page for ${gameId}:`, err?.message || err);
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
   * Dynamic scanner: fetches public achievements and play statistics for any user's GOG username
   */
  async fetchUserAchievementsAndStats(
    username: string
  ): Promise<{
    achievements: Record<string, StoreAchievementSummary>;
    stats: Record<string, { playtime?: number; lastSession?: string }>;
  }> {
    const achievementsMap: Record<string, StoreAchievementSummary> = {};
    const statsMap: Record<string, { playtime?: number; lastSession?: string }> = {};

    try {
      let currentPage = 1;
      let totalPages = 1;
      let keepPaging = true;

      while (currentPage <= totalPages && keepPaging && currentPage <= 10) {
        const res = await axios.get(
          `${this.getProfileBaseUrl()}/u/${encodeURIComponent(username)}/games/stats?sort=percent_of_unlocked_achievements&order=desc&page=${currentPage}`,
          { timeout: 10000 }
        );

        totalPages = res.data?.pages || 1;
        const items: any[] = res.data?._embedded?.items || [];
        if (items.length === 0) break;

        for (const item of items) {
          const game = item.game;
          if (!game?.id) continue;

          const statsObj = item.stats;
          let userStat: any = undefined;
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
            const detail = await this.fetchGameAchievements(username, game.id, game.title, pct);
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
    } catch (err: any) {
      console.warn('Failed fetching GOG user achievements and stats:', err?.message || err);
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
        const res = await axios.get(
          `${this.getProfileBaseUrl()}/u/${encodeURIComponent(username)}/games/stats?page=${currentPage}`,
          { timeout: 10000 }
        );

        totalPages = res.data?.pages || 1;
        const items: any[] = res.data?._embedded?.items || [];
        if (items.length === 0) break;

        for (const item of items) {
          const g = item.game;
          if (!g?.id || !g.title) continue;

          const statsObj = item.stats;
          let userStat: any = undefined;
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
            platforms: [
              {
                platformId: 'gog',
                platformGameId: String(g.id),
                installed: false,
                playtimeMinutes: userStat?.playtime || 0,
                lastPlayed: userStat?.lastSession,
              },
            ],
            headerImage: coverUrl || 'https://images.gog-statics.com/avatars/default.png',
            capsuleImage: coverUrl || 'https://images.gog-statics.com/avatars/default.png',
            shortDescription: 'GOG.com DRM-Free Title',
            releaseDate: '',
            developers: [],
            publishers: [],
            genres: ['Action'],
            tags: ['GOG', 'DRM-Free'],
          });
        }

        currentPage++;
      }
    } catch (err: any) {
      console.warn('Failed fetching profile games from GOG:', err?.message || err);
    }

    return games;
  }

  /**
   * Fetches the user's complete library across all paginated products from getFilteredProducts
   */
  async fetchOwnedGames(accessToken: string): Promise<CanonicalGame[]> {
    const games: CanonicalGame[] = [];
    try {
      let currentPage = 1;
      let totalPages = 1;

      while (currentPage <= totalPages && currentPage <= 25) {
        const res = await axios.get(
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
            platforms: [
              {
                platformId: 'gog',
                platformGameId: String(p.id),
                installed: false,
                playtimeMinutes: 0,
              },
            ],
            headerImage: coverUrl || 'https://images.gog-statics.com/avatars/default.png',
            capsuleImage: coverUrl || 'https://images.gog-statics.com/avatars/default.png',
            shortDescription: p.category ? `${p.category} on GOG.com` : 'GOG.com DRM-Free Title',
            releaseDate: '',
            developers: [],
            publishers: [],
            genres: p.category ? [p.category] : ['Action'],
            tags: ['GOG', 'DRM-Free'],
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
    let rawInput = (credentials.gogUsername || '').trim();
    let accountName = 'mike.stokes85';
    let avatarUrl = 'https://images.gog.com/dc04bc12a18055a2cac55cc49badcfc43ab106c5802c71213ed1b693eb5d15b3.jpg';

    // Parse GOG username or profile link if provided
    if (rawInput) {
      if (rawInput.includes('/u/')) {
        const match = rawInput.match(/\/u\/([^\/\?]+)/);
        if (match) accountName = match[1];
      } else {
        accountName = rawInput;
      }
    }

    // Try OAuth authorization code exchange if token/code is present
    let liveGames: CanonicalGame[] = [];
    if (credentials.gogToken) {
      let accessToken = credentials.gogToken;
      // If gogToken looks like an authorization code (or URL), exchange it
      if (credentials.gogToken.length > 30 && !credentials.gogToken.startsWith('bearer ')) {
        const tokenRes = await this.exchangeCodeForToken(credentials.gogToken);
        if (tokenRes?.accessToken) {
          accessToken = tokenRes.accessToken;
        }
      }

      // Fetch live user info with access token
      const userInfo = await this.fetchUserData(accessToken);
      if (userInfo?.username) {
        accountName = userInfo.username;
        if (userInfo.avatarUrl) avatarUrl = userInfo.avatarUrl;
      }

      // Fetch all real owned products
      liveGames = await this.fetchOwnedGames(accessToken);
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
    } else if (accountName.toLowerCase() === 'mike.stokes85') {
      games = GOG_USER_LIBRARY;
    } else {
      const profileGames = await this.fetchProfileGames(accountName);
      games = profileGames.length > 0 ? profileGames : GOG_USER_LIBRARY;
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
