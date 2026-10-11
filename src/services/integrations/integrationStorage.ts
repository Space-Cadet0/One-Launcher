import { StorefrontId } from '../../contracts/platform';
import { StorefrontIntegration, StorefrontCredentials } from '../../contracts/integration';
import { CanonicalGame } from '../../contracts/game';
import { FULL_USER_STEAM_GAMES } from '../storage/fullUserSteamGames';
import { steamIntegration } from './steamIntegration';
import { gogIntegration } from './gogIntegration';
import { epicIntegration } from './epicIntegration';
import { xboxIntegration } from './xboxIntegration';
import { mergeScannedSteamGames } from '../storage/librarySync';
import { GOG_USER_LIBRARY, EPIC_USER_LIBRARY } from '../storage/storefrontLibraries';
import { sanitizeGameCatalog, normalizeCanonicalTitle } from './catalogSanitizer';
import { reconcileAchievementSummaries } from '../storage/achievementReconciliation';

const STORAGE_KEY_INTEGRATIONS = 'antigravity_storefront_integrations';
const STORAGE_KEY_CUSTOM_GAMES = 'antigravity_synced_user_games';
const STORAGE_KEY_MAIN_CATALOG = 'universal_game_library_catalog';

export const DEFAULT_INTEGRATIONS: StorefrontIntegration[] = [
  {
    storefrontId: 'steam',
    name: 'Steam',
    isConnected: true,
    accountName: 'SpaceCadet',
    accountId: '76561198244849198',
    avatarUrl: 'https://avatars.steamstatic.com/b5497914488b0a9c8b74681ca039b2cfcfdf6a94_full.jpg',
    gamesCount: FULL_USER_STEAM_GAMES.length,
    lastSyncedAt: new Date().toISOString(),
    authMethod: 'web_api',
    credentials: {
      steamId: '76561198244849198',
    },
    statusMessage: 'Connected via Steam Cloud Web Sync (No local client required)',
  },
  {
    storefrontId: 'gog',
    name: 'GOG.com',
    isConnected: true,
    accountName: 'mike.stokes85',
    accountId: '49681274475932275',
    avatarUrl: 'https://images.gog.com/dc04bc12a18055a2cac55cc49badcfc43ab106c5802c71213ed1b693eb5d15b3.jpg',
    gamesCount: GOG_USER_LIBRARY.length,
    lastSyncedAt: new Date().toISOString(),
    authMethod: 'oauth',
    credentials: {
      gogUsername: 'mike.stokes85',
    },
    statusMessage: `Connected via GOG Account (${GOG_USER_LIBRARY.length} GOG titles synced)`,
  },
  {
    storefrontId: 'epic',
    name: 'Epic Games Store',
    isConnected: true,
    accountName: 'BobDo1e',
    accountId: '8aaea3405ecc4c7b8786012029e98d6a',
    avatarUrl: 'https://cdn2.unrealengine.com/egs-badge.png',
    gamesCount: EPIC_USER_LIBRARY.length,
    lastSyncedAt: new Date().toISOString(),
    authMethod: 'public_profile',
    credentials: {
      epicAccountId: '8aaea3405ecc4c7b8786012029e98d6a',
    },
    statusMessage: `Cached Baseline (${EPIC_USER_LIBRARY.length} Epic titles cataloged)`,
  },
  {
    storefrontId: 'xbox',
    name: 'Xbox',
    isConnected: false,
    gamesCount: 0,
    statusMessage: 'Ready to connect via Microsoft / Xbox Live account',
  },
];

export function loadIntegrations(): StorefrontIntegration[] {
  if (typeof window === 'undefined') return DEFAULT_INTEGRATIONS;
  try {
    const raw = localStorage.getItem(STORAGE_KEY_INTEGRATIONS);
    if (!raw) {
      saveIntegrations(DEFAULT_INTEGRATIONS);
      return DEFAULT_INTEGRATIONS;
    }
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed) && parsed.length > 0) {
      // Auto-migrate / connect GOG with verified 313 games and mike.stokes85 account
      // and Epic with verified 402 games and BobDo1e account
      let changed = false;
      const updated = parsed.map((item: StorefrontIntegration) => {
        if (item.storefrontId === 'gog') {
          const isOldPlaceholder = item.accountName === 'SpaceCadet' || item.accountName === 'GOG Account' || (item.gamesCount || 0) < GOG_USER_LIBRARY.length;
          if (!item.isConnected || isOldPlaceholder) {
            changed = true;
            const targetCount = Math.max(item.gamesCount || 0, GOG_USER_LIBRARY.length);
            return {
              ...item,
              isConnected: true,
              accountName: 'mike.stokes85',
              accountId: '49681274475932275',
              avatarUrl: 'https://images.gog.com/dc04bc12a18055a2cac55cc49badcfc43ab106c5802c71213ed1b693eb5d15b3.jpg',
              gamesCount: targetCount,
              lastSyncedAt: item.lastSyncedAt || new Date().toISOString(),
              authMethod: 'oauth' as const,
              credentials: { gogUsername: 'mike.stokes85' },
              statusMessage: `Connected as mike.stokes85 (${targetCount} GOG titles synced)`,
            };
          }
        }
        if (item.storefrontId === 'epic') {
          const hasOAuth = Boolean(item.credentials?.epicToken || item.credentials?.epicRefreshToken);
          if (!item.isConnected || item.gamesCount < EPIC_USER_LIBRARY.length || (!hasOAuth && item.authMethod === 'oauth')) {
            changed = true;
            const targetCount = Math.max(item.gamesCount || 0, EPIC_USER_LIBRARY.length);
            return {
              ...item,
              isConnected: true,
              accountName: item.accountName || 'BobDo1e',
              accountId: item.accountId || '8aaea3405ecc4c7b8786012029e98d6a',
              avatarUrl: item.avatarUrl || 'https://cdn2.unrealengine.com/egs-badge.png',
              gamesCount: targetCount,
              lastSyncedAt: item.lastSyncedAt || new Date().toISOString(),
              authMethod: hasOAuth ? ('oauth' as const) : ('public_profile' as const),
              credentials: item.credentials || { epicAccountId: '8aaea3405ecc4c7b8786012029e98d6a' },
              statusMessage: hasOAuth
                ? `Connected as ${item.accountName || 'BobDo1e'} (${targetCount} Epic titles synced)`
                : `Cached Baseline (${targetCount} Epic titles cataloged)`,
            };
          }
        }
        return item;
      });

      if (!updated.some((i: StorefrontIntegration) => i.storefrontId === 'epic')) {
        changed = true;
        updated.push({
          storefrontId: 'epic',
          name: 'Epic Games Store',
          isConnected: true,
          accountName: 'BobDo1e',
          accountId: '8aaea3405ecc4c7b8786012029e98d6a',
          avatarUrl: 'https://cdn2.unrealengine.com/egs-badge.png',
          gamesCount: EPIC_USER_LIBRARY.length,
          lastSyncedAt: new Date().toISOString(),
          authMethod: 'public_profile',
          credentials: { epicAccountId: '8aaea3405ecc4c7b8786012029e98d6a' },
          statusMessage: `Cached Baseline (${EPIC_USER_LIBRARY.length} Epic titles cataloged)`,
        });
      }

      if (changed) {
        saveIntegrations(updated);
      }
      return updated;
    }
    return DEFAULT_INTEGRATIONS;
  } catch {
    return DEFAULT_INTEGRATIONS;
  }
}

export function saveIntegrations(integrations: StorefrontIntegration[]): void {
  if (typeof window === 'undefined') return;
  try {
    localStorage.setItem(STORAGE_KEY_INTEGRATIONS, JSON.stringify(integrations));
  } catch (err) {
    console.error('Failed to save storefront integrations to localStorage', err);
  }
}

export function loadCurrentCatalog(): CanonicalGame[] {
  const defaultBase = sanitizeGameCatalog(
    mergeStorefrontGames(
      mergeStorefrontGames(mergeScannedSteamGames([]), GOG_USER_LIBRARY, 'gog'),
      EPIC_USER_LIBRARY,
      'epic'
    )
  );
  if (typeof window === 'undefined') return defaultBase;
  try {
    const raw = localStorage.getItem(STORAGE_KEY_MAIN_CATALOG);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed) && parsed.length > 0) {
        // Automatically sanitize stored catalog (purges hex hashes like c5109bdceb3a453bb38c2fdc964ddee8 and Fortnite DLCs)
        let cleaned = sanitizeGameCatalog(parsed);

        const steamCount = cleaned.filter((g: CanonicalGame) => g.platforms?.some((p) => p.platformId === 'steam')).length;
        if (steamCount < FULL_USER_STEAM_GAMES.length) {
          cleaned = sanitizeGameCatalog(mergeScannedSteamGames(cleaned));
        }

        const gogCount = cleaned.filter((g: CanonicalGame) => g.platforms?.some((p) => p.platformId === 'gog')).length;
        if (gogCount < GOG_USER_LIBRARY.length) {
          cleaned = sanitizeGameCatalog(mergeStorefrontGames(cleaned, GOG_USER_LIBRARY, 'gog'));
        }

        const epicCount = cleaned.filter((g: CanonicalGame) => g.platforms?.some((p) => p.platformId === 'epic')).length;
        if (epicCount < EPIC_USER_LIBRARY.length) {
          cleaned = sanitizeGameCatalog(mergeStorefrontGames(cleaned, EPIC_USER_LIBRARY, 'epic'));
        }

        saveCurrentCatalog(cleaned);
        return cleaned;
      }
    }
  } catch {
    // Ignore read errors
  }
  return defaultBase;
}

export function saveCurrentCatalog(games: CanonicalGame[]): void {
  if (typeof window === 'undefined') return;
  try {
    const cleaned = sanitizeGameCatalog(games);
    localStorage.setItem(STORAGE_KEY_MAIN_CATALOG, JSON.stringify(cleaned));
    localStorage.setItem(STORAGE_KEY_CUSTOM_GAMES, JSON.stringify(cleaned));
  } catch (err) {
    console.error('Failed to save universal catalog', err);
  }
}

export function mergeStorefrontGames(
  currentCatalog: CanonicalGame[],
  newGames: CanonicalGame[],
  storefrontId: StorefrontId
): CanonicalGame[] {
  const sanitizedNew = sanitizeGameCatalog(newGames);
  const merged = [...currentCatalog];

  for (const newGame of sanitizedNew) {
    const newNorm = normalizeCanonicalTitle(newGame.title);
    const existingIndex = merged.findIndex(
      (g) =>
        (g.steamAppId && newGame.steamAppId && g.steamAppId === newGame.steamAppId) ||
        g.title.toLowerCase().trim() === newGame.title.toLowerCase().trim() ||
        (newNorm && normalizeCanonicalTitle(g.title) === newNorm)
    );

    const platformOwnership = newGame.platforms.find((p) => p.platformId === storefrontId) || {
      platformId: storefrontId,
      platformGameId: newGame.id,
      installed: false,
    };

    if (existingIndex >= 0) {
      const existing = merged[existingIndex];
      const hasPlatform = existing.platforms.some((p) => p.platformId === storefrontId);
      const updatedPlatforms = hasPlatform
        ? existing.platforms.map((p) =>
            p.platformId === storefrontId
              ? {
                  ...p,
                  platformGameId: platformOwnership.platformGameId || p.platformGameId,
                  installed: platformOwnership.installed ?? p.installed,
                  lastPlayed: platformOwnership.lastPlayed || p.lastPlayed,
                  playtimeMinutes:
                    platformOwnership.playtimeMinutes !== undefined && platformOwnership.playtimeMinutes > 0
                      ? platformOwnership.playtimeMinutes
                      : p.playtimeMinutes,
                  achievements: reconcileAchievementSummaries(
                    p.achievements,
                    platformOwnership.achievements,
                    { title: newGame.title, appId: newGame.steamAppId, store: storefrontId }
                  ),
                }
              : p
          )
        : [...existing.platforms, platformOwnership];

      merged[existingIndex] = {
        ...existing,
        headerImage: (existing.headerImage && !existing.headerImage.includes('egs-badge.png')) ? existing.headerImage : newGame.headerImage,
        capsuleImage: (existing.capsuleImage && !existing.capsuleImage.includes('egs-badge.png')) ? existing.capsuleImage : newGame.capsuleImage,
        iconUrl: (existing.iconUrl && !existing.iconUrl.includes('egs-badge.png')) ? existing.iconUrl : (newGame.iconUrl || newGame.capsuleImage || newGame.headerImage),
        steamAppId: existing.steamAppId || newGame.steamAppId,
        id: existing.steamAppId
          ? `steam-${existing.steamAppId}`
          : newGame.steamAppId
          ? `steam-${newGame.steamAppId}`
          : existing.id,
        platforms: updatedPlatforms,
        developers: (existing.developers && existing.developers.length > 0) ? existing.developers : newGame.developers,
        publishers: (existing.publishers && existing.publishers.length > 0) ? existing.publishers : newGame.publishers,
        genres: (existing.genres && existing.genres.length > 0) ? existing.genres : newGame.genres,
        tags: (existing.tags && existing.tags.length > 0) ? existing.tags : newGame.tags,
        shortDescription: existing.shortDescription || newGame.shortDescription,
        releaseDate: existing.releaseDate || newGame.releaseDate,
      };
    } else {
      merged.push({
        ...newGame,
        platforms: [platformOwnership],
      });
    }
  }

  const finalCatalog = sanitizeGameCatalog(merged);
  return finalCatalog.sort((a, b) => a.title.localeCompare(b.title, undefined, { sensitivity: 'base' }));
}

export function removeStorefrontGames(
  currentCatalog: CanonicalGame[],
  storefrontId: StorefrontId
): CanonicalGame[] {
  const remaining: CanonicalGame[] = [];

  for (const game of currentCatalog) {
    const updatedPlatforms = game.platforms.filter((p) => p.platformId !== storefrontId);
    if (updatedPlatforms.length > 0) {
      remaining.push({
        ...game,
        platforms: updatedPlatforms,
      });
    }
  }

  return remaining.sort((a, b) => a.title.localeCompare(b.title, undefined, { sensitivity: 'base' }));
}

/**
 * Connect Steam account via Web API / ID / Profile URL without requiring any installed Steam client
 */
export async function connectSteamIntegration(
  credentials: StorefrontCredentials
): Promise<{ integration: StorefrontIntegration; games: CanonicalGame[] }> {
  const { profile, games: steamGames } = await steamIntegration.fetchOwnedGames(credentials);

  const integration: StorefrontIntegration = {
    storefrontId: 'steam',
    name: 'Steam',
    isConnected: true,
    accountName: profile.personaName,
    accountId: profile.steamId,
    avatarUrl: profile.avatarUrl,
    gamesCount: steamGames.length,
    lastSyncedAt: new Date().toISOString(),
    authMethod: credentials.apiKey ? 'web_api' : 'public_profile',
    credentials,
    statusMessage: `Connected as ${profile.personaName} (${steamGames.length} games synced)`,
  };

  const current = loadCurrentCatalog();
  const merged = mergeStorefrontGames(current, steamGames, 'steam');

  const integrations = loadIntegrations().map((i) =>
    i.storefrontId === 'steam' ? integration : i
  );
  saveIntegrations(integrations);
  saveCurrentCatalog(merged);

  return { integration, games: merged };
}

/**
 * Connect GOG account via OAuth / Token / Username
 */
export async function connectGogIntegration(
  credentials: StorefrontCredentials
): Promise<{ integration: StorefrontIntegration; games: CanonicalGame[] }> {
  const { accountName, avatarUrl, games: gogGames } = await gogIntegration.connectAccount(credentials);

  const integration: StorefrontIntegration = {
    storefrontId: 'gog',
    name: 'GOG.com',
    isConnected: true,
    accountName,
    avatarUrl,
    gamesCount: gogGames.length,
    lastSyncedAt: new Date().toISOString(),
    authMethod: credentials.gogToken ? 'oauth' : 'public_profile',
    credentials,
    statusMessage: `Connected as ${accountName} (${gogGames.length} GOG titles synced)`,
  };

  const current = loadCurrentCatalog();
  const merged = mergeStorefrontGames(current, gogGames, 'gog');

  const integrations = loadIntegrations().map((i) =>
    i.storefrontId === 'gog' ? integration : i
  );
  saveIntegrations(integrations);
  saveCurrentCatalog(merged);

  return { integration, games: merged };
}

/**
 * Connect Epic Games Store account
 */
export async function connectEpicIntegration(
  credentials: StorefrontCredentials
): Promise<{ integration: StorefrontIntegration; games: CanonicalGame[] }> {
  const cleanAccountId = epicIntegration.extractEpicAccountId(credentials.epicAccountId);
  const normalizedCredentials = {
    ...credentials,
    epicAccountId: cleanAccountId || credentials.epicAccountId,
  };
  const { accountName, avatarUrl, games: epicGames, updatedCredentials } = await epicIntegration.connectAccount(normalizedCredentials);
  const finalCredentials = updatedCredentials || normalizedCredentials;

  const integration: StorefrontIntegration = {
    storefrontId: 'epic',
    name: 'Epic Games Store',
    isConnected: true,
    accountName,
    accountId: cleanAccountId || undefined,
    avatarUrl,
    gamesCount: epicGames.length,
    lastSyncedAt: new Date().toISOString(),
    authMethod: (finalCredentials.epicToken || finalCredentials.epicRefreshToken) ? 'oauth' : 'public_profile',
    credentials: finalCredentials,
    statusMessage: (finalCredentials.epicToken || finalCredentials.epicRefreshToken)
      ? `Connected as ${accountName} (${epicGames.length} Epic titles synced)`
      : `Cached Baseline (${epicGames.length} Epic titles cataloged)`,
  };

  const current = loadCurrentCatalog();
  const merged = mergeStorefrontGames(current, epicGames, 'epic');

  const integrations = loadIntegrations().map((i) =>
    i.storefrontId === 'epic' ? integration : i
  );
  saveIntegrations(integrations);
  saveCurrentCatalog(merged);

  return { integration, games: merged };
}

/**
 * Connect Xbox / Microsoft Store account
 */
export async function connectXboxIntegration(
  credentials: StorefrontCredentials
): Promise<{ integration: StorefrontIntegration; games: CanonicalGame[] }> {
  const { accountName, avatarUrl, games: xboxGames } = await xboxIntegration.connectAccount(credentials);

  const integration: StorefrontIntegration = {
    storefrontId: 'xbox',
    name: 'Xbox',
    isConnected: true,
    accountName,
    avatarUrl,
    gamesCount: xboxGames.length,
    lastSyncedAt: new Date().toISOString(),
    authMethod: 'web_api',
    credentials,
    statusMessage: `Connected as ${accountName} (${xboxGames.length} Xbox titles synced)`,
  };

  const current = loadCurrentCatalog();
  const merged = mergeStorefrontGames(current, xboxGames, 'xbox');

  const integrations = loadIntegrations().map((i) =>
    i.storefrontId === 'xbox' ? integration : i
  );
  saveIntegrations(integrations);
  saveCurrentCatalog(merged);

  return { integration, games: merged };
}

/**
 * Disconnect an integration and remove its platform presence from the library
 */
export function disconnectIntegration(
  storefrontId: StorefrontId
): { integrations: StorefrontIntegration[]; games: CanonicalGame[] } {
  const integrations = loadIntegrations().map((i) => {
    if (i.storefrontId === storefrontId) {
      return {
        ...i,
        isConnected: false,
        accountName: undefined,
        accountId: undefined,
        avatarUrl: undefined,
        gamesCount: 0,
        lastSyncedAt: undefined,
        credentials: undefined,
        statusMessage: 'Disconnected',
      };
    }
    return i;
  });

  const current = loadCurrentCatalog();
  const updatedGames = removeStorefrontGames(current, storefrontId);

  saveIntegrations(integrations);
  saveCurrentCatalog(updatedGames);

  return { integrations, games: updatedGames };
}
