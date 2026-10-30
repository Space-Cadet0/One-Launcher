import knownAchievementsRaw from './knownGameAchievements.json';
import { StoreAchievementSummary } from '../../contracts/game';
import { reconcileAchievementSummaries } from './achievementReconciliation';

export type CachedAchievementEntry = StoreAchievementSummary;

const SPECIAL_NON_STEAM_ACHIEVEMENTS: Record<string, number> = {};

export const KNOWN_USER_GOG_ACHIEVEMENTS: Record<string, StoreAchievementSummary> = {};

export const KNOWN_USER_EPIC_ACHIEVEMENTS: Record<string, StoreAchievementSummary> = {};

export const KNOWN_USER_STEAM_ACHIEVEMENTS: Record<number, { unlocked: number; total: number; percentage: number }> = {};

export const KNOWN_GAME_ACHIEVEMENT_TOTALS: Record<string, number> = knownAchievementsRaw as Record<string, number>;

/**
 * Returns the verified total achievements for a game by steamAppId, platform game ID, or canonical title.
 */
export function getKnownAchievementTotal(
  steamAppId?: number,
  gameId?: string,
  title?: string
): number | undefined {
  if (steamAppId && KNOWN_USER_STEAM_ACHIEVEMENTS[steamAppId]?.total !== undefined) {
    return KNOWN_USER_STEAM_ACHIEVEMENTS[steamAppId].total;
  }
  if (steamAppId && KNOWN_GAME_ACHIEVEMENT_TOTALS[String(steamAppId)] !== undefined) {
    return KNOWN_GAME_ACHIEVEMENT_TOTALS[String(steamAppId)];
  }
  if (gameId && SPECIAL_NON_STEAM_ACHIEVEMENTS[gameId.toLowerCase()] !== undefined) {
    return SPECIAL_NON_STEAM_ACHIEVEMENTS[gameId.toLowerCase()];
  }
  const cleanId = gameId?.replace(/^(gog|epic|steam)-/, '');
  if (cleanId && KNOWN_GAME_ACHIEVEMENT_TOTALS[cleanId] !== undefined) {
    return KNOWN_GAME_ACHIEVEMENT_TOTALS[cleanId];
  }
  if (cleanId && SPECIAL_NON_STEAM_ACHIEVEMENTS[cleanId.toLowerCase()] !== undefined) {
    return SPECIAL_NON_STEAM_ACHIEVEMENTS[cleanId.toLowerCase()];
  }
  if (title && SPECIAL_NON_STEAM_ACHIEVEMENTS[title.toLowerCase().trim()] !== undefined) {
    return SPECIAL_NON_STEAM_ACHIEVEMENTS[title.toLowerCase().trim()];
  }
  if (title && KNOWN_GAME_ACHIEVEMENT_TOTALS[title.toLowerCase().trim()] !== undefined) {
    return KNOWN_GAME_ACHIEVEMENT_TOTALS[title.toLowerCase().trim()];
  }
  const normTitle = title?.toLowerCase().replace(/[:\-–—]/g, ' ').replace(/\s+/g, ' ').trim();
  if (normTitle && SPECIAL_NON_STEAM_ACHIEVEMENTS[normTitle] !== undefined) {
    return SPECIAL_NON_STEAM_ACHIEVEMENTS[normTitle];
  }
  if (normTitle && KNOWN_GAME_ACHIEVEMENT_TOTALS[normTitle] !== undefined) {
    return KNOWN_GAME_ACHIEVEMENT_TOTALS[normTitle];
  }
  return undefined;
}

const STORAGE_KEY_STEAM_ACH = 'antigravity_steam_achievements';
const STORAGE_KEY_EPIC_ACH = 'antigravity_epic_achievements';
const STORAGE_KEY_GOG_ACH = 'antigravity_gog_achievements';
const STORAGE_KEY_XBOX_ACH = 'antigravity_xbox_achievements';

interface AchMemorySlot {
  hydrated: boolean;
  storageRef: Storage | null;
  raw: string | null;
  parsed: Record<string, StoreAchievementSummary>;
}

const steamAchSlot: AchMemorySlot = { hydrated: false, storageRef: null, raw: null, parsed: {} };
const epicAchSlot: AchMemorySlot = { hydrated: false, storageRef: null, raw: null, parsed: {} };
const gogAchSlot: AchMemorySlot = { hydrated: false, storageRef: null, raw: null, parsed: {} };
const xboxAchSlot: AchMemorySlot = { hydrated: false, storageRef: null, raw: null, parsed: {} };

let achStorageListenerAttached = false;

function isTestEnv(): boolean {
  try {
    return (
      typeof process !== 'undefined' &&
      Boolean(process.env?.VITEST || process.env?.NODE_ENV === 'test')
    );
  } catch {
    return false;
  }
}

function getSafeAchStorage(): Storage | null {
  try {
    if (typeof localStorage !== 'undefined' && localStorage) return localStorage;
    if (typeof window !== 'undefined' && window.localStorage) return window.localStorage;
  } catch {
    // Ignore storage access errors
  }
  return null;
}

function ensureAchStorageListener(): void {
  if (achStorageListenerAttached) return;
  if (typeof window === 'undefined' || typeof window.addEventListener !== 'function') return;
  achStorageListenerAttached = true;
  window.addEventListener('storage', (e: StorageEvent) => {
    if (e.key === null || e.key === STORAGE_KEY_STEAM_ACH) {
      steamAchSlot.hydrated = false;
      steamAchSlot.raw = null;
    }
    if (e.key === null || e.key === STORAGE_KEY_EPIC_ACH) {
      epicAchSlot.hydrated = false;
      epicAchSlot.raw = null;
    }
    if (e.key === null || e.key === STORAGE_KEY_GOG_ACH) {
      gogAchSlot.hydrated = false;
      gogAchSlot.raw = null;
    }
    if (e.key === null || e.key === STORAGE_KEY_XBOX_ACH) {
      xboxAchSlot.hydrated = false;
      xboxAchSlot.raw = null;
    }
  });
}

function readAchMapFromSlot(
  slot: AchMemorySlot,
  storageKey: string
): Record<string, StoreAchievementSummary> | null {
  if (typeof window === 'undefined') return null;
  ensureAchStorageListener();
  const storage = getSafeAchStorage();
  if (!storage) return null;

  if (!isTestEnv() && slot.hydrated && slot.storageRef === storage) {
    return Object.keys(slot.parsed).length > 0 ? slot.parsed : null;
  }

  try {
    const raw = storage.getItem(storageKey);
    if (slot.hydrated && slot.storageRef === storage && raw === slot.raw) {
      // Adopt Blink ExternalString pointer to eliminate O(N) cross-representation string scans
      slot.raw = raw;
      return raw ? slot.parsed : null;
    }
    slot.storageRef = storage;
    slot.raw = raw;
    slot.hydrated = true;
    if (!raw) {
      slot.parsed = {};
      return null;
    }
    const parsed = JSON.parse(raw);
    slot.parsed =
      parsed && typeof parsed === 'object'
        ? (parsed as Record<string, StoreAchievementSummary>)
        : {};
    return slot.parsed;
  } catch {
    slot.hydrated = false;
    slot.raw = null;
    slot.parsed = {};
    return null;
  }
}

function writeAchMapToSlot(
  slot: AchMemorySlot,
  storageKey: string,
  merged: Record<string, StoreAchievementSummary>
): void {
  if (typeof window === 'undefined') return;
  ensureAchStorageListener();
  const storage = getSafeAchStorage();
  if (!storage) return;
  const serialized = JSON.stringify(merged);
  storage.setItem(storageKey, serialized);
  slot.storageRef = storage;
  slot.parsed = merged;
  slot.hydrated = true;
  slot.raw = isTestEnv() ? serialized : null;
}

/**
 * Returns user Steam achievements from live scan cache or verified records.
 */
export function getKnownSteamAchievements(
  steamAppId?: number,
  _title?: string
): StoreAchievementSummary | undefined {
  if (!steamAppId) return undefined;

  let best: StoreAchievementSummary | undefined = undefined;

  // 1. Live scanned achievements from localStorage / in-memory cache
  const parsed = readAchMapFromSlot(steamAchSlot, STORAGE_KEY_STEAM_ACH);
  if (parsed && parsed[steamAppId] && typeof parsed[steamAppId].unlocked === 'number') {
    const raw = parsed[steamAppId];
    best = {
      unlocked: raw.unlocked,
      total: raw.total,
      percentage: raw.percentage ?? (raw.total > 0 ? Math.round((raw.unlocked / raw.total) * 100) : 0),
      isMastered: raw.isMastered ?? (raw.total > 0 && raw.unlocked >= raw.total),
      source: raw.source || 'local_client_cache',
      syncedAt: raw.syncedAt,
      hasConflict: raw.hasConflict,
      conflictDetails: raw.conflictDetails,
    };
  }

  // 2. Verified built-in user achievements baseline
  const rawBaseline = KNOWN_USER_STEAM_ACHIEVEMENTS[steamAppId];
  if (rawBaseline) {
    const baseline: StoreAchievementSummary = {
      unlocked: rawBaseline.unlocked,
      total: rawBaseline.total,
      percentage: rawBaseline.percentage,
      isMastered: rawBaseline.total > 0 && rawBaseline.unlocked >= rawBaseline.total,
      source: 'baseline_fallback',
    };
    best = reconcileAchievementSummaries(best, baseline, { appId: steamAppId, store: 'steam' });
  }

  return best;
}

export type PartialSteamAchievementInput =
  | StoreAchievementSummary
  | {
      unlocked: number;
      total: number;
      percentage: number;
      isMastered?: boolean;
      source?: StoreAchievementSummary['source'];
      syncedAt?: string;
      hasConflict?: boolean;
      conflictDetails?: string;
    };

export function cacheUserSteamAchievements(
  map: Record<number, PartialSteamAchievementInput>
): void {
  if (typeof window === 'undefined') return;
  try {
    const existing = readAchMapFromSlot(steamAchSlot, STORAGE_KEY_STEAM_ACH) || {};
    const merged: Record<number, StoreAchievementSummary> = {};

    for (const [k, v] of Object.entries(existing)) {
      merged[Number(k)] = v;
    }

    for (const [key, inc] of Object.entries(map)) {
      const appId = Number(key);
      const incSummary: StoreAchievementSummary = {
        unlocked: inc.unlocked,
        total: inc.total,
        percentage: inc.percentage ?? (inc.total > 0 ? Math.round((inc.unlocked / inc.total) * 100) : 0),
        isMastered: inc.isMastered ?? (inc.total > 0 && inc.unlocked >= inc.total),
        source: inc.source || 'local_client_cache',
        syncedAt: inc.syncedAt || new Date().toISOString(),
        hasConflict: inc.hasConflict,
        conflictDetails: inc.conflictDetails,
      };
      merged[appId] =
        reconcileAchievementSummaries(merged[appId], incSummary, { appId, store: 'steam' }) || incSummary;
    }

    writeAchMapToSlot(
      steamAchSlot,
      STORAGE_KEY_STEAM_ACH,
      merged as unknown as Record<string, StoreAchievementSummary>
    );
  } catch (err) {
    console.warn('Failed to cache Steam achievements to localStorage:', err);
  }
}

/**
 * Returns user Epic achievements from cache or verified records.
 */
export function getKnownEpicAchievements(
  gameId?: string,
  title?: string
): StoreAchievementSummary | undefined {
  let cachedSummary: StoreAchievementSummary | undefined = undefined;

  const parsed = readAchMapFromSlot(epicAchSlot, STORAGE_KEY_EPIC_ACH);
  if (parsed) {
    if (title && parsed[title.toLowerCase().trim()]) {
      cachedSummary = parsed[title.toLowerCase().trim()];
    } else {
      const normTitle = title?.toLowerCase().replace(/[:\-–—]/g, ' ').replace(/\s+/g, ' ').trim();
      if (normTitle && parsed[normTitle]) {
        cachedSummary = parsed[normTitle];
      } else if (gameId && parsed[gameId.toLowerCase()]) {
        cachedSummary = parsed[gameId.toLowerCase()];
      }
    }
  }

  let baseline: StoreAchievementSummary | undefined = undefined;
  if (title && KNOWN_USER_EPIC_ACHIEVEMENTS[title.toLowerCase().trim()]) {
    baseline = KNOWN_USER_EPIC_ACHIEVEMENTS[title.toLowerCase().trim()];
  } else {
    const normTitle = title?.toLowerCase().replace(/[:\-–—]/g, ' ').replace(/\s+/g, ' ').trim();
    if (normTitle && KNOWN_USER_EPIC_ACHIEVEMENTS[normTitle]) {
      baseline = KNOWN_USER_EPIC_ACHIEVEMENTS[normTitle];
    } else if (gameId && KNOWN_USER_EPIC_ACHIEVEMENTS[gameId.toLowerCase()]) {
      baseline = KNOWN_USER_EPIC_ACHIEVEMENTS[gameId.toLowerCase()];
    }
  }

  if (baseline && !baseline.source) {
    baseline = { ...baseline, source: 'baseline_fallback' };
  }

  return reconcileAchievementSummaries(cachedSummary, baseline, { title, store: 'epic' });
}

export function cacheUserEpicAchievements(map: Record<string, StoreAchievementSummary>): void {
  if (typeof window === 'undefined') return;
  try {
    const existing = readAchMapFromSlot(epicAchSlot, STORAGE_KEY_EPIC_ACH) || {};
    const merged: Record<string, StoreAchievementSummary> = { ...existing };

    for (const [key, inc] of Object.entries(map)) {
      const normKey = key.toLowerCase().trim();
      const incSummary: StoreAchievementSummary = {
        unlocked: inc.unlocked,
        total: inc.total,
        percentage: inc.percentage ?? (inc.total > 0 ? Math.round((inc.unlocked / inc.total) * 100) : 0),
        xp: inc.xp,
        isMastered: inc.isMastered ?? (inc.total > 0 && inc.unlocked >= inc.total),
        source: inc.source || 'live_cloud_graphql',
        syncedAt: inc.syncedAt || new Date().toISOString(),
        hasConflict: inc.hasConflict,
        conflictDetails: inc.conflictDetails,
      };
      merged[normKey] =
        reconcileAchievementSummaries(merged[normKey], incSummary, { title: key, store: 'epic' }) || incSummary;
    }

    writeAchMapToSlot(epicAchSlot, STORAGE_KEY_EPIC_ACH, merged);
  } catch (err) {
    console.warn('Failed to cache Epic achievements to localStorage:', err);
  }
}

/**
 * Returns user GOG achievements from cache or verified records.
 */
export function getKnownGogAchievements(
  gameId?: string,
  title?: string
): StoreAchievementSummary | undefined {
  let cachedSummary: StoreAchievementSummary | undefined = undefined;

  const parsed = readAchMapFromSlot(gogAchSlot, STORAGE_KEY_GOG_ACH);
  if (parsed) {
    if (title && parsed[title.toLowerCase().trim()]) {
      cachedSummary = parsed[title.toLowerCase().trim()];
    } else {
      const normTitle = title?.toLowerCase().replace(/[:\-–—]/g, ' ').replace(/\s+/g, ' ').trim();
      if (normTitle && parsed[normTitle]) {
        cachedSummary = parsed[normTitle];
      } else if (gameId && parsed[gameId.toLowerCase()]) {
        cachedSummary = parsed[gameId.toLowerCase()];
      } else {
        const cleanId = gameId?.replace(/^gog-/, '');
        if (cleanId && parsed[cleanId]) {
          cachedSummary = parsed[cleanId];
        }
      }
    }
  }

  let baseline: StoreAchievementSummary | undefined = undefined;
  if (title && KNOWN_USER_GOG_ACHIEVEMENTS[title.toLowerCase().trim()]) {
    baseline = KNOWN_USER_GOG_ACHIEVEMENTS[title.toLowerCase().trim()];
  } else {
    const normTitle = title?.toLowerCase().replace(/[:\-–—]/g, ' ').replace(/\s+/g, ' ').trim();
    if (normTitle && KNOWN_USER_GOG_ACHIEVEMENTS[normTitle]) {
      baseline = KNOWN_USER_GOG_ACHIEVEMENTS[normTitle];
    } else if (gameId && KNOWN_USER_GOG_ACHIEVEMENTS[gameId.toLowerCase()]) {
      baseline = KNOWN_USER_GOG_ACHIEVEMENTS[gameId.toLowerCase()];
    } else {
      const cleanId = gameId?.replace(/^gog-/, '');
      if (cleanId && KNOWN_USER_GOG_ACHIEVEMENTS[cleanId]) {
        baseline = KNOWN_USER_GOG_ACHIEVEMENTS[cleanId];
      }
    }
  }

  if (baseline && !baseline.source) {
    baseline = { ...baseline, source: 'baseline_fallback' };
  }

  return reconcileAchievementSummaries(cachedSummary, baseline, { title, store: 'gog' });
}

export function cacheUserGogAchievements(map: Record<string, StoreAchievementSummary>): void {
  if (typeof window === 'undefined') return;
  try {
    const existing = readAchMapFromSlot(gogAchSlot, STORAGE_KEY_GOG_ACH) || {};
    const merged: Record<string, StoreAchievementSummary> = { ...existing };

    for (const [key, inc] of Object.entries(map)) {
      const normKey = key.toLowerCase().trim();
      const incSummary: StoreAchievementSummary = {
        unlocked: inc.unlocked,
        total: inc.total,
        percentage: inc.percentage ?? (inc.total > 0 ? Math.round((inc.unlocked / inc.total) * 100) : 0),
        isMastered: inc.isMastered ?? (inc.total > 0 && inc.unlocked >= inc.total),
        source: inc.source || 'live_cloud_xml',
        syncedAt: inc.syncedAt || new Date().toISOString(),
        hasConflict: inc.hasConflict,
        conflictDetails: inc.conflictDetails,
      };
      merged[normKey] =
        reconcileAchievementSummaries(merged[normKey], incSummary, { title: key, store: 'gog' }) || incSummary;
    }

    writeAchMapToSlot(gogAchSlot, STORAGE_KEY_GOG_ACH, merged);
  } catch (err) {
    console.warn('Failed to cache GOG achievements to localStorage:', err);
  }
}

export const KNOWN_USER_XBOX_ACHIEVEMENTS: Record<string, StoreAchievementSummary> = {};

/**
 * Returns user Xbox / Game Pass achievements and Gamerscore from cache or verified records.
 */
export function getKnownXboxAchievements(
  gameId?: string,
  title?: string,
  extraKeys?: Array<string | undefined>
): StoreAchievementSummary | undefined {
  let cachedSummary: StoreAchievementSummary | undefined = undefined;

  const lookupKeys: string[] = [];
  const pushKey = (k?: string) => {
    if (!k) return;
    const clean = k.toLowerCase().trim();
    if (clean && !lookupKeys.includes(clean)) lookupKeys.push(clean);
    const stripped = clean.replace(/^xbox[-_]/, '');
    if (stripped && !lookupKeys.includes(stripped)) lookupKeys.push(stripped);
  };

  if (Array.isArray(extraKeys)) {
    for (const k of extraKeys) pushKey(k);
  }
  pushKey(gameId);
  if (title) {
    pushKey(title);
    pushKey(title.replace(/[:\-–—]/g, ' ').replace(/\s+/g, ' '));
  }

  const parsed = readAchMapFromSlot(xboxAchSlot, STORAGE_KEY_XBOX_ACH);
  if (parsed) {
    for (const key of lookupKeys) {
      if (parsed[key]) {
        cachedSummary = parsed[key];
        break;
      }
    }
  }

  let baseline: StoreAchievementSummary | undefined = undefined;
  for (const key of lookupKeys) {
    if (KNOWN_USER_XBOX_ACHIEVEMENTS[key]) {
      baseline = KNOWN_USER_XBOX_ACHIEVEMENTS[key];
      break;
    }
  }

  if (baseline && !baseline.source) {
    baseline = { ...baseline, source: 'baseline_fallback' };
  }

  return reconcileAchievementSummaries(cachedSummary, baseline, { title, store: 'xbox' });
}

export interface XboxAchievementCacheInput extends Partial<StoreAchievementSummary> {
  earnedGamerscore?: number;
  totalGamerscore?: number;
}

export function cacheUserXboxAchievements(
  map: Record<string, unknown>
): void {
  if (typeof window === 'undefined' || !map) return;
  try {
    const existing = readAchMapFromSlot(xboxAchSlot, STORAGE_KEY_XBOX_ACH) || {};
    const merged: Record<string, StoreAchievementSummary> = { ...existing };

    for (const [key, inc] of Object.entries(map)) {
      if (!inc || typeof inc !== 'object') continue;
      const normKey = key.toLowerCase().trim();
      if (!normKey) continue;
      const typedInc = inc as XboxAchievementCacheInput;
      const unlocked = typeof typedInc.unlocked === 'number' ? typedInc.unlocked : 0;
      const total = typeof typedInc.total === 'number' ? typedInc.total : 0;
      const rawGs = typedInc.gamerscore;
      const gamerscore =
        rawGs && typeof rawGs === 'object'
          ? {
              earned: typeof rawGs.earned === 'number' ? rawGs.earned : 0,
              total: typeof rawGs.total === 'number' ? rawGs.total : 0,
            }
          : typeof typedInc.earnedGamerscore === 'number' || typeof typedInc.totalGamerscore === 'number'
            ? {
                earned: typeof typedInc.earnedGamerscore === 'number' ? typedInc.earnedGamerscore : 0,
                total: typeof typedInc.totalGamerscore === 'number' ? typedInc.totalGamerscore : 0,
              }
            : undefined;

      const incSummary: StoreAchievementSummary = {
        unlocked,
        total,
        percentage:
          typeof typedInc.percentage === 'number'
            ? typedInc.percentage
            : total > 0
              ? Math.round((unlocked / total) * 100)
              : 0,
        ...(gamerscore ? { gamerscore } : {}),
        isMastered:
          typeof typedInc.isMastered === 'boolean'
            ? typedInc.isMastered
            : total > 0 && unlocked >= total,
        source: typedInc.source || 'live_cloud_api',
        syncedAt: typeof typedInc.syncedAt === 'string' ? typedInc.syncedAt : new Date().toISOString(),
        hasConflict: typeof typedInc.hasConflict === 'boolean' ? typedInc.hasConflict : undefined,
        conflictDetails:
          typeof typedInc.conflictDetails === 'string' ? typedInc.conflictDetails : undefined,
      };
      merged[normKey] =
        reconcileAchievementSummaries(merged[normKey], incSummary, { title: key, store: 'xbox' }) ||
        incSummary;
    }

    writeAchMapToSlot(xboxAchSlot, STORAGE_KEY_XBOX_ACH, merged);
  } catch (err) {
    console.warn('Failed to cache Xbox achievements to localStorage:', err);
  }
}


