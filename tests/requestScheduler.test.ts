import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  requestScheduler,
  RequestPriority,
  DOMAIN_CONFIGS,
} from '../src/services/network/requestScheduler';
import { syncJobManager, SyncJobState } from '../src/services/network/syncJobManager';
import React from 'react';
import { renderToString } from 'react-dom/server';
import { GlobalSyncProgressBar } from '../src/components/Navigation/GlobalSyncProgressBar';
import { CanonicalGame } from '../src/contracts/game';
import { steamApi } from '../src/services/steam/steamApi';

describe('Request Scheduler & Token Bucket Rate Limiter', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    requestScheduler.setEnforceDelays(true);
    requestScheduler.reset();
    syncJobManager.reset();
  });

  afterEach(() => {
    requestScheduler.reset();
    requestScheduler.setEnforceDelays(false);
    syncJobManager.reset();
    vi.useRealTimers();
  });

  describe('Domain Configuration & URL Resolution', () => {
    it('correctly maps various URLs and proxy paths to canonical domains', () => {
      expect(
        requestScheduler.resolveDomain('https://store.steampowered.com/api/appdetails?appids=10')
      ).toBe('store.steampowered.com');
      expect(requestScheduler.resolveDomain('/api/steam-store/appdetails')).toBe(
        'store.steampowered.com'
      );
      expect(requestScheduler.resolveDomain('/api/steam-community/profiles')).toBe(
        'steamcommunity.com'
      );
      expect(requestScheduler.resolveDomain('https://www.metacritic.com/game/halo/')).toBe(
        'metacritic.com'
      );
      expect(requestScheduler.resolveDomain('/api/metacritic/game/halo')).toBe('metacritic.com');
      expect(requestScheduler.resolveDomain('https://api.opencritic.com/api/game/123')).toBe(
        'api.opencritic.com'
      );
      expect(requestScheduler.resolveDomain('/api/lutris/games')).toBe('lutris.net');
      expect(requestScheduler.resolveDomain('/api/gog/products/123')).toBe('catalog.gog.com');
      expect(requestScheduler.resolveDomain('/api/epic/content')).toBe(
        'launcher.store.epicgames.com'
      );
      expect(requestScheduler.resolveDomain('https://unknown-domain.org/test')).toBe('default');
    });

    it('has expected domain rate limits and burst capacities configured', () => {
      expect(DOMAIN_CONFIGS['store.steampowered.com'].requestsPerSecond).toBe(0.5);
      expect(DOMAIN_CONFIGS['store.steampowered.com'].burst).toBe(2);
      expect(DOMAIN_CONFIGS['store.steampowered.com'].cooldownOnRateLimitSec).toBe(900);

      expect(DOMAIN_CONFIGS['metacritic.com'].requestsPerSecond).toBe(0.33);
      expect(DOMAIN_CONFIGS['metacritic.com'].burst).toBe(1);

      expect(DOMAIN_CONFIGS['api.opencritic.com'].requestsPerSecond).toBe(2.0);
      expect(DOMAIN_CONFIGS['api.opencritic.com'].burst).toBe(5);
    });
  });

  describe('Priority Queue Ordering', () => {
    it('executes P0_INTERACTIVE ahead of P1_VIEWPORT and P2_BACKGROUND', async () => {
      const executionOrder: string[] = [];

      // Artificially deplete tokens for domain first so all new items must wait in queue
      const domain = 'test.domain.com';
      await requestScheduler.schedule(`https://${domain}/init1`, async () => {}, RequestPriority.P2_BACKGROUND, domain);
      await requestScheduler.schedule(`https://${domain}/init2`, async () => {}, RequestPriority.P2_BACKGROUND, domain);

      // Now with 0 tokens available, schedule P2, P1, and P0
      const p2Promise = requestScheduler.schedule(
        `https://${domain}/item1`,
        async () => {
          executionOrder.push('P2');
          return 'p2';
        },
        RequestPriority.P2_BACKGROUND,
        domain
      );

      const p1Promise = requestScheduler.schedule(
        `https://${domain}/item2`,
        async () => {
          executionOrder.push('P1');
          return 'p1';
        },
        RequestPriority.P1_VIEWPORT,
        domain
      );

      const p0Promise = requestScheduler.schedule(
        `https://${domain}/item3`,
        async () => {
          executionOrder.push('P0');
          return 'p0';
        },
        RequestPriority.P0_INTERACTIVE,
        domain
      );

      // Run pending timers and promises
      await vi.runAllTimersAsync();
      await Promise.all([p0Promise, p1Promise, p2Promise]);

      expect(executionOrder).toEqual(['P0', 'P1', 'P2']);
    });

    it('maintains FIFO order within the same priority level', async () => {
      const order: number[] = [];
      const domain = 'store.steampowered.com';

      // Steam burst is 2. Queue 4 requests with P1_VIEWPORT.
      const p1 = requestScheduler.schedule(
        'https://store.steampowered.com/1',
        async () => {
          order.push(1);
        },
        RequestPriority.P1_VIEWPORT
      );
      const p2 = requestScheduler.schedule(
        'https://store.steampowered.com/2',
        async () => {
          order.push(2);
        },
        RequestPriority.P1_VIEWPORT
      );
      const p3 = requestScheduler.schedule(
        'https://store.steampowered.com/3',
        async () => {
          order.push(3);
        },
        RequestPriority.P1_VIEWPORT
      );
      const p4 = requestScheduler.schedule(
        'https://store.steampowered.com/4',
        async () => {
          order.push(4);
        },
        RequestPriority.P1_VIEWPORT
      );

      await vi.runAllTimersAsync();
      await Promise.all([p1, p2, p3, p4]);

      expect(order).toEqual([1, 2, 3, 4]);
    });
  });

  describe('Cooldown & Akamai Edge Rate Limiting', () => {
    it('sets 900s cooldown on store.steampowered.com on 429 response', async () => {
      const domain = 'store.steampowered.com';
      expect(requestScheduler.isRateLimited(domain)).toBe(false);

      const failCall = () =>
        requestScheduler.schedule(
          'https://store.steampowered.com/test',
          async () => {
            const err: any = new Error('Too Many Requests');
            err.response = { status: 429 };
            throw err;
          },
          RequestPriority.P1_VIEWPORT
        );

      await expect(failCall()).rejects.toThrow();

      // Cooldown must now be active
      expect(requestScheduler.isRateLimited(domain)).toBe(true);
      expect(requestScheduler.getCooldownRemaining(domain)).toBeGreaterThan(0);
      expect(requestScheduler.getCooldownRemaining(domain)).toBeLessThanOrEqual(900);
    });

    it('rejects subsequent schedule requests immediately when domain is rate-limited', async () => {
      const domain = 'store.steampowered.com';
      requestScheduler.setCooldown(domain, 600);

      expect(requestScheduler.isRateLimited(domain)).toBe(true);
      expect(requestScheduler.getCooldownRemaining(domain)).toBe(600);

      await expect(
        requestScheduler.schedule('https://store.steampowered.com/app/1', async () => 'ok')
      ).rejects.toThrow(/rate-limited/);
    });

    it('clearCooldown resets the rate limit status and remaining time', () => {
      const domain = 'store.steampowered.com';
      requestScheduler.setCooldown(domain, 300);
      expect(requestScheduler.isRateLimited(domain)).toBe(true);

      requestScheduler.clearCooldown(domain);
      expect(requestScheduler.isRateLimited(domain)).toBe(false);
      expect(requestScheduler.getCooldownRemaining(domain)).toBe(0);
    });
  });

  describe('Jittered Exponential Backoff on Retryable HTTP Errors', () => {
    it('retries on 503 error with backoff and succeeds on next attempt', async () => {
      let attempts = 0;
      const fn = vi.fn().mockImplementation(async () => {
        attempts++;
        if (attempts === 1) {
          const err: any = new Error('Service Unavailable');
          err.response = { status: 503 };
          throw err;
        }
        return 'success';
      });

      const promise = requestScheduler.schedule(
        'https://api.opencritic.com/retry-test',
        fn,
        RequestPriority.P1_VIEWPORT,
        'api.opencritic.com'
      );

      await vi.runAllTimersAsync();
      const res = await promise;

      expect(res).toBe('success');
      expect(attempts).toBe(2);
    });
  });
});

describe('SyncJobManager & Navigation Resilience', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    requestScheduler.reset();
    syncJobManager.reset();
  });

  afterEach(() => {
    requestScheduler.reset();
    syncJobManager.reset();
    vi.useRealTimers();
  });

  const mockGames: CanonicalGame[] = [
    {
      id: 'steam-10',
      title: 'Counter-Strike',
      steamAppId: 10,
      platforms: [{ platformId: 'steam', platformGameId: '10' }],
    },
    {
      id: 'steam-20',
      title: 'Team Fortress Classic',
      steamAppId: 20,
      platforms: [{ platformId: 'steam', platformGameId: '20' }],
    },
    {
      id: 'steam-30',
      title: 'Day of Defeat',
      steamAppId: 30,
      platforms: [{ platformId: 'steam', platformGameId: '30' }],
    },
  ];

  it('runs sync job to completion, publishing progress updates and invoking onGameUpdated', async () => {
    const states: (SyncJobState | null)[] = [];
    const updatedGames: CanonicalGame[] = [];

    const unsubscribe = syncJobManager.subscribe((st) => {
      states.push(st);
    });

    vi.spyOn(steamApi, 'fetchGameMetadata').mockImplementation(async (appId) => {
      return {
        appId,
        name: `Game ${appId}`,
        shortDescription: `Desc for ${appId}`,
        headerImage: `https://example.com/${appId}.jpg`,
      } as any;
    });

    const syncPromise = syncJobManager.startStoreMediaSync(mockGames, (g) => {
      updatedGames.push(g);
    });

    await vi.runAllTimersAsync();
    await syncPromise;

    const finalState = syncJobManager.getState();
    expect(finalState?.status).toBe('completed');
    expect(finalState?.current).toBe(3);
    expect(finalState?.total).toBe(3);
    expect(updatedGames.length).toBe(3);
    expect(updatedGames[0].shortDescription).toBe('Desc for 10');

    unsubscribe();
  });

  it('supports pauseJob and resumeJob transitions', async () => {
    let callCount = 0;
    vi.spyOn(steamApi, 'fetchGameMetadata').mockImplementation(async (appId) => {
      callCount++;
      return { appId, name: `Title ${appId}` } as any;
    });

    const syncPromise = syncJobManager.startStoreMediaSync(mockGames, () => {});

    // Initial state running
    expect(syncJobManager.getState()?.status).toBe('running');
    const jobId = syncJobManager.getState()!.id;

    // Pause job
    syncJobManager.pauseJob(jobId);
    expect(syncJobManager.getState()?.status).toBe('paused');

    // Resume job
    syncJobManager.resumeJob(jobId);
    expect(syncJobManager.getState()?.status).toBe('running');

    await vi.runAllTimersAsync();
    await syncPromise;

    expect(syncJobManager.getState()?.status).toBe('completed');
  });

  it('supports cancelJob to abort synchronization cleanly', async () => {
    vi.spyOn(steamApi, 'fetchGameMetadata').mockImplementation(async (appId) => {
      return { appId, name: `Title ${appId}` } as any;
    });

    const syncPromise = syncJobManager.startStoreMediaSync(mockGames, () => {});
    const jobId = syncJobManager.getState()!.id;

    syncJobManager.cancelJob(jobId);
    expect(syncJobManager.getState()?.status).toBe('cancelled');

    await vi.runAllTimersAsync();
    await syncPromise;

    expect(syncJobManager.getState()?.status).toBe('cancelled');
  });

  it('handles Akamai rate limit transition with cooldown countdown', async () => {
    let cooldownTriggered = false;
    vi.spyOn(steamApi, 'fetchGameMetadata').mockImplementation(async (appId) => {
      if (appId === 10 && !cooldownTriggered) {
        cooldownTriggered = true;
        // Trigger edge cooldown
        requestScheduler.setCooldown('store.steampowered.com', 2);
        const err: any = new Error('Rate Limited');
        err.isRateLimited = true;
        throw err;
      }
      return { appId, name: `Title ${appId}` } as any;
    });

    const syncPromise = syncJobManager.startStoreMediaSync(mockGames, () => {});

    // Let the loop hit the rate limit
    await vi.advanceTimersByTimeAsync(100);

    // It should now reflect rate_limited status
    expect(syncJobManager.getState()?.status).toBe('rate_limited');
    expect(syncJobManager.getState()?.cooldownSecondsRemaining).toBeGreaterThanOrEqual(1);

    // Advance time past cooldown
    await vi.advanceTimersByTimeAsync(3000);
    await syncPromise;

    expect(syncJobManager.getState()?.status).toBe('completed');
  });

  it('proves navigation resilience: job persists across subscriber unmounts and re-mounts', async () => {
    let subscriber1Updates = 0;
    let subscriber2Updates = 0;

    // "Page 1" mounts and subscribes
    const unsub1 = syncJobManager.subscribe(() => {
      subscriber1Updates++;
    });

    vi.spyOn(steamApi, 'fetchGameMetadata').mockResolvedValue({
      appId: 10,
      name: 'Game',
    } as any);

    const syncPromise = syncJobManager.startStoreMediaSync(mockGames, () => {});

    // User navigates away: "Page 1" unmounts and unsubscribes
    unsub1();

    // "Page 2" mounts and subscribes midway through the sync job
    const unsub2 = syncJobManager.subscribe(() => {
      subscriber2Updates++;
    });

    await vi.runAllTimersAsync();
    await syncPromise;

    // Both subscribers received updates; job finished independently in the background
    expect(subscriber1Updates).toBeGreaterThan(0);
    expect(subscriber2Updates).toBeGreaterThan(0);
    expect(syncJobManager.getState()?.status).toBe('completed');

    unsub2();
  });
});

describe('GlobalSyncProgressBar Component', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    requestScheduler.reset();
    syncJobManager.reset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    requestScheduler.reset();
    syncJobManager.reset();
  });

  it('renders nothing when no sync job is active', () => {
    const html = renderToString(React.createElement(GlobalSyncProgressBar));
    expect(html).toBe('');
  });

  it('renders job title, current progress, percentage, and game name when a job is running', () => {
    // Manually prime syncJobManager state
    vi.spyOn(syncJobManager, 'getState').mockReturnValue({
      id: 'job-123',
      type: 'store_media',
      title: 'Syncing Official Store Media',
      total: 100,
      current: 42,
      currentItemName: 'Cyberpunk 2077',
      status: 'running',
    });

    const html = renderToString(React.createElement(GlobalSyncProgressBar)).replace(/<!--.*?-->/g, '');
    expect(html).toContain('Syncing Official Store Media');
    expect(html).toContain('42%');
    expect(html).toContain('Cyberpunk 2077');
    expect(html).toContain('42 / 100');
  });

  it('renders rate-limited badge and cooldown countdown when status is rate_limited', () => {
    vi.spyOn(syncJobManager, 'getState').mockReturnValue({
      id: 'job-456',
      type: 'store_media',
      title: 'Syncing Official Store Media',
      total: 50,
      current: 10,
      status: 'rate_limited',
      cooldownSecondsRemaining: 450,
    });

    const html = renderToString(React.createElement(GlobalSyncProgressBar)).replace(/<!--.*?-->/g, '');
    expect(html).toContain('Rate limited: Cooldown 7m 30s');
    expect(html).toContain('10 / 50');
  });

  it('renders completed state indicator upon job completion', () => {
    vi.spyOn(syncJobManager, 'getState').mockReturnValue({
      id: 'job-789',
      type: 'store_media',
      title: 'Syncing Official Store Media',
      total: 25,
      current: 25,
      status: 'completed',
    });

    const html = renderToString(React.createElement(GlobalSyncProgressBar)).replace(/<!--.*?-->/g, '');
    expect(html).toContain('Sync complete!');
    expect(html).toContain('100%');
    expect(html).toContain('25 / 25');
  });

  it('aggregates multiple concurrent background sync streams into a clean headline', async () => {
    let resolveCover!: () => void;
    let resolveReviews!: () => void;

    const coverPromise = syncJobManager.trackTask(
      'cover_art',
      'The Witcher 3',
      () => new Promise<void>((r) => { resolveCover = r; })
    );

    expect(syncJobManager.getState()?.headline).toBe('Syncing Cover Art');
    expect(syncJobManager.getState()?.activeCategories).toEqual(['Cover Art']);

    const reviewPromise = syncJobManager.trackTask(
      'critic_scores',
      'Cyberpunk 2077',
      () => new Promise<void>((r) => { resolveReviews = r; })
    );

    expect(syncJobManager.getState()?.headline).toBe('Syncing Cover Art & Review Scores');
    expect(syncJobManager.getState()?.activeCategories).toEqual(['Cover Art', 'Review Scores']);
    expect(syncJobManager.getState()?.total).toBe(2);
    expect(syncJobManager.getState()?.current).toBe(0);

    resolveCover();
    await coverPromise;

    expect(syncJobManager.getState()?.current).toBe(1);
    expect(syncJobManager.getState()?.headline).toBe('Syncing Review Scores');

    resolveReviews();
    await reviewPromise;

    expect(syncJobManager.getState()?.status).toBe('completed');
    expect(syncJobManager.getState()?.current).toBe(2);
  });

  it('preempts background sync during on-demand runPriorityAction and auto-resumes afterwards', async () => {
    let resolveBg!: () => void;
    const bgPromise = syncJobManager.trackTask(
      'cover_art',
      'Background Game',
      () => new Promise<void>((r) => { resolveBg = r; })
    );

    expect(syncJobManager.getState()?.headline).toBe('Syncing Cover Art');
    expect(syncJobManager.isPriorityPreempted()).toBe(false);
    expect(requestScheduler.isInteractivePreempted()).toBe(false);

    let stateDuringPriority: SyncJobState | null = null;
    let schedulerPreemptedDuringPriority = false;
    let htmlDuringPriority = '';

    await syncJobManager.runPriorityAction(
      'Syncing Game Media',
      'Hades II',
      async () => {
        stateDuringPriority = syncJobManager.getState();
        schedulerPreemptedDuringPriority = requestScheduler.isInteractivePreempted();
        htmlDuringPriority = renderToString(React.createElement(GlobalSyncProgressBar)).replace(/<!--.*?-->/g, '');
      }
    );

    // During the priority action, background sync was preempted
    expect(schedulerPreemptedDuringPriority).toBe(true);
    expect(stateDuringPriority).not.toBeNull();
    expect((stateDuringPriority as any).isPreempted).toBe(true);
    expect((stateDuringPriority as any).priorityHeadline).toBe('Syncing Game Media');
    expect((stateDuringPriority as any).priorityItemName).toBe('Hades II');
    expect(htmlDuringPriority).toContain('Syncing Game Media');
    expect(htmlDuringPriority).toContain('Background sync paused for Hades II');

    // Immediately after the priority action completes, background sync automatically resumes
    expect(syncJobManager.isPriorityPreempted()).toBe(false);
    expect(requestScheduler.isInteractivePreempted()).toBe(false);
    expect(syncJobManager.getState()?.isPreempted).toBeFalsy();
    expect(syncJobManager.getState()?.headline).toBe('Syncing Cover Art');

    resolveBg();
    await bgPromise;
  });
});

