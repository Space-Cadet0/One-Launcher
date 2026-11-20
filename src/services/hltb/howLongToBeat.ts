import {
  alignCompoundWordTokens,
  buildHltbSearchTermPasses,
  isEditionToken,
  isSequelMismatch,
  normalizeTitleKey,
  stripEditionSuffix,
  stripStorefrontPlatformDisambiguators,
} from '../common/titleUtils';
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

/** @deprecated Retained empty for export compatibility; hot paths use the persistent LRU cache. */
export const HLTB_TITLE_DATABASE: Record<string, HltbData> = {};

/** @deprecated Retained empty for export compatibility; hot paths use the persistent LRU cache. */
export const HLTB_DATABASE: Record<number, HltbData> = {};

export const HLTB_QUERY_NORM_VERSION = 2;

const LEGACY_STORAGE_PREFIX = 'hltb_cache_v2_';
const CONSOLIDATED_STORAGE_KEY = 'one_launcher_hltb_lru_v3';
const MAX_HLTB_CACHE_ENTRIES = 5000;
const NEGATIVE_HLTB_TTL_MS = 14 * 24 * 60 * 60 * 1000;
const HLTB_PERSIST_DEBOUNCE_MS = 2000;

interface CachedHltbRecord extends HltbData {
  cachedAt?: number;
  unmatched?: boolean;
  queryNormVersion?: number;
}

const memoryCache = new Map<string, CachedHltbRecord>();
const inFlightHltbRequests = new Map<string, Promise<HltbData | null>>();
let cacheHydrated = false;
let vaultHydrationStarted = false;
let persistDebounceTimer: ReturnType<typeof setTimeout> | null = null;
let hltbCacheDirty = false;
let hltbFlushListenersAttached = false;

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
  if (persistDebounceTimer) {
    clearTimeout(persistDebounceTimer);
    persistDebounceTimer = null;
  }
  hltbCacheDirty = false;
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

const HLTB_FLUSH_CLEANUP_SYMBOL = Symbol.for('one_launcher_hltb_flush_cleanup');

function ensureHltbFlushLifecycleListeners(): void {
  if (hltbFlushListenersAttached) return;
  if (typeof window === 'undefined' || typeof window.addEventListener !== 'function') return;
  hltbFlushListenersAttached = true;
  const host = globalThis as Record<symbol, (() => void) | undefined>;
  const prevCleanup = host[HLTB_FLUSH_CLEANUP_SYMBOL];
  if (typeof prevCleanup === 'function') {
    try {
      prevCleanup();
    } catch {}
  }
  const flushIfDirty = () => {
    if (hltbCacheDirty) {
      flushConsolidatedHltbCache();
    }
  };
  window.addEventListener('pagehide', flushIfDirty);
  window.addEventListener('beforeunload', flushIfDirty);
  host[HLTB_FLUSH_CLEANUP_SYMBOL] = () => {
    window.removeEventListener('pagehide', flushIfDirty);
    window.removeEventListener('beforeunload', flushIfDirty);
  };
}

function schedulePersistConsolidatedHltbCache(): void {
  if (typeof window === 'undefined') return;
  ensureHltbFlushLifecycleListeners();
  hltbCacheDirty = true;
  if (persistDebounceTimer) {
    clearTimeout(persistDebounceTimer);
  }
  persistDebounceTimer = setTimeout(() => {
    persistDebounceTimer = null;
    flushConsolidatedHltbCache();
  }, HLTB_PERSIST_DEBOUNCE_MS);
  if (
    persistDebounceTimer &&
    typeof persistDebounceTimer === 'object' &&
    'unref' in persistDebounceTimer &&
    typeof persistDebounceTimer.unref === 'function'
  ) {
    persistDebounceTimer.unref();
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

function legacyNormalizeTitleForHltbV1(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function normalizeTitleForHltb(title: string): string {
  return normalizeTitleKey(title);
}

/**
 * Determines whether a raw storefront title contained symbols, typography, parentheticals,
 * platform tags, or edition suffixes that caused the legacy v1 HLTB tokenizer
 * (`gameTitle.replace(/[+:]/g, ' ').trim().split(/\s+/)`) to poison negative cache entries.
 */
export function wasCorruptedByLegacyV1HltbTokenizer(rawTitle?: string): boolean {
  if (!rawTitle || typeof rawTitle !== 'string') return false;
  const trimmed = rawTitle.replace(/\s+/g, ' ').trim();
  if (!trimmed) return false;
  if (
    /[™®©℠℗_()\x5b\x5d]/.test(trimmed) ||
    /&[a-z0-9#]+;/i.test(trimmed) ||
    /\(\s*(?:tm|r|c)\s*\)/i.test(trimmed) ||
    /[\u2018\u2019\u02BC`´]/.test(trimmed) ||
    /[\u2010-\u2015\u2212]/.test(trimmed) ||
    /(?:^|\s)-(?:\s|$)/.test(trimmed) ||
    /[^\x00-\x7f]/.test(trimmed)
  ) {
    return true;
  }
  if (stripStorefrontPlatformDisambiguators(trimmed) !== trimmed) {
    return true;
  }
  if (stripEditionSuffix(trimmed) !== normalizeTitleKey(trimmed)) {
    return true;
  }
  return false;
}

function isLegacyCorruptedNegativeEntry(entry: CachedHltbRecord, rawTitle?: string): boolean {
  return Boolean(
    entry.unmatched &&
      (entry.queryNormVersion ?? 1) < HLTB_QUERY_NORM_VERSION &&
      wasCorruptedByLegacyV1HltbTokenizer(rawTitle)
  );
}

function purgeCorruptedNegativeCacheEntries(rawTitle?: string, appId?: number): void {
  let deleted = false;
  if (rawTitle) {
    const norm = normalizeTitleForHltb(rawTitle);
    if (norm && memoryCache.get(norm)?.unmatched) {
      memoryCache.delete(norm);
      deleted = true;
    }
    const legacyNorm = legacyNormalizeTitleForHltbV1(rawTitle);
    if (legacyNorm && legacyNorm !== norm && memoryCache.get(legacyNorm)?.unmatched) {
      memoryCache.delete(legacyNorm);
      deleted = true;
    }
  }
  if (appId) {
    const appKey = `app_${appId}`;
    if (memoryCache.get(appKey)?.unmatched) {
      memoryCache.delete(appKey);
      deleted = true;
    }
  }
  if (deleted) {
    schedulePersistConsolidatedHltbCache();
  }
}

function getCachedHltb(key: string, legacyFallbackKey?: string): CachedHltbRecord | null {
  ensureHltbCacheHydrated();
  const lookupSingle = (targetKey: string): CachedHltbRecord | null => {
    if (!targetKey || !memoryCache.has(targetKey)) return null;
    const hit = memoryCache.get(targetKey)!;
    if (hit.unmatched && !isUnexpiredNegativeHltbEntry(hit)) {
      memoryCache.delete(targetKey);
      return null;
    }
    // Promote LRU order
    memoryCache.delete(targetKey);
    memoryCache.set(targetKey, hit);
    return hit;
  };

  const primaryHit = lookupSingle(key);
  if (primaryHit) return primaryHit;
  if (legacyFallbackKey && legacyFallbackKey !== key) {
    return lookupSingle(legacyFallbackKey);
  }
  return null;
}

function setCachedHltb(key: string, data: CachedHltbRecord): void {
  ensureHltbCacheHydrated();
  setLruEntry(key, data);
  schedulePersistConsolidatedHltbCache();
}

/**
 * Non-destructively seeds verified HLTB data from the SQLite `offlineVault` (`hltb_json`)
 * into the in-memory + consolidated LRU cache so cold boots, offline launches, hover popouts,
 * and detail views resolve synchronously in 0ms without redundant network IPC round-trips.
 */
export function seedHltbFromVaultIfMissing(
  gameTitle: string,
  appId: number | undefined,
  rawHltb: unknown
): HltbData | null {
  if (!rawHltb || typeof rawHltb !== 'object') return null;
  if (!isValidHltbEntry(rawHltb)) return null;
  const hasPositiveHours =
    rawHltb.mainStoryHours > 0 ||
    rawHltb.mainExtraHours > 0 ||
    rawHltb.completionistHours > 0 ||
    rawHltb.allStylesHours > 0;
  if (!hasPositiveHours) return null;

  ensureHltbCacheHydrated();

  const seeded: CachedHltbRecord = {
    mainStoryHours: rawHltb.mainStoryHours,
    mainExtraHours: rawHltb.mainExtraHours,
    completionistHours: rawHltb.completionistHours,
    allStylesHours: rawHltb.allStylesHours,
    gameplayType: typeof rawHltb.gameplayType === 'string' ? rawHltb.gameplayType : undefined,
    hltbGameId: typeof rawHltb.hltbGameId === 'number' ? rawHltb.hltbGameId : undefined,
    isAccurate: true,
    cachedAt:
      typeof rawHltb.cachedAt === 'number' && rawHltb.cachedAt > 0 ? rawHltb.cachedAt : Date.now(),
  };

  let wroteAny = false;
  if (gameTitle) {
    const norm = normalizeTitleForHltb(gameTitle);
    const legacyNorm = legacyNormalizeTitleForHltbV1(gameTitle);
    const effectiveKey = norm || legacyNorm;
    if (effectiveKey) {
      const existing = memoryCache.get(effectiveKey);
      if (!existing || existing.unmatched || existing.isAccurate === false) {
        setLruEntry(effectiveKey, seeded);
        wroteAny = true;
      }
    }
  }
  if (appId) {
    const appKey = `app_${appId}`;
    const existingApp = memoryCache.get(appKey);
    if (!existingApp || existingApp.unmatched || existingApp.isAccurate === false) {
      setLruEntry(appKey, seeded);
      wroteAny = true;
    }
  }
  if (wroteAny) {
    schedulePersistConsolidatedHltbCache();
  }
  return seeded;
}

const HLTB_SUBTITLE_STOP_WORDS = new Set([
  'the',
  'a',
  'an',
  'of',
  'in',
  'on',
  'at',
  'to',
  'for',
  'and',
  'or',
  'is',
]);

function extractSubstantiveSubtitleTokens(rawTitle: string): string[] {
  const colonIdx = rawTitle.indexOf(':');
  if (colonIdx === -1) return [];
  const rawSub = rawTitle.slice(colonIdx + 1).trim();
  if (!rawSub) return [];
  const normSubTokens = normalizeTitleKey(rawSub).split(' ').filter(Boolean);
  if (
    normSubTokens.length === 0 ||
    normSubTokens.every((t) => isEditionToken(t) || HLTB_SUBTITLE_STOP_WORDS.has(t))
  ) {
    return [];
  }
  const strippedSub = stripEditionSuffix(rawSub);
  return (strippedSub || normalizeTitleKey(rawSub))
    .split(' ')
    .filter((t) => Boolean(t) && !isEditionToken(t) && !HLTB_SUBTITLE_STOP_WORDS.has(t));
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

  const compactNorm = (s: string): string => normalizeTitleKey(s).replace(/\s+/g, '');

  const targetNorm = compactNorm(gameTitle);
  if (!targetNorm) return null;

  // 1a. Exact full normalized match (prefers exact edition when present, e.g. "Horizon Zero Dawn - Complete Edition")
  const exactFull = compatibleResults.find((r) => compactNorm(r.game_name) === targetNorm);
  if (exactFull) return exactFull;

  // 1b. Exact base-title match after stripping storefront edition suffix (e.g. "Call of Duty®: Vanguard - Standard Edition" -> "Call of Duty: Vanguard")
  const strippedTargetNorm = stripEditionSuffix(gameTitle).replace(/\s+/g, '');
  if (strippedTargetNorm.length >= 2 && strippedTargetNorm !== targetNorm) {
    const exactBase = compatibleResults.find((r) => compactNorm(r.game_name) === strippedTargetNorm);
    if (exactBase) return exactBase;
  }

  // 2. Token overlap similarity and base-title prefix check
  const targetTokens = normalizeTitleKey(gameTitle).split(' ').filter(Boolean);
  const strippedTargetTokens = stripEditionSuffix(gameTitle).split(' ').filter(Boolean);
  const targetBaseTokens = normalizeTitleKey(gameTitle.split(':')[0]).split(' ').filter(Boolean);
  const targetSubTokens = extractSubstantiveSubtitleTokens(gameTitle);
  const targetSubSet = new Set(targetSubTokens);

  const calcOverlap = (rawA: string[], rawB: string[]): number => {
    if (rawA.length === 0 || rawB.length === 0) return 0;
    const [a, b] = alignCompoundWordTokens(rawA, rawB);
    const setB = new Set(b);
    const shared = a.filter((t) => setB.has(t)).length;
    return shared / Math.max(a.length, b.length);
  };

  let bestCandidate: HltbSearchResultItem | null = null;
  let bestSimilarity = 0;
  let bestHasPrefixMatch = false;

  for (const r of compatibleResults) {
    const candTokens = normalizeTitleKey(r.game_name).split(' ').filter(Boolean);
    const strippedCandTokens = stripEditionSuffix(r.game_name).split(' ').filter(Boolean);
    const candBaseTokens = normalizeTitleKey(r.game_name.split(':')[0]).split(' ').filter(Boolean);
    const candSubTokens = extractSubstantiveSubtitleTokens(r.game_name);

    const bothHaveSubtitles = targetSubTokens.length > 0 && candSubTokens.length > 0;
    if (bothHaveSubtitles) {
      const subOverlap = calcOverlap(targetSubTokens, candSubTokens);
      const candSubSet = new Set(candSubTokens);
      const targetHasDisjointSub = targetSubTokens.some((t) => !candSubSet.has(t));
      const candHasDisjointSub = candSubTokens.some((t) => !targetSubSet.has(t));
      const hasConflictingSubtitles =
        subOverlap < 0.5 || (targetHasDisjointSub && candHasDisjointSub && subOverlap < 0.6);
      if (hasConflictingSubtitles) {
        continue;
      }
    }

    const rawSim = calcOverlap(targetTokens, candTokens);
    const strippedSim = calcOverlap(
      strippedTargetTokens.length > 0 ? strippedTargetTokens : targetTokens,
      strippedCandTokens.length > 0 ? strippedCandTokens : candTokens
    );
    const similarity = Math.max(rawSim, strippedSim);

    const hasColon = gameTitle.includes(':') || r.game_name.includes(':');
    const isBasePrefixMatch =
      hasColon &&
      (!bothHaveSubtitles || calcOverlap(targetSubTokens, candSubTokens) >= 0.6) &&
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
 * Gets verified HowLongToBeat completion times synchronously from the persistent LRU cache.
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

  // 1. Check verified title cache (including legacy v1 positive key fallback)
  if (title) {
    const norm = normalizeTitleForHltb(title);
    const legacyNorm = legacyNormalizeTitleForHltbV1(title);
    if (norm || legacyNorm) {
      const cached = getCachedHltb(norm || legacyNorm, legacyNorm);
      if (cached && cached.isAccurate !== false && !cached.unmatched) return cached;
    }
  }

  // 2. Check verified appId cache
  if (id) {
    const cached = getCachedHltb(`app_${id}`);
    if (cached && cached.isAccurate !== false && !cached.unmatched) return cached;
  }

  return null;
}

/**
 * Checks whether a HowLongToBeat lookup has already resolved positively or negatively within TTL.
 * Automatically self-heals legacy v1 negative cache entries poisoned by symbols, dashes, or editions.
 */
export function hasAttemptedHltbLookup(gameTitle?: string, appId?: number): boolean {
  if (!gameTitle && !appId) return true;
  if (gameTitle) {
    const norm = normalizeTitleForHltb(gameTitle);
    const legacyNorm = legacyNormalizeTitleForHltbV1(gameTitle);
    if (!norm && !legacyNorm) return true;
    const cached = getCachedHltb(norm || legacyNorm, legacyNorm);
    if (cached) {
      if (cached.isAccurate !== false && !cached.unmatched) return true;
      if (isUnexpiredNegativeHltbEntry(cached)) {
        if (isLegacyCorruptedNegativeEntry(cached, gameTitle)) {
          purgeCorruptedNegativeCacheEntries(gameTitle, appId);
        } else {
          return true;
        }
      }
    }
  }
  if (appId) {
    const cachedApp = getCachedHltb(`app_${appId}`);
    if (cachedApp) {
      if (cachedApp.isAccurate !== false && !cachedApp.unmatched) return true;
      if (isUnexpiredNegativeHltbEntry(cachedApp)) {
        if (isLegacyCorruptedNegativeEntry(cachedApp, gameTitle)) {
          purgeCorruptedNegativeCacheEntries(gameTitle, appId);
        } else {
          return true;
        }
      }
    }
  }
  return false;
}

/**
 * Asynchronously fetches and caches verified live completion times from HowLongToBeat,
 * deduplicating concurrent requests for the same game title / Steam AppID.
 */
export async function fetchAndCacheHltb(
  gameTitle: string,
  appId?: number
): Promise<HltbData | null> {
  if (!gameTitle) return null;
  const norm = normalizeTitleForHltb(gameTitle);
  const legacyNorm = legacyNormalizeTitleForHltbV1(gameTitle);
  const effectiveKey = norm || legacyNorm;
  if (!effectiveKey) return null;

  const appKey = appId ? `app_${appId}` : '';

  const cached = getCachedHltb(effectiveKey, legacyNorm);
  if (cached) {
    if (cached.isAccurate !== false && !cached.unmatched) {
      return cached;
    }
    if (isUnexpiredNegativeHltbEntry(cached)) {
      if (isLegacyCorruptedNegativeEntry(cached, gameTitle)) {
        purgeCorruptedNegativeCacheEntries(gameTitle, appId);
      } else {
        return null;
      }
    }
  }

  if (appKey) {
    const cachedApp = getCachedHltb(appKey);
    if (cachedApp) {
      if (cachedApp.isAccurate !== false && !cachedApp.unmatched) {
        return cachedApp;
      }
      if (isUnexpiredNegativeHltbEntry(cachedApp)) {
        if (isLegacyCorruptedNegativeEntry(cachedApp, gameTitle)) {
          purgeCorruptedNegativeCacheEntries(gameTitle, appId);
        } else {
          return null;
        }
      }
    }
  }

  const existingInFlight =
    inFlightHltbRequests.get(effectiveKey) || (appKey ? inFlightHltbRequests.get(appKey) : undefined);
  if (existingInFlight) {
    return existingInFlight;
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
        queryNormVersion: HLTB_QUERY_NORM_VERSION,
      };
      setCachedHltb(effectiveKey, negRecord);
      if (appKey) {
        setCachedHltb(appKey, negRecord);
      }
    }
    return null;
  };

  const requestPromise = (async (): Promise<HltbData | null> => {
    try {
      let rawResults: HltbSearchResultItem[] = [];
      let match: HltbSearchResultItem | null = null;
      let completedCleanlyOnline = false;

      // Option 1: Native Electron IPC (multi-pass search runs inside hltb:search)
      if (typeof window !== 'undefined' && window.electronAPI?.searchHltb) {
        const res = await window.electronAPI.searchHltb(gameTitle);
        if (res && res.success && Array.isArray(res.data)) {
          rawResults = res.data as HltbSearchResultItem[];
          completedCleanlyOnline = true;
          if (rawResults.length > 0) {
            match = findBestHltbMatch(gameTitle, rawResults);
            if (!match) {
              const strippedQuery = stripEditionSuffix(gameTitle);
              const fullNorm = normalizeTitleKey(gameTitle);
              if (strippedQuery.length >= 2 && strippedQuery.length < fullNorm.length) {
                const fallbackRes = await window.electronAPI.searchHltb(strippedQuery);
                if (
                  fallbackRes &&
                  fallbackRes.success &&
                  Array.isArray(fallbackRes.data) &&
                  fallbackRes.data.length > 0
                ) {
                  rawResults = fallbackRes.data as HltbSearchResultItem[];
                  match = findBestHltbMatch(gameTitle, rawResults);
                }
              }
            }
          }
        }
      } else if (typeof window !== 'undefined') {
        // Option 2: Browser dev proxy or direct fetch when Electron IPC bridge is absent
        try {
          const termPasses = buildHltbSearchTermPasses(gameTitle);
          if (termPasses.length > 0) {
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
                for (const cleanTerms of termPasses) {
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

                  if (!sRes.ok) {
                    completedCleanlyOnline = false;
                    break;
                  }

                  completedCleanlyOnline = true;
                  const sData = (await sRes.json()) as { data?: HltbSearchResultItem[] };
                  if (Array.isArray(sData.data) && sData.data.length > 0) {
                    rawResults = sData.data;
                    match = findBestHltbMatch(gameTitle, rawResults);
                    if (match) break;
                  }
                }
              }
            }
          }
        } catch {
          // Network unavailable; return null without fabricating estimates
        }
      }

      if (rawResults.length === 0 || !match) {
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

      setCachedHltb(effectiveKey, hltbData);
      if (appKey) {
        setCachedHltb(appKey, hltbData);
      }

      return hltbData;
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn('[HLTB] Failed to fetch live HowLongToBeat data:', message);
      return null;
    }
  })();

  inFlightHltbRequests.set(effectiveKey, requestPromise);
  if (appKey) {
    inFlightHltbRequests.set(appKey, requestPromise);
  }

  return requestPromise.finally(() => {
    if (inFlightHltbRequests.get(effectiveKey) === requestPromise) {
      inFlightHltbRequests.delete(effectiveKey);
    }
    if (appKey && inFlightHltbRequests.get(appKey) === requestPromise) {
      inFlightHltbRequests.delete(appKey);
    }
  });
}

if (typeof window !== 'undefined') {
  vaultHydrationStarted = true;
  void hydrateHltbCacheFromVault();
}
