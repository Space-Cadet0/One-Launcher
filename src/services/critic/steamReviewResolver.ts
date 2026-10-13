import { CriticScoreData } from '../../contracts/critic';
import { calculateSyntheticSteamScore, isSequelMismatch } from './criticUtils';
import { steamMatcher } from '../steam/steamMatcher';
import steamEnrichedCache from '../storage/steamEnrichedCache.json';

function isViteBrowserDev(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.location !== 'undefined' &&
    window.location.protocol.startsWith('http') &&
    (window.location.port === '3000' || window.location.port === '5173') &&
    typeof navigator !== 'undefined' &&
    !navigator.userAgent?.includes('jsdom') &&
    !navigator.userAgent?.includes('Node')
  );
}

export class SteamReviewResolver {
  private cache = new Map<string, CriticScoreData | null>();

  /**
   * Cleans title query for Steam store search.
   */
  private cleanQuery(title: string): string {
    return (title || '')
      .replace(/[™®©]/g, '')
      .replace(/['’]/g, '')
      .replace(/[:\-–—_]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  /**
   * Resolves authentic Steam player reviews dynamically for any title (Steam, Epic, or GOG).
   * Validates title exactness to avoid sequel or variant false matches.
   */
  async resolveScore(rawTitle: string, steamAppId?: number | null): Promise<CriticScoreData | null> {
    const title = (rawTitle || '').trim();
    if (!title && !steamAppId) return null;

    const cacheKey = steamAppId ? `id:${steamAppId}` : `title:${title.toLowerCase()}`;
    if (this.cache.has(cacheKey)) {
      return this.cache.get(cacheKey) ?? null;
    }

    let targetAppId = steamAppId || null;
    if (!targetAppId && title) {
      targetAppId = steamMatcher.matchGameToSteamInstant(title) || null;
    }

    // Check local enriched cache first to bypass network rate-limits and 403 errors
    if (targetAppId && steamEnrichedCache) {
      const enriched = (steamEnrichedCache as Record<string, any>)[String(targetAppId)];
      if (enriched?.reviewSummary && enriched.reviewSummary.totalReviews >= 10) {
        const totalReviews = enriched.reviewSummary.totalReviews;
        const positivePercent = enriched.reviewSummary.positivePercent;
        const synthetic = calculateSyntheticSteamScore(positivePercent, totalReviews);
        const result: CriticScoreData = {
          id: `steam-${targetAppId}`,
          source: 'steam',
          score: synthetic.score,
          percentRecommended: synthetic.percentRecommended,
          tier: synthetic.tier,
          numReviews: totalReviews,
          url: `https://store.steampowered.com/app/${targetAppId}`,
          summary: `Based on Steam community player reviews (${positivePercent}% positive across ${totalReviews.toLocaleString()} reviews).`,
          isVerified: false,
          isSynthetic: true,
        };
        this.cache.set(cacheKey, result);
        return result;
      }
    }

    // 1. If no AppID is supplied, query Steam storesearch dynamically
    if (!targetAppId && title) {
      try {
        const clean = this.cleanQuery(title);
        const searchUrls: string[] = [];
        if (isViteBrowserDev()) {
          searchUrls.push(`/api/steam-store/api/storesearch/?term=${encodeURIComponent(clean)}&l=english&cc=US`);
          searchUrls.push(`https://store.steampowered.com/api/storesearch/?term=${encodeURIComponent(clean)}&l=english&cc=US`);
        } else {
          searchUrls.push(`https://store.steampowered.com/api/storesearch/?term=${encodeURIComponent(clean)}&l=english&cc=US`);
        }

        for (const searchUrl of searchUrls) {
          try {
            const res = await fetch(searchUrl);
            if (res.ok) {
              const data = await res.json();
              const items: Array<{ id: number; name: string }> = data.items || [];

              for (const item of items) {
                // Check for sequel mismatch
                if (isSequelMismatch(title, item.name)) {
                  continue;
                }

                // Verify word overlap with apostrophes stripped
                const qWords = clean.toLowerCase().replace(/['’]/g, '').split(/\s+/).filter(Boolean);
                const itemWords = item.name
                  .toLowerCase()
                  .replace(/[®™©]/g, '')
                  .replace(/['’]/g, '')
                  .replace(/[^a-z0-9]/g, ' ')
                  .split(/\s+/)
                  .filter(Boolean);
                const matches = qWords.filter((w) => itemWords.includes(w));

                // Must match at least 60% of words or exact start
                const cleanNorm = clean.toLowerCase().replace(/['’]/g, '');
                const itemNorm = item.name.toLowerCase().replace(/[®™©]/g, '').replace(/['’]/g, '');
                if (matches.length / qWords.length >= 0.6 || itemNorm.startsWith(cleanNorm)) {
                  targetAppId = item.id;
                  break;
                }
              }

              if (targetAppId) break;
            }
          } catch {}
        }
      } catch (err: any) {
        console.warn(`[SteamReviewResolver] Search failed for "${title}":`, err?.message);
      }
    }

    if (!targetAppId) {
      this.cache.set(cacheKey, null);
      return null;
    }

    // 2. Fetch live reviews summary from Steam
    try {
      // 2a. Try appreviews JSON endpoint
      const reviewsUrls: string[] = [];
      if (isViteBrowserDev()) {
        reviewsUrls.push(`/api/steam-store/appreviews/${targetAppId}?json=1&purchase_type=all&language=all`);
        reviewsUrls.push(`https://store.steampowered.com/appreviews/${targetAppId}?json=1&purchase_type=all&language=all`);
      } else {
        reviewsUrls.push(`https://store.steampowered.com/appreviews/${targetAppId}?json=1&purchase_type=all&language=all`);
      }

      for (const reviewsUrl of reviewsUrls) {
        try {
          const res = await fetch(reviewsUrl);
          if (res.ok) {
            const data = await res.json();
            if (data?.success === 1) {
              const summary = data?.query_summary;

              if (summary && typeof summary.total_reviews === 'number' && summary.total_reviews >= 10) {
                const totalReviews = summary.total_reviews;
                const positiveReviews = summary.total_positive || 0;
                const positivePercent = Math.round((positiveReviews / totalReviews) * 100);

                const synthetic = calculateSyntheticSteamScore(positivePercent, totalReviews);
                const result: CriticScoreData = {
                  id: `steam-${targetAppId}`,
                  source: 'steam',
                  score: synthetic.score,
                  percentRecommended: synthetic.percentRecommended,
                  tier: synthetic.tier,
                  numReviews: totalReviews,
                  url: `https://store.steampowered.com/app/${targetAppId}`,
                  summary: `Based on Steam community player reviews (${positivePercent}% positive across ${totalReviews.toLocaleString()} reviews).`,
                  isVerified: false,
                  isSynthetic: true,
                };

                this.cache.set(cacheKey, result);
                return result;
              }
            }
          }
        } catch {}
      }

      // 2b. CDN-cached Store Page HTML fallback (handles 429 rate limit on appreviews)
      const storeUrls: string[] = [];
      if (isViteBrowserDev()) {
        storeUrls.push(`/api/steam-store/app/${targetAppId}`);
        storeUrls.push(`https://store.steampowered.com/app/${targetAppId}`);
      } else {
        storeUrls.push(`https://store.steampowered.com/app/${targetAppId}`);
      }

      for (const storeUrl of storeUrls) {
        try {
          const res = await fetch(storeUrl, {
            headers: {
              Cookie: 'birthtime=568022401; mature_content=1',
              'User-Agent':
                'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
              Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            },
          });
          if (res.ok) {
            const html = await res.text();

            let match = html.match(/itemprop="aggregateRating"[^>]*data-tooltip-html="(\d+)% of the ([\d,]+) user reviews/i);
            if (!match) {
              match = html.match(/data-tooltip-html="(\d+)% of the ([\d,]+) user reviews[^"]*"[^>]*itemprop="aggregateRating"/i);
            }
            if (!match) {
              match = html.match(/data-tooltip-html="(\d+)% of the ([\d,]+) user reviews for this game are positive/i);
            }
            if (!match) {
              match = html.match(/class="responsive_reviewdesc_short"[\s\S]*?\((\d+)% of ([\d,]+)\)/i);
            }

            if (match) {
              const positivePercent = parseInt(match[1], 10);
              const totalReviews = parseInt(match[2].replace(/,/g, ''), 10);

              if (totalReviews >= 10) {
                const synthetic = calculateSyntheticSteamScore(positivePercent, totalReviews);
                const result: CriticScoreData = {
                  id: `steam-${targetAppId}`,
                  source: 'steam',
                  score: synthetic.score,
                  percentRecommended: synthetic.percentRecommended,
                  tier: synthetic.tier,
                  numReviews: totalReviews,
                  url: `https://store.steampowered.com/app/${targetAppId}`,
                  summary: `Based on Steam community player reviews (${positivePercent}% positive across ${totalReviews.toLocaleString()} reviews).`,
                  isVerified: false,
                  isSynthetic: true,
                };

                this.cache.set(cacheKey, result);
                return result;
              }
            }
          }
        } catch {}
      }
    } catch (err: any) {
      console.warn(`[SteamReviewResolver] Reviews query failed for AppID ${targetAppId}:`, err?.message);
    }

    this.cache.set(cacheKey, null);
    return null;
  }

  clearCache(): void {
    this.cache.clear();
  }
}

export const steamReviewResolver = new SteamReviewResolver();
