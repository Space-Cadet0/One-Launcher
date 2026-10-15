import knownAchievementsRaw from './knownGameAchievements.json';
import { StoreAchievementSummary } from '../../contracts/game';
import { reconcileAchievementSummaries } from './achievementReconciliation';

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

/**
 * Returns user Steam achievements from live scan cache or verified records.
 */
export function getKnownSteamAchievements(
  steamAppId?: number,
  _title?: string
): StoreAchievementSummary | undefined {
  if (!steamAppId) return undefined;

  let best: StoreAchievementSummary | undefined = undefined;

  // 1. Live scanned achievements from localStorage
  if (typeof window !== 'undefined') {
    try {
      const cached = localStorage.getItem('antigravity_steam_achievements');
      if (cached) {
        const parsed = JSON.parse(cached);
        if (parsed[steamAppId] && typeof parsed[steamAppId].unlocked === 'number') {
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
      }
    } catch {
      // Ignore cache parse errors
    }
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

export function cacheUserSteamAchievements(
  map: Record<number, StoreAchievementSummary | { unlocked: number; total: number; percentage: number; source?: any }>
): void {
  if (typeof window === 'undefined') return;
  try {
    const existingRaw = localStorage.getItem('antigravity_steam_achievements');
    const existing: Record<string, StoreAchievementSummary> = existingRaw ? JSON.parse(existingRaw) : {};
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
        isMastered: (inc as any).isMastered ?? (inc.total > 0 && inc.unlocked >= inc.total),
        source: (inc as any).source || 'local_client_cache',
        syncedAt: (inc as any).syncedAt || new Date().toISOString(),
        hasConflict: (inc as any).hasConflict,
        conflictDetails: (inc as any).conflictDetails,
      };
      merged[appId] =
        reconcileAchievementSummaries(merged[appId], incSummary, { appId, store: 'steam' }) || incSummary;
    }

    localStorage.setItem('antigravity_steam_achievements', JSON.stringify(merged));
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

  if (typeof window !== 'undefined') {
    try {
      const cached = localStorage.getItem('antigravity_epic_achievements');
      if (cached) {
        const parsed = JSON.parse(cached);
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
    } catch {
      // Ignore cache parse errors
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
    const existingRaw = localStorage.getItem('antigravity_epic_achievements');
    const existing: Record<string, StoreAchievementSummary> = existingRaw ? JSON.parse(existingRaw) : {};
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

    localStorage.setItem('antigravity_epic_achievements', JSON.stringify(merged));
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

  if (typeof window !== 'undefined') {
    try {
      const cached = localStorage.getItem('antigravity_gog_achievements');
      if (cached) {
        const parsed = JSON.parse(cached);
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
    } catch {
      // Ignore cache parse errors
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
    const existingRaw = localStorage.getItem('antigravity_gog_achievements');
    const existing: Record<string, StoreAchievementSummary> = existingRaw ? JSON.parse(existingRaw) : {};
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

    localStorage.setItem('antigravity_gog_achievements', JSON.stringify(merged));
  } catch (err) {
    console.warn('Failed to cache GOG achievements to localStorage:', err);
  }
}


