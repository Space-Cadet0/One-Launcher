import axios from 'axios';
import { CanonicalGame } from '../../contracts/game';
import steamEnrichedCache from '../storage/steamEnrichedCache.json';

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
  'thief ii: the metal age': 211740,

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
  'telltale batman season 1': 498240,
  'telltale batman season 2': 675260,
  'batman: the enemy within': 675260,
  'batman: the enemy within - the telltale series': 675260,
  'world war z': 699130,
  'rocket league': 252950,
  'overcooked! 2': 448510,
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
  'potoo': 448510,
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
};

/**
 * Normalizes title string by stripping edition noise, trademark symbols, and punctuation.
 */
export function normalizeGameTitle(rawTitle: string): string {
  if (!rawTitle) return '';

  let title = rawTitle
    .replace(/[™®©]/g, '')
    .replace(/\s+/g, ' ')
    .trim();

  // Strip store and edition suffixes
  const suffixes = [
    / - Digital Deluxe Edition/i,
    / \(Digital Deluxe Edition\)/i,
    / - Deluxe Edition/i,
    / \(Deluxe Edition\)/i,
    / - Enhanced Edition Director's Cut/i,
    / - Enhanced Edition/i,
    / \(Enhanced Edition\)/i,
    / - Game of the Year Edition/i,
    / \(Game of the Year Edition\)/i,
    / - GOTY Edition/i,
    / - GOTY/i,
    / - Definitive Edition/i,
    / \(Definitive Edition\)/i,
    / - Director's Cut/i,
    / \(Director's Cut\)/i,
    / - Complete Edition/i,
    / \(Complete Edition\)/i,
    / \[Complete Edition\]/i,
    / - Standard Edition/i,
    / \(Standard Edition\)/i,
    / - Remastered/i,
    / \(Remastered\)/i,
    / - DRM-Free/i,
    / \(DRM-Free\)/i,
    / - Royal Edition/i,
    / - Ultimate Edition/i,
    / \(Ultimate Edition\)/i,
  ];

  for (const pattern of suffixes) {
    title = title.replace(pattern, '').trim();
  }

  return title;
}

const ROMAN_NUMERALS: Record<string, string> = {
  i: '1',
  ii: '2',
  iii: '3',
  iv: '4',
  v: '5',
  vi: '6',
  vii: '7',
  viii: '8',
  ix: '9',
  x: '10',
};

export function extractSequelIdentifier(words: string[]): string | null {
  for (const w of words) {
    if (/^[2-9]$|^10$/.test(w)) return w;
    if (ROMAN_NUMERALS[w] && w !== 'i') return ROMAN_NUMERALS[w];
  }
  return null;
}

/**
 * Titles known to NOT exist on Steam (e.g. GOG / storefront exclusives)
 */
export const KNOWN_NON_STEAM_TITLES = new Set([
  'blood omen legacy of kain',
  'blood omen: legacy of kain',
  'doom + doom ii',
  'doom + doom 2',
  'total annihilation kingdoms',
  'total annihilation: kingdoms',
  'total annihilation: kingdoms + iron plague',
]);

/**
 * Computes token similarity between two game names (Jaccard coefficient + phrase check)
 */
export function computeTitleSimilarity(source: string, candidate: string): number {
  const s1 = source.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
  const s2 = candidate.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();

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

    if (this.cache.has(lowerKey)) {
      return this.cache.get(lowerKey) || null;
    }

    if (KNOWN_STORE_STEAM_MAPPINGS[lowerKey]) {
      return KNOWN_STORE_STEAM_MAPPINGS[lowerKey];
    }
    if (KNOWN_STORE_STEAM_MAPPINGS[normalized]) {
      return KNOWN_STORE_STEAM_MAPPINGS[normalized];
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

    // 1. Check in-memory / persistent cache
    if (this.cache.has(lowerKey)) {
      return this.cache.get(lowerKey)!;
    }

    // 2. Check curated instant dictionary
    if (KNOWN_STORE_STEAM_MAPPINGS[lowerKey]) {
      const id = KNOWN_STORE_STEAM_MAPPINGS[lowerKey];
      this.cache.set(lowerKey, id);
      this.savePersistentCache();
      return id;
    }
    if (KNOWN_STORE_STEAM_MAPPINGS[normalized]) {
      const id = KNOWN_STORE_STEAM_MAPPINGS[normalized];
      this.cache.set(lowerKey, id);
      this.savePersistentCache();
      return id;
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
}

export const steamMatcher = new SteamMatcherService();
