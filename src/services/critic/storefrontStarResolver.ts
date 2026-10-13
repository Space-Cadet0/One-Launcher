import { CriticScoreData } from '../../contracts/critic';
import { calculateTier, isSequelMismatch, normalizeCriticTitleKey } from './criticUtils';

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
          .replace(/[:\-–—_+]/g, ' ')
          .replace(
            /\b(standard|deluxe|gold|silver|platinum|diamond|collector'?s|ultimate|complete|special|limited|definitive|enhanced|anniversary|directors-cut|director'?s cut|goty|game of the year|remastered|remake)( edition| pack| bundle| collection)?\b/gi,
            ''
          )
          .replace(/\s+/g, ' ')
          .trim();

        const queryUrl = `https://catalog.gog.com/v1/catalog?query=${encodeURIComponent(cleanTitle)}&limit=5`;
        const res = await fetch(queryUrl, {
          headers: {
            'User-Agent':
              'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            Accept: 'application/json',
          },
          signal:
            typeof AbortSignal !== 'undefined' && 'timeout' in AbortSignal
              ? AbortSignal.timeout(6000)
              : undefined,
        });

        if (res.ok) {
          const data = await res.json();
          if (Array.isArray(data?.products) && data.products.length > 0) {
            const normalizedQuery = normalizeCriticTitleKey(cleanTitle);

            for (const product of data.products) {
              const productTitle = product.title || '';
              const normalizedProduct = normalizeCriticTitleKey(productTitle);

              // Strict title compatibility check: require token overlap and no sequel mismatch
              let isMatch = false;
              if (normalizedQuery === normalizedProduct) {
                isMatch = true;
              } else if (!isSequelMismatch(cleanTitle, productTitle)) {
                if (normalizedProduct.includes(normalizedQuery) || normalizedQuery.includes(normalizedProduct)) {
                  isMatch = true;
                } else {
                  const qTokens = normalizedQuery.split(' ').filter((t) => t.length > 1);
                  const pTokens = normalizedProduct.split(' ').filter((t) => t.length > 1);
                  if (qTokens.length > 0 && pTokens.length > 0) {
                    const shared = qTokens.filter((t) => pTokens.includes(t));
                    const ratio = shared.length / Math.min(qTokens.length, pTokens.length);
                    if (ratio >= 0.6) {
                      isMatch = true;
                    }
                  }
                }
              }

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

  clearCache(): void {
    this.cache.clear();
    this.inFlight.clear();
  }
}

export const storefrontStarResolver = new StorefrontStarResolver();
