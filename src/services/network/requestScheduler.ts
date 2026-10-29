/**
 * Request Scheduler & Token Bucket Rate Limiter
 * Provides domain-specific token bucket throttling, priority queue scheduling (P0 > P1 > P2),
 * Akamai/CDN cooldown tracking, and jittered exponential backoff.
 */

import { isWafOrChallengeResponse } from '../../contracts/network';
import { onlineLifecycleManager } from './onlineLifecycleManager';

export enum RequestPriority {
  P0_INTERACTIVE = 0,
  P1_VIEWPORT = 1,
  P2_BACKGROUND = 2,
  INTERACTIVE = 0,
  HIGH = 1,
  LOW = 2,
}

export const Priority = RequestPriority;

export interface DomainConfig {
  requestsPerSecond: number; // Token fill rate
  burst: number;             // Maximum token bucket capacity
  cooldownOnRateLimitSec?: number; // Akamai or server cooldown on 429/403
}

export interface ScheduleOptions {
  domainKey?: string;
  gameKey?: string;
}

export interface QueueItem<T = unknown> {
  id: string;
  url: string;
  gameKey?: string;
  fn: () => Promise<T>;
  priority: number;
  domain: string;
  queuedAt: number;
  retries: number;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
}

export interface TokenBucket {
  tokens: number;
  lastRefill: number;
  fillRate: number;
  capacity: number;
  cooldownUntil: number;
  cooldownDurationMs: number;
  consecutiveServerErrors: number;
  wasCoolingDown: boolean;
  probeInFlight: boolean;
  activeInteractiveCount: number;
  queue: Array<QueueItem<unknown>>;
  timer: ReturnType<typeof setTimeout> | null;
  retryTimers: Map<ReturnType<typeof setTimeout>, QueueItem<unknown>>;
}

interface RateLimitSchedulerError extends Error {
  isRateLimited?: boolean;
  status?: number;
  cooldownRemaining?: number;
}

interface SchedulerHttpError {
  status?: number;
  code?: string;
  message?: string;
  headers?: unknown;
  response?: {
    status?: number;
    headers?: unknown;
    data?: unknown;
  };
}

function createAbortError(message: string): Error {
  if (typeof DOMException !== 'undefined') {
    return new DOMException(message, 'AbortError');
  }
  const err = new Error(message);
  err.name = 'AbortError';
  return err;
}

export const DOMAIN_CONFIGS: Record<string, DomainConfig> = {
  'store.steampowered.com': {
    requestsPerSecond: 0.5,
    burst: 2,
    cooldownOnRateLimitSec: 900, // 15-minute Akamai edge cooldown
  },
  'api.steampowered.com': {
    requestsPerSecond: 2.0,
    burst: 4,
  },
  'steamcommunity.com': {
    requestsPerSecond: 1.0,
    burst: 3,
    cooldownOnRateLimitSec: 180,
  },
  'metacritic.com': {
    requestsPerSecond: 0.33,
    burst: 1,
    cooldownOnRateLimitSec: 300,
  },
  'backend.metacritic.com': {
    requestsPerSecond: 2.0,
    burst: 4,
    cooldownOnRateLimitSec: 180,
  },
  'api.opencritic.com': {
    requestsPerSecond: 2.0,
    burst: 5,
    cooldownOnRateLimitSec: 180,
  },
  'lutris.net': {
    requestsPerSecond: 0.5,
    burst: 2,
    cooldownOnRateLimitSec: 180,
  },
  'catalog.gog.com': {
    requestsPerSecond: 1.0,
    burst: 2,
    cooldownOnRateLimitSec: 120,
  },
  'launcher.store.epicgames.com': {
    requestsPerSecond: 1.0,
    burst: 2,
    cooldownOnRateLimitSec: 120,
  },
  'howlongtobeat.com': {
    requestsPerSecond: 1.0,
    burst: 2,
  },
  'api.igdb.com': {
    requestsPerSecond: 3.0,
    burst: 4,
    cooldownOnRateLimitSec: 60,
  },
  'pcgamingwiki.com': {
    requestsPerSecond: 1.0,
    burst: 2,
  },
  'en.wikipedia.org': {
    requestsPerSecond: 2.0,
    burst: 4,
  },
  default: {
    requestsPerSecond: 2.0,
    burst: 2,
  },
};

const CANONICAL_HOST_ALIASES: Record<string, string> = {
  'opencritic.com': 'api.opencritic.com',
  'gog.com': 'catalog.gog.com',
  'embed.gog.com': 'catalog.gog.com',
  'api.gog.com': 'catalog.gog.com',
  'menu.gog.com': 'catalog.gog.com',
  'epicgames.com': 'launcher.store.epicgames.com',
  'igdb.com': 'api.igdb.com',
  'wikipedia.org': 'en.wikipedia.org',
};

/**
 * Extracts a normalized lowercase hostname from a URL or bare host string
 * (stripping leading `www.`). Returns `'default'` for relative paths without a host.
 */
export function extractDomain(urlOrDomain: string): string {
  if (!urlOrDomain) return 'default';
  const trimmed = urlOrDomain.trim();
  if (!trimmed) return 'default';
  try {
    const parsed = new URL(trimmed);
    const host = parsed.hostname.toLowerCase().replace(/^www\./, '');
    return host || 'default';
  } catch {
    if (!trimmed.startsWith('/') && /^[a-z0-9.-]+\.[a-z]{2,}(?:[/:]|$)/i.test(trimmed)) {
      try {
        const parsed = new URL(`https://${trimmed}`);
        const host = parsed.hostname.toLowerCase().replace(/^www\./, '');
        return host || 'default';
      } catch {
        // Fall through
      }
    }
    return 'default';
  }
}

function matchConfiguredHost(host: string): string | null {
  if (!host || host === 'default') return null;
  if (DOMAIN_CONFIGS[host]) return host;
  if (CANONICAL_HOST_ALIASES[host]) return CANONICAL_HOST_ALIASES[host];
  for (const configured of Object.keys(DOMAIN_CONFIGS)) {
    if (configured !== 'default' && host.endsWith(`.${configured}`)) {
      return configured;
    }
  }
  for (const [suffix, canonical] of Object.entries(CANONICAL_HOST_ALIASES)) {
    if (host.endsWith(`.${suffix}`)) {
      return canonical;
    }
  }
  return null;
}

export class RequestScheduler {
  private buckets = new Map<string, TokenBucket>();
  private readonly maxRetries = 2;
  private enforceDelays: boolean = typeof process !== 'undefined' ? !process.env.VITEST : true;
  private interactiveScopes = new Set<string>();
  private inFlightP0Count = 0;
  private inGameThrottled = false;

  constructor() {
    this.initBuckets();
  }

  /**
   * Toggles in-game network throttling.
   * When enabled, P1_VIEWPORT and P2_BACKGROUND queued requests are held/deferred
   * across all domains while P0_INTERACTIVE requests continue to execute immediately.
   * When disabled, all domain queues are immediately kicked to resume.
   */
  public setInGameThrottle(throttled: boolean): void {
    this.inGameThrottled = Boolean(throttled);
    if (!this.inGameThrottled) {
      this.resumeAllQueues();
    }
  }

  public isInGameThrottled(): boolean {
    return this.inGameThrottled;
  }

  /**
   * Begins an interactive priority scope (e.g. Fix & Match Wizard or On-Demand Game Sync).
   * While any interactive scope is active, P2_BACKGROUND tasks are paused across all domains
   * so on-demand user actions have uncontested network priority.
   */
  public beginInteractiveScope(scopeId?: string): string {
    const id = scopeId || `interactive-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    this.interactiveScopes.add(id);
    return id;
  }

  /**
   * Ends an interactive priority scope and resumes queued background requests.
   */
  public endInteractiveScope(scopeId: string): void {
    if (this.interactiveScopes.delete(scopeId)) {
      this.resumeAllQueues();
    }
  }

  public isInteractivePreempted(): boolean {
    return this.interactiveScopes.size > 0 || this.inFlightP0Count > 0;
  }

  private isCandidateHeld(priority: number): boolean {
    if (this.inGameThrottled && priority > RequestPriority.P0_INTERACTIVE) {
      return true;
    }
    if (this.isInteractivePreempted() && priority >= RequestPriority.P2_BACKGROUND) {
      return true;
    }
    return false;
  }

  private sortBucketQueue(bucket: TokenBucket): void {
    if (bucket.queue.length > 1) {
      bucket.queue.sort((a, b) => a.priority - b.priority || a.queuedAt - b.queuedAt);
    }
  }

  private resumeAllQueues(): void {
    for (const domain of this.buckets.keys()) {
      this.processDomainQueue(domain);
    }
  }

  /**
   * Toggles whether rate-limiting delays are enforced.
   * Enabled by default in production; disabled in unit tests to prevent timeouts.
   */
  public setEnforceDelays(enforce: boolean): void {
    this.enforceDelays = enforce;
  }

  public getEnforceDelays(): boolean {
    return this.enforceDelays;
  }

  private initBuckets(): void {
    const defaultRateLimitCooldownSec: Record<string, number> = {
      'howlongtobeat.com': 180,
      'api.steampowered.com': 120,
    };
    for (const [domain, cfg] of Object.entries(DOMAIN_CONFIGS)) {
      const cooldownSec =
        cfg.cooldownOnRateLimitSec ?? defaultRateLimitCooldownSec[domain] ?? 0;
      this.buckets.set(domain, {
        tokens: cfg.burst,
        lastRefill: Date.now(),
        fillRate: cfg.requestsPerSecond,
        capacity: cfg.burst,
        cooldownUntil: 0,
        cooldownDurationMs: cooldownSec * 1000,
        consecutiveServerErrors: 0,
        wasCoolingDown: false,
        probeInFlight: false,
        activeInteractiveCount: 0,
        queue: [],
        timer: null,
        retryTimers: new Map(),
      });
    }
  }

  /**
   * Resolves a URL, path, or domain name to a canonical domain key.
   */
  public resolveDomain(urlOrDomain: string): string {
    if (!urlOrDomain) return 'default';
    const clean = urlOrDomain.trim().toLowerCase();

    if (DOMAIN_CONFIGS[clean]) {
      return clean;
    }
    if (CANONICAL_HOST_ALIASES[clean]) {
      return CANONICAL_HOST_ALIASES[clean];
    }

    // Check Vite dev-server relative proxy endpoints first
    if (clean.startsWith('/api/') || clean.includes('/api/')) {
      if (clean.includes('/api/steam-store')) return 'store.steampowered.com';
      if (clean.includes('/api/steam-api')) return 'api.steampowered.com';
      if (clean.includes('/api/steam-community')) return 'steamcommunity.com';
      if (clean.includes('/api/metacritic-backend')) return 'backend.metacritic.com';
      if (clean.includes('/api/metacritic')) return 'metacritic.com';
      if (clean.includes('/api/opencritic')) return 'api.opencritic.com';
      if (clean.includes('/api/lutris')) return 'lutris.net';
      if (clean.includes('/api/gog')) return 'catalog.gog.com';
      if (clean.includes('/api/epic')) return 'launcher.store.epicgames.com';
      if (clean.includes('/api/hltb')) return 'howlongtobeat.com';
    }

    // Parse URL hostname cleanly via new URL() without substring spoofing
    const host = extractDomain(urlOrDomain);
    if (host !== 'default') {
      return matchConfiguredHost(host) || 'default';
    }

    // Fallback for bare non-URL scope labels containing a discrete host token (not a full URL)
    if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(clean) && !clean.startsWith('/')) {
      const hostTokens = clean.match(/[a-z0-9-]+(?:\.[a-z0-9-]+)+/g);
      if (hostTokens) {
        for (const token of hostTokens) {
          const normalizedToken = token.replace(/^www\./, '');
          const matched = matchConfiguredHost(normalizedToken);
          if (matched) return matched;
        }
      }
    }

    return 'default';
  }

  private getBucket(domainKey: string): TokenBucket {
    let bucket = this.buckets.get(domainKey);
    if (!bucket) {
      const def = DOMAIN_CONFIGS.default;
      bucket = {
        tokens: def.burst,
        lastRefill: Date.now(),
        fillRate: def.requestsPerSecond,
        capacity: def.burst,
        cooldownUntil: 0,
        cooldownDurationMs: 0,
        consecutiveServerErrors: 0,
        wasCoolingDown: false,
        probeInFlight: false,
        activeInteractiveCount: 0,
        queue: [],
        timer: null,
        retryTimers: new Map(),
      };
      this.buckets.set(domainKey, bucket);
    }
    return bucket;
  }

  private refill(bucket: TokenBucket): void {
    const now = Date.now();
    const elapsedSec = (now - bucket.lastRefill) / 1000;
    if (elapsedSec > 0) {
      bucket.tokens = Math.min(bucket.capacity, bucket.tokens + elapsedSec * bucket.fillRate);
      bucket.lastRefill = now;
    }
  }

  /**
   * Checks whether the specified domain is currently in a rate limit cooldown.
   */
  public isRateLimited(domain: string): boolean {
    const key = this.resolveDomain(domain);
    const bucket = this.getBucket(key);
    return Date.now() < bucket.cooldownUntil;
  }

  /**
   * Returns the remaining cooldown duration in seconds, or 0 if not rate-limited.
   */
  public getCooldownRemaining(domain: string): number {
    const key = this.resolveDomain(domain);
    const bucket = this.getBucket(key);
    const remaining = bucket.cooldownUntil - Date.now();
    return remaining > 0 ? Math.ceil(remaining / 1000) : 0;
  }

  /**
   * Returns the maximum remaining cooldown duration in seconds across the specified domains
   * (or across all tracked domain buckets when omitted).
   */
  public getMaxCooldownRemaining(domains?: readonly string[]): number {
    const keys = domains ? domains.map((d) => this.resolveDomain(d)) : Array.from(this.buckets.keys());
    let maxSec = 0;
    for (const key of keys) {
      const sec = this.getCooldownRemaining(key);
      if (sec > maxSec) maxSec = sec;
    }
    return maxSec;
  }

  /**
   * Returns canonical domain keys currently in rate-limit/outage cooldown.
   */
  public getRateLimitedDomains(): string[] {
    const now = Date.now();
    const limited: string[] = [];
    for (const [domain, bucket] of this.buckets.entries()) {
      if (now < bucket.cooldownUntil) {
        limited.push(domain);
      }
    }
    return limited;
  }

  /**
   * Manually clears the cooldown for a domain.
   */
  public clearCooldown(domain: string): void {
    const key = this.resolveDomain(domain);
    const bucket = this.getBucket(key);
    const hadCooldown = bucket.cooldownUntil > 0 || bucket.wasCoolingDown;
    bucket.cooldownUntil = 0;
    bucket.wasCoolingDown = false;
    bucket.probeInFlight = false;
    bucket.consecutiveServerErrors = 0;
    if (hadCooldown) {
      onlineLifecycleManager.recordEndpointHealth({
        host: key,
        state: 'CLOSED',
        consecutiveFailures: 0,
        openedUntil: 0,
      });
    }
    this.processQueue(key);
  }

  /**
   * Manually sets a cooldown duration for a domain (in seconds).
   */
  public setCooldown(domain: string, seconds: number): void {
    const key = this.resolveDomain(domain);
    const bucket = this.getBucket(key);
    bucket.cooldownUntil = Date.now() + seconds * 1000;
    bucket.wasCoolingDown = seconds > 0;
  }

  /**
   * Schedules a task through the priority token bucket.
   */
  public schedule<T>(
    url: string,
    fn: () => Promise<T>,
    priority: number = RequestPriority.P1_VIEWPORT,
    domainKeyOrOptions?: string | ScheduleOptions,
    options?: string | { gameKey?: string }
  ): Promise<T> {
    const domainKey =
      typeof domainKeyOrOptions === 'string'
        ? domainKeyOrOptions
        : domainKeyOrOptions?.domainKey;
    const gameKey =
      typeof options === 'string'
        ? options
        : (typeof domainKeyOrOptions === 'object' && domainKeyOrOptions !== null
            ? domainKeyOrOptions.gameKey
            : undefined) ?? options?.gameKey;

    const domain = this.resolveDomain(domainKey || url);
    const bucket = this.getBucket(domain);

    if (this.isRateLimited(domain)) {
      const remaining = this.getCooldownRemaining(domain);
      const err: RateLimitSchedulerError = new Error(
        `Domain ${domain} is currently rate-limited. Cooldown remaining: ${remaining}s.`
      );
      err.isRateLimited = true;
      err.status = 429;
      err.cooldownRemaining = remaining;
      return Promise.reject(err);
    }

    return new Promise<T>((resolve, reject) => {
      const item: QueueItem<T> = {
        id: `req-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`,
        url,
        gameKey,
        fn,
        priority,
        domain,
        queuedAt: Date.now(),
        retries: 0,
        resolve,
        reject,
      };

      bucket.queue.push(item as unknown as QueueItem<unknown>);
      this.sortBucketQueue(bucket);
      this.processQueue(domain);
    });
  }

  /**
   * Alias for schedule() so callers using either method name route through the same priority token bucket.
   */
  public enqueue<T>(
    url: string,
    fn: () => Promise<T>,
    priority: number = RequestPriority.P1_VIEWPORT,
    domainKeyOrOptions?: string | ScheduleOptions,
    options?: string | { gameKey?: string }
  ): Promise<T> {
    return this.schedule(url, fn, priority, domainKeyOrOptions, options);
  }

  private processQueue(domain: string): void {
    this.processDomainQueue(domain);
  }

  private processDomainQueue(domain: string): void {
    const bucket = this.getBucket(domain);

    if (bucket.timer) {
      clearTimeout(bucket.timer);
      bucket.timer = null;
    }

    const now = Date.now();
    if (bucket.cooldownUntil > now) {
      const delay = bucket.cooldownUntil - now;
      bucket.timer = setTimeout(() => this.processDomainQueue(domain), Math.min(delay, 2147483647));
      return;
    }

    // HALF_OPEN canary probe: when a domain's cooldown just expired, dispatch only 1 item first
    // before draining the remainder of the queue so a still-throttled upstream isn't stampeded.
    if (bucket.wasCoolingDown) {
      if (bucket.probeInFlight) {
        return;
      }
      const nextCandidate = bucket.queue[0];
      if (!nextCandidate || this.isCandidateHeld(nextCandidate.priority)) {
        return;
      }
      if (this.enforceDelays) {
        this.refill(bucket);
        if (
          nextCandidate.priority === RequestPriority.P0_INTERACTIVE &&
          bucket.tokens < 1 &&
          bucket.activeInteractiveCount < 2
        ) {
          bucket.tokens = 1;
        }
        if (bucket.tokens < 1) {
          const tokensNeeded = 1 - bucket.tokens;
          const waitMs = Math.ceil((tokensNeeded / bucket.fillRate) * 1000);
          bucket.timer = setTimeout(() => this.processDomainQueue(domain), Math.max(10, waitMs));
          return;
        }
        bucket.tokens -= 1;
      }
      bucket.probeInFlight = true;
      onlineLifecycleManager.recordEndpointHealth({
        host: domain,
        state: 'HALF_OPEN',
        consecutiveFailures: bucket.consecutiveServerErrors,
        openedUntil: 0,
      });
      const canaryItem = bucket.queue.shift()!;
      void this.executeItem(domain, bucket, canaryItem);
      return;
    }

    if (!this.enforceDelays) {
      while (bucket.queue.length > 0) {
        const nextCandidate = bucket.queue[0];
        if (!nextCandidate || this.isCandidateHeld(nextCandidate.priority)) {
          break;
        }
        const item = bucket.queue.shift();
        if (!item) break;
        void this.executeItem(domain, bucket, item);
      }
      return;
    }

    this.refill(bucket);

    while (bucket.queue.length > 0) {
      const nextCandidate = bucket.queue[0];
      if (!nextCandidate || this.isCandidateHeld(nextCandidate.priority)) {
        break;
      }

      // Bounded fast-lane for P0_INTERACTIVE: grant an immediate priority token boost for up to 2
      // concurrent interactive requests per domain so on-demand user actions never stall behind
      // background token depletion without triggering an unbounded Akamai 429 burst stampede.
      if (
        nextCandidate.priority === RequestPriority.P0_INTERACTIVE &&
        bucket.tokens < 1 &&
        bucket.activeInteractiveCount < 2
      ) {
        bucket.tokens = 1;
      }

      if (bucket.tokens < 1) {
        break;
      }

      bucket.tokens -= 1;
      const item = bucket.queue.shift()!;
      void this.executeItem(domain, bucket, item);
    }

    if (bucket.queue.length > 0 && bucket.tokens < 1) {
      const nextCandidate = bucket.queue[0];
      if (nextCandidate && !this.isCandidateHeld(nextCandidate.priority)) {
        const tokensNeeded = 1 - bucket.tokens;
        const waitMs = Math.ceil((tokensNeeded / bucket.fillRate) * 1000);
        bucket.timer = setTimeout(() => this.processDomainQueue(domain), Math.max(10, waitMs));
      }
    }
  }

  /**
   * Promotes queued requests matching an exact URL or `gameKey` across buckets to P0_INTERACTIVE.
   * When given a bare domain hostname (or `options.wholeDomain === true`) and no exact URL/`gameKey`
   * matches, promotes up to `options.maxItems` (default 8, unlimited when `wholeDomain: true`)
   * highest-priority queued items in that domain bucket so deduplicated callers never stall
   * behind deep background queues without stampeding hundreds of background items.
   */
  public promoteToInteractive(
    urlOrDomainOrGameKey: string,
    options?: { wholeDomain?: boolean; maxItems?: number }
  ): void {
    if (!urlOrDomainOrGameKey) return;
    const target = urlOrDomainOrGameKey.trim();
    if (!target) return;

    const affectedDomains = new Set<string>();

    // 1. Exact URL or gameKey match across all buckets
    for (const [domainKey, bucket] of this.buckets.entries()) {
      let bucketPromoted = false;
      for (const item of bucket.queue) {
        if (
          (item.url === target || (item.gameKey !== undefined && item.gameKey === target)) &&
          item.priority > RequestPriority.P0_INTERACTIVE
        ) {
          item.priority = RequestPriority.P0_INTERACTIVE;
          bucketPromoted = true;
        }
      }
      if (bucketPromoted) {
        affectedDomains.add(domainKey);
      }
    }

    // 2. Domain-level promotion when explicitly requested or when a bare domain hostname was passed
    const resolvedDomain = this.resolveDomain(target);
    const isBareHostname =
      !/^[a-z][a-z0-9+.-]*:\/\//i.test(target) &&
      !target.startsWith('/') &&
      (resolvedDomain !== 'default' || target.toLowerCase() === 'default');

    if (options?.wholeDomain || (affectedDomains.size === 0 && isBareHostname)) {
      const bucket = this.getBucket(resolvedDomain);
      const limit = options?.wholeDomain
        ? (options.maxItems ?? Number.POSITIVE_INFINITY)
        : (options?.maxItems ?? 8);
      let count = 0;
      for (const item of bucket.queue) {
        if (count >= limit) break;
        if (item.priority > RequestPriority.P0_INTERACTIVE) {
          item.priority = RequestPriority.P0_INTERACTIVE;
          count++;
        }
      }
      if (count > 0) {
        affectedDomains.add(resolvedDomain);
      }
    }

    for (const domainKey of affectedDomains) {
      const bucket = this.getBucket(domainKey);
      this.sortBucketQueue(bucket);
      this.processDomainQueue(domainKey);
    }
  }

  /**
   * Promotes all queued requests tagged with `gameKey` across every domain bucket to P0_INTERACTIVE.
   */
  public promoteGameToInteractive(gameKey: string): void {
    if (!gameKey) return;
    const affectedDomains: string[] = [];
    for (const [domainKey, bucket] of this.buckets.entries()) {
      let promoted = false;
      for (const item of bucket.queue) {
        if (item.gameKey === gameKey && item.priority > RequestPriority.P0_INTERACTIVE) {
          item.priority = RequestPriority.P0_INTERACTIVE;
          promoted = true;
        }
      }
      if (promoted) {
        affectedDomains.push(domainKey);
      }
    }
    for (const domainKey of affectedDomains) {
      const bucket = this.getBucket(domainKey);
      this.sortBucketQueue(bucket);
      this.processDomainQueue(domainKey);
    }
  }

  private parseRetryAfterMs(headers: unknown): number {
    if (!headers || typeof headers !== 'object') return 0;
    const headerObj = headers as {
      get?: (name: string) => string | null;
      [key: string]: unknown;
    };
    const raw =
      typeof headerObj.get === 'function'
        ? headerObj.get('retry-after') ?? headerObj.get('Retry-After')
        : headerObj['retry-after'] ?? headerObj['Retry-After'];
    if (raw === undefined || raw === null) return 0;
    const str = Array.isArray(raw) ? String(raw[0] || '') : String(raw);
    const trimmed = str.trim();
    if (!trimmed) return 0;
    const numericSec = Number(trimmed);
    if (Number.isFinite(numericSec) && numericSec > 0) {
      return Math.ceil(numericSec * 1000);
    }
    const parsedDate = Date.parse(trimmed);
    if (!Number.isNaN(parsedDate)) {
      const deltaMs = parsedDate - Date.now();
      return deltaMs > 0 ? deltaMs : 0;
    }
    return 0;
  }

  private async executeItem(
    domain: string,
    bucket: TokenBucket,
    item: QueueItem<unknown>
  ): Promise<void> {
    const isP0 = item.priority === RequestPriority.P0_INTERACTIVE;
    if (isP0) {
      this.inFlightP0Count++;
      bucket.activeInteractiveCount++;
    }
    try {
      const result = await item.fn();
      const recovered = bucket.wasCoolingDown || bucket.consecutiveServerErrors >= 3;
      bucket.consecutiveServerErrors = 0;
      bucket.wasCoolingDown = false;
      bucket.probeInFlight = false;
      if (recovered) {
        onlineLifecycleManager.recordEndpointHealth({
          host: domain,
          state: 'CLOSED',
          consecutiveFailures: 0,
          openedUntil: 0,
        });
      }
      item.resolve(result);
    } catch (err: unknown) {
      bucket.probeInFlight = false;
      const httpErr = (err && typeof err === 'object' ? err : {}) as SchedulerHttpError;
      const status: number | undefined = httpErr.response?.status ?? httpErr.status;
      const headers = httpErr.response?.headers ?? httpErr.headers;
      const body = httpErr.response?.data;
      const retryAfterMs =
        status === 429 || status === 503 ? this.parseRetryAfterMs(headers) : 0;
      const isWafChallenge = isWafOrChallengeResponse(
        status,
        body,
        headers as Record<string, unknown> | Headers | undefined
      );
      const isRateLimit = status === 429 || status === 403 || isWafChallenge;
      const isServerError = typeof status === 'number' && status >= 500;
      const errCode = String(httpErr.code || '');
      const errMsg = String(httpErr.message || '');
      const isTimeout =
        errCode === 'ECONNABORTED' ||
        errCode === 'ETIMEDOUT' ||
        /timeout|timed out|aborted/i.test(errMsg);
      const isOnline = onlineLifecycleManager.isOnline();

      if (isRateLimit && isOnline && (this.enforceDelays || domain === 'store.steampowered.com')) {
        const cooldownMs = retryAfterMs > 0 ? retryAfterMs : bucket.cooldownDurationMs;
        if (cooldownMs > 0) {
          bucket.cooldownUntil = Date.now() + cooldownMs;
          bucket.wasCoolingDown = true;
          onlineLifecycleManager.recordEndpointHealth({
            host: domain,
            state: 'OPEN',
            consecutiveFailures: Math.max(1, bucket.consecutiveServerErrors + 1),
            openedUntil: bucket.cooldownUntil,
            lastStatusCode: status,
            lastError: httpErr.message,
          });
          console.warn(
            `[RequestScheduler] Domain ${domain} received HTTP ${status ?? 'WAF'}. Entering cooldown for ${Math.round(cooldownMs / 1000)}s.`
          );
        }
      } else if ((isServerError || isTimeout) && isOnline) {
        bucket.consecutiveServerErrors += 1;
        if (this.enforceDelays && bucket.consecutiveServerErrors >= 3) {
          const step = Math.min(2, bucket.consecutiveServerErrors - 3);
          const progressiveOutageMs = Math.min(120_000, 30_000 * Math.pow(2, step));
          const outageCooldownMs = Math.max(retryAfterMs, progressiveOutageMs);
          bucket.cooldownUntil = Date.now() + outageCooldownMs;
          bucket.wasCoolingDown = true;
          onlineLifecycleManager.recordEndpointHealth({
            host: domain,
            state: 'OPEN',
            consecutiveFailures: bucket.consecutiveServerErrors,
            openedUntil: bucket.cooldownUntil,
            lastStatusCode: status,
            lastError: httpErr.message,
          });
          console.warn(
            `[RequestScheduler] Domain ${domain} hit ${bucket.consecutiveServerErrors} consecutive server/timeout errors. Entering ${Math.round(outageCooldownMs / 1000)}s outage cooldown.`
          );
        }
      }

      if ((isRateLimit || isServerError) && item.retries < this.maxRetries && bucket.cooldownUntil <= Date.now()) {
        item.retries++;
        const jitter = Math.random() * 100;
        const computedBackoff =
          retryAfterMs > 0
            ? Math.min(5000, retryAfterMs)
            : Math.min(5000, 200 * Math.pow(2, item.retries) + jitter);
        const backoffMs = this.enforceDelays ? computedBackoff : 0;
        const retryTimer = setTimeout(() => {
          bucket.retryTimers.delete(retryTimer);
          bucket.queue.push(item);
          this.sortBucketQueue(bucket);
          this.processDomainQueue(domain);
        }, backoffMs);
        bucket.retryTimers.set(retryTimer, item);
        return;
      }

      item.reject(err);
    } finally {
      if (isP0) {
        bucket.activeInteractiveCount = Math.max(0, bucket.activeInteractiveCount - 1);
        this.inFlightP0Count = Math.max(0, this.inFlightP0Count - 1);
        if (this.inFlightP0Count === 0 && this.interactiveScopes.size === 0) {
          this.resumeAllQueues();
        }
      }
      this.processDomainQueue(domain);
    }
  }

  /**
   * Resets all internal queues, retry timers, and token states, rejecting pending queued items
   * with an AbortError so callers never hang indefinitely.
   */
  public reset(): void {
    const abortErr = createAbortError('RequestScheduler reset');
    for (const bucket of this.buckets.values()) {
      if (bucket.timer) {
        clearTimeout(bucket.timer);
        bucket.timer = null;
      }
      if (bucket.retryTimers.size > 0) {
        const pendingRetries = Array.from(bucket.retryTimers.entries());
        bucket.retryTimers.clear();
        for (const [retryTimer, retryItem] of pendingRetries) {
          clearTimeout(retryTimer);
          retryItem.reject(abortErr);
        }
      }
      if (bucket.queue.length > 0) {
        const queued = bucket.queue.splice(0, bucket.queue.length);
        for (const item of queued) {
          item.reject(abortErr);
        }
      }
      bucket.cooldownUntil = 0;
      bucket.consecutiveServerErrors = 0;
      bucket.wasCoolingDown = false;
      bucket.probeInFlight = false;
      bucket.activeInteractiveCount = 0;
    }
    this.interactiveScopes.clear();
    this.inFlightP0Count = 0;
    this.inGameThrottled = false;
    this.buckets.clear();
    this.initBuckets();
  }

  /**
   * Returns current queue size for a domain (or total across all domains).
   */
  public getQueueLength(domain?: string): number {
    if (domain) {
      const key = this.resolveDomain(domain);
      return this.buckets.get(key)?.queue.length || 0;
    }
    let total = 0;
    for (const b of this.buckets.values()) {
      total += b.queue.length;
    }
    return total;
  }

  /**
   * Flushes queued P2_BACKGROUND items across all domains so a newly started or cancelled sync
   * does not stall behind stale background requests.
   */
  public clearBackgroundQueues(): void {
    for (const [domain, bucket] of this.buckets.entries()) {
      const remaining: Array<QueueItem<unknown>> = [];
      for (const item of bucket.queue) {
        if (item.priority >= RequestPriority.P2_BACKGROUND) {
          item.reject(new Error('Cancelled stale background request'));
        } else {
          remaining.push(item);
        }
      }
      bucket.queue = remaining;
      this.processQueue(domain);
    }
  }
}

export const requestScheduler = new RequestScheduler();
