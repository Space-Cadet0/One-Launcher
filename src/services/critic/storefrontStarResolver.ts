import { CriticScoreData, CriticTier } from '../../contracts/critic';
import { classifyNetworkError, isWafOrChallengeResponse } from '../../contracts/network';
import { calculateTier, isSequelMismatch, normalizeCriticTitleKey } from './criticUtils';
import type { CriticScoreContext } from './criticScoreService';
import {
  isIntermediateNumeralSubtitleMatch,
  normalizeTitleForStoreSearch,
  stripPackagingEditionPhrases,
} from '../common/titleUtils';
import { isTitleCompatible } from './metacriticResolver';
import { requestScheduler, Priority } from '../network/requestScheduler';
import { onlineLifecycleManager } from '../network/onlineLifecycleManager';

const MAX_STAR_CACHE_ENTRIES = 2000;
const NEGATIVE_STAR_CACHE_TTL_MS = 15 * 60 * 1000; // 15 min bounded TTL for genuine misses
const MIN_STOREFRONT_STAR_REVIEWS = 4;
const XBOX_PRODUCT_ID_RE = /^[A-Z0-9]{12}$/i;

export interface StorefrontStarLookupInput {
  title: string;
  gogId?: string;
  epicId?: string;
  xboxProductId?: string;
  context?: CriticScoreContext;
}

interface StorefrontStarCacheEntry {
  data: CriticScoreData | null;
  cachedAt: number;
}

interface XboxStarMetadataRecord {
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
  xboxProductId?: string;
  productId?: string;
  storeUrl?: string;
  product?: Record<string, unknown>;
  results?: Array<Record<string, unknown>>;
}

/**
 * Normalizes a 5-star (scale = 5) or 50-point GOG (scale = 50) storefront rating
 * into a 1-decimal raw star rating, bounded 1..100 score, and canonical CriticTier.
 */
export function normalizeStorefrontStarRating(
  rawRating: number,
  scale: 5 | 50 = 5
): { starRatingRaw: number; score: number; tier: CriticTier } | null {
  if (typeof rawRating !== 'number' || !Number.isFinite(rawRating) || rawRating <= 0) {
    return null;
  }
  const normalizedStars = scale === 50 ? rawRating / 10 : rawRating;
  const clampedStars = Math.max(0.1, Math.min(5, normalizedStars));
  const starRatingRaw = Math.round(clampedStars * 10) / 10;
  const score = Math.min(100, Math.max(1, Math.round(starRatingRaw * 20)));
  const tier = calculateTier(score);
  return { starRatingRaw, score, tier };
}

function resolveContextEntitlements(
  input: string | StorefrontStarLookupInput,
  explicitContext?: CriticScoreContext
): {
  rawTitle: string;
  gogId?: string;
  epicId?: string;
  xboxProductId?: string;
  gameId?: string;
  hasExplicitPlatforms: boolean;
  hasXboxPlatform: boolean;
  hasGogPlatform: boolean;
  hasEpicPlatform: boolean;
} {
  const inputObj = typeof input === 'object' && input !== null ? input : undefined;
  const rawTitle = (typeof input === 'string' ? input : inputObj?.title || '').trim();
  const context = explicitContext ?? inputObj?.context;
  const platforms = Array.isArray(context?.platforms) ? context.platforms : [];
  const hasExplicitPlatforms = platforms.length > 0;

  let gogId = inputObj?.gogId?.trim() || undefined;
  let epicId = inputObj?.epicId?.trim() || undefined;
  let xboxProductId = inputObj?.xboxProductId?.trim() || undefined;
  let hasXboxPlatform = Boolean(xboxProductId);
  let hasGogPlatform = Boolean(gogId);
  let hasEpicPlatform = Boolean(epicId);

  for (const plat of platforms) {
    const pid = String(plat.platformId || '').toLowerCase();
    if (pid === 'xbox') {
      hasXboxPlatform = true;
      if (!xboxProductId) {
        const candidateId = plat.xboxProductId?.trim() || plat.platformGameId?.trim() || '';
        if (candidateId && XBOX_PRODUCT_ID_RE.test(candidateId)) {
          xboxProductId = candidateId;
        }
      }
    } else if (pid === 'gog') {
      hasGogPlatform = true;
      if (!gogId && plat.platformGameId?.trim()) {
        gogId = plat.platformGameId.trim();
      }
    } else if (pid === 'epic') {
      hasEpicPlatform = true;
      if (!epicId && plat.platformGameId?.trim()) {
        epicId = plat.platformGameId.trim();
      }
    }
  }

  return {
    rawTitle,
    gogId,
    epicId,
    xboxProductId,
    gameId: context?.gameId?.trim() || undefined,
    hasExplicitPlatforms,
    hasXboxPlatform,
    hasGogPlatform,
    hasEpicPlatform,
  };
}

export class StorefrontStarResolver {
  private cache = new Map<string, StorefrontStarCacheEntry>();
  private cacheKeysByTitle = new Map<string, Set<string>>();
  private cacheKeysByXboxId = new Map<string, Set<string>>();
  private inFlight = new Map<string, Promise<CriticScoreData | null>>();
  private transientErrorKeys = new Set<string>();

  constructor() {
    try {
      onlineLifecycleManager.onOnline(() => {
        this.transientErrorKeys.clear();
      });
    } catch {}
  }

  private extractKeyParts(key: string): { titleLower?: string; xboxIdLower?: string } {
    if (key.startsWith('xbox:')) {
      const rest = key.slice(5);
      const sep = rest.indexOf(':');
      if (sep >= 0) {
        return {
          xboxIdLower: rest.slice(0, sep) || undefined,
          titleLower: rest.slice(sep + 1) || undefined,
        };
      }
      return { xboxIdLower: rest || undefined };
    }
    if (key.startsWith('gog:') || key.startsWith('epic:') || key.startsWith('game:')) {
      const firstSep = key.indexOf(':');
      const secondSep = key.indexOf(':', firstSep + 1);
      if (secondSep >= 0) {
        return { titleLower: key.slice(secondSep + 1) || undefined };
      }
    }
    return { titleLower: key || undefined };
  }

  private indexCacheKey(key: string): void {
    const { titleLower, xboxIdLower } = this.extractKeyParts(key);
    if (titleLower) {
      let set = this.cacheKeysByTitle.get(titleLower);
      if (!set) {
        set = new Set<string>();
        this.cacheKeysByTitle.set(titleLower, set);
      }
      set.add(key);
    }
    if (xboxIdLower) {
      let set = this.cacheKeysByXboxId.get(xboxIdLower);
      if (!set) {
        set = new Set<string>();
        this.cacheKeysByXboxId.set(xboxIdLower, set);
      }
      set.add(key);
    }
  }

  private unindexCacheKey(key: string): void {
    const { titleLower, xboxIdLower } = this.extractKeyParts(key);
    if (titleLower) {
      const set = this.cacheKeysByTitle.get(titleLower);
      if (set) {
        set.delete(key);
        if (set.size === 0) this.cacheKeysByTitle.delete(titleLower);
      }
    }
    if (xboxIdLower) {
      const set = this.cacheKeysByXboxId.get(xboxIdLower);
      if (set) {
        set.delete(key);
        if (set.size === 0) this.cacheKeysByXboxId.delete(xboxIdLower);
      }
    }
  }

  private setCacheBounded(key: string, val: CriticScoreData | null): void {
    if (this.cache.has(key)) {
      this.cache.delete(key);
    }
    this.cache.set(key, { data: val, cachedAt: Date.now() });
    this.indexCacheKey(key);
    while (this.cache.size > MAX_STAR_CACHE_ENTRIES) {
      const oldest = this.cache.keys().next().value;
      if (oldest === undefined) break;
      this.cache.delete(oldest);
      this.unindexCacheKey(oldest);
    }
  }

  public hadRecentTransientFailure(title: string): boolean {
    const rawTitle = (title || '').trim();
    if (!rawTitle) return false;
    return this.transientErrorKeys.has(rawTitle.toLowerCase());
  }

  private async queryGogCatalogRating(
    rawTitle: string,
    gogId?: string
  ): Promise<{ result: CriticScoreData | null; sawTransientError: boolean }> {
    if (!rawTitle) return { result: null, sawTransientError: false };
    let sawTransientError = false;
    try {
      const packagingCleaned = stripPackagingEditionPhrases(rawTitle);
      const cleanTitle =
        normalizeTitleForStoreSearch(packagingCleaned, { stripEditions: true }) ||
        normalizeTitleForStoreSearch(rawTitle, { stripEditions: true }) ||
        normalizeTitleForStoreSearch(rawTitle);

      const cleanLike = cleanTitle.replace(/^like:/i, '').trim();
      const queryUrl = `https://catalog.gog.com/v1/catalog?query=${encodeURIComponent(`like:${cleanLike}`)}&limit=5`;
      const res = await requestScheduler.schedule(
        queryUrl,
        () =>
          fetch(queryUrl, {
            headers: {
              Accept: 'application/json',
            },
            signal:
              typeof AbortSignal !== 'undefined' && 'timeout' in AbortSignal
                ? AbortSignal.timeout(6000)
                : undefined,
          }),
        Priority.P1_VIEWPORT,
        'catalog.gog.com'
      );

      if (!res.ok) {
        if (res.status === 429 || res.status >= 500 || isWafOrChallengeResponse(res.status, '', res.headers, true)) {
          sawTransientError = true;
        }
        return { result: null, sawTransientError };
      }

      const data: unknown = await res.json();
      const hasZeroMatches =
        Boolean(data && typeof data === 'object') &&
        typeof (data as { productCount?: unknown }).productCount === 'number' &&
        (data as { productCount: number }).productCount <= 0;
      const products =
        !hasZeroMatches &&
        data &&
        typeof data === 'object' &&
        Array.isArray((data as { products?: unknown }).products)
          ? (data as { products: Array<Record<string, unknown>> }).products
          : [];
      if (products.length === 0) {
        return { result: null, sawTransientError };
      }

      const normalizedQuery = normalizeCriticTitleKey(cleanTitle);
      const rawWithoutParenYear = rawTitle.replace(/\s*[\(\[]\s*(?:19|20)\d{2}\s*[\)\]]/g, '').trim();
      const queryHasExplicitFirstInstallment = /\b(?:1|i)\b/i.test(rawWithoutParenYear);

      for (const product of products) {
        const productTitle = typeof product.title === 'string' ? product.title : '';
        const productSlug = String(product.slug || '');
        const productId = String(product.id || '').trim();
        const normalizedProduct = normalizeCriticTitleKey(productTitle);

        // Reject GOG demos, prologues, soundtracks, or DLCs when query is a full game
        const nonGamePattern = /\b(demo|prologue|soundtrack|ost|artbook|dlc|upgrade|walkthrough)\b/i;
        if (
          nonGamePattern.test(`${productTitle} ${productSlug.replace(/_/g, ' ')}`) &&
          !nonGamePattern.test(rawTitle)
        ) {
          continue;
        }

        // Reject modern unnumbered reboot slugs (e.g. 'doom_2016') when query explicitly specifies installment 1/I ('DOOM I Enhanced')
        if (
          queryHasExplicitFirstInstallment &&
          !/\b(?:1|i)\b/i.test(productTitle) &&
          /_(201\d|202\d)\b/i.test(productSlug)
        ) {
          continue;
        }

        const isExactGogIdMatch = Boolean(gogId && productId && productId === gogId);
        // Strict bidirectional title compatibility and sequel check
        const isMatch =
          isExactGogIdMatch ||
          normalizedQuery === normalizedProduct ||
          isIntermediateNumeralSubtitleMatch(rawTitle, productTitle) ||
          (!isSequelMismatch(rawTitle, productTitle) &&
            isTitleCompatible(rawTitle, productTitle) &&
            isTitleCompatible(productTitle, rawTitle));

        if (isMatch) {
          const reviewsRating = typeof product.reviewsRating === 'number' ? product.reviewsRating : 0;
          const reviewsCount = typeof product.reviewsCount === 'number' ? product.reviewsCount : 0;

          // Strict threshold: >= 4 reviews and valid rating > 0
          if (reviewsRating > 0 && reviewsCount >= MIN_STOREFRONT_STAR_REVIEWS) {
            const normalized = normalizeStorefrontStarRating(reviewsRating, 50);
            if (!normalized) continue;
            const storeUrl =
              typeof product.storeLink === 'string' && product.storeLink
                ? product.storeLink
                : `https://www.gog.com/en/game/${productSlug}`;

            const result: CriticScoreData = {
              id: `gog-${productSlug || productId}`,
              source: 'gog',
              score: normalized.score,
              starRatingRaw: normalized.starRatingRaw,
              tier: normalized.tier,
              numReviews: reviewsCount,
              url: storeUrl,
              summary: `GOG player rating (${normalized.starRatingRaw}/5 stars based on ${reviewsCount.toLocaleString()} ratings).`,
              isVerified: false,
              isSynthetic: false,
            };
            return { result, sawTransientError: false };
          }
        }
      }
    } catch (err: unknown) {
      if (classifyNetworkError(err).status === 'transient_error') {
        sawTransientError = true;
      }
    }
    return { result: null, sawTransientError };
  }

  private async queryXboxStoreRating(
    rawTitle: string,
    xboxProductId?: string
  ): Promise<{ result: CriticScoreData | null; sawTransientError: boolean }> {
    if (typeof window === 'undefined' || !window.electronAPI?.fetchXboxProductMetadata) {
      return { result: null, sawTransientError: false };
    }
    let sawTransientError = false;
    try {
      const rawMetaUnknown: unknown = await window.electronAPI.fetchXboxProductMetadata({
        xboxProductId,
        productId: xboxProductId,
        title: rawTitle || undefined,
      });
      const rawMeta =
        rawMetaUnknown && typeof rawMetaUnknown === 'object'
          ? (rawMetaUnknown as XboxStarMetadataRecord)
          : null;
      const meta: XboxStarMetadataRecord | null =
        rawMeta?.product && typeof rawMeta.product === 'object'
          ? { ...rawMeta, ...(rawMeta.product as XboxStarMetadataRecord) }
          : Array.isArray(rawMeta?.results) && rawMeta?.results[0]
          ? { ...rawMeta, ...(rawMeta.results[0] as XboxStarMetadataRecord) }
          : rawMeta;
      if (meta && typeof meta === 'object') {
        const metaTitle = String(meta.title || meta.name || '').trim();
        const isCompatibleXboxMatch =
          Boolean(xboxProductId) ||
          (Boolean(rawTitle && metaTitle) &&
            (isIntermediateNumeralSubtitleMatch(rawTitle, metaTitle) ||
              (!isSequelMismatch(rawTitle, metaTitle) && isTitleCompatible(rawTitle, metaTitle))));

        const avgRating = Number(
          meta.averageRating ??
            meta.starRating ??
            meta.reviewSummary?.averageRating ??
            0
        );
        const ratingCount = Number(
          meta.ratingCount ??
            meta.reviewCount ??
            meta.reviewSummary?.totalReviews ??
            0
        );

        if (
          isCompatibleXboxMatch &&
          Number.isFinite(avgRating) &&
          avgRating > 0 &&
          Number.isFinite(ratingCount) &&
          ratingCount >= MIN_STOREFRONT_STAR_REVIEWS
        ) {
          const normalized = normalizeStorefrontStarRating(avgRating, 5);
          if (normalized) {
            const resolvedProductId = String(
              meta.xboxProductId || meta.productId || xboxProductId || ''
            ).trim();
            const storeUrl =
              meta.storeUrl ||
              (resolvedProductId
                ? `https://www.xbox.com/games/store/-/${resolvedProductId}`
                : `https://www.xbox.com/en-us/search?q=${encodeURIComponent(rawTitle)}`);

            const xboxResult: CriticScoreData = {
              id: `xbox-${resolvedProductId || rawTitle.toLowerCase()}`,
              source: 'xbox',
              score: normalized.score,
              starRatingRaw: normalized.starRatingRaw,
              tier: normalized.tier,
              numReviews: ratingCount,
              url: storeUrl,
              summary: `Xbox / Microsoft Store player rating (${normalized.starRatingRaw}/5 stars based on ${ratingCount.toLocaleString()} ratings).`,
              isVerified: false,
              isSynthetic: false,
            };

            return { result: xboxResult, sawTransientError: false };
          }
        }
      }
    } catch (err: unknown) {
      if (classifyNetworkError(err).status === 'transient_error') {
        sawTransientError = true;
      }
    }
    return { result: null, sawTransientError };
  }

  /**
   * Resolves storefront star rating (GOG, Epic, or Xbox / Microsoft Store), converting 5-star rating into 0-100 score.
   * Honors optional CriticScoreContext entitlement scoping and requires >= 4 reviews for strict anti-poisoning.
   */
  async resolveStorefrontScore(
    input: string | StorefrontStarLookupInput,
    context?: CriticScoreContext
  ): Promise<CriticScoreData | null> {
    const resolved = resolveContextEntitlements(input, context);
    const {
      rawTitle,
      gogId,
      epicId,
      xboxProductId,
      gameId,
      hasExplicitPlatforms,
      hasXboxPlatform,
      hasGogPlatform,
    } = resolved;
    if (!rawTitle && !xboxProductId) return null;

    const titleLower = rawTitle.toLowerCase();
    const cacheKey = xboxProductId
      ? `xbox:${xboxProductId.toLowerCase()}:${titleLower}`
      : gogId
      ? `gog:${gogId.toLowerCase()}:${titleLower}`
      : epicId
      ? `epic:${epicId.toLowerCase()}:${titleLower}`
      : gameId
      ? `game:${gameId.toLowerCase()}:${titleLower}`
      : titleLower;

    if (this.cache.has(cacheKey)) {
      const entry = this.cache.get(cacheKey)!;
      if (entry.data !== null) {
        return entry.data;
      }
      if (Date.now() - entry.cachedAt < NEGATIVE_STAR_CACHE_TTL_MS) {
        return null;
      }
      this.cache.delete(cacheKey);
      this.unindexCacheKey(cacheKey);
    }

    if (!onlineLifecycleManager.isOnline()) {
      if (rawTitle) this.transientErrorKeys.add(titleLower);
      return null;
    }

    if (this.inFlight.has(cacheKey)) {
      return this.inFlight.get(cacheKey)!;
    }

    if (rawTitle) this.transientErrorKeys.delete(titleLower);

    const promise = (async (): Promise<CriticScoreData | null> => {
      let sawTransientError = false;
      const allowXboxQuery = !hasExplicitPlatforms || hasXboxPlatform || Boolean(xboxProductId);
      const preferXboxFirst = Boolean(xboxProductId) && !hasGogPlatform;

      if (preferXboxFirst && allowXboxQuery) {
        const xboxFirst = await this.queryXboxStoreRating(rawTitle, xboxProductId);
        if (xboxFirst.sawTransientError) sawTransientError = true;
        if (xboxFirst.result) {
          this.setCacheBounded(cacheKey, xboxFirst.result);
          return xboxFirst.result;
        }
      }

      // 1. Try GOG Catalog API
      if (rawTitle) {
        const gogOutcome = await this.queryGogCatalogRating(rawTitle, gogId);
        if (gogOutcome.sawTransientError) sawTransientError = true;
        if (gogOutcome.result) {
          this.setCacheBounded(cacheKey, gogOutcome.result);
          return gogOutcome.result;
        }
      }

      // 2. Try Xbox / Microsoft Store DisplayCatalog player rating via IPC (if entitled or unscoped)
      if (!preferXboxFirst && allowXboxQuery) {
        const xboxOutcome = await this.queryXboxStoreRating(rawTitle, xboxProductId);
        if (xboxOutcome.sawTransientError) sawTransientError = true;
        if (xboxOutcome.result) {
          this.setCacheBounded(cacheKey, xboxOutcome.result);
          return xboxOutcome.result;
        }
      }

      if (sawTransientError || !onlineLifecycleManager.isOnline()) {
        if (rawTitle) this.transientErrorKeys.add(titleLower);
        return null;
      }

      this.setCacheBounded(cacheKey, null);
      return null;
    })().finally(() => {
      this.inFlight.delete(cacheKey);
    });

    this.inFlight.set(cacheKey, promise);
    return promise;
  }

  async resolveScore(
    input: string | StorefrontStarLookupInput,
    context?: CriticScoreContext
  ): Promise<CriticScoreData | null> {
    return this.resolveStorefrontScore(input, context);
  }

  public evictForGame(rawTitle?: string | null, xboxProductId?: string | null): void {
    const keysToDelete = new Set<string>();
    const titleLower = (rawTitle || '').trim().toLowerCase();
    const xboxIdLower = (xboxProductId || '').trim().toLowerCase();

    if (titleLower) {
      this.transientErrorKeys.delete(titleLower);
      keysToDelete.add(titleLower);
      const indexedByTitle = this.cacheKeysByTitle.get(titleLower);
      if (indexedByTitle) {
        for (const k of indexedByTitle) keysToDelete.add(k);
      }
      const normTitle = normalizeCriticTitleKey(titleLower);
      if (normTitle && normTitle !== titleLower) {
        this.transientErrorKeys.delete(normTitle);
        keysToDelete.add(normTitle);
        const indexedByNorm = this.cacheKeysByTitle.get(normTitle);
        if (indexedByNorm) {
          for (const k of indexedByNorm) keysToDelete.add(k);
        }
      }
    }

    if (xboxIdLower) {
      const indexedByXbox = this.cacheKeysByXboxId.get(xboxIdLower);
      if (indexedByXbox) {
        for (const k of indexedByXbox) keysToDelete.add(k);
      }
      if (titleLower) {
        keysToDelete.add(`xbox:${xboxIdLower}:${titleLower}`);
      }
    }

    for (const k of keysToDelete) {
      this.cache.delete(k);
      this.inFlight.delete(k);
      this.unindexCacheKey(k);
    }
  }

  clearCache(): void {
    this.cache.clear();
    this.cacheKeysByTitle.clear();
    this.cacheKeysByXboxId.clear();
    this.inFlight.clear();
    this.transientErrorKeys.clear();
  }
}

export const storefrontStarResolver = new StorefrontStarResolver();

