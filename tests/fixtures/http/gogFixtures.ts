import { FixtureRequest, FixtureResponse } from './types';

interface GogProductFixture {
  id: string;
  slug: string;
  title: string;
  reviewsRating: number; // Out of 50 (e.g. 41 = 4.1 stars -> 82/100)
  reviewsCount: number;
  releaseDate: string;
  developers: string[];
  publishers: string[];
  genres: Array<{ name: string; slug: string }>;
  openCriticScore?: number;
  openCriticId?: number;
  openCriticSlug?: string;
}

const GOG_PRODUCTS: GogProductFixture[] = [
  {
    id: '1837805079',
    slug: 'blood_omen_legacy_of_kain',
    title: 'Blood Omen: Legacy of Kain',
    reviewsRating: 45,
    reviewsCount: 640,
    releaseDate: '1996.11.15',
    developers: ['Silicon Knights'],
    publishers: ['Square Enix'],
    genres: [{ name: 'Action', slug: 'action' }, { name: 'Adventure', slug: 'adventure' }],
  },
  {
    id: '1453375253',
    slug: 'stardew_valley',
    title: 'Stardew Valley',
    reviewsRating: 48,
    reviewsCount: 3450,
    releaseDate: '2016.02.26',
    developers: ['ConcernedApe'],
    publishers: ['ConcernedApe'],
    genres: [{ name: 'Simulation', slug: 'simulation' }, { name: 'Role-playing', slug: 'rpg' }],
  },
  {
    id: '1500000101',
    slug: 'subnautica',
    title: 'Subnautica',
    reviewsRating: 41,
    reviewsCount: 1312,
    releaseDate: '2018.01.23',
    developers: ['Unknown Worlds Entertainment'],
    publishers: ['Unknown Worlds Entertainment'],
    genres: [{ name: 'Adventure', slug: 'adventure' }],
  },
  {
    id: '1207665503',
    slug: 'terraria',
    title: 'Terraria',
    reviewsRating: 41,
    reviewsCount: 2410,
    releaseDate: '2011.05.16',
    developers: ['Re-Logic'],
    publishers: ['Re-Logic'],
    genres: [{ name: 'Adventure', slug: 'adventure' }],
  },
  {
    id: '1159093496',
    slug: 'celeste',
    title: 'Celeste',
    reviewsRating: 33,
    reviewsCount: 1280,
    releaseDate: '2018.01.25',
    developers: ['Maddy Makes Games'],
    publishers: ['Maddy Makes Games'],
    genres: [{ name: 'Action', slug: 'action' }],
  },
  {
    id: '1490000001',
    slug: 'fallout_london',
    title: 'Fallout: London',
    reviewsRating: 42,
    reviewsCount: 1850,
    releaseDate: '2024.07.25',
    developers: ['Team FOLON'],
    publishers: ['Team FOLON'],
    genres: [{ name: 'Role-playing', slug: 'rpg' }],
  },
  {
    id: '1207660111',
    slug: 'akalabeth_world_of_doom',
    title: 'Akalabeth: World of Doom',
    reviewsRating: 34,
    reviewsCount: 195,
    releaseDate: '1979.12.01',
    developers: ['Richard Garriott'],
    publishers: ['Origin Systems'],
    genres: [{ name: 'Role-playing', slug: 'rpg' }],
  },
  {
    id: '1580000002',
    slug: 'prodeus',
    title: 'Prodeus',
    reviewsRating: 44,
    reviewsCount: 215,
    releaseDate: '2022.09.23',
    developers: ['Bounding Box Software'],
    publishers: ['Humble Games'],
    genres: [{ name: 'Shooter', slug: 'shooter' }],
    openCriticScore: 82,
    openCriticId: 10450,
    openCriticSlug: 'prodeus',
  },
  {
    id: '1308320804',
    slug: 'hollow_knight',
    title: 'Hollow Knight',
    reviewsRating: 48,
    reviewsCount: 4120,
    releaseDate: '2017.02.24',
    developers: ['Team Cherry'],
    publishers: ['Team Cherry'],
    genres: [{ name: 'Action', slug: 'action' }],
    openCriticScore: 89,
    openCriticId: 4002,
    openCriticSlug: 'hollow-knight',
  },
  {
    id: '1207664643',
    slug: 'the_witcher_3_wild_hunt',
    title: 'The Witcher 3: Wild Hunt',
    reviewsRating: 49,
    reviewsCount: 28500,
    releaseDate: '2015.05.19',
    developers: ['CD PROJEKT RED'],
    publishers: ['CD PROJEKT RED'],
    genres: [{ name: 'Role-playing', slug: 'rpg' }],
  },
  {
    id: '1423049311',
    slug: 'cyberpunk_2077',
    title: 'Cyberpunk 2077',
    reviewsRating: 41,
    reviewsCount: 8940,
    releaseDate: '2020.12.10',
    developers: ['CD PROJEKT RED'],
    publishers: ['CD PROJEKT RED'],
    genres: [{ name: 'Role-playing', slug: 'rpg' }],
  },
  {
    id: '1458058109',
    slug: 'the_saboteur',
    title: 'The Saboteur',
    reviewsRating: 43,
    reviewsCount: 920,
    releaseDate: '2009.12.08',
    developers: ['Pandemic Studios'],
    publishers: ['Electronic Arts'],
    genres: [{ name: 'Action', slug: 'action' }],
  },
];

const BY_ID = new Map<string, GogProductFixture>(GOG_PRODUCTS.map((p) => [p.id, p]));
const BY_SLUG = new Map<string, GogProductFixture>(GOG_PRODUCTS.map((p) => [p.slug, p]));

function norm(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

export function handleGogEndpoints(req: FixtureRequest): FixtureResponse | null {
  const host = req.url.hostname.toLowerCase();

  if (host === 'catalog.gog.com' && req.url.pathname === '/v1/catalog') {
    const q = norm(req.url.searchParams.get('query') || '');
    const products = !q
      ? []
      : GOG_PRODUCTS.filter((p) => {
          const pn = norm(p.title);
          return pn === q || (q.length >= 4 && (pn.includes(q) || q.includes(pn)));
        }).map((p) => ({
          id: p.id,
          slug: p.slug,
          title: p.title,
          reviewsRating: p.reviewsRating,
          reviewsCount: p.reviewsCount,
          releaseDate: p.releaseDate,
          developers: p.developers,
          publishers: p.publishers,
          genres: p.genres,
          coverVertical: `https://images.gog.com/${p.slug}_vertical.jpg`,
          coverHorizontal: `https://images.gog.com/${p.slug}_horizontal.jpg`,
          screenshots: [`https://images.gog.com/${p.slug}_ss_1.jpg`],
          storeLink: `https://www.gog.com/en/game/${p.slug}`,
        }));
    return {
      status: 200,
      headers: { 'content-type': 'application/json' },
      body: { pages: 1, productCount: products.length, products },
    };
  }

  if (host === 'api.gog.com') {
    const prodMatch = req.url.pathname.match(/^\/products\/(\d+)\/?$/);
    if (prodMatch) {
      const p = BY_ID.get(prodMatch[1]);
      if (!p) {
        return { status: 404, statusText: 'Not Found', headers: { 'content-type': 'application/json' }, body: {} };
      }
      return {
        status: 200,
        headers: { 'content-type': 'application/json' },
        body: {
          id: Number(p.id),
          title: p.title,
          slug: p.slug,
          release_date: p.releaseDate.replace(/\./g, '-'),
          images: {
            background: `//images.gog.com/${p.slug}_bg.jpg`,
            logo2x: `//images.gog.com/${p.slug}_vertical.jpg`,
            icon: `//images.gog.com/${p.slug}_icon.jpg`,
          },
          description: {
            lead: `${p.title} DRM-Free edition on GOG.com.`,
            full: `<p>${p.title} full description from GOG API.</p>`,
          },
          screenshots: [{ formatted_images: [{ formatter_name: 'ggvgl_2x', image_url: `https://images.gog.com/${p.slug}_ss_1.jpg` }] }],
          videos: [],
        },
      };
    }

    const v2Match = req.url.pathname.match(/^\/v2\/games\/(\d+)\/?$/);
    if (v2Match) {
      const p = BY_ID.get(v2Match[1]);
      if (!p) {
        return { status: 404, statusText: 'Not Found', headers: { 'content-type': 'application/json' }, body: {} };
      }
      return {
        status: 200,
        headers: { 'content-type': 'application/json' },
        body: {
          _embedded: {
            product: {
              id: p.id,
              title: p.title,
              _links: {
                boxArtImage: { href: `https://images.gog.com/${p.slug}_boxart_600x900.jpg` },
                galaxyBackgroundImage: { href: `https://images.gog.com/${p.slug}_galaxy_bg.jpg` },
              },
            },
            developers: p.developers.map((name) => ({ name })),
            publisher: { name: p.publishers[0] || 'Publisher' },
            tags: p.genres.map((g) => ({ name: g.name })),
          },
          description: `<p>${p.title} detailed GOG v2 synopsis.</p>`,
        },
      };
    }
  }

  if (host === 'www.gog.com') {
    const gameMatch = req.url.pathname.match(/^\/(?:en\/)?game\/([a-z0-9_-]+)\/?$/i);
    if (gameMatch) {
      const p = BY_SLUG.get(gameMatch[1].toLowerCase());
      if (!p) {
        return { status: 404, statusText: 'Not Found', headers: { 'content-type': 'text/html' }, body: '<html><body>404</body></html>' };
      }
      const ocHtml = p.openCriticScore
        ? `<div class="critics-rating"><div class="circle-score"><span class="circle-score__text">${p.openCriticScore}</span></div><span class="critics-rating__label">Top Critic Average</span><a href="https://opencritic.com/game/${p.openCriticId}/${p.openCriticSlug}">OpenCritic</a></div>`
        : '';
      return {
        status: 200,
        headers: { 'content-type': 'text/html; charset=utf-8' },
        body: `<!DOCTYPE html><html><body><h1>${p.title}</h1>${ocHtml}</body></html>`,
      };
    }
  }

  if (host === 'auth.gog.com' && req.url.pathname === '/token') {
    const refreshToken = req.url.searchParams.get('refresh_token') || '';
    if (refreshToken.startsWith('mock-')) {
      return {
        status: 400,
        statusText: 'Bad Request',
        headers: { 'content-type': 'application/json' },
        body: { error: 'invalid_grant', error_description: 'Synthetic mock refresh token is not exchangeable' },
      };
    }
    return {
      status: 200,
      headers: { 'content-type': 'application/json' },
      body: {
        access_token: 'synthetic-gog-access-token',
        refresh_token: refreshToken || 'synthetic-gog-refresh-token',
        expires_in: 3600,
        user_id: '4815162342',
      },
    };
  }

  if (host === 'gameplay.gog.com' && /^\/clients\/[^/]+\/users\/[^/]+\/sessions\/?$/.test(req.url.pathname)) {
    return {
      status: 200,
      headers: { 'content-type': 'application/json' },
      body: { status: 'recorded' },
    };
  }

  return null;
}
