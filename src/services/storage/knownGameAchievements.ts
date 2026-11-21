import { StoreAchievementSummary } from '../../contracts/game';
import { reconcileAchievementSummaries } from './achievementReconciliation';
import {
  achievementSummaryStore,
  clearStorefrontAchievementSummaries,
  normalizeStoredAchievementSummary,
  type AchievementSummaryStorefrontId,
} from './knownGameAchievementsStore';

export { clearStorefrontAchievementSummaries };
export type { AchievementSummaryStorefrontId };

export type CachedAchievementEntry = StoreAchievementSummary;

const SPECIAL_NON_STEAM_ACHIEVEMENTS: Record<string, number> = {};

export const KNOWN_USER_GOG_ACHIEVEMENTS: Record<string, StoreAchievementSummary> = {};

export const KNOWN_USER_EPIC_ACHIEVEMENTS: Record<string, StoreAchievementSummary> = {};

export const KNOWN_USER_STEAM_ACHIEVEMENTS: Record<
  number,
  { unlocked: number; total: number; percentage: number; lastUnlockedAt?: string }
> = {};

export const KNOWN_GAME_ACHIEVEMENT_TOTALS: Record<string, number> = {};

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

/**
 * Returns user Steam achievements from the unified AchievementSummaryStore or verified baseline.
 */
export function getKnownSteamAchievements(
  steamAppId?: number,
  _title?: string
): StoreAchievementSummary | undefined {
  if (!steamAppId || !Number.isFinite(steamAppId) || steamAppId <= 0) return undefined;

  let best: StoreAchievementSummary | undefined = undefined;

  const raw = achievementSummaryStore.get('steam', Math.trunc(steamAppId));
  if (raw) {
    best = normalizeStoredAchievementSummary(raw, 'local_client_cache') ?? undefined;
  }

  const rawBaseline = KNOWN_USER_STEAM_ACHIEVEMENTS[steamAppId];
  if (rawBaseline) {
    const baseline: StoreAchievementSummary = {
      unlocked: rawBaseline.unlocked,
      total: rawBaseline.total,
      percentage: rawBaseline.percentage,
      isMastered: rawBaseline.total > 0 && rawBaseline.unlocked >= rawBaseline.total,
      ...(rawBaseline.lastUnlockedAt ? { lastUnlockedAt: rawBaseline.lastUnlockedAt } : {}),
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
      lastUnlockedAt?: string;
      source?: StoreAchievementSummary['source'];
      syncedAt?: string;
      hasConflict?: boolean;
      conflictDetails?: string;
    };

export function cacheUserSteamAchievements(
  map: Record<number, PartialSteamAchievementInput>
): void {
  if (typeof window === 'undefined' || !map || typeof map !== 'object') return;
  try {
    const batch: Record<string, StoreAchievementSummary> = {};
    const nowIso = new Date().toISOString();

    for (const [key, inc] of Object.entries(map)) {
      const appId = Number(key);
      if (!Number.isFinite(appId) || appId <= 0 || !inc || typeof inc !== 'object') {
        continue;
      }
      const normalized = normalizeStoredAchievementSummary(
        {
          ...inc,
          source: inc.source || 'local_client_cache',
          syncedAt: inc.syncedAt || nowIso,
        },
        'local_client_cache'
      );
      if (normalized) {
        batch[String(Math.trunc(appId))] = normalized;
      }
    }

    if (Object.keys(batch).length > 0) {
      achievementSummaryStore.mergeBatch('steam', batch, { immediate: true });
    }
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

  const parsed = achievementSummaryStore.getAll('epic');
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
  if (typeof window === 'undefined' || !map || typeof map !== 'object') return;
  try {
    const batch: Record<string, StoreAchievementSummary> = {};
    const nowIso = new Date().toISOString();

    for (const [key, inc] of Object.entries(map)) {
      const normKey = key.toLowerCase().trim();
      if (!normKey || !inc || typeof inc !== 'object') continue;
      const normalized = normalizeStoredAchievementSummary(
        {
          ...inc,
          source: inc.source || 'live_cloud_graphql',
          syncedAt: inc.syncedAt || nowIso,
        },
        'live_cloud_graphql'
      );
      if (normalized) {
        batch[normKey] = normalized;
      }
    }

    if (Object.keys(batch).length > 0) {
      achievementSummaryStore.mergeBatch('epic', batch, { immediate: true });
    }
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

  const parsed = achievementSummaryStore.getAll('gog');
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
  if (typeof window === 'undefined' || !map || typeof map !== 'object') return;
  try {
    const batch: Record<string, StoreAchievementSummary> = {};
    const nowIso = new Date().toISOString();

    for (const [key, inc] of Object.entries(map)) {
      const normKey = key.toLowerCase().trim();
      if (!normKey || !inc || typeof inc !== 'object') continue;
      const normalized = normalizeStoredAchievementSummary(
        {
          ...inc,
          source: inc.source || 'live_cloud_xml',
          syncedAt: inc.syncedAt || nowIso,
        },
        'live_cloud_xml'
      );
      if (normalized) {
        batch[normKey] = normalized;
      }
    }

    if (Object.keys(batch).length > 0) {
      achievementSummaryStore.mergeBatch('gog', batch, { immediate: true });
    }
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

  const parsed = achievementSummaryStore.getAll('xbox');
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

export function cacheUserXboxAchievements(map: Record<string, unknown>): void {
  if (typeof window === 'undefined' || !map || typeof map !== 'object') return;
  try {
    const batch: Record<string, StoreAchievementSummary> = {};
    const nowIso = new Date().toISOString();

    for (const [key, inc] of Object.entries(map)) {
      if (!inc || typeof inc !== 'object') continue;
      const normKey = key.toLowerCase().trim();
      if (!normKey) continue;
      const typedInc = inc as XboxAchievementCacheInput;
      const unlocked =
        typeof typedInc.unlocked === 'number' && Number.isFinite(typedInc.unlocked)
          ? typedInc.unlocked
          : 0;
      const total =
        typeof typedInc.total === 'number' && Number.isFinite(typedInc.total)
          ? typedInc.total
          : 0;
      const rawGs = typedInc.gamerscore;
      const gamerscore =
        rawGs && typeof rawGs === 'object'
          ? {
              earned: typeof rawGs.earned === 'number' ? rawGs.earned : 0,
              total: typeof rawGs.total === 'number' ? rawGs.total : 0,
            }
          : typeof typedInc.earnedGamerscore === 'number' ||
              typeof typedInc.totalGamerscore === 'number'
            ? {
                earned:
                  typeof typedInc.earnedGamerscore === 'number' ? typedInc.earnedGamerscore : 0,
                total:
                  typeof typedInc.totalGamerscore === 'number' ? typedInc.totalGamerscore : 0,
              }
            : undefined;

      const normalized = normalizeStoredAchievementSummary(
        {
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
          ...(typeof typedInc.lastUnlockedAt === 'string' && typedInc.lastUnlockedAt
            ? { lastUnlockedAt: typedInc.lastUnlockedAt }
            : {}),
          source: typedInc.source || 'live_cloud_api',
          syncedAt: typeof typedInc.syncedAt === 'string' ? typedInc.syncedAt : nowIso,
          hasConflict:
            typeof typedInc.hasConflict === 'boolean' ? typedInc.hasConflict : undefined,
          conflictDetails:
            typeof typedInc.conflictDetails === 'string' ? typedInc.conflictDetails : undefined,
        },
        'live_cloud_api'
      );
      if (normalized) {
        batch[normKey] = normalized;
      }
    }

    if (Object.keys(batch).length > 0) {
      achievementSummaryStore.mergeBatch('xbox', batch, { immediate: true });
    }
  } catch (err) {
    console.warn('Failed to cache Xbox achievements to localStorage:', err);
  }
}
