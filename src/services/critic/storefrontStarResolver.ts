import { CriticScoreData } from '../../contracts/critic';
import { classifyNetworkError, isWafOrChallengeResponse } from '../../contracts/network';
import { calculateTier, isSequelMismatch, normalizeCriticTitleKey } from './criticUtils';
import { isTitleCompatible } from './metacriticResolver';
import { requestScheduler, Priority } from '../network/requestScheduler';
import { onlineLifecycleManager } from '../network/onlineLifecycleManager';

const MAX_STAR_CACHE_ENTRIES = 2000;

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

export class StorefrontStarResolver {
  private cache = new Map<string, CriticScoreData | null>();
  private inFlight = new Map<string, Promise<CriticScoreData | null>>();
  private transientErrorKeys = new Set<string>();

  constructor() {
    try {
      onlineLifecycleManager.onOnline(() => {
        this.transientErrorKeys.clear();
      });
    } catch {}
  }

  private setCacheBounded(key: string, val: CriticScoreData | null): void {
    if (this.cache.has(key)) {
      this.cache.delete(key);
    }
    this.cache.set(key, val);
    while (this.cache.size > MAX_STAR_CACHE_ENTRIES) {
      const oldest = this.cache.keys().next().value;
      if (oldest === undefined) break;
      this.cache.delete(oldest);
    }
  }

  public hadRecentTransientFailure(title: string): boolean {
    const rawTitle = (title || '').trim();
    if (!rawTitle) return false;
    return this.transientErrorKeys.has(rawTitle.toLowerCase());
  }

  /**
   * Resolves storefront star rating (GOG, Epic, or Xbox / Microsoft Store), converting 5-star rating into 0-100 score.
   * Requires >= 4 reviews for strict anti-poisoning.
   */
  async resolveStorefrontScore(
    input: string | { title: string; gogId?: string; epicId?: string; xboxProductId?: string }
  ): Promise<CriticScoreData | null> {
    const rawTitle = (typeof input === 'string' ? input : input?.title || '').trim();
    const xboxProductId = typeof input === 'object' ? input?.xboxProductId?.trim() : undefined;
    if (!rawTitle && !xboxProductId) return null;

    const cacheKey = xboxProductId
      ? `xbox:${xboxProductId.toLowerCase()}:${rawTitle.toLowerCase()}`
      : rawTitle.toLowerCase();
    if (this.cache.has(cacheKey)) {
      return this.cache.get(cacheKey)!;
    }

    if (!onlineLifecycleManager.isOnline()) {
      if (rawTitle) this.transientErrorKeys.add(rawTitle.toLowerCase());
      return null;
    }

    if (this.inFlight.has(cacheKey)) {
      return this.inFlight.get(cacheKey)!;
    }

    if (rawTitle) this.transientErrorKeys.delete(rawTitle.toLowerCase());

    const promise = (async (): Promise<CriticScoreData | null> => {
      let sawTransientError = false;
      // 1. Try GOG Catalog API
      if (rawTitle) {
        try {
          const cleanTitle = rawTitle
            .replace(/[®™©]/g, '')
            .replace(/['’ʼ`]/g, '')
            .replace(/[:\-–—_+]/g, ' ')
            .replace(
              /\b(standard|deluxe|gold|silver|platinum|diamond|collector'?s|ultimate|complete|special|limited|definitive|enhanced|extended|enchanted|anniversary|directors-cut|director'?s cut|goty|game of the year|remastered|remake)( edition| pack| bundle| collection)?\b/gi,
              ''
            )
            .replace(/\s+/g, ' ')
            .trim();

          const queryUrl = `https://catalog.gog.com/v1/catalog?query=${encodeURIComponent(cleanTitle)}&limit=5`;
          const res = await requestScheduler.schedule(
            queryUrl,
            () =>
              fetch(queryUrl, {
                headers: {
                  'User-Agent':
                    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
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
            if (res.status === 429 || res.status >= 500 || isWafOrChallengeResponse(res.status, '')) {
              sawTransientError = true;
            }
          } else {
            const data: unknown = await res.json();
            const products =
              data && typeof data === 'object' && Array.isArray((data as { products?: unknown }).products)
                ? ((data as { products: Array<Record<string, unknown>> }).products)
                : [];
            if (products.length > 0) {
              const normalizedQuery = normalizeCriticTitleKey(cleanTitle);
              const rawWithoutParenYear = rawTitle.replace(/\s*\((?:19|20)\d{2}\)/g, '').trim();
              const queryHasExplicitFirstInstallment = /\b(?:1|i)\b/i.test(rawWithoutParenYear);

              for (const product of products) {
                const productTitle = typeof product.title === 'string' ? product.title : '';
                const productSlug = String(product.slug || '');
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

                // Strict bidirectional title compatibility and sequel check
                const isMatch =
                  normalizedQuery === normalizedProduct ||
                  (!isSequelMismatch(rawTitle, productTitle) &&
                    isTitleCompatible(rawTitle, productTitle) &&
                    isTitleCompatible(productTitle, rawTitle));

                if (isMatch) {
                  const reviewsRating = typeof product.reviewsRating === 'number' ? product.reviewsRating : 0;
                  const reviewsCount = typeof product.reviewsCount === 'number' ? product.reviewsCount : 0;

                  // Strict threshold: >= 4 reviews and valid rating > 0
                  if (reviewsRating > 0 && reviewsCount >= 4) {
                    // reviewsRating is out of 50 (e.g. 41 = 4.1/5 stars)
                    const starRatingRaw = Math.round((reviewsRating / 10) * 10) / 10;
                    const score = Math.min(100, Math.max(1, Math.round(starRatingRaw * 20)));
                    const tier = calculateTier(score);
                    const storeUrl =
                      typeof product.storeLink === 'string' && product.storeLink
                        ? product.storeLink
                        : `https://www.gog.com/en/game/${productSlug}`;

                    const result: CriticScoreData = {
                      id: `gog-${productSlug || String(product.id || '')}`,
                      source: 'gog',
                      score,
                      starRatingRaw,
                      tier,
                      numReviews: reviewsCount,
                      url: storeUrl,
                      summary: `GOG player rating (${starRatingRaw}/5 stars based on ${reviewsCount.toLocaleString()} ratings).`,
                      isVerified: false,
                      isSynthetic: false,
                    };

                    this.setCacheBounded(cacheKey, result);
                    return result;
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

      // 2. Try Xbox / Microsoft Store DisplayCatalog player rating via IPC
      if (typeof window !== 'undefined' && window.electronAPI?.fetchXboxProductMetadata) {
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
                !isSequelMismatch(rawTitle, metaTitle) &&
                isTitleCompatible(rawTitle, metaTitle));

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

            if (isCompatibleXboxMatch && avgRating > 0 && ratingCount >= 4) {
              const starRatingRaw = Math.round(Math.min(5, avgRating) * 10) / 10;
              const score = Math.min(100, Math.max(1, Math.round(starRatingRaw * 20)));
              const tier = calculateTier(score);
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
                score,
                starRatingRaw,
                tier,
                numReviews: ratingCount,
                url: storeUrl,
                summary: `Xbox / Microsoft Store player rating (${starRatingRaw}/5 stars based on ${ratingCount.toLocaleString()} ratings).`,
                isVerified: false,
                isSynthetic: false,
              };

              this.setCacheBounded(cacheKey, xboxResult);
              return xboxResult;
            }
          }
        } catch (err: unknown) {
          if (classifyNetworkError(err).status === 'transient_error') {
            sawTransientError = true;
          }
        }
      }

      if (sawTransientError || !onlineLifecycleManager.isOnline()) {
        if (rawTitle) this.transientErrorKeys.add(rawTitle.toLowerCase());
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
    input: string | { title: string; gogId?: string; epicId?: string; xboxProductId?: string }
  ): Promise<CriticScoreData | null> {
    return this.resolveStorefrontScore(input);
  }

  clearCache(): void {
    this.cache.clear();
    this.inFlight.clear();
    this.transientErrorKeys.clear();
  }
}

export const storefrontStarResolver = new StorefrontStarResolver();

