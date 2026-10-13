import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { CriticSource, CriticScoreData } from '../src/contracts/critic';
import type { CanonicalGame } from '../src/contracts/game';
import type { UserGameOverride, ScrapedMetadataBundle } from '../src/contracts/override';
import {
  saveUserOverride,
  loadUserOverrides,
  removeUserOverride,
  applyUserOverrideToGame,
} from '../src/services/storage/userOverrideStorage';
import { criticScoreService, getOpenCriticData } from '../src/services/critic/criticScoreService';
import { MutabilityTier, loadStagedCache } from '../src/services/storage/stagedCacheService';

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

describe('Phase 1: Review Score & Source Override Unit and Integration Tests', () => {
  beforeEach(() => {
    mockStorage.clear();
    criticScoreService.clearCache();
  });

  describe('Contract and Type Definitions', () => {
    it('supports "custom" as a valid CriticSource in CriticScoreData', () => {
      const customSource: CriticSource = 'custom';
      const customScore: CriticScoreData = {
        source: customSource,
        score: 95,
        tier: 'Mighty',
        url: 'https://example.com/custom-review',
        isVerified: true,
        summary: 'User verified masterpiece score',
      };
      expect(customScore.source).toBe('custom');
      expect(customScore.score).toBe(95);
    });

    it('allows reviewScoreOverride in ScrapedMetadataBundle and UserGameOverride', () => {
      const customData: CriticScoreData = {
        source: 'custom',
        score: 88,
        tier: 'Mighty',
        url: '',
        isVerified: true,
      };

      const bundle: ScrapedMetadataBundle = {
        matchedStore: 'steam',
        matchedId: 1091500,
        title: 'Cyberpunk 2077',
        sortTitle: 'Cyberpunk 2077',
        capsuleImage: 'https://example.com/cover.jpg',
        availableCovers: [],
        reviewScoreOverride: customData,
      };
      expect(bundle.reviewScoreOverride?.score).toBe(88);

      const unratedBundle: ScrapedMetadataBundle = {
        matchedStore: 'gog',
        matchedId: '12345',
        title: 'Unrated Indie Game',
        sortTitle: 'Unrated Indie Game',
        capsuleImage: 'https://example.com/cover.jpg',
        availableCovers: [],
        reviewScoreOverride: null,
      };
      expect(unratedBundle.reviewScoreOverride).toBeNull();

      const override: UserGameOverride = {
        gameId: 'steam-1091500',
        matchedStore: 'steam',
        title: 'Cyberpunk 2077',
        reviewScoreOverride: customData,
        updatedAt: '2026-10-13T12:00:00Z',
      };
      expect(override.reviewScoreOverride?.score).toBe(88);
    });
  });

  describe('Storage Layer Persistence and CanonicalGame Application', () => {
    it('persists and restores reviewScoreOverride in saveUserOverride and loadUserOverrides', () => {
      const customScore: CriticScoreData = {
        source: 'metacritic',
        score: 92,
        tier: 'Mighty',
        url: 'https://metacritic.com/game/custom',
        isVerified: true,
      };

      const override: UserGameOverride = {
        gameId: 'game-phase1-test',
        title: 'Custom RPG Title',
        matchedStore: 'custom',
        reviewScoreOverride: customScore,
        updatedAt: new Date().toISOString(),
      };

      saveUserOverride(override);
      const loaded = loadUserOverrides();
      expect(loaded['game-phase1-test']).toBeDefined();
      expect(loaded['game-phase1-test'].reviewScoreOverride).toEqual(customScore);
    });

    it('persists explicit unrated (null) reviewScoreOverride in saveUserOverride', () => {
      const override: UserGameOverride = {
        gameId: 'game-unrated-test',
        title: 'Explicitly Unrated Title',
        matchedStore: 'steam',
        reviewScoreOverride: null,
        updatedAt: new Date().toISOString(),
      };

      saveUserOverride(override);
      const loaded = loadUserOverrides();
      expect(loaded['game-unrated-test']).toBeDefined();
      expect(loaded['game-unrated-test'].reviewScoreOverride).toBeNull();
    });

    it('attaches reviewScoreOverride to CanonicalGame in applyUserOverrideToGame', () => {
      const game: CanonicalGame = {
        id: 'game-apply-test',
        title: 'Original Title',
        sortTitle: 'Original Title',
        platforms: [],
        headerImage: '',
        developers: [],
        publishers: [],
        genres: [],
        tags: [],
      };

      const customScore: CriticScoreData = {
        source: 'custom',
        score: 99,
        tier: 'Mighty',
        url: '',
        isVerified: true,
      };

      const override: UserGameOverride = {
        gameId: 'game-apply-test',
        matchedStore: 'custom',
        title: 'Overridden Title',
        reviewScoreOverride: customScore,
        updatedAt: new Date().toISOString(),
      };

      const updated = applyUserOverrideToGame(game, override);
      expect(updated.title).toBe('Overridden Title');
      expect(updated.reviewScoreOverride).toEqual(customScore);
    });

    it('attaches null (unrated) reviewScoreOverride to CanonicalGame in applyUserOverrideToGame', () => {
      const game: CanonicalGame = {
        id: 'game-apply-null',
        title: 'Original Title',
        sortTitle: 'Original Title',
        platforms: [],
        headerImage: '',
        developers: [],
        publishers: [],
        genres: [],
        tags: [],
      };

      const override: UserGameOverride = {
        gameId: 'game-apply-null',
        matchedStore: 'custom',
        reviewScoreOverride: null,
        updatedAt: new Date().toISOString(),
      };

      const updated = applyUserOverrideToGame(game, override);
      expect(updated.reviewScoreOverride).toBeNull();
    });
  });

  describe('criticScoreService Integration & Tier 0 Authority', () => {
    it('handleUserOverride stores custom score at Tier 0 in staged cache and in-memory cache', () => {
      const customScore: CriticScoreData = {
        source: 'custom',
        score: 91,
        tier: 'Mighty',
        url: '',
        isVerified: true,
      };

      const override: UserGameOverride = {
        gameId: 'steam-999999',
        steamAppId: 999999,
        title: 'Brand New Indie Game 2026',
        matchedStore: 'steam',
        reviewScoreOverride: customScore,
        updatedAt: new Date().toISOString(),
      };

      criticScoreService.handleUserOverride(override);

      const staged = loadStagedCache<CriticScoreData>('antigravity_critic_v8_id:999999', false);
      expect(staged.entry).toBeDefined();
      expect(staged.entry?.tier).toBe(MutabilityTier.TIER_0_USER_OVERRIDE);
      expect(staged.entry?.data?.score).toBe(91);

      const score = criticScoreService.getCriticScore(999999, 'Brand New Indie Game 2026');
      expect(score).toEqual(customScore);
    });

    it('handleUserOverride stores null at Tier 0 for Unrated choice and dispatches event', () => {
      const dispatchSpy = vi.fn();
      if (typeof window !== 'undefined') {
        window.addEventListener('antigravity_critic_updated', dispatchSpy);
      }

      const override: UserGameOverride = {
        gameId: 'steam-888888',
        steamAppId: 888888,
        title: 'Unrated Action Adventure',
        matchedStore: 'steam',
        reviewScoreOverride: null,
        updatedAt: new Date().toISOString(),
      };

      criticScoreService.handleUserOverride(override);

      const staged = loadStagedCache<CriticScoreData>('antigravity_critic_v8_id:888888', false);
      expect(staged.entry).toBeDefined();
      expect(staged.entry?.tier).toBe(MutabilityTier.TIER_0_USER_OVERRIDE);
      expect(staged.entry?.data).toBeNull();

      const score = criticScoreService.getCriticScore(888888, 'Unrated Action Adventure');
      expect(score).toBeNull();

      if (typeof window !== 'undefined') {
        window.removeEventListener('antigravity_critic_updated', dispatchSpy);
      }
    });

    it('getCriticScore returns user override immediately without network calls or fallback to synthetic steam score', () => {
      // Age of Empires II: Definitive Edition normally returns Metacritic 84
      // Let user override it to 99 Custom
      const customScore: CriticScoreData = {
        source: 'custom',
        score: 99,
        tier: 'Mighty',
        url: 'https://example.com/aoe2-override',
        isVerified: true,
      };

      const override: UserGameOverride = {
        gameId: 'steam-813780',
        steamAppId: 813780,
        title: 'Age of Empires II: Definitive Edition',
        matchedStore: 'steam',
        reviewScoreOverride: customScore,
        updatedAt: new Date().toISOString(),
      };

      saveUserOverride(override);

      const result = criticScoreService.getCriticScore(813780, 'Age of Empires II: Definitive Edition');
      expect(result).not.toBeNull();
      expect(result?.score).toBe(99);
      expect(result?.source).toBe('custom');
    });

    it('getCriticScore returns null immediately for unrated override even when game has known Metacritic score', () => {
      // Age of Empires II: Definitive Edition normally returns Metacritic 84
      // Let user override it to null (Unrated / Hide Review Score)
      const override: UserGameOverride = {
        gameId: 'steam-813780',
        steamAppId: 813780,
        title: 'Age of Empires II: Definitive Edition',
        matchedStore: 'steam',
        reviewScoreOverride: null,
        updatedAt: new Date().toISOString(),
      };

      saveUserOverride(override);

      const result = criticScoreService.getCriticScore(813780, 'Age of Empires II: Definitive Edition');
      expect(result).toBeNull();
    });

    it('resolveDynamicScore returns user override immediately without executing network scraping', async () => {
      const customScore: CriticScoreData = {
        source: 'custom',
        score: 94,
        tier: 'Mighty',
        url: '',
        isVerified: true,
      };

      const override: UserGameOverride = {
        gameId: 'custom-unlinked-rpg',
        title: 'Unlinked Live RPG 2026',
        matchedStore: 'custom',
        reviewScoreOverride: customScore,
        updatedAt: new Date().toISOString(),
      };

      saveUserOverride(override);

      const dynamicScore = await criticScoreService.resolveDynamicScore(
        'Unlinked Live RPG 2026',
        null,
        undefined
      );

      expect(dynamicScore).toEqual(customScore);
    });

    it('resolveDynamicScore returns null immediately when user override is null (Unrated)', async () => {
      const override: UserGameOverride = {
        gameId: 'custom-unrated-rpg',
        title: 'Unlinked Live Unrated RPG 2026',
        matchedStore: 'custom',
        reviewScoreOverride: null,
        updatedAt: new Date().toISOString(),
      };

      saveUserOverride(override);

      const dynamicScore = await criticScoreService.resolveDynamicScore(
        'Unlinked Live Unrated RPG 2026',
        null,
        undefined
      );

      expect(dynamicScore).toBeNull();
    });
  });
});
