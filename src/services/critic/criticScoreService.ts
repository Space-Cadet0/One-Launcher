import { CriticScoreData, CriticTier, OpenCriticData, StorefrontReviewAnchor } from '../../contracts/critic';
import { KNOWN_CRITIC_SCORES, KNOWN_UNRATED_TITLES } from './knownCriticScores';
import steamEnrichedCache from '../storage/steamEnrichedCache.json';
import {
  calculateSyntheticSteamScore,
  calculateTier,
  getTierColor,
  normalizeCriticTitleKey,
  stripEditionSuffix,
  isSequelMismatch,
} from './criticUtils';
import { metacriticResolver, isTitleCompatible } from './metacriticResolver';
import { steamReviewResolver } from './steamReviewResolver';
import { storefrontStarResolver } from './storefrontStarResolver';
import { storefrontReviewHarvester } from './storefrontReviewHarvester';

// Re-export master dataset, utilities and exclusions for consumers and tests
export {
  KNOWN_CRITIC_SCORES,
  KNOWN_UNRATED_TITLES,
  calculateSyntheticSteamScore,
  calculateTier,
  getTierColor,
  normalizeCriticTitleKey,
  stripEditionSuffix,
  isSequelMismatch,
  storefrontStarResolver,
};

const OPENCRITIC_BEARER_TOKEN = 'Bearer R2tBRkdvUU9WSHpoUXpaSXVYa2g5cGU5NEFsWUgyeXQ=';

/**
 * Unified Critic Score Service with Cascading Live Multi-Tier Resolution:
 * 1. Instant Cache & Master Dataset (0ms).
 * 2. Tier 1: Metacritic Live Critic Metascore (verified press consensus, >= 4 reviews).
 * 3. Tier 2: OpenCritic Live API (verified press consensus, >= 4 reviews).
 * 4. Tier 3: Metacritic Live User Score (authentic player sentiment, >= 4 user reviews).
 * 5. Tier 4: Steam Live Community Reviews (authentic player sentiment, >= 10 reviews).
 * 6. Tier 5: Storefront Star Rating (GOG/Epic 5-star rating converted to 0-100, >= 4 reviews).
 * 7. Tier 6: Null / Truly Unrated (betas, dev tools, internal playtests).
 */
const STORAGE_PREFIX = 'antigravity_critic_v8_';
const PREV_STORAGE_PREFIX = 'antigravity_critic_v7_';
const LEGACY_STORAGE_PREFIX = 'antigravity_critic_score_';

class CriticScoreService {
  private inMemoryCache = new Map<string, CriticScoreData | null>();
  private inFlightResolutions = new Map<string, Promise<CriticScoreData | null>>();
  private attemptedDynamicResolutions = new Set<string>();

  constructor() {
    this.purgeLegacyScores();
    this.purgeStaleNullScores();
  }

  /**
   * Cleanses all stale unversioned and previous version score keys from localStorage.
   */
  public purgeLegacyScores(): void {
    if (typeof localStorage === 'undefined') return;
    try {
      const keysToRemove: string[] = [];
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (
          key &&
          (key.startsWith(LEGACY_STORAGE_PREFIX) ||
            key.startsWith(PREV_STORAGE_PREFIX) ||
            key.startsWith('antigravity_critic_v6_') ||
            key.startsWith('antigravity_critic_v5_'))
        ) {
          keysToRemove.push(key);
        }
      }
      for (const k of keysToRemove) {
        localStorage.removeItem(k);
      }
    } catch {}
  }

  /**
   * Completely purges all stored critic scores in localStorage and memory.
   */
  public purgeAllScoreCache(): void {
    this.inMemoryCache.clear();
    this.inFlightResolutions.clear();
    this.attemptedDynamicResolutions.clear();
    metacriticResolver.clearCache();
    steamReviewResolver.clearCache();
    storefrontStarResolver.clearCache();
    storefrontReviewHarvester.clearCache();
    if (typeof localStorage === 'undefined') return;
    try {
      const keysToRemove: string[] = [];
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (
          key &&
          (key.startsWith(STORAGE_PREFIX) ||
            key.startsWith(PREV_STORAGE_PREFIX) ||
            key.startsWith('antigravity_critic_v6_') ||
            key.startsWith('antigravity_critic_v5_') ||
            key.startsWith(LEGACY_STORAGE_PREFIX))
        ) {
          keysToRemove.push(key);
        }
      }
      for (const k of keysToRemove) {
        localStorage.removeItem(k);
      }
    } catch {}
  }

  /**
   * Purges legacy or stale "null" strings from localStorage that poison scores.
   */
  public purgeStaleNullScores(): void {
    if (typeof localStorage === 'undefined') return;
    try {
      const keysToRemove: string[] = [];
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (
          key &&
          (key.startsWith(STORAGE_PREFIX) ||
            key.startsWith(PREV_STORAGE_PREFIX) ||
            key.startsWith('antigravity_critic_v6_') ||
            key.startsWith('antigravity_critic_v5_') ||
            key.startsWith(LEGACY_STORAGE_PREFIX))
        ) {
          const val = localStorage.getItem(key);
          if (!val || val === 'null' || val === 'undefined') {
            keysToRemove.push(key);
          } else {
            try {
              const parsed = JSON.parse(val);
              if (!parsed || typeof parsed.score !== 'number' || parsed.score <= 0) {
                keysToRemove.push(key);
              }
            } catch {
              keysToRemove.push(key);
            }
          }
        }
      }
      for (const k of keysToRemove) {
        localStorage.removeItem(k);
      }
    } catch {}
  }

  /**
   * Clears memory cache and resets attempted resolution state.
   */
  clearCache(): void {
    this.inMemoryCache.clear();
    this.inFlightResolutions.clear();
    this.attemptedDynamicResolutions.clear();
    metacriticResolver.clearCache();
    steamReviewResolver.clearCache();
    storefrontStarResolver.clearCache();
    this.purgeStaleNullScores();
  }

  /**
   * Retrieves verified critic consensus data for a game, or derives a synthetic score from Steam reviews
   * if no verified critic consensus exists, while continuing to check dynamic tiers in the background.
   */
  getCriticScore(
    steamAppId?: number | null,
    title?: string,
    steamPositivePercent?: number,
    releaseYear?: number | string | null,
    storefrontAnchor?: StorefrontReviewAnchor | null
  ): CriticScoreData | null {
    const rawTitle = (title || '').trim();
    const cacheKey = steamAppId ? `id:${steamAppId}` : `title:${rawTitle.toLowerCase()}`;

    let year = releaseYear;
    if (!year && steamAppId) {
      const enriched = (steamEnrichedCache as Record<string, any>)[String(steamAppId)];
      const releaseDate = enriched?.releaseDate || enriched?.release_date;
      if (releaseDate) {
        const m = String(releaseDate).match(/\b(19\d\d|20\d\d)\b/);
        if (m) year = parseInt(m[1], 10);
      }
    }

    const triggerDynamicResolution = () => {
      if (rawTitle && !this.attemptedDynamicResolutions.has(cacheKey)) {
        if (storefrontAnchor !== undefined) {
          this.resolveDynamicScore(rawTitle, steamAppId, year, storefrontAnchor).catch(() => {});
        } else if (year !== undefined && year !== null) {
          this.resolveDynamicScore(rawTitle, steamAppId, year).catch(() => {});
        } else {
          this.resolveDynamicScore(rawTitle, steamAppId).catch(() => {});
        }
      }
    };

    const isScoreSemanticallyCompatible = (scoreData: CriticScoreData | null | undefined): boolean => {
      if (!scoreData || typeof scoreData.score !== 'number' || scoreData.score <= 0) return false;
      if (scoreData.url && rawTitle) {
        const slugMatch = scoreData.url.match(/\/game\/(?:[0-9]+\/)?([^\/]+)/);
        const slug = slugMatch ? slugMatch[1] : '';
        const slugTitle = slug.replace(/-\d{4}$/, '').replace(/[_-]/g, ' ');
        if (isSequelMismatch(rawTitle, slugTitle) || !isTitleCompatible(rawTitle, slugTitle)) {
          return false;
        }
      }
      return true;
    };

    // 1. Check in-memory cache (only accept semantically valid scores)
    if (this.inMemoryCache.has(cacheKey)) {
      const cached = this.inMemoryCache.get(cacheKey);
      if (cached && isScoreSemanticallyCompatible(cached)) {
        // If synthetic or OpenCritic, keep checking dynamic tiers in background to potentially upgrade to Tier 1 Metacritic!
        if (cached.isSynthetic || cached.source === 'opencritic') {
          triggerDynamicResolution();
        }
        return cached;
      } else if (cached) {
        this.inMemoryCache.delete(cacheKey);
      }
    }

    const lowerTitle = rawTitle.toLowerCase();
    const normalizedKey = normalizeCriticTitleKey(rawTitle);
    const strippedKey = stripEditionSuffix(rawTitle);

    // 2. Direct lookup in master verified dataset (Authoritative compiled data takes precedence over unverified localStorage)
    let verifiedMatch: CriticScoreData | undefined;
    if (steamAppId && KNOWN_CRITIC_SCORES[steamAppId]) {
      verifiedMatch = KNOWN_CRITIC_SCORES[steamAppId];
    } else if (lowerTitle && KNOWN_CRITIC_SCORES[lowerTitle]) {
      verifiedMatch = KNOWN_CRITIC_SCORES[lowerTitle];
    } else if (normalizedKey && KNOWN_CRITIC_SCORES[normalizedKey]) {
      verifiedMatch = KNOWN_CRITIC_SCORES[normalizedKey];
    } else if (strippedKey && strippedKey !== normalizedKey && KNOWN_CRITIC_SCORES[strippedKey]) {
      verifiedMatch = KNOWN_CRITIC_SCORES[strippedKey];
    }

    if (verifiedMatch && isScoreSemanticallyCompatible(verifiedMatch)) {
      this.cacheResult(cacheKey, verifiedMatch);
      // If synthetic or OpenCritic, continue background dynamic resolution to upgrade to press consensus (Tier 1 Metacritic) if available
      if (verifiedMatch.isSynthetic || verifiedMatch.source === 'opencritic') {
        triggerDynamicResolution();
      }
      return verifiedMatch;
    }

    // 3. Check localStorage cache if available (only accept semantically valid scores, purge corrupted/mismatched entries)
    if (typeof localStorage !== 'undefined') {
      try {
        const cachedRaw = localStorage.getItem(`${STORAGE_PREFIX}${cacheKey}`);
        if (cachedRaw) {
          const parsed: CriticScoreData | null = JSON.parse(cachedRaw);
          if (parsed && isScoreSemanticallyCompatible(parsed)) {
            this.inMemoryCache.set(cacheKey, parsed);
            // If synthetic or OpenCritic, keep checking dynamic resolution in background to potentially upgrade to Tier 1 Metacritic!
            if (parsed.isSynthetic || parsed.source === 'opencritic') {
              triggerDynamicResolution();
            }
            return parsed;
          } else {
            // Stale, corrupted or mismatched entry: purge it immediately!
            try {
              localStorage.removeItem(`${STORAGE_PREFIX}${cacheKey}`);
            } catch {}
          }
        }
      } catch {}
    }

    // Early explicit unrated check (betas, editors, demos, unrated classics)
    const isExplicitlyUnrated =
      KNOWN_UNRATED_TITLES.has(lowerTitle) ||
      (Boolean(normalizedKey) && KNOWN_UNRATED_TITLES.has(normalizedKey));
    if (isExplicitlyUnrated) {
      let positive = steamPositivePercent;
      let totalReviews: number | undefined;
      if (positive === undefined && steamAppId) {
        const enriched = (steamEnrichedCache as Record<string, any>)[String(steamAppId)];
        if (enriched?.reviewSummary?.positivePercent !== undefined) {
          positive = enriched.reviewSummary.positivePercent;
          totalReviews = enriched.reviewSummary.totalReviews;
        }
      }
      if (positive !== undefined && positive > 0) {
        const synthetic = calculateSyntheticSteamScore(positive, totalReviews);
        const syntheticData: CriticScoreData = {
          id: steamAppId ? `steam-${steamAppId}` : undefined,
          source: 'steam',
          score: synthetic.score,
          percentRecommended: synthetic.percentRecommended,
          tier: synthetic.tier,
          numReviews: totalReviews || 50,
          url: steamAppId
            ? `https://store.steampowered.com/app/${steamAppId}`
            : `https://store.steampowered.com/search/?term=${encodeURIComponent(rawTitle)}`,
          summary: `Based on Steam community player reviews (${positive}% positive).`,
          isVerified: false,
          isSynthetic: true,
        };
        this.cacheResult(cacheKey, syntheticData);
        return syntheticData;
      }
      this.cacheResult(cacheKey, null);
      return null;
    }

    // 4. Always trigger cascading dynamic live resolution in background for unverified games
    triggerDynamicResolution();

    // 5. Look for authentic Steam review sentiment to construct immediate synthetic score
    // IMPORTANT: Only use review percentages if tied to a legitimate Steam App ID to avoid GOG star-rating contamination!
    let positive = steamPositivePercent;
    let totalReviews: number | undefined;

    if (positive === undefined && steamAppId) {
      const enriched = (steamEnrichedCache as Record<string, any>)[String(steamAppId)];
      if (enriched?.reviewSummary?.positivePercent !== undefined) {
        positive = enriched.reviewSummary.positivePercent;
        totalReviews = enriched.reviewSummary.totalReviews;
      }
    }

    if (positive !== undefined && positive > 0) {
      const synthetic = calculateSyntheticSteamScore(positive, totalReviews);
      const syntheticData: CriticScoreData = {
        id: steamAppId ? `steam-${steamAppId}` : undefined,
        source: 'steam',
        score: synthetic.score,
        percentRecommended: synthetic.percentRecommended,
        tier: synthetic.tier,
        numReviews: totalReviews || 50,
        url: steamAppId
          ? `https://store.steampowered.com/app/${steamAppId}`
          : `https://store.steampowered.com/search/?term=${encodeURIComponent(rawTitle)}`,
        summary: `Based on Steam community player reviews (${positive}% positive).`,
        isVerified: false,
        isSynthetic: true,
      };

      this.cacheResult(cacheKey, syntheticData);
      return syntheticData;
    }

    // 6. Explicit unrated exclusion check (strictly null when no Steam reviews exist)
    if (KNOWN_UNRATED_TITLES.has(lowerTitle) || KNOWN_UNRATED_TITLES.has(normalizedKey)) {
      this.cacheResult(cacheKey, null);
      return null;
    }

    // Non-blocking initial return: null until dynamic resolution completes
    return null;
  }

  /**
   * Dynamically resolves an authentic score via the 3-tier cascade:
   * Tier 1: Metacritic Live JSON-LD Scraper (verified press consensus, >= 4 reviews)
   * Tier 2: OpenCritic Live API (verified press consensus, >= 4 reviews)
   * Tier 3: Steam Live Community Reviews (authentic player sentiment, >= 10 reviews)
   */
  async resolveDynamicScore(
    rawTitle: string,
    steamAppId?: number | null,
    releaseYear?: number | string | null,
    storefrontAnchor?: StorefrontReviewAnchor | null
  ): Promise<CriticScoreData | null> {
    const title = (rawTitle || '').trim();
    if (!title) return null;

    let year = releaseYear;
    if (!year && steamAppId) {
      const enriched = (steamEnrichedCache as Record<string, any>)[String(steamAppId)];
      const releaseDate = enriched?.releaseDate || enriched?.release_date;
      if (releaseDate) {
        const m = String(releaseDate).match(/\b(19\d\d|20\d\d)\b/);
        if (m) year = parseInt(m[1], 10);
      }
    }

    const cacheKey = steamAppId ? `id:${steamAppId}` : `title:${title.toLowerCase()}`;

    if (this.inMemoryCache.has(cacheKey)) {
      const existing = this.inMemoryCache.get(cacheKey);
      // Only short-circuit if already verified Tier 1 Metacritic; if OpenCritic, allow dynamic upgrade check
      if (existing?.isVerified && existing.source === 'metacritic') {
        let isCompatible = true;
        if (existing.url && title) {
          const slugMatch = existing.url.match(/\/game\/(?:[0-9]+\/)?([^\/]+)/);
          const slug = slugMatch ? slugMatch[1] : '';
          const slugTitle = slug.replace(/-\d{4}$/, '').replace(/-/g, ' ');
          if (isSequelMismatch(title, slugTitle) || !isTitleCompatible(title, slugTitle)) {
            isCompatible = false;
          }
        }
        if (isCompatible) {
          return existing;
        } else {
          this.inMemoryCache.delete(cacheKey);
          this.attemptedDynamicResolutions.delete(cacheKey);
        }
      }
    }

    if (this.inFlightResolutions.has(cacheKey)) {
      return this.inFlightResolutions.get(cacheKey)!;
    }

    if (this.attemptedDynamicResolutions.has(cacheKey)) {
      const existing = this.inMemoryCache.get(cacheKey);
      if (existing?.url && title) {
        const slugMatch = existing.url.match(/\/game\/(?:[0-9]+\/)?([^\/]+)/);
        const slug = slugMatch ? slugMatch[1] : '';
        const slugTitle = slug.replace(/-\d{4}$/, '').replace(/-/g, ' ');
        if (isSequelMismatch(title, slugTitle) || !isTitleCompatible(title, slugTitle)) {
          this.inMemoryCache.delete(cacheKey);
          this.attemptedDynamicResolutions.delete(cacheKey);
        } else {
          return existing;
        }
      } else {
        return existing ?? null;
      }
    }
    this.attemptedDynamicResolutions.add(cacheKey);

    const promise = (async (): Promise<CriticScoreData | null> => {
      try {
        const cleanTitle = title
          .replace(/[™®©]/g, '')
          .replace(
            /\b(standard|deluxe|gold|silver|platinum|diamond|collector'?s|ultimate|complete|special|limited|definitive|enhanced|anniversary|directors-cut|director'?s cut|goty|game of the year|remastered|remake)( edition)?\b/gi,
            ''
          )
          .trim();

        const retainSyntheticOrNull = () => {
          const current = this.inMemoryCache.get(cacheKey);
          if (current?.isSynthetic) {
            return current;
          }
          this.cacheResult(cacheKey, null);
          return null;
        };

        const lower = title.toLowerCase();
        const normKey = normalizeCriticTitleKey(title);
        if (
          KNOWN_UNRATED_TITLES.has(lower) ||
          (Boolean(normKey) && KNOWN_UNRATED_TITLES.has(normKey)) ||
          /\b(public testing|tech beta|playtest|digital goodies|pre-game editor|resource archiver|playable teaser)\b/i.test(title)
        ) {
          return retainSyntheticOrNull();
        }

        // Harvest storefront ground truth anchor if not passed in
        let anchor = storefrontAnchor;
        if (!anchor) {
          try {
            anchor = await storefrontReviewHarvester.getStorefrontAnchor({ title, steamAppId });
          } catch {
            anchor = null;
          }
        }

        const broadcastUpdate = (data: CriticScoreData) => {
          this.cacheResult(cacheKey, data);
          if (normKey) {
            this.cacheResult(`title:${normKey}`, data);
          }
          if (typeof window !== 'undefined') {
            window.dispatchEvent(
              new CustomEvent('antigravity_critic_updated', {
                detail: { cacheKey, title, steamAppId, data },
              })
            );
          }
        };

        // ==========================================
        // TIER 1: Metacritic Live JSON-LD Resolution
        // ==========================================
        let mcBundle: import('./metacriticResolver').MetacriticBundle | null = null;
        try {
          mcBundle = await metacriticResolver.resolveMetacritic(title, year, anchor);
          if (mcBundle?.critic && mcBundle.critic.isVerified && mcBundle.critic.score > 0) {
            broadcastUpdate(mcBundle.critic);
            return mcBundle.critic;
          }
        } catch (mcErr: any) {
          console.warn(`[CriticScoreService] Metacritic check warning for "${title}":`, mcErr?.message);
        }

        // If we already have a verified OpenCritic score, and Metacritic didn't produce a Tier 1 score,
        // PRESERVE the verified OpenCritic score! DO NOT downgrade to Tier 3 user score or Tier 4 Steam!
        const existingPreSeeded =
          this.inMemoryCache.get(cacheKey) ||
          (steamAppId ? KNOWN_CRITIC_SCORES[steamAppId] : undefined) ||
          KNOWN_CRITIC_SCORES[title.toLowerCase()] ||
          (normKey ? KNOWN_CRITIC_SCORES[normKey] : undefined);

        if (existingPreSeeded?.isVerified && existingPreSeeded.source === 'opencritic') {
          this.cacheResult(cacheKey, existingPreSeeded);
          return existingPreSeeded;
        }

        // ==========================================
        // TIER 2: OpenCritic Live API Resolution
        // ==========================================

        try {
          const baseUrl =
            typeof window !== 'undefined' && window.location.hostname === 'localhost'
              ? '/api/opencritic'
              : 'https://api.opencritic.com';

          const searchUrl = `${baseUrl}/api/game/search?criteria=${encodeURIComponent(cleanTitle || title)}`;
          const headers: Record<string, string> = {
            Authorization: OPENCRITIC_BEARER_TOKEN,
            Referer: 'https://opencritic.com/',
          };

          const searchRes = await fetch(searchUrl, { headers });
          if (searchRes.ok) {
            const candidates: Array<{ id: number; name: string; dist?: number }> = await searchRes.json();
            if (Array.isArray(candidates) && candidates.length > 0) {
              let best: { id: number; name: string; dist?: number } | null = null;

              // Rule 2 & 4: If storefront anchor has an openCriticId, prioritize exact ID match
              if (anchor?.openCriticId) {
                const idMatch = candidates.find((c) => c.id === anchor.openCriticId);
                if (idMatch) {
                  best = idMatch;
                }
              }

              if (!best) {
                for (const c of candidates) {
                  if (typeof c.dist === 'number' && c.dist <= 0.35) {
                    if (!isSequelMismatch(cleanTitle || title, c.name)) {
                      best = c;
                      break;
                    }
                  }
                }
              }

              if (best) {
                const detailsRes = await fetch(`${baseUrl}/api/game/${best.id}`, { headers });
                if (detailsRes.ok) {
                  const data = await detailsRes.json();
                  if (data && typeof data.topCriticScore === 'number' && data.topCriticScore > 0) {
                    const apiScore = Math.round(data.topCriticScore);

                    // Rule 4: Corroborate OpenCritic live API candidate with storefrontAnchor.openCriticScore
                    // If storefrontAnchor has verified openCriticScore, ensure no drastic conflict (> 5 pts)
                    const isConflict =
                      anchor?.openCriticScore !== undefined &&
                      Math.abs(apiScore - anchor.openCriticScore) > 5;

                    if (!isConflict) {
                      // Rule 2: Ground Truth Storefront Anchor takes precedence when present
                      const score = anchor?.openCriticScore !== undefined ? anchor.openCriticScore : apiScore;
                      const percentRecommended =
                        typeof data.percentRecommended === 'number'
                          ? Math.round(data.percentRecommended)
                          : undefined;
                      const tier = (data.tier as CriticTier) || calculateTier(score, percentRecommended);
                      const slug = (data.name || best.name)
                        .toLowerCase()
                        .replace(/[^a-z0-9]+/g, '-')
                        .replace(/^-|-$/g, '');
                      const canonicalUrl = anchor?.openCriticUrl || `https://opencritic.com/game/${best.id}/${slug}`;

                      const result: CriticScoreData = {
                        id: best.id,
                        source: 'opencritic',
                        score,
                        tier,
                        percentRecommended,
                        numReviews: typeof data.numReviews === 'number' ? data.numReviews : 25,
                        url: canonicalUrl,
                        summary: data.reviewSummary?.summary || (anchor ? `Verified by official ${anchor.storefront.toUpperCase()} store review anchor.` : undefined),
                        isVerified: true,
                      };

                      broadcastUpdate(result);
                      return result;
                    }
                  }
                }
              }
            }
          }
        } catch (ocErr: any) {
          console.warn(`[CriticScoreService] OpenCritic check warning for "${title}":`, ocErr?.message);
        }

        // Rule 2 Fallback: If OpenCritic API is unreachable or has no direct match, but storefrontAnchor contains verified openCriticScore
        if (anchor?.openCriticScore !== undefined && anchor.openCriticScore > 0) {
          const ocScore = anchor.openCriticScore;
          const ocSlug = cleanTitle.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
          const ocUrl =
            anchor.openCriticUrl ||
            (anchor.openCriticId ? `https://opencritic.com/game/${anchor.openCriticId}/${ocSlug}` : undefined) ||
            anchor.rawStoreUrl ||
            'https://opencritic.com';
          if (ocUrl && !ocUrl.includes('/search')) {
            const ocResult: CriticScoreData = {
              id: anchor.openCriticId || `oc-${ocSlug}`,
              source: 'opencritic',
              score: ocScore,
              tier: calculateTier(ocScore),
              url: ocUrl,
              summary: `Verified by official ${anchor.storefront.toUpperCase()} store review anchor.`,
              isVerified: true,
            };
            broadcastUpdate(ocResult);
            return ocResult;
          }
        }

        // ==========================================
        // TIER 3: Metacritic User Score Resolution
        // ==========================================
        if (mcBundle?.user && mcBundle.user.score > 0) {
          broadcastUpdate(mcBundle.user);
          return mcBundle.user;
        }

        // ==========================================
        // TIER 4: Steam Live Community Reviews Resolver
        // ==========================================
        try {
          const steamResult = await steamReviewResolver.resolveScore(title, steamAppId);
          if (steamResult && steamResult.isSynthetic && steamResult.score > 0) {
            broadcastUpdate(steamResult);
            return steamResult;
          }
        } catch (steamErr: any) {
          console.warn(`[CriticScoreService] Steam live reviews check warning for "${title}":`, steamErr?.message);
        }

        // ==========================================
        // TIER 5: Storefront Star Rating (GOG / Epic, >= 4 reviews)
        // ==========================================
        try {
          const storefrontResult = await storefrontStarResolver.resolveStorefrontScore(title);
          if (storefrontResult && storefrontResult.score > 0) {
            broadcastUpdate(storefrontResult);
            return storefrontResult;
          }
        } catch (sfErr: any) {
          console.warn(`[CriticScoreService] Storefront star check warning for "${title}":`, sfErr?.message);
        }

        // ==========================================
        // TIER 6: Truly Unrated
        // ==========================================
        return retainSyntheticOrNull();
      } catch {
        return this.inMemoryCache.get(cacheKey) ?? null;
      } finally {
        this.inFlightResolutions.delete(cacheKey);
      }
    })();

    this.inFlightResolutions.set(cacheKey, promise);
    return promise;
  }

  private cacheResult(key: string, data: CriticScoreData | null): void {
    if (data && typeof data.score === 'number' && data.score > 0) {
      this.inMemoryCache.set(key, data);
      if (typeof localStorage !== 'undefined') {
        try {
          localStorage.setItem(`${STORAGE_PREFIX}${key}`, JSON.stringify(data));
        } catch {}
      }
    } else {
      this.inMemoryCache.set(key, null);
    }
  }
}

export const criticScoreService = new CriticScoreService();

/**
 * Backward compatibility function for existing components.
 */
export function getOpenCriticData(
  steamAppId?: number | null,
  title?: string,
  steamPositivePercent?: number,
  releaseYear?: number | string | null,
  storefrontAnchor?: StorefrontReviewAnchor | null
): OpenCriticData | null {
  return criticScoreService.getCriticScore(steamAppId, title, steamPositivePercent, releaseYear, storefrontAnchor);
}
