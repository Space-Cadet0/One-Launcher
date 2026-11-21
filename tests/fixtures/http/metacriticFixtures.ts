import { FixtureRequest, FixtureResponse } from './types';

interface MetacriticGameFixture {
  slug: string;
  name: string;
  year: number;
  releaseDate?: string;
  criticScore?: number | null;
  criticCount?: number;
  pcCriticScore?: number | null;
  pcCriticCount?: number;
  userScore?: number | null;
  userCount?: number;
  description?: string;
}

const METACRITIC_GAMES: MetacriticGameFixture[] = [
  { slug: 'portal-2', name: 'Portal 2', year: 2011, criticScore: 95, criticCount: 66 },
  { slug: 'dead-cells', name: 'Dead Cells', year: 2018, criticScore: 89, criticCount: 54 },
  { slug: 'slay-the-spire', name: 'Slay the Spire', year: 2019, criticScore: 89, criticCount: 46 },
  { slug: 'bioshock-2', name: 'BioShock 2', year: 2010, criticScore: 88, criticCount: 54 },
  { slug: 'mdk-2', name: 'MDK 2', year: 2000, criticScore: 83, criticCount: 24 },
  { slug: 'hitman-codename-47', name: 'Hitman: Codename 47', year: 2000, criticScore: 73, criticCount: 28 },
  { slug: 'postal-2', name: 'Postal 2', year: 2003, criticScore: 50, criticCount: 32 },
  { slug: 'fortnite', name: 'Fortnite', year: 2017, criticScore: 78, criticCount: 35 },
  {
    slug: 'deus-ex-invisible-war',
    name: 'Deus Ex: Invisible War',
    year: 2003,
    releaseDate: '2003-12-02',
    criticScore: 84,
    criticCount: 50,
    pcCriticScore: 80,
    pcCriticCount: 28,
    userScore: 6.8,
    userCount: 54,
  },
  {
    slug: 'metro-2033-redux',
    name: 'Metro: 2033 Redux',
    year: 2014,
    releaseDate: '2014-08-26',
    criticScore: 90,
    criticCount: 5,
    userScore: 8.3,
    userCount: 2649,
  },
  {
    slug: 'battlefield-2042',
    name: 'Battlefield 2042',
    year: 2021,
    releaseDate: '2021-11-19',
    criticScore: 68,
    criticCount: 64,
    userScore: 2.3,
    userCount: 5100,
  },
  {
    slug: 'warhammer-40000-darktide',
    name: 'Warhammer 40,000: Darktide',
    year: 2022,
    releaseDate: '2022-11-30',
    criticScore: 75,
    criticCount: 52,
    userScore: 5.9,
    userCount: 1450,
  },
  {
    slug: 'god-of-war-ragnarok',
    name: 'God of War Ragnarök',
    year: 2022,
    releaseDate: '2022-11-09',
    criticScore: 94,
    criticCount: 141,
    userScore: 8.3,
    userCount: 9200,
  },
  {
    slug: 'dead-space',
    name: 'Dead Space',
    year: 2008,
    releaseDate: '2008-10-14',
    criticScore: 86,
    criticCount: 28,
    userScore: 8.7,
    userCount: 2850,
  },
  {
    slug: 'dead-space-2023',
    name: 'Dead Space',
    year: 2023,
    releaseDate: '2023-01-27',
    criticScore: 89,
    criticCount: 73,
    userScore: 8.6,
    userCount: 3400,
  },
  { slug: 'predator-hunting-grounds', name: 'Predator: Hunting Grounds', year: 2020, criticScore: 56, criticCount: 46 },
  { slug: 'star-wars-battlefront-ii-2005', name: 'Star Wars: Battlefront II (2005)', year: 2005, criticScore: 83, criticCount: 42 },
  { slug: 'styx-shards-of-darkness', name: 'Styx: Shards of Darkness', year: 2017, criticScore: 72, criticCount: 38 },
  { slug: 'worms-revolution', name: 'Worms Revolution', year: 2012, criticScore: 73, criticCount: 25 },
  { slug: 'disco-elysium-2019', name: 'Disco Elysium', year: 2019, criticScore: 91, criticCount: 65 },
  { slug: 'nights-into-dreams-2012', name: 'NiGHTS into Dreams...', year: 2012, criticScore: 72, criticCount: 15 },
  { slug: 'never-alone-2014', name: 'Never Alone', year: 2014, criticScore: 72, criticCount: 40 },
  { slug: 'amnesia-the-dark-descent', name: 'Amnesia: The Dark Descent', year: 2010, criticScore: 85, criticCount: 73 },
  { slug: 'metro-last-light-redux', name: 'Metro: Last Light Redux', year: 2014, criticScore: 76, criticCount: 31 },
  { slug: 'metro-last-light', name: 'Metro: Last Light', year: 2013, criticScore: 82, criticCount: 66 },
  { slug: 'metal-gear-solid-delta-snake-eater', name: 'METAL GEAR SOLID DELTA: SNAKE EATER', year: 2025, criticScore: 85, criticCount: 72 },
  { slug: 'overcooked-2', name: 'Overcooked! 2', year: 2018, criticScore: 81, criticCount: 44 },
  { slug: 'alan-wake-2', name: 'Alan Wake 2', year: 2023, criticScore: 89, criticCount: 88 },
  { slug: 'alan-wake-ii', name: 'Alan Wake II', year: 2023, criticScore: 89, criticCount: 88 },
  { slug: 'control', name: 'Control', year: 2019, criticScore: 82, criticCount: 62 },
  { slug: 'kingdom', name: 'Kingdom: Classic', year: 2015, criticScore: 74, criticCount: 14 },
  { slug: 'kingdom-2015', name: 'Kingdom: Classic', year: 2015, criticScore: 74, criticCount: 14 },
  { slug: 'xcom-enemy-unknown', name: 'XCOM: Enemy Unknown', year: 2012, criticScore: 89, criticCount: 82 },
  { slug: 'metaphor-refantazio', name: 'Metaphor: ReFantazio', year: 2024, criticScore: 94, criticCount: 95 },
  {
    slug: 'cyberpunk-2077',
    name: 'Cyberpunk 2077',
    year: 2020,
    releaseDate: '2020-12-10',
    criticScore: 86,
    criticCount: 100,
    userScore: 7.2,
    userCount: 32000,
  },
  { slug: 'the-witcher-3-wild-hunt', name: 'The Witcher 3: Wild Hunt', year: 2015, criticScore: 93, criticCount: 79 },
  { slug: 'baldurs-gate-3', name: "Baldur's Gate 3", year: 2023, criticScore: 96, criticCount: 118 },
  { slug: 'baldurs-gate-ii-enhanced-edition', name: "Baldur's Gate II: Enhanced Edition", year: 2013, criticScore: 78, criticCount: 26 },
  { slug: 'fallout-new-vegas', name: 'Fallout: New Vegas', year: 2010, criticScore: 84, criticCount: 71 },
  { slug: 'half-life-2', name: 'Half-Life 2', year: 2004, criticScore: 96, criticCount: 81 },
  { slug: 'portal', name: 'Portal', year: 2007, criticScore: 90, criticCount: 27 },
  { slug: 'quake-ii', name: 'Quake II', year: 1997, criticScore: 85, criticCount: 22 },
  { slug: 'counter-strike', name: 'Counter-Strike', year: 2000, criticScore: 88, criticCount: 30 },
  { slug: 'beholder-2', name: 'Beholder 2', year: 2018, criticScore: 76, criticCount: 19 },
  { slug: 'the-saboteur', name: 'The Saboteur', year: 2009, criticScore: 76, criticCount: 48 },
  { slug: 'age-of-empires-ii-definitive-edition', name: 'Age of Empires II: Definitive Edition', year: 2019, criticScore: 84, criticCount: 45 },
  { slug: 'anchor-test-title', name: 'Anchor Test Title', year: 2024, criticScore: 88, criticCount: 25 },
  { slug: 'recommended-id-game', name: 'Recommended ID Game', year: 2024, criticScore: 85, criticCount: 20 },
  // Tier 3 User Score Only fixtures
  { slug: 'no-mans-sky', name: "NO MAN'S SKY", year: 2016, criticScore: null, userScore: 7.9, userCount: 640 },
  { slug: 'bioshock-2-remastered', name: 'BioShock 2 Remastered', year: 2016, criticScore: null, userScore: 7.8, userCount: 112 },
  { slug: 'factorio-2020', name: 'Factorio', year: 2020, criticScore: null, userScore: 8.1, userCount: 280 },
  { slug: 'doom-1993', name: 'DOOM (1993)', year: 1993, criticScore: null, userScore: 8.4, userCount: 450 },
  { slug: 'subnautica', name: 'Subnautica', year: 2018, criticScore: null, userScore: 7.7, userCount: 418 },
];

const FALLOUT_1997_FIXTURE: MetacriticGameFixture = {
  slug: 'fallout',
  name: 'Fallout',
  year: 1997,
  releaseDate: '1997-10-10',
  criticScore: 89,
  criticCount: 28,
};

const BY_SLUG = new Map<string, MetacriticGameFixture>(METACRITIC_GAMES.map((g) => [g.slug, g]));

function getFixtureReleaseDate(g: MetacriticGameFixture): string {
  return g.releaseDate || `${g.year}-05-15`;
}

function renderMetacriticHtml(g: MetacriticGameFixture): string {
  const htmlCriticScore = g.pcCriticScore !== undefined ? g.pcCriticScore : g.criticScore;
  const htmlCriticCount = g.pcCriticCount !== undefined ? g.pcCriticCount : g.criticCount;
  const ldJson: Record<string, unknown> = {
    '@context': 'https://schema.org',
    '@type': 'VideoGame',
    name: g.name,
    datePublished: getFixtureReleaseDate(g),
    description: g.description || `${g.name} critical reception and player consensus.`,
  };
  if (typeof htmlCriticScore === 'number' && htmlCriticScore > 0) {
    ldJson.aggregateRating = {
      '@type': 'AggregateRating',
      ratingValue: htmlCriticScore,
      reviewCount: htmlCriticCount || 20,
    };
  }
  const userSection =
    typeof g.userScore === 'number' && g.userScore > 0
      ? `<div title="User score ${g.userScore} out of 10">${g.userScore}</div><span>Based on ${g.userCount || 25} User Ratings</span>`
      : '';
  return `<!DOCTYPE html><html><head><title>${g.name} - Metacritic</title><script type="application/ld+json">${JSON.stringify(ldJson)}</script></head><body><h1>${g.name}</h1>${userSection}</body></html>`;
}

function renderMetacriticComposerJson(g: MetacriticGameFixture): Record<string, unknown> {
  const releaseDate = getFixtureReleaseDate(g);
  const overallScore =
    typeof g.criticScore === 'number' && g.criticScore > 0 ? g.criticScore : null;
  const overallCount = overallScore !== null ? g.criticCount || 20 : 0;
  const pcScore =
    g.pcCriticScore !== undefined
      ? g.pcCriticScore
      : overallScore;
  const pcCount =
    g.pcCriticCount !== undefined
      ? g.pcCriticCount
      : pcScore !== null
        ? overallCount
        : 0;
  const userScore = typeof g.userScore === 'number' && g.userScore > 0 ? g.userScore : null;
  const userCount = userScore !== null ? g.userCount || 25 : 0;

  const criticScoreSummary = {
    url: `/game/${g.slug}/critic-reviews/`,
    max: 100,
    score: overallScore,
    reviewCount: overallCount,
  };

  const userScoreSummary = {
    url: `/game/${g.slug}/user-reviews/`,
    max: 10,
    score: userScore,
    reviewCount: userCount,
  };

  const platforms = [
    {
      id: 31,
      name: 'PC',
      slug: 'pc',
      releaseDate,
      criticScoreSummary: {
        url: `/game/${g.slug}/critic-reviews/?platform=pc`,
        max: 100,
        score: pcScore,
        reviewCount: pcCount,
      },
    },
  ];

  const productItem = {
    type: 'game-title',
    slug: g.slug,
    title: g.name,
    releaseDate,
    description: g.description || `${g.name} critical reception and player consensus.`,
    criticScoreSummary,
    userScoreSummary,
    platforms,
  };

  return {
    data: {
      item: productItem,
    },
    components: [
      {
        data: { item: productItem },
        meta: { componentName: 'product', componentType: 'product' },
      },
      {
        data: { item: criticScoreSummary },
        meta: { componentName: 'critic-score-summary', componentType: 'critic-score-summary' },
      },
      {
        data: { item: userScoreSummary },
        meta: { componentName: 'user-score-summary', componentType: 'user-score-summary' },
      },
    ],
  };
}

function normalizeQuery(q: string): string {
  let decoded = q;
  try {
    decoded = decodeURIComponent(q);
  } catch {
    decoded = q;
  }
  return decoded
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\u0394/g, 'delta')
    .replace(/(\d),(\d)/g, '$1$2')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

const SEARCH_INDEX: Array<{ keywords: string[]; slugs: string[] }> = [
  { keywords: ['deus ex 2 invisible war', 'deus ex invisible war'], slugs: ['deus-ex-invisible-war'] },
  { keywords: ['metro 2033 redux'], slugs: ['metro-2033-redux'] },
  { keywords: ['battlefield 2042'], slugs: ['battlefield-2042'] },
  { keywords: ['warhammer 40000 darktide', 'warhammer 40 000 darktide'], slugs: ['warhammer-40000-darktide'] },
  { keywords: ['god of war ragnarok', 'god of war ragnar k'], slugs: ['god-of-war-ragnarok'] },
  { keywords: ['dead space'], slugs: ['dead-space-2023', 'dead-space'] },
  { keywords: ['star wars battlefront ii', 'star wars battlefront 2'], slugs: ['star-wars-battlefront-ii-2005'] },
  { keywords: ['disco elysium'], slugs: ['disco-elysium-2019'] },
  { keywords: ['factorio'], slugs: ['factorio-2020'] },
  { keywords: ['nights into dreams'], slugs: ['nights-into-dreams-2012'] },
  { keywords: ['never alone'], slugs: ['never-alone-2014'] },
  { keywords: ['amnesia'], slugs: ['amnesia-the-dark-descent'] },
  { keywords: ['kingdom classic'], slugs: ['kingdom', 'kingdom-come-deliverance'] },
  { keywords: ['xcom enemy unknown'], slugs: ['xcom-enemy-unknown', 'the-bureau-xcom-declassified'] },
  { keywords: ['metal gear solid delta snake eater', 'metal gear solid'], slugs: ['metal-gear-solid-delta-snake-eater'] },
  { keywords: ['metro last light redux'], slugs: ['metro-last-light-redux'] },
  { keywords: ['metro last light'], slugs: ['metro-last-light', 'metro-last-light-redux'] },
  { keywords: ['predator hunting grounds'], slugs: ['predator-hunting-grounds'] },
  { keywords: ['styx shards of darkness'], slugs: ['styx-shards-of-darkness'] },
  { keywords: ['worms revolution'], slugs: ['worms-revolution'] },
  { keywords: ['metaphor refantazio'], slugs: ['metaphor-refantazio'] },
  { keywords: ['no mans sky'], slugs: ['no-mans-sky'] },
  { keywords: ['bioshock 2 remastered'], slugs: ['bioshock-2-remastered'] },
  { keywords: ['bioshock 2'], slugs: ['bioshock-2', 'bioshock-2-remastered'] },
  { keywords: ['doom 1993'], slugs: ['doom-1993'] },
  { keywords: ['subnautica'], slugs: ['subnautica'] },
  { keywords: ['overcooked 2'], slugs: ['overcooked-2'] },
  { keywords: ['alan wake 2'], slugs: ['alan-wake-2'] },
  { keywords: ['cyberpunk 2077'], slugs: ['cyberpunk-2077'] },
  { keywords: ['the witcher 3 wild hunt'], slugs: ['the-witcher-3-wild-hunt'] },
  { keywords: ['fallout london'], slugs: ['fallout'] },
];

export function handleMetacriticWeb(req: FixtureRequest): FixtureResponse | null {
  const m = req.url.pathname.match(/^\/game\/(?:pc\/)?([a-z0-9-]+)(?:\/(?:critic-reviews|user-reviews))?\/?$/i);
  if (!m) return null;
  const slug = m[1].toLowerCase();
  if (slug === 'fallout') {
    return {
      status: 200,
      headers: { 'content-type': 'text/html; charset=utf-8' },
      body: renderMetacriticHtml(FALLOUT_1997_FIXTURE),
    };
  }
  const found = BY_SLUG.get(slug);
  if (!found) {
    return {
      status: 404,
      statusText: 'Not Found',
      headers: { 'content-type': 'text/html' },
      body: '<html><body>404 Not Found</body></html>',
    };
  }
  return {
    status: 200,
    headers: { 'content-type': 'text/html; charset=utf-8' },
    body: renderMetacriticHtml(found),
  };
}

export function handleMetacriticComposer(req: FixtureRequest): FixtureResponse | null {
  const m = req.url.pathname.match(
    /^\/composer\/metacritic\/pages\/games\/([a-z0-9-]+)(?:\/(?:web|critic-reviews\/web|user-reviews\/web))?\/?$/i
  );
  if (!m) return null;
  const slug = m[1].toLowerCase();
  const found = slug === 'fallout' ? FALLOUT_1997_FIXTURE : BY_SLUG.get(slug);
  if (!found) {
    return {
      status: 404,
      statusText: 'Not Found',
      headers: { 'content-type': 'application/json' },
      body: { code: 404, message: 'Not Found' },
    };
  }
  return {
    status: 200,
    headers: { 'content-type': 'application/json' },
    body: renderMetacriticComposerJson(found),
  };
}

export function handleMetacriticSearch(req: FixtureRequest): FixtureResponse | null {
  const composerRes = handleMetacriticComposer(req);
  if (composerRes) return composerRes;

  const m = req.url.pathname.match(/^\/finder\/metacritic\/search\/([^/]+)\/web\/?$/i);
  if (!m) return null;
  const norm = normalizeQuery(m[1]);
  const matchedSlugs = new Set<string>();
  for (const entry of SEARCH_INDEX) {
    if (entry.keywords.some((k) => norm === k || norm.includes(k))) {
      for (const s of entry.slugs) matchedSlugs.add(s);
    }
  }
  for (const g of METACRITIC_GAMES) {
    const gNorm = normalizeQuery(g.name);
    if (gNorm === norm) matchedSlugs.add(g.slug);
  }
  const items = Array.from(matchedSlugs).map((slug) => {
    const g = BY_SLUG.get(slug);
    if (g) {
      return {
        slug: g.slug,
        title: g.name,
        releaseDate: getFixtureReleaseDate(g),
        criticScoreSummary: { score: g.criticScore ?? null, reviewCount: g.criticCount ?? 0 },
      };
    }
    if (slug === 'fallout') {
      return {
        slug: 'fallout',
        title: 'Fallout',
        releaseDate: '1997-10-10',
        criticScoreSummary: { score: 89, reviewCount: 28 },
      };
    }
    if (slug === 'kingdom-come-deliverance') {
      return {
        slug: 'kingdom-come-deliverance',
        title: 'Kingdom Come: Deliverance',
        releaseDate: '2018-02-13',
        criticScoreSummary: { score: 76, reviewCount: 40 },
      };
    }
    return {
      slug,
      title: slug.replace(/-/g, ' '),
      releaseDate: '2013-08-20',
      criticScoreSummary: { score: 62, reviewCount: 15 },
    };
  });

  return {
    status: 200,
    headers: { 'content-type': 'application/json' },
    body: { data: { items } },
  };
}
