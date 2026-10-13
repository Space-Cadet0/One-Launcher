import axios from 'axios';
import { CanonicalGame } from '../../contracts/game';
import steamEnrichedCache from '../storage/steamEnrichedCache.json';
import {
  normalizeTitleKey,
  stripEditionSuffix,
  extractSequelIdentifier as commonExtractSequelIdentifier,
  isSequelMismatch as commonIsSequelMismatch,
  ROMAN_TO_ARABIC,
  EDITION_TOKENS,
} from '../common/titleUtils';

/**
 * Curated high-confidence mapping for hundreds of popular multi-store & cross-platform titles.
 * Guarantees instantaneous, 100% accurate matching without network latency.
 */
export const KNOWN_STORE_STEAM_MAPPINGS: Record<string, number> = {
  // CD PROJEKT RED
  'cyberpunk 2077': 1091500,
  'cyberpunk 2077: phantom liberty': 1091500,
  'the witcher 3: wild hunt': 292030,
  'the witcher 3: wild hunt - complete edition': 292030,
  'the witcher 3: wild hunt - game of the year edition': 292030,
  'the witcher 2: assassins of kings enhanced edition': 20920,
  'the witcher: enhanced edition': 20900,
  'the witcher: enhanced edition director\'s cut': 20900,
  'flight of the amazon queen': 561360,
  // Larian Studios
  'baldur\'s gate 3': 1086940,
  'baldur\'s gate: enhanced edition': 228280,
  'baldur\'s gate ii: enhanced edition': 257350,
  'divinity: original sin 2 - definitive edition': 435150,
  'divinity: original sin 2': 435150,
  'divinity: original sin enhanced edition': 373420,

  // Bethesda / Obsidian / id
  'fallout': 38400,
  'fallout 2': 38410,
  'fallout tactics': 38420,
  'fallout: new vegas': 22380,
  'fallout: new vegas ultimate edition': 22380,
  'fallout 3': 22370,
  'fallout 3: game of the year edition': 22370,
  'fallout 4': 377160,
  'fallout 4: game of the year edition': 377160,
  'the elder scrolls v: skyrim special edition': 489830,
  'the elder scrolls v: skyrim': 72850,
  'the elder scrolls iv: oblivion': 22330,
  'the elder scrolls iii: morrowind': 22320,
  'doom': 379720,
  'doom eternal': 782330,
  'doom 3': 9050,
  'doom 3: bfg edition': 208200,
  'doom 3 bfg edition': 208200,
  'final doom': 2290,
  'doom ii': 2300,
  'dishonored': 205100,
  'dishonored - definitive edition': 205100,
  'dishonored 2': 403640,
  'dishonored: death of the outsider': 614570,
  'prey': 480490,

  // Epic / Remedy / 505
  'doki doki literature club plus!': 1388880,
  'control': 870780,
  'control ultimate edition': 870780,
  'death stranding': 1190460,
  'death stranding director\'s cut': 1850570,
  'hades': 1145360,
  'hollow knight': 367520,
  'disco elysium': 632470,
  'disco elysium - the final cut': 632470,
  'ghostrunner': 1139900,
  'ghostrunner 2': 2144740,
  'second extinction': 1024380,
  'out of sight': 2526310,
  'a plague tale: innocence': 752590,
  'a plague tale: requiem': 1182900,
  'sifu': 2138710,
  'chivalry 2': 1824220,
  "demon's tilt": 422510,
  'demons tilt': 422510,
  'airship kingdoms adrift': 1597310,
  'ascendant': 296930,
  'doors - paradox': 1622770,
  'doors paradox': 1622770,
  'electrician simulator': 1080020,
  'first class trouble': 953880,
  'godzilla voxel wars': 2450820,
  'golden light': 1245430,
  'halcyon 6': 371200,
  'havendock': 2020710,
  'legion td 2': 469600,
  'lost castle': 434650,
  'mechabellum': 983310,
  'paquerette down the bunburrows': 1628610,
  'sands of aura': 1119840,
  'the ouroboros king': 2014620,
  'vampire: the masquerade - reckoning of new york': 2658030,
  'telltale batman season 1': 498240,
  'telltale batman season 2': 675260,

  // Rockstar & 2K
  'grand theft auto v': 271590,
  'grand theft auto iv: the complete edition': 12210,
  'red dead redemption 2': 1174180,
  'borderlands 2': 49520,
  'borderlands 3': 397540,
  'bioshock remastered': 409710,
  'bioshock 2 remastered': 409720,
  'bioshock infinite': 8870,
  'sid meier\'s civilization vi': 289070,
  'civilization vi': 289070,
  'xcom 2': 268500,
  'xcom: enemy unknown': 200510,
  'xcom enemy unknown': 200510,
  'xcom: enemy unknown complete pack': 200510,
  'xcom enemy unknown complete pack': 200510,

  // Warner Bros
  'batman: arkham knight': 208650,
  'batman: arkham city - goty edition': 200260,
  'batman: arkham city': 200260,
  'batman: arkham asylum game of the year edition': 35140,
  'batman: arkham asylum': 35140,
  'mad max': 234140,
  'middle-earth: shadow of mordor': 241930,
  'middle-earth: shadow of war': 356190,

  // Square Enix / Eidos
  'deus ex: human revolution - director\'s cut': 238010,
  'deus ex: mankind divided': 337000,
  'deus ex: game of the year edition': 6910,
  'tomb raider': 203160,
  'rise of the tomb raider': 391220,
  'shadow of the tomb raider: definitive edition': 750920,
  'sleeping dogs: definitive edition': 307690,
  'thief': 239160,
  'thief gold': 211600,
  'thief 2: the metal age': 211740,
  'thief 2 the metal age': 211740,
  'thief ii: the metal age': 211740,
  'thief ii the metal age': 211740,
  'thief 3: deadly shadows': 6980,
  'thief 3 deadly shadows': 6980,
  'thief: deadly shadows': 6980,
  'thief deadly shadows': 6980,
  'predator: hunting grounds': 1556200,
  'predator hunting grounds': 1556200,
  'predator: hunting grounds standard edition': 1556200,
  'predator hunting grounds standard edition': 1556200,

  // Deep Silver / 4A Games
  'metro 2033 redux': 286690,
  'metro: last light redux': 287390,
  'metro exodus': 412020,
  'saints row: the third remastered': 978300,
  'saints row iv: re-elected': 206420,
  'dead island definitive edition': 383150,

  // GOG Classics & Indie Gems
  's.t.a.l.k.e.r.: shadow of chernobyl': 4500,
  's.t.a.l.k.e.r.: clear sky': 20510,
  's.t.a.l.k.e.r.: call of pripyat': 41700,
  'heroes of might and magic 3 - hd edition': 297000,
  'heroes of might & magic iii - hd edition': 297000,
  'vampire: the masquerade - bloodlines': 2600,
  'star wars: knights of the old republic': 32370,
  'star wars: knights of the old republic ii': 208580,
  'dragon age: origins - ultimate edition': 47810,
  'mass effect legendary edition': 1328670,
  'frostpunk': 323190,
  'this war of mine': 282070,
  'subnautica': 264710,
  'subnautica: below zero': 848450,
  'outer wilds': 753640,
  'the outer worlds': 578650,
  'slay the spire': 646570,
  'dead cells': 588650,
  'celeste': 504230,
  'inside': 304430,
  'limbo': 48000,
  'stardew valley': 413150,
  'terraria': 105600,
  'cuphead': 268910,
  'risk of rain 2': 632360,
  'deep rock galactic': 548430,
  'no man\'s sky': 275850,
  'remnant: from the ashes': 617290,
  'remnant ii': 1282100,
  'darksiders warmastered edition': 462780,
  'darksiders ii deathinitive edition': 388410,
  'darksiders iii': 606280,
  'shadowrun returns': 234650,
  'shadowrun: dragonfall - director\'s cut': 300550,
  'shadowrun: hong kong - extended edition': 346940,
  'wasteland 2: director\'s cut': 240760,
  'wasteland 3': 770300,
  'pillars of eternity': 291650,
  'pillars of eternity ii: deadfire': 560130,
  'tyranny': 362960,
  'torment: tides of numenera': 272270,
  'neverwinter nights: enhanced edition': 704450,
  'planescape: torment: enhanced edition': 466300,
  'icewind dale: enhanced edition': 321800,
  'system shock: enhanced edition': 410710,
  'system shock 2': 238210,
  'system shock': 482400,
  'kingdom come: deliverance': 379430,
  'kingdom come: deliverance royal edition': 379430,
  'alien: isolation': 214490,
  'amnesia: the dark descent': 57300,
  'amnesia: a machine for pigs': 239200,
  'amnesia: rebirth': 999220,
  'amnesia: the bunker': 1944430,
  'soma': 282140,
  'outlast': 238320,
  'outlast 2': 414700,

  // Epic Games Codenames & Store Exclusives
  'into the breach': 590380,
  'hitman': 236870,
  'human resource machine': 375820,
  'batman - the telltale series': 498240,
  'batman: the telltale series': 498240,
  'the telltale batman shadows edition': 498240,
  'batman: the enemy within': 675260,
  'batman: the enemy within - the telltale series': 675260,
  'world war z': 699130,
  'rocket league': 252950,
  'overcooked! 2': 728880,
  'overcooked 2': 728880,
  'yooka-laylee and the impossible lair': 1084600,
  'minit': 609490,
  'brothers - a tale of two sons': 225080,
  'mutant year zero: road to eden': 760060,
  'tacoma': 643880,
  'farming simulator 19': 787860,
  'dragon age: inquisition': 1222690,
  'super meat boy': 40800,
  'dead by daylight': 381210,
  'the bridge': 230050,
  'boga': 1190460,
  'blobfish': 590380,
  'barbet': 236870,
  'basil': 375820,
  'batfish': 498240,
  'batfishs2': 675260,
  'wombat': 699130,
  'speedwell': 287390,
  'sugar': 252950,
  'potoo': 728880,
  'duckbill': 1084600,
  'petrel': 609490,
  'tamarind': 225080,
  'dodo': 49520,
  'falcon': 760060,
  'flagfin': 643880,
  'stellula': 787860,
  'verdi': 1222690,
  'peppermint': 1824220,
  'buffalo': 40800,
  'brill': 381210,
  'sunbird': 230050,

  // Additional Store Matches
  'rollercoaster tycoon 3: complete edition': 1368820,
  'rollercoaster tycoon 3 complete edition': 1368820,
  'rollercoaster tycoon 3': 1368820,
  'higurashi when they cry hou - ch.1 onikakushi': 310360,
  'higurashi when they cry hou ch.1 onikakushi': 310360,
  'higurashi when they cry hou ch 1 onikakushi': 310360,
  'doom (2016)': 379720,
  'rpg maker xp': 235900,
  'resident evil requiem': 3764200,
  'heretic + hexen': 3286930,
  'heretic hexen': 3286930,

  // Curated Store Matches
  'agony': 487720,
  'agony unrated': 879420,
  'darq': 433550,
  'darq: complete edition': 433550,
  'darq complete edition': 433550,
  'grip': 396900,
  'grip: combat racing': 396900,
  'grip combat racing': 396900,
  'deus ex goty edition': 6910,
  'deus ex: goty edition': 6910,
  'deus ex game of the year edition': 6910,
  'deus ex goty': 6910,
  'deus ex': 6910,
  'tomb raider goty': 203160,
  'tomb raider: goty': 203160,
  'tomb raider goty edition': 203160,
  'tomb raider: game of the year edition': 203160,
  'tomb raider game of the year edition': 203160,
  'eschalon: book i': 25600,
  'eschalon book i': 25600,
  'eschalon book 1': 25600,
  'eschalon: book 1': 25600,
  'fate': 246840,
  'fate: undiscovered realms': 276890,
  'fate undiscovered realms': 276890,
  'gamedec': 917720,
  'gamedec: definitive edition': 917720,
  'gamedec definitive edition': 917720,
  'shadowrun: hong kong': 346940,
  'shadowrun hong kong': 346940,
  'shadowrun hong kong - extended edition': 346940,
  'shadowrun hong kong extended edition': 346940,
  'deus ex: invisible war': 6920,
  'deus ex invisible war': 6920,
  'deus ex 2: invisible war': 6920,
  'deus ex 2 invisible war': 6920,
  'deus ex: human revolution - director’s cut': 238010,
  'deus ex human revolution director\'s cut': 238010,
  'deus ex human revolution directors cut': 238010,
  'deus ex: human revolution': 238010,
  'deus ex human revolution': 238010,
  'lacuna': 1365860,
  'lacuna – a sci-fi noir adventure': 1365860,
  'lacuna: a sci-fi noir adventure': 1365860,
  'lacuna a sci fi noir adventure': 1365860,
};

/**
 * Canonicalizes title strings by stripping punctuation, trademark symbols, and whitespace.
 */
export function canonicalizeTitleKey(str: string): string {
  if (!str) return '';
  return str
    .toLowerCase()
    .replace(/[™®©]/g, '')
    .replace(/['’]/g, '')
    .replace(/[:\-–—]/g, ' ')
    .replace(/\s*\((?:19|20)\d{2}\)/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Normalizes title string by stripping edition noise, trademark symbols, and punctuation.
 */
export function normalizeGameTitle(rawTitle: string): string {
  if (!rawTitle) return '';

  let title = rawTitle
    .replace(/[™®©]/g, '')
    .replace(/\s*\((?:19|20)\d{2}\)/g, '')
    .replace(/\s+/g, ' ')
    .trim();

  // Strip store and edition suffixes (allowing optional colon/hyphen/brackets/parens and optional curly/straight apostrophes)
  const suffixes = [
    /(?::|\s+-|\s+–|\s+—|\s+)?\s*(?:\(|\[)?\s*(?:Digital Deluxe|Deluxe|Enhanced Edition Director['’]?s Cut|Enhanced|Game of the Year|GOTY|Definitive|Extended|Director['’]?s Cut|Complete|Standard|Remastered|DRM-Free|Royal|Ultimate|The Final Cut|Emperor|Gold|Collector['’]?s|Anniversary)\s+Edition(?:\)|\])?/gi,
    /(?::|\s+-|\s+–|\s+—|\s+)?\s*(?:\(|\[)?\s*(?:Director['’]?s Cut|The Final Cut|GOG Cut|Remastered|GOTY)(?:\)|\])?/gi,
  ];

  for (const pattern of suffixes) {
    title = title.replace(pattern, '').trim();
  }

  // Normalize quotes and spaces
  title = title
    .replace(/['’]/g, '')
    .replace(/\s+/g, ' ')
    .trim();

  return title;
}

// Canonical lookup map pre-populated for fast O(1) matching across all variations
export const CANONICAL_KNOWN_STORE_STEAM_MAPPINGS = new Map<string, number>();

for (const [key, appId] of Object.entries(KNOWN_STORE_STEAM_MAPPINGS)) {
  CANONICAL_KNOWN_STORE_STEAM_MAPPINGS.set(key.toLowerCase().trim(), appId);
  CANONICAL_KNOWN_STORE_STEAM_MAPPINGS.set(canonicalizeTitleKey(key), appId);
  CANONICAL_KNOWN_STORE_STEAM_MAPPINGS.set(normalizeGameTitle(key).toLowerCase(), appId);
  CANONICAL_KNOWN_STORE_STEAM_MAPPINGS.set(canonicalizeTitleKey(normalizeGameTitle(key)), appId);
  CANONICAL_KNOWN_STORE_STEAM_MAPPINGS.set(normalizeTitleKey(key), appId);
  CANONICAL_KNOWN_STORE_STEAM_MAPPINGS.set(stripEditionSuffix(key), appId);
}

export function extractSequelIdentifier(words: string[] | string): string | null {
  return commonExtractSequelIdentifier(words);
}

/**
 * Titles known to NOT exist on Steam (e.g. GOG / storefront exclusives)
 */
export const KNOWN_NON_STEAM_TITLES = new Set([
  'blood omen legacy of kain',
  'blood omen: legacy of kain',
  'cyberpunk 2077 digital goodies',
  'doom + doom ii',
  'doom + doom 2',
  'doom doom 2',
  'quake ii (original)',
  'quake ii original',
  'quake 2 original',
  'quake 2 (original)',
  'total annihilation kingdoms',
  'total annihilation: kingdoms',
  'total annihilation: kingdoms + iron plague',
]);

export const EDITION_WORDS: Set<string> = EDITION_TOKENS;

/**
 * Computes token similarity between two game names (Jaccard coefficient + phrase check)
 */
export function computeTitleSimilarity(source: string, candidate: string): number {
  const s1 = source.toLowerCase().replace(/[™®©]/g, '').replace(/['’]/g, '').replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
  const s2 = candidate.toLowerCase().replace(/[™®©]/g, '').replace(/['’]/g, '').replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();

  if (!s1 || !s2) return 0;
  if (s1 === s2) return 1.0;

  const words1 = s1.split(' ').filter(Boolean);
  const words2 = s2.split(' ').filter(Boolean);

  // Strict sequel verification:
  // If one title has a sequel number (e.g. "Blood Omen 2") and the other does not ("Blood Omen"),
  // or they have different sequel numbers ("Doom" vs "Doom II", "Witcher 2" vs "Witcher 3"), THEY NEVER MATCH!
  const seq1 = extractSequelIdentifier(words1);
  const seq2 = extractSequelIdentifier(words2);
  if (seq1 !== seq2) {
    return 0;
  }

  if (commonIsSequelMismatch(source, candidate)) {
    return 0;
  }

  const tokens1 = new Set(words1);
  const tokens2 = new Set(words2);

  let intersection = 0;
  for (const t of tokens1) {
    if (tokens2.has(t)) intersection++;
  }

  const union = new Set([...tokens1, ...tokens2]).size;
  if (union === 0) return 0;
  const jaccard = intersection / union;

  // Single word checks: must match an exact word token in candidate!
  // e.g. "boga" does NOT match "path of the bogatyr"!
  if (words1.length === 1 && !tokens2.has(words1[0])) {
    return 0;
  }
  if (words2.length === 1 && !tokens1.has(words2[0])) {
    return 0;
  }

  // Intelligent Edition Variant Matching (e.g. "DARQ" <-> "DARQ: Complete Edition", "Control" <-> "Control Ultimate Edition")
  const [shorterWords, longerWords] = words1.length <= words2.length ? [words1, words2] : [words2, words1];
  const shorterSet = new Set(shorterWords);
  const longerSet = new Set(longerWords);

  let allShorterInLonger = true;
  for (const w of shorterWords) {
    if (!longerSet.has(w)) {
      allShorterInLonger = false;
      break;
    }
  }

  if (allShorterInLonger) {
    let onlyEditionTokensRemaining = true;
    for (const w of longerWords) {
      if (!shorterSet.has(w) && !EDITION_WORDS.has(w) && w !== 'the' && w !== 'of' && w !== 'a' && w !== 'an') {
        onlyEditionTokensRemaining = false;
        break;
      }
    }
    if (onlyEditionTokensRemaining) {
      return 0.92;
    }
  }

  // Exact multi-word phrase containment
  if (words1.length >= 2 && (s1.includes(s2) || s2.includes(s1))) {
    const minWords = Math.min(words1.length, words2.length);
    const maxWords = Math.max(words1.length, words2.length);
    if (minWords / maxWords >= 0.5 && intersection >= minWords) {
      return 0.88;
    }
  }

  return jaccard;
}

const STORAGE_KEY_MATCHED_APP_IDS = 'antigravity_steam_matched_app_ids';

export class SteamMatcherService {
  private cache = new Map<string, number | null>();

  constructor() {
    this.loadPersistentCache();
  }

  private loadPersistentCache() {
    if (typeof window === 'undefined') return;
    try {
      const raw = localStorage.getItem(STORAGE_KEY_MATCHED_APP_IDS);
      if (raw) {
        const parsed = JSON.parse(raw);
        for (const [k, v] of Object.entries(parsed)) {
          const lk = k.toLowerCase();
          // Purge stale false matches for codenames like boga -> Path of the Bogatyr
          if (lk === 'boga' && v !== 1190460) continue;
          if (lk === 'blobfish' && v !== 590380) continue;
          if (lk === 'barbet' && v !== 236870) continue;
          if (lk === 'basil' && v !== 375820) continue;
          if (lk === 'batfish' && v !== 498240) continue;
          if (
            (lk.includes('blood omen') && !lk.includes('2') && !lk.includes('ii') && v === 242960) ||
            lk.includes('doom + doom ii') ||
            lk.includes('total annihilation: kingdoms')
          ) {
            continue;
          }
          this.cache.set(lk, typeof v === 'number' ? v : null);
        }
      }
    } catch {
      // Ignore read errors
    }
  }

  private savePersistentCache() {
    if (typeof window === 'undefined') return;
    try {
      const obj: Record<string, number | null> = {};
      for (const [k, v] of this.cache.entries()) {
        obj[k] = v;
      }
      localStorage.setItem(STORAGE_KEY_MATCHED_APP_IDS, JSON.stringify(obj));
    } catch {
      // Ignore write errors
    }
  }

  private getStoreSearchBaseUrl(): string {
    if (typeof window !== 'undefined' && window.location.hostname === 'localhost') {
      return '/api/steam-store';
    }
    return 'https://store.steampowered.com';
  }

  /**
   * Fast, synchronous lookup against curated mappings and local caches without network requests
   */
  matchGameToSteamInstant(title: string): number | null {
    if (!title || !title.trim()) return null;
    const cleanRaw = title.trim();
    const lowerKey = cleanRaw.toLowerCase();

    const normalized = normalizeGameTitle(cleanRaw).toLowerCase();
    if (KNOWN_NON_STEAM_TITLES.has(lowerKey) || KNOWN_NON_STEAM_TITLES.has(normalized)) {
      return null;
    }

    // 1. Authoritative curated dictionary check FIRST (overrides any stale negative cache)
    const canonicalKey = canonicalizeTitleKey(cleanRaw);
    const canonicalNorm = canonicalizeTitleKey(normalized);

    const directMatch =
      CANONICAL_KNOWN_STORE_STEAM_MAPPINGS.get(lowerKey) ||
      CANONICAL_KNOWN_STORE_STEAM_MAPPINGS.get(normalized) ||
      CANONICAL_KNOWN_STORE_STEAM_MAPPINGS.get(canonicalKey) ||
      CANONICAL_KNOWN_STORE_STEAM_MAPPINGS.get(canonicalNorm) ||
      CANONICAL_KNOWN_STORE_STEAM_MAPPINGS.get(normalizeTitleKey(cleanRaw)) ||
      CANONICAL_KNOWN_STORE_STEAM_MAPPINGS.get(stripEditionSuffix(cleanRaw));

    if (directMatch) {
      this.cache.set(lowerKey, directMatch);
      return directMatch;
    }

    // 2. Check in-memory / persistent cache
    if (this.cache.has(lowerKey)) {
      return this.cache.get(lowerKey) || null;
    }

    for (const [idStr, data] of Object.entries(steamEnrichedCache as Record<string, any>)) {
      if (data?.name && computeTitleSimilarity(normalized, data.name) >= 0.88) {
        return parseInt(idStr, 10);
      }
    }

    return null;
  }

  /**
   * Intelligently matches any game title to its official Steam App ID.
   * Returns Steam App ID if found, or null if game does not exist on Steam.
   */
  async matchGameToSteam(title: string): Promise<number | null> {
    if (!title || !title.trim()) return null;
    const cleanRaw = title.trim();
    const lowerKey = cleanRaw.toLowerCase();

    const normalized = normalizeGameTitle(cleanRaw).toLowerCase();
    if (KNOWN_NON_STEAM_TITLES.has(lowerKey) || KNOWN_NON_STEAM_TITLES.has(normalized)) {
      this.cache.set(lowerKey, null);
      this.savePersistentCache();
      return null;
    }

    // 1. Authoritative curated dictionary check FIRST (overrides any stale negative cache)
    const canonicalKey = canonicalizeTitleKey(cleanRaw);
    const canonicalNorm = canonicalizeTitleKey(normalized);

    const directMatch =
      CANONICAL_KNOWN_STORE_STEAM_MAPPINGS.get(lowerKey) ||
      CANONICAL_KNOWN_STORE_STEAM_MAPPINGS.get(normalized) ||
      CANONICAL_KNOWN_STORE_STEAM_MAPPINGS.get(canonicalKey) ||
      CANONICAL_KNOWN_STORE_STEAM_MAPPINGS.get(canonicalNorm) ||
      CANONICAL_KNOWN_STORE_STEAM_MAPPINGS.get(normalizeTitleKey(cleanRaw)) ||
      CANONICAL_KNOWN_STORE_STEAM_MAPPINGS.get(stripEditionSuffix(cleanRaw));

    if (directMatch) {
      this.cache.set(lowerKey, directMatch);
      this.savePersistentCache();
      return directMatch;
    }

    // 2. Check in-memory / persistent cache
    if (this.cache.has(lowerKey)) {
      return this.cache.get(lowerKey)!;
    }

    if (directMatch) {
      this.cache.set(lowerKey, directMatch);
      this.savePersistentCache();
      return directMatch;
    }

    // 3. Check existing local steamEnrichedCache.json
    for (const [idStr, data] of Object.entries(steamEnrichedCache as Record<string, any>)) {
      if (data?.name && computeTitleSimilarity(normalized, data.name) >= 0.85) {
        const appId = parseInt(idStr, 10);
        this.cache.set(lowerKey, appId);
        this.savePersistentCache();
        return appId;
      }
    }

    // 4. Dynamic Multi-Strategy Steam Store Search
    const searchStrategies = [
      normalized,                                     // Strategy 1: Normalized clean title
      cleanRaw,                                       // Strategy 2: Exact raw title
      normalized.split(':')[0].trim(),                 // Strategy 3: Base title without subtitle
      normalized.split('-')[0].trim(),                 // Strategy 4: Base title before dash
      normalized.replace(/^(the|a|an)\s+/i, '').trim(), // Strategy 5: Without leading article
    ];

    const uniqueTerms = Array.from(new Set(searchStrategies.filter((s) => s.length >= 3)));

    for (const term of uniqueTerms) {
      try {
        const baseUrl = this.getStoreSearchBaseUrl();
        const res = await axios.get(
          `${baseUrl}/api/storesearch/?term=${encodeURIComponent(term)}&l=english&cc=US`,
          { timeout: 7000 }
        );

        const items = res.data?.items;
        if (Array.isArray(items) && items.length > 0) {
          // Score and rank candidates, filtering out DLC, soundtracks, and bonus items
          let bestCandidate: { id: number; score: number } | null = null;

          for (const item of items) {
            const candidateName = (item.name || '').trim();
            const candLower = candidateName.toLowerCase();

            // Reject DLCs, Soundtracks, Demos, Artbooks
            const isJunkCandidate =
              candLower.includes('soundtrack') ||
              candLower.includes(' ost') ||
              candLower.includes('bonus content') ||
              candLower.includes('artbook') ||
              candLower.includes(' dedicated server') ||
              candLower.includes(' sdk') ||
              candLower.includes('vr experience') ||
              candLower.endsWith(' demo');

            if (isJunkCandidate && !lowerKey.includes('soundtrack') && !lowerKey.includes('demo')) {
              continue;
            }

            const sim = computeTitleSimilarity(normalized, candidateName);

            // Give bonus for matching base keywords
            let score = sim * 100;
            if (candLower === normalized) score += 20;

            if (score >= 68 && (!bestCandidate || score > bestCandidate.score)) {
              bestCandidate = { id: item.id, score };
            }
          }

          if (bestCandidate) {
            this.cache.set(lowerKey, bestCandidate.id);
            this.savePersistentCache();
            return bestCandidate.id;
          }
        }
      } catch (err: any) {
        // If rate-limited or network error, stop dynamic search for this request
        break;
      }
    }

    // Game does not exist on Steam (or is store exclusive)
    this.cache.set(lowerKey, null);
    this.savePersistentCache();
    return null;
  }

  /**
   * Enriches a CanonicalGame with Steam App ID and official Steam assets if matched.
   */
  async enrichGameWithSteamMatch(game: CanonicalGame): Promise<CanonicalGame> {
    if (game.steamAppId) return game;

    const matchedId = await this.matchGameToSteam(game.title);
    if (!matchedId) return game;

    return {
      ...game,
      steamAppId: matchedId,
      id: `steam-${matchedId}`,
      headerImage: `https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/${matchedId}/header.jpg`,
      capsuleImage: `https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/${matchedId}/library_600x900_2x.jpg`,
    };
  }

  /**
   * Resolves the authoritative Steam App ID for a game, respecting explicit non-Steam flags
   * and manual null overrides, falling back to instant high-confidence matching.
   */
  getEffectiveSteamAppId(game?: {
    steamAppId?: number | null;
    isExplicitNonSteam?: boolean;
    title?: string;
  } | null): number | undefined {
    if (!game) return undefined;
    if (game.isExplicitNonSteam === true) return undefined;
    if (typeof game.steamAppId === 'number' && game.steamAppId > 0) return game.steamAppId;
    if (game.steamAppId === null) return undefined;
    if (game.title) {
      return this.matchGameToSteamInstant(game.title) || undefined;
    }
    return undefined;
  }

  normalizeTitleKey(title: string): string {
    return normalizeTitleKey(title);
  }

  stripEditionSuffix(title: string): string {
    return stripEditionSuffix(title);
  }
}

export const steamMatcher = new SteamMatcherService();

/**
 * Resolves the authoritative Steam App ID for a game, respecting explicit non-Steam flags
 * and manual null overrides, falling back to instant high-confidence matching.
 */
export function getEffectiveSteamAppId(game?: {
  steamAppId?: number | null;
  isExplicitNonSteam?: boolean;
  title?: string;
} | null): number | undefined {
  return steamMatcher.getEffectiveSteamAppId(game);
}

export {
  normalizeTitleKey,
  stripEditionSuffix,
  ROMAN_TO_ARABIC,
  EDITION_TOKENS,
};
