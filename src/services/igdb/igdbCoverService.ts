/**
 * IGDB Cover Art Service
 * Provides instantaneous resolution and dynamic fallback to high-resolution
 * portrait covers hosted on images.igdb.com.
 */

import {
  isSequelMismatch,
  normalizeTitleKey,
  extractSequelIdentifier,
  EDITION_TOKENS,
} from '../common/titleUtils';
import { computeAdaptive404RetryDelayMs, isWafOrChallengeResponse } from '../../contracts/network';
import { requestScheduler, Priority } from '../network/requestScheduler';
import { onlineLifecycleManager } from '../network/onlineLifecycleManager';
import { syncJobManager } from '../network/syncJobManager';
import { isTitleCompatible } from '../critic/metacriticResolver';
import { vaultDelete, vaultGet, vaultSet } from '../storage/indexedDbVault';

const STORAGE_KEY_IGDB_COVERS_V1 = 'antigravity_igdb_covers';
const STORAGE_KEY_IGDB_COVERS = 'antigravity_igdb_covers_v2';
const STORAGE_KEY_COVER_SCHEMA_MIGRATION = 'antigravity_igdb_covers_schema_v3';
const STORAGE_KEY_GOG_BOXART = 'antigravity_gog_boxart_v1';
const STORAGE_KEY_DEAD_STEAM_COVERS = 'antigravity_dead_steam_covers_v1';
const STORAGE_KEY_DEAD_STEAM_COVER_COUNTS = 'antigravity_dead_steam_cover_counts_v1';
const NEGATIVE_COVER_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const DEAD_STEAM_COVER_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

// Steam App IDs verified to not host standard unhashed library_600x900 assets on Steam CDN
export const KNOWN_DEAD_STEAM_COVER_APP_IDS = new Set<number>();

export function isKnownDeadSteamCover(appId?: number | null): boolean {
  if (!appId) return false;
  igdbCoverService.ensureInitialized();
  return KNOWN_DEAD_STEAM_COVER_APP_IDS.has(appId);
}

export const KNOWN_IGDB_COVERS: Record<string, string> = {};

export const NORMALIZED_KNOWN_IGDB_COVERS = new Map<string, string>();

for (const [k, v] of Object.entries(KNOWN_IGDB_COVERS)) {
  NORMALIZED_KNOWN_IGDB_COVERS.set(k.toLowerCase().trim(), v);
  NORMALIZED_KNOWN_IGDB_COVERS.set(normalizeKey(k), v);
}

/**
 * Extracts the 64-character hex asset hash from a GOG CDN URL.
 */
export function extractGogImageHash(url?: string | null): string | null {
  if (!url) return null;
  const match = url.match(/\/([a-f0-9]{64})/i);
  return match ? match[1].toLowerCase() : null;
}

function isGogStaticsUrl(rawUrl: string): boolean {
  try {
    const normalized = rawUrl.startsWith('//') ? `https:${rawUrl}` : rawUrl;
    const host = new URL(normalized).hostname.toLowerCase();
    return host === 'gog-statics.com' || host.endsWith('.gog-statics.com');
  } catch {
    return false;
  }
}

const WIDE_OR_LANDSCAPE_ASSET_TOKEN_REGEX = /(?:^|[^a-z0-9])(wide|landscape)(?:$|[^a-z0-9])/i;

/**
 * Detects whether a GOG cover URL is a server-cropped 16:9 horizontal banner
 * (created by applying the `_glx_vertical_cover` formatter to a horizontal `p.image` hash
 * or sharing the same 64-char hash as the game's horizontal `headerImage`).
 */
export function isGogCroppedHorizontalCover(
  capsuleUrl?: string | null,
  headerUrl?: string | null
): boolean {
  if (!capsuleUrl) return false;
  const lower = capsuleUrl.toLowerCase();
  if (!isGogStaticsUrl(capsuleUrl)) return false;
  if (lower.includes('_glx_vertical_cover')) return true;

  if (headerUrl) {
    const capHash = extractGogImageHash(capsuleUrl);
    const headHash = extractGogImageHash(headerUrl);
    if (capHash && headHash && capHash === headHash) {
      return true;
    }
  }
  return false;
}

/**
 * Checks whether an image URL represents an unsuitable horizontal banner,
 * wide capsule, server-cropped horizontal GOG banner, or broken asset
 * that should not be displayed in a 2:3 portrait card.
 */
export function isUnsuitableCoverUrl(url?: string | null): boolean {
  if (!url) return true;
  const lower = url.toLowerCase();

  // 1. Known horizontal banner URL dimensions / names & GOG server-cropped horizontal formatter
  if (
    lower.includes('184x69') ||
    lower.includes('capsule_184x69') ||
    lower.includes('capsule_sm_120') ||
    lower.includes('231x87') ||
    lower.includes('467x181') ||
    lower.includes('616x353') ||
    lower.includes('header.jpg') ||
    lower.includes('mobile_slider') ||
    lower.includes('sbicon') ||
    lower.includes('_glx_vertical_cover') ||
    lower.includes('_glx_logo') ||
    lower.includes('avatars/default.png') ||
    lower.includes('egs-badge') ||
    WIDE_OR_LANDSCAPE_ASSET_TOKEN_REGEX.test(lower)
  ) {
    return true;
  }

  // 2. Dead Steam App IDs returning 404
  for (const deadId of KNOWN_DEAD_STEAM_COVER_APP_IDS) {
    if (lower.includes(`apps/${deadId}/library_600x900`)) return true;
  }

  return false;
}

/**
 * Checks whether a header/banner or icon URL is a placeholder badge, SDK test asset,
 * or belongs to a dead Steam CDN asset that should be replaced when merging metadata.
 */
export function isUnsuitableHeaderUrl(url?: string | null): boolean {
  if (!url) return true;
  const lower = url.toLowerCase();
  if (
    lower.includes('egs-badge') ||
    lower.includes('avatars/default.png') ||
    lower.includes('/apps/480/') ||
    lower.endsWith('/480/header.jpg')
  ) {
    return true;
  }
  return false;
}


export function normalizeKey(str: string): string {
  return str
    .toLowerCase()
    .replace(/[™®©]/g, '')
    .replace(/['’]/g, '')
    .replace(/\s*\((?:19|20)\d{2}\)/g, '')
    .replace(/[:\-–—]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Normalizes a persistent cover cache key while preserving an explicit `:YYYY` release year suffix.
 */
export function normalizeCacheKey(rawKey: string): string {
  const m = rawKey.match(/^(.*):((?:19|20)\d{2})$/);
  if (m) {
    return `${normalizeKey(m[1])}:${m[2]}`;
  }
  return normalizeKey(rawKey);
}

const EDITION_WORDS = new Set([
  'complete',
  'definitive',
  'enhanced',
  'goty',
  'deluxe',
  'gold',
  'standard',
  'remastered',
  'remaster',
  'directors',
  'director',
  'cut',
  'edition',
  'collectors',
  'collector',
  'anniversary',
  'special',
  'ultimate',
  'extended',
  'game',
  'year',
  'final',
  'royal',
  'emperor',
  'classics',
  'classic',
  'plus',
  'bundle',
  'pack',
  'package',
  'collection',
  'upgrade',
  'vr',
  'hd',
  'digital',
  'gog',
  'steam',
  'epic',
]);

/**
 * Matches numbered series titles when the storefront omits the subtitle while IGDB/Lutris
 * includes a colon subtitle (e.g. "Ultima Underworld I" <-> "Ultima Underworld: The Stygian Abyss",
 * "Ultima Underworld II" <-> "Ultima Underworld II: Labyrinth of Worlds").
 */
export function isNumberedBaseTitleSubtitleMatch(
  queryTitle: string,
  candidateTitle: string
): boolean {
  if (!queryTitle || !candidateTitle) return false;
  if (queryTitle.includes(':') || !candidateTitle.includes(':')) return false;

  const cleanQ = queryTitle.replace(/[™®©]/g, '').trim();
  const candBase = candidateTitle.split(':')[0].replace(/[™®©]/g, '').trim();
  if (!cleanQ || !candBase) return false;

  // Must end with an explicit Roman or Arabic sequel numeral
  if (!/\b(?:i|ii|iii|iv|v|vi|vii|viii|ix|x|1|2|3|4|5|6|7|8|9|10)\s*$/i.test(cleanQ)) {
    return false;
  }

  // Case A: Exact base + numeral match (e.g. "Ultima Underworld II" === "Ultima Underworld II")
  if (!isSequelMismatch(cleanQ, candBase) && normalizeTitleKey(cleanQ) === normalizeTitleKey(candBase)) {
    return true;
  }

  // Case B: Explicit Part I / 1 vs original subtitled first entry without numeral
  if (/\b(?:i|1)\s*$/i.test(cleanQ) && extractSequelIdentifier(candidateTitle) === null) {
    const strippedQ = cleanQ.replace(/\s+\b(?:i|1)\s*$/i, '').trim();
    const baseWords = normalizeTitleKey(candBase).split(/\s+/).filter(Boolean);
    if (baseWords.length >= 2 && normalizeTitleKey(strippedQ) === normalizeTitleKey(candBase)) {
      return true;
    }
  }

  return false;
}

export function computeTokenSimilarity(t1: string, t2: string): number {
  const numberedSubtitleMatch =
    isNumberedBaseTitleSubtitleMatch(t1, t2) || isNumberedBaseTitleSubtitleMatch(t2, t1);
  if (!numberedSubtitleMatch) {
    if (isSequelMismatch(t1, t2)) return 0;
    if (!isTitleCompatible(t1, t2)) return 0;
  } else {
    return 0.92;
  }

  const cleanT1 = normalizeTitleKey(t1);
  const cleanT2 = normalizeTitleKey(t2);
  const list1 = cleanT1
    .split(/\s+/)
    .filter((w) => w.length > 0 && !['the', 'of', 'in', 'on', 'at', 'to', 'for', 'and', 'or', 'a', 'an'].includes(w));
  const list2 = cleanT2
    .split(/\s+/)
    .filter((w) => w.length > 0 && !['the', 'of', 'in', 'on', 'at', 'to', 'for', 'and', 'or', 'a', 'an'].includes(w));
  const words1 = new Set(list1);
  const words2 = new Set(list2);
  if (words1.size === 0 || words2.size === 0) return 0;

  // Intelligent Edition Variant Matching
  const [shorterSet, longerList] = words1.size <= words2.size ? [words1, list2] : [words2, list1];
  let allShorterInLonger = true;
  for (const w of shorterSet) {
    if (!longerList.includes(w)) {
      allShorterInLonger = false;
      break;
    }
  }
  if (allShorterInLonger) {
    let onlyEditionTokensRemaining = true;
    for (const w of longerList) {
      if (!shorterSet.has(w) && !EDITION_TOKENS.has(w) && !EDITION_WORDS.has(w)) {
        onlyEditionTokensRemaining = false;
        break;
      }
    }
    if (onlyEditionTokensRemaining) {
      return 0.92;
    }
  }

  let intersection = 0;
  for (const w of words1) {
    if (words2.has(w)) intersection++;
  }
  return intersection / Math.max(words1.size, words2.size);
}

const MAX_COVER_CACHE_ENTRIES = 2000;

interface PersistedNegativeCoverRecord {
  url: null;
  cachedAt: number;
}

interface LutrisSearchItem {
  name?: string;
  year?: number | string | null;
  coverart?: string | null;
}

export class IgdbCoverService {
  private cache = new Map<string, string | null>();
  private negativeTimestamps = new Map<string, number>();
  private gogBoxArtCache = new Map<string, string | null>();
  private gogNegativeTimestamps = new Map<string, number>();
  private deadSteamTimestamps = new Map<number, number>();
  private deadSteamFailureCounts = new Map<number, number>();
  private pendingFetches = new Map<string, Promise<string | null>>();
  private initialized = false;
  private cacheGeneration = 0;

  constructor() {
    // Lazily hydrated on first lookup via ensureInitialized() to avoid synchronous constructor localStorage scans
  }

  public ensureInitialized(): void {
    if (this.initialized) return;
    this.initialized = true;
    this.loadPersistentCache();
    void this.hydratePersistentCacheFromVault();
  }

  private setCoverCacheBounded(key: string, val: string | null): void {
    if (this.cache.has(key)) {
      this.cache.delete(key);
    }
    this.cache.set(key, val);
    while (this.cache.size > MAX_COVER_CACHE_ENTRIES) {
      const oldest = this.cache.keys().next().value;
      if (oldest === undefined) break;
      this.cache.delete(oldest);
      this.negativeTimestamps.delete(oldest);
    }
  }

  private setGogCacheBounded(key: string, val: string | null): void {
    if (this.gogBoxArtCache.has(key)) {
      this.gogBoxArtCache.delete(key);
    }
    this.gogBoxArtCache.set(key, val);
    while (this.gogBoxArtCache.size > MAX_COVER_CACHE_ENTRIES) {
      const oldest = this.gogBoxArtCache.keys().next().value;
      if (oldest === undefined) break;
      this.gogBoxArtCache.delete(oldest);
      this.gogNegativeTimestamps.delete(oldest);
    }
  }

  public clearCache(): void {
    this.cacheGeneration += 1;
    this.initialized = true;
    this.cache.clear();
    this.negativeTimestamps.clear();
    this.gogBoxArtCache.clear();
    this.gogNegativeTimestamps.clear();
    this.deadSteamTimestamps.clear();
    this.deadSteamFailureCounts.clear();
    this.pendingFetches.clear();
    KNOWN_DEAD_STEAM_COVER_APP_IDS.clear();
    void vaultDelete(STORAGE_KEY_IGDB_COVERS);
    void vaultDelete(STORAGE_KEY_GOG_BOXART);
    if (typeof localStorage !== 'undefined') {
      try {
        localStorage.removeItem(STORAGE_KEY_IGDB_COVERS);
        localStorage.removeItem(STORAGE_KEY_GOG_BOXART);
        localStorage.removeItem(STORAGE_KEY_DEAD_STEAM_COVERS);
        localStorage.removeItem(STORAGE_KEY_DEAD_STEAM_COVER_COUNTS);
      } catch {
        // Ignore storage errors
      }
    }
  }

  public evictCacheForGame(
    title?: string,
    gogId?: string | number | null,
    steamAppId?: number | null
  ): void {
    this.ensureInitialized();
    if (steamAppId && steamAppId > 0) {
      KNOWN_DEAD_STEAM_COVER_APP_IDS.delete(steamAppId);
      this.deadSteamTimestamps.delete(steamAppId);
      this.deadSteamFailureCounts.delete(steamAppId);
      if (typeof localStorage !== 'undefined') {
        try {
          const deadObj: Record<string, number> = {};
          const countsObj: Record<string, number> = {};
          for (const [id, ts] of this.deadSteamTimestamps.entries()) {
            deadObj[String(id)] = ts;
            const c = this.deadSteamFailureCounts.get(id);
            if (c && c > 0) countsObj[String(id)] = c;
          }
          localStorage.setItem(STORAGE_KEY_DEAD_STEAM_COVERS, JSON.stringify(deadObj));
          localStorage.setItem(STORAGE_KEY_DEAD_STEAM_COVER_COUNTS, JSON.stringify(countsObj));
        } catch {
          // Ignore storage error
        }
      }
    }

    if (gogId !== undefined && gogId !== null && gogId !== '') {
      const cleanId = String(gogId).replace(/^gog-/, '').trim();
      if (cleanId) {
        this.gogBoxArtCache.delete(`id:${cleanId}`);
        this.gogNegativeTimestamps.delete(`id:${cleanId}`);
      }
    }

    if (title && title.trim()) {
      const norm = normalizeKey(title);
      const lower = title.trim().toLowerCase();
      this.gogBoxArtCache.delete(`title:${norm}`);
      for (const k of Array.from(this.cache.keys())) {
        if (k === norm || k === lower || k.startsWith(`${norm}:`)) {
          this.cache.delete(k);
          this.negativeTimestamps.delete(k);
        }
      }
    }

    this.savePersistentCache();
  }

  public recordDeadSteamCover(appId?: number | null, _options?: { verified404?: boolean }): void {
    if (!appId || appId <= 0) return;
    if (typeof navigator !== 'undefined' && navigator.onLine === false) return;
    this.ensureInitialized();
    const now = Date.now();
    const nextCount = (this.deadSteamFailureCounts.get(appId) || 0) + 1;
    KNOWN_DEAD_STEAM_COVER_APP_IDS.add(appId);
    this.deadSteamTimestamps.set(appId, now);
    this.deadSteamFailureCounts.set(appId, nextCount);
    if (typeof localStorage !== 'undefined') {
      try {
        const deadObj: Record<string, number> = {};
        const countsObj: Record<string, number> = {};
        for (const [id, ts] of this.deadSteamTimestamps.entries()) {
          deadObj[String(id)] = ts;
          const count = this.deadSteamFailureCounts.get(id);
          if (count && count > 0) {
            countsObj[String(id)] = count;
          }
        }
        localStorage.setItem(STORAGE_KEY_DEAD_STEAM_COVERS, JSON.stringify(deadObj));
        localStorage.setItem(STORAGE_KEY_DEAD_STEAM_COVER_COUNTS, JSON.stringify(countsObj));
      } catch {
        // Ignore storage write error
      }
    }
  }

  public async verifyAndRecordDeadSteamCover(
    appId: number,
    _failedUrl?: string
  ): Promise<boolean> {
    if (!onlineLifecycleManager.isOnline() || !Number.isFinite(appId) || appId <= 0) {
      return false;
    }

    const probeUrl = `https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/${appId}/library_600x900.jpg`;

    if (typeof window !== 'undefined' && window.electronAPI?.offlineVault?.checkUrlStatus) {
      try {
        const statusRes = await window.electronAPI.offlineVault.checkUrlStatus(probeUrl);
        if (!statusRes || statusRes.online === false || statusRes.isWafOrRateLimited) {
          return false;
        }
        if (statusRes.isDefinitive404 === true || statusRes.status === 404) {
          this.recordDeadSteamCover(appId, { verified404: true });
          return true;
        }
        return false;
      } catch {
        return false;
      }
    }

    try {
      const res = await fetch(probeUrl, {
        method: 'HEAD',
        signal:
          typeof AbortSignal !== 'undefined' && 'timeout' in AbortSignal
            ? AbortSignal.timeout(4500)
            : undefined,
      });
      if (!onlineLifecycleManager.isOnline()) return false;
      if (isWafOrChallengeResponse(res.status, '')) return false;
      if (res.status === 404) {
        this.recordDeadSteamCover(appId, { verified404: true });
        return true;
      }
      return false;
    } catch {
      return false;
    }
  }

  private loadPersistentCache() {
    if (typeof localStorage === 'undefined') return;
    try {
      const hasMigratedSchemaV3 =
        localStorage.getItem(STORAGE_KEY_COVER_SCHEMA_MIGRATION) === '1';
      let needsSaveAfterMigration = false;

      // 1. Migrate positive covers from legacy v1 key ('antigravity_igdb_covers')
      const rawV1 = localStorage.getItem(STORAGE_KEY_IGDB_COVERS_V1);
      if (rawV1) {
        try {
          const parsedV1 = JSON.parse(rawV1);
          if (parsedV1 && typeof parsedV1 === 'object') {
            for (const [k, v] of Object.entries(parsedV1)) {
              const nk = normalizeCacheKey(k);
              if (typeof v === 'string' && v.trim() && !isUnsuitableCoverUrl(v)) {
                this.cache.set(nk, v);
                needsSaveAfterMigration = true;
              }
            }
          }
        } catch {
          // Ignore malformed v1 cache
        }
      }

      // 2. Load v2 IGDB cover cache (purging false negatives once on schema v3 migration)
      const raw = localStorage.getItem(STORAGE_KEY_IGDB_COVERS);
      if (raw) {
        const parsed: unknown = JSON.parse(raw);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
            const nk = normalizeCacheKey(k);
            if (typeof v === 'string' && v.trim() && !isUnsuitableCoverUrl(v)) {
              this.setCoverCacheBounded(nk, v);
            } else if (v && typeof v === 'object' && (v as { url?: unknown }).url === null) {
              if (hasMigratedSchemaV3 && !this.cache.has(nk)) {
                const cachedAt = Number((v as { cachedAt?: unknown }).cachedAt || 0);
                if (cachedAt > 0 && Date.now() - cachedAt < NEGATIVE_COVER_TTL_MS) {
                  this.setCoverCacheBounded(nk, null);
                  this.negativeTimestamps.set(nk, cachedAt);
                }
              } else {
                needsSaveAfterMigration = true;
              }
            }
          }
        }
      }

      // 3. Load GOG boxArt cache (purging outage negatives once on schema v3 migration)
      const rawGog = localStorage.getItem(STORAGE_KEY_GOG_BOXART);
      if (rawGog) {
        const parsedGog: unknown = JSON.parse(rawGog);
        if (parsedGog && typeof parsedGog === 'object' && !Array.isArray(parsedGog)) {
          for (const [k, v] of Object.entries(parsedGog as Record<string, unknown>)) {
            if (typeof v === 'string' && v.trim() && !isUnsuitableCoverUrl(v)) {
              this.setGogCacheBounded(k, v);
            } else if (v && typeof v === 'object' && (v as { url?: unknown }).url === null) {
              if (hasMigratedSchemaV3) {
                const cachedAt = Number((v as { cachedAt?: unknown }).cachedAt || 0);
                if (cachedAt > 0 && Date.now() - cachedAt < NEGATIVE_COVER_TTL_MS) {
                  this.setGogCacheBounded(k, null);
                  this.gogNegativeTimestamps.set(k, cachedAt);
                }
              } else {
                needsSaveAfterMigration = true;
              }
            }
          }
        }
      }

      if (!hasMigratedSchemaV3) {
        localStorage.setItem(STORAGE_KEY_COVER_SCHEMA_MIGRATION, '1');
        if (needsSaveAfterMigration) {
          this.savePersistentCache();
        }
      }

      const rawDeadCounts = localStorage.getItem(STORAGE_KEY_DEAD_STEAM_COVER_COUNTS);
      let parsedCounts: Record<string, number> = {};
      if (rawDeadCounts) {
        try {
          const obj: unknown = JSON.parse(rawDeadCounts);
          if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
            parsedCounts = obj as Record<string, number>;
          }
        } catch {}
      }

      const rawDeadSteam = localStorage.getItem(STORAGE_KEY_DEAD_STEAM_COVERS);
      if (rawDeadSteam) {
        const parsedDead: unknown = JSON.parse(rawDeadSteam);
        if (parsedDead && typeof parsedDead === 'object' && !Array.isArray(parsedDead)) {
          for (const [idStr, ts] of Object.entries(parsedDead as Record<string, unknown>)) {
            const appId = Number(idStr);
            let tsNum = 0;
            let countNum: number | undefined = undefined;
            if (typeof ts === 'number') {
              tsNum = ts;
              if (typeof parsedCounts[idStr] === 'number' && parsedCounts[idStr] > 0) {
                countNum = parsedCounts[idStr];
              }
            } else if (ts && typeof ts === 'object') {
              const deadObj = ts as { cachedAt?: unknown; failureCount?: unknown };
              tsNum = Number(deadObj.cachedAt || 0);
              if (typeof deadObj.failureCount === 'number' && deadObj.failureCount > 0) {
                countNum = deadObj.failureCount;
              }
            }
            const ttlMs =
              countNum !== undefined
                ? computeAdaptive404RetryDelayMs(countNum)
                : DEAD_STEAM_COVER_TTL_MS;
            if (appId > 0 && tsNum > 0 && Date.now() - tsNum < ttlMs) {
              KNOWN_DEAD_STEAM_COVER_APP_IDS.add(appId);
              this.deadSteamTimestamps.set(appId, tsNum);
              if (countNum !== undefined) {
                this.deadSteamFailureCounts.set(appId, countNum);
              }
            }
          }
        }
      }
    } catch {
      // Ignore storage read error
    }
  }

  private async hydratePersistentCacheFromVault(): Promise<void> {
    if (typeof window === 'undefined') return;
    const gen = this.cacheGeneration;
    try {
      const [vaultCovers, vaultGog] = await Promise.all([
        vaultGet<Record<string, unknown>>(STORAGE_KEY_IGDB_COVERS),
        vaultGet<Record<string, unknown>>(STORAGE_KEY_GOG_BOXART),
      ]);
      if (gen !== this.cacheGeneration) return;

      if (vaultCovers && typeof vaultCovers === 'object' && !Array.isArray(vaultCovers)) {
        for (const [k, v] of Object.entries(vaultCovers)) {
          const nk = normalizeCacheKey(k);
          const existing = this.cache.get(nk);
          if (typeof existing === 'string' && existing) continue;
          if (typeof v === 'string' && v.trim() && !isUnsuitableCoverUrl(v)) {
            this.setCoverCacheBounded(nk, v);
            this.negativeTimestamps.delete(nk);
          } else if (v && typeof v === 'object' && (v as { url?: unknown }).url === null) {
            const cachedAt = Number((v as { cachedAt?: unknown }).cachedAt || 0);
            const existingNegTs = this.negativeTimestamps.get(nk) || 0;
            if (
              cachedAt > existingNegTs &&
              Date.now() - cachedAt < NEGATIVE_COVER_TTL_MS
            ) {
              this.setCoverCacheBounded(nk, null);
              this.negativeTimestamps.set(nk, cachedAt);
            }
          }
        }
      }

      if (vaultGog && typeof vaultGog === 'object' && !Array.isArray(vaultGog)) {
        for (const [k, v] of Object.entries(vaultGog)) {
          const existing = this.gogBoxArtCache.get(k);
          if (typeof existing === 'string' && existing) continue;
          if (typeof v === 'string' && v.trim() && !isUnsuitableCoverUrl(v)) {
            this.setGogCacheBounded(k, v);
            this.gogNegativeTimestamps.delete(k);
          } else if (v && typeof v === 'object' && (v as { url?: unknown }).url === null) {
            const cachedAt = Number((v as { cachedAt?: unknown }).cachedAt || 0);
            const existingNegTs = this.gogNegativeTimestamps.get(k) || 0;
            if (
              cachedAt > existingNegTs &&
              Date.now() - cachedAt < NEGATIVE_COVER_TTL_MS
            ) {
              this.setGogCacheBounded(k, null);
              this.gogNegativeTimestamps.set(k, cachedAt);
            }
          }
        }
      }
    } catch {
      // Ignore vault read errors
    }
  }

  private savePersistentCache() {
    const obj: Record<string, string | PersistedNegativeCoverRecord> = {};
    for (const [k, v] of this.cache.entries()) {
      if (typeof v === 'string' && v) {
        obj[k] = v;
      } else if (v === null) {
        obj[k] = { url: null, cachedAt: this.negativeTimestamps.get(k) || Date.now() };
      }
    }
    const gogObj: Record<string, string | PersistedNegativeCoverRecord> = {};
    for (const [k, v] of this.gogBoxArtCache.entries()) {
      if (typeof v === 'string' && v) {
        gogObj[k] = v;
      } else if (v === null) {
        gogObj[k] = { url: null, cachedAt: this.gogNegativeTimestamps.get(k) || Date.now() };
      }
    }
    void vaultSet(STORAGE_KEY_IGDB_COVERS, obj);
    void vaultSet(STORAGE_KEY_GOG_BOXART, gogObj);
    if (typeof localStorage === 'undefined') return;
    try {
      localStorage.setItem(STORAGE_KEY_IGDB_COVERS, JSON.stringify(obj));
      localStorage.setItem(STORAGE_KEY_GOG_BOXART, JSON.stringify(gogObj));
    } catch {
      // Ignore storage write error; IndexedDB vault retains full cache
    }
  }

  /**
   * Checks whether a GOG vertical cover lookup has already been attempted (positively or negatively within TTL).
   */
  public hasAttemptedGogVerticalCover(gogId?: string | number | null, title?: string): boolean {
    this.ensureInitialized();
    const cleanId = String(gogId || '').replace(/^gog-/, '').trim();
    if (cleanId && this.gogBoxArtCache.has(`id:${cleanId}`)) {
      const val = this.gogBoxArtCache.get(`id:${cleanId}`);
      if (typeof val === 'string' && val) return true;
      const ts = this.gogNegativeTimestamps.get(`id:${cleanId}`);
      if (!ts || Date.now() - ts < NEGATIVE_COVER_TTL_MS) return true;
      this.gogBoxArtCache.delete(`id:${cleanId}`);
      this.gogNegativeTimestamps.delete(`id:${cleanId}`);
    }
    if (title && title.trim()) {
      const norm = normalizeKey(title);
      if (this.gogBoxArtCache.has(`title:${norm}`) && typeof this.gogBoxArtCache.get(`title:${norm}`) === 'string') {
        return true;
      }
    }
    return false;
  }

  /**
   * Instant synchronous lookup for GOG's official 2:3 vertical boxArtImage (`_links.boxArtImage.href`).
   */
  getGogVerticalCoverInstant(gogId?: string | number | null, title?: string): string | null {
    this.ensureInitialized();
    if (gogId !== undefined && gogId !== null && gogId !== '') {
      const cleanId = String(gogId).replace(/^gog-/, '').trim();
      if (cleanId && this.gogBoxArtCache.has(`id:${cleanId}`)) {
        return this.gogBoxArtCache.get(`id:${cleanId}`) || null;
      }
    }
    if (title && title.trim()) {
      const norm = normalizeKey(title);
      if (this.gogBoxArtCache.has(`title:${norm}`)) {
        return this.gogBoxArtCache.get(`title:${norm}`) || null;
      }
    }
    return null;
  }

  /**
   * Resolves GOG's true 2:3 vertical portrait cover (`_links.boxArtImage.href`) from GOG's v2 games API.
   * Unlike the `_glx_vertical_cover` formatter on `p.image` (which server-crops a 16:9 horizontal banner),
   * `boxArtImage` is GOG's dedicated vertical portrait artwork hash.
   */
  async fetchGogVerticalCover(
    gogId: string | number,
    title?: string,
    priority: number = Priority.P1_VIEWPORT
  ): Promise<string | null> {
    const cleanId = String(gogId || '').replace(/^gog-/, '').trim();
    if (!cleanId || !/^\d+$/.test(cleanId)) return null;

    if (this.hasAttemptedGogVerticalCover(cleanId, title)) {
      return this.getGogVerticalCoverInstant(cleanId, title);
    }

    if (!onlineLifecycleManager.isOnline()) {
      return this.getGogVerticalCoverInstant(cleanId, title);
    }

    const cacheKey = `gog-boxart:${cleanId}`;
    if (this.pendingFetches.has(cacheKey)) {
      return this.pendingFetches.get(cacheKey)!;
    }

    const executeGogLookup = async (): Promise<string | null> => {
      let receivedDefinitiveResponse = false;
      try {
        const url =
          typeof window !== 'undefined' && window.location.hostname === 'localhost'
            ? `/api/gog-product/v2/games/${encodeURIComponent(cleanId)}`
            : `https://api.gog.com/v2/games/${encodeURIComponent(cleanId)}`;

        const res = await requestScheduler.schedule(
          url,
          () =>
            fetch(url, {
              headers: { Accept: 'application/json' },
              signal:
                typeof AbortSignal !== 'undefined' && 'timeout' in AbortSignal
                  ? AbortSignal.timeout(4500)
                  : undefined,
            }),
          priority,
          'catalog.gog.com'
        );

        if (res && res.ok && !isWafOrChallengeResponse(res.status, '')) {
          receivedDefinitiveResponse = true;
          const data: unknown = await res.json();
          const boxArt = (
            data as { _links?: { boxArtImage?: { href?: unknown } } } | null | undefined
          )?._links?.boxArtImage?.href;
          if (boxArt && typeof boxArt === 'string' && !isUnsuitableCoverUrl(boxArt)) {
            const normalizedUrl = boxArt.startsWith('//') ? `https:${boxArt}` : boxArt;
            this.setGogCacheBounded(`id:${cleanId}`, normalizedUrl);
            if (title && title.trim()) {
              this.setGogCacheBounded(`title:${normalizeKey(title)}`, normalizedUrl);
            }
            this.savePersistentCache();
            if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
              window.dispatchEvent(
                new CustomEvent('antigravity:gog-cover-updated', {
                  detail: { gogId: cleanId, title, coverUrl: normalizedUrl },
                })
              );
            }
            return normalizedUrl;
          }
        } else if (res && res.status === 404 && !isWafOrChallengeResponse(res.status, '')) {
          receivedDefinitiveResponse = true;
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err || '');
        console.warn('[IgdbCoverService] GOG v2 boxArtImage fetch error:', cleanId, msg);
      }

      if (receivedDefinitiveResponse && onlineLifecycleManager.isOnline()) {
        const now = Date.now();
        this.setGogCacheBounded(`id:${cleanId}`, null);
        this.gogNegativeTimestamps.set(`id:${cleanId}`, now);
        this.savePersistentCache();
      }
      return null;
    };

    const p = executeGogLookup();
    this.pendingFetches.set(cacheKey, p);
    try {
      return await p;
    } finally {
      this.pendingFetches.delete(cacheKey);
    }
  }

  private resolveCacheKeys(
    title: string,
    releaseYear?: number | string | null
  ): { cleanRaw: string; norm: string; effectiveReleaseYear: number | null; cacheKey: string } {
    const cleanRaw = title.trim();
    const norm = normalizeKey(cleanRaw);

    const parsedParamYear =
      releaseYear !== undefined && releaseYear !== null && releaseYear !== ''
        ? Number(String(releaseYear).match(/\b(19\d{2}|20\d{2})\b/)?.[1] ?? releaseYear)
        : NaN;
    const titleYearMatch = cleanRaw.match(/\b(19\d{2}|20[0-2]\d)\b/);
    const effectiveReleaseYear =
      !Number.isNaN(parsedParamYear) && parsedParamYear > 0
        ? parsedParamYear
        : titleYearMatch
          ? Number(titleYearMatch[1])
          : null;

    const cacheKey = effectiveReleaseYear ? `${norm}:${effectiveReleaseYear}` : norm;
    return { cleanRaw, norm, effectiveReleaseYear, cacheKey };
  }

  /**
   * Checks whether an IGDB cover lookup for (title, releaseYear) has already been attempted
   * (either resolved positively or cached negatively within TTL).
   */
  public hasAttemptedIgdbCover(title?: string, releaseYear?: number | string | null): boolean {
    if (!title || !title.trim()) return true;
    this.ensureInitialized();
    const { cleanRaw, norm, effectiveReleaseYear, cacheKey } = this.resolveCacheKeys(title, releaseYear);
    const lower = cleanRaw.toLowerCase();

    const curated =
      NORMALIZED_KNOWN_IGDB_COVERS.get(lower) ||
      NORMALIZED_KNOWN_IGDB_COVERS.get(norm) ||
      KNOWN_IGDB_COVERS[lower] ||
      KNOWN_IGDB_COVERS[norm];
    if (curated) return true;

    if (this.cache.has(cacheKey)) {
      const val = this.cache.get(cacheKey);
      if (typeof val === 'string' && val) return true;
      const ts = this.negativeTimestamps.get(cacheKey);
      if (!ts || Date.now() - ts < NEGATIVE_COVER_TTL_MS) return true;
      this.cache.delete(cacheKey);
      this.negativeTimestamps.delete(cacheKey);
    }

    if (!effectiveReleaseYear) {
      if (this.getIgdbCoverInstant(cleanRaw)) return true;
      if (this.cache.has(norm)) {
        const val = this.cache.get(norm);
        if (typeof val === 'string' && val) return true;
        const ts = this.negativeTimestamps.get(norm);
        if (!ts || Date.now() - ts < NEGATIVE_COVER_TTL_MS) return true;
        this.cache.delete(norm);
        this.negativeTimestamps.delete(norm);
      }
    }

    return false;
  }

  /**
   * Fast synchronous lookup against curated mappings and local storage cache.
   * Returns instant image URL or null.
   */
  getIgdbCoverInstant(title?: string, steamAppId?: number, gameId?: string): string | null {
    if (!title && !steamAppId && !gameId) return null;
    this.ensureInitialized();

    if (title) {
      const cleanRaw = title.trim();
      const lower = cleanRaw.toLowerCase();
      const norm = normalizeKey(cleanRaw);

      // 1. Curated official covers take precedence over dynamic / local cache
      const match =
        NORMALIZED_KNOWN_IGDB_COVERS.get(lower) ||
        NORMALIZED_KNOWN_IGDB_COVERS.get(norm) ||
        KNOWN_IGDB_COVERS[lower] ||
        KNOWN_IGDB_COVERS[norm];

      if (match) {
        return match;
      }

      // 2. Dynamic cache
      if (this.cache.has(norm)) {
        return this.cache.get(norm) || null;
      }
      if (this.cache.has(lower)) {
        return this.cache.get(lower) || null;
      }
    }

    if (gameId) {
      const cleanId = gameId.trim();
      const lowerId = cleanId.toLowerCase();
      const normId = normalizeKey(cleanId);

      // 1. Curated official covers take precedence over dynamic / local cache
      const match =
        NORMALIZED_KNOWN_IGDB_COVERS.get(lowerId) ||
        NORMALIZED_KNOWN_IGDB_COVERS.get(normId) ||
        KNOWN_IGDB_COVERS[lowerId] ||
        KNOWN_IGDB_COVERS[normId];

      if (match) {
        return match;
      }

      // 2. Dynamic cache
      if (this.cache.has(normId)) {
        return this.cache.get(normId) || null;
      }
      if (this.cache.has(lowerId)) {
        return this.cache.get(lowerId) || null;
      }
    }

    return null;
  }

  /**
   * Asynchronous dynamic lookup against IGDB/Lutris metadata.
   * Caches results persistently and dispatches an update event for reactive UI re-renders.
   */
  async fetchIgdbCover(
    title: string,
    releaseYear?: number | string | null,
    priority: number = Priority.P2_BACKGROUND,
    options?: { trackInGlobalBar?: boolean }
  ): Promise<string | null> {
    if (!title || !title.trim()) return null;
    this.ensureInitialized();
    const { cleanRaw, norm, effectiveReleaseYear, cacheKey } = this.resolveCacheKeys(title, releaseYear);
    const schedulerGameKey = `cover:${cacheKey}`;

    // Short-circuit both positive and valid negative cache hits before scheduling or tracking any task
    if (this.hasAttemptedIgdbCover(cleanRaw, releaseYear)) {
      const lower = cleanRaw.toLowerCase();
      const curated =
        NORMALIZED_KNOWN_IGDB_COVERS.get(lower) ||
        NORMALIZED_KNOWN_IGDB_COVERS.get(norm) ||
        KNOWN_IGDB_COVERS[lower] ||
        KNOWN_IGDB_COVERS[norm];
      if (curated) return curated;
      if (this.cache.has(cacheKey)) {
        return this.cache.get(cacheKey) ?? null;
      }
      if (!effectiveReleaseYear) {
        return this.getIgdbCoverInstant(cleanRaw);
      }
      return null;
    }

    if (!onlineLifecycleManager.isOnline()) {
      return this.getIgdbCoverInstant(cleanRaw);
    }

    // Deduplicate in-flight requests
    if (this.pendingFetches.has(cacheKey)) {
      if (priority === Priority.P0_INTERACTIVE) {
        requestScheduler.promoteToInteractive(schedulerGameKey);
      }
      return this.pendingFetches.get(cacheKey)!;
    }

    const executeLookup = async (): Promise<string | null> => {
      let receivedOkResponse = false;
      // Query search endpoint via Vite proxy or direct HTTPS with full sequel, compatibility, and releaseYear verification
      try {
        const query = cleanRaw
          .replace(/[™®©]/g, '')
          .replace(/[:\-–—]/g, ' ')
          .replace(/\s+/g, ' ')
          .trim();
        const searchUrl =
          typeof window !== 'undefined' && window.location.hostname === 'localhost'
            ? `/api/lutris/api/games?search=${encodeURIComponent(query)}`
            : `https://lutris.net/api/games?search=${encodeURIComponent(query)}`;

        const res = await requestScheduler.schedule(
          searchUrl,
          () =>
            fetch(searchUrl, {
              headers: {
                'User-Agent':
                  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                Accept: 'application/json, text/plain, */*',
              },
              signal:
                typeof AbortSignal !== 'undefined' && 'timeout' in AbortSignal
                  ? AbortSignal.timeout(4500)
                  : undefined,
            }),
          priority,
          'lutris.net',
          schedulerGameKey
        );

        if (res && res.ok && !isWafOrChallengeResponse(res.status, '')) {
          receivedOkResponse = true;
          const data: unknown = await res.json();
          const rawResults =
            data && typeof data === 'object' && Array.isArray((data as { results?: unknown }).results)
              ? ((data as { results: unknown[] }).results as LutrisSearchItem[])
              : [];
          const items: LutrisSearchItem[] = rawResults;
          if (items.length > 0) {
            let bestCover: string | null = null;
            let bestScore = -1;

            const hasCloseYearAlternative =
              effectiveReleaseYear !== null &&
              items.some((cand: LutrisSearchItem) => {
                if (!cand?.coverart) return false;
                const cName = cand.name || '';
                const cNumberedSubMatch = isNumberedBaseTitleSubtitleMatch(cleanRaw, cName);
                if (
                  !cNumberedSubMatch &&
                  (isSequelMismatch(cleanRaw, cName) || !isTitleCompatible(cleanRaw, cName))
                ) {
                  return false;
                }
                const cYear =
                  cand.year !== undefined && cand.year !== null && cand.year !== ''
                    ? Number(cand.year)
                    : null;
                return (
                  cYear !== null &&
                  !Number.isNaN(cYear) &&
                  Math.abs(effectiveReleaseYear - cYear) <= 2
                );
              });

            for (const item of items) {
              if (!item.coverart) continue;
              const itemName = item.name || '';
              const numberedSubMatch = isNumberedBaseTitleSubtitleMatch(cleanRaw, itemName);
              if (
                !numberedSubMatch &&
                (isSequelMismatch(cleanRaw, itemName) || !isTitleCompatible(cleanRaw, itemName))
              ) {
                continue;
              }

              const candNorm = normalizeKey(itemName);
              let score = numberedSubMatch
                ? 92
                : computeTokenSimilarity(cleanRaw, itemName) * 100;

              const itemYear =
                item.year !== undefined && item.year !== null && item.year !== ''
                  ? Number(item.year)
                  : null;
              const isNewerReboot =
                effectiveReleaseYear !== null &&
                itemYear !== null &&
                !Number.isNaN(itemYear) &&
                itemYear - effectiveReleaseYear >= 4;
              const isOlderOverriddenByCloseYear =
                effectiveReleaseYear !== null &&
                itemYear !== null &&
                !Number.isNaN(itemYear) &&
                effectiveReleaseYear - itemYear >= 4 &&
                hasCloseYearAlternative;
              const hasEraMismatch = isNewerReboot || isOlderOverriddenByCloseYear;

              if (candNorm === norm && !hasEraMismatch) {
                score += 50;
              }

              if (effectiveReleaseYear !== null && itemYear !== null && !Number.isNaN(itemYear)) {
                const yearDiff = Math.abs(effectiveReleaseYear - itemYear);
                if (yearDiff <= 1) {
                  score += 15;
                } else if (hasEraMismatch) {
                  score -= 35;
                }
              }

              if (score > bestScore && score >= 65) {
                bestScore = score;
                const m = item.coverart.match(/\/([a-zA-Z0-9_-]+)\.(?:jpg|png|webp)/i);
                if (m && !m[1].startsWith('banner_') && !m[1].startsWith('library_capsule') && !m[1].startsWith('header_')) {
                  bestCover = `https://images.igdb.com/igdb/image/upload/t_cover_big/${m[1]}.jpg`;
                } else if (item.coverart.startsWith('http') && !isUnsuitableCoverUrl(item.coverart)) {
                  bestCover = item.coverart;
                }
              }
            }

            if (bestCover) {
              this.setCoverCacheBounded(cacheKey, bestCover);
              this.setCoverCacheBounded(norm, bestCover);
              this.savePersistentCache();
              this.notifyCoverUpdated(cleanRaw, bestCover);
              return bestCover;
            }
          }
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn('Dynamic IGDB cover fetch error for', cleanRaw, msg);
      }

      // Only mark negative cache when the API actually responded cleanly (not on network/5xx errors)
      if (receivedOkResponse && onlineLifecycleManager.isOnline()) {
        const now = Date.now();
        this.setCoverCacheBounded(cacheKey, null);
        this.negativeTimestamps.set(cacheKey, now);
        if (!effectiveReleaseYear) {
          this.setCoverCacheBounded(norm, null);
          this.negativeTimestamps.set(norm, now);
        }
        this.savePersistentCache();
      }
      return null;
    };

    const fetchPromise =
      options?.trackInGlobalBar === true && priority !== Priority.P0_INTERACTIVE
        ? syncJobManager.trackTask('cover_art', cleanRaw, executeLookup)
        : executeLookup();

    this.pendingFetches.set(cacheKey, fetchPromise);
    try {
      const res = await fetchPromise;
      return res;
    } finally {
      this.pendingFetches.delete(cacheKey);
    }
  }

  private notifyCoverUpdated(title: string, coverUrl: string) {
    if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
      window.dispatchEvent(
        new CustomEvent('antigravity:igdb-cover-updated', {
          detail: { title, coverUrl },
        })
      );
    }
  }
}

export const igdbCoverService = new IgdbCoverService();
