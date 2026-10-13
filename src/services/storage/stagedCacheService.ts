import type { CanonicalGame } from '../../contracts/game';

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
  failureReason?: 'not_found' | 'rate_limited' | 'network_error' | string;
  [key: string]: any;
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
  isNegative?: boolean;
  isUnmatched?: boolean;
  isTransientError?: boolean;
  failureReason?: string;
  numReviews?: number;
  score?: number | null;
  data?: any;
}

const memoryFallback = new Map<string, string>();

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
    (input as any).source === 'override'
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

  // Shallow merge data properties for backward-compatibility with tests checking entry.score
  if (data && typeof data === 'object') {
    Object.assign(entry, data);
    entry.data = data;
    entry.version = options?.version ?? STAGED_CACHE_VERSION;
    entry.tier = tier;
    entry.cachedAt = cachedAt;
    entry.ttlMs = ttlMs;
  }

  return entry;
}

/**
 * Saves an entry into persistent staged cache with tier-specific TTL and automatic quota handling.
 */
export function saveStagedCache<T>(
  key: string,
  data: T | null,
  tier: MutabilityTier,
  options?: {
    source?: string;
    failureReason?: 'not_found' | 'rate_limited' | 'network_error' | string;
    isVerified?: boolean;
    customTtlMs?: number;
    cachedAt?: number;
    version?: number;
  }
): StagedCacheEntry<T> {
  const entry = createStagedCacheEntry<T>(data, tier, options);
  const storage = getStorage();

  if (storage) {
    try {
      storage.setItem(key, JSON.stringify(entry));
    } catch (err) {
      try {
        clearExpiredStagedCache();
        storage.setItem(key, JSON.stringify(entry));
      } catch (retryErr) {
        console.warn(`[StagedCache] Failed to persist key "${key}" to localStorage:`, retryErr);
      }
    }
  } else {
    memoryFallback.set(key, JSON.stringify(entry));
  }

  return entry;
}

/**
 * Reads a staged cache entry and checks validity against its TTL and bypass flag.
 */
export function loadStagedCache<T>(
  key: string,
  bypassTTL: boolean = false
): { valid: boolean; data: T | null; entry?: StagedCacheEntry<T> } {
  const storage = getStorage();
  let raw: string | null = null;

  if (storage) {
    raw = storage.getItem(key);
    if (!raw && !key.startsWith('antigravity_staged_')) {
      raw = storage.getItem(`antigravity_staged_${key}`);
    }
  } else {
    raw = memoryFallback.get(key) || memoryFallback.get(`antigravity_staged_${key}`) || null;
  }

  if (!raw) {
    return { valid: false, data: null };
  }

  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') {
      return { valid: false, data: null };
    }

    let entry: StagedCacheEntry<T>;
    if (
      typeof parsed.cachedAt === 'number' &&
      (typeof parsed.ttlMs === 'number' || (parsed.tier === 'override' && (parsed.ttlMs === null || parsed.ttlMs === undefined)))
    ) {
      entry = parsed as StagedCacheEntry<T>;
      if (entry.tier === 'override') {
        entry.ttlMs = Infinity;
      }
    } else {
      // Legacy unversioned entry adapter
      const legacyData = parsed as T;
      entry = {
        data: legacyData,
        cachedAt: Date.now(),
        ttlMs: TIER_TTLS.mature,
        tier: 'mature',
        version: 8,
      };
      if (typeof (parsed as any).source === 'string') entry.source = (parsed as any).source;
      if (typeof (parsed as any).isVerified === 'boolean') entry.isVerified = (parsed as any).isVerified;
    }

    const valid = isCacheEntryValid(entry, bypassTTL);
    const data = entry.data !== undefined ? entry.data : (entry as unknown as T);

    return {
      valid,
      data,
      entry,
    };
  } catch {
    return { valid: false, data: null };
  }
}

/**
 * Removes a staged cache entry from persistent storage and in-memory fallback.
 */
export function evictStagedCache(key: string): void {
  const storage = getStorage();
  if (storage) {
    try {
      storage.removeItem(key);
      if (!key.startsWith('antigravity_staged_')) {
        storage.removeItem(`antigravity_staged_${key}`);
      }
    } catch {}
  }
  memoryFallback.delete(key);
  memoryFallback.delete(`antigravity_staged_${key}`);
}

/**
 * Removes expired staged cache entries from storage to prevent quota overflow.
 */
export function clearExpiredStagedCache(): void {
  const storage = getStorage();
  const now = Date.now();

  if (storage) {
    try {
      const keysToRemove: string[] = [];
      for (let i = 0; i < storage.length; i++) {
        const key = storage.key(i);
        if (!key) continue;
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
      }
    } catch {}
  }

  for (const [key, raw] of memoryFallback.entries()) {
    try {
      const parsed = JSON.parse(raw);
      if (
        parsed &&
        typeof parsed === 'object' &&
        typeof parsed.cachedAt === 'number' &&
        typeof parsed.ttlMs === 'number'
      ) {
        if (parsed.tier === 'override' || parsed.ttlMs === Infinity) continue;
        if (now - parsed.cachedAt >= parsed.ttlMs) {
          memoryFallback.delete(key);
        }
      }
    } catch {}
  }
}
