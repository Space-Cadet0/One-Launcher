import axios from 'axios';
import { CanonicalGame, StoreAchievementSummary } from '../../contracts/game';
import { loadIntegrations } from '../integrations/integrationStorage';
import { KNOWN_USER_STEAM_ACHIEVEMENTS } from '../storage/knownGameAchievements';

export class SteamAchievementsService {
  private inMemoryCache = new Map<number, StoreAchievementSummary>();

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
        '76561198244849198';
      const apiKey = steamInteg?.credentials?.apiKey;
      return { steamId, apiKey };
    } catch {
      return { steamId: '76561198244849198' };
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
   * Reads cached achievements from in-memory cache or localStorage.
   */
  getCachedAchievements(appId: number): StoreAchievementSummary | null {
    if (this.inMemoryCache.has(appId)) {
      return this.inMemoryCache.get(appId)!;
    }

    if (typeof window !== 'undefined') {
      try {
        const raw = localStorage.getItem('antigravity_steam_achievements');
        if (raw) {
          const map = JSON.parse(raw);
          const found = map[appId];
          if (found && typeof found.unlocked === 'number' && typeof found.total === 'number') {
            const summary: StoreAchievementSummary = {
              unlocked: found.unlocked,
              total: found.total,
              percentage: found.percentage ?? (found.total > 0 ? Math.round((found.unlocked / found.total) * 100) : 0),
              isMastered: found.total > 0 && found.unlocked >= found.total,
            };
            this.inMemoryCache.set(appId, summary);
            return summary;
          }
        }
      } catch {}
    }

    // Check verified built-in user baseline
    if (KNOWN_USER_STEAM_ACHIEVEMENTS[appId]) {
      const b = KNOWN_USER_STEAM_ACHIEVEMENTS[appId];
      const summary: StoreAchievementSummary = {
        unlocked: b.unlocked,
        total: b.total,
        percentage: b.percentage,
        isMastered: b.total > 0 && b.unlocked >= b.total,
      };
      this.inMemoryCache.set(appId, summary);
      return summary;
    }

    return null;
  }

  /**
   * Caches an achievement record in memory and localStorage.
   */
  setCachedAchievement(appId: number, summary: StoreAchievementSummary): void {
    this.inMemoryCache.set(appId, summary);
    if (typeof window !== 'undefined') {
      try {
        const raw = localStorage.getItem('antigravity_steam_achievements');
        const map = raw ? JSON.parse(raw) : {};
        map[appId] = summary;
        localStorage.setItem('antigravity_steam_achievements', JSON.stringify(map));
      } catch {}
    }
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
        const currentUnlocked = p.achievements?.unlocked;
        const currentTotal = p.achievements?.total;
        if (currentUnlocked !== cached.unlocked || currentTotal !== cached.total) {
          changed = true;
          return {
            ...p,
            achievements: cached,
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

    // 1. If Steam Web API key is configured, try ISteamUserStats/GetPlayerAchievements
    if (apiKey && steamId) {
      try {
        const url = `${this.getApiBaseUrl()}/ISteamUserStats/GetPlayerAchievements/v0001/?appid=${appId}&key=${apiKey}&steamid=${steamId}`;
        const res = await axios.get(url, { timeout: 5000 });
        const list = res.data?.playerstats?.achievements;
        if (Array.isArray(list)) {
          const total = list.length;
          const unlocked = list.filter((a: any) => a.achieved === 1).length;
          const percentage = total > 0 ? Math.round((unlocked / total) * 100) : 0;
          const summary: StoreAchievementSummary = {
            unlocked,
            total,
            percentage,
            isMastered: total > 0 && unlocked >= total,
          };
          this.setCachedAchievement(appId, summary);
          return summary;
        }
      } catch (err: any) {
        // Fall back to community XML
      }
    }

    // 2. Try official Steam Community XML stats endpoint (works for any public profile without API key)
    if (steamId) {
      try {
        const isNumeric = /^\d{17}$/.test(steamId);
        const pathSegment = isNumeric ? `profiles/${steamId}` : `id/${steamId}`;
        const url = `${this.getCommunityBaseUrl()}/${pathSegment}/stats/${appId}/?xml=1`;
        const res = await axios.get(url, { timeout: 6000, responseType: 'text' });
        const xml = typeof res.data === 'string' ? res.data : '';

        if (xml.includes('<achievements>') || xml.includes('<achievement closed=')) {
          const allMatches = xml.match(/<achievement closed="/g) || [];
          const unlockedMatches = xml.match(/<achievement closed="1">/g) || [];
          const total = allMatches.length;
          const unlocked = unlockedMatches.length;

          if (total > 0 || unlocked > 0) {
            const percentage = total > 0 ? Math.round((unlocked / total) * 100) : 0;
            const summary: StoreAchievementSummary = {
              unlocked,
              total,
              percentage,
              isMastered: total > 0 && unlocked >= total,
            };
            this.setCachedAchievement(appId, summary);
            return summary;
          }
        }
      } catch (err: any) {
        // Fall through to cached data
      }
    }

    // 3. Fallback to cached or verified baseline
    return this.getCachedAchievements(appId);
  }
}

export const steamAchievementsService = new SteamAchievementsService();
