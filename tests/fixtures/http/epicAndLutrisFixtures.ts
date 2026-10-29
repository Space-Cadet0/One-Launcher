import { FixtureRequest, FixtureResponse } from './types';

interface EpicReviewFixture {
  sku: string;
  id: number;
  name: string;
  openCriticScore: number;
  reviewCount: number;
  percentRecommended: number;
  openCriticUrl: string;
}

const EPIC_REVIEWS: Record<string, EpicReviewFixture> = {
  control: {
    sku: 'control',
    id: 7858,
    name: 'Control',
    openCriticScore: 84,
    reviewCount: 132,
    percentRecommended: 87,
    openCriticUrl: 'https://opencritic.com/game/7858/control',
  },
  epic_control: {
    sku: 'EPIC_control',
    id: 7858,
    name: 'Control',
    openCriticScore: 84,
    reviewCount: 132,
    percentRecommended: 87,
    openCriticUrl: 'https://opencritic.com/game/7858/control',
  },
  'alan-wake-2': {
    sku: 'alan-wake-2',
    id: 15022,
    name: 'Alan Wake 2',
    openCriticScore: 89,
    reviewCount: 148,
    percentRecommended: 94,
    openCriticUrl: 'https://opencritic.com/game/15022/alan-wake-2',
  },
  'epic_alan-wake-2': {
    sku: 'EPIC_alan-wake-2',
    id: 15022,
    name: 'Alan Wake 2',
    openCriticScore: 89,
    reviewCount: 148,
    percentRecommended: 94,
    openCriticUrl: 'https://opencritic.com/game/15022/alan-wake-2',
  },
};

interface LutrisGameFixture {
  id: number;
  name: string;
  slug: string;
  year: number;
  coverart: string;
  banner_url: string;
}

const LUTRIS_GAMES: LutrisGameFixture[] = [
  {
    id: 1001,
    name: 'Cyberpunk 2077',
    slug: 'cyberpunk-2077',
    year: 2020,
    coverart: 'https://images.igdb.com/igdb/image/upload/t_cover_big/co4hk8.jpg',
    banner_url: 'https://images.igdb.com/igdb/image/upload/t_screenshot_med/sc8abc.jpg',
  },
  {
    id: 12345,
    name: 'Blood Omen: Legacy of Kain',
    slug: 'blood-omen-legacy-of-kain',
    year: 1996,
    coverart: 'https://images.igdb.com/igdb/image/upload/t_cover_big/co2jds.jpg',
    banner_url: 'https://images.igdb.com/igdb/image/upload/t_screenshot_med/sc2jds.jpg',
  },
  {
    id: 1003,
    name: 'The Witcher 3: Wild Hunt',
    slug: 'the-witcher-3-wild-hunt',
    year: 2015,
    coverart: 'https://images.igdb.com/igdb/image/upload/t_cover_big/co1wyy.jpg',
    banner_url: 'https://images.igdb.com/igdb/image/upload/t_screenshot_med/sc1wyy.jpg',
  },
  {
    id: 1004,
    name: 'Age of Empires II: Definitive Edition',
    slug: 'age-of-empires-ii-definitive-edition',
    year: 2019,
    coverart: 'https://images.igdb.com/igdb/image/upload/t_cover_big/co1x7d.jpg',
    banner_url: 'https://images.igdb.com/igdb/image/upload/t_screenshot_med/sc1x7d.jpg',
  },
  {
    id: 1005,
    name: 'The Saboteur',
    slug: 'the-saboteur',
    year: 2009,
    coverart: 'https://images.igdb.com/igdb/image/upload/t_cover_big/co2sab.jpg',
    banner_url: 'https://images.igdb.com/igdb/image/upload/t_screenshot_med/sc2sab.jpg',
  },
];

function norm(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

export function handleEpicAndLutrisEndpoints(req: FixtureRequest): FixtureResponse | null {
  const host = req.url.hostname.toLowerCase();

  if (host === 'launcher.store.epicgames.com' && req.url.pathname === '/graphql') {
    let sku = '';
    if (req.body) {
      try {
        const parsed = JSON.parse(req.body);
        sku = String(parsed?.variables?.sku || '').toLowerCase();
      } catch {}
    }
    const rev = EPIC_REVIEWS[sku] || null;
    return {
      status: 200,
      headers: { 'content-type': 'application/json' },
      body: {
        data: {
          OpenCritic: {
            productReviews: rev
              ? {
                  id: rev.id,
                  name: rev.name,
                  openCriticScore: rev.openCriticScore,
                  reviewCount: rev.reviewCount,
                  percentRecommended: rev.percentRecommended,
                  openCriticUrl: rev.openCriticUrl,
                  award: rev.openCriticScore >= 84 ? 'Mighty' : 'Strong',
                }
              : null,
          },
          PlayerProfile: {
            playerProfile: {
              achievementsSummaries: { data: [] },
            },
          },
        },
      },
    };
  }

  if (host === 'store-content.ak.epicgames.com') {
    const m = req.url.pathname.match(/^\/api\/[a-zA-Z-]+\/content\/products\/([a-z0-9_-]+)\/?$/i);
    if (m) {
      const slug = m[1].toLowerCase();
      const rev = EPIC_REVIEWS[slug];
      if (!rev) {
        return { status: 404, statusText: 'Not Found', headers: { 'content-type': 'application/json' }, body: { error: 'Not Found' } };
      }
      return {
        status: 200,
        headers: { 'content-type': 'application/json' },
        body: {
          productName: rev.name,
          pages: [
            {
              data: {
                about: {
                  title: rev.name,
                  shortDescription: `${rev.name} on Epic Games Store.`,
                  description: `${rev.name} full Epic Games Store product description.`,
                  developerAttribution: 'Remedy Entertainment',
                  publisherAttribution: 'Epic Games Publishing',
                },
              },
            },
          ],
        },
      };
    }
  }

  if (host === 'account-public-service-prod03.ol.epicgames.com' && req.url.pathname === '/account/api/oauth/token') {
    return {
      status: 200,
      headers: { 'content-type': 'application/json' },
      body: {
        access_token: 'synthetic-epic-access-token',
        refresh_token: 'synthetic-epic-refresh-token',
        expires_in: 7200,
        account_id: 'a1b2c3d4e5f60718293a4b5c6d7e8f90',
      },
    };
  }

  if (host === 'lutris.net' && req.url.pathname === '/api/games') {
    const q = norm(req.url.searchParams.get('search') || '');
    const results = !q
      ? []
      : LUTRIS_GAMES.filter((g) => {
          const gn = norm(g.name);
          return gn === q || (q.length >= 4 && (gn.includes(q) || q.includes(gn)));
        });
    return {
      status: 200,
      headers: { 'content-type': 'application/json' },
      body: { count: results.length, next: null, previous: null, results },
    };
  }

  return null;
}
