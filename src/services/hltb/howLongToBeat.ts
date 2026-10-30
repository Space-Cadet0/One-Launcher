import { isSequelMismatch, normalizeTitleKey, stripEditionSuffix } from '../common/titleUtils';
import { requestScheduler, Priority } from '../network/requestScheduler';
import { onlineLifecycleManager } from '../network/onlineLifecycleManager';
import { vaultGet, vaultSet } from '../storage/indexedDbVault';

export interface HltbData {
  mainStoryHours: number;
  mainExtraHours: number;
  completionistHours: number;
  allStylesHours: number;
  gameplayType?: string;
  hltbGameId?: number;
  isAccurate?: boolean;
}

export interface HltbSearchResultItem {
  game_id?: number;
  game_name?: string;
  game_type?: string;
  comp_main?: number;
  comp_plus?: number;
  comp_100?: number;
  comp_all?: number;
}

export const HLTB_TITLE_DATABASE: Record<string, HltbData> = {};

export const HLTB_DATABASE: Record<number, HltbData> = {};

const LEGACY_STORAGE_PREFIX = 'hltb_cache_v2_';
const CONSOLIDATED_STORAGE_KEY = 'one_launcher_hltb_lru_v3';
const MAX_HLTB_CACHE_ENTRIES = 1500;
const NEGATIVE_HLTB_TTL_MS = 14 * 24 * 60 * 60 * 1000;

interface CachedHltbRecord extends HltbData {
  cachedAt?: number;
  unmatched?: boolean;
}

const memoryCache = new Map<string, CachedHltbRecord>();
let cacheHydrated = false;
let vaultHydrationStarted = false;
let persistDebounceTimer: ReturnType<typeof setTimeout> | null = null;

function isUnexpiredNegativeHltbEntry(raw: unknown): raw is CachedHltbRecord {
  if (!raw || typeof raw !== 'object') return false;
  const candidate = raw as Partial<CachedHltbRecord>;
  return (
    candidate.unmatched === true &&
    typeof candidate.cachedAt === 'number' &&
    candidate.cachedAt > 0 &&
    Date.now() - candidate.cachedAt < NEGATIVE_HLTB_TTL_MS
  );
}

function setLruEntry(key: string, value: CachedHltbRecord): void {
  if (!key || !value) return;
  const isPositive = value.isAccurate !== false && !value.unmatched;
  const isValidNegative = isUnexpiredNegativeHltbEntry(value);
  if (!isPositive && !isValidNegative) return;
  if (memoryCache.has(key)) {
    memoryCache.delete(key);
  }
  memoryCache.set(key, value);
  while (memoryCache.size > MAX_HLTB_CACHE_ENTRIES) {
    const oldest = memoryCache.keys().next().value;
    if (oldest === undefined) break;
    memoryCache.delete(oldest);
  }
}

function flushConsolidatedHltbCache(): void {
  if (typeof window === 'undefined') return;
  const payload: Record<string, CachedHltbRecord> = {};
  for (const [k, v] of memoryCache.entries()) {
    if (!v) continue;
    if (v.isAccurate !== false && !v.unmatched) {
      payload[k] = v;
    } else if (isUnexpiredNegativeHltbEntry(v)) {
      payload[k] = v;
    }
  }
  void vaultSet('hltb_lru_v3', payload);
  try {
    const serialized = JSON.stringify(payload);
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(CONSOLIDATED_STORAGE_KEY, serialized);
    }
  } catch {
    // QuotaExceededError: memoryCache + vault retain entries
  }
}

function schedulePersistConsolidatedHltbCache(): void {
  if (typeof window === 'undefined') return;
  if (persistDebounceTimer) {
    clearTimeout(persistDebounceTimer);
  }
  persistDebounceTimer = setTimeout(() => {
    persistDebounceTimer = null;
    flushConsolidatedHltbCache();
  }, 150);
  if (
    persistDebounceTimer &&
    typeof (persistDebounceTimer as unknown as { unref?: () => void }).unref === 'function'
  ) {
    (persistDebounceTimer as unknown as { unref: () => void }).unref();
  }
}

function isValidHltbEntry(raw: unknown): raw is CachedHltbRecord {
  if (!raw || typeof raw !== 'object') return false;
  const candidate = raw as Partial<CachedHltbRecord>;
  if (candidate.isAccurate === false || candidate.unmatched === true) return false;
  return (
    typeof candidate.mainStoryHours === 'number' &&
    typeof candidate.mainExtraHours === 'number' &&
    typeof candidate.completionistHours === 'number' &&
    typeof candidate.allStylesHours === 'number'
  );
}

async function hydrateHltbCacheFromVault(): Promise<void> {
  if (typeof window === 'undefined') return;
  try {
    const vaultPayload = await vaultGet<Record<string, unknown>>('hltb_lru_v3');
    if (!vaultPayload || typeof vaultPayload !== 'object' || Array.isArray(vaultPayload)) {
      return;
    }
    for (const [k, v] of Object.entries(vaultPayload)) {
      if (!k || !v || typeof v !== 'object') continue;
      const existing = memoryCache.get(k);
      const existingTs = existing?.cachedAt ?? 0;
      const incomingTs =
        typeof (v as Partial<CachedHltbRecord>).cachedAt === 'number'
          ? ((v as Partial<CachedHltbRecord>).cachedAt as number)
          : 0;
      if (existing && existing.isAccurate !== false && !existing.unmatched) {
        if (incomingTs <= existingTs) continue;
      }
      if (isValidHltbEntry(v)) {
        setLruEntry(k, { ...v, isAccurate: true });
      } else if (isUnexpiredNegativeHltbEntry(v)) {
        if (!existing || (existing.unmatched && incomingTs > existingTs)) {
          setLruEntry(k, v);
        }
      }
    }
  } catch {
    // Ignore vault hydration errors
  }
}

function ensureHltbCacheHydrated(): void {
  if (typeof window !== 'undefined' && !vaultHydrationStarted) {
    vaultHydrationStarted = true;
    void hydrateHltbCacheFromVault();
  }
  if (cacheHydrated || typeof window === 'undefined' || typeof localStorage === 'undefined') {
    return;
  }
  cacheHydrated = true;

  try {
    const rawMap = localStorage.getItem(CONSOLIDATED_STORAGE_KEY);
    if (rawMap) {
      const parsed = JSON.parse(rawMap) as Record<string, unknown>;
      if (parsed && typeof parsed === 'object') {
        for (const [k, v] of Object.entries(parsed)) {
          if (isValidHltbEntry(v)) {
            setLruEntry(k, { ...v, isAccurate: true });
          } else if (isUnexpiredNegativeHltbEntry(v)) {
            setLruEntry(k, v);
          }
        }
      }
    }

    // One-time sweep of legacy per-game `hltb_cache_v2_*` localStorage keys into the bounded LRU map
    const legacyKeysToRemove: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const storageKey = localStorage.key(i);
      if (storageKey && storageKey.startsWith(LEGACY_STORAGE_PREFIX)) {
        legacyKeysToRemove.push(storageKey);
        const subKey = storageKey.slice(LEGACY_STORAGE_PREFIX.length);
        try {
          const itemRaw = localStorage.getItem(storageKey);
          if (itemRaw && subKey) {
            const parsedItem: unknown = JSON.parse(itemRaw);
            if (isValidHltbEntry(parsedItem)) {
              setLruEntry(subKey, { ...parsedItem, isAccurate: true });
            }
          }
        } catch {
          // Ignore malformed legacy entry
        }
      }
    }

    if (legacyKeysToRemove.length > 0) {
      for (const legacyKey of legacyKeysToRemove) {
        try {
          localStorage.removeItem(legacyKey);
        } catch {}
      }
      flushConsolidatedHltbCache();
    }
  } catch {
    // Ignore storage access errors
  }
}

export function normalizeTitleForHltb(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function getCachedHltb(key: string): CachedHltbRecord | null {
  ensureHltbCacheHydrated();
  if (memoryCache.has(key)) {
    const hit = memoryCache.get(key)!;
    if (hit.unmatched && !isUnexpiredNegativeHltbEntry(hit)) {
      memoryCache.delete(key);
      return null;
    }
    // Promote LRU order
    memoryCache.delete(key);
    memoryCache.set(key, hit);
    return hit;
  }
  return null;
}

function setCachedHltb(key: string, data: CachedHltbRecord): void {
  ensureHltbCacheHydrated();
  setLruEntry(key, data);
  schedulePersistConsolidatedHltbCache();
}

export function findBestHltbMatch(
  gameTitle: string,
  results: HltbSearchResultItem[]
): HltbSearchResultItem | null {
  if (!results || results.length === 0 || !gameTitle) return null;

  const compatibleResults = results.filter(
    (r): r is HltbSearchResultItem & { game_name: string } =>
      Boolean(r?.game_name && typeof r.game_name === 'string' && !isSequelMismatch(gameTitle, r.game_name))
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

  let bestCandidate: HltbSearchResultItem | null = null;
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
 * Gets verified HowLongToBeat completion times synchronously from curated data or persistent LRU cache.
 * Returns `null` when no verified match exists (never fabricates genre/tag playtime estimates).
 */
export function getHowLongToBeat(
  gameTitleOrAppId?: string | number,
  appId?: number,
  _genres: string[] = [],
  _tags: string[] = []
): HltbData | null {
  const title = typeof gameTitleOrAppId === 'string' ? gameTitleOrAppId : '';
  const id = typeof gameTitleOrAppId === 'number' ? gameTitleOrAppId : appId;

  // 1. Check title curated database & verified cache
  if (title) {
    const norm = normalizeTitleForHltb(title);
    if (HLTB_TITLE_DATABASE[norm]) {
      return { ...HLTB_TITLE_DATABASE[norm], isAccurate: true };
    }
    const cached = getCachedHltb(norm);
    if (cached && cached.isAccurate !== false && !cached.unmatched) return cached;
  }

  // 2. Check appId curated database & verified cache
  if (id && HLTB_DATABASE[id]) {
    return { ...HLTB_DATABASE[id], isAccurate: true };
  }

  if (id) {
    const cached = getCachedHltb(`app_${id}`);
    if (cached && cached.isAccurate !== false && !cached.unmatched) return cached;
  }

  return null;
}

/**
 * Checks whether a HowLongToBeat lookup has already resolved positively or negatively within TTL.
 */
export function hasAttemptedHltbLookup(gameTitle?: string, appId?: number): boolean {
  if (!gameTitle && !appId) return true;
  if (gameTitle) {
    const norm = normalizeTitleForHltb(gameTitle);
    if (!norm) return true;
    if (HLTB_TITLE_DATABASE[norm]) return true;
    const cached = getCachedHltb(norm);
    if (cached) {
      if (cached.isAccurate !== false && !cached.unmatched) return true;
      if (isUnexpiredNegativeHltbEntry(cached)) return true;
    }
  }
  if (appId) {
    if (HLTB_DATABASE[appId]) return true;
    const cachedApp = getCachedHltb(`app_${appId}`);
    if (cachedApp) {
      if (cachedApp.isAccurate !== false && !cachedApp.unmatched) return true;
      if (isUnexpiredNegativeHltbEntry(cachedApp)) return true;
    }
  }
  return false;
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
  if (cached) {
    if (cached.isAccurate && !cached.unmatched) {
      return cached;
    }
    if (isUnexpiredNegativeHltbEntry(cached)) {
      return null;
    }
  }

  const recordNegativeIfCleanOnline = (completedCleanlyOnline: boolean): null => {
    if (completedCleanlyOnline && onlineLifecycleManager.isOnline()) {
      const negRecord: CachedHltbRecord = {
        mainStoryHours: 0,
        mainExtraHours: 0,
        completionistHours: 0,
        allStylesHours: 0,
        isAccurate: false,
        unmatched: true,
        cachedAt: Date.now(),
      };
      setCachedHltb(norm, negRecord);
      if (appId) {
        setCachedHltb(`app_${appId}`, negRecord);
      }
    }
    return null;
  };

  try {
    let rawResults: HltbSearchResultItem[] = [];
    let completedCleanlyOnline = false;

    // Option 1: Native Electron IPC
    if (typeof window !== 'undefined' && window.electronAPI?.searchHltb) {
      const res = await window.electronAPI.searchHltb(gameTitle);
      if (res && res.success && Array.isArray(res.data)) {
        rawResults = res.data as HltbSearchResultItem[];
        completedCleanlyOnline = true;
      }
    }

    // Option 2: Browser proxy or direct fetch
    if (rawResults.length === 0 && !completedCleanlyOnline && typeof window !== 'undefined') {
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
          const initJson = (await initRes.json()) as { token?: string };
          const token = initJson.token;
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
              const sData = (await sRes.json()) as { data?: HltbSearchResultItem[] };
              if (Array.isArray(sData.data)) {
                rawResults = sData.data;
                completedCleanlyOnline = true;
              }
            }
          }
        }
      } catch {
        // Network unavailable; return null without fabricating estimates
      }
    }

    if (rawResults.length === 0) {
      return recordNegativeIfCleanOnline(completedCleanlyOnline);
    }

    const match = findBestHltbMatch(gameTitle, rawResults);
    if (!match) {
      return recordNegativeIfCleanOnline(completedCleanlyOnline);
    }

    const roundHalf = (sec?: number): number =>
      sec && sec > 0 ? Math.round((sec / 3600) * 2) / 2 : 0;

    const mainHours = roundHalf(match.comp_main) || roundHalf(match.comp_all) || 0;
    const extraHours = roundHalf(match.comp_plus);
    const compHours = roundHalf(match.comp_100);
    const allHours = roundHalf(match.comp_all) || mainHours;

    if (mainHours === 0 && extraHours === 0 && compHours === 0 && allHours === 0) {
      return recordNegativeIfCleanOnline(completedCleanlyOnline);
    }

    const nowTs = Date.now();
    const hltbData: CachedHltbRecord = {
      mainStoryHours: mainHours,
      mainExtraHours: extraHours,
      completionistHours: compHours,
      allStylesHours: allHours,
      gameplayType: match.game_type === 'game' ? 'Full Game' : match.game_type || 'Game',
      hltbGameId: match.game_id,
      isAccurate: true,
      cachedAt: nowTs,
    };

    setCachedHltb(norm, hltbData);
    if (appId) {
      setCachedHltb(`app_${appId}`, hltbData);
    }

    return hltbData;
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn('[HLTB] Failed to fetch live HowLongToBeat data:', message);
    return null;
  }
}

if (typeof window !== 'undefined') {
  vaultHydrationStarted = true;
  void hydrateHltbCacheFromVault();
}
