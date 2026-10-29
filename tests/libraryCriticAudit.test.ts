import { describe, it, expect } from 'vitest';
import { CanonicalGame } from '../src/contracts/game';
import { sanitizeGameCatalog } from '../src/services/integrations/catalogSanitizer';
import { mergeStorefrontGames } from '../src/services/integrations/integrationStorage';
import {
  getOpenCriticData,
  criticScoreService,
  normalizeCriticTitleKey,
  KNOWN_UNRATED_TITLES,
} from '../src/services/critic/criticScoreService';
import { steamMatcher } from '../src/services/steam/steamMatcher';
import { isSequelMismatch } from '../src/services/critic/criticUtils';

describe('1-by-1 Full Library 6-Tier Critic, User & Storefront Score Audit', () => {
  it('audits multi-storefront games across 6 distinct tiers and verifies regression targets', async () => {
    criticScoreService.purgeAllScoreCache();

    const steamFixture: CanonicalGame[] = [
      {
        id: 'steam-2417610',
        title: 'METAL GEAR SOLID Δ: SNAKE EATER',
        sortTitle: 'METAL GEAR SOLID Δ: SNAKE EATER',
        steamAppId: 2417610,
        isVerifiedEntitlement: true,
        platforms: [{ platformId: 'steam', platformGameId: '2417610', installed: false }],
        headerImage: '',
        developers: ['KONAMI'],
        publishers: ['KONAMI'],
        genres: ['Action'],
        tags: [],
      },
      {
        id: 'steam-287390',
        title: 'Metro Last Light Redux',
        sortTitle: 'Metro Last Light Redux',
        steamAppId: 287390,
        isVerifiedEntitlement: true,
        platforms: [{ platformId: 'steam', platformGameId: '287390', installed: false }],
        headerImage: '',
        developers: ['4A Games'],
        publishers: ['Deep Silver'],
        genres: ['Action'],
        tags: [],
      },
      {
        id: 'steam-368230',
        title: 'Kingdom: Classic',
        sortTitle: 'Kingdom: Classic',
        steamAppId: 368230,
        isVerifiedEntitlement: true,
        platforms: [{ platformId: 'steam', platformGameId: '368230', installed: false }],
        headerImage: '',
        developers: ['Noio'],
        publishers: ['Raw Fury'],
        genres: ['Strategy'],
        tags: [],
      },
      {
        id: 'steam-728880',
        title: 'Overcooked! 2',
        sortTitle: 'Overcooked! 2',
        steamAppId: 728880,
        isVerifiedEntitlement: true,
        platforms: [{ platformId: 'steam', platformGameId: '728880', installed: false }],
        headerImage: '',
        developers: ['Ghost Town Games'],
        publishers: ['Team17'],
        genres: ['Action'],
        tags: [],
      },
    ];

    const gogFixture: CanonicalGame[] = [
      {
        id: 'gog-celeste',
        title: 'Celeste',
        sortTitle: 'Celeste',
        isVerifiedEntitlement: true,
        platforms: [{ platformId: 'gog', platformGameId: '1159093496', installed: false }],
        headerImage: '',
        developers: ['Maddy Makes Games'],
        publishers: ['Maddy Makes Games'],
        genres: ['Action'],
        tags: [],
      },
    ];

    const epicFixture: CanonicalGame[] = [
      {
        id: 'epic-factorio',
        title: 'Factorio',
        sortTitle: 'Factorio',
        isVerifiedEntitlement: true,
        platforms: [{ platformId: 'epic', platformGameId: 'factorio', installed: false }],
        headerImage: '',
        developers: ['Wube Software'],
        publishers: ['Wube Software'],
        genres: ['Strategy'],
        tags: [],
      },
    ];

    let catalog = sanitizeGameCatalog(steamFixture);
    catalog = mergeStorefrontGames(catalog, gogFixture, 'gog');
    catalog = mergeStorefrontGames(catalog, epicFixture, 'epic');

    expect(catalog).toHaveLength(6);

    await Promise.all(
      catalog.map(async (g) => {
        const targetSteamId = g.steamAppId || steamMatcher.matchGameToSteamInstant(g.title);
        await criticScoreService.resolveDynamicScore(g.title, targetSteamId);
      })
    );

    interface AuditRow {
      index: number;
      title: string;
      platforms: string;
      score: number | string;
      rawScore?: number;
      starRatingRaw?: number;
      tier: string;
      source: string;
      numReviews?: number;
      isVerified: boolean;
      url: string;
    }

    const tier1MetacriticRows: AuditRow[] = [];
    const allRows: AuditRow[] = [];

    catalog.forEach((game, idx) => {
      const targetSteamId = game.steamAppId || steamMatcher.matchGameToSteamInstant(game.title);
      let scoreData = getOpenCriticData(
        targetSteamId,
        game.title,
        targetSteamId ? game.reviewSummary?.positivePercent : undefined
      );

      const platforms = game.platforms.map((p) => p.platformId.toUpperCase()).join(', ');
      const lowerTitle = game.title.toLowerCase().trim();
      const normTitle = normalizeCriticTitleKey(game.title);
      const isExplicitlyUnrated =
        KNOWN_UNRATED_TITLES.has(lowerTitle) ||
        (Boolean(normTitle) && KNOWN_UNRATED_TITLES.has(normTitle)) ||
        /\b(public testing|tech beta|playtest|digital goodies|pre-game editor|resource archiver|playable teaser)\b/i.test(game.title);

      if (isExplicitlyUnrated && (!scoreData || !scoreData.isSynthetic || !game.steamAppId)) {
        scoreData = null;
      }

      if (scoreData && scoreData.score > 0) {
        const row: AuditRow = {
          index: idx + 1,
          title: game.title,
          platforms,
          score: scoreData.score,
          rawScore: scoreData.userScoreRaw,
          starRatingRaw: scoreData.starRatingRaw,
          tier: scoreData.tier,
          source: scoreData.source,
          numReviews: scoreData.numReviews,
          isVerified: scoreData.isVerified,
          url: scoreData.url,
        };
        allRows.push(row);
        if (scoreData.source === 'metacritic') {
          tier1MetacriticRows.push(row);
        }
      }
    });

    // Regressions check: Verify specific reported games link to the exact right pages
    const mgsDeltaRow = allRows.find((r) => r.title.includes('SNAKE EATER') || r.title.includes('Snake Eater'));
    expect(mgsDeltaRow?.url).toBe('https://www.metacritic.com/game/metal-gear-solid-delta-snake-eater/critic-reviews/');
    expect(mgsDeltaRow?.score).toBe(85);

    const metroLLRow = allRows.find((r) => r.title === 'Metro Last Light Redux');
    expect(metroLLRow?.url).toBe('https://www.metacritic.com/game/metro-last-light-redux/critic-reviews/');
    expect(metroLLRow?.score).toBe(76);

    const kingdomClassicRow = allRows.find((r) => r.title === 'Kingdom: Classic' || r.title === 'Kingdom Classic');
    expect(kingdomClassicRow?.url).toMatch(/metacritic\.com\/game\/kingdom(?:-2015)?\/|opencritic\.com\/game\/1968\/kingdom/);
    expect(kingdomClassicRow?.score).toBe(74);

    const overcooked2Row = allRows.find((r) => r.title === 'Overcooked! 2');
    expect(overcooked2Row?.url).toBe('https://www.metacritic.com/game/overcooked-2/critic-reviews/');
    expect(overcooked2Row?.score).toBe(81);

    // Zero sequel mismatches across Metacritic URLs
    const invalidSequelRows = tier1MetacriticRows.filter((r) => {
      const slugMatch = r.url.match(/\/game\/(?:[0-9]+\/)?([^\/]+)/);
      const slug = slugMatch ? slugMatch[1] : '';
      const slugTitle = slug.replace(/-\d{4}$/, '').replace(/-/g, ' ');
      if (/\b(remastered|remake|definitive|anniversary)\b/i.test(r.title)) return false;
      return isSequelMismatch(r.title, slugTitle);
    });
    expect(invalidSequelRows).toHaveLength(0);
  }, 60000);
});
