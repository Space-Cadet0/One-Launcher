import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { CanonicalGame } from '../src/contracts/game';
import { syncJobManager } from '../src/services/network/syncJobManager';
import { criticScoreService } from '../src/services/critic/criticScoreService';
import { metacriticResolver } from '../src/services/critic/metacriticResolver';
import { steamReviewResolver } from '../src/services/critic/steamReviewResolver';
import { storefrontStarResolver } from '../src/services/critic/storefrontStarResolver';
import { storefrontReviewHarvester } from '../src/services/critic/storefrontReviewHarvester';
import {
  loadStagedCache,
  saveStagedCache,
  TIER_TTLS,
  MutabilityTier,
} from '../src/services/storage/stagedCacheService';
import {
  IgdbCoverService,
  igdbCoverService,
  normalizeCacheKey,
  isKnownDeadSteamCover,
  isUnsuitableCoverUrl,
} from '../src/services/igdb/igdbCoverService';
import { steamAchievementsService } from '../src/services/steam/steamAchievementsService';
import { requestScheduler } from '../src/services/network/requestScheduler';

const BASE_NOW = new Date('2026-10-16T12:00:00.000Z').getTime();
const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

function createCatalogGames(baseTimeMs: number): {
  gameA: CanonicalGame;
  gameB: CanonicalGame;
  gameC: CanonicalGame;
  catalog: CanonicalGame[];
} {
  // Game A: Positive verified score, released 2020 (> 24 months ago -> immutable 180-day TTL)
  const gameA: CanonicalGame = {
    id: 'steam-910001',
    title: 'Chrono Vanguard',
    sortTitle: 'Chrono Vanguard',
    steamAppId: 910001,
    releaseDate: '2020-05-15',
    platforms: [{ platformId: 'steam', platformGameId: '910001', installed: false }],
    headerImage: 'https://cdn.example.com/chrono-vanguard.jpg',
    developers: ['Studio Alpha'],
    publishers: ['Studio Alpha'],
    genres: ['Action', 'RPG'],
    tags: [],
  };

  // Game B: Synthetic Steam score (isSynthetic: true), released 6 months ago (180 days -> mature 30-day TTL)
  const sixMonthsAgoIso = new Date(baseTimeMs - 180 * DAY_MS).toISOString();
  const gameB: CanonicalGame = {
    id: 'steam-910002',
    title: 'Stellar Outpost Tactica',
    sortTitle: 'Stellar Outpost Tactica',
    steamAppId: 910002,
    releaseDate: sixMonthsAgoIso,
    reviewSummary: {
      score: 84,
      totalReviews: 240,
      positivePercent: 84,
      reviewDesc: 'Very Positive',
    },
    platforms: [{ platformId: 'steam', platformGameId: '910002', installed: false }],
    headerImage: 'https://cdn.example.com/stellar-outpost.jpg',
    developers: ['Studio Beta'],
    publishers: ['Studio Beta'],
    genres: ['Strategy'],
    tags: [],
  };

  // Game C: Unrated indie/obscure game where all dynamic tiers return null (-> negative 7-day TTL)
  const gameC: CanonicalGame = {
    id: 'steam-910003',
    title: 'Mystery Garage Prototype Z9',
    sortTitle: 'Mystery Garage Prototype Z9',
    steamAppId: 910003,
    releaseDate: '2023-08-10',
    platforms: [{ platformId: 'steam', platformGameId: '910003', installed: false }],
    headerImage: 'https://cdn.example.com/mystery-prototype.jpg',
    developers: ['Indie Garage'],
    publishers: ['Indie Garage'],
    genres: ['Indie'],
    tags: [],
  };

  return {
    gameA,
    gameB,
    gameC,
    catalog: [gameA, gameB, gameC],
  };
}

// Ensure a spec-compliant localStorage exists when running in Vitest Node environment
if (typeof globalThis.localStorage === 'undefined') {
  const store = new Map<string, string>();
  const storagePolyfill: Storage = {
    get length() {
      return store.size;
    },
    clear() {
      store.clear();
    },
    getItem(key: string) {
      return store.has(key) ? store.get(key)! : null;
    },
    key(index: number) {
      return Array.from(store.keys())[index] ?? null;
    },
    removeItem(key: string) {
      store.delete(key);
    },
    setItem(key: string, value: string) {
      store.set(key, String(value));
    },
  };
  Object.defineProperty(globalThis, 'localStorage', {
    value: storagePolyfill,
    configurable: true,
    writable: true,
  });
}

function setupDeterministicDynamicMocks() {
  vi.spyOn(storefrontReviewHarvester, 'getStorefrontAnchor').mockResolvedValue(null);
  vi.spyOn(steamReviewResolver, 'resolveScore').mockResolvedValue(null);
  vi.spyOn(storefrontStarResolver, 'resolveStorefrontScore').mockResolvedValue(null);

  // Mock OpenCritic fetch to return empty search results
  global.fetch = vi.fn().mockResolvedValue({
    ok: true,
    json: async () => [],
  } as any);

  // Mock Metacritic resolver to return verified score ONLY for Game A / Chrono Vanguard variants
  // and null for Game B & Game C
  vi.spyOn(metacriticResolver, 'resolveMetacritic').mockImplementation(async (title: string) => {
    if (title.toLowerCase().includes('chrono vanguard')) {
      const slug = title
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '');
      return {
        critic: {
          id: `mc-${slug}`,
          source: 'metacritic',
          score: 88,
          tier: 'Mighty',
          numReviews: 45,
          url: `https://www.metacritic.com/game/${slug}/critic-reviews/`,
          summary: 'Verified Metacritic press consensus (88/100 across 45 critic reviews).',
          isVerified: true,
        },
        user: null,
      };
    }
    return null;
  });
}

describe('Phase 3: End-to-End Sync Lifecycle & Interval Verification', () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    vi.spyOn(Date, 'now').mockReturnValue(BASE_NOW);
    if (typeof localStorage !== 'undefined') {
      localStorage.clear();
    }
    syncJobManager.reset();
    criticScoreService.clearCache();
    igdbCoverService.clearCache();
    requestScheduler.reset();
    requestScheduler.setEnforceDelays(false);
  });

  afterEach(() => {
    global.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  describe('Suite 1: Startup Review Score Warmup & Zero Redundant Re-Sync on App Restart', () => {
    it('resolves all 3 catalog games on Launch #1, persists staged entries with dynamicResolved=true, and makes 0 resolveDynamicScore calls on Launch #2', async () => {
      setupDeterministicDynamicMocks();
      const { catalog } = createCatalogGames(BASE_NOW);

      const resolveSpyLaunch1 = vi.spyOn(criticScoreService, 'resolveDynamicScore');

      // Launch #1: Run background critic score sync
      await syncJobManager.startCriticScoreSync(catalog, { isBackground: true });

      expect(resolveSpyLaunch1).toHaveBeenCalledTimes(3);

      // Verify all 3 games are persisted in localStorage under antigravity_critic_v8_...
      const stagedA = loadStagedCache<any>('antigravity_critic_v8_id:910001');
      expect(stagedA.valid).toBe(true);
      expect(stagedA.entry?.tier).toBe('immutable');
      expect(stagedA.entry?.ttlMs).toBe(TIER_TTLS.immutable);
      expect(stagedA.entry?.dynamicResolved).toBe(true);
      expect(stagedA.data?.score).toBe(88);
      expect(stagedA.data?.isVerified).toBe(true);

      const stagedB = loadStagedCache<any>('antigravity_critic_v8_id:910002');
      expect(stagedB.valid).toBe(true);
      expect(stagedB.entry?.tier).toBe('mature');
      expect(stagedB.entry?.ttlMs).toBe(TIER_TTLS.mature);
      expect(stagedB.entry?.dynamicResolved).toBe(true);
      expect(stagedB.data?.isSynthetic).toBe(true);
      expect(stagedB.data?.score).toBeGreaterThan(0);

      const stagedC = loadStagedCache<any>('antigravity_critic_v8_id:910003');
      expect(stagedC.valid).toBe(true);
      expect(stagedC.entry?.tier).toBe('negative');
      expect(stagedC.entry?.ttlMs).toBe(TIER_TTLS.negative);
      expect(stagedC.entry?.dynamicResolved).toBe(true);
      expect(stagedC.data).toBeNull();

      // Simulate Launch #2 (App Restart): clear in-memory caches & attempted resolution sets
      (criticScoreService as any).inMemoryCache.clear();
      criticScoreService.clearAttemptedResolutions();
      resolveSpyLaunch1.mockClear();

      // Run background critic score sync on Launch #2
      await syncJobManager.startCriticScoreSync(catalog, { isBackground: true });

      // Zero games should be re-synced on Launch #2!
      expect(resolveSpyLaunch1).toHaveBeenCalledTimes(0);
    });
  });

  describe('Suite 2: Tiered TTL Expiration Intervals (fresh 48h, early_access 72h, negative 7d, mature 30d, immutable 180d, override Infinity)', () => {
    it('enforces exact expiration windows for negative (7d), mature (30d), and immutable (180d) games across simulated time jumps', async () => {
      setupDeterministicDynamicMocks();
      const { catalog } = createCatalogGames(BASE_NOW);

      // Launch #1 at t = BASE_NOW
      await syncJobManager.startCriticScoreSync(catalog, { isBackground: true });
      const resolveSpy = vi.spyOn(criticScoreService, 'resolveDynamicScore');

      // 1. Advance time by +3 days (< 7 days negative TTL)
      vi.spyOn(Date, 'now').mockReturnValue(BASE_NOW + 3 * DAY_MS);
      (criticScoreService as any).inMemoryCache.clear();
      criticScoreService.clearAttemptedResolutions();
      resolveSpy.mockClear();

      await syncJobManager.startCriticScoreSync(catalog, { isBackground: true });
      expect(resolveSpy).toHaveBeenCalledTimes(0);

      // 2. Advance time to 7 days + 1 minute: ONLY Game C (negative 7d tier) expires and is re-synced
      const tSevenDaysPlusOneMin = BASE_NOW + 7 * DAY_MS + MINUTE_MS;
      vi.spyOn(Date, 'now').mockReturnValue(tSevenDaysPlusOneMin);
      (criticScoreService as any).inMemoryCache.clear();
      criticScoreService.clearAttemptedResolutions();
      resolveSpy.mockClear();

      await syncJobManager.startCriticScoreSync(catalog, { isBackground: true });
      expect(resolveSpy).toHaveBeenCalledTimes(1);
      expect(resolveSpy.mock.calls[0][0]).toBe('Mystery Garage Prototype Z9');
      expect(resolveSpy.mock.calls[0][1]).toBe(910003);

      // Game C is now freshly re-cached at t = 7d + 1m.
      // 3. Advance time to 30 days + 1 minute from BASE_NOW (and keep Game C fresh so we isolate Game B vs Game A):
      // Wait: from t = 7d + 1m to t = 30d + 1m is 23 days (> 7d), so if we refresh Game C at t = 28d first,
      // at t = 30d + 1m ONLY Game B (mature 30d tier) expires while Game A (immutable 180d) and Game C remain cached!
      vi.spyOn(Date, 'now').mockReturnValue(BASE_NOW + 28 * DAY_MS);
      (criticScoreService as any).inMemoryCache.clear();
      criticScoreService.clearAttemptedResolutions();
      await syncJobManager.startCriticScoreSync(catalog, { isBackground: true });

      const tThirtyDaysPlusOneMin = BASE_NOW + 30 * DAY_MS + MINUTE_MS;
      vi.spyOn(Date, 'now').mockReturnValue(tThirtyDaysPlusOneMin);
      (criticScoreService as any).inMemoryCache.clear();
      criticScoreService.clearAttemptedResolutions();
      resolveSpy.mockClear();

      await syncJobManager.startCriticScoreSync(catalog, { isBackground: true });
      expect(resolveSpy).toHaveBeenCalledTimes(1);
      expect(resolveSpy.mock.calls[0][0]).toBe('Stellar Outpost Tactica');
      expect(resolveSpy.mock.calls[0][1]).toBe(910002);

      // Verify Game A (immutable 180d) is STILL valid at 30 days + 1 minute
      expect(loadStagedCache('antigravity_critic_v8_id:910001').valid).toBe(true);
    });

    it('enforces fresh (48h), early_access (72h), and override (Infinity — never expires even after 5 years)', async () => {
      setupDeterministicDynamicMocks();

      // Fresh game: released 10 days ago (< 90 days -> fresh 48h TTL)
      const freshGame: CanonicalGame = {
        id: 'steam-920001',
        title: 'Chrono Vanguard Fresh',
        sortTitle: 'Chrono Vanguard Fresh',
        steamAppId: 920001,
        releaseDate: new Date(BASE_NOW - 10 * DAY_MS).toISOString(),
        platforms: [{ platformId: 'steam', platformGameId: '920001', installed: false }],
        headerImage: '',
        developers: ['Studio Alpha'],
        publishers: ['Studio Alpha'],
        genres: ['Action'],
        tags: [],
      };

      // Early Access game: released 1 year ago but has 'Early Access' genre (-> early_access 72h TTL)
      const earlyAccessGame: CanonicalGame = {
        id: 'steam-920002',
        title: 'Chrono Vanguard Early',
        sortTitle: 'Chrono Vanguard Early',
        steamAppId: 920002,
        releaseDate: new Date(BASE_NOW - 365 * DAY_MS).toISOString(),
        platforms: [{ platformId: 'steam', platformGameId: '920002', installed: false }],
        headerImage: '',
        developers: ['Studio Alpha'],
        publishers: ['Studio Alpha'],
        genres: ['Action', 'Early Access'],
        tags: [],
      };

      // Override game: user-pinned score (-> override Infinity TTL)
      const overrideGame: CanonicalGame = {
        id: 'steam-920003',
        title: 'Pinned Masterpiece',
        sortTitle: 'Pinned Masterpiece',
        steamAppId: 920003,
        releaseDate: '2021-01-01',
        platforms: [{ platformId: 'steam', platformGameId: '920003', installed: false }],
        headerImage: '',
        developers: ['Studio Omega'],
        publishers: ['Studio Omega'],
        genres: ['RPG'],
        tags: [],
      };

      saveStagedCache(
        'antigravity_critic_v8_id:920003',
        {
          id: 'custom-920003',
          source: 'metacritic',
          score: 96,
          tier: 'Mighty',
          isVerified: true,
        },
        MutabilityTier.TIER_0_USER_OVERRIDE,
        { dynamicResolved: true }
      );

      const batch = [freshGame, earlyAccessGame, overrideGame];

      // Initial sync at BASE_NOW
      await syncJobManager.startCriticScoreSync(batch, { isBackground: true });

      expect(loadStagedCache('antigravity_critic_v8_id:920001').entry?.tier).toBe('fresh');
      expect(loadStagedCache('antigravity_critic_v8_id:920001').entry?.ttlMs).toBe(48 * HOUR_MS);
      expect(loadStagedCache('antigravity_critic_v8_id:920002').entry?.tier).toBe('early_access');
      expect(loadStagedCache('antigravity_critic_v8_id:920002').entry?.ttlMs).toBe(72 * HOUR_MS);
      expect(loadStagedCache('antigravity_critic_v8_id:920003').entry?.tier).toBe('override');
      expect(loadStagedCache('antigravity_critic_v8_id:920003').entry?.ttlMs).toBe(Infinity);

      const resolveSpy = vi.spyOn(criticScoreService, 'resolveDynamicScore');

      // At +47 hours: all 3 are valid -> 0 re-syncs
      vi.spyOn(Date, 'now').mockReturnValue(BASE_NOW + 47 * HOUR_MS);
      (criticScoreService as any).inMemoryCache.clear();
      criticScoreService.clearAttemptedResolutions();
      resolveSpy.mockClear();

      await syncJobManager.startCriticScoreSync(batch, { isBackground: true });
      expect(resolveSpy).toHaveBeenCalledTimes(0);

      // At +48 hours + 1 minute: ONLY freshGame (48h) expires; earlyAccessGame (72h) and overrideGame (Infinity) remain valid
      vi.spyOn(Date, 'now').mockReturnValue(BASE_NOW + 48 * HOUR_MS + MINUTE_MS);
      (criticScoreService as any).inMemoryCache.clear();
      criticScoreService.clearAttemptedResolutions();
      resolveSpy.mockClear();

      await syncJobManager.startCriticScoreSync(batch, { isBackground: true });
      expect(resolveSpy).toHaveBeenCalledTimes(1);
      expect(resolveSpy.mock.calls[0][1]).toBe(920001);

      // At +72 hours + 1 minute from BASE_NOW: earlyAccessGame (72h) expires; freshGame (re-cached at 48h+1m, so 24h old) and overrideGame remain valid
      vi.spyOn(Date, 'now').mockReturnValue(BASE_NOW + 72 * HOUR_MS + MINUTE_MS);
      (criticScoreService as any).inMemoryCache.clear();
      criticScoreService.clearAttemptedResolutions();
      resolveSpy.mockClear();

      await syncJobManager.startCriticScoreSync(batch, { isBackground: true });
      expect(resolveSpy).toHaveBeenCalledTimes(1);
      expect(resolveSpy.mock.calls[0][1]).toBe(920002);

      // At +5 years: overrideGame (Tier 0 Infinity) NEVER expires
      vi.spyOn(Date, 'now').mockReturnValue(BASE_NOW + 5 * 365 * DAY_MS);
      (criticScoreService as any).inMemoryCache.clear();
      criticScoreService.clearAttemptedResolutions();
      resolveSpy.mockClear();

      await syncJobManager.startCriticScoreSync([overrideGame], { isBackground: true });
      expect(resolveSpy).toHaveBeenCalledTimes(0);
      expect(loadStagedCache('antigravity_critic_v8_id:920003').valid).toBe(true);
    });
  });

  describe('Suite 3: Cover Art :year Key Preservation, Persistent 7-Day Negative Cover Cache, 30-Day Dead Steam Cover Cache & Zero Scroll Sync', () => {
    it('preserves :year suffix in normalizeCacheKey("DOOM:1993")', () => {
      expect(normalizeCacheKey('DOOM:1993')).toBe('doom:1993');
      expect(normalizeCacheKey('Prey:2006')).toBe('prey:2006');
      expect(normalizeCacheKey('Prey:2017')).toBe('prey:2017');
    });

    it('reloads positive and negative "some game:1993" keys intact across IgdbCoverService restarts with 0 network calls', async () => {
      // 1. Positive cover resolution with year 1993
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          results: [
            {
              name: 'Some Game',
              year: 1993,
              coverart: 'https://images.igdb.com/igdb/image/upload/t_cover_big/co_somegame1993.jpg',
            },
          ],
        }),
      } as any);
      global.fetch = fetchMock;

      const resolvedUrl = await igdbCoverService.fetchIgdbCover('Some Game', 1993);
      expect(resolvedUrl).toBe('https://images.igdb.com/igdb/image/upload/t_cover_big/co_somegame1993.jpg');
      expect(fetchMock).toHaveBeenCalledTimes(1);

      // Verify raw localStorage key preserves ":1993"
      const storedRaw = JSON.parse(localStorage.getItem('antigravity_igdb_covers_v2') || '{}');
      expect(storedRaw['some game:1993']).toBe(
        'https://images.igdb.com/igdb/image/upload/t_cover_big/co_somegame1993.jpg'
      );

      // Instantiate a brand-new IgdbCoverService() simulating app restart
      fetchMock.mockClear();
      const reloadedService = new IgdbCoverService();
      expect(reloadedService.hasAttemptedIgdbCover('Some Game', 1993)).toBe(true);

      const secondResult = await reloadedService.fetchIgdbCover('Some Game', 1993);
      expect(secondResult).toBe('https://images.igdb.com/igdb/image/upload/t_cover_big/co_somegame1993.jpg');
      expect(fetchMock).toHaveBeenCalledTimes(0);

      // 2. Negative cover resolution with year 1993
      const negFetchMock = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ results: [] }),
      } as any);
      global.fetch = negFetchMock;

      const negResult = await reloadedService.fetchIgdbCover('Missing Retro Title', 1993);
      expect(negResult).toBeNull();
      expect(negFetchMock).toHaveBeenCalledTimes(1);

      // Instantiate another new IgdbCoverService() and verify negative result is reloaded and makes 0 network calls
      negFetchMock.mockClear();
      const reloadedService2 = new IgdbCoverService();
      expect(reloadedService2.hasAttemptedIgdbCover('Missing Retro Title', 1993)).toBe(true);

      const negResultReloaded = await reloadedService2.fetchIgdbCover('Missing Retro Title', 1993);
      expect(negResultReloaded).toBeNull();
      expect(negFetchMock).toHaveBeenCalledTimes(0);

      // 3. Advance time by 7 days + 1 minute (NEGATIVE_COVER_TTL_MS): negative cover entry expires, positive remains cached
      vi.spyOn(Date, 'now').mockReturnValue(BASE_NOW + 7 * DAY_MS + MINUTE_MS);
      expect(reloadedService2.hasAttemptedIgdbCover('Missing Retro Title', 1993)).toBe(false);
      expect(reloadedService2.hasAttemptedIgdbCover('Some Game', 1993)).toBe(true);
    });

    it('persists recordDeadSteamCover(999999) to localStorage, survives IgdbCoverService reload, and marks 600x900 URL unsuitable', () => {
      expect(isKnownDeadSteamCover(999999)).toBe(false);

      igdbCoverService.recordDeadSteamCover(999999);
      expect(isKnownDeadSteamCover(999999)).toBe(true);

      const rawDead = localStorage.getItem('antigravity_dead_steam_covers_v1');
      expect(rawDead).not.toBeNull();
      const parsedDead = JSON.parse(rawDead!);
      expect(parsedDead['999999']).toBe(BASE_NOW);

      // Simulate restart by clearing in-memory set and instantiating new IgdbCoverService()
      const reloadedService = new IgdbCoverService();
      expect(reloadedService).toBeDefined();
      expect(isKnownDeadSteamCover(999999)).toBe(true);
      expect(
        isUnsuitableCoverUrl(
          'https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/999999/library_600x900.jpg'
        )
      ).toBe(true);
    });

    it('does NOT invoke syncJobManager.trackTask on passive single-card fetchIgdbCover with trackInGlobalBar: false', async () => {
      const trackTaskSpy = vi.spyOn(syncJobManager, 'trackTask');
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ results: [] }),
      } as any);

      await igdbCoverService.fetchIgdbCover('Passive Scroll Game', 2022, undefined, {
        trackInGlobalBar: false,
      });

      expect(trackTaskSpy).not.toHaveBeenCalled();
    });
  });

  describe('Suite 4: Steam Achievements 6-Hour Startup Cooldown', () => {
    it('tracks 6-hour full achievement sync cooldown accurately across 0h, 2h, and 6h + 1m intervals', () => {
      expect(steamAchievementsService.hasRecentFullSync()).toBe(false);

      steamAchievementsService.recordFullSyncCompleted();
      expect(steamAchievementsService.hasRecentFullSync()).toBe(true);

      // Still true after 2 hours
      vi.spyOn(Date, 'now').mockReturnValue(BASE_NOW + 2 * HOUR_MS);
      expect(steamAchievementsService.hasRecentFullSync()).toBe(true);

      // Becomes false after 6 hours + 1 minute
      vi.spyOn(Date, 'now').mockReturnValue(BASE_NOW + 6 * HOUR_MS + MINUTE_MS);
      expect(steamAchievementsService.hasRecentFullSync()).toBe(false);
    });
  });
});
