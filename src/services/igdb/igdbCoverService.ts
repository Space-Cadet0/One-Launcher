/**
 * IGDB Cover Art Service (Facade)
 *
 * Provides instantaneous resolution, URL-kind-aware dead Steam cover tracking,
 * GOG v2 portrait box-art lookup, and dynamic Lutris/IGDB fallback with sequel
 * and reboot year-collision isolation.
 */

import { unwrapOlMediaUrl } from '../../contracts/network';
import { stripTrailingDelimitedReleaseYear } from '../common/titleUtils';
import { requestScheduler, Priority } from '../network/requestScheduler';
import { onlineLifecycleManager } from '../network/onlineLifecycleManager';
import { syncJobManager } from '../network/syncJobManager';
import {
  buildSteamPortraitCoverUrls,
  parseSteamLibraryCoverUrl,
} from './steamCoverUrlBuilder';
import {
  extractGogImageHash,
  hasUnsuitableCoverUrlPattern,
  isGogCroppedHorizontalCover,
  isUnsuitableHeaderUrl,
} from './coverUrlClassifier';
import {
  computeTokenSimilarity,
  extractTitleExplicitReleaseYear,
  isNumberedBaseTitleSubtitleMatch,
  normalizeCacheKey,
  normalizeKey,
  parseExplicitReleaseYear,
  resolveCoverCacheKeys,
  selectBestLutrisCover,
} from './coverTitleMatcher';
import {
  DeadSteamCoverRegistry,
  KNOWN_DEAD_STEAM_COVER_APP_IDS,
} from './deadSteamCoverRegistry';
import {
  CoverCacheStore,
  NEGATIVE_COVER_TTL_MS,
  fetchGogBoxArtImage,
  fetchLutrisCoverItems,
} from './coverPersistenceAndClients';

export {
  KNOWN_DEAD_STEAM_COVER_APP_IDS,
  buildSteamPortraitCoverUrls,
  extractGogImageHash,
  isGogCroppedHorizontalCover,
  isUnsuitableHeaderUrl,
  normalizeKey,
  normalizeCacheKey,
  isNumberedBaseTitleSubtitleMatch,
  computeTokenSimilarity,
};

export const KNOWN_IGDB_COVERS: Record<string, string> = {};

export function isKnownDeadSteamCover(appId?: number | null): boolean {
  if (!appId || appId <= 0) return false;
  igdbCoverService.ensureInitialized();
  return igdbCoverService.isKnownDeadUnhashedSteamCover(appId);
}

/**
 * Checks whether an unhashed Steam cover AppID has an expired dead record eligible for
 * stale-while-revalidate (SWR) background re-probing.
 */
export function isExpiredDeadSteamUnhashed(appId?: number | null): boolean {
  if (!appId || appId <= 0) return false;
  igdbCoverService.ensureInitialized();
  return igdbCoverService.isExpiredDeadSteamUnhashed(appId);
}

/**
 * Schedules a deduplicated idle background HEAD/status re-probe for an expired dead unhashed Steam cover.
 */
export function scheduleExpiredDeadSteamReprobe(appId: number): void {
  igdbCoverService.scheduleExpiredDeadSteamReprobe(appId);
}

/**
 * O(1) URL-kind-aware dead Steam cover check.
 * - Unhashed `/apps/<id>/library_600x900*.jpg` (or `library_capsule*.jpg`) checks `KNOWN_DEAD_STEAM_COVER_APP_IDS`.
 * - 40-char SHA1-hashed `/apps/<id>/<40-hex>/library_*` checks the isolated SHA1 dead registry,
 *   so an unhashed 404 NEVER poisons a SHA1-hashed cover and vice versa.
 */
export function isDeadSteamCoverUrl(url?: string | null): boolean {
  if (!url) return false;
  igdbCoverService.ensureInitialized();
  const parsed = parseSteamLibraryCoverUrl(url);
  if (!parsed) return false;
  if (parsed.sha1) {
    return igdbCoverService.isKnownDeadHashedSteamCover(parsed.appId, parsed.sha1);
  }
  return igdbCoverService.isKnownDeadUnhashedSteamCover(parsed.appId);
}

/**
 * Checks whether an image URL represents an unsuitable horizontal banner,
 * wide capsule, server-cropped horizontal GOG banner, or dead Steam asset
 * that should not be displayed in a 2:3 portrait card.
 */
export function isUnsuitableCoverUrl(url?: string | null): boolean {
  if (!url) return true;
  const raw = unwrapOlMediaUrl(url.trim()).trim();
  if (!raw) return true;
  if (hasUnsuitableCoverUrlPattern(raw)) {
    return true;
  }
  if (isDeadSteamCoverUrl(raw)) {
    return true;
  }
  return false;
}

export class IgdbCoverService {
  private readonly store = new CoverCacheStore();
  private readonly deadSteamRegistry: DeadSteamCoverRegistry;
  private readonly pendingFetches = new Map<string, Promise<string | null>>();
  private initialized = false;
  private cacheGeneration = 0;

  constructor() {
    this.deadSteamRegistry = new DeadSteamCoverRegistry(
      () => this.ensureInitialized(),
      () => this.cacheGeneration
    );

    // Lazily hydrated on first lookup via ensureInitialized() to avoid synchronous constructor localStorage scans
    try {
      onlineLifecycleManager.onOnline(() => {
        this.deadSteamRegistry.resetBurstCircuitBreaker();
      });
    } catch {
      // Ignore partial environments in unit tests
    }
  }

  public ensureInitialized(): void {
    if (this.initialized) return;
    this.initialized = true;
    this.loadPersistentCache();
    void this.store.hydrateFromVault(
      this.deadSteamRegistry,
      () => this.cacheGeneration,
      isUnsuitableCoverUrl
    );
  }

  private loadPersistentCache(): void {
    this.store.loadPersistentCache(this.deadSteamRegistry, isUnsuitableCoverUrl);
  }

  public isKnownDeadUnhashedSteamCover(appId: number): boolean {
    return this.deadSteamRegistry.isKnownDeadUnhashedSteamCover(appId);
  }

  public isExpiredDeadSteamUnhashed(appId: number): boolean {
    return this.deadSteamRegistry.isExpiredDeadSteamUnhashed(appId);
  }

  public isKnownDeadHashedSteamCover(appId: number, sha1: string): boolean {
    return this.deadSteamRegistry.isKnownDeadHashedSteamCover(appId, sha1);
  }

  public getDeadSteamFailureCount(appId: number): number {
    return this.deadSteamRegistry.getDeadSteamFailureCount(appId);
  }

  public isDeadSteamBurstCircuitOpen(): boolean {
    return this.deadSteamRegistry.isDeadSteamBurstCircuitOpen();
  }

  public clearCache(): void {
    this.cacheGeneration += 1;
    this.initialized = true;
    this.pendingFetches.clear();
    this.store.clear();
    this.deadSteamRegistry.clear();
  }

  public evictCacheForGame(
    title?: string,
    gogId?: string | number | null,
    steamAppId?: number | null
  ): void {
    this.ensureInitialized();
    if (steamAppId && steamAppId > 0) {
      this.deadSteamRegistry.evictAppId(steamAppId);
    }
    this.store.evictForGame(title, gogId);
  }

  public recordDeadSteamCover(
    appId?: number | null,
    options?: { verified404?: boolean }
  ): void {
    this.deadSteamRegistry.recordDeadSteamCover(appId, options);
  }

  public scheduleExpiredDeadSteamReprobe(appId: number): void {
    this.deadSteamRegistry.scheduleExpiredDeadSteamReprobe(appId);
  }

  public verifyAndRecordDeadSteamCover(appId: number, failedUrl?: string): Promise<boolean> {
    return this.deadSteamRegistry.verifyAndRecordDeadSteamCover(appId, failedUrl);
  }

  /**
   * Checks whether a GOG vertical cover lookup has already been attempted (positively or negatively within TTL).
   */
  public hasAttemptedGogVerticalCover(gogId?: string | number | null, title?: string): boolean {
    this.ensureInitialized();
    const cleanId = String(gogId || '').replace(/^gog-/, '').trim();
    if (cleanId && this.store.gogBoxArtCache.has(`id:${cleanId}`)) {
      const val = this.store.gogBoxArtCache.get(`id:${cleanId}`);
      if (typeof val === 'string' && val) return true;
      const ts = this.store.gogNegativeTimestamps.get(`id:${cleanId}`);
      if (!ts || Date.now() - ts < NEGATIVE_COVER_TTL_MS) return true;
      this.store.gogBoxArtCache.delete(`id:${cleanId}`);
      this.store.gogNegativeTimestamps.delete(`id:${cleanId}`);
    }
    if (title && title.trim()) {
      const norm = normalizeKey(title);
      if (
        this.store.gogBoxArtCache.has(`title:${norm}`) &&
        typeof this.store.gogBoxArtCache.get(`title:${norm}`) === 'string'
      ) {
        return true;
      }
    }
    return false;
  }

  /**
   * Instant synchronous lookup for GOG's official 2:3 vertical boxArtImage (`_links.boxArtImage.href`).
   */
  getGogVerticalCoverInstant(gogId?: string | number | null, title?: string): string | null {
    this.ensureInitialized();
    if (gogId !== undefined && gogId !== null && gogId !== '') {
      const cleanId = String(gogId).replace(/^gog-/, '').trim();
      if (cleanId && this.store.gogBoxArtCache.has(`id:${cleanId}`)) {
        return this.store.gogBoxArtCache.get(`id:${cleanId}`) || null;
      }
    }
    if (title && title.trim()) {
      const norm = normalizeKey(title);
      if (this.store.gogBoxArtCache.has(`title:${norm}`)) {
        return this.store.gogBoxArtCache.get(`title:${norm}`) || null;
      }
    }
    return null;
  }

  /**
   * Resolves GOG's true 2:3 vertical portrait cover (`_links.boxArtImage.href`) from GOG's v2 games API.
   */
  async fetchGogVerticalCover(
    gogId: string | number,
    title?: string,
    priority: number = Priority.P1_VIEWPORT
  ): Promise<string | null> {
    const cleanId = String(gogId || '').replace(/^gog-/, '').trim();
    if (!cleanId || !/^\d+$/.test(cleanId)) return null;

    if (this.hasAttemptedGogVerticalCover(cleanId, title)) {
      return this.getGogVerticalCoverInstant(cleanId, title);
    }

    if (!onlineLifecycleManager.isOnline()) {
      return this.getGogVerticalCoverInstant(cleanId, title);
    }

    const cacheKey = `gog-boxart:${cleanId}`;
    const existing = this.pendingFetches.get(cacheKey);
    if (existing) {
      return existing;
    }

    const gen = this.cacheGeneration;

    const executeGogLookup = async (): Promise<string | null> => {
      const { receivedDefinitiveResponse, boxArtUrl } = await fetchGogBoxArtImage(
        cleanId,
        priority,
        isUnsuitableCoverUrl
      );
      if (gen !== this.cacheGeneration) {
        return null;
      }

      if (boxArtUrl) {
        this.store.setGogCacheBounded(`id:${cleanId}`, boxArtUrl);
        if (title && title.trim()) {
          this.store.setGogCacheBounded(`title:${normalizeKey(title)}`, boxArtUrl);
        }
        this.store.savePersistentCache();
        if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
          window.dispatchEvent(
            new CustomEvent('antigravity:gog-cover-updated', {
              detail: { gogId: cleanId, title, coverUrl: boxArtUrl },
            })
          );
        }
        return boxArtUrl;
      }

      if (receivedDefinitiveResponse && onlineLifecycleManager.isOnline()) {
        const now = Date.now();
        this.store.setGogCacheBounded(`id:${cleanId}`, null);
        this.store.gogNegativeTimestamps.set(`id:${cleanId}`, now);
        this.store.savePersistentCache();
      }
      return null;
    };

    const p = executeGogLookup();
    this.pendingFetches.set(cacheKey, p);
    try {
      return await p;
    } finally {
      if (this.pendingFetches.get(cacheKey) === p) {
        this.pendingFetches.delete(cacheKey);
      }
    }
  }

  /**
   * Checks whether an IGDB cover lookup for (title, releaseYear) has already been attempted
   * (either resolved positively or cached negatively within TTL).
   */
  public hasAttemptedIgdbCover(title?: string, releaseYear?: number | string | null): boolean {
    if (!title || !title.trim()) return true;
    this.ensureInitialized();
    const { cleanRaw, norm, effectiveReleaseYear, cacheKey } = resolveCoverCacheKeys(
      title,
      releaseYear
    );

    if (this.store.cache.has(cacheKey)) {
      const val = this.store.cache.get(cacheKey);
      if (typeof val === 'string' && val) return true;
      const ts = this.store.negativeTimestamps.get(cacheKey);
      if (!ts || Date.now() - ts < NEGATIVE_COVER_TTL_MS) return true;
      this.store.deleteCoverKey(cacheKey);
    }

    if (effectiveReleaseYear === null) {
      if (this.getIgdbCoverInstant(cleanRaw)) return true;
      if (this.store.cache.has(norm)) {
        const val = this.store.cache.get(norm);
        if (typeof val === 'string' && val) return true;
        const ts = this.store.negativeTimestamps.get(norm);
        if (!ts || Date.now() - ts < NEGATIVE_COVER_TTL_MS) return true;
        this.store.deleteCoverKey(norm);
      }
    }

    return false;
  }

  /**
   * Fast synchronous lookup against local storage and in-memory cover caches.
   * Respects explicit release years (from `releaseYear` param or delimited title year)
   * to prevent reboot collisions (e.g., "Prey (2006)" never receives "Prey (2017)").
   */
  getIgdbCoverInstant(
    title?: string,
    steamAppId?: number,
    gameId?: string,
    releaseYear?: number | string | null
  ): string | null {
    if (!title && !steamAppId && !gameId) return null;
    this.ensureInitialized();

    if (title) {
      const cleanRaw = title.trim();
      const lower = cleanRaw.toLowerCase();
      const norm = normalizeKey(cleanRaw);
      const paramYear = parseExplicitReleaseYear(releaseYear);
      const titleExplicitYear = extractTitleExplicitReleaseYear(cleanRaw);
      const effectiveYear = paramYear ?? titleExplicitYear;

      if (effectiveYear !== null) {
        const yearKey = `${norm}:${effectiveYear}`;
        if (this.store.cache.has(yearKey)) {
          return this.store.cache.get(yearKey) || null;
        }
        const strippedBase = normalizeKey(stripTrailingDelimitedReleaseYear(cleanRaw));
        if (strippedBase && strippedBase !== norm) {
          const strippedYearKey = `${strippedBase}:${effectiveYear}`;
          if (this.store.cache.has(strippedYearKey)) {
            return this.store.cache.get(strippedYearKey) || null;
          }
        }
        if (this.store.cache.has(lower)) {
          return this.store.cache.get(lower) || null;
        }
        // Never return a mismatched year's cover when title contains an explicit year (e.g. "Prey (2006)")
        // or when any year-qualified entry exists for this normalized title.
        const knownYearKeys = this.store.getPositiveYearKeysForNorm(norm);
        if (titleExplicitYear !== null || (knownYearKeys && knownYearKeys.size > 0)) {
          return null;
        }
        if (this.store.cache.has(norm)) {
          return this.store.cache.get(norm) || null;
        }
      } else {
        if (this.store.cache.has(norm)) {
          return this.store.cache.get(norm) || null;
        }
        if (this.store.cache.has(lower)) {
          return this.store.cache.get(lower) || null;
        }
        // Single unambiguous year fallback for callers that omit releaseYear:
        // only returns when exactly 1 positive year entry exists (zero reboot collision).
        const knownYearKeys = this.store.getPositiveYearKeysForNorm(norm);
        if (knownYearKeys && knownYearKeys.size === 1) {
          const onlyKey = knownYearKeys.values().next().value;
          if (onlyKey) {
            return this.store.cache.get(onlyKey) || null;
          }
        }
      }
    }

    if (gameId) {
      const cleanId = gameId.trim();
      const lowerId = cleanId.toLowerCase();
      const normId = normalizeKey(cleanId);

      if (this.store.cache.has(normId)) {
        return this.store.cache.get(normId) || null;
      }
      if (this.store.cache.has(lowerId)) {
        return this.store.cache.get(lowerId) || null;
      }
    }

    return null;
  }

  /**
   * Asynchronous dynamic lookup against IGDB/Lutris metadata.
   * Caches results persistently under year-isolated keys and dispatches an update event.
   */
  async fetchIgdbCover(
    title: string,
    releaseYear?: number | string | null,
    priority: number = Priority.P2_BACKGROUND,
    options?: { trackInGlobalBar?: boolean }
  ): Promise<string | null> {
    if (!title || !title.trim()) return null;
    this.ensureInitialized();
    const { cleanRaw, norm, effectiveReleaseYear, cacheKey } = resolveCoverCacheKeys(
      title,
      releaseYear
    );
    const schedulerGameKey = `cover:${cacheKey}`;

    // Short-circuit both positive and valid negative cache hits before scheduling or tracking any task
    if (this.hasAttemptedIgdbCover(cleanRaw, releaseYear)) {
      if (this.store.cache.has(cacheKey)) {
        return this.store.cache.get(cacheKey) ?? null;
      }
      if (effectiveReleaseYear === null) {
        return this.getIgdbCoverInstant(cleanRaw);
      }
      return null;
    }

    if (!onlineLifecycleManager.isOnline()) {
      return this.getIgdbCoverInstant(cleanRaw, undefined, undefined, effectiveReleaseYear);
    }

    // Deduplicate in-flight requests
    const existingPending = this.pendingFetches.get(cacheKey);
    if (existingPending) {
      if (priority === Priority.P0_INTERACTIVE) {
        requestScheduler.promoteToInteractive(schedulerGameKey);
      }
      return existingPending;
    }

    const gen = this.cacheGeneration;

    const executeLookup = async (): Promise<string | null> => {
      const { receivedOkResponse, items } = await fetchLutrisCoverItems(
        cleanRaw,
        priority,
        schedulerGameKey
      );
      if (gen !== this.cacheGeneration) {
        return null;
      }

      if (receivedOkResponse && items.length > 0) {
        const bestCover = selectBestLutrisCover(
          cleanRaw,
          norm,
          effectiveReleaseYear,
          items,
          isUnsuitableCoverUrl
        );
        if (bestCover) {
          // Store under year-isolated cacheKey only when effectiveReleaseYear is present
          // so reboots (e.g. Prey 2017 vs Prey 2006) never overwrite or poison yearless keys.
          this.store.setCoverCacheBounded(cacheKey, bestCover);
          this.store.savePersistentCache();
          this.notifyCoverUpdated(cleanRaw, bestCover);
          return bestCover;
        }
      }

      // Only mark negative cache when the API actually responded cleanly (not on network/5xx errors)
      if (receivedOkResponse && onlineLifecycleManager.isOnline()) {
        const now = Date.now();
        this.store.setCoverCacheBounded(cacheKey, null);
        this.store.negativeTimestamps.set(cacheKey, now);
        this.store.savePersistentCache();
      }
      return null;
    };

    const fetchPromise =
      options?.trackInGlobalBar === true && priority !== Priority.P0_INTERACTIVE
        ? syncJobManager.trackTask('cover_art', cleanRaw, executeLookup)
        : executeLookup();

    this.pendingFetches.set(cacheKey, fetchPromise);
    try {
      return await fetchPromise;
    } finally {
      if (this.pendingFetches.get(cacheKey) === fetchPromise) {
        this.pendingFetches.delete(cacheKey);
      }
    }
  }

  private notifyCoverUpdated(title: string, coverUrl: string): void {
    if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
      window.dispatchEvent(
        new CustomEvent('antigravity:igdb-cover-updated', {
          detail: { title, coverUrl },
        })
      );
    }
  }
}

export const igdbCoverService = new IgdbCoverService();
