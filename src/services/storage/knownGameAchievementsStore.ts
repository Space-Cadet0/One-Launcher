/**
 * Single-owner cross-storefront Achievement Summary Store (Layer 0 `services-foundation`).
 *
 * Unifies `localStorage['antigravity_<store>_achievements']` and IndexedDB vault persistence
 * across Steam, GOG, Epic, and Xbox so no two services can ever split-brain or overwrite
 * each other's writes. Enforces an IndexedDB hydration-before-write barrier so early writes
 * before IDB hydration resolves merge with hydrated vault records instead of clobbering them.
 */

import { StoreAchievementSummary } from '../../contracts/game';
import { getSafeLocalStorage, isTestEnv } from '../common/runtimeEnv';
import { isIndexedDbAvailable, vaultDelete, vaultGet, vaultSet } from './indexedDbVault';
import { reconcileAchievementSummaries } from './achievementReconciliation';

export type AchievementSummaryStorefrontId = 'steam' | 'gog' | 'epic' | 'xbox';

export const ACHIEVEMENT_SUMMARY_STORAGE_KEYS: Readonly<Record<AchievementSummaryStorefrontId, string>> = {
  steam: 'antigravity_steam_achievements',
  epic: 'antigravity_epic_achievements',
  gog: 'antigravity_gog_achievements',
  xbox: 'antigravity_xbox_achievements',
};

export const ACHIEVEMENT_SUMMARY_IDB_KEYS: Readonly<Record<AchievementSummaryStorefrontId, string>> = {
  steam: 'idb_steam_achievements_summary_v1',
  epic: 'idb_epic_achievements_summary_v1',
  gog: 'idb_gog_achievements_summary_v1',
  xbox: 'idb_xbox_achievements_summary_v1',
};

export const STORAGE_KEY_STEAM_ACHIEVEMENTS_LAST_SYNC =
  'antigravity_steam_achievements_last_sync_ts';

const SAVE_DEBOUNCE_MS = 250;
const TEST_SAVE_DEBOUNCE_MS = 10;

interface StoreSlotState {
  readonly storefrontId: AchievementSummaryStorefrontId;
  readonly localStorageKey: string;
  readonly idbKey: string;
  hydratedFromStorage: boolean;
  storageRef: Storage | null;
  rawRef: string | null;
  entries: Record<string, StoreAchievementSummary>;
  dirty: boolean;
  pendingFlushTimer: ReturnType<typeof setTimeout> | null;
  idbHydrationState: 'idle' | 'pending' | 'done';
  idbHydrationPromise: Promise<void> | null;
  pendingIdbWriteAfterHydration: boolean;
  generation: number;
}

function createSlot(storefrontId: AchievementSummaryStorefrontId): StoreSlotState {
  return {
    storefrontId,
    localStorageKey: ACHIEVEMENT_SUMMARY_STORAGE_KEYS[storefrontId],
    idbKey: ACHIEVEMENT_SUMMARY_IDB_KEYS[storefrontId],
    hydratedFromStorage: false,
    storageRef: null,
    rawRef: null,
    entries: {},
    dirty: false,
    pendingFlushTimer: null,
    idbHydrationState: 'idle',
    idbHydrationPromise: null,
    pendingIdbWriteAfterHydration: false,
    generation: 0,
  };
}

export function normalizeStoredAchievementSummary(
  raw: Partial<StoreAchievementSummary> | null | undefined,
  defaultSource: NonNullable<StoreAchievementSummary['source']> = 'local_client_cache'
): StoreAchievementSummary | null {
  if (!raw || typeof raw !== 'object') return null;
  if (typeof raw.unlocked !== 'number' || !Number.isFinite(raw.unlocked)) return null;
  if (typeof raw.total !== 'number' || !Number.isFinite(raw.total)) return null;

  const unlocked = Math.max(0, Math.floor(raw.unlocked));
  const total = Math.max(0, Math.floor(raw.total));
  const percentage =
    typeof raw.percentage === 'number' && Number.isFinite(raw.percentage)
      ? raw.percentage
      : total > 0
        ? Math.round((unlocked / total) * 100)
        : 0;
  const isMastered =
    typeof raw.isMastered === 'boolean' ? raw.isMastered : total > 0 && unlocked >= total;

  return {
    unlocked,
    total,
    percentage,
    ...(raw.gamerscore && typeof raw.gamerscore === 'object'
      ? {
          gamerscore: {
            earned:
              typeof raw.gamerscore.earned === 'number' && Number.isFinite(raw.gamerscore.earned)
                ? raw.gamerscore.earned
                : 0,
            total:
              typeof raw.gamerscore.total === 'number' && Number.isFinite(raw.gamerscore.total)
                ? raw.gamerscore.total
                : 0,
          },
        }
      : {}),
    ...(raw.xp && typeof raw.xp === 'object'
      ? {
          xp: {
            earned:
              typeof raw.xp.earned === 'number' && Number.isFinite(raw.xp.earned)
                ? raw.xp.earned
                : 0,
            total:
              typeof raw.xp.total === 'number' && Number.isFinite(raw.xp.total)
                ? raw.xp.total
                : 0,
          },
        }
      : {}),
    isMastered,
    ...(typeof raw.lastUnlockedAt === 'string' && raw.lastUnlockedAt.trim()
      ? { lastUnlockedAt: raw.lastUnlockedAt.trim() }
      : {}),
    source: raw.source || defaultSource,
    ...(typeof raw.syncedAt === 'string' && raw.syncedAt.trim()
      ? { syncedAt: raw.syncedAt.trim() }
      : {}),
    ...(typeof raw.hasConflict === 'boolean' ? { hasConflict: raw.hasConflict } : {}),
    ...(typeof raw.conflictDetails === 'string' && raw.conflictDetails
      ? { conflictDetails: raw.conflictDetails }
      : {}),
  };
}

function normalizeStoreKey(
  storefrontId: AchievementSummaryStorefrontId,
  rawKey: string
): string | null {
  if (typeof rawKey !== 'string') return null;
  const trimmed = rawKey.trim();
  if (!trimmed) return null;
  if (storefrontId === 'steam') {
    const num = Number(trimmed);
    if (!Number.isFinite(num) || num <= 0) {
      return null;
    }
    return String(Math.trunc(num));
  }
  return trimmed.toLowerCase();
}

export class AchievementSummaryStore {
  private readonly slots: Record<AchievementSummaryStorefrontId, StoreSlotState> = {
    steam: createSlot('steam'),
    epic: createSlot('epic'),
    gog: createSlot('gog'),
    xbox: createSlot('xbox'),
  };
  private listenersAttached = false;

  private ensureListeners(): void {
    if (this.listenersAttached) return;
    if (typeof window === 'undefined' || typeof window.addEventListener !== 'function') return;
    this.listenersAttached = true;

    window.addEventListener('storage', (e: StorageEvent) => {
      for (const slot of Object.values(this.slots)) {
        if (e.key === null || e.key === slot.localStorageKey) {
          if (!slot.dirty) {
            slot.hydratedFromStorage = false;
            slot.rawRef = null;
          }
        }
      }
    });

    window.addEventListener('beforeunload', () => {
      this.flushAll();
    });
  }

  private sanitizeDictionary(
    storefrontId: AchievementSummaryStorefrontId,
    raw: unknown
  ): Record<string, StoreAchievementSummary> {
    const out: Record<string, StoreAchievementSummary> = {};
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      return out;
    }
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
      const normKey = normalizeStoreKey(storefrontId, k);
      if (!normKey) continue;
      const entry = normalizeStoredAchievementSummary(
        v as Partial<StoreAchievementSummary>,
        'local_client_cache'
      );
      if (entry) {
        out[normKey] = entry;
      }
    }
    return out;
  }

  private readSlotEntries(
    storefrontId: AchievementSummaryStorefrontId
  ): Record<string, StoreAchievementSummary> {
    this.ensureListeners();
    const slot = this.slots[storefrontId];

    // If there are unflushed in-memory mutations, return them directly without re-parsing storage.
    if (slot.dirty) {
      return slot.entries;
    }

    const storage = getSafeLocalStorage();
    if (!storage) {
      return slot.entries;
    }

    try {
      const raw = storage.getItem(slot.localStorageKey);
      if (slot.hydratedFromStorage && slot.storageRef === storage && raw === slot.rawRef) {
        // Adopt Blink ExternalString ref to preserve O(1) zero-parse repeated lookups
        slot.rawRef = raw;
        return slot.entries;
      }

      slot.storageRef = storage;
      slot.rawRef = raw;
      slot.hydratedFromStorage = true;

      if (!raw) {
        // Storage was cleared (or never written)
        if (slot.idbHydrationState !== 'done') {
          slot.entries = {};
        } else if (Object.keys(slot.entries).length === 0) {
          slot.entries = {};
        } else {
          // If localStorage was explicitly cleared (e.g. test reset or quota wipe after write),
          // drop stale RAM mirror when raw transitioned from non-null -> null.
          slot.entries = {};
        }
        return slot.entries;
      }

      const parsed: unknown = JSON.parse(raw);
      slot.entries = this.sanitizeDictionary(storefrontId, parsed);
      return slot.entries;
    } catch {
      slot.hydratedFromStorage = false;
      slot.rawRef = null;
      return slot.entries;
    }
  }

  private persistSlotToLocalStorage(
    slot: StoreSlotState,
    snapshot: Record<string, StoreAchievementSummary>
  ): void {
    const storage = getSafeLocalStorage();
    if (!storage) return;
    try {
      const serialized = JSON.stringify(snapshot);
      storage.setItem(slot.localStorageKey, serialized);
      slot.storageRef = storage;
      slot.rawRef = serialized;
      slot.hydratedFromStorage = true;
    } catch {
      // QuotaExceededError: full dictionary remains in memory and IndexedDB vault
      slot.storageRef = storage;
      slot.rawRef = null;
      slot.hydratedFromStorage = true;
    }
  }

  /**
   * Hydrates a storefront's summary dictionary from IndexedDB and merges it cleanly with any
   * in-memory / localStorage writes using `reconcileAchievementSummaries`.
   * Forms the hydration-before-write barrier so early writes never wipe existing IDB entries.
   */
  public hydrateFromVault(storefrontId: AchievementSummaryStorefrontId): Promise<void> {
    const slot = this.slots[storefrontId];
    if (slot.idbHydrationState === 'done') {
      return Promise.resolve();
    }
    if (slot.idbHydrationPromise) {
      return slot.idbHydrationPromise;
    }
    if (!isIndexedDbAvailable()) {
      slot.idbHydrationState = 'done';
      return Promise.resolve();
    }

    slot.idbHydrationState = 'pending';
    const capturedGen = slot.generation;

    let flight: Promise<void> | null = null;
    flight = (async (): Promise<void> => {
      try {
        const stored = await vaultGet<Record<string, StoreAchievementSummary>>(slot.idbKey);
        if (capturedGen !== slot.generation) {
          return;
        }

        const current = this.readSlotEntries(storefrontId);
        let mergedFromVault = false;

        if (stored && typeof stored === 'object' && !Array.isArray(stored)) {
          const cleanStored = this.sanitizeDictionary(storefrontId, stored);
          for (const [key, vaultEntry] of Object.entries(cleanStored)) {
            const existing = current[key];
            if (!existing) {
              current[key] = vaultEntry;
              mergedFromVault = true;
            } else {
              const reconciled = reconcileAchievementSummaries(vaultEntry, existing, {
                appId: storefrontId === 'steam' ? Number(key) : undefined,
                title: storefrontId !== 'steam' ? key : undefined,
                store: storefrontId,
              });
              if (reconciled) {
                current[key] = reconciled;
                if (
                  reconciled.unlocked !== existing.unlocked ||
                  reconciled.total !== existing.total ||
                  reconciled.lastUnlockedAt !== existing.lastUnlockedAt
                ) {
                  mergedFromVault = true;
                }
              }
            }
          }
        }

        slot.idbHydrationState = 'done';
        slot.entries = current;

        if (slot.pendingIdbWriteAfterHydration || mergedFromVault) {
          const shouldWriteIdb = slot.pendingIdbWriteAfterHydration;
          slot.pendingIdbWriteAfterHydration = false;
          const snapshot = { ...slot.entries };
          if (mergedFromVault) {
            this.persistSlotToLocalStorage(slot, snapshot);
          }
          if (shouldWriteIdb && Object.keys(snapshot).length > 0) {
            await vaultSet(slot.idbKey, snapshot);
          }
        }
      } catch {
        if (capturedGen === slot.generation) {
          slot.idbHydrationState = 'done';
          if (slot.pendingIdbWriteAfterHydration) {
            slot.pendingIdbWriteAfterHydration = false;
            const snapshot = { ...slot.entries };
            if (Object.keys(snapshot).length > 0) {
              void vaultSet(slot.idbKey, snapshot);
            }
          }
        }
      } finally {
        if (slot.idbHydrationPromise === flight) {
          slot.idbHydrationPromise = null;
        }
      }
    })();

    slot.idbHydrationPromise = flight;
    return flight;
  }

  public getAll(
    storefrontId: AchievementSummaryStorefrontId
  ): Record<string, StoreAchievementSummary> {
    if (isIndexedDbAvailable() && this.slots[storefrontId].idbHydrationState === 'idle') {
      void this.hydrateFromVault(storefrontId);
    }
    return this.readSlotEntries(storefrontId);
  }

  public get(
    storefrontId: AchievementSummaryStorefrontId,
    rawKey: string | number
  ): StoreAchievementSummary | undefined {
    const normKey = normalizeStoreKey(storefrontId, String(rawKey));
    if (!normKey) return undefined;
    const dict = this.getAll(storefrontId);
    return dict[normKey];
  }

  /**
   * Reconciles and stores a single entry in the unified storefront dictionary.
   */
  public set(
    storefrontId: AchievementSummaryStorefrontId,
    rawKey: string | number,
    summary: StoreAchievementSummary,
    options?: { immediate?: boolean; reconcile?: boolean }
  ): StoreAchievementSummary | null {
    const normKey = normalizeStoreKey(storefrontId, String(rawKey));
    if (!normKey) return null;

    const normalized = normalizeStoredAchievementSummary(summary, summary.source || 'local_client_cache');
    if (!normalized) return null;

    const slot = this.slots[storefrontId];
    const dict = this.readSlotEntries(storefrontId);
    const nextEntry =
      options?.reconcile === false
        ? normalized
        : reconcileAchievementSummaries(dict[normKey], normalized, {
            appId: storefrontId === 'steam' ? Number(normKey) : undefined,
            title: storefrontId !== 'steam' ? normKey : undefined,
            store: storefrontId,
          }) || normalized;

    dict[normKey] = nextEntry;
    slot.entries = dict;
    slot.dirty = true;

    if (options?.immediate) {
      this.flush(storefrontId);
    } else {
      this.scheduleFlush(storefrontId);
    }
    return nextEntry;
  }

  /**
   * Batch-merges a map of summaries into the unified storefront dictionary with reconciliation.
   */
  public mergeBatch(
    storefrontId: AchievementSummaryStorefrontId,
    entries: Record<string, StoreAchievementSummary>,
    options?: { immediate?: boolean }
  ): void {
    const slot = this.slots[storefrontId];
    const dict = this.readSlotEntries(storefrontId);
    let mutated = false;

    for (const [rawKey, inc] of Object.entries(entries)) {
      const normKey = normalizeStoreKey(storefrontId, rawKey);
      if (!normKey) continue;
      const normalized = normalizeStoredAchievementSummary(inc, inc.source || 'local_client_cache');
      if (!normalized) continue;

      dict[normKey] =
        reconcileAchievementSummaries(dict[normKey], normalized, {
          appId: storefrontId === 'steam' ? Number(normKey) : undefined,
          title: storefrontId !== 'steam' ? rawKey : undefined,
          store: storefrontId,
        }) || normalized;
      mutated = true;
    }

    if (!mutated) return;
    slot.entries = dict;
    slot.dirty = true;

    if (options?.immediate !== false) {
      this.flush(storefrontId);
    } else {
      this.scheduleFlush(storefrontId);
    }
  }

  private scheduleFlush(storefrontId: AchievementSummaryStorefrontId): void {
    const slot = this.slots[storefrontId];
    if (slot.pendingFlushTimer !== null) return;
    const delayMs = isTestEnv() ? TEST_SAVE_DEBOUNCE_MS : SAVE_DEBOUNCE_MS;
    slot.pendingFlushTimer = setTimeout(() => {
      slot.pendingFlushTimer = null;
      this.flush(storefrontId);
    }, delayMs);
  }

  public flush(storefrontId: AchievementSummaryStorefrontId): void {
    const slot = this.slots[storefrontId];
    if (slot.pendingFlushTimer !== null) {
      clearTimeout(slot.pendingFlushTimer);
      slot.pendingFlushTimer = null;
    }
    if (!slot.dirty) return;
    slot.dirty = false;

    const snapshot = { ...slot.entries };
    this.persistSlotToLocalStorage(slot, snapshot);

    if (isIndexedDbAvailable()) {
      if (slot.idbHydrationState === 'done') {
        void vaultSet(slot.idbKey, snapshot);
      } else {
        // Hydration-before-write barrier: defer IDB persistence until vault records are merged
        slot.pendingIdbWriteAfterHydration = true;
        void this.hydrateFromVault(storefrontId);
      }
    }
  }

  public flushAll(): void {
    for (const storefrontId of Object.keys(this.slots) as AchievementSummaryStorefrontId[]) {
      this.flush(storefrontId);
    }
  }

  /**
   * Clears in-memory, localStorage, and IndexedDB achievement summary caches for a storefront
   * (invoked on storefront disconnect / account switch).
   */
  public clearStorefront(storefrontId: AchievementSummaryStorefrontId): void {
    const slot = this.slots[storefrontId];
    slot.generation += 1;
    if (slot.pendingFlushTimer !== null) {
      clearTimeout(slot.pendingFlushTimer);
      slot.pendingFlushTimer = null;
    }
    slot.entries = {};
    slot.dirty = false;
    slot.rawRef = null;
    slot.hydratedFromStorage = true;
    slot.idbHydrationState = 'done';
    slot.idbHydrationPromise = null;
    slot.pendingIdbWriteAfterHydration = false;

    const storage = getSafeLocalStorage();
    if (storage) {
      try {
        storage.removeItem(slot.localStorageKey);
        if (storefrontId === 'steam') {
          storage.removeItem(STORAGE_KEY_STEAM_ACHIEVEMENTS_LAST_SYNC);
        }
      } catch {
        // Ignore restricted storage environments
      }
    }

    if (isIndexedDbAvailable()) {
      void vaultDelete(slot.idbKey);
    }
  }

  /**
   * Resets internal cache pointers for tests without wiping caller-seeded storage keys.
   */
  public resetForTests(storefrontId?: AchievementSummaryStorefrontId): void {
    const targets: AchievementSummaryStorefrontId[] = storefrontId
      ? [storefrontId]
      : ['steam', 'epic', 'gog', 'xbox'];
    for (const id of targets) {
      const slot = this.slots[id];
      slot.generation += 1;
      if (slot.pendingFlushTimer !== null) {
        clearTimeout(slot.pendingFlushTimer);
        slot.pendingFlushTimer = null;
      }
      slot.hydratedFromStorage = false;
      slot.storageRef = null;
      slot.rawRef = null;
      slot.entries = {};
      slot.dirty = false;
      slot.idbHydrationState = 'idle';
      slot.idbHydrationPromise = null;
      slot.pendingIdbWriteAfterHydration = false;
    }
  }
}

export const achievementSummaryStore = new AchievementSummaryStore();

/**
 * Clears in-memory, localStorage, and IndexedDB achievement summary caches for a storefront.
 */
export function clearStorefrontAchievementSummaries(
  storefrontId: AchievementSummaryStorefrontId
): void {
  achievementSummaryStore.clearStorefront(storefrontId);
}
