import { CanonicalGame, XboxGamePassSyncMode } from '../../../contracts/game';
import { StorefrontCredentials, StorefrontIntegration } from '../../../contracts/integration';
import { StorefrontId } from '../../../contracts/platform';
import { getSafeLocalStorage } from '../../common/runtimeEnv';
import { cacheUserXboxAchievements } from '../../storage/knownGameAchievements';
import { epicIntegration } from '../epicIntegration';
import { gogIntegration } from '../gogIntegration';
import { steamIntegration } from '../steamIntegration';
import { xboxIntegration } from '../xboxIntegration';
import { mergeStorefrontGames, removeStorefrontGames } from './catalogMerger';
import { loadCurrentCatalog, saveCurrentCatalog } from './catalogPersistence';
import {
  clearXboxProfileState,
  enqueueIntegrationMutation,
  formatXboxIntegrationStatusMessage,
  loadIntegrations,
  saveIntegrations,
  saveXboxProfileState,
} from './entitlementsAndProfileStore';

const STOREFRONT_ACHIEVEMENT_STORAGE_KEYS: Partial<Record<StorefrontId, readonly string[]>> = {
  steam: ['antigravity_steam_achievements', 'antigravity_steam_achievements_last_sync'],
  gog: ['antigravity_gog_achievements', 'antigravity_user_gog_achievements'],
  epic: ['antigravity_epic_achievements', 'antigravity_user_epic_achievements'],
  xbox: ['antigravity_xbox_achievements', 'antigravity_user_xbox_achievements'],
};

function clearPerStorefrontAchievementCaches(storefrontId: StorefrontId): void {
  const storage = getSafeLocalStorage();
  if (storage) {
    const keys = STOREFRONT_ACHIEVEMENT_STORAGE_KEYS[storefrontId] || [];
    for (const key of keys) {
      try {
        storage.removeItem(key);
      } catch {
        // Ignore storage removal errors
      }
    }
    try {
      const legacyDetailKeys: string[] = [];
      for (let i = 0; i < storage.length; i++) {
        const key = storage.key(i);
        if (
          key &&
          (key.startsWith('antigravity_detailed_achievements_') ||
            key.startsWith('antigravity_achievement_details_'))
        ) {
          legacyDetailKeys.push(key);
        }
      }
      for (const k of legacyDetailKeys) {
        storage.removeItem(k);
      }
    } catch {
      // Ignore legacy detail key sweep errors
    }
  }

  // Clear in-memory / IDB detailed achievement cache asynchronously (dynamic import preserves 3-tier Rollup DAG)
  void import('../../achievements/achievementDetailService')
    .then((mod) => {
      const svc = mod?.achievementDetailService as
        | {
            clearStorefrontCache?: (store: StorefrontId) => void;
            clearCache?: () => void;
          }
        | undefined;
      if (typeof svc?.clearStorefrontCache === 'function') {
        svc.clearStorefrontCache(storefrontId);
      } else if (typeof svc?.clearCache === 'function') {
        svc.clearCache();
      }
    })
    .catch(() => {});
}

/**
 * Connect Steam account via Web API / ID / Profile URL without requiring any installed Steam client.
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

  return enqueueIntegrationMutation(() => {
    const current = loadCurrentCatalog();
    const merged = mergeStorefrontGames(current, steamGames, 'steam');

    const integrations = loadIntegrations().map((i) =>
      i.storefrontId === 'steam' ? integration : i
    );
    saveIntegrations(integrations);
    // mergeStorefrontGames already returned a freshly sanitized + override-applied catalog
    saveCurrentCatalog(merged, { skipSanitize: true });

    return { integration, games: merged };
  });
}

/**
 * Connect GOG account via OAuth / Token / Username.
 */
export async function connectGogIntegration(
  credentials: StorefrontCredentials
): Promise<{
  integration: StorefrontIntegration;
  games: CanonicalGame[];
  authoritativeComplete?: boolean;
}> {
  const {
    accountName,
    avatarUrl,
    games: gogGames,
    authoritativeComplete,
  } = await gogIntegration.connectAccount(credentials);

  return enqueueIntegrationMutation(() => {
    const current = loadCurrentCatalog();
    const shouldMerge = gogGames.length > 0 || Boolean(authoritativeComplete);
    const merged = shouldMerge
      ? mergeStorefrontGames(current, gogGames, 'gog', {
          authoritativeComplete: Boolean(authoritativeComplete),
        })
      : current;
    const gogCount = shouldMerge
      ? merged.filter((g) => g.platforms.some((p) => p.platformId === 'gog')).length
      : current.filter((g) => g.platforms.some((p) => p.platformId === 'gog')).length;

    const integration: StorefrontIntegration = {
      storefrontId: 'gog',
      name: 'GOG.com',
      isConnected: true,
      accountName,
      avatarUrl,
      gamesCount: gogCount,
      lastSyncedAt: new Date().toISOString(),
      authMethod: credentials.gogToken ? 'oauth' : 'public_profile',
      credentials,
      statusMessage: `Connected as ${accountName} (${gogCount} GOG titles synced)`,
    };

    const integrations = loadIntegrations().map((i) =>
      i.storefrontId === 'gog' ? integration : i
    );
    saveIntegrations(integrations);
    if (shouldMerge) {
      saveCurrentCatalog(merged, { skipSanitize: true });
    }

    return { integration, games: merged, authoritativeComplete };
  });
}

/**
 * Connect Epic Games Store account.
 */
export async function connectEpicIntegration(
  credentials: StorefrontCredentials
): Promise<{
  integration: StorefrontIntegration;
  games: CanonicalGame[];
  authoritativeComplete?: boolean;
}> {
  const cleanAccountId = epicIntegration.extractEpicAccountId(credentials.epicAccountId);
  const normalizedCredentials = {
    ...credentials,
    epicAccountId: cleanAccountId || credentials.epicAccountId,
  };
  const {
    accountName,
    avatarUrl,
    games: epicGames,
    updatedCredentials,
    authoritativeComplete,
  } = await epicIntegration.connectAccount(normalizedCredentials);
  const finalCredentials = updatedCredentials || normalizedCredentials;

  return enqueueIntegrationMutation(() => {
    const current = loadCurrentCatalog();
    const shouldMerge = epicGames.length > 0 || Boolean(authoritativeComplete);
    const merged = shouldMerge
      ? mergeStorefrontGames(current, epicGames, 'epic', {
          authoritativeComplete: Boolean(authoritativeComplete),
        })
      : current;
    const epicCount = shouldMerge
      ? merged.filter((g) => g.platforms.some((p) => p.platformId === 'epic')).length
      : current.filter((g) => g.platforms.some((p) => p.platformId === 'epic')).length;

    const integration: StorefrontIntegration = {
      storefrontId: 'epic',
      name: 'Epic Games Store',
      isConnected: true,
      accountName,
      accountId: cleanAccountId || undefined,
      avatarUrl,
      gamesCount: epicCount,
      lastSyncedAt: new Date().toISOString(),
      authMethod:
        finalCredentials.epicToken || finalCredentials.epicRefreshToken
          ? 'oauth'
          : 'public_profile',
      credentials: finalCredentials,
      statusMessage:
        finalCredentials.epicToken || finalCredentials.epicRefreshToken
          ? `Connected as ${accountName} (${epicCount} Epic titles synced)`
          : `Cached Baseline (${epicCount} Epic titles cataloged)`,
    };

    const integrations = loadIntegrations().map((i) =>
      i.storefrontId === 'epic' ? integration : i
    );
    saveIntegrations(integrations);
    if (shouldMerge) {
      saveCurrentCatalog(merged, { skipSanitize: true });
    }

    return { integration, games: merged, authoritativeComplete };
  });
}

/**
 * Connect Xbox / Microsoft Store / Game Pass account.
 */
export async function connectXboxIntegration(
  credentials: StorefrontCredentials & { syncMode?: XboxGamePassSyncMode; forceRefresh?: boolean }
): Promise<{
  integration: StorefrontIntegration;
  games: CanonicalGame[];
  authoritativeComplete?: boolean;
}> {
  const syncRes = await xboxIntegration.syncXboxAccount(credentials);
  const {
    accountName,
    gamertag,
    modernGamertag,
    xuid,
    avatarUrl,
    gamerscore,
    subscription,
    syncMode,
    games: xboxGames,
    achievements,
    authoritativeComplete,
  } = syncRes;

  return enqueueIntegrationMutation(() => {
    if (achievements && typeof achievements === 'object' && Object.keys(achievements).length > 0) {
      cacheUserXboxAchievements(achievements);
    }

    const syncedAt = new Date().toISOString();
    saveXboxProfileState({
      connected: true,
      gamertag: gamertag || accountName,
      modernGamertag: modernGamertag || gamertag || accountName,
      xuid,
      avatarUrl,
      gamerscore,
      subscription: subscription ?? null,
      syncMode: syncMode || credentials?.syncMode,
      lastSyncedAt: syncedAt,
    });

    const {
      webToken: _wt,
      syncMode: _sm,
      forceRefresh: _fr,
      ...safeCredentials
    } = credentials || {};

    const current = loadCurrentCatalog();
    const merged = mergeStorefrontGames(current, xboxGames, 'xbox', {
      authoritativeComplete,
    });
    const xboxCount = merged.filter((g) =>
      g.platforms?.some((p) => p.platformId === 'xbox')
    ).length;

    const displayGamertag = modernGamertag || gamertag || accountName;

    const integration: StorefrontIntegration = {
      storefrontId: 'xbox',
      name: 'Xbox',
      isConnected: true,
      accountName: displayGamertag,
      accountId: xuid || undefined,
      avatarUrl,
      gamesCount: xboxCount,
      lastSyncedAt: syncedAt,
      authMethod: 'oauth',
      credentials: safeCredentials,
      statusMessage: formatXboxIntegrationStatusMessage(displayGamertag, xboxCount, subscription),
    };

    const integrations = loadIntegrations().map((i) =>
      i.storefrontId === 'xbox' ? integration : i
    );
    saveIntegrations(integrations);
    saveCurrentCatalog(merged, { skipSanitize: true });

    return { integration, games: merged, authoritativeComplete };
  });
}

/**
 * Disconnect an integration, remove its platform presence from the library,
 * and wipe per-storefront cached achievement state to prevent cross-account leakage.
 */
export function disconnectIntegration(
  storefrontId: StorefrontId
): { integrations: StorefrontIntegration[]; games: CanonicalGame[] } {
  if (storefrontId === 'xbox') {
    clearXboxProfileState();
  }
  clearPerStorefrontAchievementCaches(storefrontId);
  if (typeof window !== 'undefined') {
    if (window.electronAPI?.clearTokens) {
      try {
        window.electronAPI.clearTokens(storefrontId);
      } catch (err) {
        console.warn(`Failed to clear tokens for ${storefrontId}:`, err);
      }
    }
    if (window.electronAPI?.disconnectStore) {
      try {
        void window.electronAPI.disconnectStore(storefrontId)?.catch?.(() => {});
      } catch (err) {
        console.warn(`Failed to disconnect store ${storefrontId}:`, err);
      }
    }
  }
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
