import type { CriticScoreData, StorefrontReviewAnchor } from '../../../contracts/critic';
import { classifyNetworkError } from '../../../contracts/network';
import type { UserGameOverride } from '../../../contracts/override';
import { isGogStoreUrl } from '../../common/storeUrlUtils';
import { normalizeTitleForStoreSearch } from '../../common/titleUtils';
import { onlineLifecycleManager } from '../../network/onlineLifecycleManager';
import { Priority } from '../../network/requestScheduler';
import {
  MutabilityTier,
  loadStagedCache,
  saveStagedCache,
} from '../../storage/stagedCacheService';
import { inferReviewRouteFromOverride } from '../../storage/userOverrideStorage';
import {
  calculateSyntheticSteamScore,
  calculateTier,
  getReviewSourceAuthorityRank,
  normalizeCriticTitleKey,
  stripEditionSuffix,
} from '../criticUtils';
import { KNOWN_CRITIC_SCORES, KNOWN_UNRATED_TITLES } from '../knownCriticScores';
import { isAnchorSlugCompatible } from '../metacritic/metacriticTitleMatching';
import { type MetacriticBundle, metacriticResolver } from '../metacriticResolver';
import { openCriticResolver } from '../openCriticResolver';
import { steamReviewResolver } from '../steamReviewResolver';
import { storefrontReviewHarvester } from '../storefrontReviewHarvester';
import { storefrontStarResolver } from '../storefrontStarResolver';
import { normalizeWikidataGogSlug, wikidataBridge } from '../wikidataBridge';
import {
  type CriticEntitlementPlatform,
  type CriticScoreContext,
  NON_GAME_ADDON_OR_BETA_REGEX,
  STORAGE_PREFIX,
  hasAnyKnownCriticScore,
} from './criticServiceTypes';

export interface DynamicCascadeOptions {
  bypassAttempted?: boolean;
  platforms?: CriticEntitlementPlatform[];
  gameId?: string;
  genres?: string[];
  steamPositivePercent?: number;
}

export interface DynamicCascadeDeps {
  cacheKey: string;
  stagedKey: string;
  title: string;
  steamAppId?: number | null;
  year?: number | string | null;
  effectiveReleaseDate?: string;
  enrichedGenres?: string[];
  storefrontAnchor?: StorefrontReviewAnchor | null;
  options?: DynamicCascadeOptions;
  isEpochCurrent: () => boolean;
  validateSemantic: (
    rawTitle: string,
    scoreData: CriticScoreData | null | undefined,
    steamAppId?: number | null,
    verifiedAnchorSlug?: string | null
  ) => boolean;
  findMatchingUserOverride: (
    steamAppId?: number | null,
    title?: string,
    gameId?: string,
    platforms?: CriticEntitlementPlatform[]
  ) => UserGameOverride | undefined;
  getInMemoryCache: (key: string) => CriticScoreData | null | undefined;
  setInMemoryCache: (key: string, value: CriticScoreData | null) => void;
  deleteAttempted: (key: string) => void;
  getTransientFailureCount: (key: string) => number;
  setTransientFailureCount: (key: string, count: number) => void;
  deleteTransientFailureCount: (key: string) => void;
  cacheResult: (
    key: string,
    data: CriticScoreData | null,
    releaseDate?: string | Date | number | null,
    genres?: string[] | string | null,
    options?: {
      dynamicResolved?: boolean;
      allowOverwritePositive?: boolean;
      allowAuthorityDowngrade?: boolean;
      aliasTitle?: string;
      customTtlMs?: number;
      cachedAt?: number;
      hadTransientError?: boolean;
      titleForValidation?: string;
      steamAppIdForValidation?: number | null;
    }
  ) => boolean;
  scheduleVaultWriteThrough: (
    gameId: string,
    criticScore: CriticScoreData,
    steamAppId?: number | null,
    canonicalTitle?: string
  ) => void;
}

function extractGogSlugFromContext(
  platforms?: CriticEntitlementPlatform[],
  anchor?: StorefrontReviewAnchor | null
): string | undefined {
  if (anchor?.storefront === 'gog' && anchor.rawStoreUrl) {
    const fromAnchor = normalizeWikidataGogSlug(anchor.rawStoreUrl);
    if (fromAnchor) return fromAnchor;
  }
  if (Array.isArray(platforms)) {
    for (const p of platforms) {
      if (p?.platformId?.toLowerCase() === 'gog') {
        const fromPlat =
          normalizeWikidataGogSlug(p.platformGameId) ||
          normalizeWikidataGogSlug(p.storefrontAppId);
        if (fromPlat) return fromPlat;
      }
    }
  }
  return undefined;
}

export async function runDynamicCriticCascade(
  deps: DynamicCascadeDeps
): Promise<CriticScoreData | null> {
  const {
    cacheKey,
    stagedKey,
    title,
    steamAppId,
    year,
    effectiveReleaseDate,
    enrichedGenres,
    storefrontAnchor,
    options,
  } = deps;

  const cleanTitle =
    normalizeTitleForStoreSearch(title, { stripEditions: true }) ||
    normalizeTitleForStoreSearch(title);

  const lower = title.toLowerCase();
  const normKey = normalizeCriticTitleKey(title);

  const isCandidateValid = (
    candidate: CriticScoreData | null | undefined,
    verifiedAnchorSlug?: string | null
  ): candidate is CriticScoreData =>
    candidate
      ? deps.validateSemantic(title, candidate, steamAppId, verifiedAnchorSlug)
      : false;

  let priorPositiveScore: CriticScoreData | null = null;
  let priorPositiveIsFresh = false;
  const priorKeys = [stagedKey];
  if (lower && stagedKey !== `${STORAGE_PREFIX}title:${lower}`) {
    priorKeys.push(`${STORAGE_PREFIX}title:${lower}`);
  }
  if (normKey && stagedKey !== `${STORAGE_PREFIX}title:${normKey}`) {
    priorKeys.push(`${STORAGE_PREFIX}title:${normKey}`);
  }
  for (const pKey of priorKeys) {
    const priorStaged = loadStagedCache<CriticScoreData>(pKey, false);
    if (
      priorStaged.data &&
      typeof priorStaged.data.score === 'number' &&
      priorStaged.data.score > 0 &&
      isCandidateValid(priorStaged.data, storefrontAnchor?.metacriticSlug)
    ) {
      const candRank = getReviewSourceAuthorityRank(priorStaged.data);
      const curRank = getReviewSourceAuthorityRank(priorPositiveScore);
      if (
        !priorPositiveScore ||
        candRank > curRank ||
        (candRank === curRank && priorStaged.valid && !priorPositiveIsFresh)
      ) {
        priorPositiveScore = priorStaged.data;
        priorPositiveIsFresh = priorStaged.valid;
      }
    }
  }
  if (!priorPositiveScore) {
    const memExisting = deps.getInMemoryCache(cacheKey);
    if (
      memExisting &&
      typeof memExisting.score === 'number' &&
      memExisting.score > 0 &&
      isCandidateValid(memExisting, storefrontAnchor?.metacriticSlug)
    ) {
      priorPositiveScore = memExisting;
    } else if (
      steamAppId &&
      typeof options?.steamPositivePercent === 'number' &&
      options.steamPositivePercent > 0
    ) {
      const synthetic = calculateSyntheticSteamScore(options.steamPositivePercent);
      priorPositiveScore = {
        id: `steam-${steamAppId}`,
        source: 'steam',
        score: synthetic.score,
        percentRecommended: synthetic.percentRecommended,
        tier: synthetic.tier,
        numReviews: 50,
        url: `https://store.steampowered.com/app/${steamAppId}`,
        summary: `Based on Steam community player reviews (${options.steamPositivePercent}% positive).`,
        isVerified: false,
        isSynthetic: true,
      };
    }
  }

  const retainExplicitUnrated = (): CriticScoreData | null => {
    if (!deps.isEpochCurrent()) return null;
    const current = deps.getInMemoryCache(cacheKey);
    if (current?.isSynthetic && isCandidateValid(current)) {
      deps.cacheResult(cacheKey, current, effectiveReleaseDate, enrichedGenres, {
        dynamicResolved: true,
        aliasTitle: title,
        titleForValidation: title,
        steamAppIdForValidation: steamAppId,
      });
      if (lower && cacheKey !== `title:${lower}`) {
        deps.setInMemoryCache(`title:${lower}`, current);
      }
      if (normKey && cacheKey !== `title:${normKey}`) {
        deps.setInMemoryCache(`title:${normKey}`, current);
      }
      return current;
    }
    deps.cacheResult(cacheKey, null, effectiveReleaseDate, enrichedGenres, {
      dynamicResolved: true,
      allowOverwritePositive: true,
      allowAuthorityDowngrade: true,
      aliasTitle: title,
      titleForValidation: title,
      steamAppIdForValidation: steamAppId,
    });
    if (lower && cacheKey !== `title:${lower}`) {
      deps.setInMemoryCache(`title:${lower}`, null);
    }
    if (normKey && cacheKey !== `title:${normKey}`) {
      deps.setInMemoryCache(`title:${normKey}`, null);
    }
    return null;
  };

  if (
    NON_GAME_ADDON_OR_BETA_REGEX.test(title) ||
    (KNOWN_UNRATED_TITLES.size > 0 &&
      (KNOWN_UNRATED_TITLES.has(lower) || (Boolean(normKey) && KNOWN_UNRATED_TITLES.has(normKey))))
  ) {
    return retainExplicitUnrated();
  }

  if (!onlineLifecycleManager.isOnline()) {
    if (!deps.isEpochCurrent()) return null;
    deps.deleteAttempted(cacheKey);
    if (lower) deps.deleteAttempted(`title:${lower}`);
    if (priorPositiveScore) {
      deps.setInMemoryCache(cacheKey, priorPositiveScore);
      if (lower && cacheKey !== `title:${lower}`) {
        deps.setInMemoryCache(`title:${lower}`, priorPositiveScore);
      }
      if (normKey && cacheKey !== `title:${normKey}`) {
        deps.setInMemoryCache(`title:${normKey}`, priorPositiveScore);
      }
      return priorPositiveScore;
    }
    const current = deps.getInMemoryCache(cacheKey);
    if (current && isCandidateValid(current)) {
      return current;
    }
    return null;
  }

  let hadTransientError = false;

  const retainSyntheticOrNull = (): CriticScoreData | null => {
    if (!deps.isEpochCurrent()) return null;
    if (priorPositiveScore) {
      if (priorPositiveScore.isSynthetic && onlineLifecycleManager.isOnline()) {
        deps.cacheResult(cacheKey, priorPositiveScore, effectiveReleaseDate, enrichedGenres, {
          dynamicResolved: true,
          aliasTitle: title,
          hadTransientError,
          titleForValidation: title,
          steamAppIdForValidation: steamAppId,
        });
      }
      deps.setInMemoryCache(cacheKey, priorPositiveScore);
      if (lower && cacheKey !== `title:${lower}`) {
        deps.setInMemoryCache(`title:${lower}`, priorPositiveScore);
      }
      if (normKey && cacheKey !== `title:${normKey}`) {
        deps.setInMemoryCache(`title:${normKey}`, priorPositiveScore);
      }
      return priorPositiveScore;
    }

    const current = deps.getInMemoryCache(cacheKey);
    if (current?.isSynthetic && isCandidateValid(current)) {
      if (onlineLifecycleManager.isOnline()) {
        deps.cacheResult(cacheKey, current, effectiveReleaseDate, enrichedGenres, {
          dynamicResolved: true,
          aliasTitle: title,
          hadTransientError,
          titleForValidation: title,
          steamAppIdForValidation: steamAppId,
        });
      }
      if (lower && cacheKey !== `title:${lower}`) {
        deps.setInMemoryCache(`title:${lower}`, current);
      }
      if (normKey && cacheKey !== `title:${normKey}`) {
        deps.setInMemoryCache(`title:${normKey}`, current);
      }
      return current;
    }

    if (!onlineLifecycleManager.isOnline()) {
      deps.deleteAttempted(cacheKey);
      if (lower) deps.deleteAttempted(`title:${lower}`);
      return null;
    }

    if (hadTransientError) {
      const prevFailures = deps.getTransientFailureCount(cacheKey);
      const nextFailures = prevFailures + 1;
      deps.setTransientFailureCount(cacheKey, nextFailures);
      const TWO_HOURS_MS = 2 * 60 * 60 * 1000;
      const TWENTY_FOUR_HOURS_MS = 24 * 60 * 60 * 1000;
      const backoffTtlMs = Math.min(
        TWENTY_FOUR_HOURS_MS,
        TWO_HOURS_MS * Math.pow(2, nextFailures - 1)
      );
      const savedTransient = saveStagedCache<CriticScoreData>(
        stagedKey,
        null,
        'transient_error',
        {
          failureReason: 'network_error',
          dynamicResolved: true,
          customTtlMs: backoffTtlMs,
        }
      );
      if (lower && stagedKey !== `${STORAGE_PREFIX}title:${lower}`) {
        const titleStagedKey = `${STORAGE_PREFIX}title:${lower}`;
        const existingTitleStaged = loadStagedCache<CriticScoreData>(titleStagedKey, false);
        if (
          !existingTitleStaged.entry ||
          (existingTitleStaged.entry.tier !== MutabilityTier.TIER_0_USER_OVERRIDE &&
            existingTitleStaged.entry.tier !== 'override')
        ) {
          const hasPositiveTitle =
            existingTitleStaged.valid &&
            existingTitleStaged.data &&
            typeof existingTitleStaged.data.score === 'number' &&
            existingTitleStaged.data.score > 0;
          if (!hasPositiveTitle) {
            saveStagedCache<CriticScoreData>(titleStagedKey, null, 'transient_error', {
              failureReason: 'network_error',
              dynamicResolved: true,
              cachedAt: savedTransient.cachedAt,
              customTtlMs: backoffTtlMs,
            });
          }
        }
      }
      return null;
    }

    deps.deleteTransientFailureCount(cacheKey);
    deps.cacheResult(cacheKey, null, effectiveReleaseDate, enrichedGenres, {
      dynamicResolved: true,
      aliasTitle: title,
      titleForValidation: title,
      steamAppIdForValidation: steamAppId,
    });
    if (lower && cacheKey !== `title:${lower}`) {
      deps.setInMemoryCache(`title:${lower}`, null);
    }
    if (normKey && cacheKey !== `title:${normKey}`) {
      deps.setInMemoryCache(`title:${normKey}`, null);
    }
    return null;
  };

  // Harvest storefront ground truth anchor if not passed in
  let anchor = storefrontAnchor;
  if (!anchor) {
    try {
      anchor = await storefrontReviewHarvester.getStorefrontAnchor({
        title,
        steamAppId,
        platforms: options?.platforms,
        id: options?.gameId,
      });
    } catch (anchorErr: unknown) {
      if (classifyNetworkError(anchorErr).status === 'transient_error') {
        hadTransientError = true;
      }
      anchor = null;
    }
  }

  const gogSlug = extractGogSlugFromContext(options?.platforms, anchor);
  const buildAnchorWithWikidataSlug = (
    baseAnchor: StorefrontReviewAnchor | null | undefined,
    mcSlug: string
  ): StorefrontReviewAnchor => ({
    ...(baseAnchor ?? { storefront: gogSlug ? 'gog' : 'steam' }),
    metacriticSlug: mcSlug,
    metacriticUrl:
      baseAnchor?.metacriticUrl ||
      `https://www.metacritic.com/game/${mcSlug}/critic-reviews/`,
    isVerifiedGroundTruth: true,
  });

  // Pre-check cached Wikidata links (populated by Stage 1 batch SPARQL pre-pass or prior lookups)
  let wdLinks = wikidataBridge.getCachedLinks({
    steamAppId,
    gogSlug,
    title: cleanTitle || title,
  });

  const broadcastUpdate = (
    data: CriticScoreData,
    verifiedAnchorSlug?: string | null
  ): CriticScoreData | null => {
    if (!deps.isEpochCurrent()) {
      return null;
    }
    if (!isCandidateValid(data, verifiedAnchorSlug)) {
      return priorPositiveScore ?? data;
    }
    const activeOverride = deps.findMatchingUserOverride(
      steamAppId,
      title,
      options?.gameId,
      options?.platforms
    );
    if (
      activeOverride &&
      (activeOverride.reviewScoreOverride !== undefined || activeOverride.reviewRoute !== undefined)
    ) {
      const activeRoute = inferReviewRouteFromOverride(activeOverride);
      if (activeRoute?.mode === 'unrated') {
        return null;
      }
      if (activeOverride.reviewScoreOverride !== undefined) {
        return activeOverride.reviewScoreOverride ?? null;
      }
    }

    // Monotonic Source-Authority Lattice guard: never overwrite an existing non-expired,
    // semantically valid cached score with a lower-authority source.
    const incomingRank = getReviewSourceAuthorityRank(data);
    let highestExisting: CriticScoreData | null = null;
    let highestExistingRank = 0;

    const considerExisting = (cand: CriticScoreData | null | undefined) => {
      if (!cand || typeof cand.score !== 'number' || cand.score <= 0) return;
      if (!isCandidateValid(cand, verifiedAnchorSlug)) return;
      const rank = getReviewSourceAuthorityRank(cand);
      if (rank > highestExistingRank) {
        highestExistingRank = rank;
        highestExisting = cand;
      }
    };

    for (const pKey of priorKeys) {
      const existingStaged = loadStagedCache<CriticScoreData>(pKey, false);
      if (existingStaged.valid && existingStaged.data) {
        considerExisting(existingStaged.data);
      }
    }
    if (priorPositiveScore && (priorPositiveIsFresh || hadTransientError)) {
      considerExisting(priorPositiveScore);
    }
    const memCandidate = deps.getInMemoryCache(cacheKey);
    const stagedForMem = loadStagedCache<CriticScoreData>(stagedKey, false);
    if (memCandidate && !stagedForMem.stale) {
      considerExisting(memCandidate);
    }

    if (highestExisting && incomingRank < highestExistingRank) {
      deps.setInMemoryCache(cacheKey, highestExisting);
      if (lower && cacheKey !== `title:${lower}`) {
        deps.setInMemoryCache(`title:${lower}`, highestExisting);
      }
      if (normKey && cacheKey !== `title:${normKey}`) {
        deps.setInMemoryCache(`title:${normKey}`, highestExisting);
      }
      return highestExisting;
    }

    deps.deleteTransientFailureCount(cacheKey);
    const wrote = deps.cacheResult(cacheKey, data, effectiveReleaseDate, enrichedGenres, {
      dynamicResolved: true,
      aliasTitle: title,
      hadTransientError,
      titleForValidation: title,
      steamAppIdForValidation: steamAppId,
    });
    if (!wrote && highestExisting) {
      return highestExisting;
    }
    if (lower && cacheKey !== `title:${lower}`) {
      deps.setInMemoryCache(`title:${lower}`, data);
    }
    if (normKey && cacheKey !== `title:${normKey}`) {
      deps.setInMemoryCache(`title:${normKey}`, data);
    }
    const baseKey = stripEditionSuffix(title);
    if (baseKey && baseKey !== normKey && cacheKey !== `title:${baseKey}`) {
      deps.setInMemoryCache(`title:${baseKey}`, data);
    }
    if (options?.gameId) {
      deps.scheduleVaultWriteThrough(options.gameId, data, steamAppId, title);
    }
    if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
      window.dispatchEvent(
        new CustomEvent('antigravity_critic_updated', {
          detail: { cacheKey, title, steamAppId, data },
        })
      );
    }
    return data;
  };

  // ==========================================
  // TIER 1: Metacritic Live Composer / HTML Resolution
  // ==========================================
  const tier1Anchor =
    !anchor?.metacriticSlug && wdLinks?.metacriticSlug
      ? buildAnchorWithWikidataSlug(anchor, wdLinks.metacriticSlug)
      : anchor;
  let mcBundle: MetacriticBundle | null = null;
  try {
    mcBundle = await metacriticResolver.resolveMetacritic(
      title,
      year,
      tier1Anchor,
      Priority.P1_VIEWPORT
    );
    if (metacriticResolver.hadRecentTransientFailure(title)) {
      hadTransientError = true;
    }
    if (
      mcBundle?.critic &&
      mcBundle.critic.isVerified &&
      mcBundle.critic.score > 0 &&
      isCandidateValid(mcBundle.critic, tier1Anchor?.metacriticSlug)
    ) {
      return broadcastUpdate(mcBundle.critic, tier1Anchor?.metacriticSlug);
    }
  } catch (mcErr: unknown) {
    if (classifyNetworkError(mcErr).status === 'transient_error') {
      hadTransientError = true;
    }
    console.warn(
      `[CriticScoreService] Metacritic check warning for "${title}":`,
      mcErr instanceof Error ? mcErr.message : String(mcErr)
    );
  }

  // Wikidata CC0 Bridge lookup when Tier 1 produced no critic score
  if (!wdLinks) {
    try {
      wdLinks = await wikidataBridge.resolveForGame({
        steamAppId,
        gogSlug,
        title: cleanTitle || title,
        releaseYear: year,
        priority: Priority.P1_VIEWPORT,
      });
      const wdFailKeys = [
        steamAppId ? `steam:${steamAppId}` : '',
        gogSlug ? `gog:${gogSlug}` : '',
        normKey ? `title:${normKey}` : '',
      ].filter(Boolean);
      if (wdFailKeys.some((k) => wikidataBridge.hadRecentTransientFailure(k))) {
        hadTransientError = true;
      }
    } catch (wdErr: unknown) {
      if (classifyNetworkError(wdErr).status === 'transient_error') {
        hadTransientError = true;
      }
    }
  }

  if (
    wdLinks?.metacriticSlug &&
    wdLinks.metacriticSlug !== tier1Anchor?.metacriticSlug
  ) {
    const wdMcAnchor = buildAnchorWithWikidataSlug(anchor, wdLinks.metacriticSlug);
    try {
      const wdMcBundle = await metacriticResolver.resolveMetacritic(
        cleanTitle || title,
        year,
        wdMcAnchor,
        Priority.P1_VIEWPORT
      );
      if (metacriticResolver.hadRecentTransientFailure(cleanTitle || title)) {
        hadTransientError = true;
      }
      if (
        wdMcBundle?.critic &&
        wdMcBundle.critic.isVerified &&
        wdMcBundle.critic.score > 0 &&
        isCandidateValid(wdMcBundle.critic, wdLinks.metacriticSlug)
      ) {
        return broadcastUpdate(wdMcBundle.critic, wdLinks.metacriticSlug);
      }
      if (!mcBundle?.user && wdMcBundle?.user) {
        mcBundle = wdMcBundle;
      }
    } catch (wdMcErr: unknown) {
      if (classifyNetworkError(wdMcErr).status === 'transient_error') {
        hadTransientError = true;
      }
    }
  }

  // Rule 1 Fallback: If Metacritic scrape failed or was blocked, but storefrontAnchor contains verified metacriticScore
  if (
    anchor?.metacriticScore !== undefined &&
    typeof anchor.metacriticScore === 'number' &&
    anchor.metacriticScore > 0
  ) {
    const mcSlug =
      anchor.metacriticSlug ||
      cleanTitle.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    if (isAnchorSlugCompatible(title, mcSlug)) {
      const mcUrl =
        anchor.metacriticUrl ||
        `https://www.metacritic.com/game/${mcSlug}/critic-reviews/`;
      const anchorMcResult: CriticScoreData = {
        id: `mc-${mcSlug}`,
        source: 'metacritic',
        score: anchor.metacriticScore,
        tier: calculateTier(anchor.metacriticScore),
        numReviews: 20,
        url: mcUrl,
        summary: `Verified by official ${anchor.storefront.toUpperCase()} store review anchor.`,
        isVerified: true,
        isSynthetic: false,
      };
      if (isCandidateValid(anchorMcResult, mcSlug)) {
        return broadcastUpdate(anchorMcResult, mcSlug);
      }
    }
  }

  // Preserve verified OpenCritic score if Metacritic didn't produce a Tier 1 score
  const hasKnown = hasAnyKnownCriticScore();
  const existingPreSeeded =
    deps.getInMemoryCache(cacheKey) ||
    (hasKnown
      ? (steamAppId ? KNOWN_CRITIC_SCORES[steamAppId] : undefined) ||
        KNOWN_CRITIC_SCORES[lower] ||
        (normKey ? KNOWN_CRITIC_SCORES[normKey] : undefined)
      : undefined);

  if (
    existingPreSeeded?.isVerified &&
    existingPreSeeded.source === 'opencritic' &&
    isCandidateValid(existingPreSeeded)
  ) {
    if (deps.isEpochCurrent()) {
      deps.cacheResult(cacheKey, existingPreSeeded, effectiveReleaseDate, enrichedGenres, {
        dynamicResolved: true,
        aliasTitle: title,
        titleForValidation: title,
        steamAppIdForValidation: steamAppId,
      });
      if (lower && cacheKey !== `title:${lower}`) {
        deps.setInMemoryCache(`title:${lower}`, existingPreSeeded);
      }
      if (normKey && cacheKey !== `title:${normKey}`) {
        deps.setInMemoryCache(`title:${normKey}`, existingPreSeeded);
      }
    }
    return existingPreSeeded;
  }

  // ==========================================
  // TIER 2: OpenCritic SSR Resolution (via Wikidata P2864 / Storefront Anchor)
  // ==========================================
  try {
    const resolvedOcId = anchor?.openCriticId ?? wdLinks?.openCriticId ?? null;
    const ocResult = await openCriticResolver.resolveForGame({
      title: cleanTitle || title,
      steamAppId,
      gogSlug,
      releaseYear: year,
      openCriticId: resolvedOcId,
      storefrontAnchor: anchor,
      priority: Priority.P1_VIEWPORT,
    });

    const ocTransient =
      openCriticResolver.hadRecentTransientFailure(cleanTitle || title) ||
      openCriticResolver.hadRecentTransientFailure(title) ||
      (steamAppId ? openCriticResolver.hadRecentTransientFailure(String(steamAppId)) : false) ||
      (resolvedOcId ? openCriticResolver.hadRecentTransientFailure(String(resolvedOcId)) : false);
    if (ocTransient) {
      hadTransientError = true;
    }

    if (ocResult && ocResult.score > 0) {
      const isVerifiedStorefrontOcAnchor = Boolean(
        !steamAppId &&
          anchor?.isVerifiedGroundTruth &&
          ocResult.summary?.includes('store review anchor')
      );
      const isDisallowedGogOcOnSteam = Boolean(
        steamAppId &&
          anchor?.storefront === 'gog' &&
          !anchor.openCriticId &&
          isGogStoreUrl(ocResult.url)
      );
      if (
        !isDisallowedGogOcOnSteam &&
        (isCandidateValid(ocResult) || isVerifiedStorefrontOcAnchor)
      ) {
        return broadcastUpdate(ocResult);
      }
    }
  } catch (ocErr: unknown) {
    if (classifyNetworkError(ocErr).status === 'transient_error') {
      hadTransientError = true;
    }
    console.warn(
      `[CriticScoreService] OpenCritic check warning for "${title}":`,
      ocErr instanceof Error ? ocErr.message : String(ocErr)
    );
  }

  // ==========================================
  // TIER 3 & 4: Metacritic User Score & Steam Live Community Reviews
  // ==========================================
  if (mcBundle?.user && mcBundle.user.score > 0 && isCandidateValid(mcBundle.user)) {
    const mcUserCount = mcBundle.user.numReviews || 0;
    if (mcUserCount >= 25 || !steamAppId) {
      return broadcastUpdate(mcBundle.user);
    }

    try {
      const steamResult = await steamReviewResolver.resolveScore(title, steamAppId);
      if (
        steamResult &&
        steamResult.score > 0 &&
        isCandidateValid(steamResult) &&
        (steamResult.numReviews || 0) >= Math.max(100, mcUserCount * 5)
      ) {
        return broadcastUpdate(steamResult);
      }
    } catch (steamErr: unknown) {
      console.warn(
        `[CriticScoreService] Steam live reviews check warning for "${title}":`,
        steamErr instanceof Error ? steamErr.message : String(steamErr)
      );
    }

    return broadcastUpdate(mcBundle.user);
  }

  // ==========================================
  // TIER 4: Steam Live Community Reviews Resolver
  // ==========================================
  try {
    const steamResult = await steamReviewResolver.resolveScore(title, steamAppId);
    if (steamReviewResolver.hadTransientError(title, steamAppId)) {
      hadTransientError = true;
    }
    if (
      steamResult &&
      steamResult.isSynthetic &&
      steamResult.score > 0 &&
      isCandidateValid(steamResult)
    ) {
      return broadcastUpdate(steamResult);
    }
  } catch (steamErr: unknown) {
    if (classifyNetworkError(steamErr).status === 'transient_error') {
      hadTransientError = true;
    }
    console.warn(
      `[CriticScoreService] Steam live reviews check warning for "${title}":`,
      steamErr instanceof Error ? steamErr.message : String(steamErr)
    );
  }

  // ==========================================
  // TIER 5: Storefront Star Rating (GOG / Epic / Xbox, >= 4 reviews)
  // ==========================================
  try {
    const starTitle = cleanTitle || title;
    const gogPlat = options?.platforms?.find((p) => p.platformId === 'gog');
    const gogIdFromGameId = options?.gameId?.match(/^gog[:_-](\d+)$/i)?.[1];
    const gogId = gogPlat?.platformGameId?.trim() || gogIdFromGameId || undefined;
    const epicPlat = options?.platforms?.find((p) => p.platformId === 'epic');
    const epicId = epicPlat?.platformGameId?.trim() || undefined;
    const xboxPlat = options?.platforms?.find((p) => p.platformId === 'xbox') as
      | { platformId: string; platformGameId?: string; xboxProductId?: string }
      | undefined;
    const xboxProductId =
      xboxPlat?.xboxProductId?.trim() ||
      (/^[A-Z0-9]{12}$/i.test(String(xboxPlat?.platformGameId || '').trim())
        ? String(xboxPlat?.platformGameId).trim()
        : undefined);
    const storefrontContext: CriticScoreContext | undefined =
      options?.gameId || (options?.platforms && options.platforms.length > 0)
        ? { gameId: options?.gameId, platforms: options?.platforms }
        : undefined;
    const storefrontResult = await storefrontStarResolver.resolveStorefrontScore(
      {
        title: starTitle,
        ...(gogId ? { gogId } : {}),
        ...(epicId ? { epicId } : {}),
        ...(xboxProductId ? { xboxProductId } : {}),
        ...(storefrontContext ? { context: storefrontContext } : {}),
      },
      storefrontContext
    );
    if (
      storefrontStarResolver.hadRecentTransientFailure(starTitle) ||
      (starTitle !== title && storefrontStarResolver.hadRecentTransientFailure(title))
    ) {
      hadTransientError = true;
    }
    if (storefrontResult && storefrontResult.score > 0 && isCandidateValid(storefrontResult)) {
      return broadcastUpdate(storefrontResult);
    }
  } catch (sfErr: unknown) {
    if (classifyNetworkError(sfErr).status === 'transient_error') {
      hadTransientError = true;
    }
    console.warn(
      `[CriticScoreService] Storefront star check warning for "${title}":`,
      sfErr instanceof Error ? sfErr.message : String(sfErr)
    );
  }

  // ==========================================
  // TIER 6: Truly Unrated
  // ==========================================
  return retainSyntheticOrNull();
}
