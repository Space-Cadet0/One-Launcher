import { describe, it, expect, vi, beforeEach } from 'vitest';

// Node environment mock for window and CustomEvent
if (typeof (globalThis as any).window === 'undefined') {
  const listeners: Record<string, Function[]> = {};
  (globalThis as any).window = {
    addEventListener: (event: string, fn: Function) => {
      listeners[event] = listeners[event] || [];
      listeners[event].push(fn);
    },
    removeEventListener: (event: string, fn: Function) => {
      if (listeners[event]) {
        listeners[event] = listeners[event].filter((f) => f !== fn);
      }
    },
    dispatchEvent: (event: any) => {
      const fns = listeners[event.type] || [];
      fns.forEach((f) => f(event));
      return true;
    },
  };
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
import { CanonicalGame } from '../src/contracts/game';
import { UserGameOverride } from '../src/contracts/override';
import { StorefrontReviewAnchor } from '../src/contracts/critic';
import {
  applyUserOverrideToGame,
  saveUserOverride,
  removeUserOverride,
} from '../src/services/storage/userOverrideStorage';
import { criticScoreService } from '../src/services/critic/criticScoreService';
import { steamMatcher, getEffectiveSteamAppId } from '../src/services/steam/steamMatcher';
import { metadataScraperService } from '../src/services/scraper/metadataScraperService';
import { storefrontReviewHarvester } from '../src/services/critic/storefrontReviewHarvester';

describe('Option 1 & Option 3: Override Bridge, Non-Steam Guarding & Review Anchors', () => {
  beforeEach(() => {
    criticScoreService.clearCache();
    storefrontReviewHarvester.clearCache();
    if (typeof localStorage !== 'undefined') {
      localStorage.clear();
    }
  });

  describe('applyUserOverrideToGame explicit non-Steam contract', () => {
    const baseGame: CanonicalGame = {
      id: 'custom-game-1',
      title: 'Awesome Non-Steam Game',
      sortTitle: 'Awesome Non-Steam Game',
      steamAppId: 12345,
      platforms: [{ platformId: 'gog', platformGameId: '987', installed: true }],
      headerImage: 'https://example.com/h.jpg',
      developers: [],
      publishers: [],
      genres: [],
      tags: [],
    };

    it('sets isExplicitNonSteam=true and steamAppId=undefined when override.steamAppId === null', () => {
      const override: UserGameOverride = {
        gameId: baseGame.id,
        matchedStore: 'gog',
        steamAppId: null,
        updatedAt: new Date().toISOString(),
      };

      const updated = applyUserOverrideToGame(baseGame, override);
      expect(updated.steamAppId).toBeUndefined();
      expect(updated.isExplicitNonSteam).toBe(true);
    });

    it('sets isExplicitNonSteam=false and sets steamAppId when override.steamAppId is a number', () => {
      const override: UserGameOverride = {
        gameId: baseGame.id,
        matchedStore: 'steam',
        steamAppId: 440,
        updatedAt: new Date().toISOString(),
      };

      const updated = applyUserOverrideToGame(baseGame, override);
      expect(updated.steamAppId).toBe(440);
      expect(updated.isExplicitNonSteam).toBe(false);
    });

    it('honors explicit override.isExplicitNonSteam flag if explicitly provided', () => {
      const override: UserGameOverride = {
        gameId: baseGame.id,
        matchedStore: 'custom',
        isExplicitNonSteam: true,
        updatedAt: new Date().toISOString(),
      };

      const updated = applyUserOverrideToGame(baseGame, override);
      expect(updated.isExplicitNonSteam).toBe(true);
    });
  });

  describe('steamMatcher.getEffectiveSteamAppId guards against auto re-linking', () => {
    it('returns undefined if game has isExplicitNonSteam === true even if title matches known Steam title', () => {
      const game: CanonicalGame = {
        id: 'gog-witcher',
        title: 'The Witcher 3: Wild Hunt',
        sortTitle: 'Witcher 3: Wild Hunt',
        isExplicitNonSteam: true,
        platforms: [{ platformId: 'gog', platformGameId: '123', installed: true }],
        headerImage: '',
        developers: [],
        publishers: [],
        genres: [],
        tags: [],
      };

      expect(steamMatcher.getEffectiveSteamAppId(game)).toBeUndefined();
      expect(getEffectiveSteamAppId(game)).toBeUndefined();
    });

    it('returns undefined if steamAppId is explicitly null', () => {
      const game = {
        title: 'Cyberpunk 2077',
        steamAppId: null,
      };

      expect(steamMatcher.getEffectiveSteamAppId(game)).toBeUndefined();
    });

    it('returns steamAppId if valid numeric steamAppId is present', () => {
      const game = {
        title: 'Cyberpunk 2077',
        steamAppId: 1091500,
      };

      expect(steamMatcher.getEffectiveSteamAppId(game)).toBe(1091500);
    });
  });

  describe('Events: saveUserOverride and removeUserOverride', () => {
    it('dispatches antigravity:user-override-updated with override and oldGame', () => {
      const listener = vi.fn();
      window.addEventListener('antigravity:user-override-updated', listener as EventListener);

      const oldGame: CanonicalGame = {
        id: 'test-game',
        title: 'Old Game Name',
        sortTitle: 'Old Game Name',
        steamAppId: 555,
        platforms: [],
        headerImage: '',
        developers: [],
        publishers: [],
        genres: [],
        tags: [],
      };

      const override: UserGameOverride = {
        gameId: 'test-game',
        title: 'New Game Name',
        matchedStore: 'steam',
        steamAppId: 777,
        updatedAt: new Date().toISOString(),
      };

      saveUserOverride(override, oldGame);

      expect(listener).toHaveBeenCalled();
      const event = listener.mock.calls[0][0] as CustomEvent;
      expect(event.detail.override.gameId).toBe('test-game');
      expect(event.detail.override.title).toBe('New Game Name');
      expect(event.detail.oldGame.title).toBe('Old Game Name');

      window.removeEventListener('antigravity:user-override-updated', listener as EventListener);
    });

    it('dispatches antigravity:user-override-removed with gameId', () => {
      const listener = vi.fn();
      window.addEventListener('antigravity:user-override-removed', listener as EventListener);

      removeUserOverride('test-game');

      expect(listener).toHaveBeenCalled();
      const event = listener.mock.calls[0][0] as CustomEvent;
      expect(event.detail).toEqual({ gameId: 'test-game' });

      window.removeEventListener('antigravity:user-override-removed', listener as EventListener);
    });
  });

  describe('criticScoreService.handleUserOverride cache invalidation & anchor resolution', () => {
    it('evicts old and new keys and proactively resolves with storefrontAnchor', async () => {
      const resolveSpy = vi.spyOn(criticScoreService, 'resolveDynamicScore').mockResolvedValue(null);

      const anchor: StorefrontReviewAnchor = {
        storefront: 'steam',
        metacriticUrl: 'https://www.metacritic.com/game/custom-title/critic-reviews/',
        metacriticScore: 88,
        isVerifiedGroundTruth: true,
      };

      const override: UserGameOverride = {
        gameId: 'my-game',
        title: 'New Title',
        steamAppId: 9999,
        matchedStore: 'steam',
        storefrontAnchor: anchor,
        updatedAt: new Date().toISOString(),
      };

      const oldGame: CanonicalGame = {
        id: 'my-game',
        title: 'Old Title',
        sortTitle: 'Old Title',
        steamAppId: 8888,
        platforms: [],
        headerImage: '',
        developers: [],
        publishers: [],
        genres: [],
        tags: [],
      };

      criticScoreService.handleUserOverride(override, oldGame);

      expect(resolveSpy).toHaveBeenCalledWith('New Title', 9999, undefined, anchor);
      resolveSpy.mockRestore();
    });
  });

  describe('metadataScraperService storefront anchor harvesting during Fix & Match', () => {
    it('attaches steamAnchor when scraping a Steam candidate', async () => {
      const mockSteamAnchor: StorefrontReviewAnchor = {
        storefront: 'steam',
        metacriticScore: 84,
        metacriticUrl: 'https://www.metacritic.com/game/age-of-empires-ii-definitive-edition/critic-reviews/',
        isVerifiedGroundTruth: true,
      };

      vi.spyOn(storefrontReviewHarvester, 'getSteamAnchor').mockResolvedValueOnce(mockSteamAnchor);

      const candidate = {
        id: 813780,
        source: 'steam' as const,
        title: 'Age of Empires II: Definitive Edition',
        steamAppId: 813780,
      };

      const bundle = await metadataScraperService.scrapeMatchDetails(candidate);
      expect(bundle.storefrontAnchor).toBeDefined();
      expect(bundle.storefrontAnchor?.metacriticScore).toBe(84);
      expect(bundle.storefrontAnchor?.storefront).toBe('steam');
    });

    it('attaches gogAnchor when scraping a GOG candidate', async () => {
      const mockGogAnchor: StorefrontReviewAnchor = {
        storefront: 'gog',
        metacriticScore: 92,
        openCriticScore: 92,
        isVerifiedGroundTruth: true,
      };

      vi.spyOn(storefrontReviewHarvester, 'getGogAnchor').mockResolvedValueOnce(mockGogAnchor);

      const candidate = {
        id: 'gog-1837805079',
        source: 'gog' as const,
        title: 'The Witcher 3: Wild Hunt',
        gogId: '1837805079',
      };

      const bundle = await metadataScraperService.scrapeMatchDetails(candidate);
      expect(bundle.storefrontAnchor).toBeDefined();
      expect(bundle.storefrontAnchor?.storefront).toBe('gog');
      expect(bundle.storefrontAnchor?.metacriticScore).toBe(92);
      expect(bundle.steamAppId).toBeNull();
    });
  });
});
