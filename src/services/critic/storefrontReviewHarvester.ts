import axios from 'axios';
import { StorefrontReviewAnchor } from '../../contracts/critic';
import { classifyNetworkError, isWafOrChallengeResponse } from '../../contracts/network';
import { steamApi } from '../steam/steamApi';
import steamEnrichedCache from '../storage/steamEnrichedCache.json';
import gogEnrichedCache from '../storage/gogEnrichedCache.json';
import { KNOWN_EPIC_APP_NAMES } from '../integrations/epicCodenames';
import { KNOWN_CRITIC_SCORES } from './knownCriticScores';
import { isTitleCompatible } from './metacriticResolver';
import { requestScheduler, Priority } from '../network/requestScheduler';
import { onlineLifecycleManager } from '../network/onlineLifecycleManager';

const GOG_USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const EPIC_LAUNCHER_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) EpicGamesLauncher';

function getGogWebBaseUrl(): string {
  if (typeof window !== 'undefined' && window.location?.hostname === 'localhost') {
    return '/api/gog-profile';
  }
  return 'https://www.gog.com';
}

function getGogApiBaseUrl(): string {
  if (typeof window !== 'undefined' && window.location?.hostname === 'localhost') {
    return '/api/gog-product';
  }
  return 'https://api.gog.com';
}

function getEpicGraphQLBaseUrl(): string {
  if (typeof window !== 'undefined' && window.location?.hostname === 'localhost') {
    return '/api/epic-graphql/graphql';
  }
  return 'https://launcher.store.epicgames.com/graphql';
}

function getEpicContentBaseUrl(): string {
  if (typeof window !== 'undefined' && window.location?.hostname === 'localhost') {
    return '/api/epic-content';
  }
  return 'https://store-content.ak.epicgames.com';
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
    let clean = url.split('?')[0].split('#')[0].trim();
    clean = clean.replace(/\/+$/, '');
    clean = clean.replace(/\/(?:critic-reviews|user-reviews|details|reviews)(?:\/.*)?$/i, '');
    clean = clean.replace(/\/+$/, '');

    const match = clean.match(/\/game\/(?:[a-z0-9-]+\/)?([a-z0-9-]+)$/i);
    if (match && match[1]) {
      return match[1].toLowerCase();
    }
  } catch {
    // Ignore URL parse errors
  }
  return undefined;
}

const MAX_ANCHOR_CACHE_ENTRIES = 2000;

interface EnrichedSteamAnchorRecord {
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

function getHttpErrorResponse(err: unknown): {
  status?: number;
  data?: unknown;
  headers?: Record<string, unknown>;
} {
  if (!err || typeof err !== 'object') return {};
  const resp = (err as { response?: unknown }).response;
  if (!resp || typeof resp !== 'object') return {};
  const r = resp as { status?: unknown; data?: unknown; headers?: unknown };
  return {
    status: typeof r.status === 'number' ? r.status : undefined,
    data: r.data,
    headers:
      r.headers && typeof r.headers === 'object'
        ? (r.headers as Record<string, unknown>)
        : undefined,
  };
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

const STEAM_ENRICHED_ANCHOR_MAP = steamEnrichedCache as unknown as Record<string, EnrichedSteamAnchorRecord>;
const GOG_ENRICHED_ANCHOR_MAP = gogEnrichedCache as unknown as Record<string, EnrichedGogAnchorRecord>;

export class StorefrontReviewHarvester {
  private anchorCache = new Map<string, StorefrontReviewAnchor | null>();
  private inFlight = new Map<string, Promise<StorefrontReviewAnchor | null>>();
  private transientErrorKeys = new Set<string>();

  constructor() {
    try {
      onlineLifecycleManager.onOnline(() => {
        this.transientErrorKeys.clear();
      });
    } catch {}
  }

  private setAnchorCacheBounded(key: string, value: StorefrontReviewAnchor | null): void {
    if (this.anchorCache.has(key)) {
      this.anchorCache.delete(key);
    }
    this.anchorCache.set(key, value);
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
   * Harvests an authoritative Metacritic review anchor for a Steam title.
   * Inspects local cache first before performing rate-limited network lookups.
   */
  async getSteamAnchor(steamAppId: number): Promise<StorefrontReviewAnchor | null> {
    if (!steamAppId || typeof steamAppId !== 'number' || steamAppId <= 0) {
      return null;
    }

    const cacheKey = `steam-${steamAppId}`;
    if (this.anchorCache.has(cacheKey)) {
      return this.anchorCache.get(cacheKey)!;
    }

    this.transientErrorKeys.delete(cacheKey);

    // 1. Check local steamEnrichedCache first
    const preCached = STEAM_ENRICHED_ANCHOR_MAP[String(steamAppId)];
    if (preCached?.metacritic) {
      const score = typeof preCached.metacritic.score === 'number' ? preCached.metacritic.score : undefined;
      const url = typeof preCached.metacritic.url === 'string' ? preCached.metacritic.url : undefined;
      const slug = extractMetacriticSlugFromUrl(url);

      if (score !== undefined || url) {
        const canonicalMcUrl = slug ? `https://www.metacritic.com/game/${slug}/critic-reviews/` : url;
        const anchor: StorefrontReviewAnchor = {
          storefront: 'steam',
          metacriticUrl: canonicalMcUrl,
          metacriticScore: score,
          metacriticSlug: slug,
          rawStoreUrl: `https://store.steampowered.com/app/${steamAppId}`,
          isVerifiedGroundTruth: true,
        };
        this.setAnchorCacheBounded(cacheKey, anchor);
        return anchor;
      }
    }

    // 2. Check steamApi in-memory cache
    const cachedMeta = steamApi.getCachedMetadata(steamAppId);
    if (cachedMeta?.metacritic) {
      const score = typeof cachedMeta.metacritic.score === 'number' ? cachedMeta.metacritic.score : undefined;
      const url = typeof cachedMeta.metacritic.url === 'string' ? cachedMeta.metacritic.url : undefined;
      const slug = extractMetacriticSlugFromUrl(url);

      if (score !== undefined || url) {
        const canonicalMcUrl = slug ? `https://www.metacritic.com/game/${slug}/critic-reviews/` : url;
        const anchor: StorefrontReviewAnchor = {
          storefront: 'steam',
          metacriticUrl: canonicalMcUrl,
          metacriticScore: score,
          metacriticSlug: slug,
          rawStoreUrl: `https://store.steampowered.com/app/${steamAppId}`,
          isVerifiedGroundTruth: true,
        };
        this.setAnchorCacheBounded(cacheKey, anchor);
        return anchor;
      }
    }

    let sawTransientError = !onlineLifecycleManager.isOnline() || steamApi.isStoreRateLimited();

    // 3. Query Steam Store API directly if not present in cache
    if (onlineLifecycleManager.isOnline() && !steamApi.isStoreRateLimited()) {
      try {
        const liveMeta = await steamApi.fetchGameMetadata(steamAppId);
        if (liveMeta?.metacritic) {
          const score = typeof liveMeta.metacritic.score === 'number' ? liveMeta.metacritic.score : undefined;
          const url = typeof liveMeta.metacritic.url === 'string' ? liveMeta.metacritic.url : undefined;
          const slug = extractMetacriticSlugFromUrl(url);

          if (score !== undefined || url) {
            const canonicalMcUrl = slug ? `https://www.metacritic.com/game/${slug}/critic-reviews/` : url;
            const anchor: StorefrontReviewAnchor = {
              storefront: 'steam',
              metacriticUrl: canonicalMcUrl,
              metacriticScore: score,
              metacriticSlug: slug,
              rawStoreUrl: `https://store.steampowered.com/app/${steamAppId}`,
              isVerifiedGroundTruth: true,
            };
            this.setAnchorCacheBounded(cacheKey, anchor);
            return anchor;
          }
        }

        // Only fire fallback direct fetch if liveMeta was null (e.g. mocked/bypassed steamApi in tests)
        if (!liveMeta) {
          if (steamApi.isStoreRateLimited() || !onlineLifecycleManager.isOnline()) {
            sawTransientError = true;
          } else {
            const baseUrl = typeof window !== 'undefined' && window.location?.hostname === 'localhost'
              ? '/api/steam-store'
              : 'https://store.steampowered.com';
            const appDetailsUrl = `${baseUrl}/api/appdetails?appids=${steamAppId}&l=english`;
            const res = await requestScheduler.schedule(
              appDetailsUrl,
              () =>
                axios.get(appDetailsUrl, {
                  timeout: 6000,
                  headers: {
                    Cookie: 'birthtime=568022401; mature_content=1; wants_mature_content=1',
                  },
                }),
              Priority.P1_VIEWPORT,
              'store.steampowered.com'
            );
            const appData = res.data?.[steamAppId]?.data;
            if (appData?.metacritic) {
              const score = typeof appData.metacritic.score === 'number' ? appData.metacritic.score : undefined;
              const url = typeof appData.metacritic.url === 'string' ? appData.metacritic.url : undefined;
              const slug = extractMetacriticSlugFromUrl(url);

              if ((score !== undefined || url) && (!slug || !appData.name || isTitleCompatible(appData.name, slug.replace(/-/g, ' ')))) {
                const canonicalMcUrl = slug ? `https://www.metacritic.com/game/${slug}/critic-reviews/` : url;
                const anchor: StorefrontReviewAnchor = {
                  storefront: 'steam',
                  metacriticUrl: canonicalMcUrl,
                  metacriticScore: score,
                  metacriticSlug: slug,
                  rawStoreUrl: `https://store.steampowered.com/app/${steamAppId}`,
                  isVerifiedGroundTruth: true,
                };
                this.setAnchorCacheBounded(cacheKey, anchor);
                return anchor;
              }
            }
          }
        }
      } catch (err: unknown) {
        const resp = getHttpErrorResponse(err);
        if (
          classifyNetworkError(err).status === 'transient_error' ||
          isWafOrChallengeResponse(resp.status, resp.data, resp.headers)
        ) {
          sawTransientError = true;
        }
      }
    }

    // 4. Check known verified master dataset
    const known = KNOWN_CRITIC_SCORES[steamAppId];
    if (known && known.source === 'metacritic' && known.url) {
      const slug = extractMetacriticSlugFromUrl(known.url);
      const canonicalMcUrl = slug ? `https://www.metacritic.com/game/${slug}/critic-reviews/` : (known.url?.startsWith('http://') ? known.url.replace(/^http:\/\//, 'https://') : known.url);
      const anchor: StorefrontReviewAnchor = {
        storefront: 'steam',
        metacriticUrl: canonicalMcUrl,
        metacriticScore: known.score,
        metacriticSlug: slug,
        rawStoreUrl: `https://store.steampowered.com/app/${steamAppId}`,
        isVerifiedGroundTruth: true,
      };
      this.setAnchorCacheBounded(cacheKey, anchor);
      return anchor;
    }

    if (sawTransientError || !onlineLifecycleManager.isOnline()) {
      this.transientErrorKeys.add(cacheKey);
      return null;
    }

    this.setAnchorCacheBounded(cacheKey, null);
    return null;
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
    if (this.anchorCache.has(cacheKey)) {
      return this.anchorCache.get(cacheKey)!;
    }

    this.transientErrorKeys.delete(cacheKey);

    // 1. Check local gogEnrichedCache
    let cachedGog: EnrichedGogAnchorRecord | undefined = GOG_ENRICHED_ANCHOR_MAP[rawTarget];
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
              axios.get(prodApiUrl, {
                headers: { 'User-Agent': GOG_USER_AGENT },
                timeout: 6000,
              }),
            Priority.P1_VIEWPORT,
            'api.gog.com'
          );
          if (apiRes.data?.slug) {
            slug = apiRes.data.slug;
          }
        } catch (err: unknown) {
          const resp = getHttpErrorResponse(err);
          if (
            classifyNetworkError(err).status === 'transient_error' ||
            isWafOrChallengeResponse(resp.status, resp.data, resp.headers)
          ) {
            sawTransientError = true;
          }
        }
      }
    }

    if (!slug && rawTitle) {
      const cleanTitle = rawTitle
        .replace(/[®™©]/g, '')
        .replace(/[:\-–—_+]/g, ' ')
        .replace(
          /\b(standard|deluxe|gold|silver|platinum|diamond|collector'?s|ultimate|complete|special|limited|definitive|enhanced|anniversary|directors-cut|director'?s cut|goty|game of the year|remastered|remake)( edition| pack| bundle| collection)?\b/gi,
          ''
        )
        .replace(/\s+/g, ' ')
        .trim();
      try {
        const catalogUrl = `https://catalog.gog.com/v1/catalog?query=${encodeURIComponent(cleanTitle)}&limit=1`;
        const catalogRes = await requestScheduler.schedule(
          catalogUrl,
          () =>
            axios.get(catalogUrl, {
              headers: { 'User-Agent': GOG_USER_AGENT },
              timeout: 6000,
            }),
          Priority.P1_VIEWPORT,
          'catalog.gog.com'
        );
        if (Array.isArray(catalogRes.data?.products) && catalogRes.data.products.length > 0) {
          const prod = catalogRes.data.products[0];
          const prodTitle = prod.title || prod.slug?.replace(/_/g, ' ') || '';
          if (isTitleCompatible(cleanTitle, prodTitle)) {
            slug = prod.slug;
          }
        }
      } catch (err: unknown) {
        const resp = getHttpErrorResponse(err);
        if (
          classifyNetworkError(err).status === 'transient_error' ||
          isWafOrChallengeResponse(resp.status, resp.data, resp.headers)
        ) {
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
            axios.get(productUrl, {
              headers: { 'User-Agent': GOG_USER_AGENT },
              timeout: 7000,
            }),
          Priority.P1_VIEWPORT,
          'www.gog.com'
        );
        const html = typeof pageRes.data === 'string' ? pageRes.data : '';
        const respHeaders =
          pageRes.headers && typeof pageRes.headers === 'object'
            ? (pageRes.headers as Record<string, unknown>)
            : undefined;
        if (isWafOrChallengeResponse(pageRes.status, html, respHeaders)) {
          sawTransientError = true;
        } else {
          const { ocScore, ocUrl, ocId, mcUrl, mcSlug } = extractGogPageReviewAnchors(html);
          let mcScore: number | undefined;

          if (ocScore !== undefined || ocUrl || mcUrl || mcScore !== undefined) {
            const anchor: StorefrontReviewAnchor = {
              storefront: 'gog',
              metacriticUrl: mcUrl,
              metacriticScore: mcScore,
              metacriticSlug: mcSlug,
              openCriticId: ocId,
              openCriticUrl: ocUrl,
              openCriticScore: ocScore,
              rawStoreUrl: `https://www.gog.com/en/game/${slug}`,
              isVerifiedGroundTruth: true,
            };
            this.setAnchorCacheBounded(cacheKey, anchor);
            return anchor;
          }
        }
      } catch (err: unknown) {
        const resp = getHttpErrorResponse(err);
        if (
          classifyNetworkError(err).status === 'transient_error' ||
          isWafOrChallengeResponse(resp.status, resp.data, resp.headers)
        ) {
          sawTransientError = true;
        }
      }
    }

    if (sawTransientError || !onlineLifecycleManager.isOnline()) {
      this.transientErrorKeys.add(cacheKey);
      return null;
    }

    this.setAnchorCacheBounded(cacheKey, null);
    return null;
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
    if (this.anchorCache.has(cacheKey)) {
      return this.anchorCache.get(cacheKey)!;
    }

    this.transientErrorKeys.delete(cacheKey);

    if (!onlineLifecycleManager.isOnline()) {
      this.transientErrorKeys.add(cacheKey);
      return null;
    }

    let sawTransientError = false;

    // Resolve appName / codename mapping if applicable
    if (rawTarget) {
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
      const cleanTitle = effectiveTitle
        .replace(/[®™©]/g, '')
        .replace(
          /\b(digital\s+)?(standard|deluxe|gold|silver|platinum|diamond|collector'?s|ultimate|complete|special|limited|definitive|enhanced|anniversary|director'?s cut|goty|game of the year|remastered|remake)\b.*$/i,
          ''
        )
        .trim();

      const titleSlug = cleanTitle
        .toLowerCase()
        .replace(/['’]/g, '')
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '');

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
            axios.post(
              gqlUrl,
              { query: graphqlQuery, variables: { sku } },
              {
                headers: {
                  'Content-Type': 'application/json',
                  'User-Agent': EPIC_LAUNCHER_USER_AGENT,
                },
                timeout: 6000,
              }
            ),
          Priority.P1_VIEWPORT,
          'launcher.store.epicgames.com'
        );

        const rev = res.data?.data?.OpenCritic?.productReviews;
        if (rev && (typeof rev.openCriticScore === 'number' || rev.openCriticUrl || typeof rev.id === 'number')) {
          const ocId = typeof rev.id === 'number' ? rev.id : undefined;
          const ocScore = typeof rev.openCriticScore === 'number' ? rev.openCriticScore : undefined;
          const ocUrl =
            rev.openCriticUrl ||
            (ocId
              ? `https://opencritic.com/game/${ocId}/${rev.name ? rev.name.toLowerCase().replace(/[^a-z0-9]+/g, '-') : 'game'}`
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
          this.setAnchorCacheBounded(cacheKey, anchor);
          return anchor;
        }
      } catch (err: unknown) {
        const resp = getHttpErrorResponse(err);
        if (
          classifyNetworkError(err).status === 'transient_error' ||
          isWafOrChallengeResponse(resp.status, resp.data, resp.headers)
        ) {
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
            axios.get(contentUrl, {
              headers: { 'User-Agent': 'Mozilla/5.0' },
              timeout: 6000,
            }),
          Priority.P1_VIEWPORT,
          'store-content.ak.epicgames.com'
        );
        const contentStr = JSON.stringify(contentRes.data || '');
        const mcMatch = contentStr.match(/https:\/\/(?:www\.)?metacritic\.com\/game\/[a-z0-9\/\-_]+/i);
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
          this.setAnchorCacheBounded(cacheKey, anchor);
          return anchor;
        }
      } catch (err: unknown) {
        const resp = getHttpErrorResponse(err);
        if (
          classifyNetworkError(err).status === 'transient_error' ||
          isWafOrChallengeResponse(resp.status, resp.data, resp.headers)
        ) {
          sawTransientError = true;
        }
      }
    }

    if (sawTransientError || !onlineLifecycleManager.isOnline()) {
      this.transientErrorKeys.add(cacheKey);
      return null;
    }

    this.setAnchorCacheBounded(cacheKey, null);
    return null;
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

    if (this.anchorCache.has(cacheKey)) {
      return this.anchorCache.get(cacheKey)!;
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

    try {
      const rawMetaUnknown: unknown = await window.electronAPI.fetchXboxProductMetadata({
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
        this.setAnchorCacheBounded(cacheKey, anchor);
        return anchor;
      }
    } catch (err: unknown) {
      if (classifyNetworkError(err).status === 'transient_error') {
        this.transientErrorKeys.add(cacheKey);
        return null;
      }
    }

    this.setAnchorCacheBounded(cacheKey, null);
    return null;
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
  }): Promise<StorefrontReviewAnchor | null> {
    if (!game) return null;

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

    if (this.anchorCache.has(cacheKey)) {
      return this.anchorCache.get(cacheKey)!;
    }

    if (this.inFlight.has(cacheKey)) {
      return this.inFlight.get(cacheKey)!;
    }

    this.transientErrorKeys.delete(cacheKey);

    const promise = (async (): Promise<StorefrontReviewAnchor | null> => {
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
      if (!effectiveSteamAppId) {
        const epicPlat = game.platforms?.find((p) => p.platformId === 'epic' || p.platformId?.toLowerCase() === 'epic');
        const epicId = epicPlat?.platformGameId || (game.id?.startsWith('epic-') ? game.id.replace('epic-', '') : undefined);
        if (epicId && KNOWN_EPIC_APP_NAMES[epicId.toLowerCase()]?.steamAppId) {
          effectiveSteamAppId = KNOWN_EPIC_APP_NAMES[epicId.toLowerCase()].steamAppId;
        }
      }

      if (effectiveSteamAppId) {
        const steamAnchor = await this.getSteamAnchor(effectiveSteamAppId);
        if (steamAnchor) {
          this.setAnchorCacheBounded(cacheKey, steamAnchor);
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
          this.setAnchorCacheBounded(cacheKey, gogAnchor);
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
          this.setAnchorCacheBounded(cacheKey, epicAnchor);
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
            this.setAnchorCacheBounded(cacheKey, gogTitleAnchor);
            return gogTitleAnchor;
          }
          if (this.transientErrorKeys.has(`gog-${game.title.trim().toLowerCase()}`)) {
            subTransient = true;
          }
        }

        if (!epicId) {
          const epicTitleAnchor = await this.getEpicAnchor('', game.title);
          if (epicTitleAnchor) {
            this.setAnchorCacheBounded(cacheKey, epicTitleAnchor);
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
          this.setAnchorCacheBounded(cacheKey, xboxAnchor);
          return xboxAnchor;
        }
        if (this.transientErrorKeys.has(`xbox-${xboxId.replace(/^xbox[-_]/i, '').trim() || (game.title || '').trim().toLowerCase()}`)) {
          subTransient = true;
        }
      }

      if (subTransient || !onlineLifecycleManager.isOnline()) {
        this.transientErrorKeys.add(cacheKey);
        return null;
      }

      this.setAnchorCacheBounded(cacheKey, null);
      return null;
    })().finally(() => {
      this.inFlight.delete(cacheKey);
    });

    this.inFlight.set(cacheKey, promise);
    return promise;
  }

  /**
   * Clears the in-memory anchor cache and any active in-flight requests.
   */
  clearCache(): void {
    this.anchorCache.clear();
    this.inFlight.clear();
    this.transientErrorKeys.clear();
  }
}

export const storefrontReviewHarvester = new StorefrontReviewHarvester();
