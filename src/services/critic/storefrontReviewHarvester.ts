import { StorefrontReviewAnchor } from '../../contracts/critic';
import { classifyNetworkError, isWafOrChallengeResponse } from '../../contracts/network';
import { steamApi } from '../steam/steamApi';
import steamEnrichedCache from '../storage/steamEnrichedCache.json';
import gogEnrichedCache from '../storage/gogEnrichedCache.json';
import { KNOWN_EPIC_APP_NAMES } from '../integrations/epicCodenames';
import { KNOWN_CRITIC_SCORES } from './knownCriticScores';
import { isAnchorSlugCompatible } from './metacritic/metacriticTitleMatching';
import { LruSet } from '../common/lruMap';
import { isValidMetacriticHostUrl } from '../common/storeUrlUtils';
import { isTitleCompatible } from '../common/titleMatching';
import { buildDevProxyUrlForRoute, getDevProxyBaseForRoute } from '../network/browserDevProxy';
import { requestScheduler, Priority } from '../network/requestScheduler';
import { onlineLifecycleManager } from '../network/onlineLifecycleManager';
import { vaultGet } from '../storage/indexedDbVault';
import {
  loadStagedCache,
  saveStagedCache,
  STAGED_CACHE_PREFIX,
} from '../storage/stagedCacheService';
import { normalizeTitleForStoreSearch, normalizeTitleKey } from '../common/titleUtils';
import { createTimeoutSignal } from './stagedResolverCache';

const STEAM_APPDETAILS_404_KEY_PREFIX = `${STAGED_CACHE_PREFIX}steam_appdetails_404_v1_`;
const STEAM_APPDETAILS_404_TTL_MS = 14 * 24 * 60 * 60 * 1000;
const NEGATIVE_ANCHOR_TTL_MS = 15 * 60 * 1000; // 15 min bounded TTL for genuine misses

function getGogWebBaseUrl(): string {
  return getDevProxyBaseForRoute('gogProfile');
}

function getGogApiBaseUrl(): string {
  return getDevProxyBaseForRoute('gogProduct');
}

function getGogCatalogBaseUrl(): string {
  return getDevProxyBaseForRoute('gogCatalog');
}

function getEpicGraphQLBaseUrl(): string {
  return buildDevProxyUrlForRoute('epicGraphql', '/graphql');
}

function getEpicContentBaseUrl(): string {
  return getDevProxyBaseForRoute('epicContent');
}

/**
 * Extracts the canonical Metacritic game slug from any Metacritic URL.
 * Strips query strings, trailing slashes, subpages (/critic-reviews, /user-reviews, /details),
 * and platform prefixes (e.g. /pc/, /playstation-5/).
 *
 * Examples:
 * - https://www.metacritic.com/game/pc/metro-last-light-redux?ftag=MCD-06-10aaa1f -> metro-last-light-redux
 * - https://www.metacritic.com/game/metal-gear-solid-delta-snake-eater/critic-reviews/ -> metal-gear-solid-delta-snake-eater
 * - https://www.metacritic.com/game/overcooked-2/ -> overcooked-2
 */
export function extractMetacriticSlugFromUrl(url?: string): string | undefined {
  if (!url || typeof url !== 'string') return undefined;
  try {
    let clean = url.split('?')[0].split('#')[0].trim().replace(/%21/gi, '!');
    clean = clean.replace(/\/+$/, '');
    clean = clean.replace(/\/(?:critic-reviews|user-reviews|details|reviews)(?:\/.*)?$/i, '');
    clean = clean.replace(/\/+$/, '');

    const match = clean.match(/\/game\/(?:[a-z0-9-]+\/)?([a-z0-9][a-z0-9!-]*)$/i);
    if (match && match[1]) {
      return match[1].toLowerCase();
    }
  } catch {
    // Ignore URL parse errors
  }
  return undefined;
}

const MAX_ANCHOR_CACHE_ENTRIES = 2000;

export interface EnrichedMetadataAnchorSource {
  appId?: number;
  name?: string;
  enrichedSource?: string;
  metadataQuality?: string;
  metacritic?: {
    score?: number;
    url?: string;
  };
}

function parseSteamAppIdValue(appId: string | number | null | undefined): number | null {
  if (typeof appId === 'number') {
    return Number.isFinite(appId) && appId > 0 ? Math.trunc(appId) : null;
  }
  if (typeof appId === 'string') {
    const cleaned = appId.trim().replace(/^steam[-_]/i, '');
    if (!/^\d+$/.test(cleaned)) return null;
    const parsed = parseInt(cleaned, 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
  }
  return null;
}

/**
 * Validates and constructs a verified Steam Metacritic anchor from enriched metadata while
 * strictly excluding legacy `local_federated` GOG star ratings masquerading in `enrichedMetadata.metacritic`
 * (requiring `enrichedSource !== 'local_federated'` / `metadataQuality !== 'local_federated'` and non-GOG/non-Xbox
 * provenance, OR a valid `metacritic.com` URL).
 */
function buildVerifiedSteamAnchorFromMetadata(
  steamAppId: number,
  meta: EnrichedMetadataAnchorSource | null | undefined,
  options?: { requirePositiveScore?: boolean }
): StorefrontReviewAnchor | null {
  if (!meta || typeof meta !== 'object' || !meta.metacritic || typeof meta.metacritic !== 'object') {
    return null;
  }
  if (meta.appId !== undefined && Number(meta.appId) > 0 && Number(meta.appId) !== steamAppId) {
    return null;
  }

  const score =
    typeof meta.metacritic.score === 'number' &&
    Number.isFinite(meta.metacritic.score) &&
    meta.metacritic.score > 0
      ? meta.metacritic.score
      : undefined;
  const rawUrl =
    typeof meta.metacritic.url === 'string' && meta.metacritic.url.trim()
      ? meta.metacritic.url.trim()
      : undefined;
  const hasValidMcUrl = isValidMetacriticHostUrl(rawUrl);
  const slug = hasValidMcUrl ? extractMetacriticSlugFromUrl(rawUrl) : undefined;

  const isLegacyFederated =
    meta.metadataQuality === 'local_federated' ||
    meta.enrichedSource === 'local_federated';
  const isNonSteamSource =
    typeof meta.enrichedSource === 'string' &&
    meta.enrichedSource.trim().length > 0 &&
    meta.enrichedSource !== 'steam';

  // Exclude legacy local_federated / GOG star ratings masquerading in enrichedMetadata.metacritic
  if ((isLegacyFederated || isNonSteamSource) && !hasValidMcUrl) {
    return null;
  }

  if (options?.requirePositiveScore) {
    if (score === undefined) return null;
    if (!hasValidMcUrl && meta.enrichedSource !== 'steam') {
      return null;
    }
  } else if (score === undefined && !hasValidMcUrl) {
    return null;
  }

  const canonicalMcUrl = slug
    ? `https://www.metacritic.com/game/${slug}/critic-reviews/`
    : hasValidMcUrl
    ? rawUrl
    : undefined;

  return {
    storefront: 'steam',
    metacriticUrl: canonicalMcUrl,
    metacriticScore: score,
    metacriticSlug: slug,
    rawStoreUrl: `https://store.steampowered.com/app/${steamAppId}`,
    isVerifiedGroundTruth: true,
  };
}

interface EnrichedSteamAnchorRecord {
  enrichedSource?: string;
  metadataQuality?: string;
  metacritic?: {
    score?: number;
    url?: string;
  };
}

interface EnrichedGogAnchorRecord {
  gogId?: string | number;
  slug?: string;
  title?: string;
  metacritic?: {
    score?: number;
    url?: string;
  };
  openCritic?: {
    id?: number;
    score?: number;
    url?: string;
  };
}

interface XboxProductMetadataRecord {
  title?: string;
  name?: string;
  averageRating?: number | string;
  starRating?: number | string;
  ratingCount?: number | string;
  reviewCount?: number | string;
  reviewSummary?: {
    averageRating?: number | string;
    totalReviews?: number | string;
  };
  metacriticUrl?: string;
  xboxProductId?: string;
  productId?: string;
  storeUrl?: string;
  product?: Record<string, unknown>;
  results?: Array<Record<string, unknown>>;
}

interface AnchorCacheEntry {
  value: StorefrontReviewAnchor | null;
  cachedAt: number;
}

function hasAnyKeys(obj: Record<string, unknown> | Record<number, unknown>): boolean {
  for (const key in obj) {
    if (Object.prototype.hasOwnProperty.call(obj, key)) {
      return true;
    }
  }
  return false;
}

function extractGogPageReviewAnchors(html: string): {
  ocScore?: number;
  ocUrl?: string;
  ocId?: number;
  mcUrl?: string;
  mcSlug?: string;
} {
  let ocScore: number | undefined;
  let ocUrl: string | undefined;
  let ocId: number | undefined;
  let mcUrl: string | undefined;
  let mcSlug: string | undefined;

  if (typeof DOMParser !== 'undefined') {
    try {
      const doc = new DOMParser().parseFromString(html, 'text/html');
      const labels = Array.from(doc.querySelectorAll('.critics-rating__label'));
      for (const label of labels) {
        if (/Top Critic Average/i.test(label.textContent || '')) {
          const container = label.parentElement;
          const scoreText = container?.querySelector('.circle-score__text')?.textContent?.trim();
          if (scoreText && /^\d+$/.test(scoreText)) {
            ocScore = parseInt(scoreText, 10);
            break;
          }
          const dashAttr = container?.querySelector('path[stroke-dasharray]')?.getAttribute('stroke-dasharray');
          const dashMatch = dashAttr?.match(/^(\d+),\s*100$/);
          if (dashMatch) {
            ocScore = parseInt(dashMatch[1], 10);
            break;
          }
        }
      }

      const anchors = Array.from(doc.querySelectorAll('a[href]'));
      for (const a of anchors) {
        const rawHref = a.getAttribute('href')?.trim();
        if (!rawHref) continue;
        try {
          const parsed = new URL(rawHref, 'https://www.gog.com');
          if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') continue;
          const host = parsed.hostname.toLowerCase();
          if (host === 'opencritic.com' || host === 'www.opencritic.com') {
            const gameIdMatch = parsed.pathname.match(/^\/game\/(\d+)\//i);
            if (gameIdMatch) {
              ocUrl = parsed.toString();
              ocId = parseInt(gameIdMatch[1], 10);
            } else if (!ocUrl) {
              ocUrl = parsed.toString();
            }
          } else if (
            !mcUrl &&
            (host === 'metacritic.com' || host === 'www.metacritic.com') &&
            /^\/game\//i.test(parsed.pathname)
          ) {
            mcUrl = parsed.toString();
            mcSlug = extractMetacriticSlugFromUrl(mcUrl);
          }
        } catch {
          // Ignore malformed href
        }
      }
    } catch {
      // Fallback to structural regex below if DOMParser fails
    }
  }

  if (ocScore === undefined) {
    const ocScoreMatch =
      html.match(
        /class=\"circle-score__text\">\s*(\d+)\s*<\/span>\s*<\/div>\s*<span class=\"critics-rating__label\">\s*Top Critic Average/i
      ) ||
      html.match(/stroke-dasharray=\"(\d+),\s*100\"[^>]*>\s*<\/path>[\s\S]*?Top Critic Average/i);
    if (ocScoreMatch) {
      ocScore = parseInt(ocScoreMatch[1], 10);
    }
  }

  if (!ocUrl) {
    const ocLinkMatch = html.match(
      /href=[\"'](https:\/\/(?:www\.)?opencritic\.com\/game\/(\d+)\/[^\"'\s>]+)[\"']/i
    );
    if (ocLinkMatch) {
      ocUrl = ocLinkMatch[1];
      ocId = parseInt(ocLinkMatch[2], 10);
    } else {
      const genericOcMatch = html.match(/href=[\"'](https:\/\/(?:www\.)?opencritic\.com\/[^\s\"'>]+)[\"']/i);
      if (genericOcMatch) {
        ocUrl = genericOcMatch[1];
      }
    }
  }

  if (!mcUrl) {
    const mcLinkMatch = html.match(/href=[\"'](https:\/\/(?:www\.)?metacritic\.com\/game\/[^\s\"'>]+)[\"']/i);
    if (mcLinkMatch) {
      mcUrl = mcLinkMatch[1];
      mcSlug = extractMetacriticSlugFromUrl(mcUrl);
    }
  }

  return { ocScore, ocUrl, ocId, mcUrl, mcSlug };
}

const STEAM_ENRICHED_ANCHOR_MAP: Record<string, EnrichedSteamAnchorRecord> = steamEnrichedCache;
const GOG_ENRICHED_ANCHOR_MAP: Record<string, EnrichedGogAnchorRecord> = gogEnrichedCache;

export class StorefrontReviewHarvester {
  private anchorCache = new Map<string, AnchorCacheEntry>();
  private inFlight = new Map<string, Promise<StorefrontReviewAnchor | null>>();
  private storeInFlight = new Map<string, Promise<StorefrontReviewAnchor | null>>();
  private transientErrorKeys = new LruSet<string>(MAX_ANCHOR_CACHE_ENTRIES);
  private cacheEpoch = 0;
  private keyEpochs = new Map<string, number>();

  constructor() {
    try {
      onlineLifecycleManager.onOnline(() => {
        this.transientErrorKeys.clear();
      });
    } catch {}
  }

  private isEpochCurrent(
    capturedEpoch: number,
    key: string,
    capturedKeyEpoch: number
  ): boolean {
    return (
      capturedEpoch === this.cacheEpoch &&
      (this.keyEpochs.get(key) ?? 0) === capturedKeyEpoch
    );
  }

  private readAnchorCache(
    key: string
  ): { hit: true; value: StorefrontReviewAnchor | null } | { hit: false } {
    const entry = this.anchorCache.get(key);
    if (!entry) return { hit: false };
    if (entry.value !== null) {
      return { hit: true, value: entry.value };
    }
    if (Date.now() - entry.cachedAt < NEGATIVE_ANCHOR_TTL_MS) {
      return { hit: true, value: null };
    }
    this.anchorCache.delete(key);
    return { hit: false };
  }

  private setAnchorCacheBounded(
    key: string,
    value: StorefrontReviewAnchor | null,
    capturedEpoch?: number,
    capturedKeyEpoch?: number
  ): void {
    if (
      capturedEpoch !== undefined &&
      capturedKeyEpoch !== undefined &&
      !this.isEpochCurrent(capturedEpoch, key, capturedKeyEpoch)
    ) {
      return;
    }
    if (this.anchorCache.has(key)) {
      this.anchorCache.delete(key);
    }
    this.anchorCache.set(key, { value, cachedAt: Date.now() });
    while (this.anchorCache.size > MAX_ANCHOR_CACHE_ENTRIES) {
      const oldest = this.anchorCache.keys().next().value;
      if (oldest === undefined) break;
      this.anchorCache.delete(oldest);
    }
  }

  public hadTransientError(cacheKey: string): boolean {
    return this.transientErrorKeys.has(cacheKey);
  }

  /**
   * Checks IndexedDB `enriched_metadata:<appId>` and caches any verified Steam Metacritic anchor
   * (`score > 0`, `url` on `metacritic.com` or `enrichedSource === 'steam'`, strictly excluding
   * legacy `local_federated` GOG star ratings) into `storefrontReviewHarvester`.
   */
  public async recoverSteamAnchorFromVault(
    appId: string | number
  ): Promise<StorefrontReviewAnchor | null> {
    const steamAppId = parseSteamAppIdValue(appId);
    if (!steamAppId) return null;

    const cacheKey = `steam-${steamAppId}`;
    const existing = this.readAnchorCache(cacheKey);
    if (existing.hit && existing.value) {
      return existing.value;
    }

    const capturedEpoch = this.cacheEpoch;
    const capturedKeyEpoch = this.keyEpochs.get(cacheKey) ?? 0;

    try {
      const vaulted = await vaultGet<EnrichedMetadataAnchorSource>(`enriched_metadata:${steamAppId}`);
      const anchor = buildVerifiedSteamAnchorFromMetadata(steamAppId, vaulted, {
        requirePositiveScore: true,
      });
      if (anchor) {
        this.setAnchorCacheBounded(cacheKey, anchor, capturedEpoch, capturedKeyEpoch);
        return anchor;
      }
    } catch {
      // IndexedDB unavailable or read error; fail open to caller
    }
    return null;
  }

  /**
   * Synchronously harvests a verified Steam Metacritic anchor directly from an in-memory game's
   * `enrichedMetadata`, strictly excluding legacy `local_federated` GOG star ratings masquerading
   * inside `enrichedMetadata.metacritic` (requiring `enrichedSource !== 'local_federated'` /
   * `metadataQuality !== 'local_federated'` or a valid `metacritic.com` URL).
   */
  public harvestFromGame(game: {
    title?: string;
    steamAppId?: number | null;
    platforms?: Array<{ platformId: string; platformGameId?: string; xboxProductId?: string }>;
    id?: string;
    enrichedMetadata?: EnrichedMetadataAnchorSource | null;
  }): StorefrontReviewAnchor | null {
    if (!game?.enrichedMetadata) return null;

    let effectiveSteamAppId: number | null = parseSteamAppIdValue(game.steamAppId);
    if (!effectiveSteamAppId) {
      const steamPlat = game.platforms?.find((p) => p.platformId === 'steam' && p.platformGameId);
      if (steamPlat?.platformGameId) {
        effectiveSteamAppId = parseSteamAppIdValue(steamPlat.platformGameId);
      } else if (game.id?.startsWith('steam-')) {
        effectiveSteamAppId = parseSteamAppIdValue(game.id);
      }
    }

    if (effectiveSteamAppId) {
      const anchor = buildVerifiedSteamAnchorFromMetadata(effectiveSteamAppId, game.enrichedMetadata);
      if (anchor) {
        this.setAnchorCacheBounded(`steam-${effectiveSteamAppId}`, anchor);
        if (game.id && game.id !== `steam-${effectiveSteamAppId}`) {
          this.setAnchorCacheBounded(game.id, anchor);
        }
        return anchor;
      }
      return null;
    }

    // For non-Steam games without a Steam AppID, only trust enrichedMetadata.metacritic when it carries
    // an explicit valid metacritic.com URL (never bare local_federated GOG star ratings).
    const mc = game.enrichedMetadata.metacritic;
    const rawUrl = typeof mc?.url === 'string' ? mc.url.trim() : undefined;
    if (!isValidMetacriticHostUrl(rawUrl)) {
      return null;
    }
    const slug = extractMetacriticSlugFromUrl(rawUrl);
    if (!slug) return null;
    const score =
      typeof mc?.score === 'number' && Number.isFinite(mc.score) && mc.score > 0
        ? mc.score
        : undefined;
    const gogPlat = game.platforms?.find((p) => p.platformId?.toLowerCase() === 'gog');
    const epicPlat = game.platforms?.find((p) => p.platformId?.toLowerCase() === 'epic');
    const xboxPlat = game.platforms?.find((p) => p.platformId?.toLowerCase() === 'xbox');
    const storefront: StorefrontReviewAnchor['storefront'] = gogPlat
      ? 'gog'
      : epicPlat
      ? 'epic'
      : xboxPlat
      ? 'xbox'
      : 'steam';
    const anchor: StorefrontReviewAnchor = {
      storefront,
      metacriticUrl: `https://www.metacritic.com/game/${slug}/critic-reviews/`,
      metacriticScore: score,
      metacriticSlug: slug,
      isVerifiedGroundTruth: true,
    };
    if (game.id) {
      this.setAnchorCacheBounded(game.id, anchor);
    }
    return anchor;
  }

  /**
   * Harvests an authoritative Metacritic review anchor for a Steam title.
   * Inspects local cache and IndexedDB vault first before performing rate-limited network lookups.
   */
  async getSteamAnchor(steamAppId: number): Promise<StorefrontReviewAnchor | null> {
    if (!steamAppId || typeof steamAppId !== 'number' || steamAppId <= 0) {
      return null;
    }

    const cacheKey = `steam-${steamAppId}`;
    const cached = this.readAnchorCache(cacheKey);
    if (cached.hit) {
      return cached.value;
    }

    const existingInFlight = this.storeInFlight.get(cacheKey);
    if (existingInFlight) {
      return existingInFlight;
    }

    this.transientErrorKeys.delete(cacheKey);

    // 1. Check local steamEnrichedCache first
    if (hasAnyKeys(STEAM_ENRICHED_ANCHOR_MAP)) {
      const preCached = STEAM_ENRICHED_ANCHOR_MAP[String(steamAppId)];
      const preCachedAnchor = buildVerifiedSteamAnchorFromMetadata(steamAppId, preCached);
      if (preCachedAnchor) {
        this.setAnchorCacheBounded(cacheKey, preCachedAnchor);
        return preCachedAnchor;
      }
    }

    // 2. Check steamApi in-memory cache (excluding legacy local_federated GOG star ratings)
    const cachedMeta = steamApi.getCachedMetadata(steamAppId);
    const cachedMetaAnchor = buildVerifiedSteamAnchorFromMetadata(steamAppId, cachedMeta);
    if (cachedMetaAnchor) {
      this.setAnchorCacheBounded(cacheKey, cachedMetaAnchor);
      return cachedMetaAnchor;
    }

    const capturedEpoch = this.cacheEpoch;
    const capturedKeyEpoch = this.keyEpochs.get(cacheKey) ?? 0;

    let run!: Promise<StorefrontReviewAnchor | null>;
    run = (async (): Promise<StorefrontReviewAnchor | null> => {
      // 2.5. Recover verified Steam Metacritic anchor from IndexedDB vault (`enriched_metadata:<appId>`)
      const vaultAnchor = await this.recoverSteamAnchorFromVault(steamAppId);
      if (vaultAnchor) {
        return vaultAnchor;
      }

      let sawTransientError = !onlineLifecycleManager.isOnline() || steamApi.isStoreRateLimited();
      const neg404Key = `${STEAM_APPDETAILS_404_KEY_PREFIX}${steamAppId}`;
      const isKnown404 = loadStagedCache<null>(neg404Key, false).valid;

      // 3. Query Steam Store API via steamApi (honoring the 14-day steam_appdetails_404_v1_ negative cache)
      if (!isKnown404 && onlineLifecycleManager.isOnline() && !steamApi.isStoreRateLimited()) {
        try {
          const liveMeta = await steamApi.fetchGameMetadata(steamAppId);
          const liveMetaAnchor = buildVerifiedSteamAnchorFromMetadata(steamAppId, liveMeta);
          if (liveMetaAnchor) {
            this.setAnchorCacheBounded(cacheKey, liveMetaAnchor, capturedEpoch, capturedKeyEpoch);
            return liveMetaAnchor;
          }

          // Only fire fallback direct fetch if liveMeta was null AND steamApi did not record a 404/delisted AppID
          if (!liveMeta && !loadStagedCache<null>(neg404Key, false).valid) {
            if (steamApi.isStoreRateLimited() || !onlineLifecycleManager.isOnline()) {
              sawTransientError = true;
            } else {
              const baseUrl = getDevProxyBaseForRoute('steamStore');
              const appDetailsUrl = `${baseUrl}/api/appdetails?appids=${steamAppId}&l=english`;
              const res = await requestScheduler.schedule(
                appDetailsUrl,
                () =>
                  fetch(appDetailsUrl, {
                    headers: { Accept: 'application/json' },
                    signal: createTimeoutSignal(6000),
                  }),
                Priority.P1_VIEWPORT,
                'store.steampowered.com'
              );
              const isWaf = isWafOrChallengeResponse(res.status, '', res.headers, true);
              if (!res.ok || isWaf) {
                if (res.status === 404 && onlineLifecycleManager.isOnline() && !isWaf) {
                  saveStagedCache<null>(neg404Key, null, 'negative', {
                    failureReason: 'not_found',
                    customTtlMs: STEAM_APPDETAILS_404_TTL_MS,
                  });
                } else if (isWaf || res.status === 429 || res.status >= 500) {
                  sawTransientError = true;
                }
              } else {
                const rawJson: unknown = await res.json();
                if (isWafOrChallengeResponse(res.status, rawJson, res.headers, true)) {
                  sawTransientError = true;
                } else {
                  const dataRecord =
                    rawJson && typeof rawJson === 'object'
                      ? (rawJson as Record<
                          string,
                          {
                            success?: boolean;
                            data?: {
                              name?: string;
                              metacritic?: { score?: unknown; url?: unknown };
                            };
                          }
                        >)
                      : null;
                  const entry = dataRecord?.[String(steamAppId)];
                  if (entry && entry.success === false && onlineLifecycleManager.isOnline()) {
                    saveStagedCache<null>(neg404Key, null, 'negative', {
                      failureReason: 'not_found',
                      customTtlMs: STEAM_APPDETAILS_404_TTL_MS,
                    });
                  }
                  const appData = entry?.data;
                  if (appData?.metacritic) {
                    const score =
                      typeof appData.metacritic.score === 'number'
                        ? appData.metacritic.score
                        : undefined;
                    const url =
                      typeof appData.metacritic.url === 'string'
                        ? appData.metacritic.url
                        : undefined;
                    const slug = extractMetacriticSlugFromUrl(url);

                    if (
                      (score !== undefined || url) &&
                      (!slug || !appData.name || isAnchorSlugCompatible(appData.name, slug))
                    ) {
                      const canonicalMcUrl = slug
                        ? `https://www.metacritic.com/game/${slug}/critic-reviews/`
                        : url;
                      const anchor: StorefrontReviewAnchor = {
                        storefront: 'steam',
                        metacriticUrl: canonicalMcUrl,
                        metacriticScore: score,
                        metacriticSlug: slug,
                        rawStoreUrl: `https://store.steampowered.com/app/${steamAppId}`,
                        isVerifiedGroundTruth: true,
                      };
                      this.setAnchorCacheBounded(cacheKey, anchor, capturedEpoch, capturedKeyEpoch);
                      return anchor;
                    }
                  }
                }
              }
            }
          }
        } catch (err: unknown) {
          if (classifyNetworkError(err).status === 'transient_error') {
            sawTransientError = true;
          }
        }
      }

      // 4. Check known verified master dataset (O(1) guard when empty)
      if (hasAnyKeys(KNOWN_CRITIC_SCORES)) {
        const known = KNOWN_CRITIC_SCORES[steamAppId];
        if (known && known.source === 'metacritic' && known.url) {
          const slug = extractMetacriticSlugFromUrl(known.url);
          const canonicalMcUrl = slug
            ? `https://www.metacritic.com/game/${slug}/critic-reviews/`
            : known.url.startsWith('http://')
            ? known.url.replace(/^http:\/\//, 'https://')
            : known.url;
          const anchor: StorefrontReviewAnchor = {
            storefront: 'steam',
            metacriticUrl: canonicalMcUrl,
            metacriticScore: known.score,
            metacriticSlug: slug,
            rawStoreUrl: `https://store.steampowered.com/app/${steamAppId}`,
            isVerifiedGroundTruth: true,
          };
          this.setAnchorCacheBounded(cacheKey, anchor, capturedEpoch, capturedKeyEpoch);
          return anchor;
        }
      }

      if (sawTransientError || !onlineLifecycleManager.isOnline()) {
        if (this.isEpochCurrent(capturedEpoch, cacheKey, capturedKeyEpoch)) {
          this.transientErrorKeys.add(cacheKey);
        }
        return null;
      }

      this.setAnchorCacheBounded(cacheKey, null, capturedEpoch, capturedKeyEpoch);
      return null;
    })().finally(() => {
      if (this.storeInFlight.get(cacheKey) === run) {
        this.storeInFlight.delete(cacheKey);
      }
    });

    this.storeInFlight.set(cacheKey, run);
    return run;
  }

  /**
   * Harvests an authoritative OpenCritic or Metacritic anchor for a GOG title.
   * Checks gogEnrichedCache first, then scrapes the official GOG listing for embedded OpenCritic scores.
   */
  async getGogAnchor(gogIdOrSlug: string, title?: string): Promise<StorefrontReviewAnchor | null> {
    const rawTarget = (gogIdOrSlug || '').trim();
    const rawTitle = (title || '').trim();
    if (!rawTarget && !rawTitle) {
      return null;
    }

    const cacheKey = `gog-${rawTarget || rawTitle.toLowerCase()}`;
    const cached = this.readAnchorCache(cacheKey);
    if (cached.hit) {
      return cached.value;
    }

    const existingInFlight = this.storeInFlight.get(cacheKey);
    if (existingInFlight) {
      return existingInFlight;
    }

    this.transientErrorKeys.delete(cacheKey);

    // 1. Check local gogEnrichedCache (O(1) empty guard)
    let cachedGog: EnrichedGogAnchorRecord | undefined;
    if (hasAnyKeys(GOG_ENRICHED_ANCHOR_MAP)) {
      cachedGog = GOG_ENRICHED_ANCHOR_MAP[rawTarget];
      if (!cachedGog && rawTarget) {
        for (const entry of Object.values(GOG_ENRICHED_ANCHOR_MAP)) {
          if (entry.slug === rawTarget || String(entry.gogId) === rawTarget) {
            cachedGog = entry;
            break;
          }
        }
      }
      if (!cachedGog && rawTitle) {
        const normTitle = rawTitle.toLowerCase();
        for (const entry of Object.values(GOG_ENRICHED_ANCHOR_MAP)) {
          if (entry.title?.toLowerCase() === normTitle) {
            cachedGog = entry;
            break;
          }
        }
      }
    }

    if (cachedGog) {
      const mcScore = typeof cachedGog.metacritic?.score === 'number' ? cachedGog.metacritic.score : undefined;
      const mcUrl = typeof cachedGog.metacritic?.url === 'string' ? cachedGog.metacritic.url : undefined;
      const mcSlug = extractMetacriticSlugFromUrl(mcUrl);

      const ocScore = typeof cachedGog.openCritic?.score === 'number' ? cachedGog.openCritic.score : undefined;
      const ocUrl = typeof cachedGog.openCritic?.url === 'string' ? cachedGog.openCritic.url : undefined;
      const ocId = typeof cachedGog.openCritic?.id === 'number' ? cachedGog.openCritic?.id : undefined;

      if (mcScore !== undefined || mcUrl || ocScore !== undefined || ocUrl) {
        const anchor: StorefrontReviewAnchor = {
          storefront: 'gog',
          metacriticUrl: mcUrl,
          metacriticScore: mcScore,
          metacriticSlug: mcSlug,
          openCriticId: ocId,
          openCriticUrl: ocUrl,
          openCriticScore: ocScore,
          rawStoreUrl: cachedGog.slug ? `https://www.gog.com/en/game/${cachedGog.slug}` : undefined,
          isVerifiedGroundTruth: true,
        };
        this.setAnchorCacheBounded(cacheKey, anchor);
        return anchor;
      }
    }

    if (!onlineLifecycleManager.isOnline()) {
      this.transientErrorKeys.add(cacheKey);
      return null;
    }

    const capturedEpoch = this.cacheEpoch;
    const capturedKeyEpoch = this.keyEpochs.get(cacheKey) ?? 0;

    let run!: Promise<StorefrontReviewAnchor | null>;
    run = (async (): Promise<StorefrontReviewAnchor | null> => {
      let sawTransientError = false;

      // 2. Resolve GOG product slug if needed
      let slug = cachedGog?.slug;
      if (!slug) {
        if (rawTarget && !/^\d+$/.test(rawTarget)) {
          slug = rawTarget.toLowerCase();
        } else if (rawTarget && /^\d+$/.test(rawTarget)) {
          try {
            const prodApiUrl = `${getGogApiBaseUrl()}/products/${rawTarget}`;
            const apiRes = await requestScheduler.schedule(
              prodApiUrl,
              () =>
                fetch(prodApiUrl, {
                  headers: { Accept: 'application/json' },
                  signal: createTimeoutSignal(6000),
                }),
              Priority.P1_VIEWPORT,
              'api.gog.com'
            );
            const isWaf = isWafOrChallengeResponse(apiRes.status, '', apiRes.headers, true);
            if (!apiRes.ok || isWaf) {
              if (isWaf || apiRes.status === 429 || apiRes.status >= 500) {
                sawTransientError = true;
              }
            } else {
              const apiData: unknown = await apiRes.json();
              if (
                apiData &&
                typeof apiData === 'object' &&
                typeof (apiData as { slug?: unknown }).slug === 'string' &&
                (apiData as { slug: string }).slug
              ) {
                slug = (apiData as { slug: string }).slug;
              }
            }
          } catch (err: unknown) {
            if (classifyNetworkError(err).status === 'transient_error') {
              sawTransientError = true;
            }
          }
        }
      }

      if (!slug && rawTitle) {
        const cleanTitle =
          normalizeTitleForStoreSearch(rawTitle, { stripEditions: true }) ||
          normalizeTitleForStoreSearch(rawTitle) ||
          rawTitle;
        try {
          const cleanLike = cleanTitle.replace(/^like:/i, '').trim();
          const catalogUrl = `${getGogCatalogBaseUrl()}/v1/catalog?query=${encodeURIComponent(`like:${cleanLike}`)}&limit=1`;
          const catalogRes = await requestScheduler.schedule(
            catalogUrl,
            () =>
              fetch(catalogUrl, {
                headers: { Accept: 'application/json' },
                signal: createTimeoutSignal(6000),
              }),
            Priority.P1_VIEWPORT,
            'catalog.gog.com'
          );
          const isWaf = isWafOrChallengeResponse(catalogRes.status, '', catalogRes.headers, true);
          if (!catalogRes.ok || isWaf) {
            if (isWaf || catalogRes.status === 429 || catalogRes.status >= 500) {
              sawTransientError = true;
            }
          } else {
            const catalogData: unknown = await catalogRes.json();
            const parsedCatalog =
              catalogData && typeof catalogData === 'object'
                ? (catalogData as {
                    productCount?: unknown;
                    products?: Array<{ title?: string; slug?: string }>;
                  })
                : null;
            const hasZeroMatches =
              typeof parsedCatalog?.productCount === 'number' && parsedCatalog.productCount <= 0;
            if (!hasZeroMatches && Array.isArray(parsedCatalog?.products) && parsedCatalog.products.length > 0) {
              const prod = parsedCatalog.products[0];
              const prodTitle = prod.title || prod.slug?.replace(/_/g, ' ') || '';
              if (prod.slug && isTitleCompatible(cleanTitle, prodTitle)) {
                slug = prod.slug;
              }
            }
          }
        } catch (err: unknown) {
          if (classifyNetworkError(err).status === 'transient_error') {
            sawTransientError = true;
          }
        }
      }

      // 3. Inspect GOG product page HTML for embedded OpenCritic or Metacritic reviews via DOMParser
      if (slug) {
        try {
          const productUrl = `${getGogWebBaseUrl()}/en/game/${slug}`;
          const pageRes = await requestScheduler.schedule(
            productUrl,
            () =>
              fetch(productUrl, {
                headers: {
                  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                },
                signal: createTimeoutSignal(7000),
              }),
            Priority.P1_VIEWPORT,
            'www.gog.com'
          );
          if (!pageRes.ok) {
            if (
              pageRes.status === 429 ||
              pageRes.status >= 500 ||
              isWafOrChallengeResponse(pageRes.status, '', pageRes.headers)
            ) {
              sawTransientError = true;
            }
          } else {
            const html = await pageRes.text();
            if (isWafOrChallengeResponse(pageRes.status, html, pageRes.headers)) {
              sawTransientError = true;
            } else {
              const { ocScore, ocUrl, ocId, mcUrl, mcSlug } = extractGogPageReviewAnchors(html);
              if (ocScore !== undefined || ocUrl || mcUrl) {
                const anchor: StorefrontReviewAnchor = {
                  storefront: 'gog',
                  metacriticUrl: mcUrl,
                  metacriticSlug: mcSlug,
                  openCriticId: ocId,
                  openCriticUrl: ocUrl,
                  openCriticScore: ocScore,
                  rawStoreUrl: `https://www.gog.com/en/game/${slug}`,
                  isVerifiedGroundTruth: true,
                };
                this.setAnchorCacheBounded(cacheKey, anchor, capturedEpoch, capturedKeyEpoch);
                return anchor;
              }
            }
          }
        } catch (err: unknown) {
          if (classifyNetworkError(err).status === 'transient_error') {
            sawTransientError = true;
          }
        }
      }

      if (sawTransientError || !onlineLifecycleManager.isOnline()) {
        if (this.isEpochCurrent(capturedEpoch, cacheKey, capturedKeyEpoch)) {
          this.transientErrorKeys.add(cacheKey);
        }
        return null;
      }

      this.setAnchorCacheBounded(cacheKey, null, capturedEpoch, capturedKeyEpoch);
      return null;
    })().finally(() => {
      if (this.storeInFlight.get(cacheKey) === run) {
        this.storeInFlight.delete(cacheKey);
      }
    });

    this.storeInFlight.set(cacheKey, run);
    return run;
  }

  /**
   * Harvests an authoritative OpenCritic or Metacritic anchor for an Epic Games Store title.
   * Inspects official Epic GraphQL store services and Epic content catalog.
   */
  async getEpicAnchor(epicSlugOrAppName: string, title?: string): Promise<StorefrontReviewAnchor | null> {
    const rawTarget = (epicSlugOrAppName || '').trim();
    let effectiveTitle = (title || '').trim();
    if (!rawTarget && !effectiveTitle) {
      return null;
    }

    const cacheKey = `epic-${rawTarget || effectiveTitle.toLowerCase()}`;
    const cached = this.readAnchorCache(cacheKey);
    if (cached.hit) {
      return cached.value;
    }

    const existingInFlight = this.storeInFlight.get(cacheKey);
    if (existingInFlight) {
      return existingInFlight;
    }

    this.transientErrorKeys.delete(cacheKey);

    if (!onlineLifecycleManager.isOnline()) {
      this.transientErrorKeys.add(cacheKey);
      return null;
    }

    const capturedEpoch = this.cacheEpoch;
    const capturedKeyEpoch = this.keyEpochs.get(cacheKey) ?? 0;

    let run!: Promise<StorefrontReviewAnchor | null>;
    run = (async (): Promise<StorefrontReviewAnchor | null> => {
      let sawTransientError = false;

      // Resolve appName / codename mapping if applicable (O(1) empty guard)
      if (rawTarget && hasAnyKeys(KNOWN_EPIC_APP_NAMES)) {
        const lowerTarget = rawTarget.toLowerCase();
        if (KNOWN_EPIC_APP_NAMES[lowerTarget]?.title && !effectiveTitle) {
          effectiveTitle = KNOWN_EPIC_APP_NAMES[lowerTarget].title;
        }
      }

      // Build candidate SKUs
      const candidateSkus: string[] = [];
      if (rawTarget) {
        if (rawTarget.startsWith('EPIC_')) {
          candidateSkus.push(rawTarget);
        } else if (!/^[0-9a-f]{32}$/i.test(rawTarget)) {
          candidateSkus.push(`EPIC_${rawTarget}`);
          candidateSkus.push(rawTarget);
        }
      }

      if (effectiveTitle) {
        const cleanTitle =
          normalizeTitleForStoreSearch(effectiveTitle, { stripEditions: true }) ||
          normalizeTitleForStoreSearch(effectiveTitle) ||
          effectiveTitle;

        const titleSlug = normalizeTitleKey(cleanTitle).replace(/\s+/g, '-');

        if (titleSlug) {
          const withPrefix = `EPIC_${titleSlug}`;
          if (!candidateSkus.includes(withPrefix)) candidateSkus.push(withPrefix);
          if (!candidateSkus.includes(titleSlug)) candidateSkus.push(titleSlug);
        }
      }

      // Query Epic Store GraphQL service for OpenCritic review anchor
      const graphqlQuery = `query productReviewsQuery($sku: String!) {
      OpenCritic {
        productReviews(sku: $sku) {
          id
          name
          openCriticScore
          reviewCount
          percentRecommended
          openCriticUrl
          award
        }
      }
    }`;

      for (const sku of candidateSkus) {
        try {
          const gqlUrl = getEpicGraphQLBaseUrl();
          const res = await requestScheduler.schedule(
            gqlUrl,
            () =>
              fetch(gqlUrl, {
                method: 'POST',
                headers: {
                  'Content-Type': 'application/json',
                  Accept: 'application/json',
                },
                body: JSON.stringify({ query: graphqlQuery, variables: { sku } }),
                signal: createTimeoutSignal(6000),
              }),
            Priority.P1_VIEWPORT,
            'launcher.store.epicgames.com'
          );

          const isWaf = isWafOrChallengeResponse(res.status, '', res.headers, true);
          if (!res.ok || isWaf) {
            if (isWaf || res.status === 429 || res.status >= 500) {
              sawTransientError = true;
            }
            continue;
          }

          const rawJson: unknown = await res.json();
          const rev = (
            rawJson as {
              data?: {
                OpenCritic?: {
                  productReviews?: {
                    id?: unknown;
                    name?: unknown;
                    openCriticScore?: unknown;
                    openCriticUrl?: unknown;
                  };
                };
              };
            } | null
          )?.data?.OpenCritic?.productReviews;

          if (
            rev &&
            (typeof rev.openCriticScore === 'number' ||
              typeof rev.openCriticUrl === 'string' ||
              typeof rev.id === 'number')
          ) {
            const ocId = typeof rev.id === 'number' ? rev.id : undefined;
            const ocScore = typeof rev.openCriticScore === 'number' ? rev.openCriticScore : undefined;
            const revName = typeof rev.name === 'string' ? rev.name : '';
            const ocUrl =
              (typeof rev.openCriticUrl === 'string' && rev.openCriticUrl) ||
              (ocId
                ? `https://opencritic.com/game/${ocId}/${revName ? revName.toLowerCase().replace(/[^a-z0-9]+/g, '-') : 'game'}`
                : undefined);

            const storeSlug = sku.replace(/^EPIC_/i, '');
            const anchor: StorefrontReviewAnchor = {
              storefront: 'epic',
              openCriticId: ocId,
              openCriticScore: ocScore,
              openCriticUrl: ocUrl,
              rawStoreUrl: `https://store.epicgames.com/p/${storeSlug}`,
              isVerifiedGroundTruth: true,
            };
            this.setAnchorCacheBounded(cacheKey, anchor, capturedEpoch, capturedKeyEpoch);
            return anchor;
          }
        } catch (err: unknown) {
          if (classifyNetworkError(err).status === 'transient_error') {
            sawTransientError = true;
          }
        }
      }

      // Inspect Epic Content API for external review links if not discovered via GraphQL
      if (candidateSkus.length > 0) {
        const primarySlug = candidateSkus[0].replace(/^EPIC_/i, '');
        try {
          const contentUrl = `${getEpicContentBaseUrl()}/api/en-US/content/products/${primarySlug}`;
          const contentRes = await requestScheduler.schedule(
            contentUrl,
            () =>
              fetch(contentUrl, {
                headers: { Accept: 'application/json' },
                signal: createTimeoutSignal(6000),
              }),
            Priority.P1_VIEWPORT,
            'store-content.ak.epicgames.com'
          );
          const isWaf = isWafOrChallengeResponse(contentRes.status, '', contentRes.headers, true);
          if (!contentRes.ok || isWaf) {
            if (isWaf || contentRes.status === 429 || contentRes.status >= 500) {
              sawTransientError = true;
            }
          } else {
            const contentText = await contentRes.text();
            const mcMatch = contentText.match(/https:\/\/(?:www\.)?metacritic\.com\/game\/[a-z0-9\/\-_]+/i);
            if (mcMatch) {
              const mcUrl = mcMatch[0];
              const mcSlug = extractMetacriticSlugFromUrl(mcUrl);
              const anchor: StorefrontReviewAnchor = {
                storefront: 'epic',
                metacriticUrl: mcUrl,
                metacriticSlug: mcSlug,
                rawStoreUrl: `https://store.epicgames.com/p/${primarySlug}`,
                isVerifiedGroundTruth: true,
              };
              this.setAnchorCacheBounded(cacheKey, anchor, capturedEpoch, capturedKeyEpoch);
              return anchor;
            }
          }
        } catch (err: unknown) {
          if (classifyNetworkError(err).status === 'transient_error') {
            sawTransientError = true;
          }
        }
      }

      if (sawTransientError || !onlineLifecycleManager.isOnline()) {
        if (this.isEpochCurrent(capturedEpoch, cacheKey, capturedKeyEpoch)) {
          this.transientErrorKeys.add(cacheKey);
        }
        return null;
      }

      this.setAnchorCacheBounded(cacheKey, null, capturedEpoch, capturedKeyEpoch);
      return null;
    })().finally(() => {
      if (this.storeInFlight.get(cacheKey) === run) {
        this.storeInFlight.delete(cacheKey);
      }
    });

    this.storeInFlight.set(cacheKey, run);
    return run;
  }

  /**
   * Harvests Xbox / Microsoft Store DisplayCatalog anchor via Electron IPC when available.
   */
  async getXboxAnchor(
    xboxIdOrTitle: string,
    title?: string
  ): Promise<StorefrontReviewAnchor | null> {
    const cleanId = (xboxIdOrTitle || '').replace(/^xbox[-_]/i, '').trim();
    const cleanTitle = (title || '').trim();
    const cacheKey = `xbox-${cleanId || cleanTitle.toLowerCase()}`;
    if (!cleanId && !cleanTitle) return null;

    const cached = this.readAnchorCache(cacheKey);
    if (cached.hit) {
      return cached.value;
    }

    const existingInFlight = this.storeInFlight.get(cacheKey);
    if (existingInFlight) {
      return existingInFlight;
    }

    if (typeof window === 'undefined' || !window.electronAPI?.fetchXboxProductMetadata) {
      return null;
    }

    if (!onlineLifecycleManager.isOnline()) {
      this.transientErrorKeys.add(cacheKey);
      return null;
    }

    this.transientErrorKeys.delete(cacheKey);
    const directBigId = /^[A-Z0-9]{12}$/i.test(cleanId) ? cleanId.toUpperCase() : undefined;
    const capturedEpoch = this.cacheEpoch;
    const capturedKeyEpoch = this.keyEpochs.get(cacheKey) ?? 0;

    let run!: Promise<StorefrontReviewAnchor | null>;
    run = (async (): Promise<StorefrontReviewAnchor | null> => {
      try {
        const rawMetaUnknown: unknown = await window.electronAPI!.fetchXboxProductMetadata!({
          xboxProductId: directBigId,
          productId: directBigId,
          title: cleanTitle || (!directBigId ? cleanId : undefined),
        });
        if (!rawMetaUnknown || typeof rawMetaUnknown !== 'object') {
          return null;
        }

        const rawMeta = rawMetaUnknown as XboxProductMetadataRecord;
        const meta: XboxProductMetadataRecord =
          rawMeta.product && typeof rawMeta.product === 'object'
            ? { ...rawMeta, ...(rawMeta.product as XboxProductMetadataRecord) }
            : Array.isArray(rawMeta.results) && rawMeta.results[0]
            ? { ...rawMeta, ...(rawMeta.results[0] as XboxProductMetadataRecord) }
            : rawMeta;

        const metaTitle = String(meta.title || meta.name || '').trim();
        if (!directBigId && cleanTitle && metaTitle && !isTitleCompatible(cleanTitle, metaTitle)) {
          return null;
        }

        const avgRating = Number(
          meta.averageRating ?? meta.starRating ?? meta.reviewSummary?.averageRating ?? 0
        );
        const ratingCount = Number(
          meta.ratingCount ?? meta.reviewCount ?? meta.reviewSummary?.totalReviews ?? 0
        );
        const mcUrl = typeof meta.metacriticUrl === 'string' ? meta.metacriticUrl : undefined;
        const mcSlug = extractMetacriticSlugFromUrl(mcUrl);
        const resolvedProdId = String(meta.xboxProductId || meta.productId || directBigId || '').trim();
        const rawStoreUrl =
          meta.storeUrl ||
          (resolvedProdId ? `https://www.xbox.com/games/store/-/${resolvedProdId}` : undefined);

        if ((ratingCount > 0 && avgRating > 0) || mcSlug) {
          const anchor: StorefrontReviewAnchor = {
            storefront: 'xbox',
            metacriticSlug: mcSlug,
            metacriticUrl: mcUrl,
            rawStoreUrl,
            isVerifiedGroundTruth: Boolean(mcSlug || directBigId),
          };
          this.setAnchorCacheBounded(cacheKey, anchor, capturedEpoch, capturedKeyEpoch);
          return anchor;
        }
      } catch (err: unknown) {
        if (classifyNetworkError(err).status === 'transient_error') {
          if (this.isEpochCurrent(capturedEpoch, cacheKey, capturedKeyEpoch)) {
            this.transientErrorKeys.add(cacheKey);
          }
          return null;
        }
      }

      this.setAnchorCacheBounded(cacheKey, null, capturedEpoch, capturedKeyEpoch);
      return null;
    })().finally(() => {
      if (this.storeInFlight.get(cacheKey) === run) {
        this.storeInFlight.delete(cacheKey);
      }
    });

    this.storeInFlight.set(cacheKey, run);
    return run;
  }

  /**
   * Resolves the authoritative storefront ground truth anchor for any canonical game.
   * Prioritizes Steam app IDs for verified Metascore links, cascading to GOG, Epic, and Xbox.
   */
  async getStorefrontAnchor(game: {
    title?: string;
    steamAppId?: number | null;
    platforms?: Array<{ platformId: string; platformGameId?: string; xboxProductId?: string }>;
    id?: string;
    enrichedMetadata?: EnrichedMetadataAnchorSource | null;
  }): Promise<StorefrontReviewAnchor | null> {
    if (!game) return null;

    // Fast path: harvest directly from verified in-memory game.enrichedMetadata (excluding legacy local_federated GOG scores)
    if (game.enrichedMetadata) {
      const harvested = this.harvestFromGame(game);
      if (harvested) {
        return harvested;
      }
    }

    // Determine primary cache key
    let cacheKey = '';
    if (typeof game.steamAppId === 'number' && game.steamAppId > 0) {
      cacheKey = `steam-${game.steamAppId}`;
    } else {
      const steamPlat = game.platforms?.find((p) => p.platformId === 'steam' && p.platformGameId);
      if (steamPlat) {
        cacheKey = `steam-${steamPlat.platformGameId}`;
      } else if (game.id?.startsWith('steam-')) {
        cacheKey = game.id;
      } else {
        const gogPlat = game.platforms?.find((p) => (p.platformId === 'gog' || p.platformId?.toLowerCase() === 'gog') && p.platformGameId);
        if (gogPlat) {
          cacheKey = `gog-${gogPlat.platformGameId}`;
        } else if (game.id?.startsWith('gog-')) {
          cacheKey = game.id;
        } else {
          const epicPlat = game.platforms?.find((p) => (p.platformId === 'epic' || p.platformId?.toLowerCase() === 'epic') && p.platformGameId);
          if (epicPlat) {
            cacheKey = `epic-${epicPlat.platformGameId}`;
          } else if (game.id?.startsWith('epic-')) {
            cacheKey = game.id;
          } else {
            const xboxPlat = game.platforms?.find(
              (p) =>
                (p.platformId === 'xbox' || p.platformId?.toLowerCase() === 'xbox') &&
                (p.xboxProductId || p.platformGameId)
            );
            if (xboxPlat) {
              cacheKey = `xbox-${xboxPlat.xboxProductId || xboxPlat.platformGameId}`;
            } else if (game.id?.startsWith('xbox-')) {
              cacheKey = game.id;
            } else if (game.title) {
              cacheKey = `title-${game.title.toLowerCase().trim()}`;
            } else if (game.id) {
              cacheKey = game.id;
            } else {
              cacheKey = 'unknown';
            }
          }
        }
      }
    }

    const cached = this.readAnchorCache(cacheKey);
    if (cached.hit) {
      return cached.value;
    }

    if (this.inFlight.has(cacheKey)) {
      return this.inFlight.get(cacheKey)!;
    }

    this.transientErrorKeys.delete(cacheKey);
    const capturedEpoch = this.cacheEpoch;
    const capturedKeyEpoch = this.keyEpochs.get(cacheKey) ?? 0;

    let promise!: Promise<StorefrontReviewAnchor | null>;
    promise = (async (): Promise<StorefrontReviewAnchor | null> => {
      let subTransient = !onlineLifecycleManager.isOnline();

      // 1. Prioritize Steam if steamAppId is known (fastest, most authoritative Metascore links)
      let effectiveSteamAppId: number | undefined;
      if (typeof game.steamAppId === 'number' && game.steamAppId > 0) {
        effectiveSteamAppId = game.steamAppId;
      } else {
        const steamPlat = game.platforms?.find((p) => p.platformId === 'steam' && p.platformGameId);
        if (steamPlat) {
          const parsed = parseInt(steamPlat.platformGameId!, 10);
          if (!isNaN(parsed) && parsed > 0) effectiveSteamAppId = parsed;
        } else if (game.id?.startsWith('steam-')) {
          const parsed = parseInt(game.id.replace('steam-', ''), 10);
          if (!isNaN(parsed) && parsed > 0) effectiveSteamAppId = parsed;
        }
      }

      // Check if Epic codename mapping links to a known Steam App ID
      if (!effectiveSteamAppId && hasAnyKeys(KNOWN_EPIC_APP_NAMES)) {
        const epicPlat = game.platforms?.find((p) => p.platformId === 'epic' || p.platformId?.toLowerCase() === 'epic');
        const epicId = epicPlat?.platformGameId || (game.id?.startsWith('epic-') ? game.id.replace('epic-', '') : undefined);
        if (epicId && KNOWN_EPIC_APP_NAMES[epicId.toLowerCase()]?.steamAppId) {
          effectiveSteamAppId = KNOWN_EPIC_APP_NAMES[epicId.toLowerCase()].steamAppId;
        }
      }

      if (effectiveSteamAppId) {
        const steamAnchor = await this.getSteamAnchor(effectiveSteamAppId);
        if (steamAnchor) {
          this.setAnchorCacheBounded(cacheKey, steamAnchor, capturedEpoch, capturedKeyEpoch);
          return steamAnchor;
        }
        if (this.transientErrorKeys.has(`steam-${effectiveSteamAppId}`)) {
          subTransient = true;
        }
      }

      // 2. Check GOG platform
      const gogPlat = game.platforms?.find((p) => p.platformId === 'gog' || p.platformId?.toLowerCase() === 'gog');
      const gogId = gogPlat?.platformGameId || (game.id?.startsWith('gog-') ? game.id.replace('gog-', '') : undefined);
      if (gogId) {
        const gogAnchor = await this.getGogAnchor(gogId, game.title);
        if (gogAnchor) {
          this.setAnchorCacheBounded(cacheKey, gogAnchor, capturedEpoch, capturedKeyEpoch);
          return gogAnchor;
        }
        if (this.transientErrorKeys.has(`gog-${gogId.trim() || (game.title || '').trim().toLowerCase()}`)) {
          subTransient = true;
        }
      }

      // 3. Check Epic platform
      const epicPlat = game.platforms?.find((p) => p.platformId === 'epic' || p.platformId?.toLowerCase() === 'epic');
      const epicId = epicPlat?.platformGameId || (game.id?.startsWith('epic-') ? game.id.replace('epic-', '') : undefined);
      if (epicId) {
        const epicAnchor = await this.getEpicAnchor(epicId, game.title);
        if (epicAnchor) {
          this.setAnchorCacheBounded(cacheKey, epicAnchor, capturedEpoch, capturedKeyEpoch);
          return epicAnchor;
        }
        if (this.transientErrorKeys.has(`epic-${epicId.trim() || (game.title || '').trim().toLowerCase()}`)) {
          subTransient = true;
        }
      }

      // 4. Fallback search by title across GOG and Epic if available (only when not already a Steam game with a known Steam App ID)
      if (game.title && !effectiveSteamAppId) {
        if (!gogId) {
          const gogTitleAnchor = await this.getGogAnchor('', game.title);
          if (gogTitleAnchor) {
            this.setAnchorCacheBounded(cacheKey, gogTitleAnchor, capturedEpoch, capturedKeyEpoch);
            return gogTitleAnchor;
          }
          if (this.transientErrorKeys.has(`gog-${game.title.trim().toLowerCase()}`)) {
            subTransient = true;
          }
        }

        if (!epicId) {
          const epicTitleAnchor = await this.getEpicAnchor('', game.title);
          if (epicTitleAnchor) {
            this.setAnchorCacheBounded(cacheKey, epicTitleAnchor, capturedEpoch, capturedKeyEpoch);
            return epicTitleAnchor;
          }
          if (this.transientErrorKeys.has(`epic-${game.title.trim().toLowerCase()}`)) {
            subTransient = true;
          }
        }
      }

      // 5. Check Xbox / Microsoft Store platform anchor fallback
      const xboxPlat = game.platforms?.find(
        (p) => p.platformId === 'xbox' || p.platformId?.toLowerCase() === 'xbox'
      );
      const xboxId =
        xboxPlat?.xboxProductId ||
        xboxPlat?.platformGameId ||
        (game.id?.startsWith('xbox-') ? game.id.replace('xbox-', '') : undefined);
      if (xboxId) {
        const xboxAnchor = await this.getXboxAnchor(xboxId, game.title);
        if (xboxAnchor) {
          this.setAnchorCacheBounded(cacheKey, xboxAnchor, capturedEpoch, capturedKeyEpoch);
          return xboxAnchor;
        }
        if (this.transientErrorKeys.has(`xbox-${xboxId.replace(/^xbox[-_]/i, '').trim() || (game.title || '').trim().toLowerCase()}`)) {
          subTransient = true;
        }
      }

      if (subTransient || !onlineLifecycleManager.isOnline()) {
        if (this.isEpochCurrent(capturedEpoch, cacheKey, capturedKeyEpoch)) {
          this.transientErrorKeys.add(cacheKey);
        }
        return null;
      }

      this.setAnchorCacheBounded(cacheKey, null, capturedEpoch, capturedKeyEpoch);
      return null;
    })().finally(() => {
      if (this.inFlight.get(cacheKey) === promise) {
        this.inFlight.delete(cacheKey);
      }
    });

    this.inFlight.set(cacheKey, promise);
    return promise;
  }

  /**
   * Targeted O(1) eviction for a single game across anchor cache, in-flight, and transient keys.
   */
  public evictForGame(params: {
    gameId?: string | null;
    title?: string | null;
    steamAppId?: number | null;
    platforms?: Array<{ platformId?: string; platformGameId?: string; xboxProductId?: string }>;
  }): void {
    const keys = new Set<string>();
    if (params.gameId) {
      keys.add(params.gameId);
      const clean = params.gameId.trim();
      if (clean) keys.add(clean);
    }
    if (typeof params.steamAppId === 'number' && params.steamAppId > 0) {
      keys.add(`steam-${params.steamAppId}`);
    }
    const lowerTitle = (params.title || '').trim().toLowerCase();
    if (lowerTitle) {
      keys.add(`title-${lowerTitle}`);
      keys.add(`gog-${lowerTitle}`);
      keys.add(`epic-${lowerTitle}`);
      keys.add(`xbox-${lowerTitle}`);
    }
    if (Array.isArray(params.platforms)) {
      for (const p of params.platforms) {
        const pid = (p.platformId || '').toLowerCase();
        const gid = (p.xboxProductId || p.platformGameId || '').trim();
        if (pid && gid) {
          keys.add(`${pid}-${gid}`);
          keys.add(`${pid}-${gid.toLowerCase()}`);
        }
      }
    }
    for (const key of keys) {
      this.keyEpochs.set(key, (this.keyEpochs.get(key) ?? 0) + 1);
      this.anchorCache.delete(key);
      this.inFlight.delete(key);
      this.storeInFlight.delete(key);
      this.transientErrorKeys.delete(key);
    }
  }

  /**
   * Clears the in-memory anchor cache and any active in-flight requests.
   */
  clearCache(): void {
    this.cacheEpoch += 1;
    this.keyEpochs.clear();
    this.anchorCache.clear();
    this.inFlight.clear();
    this.storeInFlight.clear();
    this.transientErrorKeys.clear();
  }
}

export const storefrontReviewHarvester = new StorefrontReviewHarvester();

/**
 * Standalone helper to recover a verified Steam Metacritic anchor from IndexedDB
 * (`enriched_metadata:<appId>`) and populate `storefrontReviewHarvester`'s cache.
 */
export async function recoverSteamAnchorFromVault(
  appId: string | number
): Promise<StorefrontReviewAnchor | null> {
  return storefrontReviewHarvester.recoverSteamAnchorFromVault(appId);
}
