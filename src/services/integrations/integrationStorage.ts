import { StorefrontId } from '../../contracts/platform';
import { StorefrontIntegration, StorefrontCredentials } from '../../contracts/integration';
import { CanonicalGame } from '../../contracts/game';
import { FULL_USER_STEAM_GAMES } from '../storage/fullUserSteamGames';
import { steamIntegration } from './steamIntegration';
import { gogIntegration, normalizeGogAvatarUrl } from './gogIntegration';
import { epicIntegration } from './epicIntegration';
import { xboxIntegration } from './xboxIntegration';
import { mergeScannedSteamGames } from '../storage/librarySync';
import { GOG_USER_LIBRARY, EPIC_USER_LIBRARY } from '../storage/storefrontLibraries';
import {
  sanitizeGameCatalog,
  normalizeCanonicalTitle,
  hasSameStorefrontConflict,
  hasSplitOverrideConflict,
} from './catalogSanitizer';
import { reconcileAchievementSummaries } from '../storage/achievementReconciliation';
import { isUnsuitableCoverUrl, isUnsuitableHeaderUrl } from '../igdb/igdbCoverService';
import {
  loadUserOverrides,
  getUserOverrideForGame,
  applyUserOverrideToGame,
  applyUserOverridesToCatalog,
} from '../storage/userOverrideStorage';
import { clearExpiredStagedCache } from '../storage/stagedCacheService';

const STORAGE_KEY_INTEGRATIONS = 'antigravity_storefront_integrations';
const STORAGE_KEY_CUSTOM_GAMES = 'antigravity_synced_user_games';
const STORAGE_KEY_MAIN_CATALOG = 'universal_game_library_catalog';
export const STORAGE_KEY_VERIFIED_ENTITLEMENTS = 'antigravity_verified_storefront_entitlements_v1';

export interface VerifiedUserEntitlements {
  steam: number[];
  gog: string[];
  epic: string[];
  xbox: string[];
}

function getSafeStorage(): Storage | null {
  try {
    if (typeof localStorage !== 'undefined' && localStorage) return localStorage;
    if (typeof window !== 'undefined' && window.localStorage) return window.localStorage;
  } catch {
    // Ignore storage access errors
  }
  return null;
}

export function getVerifiedUserEntitlements(): VerifiedUserEntitlements {
  const empty: VerifiedUserEntitlements = { steam: [], gog: [], epic: [], xbox: [] };
  const storage = getSafeStorage();
  if (!storage) return empty;
  try {
    const raw = storage.getItem(STORAGE_KEY_VERIFIED_ENTITLEMENTS);
    if (!raw) return empty;
    const parsed = JSON.parse(raw);
    return {
      steam: Array.isArray(parsed?.steam) ? parsed.steam.filter((n: any) => typeof n === 'number' && n > 0) : [],
      gog: Array.isArray(parsed?.gog) ? parsed.gog.filter((s: any) => typeof s === 'string' && s.length > 0) : [],
      epic: Array.isArray(parsed?.epic) ? parsed.epic.filter((s: any) => typeof s === 'string' && s.length > 0) : [],
      xbox: Array.isArray(parsed?.xbox) ? parsed.xbox.filter((s: any) => typeof s === 'string' && s.length > 0) : [],
    };
  } catch {
    return empty;
  }
}

export function recordVerifiedUserEntitlements(
  storefrontId: StorefrontId,
  games: CanonicalGame[]
): void {
  const storage = getSafeStorage();
  if (!storage || !Array.isArray(games) || games.length === 0) return;
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
      const set = new Set<string>(current[storefrontId]);
      for (const g of games) {
        if (!g || g.isVerifiedEntitlement === false) continue;
        const plat = g.platforms?.find((p) => p.platformId === storefrontId);
        if (plat?.platformGameId) {
          set.add(plat.platformGameId.trim().toLowerCase());
        }
        if (g.title) {
          const norm = normalizeCanonicalTitle(g.title);
          if (norm) set.add(norm);
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
  const storage = getSafeStorage();
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
      let changed = false;
      const normalized = parsed.map((i: StorefrontIntegration) => {
        if (i && i.storefrontId === 'gog' && i.avatarUrl) {
          const normUrl = normalizeGogAvatarUrl(i.avatarUrl);
          if (normUrl && normUrl !== i.avatarUrl) {
            changed = true;
            return { ...i, avatarUrl: normUrl };
          }
        }
        return i;
      });
      if (changed) {
        saveIntegrations(normalized);
      }
      return normalized;
    }
    return DEFAULT_INTEGRATIONS;
  } catch (err) {
    console.warn('Failed to load storefront integrations from localStorage:', err);
    return DEFAULT_INTEGRATIONS;
  }
}

export function saveIntegrations(integrations: StorefrontIntegration[]): void {
  if (typeof window === 'undefined') return;
  try {
    const isElectronRuntime = Boolean(window.electronAPI);
    const sanitized = integrations.map((integ) => {
      if (!integ) return integ;
      const copy: Record<string, any> = { ...integ };
      delete copy.access_token;
      delete copy.refresh_token;
      delete copy.accessToken;
      delete copy.refreshToken;
      if (copy.credentials && typeof copy.credentials === 'object') {
        const creds: Record<string, any> = { ...copy.credentials };
        delete creds.access_token;
        delete creds.refresh_token;
        delete creds.accessToken;
        delete creds.refreshToken;
        if (isElectronRuntime) {
          delete creds.gogToken;
          delete creds.epicToken;
          delete creds.epicRefreshToken;
        }
        copy.credentials = creds;
      }
      return copy as StorefrontIntegration;
    });
    localStorage.setItem(STORAGE_KEY_INTEGRATIONS, JSON.stringify(sanitized));
  } catch (err) {
    console.error('Failed to save storefront integrations to localStorage', err);
  }
}

export interface SaveCatalogOptions {
  immediate?: boolean;
  skipSanitize?: boolean;
}

let inMemoryCatalogCache: CanonicalGame[] | null = null;
let inMemoryCatalogRawRef: string | null = null;
let pendingCatalogSaveTimer: ReturnType<typeof setTimeout> | null = null;
let pendingCatalogGames: CanonicalGame[] | null = null;
let pendingCatalogNeedsSanitize = false;
let pendingCatalogNeedsOverrides = false;

function isTestEnv(): boolean {
  try {
    return (
      typeof process !== 'undefined' &&
      Boolean((process as any).env?.VITEST || (process as any).env?.NODE_ENV === 'test')
    );
  } catch {
    return false;
  }
}

function evictExpendableCachesForCatalogQuota(): void {
  try {
    clearExpiredStagedCache();
    const keysToRemove: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (
        key &&
        (key.startsWith('antigravity_detailed_achievements_') ||
          key.startsWith('antigravity_achievement_details_'))
      ) {
        keysToRemove.push(key);
      }
    }
    for (const k of keysToRemove) {
      localStorage.removeItem(k);
    }
  } catch {
    // Ignore storage cleanup errors
  }
}

function writeCatalogToLocalStorage(cleaned: CanonicalGame[]): void {
  const serialized = JSON.stringify(cleaned);
  try {
    localStorage.setItem(STORAGE_KEY_MAIN_CATALOG, serialized);
  } catch (err) {
    evictExpendableCachesForCatalogQuota();
    localStorage.setItem(STORAGE_KEY_MAIN_CATALOG, serialized);
  }
  inMemoryCatalogCache = cleaned;
  inMemoryCatalogRawRef = serialized;

  // Save only custom games delta to STORAGE_KEY_CUSTOM_GAMES, NOT the duplicate copy of all master games
  const customGames = cleaned.filter(
    (g) =>
      g.platforms?.some((p) => p.platformId === 'custom') ||
      !g.platforms?.some((p) => ['steam', 'gog', 'epic', 'xbox'].includes(p.platformId))
  );
  if (customGames.length > 0) {
    try {
      localStorage.setItem(STORAGE_KEY_CUSTOM_GAMES, JSON.stringify(customGames));
    } catch {}
  } else {
    localStorage.removeItem(STORAGE_KEY_CUSTOM_GAMES);
  }
}

export function flushPendingCatalogSave(): void {
  if (pendingCatalogSaveTimer) {
    clearTimeout(pendingCatalogSaveTimer);
    pendingCatalogSaveTimer = null;
  }
  if (pendingCatalogGames !== null && typeof window !== 'undefined') {
    try {
      let toWrite = pendingCatalogGames;
      if (pendingCatalogNeedsOverrides || pendingCatalogNeedsSanitize) {
        toWrite = applyUserOverridesToCatalog(toWrite, loadUserOverrides());
      }
      if (pendingCatalogNeedsSanitize) {
        toWrite = sanitizeGameCatalog(toWrite);
      }
      pendingCatalogGames = null;
      pendingCatalogNeedsSanitize = false;
      pendingCatalogNeedsOverrides = false;
      writeCatalogToLocalStorage(toWrite);
    } catch (err) {
      console.error('[IntegrationStorage] Failed to flush pending catalog save:', err);
    }
  }
}

if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
  window.addEventListener('beforeunload', () => {
    flushPendingCatalogSave();
  });
}

function buildDefaultBaseCatalog(userOverrides: ReturnType<typeof loadUserOverrides>): CanonicalGame[] {
  let defaultBase: CanonicalGame[] = [];
  if (
    FULL_USER_STEAM_GAMES.length > 0 ||
    GOG_USER_LIBRARY.length > 0 ||
    EPIC_USER_LIBRARY.length > 0
  ) {
    defaultBase = sanitizeGameCatalog(
      mergeStorefrontGames(
        mergeStorefrontGames(mergeScannedSteamGames([]), GOG_USER_LIBRARY, 'gog'),
        EPIC_USER_LIBRARY,
        'epic'
      )
    );
    defaultBase = applyUserOverridesToCatalog(defaultBase, userOverrides);
  }
  return defaultBase;
}

export function loadCurrentCatalog(): CanonicalGame[] {
  const userOverrides = loadUserOverrides();

  if (typeof window === 'undefined') {
    return buildDefaultBaseCatalog(userOverrides);
  }

  try {
    if (pendingCatalogGames !== null && inMemoryCatalogCache !== null) {
      return applyUserOverridesToCatalog(inMemoryCatalogCache, userOverrides);
    }

    const raw = localStorage.getItem(STORAGE_KEY_MAIN_CATALOG);
    if (raw) {
      if (inMemoryCatalogCache !== null && inMemoryCatalogRawRef === raw) {
        return applyUserOverridesToCatalog(inMemoryCatalogCache, userOverrides);
      }

      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed) && parsed.length > 0) {
        let cleaned = sanitizeGameCatalog(parsed, { allowNewPurchases: true });
        cleaned = applyUserOverridesToCatalog(cleaned, userOverrides);
        inMemoryCatalogCache = cleaned;
        if (cleaned.length !== parsed.length) {
          writeCatalogToLocalStorage(cleaned);
        } else {
          inMemoryCatalogRawRef = raw;
        }
        return cleaned;
      }
    } else {
      inMemoryCatalogCache = null;
      inMemoryCatalogRawRef = null;
    }

    const defaultBase = buildDefaultBaseCatalog(userOverrides);
    // Merge any custom games if stored in custom games delta
    const customRaw = localStorage.getItem(STORAGE_KEY_CUSTOM_GAMES);
    if (customRaw) {
      try {
        const customParsed = JSON.parse(customRaw);
        if (Array.isArray(customParsed) && customParsed.length > 0) {
          const customOnly = customParsed.filter(
            (g: CanonicalGame) =>
              g.platforms?.some((p) => p.platformId === 'custom') ||
              !g.platforms?.some((p) => ['steam', 'gog', 'epic', 'xbox'].includes(p.platformId))
          );
          for (const cg of customOnly) {
            if (!defaultBase.some((g: CanonicalGame) => g.id === cg.id)) {
              defaultBase.push(cg);
            }
          }
        }
      } catch (err) {
        console.warn('Failed to parse custom games cache:', err);
      }
    }
    return applyUserOverridesToCatalog(defaultBase, userOverrides);
  } catch (err) {
    console.warn('Failed to load cached universal catalog:', err);
  }
  return buildDefaultBaseCatalog(userOverrides);
}

export function saveCurrentCatalog(games: CanonicalGame[], options?: SaveCatalogOptions): void {
  if (typeof window === 'undefined') return;
  try {
    if (options?.skipSanitize) {
      inMemoryCatalogCache = games;
      if (options?.immediate || isTestEnv()) {
        if (pendingCatalogSaveTimer) {
          clearTimeout(pendingCatalogSaveTimer);
          pendingCatalogSaveTimer = null;
        }
        pendingCatalogGames = null;
        pendingCatalogNeedsSanitize = false;
        pendingCatalogNeedsOverrides = false;
        const withOverrides = applyUserOverridesToCatalog(games, loadUserOverrides());
        writeCatalogToLocalStorage(withOverrides);
      } else {
        pendingCatalogGames = games;
        pendingCatalogNeedsSanitize = false;
        pendingCatalogNeedsOverrides = true;
        if (!pendingCatalogSaveTimer) {
          pendingCatalogSaveTimer = setTimeout(() => {
            try {
              flushPendingCatalogSave();
            } catch (e) {
              console.error('[IntegrationStorage] Deferred catalog flush failed:', e);
            }
          }, 1200);
        }
      }
      return;
    }

    const userOverrides = loadUserOverrides();
    const withOverrides = applyUserOverridesToCatalog(games, userOverrides);
    const cleaned = sanitizeGameCatalog(withOverrides);
    inMemoryCatalogCache = cleaned;

    if (options?.immediate || isTestEnv()) {
      if (pendingCatalogSaveTimer) {
        clearTimeout(pendingCatalogSaveTimer);
        pendingCatalogSaveTimer = null;
      }
      pendingCatalogGames = null;
      pendingCatalogNeedsSanitize = false;
      pendingCatalogNeedsOverrides = false;
      writeCatalogToLocalStorage(cleaned);
    } else {
      pendingCatalogGames = cleaned;
      pendingCatalogNeedsSanitize = false;
      pendingCatalogNeedsOverrides = false;
      if (!pendingCatalogSaveTimer) {
        pendingCatalogSaveTimer = setTimeout(() => {
          try {
            flushPendingCatalogSave();
          } catch (e) {
            console.error('[IntegrationStorage] Deferred catalog flush failed:', e);
          }
        }, 1200);
      }
    }
  } catch (err) {
    console.error('Failed to save universal catalog', err);
  }
}

export function clearIntegrationStorage(): void {
  if (pendingCatalogSaveTimer) {
    clearTimeout(pendingCatalogSaveTimer);
    pendingCatalogSaveTimer = null;
  }
  pendingCatalogGames = null;
  pendingCatalogNeedsSanitize = false;
  inMemoryCatalogCache = null;
  inMemoryCatalogRawRef = null;
  const storage = getSafeStorage();
  if (!storage) return;
  try {
    storage.removeItem(STORAGE_KEY_INTEGRATIONS);
    storage.removeItem(STORAGE_KEY_CUSTOM_GAMES);
    storage.removeItem(STORAGE_KEY_MAIN_CATALOG);
    storage.removeItem(STORAGE_KEY_VERIFIED_ENTITLEMENTS);
  } catch {}
}

export function mergeStorefrontGames(
  currentCatalog: CanonicalGame[],
  newGames: CanonicalGame[],
  storefrontId: StorefrontId
): CanonicalGame[] {
  const userOverrides = loadUserOverrides();
  const verifiedIncoming = newGames.filter((g) => g && g.isVerifiedEntitlement === true);
  if (verifiedIncoming.length > 0) {
    recordVerifiedUserEntitlements(storefrontId, verifiedIncoming);
  }
  const sanitizedNew = sanitizeGameCatalog(newGames);
  const merged = currentCatalog.map((g) => {
    if (g.id.startsWith('steam-') && g.steamAppId) {
      return {
        ...g,
        platforms: g.platforms.map((p) => {
          if (p.platformId === 'steam' && p.platformGameId !== String(g.steamAppId)) {
            return {
              ...p,
              platformGameId: String(g.steamAppId),
              playtimeMinutes: 0,
              lastPlayed: undefined,
              achievements: undefined,
            };
          }
          return p;
        }),
      };
    }
    return g;
  });

  for (const newGame of sanitizedNew) {
    const newNorm = normalizeCanonicalTitle(newGame.title);
    const platformOwnership = newGame.platforms.find((p) => p.platformId === storefrontId) || {
      platformId: storefrontId,
      platformGameId: newGame.id,
      installed: false,
    };
    const incomingPlatGameId = String(platformOwnership.platformGameId || '').trim();

    const existingIndex = merged.findIndex((g) => {
      if (hasSameStorefrontConflict(g, newGame)) return false;
      if (hasSplitOverrideConflict(g, newGame, userOverrides)) return false;
      const ov = getUserOverrideForGame(g, userOverrides);
      if (ov) {
        if (ov.gameId && (ov.gameId === newGame.id || (newGame.steamAppId && ov.gameId === `steam-${newGame.steamAppId}`))) return true;
        if (newGame.steamAppId && ov.steamAppId && ov.steamAppId === newGame.steamAppId) return true;
      }
      if (
        incomingPlatGameId &&
        g.platforms.every((p) => p.platformId === storefrontId) &&
        g.platforms.some(
          (p) => p.platformId === storefrontId && String(p.platformGameId || '').trim() === incomingPlatGameId
        )
      ) {
        return true;
      }
      if (g.steamAppId && newGame.steamAppId && g.steamAppId === newGame.steamAppId) return true;
      if (g.id && newGame.id && g.id === newGame.id) return true;
      if (g.title.toLowerCase().trim() === newGame.title.toLowerCase().trim()) return true;
      if (newNorm && normalizeCanonicalTitle(g.title) === newNorm) return true;
      return false;
    });

    const targetIndex = existingIndex >= 0 ? existingIndex : merged.length;

    if (existingIndex >= 0) {
      const existing = merged[existingIndex];
      const existingOverride = getUserOverrideForGame(existing, userOverrides);
      const preferStorefrontTitle =
        existing.platforms.every((p) => p.platformId === storefrontId) &&
        !existingOverride?.title &&
        Boolean(newGame.title);
      const hasPlatform = existing.platforms.some((p) => p.platformId === storefrontId);
      const updatedPlatforms = hasPlatform
        ? existing.platforms.map((p) =>
            p.platformId === storefrontId
              ? {
                  ...p,
                  platformGameId: platformOwnership.platformGameId || p.platformGameId,
                  storefrontAppId: platformOwnership.storefrontAppId || p.storefrontAppId,
                  namespace: platformOwnership.namespace || p.namespace,
                  catalogItemId: platformOwnership.catalogItemId || p.catalogItemId,
                  platforms: platformOwnership.platforms || p.platforms,
                  installed: platformOwnership.installed ?? p.installed,
                  lastPlayed:
                    storefrontId === 'steam' && newGame.isVerifiedEntitlement
                      ? platformOwnership.lastPlayed
                      : platformOwnership.lastPlayed || p.lastPlayed,
                  playtimeMinutes:
                    storefrontId === 'steam' && newGame.isVerifiedEntitlement && platformOwnership.playtimeMinutes !== undefined
                      ? platformOwnership.playtimeMinutes
                      : platformOwnership.playtimeMinutes !== undefined && platformOwnership.playtimeMinutes > 0
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
        title: preferStorefrontTitle ? newGame.title : existing.title,
        sortTitle: preferStorefrontTitle ? (newGame.sortTitle || existing.sortTitle) : existing.sortTitle,
        headerImage: !isUnsuitableHeaderUrl(existing.headerImage) ? existing.headerImage : newGame.headerImage,
        capsuleImage: !isUnsuitableCoverUrl(existing.capsuleImage) ? existing.capsuleImage : newGame.capsuleImage,
        iconUrl: !isUnsuitableHeaderUrl(existing.iconUrl) ? existing.iconUrl : (newGame.iconUrl || newGame.capsuleImage || newGame.headerImage),
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
        isVerifiedEntitlement: existing.isVerifiedEntitlement || newGame.isVerifiedEntitlement,
        matchConfidence: existing.matchConfidence ?? newGame.matchConfidence,
        needsMatchReview: existing.needsMatchReview ?? newGame.needsMatchReview,
      };

      if (existingOverride) {
        merged[existingIndex] = applyUserOverrideToGame(merged[existingIndex], existingOverride);
      }
    } else {
      merged.push({
        ...newGame,
        platforms: [platformOwnership],
      });
    }

    // Ensure platformOwnership.platformGameId is not left attached to any other entry in merged from a prior false merge
    const assignedGameId = String(platformOwnership.platformGameId || '').trim();
    if (assignedGameId) {
      for (let i = 0; i < merged.length; i++) {
        if (i === targetIndex) continue;
        const other = merged[i];
        if (other.platforms.some((p) => p.platformId === storefrontId && String(p.platformGameId || '').trim() === assignedGameId)) {
          merged[i] = {
            ...other,
            platforms: other.platforms.filter(
              (p) => !(p.platformId === storefrontId && String(p.platformGameId || '').trim() === assignedGameId)
            ),
          };
        }
      }
    }
  }

  const nonEmptyMerged = merged.filter((g) => g.platforms && g.platforms.length > 0);
  const finalCatalog = sanitizeGameCatalog(nonEmptyMerged);
  const withOverrides = applyUserOverridesToCatalog(finalCatalog, userOverrides);
  return withOverrides.sort((a, b) => a.title.localeCompare(b.title, undefined, { sensitivity: 'base' }));
}

export function removeStorefrontGames(
  currentCatalog: CanonicalGame[],
  storefrontId: StorefrontId
): CanonicalGame[] {
  clearVerifiedUserEntitlements(storefrontId);
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
  if (typeof window !== 'undefined' && window.electronAPI?.clearTokens) {
    try {
      window.electronAPI.clearTokens(storefrontId);
    } catch (err) {
      console.warn(`Failed to clear tokens for ${storefrontId}:`, err);
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
