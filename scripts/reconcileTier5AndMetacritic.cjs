const fs = require('fs');
const path = require('path');

const targetFile = path.resolve(__dirname, '../src/services/critic/knownCriticScores.ts');
let content = fs.readFileSync(targetFile, 'utf8');

console.log('Original file size:', content.length);

// 1. Update KNOWN_UNRATED_TITLES: remove games that now have valid GOG storefront ratings
const titlesToRemove = new Set([
  'akalabeth',
  'akalabeth: world of doom',
  'beneath a steel sky',
  'bio menace',
  'dink smallwood hd',
  'flight of the amazon queen',
  'leap of faith + official walkthrough',
  'lure of the temptress',
  'lure of the temptress (1992)',
  'shadow warrior classic complete',
  'syndicate plus',
  'syndicate wars',
  'the life and suffering of sir brante - chapter 1 & 2',
  'tyrian 2000'
]);

for (const t of titlesToRemove) {
  const lineRegex = new RegExp(`\\s*\"${t.replace(/([.*+?^=!:${}()|\[\]\/\\])/g, '\\$1')}\",?\\n`, 'g');
  content = content.replace(lineRegex, '\n');
}

// 2. Parse KNOWN_CRITIC_SCORES JSON-like structure
const startIndex = content.indexOf('export const KNOWN_CRITIC_SCORES: Record<string | number, CriticScoreData> = {');
if (startIndex === -1) {
  console.error('Could not find KNOWN_CRITIC_SCORES opening declaration');
  process.exit(1);
}

const scoresBlock = content.substring(startIndex);
const jsonStart = scoresBlock.indexOf('{');
const jsonEnd = scoresBlock.lastIndexOf('};');

const jsonText = scoresBlock.substring(jsonStart, jsonEnd + 1);
const scores = JSON.parse(jsonText);

console.log('Current score entries:', Object.keys(scores).length);

// 3. Promote the 5 Metacritic games to Tier 1
const metacriticUpgrades = {
  '6920': {
    id: 'mc-deus-ex-invisible-war',
    source: 'metacritic',
    score: 84,
    tier: 'Mighty',
    numReviews: 50,
    url: 'https://www.metacritic.com/game/deus-ex-invisible-war/critic-reviews/',
    summary: 'Metacritic consensus score based on 50 critic reviews.',
    isVerified: true,
    isSynthetic: false
  },
  '1556200': {
    id: 'mc-predator-hunting-grounds',
    source: 'metacritic',
    score: 56,
    tier: 'Weak',
    numReviews: 62,
    url: 'https://www.metacritic.com/game/predator-hunting-grounds/critic-reviews/',
    summary: 'Metacritic consensus score based on 62 critic reviews.',
    isVerified: true,
    isSynthetic: false
  },
  '6060': {
    id: 'mc-star-wars-battlefront-ii-2005',
    source: 'metacritic',
    score: 83,
    tier: 'Strong',
    numReviews: 40,
    url: 'https://www.metacritic.com/game/star-wars-battlefront-ii-2005/critic-reviews/',
    summary: 'Metacritic consensus score based on 40 critic reviews.',
    isVerified: true,
    isSynthetic: false
  },
  '355790': {
    id: 'mc-styx-shards-of-darkness',
    source: 'metacritic',
    score: 72,
    tier: 'Fair',
    numReviews: 39,
    url: 'https://www.metacritic.com/game/styx-shards-of-darkness/critic-reviews/',
    summary: 'Metacritic consensus score based on 39 critic reviews.',
    isVerified: true,
    isSynthetic: false
  },
  '200170': {
    id: 'mc-worms-revolution',
    source: 'metacritic',
    score: 73,
    tier: 'Fair',
    numReviews: 21,
    url: 'https://www.metacritic.com/game/worms-revolution/critic-reviews/',
    summary: 'Metacritic consensus score based on 21 critic reviews.',
    isVerified: true,
    isSynthetic: false
  }
};

for (const [id, data] of Object.entries(metacriticUpgrades)) {
  scores[id] = data;
}

// Add title-based keys for the 5 Metacritic games
scores['deus ex 2 invisible war'] = metacriticUpgrades['6920'];
scores['deus ex invisible war'] = metacriticUpgrades['6920'];
scores['predator hunting grounds standard edition'] = metacriticUpgrades['1556200'];
scores['predator hunting grounds'] = metacriticUpgrades['1556200'];
scores['star wars battlefront ii classic 2005'] = metacriticUpgrades['6060'];
scores['star wars battlefront ii 2005'] = metacriticUpgrades['6060'];
scores['styx shards of darkness deluxe edition'] = metacriticUpgrades['355790'];
scores['styx shards of darkness'] = metacriticUpgrades['355790'];
scores['worms revolution gold edition'] = metacriticUpgrades['200170'];
scores['worms revolution'] = metacriticUpgrades['200170'];

// 4. Add Tier 5 Storefront Star Ratings (GOG)
const gogUpgrades = {
  'bio menace': {
    id: 'gog-bio_menace',
    source: 'gog',
    score: 82,
    starRatingRaw: 4.1,
    tier: 'Strong',
    numReviews: 301,
    url: 'https://www.gog.com/en/game/bio_menace',
    summary: 'Based on GOG player rating (4.1/5 stars across 301 reviews).',
    isVerified: false,
    isSynthetic: false
  },
  'flight of the amazon queen': {
    id: 'gog-flight_of_the_amazon_queen',
    source: 'gog',
    score: 82,
    starRatingRaw: 4.1,
    tier: 'Strong',
    numReviews: 509,
    url: 'https://www.gog.com/en/game/flight_of_the_amazon_queen',
    summary: 'Based on GOG player rating (4.1/5 stars across 509 reviews).',
    isVerified: false,
    isSynthetic: false
  },
  'lure of the temptress': {
    id: 'gog-lure_of_the_temptress',
    source: 'gog',
    score: 66,
    starRatingRaw: 3.3,
    tier: 'Fair',
    numReviews: 3005,
    url: 'https://www.gog.com/en/game/lure_of_the_temptress',
    summary: 'Based on GOG player rating (3.3/5 stars across 3,005 reviews).',
    isVerified: false,
    isSynthetic: false
  },
  'lure of the temptress 1992': {
    id: 'gog-lure_of_the_temptress',
    source: 'gog',
    score: 66,
    starRatingRaw: 3.3,
    tier: 'Fair',
    numReviews: 3005,
    url: 'https://www.gog.com/en/game/lure_of_the_temptress',
    summary: 'Based on GOG player rating (3.3/5 stars across 3,005 reviews).',
    isVerified: false,
    isSynthetic: false
  },
  'shadow warrior classic complete': {
    id: 'gog-shadow_warrior_complete',
    source: 'gog',
    score: 84,
    starRatingRaw: 4.2,
    tier: 'Mighty',
    numReviews: 848,
    url: 'https://www.gog.com/en/game/shadow_warrior_complete',
    summary: 'Based on GOG player rating (4.2/5 stars across 848 reviews).',
    isVerified: false,
    isSynthetic: false
  },
  'tyrian 2000': {
    id: 'gog-tyrian_2000',
    source: 'gog',
    score: 86,
    starRatingRaw: 4.3,
    tier: 'Mighty',
    numReviews: 4592,
    url: 'https://www.gog.com/en/game/tyrian_2000',
    summary: 'Based on GOG player rating (4.3/5 stars across 4,592 reviews).',
    isVerified: false,
    isSynthetic: false
  },
  'beneath a steel sky': {
    id: 'gog-beneath_a_steel_sky',
    source: 'gog',
    score: 86,
    starRatingRaw: 4.3,
    tier: 'Mighty',
    numReviews: 9649,
    url: 'https://www.gog.com/en/game/beneath_a_steel_sky',
    summary: 'Based on GOG player rating (4.3/5 stars across 9,649 reviews).',
    isVerified: false,
    isSynthetic: false
  },
  'beneath a steel sky 1994': {
    id: 'gog-beneath_a_steel_sky',
    source: 'gog',
    score: 86,
    starRatingRaw: 4.3,
    tier: 'Mighty',
    numReviews: 9649,
    url: 'https://www.gog.com/en/game/beneath_a_steel_sky',
    summary: 'Based on GOG player rating (4.3/5 stars across 9,649 reviews).',
    isVerified: false,
    isSynthetic: false
  },
  'dink smallwood hd': {
    id: 'gog-dink_smallwood_hd',
    source: 'gog',
    score: 84,
    starRatingRaw: 4.2,
    tier: 'Mighty',
    numReviews: 118,
    url: 'https://www.gog.com/en/game/dink_smallwood_hd',
    summary: 'Based on GOG player rating (4.2/5 stars across 118 reviews).',
    isVerified: false,
    isSynthetic: false
  },
  'syndicate plus': {
    id: 'gog-syndicate',
    source: 'gog',
    score: 92,
    starRatingRaw: 4.6,
    tier: 'Mighty',
    numReviews: 1513,
    url: 'https://www.gog.com/en/game/syndicate',
    summary: 'Based on GOG player rating (4.6/5 stars across 1,513 reviews).',
    isVerified: false,
    isSynthetic: false
  },
  'syndicate wars': {
    id: 'gog-syndicate_wars',
    source: 'gog',
    score: 86,
    starRatingRaw: 4.3,
    tier: 'Mighty',
    numReviews: 385,
    url: 'https://www.gog.com/en/game/syndicate_wars',
    summary: 'Based on GOG player rating (4.3/5 stars across 385 reviews).',
    isVerified: false,
    isSynthetic: false
  },
  'akalabeth world of doom': {
    id: 'gog-akalabeth_world_of_doom',
    source: 'gog',
    score: 68,
    starRatingRaw: 3.4,
    tier: 'Fair',
    numReviews: 277,
    url: 'https://www.gog.com/en/game/akalabeth_world_of_doom',
    summary: 'Based on GOG player rating (3.4/5 stars across 277 reviews).',
    isVerified: false,
    isSynthetic: false
  },
  'akalabeth': {
    id: 'gog-akalabeth_world_of_doom',
    source: 'gog',
    score: 68,
    starRatingRaw: 3.4,
    tier: 'Fair',
    numReviews: 277,
    url: 'https://www.gog.com/en/game/akalabeth_world_of_doom',
    summary: 'Based on GOG player rating (3.4/5 stars across 277 reviews).',
    isVerified: false,
    isSynthetic: false
  },
  'the life and suffering of sir brante chapter 1 2': {
    id: 'gog-the_life_and_suffering_of_sir_brante_chapter_12',
    source: 'gog',
    score: 84,
    starRatingRaw: 4.2,
    tier: 'Mighty',
    numReviews: 26,
    url: 'https://www.gog.com/en/game/the_life_and_suffering_of_sir_brante_chapter_12',
    summary: 'Based on GOG player rating (4.2/5 stars across 26 reviews).',
    isVerified: false,
    isSynthetic: false
  },
  'leap of faith official walkthrough': {
    id: 'gog-leap_of_faith',
    source: 'gog',
    score: 92,
    starRatingRaw: 4.6,
    tier: 'Mighty',
    numReviews: 308,
    url: 'https://www.gog.com/en/game/leap_of_faith',
    summary: 'Based on GOG player rating (4.6/5 stars across 308 reviews).',
    isVerified: false,
    isSynthetic: false
  },
  'ultima underworld 1 2': {
    id: 'gog-ultima_underworld_1_2',
    source: 'gog',
    score: 94,
    starRatingRaw: 4.7,
    tier: 'Mighty',
    numReviews: 1283,
    url: 'https://www.gog.com/en/game/ultima_underworld_1_2',
    summary: 'Based on GOG player rating (4.7/5 stars across 1,283 reviews).',
    isVerified: false,
    isSynthetic: false
  }
};

for (const [key, data] of Object.entries(gogUpgrades)) {
  scores[key] = data;
}

console.log('Updated total score entries:', Object.keys(scores).length);

const formattedJson = JSON.stringify(scores, null, 2);
const updatedFileContent =
  content.substring(0, startIndex) +
  'export const KNOWN_CRITIC_SCORES: Record<string | number, CriticScoreData> = ' +
  formattedJson +
  ';\n';

fs.writeFileSync(targetFile, updatedFileContent, 'utf8');
console.log('Successfully wrote updated knownCriticScores.ts');
