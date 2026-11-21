import {
  CanonicalGame,
  XboxGamePassSyncMode,
  XboxSubscriptionSummary,
} from '../../../contracts/game';
import { StorefrontCredentials, StorefrontIntegration } from '../../../contracts/integration';
import { StorefrontId } from '../../../contracts/platform';
import { getSafeLocalStorage } from '../../common/runtimeEnv';
import { normalizeCanonicalTitle } from '../catalogSanitizer';
import { normalizeGogAvatarUrl } from '../gogIntegration';
import {
  hasLocalInstallMetadata,
  normalizePlatformGameIdForLookup,
} from './installedReconciler';

export const STORAGE_KEY_INTEGRATIONS = 'antigravity_storefront_integrations';
export const STORAGE_KEY_VERIFIED_ENTITLEMENTS =
  'antigravity_verified_storefront_entitlements_v1';
export const STORAGE_KEY_XBOX_PROFILE = 'antigravity_xbox_profile_v1';

export interface XboxCachedProfileState {
  connected: boolean;
  gamertag?: string;
  modernGamertag?: string;
  xuid?: string;
  avatarUrl?: string;
  gamerscore?: number;
  subscription?: XboxSubscriptionSummary | null;
  syncMode?: XboxGamePassSyncMode;
  hasDeviceContext?: boolean;
  lastSyncedAt?: string;
}

export interface VerifiedUserEntitlements {
  steam: number[];
  gog: string[];
  epic: string[];
  xbox: string[];
}

export function loadXboxProfileState(): XboxCachedProfileState | null {
  const storage = getSafeLocalStorage();
  if (!storage) return null;
  try {
    const raw = storage.getItem(STORAGE_KEY_XBOX_PROFILE);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    return {
      connected: Boolean(parsed.connected),
      gamertag: typeof parsed.gamertag === 'string' ? parsed.gamertag : undefined,
      modernGamertag: typeof parsed.modernGamertag === 'string' ? parsed.modernGamertag : undefined,
      xuid: typeof parsed.xuid === 'string' ? parsed.xuid : undefined,
      avatarUrl: typeof parsed.avatarUrl === 'string' ? parsed.avatarUrl : undefined,
      gamerscore: typeof parsed.gamerscore === 'number' ? parsed.gamerscore : undefined,
      subscription:
        parsed.subscription && typeof parsed.subscription === 'object'
          ? (parsed.subscription as XboxSubscriptionSummary)
          : null,
      syncMode:
        parsed.syncMode === 'owned_and_played' ||
        parsed.syncMode === 'full_pc_game_pass' ||
        parsed.syncMode === 'owned_only'
          ? parsed.syncMode
          : undefined,
      hasDeviceContext:
        typeof parsed.hasDeviceContext === 'boolean' ? parsed.hasDeviceContext : undefined,
      lastSyncedAt: typeof parsed.lastSyncedAt === 'string' ? parsed.lastSyncedAt : undefined,
    };
  } catch {
    return null;
  }
}

export function saveXboxProfileState(state: XboxCachedProfileState): void {
  const storage = getSafeLocalStorage();
  if (!storage) return;
  try {
    const safeState: XboxCachedProfileState = {
      connected: Boolean(state.connected),
      ...(state.gamertag ? { gamertag: state.gamertag } : {}),
      ...(state.modernGamertag ? { modernGamertag: state.modernGamertag } : {}),
      ...(state.xuid ? { xuid: state.xuid } : {}),
      ...(state.avatarUrl ? { avatarUrl: state.avatarUrl } : {}),
      ...(typeof state.gamerscore === 'number' ? { gamerscore: state.gamerscore } : {}),
      subscription: state.subscription ?? null,
      ...(state.syncMode ? { syncMode: state.syncMode } : {}),
      ...(typeof state.hasDeviceContext === 'boolean'
        ? { hasDeviceContext: state.hasDeviceContext }
        : {}),
      ...(state.lastSyncedAt ? { lastSyncedAt: state.lastSyncedAt } : {}),
    };
    storage.setItem(STORAGE_KEY_XBOX_PROFILE, JSON.stringify(safeState));
    if (
      typeof window !== 'undefined' &&
      typeof window.dispatchEvent === 'function' &&
      typeof CustomEvent === 'function'
    ) {
      window.dispatchEvent(new CustomEvent('ol:xbox-profile-updated'));
    }
  } catch (err) {
    console.warn('Failed to save Xbox profile state:', err);
  }
}

export function clearXboxProfileState(): void {
  const storage = getSafeLocalStorage();
  if (!storage) return;
  try {
    storage.removeItem(STORAGE_KEY_XBOX_PROFILE);
    if (
      typeof window !== 'undefined' &&
      typeof window.dispatchEvent === 'function' &&
      typeof CustomEvent === 'function'
    ) {
      window.dispatchEvent(new CustomEvent('ol:xbox-profile-updated'));
    }
  } catch {
    // Ignore storage removal errors
  }
}

export function getVerifiedUserEntitlements(): VerifiedUserEntitlements {
  const empty: VerifiedUserEntitlements = { steam: [], gog: [], epic: [], xbox: [] };
  const storage = getSafeLocalStorage();
  if (!storage) return empty;
  try {
    const raw = storage.getItem(STORAGE_KEY_VERIFIED_ENTITLEMENTS);
    if (!raw) return empty;
    const parsed = JSON.parse(raw);
    return {
      steam: Array.isArray(parsed?.steam)
        ? parsed.steam.filter((n: unknown): n is number => typeof n === 'number' && n > 0)
        : [],
      gog: Array.isArray(parsed?.gog)
        ? parsed.gog.filter((s: unknown): s is string => typeof s === 'string' && s.length > 0)
        : [],
      epic: Array.isArray(parsed?.epic)
        ? parsed.epic.filter((s: unknown): s is string => typeof s === 'string' && s.length > 0)
        : [],
      xbox: Array.isArray(parsed?.xbox)
        ? parsed.xbox.filter((s: unknown): s is string => typeof s === 'string' && s.length > 0)
        : [],
    };
  } catch {
    return empty;
  }
}

export function formatXboxIntegrationStatusMessage(
  displayGamertag: string,
  xboxCount: number,
  subscription?: XboxSubscriptionSummary | null
): string {
  const safeName = displayGamertag || 'Xbox Live User';
  if (subscription?.hasActiveSubscription && subscription.tierDisplayName) {
    const tierPart =
      subscription.hasPcCatalogAccess === false
        ? `${subscription.tierDisplayName} · Owned Only`
        : subscription.tierDisplayName;
    return `Connected as ${safeName} · ${tierPart} (${xboxCount} Xbox titles synced)`;
  }
  return `Connected as ${safeName} · Owned Only (${xboxCount} Xbox titles synced)`;
}

export interface RecordVerifiedEntitlementsOptions {
  replaceStorefront?: boolean;
  preservedInstalledCatalog?: CanonicalGame[];
}

export function recordVerifiedUserEntitlements(
  storefrontId: StorefrontId,
  games: CanonicalGame[],
  options?: RecordVerifiedEntitlementsOptions
): void {
  const storage = getSafeLocalStorage();
  const replaceStorefront =
    Boolean(options?.replaceStorefront) &&
    (storefrontId === 'gog' || storefrontId === 'epic' || storefrontId === 'xbox');
  if (!storage || !Array.isArray(games) || (games.length === 0 && !replaceStorefront)) return;
  try {
    const current = getVerifiedUserEntitlements();
    if (storefrontId === 'steam') {
      const set = new Set<number>(current.steam);
      for (const g of games) {
        if (!g || g.isVerifiedEntitlement === false) continue;
        const steamPlat = g.platforms?.find((p) => p.platformId === 'steam');
        const appId =
          g.steamAppId ||
          (steamPlat?.platformGameId && !isNaN(Number(steamPlat.platformGameId))
            ? Number(steamPlat.platformGameId)
            : undefined);
        if (appId && appId > 0) set.add(appId);
      }
      current.steam = Array.from(set);
    } else if (storefrontId === 'gog' || storefrontId === 'epic' || storefrontId === 'xbox') {
      const set = replaceStorefront ? new Set<string>() : new Set<string>(current[storefrontId]);
      for (const g of games) {
        if (!g || g.isVerifiedEntitlement === false) continue;
        const plat = g.platforms?.find((p) => p.platformId === storefrontId);
        if (plat?.platformGameId) {
          set.add(plat.platformGameId.trim().toLowerCase());
          const normPid = normalizePlatformGameIdForLookup(plat.platformGameId);
          if (normPid) set.add(normPid);
        }
        if (plat?.storefrontAppId) {
          set.add(plat.storefrontAppId.trim().toLowerCase());
          const normStoreId = normalizePlatformGameIdForLookup(plat.storefrontAppId);
          if (normStoreId) set.add(normStoreId);
        }
        if (storefrontId === 'xbox' && plat) {
          if (plat.xboxProductId) set.add(plat.xboxProductId.trim().toLowerCase());
          if (plat.xboxTitleId) set.add(plat.xboxTitleId.trim().toLowerCase());
          if (plat.packageFamilyName) set.add(plat.packageFamilyName.trim().toLowerCase());
        }
        if (g.title) {
          const norm = normalizeCanonicalTitle(g.title);
          if (norm) set.add(norm);
        }
      }
      if (replaceStorefront && Array.isArray(options?.preservedInstalledCatalog)) {
        for (const cg of options.preservedInstalledCatalog) {
          if (!cg || !Array.isArray(cg.platforms)) continue;
          const preservedPlat = cg.platforms.find((p) => {
            if (p?.platformId !== storefrontId) return false;
            const isLocallyInstalled = Boolean(p.installed || hasLocalInstallMetadata(p));
            if (storefrontId === 'xbox') {
              return (
                isLocallyInstalled ||
                p.ownershipType === 'owned' ||
                p.ownershipType === 'owned_and_subscription'
              );
            }
            return isLocallyInstalled;
          });
          if (!preservedPlat) continue;
          if (preservedPlat.platformGameId) {
            set.add(preservedPlat.platformGameId.trim().toLowerCase());
            const normPid = normalizePlatformGameIdForLookup(preservedPlat.platformGameId);
            if (normPid) set.add(normPid);
          }
          if (preservedPlat.storefrontAppId) {
            set.add(preservedPlat.storefrontAppId.trim().toLowerCase());
            const normStoreId = normalizePlatformGameIdForLookup(preservedPlat.storefrontAppId);
            if (normStoreId) set.add(normStoreId);
          }
          if (storefrontId === 'xbox') {
            if (preservedPlat.xboxProductId) {
              set.add(preservedPlat.xboxProductId.trim().toLowerCase());
            }
            if (preservedPlat.xboxTitleId) {
              set.add(preservedPlat.xboxTitleId.trim().toLowerCase());
            }
            if (preservedPlat.packageFamilyName) {
              set.add(preservedPlat.packageFamilyName.trim().toLowerCase());
            }
          }
          if (cg.title) {
            const norm = normalizeCanonicalTitle(cg.title);
            if (norm) set.add(norm);
          }
        }
      }
      current[storefrontId] = Array.from(set);
    }
    storage.setItem(STORAGE_KEY_VERIFIED_ENTITLEMENTS, JSON.stringify(current));
  } catch (err) {
    console.warn('Failed to record verified storefront entitlements:', err);
  }
}

export function clearVerifiedUserEntitlements(storefrontId?: StorefrontId): void {
  const storage = getSafeLocalStorage();
  if (!storage) return;
  try {
    if (!storefrontId) {
      storage.removeItem(STORAGE_KEY_VERIFIED_ENTITLEMENTS);
      return;
    }
    const current = getVerifiedUserEntitlements();
    if (storefrontId === 'steam') current.steam = [];
    else if (storefrontId === 'gog') current.gog = [];
    else if (storefrontId === 'epic') current.epic = [];
    else if (storefrontId === 'xbox') current.xbox = [];
    storage.setItem(STORAGE_KEY_VERIFIED_ENTITLEMENTS, JSON.stringify(current));
  } catch (err) {
    console.warn('Failed to clear verified storefront entitlements:', err);
  }
}

export const DEFAULT_INTEGRATIONS: StorefrontIntegration[] = [
  {
    storefrontId: 'steam',
    name: 'Steam',
    isConnected: false,
    gamesCount: 0,
    statusMessage: 'Not connected — Sign in with Steam or enter SteamID64',
  },
  {
    storefrontId: 'gog',
    name: 'GOG.com',
    isConnected: false,
    gamesCount: 0,
    statusMessage: 'Not connected — Sign in with GOG.com account',
  },
  {
    storefrontId: 'epic',
    name: 'Epic Games Store',
    isConnected: false,
    gamesCount: 0,
    statusMessage: 'Not connected — Sign in with Epic Games account',
  },
  {
    storefrontId: 'xbox',
    name: 'Xbox',
    isConnected: false,
    gamesCount: 0,
    statusMessage: 'Not connected — Ready to connect via Xbox Live account',
  },
];

function cloneDefaultIntegrations(): StorefrontIntegration[] {
  return DEFAULT_INTEGRATIONS.map((item) => ({
    ...item,
    ...(item.credentials ? { credentials: { ...item.credentials } } : {}),
  }));
}

const sessionApiKeysByStore = new Map<StorefrontId, string>();

const SENSITIVE_CREDENTIAL_FIELDS = [
  'access_token',
  'refresh_token',
  'accessToken',
  'refreshToken',
  'xstsToken',
  'userHash',
  'apiKey',
  'steamApiKey',
  'clientSecret',
  'client_secret',
  'idToken',
  'id_token',
  'exchangeCode',
  'gogToken',
  'epicToken',
  'epicRefreshToken',
  'webToken',
] as const;

export function clearSessionApiKeys(): void {
  sessionApiKeysByStore.clear();
}

export function loadIntegrations(): StorefrontIntegration[] {
  const storage = getSafeLocalStorage();
  if (!storage) return cloneDefaultIntegrations();
  try {
    const raw = storage.getItem(STORAGE_KEY_INTEGRATIONS);
    if (!raw) {
      sessionApiKeysByStore.clear();
      const defaults = cloneDefaultIntegrations();
      saveIntegrations(defaults);
      return defaults;
    }
    const parsed: unknown = JSON.parse(raw);
    if (Array.isArray(parsed) && parsed.length > 0) {
      let changed = false;
      const normalized = (parsed as StorefrontIntegration[]).map((i: StorefrontIntegration) => {
        if (!i) return i;
        let next = i;
        if (next.storefrontId === 'gog' && next.avatarUrl) {
          const normUrl = normalizeGogAvatarUrl(next.avatarUrl);
          if (normUrl && normUrl !== next.avatarUrl) {
            changed = true;
            next = { ...next, avatarUrl: normUrl };
          }
        }
        const sessionKey = sessionApiKeysByStore.get(next.storefrontId);
        if (sessionKey && next.isConnected && !next.credentials?.apiKey) {
          next = {
            ...next,
            credentials: {
              ...(next.credentials || {}),
              apiKey: sessionKey,
            },
          };
        }
        return next;
      });
      if (changed) {
        saveIntegrations(normalized);
      }
      return normalized;
    }
    return cloneDefaultIntegrations();
  } catch (err) {
    console.warn('Failed to load storefront integrations from localStorage:', err);
    return cloneDefaultIntegrations();
  }
}

export function saveIntegrations(integrations: StorefrontIntegration[]): void {
  const storage = getSafeLocalStorage();
  if (!storage) return;
  try {
    const sanitized = integrations.map((integ) => {
      if (!integ) return integ;
      if (
        integ.isConnected &&
        typeof integ.credentials?.apiKey === 'string' &&
        integ.credentials.apiKey.trim()
      ) {
        sessionApiKeysByStore.set(integ.storefrontId, integ.credentials.apiKey.trim());
      } else if (!integ.isConnected) {
        sessionApiKeysByStore.delete(integ.storefrontId);
      }

      const copy: StorefrontIntegration = { ...integ };
      for (const secretField of SENSITIVE_CREDENTIAL_FIELDS) {
        Reflect.deleteProperty(copy, secretField);
      }
      if (copy.credentials && typeof copy.credentials === 'object') {
        const creds: StorefrontCredentials = { ...copy.credentials };
        for (const secretField of SENSITIVE_CREDENTIAL_FIELDS) {
          Reflect.deleteProperty(creds, secretField);
        }
        copy.credentials = creds;
      }
      return copy;
    });
    storage.setItem(STORAGE_KEY_INTEGRATIONS, JSON.stringify(sanitized));
  } catch (err) {
    console.error('Failed to save storefront integrations to localStorage', err);
  }
}

let integrationMutationQueue: Promise<unknown> = Promise.resolve();

/**
 * Serializes concurrent storefront connect/disconnect state-persistence updates
 * so parallel connections cannot drop each other's integration or catalog changes.
 */
export function enqueueIntegrationMutation<T>(task: () => Promise<T> | T): Promise<T> {
  const next = integrationMutationQueue.then(
    () => task(),
    () => task()
  );
  integrationMutationQueue = next.then(
    () => undefined,
    () => undefined
  );
  return next;
}
