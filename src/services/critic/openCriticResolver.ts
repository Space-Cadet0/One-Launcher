import type { CriticScoreData, StorefrontReviewAnchor } from '../../contracts/critic';
import { classifyNetworkError, isWafOrChallengeResponse } from '../../contracts/network';
import {
  EDITION_TOKENS,
  ROMAN_TO_ARABIC,
  alignCompoundWordTokens,
  decodeTitleHtmlEntities,
  extractParentheticalReleaseYear,
  foldLatinLigaturesAndDiacritics,
  isIntermediateNumeralSubtitleMatch,
  isSequelMismatch,
  isYearEditionToken,
  normalizeTitleKey,
  stripPackagingEditionPhrases,
  stripTrademarkSymbols,
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
import { calculateTier } from './criticUtils';
import { wikidataBridge } from './wikidataBridge';

export interface OpenCriticResolveByIdOptions {
  expectedTitle?: string;
  releaseYear?: number | string | null;
  priority?: number;
  isVerifiedAnchor?: boolean;
  anchorScore?: number;
  anchorStorefront?: string;
  anchorUrl?: string;
  bypassCache?: boolean;
}

export interface OpenCriticResolveForGameParams {
  title: string;
  steamAppId?: number | null;
  gogSlug?: string | null;
  releaseYear?: number | string | null;
  openCriticId?: number | null;
  storefrontAnchor?: StorefrontReviewAnchor | null;
  priority?: number;
  bypassCache?: boolean;
}

export interface ParsedOpenCriticRecord {
  id: number;
  name: string;
  topCriticScore: number;
  percentRecommended?: number;
  numReviews?: number;
  firstReleaseDate?: string;
  releaseYear?: number;
  url?: string;
  summary?: string;
}

interface OpenCriticCacheEntry {
  value: ParsedOpenCriticRecord | null;
  expiresAt: number;
  mirroredInStorage: boolean;
}

const STAGED_PREFIX = 'antigravity_staged_opencritic_v1_';
const MAX_IN_MEMORY_ENTRIES = 4096;
const POSITIVE_MATURE_TTL_MS = TIER_TTLS.mature; // 30 days
const POSITIVE_FRESH_TTL_MS = TIER_TTLS.fresh; // 48 hours
const NEGATIVE_TTL_MS = TIER_TTLS.negative; // 7 days
const TRANSIENT_FAILURE_WINDOW_MS = 5 * 60 * 1000;
const FETCH_TIMEOUT_MS = 8000;

const TITLE_STOP_WORDS = new Set<string>([
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
  'game',
]);

const REMASTER_OR_EDITION_RE =
  /\b(remastered|remaster|definitive|enhanced|anniversary|complete|goty|director'?s\s+cut|redux|remake)\b/i;

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

function getOpenCriticWebBaseUrl(): string {
  return isViteBrowserDev() ? '/api/opencritic-web' : 'https://opencritic.com';
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

function buildOpenCriticSlug(name: string): string {
  if (!name) return 'game';
  const slug = foldLatinLigaturesAndDiacritics(
    stripTrademarkSymbols(decodeTitleHtmlEntities(name))
  )
    .toLowerCase()
    .replace(/['’‘ʼ`´"“”]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || 'game';
}

function normalizeOpenCriticUrl(
  rawUrl: string | undefined,
  openCriticId: number,
  name: string
): string {
  if (rawUrl && typeof rawUrl === 'string') {
    const trimmed = rawUrl.trim();
    if (/^https?:\/\/(?:www\.)?opencritic\.com\/game\/\d+/i.test(trimmed)) {
      return trimmed.replace(/^http:\/\//i, 'https://');
    }
    if (/^\/game\/\d+/i.test(trimmed)) {
      return `https://opencritic.com${trimmed}`;
    }
  }
  return `https://opencritic.com/game/${openCriticId}/${buildOpenCriticSlug(name)}`;
}

/**
 * Decodes Angular SSR TransferState entity encoding without double-unescaping.
 * `&a;` MUST be decoded last so literal `&a;q;` becomes `&q;` instead of `"`.
 */
export function decodeAngularTransferState(encoded: string): string {
  if (!encoded) return '';
  return encoded
    .replace(/&q;/g, '"')
    .replace(/&s;/g, "'")
    .replace(/&l;/g, '<')
    .replace(/&g;/g, '>')
    .replace(/&a;/g, '&');
}

function decodeHtmlAttributeEntities(raw: string): string {
  if (!raw) return '';
  return raw
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;|&#x27;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&amp;/gi, '&');
}

function extractMetaContent(html: string, attrName: 'property' | 'name', attrValue: string): string | null {
  const escaped = attrValue.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const attrPattern = `${attrName}=(?:"${escaped}"|'${escaped}')`;
  const contentPattern = `content=(?:"([^"]*)"|'([^']*)')`;

  const forwardRe = new RegExp(
    `<meta[^>]*\\b${attrPattern}[^>]*\\b${contentPattern}[^>]*>`,
    'i'
  );
  const forward = html.match(forwardRe);
  const forwardVal = forward?.[1] ?? forward?.[2];
  if (forwardVal !== undefined) return decodeHtmlAttributeEntities(forwardVal).trim();

  const reverseRe = new RegExp(
    `<meta[^>]*\\b${contentPattern}[^>]*\\b${attrPattern}[^>]*>`,
    'i'
  );
  const reverse = html.match(reverseRe);
  const reverseVal = reverse?.[1] ?? reverse?.[2];
  if (reverseVal !== undefined) return decodeHtmlAttributeEntities(reverseVal).trim();

  return null;
}

function extractCanonicalHref(html: string): string | undefined {
  const forward = html.match(
    /<link[^>]*\brel=(?:"canonical"|'canonical')[^>]*\bhref=(?:"([^"]+)"|'([^']+)')[^>]*>/i
  );
  const forwardVal = forward?.[1] ?? forward?.[2];
  if (forwardVal) return decodeHtmlAttributeEntities(forwardVal).trim();
  const reverse = html.match(
    /<link[^>]*\bhref=(?:"([^"]+)"|'([^']+)')[^>]*\brel=(?:"canonical"|'canonical')[^>]*>/i
  );
  const reverseVal = reverse?.[1] ?? reverse?.[2];
  if (reverseVal) return decodeHtmlAttributeEntities(reverseVal).trim();
  return undefined;
}

function coerceGameRecord(
  candidate: unknown,
  expectedId: number,
  canonicalHref?: string
): ParsedOpenCriticRecord | null {
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
    return null;
  }
  const obj = candidate as Record<string, unknown>;
  const rawScore = typeof obj.topCriticScore === 'number' ? obj.topCriticScore : Number(obj.topCriticScore);
  if (!Number.isFinite(rawScore)) {
    return null;
  }

  const rawId = obj.id !== undefined ? Number(obj.id) : expectedId;
  if (Number.isFinite(rawId) && rawId > 0 && rawId !== expectedId) {
    return null;
  }

  const name = typeof obj.name === 'string' ? obj.name.trim() : '';
  const rawPercent =
    typeof obj.percentRecommended === 'number'
      ? obj.percentRecommended
      : typeof obj.percentRecommended === 'string'
      ? Number(obj.percentRecommended)
      : NaN;
  const percentRecommended =
    Number.isFinite(rawPercent) && rawPercent >= 0 ? Math.round(rawPercent) : undefined;

  const rawNumReviews =
    typeof obj.numReviews === 'number' && Number.isFinite(obj.numReviews) && obj.numReviews > 0
      ? Math.round(obj.numReviews)
      : typeof obj.numTopCriticReviews === 'number' &&
        Number.isFinite(obj.numTopCriticReviews) &&
        obj.numTopCriticReviews > 0
      ? Math.round(obj.numTopCriticReviews)
      : undefined;

  const firstReleaseDate =
    typeof obj.firstReleaseDate === 'string'
      ? obj.firstReleaseDate.trim()
      : typeof obj.releaseDate === 'string'
      ? obj.releaseDate.trim()
      : undefined;
  const releaseYear = parseValidYear(firstReleaseDate) ?? undefined;

  const rawUrl = typeof obj.url === 'string' ? obj.url.trim() : canonicalHref;
  const url = normalizeOpenCriticUrl(rawUrl, expectedId, name);

  let summary: string | undefined;
  if (obj.reviewSummary && typeof obj.reviewSummary === 'object' && !Array.isArray(obj.reviewSummary)) {
    const nestedSummary = (obj.reviewSummary as { summary?: unknown }).summary;
    if (typeof nestedSummary === 'string' && nestedSummary.trim()) {
      summary = nestedSummary.trim();
    }
  } else if (typeof obj.summary === 'string' && obj.summary.trim()) {
    summary = obj.summary.trim();
  }

  return {
    id: expectedId,
    name,
    topCriticScore: rawScore,
    ...(percentRecommended !== undefined ? { percentRecommended } : {}),
    ...(rawNumReviews !== undefined ? { numReviews: rawNumReviews } : {}),
    ...(firstReleaseDate ? { firstReleaseDate } : {}),
    ...(releaseYear !== undefined ? { releaseYear } : {}),
    url,
    ...(summary ? { summary } : {}),
  };
}

function findGameRecordInStateObject(
  stateObj: unknown,
  openCriticId: number,
  canonicalHref?: string
): ParsedOpenCriticRecord | null {
  if (!stateObj || typeof stateObj !== 'object' || Array.isArray(stateObj)) {
    return null;
  }

  // Direct JSON game object (e.g. unit test mock returning game payload directly)
  const direct = coerceGameRecord(stateObj, openCriticId, canonicalHref);
  if (direct) return direct;

  const rec = stateObj as Record<string, unknown>;

  // Exact Angular TransferState key `game/<id>`
  const exactKey = `game/${openCriticId}`;
  if (exactKey in rec) {
    const exactMatch = coerceGameRecord(rec[exactKey], openCriticId, canonicalHref);
    if (exactMatch) return exactMatch;
  }

  // Scan keys matching `game/<id>` or containing Angular HTTP transfer cache wrappers (`b` / `body` / `data`)
  const keyPattern = new RegExp(`(?:^|/)game/${openCriticId}(?:$|[/?#])`, 'i');
  for (const [key, value] of Object.entries(rec)) {
    if (!keyPattern.test(key) || !value || typeof value !== 'object') continue;
    const directVal = coerceGameRecord(value, openCriticId, canonicalHref);
    if (directVal) return directVal;

    const wrapped = value as { b?: unknown; body?: unknown; data?: unknown };
    const fromWrapped =
      coerceGameRecord(wrapped.b, openCriticId, canonicalHref) ??
      coerceGameRecord(wrapped.body, openCriticId, canonicalHref) ??
      coerceGameRecord(wrapped.data, openCriticId, canonicalHref);
    if (fromWrapped) return fromWrapped;
  }

  // Fallback scan of all top-level state values for matching `id === openCriticId` + `topCriticScore`
  for (const value of Object.values(rec)) {
    if (!value || typeof value !== 'object') continue;
    const directVal = coerceGameRecord(value, openCriticId, canonicalHref);
    if (directVal) return directVal;

    const wrapped = value as { b?: unknown; body?: unknown; data?: unknown };
    const fromWrapped =
      coerceGameRecord(wrapped.b, openCriticId, canonicalHref) ??
      coerceGameRecord(wrapped.body, openCriticId, canonicalHref) ??
      coerceGameRecord(wrapped.data, openCriticId, canonicalHref);
    if (fromWrapped) return fromWrapped;
  }

  return null;
}

function parseOpenCriticOgFallback(
  html: string,
  openCriticId: number,
  canonicalHref?: string
): ParsedOpenCriticRecord | null {
  const ogDesc =
    extractMetaContent(html, 'property', 'og:description') ||
    extractMetaContent(html, 'name', 'description');
  if (!ogDesc) return null;

  const scoreMatch = ogDesc.match(/average\s+score\s+of\s+(\d+(?:\.\d+)?)/i);
  if (!scoreMatch?.[1]) return null;
  const topCriticScore = Number(scoreMatch[1]);
  if (!Number.isFinite(topCriticScore) || topCriticScore <= 0) return null;

  const numReviewsMatch = ogDesc.match(/reviewed\s+by\s+(\d[\d,]*)\s+critics?/i);
  const numReviews = numReviewsMatch?.[1]
    ? Number.parseInt(numReviewsMatch[1].replace(/,/g, ''), 10)
    : undefined;

  const percentMatch = ogDesc.match(/(\d+(?:\.\d+)?)%\s+of\s+critics\s+recommend/i);
  const percentRecommended = percentMatch?.[1]
    ? Math.round(Number(percentMatch[1]))
    : undefined;

  const ogTitle = extractMetaContent(html, 'property', 'og:title');
  const titleTagMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const rawTitleCandidate =
    ogTitle ||
    (titleTagMatch?.[1] ? decodeHtmlAttributeEntities(titleTagMatch[1]).trim() : '') ||
    ogDesc.match(/^(.+?)\s+is\s+rated\b/i)?.[1] ||
    '';

  const name = rawTitleCandidate
    .replace(/\s*[-–—|]\s*OpenCritic\s*$/i, '')
    .replace(/\s+Reviews\s*$/i, '')
    .trim();

  return {
    id: openCriticId,
    name,
    topCriticScore,
    ...(percentRecommended !== undefined && Number.isFinite(percentRecommended)
      ? { percentRecommended }
      : {}),
    ...(numReviews !== undefined && Number.isFinite(numReviews) && numReviews > 0
      ? { numReviews }
      : {}),
    url: normalizeOpenCriticUrl(canonicalHref, openCriticId, name),
  };
}

export function parseOpenCriticResponsePayload(
  rawText: string,
  openCriticId: number,
  contentType: string = ''
): ParsedOpenCriticRecord | null {
  if (!rawText || typeof rawText !== 'string') return null;
  const trimmed = rawText.trim();
  if (!trimmed) return null;

  // 1. Direct JSON fallback (supports JSON responses or JSON-mocked unit tests)
  if (/application\/json/i.test(contentType) || trimmed.startsWith('{')) {
    try {
      const parsed: unknown = JSON.parse(trimmed);
      const fromJson = findGameRecordInStateObject(parsed, openCriticId);
      if (fromJson) return fromJson;
    } catch {
      // Fall through to HTML parsing
    }
  }

  const canonicalHref = extractCanonicalHref(rawText);

  // 2. Primary Angular TransferState `<script id="serverApp-state" ...>`
  const stateScriptMatch = rawText.match(
    /<script[^>]*\bid=["']serverApp-state["'][^>]*>([\s\S]*?)<\/script>/i
  );
  if (stateScriptMatch?.[1]) {
    const decoded = decodeAngularTransferState(stateScriptMatch[1].trim());
    try {
      const parsedState: unknown = JSON.parse(decoded);
      const fromState = findGameRecordInStateObject(parsedState, openCriticId, canonicalHref);
      if (fromState) return fromState;
    } catch {
      // Fall through to og:description fallback
    }
  }

  // 3. Fallback `<meta property="og:description">` when TransferState is absent
  return parseOpenCriticOgFallback(rawText, openCriticId, canonicalHref);
}

function tokenizeTitleForOpenCriticValidation(raw: string): string[] {
  const parenYr = extractParentheticalReleaseYear(raw);
  const parenYrStr = parenYr !== null ? String(parenYr) : null;
  let cleaned = stripPackagingEditionPhrases(stripYearEditionPhrases(raw));
  cleaned = cleaned.replace(/[\(\[]\s*(?:[^)\]]*?[,\s-])?(?:19|20)\d{2}\s*[\)\]]/g, ' ');
  const normalized = normalizeTitleKey(cleaned);
  if (!normalized) return [];
  const rawTokens = normalized.split(' ').filter(Boolean);
  const filtered = rawTokens
    .map((t) => ROMAN_TO_ARABIC[t] || t)
    .filter(
      (t) =>
        !TITLE_STOP_WORDS.has(t) &&
        !EDITION_TOKENS.has(t) &&
        t !== parenYrStr &&
        !isYearEditionToken(raw, t)
    );
  return filtered.length > 0 ? filtered : rawTokens.map((t) => ROMAN_TO_ARABIC[t] || t);
}

function isOpenCriticTitleCompatible(
  expectedTitle: string,
  candidateName: string,
  candidateUrl?: string,
  isVerifiedAnchor: boolean = false
): boolean {
  if (!expectedTitle || !expectedTitle.trim()) return true;

  const candidateTargets: string[] = [];
  if (candidateName && candidateName.trim()) {
    candidateTargets.push(candidateName.trim());
  }
  if (candidateUrl) {
    const slugMatch = candidateUrl.match(/opencritic\.com\/game\/\d+\/([^/?#]+)/i);
    if (slugMatch?.[1] && slugMatch[1].toLowerCase() !== 'game') {
      candidateTargets.push(slugMatch[1].replace(/-/g, ' '));
    }
  }
  if (candidateTargets.length === 0) return true;

  const queryVariants = [expectedTitle];
  const nonAsciiProjected = expectedTitle
    .replace(/[^\x00-\x7f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (nonAsciiProjected && nonAsciiProjected !== expectedTitle) {
    queryVariants.push(nonAsciiProjected);
  }
  if (isVerifiedAnchor) {
    const withoutRemaster = expectedTitle
      .replace(/\b(remastered|remaster)\b/gi, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (withoutRemaster && withoutRemaster !== expectedTitle) {
      queryVariants.push(withoutRemaster);
    }
  }

  const pairMatches = (q: string, c: string): boolean => {
    if (isSequelMismatch(q, c)) return false;
    if (isIntermediateNumeralSubtitleMatch(q, c)) return true;

    const rawQ = tokenizeTitleForOpenCriticValidation(q);
    const rawC = tokenizeTitleForOpenCriticValidation(c);
    if (rawQ.length === 0 || rawC.length === 0) return true;

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
    return qCoverage >= 0.75 && cCoverage >= 0.75;
  };

  for (const qv of queryVariants) {
    for (const ct of candidateTargets) {
      if (pairMatches(qv, ct)) {
        return true;
      }
    }
  }

  return false;
}

function isOpenCriticYearValid(
  expectedTitle: string | undefined,
  releaseYear: number | string | null | undefined,
  candidateYear: number | undefined,
  candidateName: string,
  isVerifiedAnchor: boolean
): boolean {
  if (candidateYear === undefined) return true;

  const titleYr = expectedTitle ? extractParentheticalReleaseYear(expectedTitle) : null;
  if (titleYr !== null && Math.abs(titleYr - candidateYear) > 2) {
    return false;
  }

  const paramYr = parseValidYear(releaseYear);
  const hasRemasterTag = Boolean(expectedTitle && REMASTER_OR_EDITION_RE.test(expectedTitle));

  if (
    titleYr === null &&
    paramYr !== null &&
    paramYr <= 2020 &&
    candidateYear > paramYr + 3 &&
    !hasRemasterTag &&
    !isVerifiedAnchor
  ) {
    return false;
  }

  if (expectedTitle && !isVerifiedAnchor) {
    const titleNoYear = expectedTitle
      .replace(/\s*[\(\[]\s*(?:19|20)\d{2}\s*[\)\]]/g, '')
      .trim();
    if (
      /\b(?:1|i)\b/i.test(titleNoYear) &&
      candidateName &&
      !/\b(?:1|i)\b/i.test(candidateName) &&
      candidateYear >= 2015
    ) {
      return false;
    }
  }

  return true;
}

export class OpenCriticResolver {
  private readonly inMemoryCache = new Map<number, OpenCriticCacheEntry>();
  private readonly trackedStagedKeys = new Set<string>();
  private readonly inFlightById = new Map<number, Promise<ParsedOpenCriticRecord | null>>();
  private readonly transientFailures = new Map<string, number>();
  private lastGlobalTransientFailureAt = 0;

  private makeStagedKey(openCriticId: number): string {
    return `${STAGED_PREFIX}${openCriticId}`;
  }

  private setMemoryEntry(
    openCriticId: number,
    value: ParsedOpenCriticRecord | null,
    ttlMs: number,
    mirroredInStorage: boolean
  ): void {
    if (this.inMemoryCache.has(openCriticId)) {
      this.inMemoryCache.delete(openCriticId);
    }
    this.inMemoryCache.set(openCriticId, {
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

  private readCacheEntry(
    openCriticId: number
  ): { hit: boolean; value: ParsedOpenCriticRecord | null } {
    const stagedKey = this.makeStagedKey(openCriticId);
    const mem = this.inMemoryCache.get(openCriticId);
    if (mem) {
      if (mem.mirroredInStorage) {
        const storage = getStorageSafe();
        if (storage && storage.getItem(stagedKey) === null) {
          this.inMemoryCache.delete(openCriticId);
        } else if (Date.now() < mem.expiresAt) {
          return { hit: true, value: mem.value };
        } else {
          this.inMemoryCache.delete(openCriticId);
        }
      } else if (Date.now() < mem.expiresAt) {
        return { hit: true, value: mem.value };
      } else {
        this.inMemoryCache.delete(openCriticId);
      }
    }

    const staged = loadStagedCache<ParsedOpenCriticRecord>(stagedKey, false);
    if (staged.valid) {
      const remainingMs =
        staged.entry &&
        typeof staged.entry.cachedAt === 'number' &&
        typeof staged.entry.ttlMs === 'number'
          ? Math.max(1000, staged.entry.cachedAt + staged.entry.ttlMs - Date.now())
          : staged.data
          ? POSITIVE_MATURE_TTL_MS
          : NEGATIVE_TTL_MS;
      const storage = getStorageSafe();
      const mirrored = Boolean(storage && storage.getItem(stagedKey) !== null);
      this.setMemoryEntry(openCriticId, staged.data, remainingMs, mirrored);
      this.trackedStagedKeys.add(stagedKey);
      return { hit: true, value: staged.data };
    }

    return { hit: false, value: null };
  }

  private writePositiveCache(openCriticId: number, record: ParsedOpenCriticRecord): void {
    const stagedKey = this.makeStagedKey(openCriticId);
    const currentYear = new Date().getFullYear();
    const isFreshRelease =
      record.releaseYear !== undefined && record.releaseYear >= currentYear;
    const ttlMs = isFreshRelease ? POSITIVE_FRESH_TTL_MS : POSITIVE_MATURE_TTL_MS;
    const tier = isFreshRelease ? 'fresh' : 'mature';

    this.trackedStagedKeys.add(stagedKey);
    saveStagedCache<ParsedOpenCriticRecord>(stagedKey, record, tier, {
      source: 'opencritic',
      isVerified: true,
      customTtlMs: ttlMs,
      dynamicResolved: true,
    });
    const storage = getStorageSafe();
    const mirrored = Boolean(storage && storage.getItem(stagedKey) !== null);
    this.setMemoryEntry(openCriticId, record, ttlMs, mirrored);
    this.clearTransientFailureForKeys([`id:${openCriticId}`, String(openCriticId)]);
  }

  private writeNegativeCache(openCriticId: number): void {
    const stagedKey = this.makeStagedKey(openCriticId);
    this.trackedStagedKeys.add(stagedKey);
    saveStagedCache<ParsedOpenCriticRecord>(stagedKey, null, 'negative', {
      source: 'opencritic',
      failureReason: 'not_found',
      customTtlMs: NEGATIVE_TTL_MS,
      dynamicResolved: true,
    });
    const storage = getStorageSafe();
    const mirrored = Boolean(storage && storage.getItem(stagedKey) !== null);
    this.setMemoryEntry(openCriticId, null, NEGATIVE_TTL_MS, mirrored);
  }

  private buildFailureKeys(params: {
    openCriticId?: number;
    expectedTitle?: string;
    steamAppId?: number | null;
  }): string[] {
    const keys: string[] = [];
    if (params.openCriticId && params.openCriticId > 0) {
      keys.push(String(params.openCriticId), `id:${params.openCriticId}`);
    }
    if (params.steamAppId && params.steamAppId > 0) {
      keys.push(`steam:${params.steamAppId}`, `id:${params.steamAppId}`);
    }
    if (params.expectedTitle && params.expectedTitle.trim()) {
      const lower = params.expectedTitle.trim().toLowerCase();
      const norm = normalizeTitleKey(params.expectedTitle);
      keys.push(lower, `title:${lower}`);
      if (norm && norm !== lower) {
        keys.push(norm, `title:${norm}`);
      }
    }
    return keys;
  }

  private markTransientFailure(keys: string[]): void {
    const now = Date.now();
    this.lastGlobalTransientFailureAt = now;
    for (const key of keys) {
      if (key) {
        this.transientFailures.set(key, now);
      }
    }
    while (this.transientFailures.size > MAX_IN_MEMORY_ENTRIES) {
      const oldest = this.transientFailures.keys().next().value;
      if (oldest === undefined) break;
      this.transientFailures.delete(oldest);
    }
  }

  private clearTransientFailureForKeys(keys: string[]): void {
    for (const key of keys) {
      if (key) {
        this.transientFailures.delete(key);
      }
    }
  }

  public hadRecentTransientFailure(key?: string): boolean {
    const now = Date.now();
    if (!key) {
      return now - this.lastGlobalTransientFailureAt < TRANSIENT_FAILURE_WINDOW_MS;
    }

    const trimmed = key.trim();
    const lower = trimmed.toLowerCase();
    const norm = normalizeTitleKey(trimmed);
    const probes = [
      trimmed,
      lower,
      `id:${trimmed}`,
      `steam:${trimmed}`,
      `title:${lower}`,
      ...(norm ? [norm, `title:${norm}`] : []),
    ];

    for (const probe of probes) {
      const ts = this.transientFailures.get(probe);
      if (ts !== undefined) {
        if (now - ts < TRANSIENT_FAILURE_WINDOW_MS) {
          return true;
        }
        this.transientFailures.delete(probe);
      }
    }

    return false;
  }

  public clearCache(options?: { negativesOnly?: boolean }): void {
    const negativesOnly = Boolean(options?.negativesOnly);
    this.transientFailures.clear();
    this.lastGlobalTransientFailureAt = 0;

    if (negativesOnly) {
      for (const [id, entry] of this.inMemoryCache.entries()) {
        if (entry.value === null) {
          this.inMemoryCache.delete(id);
          const stagedKey = this.makeStagedKey(id);
          evictStagedCache(stagedKey);
          this.trackedStagedKeys.delete(stagedKey);
        }
      }
      return;
    }

    this.inMemoryCache.clear();
    this.inFlightById.clear();
    for (const stagedKey of this.trackedStagedKeys) {
      evictStagedCache(stagedKey);
    }
    this.trackedStagedKeys.clear();
  }

  private async fetchRawRecordById(
    openCriticId: number,
    priority: number,
    failureKeys: string[],
    bypassCache: boolean
  ): Promise<ParsedOpenCriticRecord | null> {
    if (!bypassCache) {
      const cached = this.readCacheEntry(openCriticId);
      if (cached.hit) {
        return cached.value;
      }
    }

    const existingInFlight = !bypassCache ? this.inFlightById.get(openCriticId) : undefined;
    if (existingInFlight) {
      return existingInFlight;
    }

    const run = (async (): Promise<ParsedOpenCriticRecord | null> => {
      if (!onlineLifecycleManager.isOnline()) {
        this.markTransientFailure(failureKeys);
        return null;
      }

      const canonicalUrl = `https://opencritic.com/game/${openCriticId}/game`;
      const fetchUrl = `${getOpenCriticWebBaseUrl()}/game/${openCriticId}/game`;

      try {
        const response = await requestScheduler.schedule(
          canonicalUrl,
          () =>
            fetch(fetchUrl, {
              signal: createTimeoutSignal(FETCH_TIMEOUT_MS),
            }),
          priority,
          'api.opencritic.com'
        );

        if (!response) {
          this.markTransientFailure(failureKeys);
          return null;
        }

        if (!response.ok) {
          if (response.status === 404) {
            this.writeNegativeCache(openCriticId);
            this.clearTransientFailureForKeys(failureKeys);
            return null;
          }
          const isTransient =
            response.status === 429 ||
            response.status >= 500 ||
            isWafOrChallengeResponse(response.status, '', response.headers);
          if (isTransient) {
            this.markTransientFailure(failureKeys);
          }
          return null;
        }

        const contentType =
          typeof response.headers?.get === 'function'
            ? response.headers.get('content-type') || ''
            : '';

        let parsed: ParsedOpenCriticRecord | null = null;
        if (typeof response.text === 'function') {
          const rawText = await response.text();
          if (isWafOrChallengeResponse(response.status, rawText, response.headers, false)) {
            this.markTransientFailure(failureKeys);
            return null;
          }
          parsed = parseOpenCriticResponsePayload(rawText, openCriticId, contentType);
        } else if (typeof response.json === 'function') {
          const jsonPayload: unknown = await response.json();
          parsed = findGameRecordInStateObject(jsonPayload, openCriticId);
        } else {
          this.markTransientFailure(failureKeys);
          return null;
        }

        if (!parsed) {
          // Response was 200 OK without TransferState or og:description; avoid long negative lock-in
          return null;
        }

        if (!Number.isFinite(parsed.topCriticScore) || parsed.topCriticScore <= 0) {
          this.writeNegativeCache(openCriticId);
          this.clearTransientFailureForKeys(failureKeys);
          return null;
        }

        this.writePositiveCache(openCriticId, parsed);
        this.clearTransientFailureForKeys(failureKeys);
        return parsed;
      } catch (err: unknown) {
        const classified = classifyNetworkError(err);
        if (classified.status === 'transient_error') {
          this.markTransientFailure(failureKeys);
        }
        return null;
      }
    })();

    if (!bypassCache) {
      this.inFlightById.set(openCriticId, run);
    }
    try {
      return await run;
    } finally {
      if (!bypassCache && this.inFlightById.get(openCriticId) === run) {
        this.inFlightById.delete(openCriticId);
      }
    }
  }

  public async resolveById(
    openCriticId: number,
    options?: OpenCriticResolveByIdOptions
  ): Promise<CriticScoreData | null> {
    if (!Number.isSafeInteger(openCriticId) || openCriticId <= 0) {
      return null;
    }

    const priority = options?.priority ?? Priority.P1_VIEWPORT;
    const isVerifiedAnchor = Boolean(options?.isVerifiedAnchor);
    const failureKeys = this.buildFailureKeys({
      openCriticId,
      expectedTitle: options?.expectedTitle,
    });

    const record = await this.fetchRawRecordById(
      openCriticId,
      priority,
      failureKeys,
      Boolean(options?.bypassCache)
    );

    if (!record) {
      return null;
    }

    const rawScore = Math.round(record.topCriticScore);
    if (!Number.isFinite(rawScore) || rawScore <= 0 || rawScore > 100) {
      return null;
    }

    if (options?.expectedTitle) {
      if (
        !isOpenCriticTitleCompatible(
          options.expectedTitle,
          record.name,
          record.url,
          isVerifiedAnchor
        )
      ) {
        return null;
      }
      if (
        !isOpenCriticYearValid(
          options.expectedTitle,
          options.releaseYear,
          record.releaseYear,
          record.name,
          isVerifiedAnchor
        )
      ) {
        return null;
      }
    }

    let finalScore = rawScore;
    if (
      typeof options?.anchorScore === 'number' &&
      Number.isFinite(options.anchorScore) &&
      options.anchorScore > 0
    ) {
      const anchorScoreRounded = Math.round(options.anchorScore);
      if (Math.abs(rawScore - anchorScoreRounded) > 5) {
        return null;
      }
      if (isVerifiedAnchor) {
        finalScore = anchorScoreRounded;
      }
    }

    const percentRecommended =
      typeof record.percentRecommended === 'number' &&
      Number.isFinite(record.percentRecommended) &&
      record.percentRecommended >= 0
        ? Math.round(record.percentRecommended)
        : undefined;
    const tier = calculateTier(finalScore, percentRecommended);
    const url =
      options?.anchorUrl ||
      record.url ||
      normalizeOpenCriticUrl(undefined, openCriticId, record.name);
    const summary =
      record.summary ||
      (isVerifiedAnchor && options?.anchorStorefront
        ? `Verified by official ${options.anchorStorefront.toUpperCase()} store review anchor.`
        : undefined);

    return {
      id: openCriticId,
      source: 'opencritic',
      score: finalScore,
      tier,
      ...(percentRecommended !== undefined ? { percentRecommended } : {}),
      ...(record.numReviews !== undefined ? { numReviews: record.numReviews } : {}),
      url,
      ...(summary ? { summary } : {}),
      isVerified: true,
    };
  }

  public async resolveForGame(
    params: OpenCriticResolveForGameParams
  ): Promise<CriticScoreData | null> {
    const priority = params.priority ?? Priority.P1_VIEWPORT;
    const anchor = params.storefrontAnchor ?? null;
    const failureKeys = this.buildFailureKeys({
      openCriticId: params.openCriticId ?? anchor?.openCriticId,
      expectedTitle: params.title,
      steamAppId: params.steamAppId,
    });

    let openCriticId: number | undefined;
    let isVerifiedAnchor = false;

    if (
      typeof params.openCriticId === 'number' &&
      Number.isSafeInteger(params.openCriticId) &&
      params.openCriticId > 0
    ) {
      openCriticId = params.openCriticId;
    } else if (
      typeof anchor?.openCriticId === 'number' &&
      Number.isSafeInteger(anchor.openCriticId) &&
      anchor.openCriticId > 0
    ) {
      openCriticId = anchor.openCriticId;
      isVerifiedAnchor = true;
    } else {
      const links = await wikidataBridge.resolveForGame({
        steamAppId: params.steamAppId,
        gogSlug: params.gogSlug,
        title: params.title,
        releaseYear: params.releaseYear,
        priority,
      });

      if (links?.openCriticId) {
        openCriticId = links.openCriticId;
      } else {
        const steamFailKey = params.steamAppId ? `steam:${params.steamAppId}` : undefined;
        const normTitle = normalizeTitleKey(params.title || '');
        const titleFailKey = normTitle ? `title:${normTitle}` : undefined;
        if (
          (steamFailKey && wikidataBridge.hadRecentTransientFailure(steamFailKey)) ||
          (titleFailKey && wikidataBridge.hadRecentTransientFailure(titleFailKey))
        ) {
          this.markTransientFailure(failureKeys);
        }
      }
    }

    if (openCriticId !== undefined) {
      const resolved = await this.resolveById(openCriticId, {
        expectedTitle: params.title,
        releaseYear: params.releaseYear,
        priority,
        isVerifiedAnchor,
        anchorScore: anchor?.openCriticScore,
        anchorStorefront: anchor?.storefront,
        anchorUrl: anchor?.openCriticUrl,
        bypassCache: params.bypassCache,
      });
      if (resolved) {
        return resolved;
      }
    }

    // Authoritative storefront OpenCritic anchor fallback (e.g. GOG/Epic embedded OpenCritic score)
    if (
      anchor &&
      typeof anchor.openCriticScore === 'number' &&
      Number.isFinite(anchor.openCriticScore) &&
      anchor.openCriticScore > 0
    ) {
      const score = Math.round(anchor.openCriticScore);
      const storeLabel = anchor.storefront.toUpperCase();
      return {
        id:
          anchor.openCriticId ??
          `anchor-opencritic-${normalizeTitleKey(params.title) || 'game'}`,
        source: 'opencritic',
        score,
        tier: calculateTier(score),
        url:
          anchor.openCriticUrl ||
          (anchor.openCriticId
            ? `https://opencritic.com/game/${anchor.openCriticId}/${buildOpenCriticSlug(params.title)}`
            : anchor.rawStoreUrl || ''),
        summary: `Verified by official ${storeLabel} store review anchor.`,
        isVerified: true,
      };
    }

    return null;
  }
}

export const openCriticResolver = new OpenCriticResolver();
