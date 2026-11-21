import axios from 'axios';
import { CanonicalGame } from '../../contracts/game';
import { StorefrontCredentials } from '../../contracts/integration';
import { steamAchievementsService } from '../steam/steamAchievementsService';
import { getAlphabeticalTitleSortKey } from '../common/titleSortUtils';
import { getDevProxyBaseForRoute } from '../network/browserDevProxy';

const DEFAULT_STEAM_AVATAR_URL =
  'https://avatars.steamstatic.com/fef49e7fa7e1997310d705b2a6158ff8dc1cdfeb_full.jpg';

export interface SteamPlayerProfile {
  steamId: string;
  personaName: string;
  avatarUrl: string;
  profileUrl: string;
  gamesCount: number;
}

interface SteamResolveVanityResponse {
  response?: {
    success?: number;
    steamid?: string;
  };
}

interface SteamPlayerSummaryItem {
  personaname?: string;
  avatarfull?: string;
  avatarmedium?: string;
}

interface SteamPlayerSummariesResponse {
  response?: {
    players?: SteamPlayerSummaryItem[];
  };
}

interface SteamOwnedGameItem {
  appid: number;
  name?: string;
  playtime_forever?: number;
  rtime_last_played?: number;
}

interface SteamOwnedGamesResponse {
  response?: {
    games?: SteamOwnedGameItem[];
  };
}

interface AxiosErrorLike {
  message?: string;
  code?: string;
  response?: {
    status?: number;
  };
}

function redactSteamSecrets(input: string): string {
  return input.replace(/([?&]key=)[^&\s"']+/gi, '$1[REDACTED]');
}

function formatSanitizedSteamError(err: unknown): string {
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
      parts.push(redactSteamSecrets(axErr.message.trim()));
    }
    if (parts.length > 0) {
      return parts.join(' - ');
    }
  }
  if (typeof err === 'string' && err.trim()) {
    return redactSteamSecrets(err.trim());
  }
  return 'Steam API request failed';
}

function formatSteamLastPlayedIso(rawLastPlayed: unknown): string | undefined {
  const numeric = typeof rawLastPlayed === 'number' ? rawLastPlayed : Number(rawLastPlayed);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    return undefined;
  }
  const epochMs = numeric < 1e12 ? numeric * 1000 : numeric;
  const dt = new Date(epochMs);
  return Number.isNaN(dt.getTime()) ? undefined : dt.toISOString();
}

export class SteamIntegrationService {
  private getApiBaseUrl(): string {
    return getDevProxyBaseForRoute('steamApi');
  }

  private getCommunityBaseUrl(): string {
    return getDevProxyBaseForRoute('steamCommunity');
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
        const url = `${this.getApiBaseUrl()}/ISteamUser/ResolveVanityURL/v0001/?key=${encodeURIComponent(apiKey)}&vanityurl=${encodeURIComponent(vanityName)}`;
        const res = await axios.get<SteamResolveVanityResponse>(url, { timeout: 6000 });
        if (res.data?.response?.success === 1 && res.data.response.steamid) {
          return res.data.response.steamid;
        }
      } catch (err: unknown) {
        console.warn('Failed to resolve vanity URL via Web API:', formatSanitizedSteamError(err));
      }
    }

    // Fallback: check community XML
    try {
      const url = `${this.getCommunityBaseUrl()}/id/${encodeURIComponent(vanityName)}/?xml=1`;
      const res = await axios.get<string>(url, { timeout: 6000, responseType: 'text' });
      const xml = typeof res.data === 'string' ? res.data : '';
      const match = xml.match(/<steamID64>(\d{17})<\/steamID64>/);
      if (match) return match[1];
    } catch (err: unknown) {
      console.warn(
        'Failed to resolve vanity URL via Steam Community XML:',
        formatSanitizedSteamError(err)
      );
    }

    return null;
  }

  /**
   * Fetch player profile summary (avatar, persona name)
   */
  async fetchPlayerProfile(steamId: string, apiKey?: string): Promise<SteamPlayerProfile> {
    let personaName = 'Steam User';
    let avatarUrl = DEFAULT_STEAM_AVATAR_URL;
    const encodedSteamId = encodeURIComponent(steamId);
    const profileUrl = `https://steamcommunity.com/profiles/${encodedSteamId}`;

    if (apiKey) {
      try {
        const url = `${this.getApiBaseUrl()}/ISteamUser/GetPlayerSummaries/v0002/?key=${encodeURIComponent(apiKey)}&steamids=${encodedSteamId}`;
        const res = await axios.get<SteamPlayerSummariesResponse>(url, { timeout: 6000 });
        const player = res.data?.response?.players?.[0];
        if (player) {
          personaName = player.personaname || personaName;
          avatarUrl = player.avatarfull || player.avatarmedium || avatarUrl;
        }
      } catch (err: unknown) {
        console.warn(
          'Failed to fetch player summaries from Steam API:',
          formatSanitizedSteamError(err)
        );
      }
    }

    if (personaName === 'Steam User') {
      try {
        const isNumeric = /^\d{17}$/.test(steamId);
        const pathSeg = isNumeric ? `profiles/${encodedSteamId}` : `id/${encodedSteamId}`;
        const xmlRes = await axios.get<string>(`${this.getCommunityBaseUrl()}/${pathSeg}/?xml=1`, {
          timeout: 6000,
          responseType: 'text',
        });
        const xml = typeof xmlRes.data === 'string' ? xmlRes.data : '';
        const nameMatch = xml.match(/<steamID><!\[CDATA\[([\s\S]*?)\]\]><\/steamID>/i);
        const avatarMatch = xml.match(/<avatarFull><!\[CDATA\[([\s\S]*?)\]\]><\/avatarFull>/i);
        if (nameMatch?.[1]) personaName = nameMatch[1].trim();
        if (avatarMatch?.[1]) avatarUrl = avatarMatch[1].trim();
      } catch (err: unknown) {
        console.warn(
          'Failed to fetch Steam Community XML profile summary:',
          formatSanitizedSteamError(err)
        );
      }
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
      throw new Error(
        'Steam ID is required to connect to Steam. Click "Sign In with Steam" or enter your SteamID64.'
      );
    }

    const profile = await this.fetchPlayerProfile(steamId, apiKey);
    const games: CanonicalGame[] = [];

    // Attempt 1: If API key provided, use IPlayerService/GetOwnedGames
    if (apiKey) {
      try {
        const url = `${this.getApiBaseUrl()}/IPlayerService/GetOwnedGames/v0001/?key=${encodeURIComponent(apiKey)}&steamid=${encodeURIComponent(steamId)}&include_appinfo=1&include_played_free_games=1&format=json`;
        const res = await axios.get<SteamOwnedGamesResponse>(url, { timeout: 10000 });
        const owned = res.data?.response?.games;

        if (Array.isArray(owned) && owned.length > 0) {
          profile.gamesCount = owned.length;

          for (const item of owned) {
            const appId = item.appid;
            const title = (item.name || `App ${appId}`).trim();
            const playtimeMins = item.playtime_forever || 0;
            const lastPlayed = formatSteamLastPlayedIso(item.rtime_last_played);

            games.push({
              id: `steam-${appId}`,
              title,
              sortTitle: getAlphabeticalTitleSortKey(title, true),
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
      } catch (err: unknown) {
        console.warn('Steam GetOwnedGames API call failed:', formatSanitizedSteamError(err));
      }
    }

    // Determine final games list
    let finalGames = games;

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
    } catch (err: unknown) {
      console.warn('Steam live achievements sync warning:', formatSanitizedSteamError(err));
    }

    return { profile, games: finalGames };
  }
}

export const steamIntegration = new SteamIntegrationService();
