import { describe, it, expect, vi, beforeEach } from 'vitest';
import { metadataScraperService, cleanSearchQuery } from '../src/services/scraper/metadataScraperService';
import { CanonicalGame } from '../src/contracts/game';
import { SearchMatchCandidate } from '../src/contracts/override';

describe('MetadataScraperService', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  describe('cleanSearchQuery', () => {
    it('strips trademark symbols, punctuation, and extraneous whitespace', () => {
      expect(cleanSearchQuery('Cyberpunk 2077™: Phantom Liberty®!')).toBe('Cyberpunk 2077 Phantom Liberty');
      expect(cleanSearchQuery("Baldur's Gate 3 - Digital Deluxe Edition")).toBe('Baldurs Gate 3 Digital Deluxe Edition');
      expect(cleanSearchQuery('  Doom...   Eternal??  ')).toBe('Doom Eternal');
    });

    it('returns empty string for empty input', () => {
      expect(cleanSearchQuery('')).toBe('');
      expect(cleanSearchQuery('   ')).toBe('');
    });
  });

  describe('getSuggestedMatches', () => {
    it('generates high-confidence candidate matches for a Steam game', async () => {
      const game: CanonicalGame = {
        id: 'steam-1091500',
        title: 'Cyberpunk 2077',
        sortTitle: 'Cyberpunk 2077',
        steamAppId: 1091500,
        platforms: [{ platformId: 'steam', platformGameId: '1091500', installed: true }],
        headerImage: 'https://example.com/header.jpg',
        developers: ['CD PROJEKT RED'],
        publishers: ['CD PROJEKT RED'],
        genres: ['RPG'],
        tags: ['Open World'],
      };

      const candidates = await metadataScraperService.getSuggestedMatches(game);

      expect(candidates.length).toBeGreaterThanOrEqual(1);
      expect(candidates.length).toBeLessThanOrEqual(6);

      // Top candidate should match SteamAppId with high confidence
      const topMatch = candidates[0];
      expect(topMatch.source).toBe('steam');
      expect(topMatch.steamAppId).toBe(1091500);
      expect(topMatch.confidenceScore).toBe(100);
      expect(topMatch.capsuleImage).toContain('library_600x900_2x.jpg');
    });

    it('generates non-Steam candidates for GOG classics that do not exist on Steam', async () => {
      const game: CanonicalGame = {
        id: 'gog-1837805079',
        title: 'Blood Omen: Legacy of Kain',
        sortTitle: 'Blood Omen: Legacy of Kain',
        platforms: [{ platformId: 'gog', platformGameId: '1837805079', installed: true }],
        headerImage: 'https://example.com/kain.jpg',
        developers: ['Silicon Knights'],
        publishers: ['Square Enix'],
        genres: ['Action', 'Adventure'],
        tags: ['Vampire'],
      };

      const candidates = await metadataScraperService.getSuggestedMatches(game);

      expect(candidates.length).toBeGreaterThanOrEqual(1);
      const gogCandidate = candidates.find((c) => c.source === 'gog' || c.gogId === '1837805079');
      expect(gogCandidate).toBeDefined();
      expect(gogCandidate?.confidenceScore).toBeGreaterThanOrEqual(90);
    });

    it('respects nonSteamOnly flag by omitting Steam results', async () => {
      const game: CanonicalGame = {
        id: 'steam-292030',
        title: 'The Witcher 3: Wild Hunt',
        sortTitle: 'Witcher 3: Wild Hunt',
        steamAppId: 292030,
        platforms: [{ platformId: 'steam', platformGameId: '292030', installed: true }],
        headerImage: 'https://example.com/w3.jpg',
        developers: ['CD PROJEKT RED'],
        publishers: ['CD PROJEKT RED'],
        genres: ['RPG'],
        tags: ['Open World'],
      };

      const candidates = await metadataScraperService.getSuggestedMatches(
        game,
        undefined,
        'All',
        true // nonSteamOnly = true
      );

      // Verify no candidate is source 'steam'
      for (const cand of candidates) {
        expect(cand.source).not.toBe('steam');
      }
    });

    it('filters candidates by specific sourceTab', async () => {
      const game: CanonicalGame = {
        id: 'steam-292030',
        title: 'The Witcher 3: Wild Hunt',
        sortTitle: 'Witcher 3: Wild Hunt',
        steamAppId: 292030,
        platforms: [{ platformId: 'steam', platformGameId: '292030', installed: true }],
        headerImage: 'https://example.com/w3.jpg',
        developers: ['CD PROJEKT RED'],
        publishers: ['CD PROJEKT RED'],
        genres: ['RPG'],
        tags: ['Open World'],
      };

      const gogCandidates = await metadataScraperService.getSuggestedMatches(game, undefined, 'GOG');
      for (const cand of gogCandidates) {
        expect(cand.source).toBe('gog');
      }
    });
  });

  describe('searchStorefronts', () => {
    it('finds local GOG games in gogEnrichedCache.json', async () => {
      const results = await metadataScraperService.searchStorefronts('Hot Brass', 'gog');

      expect(results.length).toBeGreaterThan(0);
      const match = results.find((r) => r.title.toLowerCase().includes('hot brass'));
      expect(match).toBeDefined();
      expect(match?.source).toBe('gog');
      expect(match?.gogId).toBe('1075439258');
      expect(match?.capsuleImage).toBeTruthy();
    });

    it('finds local Epic games in EPIC_USER_LIBRARY and KNOWN_EPIC_APP_NAMES', async () => {
      const results = await metadataScraperService.searchStorefronts('World War Z', 'epic');

      expect(results.length).toBeGreaterThan(0);
      const match = results.find((r) => r.title.toLowerCase().includes('world war z'));
      expect(match).toBeDefined();
      expect(match?.source).toBe('epic');
    });

    it('handles purely numeric AppID query for Steam', async () => {
      const results = await metadataScraperService.searchStorefronts('1091500', 'steam');

      expect(results.length).toBeGreaterThan(0);
      const match = results.find((r) => r.steamAppId === 1091500);
      expect(match).toBeDefined();
      expect(match?.source).toBe('steam');
      expect(match?.capsuleImage).toContain('1091500');
    });

    it('returns empty array when query is empty', async () => {
      const results = await metadataScraperService.searchStorefronts('   ', 'all');
      expect(results).toEqual([]);
    });
  });

  describe('scrapeMatchDetails', () => {
    it('scrapes rich details and available covers for a Steam match', async () => {
      const candidate: SearchMatchCandidate = {
        id: 'steam-1091500',
        source: 'steam',
        title: 'Cyberpunk 2077',
        steamAppId: 1091500,
        capsuleImage: 'https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/1091500/library_600x900_2x.jpg',
      };

      const originalGame: CanonicalGame = {
        id: 'original-cyberpunk',
        title: 'Cyberpunk 2077',
        sortTitle: 'Cyberpunk 2077',
        platforms: [{ platformId: 'steam', platformGameId: '1091500', installed: true }],
        headerImage: 'https://example.com/old-header.jpg',
        capsuleImage: 'https://example.com/old-capsule.jpg',
        shortDescription: 'Original library synopsis for Cyberpunk.',
        developers: ['CD PROJEKT RED'],
        publishers: ['CD PROJEKT RED'],
        genres: ['RPG'],
        tags: ['Open World'],
      };

      const bundle = await metadataScraperService.scrapeMatchDetails(candidate, originalGame);

      expect(bundle.matchedStore).toBe('steam');
      expect(bundle.matchedId).toBe(1091500);
      expect(bundle.steamAppId).toBe(1091500);
      expect(bundle.title).toBe('Cyberpunk 2077');
      expect(bundle.availableCovers.length).toBeGreaterThanOrEqual(2);

      // Should include 600x900 portrait and capsule
      expect(bundle.availableCovers.some((c) => c.dimensions === '600x900')).toBe(true);
      expect(bundle.availableCovers.some((c) => c.source === 'original')).toBe(true);

      // Should include descriptions
      expect(bundle.availableDescriptions).toBeDefined();
      expect(bundle.availableDescriptions!.length).toBeGreaterThanOrEqual(1);
    });

    it('explicitly unlinks steamAppId (sets null) for non-Steam IGDB match', async () => {
      const candidate: SearchMatchCandidate = {
        id: 'igdb-12345',
        source: 'igdb',
        title: 'Blood Omen: Legacy of Kain',
        igdbId: 12345,
        year: 1996,
        capsuleImage: 'https://images.igdb.com/igdb/image/upload/t_cover_big/co2jds.jpg',
        description: 'Dark fantasy action adventure featuring Kain.',
      };

      const originalGame: CanonicalGame = {
        id: 'steam-999999', // Was falsely mapped to something
        title: 'Blood Omen',
        sortTitle: 'Blood Omen',
        steamAppId: 999999,
        platforms: [{ platformId: 'gog', platformGameId: '1837805079', installed: true }],
        headerImage: 'https://example.com/kain.jpg',
        capsuleImage: 'https://example.com/old-cover.jpg',
        developers: ['Silicon Knights'],
        publishers: ['Square Enix'],
        genres: ['Action'],
        tags: ['Dark Fantasy'],
      };

      const bundle = await metadataScraperService.scrapeMatchDetails(candidate, originalGame);

      expect(bundle.matchedStore).toBe('igdb');
      expect(bundle.matchedId).toBe(12345);
      expect(bundle.steamAppId).toBeNull(); // Must explicitly unlink from Steam
      expect(bundle.capsuleImage).toBe('https://images.igdb.com/igdb/image/upload/t_cover_big/co2jds.jpg');
      expect(bundle.availableCovers.some((c) => c.source === 'igdb')).toBe(true);
      expect(bundle.availableCovers.some((c) => c.source === 'original')).toBe(true);
      expect(bundle.shortDescription).toBe('Dark fantasy action adventure featuring Kain.');
      expect(bundle.releaseDate).toBe('1996');
    });

    it('scrapes GOG details and unlinks steamAppId for GOG match', async () => {
      const candidate: SearchMatchCandidate = {
        id: 'gog-1837805079',
        source: 'gog',
        title: 'Blood Omen: Legacy of Kain',
        gogId: '1837805079',
        year: 1996,
      };

      const bundle = await metadataScraperService.scrapeMatchDetails(candidate);

      expect(bundle.matchedStore).toBe('gog');
      expect(bundle.matchedId).toBe('1837805079');
      expect(bundle.steamAppId).toBeNull();
      expect(bundle.availableCovers.length).toBeGreaterThanOrEqual(1);
      expect(bundle.availableDescriptions?.length).toBeGreaterThanOrEqual(1);
    });

    it('scrapes Epic details and unlinks steamAppId for Epic match', async () => {
      const candidate: SearchMatchCandidate = {
        id: 'epic-alan-wake-2',
        source: 'epic',
        title: 'Alan Wake 2',
        year: 2023,
      };

      const bundle = await metadataScraperService.scrapeMatchDetails(candidate);

      expect(bundle.matchedStore).toBe('epic');
      expect(bundle.steamAppId).toBeNull();
      expect(bundle.title).toBe('Alan Wake 2');
    });

    it('handles unexpected candidate errors gracefully without throwing', async () => {
      const candidate: SearchMatchCandidate = {
        id: 'steam-999999999999',
        source: 'steam',
        title: 'Nonexistent Game ABCXYZ',
        steamAppId: 999999999999,
      };

      const bundle = await metadataScraperService.scrapeMatchDetails(candidate);
      expect(bundle).toBeDefined();
      expect(bundle.matchedStore).toBe('steam');
      expect(bundle.title).toBe('Nonexistent Game ABCXYZ');
    });
  });
});
