import knownAchievementsRaw from './knownGameAchievements.json';
import { StoreAchievementSummary } from '../../contracts/game';
import { reconcileAchievementSummaries } from './achievementReconciliation';

const SPECIAL_NON_STEAM_ACHIEVEMENTS: Record<string, number> = {
  'alan wake 2': 88,
  'epic-93f2a8c3547846eda966cb3c152a026e': 88,
  '1901367087': 35,
  'gog-1901367087': 35,
  'a plague tale: innocence': 35,
  'a plague tale innocence': 35,
  'gog-1413291984': 33, // DOOM + DOOM II
  'doom + doom ii': 33,
};

export const KNOWN_USER_GOG_ACHIEVEMENTS: Record<string, StoreAchievementSummary> = {
  '1901367087': {
    unlocked: 25,
    total: 35,
    percentage: 71,
    isMastered: false,
  },
  'gog-1901367087': {
    unlocked: 25,
    total: 35,
    percentage: 71,
    isMastered: false,
  },
  'a plague tale: innocence': {
    unlocked: 25,
    total: 35,
    percentage: 71,
    isMastered: false,
    source: 'live_cloud_xml',
  },
};

export const KNOWN_USER_EPIC_ACHIEVEMENTS: Record<string, StoreAchievementSummary> = {
  'alan wake 2': {
    unlocked: 59,
    total: 88,
    percentage: 67,
    xp: { earned: 830, total: 1360 },
    isMastered: false,
  },
  'epic-93f2a8c3547846eda966cb3c152a026e': {
    unlocked: 59,
    total: 88,
    percentage: 67,
    xp: { earned: 830, total: 1360 },
    isMastered: false,
  },
  'c4763f236d08423eb47b4c3008779c84': {
    unlocked: 59,
    total: 88,
    percentage: 67,
    xp: { earned: 830, total: 1360 },
    isMastered: false,
  },
};

/**
 * Verified user Steam achievements directly extracted from Steam userdata librarycache.
 * Acts as instant baseline and fallback when filesystem is offline.
 */
export const KNOWN_USER_STEAM_ACHIEVEMENTS: Record<number, { unlocked: number; total: number; percentage: number }> = {
  1091500: { unlocked: 57, total: 57, percentage: 100 }, // Cyberpunk 2077 (57/57 Mastered)
  1903340: { unlocked: 55, total: 55, percentage: 100 }, // Clair Obscur: Expedition 33 (55/55 Mastered)
  292030: { unlocked: 51, total: 78, percentage: 65 },  // The Witcher 3: Wild Hunt
  435150: { unlocked: 60, total: 97, percentage: 62 },  // Divinity: Original Sin 2
  2909400: { unlocked: 47, total: 61, percentage: 77 }, // Fantasian Neo Dimension
  3751260: { unlocked: 36, total: 46, percentage: 78 },
  257350: { unlocked: 47, total: 93, percentage: 51 },  // Baldur's Gate II: Enhanced Edition
  228280: { unlocked: 34, total: 129, percentage: 26 }, // Baldur's Gate: Enhanced Edition
  750920: { unlocked: 42, total: 99, percentage: 42 },  // Shadow of the Tomb Raider (Authoritative live XML 42/99)
  213670: { unlocked: 22, total: 50, percentage: 44 },  // South Park: The Stick of Truth
  287700: { unlocked: 21, total: 42, percentage: 50 },  // Metal Gear Solid V: Ground Zeroes (Authoritative live XML 21/42)
  1086940: { unlocked: 14, total: 54, percentage: 26 }, // Baldur's Gate 3
  3764200: { unlocked: 10, total: 49, percentage: 20 },
  362890: { unlocked: 10, total: 50, percentage: 20 },
  223850: { unlocked: 9, total: 29, percentage: 31 },   // 3DMark
  374320: { unlocked: 3, total: 43, percentage: 7 },
  288470: { unlocked: 2, total: 50, percentage: 4 },
  1608070: { unlocked: 2, total: 51, percentage: 4 },
  400: { unlocked: 2, total: 15, percentage: 13 },      // Portal
  814380: { unlocked: 1, total: 34, percentage: 3 },    // Sekiro: Shadows Die Twice
  204360: { unlocked: 1, total: 12, percentage: 8 },    // Castle Crashers
  220: { unlocked: 0, total: 69, percentage: 0 },       // Half-Life 2
  620: { unlocked: 0, total: 51, percentage: 0 },       // Portal 2
  22380: { unlocked: 0, total: 75, percentage: 0 },     // Fallout: New Vegas
  35130: { unlocked: 0, total: 12, percentage: 0 },
  43110: { unlocked: 0, total: 48, percentage: 0 },
  43160: { unlocked: 0, total: 70, percentage: 0 },
  49520: { unlocked: 0, total: 75, percentage: 0 },
  57300: { unlocked: 0, total: 18, percentage: 0 },
  94300: { unlocked: 0, total: 46, percentage: 0 },
  99300: { unlocked: 0, total: 16, percentage: 0 },
  203160: { unlocked: 0, total: 50, percentage: 0 },
  203750: { unlocked: 0, total: 49, percentage: 0 },
  207610: { unlocked: 0, total: 48, percentage: 0 },
  211160: { unlocked: 0, total: 50, percentage: 0 },
  219950: { unlocked: 0, total: 13, percentage: 0 },
  226620: { unlocked: 0, total: 35, percentage: 0 },
  226840: { unlocked: 0, total: 74, percentage: 0 },
  230230: { unlocked: 0, total: 63, percentage: 0 },
  232770: { unlocked: 0, total: 27, percentage: 0 },
  239200: { unlocked: 0, total: 7, percentage: 0 },
  242700: { unlocked: 0, total: 50, percentage: 0 },
  268500: { unlocked: 0, total: 88, percentage: 0 },
  268870: { unlocked: 0, total: 40, percentage: 0 },
  286690: { unlocked: 0, total: 49, percentage: 0 },
  287390: { unlocked: 0, total: 49, percentage: 0 },
  289690: { unlocked: 0, total: 40, percentage: 0 },
  291650: { unlocked: 0, total: 48, percentage: 0 },
  297130: { unlocked: 0, total: 27, percentage: 0 },
  318600: { unlocked: 0, total: 36, percentage: 0 },
  337000: { unlocked: 0, total: 81, percentage: 0 },
  373420: { unlocked: 0, total: 54, percentage: 0 },
  379430: { unlocked: 0, total: 82, percentage: 0 },
  379720: { unlocked: 0, total: 54, percentage: 0 },
  383870: { unlocked: 0, total: 10, percentage: 0 },
  391220: { unlocked: 0, total: 143, percentage: 0 },
  395170: { unlocked: 0, total: 16, percentage: 0 },
  412020: { unlocked: 0, total: 68, percentage: 0 },
  439190: { unlocked: 0, total: 37, percentage: 0 },
  475150: { unlocked: 0, total: 115, percentage: 0 },
  488790: { unlocked: 0, total: 35, percentage: 0 },
  489630: { unlocked: 0, total: 166, percentage: 0 },
  520720: { unlocked: 0, total: 10, percentage: 0 },
  552500: { unlocked: 0, total: 26, percentage: 0 },
  560130: { unlocked: 0, total: 55, percentage: 0 },
  640820: { unlocked: 0, total: 74, percentage: 0 },
  782330: { unlocked: 0, total: 50, percentage: 0 },
  813780: { unlocked: 0, total: 370, percentage: 0 },
  883710: { unlocked: 0, total: 44, percentage: 0 },
  960990: { unlocked: 0, total: 45, percentage: 0 },
  1144770: { unlocked: 0, total: 14, percentage: 0 },
  1151640: { unlocked: 0, total: 79, percentage: 0 },
  1174180: { unlocked: 0, total: 51, percentage: 0 },
  1180660: { unlocked: 0, total: 30, percentage: 0 },
  1373960: { unlocked: 0, total: 16, percentage: 0 },
  1448030: { unlocked: 0, total: 5, percentage: 0 },
  1687950: { unlocked: 0, total: 53, percentage: 0 },
  1712840: { unlocked: 0, total: 30, percentage: 0 },
  1715130: { unlocked: 0, total: 40, percentage: 0 },
  2215490: { unlocked: 0, total: 6, percentage: 0 },
  2398450: { unlocked: 0, total: 12, percentage: 0 },
  2417610: { unlocked: 0, total: 45, percentage: 0 },
  2561580: { unlocked: 0, total: 79, percentage: 0 },
};

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
  if (typeof window !== 'undefined') {
    try {
      const cached = localStorage.getItem('antigravity_epic_achievements');
      if (cached) {
        const parsed = JSON.parse(cached);
        if (title && parsed[title.toLowerCase().trim()]) {
          return parsed[title.toLowerCase().trim()];
        }
        const normTitle = title?.toLowerCase().replace(/[:\-–—]/g, ' ').replace(/\s+/g, ' ').trim();
        if (normTitle && parsed[normTitle]) {
          return parsed[normTitle];
        }
        if (gameId && parsed[gameId.toLowerCase()]) {
          return parsed[gameId.toLowerCase()];
        }
      }
    } catch {
      // Ignore cache parse errors
    }
  }

  if (title && KNOWN_USER_EPIC_ACHIEVEMENTS[title.toLowerCase().trim()]) {
    return KNOWN_USER_EPIC_ACHIEVEMENTS[title.toLowerCase().trim()];
  }
  if (gameId && KNOWN_USER_EPIC_ACHIEVEMENTS[gameId.toLowerCase()]) {
    return KNOWN_USER_EPIC_ACHIEVEMENTS[gameId.toLowerCase()];
  }
  return undefined;
}

export function cacheUserEpicAchievements(map: Record<string, StoreAchievementSummary>): void {
  if (typeof window === 'undefined') return;
  try {
    const existingRaw = localStorage.getItem('antigravity_epic_achievements');
    const existing = existingRaw ? JSON.parse(existingRaw) : {};
    const merged = { ...existing, ...map };
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
  if (typeof window !== 'undefined') {
    try {
      const cached = localStorage.getItem('antigravity_gog_achievements');
      if (cached) {
        const parsed = JSON.parse(cached);
        if (title && parsed[title.toLowerCase().trim()]) {
          return parsed[title.toLowerCase().trim()];
        }
        const normTitle = title?.toLowerCase().replace(/[:\-–—]/g, ' ').replace(/\s+/g, ' ').trim();
        if (normTitle && parsed[normTitle]) {
          return parsed[normTitle];
        }
        if (gameId && parsed[gameId.toLowerCase()]) {
          return parsed[gameId.toLowerCase()];
        }
        const cleanId = gameId?.replace(/^gog-/, '');
        if (cleanId && parsed[cleanId]) {
          return parsed[cleanId];
        }
      }
    } catch {
      // Ignore cache parse errors
    }
  }

  if (title && KNOWN_USER_GOG_ACHIEVEMENTS[title.toLowerCase().trim()]) {
    return KNOWN_USER_GOG_ACHIEVEMENTS[title.toLowerCase().trim()];
  }
  const normTitle = title?.toLowerCase().replace(/[:\-–—]/g, ' ').replace(/\s+/g, ' ').trim();
  if (normTitle && KNOWN_USER_GOG_ACHIEVEMENTS[normTitle]) {
    return KNOWN_USER_GOG_ACHIEVEMENTS[normTitle];
  }
  if (gameId && KNOWN_USER_GOG_ACHIEVEMENTS[gameId.toLowerCase()]) {
    return KNOWN_USER_GOG_ACHIEVEMENTS[gameId.toLowerCase()];
  }
  const cleanId = gameId?.replace(/^gog-/, '');
  if (cleanId && KNOWN_USER_GOG_ACHIEVEMENTS[cleanId]) {
    return KNOWN_USER_GOG_ACHIEVEMENTS[cleanId];
  }
  return undefined;
}

export function cacheUserGogAchievements(map: Record<string, StoreAchievementSummary>): void {
  if (typeof window === 'undefined') return;
  try {
    const existingRaw = localStorage.getItem('antigravity_gog_achievements');
    const existing = existingRaw ? JSON.parse(existingRaw) : {};
    const merged = { ...existing, ...map };
    localStorage.setItem('antigravity_gog_achievements', JSON.stringify(merged));
  } catch (err) {
    console.warn('Failed to cache GOG achievements to localStorage:', err);
  }
}

