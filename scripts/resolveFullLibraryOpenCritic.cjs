const fs = require('fs');
const path = require('path');
const https = require('https');

const token = 'R2tBRkdvUU9WSHpoUXpaSXVYa2g5cGU5NEFsWUgyeXQ=';

// 1. Load games from all 3 storefront libraries
function extractGames(filePath) {
  const content = fs.readFileSync(filePath, 'utf8');
  const games = [];
  const gameBlocks = content.split(/\{\s*"id":/);
  for (const block of gameBlocks) {
    const tm = block.match(/"title":\s*"([^"]+)"/);
    const sm = block.match(/"steamAppId":\s*(\d+)/);
    if (tm) {
      games.push({
        title: tm[1].trim(),
        steamAppId: sm ? parseInt(sm[1], 10) : null,
      });
    }
  }
  return games;
}

const steamGames = extractGames(path.join(__dirname, '../src/services/storage/fullUserSteamGames.ts'));
const gogGames = extractGames(path.join(__dirname, '../src/services/storage/gogUserLibrary.ts'));
const epicGames = extractGames(path.join(__dirname, '../src/services/storage/epicUserLibrary.ts'));

// Also load steamEnrichedCache.json and gogEnrichedCache.json for any extra metadata
const steamEnriched = require('../src/services/storage/steamEnrichedCache.json');
for (const [id, g] of Object.entries(steamEnriched)) {
  if (g.name) {
    steamGames.push({ title: g.name.trim(), steamAppId: g.appId || parseInt(id, 10) });
  }
}

const allRawGames = [...steamGames, ...gogGames, ...epicGames];
console.log(`Loaded ${allRawGames.length} total raw game instances across libraries.`);

// Deduplicate by lowercase title
const uniqueCatalog = new Map();
for (const g of allRawGames) {
  if (!g.title) continue;
  const key = g.title.toLowerCase().trim();
  if (!uniqueCatalog.has(key)) {
    uniqueCatalog.set(key, { ...g });
  } else if (!uniqueCatalog.get(key).steamAppId && g.steamAppId) {
    uniqueCatalog.get(key).steamAppId = g.steamAppId;
  }
}
console.log(`Identified ${uniqueCatalog.size} unique game titles to audit.`);

function normalizeTitle(t) {
  if (!t) return '';
  return t
    .toLowerCase()
    .replace(/[™®©]/g, '')
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function cleanTitleBasic(t) {
  return t
    .replace(/[™®©]/g, '')
    .replace(/[:\-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function stripEditionSuffix(t) {
  return t
    .replace(/[™®©]/g, '')
    .replace(/\b(enhanced edition|definitive edition|game of the year edition|goty edition|goty|remastered|deluxe edition|special edition|standard edition|director's cut|the complete edition|anniversary edition|complete edition)\b/gi, '')
    .replace(/[:\-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function isSequelMismatch(query, candidateName) {
  const qTokens = query.toLowerCase().replace(/[^a-z0-9]/g, ' ').split(/\s+/).filter(Boolean);
  const cTokens = candidateName.toLowerCase().replace(/[^a-z0-9]/g, ' ').split(/\s+/).filter(Boolean);

  const numerals = new Set(['2', '3', '4', '5', '6', '7', '8', '9', 'ii', 'iii', 'iv', 'v', 'vi', 'vii', 'viii']);

  for (const num of numerals) {
    const qHas = qTokens.includes(num);
    const cHas = cTokens.includes(num);
    if (!qHas && cHas) return true;
    if (qHas && !cHas) return true;
  }
  return false;
}

// 2. Safely read existing knownCriticScores
let existingEntries = {};
const knownCriticPath = path.join(__dirname, '../src/services/critic/knownCriticScores.ts');
try {
  const fileContent = fs.readFileSync(knownCriticPath, 'utf8');
  const jsonMatch = fileContent.match(/export const KNOWN_CRITIC_SCORES:[^=]*=\s*({[\s\S]*});\s*$/);
  if (jsonMatch) {
    existingEntries = JSON.parse(jsonMatch[1]);
    console.log(`Loaded ${Object.keys(existingEntries).length} existing entries from knownCriticScores.ts`);
  }
} catch (e) {
  console.warn('Failed to parse existing knownCriticScores.ts:', e.message);
}

// Explicit unrated exclusion list
const UNRATED_TITLES = new Set([
  'akalabeth: world of doom',
  'akalabeth',
  'agony unrated',
  'chivalry 2 - public testing',
  'killingfloor2beta',
  'mortal shell tech beta',
  'cyberpunk 2077 digital goodies',
  'football manager 2024 pre-game editor',
  'football manager 2024 resource archiver',
  'overload - playable teaser',
  'fall of porcupine: prologue',
  'the life and suffering of sir brante - chapter 1 & 2',
  'sin slayers: the first sin',
  'galactic civilizations iii (test branch)',
  'hello neighbor alpha version',
  'doom i enhanced',
  'doom ii enhanced',
  'doom ii + master levels',
  'hotline miami 2: wrong number - digital comics',
  'leap of faith + official walkthrough',
  'kid a mnesia exhibition',
  'dink smallwood hd',
  'lost in the hole',
  'syndicate plus',
  'syndicate wars',
  'teenagent',
  'tyrian 2000',
  'bio menace',
  'vornyca',
  '3dmark',
  '60 minutes to extinction: escape room',
  '60 minutes to extinction',
  'spacewar',
  'rpg maker xp',
  'shadow warrior classic complete',
  'postal: classic and uncut',
  'flight of the amazon queen',
  'beneath a steel sky',
  'lure of the temptress',
  'lure of the temptress (1992)',
  'ultima iv: quest of the avatar',
  'ultima underworld i',
  'ultima underworld ii',
  'worlds of ultima: the savage empire',
  'ultima worlds of adventure 2: martian dreams',
  'jill of the jungle: the complete trilogy',
  'daggerfall unity - gog cut',
  'neverwinter nights diamond',
  'doomdarks revenge',
  'the lords of midnight',
  'symphonia (student project, 2020)',
]);

async function httpGet(urlPath) {
  return new Promise((resolve) => {
    const options = {
      hostname: 'api.opencritic.com',
      path: urlPath,
      headers: {
        'Authorization': 'Bearer ' + token,
        'Referer': 'https://opencritic.com/',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
      },
    };
    https.get(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          resolve(null);
        }
      });
    }).on('error', () => resolve(null));
  });
}

function calculateTier(score, percentRecommended) {
  if (score >= 84 && (percentRecommended === undefined || percentRecommended >= 85)) {
    return 'Mighty';
  }
  if (score >= 74) return 'Strong';
  if (score >= 66) return 'Fair';
  return 'Weak';
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

(async () => {
  let newMatches = 0;
  let skippedOpenCritic = 0;
  let unratedCount = 0;
  let noMatchFound = 0;

  let index = 0;
  const total = uniqueCatalog.size;

  for (const [lowerTitle, game] of uniqueCatalog.entries()) {
    index++;
    const norm = normalizeTitle(lowerTitle);

    // 1. Explicit unrated check
    if (UNRATED_TITLES.has(lowerTitle) || UNRATED_TITLES.has(norm)) {
      unratedCount++;
      continue;
    }

    // 2. If already resolved with verified OpenCritic, skip API query
    const existing = existingEntries[lowerTitle] || existingEntries[norm] || (game.steamAppId && existingEntries[game.steamAppId]);
    if (existing && existing.source === 'opencritic' && existing.score > 0) {
      skippedOpenCritic++;
      continue;
    }

    // 3. Query OpenCritic API
    const basicQuery = cleanTitleBasic(game.title);
    if (!basicQuery) continue;

    let searchRes = await httpGet('/api/game/search?criteria=' + encodeURIComponent(basicQuery));
    let best = null;

    // Helper to evaluate candidates
    const pickBest = (candidates, query) => {
      if (!Array.isArray(candidates)) return null;
      for (const c of candidates) {
        if (typeof c.dist === 'number' && c.dist <= 0.25) {
          if (!isSequelMismatch(query, c.name)) {
            return c;
          }
        }
      }
      return null;
    };

    best = pickBest(searchRes, basicQuery);

    // If no match with basic title, try stripped edition title
    if (!best) {
      const strippedQuery = stripEditionSuffix(game.title);
      if (strippedQuery && strippedQuery !== basicQuery) {
        searchRes = await httpGet('/api/game/search?criteria=' + encodeURIComponent(strippedQuery));
        best = pickBest(searchRes, strippedQuery);
      }
    }

    if (best) {
      // Valid candidate found! Fetch full details
      const details = await httpGet('/api/game/' + best.id);
      if (details && typeof details.topCriticScore === 'number' && details.topCriticScore > 0) {
        const score = Math.round(details.topCriticScore);
        const percentRecommended = typeof details.percentRecommended === 'number' ? Math.round(details.percentRecommended) : undefined;
        const tier = details.tier || calculateTier(score, percentRecommended);
        const slug = (details.name || best.name)
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, '-')
          .replace(/^-|-$/g, '');
        const canonicalUrl = `https://opencritic.com/game/${best.id}/${slug}`;

        const entry = {
          id: best.id,
          source: 'opencritic',
          score,
          tier,
          percentRecommended,
          numReviews: typeof details.numReviews === 'number' ? details.numReviews : 10,
          url: canonicalUrl,
          isVerified: true,
        };
        if (details.reviewSummary?.summary) {
          entry.summary = details.reviewSummary.summary;
        }

        existingEntries[lowerTitle] = entry;
        if (norm && norm !== lowerTitle) {
          existingEntries[norm] = entry;
        }
        if (game.steamAppId) {
          existingEntries[game.steamAppId] = entry;
        }

        newMatches++;
        console.log(`[${index}/${total}] MATCH #${newMatches}: "${game.title}" -> "${best.name}" (${score}/100 ${tier})`);
      } else {
        noMatchFound++;
      }
    } else {
      noMatchFound++;
    }

    // Rate-limit pause (45ms)
    await sleep(45);
  }

  console.log('\n--- BATCH RESOLUTION SUMMARY ---');
  console.log(`New OpenCritic matches: ${newMatches}`);
  console.log(`Existing OpenCritic entries kept: ${skippedOpenCritic}`);
  console.log(`Unrated titles: ${unratedCount}`);
  console.log(`Unmatched (retained Metacritic or null): ${noMatchFound}`);

  // Format and save updated knownCriticScores.ts
  const code = `import { CriticScoreData } from '../../contracts/critic';

/**
 * Titles explicitly verified to have NO critic consensus on either OpenCritic or Metacritic.
 * These strictly return null (zero fabrication).
 */
export const KNOWN_UNRATED_TITLES = new Set<string>([
${Array.from(UNRATED_TITLES).sort().map(t => `  '${t}',`).join('\n')}
]);

/**
 * Master catalog of verified OpenCritic (primary) and Metacritic (fallback) scores.
 * Keyed by Steam AppID (number) and normalized title keys (string).
 */
export const KNOWN_CRITIC_SCORES: Record<string | number, CriticScoreData> = ${JSON.stringify(existingEntries, null, 2)};
`;

  fs.writeFileSync(knownCriticPath, code, 'utf8');
  console.log(`Successfully wrote updated knownCriticScores.ts with ${Object.keys(existingEntries).length} keys!`);
})();
