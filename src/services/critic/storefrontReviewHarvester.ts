import axios from 'axios';
import { StorefrontReviewAnchor } from '../../contracts/critic';
import { steamApi } from '../steam/steamApi';
import steamEnrichedCache from '../storage/steamEnrichedCache.json';
import gogEnrichedCache from '../storage/gogEnrichedCache.json';
import { KNOWN_EPIC_APP_NAMES } from '../integrations/epicCodenames';
import { KNOWN_CRITIC_SCORES } from './knownCriticScores';
import { isTitleCompatible } from './metacriticResolver';

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

export class StorefrontReviewHarvester {
  private anchorCache = new Map<string, StorefrontReviewAnchor | null>();
  private inFlight = new Map<string, Promise<StorefrontReviewAnchor | null>>();

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

    // 1. Check local steamEnrichedCache first
    const preCached = (steamEnrichedCache as Record<string, any>)[String(steamAppId)];
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
        this.anchorCache.set(cacheKey, anchor);
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
        this.anchorCache.set(cacheKey, anchor);
        return anchor;
      }
    }

    // 3. Query Steam Store API directly if not present in cache
    if (!steamApi.isStoreRateLimited()) {
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
            this.anchorCache.set(cacheKey, anchor);
            return anchor;
          }
        }

        // Direct fetch from Steam API if cached metadata lacked metacritic
        const baseUrl = typeof window !== 'undefined' && window.location?.hostname === 'localhost'
          ? '/api/steam-store'
          : 'https://store.steampowered.com';
        const res = await axios.get(`${baseUrl}/api/appdetails?appids=${steamAppId}&l=english`, {
          timeout: 6000,
          headers: {
            Cookie: 'birthtime=568022401; mature_content=1; wants_mature_content=1',
          },
        });
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
            this.anchorCache.set(cacheKey, anchor);
            return anchor;
          }
        }
      } catch {
        // Fallback gracefully on network timeout or transient error
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
      this.anchorCache.set(cacheKey, anchor);
      return anchor;
    }

    this.anchorCache.set(cacheKey, null);
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

    // 1. Check local gogEnrichedCache
    let cachedGog: any = (gogEnrichedCache as Record<string, any>)[rawTarget];
    if (!cachedGog && rawTarget) {
      for (const entry of Object.values(gogEnrichedCache as Record<string, any>)) {
        if (entry.slug === rawTarget || String(entry.gogId) === rawTarget) {
          cachedGog = entry;
          break;
        }
      }
    }
    if (!cachedGog && rawTitle) {
      const normTitle = rawTitle.toLowerCase();
      for (const entry of Object.values(gogEnrichedCache as Record<string, any>)) {
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
      const ocId = typeof cachedGog.openCritic?.id === 'number' ? cachedGog.openCritic.id : undefined;

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
        this.anchorCache.set(cacheKey, anchor);
        return anchor;
      }
    }

    // 2. Resolve GOG product slug if needed
    let slug = cachedGog?.slug;
    if (!slug) {
      if (rawTarget && !/^\d+$/.test(rawTarget)) {
        slug = rawTarget.toLowerCase();
      } else if (rawTarget && /^\d+$/.test(rawTarget)) {
        try {
          const apiRes = await axios.get(`${getGogApiBaseUrl()}/products/${rawTarget}`, {
            headers: { 'User-Agent': GOG_USER_AGENT },
            timeout: 6000,
          });
          if (apiRes.data?.slug) {
            slug = apiRes.data.slug;
          }
        } catch {
          // Gracefully continue
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
        const catalogRes = await axios.get(
          `https://catalog.gog.com/v1/catalog?query=${encodeURIComponent(cleanTitle)}&limit=1`,
          {
            headers: { 'User-Agent': GOG_USER_AGENT },
            timeout: 6000,
          }
        );
        if (Array.isArray(catalogRes.data?.products) && catalogRes.data.products.length > 0) {
          const prod = catalogRes.data.products[0];
          const prodTitle = prod.title || prod.slug?.replace(/_/g, ' ') || '';
          if (isTitleCompatible(cleanTitle, prodTitle)) {
            slug = prod.slug;
          }
        }
      } catch {
        // Gracefully continue
      }
    }

    // 3. Inspect GOG product page HTML for embedded OpenCritic or Metacritic reviews
    if (slug) {
      try {
        const productUrl = `${getGogWebBaseUrl()}/en/game/${slug}`;
        const pageRes = await axios.get(productUrl, {
          headers: { 'User-Agent': GOG_USER_AGENT },
          timeout: 7000,
        });
        const html = typeof pageRes.data === 'string' ? pageRes.data : '';

        // Extract OpenCritic Top Critic Average
        let ocScore: number | undefined;
        const ocScoreMatch =
          html.match(/class=\"circle-score__text\">\s*(\d+)\s*<\/span>\s*<\/div>\s*<span class=\"critics-rating__label\">\s*Top Critic Average/i) ||
          html.match(/stroke-dasharray=\"(\d+),\s*100\"[^>]*>\s*<\/path>[\s\S]*?Top Critic Average/i);
        if (ocScoreMatch) {
          ocScore = parseInt(ocScoreMatch[1], 10);
        }

        // Extract OpenCritic link & ID if embedded
        let ocUrl: string | undefined;
        let ocId: number | undefined;
        const ocLinkMatch = html.match(/href=[\"'](https:\/\/(?:www\.)?opencritic\.com\/game\/(\d+)\/[^\"'\s>]+)[\"']/i);
        if (ocLinkMatch) {
          ocUrl = ocLinkMatch[1];
          ocId = parseInt(ocLinkMatch[2], 10);
        } else {
          const genericOcMatch = html.match(/href=[\"'](https:\/\/(?:www\.)?opencritic\.com\/[^\s\"'>]+)[\"']/i);
          if (genericOcMatch) {
            ocUrl = genericOcMatch[1];
          }
        }

        // Extract Metacritic link & slug if embedded
        let mcUrl: string | undefined;
        let mcScore: number | undefined;
        let mcSlug: string | undefined;
        const mcLinkMatch = html.match(/href=[\"'](https:\/\/(?:www\.)?metacritic\.com\/game\/[^\s\"'>]+)[\"']/i);
        if (mcLinkMatch) {
          mcUrl = mcLinkMatch[1];
          mcSlug = extractMetacriticSlugFromUrl(mcUrl);
        }

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
          this.anchorCache.set(cacheKey, anchor);
          return anchor;
        }
      } catch {
        // Fallback gracefully on network error
      }
    }

    this.anchorCache.set(cacheKey, null);
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
        const res = await axios.post(
          getEpicGraphQLBaseUrl(),
          { query: graphqlQuery, variables: { sku } },
          {
            headers: {
              'Content-Type': 'application/json',
              'User-Agent': EPIC_LAUNCHER_USER_AGENT,
            },
            timeout: 6000,
          }
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
          this.anchorCache.set(cacheKey, anchor);
          return anchor;
        }
      } catch {
        // Fallback gracefully to next candidate
      }
    }

    // Inspect Epic Content API for external review links if not discovered via GraphQL
    if (candidateSkus.length > 0) {
      const primarySlug = candidateSkus[0].replace(/^EPIC_/i, '');
      try {
        const contentUrl = `${getEpicContentBaseUrl()}/api/en-US/content/products/${primarySlug}`;
        const contentRes = await axios.get(contentUrl, {
          headers: { 'User-Agent': 'Mozilla/5.0' },
          timeout: 6000,
        });
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
          this.anchorCache.set(cacheKey, anchor);
          return anchor;
        }
      } catch {
        // Gracefully continue
      }
    }

    this.anchorCache.set(cacheKey, null);
    return null;
  }

  /**
   * Resolves the authoritative storefront ground truth anchor for any canonical game.
   * Prioritizes Steam app IDs for verified Metascore links, cascading to GOG and Epic.
   */
  async getStorefrontAnchor(game: {
    title?: string;
    steamAppId?: number | null;
    platforms?: Array<{ platformId: string; platformGameId?: string }>;
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

    if (this.anchorCache.has(cacheKey)) {
      return this.anchorCache.get(cacheKey)!;
    }

    if (this.inFlight.has(cacheKey)) {
      return this.inFlight.get(cacheKey)!;
    }

    const promise = (async (): Promise<StorefrontReviewAnchor | null> => {
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
          this.anchorCache.set(cacheKey, steamAnchor);
          return steamAnchor;
        }
      }

      // 2. Check GOG platform
      const gogPlat = game.platforms?.find((p) => p.platformId === 'gog' || p.platformId?.toLowerCase() === 'gog');
      const gogId = gogPlat?.platformGameId || (game.id?.startsWith('gog-') ? game.id.replace('gog-', '') : undefined);
      if (gogId) {
        const gogAnchor = await this.getGogAnchor(gogId, game.title);
        if (gogAnchor) {
          this.anchorCache.set(cacheKey, gogAnchor);
          return gogAnchor;
        }
      }

      // 3. Check Epic platform
      const epicPlat = game.platforms?.find((p) => p.platformId === 'epic' || p.platformId?.toLowerCase() === 'epic');
      const epicId = epicPlat?.platformGameId || (game.id?.startsWith('epic-') ? game.id.replace('epic-', '') : undefined);
      if (epicId) {
        const epicAnchor = await this.getEpicAnchor(epicId, game.title);
        if (epicAnchor) {
          this.anchorCache.set(cacheKey, epicAnchor);
          return epicAnchor;
        }
      }

      // 4. Fallback search by title across GOG and Epic if available
      if (game.title) {
        if (!gogId) {
          const gogTitleAnchor = await this.getGogAnchor('', game.title);
          if (gogTitleAnchor) {
            this.anchorCache.set(cacheKey, gogTitleAnchor);
            return gogTitleAnchor;
          }
        }

        if (!epicId) {
          const epicTitleAnchor = await this.getEpicAnchor('', game.title);
          if (epicTitleAnchor) {
            this.anchorCache.set(cacheKey, epicTitleAnchor);
            return epicTitleAnchor;
          }
        }
      }

      this.anchorCache.set(cacheKey, null);
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
  }
}

export const storefrontReviewHarvester = new StorefrontReviewHarvester();
