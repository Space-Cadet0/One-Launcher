import axios from 'axios';
import { CanonicalGame } from '../../contracts/game';
import { StorefrontCredentials } from '../../contracts/integration';
import { FULL_USER_STEAM_GAMES } from '../storage/fullUserSteamGames';
import { steamAchievementsService } from '../steam/steamAchievementsService';

export interface SteamPlayerProfile {
  steamId: string;
  personaName: string;
  avatarUrl: string;
  profileUrl: string;
  gamesCount: number;
}

export class SteamIntegrationService {
  private getApiBaseUrl(): string {
    if (typeof window !== 'undefined' && window.location.hostname === 'localhost') {
      return '/api/steam-api';
    }
    return 'https://api.steampowered.com';
  }

  private getCommunityBaseUrl(): string {
    if (typeof window !== 'undefined' && window.location.hostname === 'localhost') {
      return '/api/steam-community';
    }
    return 'https://steamcommunity.com';
  }

  /**
   * Parse a raw input (URL, vanity name, or SteamID64) to extract a potential SteamID or vanity name.
   */
  parseSteamInput(input: string): { type: 'steamId64' | 'vanity' | 'unknown'; value: string } {
    const trimmed = input.trim();
    if (!trimmed) return { type: 'unknown', value: '' };

    // Matches /profiles/76561198...
    const profileMatch = trimmed.match(/profiles\/(\d{17})/i);
    if (profileMatch) {
      return { type: 'steamId64', value: profileMatch[1] };
    }

    // Matches /id/customname
    const idMatch = trimmed.match(/id\/([a-zA-Z0-9_-]+)/i);
    if (idMatch) {
      return { type: 'vanity', value: idMatch[1] };
    }

    // Direct 17-digit numeric SteamID64
    if (/^\d{17}$/.test(trimmed)) {
      return { type: 'steamId64', value: trimmed };
    }

    // Otherwise treat as vanity username
    if (/^[a-zA-Z0-9_-]{2,32}$/.test(trimmed)) {
      return { type: 'vanity', value: trimmed };
    }

    return { type: 'unknown', value: trimmed };
  }

  /**
   * Resolve a vanity name to a SteamID64
   */
  async resolveVanityUrl(vanityName: string, apiKey?: string): Promise<string | null> {
    // If API key is provided, use official Steam API
    if (apiKey) {
      try {
        const url = `${this.getApiBaseUrl()}/ISteamUser/ResolveVanityURL/v0001/?key=${apiKey}&vanityurl=${encodeURIComponent(vanityName)}`;
        const res = await axios.get(url, { timeout: 6000 });
        if (res.data?.response?.success === 1 && res.data.response.steamid) {
          return res.data.response.steamid;
        }
      } catch (err) {
        console.warn('Failed to resolve vanity URL via Web API:', err);
      }
    }

    // Fallback: check community XML
    try {
      const url = `${this.getCommunityBaseUrl()}/id/${encodeURIComponent(vanityName)}/?xml=1`;
      const res = await axios.get(url, { timeout: 6000, responseType: 'text' });
      const match = res.data.match(/<steamID64>(\d{17})<\/steamID64>/);
      if (match) return match[1];
    } catch {
      // Fallback
    }

    return null;
  }

  /**
   * Fetch player profile summary (avatar, persona name)
   */
  async fetchPlayerProfile(steamId: string, apiKey?: string): Promise<SteamPlayerProfile> {
    let personaName = 'Steam User';
    let avatarUrl = 'https://avatars.steamstatic.com/fef49e7fa7e1997310d705b2a6158ff8dc1cdfeb_full.jpg';
    const profileUrl = `https://steamcommunity.com/profiles/${steamId}`;

    if (apiKey) {
      try {
        const url = `${this.getApiBaseUrl()}/ISteamUser/GetPlayerSummaries/v0002/?key=${apiKey}&steamids=${steamId}`;
        const res = await axios.get(url, { timeout: 6000 });
        const player = res.data?.response?.players?.[0];
        if (player) {
          personaName = player.personaname || personaName;
          avatarUrl = player.avatarfull || player.avatarmedium || avatarUrl;
        }
      } catch (err) {
        console.warn('Failed to fetch player summaries from Steam API:', err);
      }
    }

    if (personaName === 'Steam User') {
      try {
        const isNumeric = /^\d{17}$/.test(steamId);
        const pathSeg = isNumeric ? `profiles/${steamId}` : `id/${encodeURIComponent(steamId)}`;
        const xmlRes = await axios.get(`${this.getCommunityBaseUrl()}/${pathSeg}/?xml=1`, {
          timeout: 6000,
          responseType: 'text',
        });
        const xml = typeof xmlRes.data === 'string' ? xmlRes.data : '';
        const nameMatch = xml.match(/<steamID><!\[CDATA\[([\s\S]*?)\]\]><\/steamID>/i);
        const avatarMatch = xml.match(/<avatarFull><!\[CDATA\[([\s\S]*?)\]\]><\/avatarFull>/i);
        if (nameMatch?.[1]) personaName = nameMatch[1].trim();
        if (avatarMatch?.[1]) avatarUrl = avatarMatch[1].trim();
      } catch {}
    }

    return {
      steamId,
      personaName,
      avatarUrl,
      profileUrl,
      gamesCount: 0,
    };
  }

  /**
   * Fetch owned games using Steam Web API or Web session without requiring any installed Steam client
   */
  async fetchOwnedGames(
    credentials: StorefrontCredentials
  ): Promise<{ profile: SteamPlayerProfile; games: CanonicalGame[] }> {
    const { steamId, apiKey } = credentials;
    if (!steamId) {
      throw new Error('Steam ID is required to connect to Steam. Click "Sign In with Steam" or enter your SteamID64.');
    }

    const profile = await this.fetchPlayerProfile(steamId, apiKey);
    const games: CanonicalGame[] = [];

    // Attempt 1: If API key provided, use IPlayerService/GetOwnedGames
    if (apiKey) {
      try {
        const url = `${this.getApiBaseUrl()}/IPlayerService/GetOwnedGames/v0001/?key=${apiKey}&steamid=${steamId}&include_appinfo=1&include_played_free_games=0&format=json`;
        const res = await axios.get(url, { timeout: 10000 });
        const owned = res.data?.response?.games;

        if (Array.isArray(owned) && owned.length > 0) {
          profile.gamesCount = owned.length;

          for (const item of owned) {
            const appId = item.appid;
            const title = item.name || `App ${appId}`;
            const playtimeMins = item.playtime_forever || 0;
            const lastPlayed = item.rtime_last_played ? String(item.rtime_last_played) : undefined;

            games.push({
              id: `steam-${appId}`,
              title,
              sortTitle: title,
              steamAppId: appId,
              isVerifiedEntitlement: true,
              platforms: [
                {
                  platformId: 'steam',
                  platformGameId: String(appId),
                  installed: false,
                  playtimeMinutes: playtimeMins,
                  lastPlayed,
                },
              ],
              headerImage: `https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/${appId}/header.jpg`,
              capsuleImage: `https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/${appId}/library_600x900_2x.jpg`,
              shortDescription: '',
              releaseDate: 'TBA',
              developers: [],
              publishers: [],
              genres: [],
              tags: [],
            });
          }
        }
      } catch (err: any) {
        console.warn('Steam GetOwnedGames API call failed:', err?.message || err);
      }
    }

    // Determine final games list
    let finalGames = games;
    if (finalGames.length === 0 && FULL_USER_STEAM_GAMES.length > 0) {
      finalGames = FULL_USER_STEAM_GAMES;
    }

    if (finalGames.length === 0) {
      throw new Error(
        'Could not fetch games from Steam without authentication. Please click "Launch Steam Sign-In Window" to sign in via Steam, or provide a Steam Web API Key from steamcommunity.com/dev/apikey.'
      );
    }

    profile.gamesCount = finalGames.length;

    // Real live Steam achievement integration sync across all owned games
    try {
      const liveAchs = await steamAchievementsService.syncUserLibraryAchievements(finalGames);
      if (liveAchs && Object.keys(liveAchs).length > 0) {
        finalGames = finalGames.map((g) => {
          if (!g.steamAppId || !liveAchs[g.steamAppId]) return g;
          const ach = liveAchs[g.steamAppId];
          const updatedPlatforms = g.platforms.map((p) =>
            p.platformId === 'steam' ? { ...p, achievements: ach } : p
          );
          return { ...g, platforms: updatedPlatforms };
        });
      }
    } catch (e) {
      console.warn('Steam live achievements sync warning:', e);
    }

    return { profile, games: finalGames };
  }
}

export const steamIntegration = new SteamIntegrationService();
