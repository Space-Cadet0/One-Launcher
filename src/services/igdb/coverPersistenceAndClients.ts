/**
 * Cover persistence (bounded LRU caches, debounced localStorage/IDB mirroring with
 * pagehide/beforeunload flush and synchronous test-mode flush) plus GOG v2 and Lutris
 * HTTP cover lookup clients routed through `buildDevProxyUrlForRoute` and `requestScheduler`.
 */

import { isWafOrChallengeResponse } from '../../contracts/network';
import { isTestEnv } from '../common/runtimeEnv';
import {
  decodeTitleHtmlEntities,
  stripStorefrontPlatformDisambiguators,
  stripTrademarkSymbols,
} from '../common/titleUtils';
import { buildDevProxyUrlForRoute } from '../network/browserDevProxy';
import { requestScheduler } from '../network/requestScheduler';
import { vaultDelete, vaultGet, vaultSet } from '../storage/indexedDbVault';
import { LutrisSearchItem, normalizeCacheKey, normalizeKey } from './coverTitleMatcher';
import {
  DeadSteamCoverRegistry,
  STORAGE_KEY_DEAD_STEAM_COVER_COUNTS,
  STORAGE_KEY_DEAD_STEAM_COVERS,
  STORAGE_KEY_DEAD_STEAM_HASHED_V2,
} from './deadSteamCoverRegistry';

export const STORAGE_KEY_IGDB_COVERS_V1 = 'antigravity_igdb_covers';
export const STORAGE_KEY_IGDB_COVERS = 'antigravity_igdb_covers_v2';
export const STORAGE_KEY_COVER_SCHEMA_MIGRATION = 'antigravity_igdb_covers_schema_v3';
export const STORAGE_KEY_GOG_BOXART = 'antigravity_gog_boxart_v1';
export const NEGATIVE_COVER_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
export const MAX_COVER_CACHE_ENTRIES = 2000;

const COVER_PERSIST_DEBOUNCE_MS = 300;
const YEAR_SUFFIX_KEY_RE = /^(.*):((?:19|20)\d{2})$/;
const COVER_FLUSH_CLEANUP_SYMBOL = Symbol.for('one_launcher_igdb_cover_flush_cleanup');

interface PersistedNegativeCoverRecord {
  url: null;
  cachedAt: number;
}

const activeFlushCallbacks = new Set<() => void>();
let flushLifecycleListenersAttached = false;

function ensureCoverFlushLifecycleListeners(): void {
  if (flushLifecycleListenersAttached) return;
  if (typeof window === 'undefined' || typeof window.addEventListener !== 'function') return;
  flushLifecycleListenersAttached = true;

  const host = globalThis as Record<symbol, (() => void) | undefined>;
  const prevCleanup = host[COVER_FLUSH_CLEANUP_SYMBOL];
  if (typeof prevCleanup === 'function') {
    try {
      prevCleanup();
    } catch {
      // Ignore cleanup errors
    }
  }

  const flushAllDirty = () => {
    for (const cb of Array.from(activeFlushCallbacks)) {
      try {
        cb();
      } catch {
        // Ignore individual flush errors
      }
    }
  };

  window.addEventListener('pagehide', flushAllDirty);
  window.addEventListener('beforeunload', flushAllDirty);
  host[COVER_FLUSH_CLEANUP_SYMBOL] = () => {
    window.removeEventListener('pagehide', flushAllDirty);
    window.removeEventListener('beforeunload', flushAllDirty);
  };
}

export class CoverCacheStore {
  public readonly cache = new Map<string, string | null>();
  public readonly negativeTimestamps = new Map<string, number>();
  public readonly gogBoxArtCache = new Map<string, string | null>();
  public readonly gogNegativeTimestamps = new Map<string, number>();
  private readonly normToYearKeys = new Map<string, Set<string>>();
  private persistDebounceTimer: ReturnType<typeof setTimeout> | null = null;
  private dirty = false;

  private readonly flushIfDirtyCallback = () => {
    if (this.dirty) {
      this.flushPersistentCacheNow();
    }
  };

  public getPositiveYearKeysForNorm(norm: string): ReadonlySet<string> | undefined {
    return this.normToYearKeys.get(norm);
  }

  private indexYearKey(key: string, val: string | null): void {
    const match = YEAR_SUFFIX_KEY_RE.exec(key);
    if (!match) return;
    const baseNorm = match[1];
    if (typeof val === 'string' && val) {
      let set = this.normToYearKeys.get(baseNorm);
      if (!set) {
        set = new Set<string>();
        this.normToYearKeys.set(baseNorm, set);
      }
      set.add(key);
    } else {
      const set = this.normToYearKeys.get(baseNorm);
      if (set) {
        set.delete(key);
        if (set.size === 0) {
          this.normToYearKeys.delete(baseNorm);
        }
      }
    }
  }

  private unindexYearKey(key: string): void {
    const match = YEAR_SUFFIX_KEY_RE.exec(key);
    if (!match) return;
    const baseNorm = match[1];
    const set = this.normToYearKeys.get(baseNorm);
    if (set) {
      set.delete(key);
      if (set.size === 0) {
        this.normToYearKeys.delete(baseNorm);
      }
    }
  }

  public setCoverCacheBounded(key: string, val: string | null): void {
    if (this.cache.has(key)) {
      this.cache.delete(key);
    }
    this.cache.set(key, val);
    this.indexYearKey(key, val);
    while (this.cache.size > MAX_COVER_CACHE_ENTRIES) {
      const oldest = this.cache.keys().next().value;
      if (oldest === undefined) break;
      this.deleteCoverKey(oldest);
    }
  }

  public deleteCoverKey(key: string): void {
    this.cache.delete(key);
    this.negativeTimestamps.delete(key);
    this.unindexYearKey(key);
  }

  public setGogCacheBounded(key: string, val: string | null): void {
    if (this.gogBoxArtCache.has(key)) {
      this.gogBoxArtCache.delete(key);
    }
    this.gogBoxArtCache.set(key, val);
    while (this.gogBoxArtCache.size > MAX_COVER_CACHE_ENTRIES) {
      const oldest = this.gogBoxArtCache.keys().next().value;
      if (oldest === undefined) break;
      this.gogBoxArtCache.delete(oldest);
      this.gogNegativeTimestamps.delete(oldest);
    }
  }

  public cancelPendingSave(): void {
    if (this.persistDebounceTimer) {
      clearTimeout(this.persistDebounceTimer);
      this.persistDebounceTimer = null;
    }
    this.dirty = false;
    activeFlushCallbacks.delete(this.flushIfDirtyCallback);
  }

  public flushPersistentCacheNow(): void {
    this.cancelPendingSave();

    const obj: Record<string, string | PersistedNegativeCoverRecord> = {};
    for (const [k, v] of this.cache.entries()) {
      if (typeof v === 'string' && v) {
        obj[k] = v;
      } else if (v === null) {
        obj[k] = { url: null, cachedAt: this.negativeTimestamps.get(k) || Date.now() };
      }
    }
    const gogObj: Record<string, string | PersistedNegativeCoverRecord> = {};
    for (const [k, v] of this.gogBoxArtCache.entries()) {
      if (typeof v === 'string' && v) {
        gogObj[k] = v;
      } else if (v === null) {
        gogObj[k] = { url: null, cachedAt: this.gogNegativeTimestamps.get(k) || Date.now() };
      }
    }
    void vaultSet(STORAGE_KEY_IGDB_COVERS, obj);
    void vaultSet(STORAGE_KEY_GOG_BOXART, gogObj);
    if (typeof localStorage === 'undefined') return;
    try {
      localStorage.setItem(STORAGE_KEY_IGDB_COVERS, JSON.stringify(obj));
      localStorage.setItem(STORAGE_KEY_GOG_BOXART, JSON.stringify(gogObj));
    } catch {
      // Ignore storage write error; IndexedDB vault retains full cache
    }
  }

  public savePersistentCache(immediate = false): void {
    if (immediate || isTestEnv()) {
      this.flushPersistentCacheNow();
      return;
    }

    ensureCoverFlushLifecycleListeners();
    this.dirty = true;
    activeFlushCallbacks.add(this.flushIfDirtyCallback);
    if (this.persistDebounceTimer) {
      clearTimeout(this.persistDebounceTimer);
    }
    this.persistDebounceTimer = setTimeout(() => {
      this.persistDebounceTimer = null;
      this.flushPersistentCacheNow();
    }, COVER_PERSIST_DEBOUNCE_MS);
    if (
      this.persistDebounceTimer &&
      typeof this.persistDebounceTimer === 'object' &&
      'unref' in this.persistDebounceTimer &&
      typeof this.persistDebounceTimer.unref === 'function'
    ) {
      this.persistDebounceTimer.unref();
    }
  }

  public clear(): void {
    this.cancelPendingSave();
    this.cache.clear();
    this.negativeTimestamps.clear();
    this.normToYearKeys.clear();
    this.gogBoxArtCache.clear();
    this.gogNegativeTimestamps.clear();

    void vaultDelete(STORAGE_KEY_IGDB_COVERS);
    void vaultDelete(STORAGE_KEY_GOG_BOXART);
    if (typeof localStorage !== 'undefined') {
      try {
        localStorage.removeItem(STORAGE_KEY_IGDB_COVERS);
        localStorage.removeItem(STORAGE_KEY_GOG_BOXART);
      } catch {
        // Ignore storage errors
      }
    }
  }

  public evictForGame(title?: string, gogId?: string | number | null): void {
    if (gogId !== undefined && gogId !== null && gogId !== '') {
      const cleanId = String(gogId).replace(/^gog-/, '').trim();
      if (cleanId) {
        this.gogBoxArtCache.delete(`id:${cleanId}`);
        this.gogNegativeTimestamps.delete(`id:${cleanId}`);
      }
    }

    if (title && title.trim()) {
      const norm = normalizeKey(title);
      const lower = title.trim().toLowerCase();
      this.gogBoxArtCache.delete(`title:${norm}`);
      for (const k of Array.from(this.cache.keys())) {
        if (k === norm || k === lower || k.startsWith(`${norm}:`)) {
          this.deleteCoverKey(k);
        }
      }
    }

    this.savePersistentCache(true);
  }

  public loadPersistentCache(
    deadSteamRegistry: DeadSteamCoverRegistry,
    isUnsuitableCoverUrl: (url?: string | null) => boolean
  ): void {
    if (typeof localStorage === 'undefined') return;
    try {
      const hasMigratedSchemaV3 =
        localStorage.getItem(STORAGE_KEY_COVER_SCHEMA_MIGRATION) === '1';
      let needsSaveAfterMigration = false;

      // 1. Migrate positive covers from legacy v1 key ('antigravity_igdb_covers') with bounded LRU enforcement
      const rawV1 = localStorage.getItem(STORAGE_KEY_IGDB_COVERS_V1);
      if (rawV1) {
        try {
          const parsedV1: unknown = JSON.parse(rawV1);
          if (parsedV1 && typeof parsedV1 === 'object' && !Array.isArray(parsedV1)) {
            for (const [k, v] of Object.entries(parsedV1 as Record<string, unknown>)) {
              const nk = normalizeCacheKey(k);
              if (typeof v === 'string' && v.trim() && !isUnsuitableCoverUrl(v)) {
                this.setCoverCacheBounded(nk, v);
                needsSaveAfterMigration = true;
              }
            }
          }
        } catch {
          // Ignore malformed v1 cache
        }
      }

      // 2. Load v2 IGDB cover cache (purging false negatives once on schema v3 migration)
      const raw = localStorage.getItem(STORAGE_KEY_IGDB_COVERS);
      if (raw) {
        const parsed: unknown = JSON.parse(raw);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
            const nk = normalizeCacheKey(k);
            if (typeof v === 'string' && v.trim() && !isUnsuitableCoverUrl(v)) {
              this.setCoverCacheBounded(nk, v);
            } else if (v && typeof v === 'object' && (v as { url?: unknown }).url === null) {
              if (hasMigratedSchemaV3 && !this.cache.has(nk)) {
                const cachedAt = Number((v as { cachedAt?: unknown }).cachedAt || 0);
                if (cachedAt > 0 && Date.now() - cachedAt < NEGATIVE_COVER_TTL_MS) {
                  this.setCoverCacheBounded(nk, null);
                  this.negativeTimestamps.set(nk, cachedAt);
                }
              } else {
                needsSaveAfterMigration = true;
              }
            }
          }
        }
      }

      // 3. Load GOG boxArt cache (purging outage negatives once on schema v3 migration)
      const rawGog = localStorage.getItem(STORAGE_KEY_GOG_BOXART);
      if (rawGog) {
        const parsedGog: unknown = JSON.parse(rawGog);
        if (parsedGog && typeof parsedGog === 'object' && !Array.isArray(parsedGog)) {
          for (const [k, v] of Object.entries(parsedGog as Record<string, unknown>)) {
            if (typeof v === 'string' && v.trim() && !isUnsuitableCoverUrl(v)) {
              this.setGogCacheBounded(k, v);
            } else if (v && typeof v === 'object' && (v as { url?: unknown }).url === null) {
              if (hasMigratedSchemaV3) {
                const cachedAt = Number((v as { cachedAt?: unknown }).cachedAt || 0);
                if (cachedAt > 0 && Date.now() - cachedAt < NEGATIVE_COVER_TTL_MS) {
                  this.setGogCacheBounded(k, null);
                  this.gogNegativeTimestamps.set(k, cachedAt);
                }
              } else {
                needsSaveAfterMigration = true;
              }
            }
          }
        }
      }

      if (!hasMigratedSchemaV3) {
        localStorage.setItem(STORAGE_KEY_COVER_SCHEMA_MIGRATION, '1');
        if (needsSaveAfterMigration) {
          this.savePersistentCache(true);
        }
      }

      // 4 & 5. Load dead Steam unhashed & SHA1-hashed cover registries
      deadSteamRegistry.loadFromLocalStorage();
    } catch {
      // Ignore storage read error
    }
  }

  public async hydrateFromVault(
    deadSteamRegistry: DeadSteamCoverRegistry,
    getCacheGeneration: () => number,
    isUnsuitableCoverUrl: (url?: string | null) => boolean
  ): Promise<void> {
    if (typeof window === 'undefined') return;
    const gen = getCacheGeneration();
    try {
      const [vaultCovers, vaultGog, vaultDeadSteam, vaultDeadCounts, vaultDeadHashed] =
        await Promise.all([
          vaultGet<Record<string, unknown>>(STORAGE_KEY_IGDB_COVERS),
          vaultGet<Record<string, unknown>>(STORAGE_KEY_GOG_BOXART),
          vaultGet<Record<string, unknown>>(STORAGE_KEY_DEAD_STEAM_COVERS),
          vaultGet<Record<string, unknown>>(STORAGE_KEY_DEAD_STEAM_COVER_COUNTS),
          vaultGet<Record<string, unknown>>(STORAGE_KEY_DEAD_STEAM_HASHED_V2),
        ]);
      if (gen !== getCacheGeneration()) return;

      if (vaultCovers && typeof vaultCovers === 'object' && !Array.isArray(vaultCovers)) {
        for (const [k, v] of Object.entries(vaultCovers)) {
          const nk = normalizeCacheKey(k);
          const existing = this.cache.get(nk);
          if (typeof existing === 'string' && existing) continue;
          if (typeof v === 'string' && v.trim() && !isUnsuitableCoverUrl(v)) {
            this.setCoverCacheBounded(nk, v);
            this.negativeTimestamps.delete(nk);
          } else if (v && typeof v === 'object' && (v as { url?: unknown }).url === null) {
            const cachedAt = Number((v as { cachedAt?: unknown }).cachedAt || 0);
            const existingNegTs = this.negativeTimestamps.get(nk) || 0;
            if (cachedAt > existingNegTs && Date.now() - cachedAt < NEGATIVE_COVER_TTL_MS) {
              this.setCoverCacheBounded(nk, null);
              this.negativeTimestamps.set(nk, cachedAt);
            }
          }
        }
      }

      if (vaultGog && typeof vaultGog === 'object' && !Array.isArray(vaultGog)) {
        for (const [k, v] of Object.entries(vaultGog)) {
          const existing = this.gogBoxArtCache.get(k);
          if (typeof existing === 'string' && existing) continue;
          if (typeof v === 'string' && v.trim() && !isUnsuitableCoverUrl(v)) {
            this.setGogCacheBounded(k, v);
            this.gogNegativeTimestamps.delete(k);
          } else if (v && typeof v === 'object' && (v as { url?: unknown }).url === null) {
            const cachedAt = Number((v as { cachedAt?: unknown }).cachedAt || 0);
            const existingNegTs = this.gogNegativeTimestamps.get(k) || 0;
            if (cachedAt > existingNegTs && Date.now() - cachedAt < NEGATIVE_COVER_TTL_MS) {
              this.setGogCacheBounded(k, null);
              this.gogNegativeTimestamps.set(k, cachedAt);
            }
          }
        }
      }

      deadSteamRegistry.hydrateFromVault(vaultDeadSteam, vaultDeadCounts, vaultDeadHashed);
    } catch {
      // Ignore vault read errors
    }
  }
}

export async function fetchGogBoxArtImage(
  cleanId: string,
  priority: number,
  isUnsuitableCoverUrl: (url?: string | null) => boolean
): Promise<{ receivedDefinitiveResponse: boolean; boxArtUrl: string | null }> {
  let receivedDefinitiveResponse = false;
  try {
    const url = buildDevProxyUrlForRoute('gogProduct', `/v2/games/${encodeURIComponent(cleanId)}`);

    const res = await requestScheduler.schedule(
      url,
      () =>
        fetch(url, {
          headers: { Accept: 'application/json' },
          signal:
            typeof AbortSignal !== 'undefined' && 'timeout' in AbortSignal
              ? AbortSignal.timeout(4500)
              : undefined,
        }),
      priority,
      'catalog.gog.com'
    );

    if (res && res.ok && !isWafOrChallengeResponse(res.status, '')) {
      receivedDefinitiveResponse = true;
      const data: unknown = await res.json();
      const boxArt = (
        data as { _links?: { boxArtImage?: { href?: unknown } } } | null | undefined
      )?._links?.boxArtImage?.href;
      if (boxArt && typeof boxArt === 'string' && !isUnsuitableCoverUrl(boxArt)) {
        const normalizedUrl = boxArt.startsWith('//') ? `https:${boxArt}` : boxArt;
        return { receivedDefinitiveResponse: true, boxArtUrl: normalizedUrl };
      }
    } else if (res && res.status === 404 && !isWafOrChallengeResponse(res.status, '')) {
      receivedDefinitiveResponse = true;
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err || '');
    console.warn('[IgdbCoverService] GOG v2 boxArtImage fetch error:', cleanId, msg);
  }

  return { receivedDefinitiveResponse, boxArtUrl: null };
}

export async function fetchLutrisCoverItems(
  cleanRaw: string,
  priority: number,
  schedulerGameKey: string
): Promise<{ receivedOkResponse: boolean; items: LutrisSearchItem[] }> {
  let receivedOkResponse = false;
  try {
    const query = stripStorefrontPlatformDisambiguators(
      stripTrademarkSymbols(decodeTitleHtmlEntities(cleanRaw))
    )
      .replace(/[\u2018\u2019\u02BC]/g, "'")
      .replace(/[:\-–—_]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();

    const searchUrl = buildDevProxyUrlForRoute(
      'lutris',
      `/api/games?search=${encodeURIComponent(query)}`
    );

    const res = await requestScheduler.schedule(
      searchUrl,
      () =>
        fetch(searchUrl, {
          headers: {
            Accept: 'application/json, text/plain, */*',
          },
          signal:
            typeof AbortSignal !== 'undefined' && 'timeout' in AbortSignal
              ? AbortSignal.timeout(4500)
              : undefined,
        }),
      priority,
      'lutris.net',
      schedulerGameKey
    );

    if (res && res.ok && !isWafOrChallengeResponse(res.status, '')) {
      receivedOkResponse = true;
      const data: unknown = await res.json();
      const rawResults =
        data &&
        typeof data === 'object' &&
        Array.isArray((data as { results?: unknown }).results)
          ? ((data as { results: unknown[] }).results as LutrisSearchItem[])
          : [];
      return { receivedOkResponse: true, items: rawResults };
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn('Dynamic IGDB cover fetch error for', cleanRaw, msg);
  }

  return { receivedOkResponse, items: [] };
}
