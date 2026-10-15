import { CriticScoreData } from '../../contracts/critic';
import { calculateTier, isSequelMismatch, normalizeCriticTitleKey } from './criticUtils';
import { isTitleCompatible } from './metacriticResolver';
import { requestScheduler, Priority } from '../network/requestScheduler';

export class StorefrontStarResolver {
  private cache = new Map<string, CriticScoreData | null>();
  private inFlight = new Map<string, Promise<CriticScoreData | null>>();

  /**
   * Resolves storefront star rating (GOG or Epic), converting 5-star rating into 0-100 score.
   * Requires >= 4 reviews for strict anti-poisoning.
   */
  async resolveStorefrontScore(title: string): Promise<CriticScoreData | null> {
    const rawTitle = (title || '').trim();
    if (!rawTitle) return null;

    const cacheKey = rawTitle.toLowerCase();
    if (this.cache.has(cacheKey)) {
      return this.cache.get(cacheKey)!;
    }

    if (this.inFlight.has(cacheKey)) {
      return this.inFlight.get(cacheKey)!;
    }

    const promise = (async (): Promise<CriticScoreData | null> => {
      // 1. Try GOG Catalog API
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

        if (res.ok) {
          const data = await res.json();
          if (Array.isArray(data?.products) && data.products.length > 0) {
            const normalizedQuery = normalizeCriticTitleKey(cleanTitle);
            const rawWithoutParenYear = rawTitle.replace(/\s*\((?:19|20)\d{2}\)/g, '').trim();
            const queryHasExplicitFirstInstallment = /\b(?:1|i)\b/i.test(rawWithoutParenYear);

            for (const product of data.products) {
              const productTitle = product.title || '';
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
                  const storeUrl = product.storeLink || `https://www.gog.com/en/game/${product.slug}`;

                  const result: CriticScoreData = {
                    id: `gog-${product.slug || product.id}`,
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

                  this.cache.set(cacheKey, result);
                  return result;
                }
              }
            }
          }
        }
      } catch (err: any) {
        // Fallback silently if offline or network timeout
      }

      this.cache.set(cacheKey, null);
      return null;
    })().finally(() => {
      this.inFlight.delete(cacheKey);
    });

    this.inFlight.set(cacheKey, promise);
    return promise;
  }

  async resolveScore(
    input: string | { title: string; gogId?: string; epicId?: string }
  ): Promise<CriticScoreData | null> {
    const title = typeof input === 'string' ? input : input?.title || '';
    return this.resolveStorefrontScore(title);
  }

  clearCache(): void {
    this.cache.clear();
    this.inFlight.clear();
  }
}

export const storefrontStarResolver = new StorefrontStarResolver();

