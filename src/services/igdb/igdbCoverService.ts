/**
 * IGDB Cover Art Service
 * Provides instantaneous resolution and dynamic fallback to high-resolution
 * portrait covers hosted on images.igdb.com.
 */

import { isSequelMismatch, normalizeTitleKey, EDITION_TOKENS } from '../common/titleUtils';
import { requestScheduler, Priority } from '../network/requestScheduler';
import { syncJobManager } from '../network/syncJobManager';
import { isTitleCompatible } from '../critic/metacriticResolver';

const STORAGE_KEY_IGDB_COVERS = 'antigravity_igdb_covers_v2';
const STORAGE_KEY_GOG_BOXART = 'antigravity_gog_boxart_v1';

// Steam App IDs verified to not host standard unhashed library_600x900 assets on Steam CDN
export const KNOWN_DEAD_STEAM_COVER_APP_IDS = new Set<number>();

export function isKnownDeadSteamCover(appId?: number | null): boolean {
  if (!appId) return false;
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
  if (!lower.includes('gog-statics.com')) return false;
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
    lower.includes('co8j9u') ||
    lower.includes('wide') ||
    lower.includes('landscape')
  ) {
    return true;
  }

  // 2. Dead Steam App IDs returning 404
  for (const deadId of KNOWN_DEAD_STEAM_COVER_APP_IDS) {
    if (lower.includes(`apps/${deadId}/library_600x900`)) return true;
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
]);

export function computeTokenSimilarity(t1: string, t2: string): number {
  if (isSequelMismatch(t1, t2)) return 0;
  if (!isTitleCompatible(t1, t2)) return 0;

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

export class IgdbCoverService {
  private cache = new Map<string, string | null>();
  private gogBoxArtCache = new Map<string, string | null>();
  private pendingFetches = new Map<string, Promise<string | null>>();

  constructor() {
    this.loadPersistentCache();
  }

  public clearCache(): void {
    this.cache.clear();
    this.gogBoxArtCache.clear();
    this.pendingFetches.clear();
  }

  private loadPersistentCache() {
    if (typeof window === 'undefined') return;
    try {
      const raw = localStorage.getItem(STORAGE_KEY_IGDB_COVERS);
      if (raw) {
        const parsed = JSON.parse(raw);
        for (const [k, v] of Object.entries(parsed)) {
          if (typeof v === 'string') {
            this.cache.set(normalizeKey(k), v);
          }
        }
      }
      const rawGog = localStorage.getItem(STORAGE_KEY_GOG_BOXART);
      if (rawGog) {
        const parsedGog = JSON.parse(rawGog);
        for (const [k, v] of Object.entries(parsedGog)) {
          if (typeof v === 'string') {
            this.gogBoxArtCache.set(k, v);
          }
        }
      }
    } catch {
      // Ignore storage read error
    }
  }

  private savePersistentCache() {
    if (typeof window === 'undefined') return;
    try {
      const obj: Record<string, string> = {};
      for (const [k, v] of this.cache.entries()) {
        if (v) obj[k] = v;
      }
      localStorage.setItem(STORAGE_KEY_IGDB_COVERS, JSON.stringify(obj));

      const gogObj: Record<string, string> = {};
      for (const [k, v] of this.gogBoxArtCache.entries()) {
        if (v) gogObj[k] = v;
      }
      localStorage.setItem(STORAGE_KEY_GOG_BOXART, JSON.stringify(gogObj));
    } catch {
      // Ignore storage write error
    }
  }

  /**
   * Instant synchronous lookup for GOG's official 2:3 vertical boxArtImage (`_links.boxArtImage.href`).
   */
  getGogVerticalCoverInstant(gogId?: string | number | null, title?: string): string | null {
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

    const cacheKey = `gog-boxart:${cleanId}`;
    if (this.gogBoxArtCache.has(`id:${cleanId}`)) {
      return this.gogBoxArtCache.get(`id:${cleanId}`) || null;
    }

    if (this.pendingFetches.has(cacheKey)) {
      return this.pendingFetches.get(cacheKey)!;
    }

    const executeGogLookup = async (): Promise<string | null> => {
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

        if (res && res.ok) {
          const data = await res.json();
          const boxArt = data?._links?.boxArtImage?.href;
          if (boxArt && typeof boxArt === 'string' && !isUnsuitableCoverUrl(boxArt)) {
            const normalizedUrl = boxArt.startsWith('//') ? `https:${boxArt}` : boxArt;
            this.gogBoxArtCache.set(`id:${cleanId}`, normalizedUrl);
            if (title && title.trim()) {
              this.gogBoxArtCache.set(`title:${normalizeKey(title)}`, normalizedUrl);
            }
            this.savePersistentCache();
            if (typeof window !== 'undefined') {
              window.dispatchEvent(
                new CustomEvent('antigravity:gog-cover-updated', {
                  detail: { gogId: cleanId, title, coverUrl: normalizedUrl },
                })
              );
            }
            return normalizedUrl;
          }
        }
      } catch (err: any) {
        console.warn('[IgdbCoverService] GOG v2 boxArtImage fetch error:', cleanId, err?.message);
      }

      this.gogBoxArtCache.set(`id:${cleanId}`, null);
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

  /**
   * Fast synchronous lookup against curated mappings and local storage cache.
   * Returns instant image URL or null.
   */
  getIgdbCoverInstant(title?: string, steamAppId?: number, gameId?: string): string | null {
    if (!title && !steamAppId && !gameId) return null;

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
    priority: number = Priority.P2_BACKGROUND
  ): Promise<string | null> {
    if (!title || !title.trim()) return null;
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

    // Check instant cache (curated always applies; dynamic cache keyed by cacheKey when year is specified)
    if (!effectiveReleaseYear) {
      const instant = this.getIgdbCoverInstant(cleanRaw);
      if (instant) return instant;
    } else {
      const lower = cleanRaw.toLowerCase();
      const curated =
        NORMALIZED_KNOWN_IGDB_COVERS.get(lower) ||
        NORMALIZED_KNOWN_IGDB_COVERS.get(norm) ||
        KNOWN_IGDB_COVERS[lower] ||
        KNOWN_IGDB_COVERS[norm];
      if (curated) return curated;
      if (this.cache.has(cacheKey)) {
        return this.cache.get(cacheKey) || null;
      }
    }

    // Deduplicate in-flight requests
    if (this.pendingFetches.has(cacheKey)) {
      if (priority === Priority.P0_INTERACTIVE) {
        requestScheduler.promoteToInteractive('lutris.net');
      }
      return this.pendingFetches.get(cacheKey)!;
    }

    const executeLookup = async (): Promise<string | null> => {
      // Query search endpoint via Vite proxy or direct HTTPS with full sequel, compatibility, and releaseYear verification
      try {
        const query = cleanRaw.replace(/[:\-–—]/g, ' ').replace(/\s+/g, ' ').trim();
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
          'lutris.net'
        );

        if (res.ok) {
          const data = await res.json();
          const items: any[] = data.results || [];
          if (items.length > 0) {
            let bestCover: string | null = null;
            let bestScore = -1;

            for (const item of items) {
              if (!item.coverart) continue;
              const itemName = item.name || '';
              if (isSequelMismatch(cleanRaw, itemName) || !isTitleCompatible(cleanRaw, itemName)) {
                continue;
              }

              const candNorm = normalizeKey(itemName);
              let score = computeTokenSimilarity(norm, candNorm) * 100;

              const itemYear =
                item.year !== undefined && item.year !== null && item.year !== ''
                  ? Number(item.year)
                  : null;
              const hasEraMismatch =
                effectiveReleaseYear !== null &&
                itemYear !== null &&
                !Number.isNaN(itemYear) &&
                Math.abs(effectiveReleaseYear - itemYear) >= 4;

              if (candNorm === norm && !hasEraMismatch) {
                score += 50;
              }

              if (effectiveReleaseYear !== null && itemYear !== null && !Number.isNaN(itemYear)) {
                const yearDiff = Math.abs(effectiveReleaseYear - itemYear);
                if (yearDiff <= 1) {
                  score += 15;
                } else if (yearDiff >= 4) {
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
              this.cache.set(cacheKey, bestCover);
              this.cache.set(norm, bestCover);
              this.savePersistentCache();
              this.notifyCoverUpdated(cleanRaw, bestCover);
              return bestCover;
            }
          }
        }
      } catch (err: any) {
        console.warn('Dynamic IGDB cover fetch error for', cleanRaw, err?.message);
      }

      // Mark negative cache to avoid infinite retries
      this.cache.set(cacheKey, null);
      if (!effectiveReleaseYear) {
        this.cache.set(norm, null);
      }
      return null;
    };

    const fetchPromise =
      priority === Priority.P0_INTERACTIVE
        ? executeLookup()
        : syncJobManager.trackTask('cover_art', cleanRaw, executeLookup);

    this.pendingFetches.set(cacheKey, fetchPromise);
    try {
      const res = await fetchPromise;
      return res;
    } finally {
      this.pendingFetches.delete(cacheKey);
    }
  }

  private notifyCoverUpdated(title: string, coverUrl: string) {
    if (typeof window !== 'undefined') {
      window.dispatchEvent(
        new CustomEvent('antigravity:igdb-cover-updated', {
          detail: { title, coverUrl },
        })
      );
    }
  }
}

export const igdbCoverService = new IgdbCoverService();
