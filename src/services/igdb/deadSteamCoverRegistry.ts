/**
 * Bounded dead-Steam cover registry supporting isolated unhashed vs 40-char SHA1-hashed
 * tracking, adaptive 404 retry TTLs, deduplication-before-breaker burst suppression,
 * legacy scroll-burst poison purging, and generation-guarded SWR background reprobing.
 */

import {
  computeAdaptive404RetryDelayMs,
  isWafOrChallengeResponse,
  unwrapOlMediaUrl,
} from '../../contracts/network';
import { LruMap, LruSet } from '../common/lruMap';
import { onlineLifecycleManager } from '../network/onlineLifecycleManager';
import { vaultDelete, vaultSet } from '../storage/indexedDbVault';
import {
  STEAM_LIBRARY_COVER_URL_RE,
  buildSteamPortraitProbeUrl,
} from './steamCoverUrlBuilder';

export const STORAGE_KEY_DEAD_STEAM_COVERS = 'antigravity_dead_steam_covers_v1';
export const STORAGE_KEY_DEAD_STEAM_COVER_COUNTS = 'antigravity_dead_steam_cover_counts_v1';
export const STORAGE_KEY_DEAD_STEAM_HASHED_V2 = 'antigravity_dead_steam_hashed_v2';
export const STORAGE_KEY_DEAD_STEAM_SCHEMA_V2 = 'antigravity_dead_steam_schema_v2';

export const MAX_DEAD_STEAM_ENTRIES = 4096;

const DEAD_STEAM_COVER_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const MAX_DEAD_STEAM_FAILURE_COUNT = 4; // 6h -> 24h -> 7d -> 30d
const DEAD_STEAM_BURST_WINDOW_MS = 15_000;
const DEAD_STEAM_BURST_THRESHOLD = 8;
const DEAD_STEAM_BURST_COOLDOWN_MS = 60_000;

export interface PersistedHashedDeadSteamRecord {
  cachedAt: number;
  failureCount: number;
}

interface ScheduledReprobeHandle {
  kind: 'idle' | 'timeout';
  id: number | ReturnType<typeof setTimeout>;
}

interface IdleCallbackGlobal {
  requestIdleCallback?: (cb: () => void, opts?: { timeout?: number }) => number;
  cancelIdleCallback?: (id: number) => void;
}

// Steam App IDs verified to not host standard unhashed library_600x900 assets on Steam CDN.
// Kept as a standard Set<number> for external test/caller compatibility while bounded internally to MAX_DEAD_STEAM_ENTRIES.
export const KNOWN_DEAD_STEAM_COVER_APP_IDS = new Set<number>();

// Active non-expired SHA1-hashed Steam library cover keys (`${appId}:${sha1}`) — strictly isolated from KNOWN_DEAD_STEAM_COVER_APP_IDS
const KNOWN_DEAD_STEAM_HASHED_KEYS = new LruSet<string>(MAX_DEAD_STEAM_ENTRIES);

function addKnownDeadAppIdBounded(appId: number): void {
  if (KNOWN_DEAD_STEAM_COVER_APP_IDS.has(appId)) {
    KNOWN_DEAD_STEAM_COVER_APP_IDS.delete(appId);
  }
  KNOWN_DEAD_STEAM_COVER_APP_IDS.add(appId);
  while (KNOWN_DEAD_STEAM_COVER_APP_IDS.size > MAX_DEAD_STEAM_ENTRIES) {
    const oldest = KNOWN_DEAD_STEAM_COVER_APP_IDS.values().next().value;
    if (oldest === undefined) break;
    KNOWN_DEAD_STEAM_COVER_APP_IDS.delete(oldest);
  }
}

export class DeadSteamCoverRegistry {
  private readonly deadSteamTimestamps = new LruMap<number, number>(MAX_DEAD_STEAM_ENTRIES);
  private readonly deadSteamFailureCounts = new LruMap<number, number>(MAX_DEAD_STEAM_ENTRIES);
  private readonly expiredDeadSteamUnhashedAppIds = new LruSet<number>(MAX_DEAD_STEAM_ENTRIES);
  private readonly deadSteamHashedEntries = new LruMap<string, PersistedHashedDeadSteamRecord>(
    MAX_DEAD_STEAM_ENTRIES
  );
  private readonly pendingDeadProbes = new Map<string, Promise<boolean>>();
  private readonly scheduledExpiredReprobes = new LruSet<number>(MAX_DEAD_STEAM_ENTRIES);
  private readonly scheduledReprobeHandles = new Map<number, ScheduledReprobeHandle>();
  private recentDeadFailureEvents: Array<{ appId: number; ts: number }> = [];
  private burstCircuitBreakerTrippedUntil = 0;

  constructor(
    private readonly ensureInitialized: () => void,
    private readonly getCacheGeneration: () => number
  ) {}

  public resetBurstCircuitBreaker(): void {
    this.burstCircuitBreakerTrippedUntil = 0;
    this.recentDeadFailureEvents = [];
  }

  public isDeadSteamBurstCircuitOpen(): boolean {
    return Date.now() < this.burstCircuitBreakerTrippedUntil;
  }

  public getDeadSteamFailureCount(appId: number): number {
    this.ensureInitialized();
    return this.deadSteamFailureCounts.peek(appId) || 0;
  }

  public isKnownDeadUnhashedSteamCover(appId: number): boolean {
    if (!appId || appId <= 0) return false;
    this.ensureInitialized();
    if (!KNOWN_DEAD_STEAM_COVER_APP_IDS.has(appId)) return false;
    const ts = this.deadSteamTimestamps.peek(appId);
    if (ts !== undefined) {
      const count = this.deadSteamFailureCounts.peek(appId);
      const ttlMs =
        count !== undefined ? computeAdaptive404RetryDelayMs(count) : DEAD_STEAM_COVER_TTL_MS;
      if (Date.now() - ts >= ttlMs) {
        KNOWN_DEAD_STEAM_COVER_APP_IDS.delete(appId);
        this.expiredDeadSteamUnhashedAppIds.add(appId);
        if (count === undefined) {
          this.deadSteamFailureCounts.set(appId, 1);
        }
        return false;
      }
    }
    return true;
  }

  public isExpiredDeadSteamUnhashed(appId: number): boolean {
    if (!appId || appId <= 0) return false;
    this.ensureInitialized();
    if (KNOWN_DEAD_STEAM_COVER_APP_IDS.has(appId)) {
      this.isKnownDeadUnhashedSteamCover(appId);
    }
    return this.expiredDeadSteamUnhashedAppIds.has(appId);
  }

  public isKnownDeadHashedSteamCover(appId: number, sha1: string): boolean {
    if (!appId || appId <= 0 || !sha1) return false;
    this.ensureInitialized();
    const key = `${appId}:${sha1.toLowerCase()}`;
    if (!KNOWN_DEAD_STEAM_HASHED_KEYS.has(key)) return false;
    const entry = this.deadSteamHashedEntries.peek(key);
    if (entry) {
      const ttlMs = computeAdaptive404RetryDelayMs(entry.failureCount);
      if (Date.now() - entry.cachedAt >= ttlMs) {
        KNOWN_DEAD_STEAM_HASHED_KEYS.delete(key);
        return false;
      }
    }
    return true;
  }

  private checkAndUpdateBurstCircuitBreaker(appId: number, now: number): boolean {
    const cutoff = now - DEAD_STEAM_BURST_WINDOW_MS;
    this.recentDeadFailureEvents = this.recentDeadFailureEvents.filter((ev) => ev.ts >= cutoff);

    if (now < this.burstCircuitBreakerTrippedUntil) {
      return true;
    }

    const distinctAppIds = new Set<number>();
    for (const ev of this.recentDeadFailureEvents) {
      distinctAppIds.add(ev.appId);
    }
    distinctAppIds.add(appId);
    this.recentDeadFailureEvents.push({ appId, ts: now });

    if (distinctAppIds.size >= DEAD_STEAM_BURST_THRESHOLD) {
      this.burstCircuitBreakerTrippedUntil = now + DEAD_STEAM_BURST_COOLDOWN_MS;
      return true;
    }
    return false;
  }

  private persistDeadSteamUnhashedState(): void {
    const deadObj: Record<string, number> = {};
    const countsObj: Record<string, number> = {};
    for (const [id, ts] of this.deadSteamTimestamps.entries()) {
      deadObj[String(id)] = ts;
    }
    for (const [id, count] of this.deadSteamFailureCounts.entries()) {
      if (count > 0) {
        countsObj[String(id)] = Math.min(MAX_DEAD_STEAM_FAILURE_COUNT, Math.floor(count));
      }
    }
    void vaultSet(STORAGE_KEY_DEAD_STEAM_COVERS, deadObj);
    void vaultSet(STORAGE_KEY_DEAD_STEAM_COVER_COUNTS, countsObj);
    if (typeof localStorage !== 'undefined') {
      try {
        localStorage.setItem(STORAGE_KEY_DEAD_STEAM_COVERS, JSON.stringify(deadObj));
        localStorage.setItem(STORAGE_KEY_DEAD_STEAM_COVER_COUNTS, JSON.stringify(countsObj));
      } catch {
        // Ignore storage write error; IndexedDB vault retains state
      }
    }
  }

  private persistDeadSteamHashedState(): void {
    const hashedObj: Record<string, PersistedHashedDeadSteamRecord> = {};
    for (const [key, rec] of this.deadSteamHashedEntries.entries()) {
      hashedObj[key] = {
        cachedAt: rec.cachedAt,
        failureCount: Math.min(
          MAX_DEAD_STEAM_FAILURE_COUNT,
          Math.max(1, Math.floor(rec.failureCount))
        ),
      };
    }
    void vaultSet(STORAGE_KEY_DEAD_STEAM_HASHED_V2, hashedObj);
    if (typeof localStorage !== 'undefined') {
      try {
        if (Object.keys(hashedObj).length > 0) {
          localStorage.setItem(STORAGE_KEY_DEAD_STEAM_HASHED_V2, JSON.stringify(hashedObj));
        } else {
          localStorage.removeItem(STORAGE_KEY_DEAD_STEAM_HASHED_V2);
        }
      } catch {
        // Ignore storage write error
      }
    }
  }

  private clearDeadUnhashedSteamCover(appId: number): boolean {
    const hadRecord =
      KNOWN_DEAD_STEAM_COVER_APP_IDS.has(appId) ||
      this.deadSteamTimestamps.has(appId) ||
      this.deadSteamFailureCounts.has(appId) ||
      this.expiredDeadSteamUnhashedAppIds.has(appId);
    KNOWN_DEAD_STEAM_COVER_APP_IDS.delete(appId);
    this.deadSteamTimestamps.delete(appId);
    this.deadSteamFailureCounts.delete(appId);
    this.expiredDeadSteamUnhashedAppIds.delete(appId);
    if (hadRecord) {
      this.persistDeadSteamUnhashedState();
    }
    return hadRecord;
  }

  public recordDeadSteamCover(
    appId?: number | null,
    _options?: { verified404?: boolean }
  ): void {
    if (!appId || appId <= 0) return;
    if (typeof navigator !== 'undefined' && navigator.onLine === false) return;
    this.ensureInitialized();
    const now = Date.now();

    // Check active-TTL deduplication BEFORE burst circuit breaker so re-reporting an
    // already-known dead AppID never increments counts or falsely trips the circuit breaker.
    const existingTs = this.deadSteamTimestamps.peek(appId);
    const existingCount = this.deadSteamFailureCounts.peek(appId);
    if (
      existingTs !== undefined &&
      KNOWN_DEAD_STEAM_COVER_APP_IDS.has(appId) &&
      !this.expiredDeadSteamUnhashedAppIds.has(appId)
    ) {
      const activeTtl =
        existingCount !== undefined
          ? computeAdaptive404RetryDelayMs(existingCount)
          : DEAD_STEAM_COVER_TTL_MS;
      if (now - existingTs < activeTtl) {
        return;
      }
    }

    if (this.checkAndUpdateBurstCircuitBreaker(appId, now)) {
      return;
    }

    const nextCount = Math.min(MAX_DEAD_STEAM_FAILURE_COUNT, (existingCount || 0) + 1);
    this.expiredDeadSteamUnhashedAppIds.delete(appId);
    addKnownDeadAppIdBounded(appId);
    this.deadSteamTimestamps.set(appId, now);
    this.deadSteamFailureCounts.set(appId, nextCount);
    this.persistDeadSteamUnhashedState();
  }

  private recordDeadHashedSteamCover(appId: number, sha1: string): boolean {
    if (!appId || appId <= 0 || !sha1) return false;
    if (typeof navigator !== 'undefined' && navigator.onLine === false) return false;
    this.ensureInitialized();
    const now = Date.now();
    const key = `${appId}:${sha1.toLowerCase()}`;

    // Check active-TTL deduplication BEFORE burst circuit breaker so re-reporting an
    // already-known dead SHA1 asset never falsely trips the circuit breaker.
    const existing = this.deadSteamHashedEntries.peek(key);
    if (existing && KNOWN_DEAD_STEAM_HASHED_KEYS.has(key)) {
      const activeTtl = computeAdaptive404RetryDelayMs(existing.failureCount);
      if (now - existing.cachedAt < activeTtl) {
        return true;
      }
    }

    if (this.checkAndUpdateBurstCircuitBreaker(appId, now)) {
      return false;
    }

    const nextCount = Math.min(
      MAX_DEAD_STEAM_FAILURE_COUNT,
      (existing?.failureCount || 0) + 1
    );
    this.deadSteamHashedEntries.set(key, { cachedAt: now, failureCount: nextCount });
    KNOWN_DEAD_STEAM_HASHED_KEYS.add(key);
    // CRITICAL: NEVER touch KNOWN_DEAD_STEAM_COVER_APP_IDS for SHA1-hashed failures!
    this.persistDeadSteamHashedState();
    return true;
  }

  public cancelScheduledReprobes(): void {
    const g = globalThis as typeof globalThis & IdleCallbackGlobal;
    for (const handle of this.scheduledReprobeHandles.values()) {
      try {
        if (handle.kind === 'idle' && typeof g.cancelIdleCallback === 'function') {
          g.cancelIdleCallback(handle.id as number);
        } else if (handle.kind === 'timeout') {
          clearTimeout(handle.id as ReturnType<typeof setTimeout>);
        }
      } catch {
        // Ignore timer cleanup errors
      }
    }
    this.scheduledReprobeHandles.clear();
    this.scheduledExpiredReprobes.clear();
  }

  public clear(): void {
    this.cancelScheduledReprobes();
    this.deadSteamTimestamps.clear();
    this.deadSteamFailureCounts.clear();
    this.expiredDeadSteamUnhashedAppIds.clear();
    this.deadSteamHashedEntries.clear();
    this.pendingDeadProbes.clear();
    this.resetBurstCircuitBreaker();
    KNOWN_DEAD_STEAM_COVER_APP_IDS.clear();
    KNOWN_DEAD_STEAM_HASHED_KEYS.clear();

    void vaultDelete(STORAGE_KEY_DEAD_STEAM_COVERS);
    void vaultDelete(STORAGE_KEY_DEAD_STEAM_COVER_COUNTS);
    void vaultDelete(STORAGE_KEY_DEAD_STEAM_HASHED_V2);
    if (typeof localStorage !== 'undefined') {
      try {
        localStorage.removeItem(STORAGE_KEY_DEAD_STEAM_COVERS);
        localStorage.removeItem(STORAGE_KEY_DEAD_STEAM_COVER_COUNTS);
        localStorage.removeItem(STORAGE_KEY_DEAD_STEAM_HASHED_V2);
        localStorage.removeItem(STORAGE_KEY_DEAD_STEAM_SCHEMA_V2);
      } catch {
        // Ignore storage errors
      }
    }
  }

  public evictAppId(steamAppId: number): void {
    if (!steamAppId || steamAppId <= 0) return;

    const handle = this.scheduledReprobeHandles.get(steamAppId);
    if (handle) {
      const g = globalThis as typeof globalThis & IdleCallbackGlobal;
      try {
        if (handle.kind === 'idle' && typeof g.cancelIdleCallback === 'function') {
          g.cancelIdleCallback(handle.id as number);
        } else if (handle.kind === 'timeout') {
          clearTimeout(handle.id as ReturnType<typeof setTimeout>);
        }
      } catch {
        // Ignore timer cleanup errors
      }
      this.scheduledReprobeHandles.delete(steamAppId);
      this.scheduledExpiredReprobes.delete(steamAppId);
    }

    KNOWN_DEAD_STEAM_COVER_APP_IDS.delete(steamAppId);
    this.deadSteamTimestamps.delete(steamAppId);
    this.deadSteamFailureCounts.delete(steamAppId);
    this.expiredDeadSteamUnhashedAppIds.delete(steamAppId);
    this.persistDeadSteamUnhashedState();

    const hashedPrefix = `${steamAppId}:`;
    let removedAnyHashed = false;
    for (const k of Array.from(this.deadSteamHashedEntries.keys())) {
      if (k.startsWith(hashedPrefix)) {
        this.deadSteamHashedEntries.delete(k);
        KNOWN_DEAD_STEAM_HASHED_KEYS.delete(k);
        removedAnyHashed = true;
      }
    }
    for (const k of Array.from(KNOWN_DEAD_STEAM_HASHED_KEYS)) {
      if (k.startsWith(hashedPrefix)) {
        KNOWN_DEAD_STEAM_HASHED_KEYS.delete(k);
        removedAnyHashed = true;
      }
    }
    if (removedAnyHashed) {
      this.persistDeadSteamHashedState();
    }
  }

  public scheduleExpiredDeadSteamReprobe(appId: number): void {
    if (!appId || appId <= 0 || !onlineLifecycleManager.isOnline()) return;
    this.ensureInitialized();
    if (!this.isExpiredDeadSteamUnhashed(appId)) return;
    if (this.scheduledExpiredReprobes.has(appId)) return;

    const gen = this.getCacheGeneration();
    this.scheduledExpiredReprobes.add(appId);

    const run = () => {
      this.scheduledReprobeHandles.delete(appId);
      if (gen !== this.getCacheGeneration()) {
        return;
      }
      void this.verifyAndRecordDeadSteamCover(appId).finally(() => {
        if (gen === this.getCacheGeneration()) {
          this.scheduledExpiredReprobes.delete(appId);
        }
      });
    };

    const g = globalThis as typeof globalThis & IdleCallbackGlobal;
    if (typeof g.requestIdleCallback === 'function') {
      const idleId = g.requestIdleCallback(run, { timeout: 4000 });
      this.scheduledReprobeHandles.set(appId, { kind: 'idle', id: idleId });
    } else {
      const timerId = setTimeout(run, 150);
      if (
        timerId &&
        typeof timerId === 'object' &&
        'unref' in timerId &&
        typeof timerId.unref === 'function'
      ) {
        timerId.unref();
      }
      this.scheduledReprobeHandles.set(appId, { kind: 'timeout', id: timerId });
    }
  }

  private async probeUrlStatus(
    probeUrl: string
  ): Promise<{ outcome: 'ok' | 'definitive_404' | 'transient' }> {
    if (typeof window !== 'undefined' && window.electronAPI?.offlineVault?.checkUrlStatus) {
      try {
        const statusRes = await window.electronAPI.offlineVault.checkUrlStatus(probeUrl);
        if (!statusRes || statusRes.online === false || statusRes.isWafOrRateLimited) {
          return { outcome: 'transient' };
        }
        if (statusRes.isDefinitive404 === true || statusRes.status === 404) {
          return { outcome: 'definitive_404' };
        }
        if (
          typeof statusRes.status === 'number' &&
          statusRes.status >= 200 &&
          statusRes.status < 300
        ) {
          return { outcome: 'ok' };
        }
        return { outcome: 'transient' };
      } catch {
        return { outcome: 'transient' };
      }
    }

    try {
      const res = await fetch(probeUrl, {
        method: 'HEAD',
        signal:
          typeof AbortSignal !== 'undefined' && 'timeout' in AbortSignal
            ? AbortSignal.timeout(4500)
            : undefined,
      });
      if (!onlineLifecycleManager.isOnline()) return { outcome: 'transient' };
      if (isWafOrChallengeResponse(res.status, '')) return { outcome: 'transient' };
      if (res.status === 404) return { outcome: 'definitive_404' };
      if (res.ok || (res.status >= 200 && res.status < 300)) return { outcome: 'ok' };
      return { outcome: 'transient' };
    } catch {
      return { outcome: 'transient' };
    }
  }

  public async verifyAndRecordDeadSteamCover(
    appId: number,
    failedUrl?: string
  ): Promise<boolean> {
    if (!onlineLifecycleManager.isOnline() || !Number.isFinite(appId) || appId <= 0) {
      return false;
    }
    this.ensureInitialized();
    const gen = this.getCacheGeneration();

    const unwrappedFailed = failedUrl ? unwrapOlMediaUrl(failedUrl).trim() : '';
    const normalizedFailed = unwrappedFailed.startsWith('//')
      ? `https:${unwrappedFailed}`
      : unwrappedFailed;
    const urlMatch = normalizedFailed ? STEAM_LIBRARY_COVER_URL_RE.exec(normalizedFailed) : null;
    const sha1 = urlMatch?.[2]?.toLowerCase() || null;

    // Branch A: 40-char SHA1-hashed Steam URL — probe ONLY that exact URL and NEVER poison the AppID!
    if (sha1 && normalizedFailed) {
      if (this.isKnownDeadHashedSteamCover(appId, sha1)) {
        return true;
      }
      const probeKey = `hashed:${appId}:${sha1}`;
      const existingProbe = this.pendingDeadProbes.get(probeKey);
      if (existingProbe) return existingProbe;

      const probePromise = (async (): Promise<boolean> => {
        const { outcome } = await this.probeUrlStatus(normalizedFailed);
        if (gen !== this.getCacheGeneration()) {
          return false;
        }
        if (outcome === 'definitive_404') {
          return this.recordDeadHashedSteamCover(appId, sha1);
        }
        if (outcome === 'ok') {
          const hashedKey = `${appId}:${sha1}`;
          if (this.deadSteamHashedEntries.delete(hashedKey)) {
            KNOWN_DEAD_STEAM_HASHED_KEYS.delete(hashedKey);
            this.persistDeadSteamHashedState();
          }
        }
        return false;
      })();

      this.pendingDeadProbes.set(probeKey, probePromise);
      try {
        return await probePromise;
      } finally {
        if (this.pendingDeadProbes.get(probeKey) === probePromise) {
          this.pendingDeadProbes.delete(probeKey);
        }
      }
    }

    // Branch B: Legacy unhashed Steam cover URL
    if (this.isKnownDeadUnhashedSteamCover(appId)) {
      return true;
    }

    const probeKey = `unhashed:${appId}`;
    const existingProbe = this.pendingDeadProbes.get(probeKey);
    if (existingProbe) return existingProbe;

    const probeUrl = buildSteamPortraitProbeUrl(appId);

    const probePromise = (async (): Promise<boolean> => {
      const { outcome } = await this.probeUrlStatus(probeUrl);
      if (gen !== this.getCacheGeneration()) {
        return false;
      }
      if (outcome === 'definitive_404') {
        const beforeActive = KNOWN_DEAD_STEAM_COVER_APP_IDS.has(appId);
        this.recordDeadSteamCover(appId, { verified404: true });
        return KNOWN_DEAD_STEAM_COVER_APP_IDS.has(appId) || beforeActive;
      }
      if (outcome === 'ok') {
        const wasDeadOrExpired = this.clearDeadUnhashedSteamCover(appId);
        if (
          wasDeadOrExpired &&
          typeof window !== 'undefined' &&
          typeof window.dispatchEvent === 'function'
        ) {
          try {
            window.dispatchEvent(
              new CustomEvent('antigravity:steam-assets-resolved', {
                detail: { appId, capsuleImage: probeUrl, ts: Date.now() },
              })
            );
          } catch {
            // Ignore event dispatch errors
          }
        }
      }
      return false;
    })();

    this.pendingDeadProbes.set(probeKey, probePromise);
    try {
      return await probePromise;
    } finally {
      if (this.pendingDeadProbes.get(probeKey) === probePromise) {
        this.pendingDeadProbes.delete(probeKey);
      }
    }
  }

  private detectBurstClusterAppIds(
    entries: Array<{ appId: number; tsNum: number; countNum: number | undefined }>
  ): Set<number> {
    const uncounted = entries
      .filter((e) => e.countNum === undefined && e.appId > 0 && e.tsNum > 0)
      .sort((a, b) => a.tsNum - b.tsNum);

    const burstPurged = new Set<number>();
    if (uncounted.length < DEAD_STEAM_BURST_THRESHOLD) {
      return burstPurged;
    }

    let left = 0;
    for (let right = 0; right < uncounted.length; right++) {
      while (uncounted[right].tsNum - uncounted[left].tsNum > DEAD_STEAM_BURST_WINDOW_MS) {
        left++;
      }
      if (right - left + 1 >= DEAD_STEAM_BURST_THRESHOLD) {
        for (let k = left; k <= right; k++) {
          burstPurged.add(uncounted[k].appId);
        }
      }
    }
    return burstPurged;
  }

  public loadFromLocalStorage(): void {
    if (typeof localStorage === 'undefined') return;

    const rawDeadCounts = localStorage.getItem(STORAGE_KEY_DEAD_STEAM_COVER_COUNTS);
    let parsedCounts: Record<string, number> = {};
    if (rawDeadCounts) {
      try {
        const obj: unknown = JSON.parse(rawDeadCounts);
        if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
          parsedCounts = obj as Record<string, number>;
        }
      } catch {
        // Ignore malformed count cache
      }
    }

    for (const [idStr, rawCount] of Object.entries(parsedCounts)) {
      const appId = Number(idStr);
      if (Number.isFinite(appId) && appId > 0 && typeof rawCount === 'number' && rawCount > 0) {
        this.deadSteamFailureCounts.set(
          appId,
          Math.min(MAX_DEAD_STEAM_FAILURE_COUNT, Math.floor(rawCount))
        );
      }
    }

    const hasDeadSteamSchemaV2 =
      localStorage.getItem(STORAGE_KEY_DEAD_STEAM_SCHEMA_V2) === '1';
    const rawDeadSteam = localStorage.getItem(STORAGE_KEY_DEAD_STEAM_COVERS);
    if (rawDeadSteam) {
      const parsedDead: unknown = JSON.parse(rawDeadSteam);
      if (parsedDead && typeof parsedDead === 'object' && !Array.isArray(parsedDead)) {
        const parsedEntries: Array<{
          appId: number;
          tsNum: number;
          countNum: number | undefined;
        }> = [];
        for (const [idStr, ts] of Object.entries(parsedDead as Record<string, unknown>)) {
          const appId = Number(idStr);
          if (!Number.isFinite(appId) || appId <= 0) continue;
          let tsNum = 0;
          let countNum: number | undefined = undefined;
          if (typeof ts === 'number') {
            tsNum = ts;
            if (typeof parsedCounts[idStr] === 'number' && parsedCounts[idStr] > 0) {
              countNum = Math.min(MAX_DEAD_STEAM_FAILURE_COUNT, Math.floor(parsedCounts[idStr]));
            }
          } else if (ts && typeof ts === 'object') {
            const deadObj = ts as { cachedAt?: unknown; failureCount?: unknown };
            tsNum = Number(deadObj.cachedAt || 0);
            if (typeof deadObj.failureCount === 'number' && deadObj.failureCount > 0) {
              countNum = Math.min(
                MAX_DEAD_STEAM_FAILURE_COUNT,
                Math.floor(deadObj.failureCount)
              );
            }
          }
          if (tsNum > 0) {
            parsedEntries.push({ appId, tsNum, countNum });
          }
        }

        // One-time v2 poison purge: remove any scroll-burst cluster (>= 8 uncounted entries within 15s)
        // while preserving single genuine 404s and unit-test-seeded entries!
        const burstPurgedIds = !hasDeadSteamSchemaV2
          ? this.detectBurstClusterAppIds(parsedEntries)
          : new Set<number>();

        const now = Date.now();
        for (const entry of parsedEntries) {
          if (burstPurgedIds.has(entry.appId)) {
            KNOWN_DEAD_STEAM_COVER_APP_IDS.delete(entry.appId);
            this.deadSteamTimestamps.delete(entry.appId);
            this.deadSteamFailureCounts.delete(entry.appId);
            this.expiredDeadSteamUnhashedAppIds.delete(entry.appId);
            continue;
          }

          const ttlMs =
            entry.countNum !== undefined
              ? computeAdaptive404RetryDelayMs(entry.countNum)
              : DEAD_STEAM_COVER_TTL_MS;
          this.deadSteamTimestamps.set(entry.appId, entry.tsNum);
          if (entry.countNum !== undefined) {
            this.deadSteamFailureCounts.set(entry.appId, entry.countNum);
          }

          if (now - entry.tsNum < ttlMs) {
            addKnownDeadAppIdBounded(entry.appId);
            this.expiredDeadSteamUnhashedAppIds.delete(entry.appId);
          } else {
            // TTL expired: remove from active dead set, record for SWR re-probe, and PRESERVE failureCount!
            KNOWN_DEAD_STEAM_COVER_APP_IDS.delete(entry.appId);
            this.expiredDeadSteamUnhashedAppIds.add(entry.appId);
            if (entry.countNum === undefined) {
              this.deadSteamFailureCounts.set(entry.appId, 1);
            }
          }
        }

        if (!hasDeadSteamSchemaV2) {
          localStorage.setItem(STORAGE_KEY_DEAD_STEAM_SCHEMA_V2, '1');
          if (burstPurgedIds.size > 0) {
            this.persistDeadSteamUnhashedState();
          }
        }
      }
    }

    // Load SHA1-hashed dead Steam cover registry (strictly isolated from KNOWN_DEAD_STEAM_COVER_APP_IDS)
    const rawDeadHashed = localStorage.getItem(STORAGE_KEY_DEAD_STEAM_HASHED_V2);
    if (rawDeadHashed) {
      try {
        const parsedHashed: unknown = JSON.parse(rawDeadHashed);
        if (parsedHashed && typeof parsedHashed === 'object' && !Array.isArray(parsedHashed)) {
          const now = Date.now();
          for (const [key, rec] of Object.entries(parsedHashed as Record<string, unknown>)) {
            if (!/^\d+:[a-f0-9]{40}$/i.test(key) || !rec || typeof rec !== 'object') continue;
            const typedRec = rec as { cachedAt?: unknown; failureCount?: unknown };
            const cachedAt = Number(typedRec.cachedAt || 0);
            const failureCount = Math.min(
              MAX_DEAD_STEAM_FAILURE_COUNT,
              Math.max(1, Math.floor(Number(typedRec.failureCount || 1)))
            );
            if (cachedAt <= 0) continue;
            const normKey = key.toLowerCase();
            this.deadSteamHashedEntries.set(normKey, { cachedAt, failureCount });
            if (now - cachedAt < computeAdaptive404RetryDelayMs(failureCount)) {
              KNOWN_DEAD_STEAM_HASHED_KEYS.add(normKey);
            } else {
              KNOWN_DEAD_STEAM_HASHED_KEYS.delete(normKey);
            }
          }
        }
      } catch {
        // Ignore malformed hashed registry
      }
    }
  }

  public hydrateFromVault(
    vaultDeadSteam: Record<string, unknown> | undefined,
    vaultDeadCounts: Record<string, unknown> | undefined,
    vaultDeadHashed: Record<string, unknown> | undefined
  ): void {
    if (vaultDeadCounts && typeof vaultDeadCounts === 'object' && !Array.isArray(vaultDeadCounts)) {
      for (const [idStr, rawCount] of Object.entries(vaultDeadCounts)) {
        const appId = Number(idStr);
        if (Number.isFinite(appId) && appId > 0 && typeof rawCount === 'number' && rawCount > 0) {
          const clamped = Math.min(MAX_DEAD_STEAM_FAILURE_COUNT, Math.floor(rawCount));
          const existingCount = this.deadSteamFailureCounts.peek(appId) || 0;
          if (clamped > existingCount) {
            this.deadSteamFailureCounts.set(appId, clamped);
          }
        }
      }
    }

    if (vaultDeadSteam && typeof vaultDeadSteam === 'object' && !Array.isArray(vaultDeadSteam)) {
      const now = Date.now();
      for (const [idStr, ts] of Object.entries(vaultDeadSteam)) {
        const appId = Number(idStr);
        const tsNum = typeof ts === 'number' ? ts : 0;
        if (!Number.isFinite(appId) || appId <= 0 || tsNum <= 0) continue;
        const existingTs = this.deadSteamTimestamps.peek(appId) || 0;
        if (tsNum <= existingTs) continue;
        const count = this.deadSteamFailureCounts.peek(appId);
        const ttlMs =
          count !== undefined ? computeAdaptive404RetryDelayMs(count) : DEAD_STEAM_COVER_TTL_MS;
        this.deadSteamTimestamps.set(appId, tsNum);
        if (now - tsNum < ttlMs) {
          addKnownDeadAppIdBounded(appId);
          this.expiredDeadSteamUnhashedAppIds.delete(appId);
        } else {
          KNOWN_DEAD_STEAM_COVER_APP_IDS.delete(appId);
          this.expiredDeadSteamUnhashedAppIds.add(appId);
          if (count === undefined) {
            this.deadSteamFailureCounts.set(appId, 1);
          }
        }
      }
    }

    if (vaultDeadHashed && typeof vaultDeadHashed === 'object' && !Array.isArray(vaultDeadHashed)) {
      const now = Date.now();
      for (const [key, rec] of Object.entries(vaultDeadHashed)) {
        if (!/^\d+:[a-f0-9]{40}$/i.test(key) || !rec || typeof rec !== 'object') continue;
        const typedRec = rec as { cachedAt?: unknown; failureCount?: unknown };
        const cachedAt = Number(typedRec.cachedAt || 0);
        const failureCount = Math.min(
          MAX_DEAD_STEAM_FAILURE_COUNT,
          Math.max(1, Math.floor(Number(typedRec.failureCount || 1)))
        );
        if (cachedAt <= 0) continue;
        const normKey = key.toLowerCase();
        const existing = this.deadSteamHashedEntries.peek(normKey);
        if (existing && existing.cachedAt >= cachedAt) continue;
        this.deadSteamHashedEntries.set(normKey, { cachedAt, failureCount });
        if (now - cachedAt < computeAdaptive404RetryDelayMs(failureCount)) {
          KNOWN_DEAD_STEAM_HASHED_KEYS.add(normKey);
        }
      }
    }
  }
}
