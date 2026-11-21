import { LruMap } from '../common/lruMap';
import { getSafeLocalStorage, isTestEnv } from '../common/runtimeEnv';
import {
  type MutabilityTier,
  evictStagedCache,
  loadStagedCache,
  saveStagedCache,
} from '../storage/stagedCacheService';

export interface StagedResolverCacheEntry<V> {
  value: V | null;
  expiresAt: number;
  mirroredInStorage: boolean;
}

export interface StagedResolverCacheOptions<K extends string | number> {
  stagedPrefix: string;
  sourceLabel: string;
  maxInMemoryEntries?: number;
  maxTransientFailures?: number;
  transientFailureWindowMs?: number;
  defaultPositiveTtlMs: number;
  negativeTtlMs: number;
  toStorageSuffix?: (key: K) => string;
}

export interface StagedResolverWriteOptions {
  ttlMs?: number;
  tier?: MutabilityTier;
  meta?: Record<string, unknown>;
  clearTransientKeys?: readonly string[];
  capturedGlobalEpoch?: number;
  capturedKeyEpoch?: number;
}

export interface StagedResolverEpochSnapshot {
  globalEpoch: number;
  keyEpoch: number;
}

/**
 * Returns an AbortSignal with timeout when supported by the runtime.
 */
export function createTimeoutSignal(ms: number): AbortSignal | undefined {
  if (typeof AbortSignal !== 'undefined' && 'timeout' in AbortSignal) {
    return AbortSignal.timeout(ms);
  }
  return undefined;
}

/**
 * Parses a valid game release year (1975 .. currentYear + 2) from numeric or date strings.
 */
export function parseValidReleaseYear(raw?: number | string | null): number | null {
  if (raw === null || raw === undefined) return null;
  const maxYear = new Date().getFullYear() + 2;
  if (typeof raw === 'number') {
    return Number.isInteger(raw) && raw >= 1975 && raw <= maxYear ? raw : null;
  }
  const str = String(raw).trim();
  if (!str) return null;
  const isoMatch = str.match(/^[+-]?((?:19|20)\d{2})(?:[-T/]|$)/);
  if (isoMatch) {
    const yr = Number.parseInt(isoMatch[1], 10);
    return yr >= 1975 && yr <= maxYear ? yr : null;
  }
  const anyMatch = str.match(/\b((?:19|20)\d{2})\b/);
  if (anyMatch) {
    const yr = Number.parseInt(anyMatch[1], 10);
    return yr >= 1975 && yr <= maxYear ? yr : null;
  }
  return null;
}

/**
 * Shared staged-persistence + bounded-LRU memory cache + epoch-fenced eviction store
 * used by critic sub-resolvers (OpenCritic, Wikidata).
 *
 * - Production warm reads hit in-memory LRU without synchronous `localStorage.getItem` calls.
 * - Under Vitest (`isTestEnv()`), verifies `localStorage` presence for mirrored entries so
 *   direct `localStorage.clear()` calls in unit tests immediately invalidate warm entries.
 * - Monotonic `globalEpoch` + per-key `keyEpochs` prevent stale pre-eviction in-flight
 *   fetches from re-poisoning cache after `evictKey()` or `clear()`.
 */
export class StagedResolverCache<K extends string | number, V> {
  private readonly stagedPrefix: string;
  private readonly sourceLabel: string;
  private readonly maxInMemoryEntries: number;
  private readonly transientFailureWindowMs: number;
  private readonly defaultPositiveTtlMs: number;
  private readonly negativeTtlMs: number;
  private readonly toStorageSuffix: (key: K) => string;

  private readonly inMemoryCache: LruMap<K, StagedResolverCacheEntry<V>>;
  private readonly trackedStagedKeys = new Set<string>();
  private readonly transientFailures: LruMap<string, number>;
  private readonly keyEpochs = new Map<K, number>();

  private globalEpoch = 0;
  private lastGlobalTransientFailureAt = 0;

  constructor(options: StagedResolverCacheOptions<K>) {
    this.stagedPrefix = options.stagedPrefix;
    this.sourceLabel = options.sourceLabel;
    this.maxInMemoryEntries = options.maxInMemoryEntries ?? 4096;
    this.transientFailureWindowMs = options.transientFailureWindowMs ?? 5 * 60 * 1000;
    this.defaultPositiveTtlMs = options.defaultPositiveTtlMs;
    this.negativeTtlMs = options.negativeTtlMs;
    this.toStorageSuffix = options.toStorageSuffix ?? ((key: K) => String(key));

    this.inMemoryCache = new LruMap<K, StagedResolverCacheEntry<V>>(this.maxInMemoryEntries);
    this.transientFailures = new LruMap<string, number>(
      options.maxTransientFailures ?? this.maxInMemoryEntries
    );
  }

  public makeStagedKey(key: K): string {
    return `${this.stagedPrefix}${this.toStorageSuffix(key)}`;
  }

  public getGlobalEpoch(): number {
    return this.globalEpoch;
  }

  public getKeyEpoch(key: K): number {
    return this.keyEpochs.get(key) ?? 0;
  }

  public captureEpoch(key: K): StagedResolverEpochSnapshot {
    return {
      globalEpoch: this.globalEpoch,
      keyEpoch: this.keyEpochs.get(key) ?? 0,
    };
  }

  public isEpochCurrent(
    capturedGlobalEpoch: number,
    key?: K,
    capturedKeyEpoch?: number
  ): boolean {
    if (capturedGlobalEpoch !== this.globalEpoch) return false;
    if (key !== undefined && capturedKeyEpoch !== undefined) {
      return (this.keyEpochs.get(key) ?? 0) === capturedKeyEpoch;
    }
    return true;
  }

  private setMemoryEntry(
    key: K,
    value: V | null,
    ttlMs: number,
    mirroredInStorage: boolean
  ): void {
    this.inMemoryCache.set(key, {
      value,
      expiresAt: Date.now() + ttlMs,
      mirroredInStorage,
    });
  }

  public read(key: K): { hit: boolean; value: V | null } {
    const stagedKey = this.makeStagedKey(key);
    const mem = this.inMemoryCache.get(key);
    const now = Date.now();

    if (mem) {
      if (mem.mirroredInStorage && isTestEnv()) {
        const storage = getSafeLocalStorage();
        if (storage && storage.getItem(stagedKey) === null) {
          this.inMemoryCache.delete(key);
        } else if (now < mem.expiresAt) {
          return { hit: true, value: mem.value };
        } else {
          this.inMemoryCache.delete(key);
        }
      } else if (now < mem.expiresAt) {
        return { hit: true, value: mem.value };
      } else {
        this.inMemoryCache.delete(key);
      }
    }

    const staged = loadStagedCache<V>(stagedKey, false);
    if (staged.valid) {
      const remainingMs =
        staged.entry &&
        typeof staged.entry.cachedAt === 'number' &&
        typeof staged.entry.ttlMs === 'number'
          ? Math.max(1000, staged.entry.cachedAt + staged.entry.ttlMs - now)
          : staged.data !== null
          ? this.defaultPositiveTtlMs
          : this.negativeTtlMs;
      const storage = getSafeLocalStorage();
      const mirrored = Boolean(storage && storage.getItem(stagedKey) !== null);
      this.setMemoryEntry(key, staged.data, remainingMs, mirrored);
      this.trackedStagedKeys.add(stagedKey);
      return { hit: true, value: staged.data };
    }

    return { hit: false, value: null };
  }

  public writePositive(
    key: K,
    value: V,
    options?: StagedResolverWriteOptions
  ): boolean {
    if (
      options?.capturedGlobalEpoch !== undefined &&
      !this.isEpochCurrent(options.capturedGlobalEpoch, key, options.capturedKeyEpoch)
    ) {
      return false;
    }

    const stagedKey = this.makeStagedKey(key);
    const ttlMs = options?.ttlMs ?? this.defaultPositiveTtlMs;
    const tier: MutabilityTier = options?.tier ?? 'mature';

    this.trackedStagedKeys.add(stagedKey);
    saveStagedCache<V>(stagedKey, value, tier, {
      source: this.sourceLabel,
      customTtlMs: ttlMs,
      dynamicResolved: true,
      ...(options?.meta ?? {}),
    });

    const storage = getSafeLocalStorage();
    const mirrored = Boolean(storage && storage.getItem(stagedKey) !== null);
    this.setMemoryEntry(key, value, ttlMs, mirrored);

    if (options?.clearTransientKeys) {
      this.clearTransientFailures(options.clearTransientKeys);
    }
    return true;
  }

  public writeNegative(
    key: K,
    options?: Omit<StagedResolverWriteOptions, 'tier'>
  ): boolean {
    if (
      options?.capturedGlobalEpoch !== undefined &&
      !this.isEpochCurrent(options.capturedGlobalEpoch, key, options.capturedKeyEpoch)
    ) {
      return false;
    }

    const stagedKey = this.makeStagedKey(key);
    const ttlMs = options?.ttlMs ?? this.negativeTtlMs;

    this.trackedStagedKeys.add(stagedKey);
    saveStagedCache<V>(stagedKey, null, 'negative', {
      source: this.sourceLabel,
      failureReason: 'not_found',
      customTtlMs: ttlMs,
      dynamicResolved: true,
      ...(options?.meta ?? {}),
    });

    const storage = getSafeLocalStorage();
    const mirrored = Boolean(storage && storage.getItem(stagedKey) !== null);
    this.setMemoryEntry(key, null, ttlMs, mirrored);

    if (options?.clearTransientKeys) {
      this.clearTransientFailures(options.clearTransientKeys);
    }
    return true;
  }

  public evictKey(key: K): void {
    this.keyEpochs.set(key, (this.keyEpochs.get(key) ?? 0) + 1);
    this.inMemoryCache.delete(key);
    const stagedKey = this.makeStagedKey(key);
    evictStagedCache(stagedKey);
    this.trackedStagedKeys.delete(stagedKey);
  }

  public markTransientFailure(keys?: readonly string[]): void {
    const now = Date.now();
    this.lastGlobalTransientFailureAt = now;
    if (!keys) return;
    for (const key of keys) {
      if (key) {
        this.transientFailures.set(key, now);
      }
    }
  }

  public clearTransientFailures(keys: readonly string[]): void {
    for (const key of keys) {
      if (key) {
        this.transientFailures.delete(key);
      }
    }
  }

  public hadRecentTransientFailure(probeKeys?: readonly string[]): boolean {
    const now = Date.now();
    if (!probeKeys || probeKeys.length === 0) {
      return now - this.lastGlobalTransientFailureAt < this.transientFailureWindowMs;
    }

    for (const probe of probeKeys) {
      if (!probe) continue;
      const ts = this.transientFailures.get(probe);
      if (ts !== undefined) {
        if (now - ts < this.transientFailureWindowMs) {
          return true;
        }
        this.transientFailures.delete(probe);
      }
    }
    return false;
  }

  public clear(options?: { negativesOnly?: boolean }): void {
    const negativesOnly = Boolean(options?.negativesOnly);
    this.transientFailures.clear();
    this.lastGlobalTransientFailureAt = 0;

    if (negativesOnly) {
      const negativeKeys: K[] = [];
      for (const [key, entry] of this.inMemoryCache.entries()) {
        if (entry.value === null) {
          negativeKeys.push(key);
        }
      }
      for (const key of negativeKeys) {
        this.keyEpochs.set(key, (this.keyEpochs.get(key) ?? 0) + 1);
        this.inMemoryCache.delete(key);
        const stagedKey = this.makeStagedKey(key);
        evictStagedCache(stagedKey);
        this.trackedStagedKeys.delete(stagedKey);
      }
      return;
    }

    this.globalEpoch += 1;
    this.keyEpochs.clear();
    this.inMemoryCache.clear();
    for (const stagedKey of this.trackedStagedKeys) {
      evictStagedCache(stagedKey);
    }
    this.trackedStagedKeys.clear();
  }
}
