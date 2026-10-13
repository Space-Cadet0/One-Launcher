import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mock Storage and Browser Environment (Window & CustomEvent)
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

if (typeof (globalThis as any).window === 'undefined') {
  const listeners: Record<string, Function[]> = {};
  (globalThis as any).window = {
    localStorage: mockStorage,
    location: { hostname: '' },
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
      const fns = (listeners[event.type] || []).slice();
      fns.forEach((f) => f(event));
      return true;
    },
  };
} else {
  if (!(globalThis as any).window.localStorage) {
    (globalThis as any).window.localStorage = mockStorage;
  }
}

// ---------------------------------------------------------------------------
// Imports under test
// ---------------------------------------------------------------------------
import { CanonicalGame } from '../src/contracts/game';
import { UserGameOverride } from '../src/contracts/override';
import { StorefrontReviewAnchor, CriticScoreData } from '../src/contracts/critic';
import {
  applyUserOverrideToGame,
  saveUserOverride,
  removeUserOverride,
} from '../src/services/storage/userOverrideStorage';
import {
  steamMatcher,
  getEffectiveSteamAppId,
  computeTitleSimilarity,
  normalizeTitleKey as steamExportedNormalizeTitleKey,
  stripEditionSuffix as steamExportedStripEditionSuffix,
} from '../src/services/steam/steamMatcher';
import {
  criticScoreService,
  getOpenCriticData,
} from '../src/services/critic/criticScoreService';
import {
  normalizeTitleKey,
  stripEditionSuffix,
  isSequelMismatch,
  extractSequelIdentifier,
  ROMAN_TO_ARABIC,
  EDITION_TOKENS,
} from '../src/services/common/titleUtils';
import {
  normalizeCriticTitleKey,
  stripEditionSuffix as criticStripEditionSuffix,
  isSequelMismatch as criticIsSequelMismatch,
} from '../src/services/critic/criticUtils';
import { metadataScraperService } from '../src/services/scraper/metadataScraperService';
import { storefrontReviewHarvester } from '../src/services/critic/storefrontReviewHarvester';
import { metacriticResolver } from '../src/services/critic/metacriticResolver';

describe('Comprehensive Options 1, 2, and 3 Integration & Regression Test Suite', () => {
  beforeEach(() => {
    mockStorage.clear();
    if (typeof localStorage !== 'undefined') {
      localStorage.clear();
    }
    criticScoreService.clearCache();
    storefrontReviewHarvester.clearCache();
    metacriticResolver.clearCache();
    criticScoreService.initEventListeners();
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // =========================================================================
  // OPTION 1: Wizard Override Bridge & Invalidation
  // =========================================================================
  describe('Option 1: Wizard Override Bridge & Invalidation', () => {
    const baseGame: CanonicalGame = {
      id: 'epic-game-42',
      title: 'The Witcher 3: Wild Hunt',
      sortTitle: 'Witcher 3: Wild Hunt',
      steamAppId: 292030,
      platforms: [{ platformId: 'epic', platformGameId: 'witcher-3', installed: true }],
      headerImage: 'https://example.com/witcher.jpg',
      developers: ['CD PROJEKT RED'],
      publishers: ['CD PROJEKT RED'],
      genres: ['RPG'],
      tags: ['Open World', 'Story Rich'],
    };

    describe('applyUserOverrideToGame setting isExplicitNonSteam = true on steamAppId: null', () => {
      it('sets isExplicitNonSteam = true and steamAppId = undefined when override.steamAppId === null', () => {
        const override: UserGameOverride = {
          gameId: baseGame.id,
          matchedStore: 'gog',
          steamAppId: null,
          title: 'The Witcher 3: Wild Hunt (GOG Edition)',
          updatedAt: new Date().toISOString(),
        };

        const applied = applyUserOverrideToGame(baseGame, override);

        expect(applied.steamAppId).toBeUndefined();
        expect(applied.isExplicitNonSteam).toBe(true);
        expect(applied.title).toBe('The Witcher 3: Wild Hunt (GOG Edition)');
      });

      it('sets isExplicitNonSteam = false and sets steamAppId when override.steamAppId is a valid number', () => {
        const nonSteamGame: CanonicalGame = {
          ...baseGame,
          steamAppId: undefined,
          isExplicitNonSteam: true,
        };

        const override: UserGameOverride = {
          gameId: nonSteamGame.id,
          matchedStore: 'steam',
          steamAppId: 292030,
          updatedAt: new Date().toISOString(),
        };

        const applied = applyUserOverrideToGame(nonSteamGame, override);

        expect(applied.steamAppId).toBe(292030);
        expect(applied.isExplicitNonSteam).toBe(false);
      });

      it('preserves explicit isExplicitNonSteam boolean flag if supplied in override', () => {
        const override: UserGameOverride = {
          gameId: baseGame.id,
          matchedStore: 'custom',
          isExplicitNonSteam: true,
          updatedAt: new Date().toISOString(),
        };

        const applied = applyUserOverrideToGame(baseGame, override);
        expect(applied.isExplicitNonSteam).toBe(true);
      });
    });

    describe('getEffectiveSteamAppId returning undefined for isExplicitNonSteam = true', () => {
      it('returns undefined for isExplicitNonSteam = true even when game title is a known Steam title', () => {
        const gameWithExplicitFlag: CanonicalGame = {
          id: 'custom-witcher-gog',
          title: 'The Witcher 3: Wild Hunt',
          sortTitle: 'Witcher 3: Wild Hunt',
          isExplicitNonSteam: true,
          steamAppId: 292030, // Even if an old steamAppId was present
          platforms: [{ platformId: 'gog', platformGameId: '123', installed: true }],
          headerImage: '',
          developers: [],
          publishers: [],
          genres: [],
          tags: [],
        };

        // Standalone helper
        expect(getEffectiveSteamAppId(gameWithExplicitFlag)).toBeUndefined();
        // Class method
        expect(steamMatcher.getEffectiveSteamAppId(gameWithExplicitFlag)).toBeUndefined();
      });

      it('returns undefined when steamAppId is explicitly null', () => {
        const game = {
          title: 'Cyberpunk 2077',
          steamAppId: null,
        };

        expect(getEffectiveSteamAppId(game)).toBeUndefined();
        expect(steamMatcher.getEffectiveSteamAppId(game)).toBeUndefined();
      });

      it('returns numeric steamAppId when present and isExplicitNonSteam is falsy', () => {
        const game = {
          title: 'Cyberpunk 2077',
          steamAppId: 1091500,
          isExplicitNonSteam: false,
        };

        expect(getEffectiveSteamAppId(game)).toBe(1091500);
        expect(steamMatcher.getEffectiveSteamAppId(game)).toBe(1091500);
      });
    });

    describe('handleUserOverride evicting stale critic scores and dynamic resolution state', () => {
      it('evicts memory cache, localStorage, in-flight resolutions, and attempted sets for old and new keys', async () => {
        const oldGame: CanonicalGame = {
          id: 'game-invalidation-1',
          title: 'Stale Title Alpha',
          sortTitle: 'Stale Title Alpha',
          steamAppId: 11111,
          platforms: [],
          headerImage: '',
          developers: [],
          publishers: [],
          genres: [],
          tags: [],
        };

        const oldScoreData: CriticScoreData = {
          id: 'id:11111',
          source: 'steam',
          score: 80,
          tier: 'Strong',
          isVerified: false,
          isSynthetic: true,
        };

        // Pre-seed into criticScoreService internal structures and localStorage
        const oldIdKey = 'id:11111';
        const oldTitleKey = 'title:stale title alpha';
        const serviceAny = criticScoreService as any;

        serviceAny.inMemoryCache.set(oldIdKey, oldScoreData);
        serviceAny.inMemoryCache.set(oldTitleKey, oldScoreData);
        serviceAny.attemptedDynamicResolutions.add(oldIdKey);
        serviceAny.attemptedDynamicResolutions.add(oldTitleKey);

        localStorage.setItem(`antigravity_critic_v8_${oldIdKey}`, JSON.stringify(oldScoreData));
        localStorage.setItem(`antigravity_critic_v8_${oldTitleKey}`, JSON.stringify(oldScoreData));

        const clearHarvesterSpy = vi.spyOn(storefrontReviewHarvester, 'clearCache');
        const resolveSpy = vi.spyOn(criticScoreService, 'resolveDynamicScore').mockResolvedValue(null);

        const newAnchor: StorefrontReviewAnchor = {
          storefront: 'steam',
          metacriticScore: 88,
          metacriticUrl: 'https://www.metacritic.com/game/fresh-title-beta/critic-reviews/',
          isVerifiedGroundTruth: true,
        };

        const override: UserGameOverride = {
          gameId: oldGame.id,
          title: 'Fresh Title Beta',
          steamAppId: 22222,
          matchedStore: 'steam',
          storefrontAnchor: newAnchor,
          updatedAt: new Date().toISOString(),
        };

        // Execute invalidation
        criticScoreService.handleUserOverride(override, oldGame);

        // Verify old entries were purged from memory cache
        expect(serviceAny.inMemoryCache.has(oldIdKey)).toBe(false);
        expect(serviceAny.inMemoryCache.has(oldTitleKey)).toBe(false);

        // Verify old entries were purged from attempted dynamic resolutions
        expect(serviceAny.attemptedDynamicResolutions.has(oldIdKey)).toBe(false);
        expect(serviceAny.attemptedDynamicResolutions.has(oldTitleKey)).toBe(false);

        // Verify old entries were purged from localStorage
        expect(localStorage.getItem(`antigravity_critic_v8_${oldIdKey}`)).toBeNull();
        expect(localStorage.getItem(`antigravity_critic_v8_${oldTitleKey}`)).toBeNull();

        // Verify storefront review cache was cleared
        expect(clearHarvesterSpy).toHaveBeenCalled();

        // Verify resolveDynamicScore was initiated with new title and storefront anchor
        expect(resolveSpy).toHaveBeenCalledWith('Fresh Title Beta', 22222, undefined, newAnchor);
      });
    });

    describe('Custom event dispatching antigravity:user-override-updated and antigravity:user-override-removed', () => {
      it('saveUserOverride dispatches antigravity:user-override-updated with override and oldGame payload', () => {
        const updateListener = vi.fn();
        window.addEventListener('antigravity:user-override-updated', updateListener as EventListener);

        const oldGame: CanonicalGame = {
          id: 'test-event-game',
          title: 'Old Title',
          sortTitle: 'Old Title',
          steamAppId: 555,
          platforms: [],
          headerImage: '',
          developers: [],
          publishers: [],
          genres: [],
          tags: [],
        };

        const override: UserGameOverride = {
          gameId: 'test-event-game',
          title: 'New Corrected Title',
          steamAppId: 777,
          matchedStore: 'steam',
          updatedAt: new Date().toISOString(),
        };

        saveUserOverride(override, oldGame);

        expect(updateListener).toHaveBeenCalled();
        const event = updateListener.mock.calls[0][0] as CustomEvent;
        expect(event.detail).toBeDefined();
        expect(event.detail.override.gameId).toBe('test-event-game');
        expect(event.detail.override.title).toBe('New Corrected Title');
        expect(event.detail.override.steamAppId).toBe(777);
        expect(event.detail.oldGame.title).toBe('Old Title');

        window.removeEventListener('antigravity:user-override-updated', updateListener as EventListener);
      });

      it('removeUserOverride dispatches antigravity:user-override-removed with gameId', () => {
        const removeListener = vi.fn();
        window.addEventListener('antigravity:user-override-removed', removeListener as EventListener);

        removeUserOverride('test-event-game');

        expect(removeListener).toHaveBeenCalled();
        const event = removeListener.mock.calls[0][0] as CustomEvent;
        expect(event.detail).toEqual({ gameId: 'test-event-game' });

        window.removeEventListener('antigravity:user-override-removed', removeListener as EventListener);
      });

      it('criticScoreService receives window event antigravity:user-override-updated and triggers cache invalidation', () => {
        const handleOverrideSpy = vi.spyOn(criticScoreService, 'handleUserOverride');

        const override: UserGameOverride = {
          gameId: 'reactivity-test',
          title: 'Reactive Override Title',
          matchedStore: 'steam',
          steamAppId: 98765,
          updatedAt: new Date().toISOString(),
        };

        window.dispatchEvent(
          new CustomEvent('antigravity:user-override-updated', {
            detail: { override, oldGame: undefined },
          })
        );

        expect(handleOverrideSpy).toHaveBeenCalledWith(override, undefined);
      });

      it('criticScoreService receives window event antigravity:user-override-removed and clears cache', () => {
        const clearCacheSpy = vi.spyOn(criticScoreService, 'clearCache');

        window.dispatchEvent(
          new CustomEvent('antigravity:user-override-removed', {
            detail: { gameId: 'reactivity-test' },
          })
        );

        expect(clearCacheSpy).toHaveBeenCalled();
      });
    });
  });

  // =========================================================================
  // OPTION 2: Unified Title Normalization
  // =========================================================================
  describe('Option 2: Unified Title Normalization', () => {
    describe('titleUtils.ts integration with both steamMatcher and criticUtils', () => {
      it('unifies normalizeTitleKey across titleUtils, steamMatcher, and criticUtils', () => {
        const sampleTitles = [
          'Deus Ex: Human Revolution™ - Director\'s Cut',
          'S.T.A.L.K.E.R.: Shadow of Chernobyl',
          'Tom Clancy\'s Rainbow Six® Siege',
          'METAL GEAR SOLID Δ: SNAKE EATER',
          'NieR:Automata™ Game of the YoRHa Edition',
        ];

        for (const title of sampleTitles) {
          const canonical = normalizeTitleKey(title);
          const criticNorm = normalizeCriticTitleKey(title);
          const steamExportedNorm = steamExportedNormalizeTitleKey(title);
          const steamMethodNorm = steamMatcher.normalizeTitleKey(title);

          expect(criticNorm).toBe(canonical);
          expect(steamExportedNorm).toBe(canonical);
          expect(steamMethodNorm).toBe(canonical);
        }
      });

      it('unifies stripEditionSuffix across titleUtils, steamMatcher, and criticUtils', () => {
        const sampleTitles = [
          'Age of Empires II: Definitive Edition',
          'The Witcher 3: Wild Hunt - Game of the Year Edition',
          'XCOM: Enemy Unknown Complete Pack',
          'Control Ultimate Edition',
          'Dishonored - Definitive Edition',
          'Borderlands 2: Game of the Year Edition',
        ];

        for (const title of sampleTitles) {
          const canonical = stripEditionSuffix(title);
          const criticStripped = criticStripEditionSuffix(title);
          const steamExportedStripped = steamExportedStripEditionSuffix(title);
          const steamMethodStripped = steamMatcher.stripEditionSuffix(title);

          expect(criticStripped).toBe(canonical);
          expect(steamExportedStripped).toBe(canonical);
          expect(steamMethodStripped).toBe(canonical);
        }
      });

      it('unifies isSequelMismatch across titleUtils and criticUtils', () => {
        const pairs: [string, string][] = [
          ['Doom', 'Doom II'],
          ['The Witcher 2', 'The Witcher 3'],
          ['Quake', 'Quake 2'],
          ['Left 4 Dead', 'Left 4 Dead 2'],
          ['Fallout 3', 'Fallout 4'],
          ['Mafia', 'Mafia II'],
          ['Doom', 'Doom'],
          ['The Witcher 3', 'The Witcher 3: Wild Hunt'],
        ];

        for (const [q, c] of pairs) {
          const canonicalMismatch = isSequelMismatch(q, c);
          const criticMismatch = criticIsSequelMismatch(q, c);
          expect(criticMismatch).toBe(canonicalMismatch);
        }
      });

      it('shares ROMAN_TO_ARABIC and EDITION_TOKENS definitions', () => {
        expect(ROMAN_TO_ARABIC['ii']).toBe('2');
        expect(ROMAN_TO_ARABIC['iii']).toBe('3');
        expect(ROMAN_TO_ARABIC['iv']).toBe('4');
        expect(ROMAN_TO_ARABIC['v']).toBe('5');
        expect(ROMAN_TO_ARABIC['vii']).toBe('7');
        expect(ROMAN_TO_ARABIC['x']).toBe('10');

        expect(EDITION_TOKENS.has('goty')).toBe(true);
        expect(EDITION_TOKENS.has('definitive')).toBe(true);
        expect(EDITION_TOKENS.has('deluxe')).toBe(true);
        expect(EDITION_TOKENS.has('complete')).toBe(true);
        expect(EDITION_TOKENS.has('remastered')).toBe(true);
      });
    });

    describe('Sequel mismatch detection (Doom vs Doom II, Witcher 2 vs Witcher 3)', () => {
      it('detects sequel mismatch between Doom and Doom II', () => {
        expect(isSequelMismatch('Doom', 'Doom II')).toBe(true);
        expect(isSequelMismatch('Doom II', 'Doom')).toBe(true);
        expect(computeTitleSimilarity('Doom', 'Doom II')).toBe(0);
      });

      it('detects sequel mismatch between Witcher 2 and Witcher 3', () => {
        expect(isSequelMismatch('Witcher 2', 'Witcher 3')).toBe(true);
        expect(isSequelMismatch('The Witcher 2', 'The Witcher 3')).toBe(true);
        expect(isSequelMismatch('The Witcher 2: Assassins of Kings', 'The Witcher 3: Wild Hunt')).toBe(true);
        expect(computeTitleSimilarity('The Witcher 2', 'The Witcher 3')).toBe(0);
      });

      it('detects sequel mismatch across other classic numbered franchises', () => {
        expect(isSequelMismatch('Quake', 'Quake 2')).toBe(true);
        expect(isSequelMismatch('Left 4 Dead', 'Left 4 Dead 2')).toBe(true);
        expect(isSequelMismatch('Grand Theft Auto IV', 'Grand Theft Auto V')).toBe(true);
        expect(isSequelMismatch('Fallout 3', 'Fallout 4')).toBe(true);
        expect(isSequelMismatch('Mafia', 'Mafia II')).toBe(true);
        expect(isSequelMismatch('Mafia', 'Mafia 3')).toBe(true);
      });

      it('allows legitimate same-game matches and subtitle variations without false positives', () => {
        expect(isSequelMismatch('Doom', 'Doom')).toBe(false);
        expect(isSequelMismatch('The Witcher 3', 'The Witcher 3: Wild Hunt')).toBe(false);
        expect(isSequelMismatch('Mafia II', 'Mafia II: Definitive Edition')).toBe(false);
        expect(isSequelMismatch('Deus Ex 2: Invisible War', 'Deus Ex: Invisible War')).toBe(false);
        expect(isSequelMismatch('20 Minutes Till Dawn', '20 Minutes Till Dawn')).toBe(false);
      });

      it('extractSequelIdentifier extracts both Arabic and Roman numeral sequels', () => {
        expect(extractSequelIdentifier('Doom II')).toBe('2');
        expect(extractSequelIdentifier('The Witcher 3')).toBe('3');
        expect(extractSequelIdentifier('Final Fantasy VII')).toBe('7');
        expect(extractSequelIdentifier('Grand Theft Auto V')).toBe('5');
        expect(extractSequelIdentifier('Half-Life 2')).toBe('2');
        expect(extractSequelIdentifier('Cyberpunk 2077')).toBeNull();
        expect(extractSequelIdentifier('Doom')).toBeNull();
      });
    });

    describe('Edition token stripping (Complete Pack, Definitive Edition, GOTY)', () => {
      it('strips Complete Pack suffix cleanly', () => {
        expect(stripEditionSuffix('XCOM: Enemy Unknown Complete Pack')).toBe('xcom enemy unknown');
        expect(stripEditionSuffix('Civilization V: The Complete Edition')).toBe('civilization v');
      });

      it('strips Definitive Edition suffix cleanly', () => {
        expect(stripEditionSuffix('Age of Empires II: Definitive Edition')).toBe('age of empires ii');
        expect(stripEditionSuffix('Dishonored: Definitive Edition')).toBe('dishonored');
        expect(stripEditionSuffix('Mafia: Definitive Edition')).toBe('mafia');
      });

      it('strips GOTY and Game of the Year Edition suffixes cleanly', () => {
        expect(stripEditionSuffix('The Witcher 3: Wild Hunt GOTY')).toBe('the witcher 3 wild hunt');
        expect(stripEditionSuffix('The Witcher® 3: Wild Hunt - Game of the Year Edition')).toBe('the witcher 3 wild hunt');
        expect(stripEditionSuffix('Borderlands 2: Game of the Year Edition')).toBe('borderlands 2');
        expect(stripEditionSuffix('Fallout 4: Game of the Year Edition')).toBe('fallout 4');
      });

      it('strips Deluxe, Gold, Remastered, and Collector\'s edition suffixes', () => {
        expect(stripEditionSuffix('Civilization VI: Digital Deluxe Edition')).toBe('civilization vi');
        expect(stripEditionSuffix('Worms Revolution Gold Edition')).toBe('worms revolution');
        expect(stripEditionSuffix('Dark Souls: Remastered')).toBe('dark souls');
        expect(stripEditionSuffix('Quake II (Remastered)')).toBe('quake ii');
        expect(stripEditionSuffix('Deus Ex: Human Revolution - Director\'s Cut')).toBe('deus ex human revolution');
      });
    });
  });

  // =========================================================================
  // OPTION 3: Direct Storefront Review Anchors
  // =========================================================================
  describe('Option 3: Direct Storefront Review Anchors', () => {
    describe('metadataScraperService.scrapeMatchDetails attaching storefrontAnchor for Steam and GOG', () => {
      it('attaches verified storefrontAnchor with storefront="steam" when scraping a Steam candidate', async () => {
        const mockSteamAnchor: StorefrontReviewAnchor = {
          storefront: 'steam',
          metacriticScore: 84,
          metacriticUrl: 'https://www.metacritic.com/game/age-of-empires-ii-definitive-edition/critic-reviews/',
          isVerifiedGroundTruth: true,
        };

        const steamHarvesterSpy = vi
          .spyOn(storefrontReviewHarvester, 'getSteamAnchor')
          .mockResolvedValueOnce(mockSteamAnchor);

        const candidate = {
          id: 813780,
          source: 'steam' as const,
          title: 'Age of Empires II: Definitive Edition',
          steamAppId: 813780,
        };

        const bundle = await metadataScraperService.scrapeMatchDetails(candidate);

        expect(steamHarvesterSpy).toHaveBeenCalledWith(813780);
        expect(bundle.storefrontAnchor).toBeDefined();
        expect(bundle.storefrontAnchor?.storefront).toBe('steam');
        expect(bundle.storefrontAnchor?.metacriticScore).toBe(84);
        expect(bundle.storefrontAnchor?.metacriticUrl).toContain('age-of-empires-ii-definitive-edition');
        expect(bundle.storefrontAnchor?.isVerifiedGroundTruth).toBe(true);
        expect(bundle.steamAppId).toBe(813780);
      });

      it('attaches verified storefrontAnchor with storefront="gog" and sets steamAppId=null when scraping a GOG candidate', async () => {
        const mockGogAnchor: StorefrontReviewAnchor = {
          storefront: 'gog',
          metacriticScore: 92,
          openCriticScore: 92,
          isVerifiedGroundTruth: true,
        };

        const gogHarvesterSpy = vi
          .spyOn(storefrontReviewHarvester, 'getGogAnchor')
          .mockResolvedValueOnce(mockGogAnchor);

        const candidate = {
          id: 'gog-1837805079',
          source: 'gog' as const,
          title: 'The Witcher 3: Wild Hunt',
          gogId: '1837805079',
        };

        const bundle = await metadataScraperService.scrapeMatchDetails(candidate);

        expect(gogHarvesterSpy).toHaveBeenCalledWith('1837805079', 'The Witcher 3: Wild Hunt');
        expect(bundle.storefrontAnchor).toBeDefined();
        expect(bundle.storefrontAnchor?.storefront).toBe('gog');
        expect(bundle.storefrontAnchor?.metacriticScore).toBe(92);
        expect(bundle.storefrontAnchor?.openCriticScore).toBe(92);
        expect(bundle.storefrontAnchor?.isVerifiedGroundTruth).toBe(true);
        // Guarantee GOG match does not poison steamAppId
        expect(bundle.steamAppId).toBeNull();
      });
    });

    describe('criticScoreService.resolveDynamicScore honoring storefrontAnchor as verified ground truth', () => {
      it('honors storefrontAnchor with Metacritic score as verified Tier 1 Metacritic ground truth', async () => {
        const anchor: StorefrontReviewAnchor = {
          storefront: 'steam',
          metacriticScore: 84,
          metacriticSlug: 'age-of-empires-ii-definitive-edition',
          metacriticUrl: 'https://www.metacritic.com/game/age-of-empires-ii-definitive-edition/critic-reviews/',
          isVerifiedGroundTruth: true,
        };

        vi.spyOn(metacriticResolver, 'resolveMetacritic').mockResolvedValueOnce({
          critic: {
            id: 'mc-age-of-empires-ii-definitive-edition',
            source: 'metacritic',
            score: 84,
            tier: 'Mighty',
            isVerified: true,
            url: 'https://www.metacritic.com/game/age-of-empires-ii-definitive-edition/critic-reviews/',
          },
          user: null,
        });

        const score = await criticScoreService.resolveDynamicScore(
          'Age of Empires II: Definitive Edition',
          813780,
          undefined,
          anchor
        );

        expect(score).not.toBeNull();
        expect(score?.source).toBe('metacritic');
        expect(score?.score).toBe(84);
        expect(score?.tier).toBe('Mighty');
        expect(score?.isVerified).toBe(true);
        expect(score?.url).toContain('age-of-empires-ii-definitive-edition');
      });

      it('honors storefrontAnchor with OpenCritic score as verified Tier 2 ground truth when Metacritic is unavailable', async () => {
        const anchor: StorefrontReviewAnchor = {
          storefront: 'gog',
          openCriticScore: 88,
          openCriticId: 77777,
          openCriticUrl: 'https://opencritic.com/game/77777/unique-indie-gog-title',
          isVerifiedGroundTruth: true,
        };

        const score = await criticScoreService.resolveDynamicScore(
          'Unique Indie GOG Title 2026 XYZ',
          null,
          undefined,
          anchor
        );

        expect(score).not.toBeNull();
        expect(score?.source).toBe('opencritic');
        expect(score?.score).toBe(88);
        expect(score?.tier).toBe('Mighty');
        expect(score?.isVerified).toBe(true);
        expect(score?.url).toContain('77777');
      }, 15000);

      it('vetoes conflicting OpenCritic candidate scores when drastically conflicting (> 5 pts) with verified storefrontAnchor', async () => {
        const anchor: StorefrontReviewAnchor = {
          storefront: 'gog',
          openCriticScore: 82,
          openCriticId: 10189,
          isVerifiedGroundTruth: true,
        };

        // When resolving an unlinked title with a verified GOG anchor (82),
        // any conflicting API candidate (> 5 pt difference) is rejected in favor of the anchor
        const score = await criticScoreService.resolveDynamicScore(
          'Unmatched Indie Action Title With Verified Anchor 999',
          null,
          null,
          anchor
        );

        expect(score).not.toBeNull();
        expect(score?.source).toBe('opencritic');
        expect(score?.score).toBe(82);
        expect(score?.isVerified).toBe(true);
      }, 15000);
    });
  });
});
