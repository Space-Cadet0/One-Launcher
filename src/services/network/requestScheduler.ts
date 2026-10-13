/**
 * Request Scheduler & Token Bucket Rate Limiter
 * Provides domain-specific token bucket throttling, priority queue scheduling (P0 > P1 > P2),
 * Akamai/CDN cooldown tracking, and jittered exponential backoff.
 */

export enum RequestPriority {
  P0_INTERACTIVE = 0,
  P1_VIEWPORT = 1,
  P2_BACKGROUND = 2,
}

export const Priority = RequestPriority;

export interface DomainConfig {
  requestsPerSecond: number; // Token fill rate
  burst: number;             // Maximum token bucket capacity
  cooldownOnRateLimitSec?: number; // Akamai or server cooldown on 429/403
}

export interface QueueItem<T> {
  id: string;
  url: string;
  fn: () => Promise<T>;
  priority: number;
  domain: string;
  queuedAt: number;
  retries: number;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: any) => void;
}

export interface TokenBucket {
  tokens: number;
  lastRefill: number;
  fillRate: number;
  capacity: number;
  cooldownUntil: number;
  cooldownDurationMs: number;
  queue: QueueItem<any>[];
  timer: any;
}

export const DOMAIN_CONFIGS: Record<string, DomainConfig> = {
  'store.steampowered.com': {
    requestsPerSecond: 0.5,
    burst: 2,
    cooldownOnRateLimitSec: 900, // 15-minute Akamai edge cooldown
  },
  'steamcommunity.com': {
    requestsPerSecond: 1.0,
    burst: 3,
  },
  'metacritic.com': {
    requestsPerSecond: 0.33,
    burst: 1,
  },
  'api.opencritic.com': {
    requestsPerSecond: 2.0,
    burst: 5,
  },
  'lutris.net': {
    requestsPerSecond: 0.5,
    burst: 2,
  },
  'catalog.gog.com': {
    requestsPerSecond: 1.0,
    burst: 2,
  },
  'launcher.store.epicgames.com': {
    requestsPerSecond: 1.0,
    burst: 2,
  },
  'howlongtobeat.com': {
    requestsPerSecond: 1.0,
    burst: 2,
  },
  default: {
    requestsPerSecond: 2.0,
    burst: 2,
  },
};

export class RequestScheduler {
  private buckets = new Map<string, TokenBucket>();
  private readonly maxRetries = 2;
  private enforceDelays: boolean = typeof process !== 'undefined' ? !process.env.VITEST : true;

  constructor() {
    this.initBuckets();
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
    for (const [domain, cfg] of Object.entries(DOMAIN_CONFIGS)) {
      this.buckets.set(domain, {
        tokens: cfg.burst,
        lastRefill: Date.now(),
        fillRate: cfg.requestsPerSecond,
        capacity: cfg.burst,
        cooldownUntil: 0,
        cooldownDurationMs: (cfg.cooldownOnRateLimitSec || 0) * 1000,
        queue: [],
        timer: null,
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

    // Check Vite proxy endpoints
    if (clean.includes('/api/steam-store')) return 'store.steampowered.com';
    if (clean.includes('/api/steam-community')) return 'steamcommunity.com';
    if (clean.includes('/api/metacritic')) return 'metacritic.com';
    if (clean.includes('/api/opencritic')) return 'api.opencritic.com';
    if (clean.includes('/api/lutris')) return 'lutris.net';
    if (clean.includes('/api/gog')) return 'catalog.gog.com';
    if (clean.includes('/api/epic')) return 'launcher.store.epicgames.com';
    if (clean.includes('/api/hltb') || clean.includes('howlongtobeat.com')) return 'howlongtobeat.com';

    // Check domain string containment
    if (clean.includes('store.steampowered.com')) return 'store.steampowered.com';
    if (clean.includes('steamcommunity.com')) return 'steamcommunity.com';
    if (clean.includes('metacritic.com')) return 'metacritic.com';
    if (clean.includes('opencritic.com')) return 'api.opencritic.com';
    if (clean.includes('lutris.net')) return 'lutris.net';
    if (clean.includes('gog.com')) return 'catalog.gog.com';
    if (clean.includes('epicgames.com')) return 'launcher.store.epicgames.com';

    try {
      const parsed = new URL(urlOrDomain);
      const host = parsed.hostname.toLowerCase();
      if (DOMAIN_CONFIGS[host]) return host;
      for (const d of Object.keys(DOMAIN_CONFIGS)) {
        if (host.endsWith(d)) return d;
      }
    } catch {}

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
        queue: [],
        timer: null,
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
   * Manually clears the cooldown for a domain.
   */
  public clearCooldown(domain: string): void {
    const key = this.resolveDomain(domain);
    const bucket = this.getBucket(key);
    bucket.cooldownUntil = 0;
    this.processQueue(key);
  }

  /**
   * Manually sets a cooldown duration for a domain (in seconds).
   */
  public setCooldown(domain: string, seconds: number): void {
    const key = this.resolveDomain(domain);
    const bucket = this.getBucket(key);
    bucket.cooldownUntil = Date.now() + seconds * 1000;
  }

  /**
   * Schedules a task through the priority token bucket.
   */
  public schedule<T>(
    url: string,
    fn: () => Promise<T>,
    priority: number = RequestPriority.P1_VIEWPORT,
    domainKey?: string
  ): Promise<T> {
    const domain = this.resolveDomain(domainKey || url);
    const bucket = this.getBucket(domain);

    if (this.isRateLimited(domain)) {
      const remaining = this.getCooldownRemaining(domain);
      const err: any = new Error(
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
        fn,
        priority,
        domain,
        queuedAt: Date.now(),
        retries: 0,
        resolve,
        reject,
      };

      bucket.queue.push(item);
      this.processQueue(domain);
    });
  }

  private processQueue(domain: string): void {
    const bucket = this.getBucket(domain);

    if (bucket.timer) {
      clearTimeout(bucket.timer);
      bucket.timer = null;
    }

    const now = Date.now();
    if (bucket.cooldownUntil > now) {
      const delay = bucket.cooldownUntil - now;
      bucket.timer = setTimeout(() => this.processQueue(domain), Math.min(delay, 2147483647));
      return;
    }

    if (!this.enforceDelays) {
      while (bucket.queue.length > 0) {
        bucket.queue.sort((a, b) => a.priority - b.priority || a.queuedAt - b.queuedAt);
        const item = bucket.queue.shift();
        if (!item) break;
        this.executeItem(domain, bucket, item);
      }
      return;
    }

    this.refill(bucket);

    while (bucket.queue.length > 0 && bucket.tokens >= 1) {
      bucket.tokens -= 1;
      // Sort queue: lowest priority number first (P0 < P1 < P2), then FIFO
      bucket.queue.sort((a, b) => a.priority - b.priority || a.queuedAt - b.queuedAt);
      const item = bucket.queue.shift();
      if (!item) break;

      this.executeItem(domain, bucket, item);
    }

    if (bucket.queue.length > 0 && bucket.tokens < 1) {
      const tokensNeeded = 1 - bucket.tokens;
      const waitMs = Math.ceil((tokensNeeded / bucket.fillRate) * 1000);
      bucket.timer = setTimeout(() => this.processQueue(domain), Math.max(10, waitMs));
    }
  }

  private async executeItem(domain: string, bucket: TokenBucket, item: QueueItem<any>): Promise<void> {
    try {
      const result = await item.fn();
      item.resolve(result);
    } catch (err: any) {
      const status = err?.response?.status || err?.status;
      const isRateLimit = status === 429 || status === 403;
      const isServerError = status === 503;

      if (isRateLimit && bucket.cooldownDurationMs > 0) {
        bucket.cooldownUntil = Date.now() + bucket.cooldownDurationMs;
        console.warn(
          `[RequestScheduler] Domain ${domain} received HTTP ${status}. Entering cooldown for ${bucket.cooldownDurationMs / 1000}s.`
        );
      }

      if ((isRateLimit || isServerError) && item.retries < this.maxRetries && bucket.cooldownUntil <= Date.now()) {
        item.retries++;
        const jitter = Math.random() * 100;
        const backoffMs = Math.min(5000, 200 * Math.pow(2, item.retries) + jitter);
        setTimeout(() => {
          bucket.queue.push(item);
          this.processQueue(domain);
        }, backoffMs);
        return;
      }

      item.reject(err);
    } finally {
      this.processQueue(domain);
    }
  }

  /**
   * Resets all internal queues, timers, and token states (primarily for testing).
   */
  public reset(): void {
    for (const bucket of this.buckets.values()) {
      if (bucket.timer) {
        clearTimeout(bucket.timer);
        bucket.timer = null;
      }
      bucket.queue = [];
      bucket.cooldownUntil = 0;
    }
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
}

export const requestScheduler = new RequestScheduler();
