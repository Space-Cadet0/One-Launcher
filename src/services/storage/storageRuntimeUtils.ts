import { getSafeLocalStorage } from '../common/runtimeEnv';

export { getSafeLocalStorage };

/**
 * Dynamic test-environment check honoring runtime `process.env` mutations
 * (e.g. `vi.stubEnv('VITEST', '')` + `vi.stubEnv('NODE_ENV', 'production')` in production-mode perf tests).
 */
export function isTestEnv(): boolean {
  try {
    return (
      typeof process !== 'undefined' &&
      Boolean(process.env?.VITEST || process.env?.NODE_ENV === 'test')
    );
  } catch {
    return false;
  }
}

/**
 * Validates a canonical gameId, alias, or storage key against prototype-pollution
 * and control-character hazards.
 */
export function normalizeSafeIdKey(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  const trimmed = raw.replace(/[\x00-\x1f\x7f]+/g, '').trim();
  if (
    !trimmed ||
    trimmed.length > 256 ||
    trimmed === '__proto__' ||
    trimmed === 'constructor' ||
    trimmed === 'prototype'
  ) {
    return '';
  }
  return trimmed;
}

/**
 * Parses an ISO/date timestamp string into Unix epoch milliseconds, returning `0` on invalid input.
 */
export function parseIsoTimestampMs(raw?: string | null): number {
  if (!raw) return 0;
  const ts = Date.parse(raw);
  return Number.isFinite(ts) ? ts : 0;
}

/**
 * Produces a strictly monotonic ISO timestamp greater than `prevUpdatedAt`.
 */
export function nextMonotonicIsoTimestamp(prevUpdatedAt?: string | null): string {
  const prevTs = parseIsoTimestampMs(prevUpdatedAt);
  const nowTs = Date.now();
  return new Date(nowTs > prevTs ? nowTs : prevTs + 1).toISOString();
}

export interface CachedLocalStorageSlotOptions<T> {
  storageKey: string;
  createEmpty: () => T;
  deserialize: (raw: string) => { value: T; upgradedRaw?: string };
  serialize: (value: T) => string;
  onExternalInvalidate?: () => void;
}

export interface CachedLocalStorageSlot<T> {
  load: () => T;
  persist: (nextValue: T) => boolean;
  invalidate: () => void;
  getRevision: () => number;
  bumpRevision: () => void;
}

/**
 * Shared in-memory cached `localStorage` slot with:
 * - Zero redundant `localStorage.getItem()` syscalls in production after initial hydration
 * - Cross-window `StorageEvent` invalidation (window-identity aware for test harnesses)
 * - Atomic write-before-cache-update persistence (in-memory state is never corrupted on QuotaExceededError)
 */
export function createCachedLocalStorageSlot<T>(
  options: CachedLocalStorageSlotOptions<T>
): CachedLocalStorageSlot<T> {
  const { storageKey, createEmpty, deserialize, serialize, onExternalInvalidate } = options;

  let cachedRaw: string | null = null;
  let cachedValue: T = createEmpty();
  let cachedStorageRef: Storage | null = null;
  let hydrated = false;
  let attachedWindowRef: Window | null = null;
  let revision = 0;

  const bumpRevision = (): void => {
    revision += 1;
  };

  const ensureListener = (): void => {
    if (typeof window === 'undefined' || typeof window.addEventListener !== 'function') return;
    if (attachedWindowRef === window) return;
    attachedWindowRef = window;
    window.addEventListener('storage', (e: StorageEvent) => {
      if (e.key === null || e.key === storageKey) {
        hydrated = false;
        cachedRaw = null;
        bumpRevision();
        onExternalInvalidate?.();
      }
    });
  };

  const load = (): T => {
    const storage = getSafeLocalStorage();
    if (!storage) return createEmpty();
    ensureListener();

    if (!isTestEnv() && hydrated && storage === cachedStorageRef) {
      return cachedValue;
    }

    try {
      const raw = storage.getItem(storageKey);
      if (!raw) {
        if (hydrated && cachedRaw !== null) {
          bumpRevision();
        }
        cachedStorageRef = storage;
        cachedRaw = null;
        cachedValue = createEmpty();
        hydrated = true;
        return cachedValue;
      }

      if (hydrated && storage === cachedStorageRef && raw === cachedRaw) {
        cachedRaw = raw;
        return cachedValue;
      }

      const decoded = deserialize(raw);
      cachedStorageRef = storage;
      cachedRaw = raw;
      cachedValue = decoded.value;
      hydrated = true;

      if (decoded.upgradedRaw !== undefined) {
        try {
          storage.setItem(storageKey, decoded.upgradedRaw);
          cachedRaw = isTestEnv() ? decoded.upgradedRaw : null;
        } catch {
          // Keep deserialized value if storage quota refuses rewrite
        }
      }

      return cachedValue;
    } catch {
      return createEmpty();
    }
  };

  const persist = (nextValue: T): boolean => {
    const storage = getSafeLocalStorage();
    ensureListener();
    if (storage) {
      const serialized = serialize(nextValue);
      // Persist to storage BEFORE mutating in-memory cache so QuotaExceededError never corrupts state
      storage.setItem(storageKey, serialized);
      cachedStorageRef = storage;
      cachedRaw = isTestEnv() ? serialized : null;
    }
    cachedValue = nextValue;
    hydrated = true;
    bumpRevision();
    return true;
  };

  const invalidate = (): void => {
    hydrated = false;
    cachedRaw = null;
  };

  return {
    load,
    persist,
    invalidate,
    getRevision: () => revision,
    bumpRevision,
  };
}
