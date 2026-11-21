import { classifyNetworkError, isWafOrChallengeResponse } from '../../contracts/network';
import {
  EDITION_TOKENS,
  ROMAN_TO_ARABIC,
  alignCompoundWordTokens,
  extractParentheticalReleaseYear,
  isIntermediateNumeralSubtitleMatch,
  isSequelMismatch,
  isYearEditionToken,
  normalizeTitleForStoreSearch,
  normalizeTitleKey,
  sanitizeTitleForSearchQuery,
  stripIntermediateSubtitleNumeral,
  stripPackagingEditionPhrases,
  stripYearEditionPhrases,
} from '../common/titleUtils';
import { onlineLifecycleManager } from '../network/onlineLifecycleManager';
import { Priority, requestScheduler } from '../network/requestScheduler';
import {
  TIER_TTLS,
  evictStagedCache,
  loadStagedCache,
  saveStagedCache,
} from '../storage/stagedCacheService';

export interface WikidataGameLinks {
  qid?: string;
  openCriticId?: number;
  metacriticSlug?: string;
  steamAppId?: number;
  gogSlug?: string;
  label?: string;
  releaseYear?: number;
}

export interface WikidataBatchStoreItem {
  key: string;
  steamAppId?: number | null;
  gogSlug?: string | null;
  title?: string;
}

export interface WikidataResolveForGameParams {
  steamAppId?: number | null;
  gogSlug?: string | null;
  title?: string;
  releaseYear?: number | string | null;
  priority?: number;
}

interface WikidataCacheEntry {
  value: WikidataGameLinks | null;
  expiresAt: number;
  mirroredInStorage: boolean;
}

interface SparqlBindingValue {
  type?: string;
  value?: string;
}

interface SparqlResponseBody {
  results?: {
    bindings?: Array<Record<string, SparqlBindingValue>>;
  };
}

interface WikidataSearchEntityHit {
  id?: string;
  label?: string;
  description?: string;
  match?: {
    type?: string;
    text?: string;
  };
}

interface WikidataSearchResponseBody {
  search?: WikidataSearchEntityHit[];
}

interface WikidataClaimSnak {
  snaktype?: string;
  datavalue?: {
    type?: string;
    value?: unknown;
  };
}

interface WikidataClaimStatement {
  mainsnak?: WikidataClaimSnak;
  rank?: string;
}

interface WikidataEntityRecord {
  id?: string;
  labels?: Record<string, { language?: string; value?: string }>;
  descriptions?: Record<string, { language?: string; value?: string }>;
  claims?: Record<string, WikidataClaimStatement[]>;
}

interface WikidataGetEntitiesResponseBody {
  entities?: Record<string, WikidataEntityRecord>;
}

const STAGED_PREFIX = 'antigravity_staged_wikidata_v1_';
const MAX_IN_MEMORY_ENTRIES = 4096;
const MAX_SPARQL_STEAM_IDS_PER_BATCH = 40;
const MAX_SPARQL_GOG_SLUGS_PER_BATCH = 20; // expands to <= 40 literals (game/<slug> + <slug>)
const POSITIVE_TTL_MS = TIER_TTLS.mature; // 30 days
const NEGATIVE_TTL_MS = TIER_TTLS.negative; // 7 days
const TRANSIENT_FAILURE_WINDOW_MS = 5 * 60 * 1000;
const FETCH_TIMEOUT_MS = 8000;

const VIDEO_GAME_INSTANCE_QIDS = new Set<string>([
  'Q7889', // video game
  'Q4393107', // video game remake
  'Q65963104', // video game remaster
  'Q209163', // expansion pack
  'Q1066707', // downloadable content
  'Q16070115', // video game compilation
  'Q21125433', // browser game
  'Q20650540', // electronic game
]);

const LABEL_STOP_WORDS = new Set<string>([
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
  'video',
  'game',
]);

const REMASTER_OR_EDITION_RE =
  /\b(remastered|remaster|definitive|enhanced|anniversary|complete|goty|director'?s\s+cut|redux|remake)\b/i;

const LEGACY_METACRITIC_PLATFORM_PREFIX_RE =
  /^(?:pc|playstation-\d|ps\d|xbox(?:-[a-z0-9-]+)?|switch|nintendo-[a-z0-9-]+|wii(?:-u)?|3ds|ds|psp|vita|ios|android|stadia|dreamcast|gamecube|mac|linux)\//i;

function isViteBrowserDev(): boolean {
  const metaEnv = (
    import.meta as ImportMeta & { env?: { DEV?: boolean; VITEST?: string | boolean } }
  ).env;
  if (!metaEnv?.DEV) return false;
  if (metaEnv.VITEST) return false;
  if (typeof process !== 'undefined' && Boolean(process.env?.VITEST)) return false;
  if (typeof window === 'undefined' || typeof window.location === 'undefined') return false;
  if (window.electronAPI) return false;
  const protocol = window.location.protocol || '';
  const port = window.location.port || '';
  if (!protocol.startsWith('http') || (port !== '3000' && port !== '5173')) {
    return false;
  }
  if (
    typeof navigator !== 'undefined' &&
    (navigator.userAgent?.includes('jsdom') || navigator.userAgent?.includes('Node'))
  ) {
    return false;
  }
  return true;
}

function getSparqlBaseUrl(): string {
  return isViteBrowserDev()
    ? '/api/wikidata-sparql/sparql'
    : 'https://query.wikidata.org/sparql';
}

function getActionApiBaseUrl(): string {
  return isViteBrowserDev()
    ? '/api/wikidata-api/w/api.php'
    : 'https://www.wikidata.org/w/api.php';
}

function getStorageSafe(): Storage | null {
  try {
    if (typeof window !== 'undefined' && window.localStorage) {
      return window.localStorage;
    }
    if (typeof localStorage !== 'undefined') {
      return localStorage;
    }
  } catch {
    // Ignore restricted storage environments
  }
  return null;
}

function createTimeoutSignal(ms: number): AbortSignal | undefined {
  if (typeof AbortSignal !== 'undefined' && 'timeout' in AbortSignal) {
    return AbortSignal.timeout(ms);
  }
  return undefined;
}

function parsePositiveInt(raw?: number | string | null): number | undefined {
  if (raw === null || raw === undefined) return undefined;
  if (typeof raw === 'number') {
    return Number.isSafeInteger(raw) && raw > 0 ? raw : undefined;
  }
  const trimmed = String(raw).trim();
  if (!trimmed) return undefined;
  const direct = trimmed.match(/^\d+$/);
  const digits = direct ? trimmed : trimmed.match(/opencritic\.com\/game\/(\d+)/i)?.[1];
  if (!digits) return undefined;
  const parsed = Number.parseInt(digits, 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function parseValidYear(raw?: number | string | null): number | null {
  if (raw === null || raw === undefined) return null;
  const maxYear = new Date().getFullYear() + 2;
  if (typeof raw === 'number') {
    return Number.isInteger(raw) && raw >= 1975 && raw <= maxYear ? raw : null;
  }
  const str = String(raw).trim();
  if (!str) return null;
  const isoMatch = str.match(/^[+-]?((?:19|20)\d{2})(?:[-T/]|$)/);
  if (isoMatch) {
    const yr = Number.parseInt(isoMatch[1], 10);
    return yr >= 1975 && yr <= maxYear ? yr : null;
  }
  const anyMatch = str.match(/\b((?:19|20)\d{2})\b/);
  if (anyMatch) {
    const yr = Number.parseInt(anyMatch[1], 10);
    return yr >= 1975 && yr <= maxYear ? yr : null;
  }
  return null;
}

function extractQid(raw?: string | null): string | undefined {
  if (!raw || typeof raw !== 'string') return undefined;
  const match = raw.trim().match(/(Q\d+)$/i);
  return match ? match[1].toUpperCase() : undefined;
}

export function normalizeWikidataGogSlug(raw?: string | null): string | undefined {
  if (!raw || typeof raw !== 'string') return undefined;
  let cleaned = raw.trim().toLowerCase();
  if (!cleaned) return undefined;
  cleaned = cleaned
    .replace(/^https?:\/\/(?:www\.)?gog\.com\/(?:[a-z]{2}(?:-[a-z]{2})?\/)?/i, '')
    .replace(/[?#].*$/, '')
    .replace(/^\/+/, '')
    .replace(/^game\//i, '')
    .replace(/\/+$/, '');
  if (!cleaned) return undefined;
  // Numeric GOG product IDs (e.g. 1458058109) are not P2725 URL slugs
  if (/^\d{7,}$/.test(cleaned)) return undefined;
  if (!/^[a-z0-9][a-z0-9_-]*$/.test(cleaned)) return undefined;
  return cleaned.replace(/-/g, '_');
}

export function sanitizeWikidataMetacriticSlug(
  raw?: string | null,
  isLegacyP1712: boolean = false
): string | undefined {
  if (!raw || typeof raw !== 'string') return undefined;
  let cleaned = raw.trim().toLowerCase();
  if (!cleaned) return undefined;
  cleaned = cleaned
    .replace(/^https?:\/\/(?:www\.)?metacritic\.com\//i, '')
    .replace(/[?#].*$/, '')
    .replace(/^\/+/, '')
    .replace(/\/+$/, '');
  if (!cleaned) return undefined;

  if (isLegacyP1712) {
    // Legacy P1712 spans movies, TV, music, and people; accept strictly game/* slugs.
    if (!cleaned.startsWith('game/')) {
      return undefined;
    }
  }

  cleaned = cleaned
    .replace(/^game\//i, '')
    .replace(LEGACY_METACRITIC_PLATFORM_PREFIX_RE, '')
    .replace(/\/(?:critic-reviews|user-reviews|details|trailers)\/?$/i, '')
    .replace(/^\/+|\/+$/g, '');

  if (!cleaned || cleaned.includes('/')) return undefined;
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(cleaned)) return undefined;
  return cleaned;
}

function escapeSparqlLiteral(val: string): string {
  return val.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/[\r\n]/g, ' ');
}

function tokenizeForLabelMatch(raw: string): string[] {
  const parenYr = extractParentheticalReleaseYear(raw);
  const parenYrStr = parenYr !== null ? String(parenYr) : null;
  let cleaned = stripPackagingEditionPhrases(stripYearEditionPhrases(raw));
  cleaned = cleaned.replace(/[\(\[]\s*(?:[^)\]]*?[,\s-])?(?:19|20)\d{2}\s*[\)\]]/g, ' ');
  cleaned = cleaned.replace(/[\(\[]\s*(?:video\s+game|pc|windows|mac|linux)\s*[\)\]]/gi, ' ');
  const normalized = normalizeTitleKey(cleaned);
  if (!normalized) return [];
  const rawTokens = normalized.split(' ').filter(Boolean);
  const filtered = rawTokens
    .map((t) => ROMAN_TO_ARABIC[t] || t)
    .filter(
      (t) =>
        !LABEL_STOP_WORDS.has(t) &&
        !EDITION_TOKENS.has(t) &&
        t !== parenYrStr &&
        !isYearEditionToken(raw, t)
    );
  return filtered.length > 0 ? filtered : rawTokens.map((t) => ROMAN_TO_ARABIC[t] || t);
}

function isWikidataLabelCompatible(queryTitle: string, candidateLabel: string): boolean {
  if (!queryTitle || !candidateLabel) return false;
  if (isSequelMismatch(queryTitle, candidateLabel)) {
    const asciiProjected = queryTitle.replace(/[^\x00-\x7f]+/g, ' ').replace(/\s+/g, ' ').trim();
    if (!asciiProjected || asciiProjected === queryTitle || isSequelMismatch(asciiProjected, candidateLabel)) {
      return false;
    }
  }
  if (isIntermediateNumeralSubtitleMatch(queryTitle, candidateLabel)) {
    return true;
  }

  const checkPair = (a: string, b: string): boolean => {
    const rawQ = tokenizeForLabelMatch(a);
    const rawC = tokenizeForLabelMatch(b);
    if (rawQ.length === 0 || rawC.length === 0) return false;

    const [qTokens, cTokens] = alignCompoundWordTokens(rawQ, rawC);
    const qSet = new Set(qTokens);
    const cSet = new Set(cTokens);
    let shared = 0;
    for (const token of qSet) {
      if (cSet.has(token)) shared += 1;
    }
    if (shared === 0) return false;
    const qCoverage = shared / qSet.size;
    const cCoverage = shared / cSet.size;
    return qCoverage >= 0.8 && cCoverage >= 0.8;
  };

  if (checkPair(queryTitle, candidateLabel)) {
    return true;
  }

  const asciiProjected = queryTitle.replace(/[^\x00-\x7f]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (asciiProjected && asciiProjected !== queryTitle && checkPair(asciiProjected, candidateLabel)) {
    return true;
  }

  return false;
}

function isCandidateYearCompatible(
  queryTitle: string,
  paramYear: number | null,
  candidateYear: number | null,
  candidateLabel: string
): boolean {
  const titleYear = extractParentheticalReleaseYear(queryTitle);
  if (titleYear !== null && candidateYear !== null) {
    if (Math.abs(titleYear - candidateYear) > 2) {
      return false;
    }
  }

  const hasRemasterTag = REMASTER_OR_EDITION_RE.test(queryTitle);
  if (
    titleYear === null &&
    paramYear !== null &&
    paramYear <= 2020 &&
    candidateYear !== null &&
    candidateYear > paramYear + 3 &&
    !hasRemasterTag
  ) {
    return false;
  }

  const titleNoParenYear = queryTitle.replace(/\s*[\(\[]\s*(?:19|20)\d{2}\s*[\)\]]/g, '').trim();
  if (
    /\b(?:1|i)\b/i.test(titleNoParenYear) &&
    candidateLabel &&
    !/\b(?:1|i)\b/i.test(candidateLabel) &&
    candidateYear !== null &&
    candidateYear >= 2015
  ) {
    return false;
  }

  return true;
}

function extractStringClaims(entity: WikidataEntityRecord, property: string): string[] {
  const statements = entity.claims?.[property];
  if (!Array.isArray(statements) || statements.length === 0) return [];
  const preferred: string[] = [];
  const normal: string[] = [];
  for (const stmt of statements) {
    if (!stmt || stmt.rank === 'deprecated') continue;
    const val = stmt.mainsnak?.datavalue?.value;
    if (typeof val === 'string' && val.trim()) {
      if (stmt.rank === 'preferred') {
        preferred.push(val.trim());
      } else {
        normal.push(val.trim());
      }
    }
  }
  return [...preferred, ...normal];
}

function extractEntityIdClaims(entity: WikidataEntityRecord, property: string): string[] {
  const statements = entity.claims?.[property];
  if (!Array.isArray(statements) || statements.length === 0) return [];
  const ids: string[] = [];
  for (const stmt of statements) {
    if (!stmt || stmt.rank === 'deprecated') continue;
    const val = stmt.mainsnak?.datavalue?.value;
    if (val && typeof val === 'object' && 'id' in val) {
      const idVal = (val as { id?: unknown }).id;
      if (typeof idVal === 'string' && /^Q\d+$/i.test(idVal)) {
        ids.push(idVal.toUpperCase());
      }
    }
  }
  return ids;
}

function extractEarliestPublicationYearFromClaims(entity: WikidataEntityRecord): number | null {
  const statements = entity.claims?.P577;
  if (!Array.isArray(statements) || statements.length === 0) return null;
  let earliest: number | null = null;
  for (const stmt of statements) {
    if (!stmt || stmt.rank === 'deprecated') continue;
    const val = stmt.mainsnak?.datavalue?.value;
    if (val && typeof val === 'object' && 'time' in val) {
      const timeVal = (val as { time?: unknown }).time;
      if (typeof timeVal === 'string') {
        const yr = parseValidYear(timeVal);
        if (yr !== null && (earliest === null || yr < earliest)) {
          earliest = yr;
        }
      }
    }
  }
  return earliest;
}

function mergeGameLinks(
  existing: WikidataGameLinks | undefined,
  incoming: WikidataGameLinks
): WikidataGameLinks {
  if (!existing) return { ...incoming };
  let releaseYear = existing.releaseYear;
  if (
    incoming.releaseYear !== undefined &&
    (releaseYear === undefined || incoming.releaseYear < releaseYear)
  ) {
    releaseYear = incoming.releaseYear;
  }
  return {
    qid: existing.qid || incoming.qid,
    openCriticId: existing.openCriticId ?? incoming.openCriticId,
    metacriticSlug: existing.metacriticSlug || incoming.metacriticSlug,
    steamAppId: existing.steamAppId ?? incoming.steamAppId,
    gogSlug: existing.gogSlug || incoming.gogSlug,
    label: existing.label || incoming.label,
    releaseYear,
  };
}

function hasAnyUsefulLink(links: WikidataGameLinks | null | undefined): boolean {
  if (!links) return false;
  return Boolean(
    links.openCriticId || links.metacriticSlug || links.steamAppId || links.gogSlug
  );
}

export class WikidataBridge {
  private readonly inMemoryCache = new Map<string, WikidataCacheEntry>();
  private readonly trackedStagedKeys = new Set<string>();
  private readonly inFlightLookups = new Map<string, Promise<WikidataGameLinks | null>>();
  private readonly transientFailures = new Map<string, number>();
  private lastGlobalTransientFailureAt = 0;

  private makeStagedKey(cacheKey: string): string {
    return `${STAGED_PREFIX}${cacheKey}`;
  }

  private setMemoryEntry(
    cacheKey: string,
    value: WikidataGameLinks | null,
    ttlMs: number,
    mirroredInStorage: boolean
  ): void {
    if (this.inMemoryCache.has(cacheKey)) {
      this.inMemoryCache.delete(cacheKey);
    }
    this.inMemoryCache.set(cacheKey, {
      value,
      expiresAt: Date.now() + ttlMs,
      mirroredInStorage,
    });
    while (this.inMemoryCache.size > MAX_IN_MEMORY_ENTRIES) {
      const oldest = this.inMemoryCache.keys().next().value;
      if (oldest === undefined) break;
      this.inMemoryCache.delete(oldest);
    }
  }

  private readCacheEntry(cacheKey: string): { hit: boolean; value: WikidataGameLinks | null } {
    const stagedKey = this.makeStagedKey(cacheKey);
    const mem = this.inMemoryCache.get(cacheKey);
    if (mem) {
      if (mem.mirroredInStorage) {
        const storage = getStorageSafe();
        if (storage && storage.getItem(stagedKey) === null) {
          this.inMemoryCache.delete(cacheKey);
        } else if (Date.now() < mem.expiresAt) {
          return { hit: true, value: mem.value };
        } else {
          this.inMemoryCache.delete(cacheKey);
        }
      } else if (Date.now() < mem.expiresAt) {
        return { hit: true, value: mem.value };
      } else {
        this.inMemoryCache.delete(cacheKey);
      }
    }

    const staged = loadStagedCache<WikidataGameLinks>(stagedKey, false);
    if (staged.valid) {
      const remainingMs =
        staged.entry && typeof staged.entry.cachedAt === 'number' && typeof staged.entry.ttlMs === 'number'
          ? Math.max(1000, staged.entry.cachedAt + staged.entry.ttlMs - Date.now())
          : staged.data
          ? POSITIVE_TTL_MS
          : NEGATIVE_TTL_MS;
      const storage = getStorageSafe();
      const mirrored = Boolean(storage && storage.getItem(stagedKey) !== null);
      this.setMemoryEntry(cacheKey, staged.data, remainingMs, mirrored);
      this.trackedStagedKeys.add(stagedKey);
      return { hit: true, value: staged.data };
    }

    return { hit: false, value: null };
  }

  private writePositiveCache(cacheKey: string, links: WikidataGameLinks): void {
    const stagedKey = this.makeStagedKey(cacheKey);
    this.trackedStagedKeys.add(stagedKey);
    saveStagedCache<WikidataGameLinks>(stagedKey, links, 'mature', {
      source: 'wikidata',
      customTtlMs: POSITIVE_TTL_MS,
      dynamicResolved: true,
    });
    const storage = getStorageSafe();
    const mirrored = Boolean(storage && storage.getItem(stagedKey) !== null);
    this.setMemoryEntry(cacheKey, links, POSITIVE_TTL_MS, mirrored);
    this.transientFailures.delete(cacheKey);
  }

  private writeNegativeCache(cacheKey: string): void {
    const stagedKey = this.makeStagedKey(cacheKey);
    this.trackedStagedKeys.add(stagedKey);
    saveStagedCache<WikidataGameLinks>(stagedKey, null, 'negative', {
      source: 'wikidata',
      failureReason: 'not_found',
      customTtlMs: NEGATIVE_TTL_MS,
      dynamicResolved: true,
    });
    const storage = getStorageSafe();
    const mirrored = Boolean(storage && storage.getItem(stagedKey) !== null);
    this.setMemoryEntry(cacheKey, null, NEGATIVE_TTL_MS, mirrored);
  }

  private markTransientFailure(keys?: string[]): void {
    const now = Date.now();
    this.lastGlobalTransientFailureAt = now;
    if (keys) {
      for (const k of keys) {
        if (k) {
          this.transientFailures.set(k, now);
        }
      }
      while (this.transientFailures.size > MAX_IN_MEMORY_ENTRIES) {
        const oldest = this.transientFailures.keys().next().value;
        if (oldest === undefined) break;
        this.transientFailures.delete(oldest);
      }
    }
  }

  public hadRecentTransientFailure(key?: string): boolean {
    const now = Date.now();
    if (!key) {
      return now - this.lastGlobalTransientFailureAt < TRANSIENT_FAILURE_WINDOW_MS;
    }
    const ts = this.transientFailures.get(key);
    if (ts === undefined) return false;
    if (now - ts >= TRANSIENT_FAILURE_WINDOW_MS) {
      this.transientFailures.delete(key);
      return false;
    }
    return true;
  }

  private buildTitleCacheKey(title: string, targetYear: number | null): string {
    const normTitle = normalizeTitleKey(title);
    if (!normTitle) return '';
    return targetYear !== null ? `title:${normTitle}:y${targetYear}` : `title:${normTitle}`;
  }

  public getCachedLinks(params: {
    steamAppId?: number | null;
    gogSlug?: string | null;
    title?: string;
  }): WikidataGameLinks | null {
    const steamAppId = parsePositiveInt(params.steamAppId);
    if (steamAppId) {
      const hit = this.readCacheEntry(`steam:${steamAppId}`);
      if (hit.hit && hit.value) return hit.value;
    }

    const gogSlug = normalizeWikidataGogSlug(params.gogSlug);
    if (gogSlug) {
      const hit = this.readCacheEntry(`gog:${gogSlug}`);
      if (hit.hit && hit.value) return hit.value;
    }

    if (params.title) {
      const titleYear = extractParentheticalReleaseYear(params.title);
      if (titleYear !== null) {
        const yearKey = this.buildTitleCacheKey(params.title, titleYear);
        if (yearKey) {
          const hit = this.readCacheEntry(yearKey);
          if (hit.hit && hit.value) return hit.value;
        }
      }
      const baseKey = this.buildTitleCacheKey(params.title, null);
      if (baseKey) {
        const hit = this.readCacheEntry(baseKey);
        if (hit.hit && hit.value) return hit.value;
      }
    }

    return null;
  }

  public clearCache(options?: { negativesOnly?: boolean }): void {
    const negativesOnly = Boolean(options?.negativesOnly);
    this.transientFailures.clear();
    this.lastGlobalTransientFailureAt = 0;

    if (negativesOnly) {
      for (const [key, entry] of this.inMemoryCache.entries()) {
        if (entry.value === null) {
          this.inMemoryCache.delete(key);
          const stagedKey = this.makeStagedKey(key);
          evictStagedCache(stagedKey);
          this.trackedStagedKeys.delete(stagedKey);
        }
      }
      return;
    }

    this.inMemoryCache.clear();
    this.inFlightLookups.clear();
    for (const stagedKey of this.trackedStagedKeys) {
      evictStagedCache(stagedKey);
    }
    this.trackedStagedKeys.clear();
  }

  private async executeSparqlQuery(
    sparql: string,
    priority: number,
    failureKeys: string[]
  ): Promise<{ ok: boolean; transientError: boolean; bindings: Array<Record<string, SparqlBindingValue>> }> {
    if (!onlineLifecycleManager.isOnline()) {
      this.markTransientFailure(failureKeys);
      return { ok: false, transientError: true, bindings: [] };
    }

    const url = `${getSparqlBaseUrl()}?format=json&query=${encodeURIComponent(sparql)}`;
    try {
      const response = await requestScheduler.schedule(
        'https://query.wikidata.org/sparql',
        () =>
          fetch(url, {
            signal: createTimeoutSignal(FETCH_TIMEOUT_MS),
          }),
        priority,
        'query.wikidata.org'
      );

      if (!response) {
        this.markTransientFailure(failureKeys);
        return { ok: false, transientError: true, bindings: [] };
      }

      if (!response.ok) {
        const isTransient =
          response.status === 429 ||
          response.status >= 500 ||
          isWafOrChallengeResponse(response.status, '', response.headers, true);
        if (isTransient) {
          this.markTransientFailure(failureKeys);
        }
        return { ok: false, transientError: isTransient, bindings: [] };
      }

      let rawBody: unknown;
      if (typeof response.text === 'function') {
        const text = await response.text();
        if (isWafOrChallengeResponse(response.status, text, response.headers, true)) {
          this.markTransientFailure(failureKeys);
          return { ok: false, transientError: true, bindings: [] };
        }
        try {
          rawBody = JSON.parse(text);
        } catch {
          this.markTransientFailure(failureKeys);
          return { ok: false, transientError: true, bindings: [] };
        }
      } else if (typeof response.json === 'function') {
        rawBody = await response.json();
      } else {
        this.markTransientFailure(failureKeys);
        return { ok: false, transientError: true, bindings: [] };
      }

      const parsed = rawBody as SparqlResponseBody;
      const bindings = Array.isArray(parsed?.results?.bindings) ? parsed.results.bindings : [];
      return { ok: true, transientError: false, bindings };
    } catch (err: unknown) {
      const classified = classifyNetworkError(err);
      const isTransient = classified.status === 'transient_error';
      if (isTransient) {
        this.markTransientFailure(failureKeys);
      }
      return { ok: false, transientError: isTransient, bindings: [] };
    }
  }

  private parseSparqlBinding(binding: Record<string, SparqlBindingValue>): {
    links: WikidataGameLinks;
    matchedSteamId?: number;
    matchedGogSlug?: string;
  } {
    const qid = extractQid(binding.item?.value);
    const matchedSteamId = parsePositiveInt(
      binding.steamId?.value ?? binding.resolvedSteamId?.value
    );
    const matchedGogSlug = normalizeWikidataGogSlug(binding.gogSlug?.value);
    const openCriticId = parsePositiveInt(binding.ocId?.value);
    const metacriticSlug =
      sanitizeWikidataMetacriticSlug(binding.mcSlug?.value, false) ??
      sanitizeWikidataMetacriticSlug(binding.legacyMc?.value, true);
    const label = binding.itemLabel?.value?.trim() || undefined;
    const releaseYear = parseValidYear(binding.pubDate?.value) ?? undefined;

    const links: WikidataGameLinks = {
      ...(qid ? { qid } : {}),
      ...(openCriticId !== undefined ? { openCriticId } : {}),
      ...(metacriticSlug ? { metacriticSlug } : {}),
      ...(matchedSteamId !== undefined ? { steamAppId: matchedSteamId } : {}),
      ...(matchedGogSlug ? { gogSlug: matchedGogSlug } : {}),
      ...(label ? { label } : {}),
      ...(releaseYear !== undefined ? { releaseYear } : {}),
    };

    return { links, matchedSteamId, matchedGogSlug };
  }

  public async batchResolveByStoreIds(
    items: WikidataBatchStoreItem[],
    options?: { priority?: number }
  ): Promise<Map<string, WikidataGameLinks>> {
    const results = new Map<string, WikidataGameLinks>();
    if (!Array.isArray(items) || items.length === 0) {
      return results;
    }

    const priority = options?.priority ?? Priority.P2_BACKGROUND;
    const steamIdToItemKeys = new Map<number, string[]>();
    const gogSlugToItemKeys = new Map<string, string[]>();

    for (const item of items) {
      if (!item?.key) continue;
      const steamId = parsePositiveInt(item.steamAppId);
      const gogSlug = normalizeWikidataGogSlug(item.gogSlug);

      let resolvedFromCache = false;
      if (steamId !== undefined) {
        const cached = this.readCacheEntry(`steam:${steamId}`);
        if (cached.hit) {
          if (cached.value) {
            results.set(item.key, cached.value);
            resolvedFromCache = true;
          }
        } else {
          const list = steamIdToItemKeys.get(steamId) ?? [];
          list.push(item.key);
          steamIdToItemKeys.set(steamId, list);
        }
      }

      if (!resolvedFromCache && gogSlug !== undefined) {
        const cached = this.readCacheEntry(`gog:${gogSlug}`);
        if (cached.hit) {
          if (cached.value) {
            results.set(item.key, cached.value);
          }
        } else {
          const list = gogSlugToItemKeys.get(gogSlug) ?? [];
          list.push(item.key);
          gogSlugToItemKeys.set(gogSlug, list);
        }
      }
    }

    // 1. Batch resolve Steam AppIDs (wdt:P1733), chunked at max 40 IDs per GET request
    const steamIds = Array.from(steamIdToItemKeys.keys());
    for (let offset = 0; offset < steamIds.length; offset += MAX_SPARQL_STEAM_IDS_PER_BATCH) {
      const chunk = steamIds.slice(offset, offset + MAX_SPARQL_STEAM_IDS_PER_BATCH);
      const valuesLiteral = chunk.map((id) => `"${id}"`).join(' ');
      const sparql =
        `SELECT ?item ?steamId ?gogSlug ?ocId ?mcSlug ?legacyMc ?pubDate ?itemLabel WHERE { ` +
        `VALUES ?steamId { ${valuesLiteral} } ` +
        `?item wdt:P1733 ?steamId . ` +
        `OPTIONAL { ?item wdt:P2725 ?gogSlug . } ` +
        `OPTIONAL { ?item wdt:P2864 ?ocId . } ` +
        `OPTIONAL { ?item wdt:P12054 ?mcSlug . } ` +
        `OPTIONAL { ?item wdt:P1712 ?legacyMc . } ` +
        `OPTIONAL { ?item wdt:P577 ?pubDate . } ` +
        `OPTIONAL { ?item rdfs:label ?itemLabel . FILTER(LANG(?itemLabel) = "en") } ` +
        `}`;

      const failureKeys = chunk.map((id) => `steam:${id}`);
      const queryRes = await this.executeSparqlQuery(sparql, priority, failureKeys);
      if (!queryRes.ok) {
        continue;
      }

      const bySteamId = new Map<number, WikidataGameLinks>();
      for (const binding of queryRes.bindings) {
        const { links, matchedSteamId } = this.parseSparqlBinding(binding);
        if (matchedSteamId !== undefined) {
          bySteamId.set(matchedSteamId, mergeGameLinks(bySteamId.get(matchedSteamId), links));
        }
      }

      for (const steamId of chunk) {
        const links = bySteamId.get(steamId);
        if (links && hasAnyUsefulLink(links)) {
          this.writePositiveCache(`steam:${steamId}`, links);
          if (links.gogSlug) {
            this.writePositiveCache(`gog:${links.gogSlug}`, links);
          }
          const itemKeys = steamIdToItemKeys.get(steamId) ?? [];
          for (const itemKey of itemKeys) {
            results.set(itemKey, links);
          }
        } else {
          this.writeNegativeCache(`steam:${steamId}`);
        }
      }
    }

    // 2. Batch resolve unresolved GOG slugs (wdt:P2725), querying both game/<slug> and bare <slug>
    const unresolvedGogSlugs: string[] = [];
    for (const [slug, itemKeys] of gogSlugToItemKeys.entries()) {
      if (itemKeys.some((k) => !results.has(k))) {
        unresolvedGogSlugs.push(slug);
      }
    }

    for (let offset = 0; offset < unresolvedGogSlugs.length; offset += MAX_SPARQL_GOG_SLUGS_PER_BATCH) {
      const chunk = unresolvedGogSlugs.slice(offset, offset + MAX_SPARQL_GOG_SLUGS_PER_BATCH);
      const literals: string[] = [];
      for (const slug of chunk) {
        const escaped = escapeSparqlLiteral(slug);
        literals.push(`"game/${escaped}"`, `"${escaped}"`);
      }
      const sparql =
        `SELECT ?item ?gogSlug ?resolvedSteamId ?ocId ?mcSlug ?legacyMc ?pubDate ?itemLabel WHERE { ` +
        `VALUES ?gogSlug { ${literals.join(' ')} } ` +
        `?item wdt:P2725 ?gogSlug . ` +
        `OPTIONAL { ?item wdt:P1733 ?resolvedSteamId . } ` +
        `OPTIONAL { ?item wdt:P2864 ?ocId . } ` +
        `OPTIONAL { ?item wdt:P12054 ?mcSlug . } ` +
        `OPTIONAL { ?item wdt:P1712 ?legacyMc . } ` +
        `OPTIONAL { ?item wdt:P577 ?pubDate . } ` +
        `OPTIONAL { ?item rdfs:label ?itemLabel . FILTER(LANG(?itemLabel) = "en") } ` +
        `}`;

      const failureKeys = chunk.map((slug) => `gog:${slug}`);
      const queryRes = await this.executeSparqlQuery(sparql, priority, failureKeys);
      if (!queryRes.ok) {
        continue;
      }

      const byGogSlug = new Map<string, WikidataGameLinks>();
      for (const binding of queryRes.bindings) {
        const { links, matchedGogSlug } = this.parseSparqlBinding(binding);
        if (matchedGogSlug) {
          byGogSlug.set(matchedGogSlug, mergeGameLinks(byGogSlug.get(matchedGogSlug), links));
        }
      }

      for (const slug of chunk) {
        const links = byGogSlug.get(slug);
        if (links && hasAnyUsefulLink(links)) {
          this.writePositiveCache(`gog:${slug}`, links);
          if (links.steamAppId !== undefined) {
            this.writePositiveCache(`steam:${links.steamAppId}`, links);
          }
          const itemKeys = gogSlugToItemKeys.get(slug) ?? [];
          for (const itemKey of itemKeys) {
            if (!results.has(itemKey)) {
              results.set(itemKey, links);
            }
          }
        } else {
          this.writeNegativeCache(`gog:${slug}`);
        }
      }
    }

    return results;
  }

  private async fetchActionApiJson<T>(
    params: Record<string, string>,
    priority: number,
    failureKeys: string[]
  ): Promise<{ ok: boolean; transientError: boolean; data: T | null }> {
    if (!onlineLifecycleManager.isOnline()) {
      this.markTransientFailure(failureKeys);
      return { ok: false, transientError: true, data: null };
    }

    const search = new URLSearchParams({
      ...params,
      format: 'json',
      origin: '*',
    });
    const url = `${getActionApiBaseUrl()}?${search.toString()}`;

    try {
      const response = await requestScheduler.schedule(
        'https://www.wikidata.org/w/api.php',
        () =>
          fetch(url, {
            signal: createTimeoutSignal(FETCH_TIMEOUT_MS),
          }),
        priority,
        'www.wikidata.org'
      );

      if (!response) {
        this.markTransientFailure(failureKeys);
        return { ok: false, transientError: true, data: null };
      }

      if (!response.ok) {
        const isTransient =
          response.status === 429 ||
          response.status >= 500 ||
          isWafOrChallengeResponse(response.status, '', response.headers, true);
        if (isTransient) {
          this.markTransientFailure(failureKeys);
        }
        return { ok: false, transientError: isTransient, data: null };
      }

      if (typeof response.text === 'function') {
        const text = await response.text();
        if (isWafOrChallengeResponse(response.status, text, response.headers, true)) {
          this.markTransientFailure(failureKeys);
          return { ok: false, transientError: true, data: null };
        }
        try {
          return { ok: true, transientError: false, data: JSON.parse(text) as T };
        } catch {
          this.markTransientFailure(failureKeys);
          return { ok: false, transientError: true, data: null };
        }
      }

      if (typeof response.json === 'function') {
        const parsed = (await response.json()) as T;
        return { ok: true, transientError: false, data: parsed };
      }

      this.markTransientFailure(failureKeys);
      return { ok: false, transientError: true, data: null };
    } catch (err: unknown) {
      const classified = classifyNetworkError(err);
      const isTransient = classified.status === 'transient_error';
      if (isTransient) {
        this.markTransientFailure(failureKeys);
      }
      return { ok: false, transientError: isTransient, data: null };
    }
  }

  private async resolveByTitleSearch(
    title: string,
    options: {
      steamAppId?: number;
      gogSlug?: string;
      releaseYear?: number | string | null;
      priority: number;
    }
  ): Promise<WikidataGameLinks | null> {
    const cleanTitle = title.trim();
    if (!cleanTitle) return null;

    const titleYear = extractParentheticalReleaseYear(cleanTitle);
    const paramYear = parseValidYear(options.releaseYear);
    const targetYear = titleYear ?? paramYear;
    const cacheKey = this.buildTitleCacheKey(cleanTitle, targetYear);
    const baseCacheKey = this.buildTitleCacheKey(cleanTitle, null);

    if (cacheKey) {
      const cached = this.readCacheEntry(cacheKey);
      if (cached.hit) {
        return cached.value;
      }
    }
    if (baseCacheKey && baseCacheKey !== cacheKey) {
      const baseCached = this.readCacheEntry(baseCacheKey);
      if (
        baseCached.hit &&
        baseCached.value &&
        isCandidateYearCompatible(
          cleanTitle,
          paramYear,
          baseCached.value.releaseYear ?? null,
          baseCached.value.label || ''
        )
      ) {
        return baseCached.value;
      }
    }

    const inFlightKey = cacheKey || `raw:${cleanTitle.toLowerCase()}`;
    const existingInFlight = this.inFlightLookups.get(inFlightKey);
    if (existingInFlight) {
      return existingInFlight;
    }

    const run = (async (): Promise<WikidataGameLinks | null> => {
      const failureKeys = [cacheKey, baseCacheKey].filter(Boolean);
      const primaryQuery = sanitizeTitleForSearchQuery(cleanTitle) || cleanTitle;

      const searchRes = await this.fetchActionApiJson<WikidataSearchResponseBody>(
        {
          action: 'wbsearchentities',
          language: 'en',
          type: 'item',
          limit: '5',
          search: primaryQuery,
        },
        options.priority,
        failureKeys
      );

      if (!searchRes.ok) {
        return null;
      }

      let hits = Array.isArray(searchRes.data?.search) ? searchRes.data.search : [];

      if (hits.length === 0) {
        const altQueryCandidate =
          stripIntermediateSubtitleNumeral(cleanTitle) ||
          normalizeTitleForStoreSearch(stripPackagingEditionPhrases(cleanTitle), {
            stripEditions: true,
          });
        const altQuery = altQueryCandidate ? sanitizeTitleForSearchQuery(altQueryCandidate) : '';
        if (
          altQuery &&
          altQuery.length >= 2 &&
          altQuery.toLowerCase() !== primaryQuery.toLowerCase()
        ) {
          const fallbackRes = await this.fetchActionApiJson<WikidataSearchResponseBody>(
            {
              action: 'wbsearchentities',
              language: 'en',
              type: 'item',
              limit: '5',
              search: altQuery,
            },
            options.priority,
            failureKeys
          );
          if (!fallbackRes.ok) {
            return null;
          }
          hits = Array.isArray(fallbackRes.data?.search) ? fallbackRes.data.search : [];
        }
      }

      const candidateQids: string[] = [];
      const searchMetaByQid = new Map<string, WikidataSearchEntityHit>();
      for (const hit of hits) {
        const qid = extractQid(hit?.id);
        if (qid && !searchMetaByQid.has(qid)) {
          candidateQids.push(qid);
          searchMetaByQid.set(qid, hit);
        }
        if (candidateQids.length >= 5) break;
      }

      if (candidateQids.length === 0) {
        if (cacheKey) this.writeNegativeCache(cacheKey);
        return null;
      }

      const entitiesRes = await this.fetchActionApiJson<WikidataGetEntitiesResponseBody>(
        {
          action: 'wbgetentities',
          props: 'claims|labels',
          ids: candidateQids.join('|'),
        },
        options.priority,
        failureKeys
      );

      if (!entitiesRes.ok || !entitiesRes.data?.entities) {
        return null;
      }

      let bestCandidate: { links: WikidataGameLinks; rank: number } | null = null;
      const normQuery = normalizeTitleKey(cleanTitle);

      for (const qid of candidateQids) {
        const entity = entitiesRes.data.entities[qid];
        if (!entity) continue;

        const searchMeta = searchMetaByQid.get(qid);
        const label =
          entity.labels?.en?.value?.trim() || searchMeta?.label?.trim() || '';
        const description =
          entity.descriptions?.en?.value?.trim() || searchMeta?.description?.trim() || '';

        const ocValues = extractStringClaims(entity, 'P2864');
        const mcValues = extractStringClaims(entity, 'P12054');
        const legacyMcValues = extractStringClaims(entity, 'P1712');
        const steamValues = extractStringClaims(entity, 'P1733');
        const gogValues = extractStringClaims(entity, 'P2725');
        const instanceOfQids = extractEntityIdClaims(entity, 'P31');

        const openCriticId = ocValues.map((v) => parsePositiveInt(v)).find((v) => v !== undefined);
        const metacriticSlug =
          mcValues.map((v) => sanitizeWikidataMetacriticSlug(v, false)).find((v) => v !== undefined) ??
          legacyMcValues.map((v) => sanitizeWikidataMetacriticSlug(v, true)).find((v) => v !== undefined);
        const steamAppIds = steamValues
          .map((v) => parsePositiveInt(v))
          .filter((v): v is number => v !== undefined);
        const gogSlugs = gogValues
          .map((v) => normalizeWikidataGogSlug(v))
          .filter((v): v is string => v !== undefined);

        const isVideoGameInstance = instanceOfQids.some((id) => VIDEO_GAME_INSTANCE_QIDS.has(id));
        const hasGamingProperty =
          openCriticId !== undefined ||
          metacriticSlug !== undefined ||
          steamAppIds.length > 0 ||
          gogSlugs.length > 0 ||
          isVideoGameInstance;

        if (!hasGamingProperty) {
          continue;
        }

        if (!label || !isWikidataLabelCompatible(cleanTitle, label)) {
          continue;
        }

        const claimYear = extractEarliestPublicationYearFromClaims(entity);
        const descYear = /\b(?:video\s*game|game|remake|remaster|rpg|shooter|platformer|roguelike|survival|strategy|action|adventure)\b/i.test(
          description
        )
          ? parseValidYear(description)
          : null;
        const candidateYear = claimYear ?? descYear;

        if (!isCandidateYearCompatible(cleanTitle, paramYear, candidateYear, label)) {
          continue;
        }

        const matchedSteamAppId =
          options.steamAppId !== undefined && steamAppIds.includes(options.steamAppId)
            ? options.steamAppId
            : steamAppIds[0];
        const matchedGogSlug =
          options.gogSlug !== undefined && gogSlugs.includes(options.gogSlug)
            ? options.gogSlug
            : gogSlugs[0];

        let rank = 0;
        if (options.steamAppId !== undefined && steamAppIds.includes(options.steamAppId)) {
          rank += 1000;
        }
        if (options.gogSlug !== undefined && gogSlugs.includes(options.gogSlug)) {
          rank += 900;
        }
        if (targetYear !== null && candidateYear !== null) {
          const diff = Math.abs(targetYear - candidateYear);
          if (diff <= 2) {
            rank += 500 - diff * 25;
          } else if (candidateYear < targetYear - 3) {
            rank += 50;
          } else {
            rank -= 200;
          }
        }
        if (openCriticId !== undefined) rank += 120;
        if (metacriticSlug) rank += 100;
        if (matchedSteamAppId !== undefined) rank += 40;
        if (matchedGogSlug) rank += 40;
        if (normalizeTitleKey(label) === normQuery) rank += 30;
        if (isVideoGameInstance) rank += 15;

        const links: WikidataGameLinks = {
          qid,
          ...(openCriticId !== undefined ? { openCriticId } : {}),
          ...(metacriticSlug ? { metacriticSlug } : {}),
          ...(matchedSteamAppId !== undefined ? { steamAppId: matchedSteamAppId } : {}),
          ...(matchedGogSlug ? { gogSlug: matchedGogSlug } : {}),
          ...(label ? { label } : {}),
          ...(candidateYear !== null ? { releaseYear: candidateYear } : {}),
        };

        if (!bestCandidate || rank > bestCandidate.rank) {
          bestCandidate = { links, rank };
        }
      }

      if (bestCandidate) {
        if (cacheKey) {
          this.writePositiveCache(cacheKey, bestCandidate.links);
        }
        if (baseCacheKey && baseCacheKey !== cacheKey && targetYear === null) {
          this.writePositiveCache(baseCacheKey, bestCandidate.links);
        }
        if (
          options.steamAppId !== undefined &&
          bestCandidate.links.steamAppId === options.steamAppId
        ) {
          this.writePositiveCache(`steam:${options.steamAppId}`, bestCandidate.links);
        }
        if (options.gogSlug !== undefined && bestCandidate.links.gogSlug === options.gogSlug) {
          this.writePositiveCache(`gog:${options.gogSlug}`, bestCandidate.links);
        }
        return bestCandidate.links;
      }

      if (cacheKey) {
        this.writeNegativeCache(cacheKey);
      }
      return null;
    })();

    this.inFlightLookups.set(inFlightKey, run);
    try {
      return await run;
    } finally {
      this.inFlightLookups.delete(inFlightKey);
    }
  }

  public async resolveForGame(
    params: WikidataResolveForGameParams
  ): Promise<WikidataGameLinks | null> {
    const priority = params.priority ?? Priority.P1_VIEWPORT;
    const steamAppId = parsePositiveInt(params.steamAppId);
    const gogSlug = normalizeWikidataGogSlug(params.gogSlug);

    // 1. Check store-ID cache hits first
    if (steamAppId !== undefined) {
      const cached = this.readCacheEntry(`steam:${steamAppId}`);
      if (cached.hit && cached.value && hasAnyUsefulLink(cached.value)) {
        return cached.value;
      }
    }
    if (gogSlug !== undefined) {
      const cached = this.readCacheEntry(`gog:${gogSlug}`);
      if (cached.hit && cached.value && hasAnyUsefulLink(cached.value)) {
        return cached.value;
      }
    }

    // 2. Query SPARQL by Steam AppID / GOG slug when available
    if (steamAppId !== undefined || gogSlug !== undefined) {
      const batchMap = await this.batchResolveByStoreIds(
        [
          {
            key: 'single',
            steamAppId,
            gogSlug,
            title: params.title,
          },
        ],
        { priority }
      );
      const fromStoreId = batchMap.get('single');
      if (fromStoreId && hasAnyUsefulLink(fromStoreId)) {
        return fromStoreId;
      }
    }

    // 3. Title search fallback when store IDs are absent or yielded no links
    if (params.title && params.title.trim()) {
      return this.resolveByTitleSearch(params.title, {
        steamAppId,
        gogSlug,
        releaseYear: params.releaseYear,
        priority,
      });
    }

    return null;
  }
}

export const wikidataBridge = new WikidataBridge();
