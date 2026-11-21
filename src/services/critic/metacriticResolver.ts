import { CriticScoreData, StorefrontReviewAnchor } from '../../contracts/critic';
import { classifyNetworkError, isWafOrChallengeResponse } from '../../contracts/network';
import { LruSet } from '../common/lruMap';
import {
  isSequelMismatch,
  normalizeTitleKey,
  stripIntermediateSubtitleNumeral,
  stripPackagingEditionPhrases,
  stripTrailingDelimitedReleaseYear,
  stripYearEditionPhrases,
} from '../common/titleUtils';
import { getDevProxyBaseForRoute } from '../network/browserDevProxy';
import { onlineLifecycleManager } from '../network/onlineLifecycleManager';
import { Priority, requestScheduler } from '../network/requestScheduler';
import { calculateTier } from './criticUtils';
import { createTimeoutSignal } from './stagedResolverCache';
import {
  type MetacriticComposerResponse,
  evaluateMetacriticComposerPayload,
} from './metacritic/metacriticComposerParser';
import {
  type DeferredOlderCritic,
  type DeferredOlderUser,
  type SlugEvaluationResult,
  evaluateMetacriticHtmlBody,
} from './metacritic/metacriticHtmlParser';
import {
  type MetacriticSearchCandidate,
  generateMetacriticSlugCandidates,
  rankCandidateSlugs,
  searchMetacriticCandidates,
  searchMetacriticSlugs,
} from './metacritic/metacriticSlugCandidates';
import {
  SPECIAL_CHAR_TRANSLITERATION,
  hasExplicitClassicOrOriginalEditionTag,
  isAnchorMatch,
  isAnchorSlugCompatible,
  isCandidateConflictingWithAnchor,
  isTitleCompatible,
  stripMetacriticEditionSlug,
  toCanonicalMetacriticSlug,
} from './metacritic/metacriticTitleMatching';
import {
  createMetacriticIdentityContext,
  evaluateReleaseYearCompatibility,
  extractYearFromDateString,
  sanitizeMetacriticDescription,
} from './metacritic/metacriticYearGuard';

export {
  SPECIAL_CHAR_TRANSLITERATION,
  toCanonicalMetacriticSlug,
  stripMetacriticEditionSlug,
  isAnchorMatch,
  isCandidateConflictingWithAnchor,
  isAnchorSlugCompatible,
  generateMetacriticSlugCandidates,
  searchMetacriticCandidates,
  searchMetacriticSlugs,
  hasExplicitClassicOrOriginalEditionTag,
  isTitleCompatible,
  sanitizeMetacriticDescription,
  rankCandidateSlugs,
};
export type { MetacriticSearchCandidate };

export interface MetacriticBundle {
  critic: CriticScoreData | null;
  user: CriticScoreData | null;
  offlinePartialUserScore?: boolean;
}

interface MetacriticCacheEntry {
  bundle: MetacriticBundle;
  cachedAt: number;
}

const MAX_METACRITIC_CACHE_ENTRIES = 2000;
const NEGATIVE_METACRITIC_TTL_MS = 15 * 60 * 1000; // 15 min bounded TTL for negative { critic: null, user: null } entries

export class MetacriticResolver {
  private cache = new Map<string, MetacriticCacheEntry>();
  private cacheKeysByTitle = new Map<string, Set<string>>();
  private cacheKeyToTitleKeys = new Map<string, string[]>();
  private inFlight = new Map<string, Promise<MetacriticBundle>>();
  private transientFailureTitles = new LruSet<string>(MAX_METACRITIC_CACHE_ENTRIES);
  private cacheEpoch = 0;
  private keyEpochs = new Map<string, number>();

  constructor() {
    try {
      onlineLifecycleManager.onOnline(() => {
        this.transientFailureTitles.clear();
        const partialKeys: string[] = [];
        for (const [k, entry] of this.cache.entries()) {
          if (entry.bundle.offlinePartialUserScore) {
            partialKeys.push(k);
          }
        }
        for (const k of partialKeys) {
          this.deleteCacheKey(k, true);
        }
      });
    } catch {}
  }

  private isEpochCurrent(
    capturedEpoch: number,
    cacheKey: string,
    capturedKeyEpoch: number
  ): boolean {
    return (
      capturedEpoch === this.cacheEpoch &&
      (this.keyEpochs.get(cacheKey) ?? 0) === capturedKeyEpoch
    );
  }

  private deleteCacheKey(key: string, bumpKeyEpoch: boolean = false): void {
    if (bumpKeyEpoch) {
      this.keyEpochs.set(key, (this.keyEpochs.get(key) ?? 0) + 1);
    }
    this.cache.delete(key);
    this.inFlight.delete(key);
    const titleKeys = this.cacheKeyToTitleKeys.get(key);
    if (titleKeys) {
      for (const tk of titleKeys) {
        const set = this.cacheKeysByTitle.get(tk);
        if (set) {
          set.delete(key);
          if (set.size === 0) this.cacheKeysByTitle.delete(tk);
        }
      }
      this.cacheKeyToTitleKeys.delete(key);
    }
  }

  private setCacheBounded(
    key: string,
    bundle: MetacriticBundle,
    rawTitle?: string,
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
    if (this.cache.has(key)) {
      this.deleteCacheKey(key, false);
    }
    this.cache.set(key, { bundle, cachedAt: Date.now() });
    const titleKeys: string[] = [];
    const titleLower = (rawTitle || '').trim().toLowerCase();
    if (titleLower) {
      titleKeys.push(titleLower);
      const norm = normalizeTitleKey(titleLower);
      if (norm && norm !== titleLower) {
        titleKeys.push(norm);
      }
    }
    if (titleKeys.length > 0) {
      this.cacheKeyToTitleKeys.set(key, titleKeys);
      for (const tk of titleKeys) {
        let set = this.cacheKeysByTitle.get(tk);
        if (!set) {
          set = new Set<string>();
          this.cacheKeysByTitle.set(tk, set);
        }
        set.add(key);
      }
    }
    while (this.cache.size > MAX_METACRITIC_CACHE_ENTRIES) {
      const oldest = this.cache.keys().next().value;
      if (oldest === undefined) break;
      this.deleteCacheKey(oldest, false);
    }
  }

  public hadRecentTransientFailure(rawTitle: string): boolean {
    const title = (rawTitle || '').trim().toLowerCase();
    return title ? this.transientFailureTitles.has(title) : false;
  }

  /**
   * Resolves both Critic Metascore and User Score for a game title in a single request pass.
   */
  async resolveMetacritic(
    rawTitle: string,
    releaseYear?: number | string | null,
    storefrontAnchor?: StorefrontReviewAnchor | null,
    priority: number = Priority.P1_VIEWPORT
  ): Promise<MetacriticBundle> {
    const title = (rawTitle || '').trim();
    if (!title) return { critic: null, user: null };

    const rawAnchorSlug = storefrontAnchor?.metacriticSlug?.toLowerCase().trim();
    const anchorSlug =
      rawAnchorSlug && isAnchorSlugCompatible(title, rawAnchorSlug) ? rawAnchorSlug : undefined;
    const cacheKey = `${title.toLowerCase()}${releaseYear ? `:${releaseYear}` : ''}${anchorSlug ? `:${anchorSlug}` : ''}`;

    const cachedEntry = this.cache.get(cacheKey);
    if (cachedEntry !== undefined) {
      const cached = cachedEntry.bundle;
      if (cached.offlinePartialUserScore && onlineLifecycleManager.isOnline()) {
        this.deleteCacheKey(cacheKey, false);
      } else if (
        cached.critic === null &&
        cached.user === null &&
        Date.now() - cachedEntry.cachedAt >= NEGATIVE_METACRITIC_TTL_MS
      ) {
        this.deleteCacheKey(cacheKey, false);
      } else {
        return cached;
      }
    }

    if (this.inFlight.has(cacheKey)) {
      return this.inFlight.get(cacheKey)!;
    }

    const titleLower = title.toLowerCase();
    this.transientFailureTitles.delete(titleLower);

    if (!onlineLifecycleManager.isOnline()) {
      if (
        typeof storefrontAnchor?.metacriticScore === 'number' &&
        storefrontAnchor.metacriticScore > 0
      ) {
        const fallbackSlug =
          anchorSlug ||
          storefrontAnchor.metacriticSlug ||
          toCanonicalMetacriticSlug(title);
        if (fallbackSlug && isAnchorSlugCompatible(title, fallbackSlug)) {
          const anchorCritic: CriticScoreData = {
            id: `mc-${fallbackSlug}`,
            source: 'metacritic',
            score: storefrontAnchor.metacriticScore,
            tier: calculateTier(storefrontAnchor.metacriticScore),
            numReviews: 20,
            url:
              storefrontAnchor.metacriticUrl ||
              `https://www.metacritic.com/game/${fallbackSlug}/critic-reviews/`,
            summary: `Verified by official ${storefrontAnchor.storefront.toUpperCase()} store review anchor.`,
            isVerified: true,
            isSynthetic: false,
          };
          const bundle: MetacriticBundle = {
            critic: anchorCritic,
            user: null,
            offlinePartialUserScore: true,
          };
          this.setCacheBounded(cacheKey, bundle, title);
          return bundle;
        }
      }
      this.transientFailureTitles.add(titleLower);
      return { critic: null, user: null };
    }

    const identityCtx = createMetacriticIdentityContext(title, releaseYear);
    const {
      titleYear,
      paramYear,
      queryHasExplicitFirstInstallment,
      isExplicitRetroQuery,
    } = identityCtx;

    const buildAnchorFallbackCritic = (slug: string): CriticScoreData | null => {
      if (
        typeof storefrontAnchor?.metacriticScore === 'number' &&
        storefrontAnchor.metacriticScore > 0
      ) {
        return {
          id: `mc-${slug}`,
          source: 'metacritic',
          score: storefrontAnchor.metacriticScore,
          tier: calculateTier(storefrontAnchor.metacriticScore),
          numReviews: 20,
          url:
            storefrontAnchor.metacriticUrl ||
            `https://www.metacritic.com/game/${slug}/critic-reviews/`,
          summary: `Verified by official ${storefrontAnchor.storefront.toUpperCase()} store review anchor.`,
          isVerified: true,
          isSynthetic: false,
        };
      }
      return null;
    };

    const capturedEpoch = this.cacheEpoch;
    const capturedKeyEpoch = this.keyEpochs.get(cacheKey) ?? 0;

    let promise!: Promise<MetacriticBundle>;
    promise = (async (): Promise<MetacriticBundle> => {
      const slugs = generateMetacriticSlugCandidates(title, releaseYear, storefrontAnchor);
      let fallbackUser: CriticScoreData | null = null;
      let deferredOlderCritic: DeferredOlderCritic | null = null;
      let deferredOlderUser: DeferredOlderUser | null = null;
      let sawTransientError = false;

      const recordDeferredOlder = (evalRes: SlugEvaluationResult): void => {
        if (evalRes.user && !fallbackUser) {
          fallbackUser = evalRes.user;
        }
        if (evalRes.deferredOlderCritic) {
          if (
            !deferredOlderCritic ||
            (paramYear !== null &&
              Math.abs(evalRes.deferredOlderCritic.pageYear - paramYear) <
                Math.abs(deferredOlderCritic.pageYear - paramYear))
          ) {
            deferredOlderCritic = evalRes.deferredOlderCritic;
          }
        }
        if (evalRes.deferredOlderUser && !deferredOlderUser) {
          deferredOlderUser = evalRes.deferredOlderUser;
        }
      };

      const evaluateSlug = async (
        slug: string,
        isAnchor = false,
        redirectDepth = 0,
        allowAnchorFallback = isAnchor
      ): Promise<SlugEvaluationResult> => {
        const composerBaseUrl = getDevProxyBaseForRoute('metacriticBackend');
        const composerUrl = `${composerBaseUrl}/composer/metacritic/pages/games/${encodeURIComponent(slug)}/web`;

        let shouldFallbackToHtml = false;
        let definitiveNotFound = false;

        // Primary: Metacritic Composer JSON API (CORS-simple request: zero User-Agent/Referer headers)
        try {
          const composerRes = await requestScheduler.schedule(
            composerUrl,
            () =>
              fetch(composerUrl, {
                headers: { Accept: 'application/json' },
                signal: createTimeoutSignal(6000),
              }),
            priority,
            'backend.metacritic.com'
          );

          const contentType = (composerRes.headers?.get?.('content-type') || '').toLowerCase();

          if (composerRes.ok) {
            const rawBody = await composerRes.text();
            if (isWafOrChallengeResponse(composerRes.status, rawBody, composerRes.headers)) {
              sawTransientError = true;
              shouldFallbackToHtml = true;
            } else if (
              contentType.includes('text/html') ||
              (!contentType.includes('application/json') &&
                /<(?:!doctype|html|head|body|script|div)\b/i.test(rawBody))
            ) {
              return evaluateMetacriticHtmlBody({
                html: rawBody,
                slug,
                isAnchor,
                identityCtx,
                storefrontAnchor,
              });
            } else {
              try {
                const parsed: unknown = JSON.parse(rawBody);
                if (parsed && typeof parsed === 'object') {
                  const composerEval = evaluateMetacriticComposerPayload({
                    payload: parsed as MetacriticComposerResponse,
                    slug,
                    isAnchor,
                    identityCtx,
                    storefrontAnchor,
                  });
                  if (composerEval.handled) {
                    return composerEval.result;
                  }
                  if (composerEval.redirectSlug && redirectDepth < 1) {
                    return evaluateSlug(
                      composerEval.redirectSlug,
                      isAnchor,
                      redirectDepth + 1,
                      allowAnchorFallback
                    );
                  }
                }
                shouldFallbackToHtml = true;
              } catch {
                shouldFallbackToHtml = true;
              }
            }
          } else if (composerRes.status === 404) {
            if (contentType.includes('application/json')) {
              definitiveNotFound = true;
            } else {
              shouldFallbackToHtml = true;
            }
          } else {
            if (
              composerRes.status === 429 ||
              composerRes.status >= 500 ||
              isWafOrChallengeResponse(composerRes.status, '', composerRes.headers)
            ) {
              sawTransientError = true;
            }
            shouldFallbackToHtml = true;
          }
        } catch (err: unknown) {
          if (classifyNetworkError(err).status === 'transient_error') {
            sawTransientError = true;
          }
          shouldFallbackToHtml = true;
        }

        if (definitiveNotFound) {
          const anchorFallback = allowAnchorFallback ? buildAnchorFallbackCritic(slug) : null;
          return { critic: anchorFallback, user: null };
        }

        if (!shouldFallbackToHtml) {
          return { critic: null, user: null };
        }

        // Smart HTML Fallback: www.metacritic.com/game/${slug}/ (CORS-simple request: zero User-Agent/Referer)
        const htmlUrl = `${getDevProxyBaseForRoute('metacritic')}/game/${slug}/`;

        try {
          let res: Response | null = null;
          for (let attempt = 0; attempt < 2; attempt++) {
            try {
              res = await requestScheduler.schedule(
                htmlUrl,
                () =>
                  fetch(htmlUrl, {
                    headers: {
                      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                    },
                    signal: createTimeoutSignal(6000),
                  }),
                priority,
                'metacritic.com'
              );
              if (res.ok || res.status === 404) break;
              if (
                res.status === 429 ||
                res.status >= 500 ||
                isWafOrChallengeResponse(res.status, '', res.headers)
              ) {
                sawTransientError = true;
              }
            } catch (e: unknown) {
              if (classifyNetworkError(e).status === 'transient_error') {
                sawTransientError = true;
              }
              if (attempt === 0) {
                await new Promise((r) => setTimeout(r, 200));
              }
            }
          }

          if (!res || !res.ok) {
            if (
              res &&
              (res.status === 429 ||
                res.status >= 500 ||
                isWafOrChallengeResponse(res.status, '', res.headers))
            ) {
              sawTransientError = true;
            }
            const anchorFallback = allowAnchorFallback ? buildAnchorFallbackCritic(slug) : null;
            return { critic: anchorFallback, user: null };
          }

          const html = await res.text();
          if (isWafOrChallengeResponse(res.status, html, res.headers)) {
            sawTransientError = true;
            const anchorFallback = allowAnchorFallback ? buildAnchorFallbackCritic(slug) : null;
            return { critic: anchorFallback, user: null };
          }

          return evaluateMetacriticHtmlBody({
            html,
            slug,
            isAnchor,
            identityCtx,
            storefrontAnchor,
          });
        } catch {
          const anchorFallback = allowAnchorFallback ? buildAnchorFallbackCritic(slug) : null;
          return { critic: anchorFallback, user: null };
        }
      };

      const testedSlugs = new Set<string>();
      const baseCanonicalSlug = toCanonicalMetacriticSlug(title);

      // 1. Anchor slug evaluation
      const queryYr = titleYear !== null ? String(titleYear) : undefined;
      const primaryAnchorSlug =
        queryYr && anchorSlug && !anchorSlug.endsWith(`-${queryYr}`) && anchorSlug !== queryYr
          ? `${anchorSlug}-${queryYr}`
          : anchorSlug;

      if (primaryAnchorSlug) {
        const isSynthesizedYearAnchor = primaryAnchorSlug !== anchorSlug;
        testedSlugs.add(primaryAnchorSlug);
        const evalRes = await evaluateSlug(primaryAnchorSlug, true, 0, !isSynthesizedYearAnchor);
        if (evalRes.critic) {
          const bundle: MetacriticBundle = { critic: evalRes.critic, user: evalRes.user || fallbackUser };
          this.setCacheBounded(cacheKey, bundle, title, capturedEpoch, capturedKeyEpoch);
          return bundle;
        }
        recordDeferredOlder(evalRes);

        if (isSynthesizedYearAnchor && anchorSlug && !testedSlugs.has(anchorSlug)) {
          testedSlugs.add(anchorSlug);
          const baseAnchorEval = await evaluateSlug(anchorSlug, true, 0, false);
          if (baseAnchorEval.critic) {
            const bundle: MetacriticBundle = {
              critic: baseAnchorEval.critic,
              user: baseAnchorEval.user || fallbackUser,
            };
            this.setCacheBounded(cacheKey, bundle, title, capturedEpoch, capturedKeyEpoch);
            return bundle;
          }
          recordDeferredOlder(baseAnchorEval);
        }
      }

      // 2. Direct candidate probing with candidateLimit = 4
      const candidateLimit = 4;
      const step2Queue: string[] = [];
      for (const slug of slugs) {
        if (!testedSlugs.has(slug)) {
          step2Queue.push(slug);
        }
        if (step2Queue.length + testedSlugs.size >= candidateLimit) {
          break;
        }
      }

      for (let i = 0; i < step2Queue.length; i++) {
        const slug = step2Queue[i];
        if (testedSlugs.has(slug)) continue;
        testedSlugs.add(slug);
        const isAnchor = Boolean(anchorSlug && isAnchorMatch(slug, anchorSlug));
        const evalRes = await evaluateSlug(slug, isAnchor, 0, false);
        if (evalRes.critic) {
          const bundle: MetacriticBundle = { critic: evalRes.critic, user: evalRes.user || fallbackUser };
          this.setCacheBounded(cacheKey, bundle, title, capturedEpoch, capturedKeyEpoch);
          return bundle;
        }
        recordDeferredOlder(evalRes);

        if (
          (evalRes.deferredOlderCritic || evalRes.deferredOlderUser) &&
          titleYear === null &&
          paramYear !== null &&
          baseCanonicalSlug &&
          !baseCanonicalSlug.endsWith(`-${paramYear}`)
        ) {
          const yearProbeSlug = `${baseCanonicalSlug}-${paramYear}`;
          if (!testedSlugs.has(yearProbeSlug) && !step2Queue.includes(yearProbeSlug)) {
            step2Queue.push(yearProbeSlug);
          }
        }
      }

      // 3. Query Metacritic backend finder search API to discover verified slugs
      let modernRemakeExistsInFinder = false;
      let finderSucceeded = false;
      try {
        const markSearchTransient = () => {
          sawTransientError = true;
        };
        const markSearchSuccess = () => {
          finderSucceeded = true;
        };
        let searchCandidates = await searchMetacriticCandidates(title, priority, {
          onTransientError: markSearchTransient,
          onSuccess: markSearchSuccess,
        });
        let ranked = rankCandidateSlugs(title, searchCandidates, storefrontAnchor);

        const midNumeralQuery = stripIntermediateSubtitleNumeral(title);
        if (ranked.length === 0 && midNumeralQuery && midNumeralQuery !== title) {
          const midSearchCandidates = await searchMetacriticCandidates(midNumeralQuery, priority, {
            onTransientError: markSearchTransient,
            onSuccess: markSearchSuccess,
          });
          if (midSearchCandidates.length > 0) {
            searchCandidates = midSearchCandidates;
            ranked = rankCandidateSlugs(title, searchCandidates, storefrontAnchor);
          }
        }

        const phraseStrippedForSearch = stripPackagingEditionPhrases(
          stripYearEditionPhrases(stripTrailingDelimitedReleaseYear(title))
        );
        const strippedSlug = stripMetacriticEditionSlug(
          toCanonicalMetacriticSlug(phraseStrippedForSearch) || baseCanonicalSlug
        );
        if (ranked.length === 0 && strippedSlug && strippedSlug !== baseCanonicalSlug) {
          const strippedQuery = strippedSlug.replace(/-/g, ' ');
          searchCandidates = await searchMetacriticCandidates(strippedQuery, priority, {
            onTransientError: markSearchTransient,
            onSuccess: markSearchSuccess,
          });
          ranked = rankCandidateSlugs(strippedQuery, searchCandidates, storefrontAnchor);
        }

        const modernRemakeSlugs: string[] = [];
        if (titleYear === null && paramYear !== null) {
          for (const cand of searchCandidates) {
            const candYear = extractYearFromDateString(cand.releaseDate);
            if (candYear === null || Math.abs(candYear - paramYear) > 2) continue;
            const candTitle = cand.title || cand.slug.replace(/-/g, ' ');
            const isCompat =
              !isSequelMismatch(title, candTitle) &&
              (!cand.title || isTitleCompatible(title, cand.title));
            if (isCompat) {
              modernRemakeExistsInFinder = true;
              if (!modernRemakeSlugs.includes(cand.slug)) {
                modernRemakeSlugs.push(cand.slug);
              }
            }
          }
        }

        const step3Slugs = Array.from(new Set([...modernRemakeSlugs, ...ranked.slice(0, 2)]));

        for (const s of step3Slugs) {
          const isAnchor = Boolean(anchorSlug && isAnchorMatch(s, anchorSlug));
          if (!testedSlugs.has(s)) {
            testedSlugs.add(s);
            const evalRes = await evaluateSlug(s, isAnchor, 0, false);
            if (evalRes.critic) {
              const bundle: MetacriticBundle = {
                critic: evalRes.critic,
                user: evalRes.user || fallbackUser,
              };
              this.setCacheBounded(cacheKey, bundle, title, capturedEpoch, capturedKeyEpoch);
              return bundle;
            }
            recordDeferredOlder(evalRes);
          }

          const searchCand = searchCandidates.find((c) => c.slug === s);
          if (
            searchCand &&
            typeof searchCand.score === 'number' &&
            searchCand.score > 0 &&
            (!searchCand.title || isTitleCompatible(title, searchCand.title))
          ) {
            const candYear = extractYearFromDateString(searchCand.releaseDate);
            const candTitleForGuard = searchCand.title || s.replace(/-/g, ' ');
            const candHasFirstInstallment = /\b(?:1|i)\b/i.test(candTitleForGuard);
            const candHasRetroKeyword = /\b(classic|original|plus|dos)\b/i.test(candTitleForGuard);
            const isRebootMismatch =
              ((queryHasExplicitFirstInstallment && !candHasFirstInstallment) ||
                (isExplicitRetroQuery && !candHasRetroKeyword)) &&
              Boolean(candYear && candYear >= 2008);
            const yearStatus = evaluateReleaseYearCompatibility(identityCtx, candYear, isAnchor);
            if (!isRebootMismatch && yearStatus !== 'reject') {
              const jsonScore = Math.round(searchCand.score);
              const jsonCritic: CriticScoreData = {
                id: `mc-${s}`,
                source: 'metacritic',
                score: jsonScore,
                tier: calculateTier(jsonScore),
                numReviews: 20,
                url: `https://www.metacritic.com/game/${s}/critic-reviews/`,
                summary: `Metacritic consensus score based on critic reviews.`,
                isVerified: true,
                isSynthetic: false,
              };
              if (yearStatus === 'accept') {
                const bundle: MetacriticBundle = { critic: jsonCritic, user: fallbackUser };
                this.setCacheBounded(cacheKey, bundle, title, capturedEpoch, capturedKeyEpoch);
                return bundle;
              }
              if (yearStatus === 'defer_older' && candYear !== null && !deferredOlderCritic) {
                deferredOlderCritic = { critic: jsonCritic, user: null, pageYear: candYear };
              }
            }
          }
        }
      } catch {
        sawTransientError = true;
      }

      // Two-phase promotion for deferred older pages
      const promotedOlderCritic = deferredOlderCritic as DeferredOlderCritic | null;
      if (
        promotedOlderCritic &&
        finderSucceeded &&
        !sawTransientError &&
        !modernRemakeExistsInFinder
      ) {
        const bundle: MetacriticBundle = {
          critic: promotedOlderCritic.critic,
          user: promotedOlderCritic.user || fallbackUser,
        };
        this.setCacheBounded(cacheKey, bundle, title, capturedEpoch, capturedKeyEpoch);
        return bundle;
      }

      const promotedOlderUser = deferredOlderUser as DeferredOlderUser | null;
      if (
        !fallbackUser &&
        promotedOlderUser &&
        finderSucceeded &&
        !sawTransientError &&
        !modernRemakeExistsInFinder
      ) {
        fallbackUser = promotedOlderUser.user;
      }

      if ((promotedOlderCritic || promotedOlderUser) && !finderSucceeded) {
        sawTransientError = true;
      }

      // 4. Final Storefront Anchor ground-truth fallback if Composer/HTML & backend search failed
      if (
        typeof storefrontAnchor?.metacriticScore === 'number' &&
        storefrontAnchor.metacriticScore > 0
      ) {
        const fallbackSlug =
          anchorSlug ||
          storefrontAnchor.metacriticSlug ||
          toCanonicalMetacriticSlug(title);
        if (fallbackSlug && isAnchorSlugCompatible(title, fallbackSlug)) {
          const anchorCritic: CriticScoreData = {
            id: `mc-${fallbackSlug}`,
            source: 'metacritic',
            score: storefrontAnchor.metacriticScore,
            tier: calculateTier(storefrontAnchor.metacriticScore),
            numReviews: 20,
            url:
              storefrontAnchor.metacriticUrl ||
              `https://www.metacritic.com/game/${fallbackSlug}/critic-reviews/`,
            summary: `Verified by official ${storefrontAnchor.storefront.toUpperCase()} store review anchor.`,
            isVerified: true,
            isSynthetic: false,
          };
          const bundle: MetacriticBundle = {
            critic: anchorCritic,
            user: fallbackUser,
            ...(!onlineLifecycleManager.isOnline() && !fallbackUser
              ? { offlinePartialUserScore: true }
              : {}),
          };
          this.setCacheBounded(cacheKey, bundle, title, capturedEpoch, capturedKeyEpoch);
          return bundle;
        }
      }

      const finalBundle: MetacriticBundle = { critic: null, user: fallbackUser };
      if (
        finalBundle.critic === null &&
        finalBundle.user === null &&
        (sawTransientError || !onlineLifecycleManager.isOnline())
      ) {
        if (this.isEpochCurrent(capturedEpoch, cacheKey, capturedKeyEpoch)) {
          this.transientFailureTitles.add(titleLower);
        }
        return finalBundle;
      }
      this.setCacheBounded(cacheKey, finalBundle, title, capturedEpoch, capturedKeyEpoch);
      return finalBundle;
    })().finally(() => {
      if (this.inFlight.get(cacheKey) === promise) {
        this.inFlight.delete(cacheKey);
      }
    });

    this.inFlight.set(cacheKey, promise);
    return promise;
  }

  /**
   * Resolves verified Critic score only.
   */
  async resolveCriticScore(
    rawTitle: string,
    releaseYear?: number | string | null,
    storefrontAnchor?: StorefrontReviewAnchor | null,
    priority: number = Priority.P1_VIEWPORT
  ): Promise<CriticScoreData | null> {
    const bundle = await this.resolveMetacritic(rawTitle, releaseYear, storefrontAnchor, priority);
    return bundle.critic;
  }

  /**
   * Resolves verified User score only.
   */
  async resolveUserScore(
    rawTitle: string,
    releaseYear?: number | string | null,
    storefrontAnchor?: StorefrontReviewAnchor | null,
    priority: number = Priority.P1_VIEWPORT
  ): Promise<CriticScoreData | null> {
    const bundle = await this.resolveMetacritic(rawTitle, releaseYear, storefrontAnchor, priority);
    return bundle.user;
  }

  /**
   * Backward-compatible resolveScore: returns Critic score if available, otherwise User score.
   */
  async resolveScore(
    rawTitle: string,
    releaseYear?: number | string | null,
    storefrontAnchor?: StorefrontReviewAnchor | null,
    priority: number = Priority.P1_VIEWPORT
  ): Promise<CriticScoreData | null> {
    const bundle = await this.resolveMetacritic(rawTitle, releaseYear, storefrontAnchor, priority);
    return bundle.critic || bundle.user;
  }

  public evictForGame(rawTitle?: string | null): void {
    const titleLower = (rawTitle || '').trim().toLowerCase();
    if (!titleLower) return;
    this.transientFailureTitles.delete(titleLower);
    const keysToDelete = new Set<string>([titleLower]);
    const exactSet = this.cacheKeysByTitle.get(titleLower);
    if (exactSet) {
      for (const k of exactSet) keysToDelete.add(k);
    }
    const normTitle = normalizeTitleKey(titleLower);
    if (normTitle && normTitle !== titleLower) {
      this.transientFailureTitles.delete(normTitle);
      keysToDelete.add(normTitle);
      const normSet = this.cacheKeysByTitle.get(normTitle);
      if (normSet) {
        for (const k of normSet) keysToDelete.add(k);
      }
    }
    for (const k of keysToDelete) {
      this.deleteCacheKey(k, true);
    }
  }

  clearCache(): void {
    this.cacheEpoch += 1;
    this.keyEpochs.clear();
    this.cache.clear();
    this.cacheKeysByTitle.clear();
    this.cacheKeyToTitleKeys.clear();
    this.inFlight.clear();
    this.transientFailureTitles.clear();
  }
}

export const metacriticResolver = new MetacriticResolver();
