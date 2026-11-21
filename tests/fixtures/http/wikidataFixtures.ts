import { FixtureRequest, FixtureResponse } from './types';

interface WikidataGameFixture {
  qid: string;
  label: string;
  aliases?: string[];
  description?: string;
  steamAppIds?: string[];
  gogSlugs?: string[];
  openCriticId?: string;
  metacriticSlug?: string;
}

const WIKIDATA_GAMES: WikidataGameFixture[] = [
  {
    qid: 'Q112625948',
    label: '20 Minutes Till Dawn',
    description: '2023 roguelike survival video game',
    steamAppIds: ['1966900'],
    openCriticId: '13483',
  },
  {
    qid: 'Q101245652',
    label: 'Prodeus',
    description: '2022 first-person shooter video game',
    steamAppIds: ['964800'],
    gogSlugs: ['prodeus'],
    openCriticId: '10450',
  },
  {
    qid: 'Q54958391',
    label: 'Control',
    aliases: ['Control Ultimate Edition'],
    description: '2019 action-adventure video game',
    steamAppIds: ['870780'],
    gogSlugs: ['control', 'control_ultimate_edition'],
    openCriticId: '7858',
    metacriticSlug: 'control',
  },
  {
    qid: 'Q110028543',
    label: 'Alan Wake 2',
    aliases: ['Alan Wake II'],
    description: '2023 survival horror video game',
    openCriticId: '15022',
    metacriticSlug: 'alan-wake-2',
  },
  {
    qid: 'Q1545721',
    label: 'The Saboteur',
    description: '2009 action-adventure video game',
    steamAppIds: ['24880'],
    gogSlugs: ['the_saboteur'],
    openCriticId: '4321',
    metacriticSlug: 'the-saboteur',
  },
  {
    qid: 'Q17635128',
    label: 'Metro 2033 Redux',
    aliases: ['Metro: 2033 Redux', 'METRO 2033 Redux'],
    description: '2014 first-person shooter video game',
    steamAppIds: ['286690'],
    gogSlugs: ['metro_2033_redux'],
    openCriticId: '957',
    metacriticSlug: 'metro-2033-redux',
  },
  {
    qid: 'Q1201699',
    label: 'Deus Ex: Invisible War',
    aliases: ['Deus Ex 2: Invisible War', 'Deus ex 2: invisible war'],
    description: '2003 action role-playing video game',
    steamAppIds: ['6920'],
    gogSlugs: ['deus_ex_invisible_war', 'deus_ex_2_invisible_war'],
    metacriticSlug: 'deus-ex-invisible-war',
  },
  {
    qid: 'Q21527788',
    label: 'Kingdom: Classic',
    aliases: ['Kingdom'],
    description: '2015 strategy video game',
    steamAppIds: ['368230'],
    openCriticId: '1968',
    metacriticSlug: 'kingdom',
  },
  {
    qid: 'Q28840319',
    label: 'Hollow Knight',
    description: '2017 Metroidvania video game',
    steamAppIds: ['367520'],
    gogSlugs: ['hollow_knight'],
    openCriticId: '4002',
  },
  {
    qid: 'Q99909876',
    label: 'Indie Hero Adventure',
    description: '2024 indie video game',
    openCriticId: '9876',
  },
  {
    qid: 'Q3182559',
    label: 'Cyberpunk 2077',
    description: '2020 action role-playing video game',
    steamAppIds: ['1091500'],
    gogSlugs: ['cyberpunk_2077'],
    openCriticId: '8525',
    metacriticSlug: 'cyberpunk-2077',
  },
  {
    qid: 'Q107169693',
    label: 'Battlefield 2042',
    description: '2021 first-person shooter video game',
    steamAppIds: ['1517290'],
    metacriticSlug: 'battlefield-2042',
  },
  {
    qid: 'Q97626888',
    label: 'Warhammer 40,000: Darktide',
    description: '2022 first-person action video game',
    steamAppIds: ['1361210'],
    metacriticSlug: 'warhammer-40000-darktide',
  },
  {
    qid: 'Q99397854',
    label: 'God of War Ragnarök',
    aliases: ['God of War Ragnarok'],
    description: '2022 action-adventure video game',
    steamAppIds: ['2322010'],
    metacriticSlug: 'god-of-war-ragnarok',
  },
  {
    qid: 'Q589328',
    label: 'Dead Space',
    description: '2008 survival horror video game',
    steamAppIds: ['17470'],
    metacriticSlug: 'dead-space',
  },
  {
    qid: 'Q107616143',
    label: 'Dead Space',
    aliases: ['Dead Space (2023)'],
    description: '2023 survival horror video game remake',
    steamAppIds: ['1693980'],
    metacriticSlug: 'dead-space-2023',
  },
];

const BY_QID = new Map<string, WikidataGameFixture>(WIKIDATA_GAMES.map((g) => [g.qid, g]));

const BY_STEAM_ID = new Map<string, WikidataGameFixture>();
const BY_GOG_SLUG = new Map<string, WikidataGameFixture>();

function normalizeGogSlug(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/^game\//, '')
    .replace(/-/g, '_');
}

for (const g of WIKIDATA_GAMES) {
  for (const sid of g.steamAppIds || []) {
    BY_STEAM_ID.set(String(sid).trim(), g);
  }
  for (const slug of g.gogSlugs || []) {
    BY_GOG_SLUG.set(normalizeGogSlug(slug), g);
  }
}

function normalizeTitle(raw: string): string {
  return raw
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/(\d),(\d)/g, '$1$2')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function extractSparqlQueryString(req: FixtureRequest): string {
  const fromQueryParam = req.url.searchParams.get('query');
  if (fromQueryParam) return fromQueryParam;
  if (req.body) {
    const trimmed = req.body.trim();
    if (/^query=/i.test(trimmed)) {
      try {
        const params = new URLSearchParams(trimmed);
        return params.get('query') || trimmed;
      } catch {
        return trimmed;
      }
    }
    return trimmed;
  }
  return '';
}

function collectPredicateVars(sparql: string, property: string, fallback: string): string[] {
  const vars = new Set<string>();
  const propRegex = new RegExp(`wdt:${property}\\s+\\?([a-zA-Z0-9_]+)`, 'g');
  let m: RegExpExecArray | null = propRegex.exec(sparql);
  while (m) {
    const rawVar = m[1];
    vars.add(rawVar);
    // Also detect SELECT aliases such as `(SAMPLE(?oc) AS ?ocId)`
    const aliasRegex = new RegExp(
      `\\(\\s*[A-Za-z_]+\\(\\s*(?:DISTINCT\\s+)?\\?${rawVar}\\b[^)]*\\)\\s+AS\\s+\\?([a-zA-Z0-9_]+)\\s*\\)`,
      'gi'
    );
    let am: RegExpExecArray | null = aliasRegex.exec(sparql);
    while (am) {
      vars.add(am[1]);
      am = aliasRegex.exec(sparql);
    }
    m = propRegex.exec(sparql);
  }
  if (vars.size === 0) {
    vars.add(fallback);
  }
  return Array.from(vars);
}

function parseSparqlVariableNames(sparql: string): {
  itemVar: string;
  steamVars: string[];
  gogVars: string[];
  ocVars: string[];
  mcVars: string[];
  labelVars: string[];
} {
  const itemVar =
    sparql.match(/\?([a-zA-Z0-9_]+)\s+wdt:P(?:1733|2725|2864|12054)\b/)?.[1] || 'item';
  const steamVars = collectPredicateVars(sparql, 'P1733', 'steamId');
  const gogVars = collectPredicateVars(sparql, 'P2725', 'gogSlug');
  const ocVars = collectPredicateVars(sparql, 'P2864', 'ocId');
  const mcVars = collectPredicateVars(sparql, 'P12054', 'mcSlug');

  const labelSet = new Set<string>([`${itemVar}Label`]);
  const rdfsLabelMatch = sparql.match(/rdfs:label\s+\?([a-zA-Z0-9_]+)/);
  if (rdfsLabelMatch?.[1]) labelSet.add(rdfsLabelMatch[1]);
  const genericLabelMatches = sparql.matchAll(/\?([a-zA-Z0-9_]*[Ll]abel)\b/g);
  for (const lm of genericLabelMatches) {
    if (lm[1]) labelSet.add(lm[1]);
  }

  return {
    itemVar,
    steamVars,
    gogVars,
    ocVars,
    mcVars,
    labelVars: Array.from(labelSet),
  };
}

function extractQuotedLiterals(block: string): string[] {
  const values: string[] = [];
  const regex = /"([^"]+)"|'([^']+)'/g;
  let m: RegExpExecArray | null = regex.exec(block);
  while (m) {
    const val = (m[1] ?? m[2] ?? '').trim();
    if (val) values.push(val);
    m = regex.exec(block);
  }
  return values;
}

function handleWikidataSparql(req: FixtureRequest): FixtureResponse {
  const sparql = extractSparqlQueryString(req);
  const vars = parseSparqlVariableNames(sparql);

  const requestedSteamIds = new Set<string>();
  const requestedGogLiterals = new Map<string, string>(); // normalizedSlug -> exact query literal

  // Parse all VALUES ?var { ... } clauses
  const valuesClauseRegex = /VALUES\s+\?([a-zA-Z0-9_]+)\s*\{([^}]*)\}/gi;
  let vm: RegExpExecArray | null = valuesClauseRegex.exec(sparql);
  while (vm) {
    const varName = vm[1];
    const literals = extractQuotedLiterals(vm[2]);
    const isSteamVar =
      vars.steamVars.includes(varName) || /steam|1733/i.test(varName);
    const isGogVar =
      vars.gogVars.includes(varName) || /gog|2725/i.test(varName);

    for (const lit of literals) {
      if (isSteamVar && /^\d+$/.test(lit)) {
        requestedSteamIds.add(lit);
      } else if (isGogVar) {
        const normSlug = normalizeGogSlug(lit);
        if (!requestedGogLiterals.has(normSlug)) {
          requestedGogLiterals.set(normSlug, lit);
        }
      } else if (/^\d+$/.test(lit)) {
        requestedSteamIds.add(lit);
      } else {
        const normSlug = normalizeGogSlug(lit);
        if (!requestedGogLiterals.has(normSlug)) {
          requestedGogLiterals.set(normSlug, lit);
        }
      }
    }
    vm = valuesClauseRegex.exec(sparql);
  }

  // Also parse direct inline literal triples: `wdt:P1733 "286690"` or `wdt:P2725 "game/foo"`
  const inlineSteamRegex = /wdt:P1733\s+["'](\d+)["']/gi;
  let sm: RegExpExecArray | null = inlineSteamRegex.exec(sparql);
  while (sm) {
    requestedSteamIds.add(sm[1]);
    sm = inlineSteamRegex.exec(sparql);
  }
  const inlineGogRegex = /wdt:P2725\s+["']([^"']+)["']/gi;
  let gm: RegExpExecArray | null = inlineGogRegex.exec(sparql);
  while (gm) {
    const normSlug = normalizeGogSlug(gm[1]);
    if (!requestedGogLiterals.has(normSlug)) {
      requestedGogLiterals.set(normSlug, gm[1]);
    }
    gm = inlineGogRegex.exec(sparql);
  }

  const matchedGames = new Map<
    string,
    { game: WikidataGameFixture; matchedSteamId?: string; matchedGogLiteral?: string }
  >();

  for (const sid of requestedSteamIds) {
    const g = BY_STEAM_ID.get(sid);
    if (g) {
      const existing = matchedGames.get(g.qid);
      matchedGames.set(g.qid, {
        game: g,
        matchedSteamId: sid,
        matchedGogLiteral: existing?.matchedGogLiteral,
      });
    }
  }

  for (const [normSlug, rawLit] of requestedGogLiterals.entries()) {
    const g = BY_GOG_SLUG.get(normSlug);
    if (g) {
      const existing = matchedGames.get(g.qid);
      matchedGames.set(g.qid, {
        game: g,
        matchedSteamId: existing?.matchedSteamId,
        matchedGogLiteral: rawLit,
      });
    }
  }

  const bindings: Array<Record<string, { type: string; value: string; 'xml:lang'?: string }>> = [];
  for (const { game, matchedSteamId, matchedGogLiteral } of matchedGames.values()) {
    const binding: Record<string, { type: string; value: string; 'xml:lang'?: string }> = {
      [vars.itemVar]: { type: 'uri', value: `http://www.wikidata.org/entity/${game.qid}` },
    };
    for (const labelVar of vars.labelVars) {
      binding[labelVar] = { type: 'literal', 'xml:lang': 'en', value: game.label };
    }

    const effectiveSteamId = matchedSteamId ?? game.steamAppIds?.[0];
    if (effectiveSteamId) {
      for (const steamVar of vars.steamVars) {
        binding[steamVar] = { type: 'literal', value: effectiveSteamId };
      }
    }

    const effectiveGog =
      matchedGogLiteral ?? (game.gogSlugs?.[0] ? `game/${game.gogSlugs[0]}` : undefined);
    if (effectiveGog) {
      for (const gogVar of vars.gogVars) {
        binding[gogVar] = { type: 'literal', value: effectiveGog };
      }
    }

    if (game.openCriticId) {
      for (const ocVar of vars.ocVars) {
        binding[ocVar] = { type: 'literal', value: game.openCriticId };
      }
    }
    if (game.metacriticSlug) {
      for (const mcVar of vars.mcVars) {
        binding[mcVar] = { type: 'literal', value: game.metacriticSlug };
      }
    }

    bindings.push(binding);
  }

  const headVars = Array.from(
    new Set([
      vars.itemVar,
      ...vars.steamVars,
      ...vars.gogVars,
      ...vars.ocVars,
      ...vars.mcVars,
      ...vars.labelVars,
    ])
  );

  return {
    status: 200,
    headers: { 'content-type': 'application/sparql-results+json' },
    body: {
      head: { vars: headVars },
      results: { bindings },
    },
  };
}

function buildStringClaim(property: string, value: string): Record<string, unknown> {
  return {
    mainsnak: {
      snaktype: 'value',
      property,
      datavalue: {
        value,
        type: 'string',
      },
    },
    type: 'statement',
    rank: 'normal',
  };
}

function handleWikidataActionApi(req: FixtureRequest): FixtureResponse {
  const action = (req.url.searchParams.get('action') || '').toLowerCase();

  if (action === 'wbsearchentities') {
    const rawSearch = req.url.searchParams.get('search') || '';
    const normSearch = normalizeTitle(rawSearch);
    const searchHits = !normSearch
      ? []
      : WIKIDATA_GAMES.filter((g) => {
          const candidates = [g.label, ...(g.aliases || [])].map(normalizeTitle);
          return candidates.some(
            (c) =>
              c === normSearch ||
              (normSearch.length >= 4 && (c.includes(normSearch) || normSearch.includes(c)))
          );
        }).map((g) => ({
          id: g.qid,
          title: g.qid,
          label: g.label,
          description: g.description || 'video game',
          match: {
            type: 'label',
            language: 'en',
            text: g.label,
          },
        }));

    return {
      status: 200,
      headers: { 'content-type': 'application/json' },
      body: {
        searchinfo: { search: rawSearch },
        search: searchHits,
        success: 1,
      },
    };
  }

  if (action === 'wbgetentities') {
    const rawIds = req.url.searchParams.get('ids') || '';
    const ids = rawIds
      .split('|')
      .map((id) => id.trim())
      .filter(Boolean);

    const entities: Record<string, unknown> = {};
    for (const qid of ids) {
      const g = BY_QID.get(qid);
      if (!g) continue;
      const claims: Record<string, unknown[]> = {
        P31: [
          {
            mainsnak: {
              snaktype: 'value',
              property: 'P31',
              datavalue: {
                value: { 'entity-type': 'item', 'numeric-id': 7889, id: 'Q7889' },
                type: 'wikibase-entityid',
              },
            },
            type: 'statement',
            rank: 'normal',
          },
        ],
      };
      if (g.openCriticId) {
        claims.P2864 = [buildStringClaim('P2864', g.openCriticId)];
      }
      if (g.metacriticSlug) {
        claims.P12054 = [buildStringClaim('P12054', g.metacriticSlug)];
      }
      if (g.steamAppIds && g.steamAppIds.length > 0) {
        claims.P1733 = g.steamAppIds.map((sid) => buildStringClaim('P1733', sid));
      }
      if (g.gogSlugs && g.gogSlugs.length > 0) {
        claims.P2725 = g.gogSlugs.map((slug) => buildStringClaim('P2725', `game/${slug}`));
      }

      entities[g.qid] = {
        type: 'item',
        id: g.qid,
        labels: {
          en: { language: 'en', value: g.label },
        },
        descriptions: {
          en: { language: 'en', value: g.description || 'video game' },
        },
        claims,
      };
    }

    return {
      status: 200,
      headers: { 'content-type': 'application/json' },
      body: {
        entities,
        success: 1,
      },
    };
  }

  return {
    status: 200,
    headers: { 'content-type': 'application/json' },
    body: { search: [], entities: {}, success: 1 },
  };
}

export function handleWikidataEndpoints(req: FixtureRequest): FixtureResponse | null {
  const host = req.url.hostname.toLowerCase();

  if (host === 'query.wikidata.org') {
    if (req.url.pathname === '/sparql' || req.url.pathname === '/' || req.url.pathname === '/sparql/') {
      return handleWikidataSparql(req);
    }
    return {
      status: 200,
      headers: { 'content-type': 'application/sparql-results+json' },
      body: { head: { vars: [] }, results: { bindings: [] } },
    };
  }

  if (host === 'www.wikidata.org' || host === 'wikidata.org') {
    if (req.url.pathname === '/w/api.php' || req.url.pathname === '/api.php') {
      return handleWikidataActionApi(req);
    }
    return {
      status: 200,
      headers: { 'content-type': 'application/json' },
      body: { search: [], entities: {}, success: 1 },
    };
  }

  return null;
}
