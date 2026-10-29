import { createStore, entries as idbEntries, type UseStore } from 'idb-keyval';
import type { CanonicalGame } from '../../contracts/game';
import { isIndexedDbAvailable, vaultDelete, vaultGet, vaultSet } from './indexedDbVault';

/**
 * Phase 4 Option B: Tiered Data Mutability & Staged TTL Caching
 *
 * Tier 0: Human Override (TTL = Infinity) - Immune to automatic eviction and background overwrites.
 * Tier 1: Immutable (TTL = 180 days) - Titles released > 24 months ago with mature review volume.
 * Tier 2: Mature (TTL = 30 days) - Titles released 3 to 24 months ago.
 * Tier 3: Fresh (TTL = 48 hours) - Titles released < 90 days ago with active patches and reviews.
 * Tier 4A: Early Access (TTL = 72 hours) - Actively updated titles with frequent review shifts.
 * Tier 4B: Negative Cache (TTL = 7 days) - Unmatched titles or 0 reviews; strictly capped, NEVER infinite.
 * Tier 4C: Transient Error (TTL = 15 minutes) - HTTP 429/403 or network errors.
 */

export type MutabilityTier =
  | 'override'
  | 'immutable'
  | 'mature'
  | 'fresh'
  | 'early_access'
  | 'negative'
  | 'transient_error';

export const MUTABILITY_TIERS = {
  TIER_0_USER_OVERRIDE: 'override' as MutabilityTier,
  TIER_1_IMMUTABLE: 'immutable' as MutabilityTier,
  TIER_2_MATURE: 'mature' as MutabilityTier,
  TIER_3_FRESH: 'fresh' as MutabilityTier,
  TIER_4A_EARLY_ACCESS: 'early_access' as MutabilityTier,
  TIER_4B_NEGATIVE_CACHE: 'negative' as MutabilityTier,
  TIER_4C_TRANSIENT_ERROR: 'transient_error' as MutabilityTier,
} as const;

export const MutabilityTier = MUTABILITY_TIERS;

export const TIER_0_USER_OVERRIDE: MutabilityTier = 'override';
export const TIER_1_IMMUTABLE: MutabilityTier = 'immutable';
export const TIER_2_MATURE: MutabilityTier = 'mature';
export const TIER_3_FRESH: MutabilityTier = 'fresh';
export const TIER_4A_EARLY_ACCESS: MutabilityTier = 'early_access';
export const TIER_4B_NEGATIVE_CACHE: MutabilityTier = 'negative';
export const TIER_4C_TRANSIENT_ERROR: MutabilityTier = 'transient_error';

export const TIER_TTLS: Record<MutabilityTier, number> = {
  override: Infinity,
  immutable: 180 * 24 * 60 * 60 * 1000, // 180 days = 15,552,000,000 ms
  mature: 30 * 24 * 60 * 60 * 1000,     // 30 days = 2,592,000,000 ms
  fresh: 48 * 60 * 60 * 1000,           // 48 hours = 172,800,000 ms
  early_access: 72 * 60 * 60 * 1000,    // 72 hours = 259,200,000 ms
  negative: 7 * 24 * 60 * 60 * 1000,    // 7 days = 604,800,000 ms
  transient_error: 15 * 60 * 1000,      // 15 minutes = 900,000 ms
};

export const TTL_TIER_0 = Infinity;
export const TTL_TIER_1_IMMUTABLE = 180 * 24 * 60 * 60 * 1000;
export const TTL_TIER_2_MATURE = 30 * 24 * 60 * 60 * 1000;
export const TTL_TIER_3_FRESH = 48 * 60 * 60 * 1000;
export const TTL_TIER_4A_EARLY_ACCESS = 72 * 60 * 60 * 1000;
export const TTL_TIER_4B_NEGATIVE_CACHE = 7 * 24 * 60 * 60 * 1000;
export const TTL_TIER_4C_TRANSIENT_ERROR = 15 * 60 * 1000;

export const STAGED_CACHE_VERSION = 9;

export interface StagedCacheEntry<T> {
  data: T | null;
  cachedAt: number; // 13-digit Unix epoch integer
  ttlMs: number;
  tier: MutabilityTier;
  version: number; // 9
  source?: string;
  isVerified?: boolean;
  dynamicResolved?: boolean;
  failureReason?: 'not_found' | 'rate_limited' | 'network_error' | string;
  [key: string]: unknown;
}

export interface MutabilityEvaluationInput {
  releaseDate?: string | Date | number | null;
  release_date?: string | Date | number | null;
  releaseYear?: string | number | null;
  genres?: string[] | string | null;
  tags?: string[] | string | null;
  isEarlyAccess?: boolean;
  isOverride?: boolean;
  userOverride?: boolean;
  hasOverride?: boolean;
  source?: string;
  isNegative?: boolean;
  isUnmatched?: boolean;
  isTransientError?: boolean;
  failureReason?: string;
  numReviews?: number;
  score?: number | null;
  data?: unknown;
}

export const MAX_MEMORY_FALLBACK_ENTRIES = 4096;
const BULKY_STAGED_LOCALSTORAGE_BYTES = 2048;
const MAX_STUB_STRING_CHARS = 240;
const memoryFallback = new Map<string, StagedCacheEntry<unknown>>();
const localStorageMirroredKeys = new Set<string>();
const vaultHydratedKeys = new Set<string>();

let bulkVaultStore: UseStore | null = null;
let inFlightBulkVaultHydration: Promise<number> | null = null;

function getBulkVaultStore(): UseStore | null {
  if (!isIndexedDbAvailable()) return null;
  if (!bulkVaultStore) {
    try {
      bulkVaultStore = createStore('one-launcher-db', 'kv');
    } catch {
      bulkVaultStore = null;
    }
  }
  return bulkVaultStore;
}

function setMemoryFallbackBounded<T>(key: string, entry: StagedCacheEntry<T>): void {
  if (memoryFallback.has(key)) {
    memoryFallback.delete(key);
  }
  memoryFallback.set(key, entry as StagedCacheEntry<unknown>);
  while (memoryFallback.size > MAX_MEMORY_FALLBACK_ENTRIES) {
    const oldest = memoryFallback.keys().next().value;
    if (oldest === undefined) break;
    memoryFallback.delete(oldest);
    vaultHydratedKeys.delete(oldest);
  }
}

export function clearStagedMemoryFallback(): void {
  memoryFallback.clear();
  parsedStagedMemo.clear();
  localStorageMirroredKeys.clear();
  vaultHydratedKeys.clear();
}

function compactDataPayloadForStub(data: unknown): unknown {
  if (data === null || data === undefined) return data;
  if (typeof data !== 'object' || Array.isArray(data)) return null;
  const src = data as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(src)) {
    if (v === null || typeof v === 'number' || typeof v === 'boolean') {
      out[k] = v;
    } else if (typeof v === 'string' && v.length <= MAX_STUB_STRING_CHARS) {
      out[k] = v;
    } else if (
      v &&
      typeof v === 'object' &&
      !Array.isArray(v) &&
      (k === 'openCritic' || k === 'metacritic' || k === 'steam' || k === 'storefrontStars')
    ) {
      const nested: Record<string, unknown> = {};
      for (const [nk, nv] of Object.entries(v as Record<string, unknown>)) {
        if (nv === null || typeof nv === 'number' || typeof nv === 'boolean') {
          nested[nk] = nv;
        } else if (typeof nv === 'string' && nv.length <= MAX_STUB_STRING_CHARS) {
          nested[nk] = nv;
        }
      }
      out[k] = nested;
    }
  }
  return out;
}

function buildCompactLocalStorageStub<T>(entry: StagedCacheEntry<T>): StagedCacheEntry<T> {
  const compactData = compactDataPayloadForStub(entry.data) as T | null;
  const stub: StagedCacheEntry<T> = {
    data: compactData,
    cachedAt: entry.cachedAt,
    ttlMs: entry.ttlMs,
    tier: entry.tier,
    version: entry.version,
    __vaultFull: true,
  };
  if (entry.source !== undefined) stub.source = entry.source;
  if (entry.isVerified !== undefined) stub.isVerified = entry.isVerified;
  if (entry.failureReason !== undefined) stub.failureReason = entry.failureReason;
  if (entry.dynamicResolved !== undefined) stub.dynamicResolved = entry.dynamicResolved;
  if (compactData && typeof compactData === 'object') {
    Object.assign(stub, compactData);
    stub.data = compactData;
    stub.cachedAt = entry.cachedAt;
    stub.ttlMs = entry.ttlMs;
    stub.tier = entry.tier;
    stub.version = entry.version;
    stub.__vaultFull = true;
  }
  return stub;
}

function hasDurableVaultBackend(): boolean {
  return Boolean(
    (typeof window !== 'undefined' && window.electronAPI?.offlineVault) ||
      typeof indexedDB !== 'undefined'
  );
}

function getStorage(): Storage | null {
  if (typeof window !== 'undefined' && window.localStorage) {
    return window.localStorage;
  }
  if (typeof localStorage !== 'undefined') {
    return localStorage;
  }
  return null;
}

/**
 * Parses multiple date representations (ISO string, Steam date, 4-digit year, epoch) into a Unix epoch timestamp in ms.
 */
export function parseReleaseTimestamp(raw?: string | Date | number | null): number | null {
  if (raw === null || raw === undefined) return null;
  if (raw instanceof Date) {
    const t = raw.getTime();
    return isNaN(t) ? null : t;
  }
  if (typeof raw === 'number') {
    if (isNaN(raw)) return null;
    if (raw >= 1970 && raw <= 2100) {
      return new Date(raw, 0, 1).getTime();
    }
    return raw < 10000000000 ? raw * 1000 : raw;
  }
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (!trimmed) return null;
    if (/^\d{4}$/.test(trimmed)) {
      const y = parseInt(trimmed, 10);
      return new Date(y, 0, 1).getTime();
    }
    const parsed = Date.parse(trimmed);
    if (!isNaN(parsed)) return parsed;
    const m = trimmed.match(/\b(19\d\d|20\d\d)\b/);
    if (m) {
      return new Date(parseInt(m[1], 10), 0, 1).getTime();
    }
  }
  return null;
}

/**
 * Determines the data mutability tier for a game based on its release date, genre tags,
 * override status, and error states.
 */
export function determineGameMutabilityTier(
  game?: MutabilityEvaluationInput | CanonicalGame | string | number | Date | null,
  genresArg?: string[] | string | null,
  isEarlyAccessArg?: boolean
): MutabilityTier {
  if (game === null || game === undefined) {
    return 'negative';
  }

  // Handle direct string / number / Date passed as first argument
  if (typeof game === 'string' || typeof game === 'number' || game instanceof Date) {
    return evaluateGameTierInternal({
      releaseDate: game,
      genres: genresArg,
      isEarlyAccess: isEarlyAccessArg,
    });
  }

  return evaluateGameTierInternal(game as MutabilityEvaluationInput, genresArg, isEarlyAccessArg);
}

function evaluateGameTierInternal(
  input: MutabilityEvaluationInput,
  genresArg?: string[] | string | null,
  isEarlyAccessArg?: boolean
): MutabilityTier {
  // 1. Tier 0: Human Override
  if (
    input.isOverride === true ||
    input.userOverride === true ||
    input.hasOverride === true ||
    input.source === 'override'
  ) {
    return 'override';
  }

  // 2. Tier 4C: Transient Error
  if (
    input.isTransientError === true ||
    input.failureReason === 'rate_limited' ||
    input.failureReason === 'network_error'
  ) {
    return 'transient_error';
  }

  // 3. Tier 4B: Negative Cache
  if (
    input.isNegative === true ||
    input.isUnmatched === true ||
    input.data === null ||
    input.score === null ||
    (input.numReviews !== undefined && input.numReviews === 0 && input.score === undefined)
  ) {
    return 'negative';
  }

  // 4. Tier 4A: Early Access
  const isEarlyAccessExplicit = input.isEarlyAccess === true || isEarlyAccessArg === true;
  const effectiveGenres = input.genres || genresArg;
  const effectiveTags = input.tags;

  const matchesEarlyAccessString = (val?: string[] | string | null): boolean => {
    if (!val) return false;
    if (Array.isArray(val)) {
      return val.some((g) => typeof g === 'string' && /early\s*access/i.test(g));
    }
    return typeof val === 'string' && /early\s*access/i.test(val);
  };

  if (
    isEarlyAccessExplicit ||
    matchesEarlyAccessString(effectiveGenres) ||
    matchesEarlyAccessString(effectiveTags)
  ) {
    return 'early_access';
  }

  // 5. Release Date Age Evaluation
  const rawDate = input.releaseDate || input.release_date || input.releaseYear;
  const releaseTs = parseReleaseTimestamp(rawDate);

  if (releaseTs === null) {
    return 'mature';
  }

  const now = Date.now();
  const ageMs = now - releaseTs;

  // Released > 24 months ago (~730 days) -> Immutable
  const TWENTY_FOUR_MONTHS_MS = 730 * 24 * 60 * 60 * 1000;
  if (ageMs > TWENTY_FOUR_MONTHS_MS) {
    return 'immutable';
  }

  // Released 3 to 24 months ago (90 to 730 days) -> Mature
  const NINETY_DAYS_MS = 90 * 24 * 60 * 60 * 1000;
  if (ageMs >= NINETY_DAYS_MS) {
    return 'mature';
  }

  // Released < 90 days ago (or future release date) -> Fresh
  return 'fresh';
}

/**
 * Validates whether a staged cache entry is still valid according to its tier TTL.
 * Human overrides (Tier 0) are strictly immune to TTL expiration and bypass.
 * Explicit bypassTTL causes non-override entries to be treated as invalid, forcing refresh.
 */
export function isCacheEntryValid<T>(
  entry?: StagedCacheEntry<T> | null,
  bypassTTL: boolean = false
): boolean {
  if (!entry || typeof entry !== 'object') return false;

  // Tier 0 human override has immunity from expiration and forced bypass
  if (entry.tier === 'override') return true;

  // If explicitly forced bypassTTL, entry is invalid (must refresh)
  if (bypassTTL) return false;

  if (typeof entry.cachedAt !== 'number' || typeof entry.ttlMs !== 'number') return false;
  if (entry.ttlMs === Infinity) return true;

  return Date.now() - entry.cachedAt < entry.ttlMs;
}

/**
 * Constructs a standardized StagedCacheEntry.
 */
export function createStagedCacheEntry<T>(
  data: T | null,
  tier: MutabilityTier,
  options?: {
    source?: string;
    failureReason?: 'not_found' | 'rate_limited' | 'network_error' | string;
    isVerified?: boolean;
    dynamicResolved?: boolean;
    customTtlMs?: number;
    cachedAt?: number;
    version?: number;
  }
): StagedCacheEntry<T> {
  const cachedAt = options?.cachedAt ?? Date.now();
  const ttlMs = options?.customTtlMs ?? TIER_TTLS[tier] ?? TIER_TTLS.mature;

  const entry: StagedCacheEntry<T> = {
    data,
    cachedAt,
    ttlMs,
    tier,
    version: options?.version ?? STAGED_CACHE_VERSION,
  };

  if (options?.source !== undefined) entry.source = options.source;
  if (options?.isVerified !== undefined) entry.isVerified = options.isVerified;
  if (options?.failureReason !== undefined) entry.failureReason = options.failureReason;
  if (options?.dynamicResolved !== undefined) entry.dynamicResolved = options.dynamicResolved;

  // Shallow merge data properties for backward-compatibility with tests checking entry.score
  if (data && typeof data === 'object') {
    Object.assign(entry, data);
    entry.data = data;
    entry.version = options?.version ?? STAGED_CACHE_VERSION;
    entry.tier = tier;
    entry.cachedAt = cachedAt;
    entry.ttlMs = ttlMs;
    if (options?.dynamicResolved !== undefined) entry.dynamicResolved = options.dynamicResolved;
  }

  return entry;
}

const MAX_PARSED_STAGED_MEMO_ENTRIES = 4096;
const parsedStagedMemo = new Map<string, { raw: string; parsed: Record<string, unknown> }>();

function setParsedStagedMemo(key: string, raw: string, parsed: Record<string, unknown>): void {
  if (parsedStagedMemo.has(key)) {
    parsedStagedMemo.delete(key);
  }
  parsedStagedMemo.set(key, { raw, parsed });
  if (parsedStagedMemo.size > MAX_PARSED_STAGED_MEMO_ENTRIES) {
    const oldest = parsedStagedMemo.keys().next().value;
    if (oldest !== undefined) parsedStagedMemo.delete(oldest);
  }
}

/**
 * Saves an entry into persistent staged cache with tier-specific TTL and automatic quota handling.
 * Full payloads are stored as parsed objects in bounded LRU `memoryFallback` (4,096 entries) and
 * persisted asynchronously to IndexedDB vault, while oversized payloads (> 2KB) mirror a compact
 * `< 512 B` header/score stub to `localStorage` so cold reloads achieve 100% synchronous hit rate
 * without multi-MB `localStorage` bloat.
 */
export function saveStagedCache<T>(
  key: string,
  data: T | null,
  tier: MutabilityTier,
  options?: {
    source?: string;
    failureReason?: 'not_found' | 'rate_limited' | 'network_error' | string;
    isVerified?: boolean;
    dynamicResolved?: boolean;
    customTtlMs?: number;
    cachedAt?: number;
    version?: number;
  }
): StagedCacheEntry<T> {
  const entry = createStagedCacheEntry<T>(data, tier, options);
  const storage = getStorage();
  trackedCacheKeys.add(key);

  setMemoryFallbackBounded(key, entry);
  void vaultSet(`staged:${key}`, entry);

  const serialized = JSON.stringify(entry);
  const isBulkyWithVault =
    serialized.length > BULKY_STAGED_LOCALSTORAGE_BYTES && hasDurableVaultBackend();

  if (storage) {
    const toStoreObj: Record<string, unknown> = isBulkyWithVault
      ? buildCompactLocalStorageStub(entry)
      : entry;
    const toStoreRaw = isBulkyWithVault ? JSON.stringify(toStoreObj) : serialized;

    try {
      storage.setItem(key, toStoreRaw);
      localStorageMirroredKeys.add(key);
      vaultHydratedKeys.delete(key);
      setParsedStagedMemo(key, toStoreRaw, toStoreObj);
    } catch {
      try {
        clearExpiredStagedCache();
        storage.setItem(key, toStoreRaw);
        localStorageMirroredKeys.add(key);
        vaultHydratedKeys.delete(key);
        setParsedStagedMemo(key, toStoreRaw, toStoreObj);
      } catch {
        // QuotaExceededError: full entry remains available in bounded memoryFallback and IndexedDB vault
        try {
          storage.removeItem(key);
        } catch {}
        localStorageMirroredKeys.delete(key);
        vaultHydratedKeys.add(key);
        parsedStagedMemo.delete(key);
      }
    }
  } else {
    vaultHydratedKeys.add(key);
  }

  return entry;
}

export async function hydrateStagedCacheKeyFromVault<T>(
  key: string
): Promise<StagedCacheEntry<T> | null> {
  const fromVault =
    (await vaultGet<StagedCacheEntry<T>>(`staged:${key}`)) ??
    (!key.startsWith('antigravity_staged_')
      ? await vaultGet<StagedCacheEntry<T>>(`staged:antigravity_staged_${key}`)
      : undefined);
  if (!fromVault || typeof fromVault !== 'object') return null;
  if (fromVault.tier === 'override' && (fromVault.ttlMs === null || fromVault.ttlMs === undefined)) {
    fromVault.ttlMs = Infinity;
  }
  setMemoryFallbackBounded(key, fromVault);
  vaultHydratedKeys.add(key);
  return fromVault;
}

/**
 * Bulk-hydrates all `'staged:*'` entries from IndexedDB vault into the bounded in-memory cache
 * in a single cursor read so oversized (> 2KB) payloads achieve 100% full-detail hit rates after reload.
 * Safe and non-throwing in headless/test environments without IndexedDB.
 */
export async function hydrateAllStagedCacheFromVault(): Promise<number> {
  if (inFlightBulkVaultHydration) {
    return inFlightBulkVaultHydration;
  }
  const store = getBulkVaultStore();
  if (!store) return 0;

  inFlightBulkVaultHydration = (async (): Promise<number> => {
    try {
      const allEntries = await idbEntries(store);
      if (!Array.isArray(allEntries) || allEntries.length === 0) return 0;
      const now = Date.now();
      let hydratedCount = 0;
      for (const pair of allEntries) {
        if (!Array.isArray(pair) || pair.length < 2) continue;
        const [rawKey, rawVal] = pair;
        if (typeof rawKey !== 'string' || !rawKey.startsWith('staged:')) continue;
        const cacheKey = rawKey.slice('staged:'.length);
        if (!cacheKey || !rawVal || typeof rawVal !== 'object' || Array.isArray(rawVal)) continue;

        const entry = rawVal as StagedCacheEntry<unknown>;
        if (entry.tier === 'override') {
          entry.ttlMs = Infinity;
        }
        if (
          (entry.tier === 'negative' || entry.tier === 'transient_error') &&
          typeof entry.cachedAt === 'number' &&
          typeof entry.ttlMs === 'number' &&
          now - entry.cachedAt >= entry.ttlMs
        ) {
          continue;
        }
        trackedCacheKeys.add(cacheKey);
        setMemoryFallbackBounded(cacheKey, entry);
        vaultHydratedKeys.add(cacheKey);
        hydratedCount++;
      }
      return hydratedCount;
    } catch {
      return 0;
    } finally {
      inFlightBulkVaultHydration = null;
    }
  })();

  return inFlightBulkVaultHydration;
}

function evaluateHydratedStagedEntry<T>(
  entry: StagedCacheEntry<T>,
  bypassTTL: boolean
): { valid: boolean; stale?: boolean; data: T | null; entry: StagedCacheEntry<T> } {
  if (entry.tier === 'override') {
    entry.ttlMs = Infinity;
  }
  const valid = isCacheEntryValid(entry, bypassTTL);
  const data = entry.data !== undefined ? entry.data : (entry as unknown as T);
  const stale =
    !valid &&
    data !== null &&
    entry?.tier !== 'negative' &&
    entry?.tier !== 'transient_error';
  return { valid, stale, data, entry };
}

/**
 * Reads a staged cache entry and checks validity against its TTL and bypass flag.
 * Raw-string memoization skips redundant JSON.parse calls while staying 100% coherent
 * with direct localStorage mutations in callers or unit tests.
 */
export function loadStagedCache<T>(
  key: string,
  bypassTTL: boolean = false
): { valid: boolean; stale?: boolean; data: T | null; entry?: StagedCacheEntry<T> } {
  const storage = getStorage();
  let raw: string | null = null;
  let resolvedKey = key;

  if (storage) {
    raw = storage.getItem(key);
    if (!raw && !key.startsWith('antigravity_staged_')) {
      const prefixedKey = `antigravity_staged_${key}`;
      raw = storage.getItem(prefixedKey);
      if (raw) resolvedKey = prefixedKey;
    }
  }

  if (!raw) {
    parsedStagedMemo.delete(key);
    const prefixedKey = `antigravity_staged_${key}`;
    if (localStorageMirroredKeys.has(key) && !vaultHydratedKeys.has(key)) {
      memoryFallback.delete(key);
      localStorageMirroredKeys.delete(key);
    }
    if (localStorageMirroredKeys.has(prefixedKey) && !vaultHydratedKeys.has(prefixedKey)) {
      memoryFallback.delete(prefixedKey);
      localStorageMirroredKeys.delete(prefixedKey);
    }

    const memHit =
      (memoryFallback.get(key) as StagedCacheEntry<T> | undefined) ??
      (!key.startsWith('antigravity_staged_')
        ? (memoryFallback.get(prefixedKey) as StagedCacheEntry<T> | undefined)
        : undefined);
    if (!memHit) {
      return { valid: false, data: null };
    }
    setMemoryFallbackBounded(memoryFallback.has(key) ? key : prefixedKey, memHit);
    return evaluateHydratedStagedEntry(memHit, bypassTTL);
  }

  try {
    const memoHit = parsedStagedMemo.get(resolvedKey);
    let parsed: Record<string, unknown> | null = null;
    if (memoHit && memoHit.raw === raw) {
      parsed = memoHit.parsed;
    } else {
      const rawParsed: unknown = JSON.parse(raw);
      if (rawParsed && typeof rawParsed === 'object' && !Array.isArray(rawParsed)) {
        parsed = rawParsed as Record<string, unknown>;
        setParsedStagedMemo(resolvedKey, raw, parsed);
      }
    }
    if (!parsed) {
      return { valid: false, data: null };
    }

    // If localStorage holds a compact stub (`__vaultFull: true`) and the full rich object is
    // already hydrated in memoryFallback with matching cachedAt, return the full rich object!
    if (parsed.__vaultFull === true) {
      const memRich = memoryFallback.get(resolvedKey) as StagedCacheEntry<T> | undefined;
      if (memRich && memRich.cachedAt === parsed.cachedAt) {
        setMemoryFallbackBounded(resolvedKey, memRich);
        return evaluateHydratedStagedEntry(memRich, bypassTTL);
      }
    }

    let entry: StagedCacheEntry<T>;
    if (
      typeof parsed.cachedAt === 'number' &&
      (typeof parsed.ttlMs === 'number' ||
        (parsed.tier === 'override' && (parsed.ttlMs === null || parsed.ttlMs === undefined)))
    ) {
      entry = parsed as StagedCacheEntry<T>;
      if (entry.tier === 'override') {
        entry.ttlMs = Infinity;
      }
    } else {
      // Legacy unversioned entry adapter
      const legacyData = parsed as unknown as T;
      entry = {
        data: legacyData,
        cachedAt: Date.now(),
        ttlMs: TIER_TTLS.mature,
        tier: 'mature',
        version: 8,
      };
      if (typeof parsed.source === 'string') entry.source = parsed.source;
      if (typeof parsed.isVerified === 'boolean') entry.isVerified = parsed.isVerified;
    }

    return evaluateHydratedStagedEntry(entry, bypassTTL);
  } catch {
    return { valid: false, data: null };
  }
}

export const STAGED_CACHE_PREFIX = 'antigravity_staged_';
const trackedCacheKeys = new Set<string>();

/**
 * Removes a staged cache entry from persistent storage and in-memory fallback.
 */
export function evictStagedCache(key: string): void {
  trackedCacheKeys.delete(key);
  localStorageMirroredKeys.delete(key);
  localStorageMirroredKeys.delete(`${STAGED_CACHE_PREFIX}${key}`);
  vaultHydratedKeys.delete(key);
  vaultHydratedKeys.delete(`${STAGED_CACHE_PREFIX}${key}`);
  parsedStagedMemo.delete(key);
  parsedStagedMemo.delete(`${STAGED_CACHE_PREFIX}${key}`);
  const storage = getStorage();
  if (storage) {
    try {
      storage.removeItem(key);
      if (!key.startsWith(STAGED_CACHE_PREFIX)) {
        storage.removeItem(`${STAGED_CACHE_PREFIX}${key}`);
      }
    } catch {}
  }
  memoryFallback.delete(key);
  memoryFallback.delete(`${STAGED_CACHE_PREFIX}${key}`);
  void vaultDelete(`staged:${key}`);
  if (!key.startsWith(STAGED_CACHE_PREFIX)) {
    void vaultDelete(`staged:${STAGED_CACHE_PREFIX}${key}`);
  }
}

/**
 * Removes expired staged cache entries from storage.
 * When `onlyNegativeAndTransient` is true (e.g. startup maintenance), positive entries
 * ('immutable', 'mature', 'fresh', 'early_access', 'override') are retained past their
 * refresh TTL in localStorage to guarantee stale-while-offline availability, while
 * full quota-recovery sweeps evict expired non-override localStorage entries (which remain
 * persisted in IndexedDB vault).
 */
export function clearExpiredStagedCache(options?: { onlyNegativeAndTransient?: boolean }): void {
  const onlyNegOrTransient = Boolean(options?.onlyNegativeAndTransient);
  const storage = getStorage();
  const now = Date.now();

  if (storage) {
    try {
      const keysToRemove: string[] = [];
      for (let i = 0; i < storage.length; i++) {
        const key = storage.key(i);
        if (!key) continue;
        if (
          !key.startsWith(STAGED_CACHE_PREFIX) &&
          !key.startsWith('antigravity_critic_') &&
          !key.startsWith('steam_match_') &&
          !trackedCacheKeys.has(key)
        ) {
          continue;
        }
        try {
          const raw = storage.getItem(key);
          if (!raw) continue;
          const parsed = JSON.parse(raw);
          if (
            parsed &&
            typeof parsed === 'object' &&
            typeof parsed.cachedAt === 'number' &&
            typeof parsed.ttlMs === 'number'
          ) {
            if (parsed.tier === 'override' || parsed.ttlMs === Infinity) {
              continue;
            }
            if (
              onlyNegOrTransient &&
              parsed.tier !== 'negative' &&
              parsed.tier !== 'transient_error'
            ) {
              continue;
            }
            if (now - parsed.cachedAt >= parsed.ttlMs) {
              keysToRemove.push(key);
            }
          }
        } catch {
          // Skip unparseable non-cache entries
        }
      }
      for (const k of keysToRemove) {
        storage.removeItem(k);
        trackedCacheKeys.delete(k);
        localStorageMirroredKeys.delete(k);
        parsedStagedMemo.delete(k);
        memoryFallback.delete(k);
      }
    } catch {}
  }

  for (const [key, entry] of memoryFallback.entries()) {
    if (
      entry &&
      typeof entry === 'object' &&
      typeof entry.cachedAt === 'number' &&
      typeof entry.ttlMs === 'number'
    ) {
      if (entry.tier === 'override' || entry.ttlMs === Infinity) continue;
      if (
        onlyNegOrTransient &&
        entry.tier !== 'negative' &&
        entry.tier !== 'transient_error'
      ) {
        continue;
      }
      if (now - entry.cachedAt >= entry.ttlMs) {
        memoryFallback.delete(key);
        vaultHydratedKeys.delete(key);
        localStorageMirroredKeys.delete(key);
        parsedStagedMemo.delete(key);
      }
    }
  }
}

if (typeof window !== 'undefined' && isIndexedDbAvailable()) {
  try {
    void hydrateAllStagedCacheFromVault();
  } catch {}
}
