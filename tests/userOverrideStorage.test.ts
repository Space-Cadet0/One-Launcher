import { describe, it, expect, beforeEach } from 'vitest';
import {
  STORAGE_KEY_USER_OVERRIDES,
  loadUserOverrides,
  saveUserOverride,
  removeUserOverride,
  getUserOverrideForGame,
  applyUserOverrideToGame,
  applyUserOverridesToCatalog,
} from '../src/services/storage/userOverrideStorage';
import { sanitizeGameCatalog } from '../src/services/integrations/catalogSanitizer';
import { mergeStorefrontGames } from '../src/services/integrations/integrationStorage';
import { getCoverCandidates } from '../src/components/Library/LibraryGridView';
import { CanonicalGame } from '../src/contracts/game';
import { UserGameOverride } from '../src/contracts/override';

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
(globalThis as unknown as { localStorage: Storage }).localStorage = mockStorage;
(globalThis as unknown as { window: { localStorage: Storage } }).window = { localStorage: mockStorage };

describe('User Game Override & Storage Layer', () => {
  beforeEach(() => {
    mockStorage.clear();
  });

  it('saves, loads, and removes user overrides from storage', () => {
    expect(loadUserOverrides()).toEqual({});

    const override: UserGameOverride = {
      gameId: 'steam-12345',
      title: 'Custom Title',
      matchedStore: 'custom',
      capsuleImage: 'https://example.com/custom-cover.jpg',
      updatedAt: '2026-10-12T12:00:00Z',
    };

    saveUserOverride(override);
    const loaded = loadUserOverrides();
    expect(loaded['steam-12345']).toBeDefined();
    expect(loaded['steam-12345'].title).toBe('Custom Title');

    removeUserOverride('steam-12345');
    expect(loadUserOverrides()).toEqual({});
  });

  it('correctly matches game by game.id, steamAppId, and platform keys', () => {
    const override: UserGameOverride = {
      gameId: 'custom-game-1',
      platformId: 'gog',
      platformGameId: '1837805079',
      title: 'Blood Omen: Overridden Custom Edition',
      matchedStore: 'gog',
      updatedAt: '2026-10-12T12:00:00Z',
    };

    saveUserOverride(override);
    const overrides = loadUserOverrides();

    const game: CanonicalGame = {
      id: 'gog-1837805079',
      title: 'Blood Omen: Legacy of Kain',
      sortTitle: 'Blood Omen: Legacy of Kain',
      platforms: [{ platformId: 'gog', platformGameId: '1837805079' }],
    };

    const matched = getUserOverrideForGame(game, overrides);
    expect(matched).toBeDefined();
    expect(matched?.title).toBe('Blood Omen: Overridden Custom Edition');
  });

  it('applies override fields and unlinks Steam App ID when steamAppId is null', () => {
    const game: CanonicalGame = {
      id: 'steam-1139900',
      title: 'Ghostrunner',
      sortTitle: 'Ghostrunner',
      steamAppId: 1139900,
      capsuleImage: 'https://example.com/old-cover.jpg',
      platforms: [{ platformId: 'steam', platformGameId: '1139900' }],
    };

    const override: UserGameOverride = {
      gameId: 'steam-1139900',
      title: 'Ghostrunner: My Custom Modded Edition',
      steamAppId: null, // Explicitly unlinked from Steam!
      capsuleImage: 'https://example.com/new-cover.jpg',
      shortDescription: 'Custom blurb',
      matchedStore: 'custom',
      updatedAt: '2026-10-12T12:00:00Z',
    };

    const updated = applyUserOverrideToGame(game, override);
    expect(updated.title).toBe('Ghostrunner: My Custom Modded Edition');
    expect(updated.steamAppId).toBeUndefined();
    expect(updated.capsuleImage).toBe('https://example.com/new-cover.jpg');
    expect(updated.shortDescription).toBe('Custom blurb');
  });

  it('guarantees user overrides take highest priority over KNOWN_GAME_PATCHES in sanitizeGameCatalog', () => {
    // Prey in KNOWN_GAME_PATCHES sets steamAppId: 480490.
    // User wants it unlinked from Steam with custom art.
    const override: UserGameOverride = {
      gameId: 'steam-480490',
      title: 'Prey (Non-Steam User Edition)',
      steamAppId: null,
      capsuleImage: 'https://example.com/prey-user-cover.jpg',
      matchedStore: 'custom',
      updatedAt: '2026-10-12T12:00:00Z',
    };

    saveUserOverride(override);

    const inputCatalog: CanonicalGame[] = [
      {
        id: 'steam-480490',
        title: 'Prey',
        sortTitle: 'Prey',
        steamAppId: 480490,
        platforms: [{ platformId: 'epic', platformGameId: 'b02b1bf386df448fb564858e7fd6a635' }],
      },
    ];

    const sanitized = sanitizeGameCatalog(inputCatalog);
    expect(sanitized).toHaveLength(1);
    expect(sanitized[0].title).toBe('Prey (Non-Steam User Edition)');
    expect(sanitized[0].steamAppId).toBeUndefined();
    expect(sanitized[0].capsuleImage).toBe('https://example.com/prey-user-cover.jpg');
  });

  it('preserves user overrides against incoming storefront data during mergeStorefrontGames', () => {
    const override: UserGameOverride = {
      gameId: 'steam-1139900',
      title: 'Ghostrunner (Personal Custom Title)',
      capsuleImage: 'https://example.com/custom-ghostrunner.jpg',
      matchedStore: 'steam',
      updatedAt: '2026-10-12T12:00:00Z',
    };

    saveUserOverride(override);

    const currentCatalog: CanonicalGame[] = [
      {
        id: 'steam-1139900',
        title: 'Ghostrunner (Personal Custom Title)',
        sortTitle: 'Ghostrunner (Personal Custom Title)',
        steamAppId: 1139900,
        capsuleImage: 'https://example.com/custom-ghostrunner.jpg',
        platforms: [{ platformId: 'steam', platformGameId: '1139900' }],
      },
    ];

    const incomingGames: CanonicalGame[] = [
      {
        id: 'steam-1139900',
        title: 'Ghostrunner',
        sortTitle: 'Ghostrunner',
        steamAppId: 1139900,
        capsuleImage: 'https://images-2.gog-statics.com/default_cover.jpg',
        platforms: [{ platformId: 'gog', platformGameId: '1957528513' }],
      },
    ];

    const merged = mergeStorefrontGames(currentCatalog, incomingGames, 'gog');
    expect(merged).toHaveLength(1);
    expect(merged[0].title).toBe('Ghostrunner (Personal Custom Title)');
    expect(merged[0].capsuleImage).toBe('https://example.com/custom-ghostrunner.jpg');
    expect(merged[0].platforms).toHaveLength(2);
  });

  it('guarantees user override cover for Alone in the Dark 1 takes precedence over Steam 600x900 CDN poster', () => {
    // Alone in the Dark 1 has Steam App ID 548090 and GOG ID 1207660923
    const game: CanonicalGame = {
      id: 'steam-548090',
      title: 'Alone in the Dark 1',
      sortTitle: 'Alone in the Dark 1',
      steamAppId: 548090,
      platforms: [{ platformId: 'gog', platformGameId: '1207660923' }],
      capsuleImage: 'https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/548090/library_600x900_2x.jpg',
    };

    // Default candidates without override prefer Steam 600x900
    const defaultCandidates = getCoverCandidates(game);
    expect(defaultCandidates[0]).toContain('548090/library_600x900_2x.jpg');

    // User applies an override with classic GOG vertical art
    const gogCoverArt = 'https://images.gog-statics.com/bfa3ef0eb558b33325550eb4e56b6cf3a6f99a1c935b5cf10187128a691810ae.jpg';
    const override: UserGameOverride = {
      gameId: 'steam-548090',
      platformId: 'gog',
      platformGameId: '1207660923',
      title: 'Alone in the Dark (1992 Classic)',
      matchedStore: 'gog',
      capsuleImage: gogCoverArt,
      updatedAt: '2026-10-12T14:00:00Z',
    };

    saveUserOverride(override);

    const updatedGame = applyUserOverrideToGame(game, override);
    expect(updatedGame.capsuleImage).toBe(gogCoverArt);

    // Candidates WITH user override MUST place user's chosen cover at candidate #0
    const candidatesWithOverride = getCoverCandidates(updatedGame, override.capsuleImage, override);
    expect(candidatesWithOverride[0]).toBe(gogCoverArt);
  });

  it('completely suppresses Steam matching when game is explicitly unlinked from Steam', () => {
    const game: CanonicalGame = {
      id: 'steam-548090',
      title: 'Alone in the Dark 1',
      sortTitle: 'Alone in the Dark 1',
      steamAppId: 548090,
      platforms: [{ platformId: 'gog', platformGameId: '1207660923' }],
      capsuleImage: 'https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/548090/library_600x900_2x.jpg',
    };

    const igdbCover = 'https://images.igdb.com/igdb/image/upload/t_cover_big/co6jwo.jpg';
    const unlinkedOverride: UserGameOverride = {
      gameId: 'steam-548090',
      platformId: 'gog',
      platformGameId: '1207660923',
      title: 'Alone in the Dark (1992 Non-Steam)',
      steamAppId: null, // explicitly unlinked from Steam!
      matchedStore: 'igdb',
      capsuleImage: igdbCover,
      shortDescription: 'Classic 1992 DOS survival horror masterpiece.',
      updatedAt: '2026-10-12T14:00:00Z',
    };

    saveUserOverride(unlinkedOverride);

    const unlinkedGame = applyUserOverrideToGame(game, unlinkedOverride);
    expect(unlinkedGame.steamAppId).toBeUndefined();

    const candidates = getCoverCandidates(unlinkedGame, unlinkedOverride.capsuleImage, unlinkedOverride);
    // Priority 1 is user's IGDB cover
    expect(candidates[0]).toBe(igdbCover);
    // Steam 548090 cover art must NOT be present since it is explicitly unlinked!
    expect(candidates.some((c) => c.includes('548090/library_600x900'))).toBe(false);
  });
});
