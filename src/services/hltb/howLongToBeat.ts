import { isSequelMismatch, normalizeTitleKey, stripEditionSuffix } from '../common/titleUtils';
import { requestScheduler, Priority } from '../network/requestScheduler';

export interface HltbData {
  mainStoryHours: number;
  mainExtraHours: number;
  completionistHours: number;
  allStylesHours: number;
  gameplayType?: string;
  hltbGameId?: number;
  isAccurate?: boolean;
}

export const HLTB_TITLE_DATABASE: Record<string, HltbData> = {};

export const HLTB_DATABASE: Record<number, HltbData> = {};

const LOCAL_STORAGE_KEY = 'hltb_cache_v2';
const memoryCache = new Map<string, HltbData>();

export function normalizeTitleForHltb(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function getCachedHltb(key: string): HltbData | null {
  if (memoryCache.has(key)) return memoryCache.get(key)!;
  if (typeof window === 'undefined') return null;
  try {
    const raw = localStorage.getItem(`${LOCAL_STORAGE_KEY}_${key}`);
    if (raw) {
      const parsed = JSON.parse(raw);
      memoryCache.set(key, parsed);
      return parsed;
    }
  } catch {}
  return null;
}

function setCachedHltb(key: string, data: HltbData) {
  memoryCache.set(key, data);
  if (typeof window === 'undefined') return;
  try {
    localStorage.setItem(`${LOCAL_STORAGE_KEY}_${key}`, JSON.stringify(data));
  } catch {}
}

function estimateHltbFromGenres(genres: string[] = [], tags: string[] = []): HltbData {
  const allDescriptors = [...genres, ...tags].map((t) => t.toLowerCase());

  const isRpg = allDescriptors.some((d) => d.includes('rpg') || d.includes('role-playing'));
  const isOpenWorld = allDescriptors.some((d) => d.includes('open world'));
  const isStrategy = allDescriptors.some((d) => d.includes('strategy') || d.includes('tactics') || d.includes('4x'));
  const isShooter = allDescriptors.some((d) => d.includes('shooter') || d.includes('fps'));
  const isHorror = allDescriptors.some((d) => d.includes('horror'));
  const isPuzzle = allDescriptors.some((d) => d.includes('puzzle') || d.includes('platformer'));
  const isIndie = allDescriptors.some((d) => d.includes('indie') || d.includes('short'));

  if (isRpg && isOpenWorld) {
    return { mainStoryHours: 38, mainExtraHours: 75, completionistHours: 130, allStylesHours: 60, gameplayType: 'Open World RPG', isAccurate: false };
  } else if (isRpg) {
    return { mainStoryHours: 30, mainExtraHours: 52, completionistHours: 85, allStylesHours: 42, gameplayType: 'Role-Playing Game', isAccurate: false };
  } else if (isStrategy) {
    return { mainStoryHours: 26, mainExtraHours: 45, completionistHours: 72, allStylesHours: 38, gameplayType: 'Strategy / Tactical', isAccurate: false };
  } else if (isShooter) {
    return { mainStoryHours: 11, mainExtraHours: 16, completionistHours: 25, allStylesHours: 14, gameplayType: 'First-Person Action', isAccurate: false };
  } else if (isHorror) {
    return { mainStoryHours: 9, mainExtraHours: 13, completionistHours: 21, allStylesHours: 11, gameplayType: 'Survival Horror', isAccurate: false };
  } else if (isPuzzle || isIndie) {
    return { mainStoryHours: 5, mainExtraHours: 8, completionistHours: 12, allStylesHours: 6.5, gameplayType: 'Adventure / Indie', isAccurate: false };
  }

  return { mainStoryHours: 12, mainExtraHours: 18, completionistHours: 30, allStylesHours: 15, gameplayType: 'Action-Adventure', isAccurate: false };
}

export function findBestHltbMatch(gameTitle: string, results: any[]): any | null {
  if (!results || results.length === 0 || !gameTitle) return null;

  const compatibleResults = results.filter(
    (r) => r?.game_name && typeof r.game_name === 'string' && !isSequelMismatch(gameTitle, r.game_name)
  );
  if (compatibleResults.length === 0) return null;

  const normalize = (s: string) =>
    s
      .toLowerCase()
      .replace(/[^a-z0-9]/g, '')
      .trim();

  const targetNorm = normalize(gameTitle);
  if (!targetNorm) return null;

  // 1. Exact normalized match (e.g. "Betrayer", "Alan Wake 2", "Blood Omen: Legacy of Kain")
  const exact = compatibleResults.find((r) => normalize(r.game_name) === targetNorm);
  if (exact) return exact;

  // 2. Token overlap similarity and base-title prefix check
  const targetTokens = normalizeTitleKey(gameTitle).split(' ').filter(Boolean);
  const strippedTargetTokens = normalizeTitleKey(stripEditionSuffix(gameTitle)).split(' ').filter(Boolean);
  const targetBaseTokens = normalizeTitleKey(gameTitle.split(':')[0]).split(' ').filter(Boolean);

  const calcOverlap = (a: string[], b: string[]): number => {
    if (a.length === 0 || b.length === 0) return 0;
    const setB = new Set(b);
    const shared = a.filter((t) => setB.has(t)).length;
    return shared / Math.max(a.length, b.length);
  };

  let bestCandidate: any | null = null;
  let bestSimilarity = 0;
  let bestHasPrefixMatch = false;

  for (const r of compatibleResults) {
    const candTokens = normalizeTitleKey(r.game_name).split(' ').filter(Boolean);
    const strippedCandTokens = normalizeTitleKey(stripEditionSuffix(r.game_name)).split(' ').filter(Boolean);
    const candBaseTokens = normalizeTitleKey(r.game_name.split(':')[0]).split(' ').filter(Boolean);

    const rawSim = calcOverlap(targetTokens, candTokens);
    const strippedSim = calcOverlap(
      strippedTargetTokens.length > 0 ? strippedTargetTokens : targetTokens,
      strippedCandTokens.length > 0 ? strippedCandTokens : candTokens
    );
    const similarity = Math.max(rawSim, strippedSim);

    const hasColon = gameTitle.includes(':') || r.game_name.includes(':');
    const isBasePrefixMatch =
      hasColon &&
      targetBaseTokens.length > 0 &&
      targetBaseTokens.length === candBaseTokens.length &&
      targetBaseTokens.every((t, i) => candBaseTokens[i] === t);

    if (similarity > bestSimilarity || (!bestCandidate && isBasePrefixMatch)) {
      bestSimilarity = similarity;
      bestCandidate = r;
      bestHasPrefixMatch = isBasePrefixMatch;
    }
  }

  if (bestCandidate && (bestSimilarity >= 0.6 || bestHasPrefixMatch)) {
    return bestCandidate;
  }

  return null;
}

/**
 * Gets HowLongToBeat completion times synchronously from curated data, persistent cache, or heuristic baseline.
 */
export function getHowLongToBeat(
  gameTitleOrAppId?: string | number,
  appId?: number,
  genres: string[] = [],
  tags: string[] = []
): HltbData {
  const title = typeof gameTitleOrAppId === 'string' ? gameTitleOrAppId : '';
  const id = typeof gameTitleOrAppId === 'number' ? gameTitleOrAppId : appId;

  // 1. Check title curated database
  if (title) {
    const norm = normalizeTitleForHltb(title);
    if (HLTB_TITLE_DATABASE[norm]) {
      return HLTB_TITLE_DATABASE[norm];
    }
    const cached = getCachedHltb(norm);
    if (cached) return cached;
  }

  // 2. Check appId curated database
  if (id && HLTB_DATABASE[id]) {
    return { ...HLTB_DATABASE[id], isAccurate: true };
  }

  if (id) {
    const cached = getCachedHltb(`app_${id}`);
    if (cached) return cached;
  }

  // 3. Fallback to genre/tag heuristic
  return estimateHltbFromGenres(genres, tags);
}

/**
 * Asynchronously fetches and caches verified live completion times from HowLongToBeat.
 */
export async function fetchAndCacheHltb(
  gameTitle: string,
  appId?: number
): Promise<HltbData | null> {
  if (!gameTitle) return null;
  const norm = normalizeTitleForHltb(gameTitle);

  if (HLTB_TITLE_DATABASE[norm]) {
    return HLTB_TITLE_DATABASE[norm];
  }

  const cached = getCachedHltb(norm);
  if (cached && cached.isAccurate) {
    return cached;
  }

  try {
    let rawResults: any[] = [];

    // Option 1: Native Electron IPC
    if (typeof window !== 'undefined' && window.electronAPI?.searchHltb) {
      const res = await window.electronAPI.searchHltb(gameTitle);
      if (res && res.success && Array.isArray(res.data)) {
        rawResults = res.data;
      }
    }

    // Option 2: Browser proxy or direct fetch
    if (rawResults.length === 0 && typeof window !== 'undefined') {
      try {
        const isLocalhost = window.location.hostname === 'localhost';
        const initUrl = isLocalhost
          ? `/api/hltb/api/search/site/init?t=${Date.now()}`
          : `https://howlongtobeat.com/api/search/site/init?t=${Date.now()}`;
        const searchUrl = isLocalhost
          ? '/api/hltb/api/search/site'
          : 'https://howlongtobeat.com/api/search/site';

        const initRes = await requestScheduler.schedule(
          initUrl,
          () => fetch(initUrl),
          Priority.P2_BACKGROUND,
          'howlongtobeat.com'
        );
        if (initRes.ok) {
          const { token } = await initRes.json();
          if (token) {
            const cleanTerms = gameTitle
              .replace(/[+:]/g, ' ')
              .trim()
              .split(/\s+/)
              .filter(Boolean);

            const sRes = await requestScheduler.schedule(
              searchUrl,
              () =>
                fetch(searchUrl, {
                  method: 'POST',
                  headers: {
                    'Content-Type': 'application/json',
                    'x-auth-token': token,
                  },
                  body: JSON.stringify({
                    searchType: 'games',
                    searchTerms: cleanTerms,
                    searchPage: 1,
                    size: 10,
                    searchOptions: {
                      games: {
                        userId: 0,
                        platform: '',
                        sortCategory: 'popular',
                        rangeCategory: 'main',
                        rangeTime: { min: 0, max: 0 },
                        gameplay: { perspective: '', flow: '', genre: '' },
                        year: '',
                        modifier: '',
                      },
                      users: { sortCategory: 'postcount' },
                      lists: { sortCategory: 'follows' },
                      filter: '',
                      sort: 0,
                      randomizer: 0,
                    },
                    useCache: true,
                  }),
                }),
              Priority.P2_BACKGROUND,
              'howlongtobeat.com'
            );

            if (sRes.ok) {
              const sData = await sRes.json();
              if (Array.isArray(sData.data)) {
                rawResults = sData.data;
              }
            }
          }
        }
      } catch {
        // Fallback to offline heuristic
      }
    }

    if (rawResults.length === 0) return null;

    const match = findBestHltbMatch(gameTitle, rawResults);
    if (!match) return null;

    const roundHalf = (sec: number) =>
      sec && sec > 0 ? Math.round((sec / 3600) * 2) / 2 : 0;

    const mainHours = roundHalf(match.comp_main) || roundHalf(match.comp_all) || 0;
    const extraHours = roundHalf(match.comp_plus) || (mainHours ? Math.round(mainHours * 1.4 * 2) / 2 : 0);
    const compHours = roundHalf(match.comp_100) || (extraHours ? Math.round(extraHours * 1.5 * 2) / 2 : 0);
    const allHours = roundHalf(match.comp_all) || mainHours;

    const hltbData: HltbData = {
      mainStoryHours: mainHours,
      mainExtraHours: extraHours,
      completionistHours: compHours,
      allStylesHours: allHours,
      gameplayType: match.game_type === 'game' ? 'Full Game' : match.game_type || 'Game',
      hltbGameId: match.game_id,
      isAccurate: true,
    };

    setCachedHltb(norm, hltbData);
    if (appId) {
      setCachedHltb(`app_${appId}`, hltbData);
    }

    return hltbData;
  } catch (err: any) {
    console.warn('[HLTB] Failed to fetch live HowLongToBeat data:', err?.message);
    return null;
  }
}
