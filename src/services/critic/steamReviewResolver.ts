import { CriticScoreData } from '../../contracts/critic';
import { classifyNetworkError, isWafOrChallengeResponse } from '../../contracts/network';
import { calculateSyntheticSteamScore } from './criticUtils';
import { steamMatcher } from '../steam/steamMatcher';
import { isSequelMismatch, normalizeTitleKey } from '../common/titleUtils';
import steamEnrichedCache from '../storage/steamEnrichedCache.json';
import { requestScheduler, Priority } from '../network/requestScheduler';
import { onlineLifecycleManager } from '../network/onlineLifecycleManager';

function isViteBrowserDev(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.location !== 'undefined' &&
    window.location.protocol?.startsWith('http') &&
    (window.location.port === '3000' || window.location.port === '5173') &&
    typeof navigator !== 'undefined' &&
    !navigator.userAgent?.includes('jsdom') &&
    !navigator.userAgent?.includes('Node')
  );
}

const MAX_STEAM_REVIEW_CACHE_ENTRIES = 2000;

interface EnrichedSteamReviewRecord {
  reviewSummary?: {
    totalReviews: number;
    positivePercent: number;
  };
}

const STEAM_ENRICHED_REVIEWS_MAP = steamEnrichedCache as unknown as Record<string, EnrichedSteamReviewRecord>;

function extractSteamReviewsFromHtml(html: string): { positivePercent: number; totalReviews: number } | null {
  if (typeof DOMParser !== 'undefined') {
    try {
      const doc = new DOMParser().parseFromString(html, 'text/html');
      const tooltipNodes = Array.from(doc.querySelectorAll('[data-tooltip-html]'));
      for (const node of tooltipNodes) {
        const tooltip = node.getAttribute('data-tooltip-html') || '';
        const m = tooltip.match(/(\d+)%\s+of\s+the\s+([\d,]+)\s+user\s+reviews/i);
        if (m) {
          return {
            positivePercent: parseInt(m[1], 10),
            totalReviews: parseInt(m[2].replace(/,/g, ''), 10),
          };
        }
      }
      const shortNodes = Array.from(doc.querySelectorAll('.responsive_reviewdesc_short'));
      for (const node of shortNodes) {
        const text = node.textContent || '';
        const m = text.match(/\((\d+)%\s+of\s+([\d,]+)\)/i);
        if (m) {
          return {
            positivePercent: parseInt(m[1], 10),
            totalReviews: parseInt(m[2].replace(/,/g, ''), 10),
          };
        }
      }
    } catch {
      // Fallback below
    }
  }

  const fallbackMatch =
    html.match(/itemprop="aggregateRating"[^>]*data-tooltip-html="(\d+)% of the ([\d,]+) user reviews/i) ||
    html.match(/data-tooltip-html="(\d+)% of the ([\d,]+) user reviews[^"]*"[^>]*itemprop="aggregateRating"/i) ||
    html.match(/data-tooltip-html="(\d+)% of the ([\d,]+) user reviews for this game are positive/i) ||
    html.match(/class="responsive_reviewdesc_short"[\s\S]*?\((\d+)% of ([\d,]+)\)/i);

  if (!fallbackMatch) return null;
  return {
    positivePercent: parseInt(fallbackMatch[1], 10),
    totalReviews: parseInt(fallbackMatch[2].replace(/,/g, ''), 10),
  };
}

export class SteamReviewResolver {
  private cache = new Map<string, CriticScoreData | null>();
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
    while (this.cache.size > MAX_STEAM_REVIEW_CACHE_ENTRIES) {
      const oldest = this.cache.keys().next().value;
      if (oldest === undefined) break;
      this.cache.delete(oldest);
    }
  }

  public hadTransientError(rawTitle: string, steamAppId?: number | null): boolean {
    const title = (rawTitle || '').trim();
    if (!title && !steamAppId) return false;
    const cacheKey = steamAppId ? `id:${steamAppId}` : `title:${title.toLowerCase()}`;
    return this.transientErrorKeys.has(cacheKey);
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

    this.transientErrorKeys.delete(cacheKey);

    let targetAppId = steamAppId || null;
    if (!targetAppId && title) {
      targetAppId = steamMatcher.matchGameToSteamInstant(title) || null;
    }

    // Check local enriched cache first to bypass network rate-limits and 403 errors
    if (targetAppId && STEAM_ENRICHED_REVIEWS_MAP) {
      const enriched = STEAM_ENRICHED_REVIEWS_MAP[String(targetAppId)];
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
        this.setCacheBounded(cacheKey, result);
        return result;
      }
    }

    if (!onlineLifecycleManager.isOnline()) {
      this.transientErrorKeys.add(cacheKey);
      return null;
    }

    let sawTransientError = false;

    // 1. If no AppID is supplied, search Steam Store via fetch with disjoint token guard + sibling adjacency tie-breaking
    if (!targetAppId && title) {
      try {
        const clean = title
          .replace(/[™®©]/g, '')
          .replace(/['’]/g, '')
          .replace(/[:\-–—_]/g, ' ')
          .replace(/\s+/g, ' ')
          .trim();
        const searchUrls: string[] = [];
        if (isViteBrowserDev()) {
          searchUrls.push(`/api/steam-store/api/storesearch/?term=${encodeURIComponent(clean)}&l=english&cc=US`);
          searchUrls.push(`https://store.steampowered.com/api/storesearch/?term=${encodeURIComponent(clean)}&l=english&cc=US`);
        } else {
          searchUrls.push(`https://store.steampowered.com/api/storesearch/?term=${encodeURIComponent(clean)}&l=english&cc=US`);
        }

        const stopWords = new Set(['the', 'a', 'an', 'of', 'in', 'on', 'at', 'to', 'for', 'and', 'or', 'is', 'with', 'from', 'by']);

        for (const searchUrl of searchUrls) {
          try {
            const res = await requestScheduler.schedule(
              searchUrl,
              () => fetch(searchUrl),
              Priority.P1_VIEWPORT,
              'store.steampowered.com'
            );
            if (!res.ok) {
              if (res.status === 429 || res.status >= 500 || isWafOrChallengeResponse(res.status, '')) {
                sawTransientError = true;
              }
              continue;
            }

            sawTransientError = false;
            const data: unknown = await res.json();
            const items: Array<{ id: number; name: string }> =
              data && typeof data === 'object' && Array.isArray((data as { items?: unknown }).items)
                ? ((data as { items: Array<{ id: number; name: string }> }).items)
                : [];
            let bestScore = -1;

            for (const item of items) {
              if (!item?.id || !item?.name) continue;
              if (isSequelMismatch(title, item.name)) continue;

              const qWords = clean.toLowerCase().replace(/['’]/g, '').split(/\s+/).filter(Boolean);
              const itemWords = item.name
                .toLowerCase()
                .replace(/[®™©]/g, '')
                .replace(/['’]/g, '')
                .replace(/[^a-z0-9]/g, ' ')
                .split(/\s+/)
                .filter(Boolean);

              // Disjoint substantive token guard (e.g. 'Reckoning of New York' vs 'Coteries of New York')
              const qSub = qWords.filter((w) => !/^\d+$/.test(w) && !stopWords.has(w));
              const iSub = itemWords.filter((w) => !/^\d+$/.test(w) && !stopWords.has(w));
              const qDisjoint = qSub.filter((w) => !itemWords.includes(w));
              const iDisjoint = iSub.filter((w) => !qWords.includes(w));
              if (qDisjoint.length >= 1 && iDisjoint.length >= 1) {
                continue;
              }

              const matches = qWords.filter((w) => itemWords.includes(w));
              const cleanNorm = clean.toLowerCase().replace(/['’]/g, '');
              const itemNorm = item.name.toLowerCase().replace(/[®™©]/g, '').replace(/['’]/g, '');
              const ratio = qWords.length > 0 ? matches.length / qWords.length : 0;

              if (ratio >= 0.6 || itemNorm.startsWith(cleanNorm)) {
                let score = ratio * 100 + (itemNorm === cleanNorm ? 10 : itemNorm.startsWith(cleanNorm) ? 5 : 0);
                const candId = Number(item.id);
                const candNormKey = normalizeTitleKey(item.name);

                if (candNormKey.length >= 4 && Number.isFinite(candId)) {
                  const hasAdjacentFranchiseSibling = items.some((other: { id?: number; name?: string }) => {
                    if (!other?.id || !other?.name || Number(other.id) === candId) return false;
                    const otherId = Number(other.id);
                    if (!Number.isFinite(otherId) || Math.abs(otherId - candId) > 50) return false;
                    const otherNormKey = normalizeTitleKey(other.name);
                    return otherNormKey !== candNormKey && otherNormKey.startsWith(`${candNormKey} `);
                  });
                  if (hasAdjacentFranchiseSibling) {
                    score += 15;
                  }
                }

                if (score > bestScore) {
                  bestScore = score;
                  targetAppId = candId;
                }
              }
            }

            if (targetAppId) break;
          } catch (innerErr: unknown) {
            if (classifyNetworkError(innerErr).status === 'transient_error') {
              sawTransientError = true;
            }
          }
        }
      } catch (err: unknown) {
        if (classifyNetworkError(err).status === 'transient_error') {
          sawTransientError = true;
        }
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`[SteamReviewResolver] Search failed for "${title}":`, msg);
      }
    }

    if (!targetAppId) {
      if (sawTransientError || !onlineLifecycleManager.isOnline()) {
        this.transientErrorKeys.add(cacheKey);
        return null;
      }
      this.setCacheBounded(cacheKey, null);
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

      let jsonSucceeded = false;
      for (const reviewsUrl of reviewsUrls) {
        try {
          const res = await requestScheduler.schedule(
            reviewsUrl,
            () => fetch(reviewsUrl),
            Priority.P1_VIEWPORT,
            'store.steampowered.com'
          );
          if (!res.ok) {
            if (res.status === 429 || res.status >= 500 || isWafOrChallengeResponse(res.status, '')) {
              sawTransientError = true;
            }
            continue;
          }

          const data: unknown = await res.json();
          const summaryResp =
            data && typeof data === 'object'
              ? (data as {
                  success?: number;
                  query_summary?: { total_reviews?: number; total_positive?: number };
                })
              : null;
          if (summaryResp?.success === 1) {
            jsonSucceeded = true;
            sawTransientError = false;
            const summary = summaryResp.query_summary;

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

              this.setCacheBounded(cacheKey, result);
              return result;
            }
            break;
          }
        } catch (innerErr: unknown) {
          if (classifyNetworkError(innerErr).status === 'transient_error') {
            sawTransientError = true;
          }
        }
      }

      // 2b. CDN-cached Store Page HTML fallback (only when appreviews JSON failed or was rate-limited)
      if (!jsonSucceeded) {
        const storeUrls: string[] = [];
        if (isViteBrowserDev()) {
          storeUrls.push(`/api/steam-store/app/${targetAppId}`);
          storeUrls.push(`https://store.steampowered.com/app/${targetAppId}`);
        } else {
          storeUrls.push(`https://store.steampowered.com/app/${targetAppId}`);
        }

        for (const storeUrl of storeUrls) {
          try {
            const res = await requestScheduler.schedule(
              storeUrl,
              () =>
                fetch(storeUrl, {
                  headers: {
                    Cookie: 'birthtime=568022401; mature_content=1',
                    'User-Agent':
                      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                  },
                }),
              Priority.P1_VIEWPORT,
              'store.steampowered.com'
            );
            if (!res.ok) {
              if (res.status === 429 || res.status >= 500 || isWafOrChallengeResponse(res.status, '')) {
                sawTransientError = true;
              }
              continue;
            }

            const html = await res.text();
            if (isWafOrChallengeResponse(res.status, html)) {
              sawTransientError = true;
              continue;
            }
            sawTransientError = false;

            const extracted = extractSteamReviewsFromHtml(html);
            if (extracted && extracted.totalReviews >= 10) {
              const { positivePercent, totalReviews } = extracted;
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

              this.setCacheBounded(cacheKey, result);
              return result;
            }
          } catch (innerErr: unknown) {
            if (classifyNetworkError(innerErr).status === 'transient_error') {
              sawTransientError = true;
            }
          }
        }
      }
    } catch (err: unknown) {
      if (classifyNetworkError(err).status === 'transient_error') {
        sawTransientError = true;
      }
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[SteamReviewResolver] Reviews query failed for AppID ${targetAppId}:`, msg);
    }

    if (sawTransientError || !onlineLifecycleManager.isOnline()) {
      this.transientErrorKeys.add(cacheKey);
      return null;
    }

    this.setCacheBounded(cacheKey, null);
    return null;
  }

  clearCache(): void {
    this.cache.clear();
    this.transientErrorKeys.clear();
  }
}

export const steamReviewResolver = new SteamReviewResolver();
