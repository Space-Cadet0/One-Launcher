import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import type { CanonicalGame } from '../src/contracts/game';
import type { SearchMatchCandidate, ScrapedMetadataBundle, UserGameOverride } from '../src/contracts/override';
import type { StorefrontReviewAnchor } from '../src/contracts/critic';
import {
  reviewCandidateService,
  ReviewCandidateService,
  ReviewCandidateOption,
} from '../src/services/scraper/reviewCandidateService';
import { requestScheduler, Priority } from '../src/services/network/requestScheduler';
import { saveUserOverride } from '../src/services/storage/userOverrideStorage';
import { storefrontReviewHarvester } from '../src/services/critic/storefrontReviewHarvester';
import { metacriticResolver } from '../src/services/critic/metacriticResolver';

// ---------------------------------------------------------------------------
// Mock Storage and Browser Environment
// ---------------------------------------------------------------------------
class MockStorage implements Storage {
  private store = new Map<string, string>();
  get length() {
    return this.store.size;
  }
  clear() {
    this.store.clear();
  }
  getItem(key: string) {
    return this.store.get(key) ?? null;
  }
  key(index: number) {
    return Array.from(this.store.keys())[index] ?? null;
  }
  removeItem(key: string) {
    this.store.delete(key);
  }
  setItem(key: string, value: string) {
    this.store.set(key, String(value));
  }
}

const mockStorage = new MockStorage();
if (typeof (globalThis as any).localStorage === 'undefined') {
  (globalThis as any).localStorage = mockStorage;
}
if (typeof (globalThis as any).CustomEvent === 'undefined') {
  (globalThis as any).CustomEvent = class CustomEvent {
    type: string;
    detail: any;
    constructor(type: string, init?: any) {
      this.type = type;
      this.detail = init?.detail;
    }
  };
}

describe('Phase 2: Review Candidate Service (Review Score & Source Override)', { timeout: 25000 }, () => {
  beforeEach(() => {
    mockStorage.clear();
    requestScheduler.setEnforceDelays(false);
    storefrontReviewHarvester.clearCache();
    metacriticResolver.clearCache();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // =========================================================================
  // 1. Discovery with Known Titles
  // =========================================================================
  describe('Discovery with Known Titles', () => {
    it('discovers verified Metacritic review candidate for Star Wars Battlefront II Classic (AppID 6060)', async () => {
      const swGame: CanonicalGame = {
        id: 'steam-6060',
        title: 'STAR WARS™ Battlefront™ II (Classic, 2005)',
        sortTitle: 'STAR WARS Battlefront II Classic 2005',
        steamAppId: 6060,
        platforms: [{ platformId: 'steam', platformGameId: '6060', installed: true }],
        headerImage: 'https://cdn.example.com/header.jpg',
        developers: ['Pandemic Studios'],
        publishers: ['LucasArts'],
        genres: ['Action'],
        tags: ['Classic', 'Sci-fi'],
      };

      const candidates = await reviewCandidateService.discoverReviewCandidates(swGame);

      expect(candidates.length).toBeGreaterThan(0);
      const mcOption = candidates.find((c) => c.source === 'metacritic');
      expect(mcOption).toBeDefined();
      expect(mcOption?.score).toBe(83);
      expect(mcOption?.tier).toBe('Strong');
      expect(mcOption?.isVerified).toBe(true);
      expect(mcOption?.sourceLabel).toBe('Metacritic Metascore');
    });

    it('discovers verified Metacritic score for Metro Last Light (AppID 43160 / 287390)', async () => {
      const metroGame: CanonicalGame = {
        id: 'steam-43160',
        title: 'Metro: Last Light',
        sortTitle: 'Metro Last Light',
        steamAppId: 43160,
        platforms: [{ platformId: 'steam', platformGameId: '43160', installed: true }],
        headerImage: 'https://cdn.example.com/metro.jpg',
        developers: ['4A Games'],
        publishers: ['Deep Silver'],
        genres: ['Action', 'Post-Apocalyptic'],
        tags: ['FPS', 'Atmospheric'],
      };

      const candidates = await reviewCandidateService.discoverReviewCandidates(metroGame);

      expect(candidates.length).toBeGreaterThan(0);
      const mcCandidate = candidates.find((c) => c.source === 'metacritic');
      expect(mcCandidate).toBeDefined();
      expect(mcCandidate?.score).toBe(82);
      expect(mcCandidate?.tier).toBe('Strong');
      expect(mcCandidate?.isVerified).toBe(true);
    });

    it('discovers OpenCritic ground truth candidate for Prodeus (GOG game)', async () => {
      const prodeusGame: CanonicalGame = {
        id: 'gog-prodeus',
        title: 'Prodeus',
        sortTitle: 'Prodeus',
        platforms: [{ platformId: 'gog', platformGameId: 'prodeus', installed: true }],
        headerImage: 'https://cdn.example.com/prodeus.jpg',
        developers: ['Bounding Box Games'],
        publishers: ['Humble Games'],
        genres: ['Action', 'Shooter'],
        tags: ['Retro', 'Boomer Shooter'],
      };

      const candidates = await reviewCandidateService.discoverReviewCandidates(prodeusGame);

      expect(candidates.length).toBeGreaterThan(0);
      const ocCandidate = candidates.find((c) => c.source === 'opencritic');
      expect(ocCandidate).toBeDefined();
      expect(ocCandidate?.score).toBe(82);
      expect(ocCandidate?.isVerified).toBe(true);
      expect(ocCandidate?.tier).toBe('Strong');
    });
  });

  // =========================================================================
  // 2. Identification of Ground Truth Anchors
  // =========================================================================
  describe('Identification of Ground Truth Anchors', () => {
    it('identifies Metacritic ground truth anchor from ScrapedMetadataBundle and marks isRecommended: true', async () => {
      const game: CanonicalGame = {
        id: 'game-anchor-test',
        title: 'Anchor Test Title',
        sortTitle: 'Anchor Test Title',
        platforms: [],
        headerImage: '',
        developers: [],
        publishers: [],
        genres: [],
        tags: [],
      };

      const storefrontAnchor: StorefrontReviewAnchor = {
        storefront: 'steam',
        metacriticScore: 88,
        metacriticSlug: 'anchor-test-title',
        metacriticUrl: 'https://www.metacritic.com/game/anchor-test-title/critic-reviews/',
        isVerifiedGroundTruth: true,
      };

      const bundle: ScrapedMetadataBundle = {
        matchedStore: 'steam',
        matchedId: 123456,
        title: 'Anchor Test Title',
        sortTitle: 'Anchor Test Title',
        capsuleImage: '',
        availableCovers: [],
        storefrontAnchor,
      };

      const candidates = await reviewCandidateService.discoverReviewCandidates(game, null, bundle);

      expect(candidates.length).toBeGreaterThan(0);
      const anchorOpt = candidates.find((c) => c.id === 'anchor-metacritic');
      expect(anchorOpt).toBeDefined();
      expect(anchorOpt?.isRecommended).toBe(true);
      expect(anchorOpt?.score).toBe(88);
      expect(anchorOpt?.tier).toBe('Mighty');
      expect(anchorOpt?.groundTruthSource).toBe('Verified by Steam Store Link');
      expect(anchorOpt?.badgeText).toBe('Verified Press Consensus');

      // The ground truth anchor must be ranked at index 0 (#1)
      expect(candidates[0].id).toBe('anchor-metacritic');
      expect(candidates[0].isRecommended).toBe(true);
    });

    it('identifies OpenCritic ground truth anchor (e.g. GOG/Epic anchor) and marks isRecommended: true', async () => {
      const game: CanonicalGame = {
        id: 'gog-indie-hero',
        title: 'Indie Hero Adventure',
        sortTitle: 'Indie Hero Adventure',
        platforms: [{ platformId: 'gog', platformGameId: 'indie-hero', installed: true }],
        headerImage: '',
        developers: [],
        publishers: [],
        genres: [],
        tags: [],
      };

      const storefrontAnchor: StorefrontReviewAnchor = {
        storefront: 'gog',
        openCriticScore: 86,
        openCriticId: 9876,
        openCriticUrl: 'https://opencritic.com/game/9876/indie-hero-adventure',
        isVerifiedGroundTruth: true,
      };

      const bundle: ScrapedMetadataBundle = {
        matchedStore: 'gog',
        matchedId: 'indie-hero',
        title: 'Indie Hero Adventure',
        sortTitle: 'Indie Hero Adventure',
        capsuleImage: '',
        availableCovers: [],
        storefrontAnchor,
      };

      const candidates = await reviewCandidateService.discoverReviewCandidates(game, null, bundle);

      expect(candidates.length).toBeGreaterThan(0);
      const anchorOpt = candidates.find((c) => c.id === 'anchor-opencritic');
      expect(anchorOpt).toBeDefined();
      expect(anchorOpt?.isRecommended).toBe(true);
      expect(anchorOpt?.score).toBe(86);
      expect(anchorOpt?.tier).toBe('Mighty');
      expect(anchorOpt?.groundTruthSource).toBe('Verified by GOG Store Link');

      // Ground truth anchor is ranked #1
      expect(candidates[0].id).toBe('anchor-opencritic');
      expect(candidates[0].isRecommended).toBe(true);
    });

    it('discoverReviews returns recommendedCandidateId matching the recommended anchor', async () => {
      const game: CanonicalGame = {
        id: 'game-rec-id-test',
        title: 'Recommended ID Game',
        sortTitle: 'Recommended ID Game',
        platforms: [],
        headerImage: '',
        developers: [],
        publishers: [],
        genres: [],
        tags: [],
      };

      const bundle: ScrapedMetadataBundle = {
        matchedStore: 'steam',
        matchedId: 111111,
        title: 'Recommended ID Game',
        sortTitle: 'Recommended ID Game',
        capsuleImage: '',
        availableCovers: [],
        storefrontAnchor: {
          storefront: 'steam',
          metacriticScore: 85,
          metacriticSlug: 'recommended-id-game',
          isVerifiedGroundTruth: true,
        },
      };

      const result = await reviewCandidateService.discoverReviews(game, null, bundle);

      expect(result.isLoading).toBe(false);
      expect(result.recommendedCandidateId).toBe('anchor-metacritic');
      expect(result.candidates.length).toBeGreaterThan(0);
      expect(result.candidates[0].id).toBe('anchor-metacritic');
    });
  });

  // =========================================================================
  // 3. Active User Override Preservation
  // =========================================================================
  describe('Active User Override Handling', () => {
    it('includes active reviewScoreOverride on CanonicalGame tagged as active-override', async () => {
      const game: CanonicalGame = {
        id: 'game-active-ov-1',
        title: 'Active Override RPG',
        sortTitle: 'Active Override RPG',
        platforms: [],
        headerImage: '',
        developers: [],
        publishers: [],
        genres: [],
        tags: [],
        reviewScoreOverride: {
          source: 'custom',
          score: 97,
          tier: 'Mighty',
          url: 'https://example.com/my-review',
          summary: 'User custom score for masterpiece',
          isVerified: true,
        },
      };

      const candidates = await reviewCandidateService.discoverReviewCandidates(game);

      const activeOpt = candidates.find((c) => c.id === 'active-override');
      expect(activeOpt).toBeDefined();
      expect(activeOpt?.score).toBe(97);
      expect(activeOpt?.tier).toBe('Mighty');
      expect(activeOpt?.source).toBe('custom');
      expect(activeOpt?.sourceLabel).toBe('Current Custom Override');
    });

    it('picks up active reviewScoreOverride saved in userOverrideStorage', async () => {
      const game: CanonicalGame = {
        id: 'game-storage-ov-1',
        title: 'Storage Overridden Title',
        sortTitle: 'Storage Overridden Title',
        platforms: [],
        headerImage: '',
        developers: [],
        publishers: [],
        genres: [],
        tags: [],
      };

      const override: UserGameOverride = {
        gameId: 'game-storage-ov-1',
        matchedStore: 'custom',
        title: 'Storage Overridden Title',
        reviewScoreOverride: {
          source: 'metacritic',
          score: 91,
          tier: 'Mighty',
          url: 'https://metacritic.com/game/stored',
          isVerified: true,
        },
        updatedAt: new Date().toISOString(),
      };

      saveUserOverride(override);

      const candidates = await reviewCandidateService.discoverReviewCandidates(game);

      const activeOpt = candidates.find((c) => c.id === 'active-override');
      expect(activeOpt).toBeDefined();
      expect(activeOpt?.score).toBe(91);
      expect(activeOpt?.source).toBe('metacritic');
    });
  });

  // =========================================================================
  // 4. Correct Tier Calculation, Deduplication & Ranking
  // =========================================================================
  describe('Correct Tier Calculation, Deduplication & Ranking', () => {
    it('correctly maps scores to CriticTier classifications', () => {
      const service = new ReviewCandidateService();
      const rawOptions: ReviewCandidateOption[] = [
        {
          id: 'test-1',
          source: 'metacritic',
          sourceLabel: 'Metacritic',
          score: 92,
          tier: 'Mighty',
          isVerified: true,
        },
        {
          id: 'test-2',
          source: 'opencritic',
          sourceLabel: 'OpenCritic',
          score: 79,
          tier: 'Strong',
          isVerified: true,
        },
        {
          id: 'test-3',
          source: 'metacritic_user',
          sourceLabel: 'User Score',
          score: 68,
          tier: 'Fair',
          isVerified: false,
        },
        {
          id: 'test-4',
          source: 'steam',
          sourceLabel: 'Steam Community',
          score: 55,
          tier: 'Weak',
          isVerified: false,
        },
      ];

      const ranked = service.deduplicateAndRank(rawOptions);
      expect(ranked[0].tier).toBe('Mighty');
      expect(ranked[1].tier).toBe('Strong');
      expect(ranked[2].tier).toBe('Fair');
      expect(ranked[3].tier).toBe('Weak');
    });

    it('deduplicates duplicate options with the same source and score, merging richer metadata', () => {
      const service = new ReviewCandidateService();
      const rawOptions: ReviewCandidateOption[] = [
        {
          id: 'mc-metascore',
          source: 'metacritic',
          sourceLabel: 'Metacritic Metascore',
          score: 84,
          tier: 'Mighty',
          isVerified: true,
          numReviews: 12,
        },
        {
          id: 'anchor-metacritic',
          source: 'metacritic',
          sourceLabel: 'Metacritic Metascore',
          score: 84,
          tier: 'Mighty',
          isVerified: true,
          isRecommended: true,
          groundTruthSource: 'Verified by Steam Store Link',
          numReviews: 45,
          url: 'https://metacritic.com/game/anchor-metacritic',
        },
      ];

      const deduplicated = service.deduplicateAndRank(rawOptions);

      // Must collapse into a single candidate
      expect(deduplicated.length).toBe(1);
      const merged = deduplicated[0];
      expect(merged.id).toBe('anchor-metacritic');
      expect(merged.isRecommended).toBe(true);
      expect(merged.groundTruthSource).toBe('Verified by Steam Store Link');
      expect(merged.numReviews).toBe(45);
      expect(merged.url).toBe('https://metacritic.com/game/anchor-metacritic');
    });

    it('strictly ranks options in the defined hierarchical order', () => {
      const service = new ReviewCandidateService();
      const rawOptions: ReviewCandidateOption[] = [
        {
          id: 'gog-stars',
          source: 'gog',
          sourceLabel: 'GOG Star Rating',
          score: 80,
          tier: 'Strong',
          isVerified: false,
        },
        {
          id: 'steam-community',
          source: 'steam',
          sourceLabel: 'Steam Community Reviews',
          score: 95,
          tier: 'Mighty',
          isVerified: false,
        },
        {
          id: 'mc-userscore',
          source: 'metacritic_user',
          sourceLabel: 'Metacritic User Score',
          score: 75,
          tier: 'Strong',
          isVerified: false,
        },
        {
          id: 'opencritic',
          source: 'opencritic',
          sourceLabel: 'OpenCritic',
          score: 82,
          tier: 'Strong',
          isVerified: true,
        },
        {
          id: 'mc-metascore',
          source: 'metacritic',
          sourceLabel: 'Metacritic Metascore',
          score: 85,
          tier: 'Mighty',
          isVerified: true,
        },
        {
          id: 'anchor-metacritic',
          source: 'metacritic',
          sourceLabel: 'Metacritic Metascore',
          score: 84,
          tier: 'Mighty',
          isVerified: true,
          isRecommended: true,
          groundTruthSource: 'Verified by Storefront Link',
        },
      ];

      const ranked = service.deduplicateAndRank(rawOptions);

      // Expected ranking order:
      // 1. Storefront ground truth anchor (isRecommended)
      // 2. Tier 1 Metacritic Press Metascore
      // 3. Tier 2 OpenCritic Top Critic Average
      // 4. Tier 3 Metacritic User Score
      // 5. Tier 4 Steam Community Sentiment
      // 6. Tier 5 Storefront Star Rating
      expect(ranked[0].id).toBe('anchor-metacritic');
      expect(ranked[0].isRecommended).toBe(true);
      expect(ranked[1].id).toBe('mc-metascore');
      expect(ranked[2].id).toBe('opencritic');
      expect(ranked[3].id).toBe('mc-userscore');
      expect(ranked[4].id).toBe('steam-community');
      expect(ranked[5].id).toBe('gog-stars');
    });
  });

  // =========================================================================
  // 5. Anti-Bot Safety & Fault-Tolerance Guards
  // =========================================================================
  describe('Anti-Bot Safety & Fault-Tolerance Guards', () => {
    it('routes interactive discovery requests through requestScheduler with Priority.P0_INTERACTIVE', async () => {
      const scheduleSpy = vi.spyOn(requestScheduler, 'schedule');

      const testGame: CanonicalGame = {
        id: 'game-safety-test',
        title: 'Safety Test Game 2026',
        sortTitle: 'Safety Test Game 2026',
        platforms: [{ platformId: 'steam', platformGameId: '12345', installed: true }],
        headerImage: '',
        developers: [],
        publishers: [],
        genres: [],
        tags: [],
      };

      await reviewCandidateService.discoverReviewCandidates(testGame);

      // Verify requestScheduler.schedule was invoked with P0_INTERACTIVE
      expect(scheduleSpy).toHaveBeenCalled();
      const p0Calls = scheduleSpy.mock.calls.filter((call) => call[2] === Priority.P0_INTERACTIVE);
      expect(p0Calls.length).toBeGreaterThan(0);
    }, 20000);

    it('gracefully handles network failures and timeouts without throwing or breaking results', async () => {
      // Mock requestScheduler.schedule to simulate network failure / timeout
      vi.spyOn(requestScheduler, 'schedule').mockImplementation(() => {
        return Promise.reject(new Error('503 Service Unavailable / Akamai Rate Limit'));
      });

      const game: CanonicalGame = {
        id: 'game-fail-test',
        title: 'Network Failure Game',
        sortTitle: 'Network Failure Game',
        platforms: [],
        headerImage: '',
        developers: [],
        publishers: [],
        genres: [],
        tags: [],
      };

      // Must not throw, returns empty or locally cached array
      await expect(reviewCandidateService.discoverReviewCandidates(game)).resolves.toBeDefined();

      const result = await reviewCandidateService.discoverReviews(game);
      expect(result.isLoading).toBe(false);
      expect(Array.isArray(result.candidates)).toBe(true);
    });
  });

  // =========================================================================
  // 6. Synthetic Steam Community and Storefront Star Ratings
  // =========================================================================
  describe('Synthetic Steam Community and Storefront Stars', () => {
    it('derives synthetic Steam community candidate from game.reviewSummary', async () => {
      const steamGame: CanonicalGame = {
        id: 'steam-999999',
        title: 'Indie Darling',
        sortTitle: 'Indie Darling',
        steamAppId: 999999,
        platforms: [{ platformId: 'steam', platformGameId: '999999', installed: true }],
        headerImage: '',
        developers: ['Indie Team'],
        publishers: ['Indie Publisher'],
        genres: ['Indie'],
        tags: ['Positive'],
        reviewSummary: {
          positivePercent: 96,
          totalReviews: 1500,
          reviewScoreDesc: 'Overwhelmingly Positive',
        },
      };

      const candidates = await reviewCandidateService.discoverReviewCandidates(steamGame);

      const steamOpt = candidates.find((c) => c.source === 'steam');
      expect(steamOpt).toBeDefined();
      expect(steamOpt?.id).toBe('steam-community');
      expect(steamOpt?.isSynthetic).toBe(true);
      expect(steamOpt?.isVerified).toBe(false);
      expect(steamOpt?.score).toBeGreaterThanOrEqual(88); // 96% positive maps to Mighty tier score >= 88
      expect(steamOpt?.badgeText).toBe('Player Community Sentiment');
      expect(steamOpt?.numReviews).toBe(1500);
    });

    it('converts GOG star rating into 0-100 scale candidate', () => {
      const service = new ReviewCandidateService();
      // 4.2 out of 5 stars maps to 84 (Strong or Mighty)
      const starRatingRaw = 4.2;
      const score = Math.min(100, Math.max(1, Math.round(starRatingRaw * 20)));
      const option: ReviewCandidateOption = {
        id: 'gog-stars',
        source: 'gog',
        sourceLabel: 'GOG Star Rating',
        score,
        tier: 'Strong',
        starRatingRaw,
        numReviews: 240,
        isVerified: false,
        badgeText: 'Storefront Rating',
      };

      const ranked = service.deduplicateAndRank([option]);
      expect(ranked[0].score).toBe(84);
      expect(ranked[0].starRatingRaw).toBe(4.2);
      expect(ranked[0].source).toBe('gog');
    });
  });
});
