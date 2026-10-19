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
import { computeEntityMatchConfidence } from '../common/entityResolver';
import { requestScheduler, Priority } from '../network/requestScheduler';
import { TIER_TTLS } from '../storage/stagedCacheService';

/**
 * Optional static Steam AppID mapping table (empty by default for universal dynamic resolution).
 */
export const KNOWN_STORE_STEAM_MAPPINGS: Record<string, number> = {};

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
    /(?::|\s+-|\s+–|\s+—|\s+)?\s*(?:\(|\[)?\s*(?:Digital Deluxe|Deluxe|Enhanced Edition Director['’]?s Cut|Enhanced|Game of the Year|GOTY|Definitive|Extended|Director['’]?s Cut|Complete|Standard|Remastered|DRM-Free|Royal|Ultimate|The Final Cut|Emperor|Gold|Collector['’]?s|Anniversary)\s+(?:Edition|Pack|Bundle|Collection)(?:\)|\])?/gi,
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
 * Titles known to NOT exist on Steam (empty by default for universal dynamic resolution)
 */
export const KNOWN_NON_STEAM_TITLES = new Set<string>();

export const EDITION_WORDS: Set<string> = EDITION_TOKENS;

const DISJOINT_STOP_WORDS = new Set<string>([
  'the',
  'a',
  'an',
  'of',
  'in',
  'on',
  'at',
  'to',
  'for',
  'and',
  'or',
  'is',
  'with',
  'from',
  'by',
]);

/**
 * Computes token similarity between two game names (Jaccard coefficient + phrase check)
 */
export function computeTitleSimilarity(source: string, candidate: string): number {
  const s1 = source.toLowerCase().replace(/[™®©]/g, '').replace(/['’]/g, '').replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
  const s2 = candidate.toLowerCase().replace(/[™®©]/g, '').replace(/['’]/g, '').replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();

  if (!s1 || !s2) return 0;
  if (s1 === s2) return 1.0;

  const rawWords1 = s1.split(' ').filter(Boolean);
  const rawWords2 = s2.split(' ').filter(Boolean);

  // Strict sequel verification:
  // If one title has a sequel number (e.g. "Blood Omen 2") and the other does not ("Blood Omen"),
  // or they have different sequel numbers ("Doom" vs "Doom II", "Witcher 2" vs "Witcher 3"), THEY NEVER MATCH!
  const seq1 = extractSequelIdentifier(rawWords1);
  const seq2 = extractSequelIdentifier(rawWords2);
  if (seq1 !== seq2) {
    return 0;
  }

  if (commonIsSequelMismatch(source, candidate)) {
    return 0;
  }

  const words1 = seq1 !== null ? rawWords1.map((w) => ROMAN_TO_ARABIC[w] || w) : rawWords1;
  const words2 = seq2 !== null ? rawWords2.map((w) => ROMAN_TO_ARABIC[w] || w) : rawWords2;

  if (words1.join(' ') === words2.join(' ')) {
    return 1.0;
  }

  const tokens1 = new Set(words1);
  const tokens2 = new Set(words2);

  // Prevent distinct franchise entries with mutually exclusive non-edition substantive words
  // (e.g. 'Vampire: The Masquerade - Reckoning of New York' vs 'Vampire: The Masquerade - Coteries of New York')
  const substantive1 = words1.filter((w) => !/^\d+$/.test(w) && !EDITION_WORDS.has(w) && !DISJOINT_STOP_WORDS.has(w));
  const substantive2 = words2.filter((w) => !/^\d+$/.test(w) && !EDITION_WORDS.has(w) && !DISJOINT_STOP_WORDS.has(w));
  const disjoint1 = substantive1.filter((w) => !tokens2.has(w));
  const disjoint2 = substantive2.filter((w) => !tokens1.has(w));
  if (disjoint1.length >= 1 && disjoint2.length >= 1) {
    return 0;
  }

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
    let hasEditionToken = false;
    for (const w of longerWords) {
      if (!shorterSet.has(w)) {
        if (EDITION_WORDS.has(w)) {
          hasEditionToken = true;
        } else if (w !== 'the' && w !== 'of' && w !== 'a' && w !== 'an') {
          onlyEditionTokensRemaining = false;
          break;
        }
      }
    }
    if (onlyEditionTokensRemaining && (hasEditionToken || shorterWords.length >= 2)) {
      return 0.92;
    }
  }

  // Exact multi-word phrase containment (only when sharing an explicit sequel number or article/edition-only tokens)
  if (seq1 !== null && seq1 === seq2 && words1.length >= 2 && (s1.includes(s2) || s2.includes(s1))) {
    const minWords = Math.min(words1.length, words2.length);
    const maxWords = Math.max(words1.length, words2.length);
    if (minWords / maxWords >= 0.5 && intersection >= minWords) {
      return 0.88;
    }
  }

  return jaccard;
}

const STORAGE_KEY_MATCHED_APP_IDS = 'steam_app_id_match_cache_v4';
const STORAGE_KEY_MATCHER_SCHEMA = 'antigravity_steam_matcher_schema_v5';
const NEGATIVE_MATCH_TTL_MS = TIER_TTLS.negative; // 7 days = 604,800,000 ms
const NON_GAME_SOURCE_REGEX =
  /\b(public testing|tech beta|playtest|test branch|official walkthrough|walkthrough|digital goodies|pre-game editor|resource archiver|bonus content|artbook|soundtrack|ost)\b|\bcontent$/i;
export const DISTINCT_EDITION_TOKEN_REGEX =
  /\b(remastered|remaster|remake|enhanced|definitive|redux|director'?s cut|anniversary)\b/i;

export class SteamMatcherService {
  private cache = new Map<string, number | null>();
  private negativeTimestamps = new Map<string, number>();

  constructor() {
    this.loadPersistentCache();
  }

  private loadPersistentCache() {
    if (typeof window === 'undefined') return;
    try {
      localStorage.removeItem('steam_app_id_match_cache_v3');
      localStorage.removeItem('antigravity_steam_matched_app_ids');
      const raw = localStorage.getItem(STORAGE_KEY_MATCHED_APP_IDS);
      if (raw) {
        const parsed = JSON.parse(raw);
        const entries = Object.entries(parsed);
        const hasV5Schema = localStorage.getItem(STORAGE_KEY_MATCHER_SCHEMA) === '1';

        for (const [k, v] of entries) {
          const lk = k.toLowerCase();
          if (NON_GAME_SOURCE_REGEX.test(lk) || /\s\+\s/.test(lk)) {
            continue;
          }

          if (typeof v === 'number' && v > 0) {
            const enrichedName = (steamEnrichedCache as Record<string, any>)[String(v)]?.name;
            if (
              enrichedName &&
              (computeTitleSimilarity(normalizeGameTitle(lk), enrichedName) < 0.85 ||
                DISTINCT_EDITION_TOKEN_REGEX.test(lk) !== DISTINCT_EDITION_TOKEN_REGEX.test(enrichedName))
            ) {
              continue;
            }
            this.cache.set(lk, v);
          } else if (v === null) {
            // Legacy null without timestamp: treat as expired
          } else if (typeof v === 'object' && v !== null && hasV5Schema) {
            const cachedAt = (v as any).cachedAt || 0;
            const isExpired = Date.now() - cachedAt >= NEGATIVE_MATCH_TTL_MS;
            if (!isExpired && ((v as any).appId === null || (v as any).id === null)) {
              this.cache.set(lk, null);
              this.negativeTimestamps.set(lk, cachedAt);
            }
          }
        }

        if (!hasV5Schema) {
          localStorage.setItem(STORAGE_KEY_MATCHER_SCHEMA, '1');
          this.savePersistentCache();
        }
      }
    } catch {
      // Ignore read errors
    }
  }

  private savePersistentCache() {
    if (typeof window === 'undefined') return;
    try {
      const obj: Record<string, any> = {};
      for (const [k, v] of this.cache.entries()) {
        if (typeof v === 'number' && v > 0) {
          obj[k] = v;
        } else if (v === null) {
          const cachedAt = this.negativeTimestamps.get(k) || Date.now();
          obj[k] = { appId: null, cachedAt };
        }
      }
      localStorage.setItem(STORAGE_KEY_MATCHED_APP_IDS, JSON.stringify(obj));
      localStorage.setItem(STORAGE_KEY_MATCHER_SCHEMA, '1');
    } catch {
      // Ignore write errors
    }
  }

  private recordNegativeMatch(key: string, timestamp: number = Date.now()): void {
    this.cache.set(key, null);
    this.negativeTimestamps.set(key, timestamp);
    this.savePersistentCache();
  }

  public clearCache(): void {
    this.cache.clear();
    this.negativeTimestamps.clear();
    if (typeof window !== 'undefined') {
      try {
        localStorage.removeItem(STORAGE_KEY_MATCHED_APP_IDS);
      } catch {}
    }
  }

  private getStoreSearchBaseUrl(): string {
    if (
      typeof window !== 'undefined' &&
      window.location?.hostname === 'localhost' &&
      (window.location?.port === '3000' || window.location?.port === '5173') &&
      typeof navigator !== 'undefined' &&
      !navigator.userAgent?.includes('jsdom') &&
      !navigator.userAgent?.includes('Node')
    ) {
      return '/api/steam-store';
    }
    return 'https://store.steampowered.com';
  }

  /**
   * Checks whether a Steam match lookup has already been attempted (positively or negatively within TTL).
   */
  public hasAttemptedMatch(title: string): boolean {
    if (!title || !title.trim()) return true;
    const cleanRaw = title.trim();
    const lowerKey = cleanRaw.toLowerCase();

    if (this.matchGameToSteamInstant(cleanRaw)) {
      return true;
    }

    const normalized = normalizeGameTitle(cleanRaw).toLowerCase();
    if (
      NON_GAME_SOURCE_REGEX.test(cleanRaw) ||
      KNOWN_NON_STEAM_TITLES.has(lowerKey) ||
      KNOWN_NON_STEAM_TITLES.has(normalized)
    ) {
      return true;
    }

    if (this.cache.has(lowerKey)) {
      const val = this.cache.get(lowerKey);
      if (typeof val === 'number' && val > 0) {
        return true;
      }
      if (val === null) {
        const cachedAt = this.negativeTimestamps.get(lowerKey);
        if (cachedAt && Date.now() - cachedAt < NEGATIVE_MATCH_TTL_MS) {
          return true;
        }
      }
    }

    return false;
  }

  /**
   * Fast, synchronous lookup against curated mappings and local caches without network requests
   */
  matchGameToSteamInstant(title: string): number | null {
    if (!title || !title.trim()) return null;
    const cleanRaw = title.trim();
    const lowerKey = cleanRaw.toLowerCase();
    if (NON_GAME_SOURCE_REGEX.test(cleanRaw)) {
      return null;
    }

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
      this.savePersistentCache();
      return directMatch;
    }

    // 2. Check in-memory / persistent cache
    if (this.cache.has(lowerKey)) {
      const val = this.cache.get(lowerKey);
      if (typeof val === 'number' && val > 0) {
        return val;
      }
      if (val === null) {
        const cachedAt = this.negativeTimestamps.get(lowerKey);
        if (cachedAt && Date.now() - cachedAt < NEGATIVE_MATCH_TTL_MS) {
          return null;
        }
        this.cache.delete(lowerKey);
        this.negativeTimestamps.delete(lowerKey);
      }
    }

    for (const [idStr, data] of Object.entries(steamEnrichedCache as Record<string, any>)) {
      if (!data?.name) continue;
      if (DISTINCT_EDITION_TOKEN_REGEX.test(cleanRaw) !== DISTINCT_EDITION_TOKEN_REGEX.test(data.name)) {
        continue;
      }
      if (computeTitleSimilarity(normalized, data.name) >= 0.88) {
        const appId = parseInt(idStr, 10);
        this.cache.set(lowerKey, appId);
        this.savePersistentCache();
        return appId;
      }
    }

    return null;
  }

  /**
   * Intelligently matches any game title to its official Steam App ID.
   * Returns Steam App ID if found, or null if game does not exist on Steam.
   */
  async matchGameToSteam(
    title: string,
    options?: { releaseYear?: number | string | null; developers?: string[] }
  ): Promise<number | null> {
    if (!title || !title.trim()) return null;
    const cleanRaw = title.trim();
    const lowerKey = cleanRaw.toLowerCase();
    if (NON_GAME_SOURCE_REGEX.test(cleanRaw)) {
      this.recordNegativeMatch(lowerKey);
      return null;
    }

    const normalized = normalizeGameTitle(cleanRaw).toLowerCase();
    if (KNOWN_NON_STEAM_TITLES.has(lowerKey) || KNOWN_NON_STEAM_TITLES.has(normalized)) {
      this.recordNegativeMatch(lowerKey);
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
      const val = this.cache.get(lowerKey);
      if (typeof val === 'number' && val > 0) {
        return val;
      }
      if (val === null) {
        const cachedAt = this.negativeTimestamps.get(lowerKey);
        if (cachedAt && Date.now() - cachedAt < NEGATIVE_MATCH_TTL_MS) {
          return null;
        }
        this.cache.delete(lowerKey);
        this.negativeTimestamps.delete(lowerKey);
      }
    }

    if (directMatch) {
      this.cache.set(lowerKey, directMatch);
      this.savePersistentCache();
      return directMatch;
    }

    // 3. Check existing local steamEnrichedCache.json
    for (const [idStr, data] of Object.entries(steamEnrichedCache as Record<string, any>)) {
      if (!data?.name) continue;
      if (DISTINCT_EDITION_TOKEN_REGEX.test(cleanRaw) !== DISTINCT_EDITION_TOKEN_REGEX.test(data.name)) {
        continue;
      }
      if (computeTitleSimilarity(normalized, data.name) >= 0.85) {
        const appId = parseInt(idStr, 10);
        this.cache.set(lowerKey, appId);
        this.savePersistentCache();
        return appId;
      }
    }

    // 4. Dynamic Multi-Strategy Steam Store Search
    const hasCorroboratingMetadata = Boolean(
      options?.releaseYear || (options?.developers && options.developers.length > 0)
    );

    const searchStrategies = [
      normalized,                                     // Strategy 1: Normalized clean title
      cleanRaw,                                       // Strategy 2: Exact raw title
      ...(cleanRaw.includes('+')
        ? [normalized.replace(/\+/g, ' ').replace(/\s+/g, ' ').trim()]
        : []),
      ...(hasCorroboratingMetadata
        ? [
            normalized.split(':')[0].trim(),          // Strategy 3: Base title without subtitle (corroborated)
            normalized.split('-')[0].trim(),          // Strategy 4: Base title before dash (corroborated)
          ]
        : []),
      normalized.replace(/^(the|a|an)\s+/i, '').trim(), // Strategy 5: Without leading article
    ];

    const uniqueTerms = Array.from(new Set(searchStrategies.filter((s) => s.length >= 3)));

    for (const term of uniqueTerms) {
      try {
        const baseUrl = this.getStoreSearchBaseUrl();
        const url = `${baseUrl}/api/storesearch/?term=${encodeURIComponent(term)}&l=english&cc=US`;
        const res = await requestScheduler.schedule(
          url,
          () => axios.get(url, { timeout: 7000 }),
          Priority.P2_BACKGROUND,
          'store.steampowered.com'
        );

        const items = res.data?.items;
        if (Array.isArray(items) && items.length > 0) {
          // Score and rank candidates, filtering out DLC, soundtracks, and bonus items
          let bestCandidate: { id: number; score: number; name: string } | null = null;

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

            const evalNormalized = computeEntityMatchConfidence(
              {
                title: normalized,
                releaseYear: options?.releaseYear,
                developers: options?.developers,
              },
              {
                title: candidateName,
              }
            );
            const evalRaw = computeEntityMatchConfidence(
              {
                title: cleanRaw,
                releaseYear: options?.releaseYear,
                developers: options?.developers,
              },
              {
                title: candidateName,
              }
            );

            const isAccepted = evalNormalized.isAccepted || evalRaw.isAccepted;
            const isRebootCollision = evalNormalized.isRebootCollision || evalRaw.isRebootCollision;
            let score = Math.max(evalNormalized.confidence, evalRaw.confidence);

            if (candLower === normalized && !isRebootCollision) {
              score = Math.min(100, score + 15);
            }

            // Edition alignment: prefer exact edition matches (e.g. GOTY / Game of the Year, Unrated, Director's Cut)
            // and penalize candidate remasters when the user's title is the original/GOTY edition
            const rawHasGoty = /\b(goty|game of the year)\b/i.test(cleanRaw);
            const candHasGoty = /\b(goty|game of the year)\b/i.test(candidateName);
            if (rawHasGoty && candHasGoty) {
              score = Math.min(100, score + 12);
            }
            const rawHasRemaster = /\b(remastered|remaster|remake|enhanced)\b/i.test(cleanRaw);
            const candHasRemaster = /\b(remastered|remaster|remake|enhanced)\b/i.test(candidateName);
            if (!rawHasRemaster && candHasRemaster) {
              score -= 25;
            }

            // Franchise sibling AppID adjacency tie-breaker:
            // When two candidates share the same base title (e.g. 'Eye of the Beholder' 1882260 vs homonym 1425330),
            // prefer the candidate whose AppID is adjacent (within 50 IDs) to numbered sequels/siblings in the same batch.
            const candNormKey = normalizeTitleKey(candidateName);
            if (
              candNormKey.length >= 3 &&
              items.some(
                (other: any) =>
                  other.id !== item.id &&
                  typeof other.id === 'number' &&
                  typeof item.id === 'number' &&
                  Math.abs(other.id - item.id) <= 50 &&
                  typeof other.name === 'string' &&
                  normalizeTitleKey(other.name).startsWith(`${candNormKey} `)
              )
            ) {
              score += 5;
            }

            if (isAccepted && score >= 68 && (!bestCandidate || score > bestCandidate.score)) {
              bestCandidate = { id: item.id, score, name: candidateName };
            }
          }

          if (bestCandidate) {
            this.cache.set(lowerKey, bestCandidate.id);
            if (
              normalized &&
              !DISTINCT_EDITION_TOKEN_REGEX.test(cleanRaw) &&
              !DISTINCT_EDITION_TOKEN_REGEX.test(bestCandidate.name)
            ) {
              this.cache.set(normalized, bestCandidate.id);
            }
            this.savePersistentCache();
            if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
              try {
                window.dispatchEvent(
                  new CustomEvent('antigravity:steam-match-updated', {
                    detail: { title: cleanRaw, steamAppId: bestCandidate.id },
                  })
                );
              } catch {}
            }
            return bestCandidate.id;
          }
        }
      } catch (err: any) {
        // If rate-limited or network error, stop dynamic search for this request
        break;
      }
    }

    // Game does not exist on Steam (or is store exclusive)
    this.recordNegativeMatch(lowerKey);
    return null;
  }

  /**
   * Enriches a CanonicalGame with Steam App ID and official Steam assets if matched.
   */
  async enrichGameWithSteamMatch(game: CanonicalGame): Promise<CanonicalGame> {
    if (game.steamAppId) return game;

    const matchedId = await this.matchGameToSteam(game.title, {
      releaseYear: game.releaseDate,
      developers: game.developers,
    });
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
