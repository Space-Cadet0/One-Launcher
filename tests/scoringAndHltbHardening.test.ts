import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { criticScoreService } from '../src/services/critic/criticScoreService';
import { metacriticResolver } from '../src/services/critic/metacriticResolver';
import { steamReviewResolver } from '../src/services/critic/steamReviewResolver';
import { storefrontStarResolver } from '../src/services/critic/storefrontStarResolver';
import { storefrontReviewHarvester } from '../src/services/critic/storefrontReviewHarvester';
import { findBestHltbMatch } from '../src/services/hltb/howLongToBeat';
import { requestScheduler, DOMAIN_CONFIGS } from '../src/services/network/requestScheduler';

describe('Phase 3B & 4.1: Review Scoring Engine Hardening, HLTB Guard, and RequestScheduler Domain Expansion', () => {
  beforeEach(() => {
    criticScoreService.clearCache();
    requestScheduler.reset();
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('RequestScheduler howlongtobeat.com Domain Configuration', () => {
    it('configures howlongtobeat.com token bucket and resolves HLTB URLs and proxies', () => {
      expect(DOMAIN_CONFIGS['howlongtobeat.com']).toEqual({
        requestsPerSecond: 1.0,
        burst: 2,
      });
      expect(requestScheduler.resolveDomain('howlongtobeat.com')).toBe('howlongtobeat.com');
      expect(requestScheduler.resolveDomain('https://howlongtobeat.com/api/search/site')).toBe('howlongtobeat.com');
      expect(requestScheduler.resolveDomain('/api/hltb/api/search/site/init?t=123')).toBe('howlongtobeat.com');
    });
  });

  describe('OpenCritic Live API Hardening (Tier 2)', () => {
    it('rejects OpenCritic candidate when release year differs by >= 4 years (2006 game vs 2017 reboot)', async () => {
      vi.spyOn(storefrontReviewHarvester, 'getStorefrontAnchor').mockResolvedValue(null);
      vi.spyOn(metacriticResolver, 'resolveMetacritic').mockResolvedValue({ critic: null, user: null });
      vi.spyOn(steamReviewResolver, 'resolveScore').mockResolvedValue(null);
      vi.spyOn(storefrontStarResolver, 'resolveStorefrontScore').mockResolvedValue(null);

      const fetchMock = vi.fn().mockImplementation(async (url: string) => {
        if (url.includes('/api/game/search')) {
          return {
            ok: true,
            json: async () => [{ id: 4001, name: 'Shadowbound', dist: 0.0 }],
          };
        }
        if (url.includes('/api/game/4001')) {
          return {
            ok: true,
            json: async () => ({
              id: 4001,
              name: 'Shadowbound',
              firstReleaseDate: '2017-05-05T00:00:00.000Z',
              topCriticScore: 82,
              percentRecommended: 80,
              numReviews: 95,
            }),
          };
        }
        return { ok: false };
      });
      vi.stubGlobal('fetch', fetchMock);

      // Querying original 2006 Shadowbound should reject the 2017 reboot from OpenCritic
      const score2006 = await criticScoreService.resolveDynamicScore('Shadowbound', 993970, 2006);
      expect(score2006).toBeNull();

      // Querying 2017 Shadowbound should accept the 2017 OpenCritic candidate
      criticScoreService.clearCache();
      const score2017 = await criticScoreService.resolveDynamicScore('Shadowbound', 994804, 2017);
      expect(score2017).not.toBeNull();
      expect(score2017?.source).toBe('opencritic');
      expect(score2017?.score).toBe(82);
    });
  });

  describe('Sample-Size Weighting Between Tier 3 (Metacritic User) and Tier 4 (Steam Community)', () => {
    it('prefers Tier 4 Steam score when Tier 3 Metacritic User Score has < 25 ratings and Steam has high sample size', async () => {
      vi.spyOn(storefrontReviewHarvester, 'getStorefrontAnchor').mockResolvedValue(null);
      vi.spyOn(metacriticResolver, 'resolveMetacritic').mockResolvedValue({
        critic: null,
        user: {
          id: 'mc-user-tiny',
          source: 'metacritic_user',
          score: 52,
          tier: 'Weak',
          numReviews: 6,
          url: 'https://www.metacritic.com/game/obscure-gem/user-reviews/',
          isVerified: false,
          isSynthetic: true,
        },
      });
      vi.spyOn(steamReviewResolver, 'resolveScore').mockResolvedValue({
        id: 999111,
        source: 'steam',
        score: 88,
        tier: 'Mighty',
        numReviews: 1200,
        url: 'https://store.steampowered.com/app/999111',
        isVerified: false,
        isSynthetic: true,
      });
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false }));

      const res = await criticScoreService.resolveDynamicScore('Obscure Gem', 999111, 2023);
      expect(res).not.toBeNull();
      expect(res?.source).toBe('steam');
      expect(res?.score).toBe(88);
      expect(res?.numReviews).toBe(1200);
    });

    it('retains Tier 3 Metacritic User Score when numReviews >= 25 without downgrading to Tier 4 Steam', async () => {
      vi.spyOn(storefrontReviewHarvester, 'getStorefrontAnchor').mockResolvedValue(null);
      vi.spyOn(metacriticResolver, 'resolveMetacritic').mockResolvedValue({
        critic: null,
        user: {
          id: 'mc-user-solid',
          source: 'metacritic_user',
          score: 79,
          tier: 'Strong',
          numReviews: 42,
          url: 'https://www.metacritic.com/game/solid-game/user-reviews/',
          isVerified: false,
          isSynthetic: true,
        },
      });
      const steamSpy = vi.spyOn(steamReviewResolver, 'resolveScore').mockResolvedValue({
        id: 999222,
        source: 'steam',
        score: 85,
        tier: 'Mighty',
        numReviews: 5000,
        url: 'https://store.steampowered.com/app/999222',
        isVerified: false,
        isSynthetic: true,
      });
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false }));

      const res = await criticScoreService.resolveDynamicScore('Solid Game', 999222, 2023);
      expect(res).not.toBeNull();
      expect(res?.source).toBe('metacritic_user');
      expect(res?.score).toBe(79);
      expect(steamSpy).not.toHaveBeenCalled();
    });
  });

  describe('findBestHltbMatch Hardening', () => {
    it('rejects sequel mismatches ("Doom" vs "Doom II")', () => {
      const candidates = [
        { game_id: 2709, game_name: 'Doom II', comp_main: 18000 },
        { game_id: 2710, game_name: 'Doom 3', comp_main: 36000 },
      ];
      expect(findBestHltbMatch('Doom', candidates)).toBeNull();
    });

    it('rejects unrelated results[0] fallback when token similarity < 0.6', () => {
      const candidates = [
        { game_id: 9999, game_name: 'Completely Different Galaxies', comp_main: 36000 },
        { game_id: 8888, game_name: 'Prey for the Gods', comp_main: 25000 },
      ];
      expect(findBestHltbMatch('Prey', candidates)).toBeNull();
    });

    it('accepts valid exact and edition matches', () => {
      const candidates = [
        { game_id: 101, game_name: 'Cyberpunk 2077: Phantom Liberty', comp_main: 40000 },
        { game_id: 102, game_name: 'Cyberpunk 2077', comp_main: 93600 },
      ];
      const matchExact = findBestHltbMatch('Cyberpunk 2077', candidates);
      expect(matchExact?.game_id).toBe(102);

      const matchEdition = findBestHltbMatch('Cyberpunk 2077: Ultimate Edition', [
        { game_id: 102, game_name: 'Cyberpunk 2077', comp_main: 93600 },
      ]);
      expect(matchEdition?.game_id).toBe(102);
    });
  });
});
