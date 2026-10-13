import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  determineGameMutabilityTier,
  isCacheEntryValid,
  createStagedCacheEntry,
  saveStagedCache,
  loadStagedCache,
  evictStagedCache,
  clearExpiredStagedCache,
  TIER_TTLS,
  MUTABILITY_TIERS,
  TIER_0_USER_OVERRIDE,
  TIER_1_IMMUTABLE,
  TIER_2_MATURE,
  TIER_3_FRESH,
  TIER_4A_EARLY_ACCESS,
  TIER_4B_NEGATIVE_CACHE,
  TIER_4C_TRANSIENT_ERROR,
  TTL_TIER_0,
  TTL_TIER_1_IMMUTABLE,
  TTL_TIER_2_MATURE,
  TTL_TIER_3_FRESH,
  TTL_TIER_4A_EARLY_ACCESS,
  TTL_TIER_4B_NEGATIVE_CACHE,
  TTL_TIER_4C_TRANSIENT_ERROR,
  STAGED_CACHE_VERSION,
} from '../src/services/storage/stagedCacheService';
import { criticScoreService } from '../src/services/critic/criticScoreService';
import { SteamMatcherService } from '../src/services/steam/steamMatcher';

describe('Phase 4 Option B: Staged Cache Service & Tiered Data Mutability', () => {
  beforeEach(() => {
    if (typeof localStorage !== 'undefined') {
      localStorage.clear();
    }
    criticScoreService.clearCache();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('1. Mutability Tier Determination (determineGameMutabilityTier)', () => {
    it('identifies Tier 0: Human Override regardless of release date or genre', () => {
      expect(determineGameMutabilityTier({ isOverride: true, releaseDate: '2020-01-01' })).toBe('override');
      expect(determineGameMutabilityTier({ userOverride: true, genres: ['Early Access'] })).toBe('override');
      expect(determineGameMutabilityTier({ hasOverride: true })).toBe('override');
      expect(determineGameMutabilityTier({ source: 'override' } as any)).toBe('override');
    });

    it('identifies Tier 4C: Transient Errors (429 rate limit or network error)', () => {
      expect(determineGameMutabilityTier({ failureReason: 'rate_limited' })).toBe('transient_error');
      expect(determineGameMutabilityTier({ failureReason: 'network_error' })).toBe('transient_error');
      expect(determineGameMutabilityTier({ isTransientError: true })).toBe('transient_error');
    });

    it('identifies Tier 4B: Negative Cache (Unmatched titles, null scores, 0 reviews)', () => {
      expect(determineGameMutabilityTier(null)).toBe('negative');
      expect(determineGameMutabilityTier({ isNegative: true })).toBe('negative');
      expect(determineGameMutabilityTier({ isUnmatched: true })).toBe('negative');
      expect(determineGameMutabilityTier({ score: null })).toBe('negative');
      expect(determineGameMutabilityTier({ data: null })).toBe('negative');
      expect(determineGameMutabilityTier({ numReviews: 0 })).toBe('negative');
    });

    it('identifies Tier 4A: Early Access titles (prioritized over release date)', () => {
      // Even if released 3 years ago, Early Access status forces 72h TTL
      const threeYearsAgo = new Date(Date.now() - 1000 * 24 * 60 * 60 * 1000).toISOString();
      expect(
        determineGameMutabilityTier({
          releaseDate: threeYearsAgo,
          genres: ['Early Access', 'Action'],
        })
      ).toBe('early_access');

      expect(
        determineGameMutabilityTier({
          releaseDate: threeYearsAgo,
          tags: ['Indie', 'early access'],
        })
      ).toBe('early_access');

      expect(
        determineGameMutabilityTier({
          releaseDate: threeYearsAgo,
          isEarlyAccess: true,
        })
      ).toBe('early_access');

      expect(
        determineGameMutabilityTier(threeYearsAgo, ['Early Access'])
      ).toBe('early_access');
    });

    it('identifies Tier 1: Immutable (Titles released > 24 months ago)', () => {
      // 30 months ago (~900 days)
      const thirtyMonthsAgo = new Date(Date.now() - 900 * 24 * 60 * 60 * 1000).toISOString();
      expect(determineGameMutabilityTier({ releaseDate: thirtyMonthsAgo })).toBe('immutable');
      expect(determineGameMutabilityTier(thirtyMonthsAgo)).toBe('immutable');

      // 4-digit classic year
      expect(determineGameMutabilityTier({ releaseYear: 2018 })).toBe('immutable');
      expect(determineGameMutabilityTier('2015-05-19')).toBe('immutable');
    });

    it('identifies Tier 2: Mature (Titles released 3 to 24 months ago)', () => {
      // 6 months ago (180 days)
      const sixMonthsAgo = new Date(Date.now() - 180 * 24 * 60 * 60 * 1000).toISOString();
      expect(determineGameMutabilityTier({ releaseDate: sixMonthsAgo })).toBe('mature');
      expect(determineGameMutabilityTier(sixMonthsAgo)).toBe('mature');

      // 18 months ago (540 days)
      const eighteenMonthsAgo = new Date(Date.now() - 540 * 24 * 60 * 60 * 1000).toISOString();
      expect(determineGameMutabilityTier({ releaseDate: eighteenMonthsAgo })).toBe('mature');
    });

    it('identifies Tier 3: Fresh (Titles released < 90 days ago or future releases)', () => {
      // 30 days ago
      const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
      expect(determineGameMutabilityTier({ releaseDate: thirtyDaysAgo })).toBe('fresh');
      expect(determineGameMutabilityTier(thirtyDaysAgo)).toBe('fresh');

      // Released today
      const today = new Date().toISOString();
      expect(determineGameMutabilityTier({ releaseDate: today })).toBe('fresh');

      // Future release (next year)
      const future = new Date(Date.now() + 100 * 24 * 60 * 60 * 1000).toISOString();
      expect(determineGameMutabilityTier({ releaseDate: future })).toBe('fresh');
    });
  });

  describe('2. TTL Validity Checks & Expiration (isCacheEntryValid)', () => {
    it('correctly associates each tier with its required standard TTL', () => {
      expect(TIER_TTLS.override).toBe(Infinity);
      expect(TIER_TTLS.immutable).toBe(180 * 24 * 60 * 60 * 1000);
      expect(TIER_TTLS.mature).toBe(30 * 24 * 60 * 60 * 1000);
      expect(TIER_TTLS.fresh).toBe(48 * 60 * 60 * 1000);
      expect(TIER_TTLS.early_access).toBe(72 * 60 * 60 * 1000);
      expect(TIER_TTLS.negative).toBe(7 * 24 * 60 * 60 * 1000);
      expect(TIER_TTLS.transient_error).toBe(15 * 60 * 1000);

      expect(TTL_TIER_0).toBe(Infinity);
      expect(TTL_TIER_1_IMMUTABLE).toBe(180 * 24 * 60 * 60 * 1000);
      expect(TTL_TIER_2_MATURE).toBe(30 * 24 * 60 * 60 * 1000);
      expect(TTL_TIER_3_FRESH).toBe(48 * 60 * 60 * 1000);
      expect(TTL_TIER_4A_EARLY_ACCESS).toBe(72 * 60 * 60 * 1000);
      expect(TTL_TIER_4B_NEGATIVE_CACHE).toBe(7 * 24 * 60 * 60 * 1000);
      expect(TTL_TIER_4C_TRANSIENT_ERROR).toBe(15 * 60 * 1000);
    });

    it('validates fresh entries within TTL and invalidates expired entries', () => {
      const now = Date.now();

      // Fresh tier entry cached 10 hours ago (TTL 48h) -> valid
      const freshEntry = createStagedCacheEntry({ score: 85 }, 'fresh', {
        cachedAt: now - 10 * 60 * 60 * 1000,
      });
      expect(isCacheEntryValid(freshEntry)).toBe(true);

      // Fresh tier entry cached 50 hours ago (TTL 48h) -> expired
      const expiredFreshEntry = createStagedCacheEntry({ score: 85 }, 'fresh', {
        cachedAt: now - 50 * 60 * 60 * 1000,
      });
      expect(isCacheEntryValid(expiredFreshEntry)).toBe(false);

      // Mature tier entry cached 20 days ago (TTL 30d) -> valid
      const matureEntry = createStagedCacheEntry({ score: 85 }, 'mature', {
        cachedAt: now - 20 * 24 * 60 * 60 * 1000,
      });
      expect(isCacheEntryValid(matureEntry)).toBe(true);

      // Mature tier entry cached 35 days ago (TTL 30d) -> expired
      const expiredMatureEntry = createStagedCacheEntry({ score: 85 }, 'mature', {
        cachedAt: now - 35 * 24 * 60 * 60 * 1000,
      });
      expect(isCacheEntryValid(expiredMatureEntry)).toBe(false);
    });

    it('rejects invalid, null, or corrupted entries', () => {
      expect(isCacheEntryValid(null)).toBe(false);
      expect(isCacheEntryValid(undefined)).toBe(false);
      expect(isCacheEntryValid({} as any)).toBe(false);
      expect(isCacheEntryValid({ cachedAt: 'invalid' } as any)).toBe(false);
    });
  });

  describe('3. 7-Day Negative Cache Expiration (Never Permanent False-Null Lock-in)', () => {
    it('negative cache entries remain valid within 7-day window and expire strictly after 7 days', () => {
      const now = Date.now();

      // Negative cache entry created 3 days ago -> valid (< 7 days)
      const recentNegative = createStagedCacheEntry(null, 'negative', {
        cachedAt: now - 3 * 24 * 60 * 60 * 1000,
        failureReason: 'not_found',
      });
      expect(recentNegative.ttlMs).toBe(7 * 24 * 60 * 60 * 1000);
      expect(isCacheEntryValid(recentNegative)).toBe(true);

      // Negative cache entry created 8 days ago -> expired (> 7 days)
      const expiredNegative = createStagedCacheEntry(null, 'negative', {
        cachedAt: now - 8 * 24 * 60 * 60 * 1000,
        failureReason: 'not_found',
      });
      expect(isCacheEntryValid(expiredNegative)).toBe(false);
    });

    it('clearExpiredStagedCache purges expired negative entries from storage', () => {
      const now = Date.now();

      // Save an unexpired negative entry (3 days old)
      saveStagedCache('test_neg_recent', null, 'negative', {
        cachedAt: now - 3 * 24 * 60 * 60 * 1000,
      });

      // Save an expired negative entry (8 days old)
      saveStagedCache('test_neg_expired', null, 'negative', {
        cachedAt: now - 8 * 24 * 60 * 60 * 1000,
      });

      clearExpiredStagedCache();

      // Recent entry preserved
      const recentResult = loadStagedCache('test_neg_recent');
      expect(recentResult.valid).toBe(true);
      expect(recentResult.data).toBeNull();

      // Expired entry purged
      const expiredResult = loadStagedCache('test_neg_expired');
      expect(expiredResult.valid).toBe(false);
      expect(expiredResult.data).toBeNull();
    });
  });

  describe('4. Human Override Immunity (Tier 0)', () => {
    it('human overrides have TTL = Infinity and never expire', () => {
      const now = Date.now();
      // Even if an override was recorded 5 years ago, it remains valid
      const tenYearsAgo = now - 5 * 365 * 24 * 60 * 60 * 1000;
      const overrideEntry = createStagedCacheEntry({ score: 99 }, 'override', {
        cachedAt: tenYearsAgo,
      });

      expect(overrideEntry.ttlMs).toBe(Infinity);
      expect(isCacheEntryValid(overrideEntry)).toBe(true);
    });

    it('clearExpiredStagedCache never evicts human override entries', () => {
      const ancientTime = Date.now() - 10 * 365 * 24 * 60 * 60 * 1000;
      saveStagedCache('user_override_game_1', { score: 95 }, 'override', {
        cachedAt: ancientTime,
      });

      clearExpiredStagedCache();

      const loaded = loadStagedCache<{ score: number }>('user_override_game_1');
      expect(loaded.valid).toBe(true);
      expect(loaded.data?.score).toBe(95);
    });

    it('human override remains valid even when bypassTTL is requested', () => {
      const overrideEntry = createStagedCacheEntry({ score: 99 }, 'override');
      expect(isCacheEntryValid(overrideEntry, true)).toBe(true);
    });

    it('non-override entries are treated as invalid when bypassTTL is explicitly forced', () => {
      const matureEntry = createStagedCacheEntry({ score: 80 }, 'mature');
      expect(isCacheEntryValid(matureEntry, false)).toBe(true);
      expect(isCacheEntryValid(matureEntry, true)).toBe(false);
    });
  });

  describe('5. 15-Minute Transient Rate Limit Cooldown (Tier 4C)', () => {
    it('assigns 15-minute TTL to transient errors and expires them appropriately', () => {
      const now = Date.now();
      const transientEntry = createStagedCacheEntry(null, 'transient_error', {
        cachedAt: now - 5 * 60 * 1000, // 5 minutes ago
        failureReason: 'rate_limited',
      });

      expect(transientEntry.ttlMs).toBe(15 * 60 * 1000);
      expect(isCacheEntryValid(transientEntry)).toBe(true);

      const expiredTransient = createStagedCacheEntry(null, 'transient_error', {
        cachedAt: now - 16 * 60 * 1000, // 16 minutes ago
        failureReason: 'rate_limited',
      });
      expect(isCacheEntryValid(expiredTransient)).toBe(false);
    });

    it('clearExpiredStagedCache evicts rate limited entries after 15 minutes', () => {
      const now = Date.now();
      saveStagedCache('transient_rate_limit_1', null, 'transient_error', {
        cachedAt: now - 16 * 60 * 1000,
        failureReason: 'rate_limited',
      });

      clearExpiredStagedCache();

      const result = loadStagedCache('transient_rate_limit_1');
      expect(result.valid).toBe(false);
    });
  });

  describe('6. CriticScoreService Staged Cache Integration', () => {
    it('saves resolved score into staged cache with appropriate mutability tier', () => {
      // Simulate caching a mature game score
      const serviceAny = criticScoreService as any;
      const testKey = 'title:staged mature title test';
      const scoreData = {
        id: 'mc-mature-test',
        source: 'metacritic',
        score: 88,
        tier: 'Mighty',
        numReviews: 25,
        url: 'https://www.metacritic.com/game/staged-mature-test/critic-reviews/',
        isVerified: true,
      };

      // 6 months ago release date -> Tier 2 Mature (TTL 30 days)
      const sixMonthsAgo = new Date(Date.now() - 180 * 24 * 60 * 60 * 1000).toISOString();
      serviceAny.cacheResult(testKey, scoreData, sixMonthsAgo, ['Adventure']);

      const loaded = loadStagedCache<any>(`antigravity_critic_v8_${testKey}`);
      expect(loaded.valid).toBe(true);
      expect(loaded.entry?.tier).toBe('mature');
      expect(loaded.entry?.version).toBe(STAGED_CACHE_VERSION);
      expect(loaded.data?.score).toBe(88);
    });

    it('allows expired negative scores (> 7 days) to re-resolve in getCriticScore', async () => {
      const testTitle = 'Dynamic Negative Expiration Test Game 2026';
      const cacheKey = `title:${testTitle.toLowerCase()}`;
      const storageKey = `antigravity_critic_v8_${cacheKey}`;

      // 1. Pre-seed a negative score cached 8 days ago (> 7 days TTL)
      const eightDaysAgo = Date.now() - 8 * 24 * 60 * 60 * 1000;
      saveStagedCache(storageKey, null, 'negative', {
        cachedAt: eightDaysAgo,
        failureReason: 'not_found',
      });

      // Verify that loaded staged cache is expired
      const loaded = loadStagedCache(storageKey);
      expect(loaded.valid).toBe(false);

      // Mock resolveDynamicScore to monitor whether dynamic resolution is triggered
      const resolveSpy = vi.spyOn(criticScoreService, 'resolveDynamicScore').mockResolvedValue(null);

      // Calling getCriticScore should NOT be locked into the old negative entry;
      // it should detect expiration and trigger dynamic resolution to try again!
      const result = criticScoreService.getCriticScore(null, testTitle);
      expect(result).toBeNull();
      expect(resolveSpy).toHaveBeenCalledWith(testTitle, null);
    });

    it('respects unexpired negative scores (< 7 days) and does NOT trigger immediate re-resolution', async () => {
      const testTitle = 'Unexpired Negative Test Game 2026';
      const cacheKey = `title:${testTitle.toLowerCase()}`;
      const storageKey = `antigravity_critic_v8_${cacheKey}`;

      // 1. Pre-seed a negative score cached 2 days ago (< 7 days TTL)
      const twoDaysAgo = Date.now() - 2 * 24 * 60 * 60 * 1000;
      saveStagedCache(storageKey, null, 'negative', {
        cachedAt: twoDaysAgo,
        failureReason: 'not_found',
      });

      const resolveSpy = vi.spyOn(criticScoreService, 'resolveDynamicScore').mockResolvedValue(null);

      // Calling getCriticScore within 7 days returns null and does NOT spam dynamic resolution
      const result = criticScoreService.getCriticScore(null, testTitle);
      expect(result).toBeNull();
      expect(resolveSpy).not.toHaveBeenCalled();
    });

    it('forces dynamic refresh when bypassTTL is true', async () => {
      const testTitle = 'Bypass TTL Force Refresh Game';
      const cacheKey = `title:${testTitle.toLowerCase()}`;
      const storageKey = `antigravity_critic_v8_${cacheKey}`;

      const validScore = {
        id: 'mc-bypass-test',
        source: 'metacritic',
        score: 82,
        tier: 'Great',
        numReviews: 30,
        url: 'https://www.metacritic.com/game/bypass-test/critic-reviews/',
        isVerified: true,
      };

      // Seed valid unexpired cache
      saveStagedCache(storageKey, validScore, 'mature');

      const resolveSpy = vi.spyOn(criticScoreService, 'resolveDynamicScore').mockResolvedValue(validScore as any);

      // Calling with bypassTTL = true must trigger dynamic resolution to refresh
      criticScoreService.getCriticScore(null, testTitle, undefined, undefined, undefined, true);
      expect(resolveSpy).toHaveBeenCalled();
    });
  });

  describe('7. SteamMatcher Negative Cache Expiration Integration', () => {
    it('positive Steam App ID matches remain immutable', () => {
      const matcher = new SteamMatcherService();
      // Curated or instant match
      const appId = matcher.matchGameToSteamInstant('Cyberpunk 2077');
      expect(appId).toBe(1091500);

      // Verify persistent cache holds the positive match as a raw number
      if (typeof localStorage !== 'undefined') {
        const raw = localStorage.getItem('antigravity_steam_matched_app_ids');
        expect(raw).not.toBeNull();
        const parsed = JSON.parse(raw!);
        expect(parsed['cyberpunk 2077']).toBe(1091500);
      }
    });

    it('negative matches expire after 7 days allowing new store listings to be matched', () => {
      const matcher = new SteamMatcherService();
      const testKey = 'unknown indie exclusive title 2026';

      // Record negative match timestamped 8 days ago
      const eightDaysAgo = Date.now() - 8 * 24 * 60 * 60 * 1000;
      (matcher as any).recordNegativeMatch(testKey, eightDaysAgo);

      // Instant lookup should detect expired negative cache and purge it
      const matchResult = matcher.matchGameToSteamInstant(testKey);
      expect(matchResult).toBeNull();

      // Negative cache entry should be evicted from in-memory cache
      expect((matcher as any).cache.has(testKey)).toBe(false);
      expect((matcher as any).negativeTimestamps.has(testKey)).toBe(false);
    });

    it('unexpired negative matches (< 7 days) are preserved without redundant network lookups', () => {
      const matcher = new SteamMatcherService();
      const testKey = 'recently checked exclusive title';

      // Record negative match timestamped 2 days ago
      const twoDaysAgo = Date.now() - 2 * 24 * 60 * 60 * 1000;
      (matcher as any).recordNegativeMatch(testKey, twoDaysAgo);

      // Lookup within 7 days returns null and preserves cache
      const matchResult = matcher.matchGameToSteamInstant(testKey);
      expect(matchResult).toBeNull();
      expect((matcher as any).cache.has(testKey)).toBe(true);
    });
  });
});
