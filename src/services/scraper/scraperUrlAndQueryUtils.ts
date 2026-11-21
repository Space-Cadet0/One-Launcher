import { CanonicalGame } from '../../contracts/game';
import { SteamEnrichedMetadata } from '../../contracts/steam';
import { SearchMatchCandidate, ScrapedCoverOption } from '../../contracts/override';
import { withTimeoutFallback } from '../../utils/asyncUtils';
import { isXboxStoreUrl } from '../common/storeUrlUtils';
import {
  isGogCroppedHorizontalCover,
  isKnownDeadSteamCover,
  isUnsuitableCoverUrl,
} from '../igdb/igdbCoverService';
import { KNOWN_EPIC_APP_NAMES, EpicCodenameMapping } from '../integrations/epicCodenames';
import { Priority } from '../network/requestScheduler';
import { stripHtmlToPlainSynopsis } from '../steam/fallbackMetadataProvider';
import { steamApi, SteamStoreBrowseAssets } from '../steam/steamApi';
import { canonicalizeTitleKey } from '../steam/steamMatcher';
import gogEnrichedCache from '../storage/gogEnrichedCache.json';
import steamEnrichedCache from '../storage/steamEnrichedCache.json';

export interface GogEnrichedEntry {
  title?: string;
  slug?: string;
  releaseDate?: string;
  coverVertical?: string;
  coverHorizontal?: string;
  shortDescription?: string;
  aboutTheGame?: string;
  developers?: string[];
  publishers?: string[];
  genres?: string[];
  tags?: string[];
}

export interface SteamEnrichedEntry {
  name?: string;
}

export interface SteamStoreSearchItem {
  id?: number;
  name?: string;
}

export interface LutrisGameSearchItem {
  id?: number | string;
  slug?: string;
  name?: string;
  year?: string | number;
  coverart?: string;
  description?: string;
}

export interface XboxProductSearchRecord {
  xboxProductId?: string;
  productId?: string;
  title?: string;
  name?: string;
  releaseDate?: string;
  storeUrl?: string;
  capsuleImage?: string;
  posterUrl?: string;
  boxArtUrl?: string;
  headerImage?: string;
  heroUrl?: string;
  shortDescription?: string;
  description?: string;
}

export type StorefrontSearchSource = 'all' | 'steam' | 'igdb' | 'gog' | 'epic' | 'xbox';

export const gogCacheMap = gogEnrichedCache as Record<string, GogEnrichedEntry>;
export const steamCacheMap = steamEnrichedCache as Record<string, SteamEnrichedEntry>;

export function hasGogCacheEntries(): boolean {
  return Object.keys(gogCacheMap).length > 0;
}

export function hasSteamCacheEntries(): boolean {
  return Object.keys(steamCacheMap).length > 0;
}

export function hasKnownEpicAppNames(): boolean {
  return Object.keys(KNOWN_EPIC_APP_NAMES).length > 0;
}

export function lookupKnownEpicApp(
  platformGameId?: string,
  fallbackTitle?: string
): EpicCodenameMapping | undefined {
  if (!hasKnownEpicAppNames()) return undefined;
  if (platformGameId) {
    const exact =
      KNOWN_EPIC_APP_NAMES[platformGameId] ||
      KNOWN_EPIC_APP_NAMES[platformGameId.toLowerCase()];
    if (exact) return exact;
  }
  if (fallbackTitle) {
    return KNOWN_EPIC_APP_NAMES[fallbackTitle.toLowerCase()];
  }
  return undefined;
}

export function getErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function extractXboxStoreProductId(
  meta: Partial<SteamEnrichedMetadata> | null | undefined
): string | undefined {
  if (!meta || typeof meta !== 'object') return undefined;
  const rec = meta as Record<string, unknown>;
  if (typeof rec.xboxProductId === 'string' && rec.xboxProductId.trim()) {
    return rec.xboxProductId.trim();
  }
  if (typeof rec.productId === 'string' && rec.productId.trim()) {
    return rec.productId.trim();
  }
  return undefined;
}

/**
 * Checks whether a candidate or metadata source ID/URL represents an Xbox / Microsoft Store item.
 */
export function isXboxStoreCandidateId(
  id?: string | number | null,
  storeUrl?: string | null
): boolean {
  if (id !== undefined && id !== null && String(id).toLowerCase().startsWith('xbox-')) {
    return true;
  }
  if (storeUrl && isXboxStoreUrl(storeUrl)) {
    return true;
  }
  return false;
}

/**
 * Extracts a canonical 12-character Microsoft Store BigId when present.
 */
export function extractXboxBigId(rawId?: string | number | null): string | undefined {
  if (rawId === undefined || rawId === null) return undefined;
  const cleaned = String(rawId).replace(/^xbox-/i, '').trim();
  if (/^[A-Z0-9]{12}$/i.test(cleaned)) {
    return cleaned.toUpperCase();
  }
  return undefined;
}

/**
 * Builds a direct or search storefront URL for a candidate or metadata source.
 */
export function buildCandidateStoreUrl(params: {
  source: string;
  title: string;
  steamAppId?: number;
  gogId?: string | number;
  epicSlug?: string;
  igdbId?: string | number;
  xboxProductId?: string | number;
}): string {
  const cleanTitle = (params.title || '').trim();
  const src = (params.source || '').toLowerCase();

  const xboxBigId =
    extractXboxBigId(params.xboxProductId) ||
    (String(params.igdbId ?? '').toLowerCase().startsWith('xbox-')
      ? extractXboxBigId(params.igdbId)
      : undefined) ||
    (src === 'xbox'
      ? extractXboxBigId(params.epicSlug || params.gogId || params.igdbId)
      : undefined);

  if (
    src === 'xbox' ||
    xboxBigId ||
    String(params.igdbId ?? '').toLowerCase().startsWith('xbox-')
  ) {
    if (xboxBigId) {
      return `https://www.xbox.com/games/store/-/${xboxBigId}`;
    }
    return `https://www.xbox.com/en-us/search?q=${encodeURIComponent(cleanTitle)}`;
  }

  if (src === 'steam') {
    if (params.steamAppId && Number(params.steamAppId) > 0) {
      return `https://store.steampowered.com/app/${params.steamAppId}`;
    }
    return `https://store.steampowered.com/search/?term=${encodeURIComponent(cleanTitle)}`;
  }

  if (src === 'gog') {
    const gogStr =
      params.gogId !== undefined && params.gogId !== null
        ? String(params.gogId).replace(/^gog-/, '').trim()
        : '';
    if (gogStr && !/^\d+$/.test(gogStr)) {
      return `https://www.gog.com/en/game/${gogStr}`;
    }
    return `https://www.gog.com/en/games?query=${encodeURIComponent(cleanTitle)}`;
  }

  if (src === 'epic') {
    const slug = (params.epicSlug || '').replace(/^epic-/, '').trim();
    if (slug && slug.toLowerCase() !== 'epic' && !/^[0-9a-f]{20,}$/i.test(slug)) {
      return `https://store.epicgames.com/en-US/p/${slug}`;
    }
    return `https://store.epicgames.com/en-US/browse?q=${encodeURIComponent(cleanTitle)}`;
  }

  if (src === 'igdb') {
    const igdbStr =
      params.igdbId !== undefined && params.igdbId !== null
        ? String(params.igdbId).replace(/^igdb-/, '').trim()
        : '';
    if (igdbStr && igdbStr.toLowerCase() !== 'igdb' && !/^\d+$/.test(igdbStr)) {
      return `https://www.igdb.com/games/${igdbStr}`;
    }
    return `https://www.igdb.com/search?type=1&q=${encodeURIComponent(cleanTitle)}`;
  }

  return `https://www.google.com/search?q=${encodeURIComponent(cleanTitle + ' game')}`;
}

/**
 * Cleans a user or game search query by stripping punctuation and trademark noise.
 */
export function cleanSearchQuery(query: string): string {
  if (!query) return '';
  return query
    .replace(/[™®©]/g, '')
    .replace(/['’]/g, '')
    .replace(/[+]/g, ' ')
    .replace(/[:\-–—_]/g, ' ')
    .replace(/[!?,.]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

const NON_GAME_ADDON_REGEX =
  /\b(soundtrack|ost|artbook|art book|demo|playtest|season pass|expansion pass|upgrade pack|cosmetic pack|voice pack|dedicated server|sdk|mod tools|bonus content|digital goodies|wallpaper|playable teaser|tech beta|public testing)\b/i;

/**
 * Universal helper to detect non-game clutter (DLCs, Soundtracks, Demos, Tools, Bonus Content)
 * when the user's query title does not explicitly ask for those terms.
 */
export function isNonGameAddonTitle(candidateTitle: string, queryTitle: string): boolean {
  if (!candidateTitle) return false;
  if (NON_GAME_ADDON_REGEX.test(queryTitle || '')) return false;
  return NON_GAME_ADDON_REGEX.test(candidateTitle);
}

export function getSteamUnhashedPortrait2xUrl(appId: number): string {
  return `https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/${appId}/library_600x900_2x.jpg`;
}

export function getSteamUnhashedCapsuleUrl(appId: number): string {
  return `https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/${appId}/library_capsule.jpg`;
}

export function getSteamHeaderUrl(appId: number): string {
  return `https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/${appId}/header.jpg`;
}

/**
 * Resolves the best Steam portrait cover URL for a candidate or metadata source,
 * preferring verified cached browse assets (SHA1-hashed 2x art) and suppressing
 * unhashed CDN URLs when `isKnownDeadSteamCover(appId)` is true.
 */
export function resolveSteamCandidateCapsuleUrl(
  appId?: number | null,
  browseAssets?: SteamStoreBrowseAssets | null
): string | undefined {
  if (!appId || appId <= 0) return undefined;
  const resolvedBrowse = browseAssets ?? steamApi.peekCachedBrowseAssets(appId);
  if (resolvedBrowse?.capsuleImage && !isUnsuitableCoverUrl(resolvedBrowse.capsuleImage)) {
    return resolvedBrowse.capsuleImage;
  }
  if (!isKnownDeadSteamCover(appId)) {
    return getSteamUnhashedPortrait2xUrl(appId);
  }
  return undefined;
}

/**
 * Assembles Steam portrait cover options for a given `appId`, preferring verified cached/fetched
 * Steam Store Browse assets first and only emitting unhashed `library_600x900_2x.jpg` /
 * `library_capsule.jpg` fallbacks when `!isKnownDeadSteamCover(appId)`.
 */
export function buildSteamCoverOptions(
  appId?: number | null,
  options?: {
    browseAssets?: SteamStoreBrowseAssets | null;
    labelTitle?: string;
  }
): ScrapedCoverOption[] {
  if (!appId || appId <= 0) return [];
  const covers: ScrapedCoverOption[] = [];
  const resolvedBrowse = options?.browseAssets ?? steamApi.peekCachedBrowseAssets(appId);
  const titleSuffix = options?.labelTitle ? ` — ${options.labelTitle}` : '';

  if (resolvedBrowse?.capsuleImage && !isUnsuitableCoverUrl(resolvedBrowse.capsuleImage)) {
    covers.push({
      url: resolvedBrowse.capsuleImage,
      source: 'steam',
      label: titleSuffix
        ? `Steam Official Cover${titleSuffix}`
        : 'Steam Official Cover (2x High-Res)',
      dimensions: '600x900',
    });
  }

  if (!isKnownDeadSteamCover(appId)) {
    const portrait2xUrl = getSteamUnhashedPortrait2xUrl(appId);
    if (resolvedBrowse?.capsuleImage !== portrait2xUrl) {
      covers.push({
        url: portrait2xUrl,
        source: 'steam',
        label: titleSuffix ? `Steam Portrait${titleSuffix}` : 'Steam Portrait (600x900)',
        dimensions: '600x900',
      });
    }
    const capsuleUrl = getSteamUnhashedCapsuleUrl(appId);
    if (resolvedBrowse?.capsuleImage !== capsuleUrl) {
      covers.push({
        url: capsuleUrl,
        source: 'steam',
        label: titleSuffix ? `Steam Capsule${titleSuffix}` : 'Steam Library Capsule',
        dimensions: 'library_capsule',
      });
    }
  }

  return covers;
}

/**
 * Resolves Steam Store Browse assets with an instant cache peek and optional bounded live fetch.
 */
export async function resolveSteamBrowseAssets(
  appId?: number | null,
  options?: {
    allowFetch?: boolean;
    timeoutMs?: number;
  }
): Promise<SteamStoreBrowseAssets | null> {
  if (!appId || appId <= 0) return null;
  const cached = steamApi.peekCachedBrowseAssets(appId);
  if (cached) return cached;
  if (options?.allowFetch === false) return null;
  return withTimeoutFallback(
    steamApi.fetchStoreBrowseAssets(appId, Priority.P0_INTERACTIVE).catch(() => null),
    options?.timeoutMs ?? 2500,
    null
  );
}

/**
 * Deduplicates scraped covers by normalized image URL and filters out unsuitable horizontal/dead
 * covers as well as server-cropped GOG horizontal covers (comparing hashes against `headerUrl`).
 */
export function deduplicateCovers(
  covers: ScrapedCoverOption[],
  headerUrl?: string | null
): ScrapedCoverOption[] {
  const seen = new Set<string>();
  const result: ScrapedCoverOption[] = [];
  for (const c of covers) {
    if (!c.url || !c.url.trim()) continue;
    if (isUnsuitableCoverUrl(c.url)) continue;
    if (isGogCroppedHorizontalCover(c.url, headerUrl)) continue;
    const norm = c.url.trim().toLowerCase().replace(/^https?:\/\//, '');
    if (seen.has(norm)) continue;
    seen.add(norm);
    result.push(c);
  }
  return result;
}

/**
 * Deduplicates descriptions by normalized plain-text content, stripping any residual HTML tags.
 */
export function deduplicateDescriptions(
  descriptions: { source: string; text: string }[]
): { source: string; text: string }[] {
  const seen = new Set<string>();
  const result: { source: string; text: string }[] = [];
  for (const d of descriptions) {
    if (!d.text || !d.text.trim()) continue;
    const plain = stripHtmlToPlainSynopsis(d.text);
    if (!plain) continue;
    const norm = plain.toLowerCase();
    if (seen.has(norm)) continue;
    seen.add(norm);
    result.push({ source: d.source, text: plain });
  }
  return result;
}

/**
 * Resolves the first non-empty release year or date hint to pass to IGDB cover matching.
 */
export function resolveReleaseYearHint(
  ...sources: Array<string | number | null | undefined>
): string | number | undefined {
  for (const raw of sources) {
    if (typeof raw === 'number' && Number.isFinite(raw) && raw > 0) {
      return raw;
    }
    if (typeof raw === 'string' && raw.trim()) {
      return raw.trim();
    }
  }
  return undefined;
}

/**
 * Resolves a GOG counterpart product ID from candidate, originalGame platform, or exact canonical title match in gogEnrichedCache.
 */
export function findGogCounterpartId(
  candidate?: SearchMatchCandidate | null,
  originalGame?: CanonicalGame | null
): string | undefined {
  if (candidate?.gogId) {
    return String(candidate.gogId).replace(/^gog-/, '');
  }
  if (candidate?.source === 'gog' && candidate.id) {
    return String(candidate.id).replace(/^gog-/, '');
  }
  const gogPlat = originalGame?.platforms?.find(
    (p) => p.platformId === 'gog' || p.platformId?.toLowerCase() === 'gog'
  );
  if (gogPlat?.platformGameId) {
    return String(gogPlat.platformGameId).replace(/^gog-/, '');
  }
  if (!hasGogCacheEntries()) return undefined;
  const targetTitle = (candidate?.title || originalGame?.title || '').trim();
  if (!targetTitle) return undefined;
  const targetKey = canonicalizeTitleKey(targetTitle);
  if (!targetKey) return undefined;
  for (const [id, entry] of Object.entries(gogCacheMap)) {
    if (entry?.title && canonicalizeTitleKey(entry.title) === targetKey) {
      return String(id);
    }
  }
  return undefined;
}
