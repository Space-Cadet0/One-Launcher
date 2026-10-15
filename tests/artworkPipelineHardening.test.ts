import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { renderToString } from 'react-dom/server';
import axios from 'axios';
import { igdbCoverService, computeTokenSimilarity } from '../src/services/igdb/igdbCoverService';
import { requestScheduler, Priority } from '../src/services/network/requestScheduler';
import { steamApi } from '../src/services/steam/steamApi';
import { GameCardCover, getCoverCandidates } from '../src/components/Library/LibraryGridView';
import { CanonicalGame } from '../src/contracts/game';

describe('Phase 3A: Artwork & Media Pipeline Hardening', () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    igdbCoverService.clearCache();
    requestScheduler.reset();
    requestScheduler.setEnforceDelays(false);
  });

  afterEach(() => {
    global.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  describe('igdbCoverService sequel protection, year disambiguation, and scheduler integration', () => {
    it('enforces sequel and title compatibility guards in computeTokenSimilarity', () => {
      expect(computeTokenSimilarity('Doom', 'Doom II')).toBe(0);
      expect(computeTokenSimilarity('Doom', 'Doom 3')).toBe(0);
      expect(computeTokenSimilarity('Quake', 'Quake II')).toBe(0);
      expect(computeTokenSimilarity('Kingdom: Classic', 'Kingdom Come: Deliverance')).toBe(0);
      expect(computeTokenSimilarity('Prey', 'Prey')).toBeGreaterThanOrEqual(0.92);
    });

    it('rejects sequel covers (Doom II / Doom 3) when searching for original Doom', async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          results: [
            {
              name: 'Doom II',
              year: 1994,
              coverart: 'https://images.igdb.com/igdb/image/upload/t_cover_big/co_doom2.jpg',
            },
            {
              name: 'Doom 3',
              year: 2004,
              coverart: 'https://images.igdb.com/igdb/image/upload/t_cover_big/co_doom3.jpg',
            },
          ],
        }),
      } as any);

      const cover = await igdbCoverService.fetchIgdbCover('Doom');
      expect(cover).toBeNull();
    });

    it('disambiguates covers by releaseYear (Prey 2006 vs Prey 2017) and rejects distant reboots', async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          results: [
            {
              name: 'Prey',
              year: 2017,
              coverart: 'https://images.igdb.com/igdb/image/upload/t_cover_big/co_prey2017.jpg',
            },
            {
              name: 'Prey',
              year: 2006,
              coverart: 'https://images.igdb.com/igdb/image/upload/t_cover_big/co_prey2006.jpg',
            },
          ],
        }),
      } as any);

      const cover2006 = await igdbCoverService.fetchIgdbCover('Prey', 2006);
      expect(cover2006).toBe('https://images.igdb.com/igdb/image/upload/t_cover_big/co_prey2006.jpg');

      const cover2017 = await igdbCoverService.fetchIgdbCover('Prey', 2017);
      expect(cover2017).toBe('https://images.igdb.com/igdb/image/upload/t_cover_big/co_prey2017.jpg');

      // Verify a 1993 title rejects a 2016 reboot cover when only the 2016 reboot is returned
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          results: [
            {
              name: 'Doom',
              year: 2016,
              coverart: 'https://images.igdb.com/igdb/image/upload/t_cover_big/co_doom2016.jpg',
            },
          ],
        }),
      } as any);

      const doom1993 = await igdbCoverService.fetchIgdbCover('Doom', 1993);
      expect(doom1993).toBeNull();
    });

    it('routes Lutris cover lookups through requestScheduler with P2_BACKGROUND priority', async () => {
      const scheduleSpy = vi.spyOn(requestScheduler, 'schedule');
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          results: [
            {
              name: 'Uncharted Waters',
              year: 1991,
              coverart: 'https://images.igdb.com/igdb/image/upload/t_cover_big/co_uw1.jpg',
            },
          ],
        }),
      } as any);

      const cover = await igdbCoverService.fetchIgdbCover('Uncharted Waters', 1991);
      expect(cover).toBe('https://images.igdb.com/igdb/image/upload/t_cover_big/co_uw1.jpg');
      expect(scheduleSpy).toHaveBeenCalledTimes(1);
      expect(scheduleSpy.mock.calls[0][2]).toBe(Priority.P2_BACKGROUND);
      expect(scheduleSpy.mock.calls[0][3]).toBe('lutris.net');
    });
  });

  describe('steamApi capsuleImage fallback extraction', () => {
    it('extracts library_capsule or capsule_imagev5 from Steam appdetails payload', async () => {
      const testAppId = 9999991;
      vi.spyOn(axios, 'get').mockImplementation(async (url: string) => {
        if (url.includes('appdetails')) {
          return {
            data: {
              [testAppId]: {
                success: true,
                data: {
                  name: 'Hashed Capsule Test Game',
                  short_description: 'Test description',
                  header_image: 'https://shared.fastly.steamstatic.com/store_item_assets/steam/apps/9999991/header.jpg',
                  capsule_imagev5:
                    'https://shared.fastly.steamstatic.com/store_item_assets/steam/apps/9999991/hash123/capsule_184x69.jpg',
                  library_capsule:
                    'https://shared.fastly.steamstatic.com/store_item_assets/steam/apps/9999991/hash123/library_capsule.jpg',
                },
              },
            },
          };
        }
        return { data: {} };
      });

      const meta = await steamApi.fetchGameMetadata(testAppId);
      expect(meta).not.toBeNull();
      expect(meta?.capsuleImage).toBe(
        'https://shared.fastly.steamstatic.com/store_item_assets/steam/apps/9999991/hash123/library_capsule.jpg'
      );
    });
  });

  describe('GameCardCover 2:3 blurred-backdrop letterboxed fallback & match review badge', () => {
    const baseUnmatchedGame: CanonicalGame = {
      id: 'epic-custom-unmatched',
      title: 'Mystery Horizon',
      sortTitle: 'Mystery Horizon',
      isExplicitNonSteam: true,
      platforms: [{ platformId: 'epic', platformGameId: 'mystery-horizon', installed: false }],
      headerImage: 'https://cdn.example.com/mystery-horizon-header.jpg',
      capsuleImage: undefined,
      developers: ['Studio X'],
      publishers: ['Studio X'],
      genres: ['Action'],
      tags: [],
    };

    it('renders 2:3 blurred-backdrop letterboxed card when vertical cover candidates are absent but headerImage is valid', () => {
      const html = renderToString(
        React.createElement(GameCardCover, {
          game: baseUnmatchedGame,
        })
      );

      expect(html).toContain('grid-cover-fallback');
      expect(html).toContain('blur-md');
      expect(html).toContain('aspect-[460/215]');
      expect(html).toContain('https://cdn.example.com/mystery-horizon-header.jpg');
      expect(html).toContain('Mystery Horizon');
    });

    it('falls back to Gamepad2 icon when headerImage is missing or a default placeholder', () => {
      const noHeaderGame: CanonicalGame = {
        ...baseUnmatchedGame,
        id: 'epic-no-header',
        headerImage: 'https://cdn.example.com/avatars/default.png',
      };

      const html = renderToString(
        React.createElement(GameCardCover, {
          game: noHeaderGame,
        })
      );

      expect(html).toContain('grid-cover-fallback');
      expect(html).not.toContain('aspect-[460/215]');
      expect(html).toContain('<svg');
    });

    it('renders low-confidence match review badge when needsMatchReview is true and no userOverride exists', () => {
      const lowConfidenceGame: CanonicalGame = {
        ...baseUnmatchedGame,
        needsMatchReview: true,
      };

      const htmlWithBadge = renderToString(
        React.createElement(GameCardCover, {
          game: lowConfidenceGame,
          userOverride: null,
        })
      );
      expect(htmlWithBadge).toContain('Low-confidence automatic match — click Fix Match to verify');

      const htmlWithOverride = renderToString(
        React.createElement(GameCardCover, {
          game: lowConfidenceGame,
          userOverride: {
            gameId: lowConfidenceGame.id,
            title: lowConfidenceGame.title,
            updatedAt: new Date().toISOString(),
          },
        })
      );
      expect(htmlWithOverride).not.toContain('Low-confidence automatic match — click Fix Match to verify');
    });

    it('prefers confirmed Steam 600x900 portrait cover over storefront and IGDB covers for non-Steam games', () => {
      const gogGameWithSteamMatch: CanonicalGame = {
        id: 'gog-12345',
        title: 'Control Ultimate Edition',
        sortTitle: 'Control Ultimate Edition',
        steamAppId: 870780,
        platforms: [{ platformId: 'gog', platformGameId: '12345', installed: false }],
        capsuleImage: 'https://images.gog-statics.com/77873a93caeab4889e3f032f58687f25f9c6277d0e71182127812f21ac62e005.jpg',
        developers: ['Remedy Entertainment'],
        publishers: ['505 Games'],
        genres: ['Action'],
        tags: [],
      };

      const candidates = getCoverCandidates(
        gogGameWithSteamMatch,
        'https://images.igdb.com/igdb/image/upload/t_cover_big/co_control.jpg',
        null
      );

      expect(candidates[0]).toBe(
        'https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/870780/library_600x900_2x.jpg'
      );
      expect(candidates[1]).toBe(
        'https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/870780/library_600x900.jpg'
      );
      expect(candidates[2]).toBe(
        'https://images.gog-statics.com/77873a93caeab4889e3f032f58687f25f9c6277d0e71182127812f21ac62e005.jpg'
      );
      expect(candidates[3]).toBe('https://images.igdb.com/igdb/image/upload/t_cover_big/co_control.jpg');
    });

    it('rejects GOG server-cropped horizontal covers (_glx_vertical_cover or shared horizontal hash)', () => {
      const gogGameWithCroppedHorizontal: CanonicalGame = {
        id: 'gog-1436499377',
        title: 'TOEM',
        sortTitle: 'TOEM',
        isExplicitNonSteam: true,
        platforms: [{ platformId: 'gog', platformGameId: '1436499377', installed: false }],
        headerImage:
          'https://images.gog-statics.com/ec2493f50e8945e04ccf2f5708fced7bd38606cc47bc68ced58d410fff21b120.jpg',
        capsuleImage:
          'https://images.gog-statics.com/ec2493f50e8945e04ccf2f5708fced7bd38606cc47bc68ced58d410fff21b120_glx_vertical_cover.jpg',
        developers: ['Something We Made'],
        publishers: ['Something We Made'],
        genres: ['Adventure'],
        tags: [],
      };

      const candidates = getCoverCandidates(gogGameWithCroppedHorizontal, undefined, null);
      expect(candidates).toHaveLength(0);
    });
  });
});
