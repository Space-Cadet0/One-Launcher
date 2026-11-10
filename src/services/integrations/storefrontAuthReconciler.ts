import type { CanonicalGame, XboxGamePassSyncMode } from '../../contracts/game';
import type { StorefrontCredentials, StorefrontIntegration } from '../../contracts/integration';
import type { StorefrontId } from '../../contracts/platform';
import type {
  ElectronAPI,
  SavedStoreTokensMap,
  StorefrontTokenSummary,
} from '../../types/electron';

export type XboxStatusSnapshot = Partial<
  NonNullable<Awaited<ReturnType<NonNullable<ElectronAPI['getXboxStatus']>>>>
>;
import {
  registerSuppressedCatalogEntries,
  type SuppressedCatalogEntry,
} from './catalogSanitizer';
import { normalizeGogAvatarUrl } from './gogIntegration';
import {
  formatXboxIntegrationStatusMessage,
  loadCurrentCatalog,
  loadIntegrations,
  loadXboxProfileState,
  saveIntegrations,
  saveXboxProfileState,
  type XboxCachedProfileState,
} from './integrationStorage';

export type ExtendedSavedStoreTokenSummary = StorefrontTokenSummary & {
  uhs?: string;
  expires_at?: number | string;
};

export type ExtendedSavedStoreTokensMap = SavedStoreTokensMap & {
  steam?: ExtendedSavedStoreTokenSummary;
  gog?: ExtendedSavedStoreTokenSummary;
  epic?: ExtendedSavedStoreTokenSummary;
  xbox?: ExtendedSavedStoreTokenSummary;
  suppressedItems?: SuppressedCatalogEntry[];
};

export interface ReconcileStorefrontAuthOptions {
  savedTokens?: ExtendedSavedStoreTokensMap | null;
  xboxStatus?: XboxStatusSnapshot | null;
  initialIntegrations?: StorefrontIntegration[];
  activeCatalog?: CanonicalGame[];
  persistIfChanged?: boolean;
  dispatchXboxProfileEvent?: boolean;
}

export interface ReconcileStorefrontAuthResult {
  integrations: StorefrontIntegration[];
  changed: boolean;
  xboxProfile: XboxCachedProfileState | null;
}

/**
 * Strips all secret tokens/keys so renderer localStorage only persists non-secret public identifiers.
 */
export function sanitizePublicCredentials(
  storefrontId: StorefrontId,
  creds?: StorefrontCredentials
): StorefrontCredentials {
  if (!creds || storefrontId === 'xbox') return {};
  const next: StorefrontCredentials = {};
  if (creds.steamId) next.steamId = creds.steamId;
  if (creds.profileUrl) next.profileUrl = creds.profileUrl;
  if (creds.vanityUrl) next.vanityUrl = creds.vanityUrl;
  if (creds.gogUsername) next.gogUsername = creds.gogUsername;
  if (creds.epicAccountId) next.epicAccountId = creds.epicAccountId;
  if (creds.epicTokenExpiresAt !== undefined) next.epicTokenExpiresAt = creds.epicTokenExpiresAt;
  return next;
}

/**
 * Loads integrations from storage and scrubs any legacy secret tokens/keys if present.
 */
export function scrubPersistedIntegrationSecrets(
  sourceIntegrations?: StorefrontIntegration[]
): StorefrontIntegration[] {
  const loaded = sourceIntegrations ?? loadIntegrations();
  let mutated = false;
  const cleaned = loaded.map((integ) => {
    const raw = integ.credentials;
    if (
      raw &&
      (raw.apiKey ||
        raw.webToken ||
        raw.gogToken ||
        raw.epicToken ||
        raw.epicRefreshToken)
    ) {
      mutated = true;
      return {
        ...integ,
        credentials: sanitizePublicCredentials(integ.storefrontId, raw),
      };
    }
    return integ;
  });
  if (mutated && !sourceIntegrations) {
    saveIntegrations(cleaned);
  }
  return cleaned;
}

/**
 * Shared reconciler for Steam, GOG, Epic, and Xbox native OAuth session summaries returned by
 * `window.electronAPI.getSavedTokens()` and `window.electronAPI.getXboxStatus()`.
 * Guarantees non-secret renderer credential persistence across both boot sync and IntegrationsModal.
 */
export function reconcileNativeStorefrontAuthSessions(
  options: ReconcileStorefrontAuthOptions
): ReconcileStorefrontAuthResult {
  const savedTokens = options.savedTokens ?? null;
  const xboxStatus = options.xboxStatus ?? null;
  let updatedIntegrations = scrubPersistedIntegrationSecrets(options.initialIntegrations);
  let integrationsChanged = false;
  let resolvedXboxProfile: XboxCachedProfileState | null = loadXboxProfileState();

  const getCatalog = (() => {
    let cached: CanonicalGame[] | null = options.activeCatalog ?? null;
    return (): CanonicalGame[] => {
      if (!cached) {
        cached = loadCurrentCatalog();
      }
      return cached;
    };
  })();

  // 1. Reconcile Steam saved token (strictly non-secret identity)
  const steamSaved = savedTokens?.steam;
  if (
    steamSaved?.steamId ||
    steamSaved?.hasAccessToken ||
    steamSaved?.access_token ||
    steamSaved?.connected
  ) {
    const steamInteg = updatedIntegrations.find((i) => i.storefrontId === 'steam');
    const steamId =
      steamSaved.steamId || steamInteg?.credentials?.steamId || steamInteg?.accountId;
    const accountName =
      steamSaved.accountName || steamInteg?.accountName || 'Steam User';
    if (
      !steamInteg ||
      !steamInteg.isConnected ||
      !steamInteg.credentials?.steamId ||
      (steamId && steamInteg.credentials.steamId !== steamId) ||
      steamInteg.accountName !== accountName
    ) {
      const count =
        (Array.isArray(steamSaved.games) && steamSaved.games.length) ||
        steamInteg?.gamesCount ||
        getCatalog().filter((g) => g.platforms.some((p) => p.platformId === 'steam')).length;
      updatedIntegrations = updatedIntegrations.map((i) =>
        i.storefrontId === 'steam'
          ? {
              ...i,
              isConnected: true,
              accountName,
              accountId: steamId,
              avatarUrl: steamSaved.avatarUrl || i.avatarUrl,
              gamesCount: count,
              lastSyncedAt: steamSaved.updatedAt || new Date().toISOString(),
              authMethod: 'oauth' as const,
              credentials: sanitizePublicCredentials('steam', {
                ...i.credentials,
                steamId,
              }),
              statusMessage: `Connected as ${accountName} (${count} titles synced)`,
            }
          : i
      );
      integrationsChanged = true;
    }
  }

  // 2. Reconcile GOG saved token (never persist access/refresh tokens in localStorage)
  const gogSaved = savedTokens?.gog;
  if (
    gogSaved?.hasAccessToken ||
    gogSaved?.access_token ||
    gogSaved?.connected ||
    gogSaved?.user_id
  ) {
    const gogInteg = updatedIntegrations.find((i) => i.storefrontId === 'gog');
    const gogUserId = gogSaved.user_id || gogInteg?.accountId;
    const resolvedGogAvatar =
      normalizeGogAvatarUrl(gogSaved.avatarUrl, gogSaved.avatars) ||
      normalizeGogAvatarUrl(gogInteg?.avatarUrl) ||
      gogInteg?.avatarUrl;
    const accountName =
      (gogSaved.username && gogSaved.username !== 'GOG User' ? gogSaved.username : undefined) ||
      (gogInteg?.accountName && gogInteg.accountName !== 'GOG User'
        ? gogInteg.accountName
        : undefined) ||
      gogSaved.username ||
      'GOG User';
    if (
      !gogInteg ||
      !gogInteg.isConnected ||
      (resolvedGogAvatar && gogInteg.avatarUrl !== resolvedGogAvatar) ||
      gogInteg.accountName !== accountName
    ) {
      const count =
        gogInteg?.gamesCount && gogInteg.gamesCount > 0
          ? gogInteg.gamesCount
          : getCatalog().filter((g) => g.platforms.some((p) => p.platformId === 'gog')).length;
      updatedIntegrations = updatedIntegrations.map((i) =>
        i.storefrontId === 'gog'
          ? {
              ...i,
              isConnected: true,
              accountName,
              accountId: gogUserId,
              avatarUrl: resolvedGogAvatar || i.avatarUrl,
              gamesCount: count,
              lastSyncedAt: gogSaved.updatedAt || new Date().toISOString(),
              authMethod: 'oauth' as const,
              credentials: sanitizePublicCredentials('gog', {
                ...i.credentials,
                gogUsername:
                  accountName !== 'GOG User' ? accountName : i.credentials?.gogUsername,
              }),
              statusMessage: `Connected as ${accountName} (${count} titles synced)`,
            }
          : i
      );
      integrationsChanged = true;
    }
  }

  // 3. Reconcile Epic saved token (never persist access/refresh tokens in localStorage)
  const epicSaved = savedTokens?.epic;
  if (
    epicSaved?.hasAccessToken ||
    epicSaved?.access_token ||
    epicSaved?.connected ||
    epicSaved?.account_id
  ) {
    const epicInteg = updatedIntegrations.find((i) => i.storefrontId === 'epic');
    const displayName = epicSaved.displayName || epicInteg?.accountName || 'Epic User';
    const rawExpires = epicSaved.expires_at ?? epicSaved.expiresAt;
    const normalizedExpires =
      typeof rawExpires === 'number' || typeof rawExpires === 'string'
        ? rawExpires
        : undefined;
    const nextAccountId = epicSaved.account_id || epicInteg?.accountId;
    if (
      !epicInteg ||
      !epicInteg.isConnected ||
      epicInteg.accountName !== displayName ||
      (nextAccountId && epicInteg.credentials?.epicAccountId !== nextAccountId)
    ) {
      const count =
        epicInteg?.gamesCount && epicInteg.gamesCount > 0
          ? epicInteg.gamesCount
          : getCatalog().filter((g) => g.platforms.some((p) => p.platformId === 'epic')).length;
      updatedIntegrations = updatedIntegrations.map((i) =>
        i.storefrontId === 'epic'
          ? {
              ...i,
              isConnected: true,
              accountName: displayName,
              accountId: nextAccountId,
              gamesCount: count,
              lastSyncedAt: epicSaved.updatedAt || new Date().toISOString(),
              authMethod: 'oauth' as const,
              credentials: sanitizePublicCredentials('epic', {
                epicAccountId: nextAccountId || i.credentials?.epicAccountId,
                epicTokenExpiresAt: normalizedExpires ?? i.credentials?.epicTokenExpiresAt,
              }),
              statusMessage: `Connected as ${displayName} (${count} titles synced)`,
            }
          : i
      );
      integrationsChanged = true;
    }
  }

  // 4. Reconcile Xbox saved session & Game Pass status (strictly non-secret state)
  const xboxSaved = savedTokens?.xbox;
  const hasSavedXbox = Boolean(
    xboxStatus?.connected ||
      xboxSaved?.connected ||
      xboxSaved?.hasAccessToken ||
      xboxSaved?.hasRefreshToken ||
      xboxSaved?.xuid ||
      xboxSaved?.gamertag ||
      xboxSaved?.access_token ||
      xboxSaved?.uhs
  );
  if (hasSavedXbox) {
    const cachedProfile = resolvedXboxProfile;
    const xboxInteg = updatedIntegrations.find((i) => i.storefrontId === 'xbox');
    const gamertag =
      xboxStatus?.modernGamertag ||
      xboxStatus?.gamertag ||
      xboxStatus?.accountName ||
      xboxSaved?.modernGamertag ||
      xboxSaved?.gamertag ||
      cachedProfile?.modernGamertag ||
      cachedProfile?.gamertag ||
      xboxInteg?.accountName ||
      'Xbox Live User';
    const xuid =
      xboxStatus?.xuid ||
      xboxSaved?.xuid ||
      cachedProfile?.xuid ||
      xboxInteg?.accountId;
    const avatarUrl =
      xboxStatus?.avatarUrl ||
      xboxStatus?.gamerpicUrl ||
      xboxSaved?.avatarUrl ||
      xboxSaved?.gamerpicUrl ||
      cachedProfile?.avatarUrl ||
      xboxInteg?.avatarUrl;
    const syncMode: XboxGamePassSyncMode =
      xboxStatus?.syncMode ||
      xboxSaved?.syncMode ||
      cachedProfile?.syncMode ||
      'owned_and_played';
    const nextProfile: XboxCachedProfileState = {
      connected: true,
      gamertag:
        xboxStatus?.gamertag ||
        xboxSaved?.gamertag ||
        cachedProfile?.gamertag ||
        gamertag,
      modernGamertag: gamertag,
      xuid,
      avatarUrl,
      gamerscore:
        typeof xboxStatus?.gamerscore === 'number'
          ? xboxStatus.gamerscore
          : typeof xboxSaved?.gamerscore === 'number'
          ? xboxSaved.gamerscore
          : cachedProfile?.gamerscore,
      subscription:
        xboxStatus?.subscription !== undefined
          ? xboxStatus.subscription
          : xboxSaved?.subscription !== undefined
          ? xboxSaved.subscription
          : cachedProfile?.subscription ?? null,
      syncMode,
      hasDeviceContext:
        typeof xboxStatus?.hasDeviceContext === 'boolean'
          ? xboxStatus.hasDeviceContext
          : cachedProfile?.hasDeviceContext,
      lastSyncedAt:
        xboxSaved?.updatedAt ||
        cachedProfile?.lastSyncedAt ||
        xboxInteg?.lastSyncedAt ||
        new Date().toISOString(),
    };
    saveXboxProfileState(nextProfile);
    resolvedXboxProfile = nextProfile;

    if (options.dispatchXboxProfileEvent && typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('ol:xbox-profile-updated'));
    }

    const count =
      xboxInteg?.gamesCount && xboxInteg.gamesCount > 0
        ? xboxInteg.gamesCount
        : getCatalog().filter((g) => g.platforms.some((p) => p.platformId === 'xbox')).length;
    const nextXboxStatusMessage = formatXboxIntegrationStatusMessage(
      gamertag,
      count,
      nextProfile.subscription
    );
    const subscriptionFingerprintChanged =
      (cachedProfile?.subscription?.subscriptionFingerprint || '') !==
        (nextProfile.subscription?.subscriptionFingerprint || '') ||
      (cachedProfile?.subscription?.tierDisplayName || '') !==
        (nextProfile.subscription?.tierDisplayName || '');

    if (
      !xboxInteg ||
      !xboxInteg.isConnected ||
      xboxInteg.accountName !== gamertag ||
      xboxInteg.accountId !== xuid ||
      (avatarUrl && xboxInteg.avatarUrl !== avatarUrl) ||
      xboxInteg.statusMessage !== nextXboxStatusMessage ||
      subscriptionFingerprintChanged
    ) {
      updatedIntegrations = updatedIntegrations.map((i) =>
        i.storefrontId === 'xbox'
          ? {
              ...i,
              isConnected: true,
              accountName: gamertag,
              accountId: xuid,
              avatarUrl: avatarUrl || i.avatarUrl,
              gamesCount: count,
              lastSyncedAt: nextProfile.lastSyncedAt,
              authMethod: 'oauth' as const,
              credentials: {},
              statusMessage: nextXboxStatusMessage,
            }
          : i
      );
      integrationsChanged = true;
    }
  }

  if (
    Array.isArray(savedTokens?.suppressedItems) &&
    savedTokens.suppressedItems.length > 0
  ) {
    registerSuppressedCatalogEntries(savedTokens.suppressedItems);
    integrationsChanged = true;
  }

  if (integrationsChanged && options.persistIfChanged !== false) {
    saveIntegrations(updatedIntegrations);
  }

  return {
    integrations: updatedIntegrations,
    changed: integrationsChanged,
    xboxProfile: resolvedXboxProfile,
  };
}
