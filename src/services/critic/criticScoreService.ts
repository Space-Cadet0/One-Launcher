import { CriticScoreData, CriticTier, OpenCriticData, StorefrontReviewAnchor } from '../../contracts/critic';
import { classifyNetworkError, isWafOrChallengeResponse } from '../../contracts/network';
import type { CanonicalGame } from '../../contracts/game';
import type { UserGameOverride, ReviewScoreRoute } from '../../contracts/override';
import { KNOWN_CRITIC_SCORES, KNOWN_UNRATED_TITLES } from './knownCriticScores';
import steamEnrichedCache from '../storage/steamEnrichedCache.json';
import { FULL_USER_STEAM_GAMES } from '../storage/fullUserSteamGames';
import {
  determineGameMutabilityTier,
  saveStagedCache,
  loadStagedCache,
  evictStagedCache,
  clearExpiredStagedCache,
  isCacheEntryValid,
  isStagedVaultHydrationComplete,
  TIER_TTLS,
  MutabilityTier,
} from '../storage/stagedCacheService';
import {
  getUserOverrideForGame,
  loadUserOverrides,
  inferReviewRouteFromOverride,
  STORAGE_KEY_USER_OVERRIDES,
} from '../storage/userOverrideStorage';
import {
  calculateSyntheticSteamScore,
  calculateTier,
  getTierColor,
  normalizeCriticTitleKey,
  stripEditionSuffix,
  isSequelMismatch,
} from './criticUtils';
import {
  metacriticResolver,
  isTitleCompatible,
  isAnchorSlugCompatible,
  sanitizeMetacriticDescription,
  hasExplicitClassicOrOriginalEditionTag,
} from './metacriticResolver';
import { steamReviewResolver } from './steamReviewResolver';
import { storefrontStarResolver } from './storefrontStarResolver';
import { storefrontReviewHarvester } from './storefrontReviewHarvester';
import { requestScheduler, Priority } from '../network/requestScheduler';
import { onlineLifecycleManager } from '../network/onlineLifecycleManager';

const NON_OVERRIDE_EVENT_TYPES: ReadonlySet<string> = new Set([
  'confirmed-non-game',
  'confirmed-non-game-batch',
  'batch-confirmed-non-game',
  'unconfirmed-non-game',
  'hidden',
  'unhidden',
]);

function extractValidGameOverrideFromEventDetail(
  detail: unknown
): { override: UserGameOverride; oldGame?: CanonicalGame } | null {
  if (!detail || typeof detail !== 'object') return null;
  const record = detail as Record<string, unknown>;
  const hasExplicitOverride = Boolean(record.override && typeof record.override === 'object');
  if (
    !hasExplicitOverride &&
    ('isHidden' in record ||
      'hiddenGameId' in record ||
      'unhiddenKey' in record ||
      (typeof record.type === 'string' && NON_OVERRIDE_EVENT_TYPES.has(record.type)))
  ) {
    return null;
  }

  const candidate = (hasExplicitOverride ? record.override : record) as Partial<UserGameOverride> & {
    type?: unknown;
  };
  if (!candidate || typeof candidate !== 'object') return null;
  if (typeof candidate.type === 'string' && NON_OVERRIDE_EVENT_TYPES.has(candidate.type)) {
    return null;
  }

  const hasValidIdentifier =
    (typeof candidate.gameId === 'string' && candidate.gameId.trim().length > 0) ||
    (typeof candidate.title === 'string' && candidate.title.trim().length > 0) ||
    (typeof candidate.steamAppId === 'number' && candidate.steamAppId > 0) ||
    (typeof candidate.platformGameId === 'string' && candidate.platformGameId.trim().length > 0);
  if (!hasValidIdentifier) {
    return null;
  }

  const oldGame =
    record.oldGame && typeof record.oldGame === 'object'
      ? (record.oldGame as CanonicalGame)
      : undefined;
  return { override: candidate as UserGameOverride, oldGame };
}
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

interface EnrichedSteamCriticCacheEntry {
  name?: string;
  releaseDate?: string;
  release_date?: string;
  genres?: string[];
  reviewSummary?: {
    positivePercent?: number;
    totalReviews?: number;
  };
}

const STEAM_ENRICHED_CRITIC_MAP = steamEnrichedCache as unknown as Record<string, EnrichedSteamCriticCacheEntry>;

const OPENCRITIC_PUBLIC_HEADERS: Record<string, string> = {
  Accept: 'application/json',
  Referer: 'https://opencritic.com/',
};

function isUrlHostMatching(rawUrl: string | undefined, expectedDomain: string): boolean {
  if (!rawUrl || typeof rawUrl !== 'string') return false;
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    const target = expectedDomain.toLowerCase();
    return host === target || host.endsWith(`.${target}`);
  } catch {
    return false;
  }
}

const STEAM_APP_ID_TO_TITLE = new Map<number, string>();
for (const [idStr, info] of Object.entries(STEAM_ENRICHED_CRITIC_MAP)) {
  if (info?.name) {
    STEAM_APP_ID_TO_TITLE.set(Number(idStr), String(info.name));
  }
}
for (const g of FULL_USER_STEAM_GAMES) {
  if (g.steamAppId && g.title && !STEAM_APP_ID_TO_TITLE.has(g.steamAppId)) {
    STEAM_APP_ID_TO_TITLE.set(g.steamAppId, g.title);
  }
}

const NON_GAME_ADDON_OR_BETA_REGEX =
  /\b(public testing|tech beta|playtest|test branch|alpha version|beta version|closed beta|open beta|official walkthrough|walkthrough|digital goodies|digital comics|pre-game editor|resource archiver|playable teaser|bonus content)\b|\bcontent$/i;

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

interface CompiledReviewOverrideIndex {
  hasAnyReviewOverride: boolean;
  byKey: Map<string, UserGameOverride>;
  byGameId: Map<string, UserGameOverride>;
  bySteamId: Map<number, UserGameOverride>;
  byLowerTitle: Map<string, UserGameOverride>;
  byNormTitle: Map<string, UserGameOverride>;
}

export class CriticScoreService {
  public static readonly MAX_IN_MEMORY_CACHE_SIZE = 1200;
  public static readonly EVICT_TARGET_CACHE_SIZE = 1000;
  private inMemoryCache = new Map<string, CriticScoreData | null>();
  private semanticValidationMemo = new WeakMap<CriticScoreData, Map<string, boolean>>();
  private compiledOverrideIndexMemo = new WeakMap<object, CompiledReviewOverrideIndex>();
  private inFlightResolutions = new Map<string, Promise<CriticScoreData | null>>();
  private attemptedDynamicResolutions = new Set<string>();
  private stubPinnedKeys = new Set<string>();
  private transientFailureCounts = new Map<string, number>();
  private listenersInitialized = false;
  private listenerCleanups: Array<() => void> = [];
  private storageHydrated = false;

  private setInMemoryCache(key: string, value: CriticScoreData | null): void {
    if (this.inMemoryCache.has(key)) {
      this.inMemoryCache.delete(key);
    }
    this.inMemoryCache.set(key, value);
    if (this.inMemoryCache.size > CriticScoreService.MAX_IN_MEMORY_CACHE_SIZE) {
      while (this.inMemoryCache.size > CriticScoreService.EVICT_TARGET_CACHE_SIZE) {
        const oldestKey = this.inMemoryCache.keys().next().value;
        if (oldestKey === undefined) break;
        this.inMemoryCache.delete(oldestKey);
      }
    }
  }

  constructor() {
    this.initEventListeners();
  }

  private ensureHydrated(): void {
    if (this.storageHydrated) return;
    this.storageHydrated = true;
    this.purgeLegacyScores();
    this.purgeStaleNullScores();
  }

  public initEventListeners(): void {
    if (this.listenersInitialized) return;
    if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
      const onOverrideUpdated = ((e: CustomEvent) => {
        if (e.detail && typeof e.detail === 'object' && (e.detail as { hydratedFromVault?: boolean }).hydratedFromVault) {
          return;
        }
        const extracted = extractValidGameOverrideFromEventDetail(e.detail);
        if (!extracted) return;
        this.handleUserOverride(extracted.override, extracted.oldGame);
      }) as EventListener;

      const onStagedVaultHydrated = (() => {
        if (this.stubPinnedKeys.size > 0) {
          for (const stubKey of this.stubPinnedKeys) {
            this.inMemoryCache.delete(stubKey);
          }
          this.stubPinnedKeys.clear();
        }
      }) as EventListener;

      const onOverrideRemoved = ((e: CustomEvent) => {
        const detail = (e.detail || {}) as {
          gameId?: string;
          deletedKeys?: string[];
          removedOverride?: UserGameOverride;
          oldOverride?: UserGameOverride;
          oldGame?: Partial<CanonicalGame>;
        };
        const gameId = detail.gameId;
        const oldOverride = detail.removedOverride ?? detail.oldOverride;
        const oldGame = detail.oldGame;
        const deletedKeys = Array.isArray(detail.deletedKeys) ? detail.deletedKeys : [];

        if (gameId || oldOverride || oldGame || deletedKeys.length > 0) {
          this.clearCache();
          const keysToEvict = new Set<string>();

          const addTitleKeys = (rawTitle?: string | null) => {
            if (!rawTitle || typeof rawTitle !== 'string') return;
            const trimmed = rawTitle.trim().toLowerCase();
            if (!trimmed) return;
            keysToEvict.add(`title:${trimmed}`);
            const norm = normalizeCriticTitleKey(trimmed);
            if (norm) {
              keysToEvict.add(`title:${norm}`);
            }
          };

          const addIdKeys = (rawId?: string | number | null) => {
            if (rawId === undefined || rawId === null) return;
            const str = String(rawId).trim();
            if (!str) return;
            keysToEvict.add(str);
            const cleanId = str.replace(/^steam-/, '');
            if (cleanId) {
              keysToEvict.add(`id:${cleanId}`);
            }
            addTitleKeys(str);
          };

          addIdKeys(gameId);
          for (const dk of deletedKeys) {
            addIdKeys(dk);
          }
          if (oldOverride) {
            addIdKeys(oldOverride.gameId);
            if (typeof oldOverride.steamAppId === 'number' && oldOverride.steamAppId > 0) {
              keysToEvict.add(`id:${oldOverride.steamAppId}`);
            }
            if (oldOverride.matchedId !== undefined) {
              addIdKeys(oldOverride.matchedId);
            }
            if (oldOverride.nativeBaseline?.steamAppId) {
              keysToEvict.add(`id:${oldOverride.nativeBaseline.steamAppId}`);
            }
            addIdKeys(oldOverride.nativeBaseline?.id);
            addTitleKeys(oldOverride.title);
            addTitleKeys(oldOverride.originalSourceTitle);
            addTitleKeys(oldOverride.nativeBaseline?.title);
          }
          if (oldGame) {
            addIdKeys(oldGame.id);
            if (typeof oldGame.steamAppId === 'number' && oldGame.steamAppId > 0) {
              keysToEvict.add(`id:${oldGame.steamAppId}`);
            }
            addTitleKeys(oldGame.title);
            addTitleKeys(oldGame.originalStoreTitle);
          }

          for (const key of keysToEvict) {
            this.inMemoryCache.delete(key);
            this.attemptedDynamicResolutions.delete(key);
            this.inFlightResolutions.delete(key);
            evictStagedCache(`${STORAGE_PREFIX}${key}`);
            evictStagedCache(`${PREV_STORAGE_PREFIX}${key}`);
            evictStagedCache(key);
            if (typeof localStorage !== 'undefined') {
              try {
                localStorage.removeItem(`${STORAGE_PREFIX}${key}`);
                localStorage.removeItem(`${PREV_STORAGE_PREFIX}${key}`);
              } catch {}
            }
          }

          if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
            try {
              window.dispatchEvent(new CustomEvent('antigravity_critic_updated'));
            } catch {}
          }
        }
      }) as EventListener;

      window.addEventListener('antigravity:user-override-updated', onOverrideUpdated);
      window.addEventListener('antigravity:user-override-removed', onOverrideRemoved);
      window.addEventListener('antigravity:staged-vault-hydrated', onStagedVaultHydrated);
      const unsubscribeOnline = onlineLifecycleManager.onOnline(() => {
        this.attemptedDynamicResolutions.clear();
        for (const [k, v] of this.inMemoryCache.entries()) {
          if (v === null) {
            this.inMemoryCache.delete(k);
          }
        }
      });
      this.listenersInitialized = true;
      this.listenerCleanups.push(() => {
        window.removeEventListener('antigravity:user-override-updated', onOverrideUpdated);
        window.removeEventListener('antigravity:user-override-removed', onOverrideRemoved);
        window.removeEventListener('antigravity:staged-vault-hydrated', onStagedVaultHydrated);
        unsubscribeOnline();
      });
    }
  }

  public disposeEventListeners(): void {
    for (const cleanup of this.listenerCleanups) {
      try {
        cleanup();
      } catch {}
    }
    this.listenerCleanups = [];
    this.listenersInitialized = false;
  }

  /**
   * Responds to user game overrides by evicting stale cached entries across memory and localStorage,
   * invalidating storefrontReviewHarvester cache, and proactively initiating dynamic score resolution.
   */
  public handleUserOverride(override: UserGameOverride, oldGame?: CanonicalGame): void {
    if (!override || typeof override !== 'object') return;
    const candidateType = (override as Partial<UserGameOverride> & { type?: unknown }).type;
    if (typeof candidateType === 'string' && NON_OVERRIDE_EVENT_TYPES.has(candidateType)) {
      return;
    }
    const hasIdentifierOrOldGame =
      (typeof override.gameId === 'string' && override.gameId.trim().length > 0) ||
      (typeof override.title === 'string' && override.title.trim().length > 0) ||
      (typeof override.steamAppId === 'number' && override.steamAppId > 0) ||
      (typeof override.platformGameId === 'string' && override.platformGameId.trim().length > 0) ||
      Boolean(oldGame?.title) ||
      Boolean(typeof oldGame?.steamAppId === 'number' && oldGame.steamAppId > 0);
    if (!hasIdentifierOrOldGame) {
      return;
    }

    this.ensureHydrated();
    const keysToEvict = new Set<string>();

    if (override.title) {
      keysToEvict.add(`title:${override.title.toLowerCase().trim()}`);
    }
    if (typeof override.steamAppId === 'number' && override.steamAppId > 0) {
      keysToEvict.add(`id:${override.steamAppId}`);
    }

    if (oldGame) {
      if (oldGame.title) {
        keysToEvict.add(`title:${oldGame.title.toLowerCase().trim()}`);
      }
      if (typeof oldGame.steamAppId === 'number' && oldGame.steamAppId > 0) {
        keysToEvict.add(`id:${oldGame.steamAppId}`);
      }
    }

    for (const key of keysToEvict) {
      this.inMemoryCache.delete(key);
      this.attemptedDynamicResolutions.delete(key);
      this.inFlightResolutions.delete(key);
      evictStagedCache(`${STORAGE_PREFIX}${key}`);
      evictStagedCache(`${PREV_STORAGE_PREFIX}${key}`);
      evictStagedCache(key);
      if (typeof localStorage !== 'undefined') {
        try {
          localStorage.removeItem(`${STORAGE_PREFIX}${key}`);
          localStorage.removeItem(`${PREV_STORAGE_PREFIX}${key}`);
        } catch {}
      }
    }

    storefrontReviewHarvester.clearCache();

    const targetTitle = (override.title || oldGame?.title || '').trim();
    const targetSteamId = typeof override.steamAppId === 'number' && override.steamAppId > 0 ? override.steamAppId : undefined;
    const cacheKey = targetSteamId ? `id:${targetSteamId}` : `title:${targetTitle.toLowerCase()}`;
    const stagedKey = `${STORAGE_PREFIX}${cacheKey}`;

    const route = inferReviewRouteFromOverride(override);
    if (route) {
      const keysToSet = new Set<string>();
      if (cacheKey) keysToSet.add(cacheKey);
      if (targetTitle) keysToSet.add(`title:${targetTitle.toLowerCase()}`);

      if (route.mode === 'unrated') {
        this.setInMemoryCache(cacheKey, null);
        saveStagedCache<CriticScoreData>(stagedKey, null, MutabilityTier.TIER_0_USER_OVERRIDE);
        for (const k of keysToSet) {
          if (k !== cacheKey) {
            this.setInMemoryCache(k, null);
          }
        }
        if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
          window.dispatchEvent(
            new CustomEvent('antigravity_critic_updated', {
              detail: { cacheKey, title: targetTitle, steamAppId: targetSteamId, data: null },
            })
          );
        }
        return;
      }

      if (route.mode === 'static') {
        const staticData = override.reviewScoreOverride ?? null;
        this.setInMemoryCache(cacheKey, staticData);
        saveStagedCache<CriticScoreData>(stagedKey, staticData, MutabilityTier.TIER_0_USER_OVERRIDE);
        for (const k of keysToSet) {
          if (k !== cacheKey) {
            this.setInMemoryCache(k, staticData);
          }
        }
        if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
          window.dispatchEvent(
            new CustomEvent('antigravity_critic_updated', {
              detail: { cacheKey, title: targetTitle, steamAppId: targetSteamId, data: staticData },
            })
          );
        }
        return;
      }

      if (route.mode === 'routed' && override.reviewScoreOverride) {
        const dynamicTier = determineGameMutabilityTier({
          releaseDate: override.releaseDate || oldGame?.releaseDate,
          isOverride: false,
        });
        this.setInMemoryCache(cacheKey, override.reviewScoreOverride);
        saveStagedCache<CriticScoreData>(stagedKey, override.reviewScoreOverride, dynamicTier, {
          source: override.reviewScoreOverride.source,
          isVerified: override.reviewScoreOverride.isVerified,
        });
        for (const k of keysToSet) {
          if (k !== cacheKey) {
            this.setInMemoryCache(k, override.reviewScoreOverride);
          }
        }
        if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
          window.dispatchEvent(
            new CustomEvent('antigravity_critic_updated', {
              detail: { cacheKey, title: targetTitle, steamAppId: targetSteamId, data: override.reviewScoreOverride },
            })
          );
        }
        return;
      }
    }

    if (targetTitle) {
      this.resolveDynamicScore(targetTitle, targetSteamId, undefined, override.storefrontAnchor).catch(() => {});
    }
  }

  /**
   * Resolves a routed review score dynamically from its pinned provider, falling back to fallbackScore if offline/unreachable.
   */
  public async resolveRoutedScore(
    route: ReviewScoreRoute,
    fallbackTitle: string,
    releaseYear?: number | string | null,
    fallbackScore?: CriticScoreData | null
  ): Promise<CriticScoreData | null> {
    if (!route || route.mode === 'unrated') {
      return null;
    }
    if (route.mode === 'static') {
      return fallbackScore ?? null;
    }

    const targetTitle = (route.targetTitle || fallbackTitle || '').trim();
    const yearNum =
      typeof releaseYear === 'number'
        ? releaseYear
        : releaseYear
        ? parseInt(String(releaseYear).match(/\b(19\d\d|20\d\d)\b/)?.[1] || '', 10) || undefined
        : undefined;

    try {
      if (route.source === 'metacritic' || route.source === 'metacritic_user') {
        const slug =
          route.metacriticSlug ||
          route.url?.match(/metacritic\.com\/game\/(?:pc\/)?([^/?#]+)/i)?.[1];
        const anchorArg = slug
          ? ({
              gameId: slug,
              storefront: 'steam',
              metacriticSlug: slug,
              metacriticUrl: route.url,
            } as StorefrontReviewAnchor & { gameId?: string })
          : undefined;
        const bundle = await metacriticResolver.resolveMetacritic(
          targetTitle,
          yearNum,
          anchorArg,
          Priority.P1_VIEWPORT
        );
        if (route.source === 'metacritic' && bundle?.critic && bundle.critic.score > 0) {
          return bundle.critic;
        }
        if (route.source === 'metacritic_user' && bundle?.user && bundle.user.score > 0) {
          return bundle.user;
        }
      } else if (route.source === 'opencritic') {
        let ocId =
          route.openCriticId ||
          Number(route.url?.match(/opencritic\.com\/game\/(\d+)/i)?.[1] || 0);
        const baseUrl =
          typeof window !== 'undefined' && window.location?.hostname === 'localhost'
            ? '/api/opencritic'
            : 'https://api.opencritic.com';
        const headers: Record<string, string> = {
          ...OPENCRITIC_PUBLIC_HEADERS,
        };

        if (!ocId && targetTitle) {
          const searchUrl = `${baseUrl}/api/game/search?criteria=${encodeURIComponent(targetTitle)}`;
          const searchRes = await requestScheduler.schedule(
            searchUrl,
            () => fetch(searchUrl, { headers }),
            Priority.P1_VIEWPORT,
            'api.opencritic.com'
          );
          if (searchRes.ok) {
            const candidates: Array<{ id: number; name: string; dist?: number }> = await searchRes.json();
            if (Array.isArray(candidates) && candidates.length > 0) {
              const match =
                candidates.find(
                  (c) =>
                    !isSequelMismatch(targetTitle, c.name) &&
                    isTitleCompatible(targetTitle, c.name)
                ) || candidates[0];
              if (match?.id) {
                ocId = Number(match.id);
              }
            }
          }
        }

        if (ocId > 0) {
          const detailsUrl = `${baseUrl}/api/game/${ocId}`;
          const res = await requestScheduler.schedule(
            detailsUrl,
            () => fetch(detailsUrl, { headers }),
            Priority.P1_VIEWPORT,
            'api.opencritic.com'
          );
          if (res.ok) {
            const data = await res.json();
            if (typeof data?.topCriticScore === 'number' && data.topCriticScore > 0) {
              const score = Math.round(data.topCriticScore);
              const percentRecommended =
                typeof data.percentRecommended === 'number'
                  ? Math.round(data.percentRecommended)
                  : undefined;
              const tier =
                (data.tier as CriticTier) ||
                calculateTier(score, percentRecommended);
              return {
                id: ocId,
                source: 'opencritic',
                score,
                tier,
                percentRecommended,
                numReviews:
                  typeof data.numReviews === 'number'
                    ? data.numReviews
                    : fallbackScore?.numReviews || 25,
                url: route.url || `https://opencritic.com/game/${ocId}`,
                summary: data.reviewSummary?.summary || fallbackScore?.summary,
                isVerified: true,
              };
            }
          }
        }
      } else if (route.source === 'steam') {
        const appId =
          route.steamAppId ||
          Number(route.url?.match(/store\.steampowered\.com\/app\/(\d+)/i)?.[1] || 0);
        if (appId > 0) {
          const steamRes = await steamReviewResolver.resolveScore(targetTitle, appId);
          if (steamRes && steamRes.score > 0) {
            return steamRes;
          }
        }
      } else if (route.source === 'gog' || route.source === 'epic' || route.source === 'xbox') {
        const starRes = await storefrontStarResolver.resolveScore({
          title: targetTitle,
          gogId: route.gogId,
          epicId: route.epicId,
          xboxProductId: route.xboxProductId,
        });
        if (starRes && starRes.score > 0) {
          return {
            ...starRes,
            source: route.source,
          };
        }
      }
    } catch {}

    return fallbackScore ?? null;
  }

  private getCompiledReviewOverrideIndex(
    overrides: Record<string, UserGameOverride>
  ): CompiledReviewOverrideIndex {
    const existing = this.compiledOverrideIndexMemo.get(overrides);
    if (existing) return existing;

    const byKey = new Map<string, UserGameOverride>();
    const byGameId = new Map<string, UserGameOverride>();
    const bySteamId = new Map<number, UserGameOverride>();
    const byLowerTitle = new Map<string, UserGameOverride>();
    const byNormTitle = new Map<string, UserGameOverride>();
    let hasAnyReviewOverride = false;

    for (const [k, ov] of Object.entries(overrides)) {
      if (!ov || (ov.reviewScoreOverride === undefined && ov.reviewRoute === undefined)) {
        continue;
      }
      hasAnyReviewOverride = true;
      byKey.set(k, ov);
      if (ov.gameId && !byGameId.has(ov.gameId)) {
        byGameId.set(ov.gameId, ov);
      }
      if (typeof ov.steamAppId === 'number' && ov.steamAppId > 0 && !bySteamId.has(ov.steamAppId)) {
        bySteamId.set(ov.steamAppId, ov);
      }
      if (ov.title) {
        const lower = ov.title.toLowerCase().trim();
        if (lower && !byLowerTitle.has(lower)) {
          byLowerTitle.set(lower, ov);
        }
        const norm = normalizeCriticTitleKey(ov.title);
        if (norm && !byNormTitle.has(norm)) {
          byNormTitle.set(norm, ov);
        }
      }
    }

    const compiled: CompiledReviewOverrideIndex = {
      hasAnyReviewOverride,
      byKey,
      byGameId,
      bySteamId,
      byLowerTitle,
      byNormTitle,
    };
    this.compiledOverrideIndexMemo.set(overrides, compiled);
    return compiled;
  }

  /**
   * Helper to locate an active user override matching the provided game by steamAppId, title, or platform combinations.
   */
  public findMatchingUserOverride(
    steamAppId?: number | null,
    title?: string,
    gameId?: string
  ): UserGameOverride | undefined {
    try {
      const overrides = loadUserOverrides();
      if (!overrides) return undefined;

      const idx = this.getCompiledReviewOverrideIndex(overrides);
      if (!idx.hasAnyReviewOverride) return undefined;

      if (gameId) {
        const directByKey = idx.byKey.get(gameId);
        if (directByKey) return directByKey;
      }

      const synthGame: CanonicalGame = {
        id: gameId || (steamAppId ? `steam-${steamAppId}` : (title ? `game-${title.toLowerCase().trim()}` : '')),
        title: title || '',
        sortTitle: title || '',
        steamAppId: typeof steamAppId === 'number' && steamAppId > 0 ? steamAppId : undefined,
        platforms: [],
        headerImage: '',
        developers: [],
        publishers: [],
        genres: [],
        tags: [],
      };
      const directMatch = getUserOverrideForGame(synthGame, overrides);
      if (directMatch && (directMatch.reviewScoreOverride !== undefined || directMatch.reviewRoute !== undefined)) {
        return directMatch;
      }

      if (steamAppId) {
        const bySteamKey = idx.byKey.get(`steam-${steamAppId}`) || idx.byKey.get(String(steamAppId));
        if (bySteamKey) return bySteamKey;
      }

      const lower = title ? title.toLowerCase().trim() : '';
      if (lower) {
        const byTitleKey = idx.byKey.get(lower) || idx.byKey.get(`title:${lower}`);
        if (byTitleKey) return byTitleKey;
      }

      if (gameId && idx.byGameId.has(gameId)) {
        return idx.byGameId.get(gameId);
      }
      if (typeof steamAppId === 'number' && steamAppId > 0 && idx.bySteamId.has(steamAppId)) {
        return idx.bySteamId.get(steamAppId);
      }
      if (lower && idx.byLowerTitle.has(lower)) {
        return idx.byLowerTitle.get(lower);
      }
      if (title) {
        const normSearchTitle = normalizeCriticTitleKey(title);
        if (normSearchTitle && idx.byNormTitle.has(normSearchTitle)) {
          return idx.byNormTitle.get(normSearchTitle);
        }
      }
    } catch {}
    return undefined;
  }

  /**
   * Universal semantic compatibility validator for cached or candidate critic scores.
   * Memoizes validation outcomes per `CriticScoreData` object reference (`WeakMap`) so hot-path
   * cache hits run in O(1) without repeating regex/slug/summary passes.
   */
  private validateScoreSemanticCompatibility(
    rawTitle: string,
    scoreData: CriticScoreData | null | undefined,
    steamAppId?: number | null
  ): boolean {
    if (!scoreData || typeof scoreData.score !== 'number' || scoreData.score <= 0) return false;

    const memoKey = `${steamAppId ?? ''}|${rawTitle}`;
    let byQuery = this.semanticValidationMemo.get(scoreData);
    if (byQuery && byQuery.has(memoKey)) {
      return byQuery.get(memoKey)!;
    }

    const recordValidation = (valid: boolean): boolean => {
      if (!byQuery) {
        byQuery = new Map<string, boolean>();
        this.semanticValidationMemo.set(scoreData, byQuery);
      } else if (byQuery.size >= 32) {
        const oldest = byQuery.keys().next().value;
        if (oldest !== undefined) byQuery.delete(oldest);
      }
      byQuery.set(memoKey, valid);
      return valid;
    };

    const isNonGameAddonOrBeta = NON_GAME_ADDON_OR_BETA_REGEX.test(rawTitle);
    if (isNonGameAddonOrBeta && !scoreData.isSynthetic) {
      return recordValidation(false);
    }
    if (
      rawTitle &&
      (KNOWN_UNRATED_TITLES.has(rawTitle.toLowerCase().trim()) ||
        KNOWN_UNRATED_TITLES.has(normalizeCriticTitleKey(rawTitle))) &&
      !scoreData.isSynthetic
    ) {
      return recordValidation(false);
    }
    if (scoreData.source === 'steam' && scoreData.url?.includes('/search/?term=') && !steamAppId) {
      return recordValidation(false);
    }
    if (scoreData.source === 'opencritic' && isUrlHostMatching(scoreData.url, 'gog.com') && steamAppId) {
      return recordValidation(false);
    }

    if (scoreData.url && rawTitle) {
      const slugMatch = scoreData.url.match(/\/game\/(?:[0-9]+\/)?([^\/?#]+)/);
      const slug = slugMatch ? slugMatch[1] : '';
      if (slug) {
        const compatQueryTitle =
          scoreData.source === 'gog' ? rawTitle.replace(/\bplus\b/gi, '').trim() || rawTitle : rawTitle;
        if (scoreData.source === 'gog') {
          const nonGameGog = /\b(demo|prologue|soundtrack|ost|artbook|dlc|upgrade|walkthrough)\b/i;
          if (nonGameGog.test(slug.replace(/_/g, ' ')) && !nonGameGog.test(rawTitle)) {
            return recordValidation(false);
          }
          const gogSlugTitle = slug.replace(/-\d{4}$/, '').replace(/[_-]/g, ' ');
          if (
            isSequelMismatch(compatQueryTitle, gogSlugTitle) ||
            !isTitleCompatible(compatQueryTitle, gogSlugTitle) ||
            !isTitleCompatible(gogSlugTitle, compatQueryTitle)
          ) {
            return recordValidation(false);
          }
        }

        const normalizedSlug = !/\b(season|episode)\b/i.test(rawTitle)
          ? slug.replace(/-episode-(?:1|one)\b.*$/i, '')
          : slug;
        const slugTitle = normalizedSlug.replace(/-\d{4}$/, '').replace(/[_-]/g, ' ');
        if (isSequelMismatch(compatQueryTitle, slugTitle)) {
          return recordValidation(false);
        }

        const isVerifiedStoreAnchor = Boolean(
          scoreData.summary?.includes('store review anchor') && isAnchorSlugCompatible(rawTitle, slug)
        );
        const colonRestoredSlugTitle = slugTitle.replace(/^([a-z0-9]+)\s+(a|an|the)\s+/i, '$1: $2 ');
        if (
          !isVerifiedStoreAnchor &&
          !isTitleCompatible(compatQueryTitle, slugTitle) &&
          !isTitleCompatible(compatQueryTitle, colonRestoredSlugTitle)
        ) {
          return recordValidation(false);
        }

        // Guard against explicit first-installment or retro classic matching an unnumbered modern reboot
        const titleNoYear = rawTitle.replace(/\s*\((?:19|20)\d{2}\)/g, '').trim();
        const isFirstInstallment = /\b(?:1|i)\b/i.test(titleNoYear) && !/\b(?:1|i)\b/i.test(slugTitle);
        const isExplicitRetro =
          (hasExplicitClassicOrOriginalEditionTag(titleNoYear) ||
            /\b(plus|dos)\b/i.test(titleNoYear)) &&
          !/\b(classic|original|plus|dos)\b/i.test(slugTitle);

        if (
          (isFirstInstallment || isExplicitRetro) &&
          (scoreData.source === 'opencritic' ||
            /[-_](200[89]|201\d|202\d)$/.test(slug) ||
            /\b(reimagination|reimagining|remake of the|modern reboot|reboot of the|completely remastered|playstation 5|xbox series)\b/i.test(
              scoreData.summary || ''
            ))
        ) {
          return recordValidation(false);
        }

        // Guard against franchise spinoff subtitle collisions on base-title review URLs
        const summaryText = scoreData.summary || '';
        const escapedBase = titleNoYear.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        if (escapedBase && !rawTitle.includes(':')) {
          const spinoffColonRe = new RegExp(`\\b${escapedBase}:\\s+([A-Z][A-Za-z0-9'\\s-]{2,})`, 'i');
          const spinoffMatch = summaryText.match(spinoffColonRe);
          if (spinoffMatch?.[1]) {
            const subLower = spinoffMatch[1].trim().toLowerCase();
            if (subLower && !rawTitle.toLowerCase().includes(subLower)) {
              return recordValidation(false);
            }
          }
        }
      }
    }

    if (scoreData.summary && scoreData.source === 'metacritic') {
      scoreData.summary = sanitizeMetacriticDescription(scoreData.summary, scoreData.numReviews || 20);
    }
    return recordValidation(true);
  }

  /**
   * Cleanses all stale unversioned and previous version score keys from localStorage.
   */
  public purgeLegacyScores(): void {
    this.storageHydrated = true;
    clearExpiredStagedCache({ onlyNegativeAndTransient: true });
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
    this.storageHydrated = true;
    this.inMemoryCache.clear();
    this.inFlightResolutions.clear();
    this.attemptedDynamicResolutions.clear();
    metacriticResolver.clearCache();
    steamReviewResolver.clearCache();
    storefrontStarResolver.clearCache();
    storefrontReviewHarvester.clearCache();
    clearExpiredStagedCache();
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
   * Purges legacy or stale "null" strings and semantically poisoned entries from localStorage.
   * Preserves valid StagedCacheEntry negative records (< 7 days) and purges expired ones.
   */
  public purgeStaleNullScores(): void {
    this.storageHydrated = true;
    if (typeof localStorage === 'undefined') return;
    try {
      const schemaUpgraded = localStorage.getItem('antigravity_critic_schema_v15') === '1';
      if (!schemaUpgraded) {
        const catalogTitleByAppId = new Map<number, string>();
        const catalogAppIdByTitle = new Map<string, number>();
        try {
          const rawCat = localStorage.getItem('universal_game_library_catalog');
          if (rawCat) {
            const parsedCat = JSON.parse(rawCat);
            if (Array.isArray(parsedCat)) {
              for (const g of parsedCat) {
                if (!g || !g.title) continue;
                const sid =
                  typeof g.steamAppId === 'number' && g.steamAppId > 0
                    ? g.steamAppId
                    : typeof g.id === 'string' && g.id.startsWith('steam-')
                    ? Number(g.id.slice(6))
                    : 0;
                if (sid > 0) {
                  catalogTitleByAppId.set(sid, g.title);
                  catalogAppIdByTitle.set(String(g.title).toLowerCase().trim(), sid);
                  catalogAppIdByTitle.set(normalizeCriticTitleKey(String(g.title)), sid);
                }
              }
            }
          }
        } catch {}

        const v15Remove: string[] = [];
        for (let i = 0; i < localStorage.length; i++) {
          const key = localStorage.key(i);
          if (key && key.startsWith(STORAGE_PREFIX)) {
            const val = localStorage.getItem(key);
            if (!val) {
              v15Remove.push(key);
              continue;
            }
            try {
              const parsed = JSON.parse(val);
              const isStaged = parsed && typeof parsed === 'object' && 'data' in parsed;
              const data: CriticScoreData | null = isStaged ? parsed.data : parsed;
              const tier = isStaged ? parsed.tier : undefined;
              if (tier === MutabilityTier.TIER_0_USER_OVERRIDE || tier === 'override') {
                continue;
              }
              if (
                isStaged &&
                data === null &&
                (tier === 'negative' || tier === 'transient_error') &&
                isCacheEntryValid(parsed)
              ) {
                continue;
              }
              const rawKey = key.slice(STORAGE_PREFIX.length);
              const titleFromKey = rawKey.startsWith('title:') ? rawKey.slice(6).toLowerCase().trim() : '';
              const appId = rawKey.startsWith('id:')
                ? Number(rawKey.slice(3))
                : titleFromKey
                ? catalogAppIdByTitle.get(titleFromKey)
                : undefined;
              const effectiveTitle = rawKey.startsWith('title:')
                ? rawKey.slice(6)
                : appId
                ? STEAM_APP_ID_TO_TITLE.get(appId) || catalogTitleByAppId.get(appId) || ''
                : '';

              if (
                data &&
                typeof data.score === 'number' &&
                data.score > 0 &&
                (data.source === 'metacritic' ||
                  data.source === 'opencritic' ||
                  data.source === 'metacritic_user' ||
                  data.source === 'steam' ||
                  data.source === 'gog' ||
                  data.source === 'epic' ||
                  data.source === 'xbox')
              ) {
                const origSummary = data.summary;
                if (effectiveTitle && !this.validateScoreSemanticCompatibility(effectiveTitle, data, appId)) {
                  v15Remove.push(key);
                  continue;
                }
                if (origSummary && (data.source === 'metacritic' || data.source === 'metacritic_user')) {
                  const sanitized = sanitizeMetacriticDescription(origSummary, data.numReviews || 20);
                  if (sanitized !== origSummary) {
                    data.summary = sanitized;
                    if (isStaged && 'summary' in parsed) {
                      parsed.summary = sanitized;
                    }
                    localStorage.setItem(key, JSON.stringify(parsed));
                  }
                }
              } else {
                v15Remove.push(key);
              }
            } catch {
              v15Remove.push(key);
            }
          }
        }
        for (const k of v15Remove) {
          localStorage.removeItem(k);
          if (k.startsWith(STORAGE_PREFIX)) {
            const rawKey = k.slice(STORAGE_PREFIX.length);
            this.inMemoryCache.delete(rawKey);
            this.attemptedDynamicResolutions.delete(rawKey);
          }
        }

        // Clean stale negative or semantically incompatible Steam matcher entries
        const rawMatched = localStorage.getItem('antigravity_steam_matched_app_ids');
        if (rawMatched) {
          try {
            const parsedMatched = JSON.parse(rawMatched);
            if (parsedMatched && typeof parsedMatched === 'object') {
              let changed = false;
              for (const [mk, mv] of Object.entries(parsedMatched)) {
                if (mv === null || typeof mv === 'object') {
                  delete parsedMatched[mk];
                  changed = true;
                } else if (typeof mv === 'number') {
                  const enrichedName = STEAM_ENRICHED_CRITIC_MAP[String(mv)]?.name;
                  if (
                    enrichedName &&
                    (isSequelMismatch(mk, enrichedName) || !isTitleCompatible(mk, enrichedName))
                  ) {
                    delete parsedMatched[mk];
                    changed = true;
                  }
                }
              }
              if (changed) {
                localStorage.setItem('antigravity_steam_matched_app_ids', JSON.stringify(parsedMatched));
              }
            }
          } catch {}
        }

        localStorage.setItem('antigravity_critic_schema_v9', '1');
        localStorage.setItem('antigravity_critic_schema_v10', '1');
        localStorage.setItem('antigravity_critic_schema_v11', '1');
        localStorage.setItem('antigravity_critic_schema_v12', '1');
        localStorage.setItem('antigravity_critic_schema_v13', '1');
        localStorage.setItem('antigravity_critic_schema_v14', '1');
        localStorage.setItem('antigravity_critic_schema_v15', '1');
      }

      if (!onlineLifecycleManager.isOnline()) {
        return;
      }

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
              if (parsed && typeof parsed === 'object' && typeof parsed.cachedAt === 'number') {
                const isPositiveScore =
                  parsed.data &&
                  typeof parsed.data === 'object' &&
                  typeof parsed.data.score === 'number' &&
                  parsed.data.score > 0;
                if (!isPositiveScore && !isCacheEntryValid(parsed)) {
                  keysToRemove.push(key);
                }
              } else if (!parsed || typeof parsed.score !== 'number' || parsed.score <= 0) {
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
        if (k.startsWith(STORAGE_PREFIX)) {
          const rawKey = k.slice(STORAGE_PREFIX.length);
          this.inMemoryCache.delete(rawKey);
          this.attemptedDynamicResolutions.delete(rawKey);
        }
      }
      if (!schemaUpgraded && keysToRemove.length > 0) {
        this.inMemoryCache.clear();
        this.attemptedDynamicResolutions.clear();
      }
    } catch {}
  }

  /**
   * Clears memory cache and resets attempted resolution state.
   */
  clearCache(): void {
    this.inMemoryCache.clear();
    this.stubPinnedKeys.clear();
    this.transientFailureCounts.clear();
    this.inFlightResolutions.clear();
    this.attemptedDynamicResolutions.clear();
    metacriticResolver.clearCache();
    steamReviewResolver.clearCache();
    storefrontStarResolver.clearCache();
    storefrontReviewHarvester.clearCache();
    this.purgeStaleNullScores();
  }

  public clearAttemptedResolutions(): void {
    this.attemptedDynamicResolutions.clear();
  }

  public hasAttemptedDynamicResolution(steamAppId?: number | null, title?: string): boolean {
    const rawTitle = (title || '').trim().toLowerCase();
    if (steamAppId && this.attemptedDynamicResolutions.has(`id:${steamAppId}`)) {
      return true;
    }
    if (rawTitle && this.attemptedDynamicResolutions.has(`title:${rawTitle}`)) {
      return true;
    }
    return false;
  }

  public hasValidCachedResolution(steamAppId?: number | null, title?: string): boolean {
    this.ensureHydrated();
    if (this.hasAttemptedDynamicResolution(steamAppId, title)) {
      return true;
    }
    const rawTitle = (title || '').trim();
    const userOverride = this.findMatchingUserOverride(steamAppId, rawTitle);
    if (userOverride && (userOverride.reviewScoreOverride !== undefined || userOverride.reviewRoute !== undefined)) {
      const route = inferReviewRouteFromOverride(userOverride);
      if (route?.mode === 'unrated' || route?.mode === 'static') {
        return true;
      }
    }

    const primaryIdKey = steamAppId ? `${STORAGE_PREFIX}id:${steamAppId}` : '';
    const candidateKeys: string[] = [];
    if (primaryIdKey) {
      candidateKeys.push(primaryIdKey);
    }
    const lowerTitle = rawTitle ? rawTitle.toLowerCase() : '';
    if (rawTitle) {
      candidateKeys.push(`${STORAGE_PREFIX}title:${lowerTitle}`);
      const norm = normalizeCriticTitleKey(rawTitle);
      if (norm && norm !== lowerTitle) {
        candidateKeys.push(`${STORAGE_PREFIX}title:${norm}`);
      }
    }

    let expiredPrimaryIdCachedAt: number | null = null;

    const backfillTitleAliasIfNeeded = (
      sourceKey: string,
      stagedEntry: NonNullable<ReturnType<typeof loadStagedCache<CriticScoreData>>['entry']>,
      resolvedData: CriticScoreData | null
    ) => {
      if (!primaryIdKey || sourceKey !== primaryIdKey || !lowerTitle) return;
      const titleAliasKey = `${STORAGE_PREFIX}title:${lowerTitle}`;
      const existingAlias = loadStagedCache<CriticScoreData>(titleAliasKey, false);
      if (existingAlias.valid && existingAlias.entry?.dynamicResolved === true) {
        return;
      }
      if (
        existingAlias.entry &&
        (existingAlias.entry.tier === MutabilityTier.TIER_0_USER_OVERRIDE ||
          existingAlias.entry.tier === 'override')
      ) {
        return;
      }
      saveStagedCache<CriticScoreData>(titleAliasKey, resolvedData, stagedEntry.tier, {
        source: stagedEntry.source,
        isVerified: stagedEntry.isVerified,
        failureReason: stagedEntry.failureReason,
        dynamicResolved: true,
        cachedAt: stagedEntry.cachedAt,
        customTtlMs: stagedEntry.ttlMs,
      });
    };

    for (const key of candidateKeys) {
      const staged = loadStagedCache<CriticScoreData>(key, false);
      if (!staged.entry) continue;
      if (
        staged.entry.tier === MutabilityTier.TIER_0_USER_OVERRIDE ||
        staged.entry.tier === 'override'
      ) {
        return true;
      }
      if (
        expiredPrimaryIdCachedAt !== null &&
        key !== primaryIdKey &&
        (staged.entry.cachedAt || 0) <= expiredPrimaryIdCachedAt
      ) {
        continue;
      }
      if (!onlineLifecycleManager.isOnline()) {
        if (
          staged.data &&
          staged.data.score > 0 &&
          (!rawTitle || this.validateScoreSemanticCompatibility(rawTitle, staged.data, steamAppId))
        ) {
          return true;
        }
      }
      if (staged.entry.dynamicResolved === true) {
        if (isCacheEntryValid(staged.entry)) {
          if (staged.entry.data === null) {
            backfillTitleAliasIfNeeded(key, staged.entry, null);
            return true;
          }
          if (
            staged.data &&
            staged.data.score > 0 &&
            (!rawTitle || this.validateScoreSemanticCompatibility(rawTitle, staged.data, steamAppId))
          ) {
            backfillTitleAliasIfNeeded(key, staged.entry, staged.data);
            return true;
          }
        } else if (key === primaryIdKey) {
          expiredPrimaryIdCachedAt = staged.entry.cachedAt || 0;
        }
      }
    }

    return false;
  }

  /**
   * Seeds an authoritative critic score hydrated from the Electron SQLite vault when no
   * valid staged cache entry or user override already exists.
   */
  public seedFromVaultIfMissing(
    steamAppId: number | null | undefined,
    title: string | undefined,
    scoreData: CriticScoreData | null | undefined,
    releaseDate?: string | number | null,
    genres?: string[] | null
  ): void {
    if (!scoreData || typeof scoreData.score !== 'number' || scoreData.score <= 0) return;
    this.ensureHydrated();
    const rawTitle = (title || '').trim();
    if (rawTitle && !this.validateScoreSemanticCompatibility(rawTitle, scoreData, steamAppId)) {
      return;
    }
    if (this.hasValidCachedResolution(steamAppId, rawTitle)) {
      return;
    }
    const cacheKey =
      typeof steamAppId === 'number' && steamAppId > 0
        ? `id:${steamAppId}`
        : rawTitle
        ? `title:${rawTitle.toLowerCase()}`
        : '';
    if (!cacheKey) return;
    this.cacheResult(cacheKey, scoreData, releaseDate, genres, {
      dynamicResolved: true,
      aliasTitle: rawTitle || undefined,
    });
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
    storefrontAnchor?: StorefrontReviewAnchor | null,
    bypassTTL: boolean = false,
    skipBackgroundTrigger: boolean = false
  ): CriticScoreData | null {
    this.ensureHydrated();
    const rawTitle = (title || '').trim();
    const lowerTitle = rawTitle.toLowerCase();
    let cachedAposStripped: string | undefined;
    let cachedNormalizedKey: string | undefined;
    let cachedStrippedKey: string | undefined;
    const getAposStrippedTitle = (): string => {
      if (cachedAposStripped === undefined) {
        cachedAposStripped = lowerTitle.includes("'") || /[’ʼ`]/.test(lowerTitle)
          ? lowerTitle.replace(/['’ʼ`]/g, '')
          : lowerTitle;
      }
      return cachedAposStripped;
    };
    const getNormalizedKey = (): string => {
      if (cachedNormalizedKey === undefined) {
        cachedNormalizedKey = normalizeCriticTitleKey(rawTitle);
      }
      return cachedNormalizedKey;
    };
    const getStrippedKey = (): string => {
      if (cachedStrippedKey === undefined) {
        cachedStrippedKey = stripEditionSuffix(rawTitle);
      }
      return cachedStrippedKey;
    };

    const cacheKey = steamAppId ? `id:${steamAppId}` : `title:${lowerTitle}`;
    const stagedKey = `${STORAGE_PREFIX}${cacheKey}`;

    const userOverride = this.findMatchingUserOverride(steamAppId, rawTitle);
    if (userOverride && (userOverride.reviewScoreOverride !== undefined || userOverride.reviewRoute !== undefined)) {
      const route = inferReviewRouteFromOverride(userOverride);
      if (route?.mode === 'unrated') {
        this.attemptedDynamicResolutions.add(cacheKey);
        if (lowerTitle) this.attemptedDynamicResolutions.add(`title:${lowerTitle}`);
        this.setInMemoryCache(cacheKey, null);
        saveStagedCache<CriticScoreData>(stagedKey, null, MutabilityTier.TIER_0_USER_OVERRIDE);
        return null;
      }
      if (route?.mode === 'static') {
        this.attemptedDynamicResolutions.add(cacheKey);
        if (lowerTitle) this.attemptedDynamicResolutions.add(`title:${lowerTitle}`);
        const staticScore = userOverride.reviewScoreOverride ?? null;
        this.setInMemoryCache(cacheKey, staticScore);
        saveStagedCache<CriticScoreData>(stagedKey, staticScore, MutabilityTier.TIER_0_USER_OVERRIDE);
        return staticScore;
      }
      if (route?.mode === 'routed') {
        if (bypassTTL && onlineLifecycleManager.isOnline()) {
          this.inMemoryCache.delete(cacheKey);
          this.attemptedDynamicResolutions.delete(cacheKey);
          if (lowerTitle) this.attemptedDynamicResolutions.delete(`title:${lowerTitle}`);
        }
        const staged = loadStagedCache<CriticScoreData>(stagedKey, bypassTTL);
        if ((staged.valid || !onlineLifecycleManager.isOnline()) && staged.data) {
          if (staged.valid) {
            this.attemptedDynamicResolutions.add(cacheKey);
            if (lowerTitle) this.attemptedDynamicResolutions.add(`title:${lowerTitle}`);
          }
          if (!staged.isCompactStub) {
            this.setInMemoryCache(cacheKey, staged.data);
          } else {
            this.stubPinnedKeys.add(cacheKey);
          }
          return staged.data;
        }
        if (
          onlineLifecycleManager.isOnline() &&
          !skipBackgroundTrigger &&
          !this.attemptedDynamicResolutions.has(cacheKey)
        ) {
          this.resolveDynamicScore(
            rawTitle || userOverride.title || '',
            steamAppId,
            releaseYear,
            storefrontAnchor
          ).catch(() => {});
        }
        return staged.data || userOverride.reviewScoreOverride || null;
      }
    }

    // 0. Check Tier 0 User Override (Absolute human authority, skips network/heuristic tiers)
    const stagedTier0 = loadStagedCache<CriticScoreData>(stagedKey, false);
    if (
      stagedTier0.entry &&
      (stagedTier0.entry.tier === MutabilityTier.TIER_0_USER_OVERRIDE || stagedTier0.entry.tier === 'override')
    ) {
      this.attemptedDynamicResolutions.add(cacheKey);
      if (lowerTitle) this.attemptedDynamicResolutions.add(`title:${lowerTitle}`);
      if (stagedTier0.entry.data === null) {
        this.setInMemoryCache(cacheKey, null);
        return null;
      }
      if (stagedTier0.entry.data) {
        this.setInMemoryCache(cacheKey, stagedTier0.entry.data);
        return stagedTier0.entry.data;
      }
    }

    let year = releaseYear;
    let enrichedReleaseDate: string | undefined;
    let enrichedGenres: string[] | undefined;
    if (steamAppId) {
      const enriched = STEAM_ENRICHED_CRITIC_MAP[String(steamAppId)];
      enrichedReleaseDate = enriched?.releaseDate || enriched?.release_date;
      enrichedGenres = enriched?.genres;
      if (!year && enrichedReleaseDate) {
        const m = String(enrichedReleaseDate).match(/\b(19\d\d|20\d\d)\b/);
        if (m) year = parseInt(m[1], 10);
      }
    }
    const effectiveReleaseDate = enrichedReleaseDate || (year ? String(year) : undefined);

    const triggerDynamicResolution = () => {
      if (skipBackgroundTrigger) return;
      if (!onlineLifecycleManager.isOnline()) return;
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

    const isNonGameAddonOrBeta = NON_GAME_ADDON_OR_BETA_REGEX.test(rawTitle);

    const isScoreSemanticallyCompatible = (scoreData: CriticScoreData | null | undefined): boolean =>
      this.validateScoreSemanticCompatibility(rawTitle, scoreData, steamAppId);

    if (bypassTTL) {
      this.inMemoryCache.delete(cacheKey);
      this.attemptedDynamicResolutions.delete(cacheKey);
      if (lowerTitle) this.attemptedDynamicResolutions.delete(`title:${lowerTitle}`);
    }

    // 1. Check in-memory cache across primary and normalized title keys
    if (!bypassTTL) {
      const checkMemKey = (mKey: string): CriticScoreData | null | undefined => {
        if (!this.inMemoryCache.has(mKey)) return undefined;
        const cached = this.inMemoryCache.get(mKey);
        if (cached === null) {
          return null;
        }
        if (cached && isScoreSemanticallyCompatible(cached)) {
          if (mKey !== cacheKey) {
            this.setInMemoryCache(cacheKey, cached);
          }
          if (cached.isSynthetic || cached.source === 'opencritic') {
            triggerDynamicResolution();
          }
          return cached;
        } else if (cached && mKey === cacheKey) {
          this.inMemoryCache.delete(cacheKey);
        }
        return undefined;
      };

      const directHit = checkMemKey(cacheKey);
      if (directHit !== undefined) return directHit;

      if (lowerTitle && cacheKey !== `title:${lowerTitle}`) {
        const lowerHit = checkMemKey(`title:${lowerTitle}`);
        if (lowerHit !== undefined) return lowerHit;
      }

      const aposStrippedTitle = getAposStrippedTitle();
      if (aposStrippedTitle && aposStrippedTitle !== lowerTitle) {
        const aposHit = checkMemKey(`title:${aposStrippedTitle}`);
        if (aposHit !== undefined) return aposHit;
      }

      const normalizedKey = getNormalizedKey();
      if (normalizedKey && normalizedKey !== lowerTitle && normalizedKey !== aposStrippedTitle) {
        const normHit = checkMemKey(`title:${normalizedKey}`);
        if (normHit !== undefined) return normHit;
      }
    }

    // 2. Direct lookup in master verified dataset (Authoritative compiled data takes precedence over unverified localStorage)
    let verifiedMatch: CriticScoreData | undefined;
    if (!isNonGameAddonOrBeta) {
      if (steamAppId && KNOWN_CRITIC_SCORES[steamAppId]) {
        verifiedMatch = KNOWN_CRITIC_SCORES[steamAppId];
      } else if (lowerTitle && KNOWN_CRITIC_SCORES[lowerTitle]) {
        verifiedMatch = KNOWN_CRITIC_SCORES[lowerTitle];
      } else {
        const normalizedKey = getNormalizedKey();
        if (normalizedKey && KNOWN_CRITIC_SCORES[normalizedKey]) {
          verifiedMatch = KNOWN_CRITIC_SCORES[normalizedKey];
        } else {
          const strippedKey = getStrippedKey();
          if (strippedKey && strippedKey !== normalizedKey && KNOWN_CRITIC_SCORES[strippedKey]) {
            verifiedMatch = KNOWN_CRITIC_SCORES[strippedKey];
          }
        }
      }
    }

    if (verifiedMatch && isScoreSemanticallyCompatible(verifiedMatch)) {
      const existingStaged = !bypassTTL ? stagedTier0 : loadStagedCache<CriticScoreData>(stagedKey, bypassTTL);
      if (existingStaged.valid && !bypassTTL && existingStaged.entry?.dynamicResolved) {
        this.attemptedDynamicResolutions.add(cacheKey);
        if (lowerTitle) this.attemptedDynamicResolutions.add(`title:${lowerTitle}`);
        if (existingStaged.data && isScoreSemanticallyCompatible(existingStaged.data)) {
          if (!existingStaged.isCompactStub) {
            this.setInMemoryCache(cacheKey, existingStaged.data);
          }
          return existingStaged.data;
        }
      }
      if (!verifiedMatch.isSynthetic && verifiedMatch.source === 'metacritic') {
        this.attemptedDynamicResolutions.add(cacheKey);
        if (lowerTitle) this.attemptedDynamicResolutions.add(`title:${lowerTitle}`);
      }
      if (!skipBackgroundTrigger && isStagedVaultHydrationComplete()) {
        this.cacheResult(cacheKey, verifiedMatch, effectiveReleaseDate, enrichedGenres, {
          dynamicResolved:
            existingStaged.valid && !bypassTTL ? existingStaged.entry?.dynamicResolved : undefined,
          aliasTitle: rawTitle || undefined,
        });
      } else {
        this.setInMemoryCache(cacheKey, verifiedMatch);
        if (!isStagedVaultHydrationComplete()) {
          this.stubPinnedKeys.add(cacheKey);
        }
      }
      if (
        (verifiedMatch.isSynthetic || verifiedMatch.source === 'opencritic') &&
        !this.attemptedDynamicResolutions.has(cacheKey)
      ) {
        triggerDynamicResolution();
      }
      return verifiedMatch;
    }

    // 3. Check staged localStorage cache across primary and normalized title keys (reuse stagedTier0 when !bypassTTL)
    let staged = !bypassTTL ? stagedTier0 : loadStagedCache<CriticScoreData>(stagedKey, bypassTTL);
    if (staged.entry && staged.data && !isScoreSemanticallyCompatible(staged.data)) {
      evictStagedCache(stagedKey);
      staged = { valid: false, data: null, entry: undefined };
    }

    const tryFallbackStagedKey = (fallbackKey: string) => {
      const altStaged = loadStagedCache<CriticScoreData>(fallbackKey, bypassTTL);
      if (altStaged.entry) {
        if (altStaged.data && !isScoreSemanticallyCompatible(altStaged.data)) {
          evictStagedCache(fallbackKey);
          return;
        }
        if (altStaged.data || altStaged.entry.data === null) {
          staged = altStaged;
          if (
            altStaged.data &&
            steamAppId &&
            cacheKey === `id:${steamAppId}` &&
            !altStaged.isCompactStub &&
            isStagedVaultHydrationComplete()
          ) {
            saveStagedCache<CriticScoreData>(stagedKey, altStaged.data, altStaged.entry.tier, {
              source: altStaged.data.source,
              isVerified: altStaged.data.isVerified,
              dynamicResolved: Boolean(altStaged.entry.dynamicResolved),
            });
            this.setInMemoryCache(`id:${steamAppId}`, altStaged.data);
          }
        }
      }
    };

    if (!staged.entry && lowerTitle && cacheKey !== `title:${lowerTitle}`) {
      tryFallbackStagedKey(`${STORAGE_PREFIX}title:${lowerTitle}`);
    }
    if (!staged.entry) {
      const aposStrippedTitle = getAposStrippedTitle();
      if (
        aposStrippedTitle &&
        aposStrippedTitle !== lowerTitle &&
        cacheKey !== `title:${aposStrippedTitle}`
      ) {
        tryFallbackStagedKey(`${STORAGE_PREFIX}title:${aposStrippedTitle}`);
      }
    }
    if (!staged.entry) {
      const normalizedKey = getNormalizedKey();
      if (normalizedKey && cacheKey !== `title:${normalizedKey}`) {
        tryFallbackStagedKey(`${STORAGE_PREFIX}title:${normalizedKey}`);
      }
    }

    if (staged.entry) {
      if (staged.entry.data === null) {
        if (staged.valid && !bypassTTL) {
          this.setInMemoryCache(cacheKey, null);
          this.attemptedDynamicResolutions.add(cacheKey);
          if (lowerTitle) this.attemptedDynamicResolutions.add(`title:${lowerTitle}`);
          return null;
        } else {
          this.inMemoryCache.delete(cacheKey);
          this.attemptedDynamicResolutions.delete(cacheKey);
          if (lowerTitle) this.attemptedDynamicResolutions.delete(`title:${lowerTitle}`);
          triggerDynamicResolution();
          return null;
        }
      } else if (staged.data && isScoreSemanticallyCompatible(staged.data)) {
        if (!onlineLifecycleManager.isOnline()) {
          if (!staged.isCompactStub) {
            this.setInMemoryCache(cacheKey, staged.data);
          }
          return staged.data;
        }
        if (staged.valid && !bypassTTL) {
          if (!staged.isCompactStub) {
            this.setInMemoryCache(cacheKey, staged.data);
          }
          if (staged.data.isSynthetic && !staged.entry.dynamicResolved) {
            // Synchronous pre-resolution synthetic score that hasn't completed dynamic cascade yet
            triggerDynamicResolution();
            return staged.data;
          } else {
            this.attemptedDynamicResolutions.add(cacheKey);
            if (lowerTitle) this.attemptedDynamicResolutions.add(`title:${lowerTitle}`);
            return staged.data;
          }
        } else {
          this.inMemoryCache.delete(cacheKey);
          this.attemptedDynamicResolutions.delete(cacheKey);
          if (lowerTitle) this.attemptedDynamicResolutions.delete(`title:${lowerTitle}`);
          triggerDynamicResolution();
          return staged.data;
        }
      } else {
        evictStagedCache(stagedKey);
      }
    }

    // Early explicit unrated check (betas, editors, demos, unrated classics)
    const isExplicitlyUnrated =
      isNonGameAddonOrBeta ||
      KNOWN_UNRATED_TITLES.has(lowerTitle) ||
      (Boolean(getNormalizedKey()) && KNOWN_UNRATED_TITLES.has(getNormalizedKey()));
    if (isExplicitlyUnrated) {
      this.attemptedDynamicResolutions.add(cacheKey);
      if (lowerTitle) this.attemptedDynamicResolutions.add(`title:${lowerTitle}`);
      let positive = steamAppId ? steamPositivePercent : undefined;
      let totalReviews: number | undefined;
      if (positive === undefined && steamAppId) {
        const enriched = STEAM_ENRICHED_CRITIC_MAP[String(steamAppId)];
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
        if (!skipBackgroundTrigger && isStagedVaultHydrationComplete()) {
          this.cacheResult(cacheKey, syntheticData, effectiveReleaseDate, enrichedGenres, {
            dynamicResolved: true,
            aliasTitle: rawTitle || undefined,
          });
        } else {
          this.setInMemoryCache(cacheKey, syntheticData);
          if (!isStagedVaultHydrationComplete()) {
            this.stubPinnedKeys.add(cacheKey);
          }
        }
        return syntheticData;
      }
      if (!skipBackgroundTrigger && isStagedVaultHydrationComplete()) {
        this.cacheResult(cacheKey, null, effectiveReleaseDate, enrichedGenres, {
          dynamicResolved: true,
          aliasTitle: rawTitle || undefined,
        });
      }
      return null;
    }

    // 4. Trigger cascading dynamic live resolution in background when not skipped
    triggerDynamicResolution();

    // 5. Look for authentic Steam review sentiment to construct immediate synthetic score
    // IMPORTANT: Only use review percentages if tied to a legitimate Steam App ID to avoid GOG star-rating contamination!
    let positive = steamAppId ? steamPositivePercent : undefined;
    let totalReviews: number | undefined;

    if (positive === undefined && steamAppId) {
      const enriched = STEAM_ENRICHED_CRITIC_MAP[String(steamAppId)];
      if (enriched?.reviewSummary?.positivePercent !== undefined) {
        positive = enriched.reviewSummary.positivePercent;
        totalReviews = enriched.reviewSummary.totalReviews;
      }
    }

    if (positive !== undefined && positive > 0 && steamAppId) {
      const synthetic = calculateSyntheticSteamScore(positive, totalReviews);
      const syntheticData: CriticScoreData = {
        id: `steam-${steamAppId}`,
        source: 'steam',
        score: synthetic.score,
        percentRecommended: synthetic.percentRecommended,
        tier: synthetic.tier,
        numReviews: totalReviews || 50,
        url: `https://store.steampowered.com/app/${steamAppId}`,
        summary: `Based on Steam community player reviews (${positive}% positive).`,
        isVerified: false,
        isSynthetic: true,
      };

      if (!skipBackgroundTrigger && isStagedVaultHydrationComplete()) {
        this.cacheResult(cacheKey, syntheticData, effectiveReleaseDate, enrichedGenres);
      } else {
        this.setInMemoryCache(cacheKey, syntheticData);
        if (!isStagedVaultHydrationComplete()) {
          this.stubPinnedKeys.add(cacheKey);
        }
      }
      return syntheticData;
    }

    // 6. Explicit unrated exclusion check (strictly null when no Steam reviews exist)
    if (KNOWN_UNRATED_TITLES.has(lowerTitle) || KNOWN_UNRATED_TITLES.has(getNormalizedKey())) {
      this.attemptedDynamicResolutions.add(cacheKey);
      if (lowerTitle) this.attemptedDynamicResolutions.add(`title:${lowerTitle}`);
      if (!skipBackgroundTrigger && isStagedVaultHydrationComplete()) {
        this.cacheResult(cacheKey, null, effectiveReleaseDate, enrichedGenres, {
          dynamicResolved: true,
          aliasTitle: rawTitle || undefined,
        });
      }
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
    storefrontAnchor?: StorefrontReviewAnchor | null,
    options?: {
      bypassAttempted?: boolean;
      platforms?: Array<{ platformId: string; platformGameId?: string }>;
      gameId?: string;
      genres?: string[];
      steamPositivePercent?: number;
    }
  ): Promise<CriticScoreData | null> {
    this.ensureHydrated();
    const title = (rawTitle || '').trim();
    if (!title) return null;

    let year = releaseYear;
    let enrichedReleaseDate: string | undefined;
    let enrichedGenres: string[] | undefined = options?.genres;
    if (steamAppId) {
      const enriched = STEAM_ENRICHED_CRITIC_MAP[String(steamAppId)];
      enrichedReleaseDate = enriched?.releaseDate || enriched?.release_date;
      enrichedGenres = enriched?.genres || enrichedGenres;
      if (!year && enrichedReleaseDate) {
        const m = String(enrichedReleaseDate).match(/\b(19\d\d|20\d\d)\b/);
        if (m) year = parseInt(m[1], 10);
      }
    }
    if (!year && title) {
      const m = title.match(/\b(19\d\d|20\d\d)\b/);
      if (m) year = parseInt(m[1], 10);
    }
    const effectiveReleaseDate = enrichedReleaseDate || (year ? String(year) : undefined);

    const cacheKey = steamAppId ? `id:${steamAppId}` : `title:${title.toLowerCase()}`;
    const stagedKey = `${STORAGE_PREFIX}${cacheKey}`;

    if (options?.bypassAttempted) {
      this.attemptedDynamicResolutions.delete(cacheKey);
      if (title) this.attemptedDynamicResolutions.delete(`title:${title.toLowerCase()}`);
    }

    const userOverride = this.findMatchingUserOverride(steamAppId, title, options?.gameId);
    if (userOverride && (userOverride.reviewScoreOverride !== undefined || userOverride.reviewRoute !== undefined)) {
      const route = inferReviewRouteFromOverride(userOverride);
      if (route?.mode === 'unrated') {
        this.setInMemoryCache(cacheKey, null);
        saveStagedCache<CriticScoreData>(stagedKey, null, MutabilityTier.TIER_0_USER_OVERRIDE);
        return null;
      }
      if (route?.mode === 'static') {
        const staticScore = userOverride.reviewScoreOverride ?? null;
        this.setInMemoryCache(cacheKey, staticScore);
        saveStagedCache<CriticScoreData>(stagedKey, staticScore, MutabilityTier.TIER_0_USER_OVERRIDE);
        return staticScore;
      }
      if (route?.mode === 'routed') {
        const stagedRouted = loadStagedCache<CriticScoreData>(stagedKey, false);
        if (!onlineLifecycleManager.isOnline()) {
          const fallbackVal = stagedRouted.data || userOverride.reviewScoreOverride || null;
          if (fallbackVal) {
            this.setInMemoryCache(cacheKey, fallbackVal);
          }
          return fallbackVal;
        }
        this.attemptedDynamicResolutions.add(cacheKey);
        if (title) this.attemptedDynamicResolutions.add(`title:${title.toLowerCase()}`);
        const refreshed = await this.resolveRoutedScore(route, title, year, userOverride.reviewScoreOverride);
        if (refreshed) {
          const dynamicTier = determineGameMutabilityTier({
            releaseDate: userOverride.releaseDate || effectiveReleaseDate,
            isOverride: false,
          });
          this.setInMemoryCache(cacheKey, refreshed);
          const savedRouted = saveStagedCache<CriticScoreData>(stagedKey, refreshed, dynamicTier, {
            source: refreshed.source,
            isVerified: refreshed.isVerified,
            dynamicResolved: true,
          });
          const lower = title.toLowerCase();
          if (lower && cacheKey !== `title:${lower}`) {
            this.setInMemoryCache(`title:${lower}`, refreshed);
            saveStagedCache<CriticScoreData>(`${STORAGE_PREFIX}title:${lower}`, refreshed, dynamicTier, {
              source: refreshed.source,
              isVerified: refreshed.isVerified,
              dynamicResolved: true,
              cachedAt: savedRouted.cachedAt,
              customTtlMs: savedRouted.ttlMs,
            });
          }
          try {
            const allOverrides = loadUserOverrides();
            if (userOverride.gameId && allOverrides[userOverride.gameId]) {
              allOverrides[userOverride.gameId].reviewScoreOverride = refreshed;
              if (userOverride.platformId && userOverride.platformGameId) {
                const pk = `${userOverride.platformId}:${userOverride.platformGameId}`;
                if (allOverrides[pk]) {
                  allOverrides[pk].reviewScoreOverride = refreshed;
                }
              }
              if (typeof localStorage !== 'undefined') {
                localStorage.setItem(STORAGE_KEY_USER_OVERRIDES, JSON.stringify(allOverrides));
              }
            }
          } catch {}
          if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
            window.dispatchEvent(
              new CustomEvent('antigravity_critic_updated', {
                detail: { cacheKey, title, steamAppId, data: refreshed },
              })
            );
          }
          return refreshed;
        }
        const fallbackVal = stagedRouted.data || userOverride.reviewScoreOverride || null;
        if (fallbackVal) {
          this.setInMemoryCache(cacheKey, fallbackVal);
        }
        return fallbackVal;
      }
    }

    // 0. Check Tier 0 User Override (Absolute human authority, skips dynamic resolution)
    const stagedTier0 = loadStagedCache<CriticScoreData>(stagedKey, false);
    if (
      stagedTier0.entry &&
      (stagedTier0.entry.tier === MutabilityTier.TIER_0_USER_OVERRIDE || stagedTier0.entry.tier === 'override')
    ) {
      if (stagedTier0.entry.data === null) {
        this.setInMemoryCache(cacheKey, null);
        return null;
      }
      if (stagedTier0.entry.data) {
        this.setInMemoryCache(cacheKey, stagedTier0.entry.data);
        return stagedTier0.entry.data;
      }
    }

    const lowerTitleKey = title ? `title:${title.toLowerCase()}` : '';
    if (this.inMemoryCache.has(cacheKey) || (lowerTitleKey && this.inMemoryCache.has(lowerTitleKey))) {
      const existing =
        this.inMemoryCache.get(cacheKey) ??
        (lowerTitleKey ? this.inMemoryCache.get(lowerTitleKey) : undefined);
      // Only short-circuit if already verified Tier 1 Metacritic; if OpenCritic, allow dynamic upgrade check
      if (existing?.isVerified && existing.source === 'metacritic') {
        if (this.validateScoreSemanticCompatibility(title, existing, steamAppId)) {
          this.cacheResult(cacheKey, existing, effectiveReleaseDate, enrichedGenres, {
            dynamicResolved: true,
            aliasTitle: title,
          });
          if (lowerTitleKey && lowerTitleKey !== cacheKey) {
            this.setInMemoryCache(lowerTitleKey, existing);
          }
          return existing;
        } else {
          this.inMemoryCache.delete(cacheKey);
          if (lowerTitleKey) this.inMemoryCache.delete(lowerTitleKey);
          this.attemptedDynamicResolutions.delete(cacheKey);
          if (lowerTitleKey) this.attemptedDynamicResolutions.delete(lowerTitleKey);
        }
      } else if (existing && this.validateScoreSemanticCompatibility(title, existing, steamAppId)) {
        if (!this.inMemoryCache.has(cacheKey)) {
          this.cacheResult(cacheKey, existing, effectiveReleaseDate, enrichedGenres);
        }
        if (lowerTitleKey && lowerTitleKey !== cacheKey && !this.inMemoryCache.has(lowerTitleKey)) {
          this.setInMemoryCache(lowerTitleKey, existing);
        }
      }
    }

    if (this.inFlightResolutions.has(cacheKey)) {
      return this.inFlightResolutions.get(cacheKey)!;
    }

    if (this.attemptedDynamicResolutions.has(cacheKey)) {
      const existing = this.inMemoryCache.get(cacheKey);
      if (existing && title) {
        if (!this.validateScoreSemanticCompatibility(title, existing, steamAppId)) {
          this.inMemoryCache.delete(cacheKey);
          this.attemptedDynamicResolutions.delete(cacheKey);
          if (title) this.attemptedDynamicResolutions.delete(`title:${title.toLowerCase()}`);
        } else {
          return existing;
        }
      } else {
        return existing ?? null;
      }
    }
    this.attemptedDynamicResolutions.add(cacheKey);
    if (title) this.attemptedDynamicResolutions.add(`title:${title.toLowerCase()}`);

    const promise = (async (): Promise<CriticScoreData | null> => {
      try {
        const cleanTitle = title
          .replace(/[™®©]/g, '')
          .replace(
            /\b(standard|deluxe|gold|silver|platinum|diamond|collector'?s|ultimate|complete|special|limited|definitive|enhanced|anniversary|directors-cut|director'?s cut|goty|game of the year|remastered|remake)( edition)?\b/gi,
            ''
          )
          .trim();

        const lower = title.toLowerCase();
        const normKey = normalizeCriticTitleKey(title);

        const isCandidateValid = (candidate: CriticScoreData | null | undefined): candidate is CriticScoreData =>
          candidate ? this.validateScoreSemanticCompatibility(title, candidate, steamAppId) : false;

        let priorPositiveScore: CriticScoreData | null = null;
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
            isCandidateValid(priorStaged.data)
          ) {
            priorPositiveScore = priorStaged.data;
            break;
          }
        }
        if (!priorPositiveScore) {
          const memExisting = this.inMemoryCache.get(cacheKey);
          if (memExisting && typeof memExisting.score === 'number' && memExisting.score > 0 && isCandidateValid(memExisting)) {
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

        const retainExplicitUnrated = () => {
          const current = this.inMemoryCache.get(cacheKey);
          if (current?.isSynthetic && isCandidateValid(current)) {
            this.cacheResult(cacheKey, current, effectiveReleaseDate, enrichedGenres, {
              dynamicResolved: true,
              aliasTitle: title,
            });
            if (lower && cacheKey !== `title:${lower}`) {
              this.setInMemoryCache(`title:${lower}`, current);
            }
            if (normKey && cacheKey !== `title:${normKey}`) {
              this.setInMemoryCache(`title:${normKey}`, current);
            }
            return current;
          }
          this.cacheResult(cacheKey, null, effectiveReleaseDate, enrichedGenres, {
            dynamicResolved: true,
            allowOverwritePositive: true,
            aliasTitle: title,
          });
          if (lower && cacheKey !== `title:${lower}`) {
            this.setInMemoryCache(`title:${lower}`, null);
          }
          if (normKey && cacheKey !== `title:${normKey}`) {
            this.setInMemoryCache(`title:${normKey}`, null);
          }
          return null;
        };

        if (
          KNOWN_UNRATED_TITLES.has(lower) ||
          (Boolean(normKey) && KNOWN_UNRATED_TITLES.has(normKey)) ||
          NON_GAME_ADDON_OR_BETA_REGEX.test(title)
        ) {
          return retainExplicitUnrated();
        }

        if (!onlineLifecycleManager.isOnline()) {
          this.attemptedDynamicResolutions.delete(cacheKey);
          if (lower) this.attemptedDynamicResolutions.delete(`title:${lower}`);
          if (priorPositiveScore) {
            this.setInMemoryCache(cacheKey, priorPositiveScore);
            if (lower && cacheKey !== `title:${lower}`) {
              this.setInMemoryCache(`title:${lower}`, priorPositiveScore);
            }
            if (normKey && cacheKey !== `title:${normKey}`) {
              this.setInMemoryCache(`title:${normKey}`, priorPositiveScore);
            }
            return priorPositiveScore;
          }
          const current = this.inMemoryCache.get(cacheKey);
          if (current && isCandidateValid(current)) {
            return current;
          }
          return null;
        }

        let hadTransientError = false;

        const retainSyntheticOrNull = () => {
          if (priorPositiveScore) {
            if (priorPositiveScore.isSynthetic && onlineLifecycleManager.isOnline()) {
              this.cacheResult(cacheKey, priorPositiveScore, effectiveReleaseDate, enrichedGenres, {
                dynamicResolved: true,
                aliasTitle: title,
                customTtlMs: hadTransientError ? TIER_TTLS.fresh : undefined,
              });
            }
            this.setInMemoryCache(cacheKey, priorPositiveScore);
            if (lower && cacheKey !== `title:${lower}`) {
              this.setInMemoryCache(`title:${lower}`, priorPositiveScore);
            }
            if (normKey && cacheKey !== `title:${normKey}`) {
              this.setInMemoryCache(`title:${normKey}`, priorPositiveScore);
            }
            return priorPositiveScore;
          }

          const current = this.inMemoryCache.get(cacheKey);
          if (current?.isSynthetic && isCandidateValid(current)) {
            if (onlineLifecycleManager.isOnline()) {
              this.cacheResult(cacheKey, current, effectiveReleaseDate, enrichedGenres, {
                dynamicResolved: true,
                aliasTitle: title,
                customTtlMs: hadTransientError ? TIER_TTLS.fresh : undefined,
              });
            }
            if (lower && cacheKey !== `title:${lower}`) {
              this.setInMemoryCache(`title:${lower}`, current);
            }
            if (normKey && cacheKey !== `title:${normKey}`) {
              this.setInMemoryCache(`title:${normKey}`, current);
            }
            return current;
          }

          if (!onlineLifecycleManager.isOnline()) {
            this.attemptedDynamicResolutions.delete(cacheKey);
            if (lower) this.attemptedDynamicResolutions.delete(`title:${lower}`);
            return null;
          }

          if (hadTransientError) {
            const prevFailures = this.transientFailureCounts.get(cacheKey) || 0;
            const nextFailures = prevFailures + 1;
            this.transientFailureCounts.set(cacheKey, nextFailures);
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
                saveStagedCache<CriticScoreData>(titleStagedKey, null, 'transient_error', {
                  failureReason: 'network_error',
                  dynamicResolved: true,
                  cachedAt: savedTransient.cachedAt,
                  customTtlMs: backoffTtlMs,
                });
              }
            }
            return null;
          }

          this.transientFailureCounts.delete(cacheKey);
          this.cacheResult(cacheKey, null, effectiveReleaseDate, enrichedGenres, {
            dynamicResolved: true,
            aliasTitle: title,
          });
          if (lower && cacheKey !== `title:${lower}`) {
            this.setInMemoryCache(`title:${lower}`, null);
          }
          if (normKey && cacheKey !== `title:${normKey}`) {
            this.setInMemoryCache(`title:${normKey}`, null);
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

        const broadcastUpdate = (data: CriticScoreData) => {
          if (!isCandidateValid(data)) return;
          const userOverride = this.findMatchingUserOverride(steamAppId, title);
          if (userOverride && userOverride.reviewScoreOverride !== undefined) {
            return;
          }
          this.transientFailureCounts.delete(cacheKey);
          this.cacheResult(cacheKey, data, effectiveReleaseDate, enrichedGenres, {
            dynamicResolved: true,
            aliasTitle: title,
          });
          if (lower && cacheKey !== `title:${lower}`) {
            this.setInMemoryCache(`title:${lower}`, data);
          }
          if (normKey && cacheKey !== `title:${normKey}`) {
            this.setInMemoryCache(`title:${normKey}`, data);
          }
          const baseKey = stripEditionSuffix(title);
          if (baseKey && baseKey !== normKey && cacheKey !== `title:${baseKey}`) {
            this.setInMemoryCache(`title:${baseKey}`, data);
          }
          if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
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
          if (metacriticResolver.hadRecentTransientFailure(title)) {
            hadTransientError = true;
          }
          if (
            mcBundle?.critic &&
            mcBundle.critic.isVerified &&
            mcBundle.critic.score > 0 &&
            isCandidateValid(mcBundle.critic)
          ) {
            broadcastUpdate(mcBundle.critic);
            return mcBundle.critic;
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

        // Rule 1 Fallback: If Metacritic HTML scrape failed or was blocked, but storefrontAnchor contains verified metacriticScore
        if (anchor?.metacriticScore !== undefined && typeof anchor.metacriticScore === 'number' && anchor.metacriticScore > 0) {
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
            if (isCandidateValid(anchorMcResult)) {
              broadcastUpdate(anchorMcResult);
              return anchorMcResult;
            }
          }
        }

        // If we already have a verified OpenCritic score, and Metacritic didn't produce a Tier 1 score,
        // PRESERVE the verified OpenCritic score! DO NOT downgrade to Tier 3 user score or Tier 4 Steam!
        const existingPreSeeded =
          this.inMemoryCache.get(cacheKey) ||
          (steamAppId ? KNOWN_CRITIC_SCORES[steamAppId] : undefined) ||
          KNOWN_CRITIC_SCORES[title.toLowerCase()] ||
          (normKey ? KNOWN_CRITIC_SCORES[normKey] : undefined);

        if (existingPreSeeded?.isVerified && existingPreSeeded.source === 'opencritic' && isCandidateValid(existingPreSeeded)) {
          this.cacheResult(cacheKey, existingPreSeeded, effectiveReleaseDate, enrichedGenres, { dynamicResolved: true });
          if (lower && cacheKey !== `title:${lower}`) {
            this.setInMemoryCache(`title:${lower}`, existingPreSeeded);
          }
          if (normKey && cacheKey !== `title:${normKey}`) {
            this.setInMemoryCache(`title:${normKey}`, existingPreSeeded);
          }
          return existingPreSeeded;
        }

        // ==========================================
        // TIER 2: OpenCritic Live API Resolution
        // ==========================================

        let openCriticRejectedCloseCandidate = false;
        try {
          const baseUrl =
            typeof window !== 'undefined' && window.location.hostname === 'localhost'
              ? '/api/opencritic'
              : 'https://api.opencritic.com';

          const searchUrl = `${baseUrl}/api/game/search?criteria=${encodeURIComponent(cleanTitle || title)}`;
          const headers: Record<string, string> = { ...OPENCRITIC_PUBLIC_HEADERS };

          const searchRes = await requestScheduler.schedule(
            searchUrl,
            () => fetch(searchUrl, { headers }),
            Priority.P1_VIEWPORT,
            'api.opencritic.com'
          );
          if (!searchRes.ok) {
            if (
              searchRes.status === 429 ||
              searchRes.status >= 500 ||
              isWafOrChallengeResponse(searchRes.status, '')
            ) {
              hadTransientError = true;
            }
          } else {
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
                    if (
                      !isSequelMismatch(cleanTitle || title, c.name) &&
                      isTitleCompatible(cleanTitle || title, c.name)
                    ) {
                      best = c;
                      break;
                    } else {
                      openCriticRejectedCloseCandidate = true;
                    }
                  }
                }
              }

              if (best) {
                const detailsUrl = `${baseUrl}/api/game/${best.id}`;
                const detailsRes = await requestScheduler.schedule(
                  detailsUrl,
                  () => fetch(detailsUrl, { headers }),
                  Priority.P1_VIEWPORT,
                  'api.opencritic.com'
                );
                if (!detailsRes.ok) {
                  if (
                    detailsRes.status === 429 ||
                    detailsRes.status >= 500 ||
                    isWafOrChallengeResponse(detailsRes.status, '')
                  ) {
                    hadTransientError = true;
                  }
                } else {
                  const data = await detailsRes.json();
                  const candidateTitle = data?.name || best.name;
                  const titleCompatible = isTitleCompatible(cleanTitle || title, candidateTitle);

                  // Release Year Reboot Guard
                  let yearRejected = false;
                  const yrMatch = String(data?.firstReleaseDate || '').match(/\b(19\d\d|20\d\d)\b/);
                  const ocYear = yrMatch ? parseInt(yrMatch[1], 10) : null;
                  const hasYearInTitle = /\b(19\d\d|20\d\d)\b/.test(title);
                  const numYear = year ? Number(String(year).match(/\b(19\d\d|20\d\d)\b/)?.[1] || year) : NaN;
                  if (!isNaN(numYear) && ocYear && (hasYearInTitle || numYear <= 2020)) {
                    const isRemaster =
                      /\b(remastered|remaster|definitive|enhanced|anniversary|complete|goty|director'?s cut|redux|remake)\b/i.test(
                        title
                      );
                    if (Math.abs(numYear - ocYear) >= 4 && !isRemaster) {
                      yearRejected = true;
                    }
                  }
                  const titleNoYear = title.replace(/\s*\((?:19|20)\d{2}\)/g, '').trim();
                  if (
                    /\b(?:1|i)\b/i.test(titleNoYear) &&
                    !/\b(?:1|i)\b/i.test(candidateTitle) &&
                    ocYear &&
                    ocYear >= 2015
                  ) {
                    yearRejected = true;
                  }

                  if (
                    data &&
                    titleCompatible &&
                    !yearRejected &&
                    typeof data.topCriticScore === 'number' &&
                    data.topCriticScore > 0
                  ) {
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
                      const slug = candidateTitle
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

                      if (isCandidateValid(result)) {
                        broadcastUpdate(result);
                        return result;
                      }
                    }
                  }
                }
              }
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

        // Rule 2 Fallback: If OpenCritic API is unreachable or has no direct match, but storefrontAnchor contains verified openCriticScore
        if (
          anchor?.openCriticScore !== undefined &&
          anchor.openCriticScore > 0 &&
          !openCriticRejectedCloseCandidate &&
          !(steamAppId && anchor.storefront === 'gog' && !anchor.openCriticId)
        ) {
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
            if (isCandidateValid(ocResult) || (!steamAppId && anchor.isVerifiedGroundTruth)) {
              broadcastUpdate(ocResult);
              return ocResult;
            }
          }
        }

        // ==========================================
        // TIER 3 & 4: Metacritic User Score & Steam Live Community Reviews
        // Sample-Size Weighting: High-sample verified Steam consensus beats tiny (<25) Metacritic user ratings
        // ==========================================
        if (mcBundle?.user && mcBundle.user.score > 0 && isCandidateValid(mcBundle.user)) {
          const mcUserCount = mcBundle.user.numReviews || 0;
          if (mcUserCount >= 25 || !steamAppId) {
            broadcastUpdate(mcBundle.user);
            return mcBundle.user;
          }

          try {
            const steamResult = await steamReviewResolver.resolveScore(title, steamAppId);
            if (
              steamResult &&
              steamResult.score > 0 &&
              isCandidateValid(steamResult) &&
              (steamResult.numReviews || 0) >= Math.max(100, mcUserCount * 5)
            ) {
              broadcastUpdate(steamResult);
              return steamResult;
            }
          } catch (steamErr: unknown) {
            console.warn(
              `[CriticScoreService] Steam live reviews check warning for "${title}":`,
              steamErr instanceof Error ? steamErr.message : String(steamErr)
            );
          }

          broadcastUpdate(mcBundle.user);
          return mcBundle.user;
        }

        // ==========================================
        // TIER 4: Steam Live Community Reviews Resolver
        // ==========================================
        try {
          const steamResult = await steamReviewResolver.resolveScore(title, steamAppId);
          if (steamReviewResolver.hadTransientError(title, steamAppId)) {
            hadTransientError = true;
          }
          if (steamResult && steamResult.isSynthetic && steamResult.score > 0 && isCandidateValid(steamResult)) {
            broadcastUpdate(steamResult);
            return steamResult;
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
          const xboxPlat = options?.platforms?.find((p) => p.platformId === 'xbox') as
            | { platformId: string; platformGameId?: string; xboxProductId?: string }
            | undefined;
          const xboxProductId =
            xboxPlat?.xboxProductId ||
            (/^[A-Z0-9]{12}$/i.test(String(xboxPlat?.platformGameId || ''))
              ? xboxPlat?.platformGameId
              : undefined);
          const storefrontResult = await storefrontStarResolver.resolveStorefrontScore(
            xboxProductId ? { title, xboxProductId } : title
          );
          if (storefrontStarResolver.hadRecentTransientFailure(title)) {
            hadTransientError = true;
          }
          if (storefrontResult && storefrontResult.score > 0 && isCandidateValid(storefrontResult)) {
            broadcastUpdate(storefrontResult);
            return storefrontResult;
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
      } catch {
        return this.inMemoryCache.get(cacheKey) ?? null;
      } finally {
        this.inFlightResolutions.delete(cacheKey);
      }
    })();

    this.inFlightResolutions.set(cacheKey, promise);
    return promise;
  }

  private cacheResult(
    key: string,
    data: CriticScoreData | null,
    releaseDate?: string | Date | number | null,
    genres?: string[] | string | null,
    options?: {
      dynamicResolved?: boolean;
      allowOverwritePositive?: boolean;
      aliasTitle?: string;
      customTtlMs?: number;
      cachedAt?: number;
    }
  ): void {
    const stagedKey = key.startsWith(STORAGE_PREFIX) ? key : `${STORAGE_PREFIX}${key}`;
    const existingStaged = loadStagedCache<CriticScoreData>(stagedKey, false);
    if (
      existingStaged.entry &&
      (existingStaged.entry.tier === MutabilityTier.TIER_0_USER_OVERRIDE || existingStaged.entry.tier === 'override')
    ) {
      return;
    }
    const rawKey = key.startsWith(STORAGE_PREFIX) ? key.slice(STORAGE_PREFIX.length) : key;
    if (data && typeof data.score === 'number' && data.score > 0) {
      this.setInMemoryCache(key, data);
      const overrideMeta = data as CriticScoreData & { isUserOverride?: boolean };
      const tier = determineGameMutabilityTier({
        releaseDate,
        genres,
        isOverride: Boolean(overrideMeta.isUserOverride || (data.tier as string) === 'override'),
      });
      const savedEntry = saveStagedCache<CriticScoreData>(stagedKey, data, tier, {
        source: data.source,
        isVerified: data.isVerified,
        dynamicResolved: options?.dynamicResolved,
        customTtlMs: options?.customTtlMs,
        cachedAt: options?.cachedAt,
      });
      if (options?.dynamicResolved && rawKey.startsWith('id:') && options?.aliasTitle) {
        const lowerAlias = options.aliasTitle.trim().toLowerCase();
        if (lowerAlias) {
          const titleStagedKey = `${STORAGE_PREFIX}title:${lowerAlias}`;
          const existingTitleStaged = loadStagedCache<CriticScoreData>(titleStagedKey, false);
          if (
            !existingTitleStaged.entry ||
            (existingTitleStaged.entry.tier !== MutabilityTier.TIER_0_USER_OVERRIDE &&
              existingTitleStaged.entry.tier !== 'override')
          ) {
            this.setInMemoryCache(`title:${lowerAlias}`, data);
            saveStagedCache<CriticScoreData>(titleStagedKey, data, tier, {
              source: data.source,
              isVerified: data.isVerified,
              dynamicResolved: true,
              cachedAt: savedEntry.cachedAt,
              customTtlMs: savedEntry.ttlMs,
            });
          }
        }
      }
      if (rawKey.startsWith('title:')) {
        const normKey = normalizeCriticTitleKey(rawKey.slice(6));
        if (normKey) {
          const normStagedKey = `${STORAGE_PREFIX}title:${normKey}`;
          if (normStagedKey !== stagedKey) {
            this.setInMemoryCache(`title:${normKey}`, data);
          }
        }
      }
    } else {
      if (
        !options?.allowOverwritePositive &&
        existingStaged.data &&
        typeof existingStaged.data.score === 'number' &&
        existingStaged.data.score > 0
      ) {
        this.setInMemoryCache(key, existingStaged.data);
        return;
      }
      if (!onlineLifecycleManager.isOnline() && !options?.allowOverwritePositive) {
        return;
      }
      this.setInMemoryCache(key, null);
      const savedNeg = saveStagedCache<CriticScoreData>(stagedKey, null, 'negative', {
        failureReason: 'not_found',
        dynamicResolved: options?.dynamicResolved,
        customTtlMs: options?.customTtlMs,
        cachedAt: options?.cachedAt,
      });
      if (options?.dynamicResolved && rawKey.startsWith('id:') && options?.aliasTitle) {
        const lowerAlias = options.aliasTitle.trim().toLowerCase();
        if (lowerAlias) {
          const titleStagedKey = `${STORAGE_PREFIX}title:${lowerAlias}`;
          const existingTitleStaged = loadStagedCache<CriticScoreData>(titleStagedKey, false);
          if (
            !existingTitleStaged.entry ||
            (existingTitleStaged.entry.tier !== MutabilityTier.TIER_0_USER_OVERRIDE &&
              existingTitleStaged.entry.tier !== 'override')
          ) {
            const hasPositiveTitle =
              !options?.allowOverwritePositive &&
              existingTitleStaged.data &&
              typeof existingTitleStaged.data.score === 'number' &&
              existingTitleStaged.data.score > 0;
            if (!hasPositiveTitle) {
              this.setInMemoryCache(`title:${lowerAlias}`, null);
              saveStagedCache<CriticScoreData>(titleStagedKey, null, 'negative', {
                failureReason: 'not_found',
                dynamicResolved: true,
                cachedAt: savedNeg.cachedAt,
                customTtlMs: savedNeg.ttlMs,
              });
            }
          }
        }
      }
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
  storefrontAnchor?: StorefrontReviewAnchor | null,
  bypassTTL: boolean = false,
  skipBackgroundTrigger: boolean = false
): OpenCriticData | null {
  return criticScoreService.getCriticScore(
    steamAppId,
    title,
    steamPositivePercent,
    releaseYear,
    storefrontAnchor,
    bypassTTL,
    skipBackgroundTrigger
  );
}
