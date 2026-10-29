import { FixtureRequest, FixtureResponse } from './types';

interface OpenCriticGameFixture {
  id: number;
  name: string;
  slug: string;
  topCriticScore: number;
  percentRecommended: number;
  numReviews: number;
  firstReleaseDate: string;
}

const OPENCRITIC_GAMES: OpenCriticGameFixture[] = [
  {
    id: 13483,
    name: '20 Minutes Till Dawn',
    slug: '20-minutes-till-dawn',
    topCriticScore: 77,
    percentRecommended: 50,
    numReviews: 14,
    firstReleaseDate: '2023-06-08T00:00:00.000Z',
  },
  {
    id: 10450,
    name: 'Prodeus',
    slug: 'prodeus',
    topCriticScore: 82,
    percentRecommended: 85,
    numReviews: 34,
    firstReleaseDate: '2022-09-23T00:00:00.000Z',
  },
  {
    id: 7858,
    name: 'Control',
    slug: 'control',
    topCriticScore: 84,
    percentRecommended: 80,
    numReviews: 132,
    firstReleaseDate: '2019-08-27T00:00:00.000Z',
  },
  {
    id: 1968,
    name: 'Kingdom: Classic',
    slug: 'kingdom',
    topCriticScore: 74,
    percentRecommended: 62,
    numReviews: 18,
    firstReleaseDate: '2015-10-21T00:00:00.000Z',
  },
  {
    id: 15022,
    name: 'Alan Wake 2',
    slug: 'alan-wake-2',
    topCriticScore: 89,
    percentRecommended: 94,
    numReviews: 148,
    firstReleaseDate: '2023-10-27T00:00:00.000Z',
  },
  {
    id: 8525,
    name: 'Cyberpunk 2077',
    slug: 'cyberpunk-2077',
    topCriticScore: 76,
    percentRecommended: 78,
    numReviews: 212,
    firstReleaseDate: '2020-12-10T00:00:00.000Z',
  },
  {
    id: 4002,
    name: 'Hollow Knight',
    slug: 'hollow-knight',
    topCriticScore: 89,
    percentRecommended: 96,
    numReviews: 98,
    firstReleaseDate: '2017-02-24T00:00:00.000Z',
  },
  {
    id: 9876,
    name: 'Indie Hero Adventure',
    slug: 'indie-hero-adventure',
    topCriticScore: 86,
    percentRecommended: 90,
    numReviews: 22,
    firstReleaseDate: '2024-03-10T00:00:00.000Z',
  },
  {
    id: 4321,
    name: 'The Saboteur',
    slug: 'the-saboteur',
    topCriticScore: 82.4,
    percentRecommended: 80,
    numReviews: 40,
    firstReleaseDate: '2009-12-08T00:00:00.000Z',
  },
];

const BY_ID = new Map<number, OpenCriticGameFixture>(OPENCRITIC_GAMES.map((g) => [g.id, g]));

function norm(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

export function handleOpenCriticApi(req: FixtureRequest): FixtureResponse | null {
  if (req.url.pathname === '/api/game/search') {
    const criteria = norm(req.url.searchParams.get('criteria') || '');
    if (!criteria) {
      return { status: 200, headers: { 'content-type': 'application/json' }, body: [] };
    }
    const hits = OPENCRITIC_GAMES.filter((g) => {
      const gn = norm(g.name);
      return gn === criteria || (criteria.length >= 5 && gn.includes(criteria));
    }).map((g) => ({
      id: g.id,
      name: g.name,
      dist: norm(g.name) === criteria ? 0 : 0.12,
    }));
    return {
      status: 200,
      headers: { 'content-type': 'application/json' },
      body: hits,
    };
  }

  const detailMatch = req.url.pathname.match(/^\/api\/game\/(\d+)\/?$/);
  if (detailMatch) {
    const id = Number(detailMatch[1]);
    const game = BY_ID.get(id);
    if (!game) {
      return { status: 404, statusText: 'Not Found', headers: { 'content-type': 'application/json' }, body: { message: 'Not found' } };
    }
    return {
      status: 200,
      headers: { 'content-type': 'application/json' },
      body: {
        id: game.id,
        name: game.name,
        topCriticScore: game.topCriticScore,
        percentRecommended: game.percentRecommended,
        numReviews: game.numReviews,
        firstReleaseDate: game.firstReleaseDate,
        url: `https://opencritic.com/game/${game.id}/${game.slug}`,
      },
    };
  }

  return null;
}
