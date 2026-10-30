import axios from 'axios';
import { CanonicalGame } from '../../contracts/game';
import steamEnrichedCache from '../storage/steamEnrichedCache.json';
import {
  normalizeTitleKey,
  stripEditionSuffix,
  stripYearEditionPhrases,
  splitCamelCaseTitle,
  alignCompoundWordTokens,
  stripStorefrontPlatformDisambiguators,
  extractSequelIdentifier as commonExtractSequelIdentifier,
  isSequelMismatch as commonIsSequelMismatch,
  ROMAN_TO_ARABIC,
  EDITION_TOKENS,
} from '../common/titleUtils';
import { computeEntityMatchConfidence } from '../common/entityResolver';
import { requestScheduler, Priority } from '../network/requestScheduler';
import { onlineLifecycleManager } from '../network/onlineLifecycleManager';
import { computeAdaptive404RetryDelayMs, isWafOrChallengeResponse } from '../../contracts/network';
import { TIER_TTLS } from '../storage/stagedCacheService';
import { vaultDelete, vaultGet, vaultSet } from '../storage/indexedDbVault';
import {
  registerInstantSteamTitleMatcher,
  resolveEffectiveSteamAppId,
  type EffectiveSteamLookupInput,
} from '../storage/userOverrideStorage';

/**
 * Optional static Steam AppID mapping table (empty by default for universal dynamic resolution).
 */
export const KNOWN_STORE_STEAM_MAPPINGS: Record<string, number> = {};

/**
 * Canonicalizes title strings by stripping punctuation, trademark symbols, and whitespace.
 */
export function canonicalizeTitleKey(str: string): string {
  if (!str) return '';
  return stripYearEditionPhrases(stripStorefrontPlatformDisambiguators(str))
    .toLowerCase()
    .replace(/['’‘"“”]/g, '')
    .replace(/[™®©℠•·𝄞★☆]/g, ' ')
    .replace(/[:\-–—−‑]/g, ' ')
    .replace(/\s*\((?:19|20)\d{2}\)/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Normalizes title string by stripping edition noise, trademark symbols, and punctuation.
 */
export function normalizeGameTitle(rawTitle: string): string {
  if (!rawTitle) return '';

  let title = stripYearEditionPhrases(stripStorefrontPlatformDisambiguators(rawTitle))
    .replace(/[™®©℠•·𝄞★☆]/g, ' ')
    .replace(/\s+:/g, ':')
    .replace(/\s*\((?:19|20)\d{2}\)/g, '')
    .replace(/\s+/g, ' ')
    .trim();

  // Strip store and edition suffixes (allowing optional colon/hyphen/brackets/parens and optional curly/straight apostrophes)
  const suffixes = [
    /(?::|\s+-|\s+–|\s+—|\s+)?\s*(?:\(|\[)?\s*(?:Digital Deluxe|Digital Premium|Premium|Deluxe|Enhanced Edition Director['’]?s Cut|Enhanced|Game of the Year|GOTY|Definitive|Extended|Director['’]?s Cut|Complete|Standard|Remastered|DRM-Free|Royal|Ultimate|The Final Cut|Emperor|Gold|Vault|Launch|Founders?|Cross[\s\-]Gen|Celebration|International|Collector['’]?s|Anniversary|Windows(?:\s*10|\s*11)?|PC)\s+(?:Edition|Pack|Bundle|Collection|Version)(?:\)|\])?/gi,
    /(?::|\s+-|\s+–|\s+—|\s+)?\s*(?:\(|\[)?\s*(?:Director['’]?s Cut|The Final Cut|GOG Cut|Remastered|GOTY|Game Preview)(?:\)|\])?/gi,
  ];

  for (const pattern of suffixes) {
    title = title.replace(pattern, '').trim();
  }

  // Strip any residual trailing MS Store platform disambiguators exposed after edition suffix removal
  title = stripStorefrontPlatformDisambiguators(title);

  // Normalize quotes and spaces
  title = title
    .replace(/['’‘"“”]/g, '')
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
  const cleanSource = stripYearEditionPhrases(source);
  const cleanCandidate = stripYearEditionPhrases(candidate);
  const s1 = stripStorefrontPlatformDisambiguators(cleanSource).toLowerCase().replace(/['’‘"“”]/g, '').replace(/[™®©℠•·𝄞★☆–—−‑]/g, ' ').replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
  const s2 = stripStorefrontPlatformDisambiguators(cleanCandidate).toLowerCase().replace(/['’‘"“”]/g, '').replace(/[™®©℠•·𝄞★☆–—−‑]/g, ' ').replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();

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

  if (commonIsSequelMismatch(cleanSource, cleanCandidate)) {
    return 0;
  }

  const mappedWords1 = seq1 !== null ? rawWords1.map((w) => ROMAN_TO_ARABIC[w] || w) : rawWords1;
  const mappedWords2 = seq2 !== null ? rawWords2.map((w) => ROMAN_TO_ARABIC[w] || w) : rawWords2;
  const [words1, words2] = alignCompoundWordTokens(mappedWords1, mappedWords2);

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

function tokenizeSimilarityWords(text: string): string[] {
  const cleaned = stripYearEditionPhrases(stripStorefrontPlatformDisambiguators(text))
    .toLowerCase()
    .replace(/['’‘"“”]/g, '')
    .replace(/[™®©℠•·𝄞★☆–—−‑]/g, ' ')
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!cleaned) return [];
  return cleaned
    .split(' ')
    .filter(Boolean)
    .map((w) => ROMAN_TO_ARABIC[w] || w);
}

interface EnrichedMatchEntry {
  appId: number;
  name: string;
  hasDistinctEdition: boolean;
}

const MAX_MATCH_CACHE_ENTRIES = 2000;

interface PersistedNegativeMatchRecord {
  appId?: null;
  id?: null;
  cachedAt: number;
  failureCount?: number;
}

export class SteamMatcherService {
  private cache = new Map<string, number | null>();
  private negativeTimestamps = new Map<string, number>();
  private negativeFailureCounts = new Map<string, number>();
  private instantMemo = new Map<string, number | null>();
  private inFlightFailedKeys = new Set<string>();
  private enrichedEntries: EnrichedMatchEntry[] | null = null;
  private enrichedWordIndex: Map<string, number[]> | null = null;
  private pendingSaveTimer: ReturnType<typeof setTimeout> | null = null;
  private cacheGeneration = 0;

  constructor() {
    this.loadPersistentCache();
    void this.hydratePersistentCacheFromVault();
    try {
      if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
        window.addEventListener('beforeunload', () => {
          if (this.pendingSaveTimer !== null) {
            clearTimeout(this.pendingSaveTimer);
            this.pendingSaveTimer = null;
            this.savePersistentCache();
          }
        });
      }
      onlineLifecycleManager.onOnline(() => {
        this.inFlightFailedKeys.clear();
        for (const [k, v] of this.instantMemo.entries()) {
          if (v === null && !this.cache.has(k)) {
            this.instantMemo.delete(k);
          }
        }
      });
    } catch {
      // Ignore partial window mock environments in unit tests
    }
  }

  private setCacheBounded(key: string, val: number | null): void {
    if (this.cache.has(key)) {
      this.cache.delete(key);
    }
    this.cache.set(key, val);
    while (this.cache.size > MAX_MATCH_CACHE_ENTRIES) {
      const oldest = this.cache.keys().next().value;
      if (oldest === undefined) break;
      this.cache.delete(oldest);
      this.negativeTimestamps.delete(oldest);
      this.negativeFailureCounts.delete(oldest);
    }
  }

  private setNegativeTimestampBounded(key: string, ts: number): void {
    if (this.negativeTimestamps.has(key)) {
      this.negativeTimestamps.delete(key);
    }
    this.negativeTimestamps.set(key, ts);
    while (this.negativeTimestamps.size > MAX_MATCH_CACHE_ENTRIES) {
      const oldest = this.negativeTimestamps.keys().next().value;
      if (oldest === undefined) break;
      this.negativeTimestamps.delete(oldest);
    }
  }

  private schedulePersistentCacheSave(): void {
    if (this.pendingSaveTimer !== null) return;
    this.pendingSaveTimer = setTimeout(() => {
      this.pendingSaveTimer = null;
      this.savePersistentCache();
    }, 200);
  }

  private getNegativeMatchTtlMs(key: string): number {
    const count = this.negativeFailureCounts.get(key);
    if (typeof count === 'number' && count >= 1) {
      return computeAdaptive404RetryDelayMs(count);
    }
    return NEGATIVE_MATCH_TTL_MS;
  }

  private getEnrichedCandidateEntries(normalizedTitle: string): EnrichedMatchEntry[] {
    if (!this.enrichedEntries || !this.enrichedWordIndex) {
      const entries: EnrichedMatchEntry[] = [];
      const index = new Map<string, number[]>();
      for (const [idStr, data] of Object.entries(
        steamEnrichedCache as Record<string, { name?: string }>
      )) {
        if (!data?.name) continue;
        const idx = entries.length;
        entries.push({
          appId: parseInt(idStr, 10),
          name: data.name,
          hasDistinctEdition: DISTINCT_EDITION_TOKEN_REGEX.test(data.name),
        });
        const words = new Set(tokenizeSimilarityWords(data.name));
        for (const w of words) {
          let bucket = index.get(w);
          if (!bucket) {
            bucket = [];
            index.set(w, bucket);
          }
          bucket.push(idx);
        }
      }
      this.enrichedEntries = entries;
      this.enrichedWordIndex = index;
    }

    const queryWords = tokenizeSimilarityWords(normalizedTitle);
    if (queryWords.length === 0) return [];
    const candidateSet = new Set<number>();
    for (let i = 0; i < queryWords.length; i++) {
      const bucket = this.enrichedWordIndex.get(queryWords[i]);
      if (bucket) {
        for (let j = 0; j < bucket.length; j++) {
          candidateSet.add(bucket[j]);
        }
      }
    }
    if (candidateSet.size === 0) return [];
    const entries = this.enrichedEntries;
    if (candidateSet.size === 1) {
      return [entries[candidateSet.values().next().value as number]];
    }
    return Array.from(candidateSet)
      .sort((a, b) => a - b)
      .map((idx) => entries[idx]);
  }

  private loadPersistentCache() {
    if (typeof window === 'undefined') return;
    try {
      localStorage.removeItem('steam_app_id_match_cache_v3');
      localStorage.removeItem('antigravity_steam_matched_app_ids');
      const raw = localStorage.getItem(STORAGE_KEY_MATCHED_APP_IDS);
      if (raw) {
        const parsed: unknown = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return;
        const entries = Object.entries(parsed as Record<string, unknown>);
        const hasV5Schema = localStorage.getItem(STORAGE_KEY_MATCHER_SCHEMA) === '1';

        for (const [k, v] of entries) {
          const lk = k.toLowerCase();
          if (NON_GAME_SOURCE_REGEX.test(lk)) {
            continue;
          }

          if (typeof v === 'number' && v > 0) {
            const enrichedName = (
              steamEnrichedCache as Record<string, { name?: string } | undefined>
            )[String(v)]?.name;
            if (
              enrichedName &&
              (computeTitleSimilarity(normalizeGameTitle(lk), enrichedName) < 0.85 ||
                DISTINCT_EDITION_TOKEN_REGEX.test(lk) !== DISTINCT_EDITION_TOKEN_REGEX.test(enrichedName))
            ) {
              continue;
            }
            this.setCacheBounded(lk, v);
          } else if (v === null) {
            // Legacy null without timestamp: treat as expired
          } else if (typeof v === 'object' && v !== null && hasV5Schema) {
            const negRec = v as Partial<PersistedNegativeMatchRecord>;
            const cachedAt = typeof negRec.cachedAt === 'number' ? negRec.cachedAt : 0;
            const rawFailureCount = negRec.failureCount;
            const failureCount =
              typeof rawFailureCount === 'number' && rawFailureCount >= 1
                ? Math.floor(rawFailureCount)
                : undefined;
            const effectiveTtlMs =
              failureCount !== undefined
                ? computeAdaptive404RetryDelayMs(failureCount)
                : NEGATIVE_MATCH_TTL_MS;
            const isExpired = Date.now() - cachedAt >= effectiveTtlMs;
            if (negRec.appId === null || negRec.id === null) {
              if (failureCount !== undefined) {
                this.negativeFailureCounts.set(lk, failureCount);
              }
              if (!isExpired) {
                this.setCacheBounded(lk, null);
                this.setNegativeTimestampBounded(lk, cachedAt);
              }
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

  private async hydratePersistentCacheFromVault(): Promise<void> {
    if (typeof window === 'undefined') return;
    const gen = this.cacheGeneration;
    try {
      const vaultData = await vaultGet<Record<string, unknown>>(STORAGE_KEY_MATCHED_APP_IDS);
      if (
        gen !== this.cacheGeneration ||
        !vaultData ||
        typeof vaultData !== 'object' ||
        Array.isArray(vaultData)
      ) {
        return;
      }

      let hydratedAny = false;
      for (const [k, v] of Object.entries(vaultData)) {
        const lk = k.toLowerCase();
        if (NON_GAME_SOURCE_REGEX.test(lk)) {
          continue;
        }

        const existingVal = this.cache.get(lk);
        if (typeof existingVal === 'number' && existingVal > 0) {
          continue;
        }

        if (typeof v === 'number' && v > 0) {
          const enrichedName = (
            steamEnrichedCache as Record<string, { name?: string } | undefined>
          )[String(v)]?.name;
          if (
            enrichedName &&
            (computeTitleSimilarity(normalizeGameTitle(lk), enrichedName) < 0.85 ||
              DISTINCT_EDITION_TOKEN_REGEX.test(lk) !==
                DISTINCT_EDITION_TOKEN_REGEX.test(enrichedName))
          ) {
            continue;
          }
          this.setCacheBounded(lk, v);
          this.negativeTimestamps.delete(lk);
          this.negativeFailureCounts.delete(lk);
          if (this.instantMemo.get(lk) === null) {
            this.instantMemo.delete(lk);
          }
          hydratedAny = true;
        } else if (typeof v === 'object' && v !== null) {
          const negRec = v as Partial<PersistedNegativeMatchRecord>;
          const cachedAt = typeof negRec.cachedAt === 'number' ? negRec.cachedAt : 0;
          const existingNegTs = this.negativeTimestamps.get(lk) || 0;
          if (existingVal === null && existingNegTs >= cachedAt) {
            continue;
          }
          const rawFailureCount = negRec.failureCount;
          const failureCount =
            typeof rawFailureCount === 'number' && rawFailureCount >= 1
              ? Math.floor(rawFailureCount)
              : undefined;
          const effectiveTtlMs =
            failureCount !== undefined
              ? computeAdaptive404RetryDelayMs(failureCount)
              : NEGATIVE_MATCH_TTL_MS;
          const isExpired = Date.now() - cachedAt >= effectiveTtlMs;
          if (negRec.appId === null || negRec.id === null) {
            if (failureCount !== undefined) {
              this.negativeFailureCounts.set(lk, failureCount);
            }
            if (!isExpired) {
              this.setCacheBounded(lk, null);
              this.setNegativeTimestampBounded(lk, cachedAt);
              this.instantMemo.delete(lk);
              hydratedAny = true;
            }
          }
        }
      }

      if (hydratedAny) {
        try {
          const obj: Record<string, number | PersistedNegativeMatchRecord> = {};
          for (const [k, v] of this.cache.entries()) {
            if (typeof v === 'number' && v > 0) {
              obj[k] = v;
            } else if (v === null) {
              const cachedAt = this.negativeTimestamps.get(k) || Date.now();
              const failureCount = this.negativeFailureCounts.get(k);
              obj[k] =
                failureCount !== undefined
                  ? { appId: null, cachedAt, failureCount }
                  : { appId: null, cachedAt };
            }
          }
          localStorage.setItem(STORAGE_KEY_MATCHED_APP_IDS, JSON.stringify(obj));
          localStorage.setItem(STORAGE_KEY_MATCHER_SCHEMA, '1');
        } catch {
          // Ignore localStorage quota errors; IndexedDB already holds full cache
        }
      }
    } catch {
      // Ignore vault read errors
    }
  }

  private savePersistentCache() {
    if (typeof window === 'undefined') return;
    if (this.pendingSaveTimer !== null) {
      clearTimeout(this.pendingSaveTimer);
      this.pendingSaveTimer = null;
    }
    const obj: Record<string, number | PersistedNegativeMatchRecord> = {};
    for (const [k, v] of this.cache.entries()) {
      if (typeof v === 'number' && v > 0) {
        obj[k] = v;
      } else if (v === null) {
        const cachedAt = this.negativeTimestamps.get(k) || Date.now();
        const failureCount = this.negativeFailureCounts.get(k);
        obj[k] =
          failureCount !== undefined
            ? { appId: null, cachedAt, failureCount }
            : { appId: null, cachedAt };
      }
    }
    void vaultSet(STORAGE_KEY_MATCHED_APP_IDS, obj);
    try {
      localStorage.setItem(STORAGE_KEY_MATCHED_APP_IDS, JSON.stringify(obj));
      localStorage.setItem(STORAGE_KEY_MATCHER_SCHEMA, '1');
    } catch {
      // Ignore write errors
    }
  }

  private recordNegativeMatch(
    key: string,
    timestamp: number = Date.now(),
    failureCount?: number
  ): void {
    this.setCacheBounded(key, null);
    this.setNegativeTimestampBounded(key, timestamp);
    if (typeof failureCount === 'number' && failureCount >= 1) {
      this.negativeFailureCounts.set(key, Math.floor(failureCount));
    }
    this.instantMemo.delete(key);
    this.savePersistentCache();
  }

  public clearCache(): void {
    this.cacheGeneration += 1;
    if (this.pendingSaveTimer !== null) {
      clearTimeout(this.pendingSaveTimer);
      this.pendingSaveTimer = null;
    }
    this.cache.clear();
    this.negativeTimestamps.clear();
    this.negativeFailureCounts.clear();
    this.inFlightFailedKeys.clear();
    this.instantMemo.clear();
    this.enrichedEntries = null;
    this.enrichedWordIndex = null;
    void vaultDelete(STORAGE_KEY_MATCHED_APP_IDS);
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
        if (cachedAt && Date.now() - cachedAt < this.getNegativeMatchTtlMs(lowerKey)) {
          return true;
        }
      }
    }

    return false;
  }

  /**
   * Synchronous read-only lookup for positive cached Steam AppID matches across
   * raw, normalized, and curated keys without triggering network requests.
   */
  public peekCachedMatch(title: string): number | null {
    return this.matchGameToSteamInstant(title);
  }

  /**
   * Fast, synchronous lookup against curated mappings and local caches without network requests
   */
  matchGameToSteamInstant(title: string): number | null {
    if (!title || !title.trim()) return null;
    const cleanRaw = title.trim();
    const lowerKey = cleanRaw.toLowerCase();
    if (this.instantMemo.has(lowerKey)) {
      return this.instantMemo.get(lowerKey) ?? null;
    }
    if (NON_GAME_SOURCE_REGEX.test(cleanRaw)) {
      this.instantMemo.set(lowerKey, null);
      return null;
    }

    const normalized = normalizeGameTitle(cleanRaw).toLowerCase();
    if (KNOWN_NON_STEAM_TITLES.has(lowerKey) || KNOWN_NON_STEAM_TITLES.has(normalized)) {
      this.instantMemo.set(lowerKey, null);
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
      this.setCacheBounded(lowerKey, directMatch);
      this.instantMemo.set(lowerKey, directMatch);
      this.schedulePersistentCacheSave();
      return directMatch;
    }

    // 2. Check in-memory / persistent cache
    if (this.cache.has(lowerKey)) {
      const val = this.cache.get(lowerKey);
      if (typeof val === 'number' && val > 0) {
        this.instantMemo.set(lowerKey, val);
        return val;
      }
      if (val === null) {
        const cachedAt = this.negativeTimestamps.get(lowerKey);
        if (cachedAt && Date.now() - cachedAt < this.getNegativeMatchTtlMs(lowerKey)) {
          this.instantMemo.set(lowerKey, null);
          return null;
        }
        this.cache.delete(lowerKey);
        this.negativeTimestamps.delete(lowerKey);
      }
    }

    const cleanHasDistinctEdition = DISTINCT_EDITION_TOKEN_REGEX.test(cleanRaw);
    if (!cleanHasDistinctEdition && normalized && this.cache.has(normalized)) {
      const normVal = this.cache.get(normalized);
      if (typeof normVal === 'number' && normVal > 0) {
        this.instantMemo.set(lowerKey, normVal);
        return normVal;
      }
    }

    const candidateEntries = this.getEnrichedCandidateEntries(normalized);
    for (let i = 0; i < candidateEntries.length; i++) {
      const entry = candidateEntries[i];
      if (cleanHasDistinctEdition !== entry.hasDistinctEdition) {
        continue;
      }
      if (computeTitleSimilarity(normalized, entry.name) >= 0.88) {
        this.setCacheBounded(lowerKey, entry.appId);
        this.instantMemo.set(lowerKey, entry.appId);
        this.schedulePersistentCacheSave();
        return entry.appId;
      }
    }

    if (this.instantMemo.size > 16384) {
      this.instantMemo.clear();
    }
    this.instantMemo.set(lowerKey, null);
    return null;
  }

  private commitPositiveMatch(
    lowerKey: string,
    cleanRaw: string,
    normalized: string,
    candidateId: number,
    candidateName: string
  ): number {
    this.setCacheBounded(lowerKey, candidateId);
    this.negativeFailureCounts.delete(lowerKey);
    this.negativeTimestamps.delete(lowerKey);
    this.inFlightFailedKeys.delete(lowerKey);
    this.instantMemo.set(lowerKey, candidateId);
    if (
      normalized &&
      !DISTINCT_EDITION_TOKEN_REGEX.test(cleanRaw) &&
      !DISTINCT_EDITION_TOKEN_REGEX.test(candidateName)
    ) {
      this.setCacheBounded(normalized, candidateId);
      this.negativeFailureCounts.delete(normalized);
      this.negativeTimestamps.delete(normalized);
      this.instantMemo.set(normalized, candidateId);
    }
    this.savePersistentCache();
    if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
      try {
        window.dispatchEvent(
          new CustomEvent('antigravity:steam-match-updated', {
            detail: { title: cleanRaw, steamAppId: candidateId },
          })
        );
      } catch {}
    }
    return candidateId;
  }

  private scoreCandidateItems(
    items: Array<{ id: number; name?: string }>,
    cleanRaw: string,
    lowerKey: string,
    normalized: string,
    normBaseKey: string,
    options?: { releaseYear?: number | string | null; developers?: string[] },
    minScoreThreshold: number = 68
  ): { id: number; score: number; name: string } | null {
    let bestCandidate: { id: number; score: number; name: string } | null = null;

    for (const item of items) {
      if (typeof item.id !== 'number' || item.id <= 0) continue;
      const candidateName = (item.name || '').trim();
      if (!candidateName) continue;
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

      const candNormKey = normalizeTitleKey(candidateName);
      // 2-character titles (e.g. "Fe", "Ys") must match the exact normalized title key
      if (normBaseKey.length === 2 && candNormKey !== normBaseKey) {
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
      if (
        candNormKey.length >= 3 &&
        items.some(
          (other) =>
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

      if (isAccepted && score >= minScoreThreshold && (!bestCandidate || score > bestCandidate.score)) {
        bestCandidate = { id: item.id, score, name: candidateName };
      }
    }

    return bestCandidate;
  }

  /**
   * Intelligently matches any game title to its official Steam App ID.
   * Returns Steam App ID if found, or null if game does not exist on Steam.
   */
  async matchGameToSteam(
    title: string,
    options?: { releaseYear?: number | string | null; developers?: string[]; priority?: number }
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
    const normBaseKey = normalizeTitleKey(cleanRaw);
    const strippedBase = stripEditionSuffix(cleanRaw);

    const directMatch =
      CANONICAL_KNOWN_STORE_STEAM_MAPPINGS.get(lowerKey) ||
      CANONICAL_KNOWN_STORE_STEAM_MAPPINGS.get(normalized) ||
      CANONICAL_KNOWN_STORE_STEAM_MAPPINGS.get(canonicalKey) ||
      CANONICAL_KNOWN_STORE_STEAM_MAPPINGS.get(canonicalNorm) ||
      CANONICAL_KNOWN_STORE_STEAM_MAPPINGS.get(normBaseKey) ||
      CANONICAL_KNOWN_STORE_STEAM_MAPPINGS.get(strippedBase);

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
        if (cachedAt && Date.now() - cachedAt < this.getNegativeMatchTtlMs(lowerKey)) {
          return null;
        }
        this.cache.delete(lowerKey);
        this.negativeTimestamps.delete(lowerKey);
      }
    }

    const cleanHasDistinctEdition = DISTINCT_EDITION_TOKEN_REGEX.test(cleanRaw);
    if (!cleanHasDistinctEdition && normalized && this.cache.has(normalized)) {
      const normVal = this.cache.get(normalized);
      if (typeof normVal === 'number' && normVal > 0) {
        this.cache.set(lowerKey, normVal);
        this.instantMemo.set(lowerKey, normVal);
        this.savePersistentCache();
        return normVal;
      }
    }

    // 3. Check existing local steamEnrichedCache.json
    const candidateEntries = this.getEnrichedCandidateEntries(normalized);
    for (let i = 0; i < candidateEntries.length; i++) {
      const entry = candidateEntries[i];
      if (cleanHasDistinctEdition !== entry.hasDistinctEdition) {
        continue;
      }
      if (computeTitleSimilarity(normalized, entry.name) >= 0.85) {
        this.cache.set(lowerKey, entry.appId);
        this.negativeFailureCounts.delete(lowerKey);
        this.negativeTimestamps.delete(lowerKey);
        this.instantMemo.set(lowerKey, entry.appId);
        this.savePersistentCache();
        return entry.appId;
      }
    }

    if (!onlineLifecycleManager.isOnline()) {
      this.inFlightFailedKeys.add(lowerKey);
      return null;
    }

    // 4. Dynamic Multi-Strategy Steam Store Search
    const hasCorroboratingMetadata = Boolean(
      options?.releaseYear || (options?.developers && options.developers.length > 0)
    );
    const effectivePriority =
      options?.priority !== undefined ? options.priority : Priority.P2_BACKGROUND;
    const camelSplit = splitCamelCaseTitle(stripStorefrontPlatformDisambiguators(cleanRaw)).toLowerCase();
    const bilingualParts = cleanRaw.includes(' / ')
      ? cleanRaw
          .split(' / ')
          .map((part) => normalizeGameTitle(part).toLowerCase())
          .filter((part) => part.length >= 3)
      : [];

    const searchStrategies = [
      normalized,                                     // Strategy 1: Normalized clean title
      cleanRaw,                                       // Strategy 2: Exact raw title
      strippedBase,                                   // Strategy 3: Stripped base edition key
      normBaseKey,                                    // Strategy 4: Normalized alphanumeric title key
      ...(camelSplit && camelSplit !== normalized ? [camelSplit] : []),
      ...bilingualParts,
      ...(cleanRaw.includes('+')
        ? [normalized.replace(/\+/g, ' ').replace(/\s+/g, ' ').trim()]
        : []),
      ...(hasCorroboratingMetadata
        ? [
            normalized.split(':')[0].trim(),          // Base title without subtitle (corroborated)
            normalized.split('-')[0].trim(),          // Base title before dash (corroborated)
          ]
        : []),
      normalized.replace(/^(the|a|an)\s+/i, '').trim(), // Without leading article
    ];

    const uniqueTerms = Array.from(
      new Set(
        searchStrategies.filter(
          (s) => s.length >= 3 || (s.length === 2 && normBaseKey.length === 2)
        )
      )
    );
    let completedAllQueriesCleanly = true;
    let sawTruncatedStoreSearch = false;

    for (const term of uniqueTerms) {
      if (!onlineLifecycleManager.isOnline()) {
        completedAllQueriesCleanly = false;
        break;
      }
      try {
        const baseUrl = this.getStoreSearchBaseUrl();
        const url = `${baseUrl}/api/storesearch/?term=${encodeURIComponent(term)}&l=english&cc=US`;
        const res = await requestScheduler.schedule(
          url,
          () => axios.get<{ items?: Array<{ id: number; name?: string }> }>(url, { timeout: 7000 }),
          effectivePriority,
          'store.steampowered.com'
        );

        if (
          isWafOrChallengeResponse(
            res.status,
            res.data,
            res.headers as Record<string, string | string[] | undefined>,
            true
          ) ||
          res.status === 429 ||
          res.status >= 500
        ) {
          completedAllQueriesCleanly = false;
          break;
        }

        const items = res.data?.items;
        if (Array.isArray(items) && items.length > 0) {
          if (items.length >= 10) {
            sawTruncatedStoreSearch = true;
          }
          const bestCandidate = this.scoreCandidateItems(
            items,
            cleanRaw,
            lowerKey,
            normalized,
            normBaseKey,
            options,
            68
          );
          if (bestCandidate) {
            return this.commitPositiveMatch(
              lowerKey,
              cleanRaw,
              normalized,
              bestCandidate.id,
              bestCandidate.name
            );
          }
        }
      } catch {
        // If rate-limited or network error, stop dynamic search and do NOT poison negative cache!
        completedAllQueriesCleanly = false;
        this.inFlightFailedKeys.add(lowerKey);
        break;
      }
    }

    // 5. Truncated Top-10 StoreSearch Fallback (/search/results/ category1=998 Games-only up to 25 items)
    // Rescues short/1-word base games pushed below rank 10 in /api/storesearch/ by DLC/soundtrack floods.
    if (completedAllQueriesCleanly && sawTruncatedStoreSearch && onlineLifecycleManager.isOnline()) {
      const fallbackTerm = strippedBase || normBaseKey || normalized;
      if (fallbackTerm.length >= 2) {
        try {
          const baseUrl = this.getStoreSearchBaseUrl();
          const fallbackUrl = `${baseUrl}/search/results/?term=${encodeURIComponent(fallbackTerm)}&json=1&category1=998&cc=us&l=english`;
          const fallbackRes = await requestScheduler.schedule(
            fallbackUrl,
            () =>
              axios.get<{ items?: Array<{ id?: number; name?: string; logo?: string }> }>(
                fallbackUrl,
                { timeout: 7000 }
              ),
            effectivePriority,
            'store.steampowered.com'
          );
          if (
            isWafOrChallengeResponse(
              fallbackRes.status,
              fallbackRes.data,
              fallbackRes.headers as Record<string, string | string[] | undefined>,
              true
            ) ||
            fallbackRes.status === 429 ||
            fallbackRes.status >= 500
          ) {
            completedAllQueriesCleanly = false;
          } else if (Array.isArray(fallbackRes.data?.items) && fallbackRes.data.items.length > 0) {
            const parsedItems: Array<{ id: number; name?: string }> = [];
            for (const rawItem of fallbackRes.data.items.slice(0, 25)) {
              const directId = typeof rawItem?.id === 'number' ? rawItem.id : 0;
              const logoMatch =
                directId > 0
                  ? null
                  : String(rawItem?.logo || '').match(/\/steam\/apps\/(\d+)\//);
              const extractedId = directId > 0 ? directId : logoMatch ? parseInt(logoMatch[1], 10) : 0;
              if (extractedId > 0 && typeof rawItem?.name === 'string') {
                parsedItems.push({ id: extractedId, name: rawItem.name });
              }
            }
            const fallbackBest = this.scoreCandidateItems(
              parsedItems,
              cleanRaw,
              lowerKey,
              normalized,
              normBaseKey,
              options,
              70
            );
            if (fallbackBest) {
              return this.commitPositiveMatch(
                lowerKey,
                cleanRaw,
                normalized,
                fallbackBest.id,
                fallbackBest.name
              );
            }
          }
        } catch (err: unknown) {
          const status =
            err && typeof err === 'object' && 'response' in err
              ? (err as { response?: { status?: number } }).response?.status
              : undefined;
          if (status === 429 || (typeof status === 'number' && status >= 500) || !status) {
            completedAllQueriesCleanly = false;
            this.inFlightFailedKeys.add(lowerKey);
          }
        }
      }
    }

    // Only record negative match when online AND all queries completed cleanly without transient/WAF errors
    if (completedAllQueriesCleanly && onlineLifecycleManager.isOnline()) {
      const nextFailureCount = (this.negativeFailureCounts.get(lowerKey) || 0) + 1;
      this.recordNegativeMatch(lowerKey, Date.now(), nextFailureCount);
    }
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
   * Resolves the authoritative Steam App ID for a game, respecting user overrides,
   * explicit non-Steam flags, and manual null overrides, falling back to instant high-confidence matching.
   */
  getEffectiveSteamAppId(game?: EffectiveSteamLookupInput | CanonicalGame | null): number | undefined {
    return resolveEffectiveSteamAppId(game, (title) => this.matchGameToSteamInstant(title));
  }

  normalizeTitleKey(title: string): string {
    return normalizeTitleKey(title);
  }

  stripEditionSuffix(title: string): string {
    return stripEditionSuffix(title);
  }
}

export const steamMatcher = new SteamMatcherService();
registerInstantSteamTitleMatcher((title) => steamMatcher.matchGameToSteamInstant(title));

/**
 * Resolves the authoritative Steam App ID for a game, respecting user overrides,
 * explicit non-Steam flags, and manual null overrides, falling back to instant high-confidence matching.
 */
export function getEffectiveSteamAppId(
  game?: EffectiveSteamLookupInput | CanonicalGame | null
): number | undefined {
  return steamMatcher.getEffectiveSteamAppId(game);
}

export {
  normalizeTitleKey,
  stripEditionSuffix,
  ROMAN_TO_ARABIC,
  EDITION_TOKENS,
};
