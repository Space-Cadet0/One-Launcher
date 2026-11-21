import type { CanonicalGame } from '../../../contracts/game';
import { CRITIC_STORAGE_PREFIX } from '../../../contracts/critic';
import { steamMatcher } from '../../steam/steamMatcher';
import { criticScoreService, getOpenCriticData } from '../../critic/criticScoreService';
import { getReviewSourceAuthorityRank } from '../../critic/criticUtils';
import { buildVerifiedSteamMetacriticAnchor } from '../../critic/reviewScoreResolver';
import {
  normalizeWikidataGogSlug,
  wikidataBridge,
  type WikidataBatchStoreItem,
} from '../../critic/wikidataBridge';
import { RequestPriority } from '../requestScheduler';
import {
  getUserOverrideForGame,
  inferReviewRouteFromOverride,
} from '../../storage/userOverrideStorage';
import { loadStagedCache, whenStagedCacheHydrated } from '../../storage/stagedCacheService';
import { flushPendingCatalogSave } from '../../integrations/integrationStorage';
import { isUserActivelyScrolling, waitUntilScrollIdle } from '../../../utils/scrollActivityTracker';
import { onlineLifecycleManager } from '../onlineLifecycleManager';
import {
  type SyncCategory,
  type SyncJobHandle,
  type SyncJobState,
  type TrackedCategoryStats,
  yieldToMainThread,
} from './syncStateMachine';

export interface CriticScoreSyncOptions {
  forceRefresh?: boolean;
  deepReverify?: boolean;
  isBackgroundWarmup?: boolean;
  isBackground?: boolean;
}

export interface CriticScoreSyncRuntime {
  getState(): SyncJobState | null;
  setState(next: SyncJobState | null): void;
  notify(): void;
  syncHeadlineAndPriorityFields(): void;
  hasActiveManualJob(): boolean;
  getCriticLoopToken(): number;
  getBackgroundWarmupEpoch(): number;
  isCancelled(): boolean;
  setCancelled(cancelled: boolean): void;
  preemptExistingForManualJob(): void;
  allocateCriticJobHandle(isBackground: boolean): SyncJobHandle;
  getCategoryStats(): Map<SyncCategory, TrackedCategoryStats>;
  getActiveCategories(): SyncCategory[];
  recomputeAggregateStateFromCategories(
    latestCategory?: SyncCategory,
    latestItemName?: string
  ): void;
  waitWhilePausedOrPreempted(shouldAbort?: () => boolean): Promise<void>;
}

function extractGameGogSlugForWikidata(game: CanonicalGame): string | undefined {
  const gogPlat = game.platforms?.find((p) => p?.platformId?.toLowerCase() === 'gog');
  if (gogPlat) {
    const fromPlat =
      normalizeWikidataGogSlug(gogPlat.platformGameId) ||
      normalizeWikidataGogSlug(gogPlat.storefrontAppId);
    if (fromPlat) return fromPlat;
  }
  if (game.enrichedMetadata?.website && /gog\.com\//i.test(game.enrichedMetadata.website)) {
    const fromSite = normalizeWikidataGogSlug(game.enrichedMetadata.website);
    if (fromSite) return fromSite;
  }
  if (game.id?.startsWith('gog-')) {
    const fromId = normalizeWikidataGogSlug(game.id.slice(4));
    if (fromId) return fromId;
  }
  return undefined;
}

export async function executeCriticScoreSyncJob(
  runtime: CriticScoreSyncRuntime,
  games: CanonicalGame[],
  options: CriticScoreSyncOptions | undefined,
  isBackground: boolean
): Promise<void> {
  // P0-3: Snapshot tokens BEFORE awaiting `whenStagedCacheHydrated()` so preemption during
  // hydration aborts cleanly instead of starting a stale background critic sync.
  if (isBackground) {
    const entryCriticToken = runtime.getCriticLoopToken();
    const entryWarmupEpoch = runtime.getBackgroundWarmupEpoch();
    await whenStagedCacheHydrated();
    const curState = runtime.getState();
    if (
      runtime.getCriticLoopToken() !== entryCriticToken ||
      runtime.getBackgroundWarmupEpoch() !== entryWarmupEpoch ||
      !onlineLifecycleManager.isOnline() ||
      (curState?.type === 'critic_scores' && curState?.status === 'running') ||
      runtime.hasActiveManualJob()
    ) {
      return;
    }
  } else {
    runtime.preemptExistingForManualJob();
  }

  if (options?.forceRefresh) {
    if (options?.deepReverify) {
      criticScoreService.clearCache();
    } else {
      criticScoreService.prepareForIncrementalRefresh();
    }
  }
  criticScoreService.purgeStaleNullScores();

  const shouldSkipFreshVerifiedMcOnForceRefresh = Boolean(
    options?.forceRefresh && !options?.deepReverify && games.length > 25
  );

  // Pass skipBackgroundTrigger = true so filtering does NOT fire simultaneous background requests!
  const filteredGames = options?.forceRefresh
    ? shouldSkipFreshVerifiedMcOnForceRefresh
      ? games.filter((g) => {
          const targetSteamId = steamMatcher.getEffectiveSteamAppId(g);
          const ov = getUserOverrideForGame(g);
          const route = ov ? inferReviewRouteFromOverride(ov) : undefined;
          if (route?.mode === 'unrated' || route?.mode === 'static') {
            return false;
          }
          return !criticScoreService.hasFreshVerifiedPressCriticScore(g.title, {
            steamAppId: targetSteamId,
            gameId: g.id,
            platforms: g.platforms,
            metacriticOnly: true,
          });
        })
      : games
    : games.filter((g) => {
        const targetSteamId = steamMatcher.getEffectiveSteamAppId(g);
        const ov = getUserOverrideForGame(g) as
          | (ReturnType<typeof getUserOverrideForGame> & {
              reviewRoute?: { mode?: 'routed' | 'static' };
            })
          | undefined;
        if (
          ov &&
          (ov.reviewRoute?.mode === 'routed' ||
            (ov.reviewScoreOverride &&
              ov.reviewScoreOverride.source !== 'custom' &&
              ov.reviewRoute?.mode !== 'static'))
        ) {
          const cacheKey = targetSteamId
            ? `id:${targetSteamId}`
            : `title:${g.title.toLowerCase().trim()}`;
          const staged = loadStagedCache(`${CRITIC_STORAGE_PREFIX}${cacheKey}`, false);
          if (!staged.valid) return true;
        }
        if (isBackground && criticScoreService.hasValidCachedResolution(targetSteamId, g.title)) {
          return false;
        }
        const score = getOpenCriticData(
          targetSteamId || undefined,
          g.title,
          g.reviewSummary?.positivePercent ?? g.enrichedMetadata?.reviewSummary?.positivePercent,
          g.releaseDate,
          buildVerifiedSteamMetacriticAnchor(g),
          false,
          true,
          { gameId: g.id, platforms: g.platforms }
        );
        if (isBackground && criticScoreService.hasValidCachedResolution(targetSteamId, g.title)) {
          return false;
        }
        if (criticScoreService.hasAttemptedDynamicResolution(targetSteamId, g.title)) {
          return false;
        }
        if (score && score.score > 0) {
          if (!criticScoreService.hasValidCachedResolution(targetSteamId, g.title)) {
            const cacheKey = targetSteamId
              ? `id:${targetSteamId}`
              : `title:${g.title.toLowerCase().trim()}`;
            const staged = loadStagedCache(`${CRITIC_STORAGE_PREFIX}${cacheKey}`, false);
            if (staged.stale) {
              return true;
            }
          }
          if (
            score.isSynthetic &&
            (!isBackground || !criticScoreService.hasValidCachedResolution(targetSteamId, g.title))
          ) {
            return true;
          }
          return false;
        }
        return true;
      });

  // Stage 2 Priority Ordering:
  // 0: null / uncached -> 1: upgradeable non-critic fallbacks (GOG/XBX/EGS/STM/MCU) -> 2: stale OC -> 3: stale MC
  const targetGames = filteredGames
    .map((g, origIdx) => {
      const targetSteamId = steamMatcher.getEffectiveSteamAppId(g);
      const existingScore = getOpenCriticData(
        targetSteamId || undefined,
        g.title,
        undefined,
        g.releaseDate,
        undefined,
        false,
        true,
        { gameId: g.id, platforms: g.platforms }
      );
      let bucket = 0;
      let subRank = 0;
      if (existingScore && existingScore.score > 0) {
        if (existingScore.source === 'metacritic') {
          bucket = 3;
          subRank = 4;
        } else if (existingScore.source === 'opencritic') {
          bucket = 2;
          subRank = 3;
        } else if (existingScore.source === 'custom') {
          bucket = 3;
          subRank = 5;
        } else {
          bucket = 1;
          subRank = getReviewSourceAuthorityRank(existingScore);
        }
      }
      return { game: g, bucket, subRank, origIdx };
    })
    .toSorted((a, b) => a.bucket - b.bucket || a.subRank - b.subRank || a.origIdx - b.origIdx)
    .map((entry) => entry.game);

  if (targetGames.length === 0) {
    if (!isBackground) {
      runtime.setState({
        id: `sync-critic-scores-${Date.now()}`,
        type: 'critic_scores',
        title: 'Syncing Review Scores',
        headline: 'Syncing Review Scores',
        total: 0,
        current: 0,
        status: 'completed',
        startedAt: Date.now(),
      });
      runtime.notify();
    }
    return;
  }

  const handle = runtime.allocateCriticJobHandle(isBackground);
  runtime.setCancelled(false);

  const categoryStats = runtime.getCategoryStats();
  // Prune any already-finished single-shot categories (e.g. startup achievement check)
  for (const [cat, stat] of categoryStats.entries()) {
    if (stat.inFlight === 0 && stat.completed >= stat.total) {
      categoryStats.delete(cat);
    }
  }

  categoryStats.set('critic_scores', {
    total: targetGames.length,
    completed: 0,
    inFlight: 1,
    lastItemName: targetGames[0]?.title,
  });

  runtime.setState({
    id: handle.jobId,
    type: 'critic_scores',
    title: 'Syncing Review Scores',
    headline: 'Syncing Review Scores',
    total: targetGames.length,
    current: 0,
    currentItemName: targetGames[0]?.title,
    status: 'running',
    startedAt: Date.now(),
  });
  runtime.syncHeadlineAndPriorityFields();
  runtime.notify();

  const shouldAbort = (): boolean => runtime.isCancelled() || handle.isStale();

  // Stage 1: Polite Batch Wikidata SPARQL Pre-Pass for upgrade-eligible games with Steam AppIDs or GOG slugs.
  if (onlineLifecycleManager.isOnline() && !shouldAbort()) {
    const wikidataBatchItems: WikidataBatchStoreItem[] = [];
    for (const game of targetGames) {
      const steamAppId = steamMatcher.getEffectiveSteamAppId(game);
      const gogSlug = extractGameGogSlugForWikidata(game);
      if (!steamAppId && !gogSlug) continue;
      if (
        criticScoreService.hasFreshVerifiedPressCriticScore(game.title, {
          steamAppId,
          gameId: game.id,
          platforms: game.platforms,
          metacriticOnly: true,
        })
      ) {
        continue;
      }
      wikidataBatchItems.push({
        key: game.id || `${steamAppId ?? ''}:${gogSlug ?? ''}:${game.title}`,
        steamAppId: steamAppId ?? null,
        gogSlug: gogSlug ?? null,
        title: game.title,
      });
    }
    if (wikidataBatchItems.length > 0) {
      try {
        await wikidataBridge.batchResolveByStoreIds(wikidataBatchItems, {
          priority: isBackground ? RequestPriority.P2_BACKGROUND : RequestPriority.P1_VIEWPORT,
        });
      } catch {
        // Non-fatal: individual game resolution still cascades through Metacritic / OpenCritic / Steam
      }
    }
  }

  const chunkSize = isBackground ? 2 : 3;
  let completedCount = 0;

  try {
    for (let i = 0; i < targetGames.length; i += chunkSize) {
      if (shouldAbort() || runtime.getState()?.status === 'cancelled') {
        break;
      }

      await runtime.waitWhilePausedOrPreempted(shouldAbort);
      if (
        isBackground &&
        isUserActivelyScrolling() &&
        !(typeof process !== 'undefined' && process.env.VITEST)
      ) {
        await waitUntilScrollIdle(1500);
      }
      if (shouldAbort()) break;

      const chunk = targetGames.slice(i, i + chunkSize);
      const activeTitles = new Set<string>();
      const firstTitle = chunk[0]?.title;

      const stat = categoryStats.get('critic_scores');
      if (stat) {
        stat.completed = completedCount;
        if (firstTitle) stat.lastItemName = firstTitle;
      }

      // P0-3: Require exact `this.state.id === handle.jobId` (via `handle.isStale()`) —
      // NEVER `state.id.startsWith('auto-')` which could clobber a newer `auto-store-media-*` job!
      if (!handle.isStale()) {
        const activeCats = runtime.getActiveCategories();
        if (activeCats.length > 1) {
          runtime.recomputeAggregateStateFromCategories('critic_scores', firstTitle);
        } else {
          handle.safeUpdateState({
            current: completedCount,
            total: targetGames.length,
            currentItemName: firstTitle,
          });
        }
      }

      await Promise.all(
        chunk.map(async (game) => {
          if (shouldAbort()) return;
          await runtime.waitWhilePausedOrPreempted(shouldAbort);
          if (shouldAbort()) return;
          if (game.title) {
            activeTitles.add(game.title);
          }
          try {
            let targetSteamId = steamMatcher.getEffectiveSteamAppId(game);
            if (!targetSteamId && !game.isExplicitNonSteam) {
              try {
                const matchedId = await steamMatcher.matchGameToSteam(game.title, {
                  releaseYear: game.releaseDate,
                  developers: game.developers,
                });
                if (matchedId) targetSteamId = matchedId;
              } catch {}
            }
            if (shouldAbort()) return;
            const storefrontAnchor = buildVerifiedSteamMetacriticAnchor(game) ?? undefined;
            const resolvedScore = await criticScoreService.resolveDynamicScore(
              game.title,
              targetSteamId,
              game.releaseDate,
              storefrontAnchor ?? undefined,
              {
                bypassAttempted: Boolean(options?.forceRefresh),
                platforms: game.platforms,
                gameId: game.id,
                genres: game.genres,
                steamPositivePercent:
                  game.reviewSummary?.positivePercent ??
                  game.enrichedMetadata?.reviewSummary?.positivePercent,
              }
            );
            if (
              resolvedScore &&
              typeof window !== 'undefined' &&
              window.electronAPI?.offlineVault?.saveGameDetail
            ) {
              try {
                void window.electronAPI.offlineVault
                  .saveGameDetail({
                    gameId: game.id,
                    steamAppId: targetSteamId ?? game.steamAppId ?? null,
                    canonicalTitle: game.title,
                    platforms: game.platforms,
                    criticScore: { ...resolvedScore } as Record<string, unknown>,
                  })
                  ?.catch?.(() => {});
              } catch {}
            }
          } catch {} finally {
            activeTitles.delete(game.title);
            if (!shouldAbort()) {
              completedCount = Math.min(targetGames.length, completedCount + 1);
              const nextActiveTitle = activeTitles.values().next().value as string | undefined;
              const nextItemName =
                nextActiveTitle ?? (stat?.lastItemName || runtime.getState()?.currentItemName);
              if (stat) {
                stat.completed = completedCount;
                if (nextItemName) stat.lastItemName = nextItemName;
              }
              if (!handle.isStale()) {
                const activeCats = runtime.getActiveCategories();
                if (activeCats.length > 1) {
                  runtime.recomputeAggregateStateFromCategories('critic_scores', nextItemName);
                } else {
                  handle.safeUpdateState({
                    current: completedCount,
                    total: targetGames.length,
                    currentItemName: nextItemName,
                  });
                }
              }
            }
          }
        })
      );

      await yieldToMainThread();

      if (
        isBackground &&
        completedCount < targetGames.length &&
        !shouldAbort() &&
        !(typeof process !== 'undefined' && process.env.VITEST)
      ) {
        await new Promise<void>((r) => setTimeout(r, 300));
      }
    }

    if (handle.isStale()) {
      return;
    }

    const stat = categoryStats.get('critic_scores');
    if (stat) {
      stat.inFlight = 0;
      stat.completed = stat.total;
    }

    if (runtime.isCancelled() || runtime.getState()?.status === 'cancelled') {
      categoryStats.delete('critic_scores');
      handle.safeUpdateState({
        status: 'cancelled',
        currentItemName: undefined,
      });
    } else {
      const remainingCats = runtime.getActiveCategories().filter((c) => c !== 'critic_scores');
      categoryStats.delete('critic_scores');
      if (remainingCats.length > 0) {
        runtime.recomputeAggregateStateFromCategories(remainingCats[0]);
      } else {
        handle.safeUpdateState({
          status: 'completed',
          current: targetGames.length,
          total: targetGames.length,
          currentItemName: undefined,
        });
      }
    }
  } finally {
    if (!handle.isStale()) {
      try {
        flushPendingCatalogSave();
        if (typeof window !== 'undefined') {
          window.electronAPI?.trimMemory?.({ passive: true })?.catch?.(() => {});
        }
      } catch {}
    }
  }
}
