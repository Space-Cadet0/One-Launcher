import axios from 'axios';
import { CanonicalGame } from '../../contracts/game';
import { computeAdaptive404RetryDelayMs, isWafOrChallengeResponse } from '../../contracts/network';
import { computeEntityMatchConfidence } from '../common/entityResolver';
import { LruMap } from '../common/lruMap';
import { getSafeLocalStorage, isTestEnv } from '../common/runtimeEnv';
import { computeTitleSimilarity as sharedComputeTitleSimilarity } from '../common/titleMatching';
import {
  normalizeTitleKey,
  stripEditionSuffix,
  stripYearEditionPhrases,
  stripPackagingEditionPhrases,
  stripIntermediateSubtitleNumeral,
  foldLatinLigaturesAndDiacritics,
  splitCamelCaseTitle,
  stripStorefrontPlatformDisambiguators,
  extractSequelIdentifier as commonExtractSequelIdentifier,
  ROMAN_TO_ARABIC,
  EDITION_TOKENS,
} from '../common/titleUtils';
import { isKnownDeadSteamCover } from '../igdb/igdbCoverService';
import { getDevProxyBaseForRoute } from '../network/browserDevProxy';
import { onlineLifecycleManager } from '../network/onlineLifecycleManager';
import { requestScheduler, Priority } from '../network/requestScheduler';
import { isIndexedDbAvailable, vaultDelete, vaultGet, vaultSet } from '../storage/indexedDbVault';
import {
  reconcileCapsuleImage,
  reconcileHeaderImage,
  type ArtworkRecoveryContext,
} from '../storage/metadataReconciliation';
import { TIER_TTLS } from '../storage/stagedCacheService';
import steamEnrichedCache from '../storage/steamEnrichedCache.json';
import {
  registerInstantSteamTitleMatcher,
  resolveEffectiveSteamAppId,
  type EffectiveSteamLookupInput,
} from '../storage/userOverrideStorage';
import { steamApi } from './steamApi';

const STOREFRONT_DISTRIBUTION_SUFFIX_RE =
  /(?:[:\-–—]\s*|\s+)(?:amazon\s+prime(?:\s+gaming)?|prime\s+gaming|ea\s+play(?:\s+pro)?|ubisoft\s+connect|xbox\s+game\s+pass)(?:\s+(?:edition|version))?\s*$/gi;
const STOREFRONT_DISTRIBUTION_DETECTOR_RE =
  /(?:[:\-–—]\s*|\s+)(?:amazon\s+prime(?:\s+gaming)?|prime\s+gaming|ea\s+play(?:\s+pro)?|ubisoft\s+connect|xbox\s+game\s+pass)(?:\s+(?:edition|version))?\s*$/i;

function stripStorefrontMatchSuffixes(rawTitle: string): string {
  if (!rawTitle || typeof rawTitle !== 'string') return '';
  let cur = rawTitle.replace(/\s+/g, ' ').trim();
  for (let pass = 0; pass < 3; pass++) {
    const prev = cur;
    cur = stripStorefrontPlatformDisambiguators(
      cur.replace(STOREFRONT_DISTRIBUTION_SUFFIX_RE, '').replace(/\s+/g, ' ').trim()
    );
    if (cur === prev) break;
  }
  return cur || rawTitle.trim();
}

function hasStorefrontDistributionSuffix(rawTitle: string): boolean {
  return STOREFRONT_DISTRIBUTION_DETECTOR_RE.test(rawTitle);
}

/**
 * Optional static Steam AppID mapping table (empty by default for universal dynamic resolution).
 */
export const KNOWN_STORE_STEAM_MAPPINGS: Record<string, number> = {};

/**
 * Canonicalizes title strings by stripping punctuation, trademark symbols, and whitespace.
 */
export function canonicalizeTitleKey(str: string): string {
  if (!str) return '';
  return stripYearEditionPhrases(stripStorefrontMatchSuffixes(str))
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

  let title = stripYearEditionPhrases(stripStorefrontMatchSuffixes(rawTitle))
    .replace(/[™®©℠•·𝄞★☆]/g, ' ')
    .replace(/\s+:/g, ':')
    .replace(/\s*\((?:19|20)\d{2}\)/g, '')
    .replace(/\s+/g, ' ')
    .trim();

  // Strip store and edition suffixes
  const suffixes = [
    /(?::|\s+-|\s+–|\s+—|\s+)?\s*(?:\(|\[)?\s*(?:Digital Deluxe|Digital Premium|Premium|Deluxe|Enhanced Edition Director['’]?s Cut|Enhanced|Game of the Year|GOTY|Definitive|Extended|Director['’]?s Cut|Complete|Standard|Remastered|DRM-Free|Royal|Ultimate|The Final Cut|Emperor|Gold|Vault|Launch|Founders?|Cross[\s-]Gen|Celebration|International|Collector['’]?s|Anniversary|Windows(?:\s*10|\s*11)?|PC)\s+(?:Edition|Pack|Bundle|Collection|Version)(?:\)|\])?/gi,
    /(?::|\s+-|\s+–|\s+—|\s+)?\s*(?:\(|\[)?\s*(?:Director['’]?s Cut|The Final Cut|GOG Cut|Remastered|GOTY|Game Preview)(?:\)|\])?/gi,
  ];

  for (const pattern of suffixes) {
    title = title.replace(pattern, '').trim();
  }

  title = stripStorefrontMatchSuffixes(title);

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

/**
 * Computes canonical token similarity in `[0, 1]` between two game titles, delegating to the
 * shared Layer-0 `titleMatching.computeTitleSimilarity` implementation.
 */
export function computeTitleSimilarity(source: string, candidate: string): number {
  return sharedComputeTitleSimilarity(source, candidate, {
    requireDelimiterForDisjointCheck: false,
    checkEditionStrippedEquality: false,
  });
}

const STORAGE_KEY_MATCHED_APP_IDS = 'steam_app_id_match_cache_v5';
const LEGACY_STORAGE_KEY_MATCHED_APP_IDS_V4 = 'steam_app_id_match_cache_v4';
const STORAGE_KEY_MATCHER_SCHEMA = 'antigravity_steam_matcher_schema_v5';
const POSITIVE_MATCH_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const NEGATIVE_MATCH_TTL_MS = TIER_TTLS.negative; // 7 days = 604,800,000 ms
const NON_GAME_SOURCE_REGEX =
  /\b(public testing|tech beta|playtest|test branch|official walkthrough|walkthrough|digital goodies|pre-game editor|resource archiver|bonus content|artbook|soundtrack|ost)\b|\bcontent$/i;
export const DISTINCT_EDITION_TOKEN_REGEX =
  /\b(remastered|remaster|remake|enhanced|definitive|redux|director'?s cut|anniversary)\b/i;

function tokenizeSimilarityWords(text: string): string[] {
  const cleaned = foldLatinLigaturesAndDiacritics(
    stripYearEditionPhrases(stripStorefrontMatchSuffixes(text))
  )
    .toLowerCase()
    .replace(/['’‘"“”]/g, '')
    .replace(/(\d),(\d)/g, '$1$2')
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
const MAX_INSTANT_MEMO_ENTRIES = 16384;
const NEGATIVE_SELF_HEAL_REV = 2;
const NON_ASCII_CHAR_RE = /[^\x00-\x7f]/;
const DIGIT_COMMA_RE = /\d,\d/;
const SAVE_DEBOUNCE_MS = 200;
const TEST_SAVE_DEBOUNCE_MS = 10;

/**
 * Identifies titles whose previously cached negative (`appId: null`) v5 entries should be
 * lazily self-healed because newer matching passes cover intermediate-numeral subtitles,
 * non-ASCII diacritics, digit-commas ("40,000"), and multi-word packaging edition phrases.
 */
function isNegativeCacheSelfHealCandidate(title: string): boolean {
  if (!title) return false;
  if (NON_ASCII_CHAR_RE.test(title)) return true;
  if (DIGIT_COMMA_RE.test(title)) return true;
  if (stripIntermediateSubtitleNumeral(title) !== null) return true;
  if (stripPackagingEditionPhrases(title) !== title) return true;
  return false;
}

interface PersistedPositiveMatchRecord {
  appId: number;
  cachedAt: number;
}

interface PersistedNegativeMatchRecord {
  appId?: null;
  id?: null;
  cachedAt: number;
  failureCount?: number;
  healRev?: number;
}

type PersistedMatchRecord = number | PersistedPositiveMatchRecord | PersistedNegativeMatchRecord;

const activeSteamMatcherInstances = new Set<SteamMatcherService>();
let steamMatcherBeforeUnloadAttached = false;

function registerSteamMatcherUnloadFlush(instance: SteamMatcherService): void {
  activeSteamMatcherInstances.add(instance);
  if (steamMatcherBeforeUnloadAttached) return;
  if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
    steamMatcherBeforeUnloadAttached = true;
    try {
      window.addEventListener('beforeunload', () => {
        for (const svc of activeSteamMatcherInstances) {
          svc.flushPendingSave();
        }
      });
    } catch {
      // Ignore partial window mock environments in unit tests
    }
  }
}

export class SteamMatcherService {
  private cache = new Map<string, number | null>();
  private positiveTimestamps = new Map<string, number>();
  private negativeTimestamps = new Map<string, number>();
  private negativeFailureCounts = new Map<string, number>();
  private negativeHealRevs = new Map<string, number>();
  private instantMemo = new LruMap<string, number | null>(MAX_INSTANT_MEMO_ENTRIES);
  private inFlightFailedKeys = new Set<string>();
  private inFlightMatches = new Map<string, Promise<number | null>>();
  private enrichedEntries: EnrichedMatchEntry[] | null = null;
  private enrichedWordIndex: Map<string, number[]> | null = null;
  private pendingSaveTimer: ReturnType<typeof setTimeout> | null = null;
  private cacheGeneration = 0;

  // P0-9 IDB Hydration-Before-Write Barrier state
  private vaultHydrationState: 'idle' | 'pending' | 'done' = 'idle';
  private vaultHydrationPromise: Promise<void> | null = null;
  private pendingVaultSaveAfterHydration = false;

  constructor() {
    this.loadPersistentCache();
    if (isIndexedDbAvailable()) {
      void this.hydratePersistentCacheFromVault();
    } else {
      this.vaultHydrationState = 'done';
    }
    try {
      registerSteamMatcherUnloadFlush(this);
      onlineLifecycleManager.onOnline(() => {
        this.inFlightFailedKeys.clear();
        this.instantMemo.prune((v, k) => v === null && !this.cache.has(k));
      });
    } catch {
      // Ignore partial window mock environments in unit tests
    }
  }

  private setCacheBounded(key: string, val: number | null, positiveCachedAt?: number): void {
    if (this.cache.has(key)) {
      this.cache.delete(key);
    }
    this.cache.set(key, val);
    if (typeof val === 'number' && val > 0) {
      this.positiveTimestamps.set(key, positiveCachedAt ?? Date.now());
    } else {
      this.positiveTimestamps.delete(key);
    }
    while (this.cache.size > MAX_MATCH_CACHE_ENTRIES) {
      const oldest = this.cache.keys().next().value;
      if (oldest === undefined) break;
      this.cache.delete(oldest);
      this.positiveTimestamps.delete(oldest);
      this.negativeTimestamps.delete(oldest);
      this.negativeFailureCounts.delete(oldest);
      this.negativeHealRevs.delete(oldest);
    }
  }

  private shouldSelfHealNegativeCacheKey(lowerKey: string, rawTitle?: string): boolean {
    const rev = this.negativeHealRevs.get(lowerKey) ?? 0;
    if (rev >= NEGATIVE_SELF_HEAL_REV) return false;
    return (
      isNegativeCacheSelfHealCandidate(lowerKey) ||
      (typeof rawTitle === 'string' &&
        rawTitle.length > 0 &&
        isNegativeCacheSelfHealCandidate(rawTitle))
    );
  }

  private purgeNegativeCacheKey(lowerKey: string): void {
    this.cache.delete(lowerKey);
    this.negativeTimestamps.delete(lowerKey);
    this.negativeFailureCounts.delete(lowerKey);
    this.negativeHealRevs.delete(lowerKey);
    if (this.instantMemo.peek(lowerKey) === null) {
      this.instantMemo.delete(lowerKey);
    }
  }

  private isPositiveEntryFresh(key: string): boolean {
    const cachedAt = this.positiveTimestamps.get(key);
    if (cachedAt === undefined) return true;
    return Date.now() - cachedAt < POSITIVE_MATCH_TTL_MS;
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
    const delayMs = isTestEnv() ? TEST_SAVE_DEBOUNCE_MS : SAVE_DEBOUNCE_MS;
    this.pendingSaveTimer = setTimeout(() => {
      this.pendingSaveTimer = null;
      this.savePersistentCache();
    }, delayMs);
  }

  public flushPendingSave(): void {
    if (this.pendingSaveTimer !== null) {
      clearTimeout(this.pendingSaveTimer);
      this.pendingSaveTimer = null;
      this.savePersistentCache();
    }
  }

  private getNegativeMatchTtlMs(key: string): number {
    const count = this.negativeFailureCounts.get(key);
    if (typeof count === 'number' && count >= 1) {
      return computeAdaptive404RetryDelayMs(count);
    }
    return NEGATIVE_MATCH_TTL_MS;
  }

  private getEnrichedCandidateEntries(normalizedTitle: string): EnrichedMatchEntry[] {
    if (!this.enrichedEntries) {
      const rawEnriched = steamEnrichedCache as Record<string, { name?: string } | undefined>;
      const keys = Object.keys(rawEnriched);
      if (keys.length === 0) {
        this.enrichedEntries = [];
        this.enrichedWordIndex = null;
        return [];
      }

      const entries: EnrichedMatchEntry[] = [];
      const index = new Map<string, number[]>();
      for (const idStr of keys) {
        const data = rawEnriched[idStr];
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

    if (this.enrichedEntries.length === 0 || !this.enrichedWordIndex) {
      return [];
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
      .toSorted((a, b) => a - b)
      .map((idx) => entries[idx]);
  }

  private ingestPersistedMatchEntries(
    recordMap: Record<string, unknown>,
    options: { isLegacyV4: boolean; allowNegativeRecords: boolean; skipExistingPositives?: boolean }
  ): { ingestedAny: boolean; sweptStaleNegative: boolean } {
    let ingestedAny = false;
    let sweptStaleNegative = false;
    const now = Date.now();
    const rawEnriched = steamEnrichedCache as Record<string, { name?: string } | undefined>;

    for (const [rawKey, v] of Object.entries(recordMap)) {
      const rawLower = rawKey.toLowerCase().trim();
      if (!rawLower || NON_GAME_SOURCE_REGEX.test(rawLower)) {
        continue;
      }

      // On legacy v4 migration, drop entries carrying storefront distribution suffixes
      if (options.isLegacyV4 && hasStorefrontDistributionSuffix(rawLower)) {
        continue;
      }

      const lk = stripStorefrontMatchSuffixes(rawLower).toLowerCase().trim();
      if (!lk || NON_GAME_SOURCE_REGEX.test(lk)) {
        continue;
      }

      const existingVal = this.cache.get(lk);
      if (options.skipExistingPositives && typeof existingVal === 'number' && existingVal > 0) {
        continue;
      }

      // Positive match: either v5 `{ appId: number, cachedAt: number }` or legacy bare `number`
      let positiveAppId: number | null = null;
      let positiveCachedAt = now;
      if (typeof v === 'number' && v > 0) {
        positiveAppId = v;
        positiveCachedAt = now;
      } else if (
        v &&
        typeof v === 'object' &&
        typeof (v as Partial<PersistedPositiveMatchRecord>).appId === 'number' &&
        ((v as Partial<PersistedPositiveMatchRecord>).appId as number) > 0
      ) {
        const posRec = v as Partial<PersistedPositiveMatchRecord>;
        positiveAppId = posRec.appId as number;
        positiveCachedAt =
          typeof posRec.cachedAt === 'number' && posRec.cachedAt > 0 ? posRec.cachedAt : now;
      }

      if (positiveAppId !== null) {
        if (now - positiveCachedAt >= POSITIVE_MATCH_TTL_MS) {
          continue;
        }
        const enrichedName = rawEnriched[String(positiveAppId)]?.name;
        if (
          enrichedName &&
          (computeTitleSimilarity(normalizeGameTitle(lk), enrichedName) < 0.85 ||
            DISTINCT_EDITION_TOKEN_REGEX.test(lk) !==
              DISTINCT_EDITION_TOKEN_REGEX.test(enrichedName))
        ) {
          continue;
        }
        this.setCacheBounded(lk, positiveAppId, positiveCachedAt);
        this.negativeTimestamps.delete(lk);
        this.negativeFailureCounts.delete(lk);
        this.negativeHealRevs.delete(lk);
        if (this.instantMemo.peek(lk) === null) {
          this.instantMemo.delete(lk);
        }
        ingestedAny = true;
        continue;
      }

      if (v === null) {
        continue;
      }

      if (typeof v === 'object' && v !== null && options.allowNegativeRecords) {
        const negRec = v as Partial<PersistedNegativeMatchRecord>;
        const cachedAt = typeof negRec.cachedAt === 'number' ? negRec.cachedAt : 0;
        const healRev = typeof negRec.healRev === 'number' ? negRec.healRev : 0;
        const existingNegTs = this.negativeTimestamps.get(lk) || 0;
        if (options.skipExistingPositives && existingVal === null && existingNegTs >= cachedAt) {
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
        const isExpired = now - cachedAt >= effectiveTtlMs;
        if (negRec.appId === null || negRec.id === null) {
          if (
            healRev < NEGATIVE_SELF_HEAL_REV &&
            (isNegativeCacheSelfHealCandidate(rawKey) || isNegativeCacheSelfHealCandidate(lk))
          ) {
            this.purgeNegativeCacheKey(lk);
            sweptStaleNegative = true;
            continue;
          }
          if (failureCount !== undefined) {
            this.negativeFailureCounts.set(lk, failureCount);
          }
          if (!isExpired) {
            this.setCacheBounded(lk, null);
            this.setNegativeTimestampBounded(lk, cachedAt);
            if (healRev > 0) {
              this.negativeHealRevs.set(lk, healRev);
            }
            this.instantMemo.delete(lk);
            ingestedAny = true;
          }
        }
      }
    }

    return { ingestedAny, sweptStaleNegative };
  }

  private buildPersistedCachePayload(): Record<string, PersistedMatchRecord> {
    const now = Date.now();
    const obj: Record<string, PersistedMatchRecord> = {};
    for (const [k, v] of this.cache.entries()) {
      if (typeof v === 'number' && v > 0) {
        const cachedAt = this.positiveTimestamps.get(k) ?? now;
        if (now - cachedAt < POSITIVE_MATCH_TTL_MS) {
          obj[k] = { appId: v, cachedAt };
        }
      } else if (v === null) {
        const cachedAt = this.negativeTimestamps.get(k) || now;
        const failureCount = this.negativeFailureCounts.get(k);
        const healRev = this.negativeHealRevs.get(k);
        const rec: PersistedNegativeMatchRecord = { appId: null, cachedAt };
        if (failureCount !== undefined) {
          rec.failureCount = failureCount;
        }
        if (healRev !== undefined && healRev > 0) {
          rec.healRev = healRev;
        }
        obj[k] = rec;
      }
    }
    return obj;
  }

  private loadPersistentCache(): void {
    const storage = getSafeLocalStorage();
    if (!storage) return;
    try {
      storage.removeItem('steam_app_id_match_cache_v3');
      storage.removeItem('antigravity_steam_matched_app_ids');

      const hasV5Schema = storage.getItem(STORAGE_KEY_MATCHER_SCHEMA) === '1';
      let needsPersistV5 = false;

      const rawV5 = storage.getItem(STORAGE_KEY_MATCHED_APP_IDS);
      if (rawV5) {
        const parsedV5: unknown = JSON.parse(rawV5);
        if (parsedV5 && typeof parsedV5 === 'object' && !Array.isArray(parsedV5)) {
          const resV5 = this.ingestPersistedMatchEntries(parsedV5 as Record<string, unknown>, {
            isLegacyV4: false,
            allowNegativeRecords: true,
          });
          if (resV5.sweptStaleNegative) {
            needsPersistV5 = true;
          }
        }
      }

      // One-time sanitized migration from legacy steam_app_id_match_cache_v4 -> v5
      const rawV4 = storage.getItem(LEGACY_STORAGE_KEY_MATCHED_APP_IDS_V4);
      if (rawV4) {
        try {
          const parsedV4: unknown = JSON.parse(rawV4);
          if (parsedV4 && typeof parsedV4 === 'object' && !Array.isArray(parsedV4)) {
            this.ingestPersistedMatchEntries(parsedV4 as Record<string, unknown>, {
              isLegacyV4: true,
              allowNegativeRecords: hasV5Schema,
              skipExistingPositives: true,
            });
          }
        } catch {
          // Ignore malformed legacy v4 cache
        }
        storage.removeItem(LEGACY_STORAGE_KEY_MATCHED_APP_IDS_V4);
        needsPersistV5 = true;
      }

      if (needsPersistV5 || (rawV5 && !hasV5Schema)) {
        storage.setItem(STORAGE_KEY_MATCHER_SCHEMA, '1');
        this.savePersistentCache();
      }
    } catch {
      // Ignore read errors
    }
  }

  /**
   * Hydrates persisted matches from IndexedDB and merges them with any in-memory entries.
   * Implements the P0-9 hydration-before-write barrier so early writes never clobber IDB.
   */
  public hydratePersistentCacheFromVault(): Promise<void> {
    if (typeof window === 'undefined') return Promise.resolve();
    if (this.vaultHydrationState === 'done') return Promise.resolve();
    if (this.vaultHydrationPromise) return this.vaultHydrationPromise;
    if (!isIndexedDbAvailable()) {
      this.vaultHydrationState = 'done';
      return Promise.resolve();
    }

    this.vaultHydrationState = 'pending';
    const gen = this.cacheGeneration;

    let flight: Promise<void> | null = null;
    flight = (async (): Promise<void> => {
      try {
        const [vaultDataV5, vaultDataV4] = await Promise.all([
          vaultGet<Record<string, unknown>>(STORAGE_KEY_MATCHED_APP_IDS),
          vaultGet<Record<string, unknown>>(LEGACY_STORAGE_KEY_MATCHED_APP_IDS_V4),
        ]);
        if (gen !== this.cacheGeneration) return;

        let hydratedAny = false;
        let sweptAnyNegative = false;
        if (vaultDataV5 && typeof vaultDataV5 === 'object' && !Array.isArray(vaultDataV5)) {
          const resV5 = this.ingestPersistedMatchEntries(vaultDataV5, {
            isLegacyV4: false,
            allowNegativeRecords: true,
            skipExistingPositives: true,
          });
          if (resV5.ingestedAny) hydratedAny = true;
          if (resV5.sweptStaleNegative) sweptAnyNegative = true;
        }

        let migratedLegacyV4 = false;
        if (vaultDataV4 && typeof vaultDataV4 === 'object' && !Array.isArray(vaultDataV4)) {
          const resV4 = this.ingestPersistedMatchEntries(vaultDataV4, {
            isLegacyV4: true,
            allowNegativeRecords: true,
            skipExistingPositives: true,
          });
          if (resV4.ingestedAny) hydratedAny = true;
          if (resV4.sweptStaleNegative) sweptAnyNegative = true;
          migratedLegacyV4 = true;
          void vaultDelete(LEGACY_STORAGE_KEY_MATCHED_APP_IDS_V4);
        }

        this.vaultHydrationState = 'done';
        const hadPendingWrite = this.pendingVaultSaveAfterHydration;
        this.pendingVaultSaveAfterHydration = false;

        if (hydratedAny || migratedLegacyV4 || sweptAnyNegative || hadPendingWrite) {
          const obj = this.buildPersistedCachePayload();
          if (migratedLegacyV4 || sweptAnyNegative || hadPendingWrite) {
            await vaultSet(STORAGE_KEY_MATCHED_APP_IDS, obj);
          }
          const storage = getSafeLocalStorage();
          if (storage) {
            try {
              storage.setItem(STORAGE_KEY_MATCHED_APP_IDS, JSON.stringify(obj));
              storage.setItem(STORAGE_KEY_MATCHER_SCHEMA, '1');
            } catch {
              // Ignore localStorage quota errors; IndexedDB already holds full cache
            }
          }
        }
      } catch {
        if (gen === this.cacheGeneration) {
          this.vaultHydrationState = 'done';
          if (this.pendingVaultSaveAfterHydration) {
            this.pendingVaultSaveAfterHydration = false;
            const obj = this.buildPersistedCachePayload();
            void vaultSet(STORAGE_KEY_MATCHED_APP_IDS, obj);
          }
        }
      } finally {
        if (this.vaultHydrationPromise === flight) {
          this.vaultHydrationPromise = null;
        }
      }
    })();

    this.vaultHydrationPromise = flight;
    return flight;
  }

  private savePersistentCache(): void {
    if (typeof window === 'undefined') return;
    if (this.pendingSaveTimer !== null) {
      clearTimeout(this.pendingSaveTimer);
      this.pendingSaveTimer = null;
    }
    const obj = this.buildPersistedCachePayload();
    if (isIndexedDbAvailable()) {
      if (this.vaultHydrationState === 'done') {
        void vaultSet(STORAGE_KEY_MATCHED_APP_IDS, obj);
      } else {
        // Hydration-before-write barrier: defer IDB persistence until existing IDB records are merged
        this.pendingVaultSaveAfterHydration = true;
        void this.hydratePersistentCacheFromVault();
      }
    }
    const storage = getSafeLocalStorage();
    if (storage) {
      try {
        storage.setItem(STORAGE_KEY_MATCHED_APP_IDS, JSON.stringify(obj));
        storage.setItem(STORAGE_KEY_MATCHER_SCHEMA, '1');
      } catch {
        // Ignore write errors
      }
    }
  }

  private recordNegativeMatch(
    key: string,
    timestamp: number = Date.now(),
    failureCount?: number
  ): void {
    this.setCacheBounded(key, null);
    this.setNegativeTimestampBounded(key, timestamp);
    this.negativeHealRevs.set(key, NEGATIVE_SELF_HEAL_REV);
    if (typeof failureCount === 'number' && failureCount >= 1) {
      this.negativeFailureCounts.set(key, Math.floor(failureCount));
    }
    this.instantMemo.delete(key);
    this.schedulePersistentCacheSave();
  }

  public clearCache(): void {
    this.cacheGeneration += 1;
    if (this.pendingSaveTimer !== null) {
      clearTimeout(this.pendingSaveTimer);
      this.pendingSaveTimer = null;
    }
    this.cache.clear();
    this.positiveTimestamps.clear();
    this.negativeTimestamps.clear();
    this.negativeFailureCounts.clear();
    this.negativeHealRevs.clear();
    this.inFlightFailedKeys.clear();
    this.inFlightMatches.clear();
    this.instantMemo.clear();
    this.enrichedEntries = null;
    this.enrichedWordIndex = null;
    this.vaultHydrationState = 'done';
    this.vaultHydrationPromise = null;
    this.pendingVaultSaveAfterHydration = false;
    void vaultDelete(STORAGE_KEY_MATCHED_APP_IDS);
    void vaultDelete(LEGACY_STORAGE_KEY_MATCHED_APP_IDS_V4);
    const storage = getSafeLocalStorage();
    if (storage) {
      try {
        storage.removeItem(STORAGE_KEY_MATCHED_APP_IDS);
        storage.removeItem(LEGACY_STORAGE_KEY_MATCHED_APP_IDS_V4);
      } catch {
        // Ignore storage errors
      }
    }
  }

  private getStoreSearchBaseUrl(): string {
    return getDevProxyBaseForRoute('steamStore');
  }

  /**
   * Checks whether a Steam match lookup has already been attempted (positively or negatively within TTL).
   */
  public hasAttemptedMatch(title: string): boolean {
    if (!title || !title.trim()) return true;
    const cleanRaw = stripStorefrontMatchSuffixes(title.trim());
    const lowerKey = cleanRaw.toLowerCase();

    if (this.matchGameToSteamInstant(cleanRaw)) {
      return true;
    }

    const normalized = normalizeGameTitle(cleanRaw).toLowerCase();
    if (
      NON_GAME_SOURCE_REGEX.test(title) ||
      NON_GAME_SOURCE_REGEX.test(cleanRaw) ||
      KNOWN_NON_STEAM_TITLES.has(lowerKey) ||
      KNOWN_NON_STEAM_TITLES.has(normalized)
    ) {
      return true;
    }

    if (this.cache.has(lowerKey)) {
      const val = this.cache.get(lowerKey);
      if (typeof val === 'number' && val > 0) {
        if (this.isPositiveEntryFresh(lowerKey)) {
          return true;
        }
        this.cache.delete(lowerKey);
        this.positiveTimestamps.delete(lowerKey);
      }
      if (val === null) {
        if (this.shouldSelfHealNegativeCacheKey(lowerKey, title)) {
          this.purgeNegativeCacheKey(lowerKey);
          return false;
        }
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
   * Fast, synchronous lookup against curated mappings and local caches without network requests.
   */
  matchGameToSteamInstant(title: string): number | null {
    if (!title || !title.trim()) return null;
    const cleanRaw = stripStorefrontMatchSuffixes(title.trim());
    const lowerKey = cleanRaw.toLowerCase();
    if (this.instantMemo.has(lowerKey)) {
      const memoVal = this.instantMemo.get(lowerKey) ?? null;
      if (memoVal === null || !this.cache.has(lowerKey) || this.isPositiveEntryFresh(lowerKey)) {
        return memoVal;
      }
      this.instantMemo.delete(lowerKey);
    }
    if (NON_GAME_SOURCE_REGEX.test(title) || NON_GAME_SOURCE_REGEX.test(cleanRaw)) {
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

    // 2. Check in-memory / persistent cache (enforcing 30-day positive TTL)
    if (this.cache.has(lowerKey)) {
      const val = this.cache.get(lowerKey);
      if (typeof val === 'number' && val > 0) {
        if (this.isPositiveEntryFresh(lowerKey)) {
          this.instantMemo.set(lowerKey, val);
          return val;
        }
        this.cache.delete(lowerKey);
        this.positiveTimestamps.delete(lowerKey);
      }
      if (val === null) {
        if (this.shouldSelfHealNegativeCacheKey(lowerKey, title)) {
          this.purgeNegativeCacheKey(lowerKey);
        } else {
          const cachedAt = this.negativeTimestamps.get(lowerKey);
          if (cachedAt && Date.now() - cachedAt < this.getNegativeMatchTtlMs(lowerKey)) {
            this.instantMemo.set(lowerKey, null);
            return null;
          }
          this.purgeNegativeCacheKey(lowerKey);
        }
      }
    }

    const cleanHasDistinctEdition = DISTINCT_EDITION_TOKEN_REGEX.test(cleanRaw);
    if (!cleanHasDistinctEdition && normalized && this.cache.has(normalized)) {
      const normVal = this.cache.get(normalized);
      if (typeof normVal === 'number' && normVal > 0 && this.isPositiveEntryFresh(normalized)) {
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
    this.negativeHealRevs.delete(lowerKey);
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
      this.negativeHealRevs.delete(normalized);
      this.instantMemo.set(normalized, candidateId);
    }
    this.schedulePersistentCacheSave();
    if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
      try {
        window.dispatchEvent(
          new CustomEvent('antigravity:steam-match-updated', {
            detail: { title: cleanRaw, steamAppId: candidateId },
          })
        );
      } catch {
        // Ignore event dispatch errors
      }
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
      const packagingStripped = stripPackagingEditionPhrases(cleanRaw);
      const evalPackaging =
        packagingStripped && packagingStripped !== cleanRaw
          ? computeEntityMatchConfidence(
              {
                title: packagingStripped,
                releaseYear: options?.releaseYear,
                developers: options?.developers,
              },
              {
                title: candidateName,
              }
            )
          : null;

      const isAccepted =
        evalNormalized.isAccepted || evalRaw.isAccepted || Boolean(evalPackaging?.isAccepted);
      const isRebootCollision =
        evalNormalized.isRebootCollision ||
        evalRaw.isRebootCollision ||
        Boolean(evalPackaging?.isRebootCollision);
      let score = Math.max(
        evalNormalized.confidence,
        evalRaw.confidence,
        evalPackaging ? Math.max(0, evalPackaging.confidence - 2) : 0
      );

      if (candLower === normalized && !isRebootCollision) {
        score = Math.min(100, score + 15);
      }

      const rawHasStrictRemaster = /\b(remastered|remaster|remake)\b/i.test(cleanRaw);
      const candHasStrictRemaster = /\b(remastered|remaster|remake)\b/i.test(candidateName);
      if (rawHasStrictRemaster && !candHasStrictRemaster) {
        continue;
      }
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

      // Franchise sibling AppID adjacency tie-breaker
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

      if (
        isAccepted &&
        score >= minScoreThreshold &&
        (!bestCandidate || score > bestCandidate.score)
      ) {
        bestCandidate = { id: item.id, score, name: candidateName };
      }
    }

    return bestCandidate;
  }

  /**
   * Intelligently matches any game title to its official Steam App ID, coalescing
   * concurrent requests for the same title via `inFlightMatches`.
   */
  async matchGameToSteam(
    title: string,
    options?: { releaseYear?: number | string | null; developers?: string[]; priority?: number }
  ): Promise<number | null> {
    if (!title || !title.trim()) return null;
    const cleanRaw = stripStorefrontMatchSuffixes(title.trim());
    const lowerKey = cleanRaw.toLowerCase();
    if (NON_GAME_SOURCE_REGEX.test(title) || NON_GAME_SOURCE_REGEX.test(cleanRaw)) {
      this.recordNegativeMatch(lowerKey);
      return null;
    }

    const normalized = normalizeGameTitle(cleanRaw).toLowerCase();
    if (KNOWN_NON_STEAM_TITLES.has(lowerKey) || KNOWN_NON_STEAM_TITLES.has(normalized)) {
      this.recordNegativeMatch(lowerKey);
      return null;
    }

    // 1. Authoritative curated dictionary check FIRST
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
      this.setCacheBounded(lowerKey, directMatch);
      this.schedulePersistentCacheSave();
      return directMatch;
    }

    // 2. Check in-memory / persistent cache (honoring 30-day positive TTL)
    if (this.cache.has(lowerKey)) {
      const val = this.cache.get(lowerKey);
      if (typeof val === 'number' && val > 0) {
        if (this.isPositiveEntryFresh(lowerKey)) {
          return val;
        }
        this.cache.delete(lowerKey);
        this.positiveTimestamps.delete(lowerKey);
      }
      if (val === null) {
        if (this.shouldSelfHealNegativeCacheKey(lowerKey, title)) {
          this.purgeNegativeCacheKey(lowerKey);
        } else {
          const cachedAt = this.negativeTimestamps.get(lowerKey);
          if (cachedAt && Date.now() - cachedAt < this.getNegativeMatchTtlMs(lowerKey)) {
            return null;
          }
          this.purgeNegativeCacheKey(lowerKey);
        }
      }
    }

    const cleanHasDistinctEdition = DISTINCT_EDITION_TOKEN_REGEX.test(cleanRaw);
    if (!cleanHasDistinctEdition && normalized && this.cache.has(normalized)) {
      const normVal = this.cache.get(normalized);
      if (typeof normVal === 'number' && normVal > 0 && this.isPositiveEntryFresh(normalized)) {
        this.setCacheBounded(lowerKey, normVal);
        this.instantMemo.set(lowerKey, normVal);
        this.schedulePersistentCacheSave();
        return normVal;
      }
    }

    // 3. Check optional populated static enriched cache (no-op when empty)
    const candidateEntries = this.getEnrichedCandidateEntries(normalized);
    for (let i = 0; i < candidateEntries.length; i++) {
      const entry = candidateEntries[i];
      if (cleanHasDistinctEdition !== entry.hasDistinctEdition) {
        continue;
      }
      if (computeTitleSimilarity(normalized, entry.name) >= 0.85) {
        this.setCacheBounded(lowerKey, entry.appId);
        this.negativeFailureCounts.delete(lowerKey);
        this.negativeTimestamps.delete(lowerKey);
        this.negativeHealRevs.delete(lowerKey);
        this.instantMemo.set(lowerKey, entry.appId);
        this.schedulePersistentCacheSave();
        return entry.appId;
      }
    }

    if (!onlineLifecycleManager.isOnline()) {
      this.inFlightFailedKeys.add(lowerKey);
      return null;
    }

    const existingFlight = this.inFlightMatches.get(lowerKey);
    if (existingFlight) {
      return existingFlight;
    }

    const capturedGen = this.cacheGeneration;
    const flight = this.runDynamicSteamSearch(
      cleanRaw,
      lowerKey,
      normalized,
      normBaseKey,
      strippedBase,
      cleanHasDistinctEdition,
      capturedGen,
      options
    );
    this.inFlightMatches.set(lowerKey, flight);
    try {
      return await flight;
    } finally {
      if (this.inFlightMatches.get(lowerKey) === flight) {
        this.inFlightMatches.delete(lowerKey);
      }
    }
  }

  private async runDynamicSteamSearch(
    cleanRaw: string,
    lowerKey: string,
    normalized: string,
    normBaseKey: string,
    strippedBase: string,
    cleanHasDistinctEdition: boolean,
    capturedGen: number,
    options?: { releaseYear?: number | string | null; developers?: string[]; priority?: number }
  ): Promise<number | null> {
    const hasCorroboratingMetadata = Boolean(
      options?.releaseYear || (options?.developers && options.developers.length > 0)
    );
    const effectivePriority =
      options?.priority !== undefined ? options.priority : Priority.P2_BACKGROUND;
    const camelSplit = splitCamelCaseTitle(cleanRaw).toLowerCase();
    const bilingualParts = cleanRaw.includes(' / ')
      ? cleanRaw
          .split(' / ')
          .map((part) => normalizeGameTitle(part).toLowerCase())
          .filter((part) => part.length >= 3)
      : [];
    const intermediateNumeralStripped = stripIntermediateSubtitleNumeral(cleanRaw);
    const packagingStripped = stripPackagingEditionPhrases(cleanRaw);
    const digitCommaStripped = DIGIT_COMMA_RE.test(cleanRaw)
      ? cleanRaw.replace(/(\d),(\d)/g, '$1$2')
      : null;
    const diacriticFolded = NON_ASCII_CHAR_RE.test(cleanRaw)
      ? foldLatinLigaturesAndDiacritics(cleanRaw)
      : null;

    const searchStrategies = [
      ...(cleanHasDistinctEdition ? [cleanRaw] : []),
      normalized,
      cleanRaw,
      ...(intermediateNumeralStripped
        ? [
            normalizeGameTitle(intermediateNumeralStripped).toLowerCase(),
            intermediateNumeralStripped.toLowerCase(),
          ]
        : []),
      ...(packagingStripped !== cleanRaw
        ? [
            normalizeGameTitle(packagingStripped).toLowerCase(),
            packagingStripped.toLowerCase(),
          ]
        : []),
      ...(digitCommaStripped
        ? [
            normalizeGameTitle(digitCommaStripped).toLowerCase(),
            digitCommaStripped.toLowerCase(),
          ]
        : []),
      ...(diacriticFolded && diacriticFolded !== cleanRaw
        ? [normalizeGameTitle(diacriticFolded).toLowerCase()]
        : []),
      strippedBase,
      normBaseKey,
      ...(camelSplit && camelSplit !== normalized ? [camelSplit] : []),
      ...bilingualParts,
      ...(cleanRaw.includes('+')
        ? [normalized.replace(/\+/g, ' ').replace(/\s+/g, ' ').trim()]
        : []),
      ...(hasCorroboratingMetadata
        ? [normalized.split(':')[0].trim(), normalized.split('-')[0].trim()]
        : []),
      normalized.replace(/^(the|a|an)\s+/i, '').trim(),
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
            if (capturedGen !== this.cacheGeneration) {
              return bestCandidate.id;
            }
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
        completedAllQueriesCleanly = false;
        this.inFlightFailedKeys.add(lowerKey);
        break;
      }
    }

    // 5. Truncated Top-10 StoreSearch Fallback (/search/results/ category1=998 Games-only up to 25 items)
    if (completedAllQueriesCleanly && sawTruncatedStoreSearch && onlineLifecycleManager.isOnline()) {
      const fallbackTerm = strippedBase || normBaseKey || normalized;
      if (fallbackTerm.length >= 2) {
        try {
          const baseUrl = this.getStoreSearchBaseUrl();
          const fallbackUrl = `${baseUrl}/search/results/?term=${encodeURIComponent(
            fallbackTerm
          )}&json=1&category1=998&cc=us&l=english`;
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
              const extractedId =
                directId > 0 ? directId : logoMatch ? parseInt(logoMatch[1], 10) : 0;
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
              if (capturedGen !== this.cacheGeneration) {
                return fallbackBest.id;
              }
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
    if (
      completedAllQueriesCleanly &&
      onlineLifecycleManager.isOnline() &&
      capturedGen === this.cacheGeneration
    ) {
      const nextFailureCount = (this.negativeFailureCounts.get(lowerKey) || 0) + 1;
      this.recordNegativeMatch(lowerKey, Date.now(), nextFailureCount);
    }
    return null;
  }

  /**
   * Enriches a CanonicalGame with Steam App ID and monotonically reconciled Steam assets if matched.
   */
  async enrichGameWithSteamMatch(game: CanonicalGame): Promise<CanonicalGame> {
    if (game.steamAppId) return game;

    const matchedId = await this.matchGameToSteam(game.title, {
      releaseYear: game.releaseDate,
      developers: game.developers,
    });
    if (!matchedId) return game;

    const gogPlat = game.platforms?.find((p) => p.platformId === 'gog');
    const browseAssets = steamApi.peekCachedBrowseAssets(matchedId);
    const candidateHeader =
      browseAssets?.headerImage ||
      `https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/${matchedId}/header.jpg`;
    const candidateCapsule =
      browseAssets?.capsuleImage ||
      (!isKnownDeadSteamCover(matchedId)
        ? `https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/${matchedId}/library_600x900_2x.jpg`
        : undefined);

    const artworkCtx: ArtworkRecoveryContext = {
      gameId: game.id,
      title: game.title,
      steamAppId: matchedId,
      gogId: gogPlat?.platformGameId,
    };
    const nextHeader =
      reconcileHeaderImage(game.headerImage, candidateHeader, artworkCtx) ||
      game.headerImage ||
      candidateHeader;
    const nextCapsule = reconcileCapsuleImage(game.capsuleImage, candidateCapsule, {
      ...artworkCtx,
      headerUrl: nextHeader,
    });

    return {
      ...game,
      steamAppId: matchedId,
      id: `steam-${matchedId}`,
      headerImage: nextHeader,
      capsuleImage: nextCapsule,
    };
  }

  /**
   * Resolves the authoritative Steam App ID for a game, respecting user overrides,
   * explicit non-Steam flags, and manual null overrides, falling back to instant high-confidence matching.
   */
  getEffectiveSteamAppId(
    game?: EffectiveSteamLookupInput | CanonicalGame | null
  ): number | undefined {
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

export { normalizeTitleKey, stripEditionSuffix, ROMAN_TO_ARABIC, EDITION_TOKENS };
