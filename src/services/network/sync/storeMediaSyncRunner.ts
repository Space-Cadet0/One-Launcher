import type { CanonicalGame } from '../../../contracts/game';
import type { MediaSyncOutcome } from '../../../contracts/steam';
import { steamMatcher } from '../../steam/steamMatcher';
import { steamApi } from '../../steam/steamApi';
import {
  fallbackMetadataProvider,
  isGenericPlaceholderSynopsis,
} from '../../steam/fallbackMetadataProvider';
import { requestScheduler, RequestPriority } from '../requestScheduler';
import {
  getUserOverrideForGame,
  inferMetadataRouteFromOverride,
  updateRoutedMetadataSnapshot,
} from '../../storage/userOverrideStorage';
import { recordMediaSyncAttempt, whenStagedCacheHydrated } from '../../storage/stagedCacheService';
import { flushPendingCatalogSave } from '../../integrations/integrationStorage';
import {
  pickBestEnrichedMetadata,
  pickPreferredCapsuleImage,
  pickPreferredDetailedDescription,
  pickPreferredHeaderImage,
  pickPreferredReleaseDate,
} from '../../storage/librarySync';
import { isUserActivelyScrolling, waitUntilScrollIdle } from '../../../utils/scrollActivityTracker';
import { onlineLifecycleManager } from '../onlineLifecycleManager';
import { fetchAndCacheHltb, hasAttemptedHltbLookup } from '../../hltb/howLongToBeat';
import {
  isGogCroppedHorizontalCover,
  isUnsuitableCoverUrl,
} from '../../igdb/igdbCoverService';
import {
  clearDurableEmptySynopsisProbe,
  hasGenuineStoreSynopsis,
  isLikelyNonStoreOrTestBranchTitle,
} from '../../../components/Library/MatchManager/matchManagerDiagnostics';
import {
  buildHydrationGameEntry,
  extractStaticHydrationAssets,
} from './hydrationAssetExtractor';
import {
  computeMediaRepairPriority,
  evaluateGameNeedsStoreMediaSync,
  hasActiveMediaSyncCooldown,
  isOwnedNativeMacGame,
  MAX_PASSIVE_REPAIR_PER_BOOT,
  MEDIA_SYNC_DOMAINS,
  type MediaRepairPriorityTier,
  resolveSyncHostPlatform,
  type StoreMediaSyncEvalOptions,
  type StoreMediaSyncOptions,
} from './mediaSyncEligibility';
import {
  type SyncJobHandle,
  type SyncJobState,
  yieldToMainThread,
} from './syncStateMachine';

interface MediaSyncRateError {
  isRateLimited?: boolean;
  status?: number;
  cooldownRemaining?: number;
  message?: string;
  response?: {
    status?: number;
  };
}

const MAX_RATE_LIMIT_RETRIES = 3;

export interface StoreMediaSyncRuntime {
  getState(): SyncJobState | null;
  setState(next: SyncJobState | null): void;
  notify(): void;
  syncHeadlineAndPriorityFields(): void;
  hasActiveManualJob(): boolean;
  getMediaSyncLoopToken(): number;
  getBackgroundWarmupEpoch(): number;
  isCancelled(): boolean;
  setCancelled(cancelled: boolean): void;
  cancelJob(id: string): void;
  bumpMediaSyncLoopToken(): number;
  bumpCriticLoopToken(): void;
  drainPauseWaiters(): void;
  createMediaJobHandle(jobId: string, myToken: number): SyncJobHandle;
  waitWhilePausedOrPreempted(shouldAbort?: () => boolean): Promise<void>;
}

export async function executeStoreMediaSyncJob(
  runtime: StoreMediaSyncRuntime,
  games: CanonicalGame[],
  onGameUpdated: (updated: CanonicalGame) => void,
  options?: StoreMediaSyncOptions
): Promise<void> {
  const isBackgroundWarmup = Boolean(options?.isBackgroundWarmup);
  const forceRefresh = Boolean(options?.forceRefresh);
  const isManualSync = Boolean(options?.isManualSync);
  const isPostHydration = Boolean(options?.isPostHydration);
  const shouldWarmHltb = Boolean(options?.isBackgroundWarmup || options?.incremental);

  if (isBackgroundWarmup) {
    const entryMediaToken = runtime.getMediaSyncLoopToken();
    const entryWarmupEpoch = runtime.getBackgroundWarmupEpoch();
    await whenStagedCacheHydrated();
    const curState = runtime.getState();
    if (
      runtime.getMediaSyncLoopToken() !== entryMediaToken ||
      runtime.getBackgroundWarmupEpoch() !== entryWarmupEpoch ||
      !onlineLifecycleManager.isOnline() ||
      hasActiveMediaSyncCooldown() ||
      (curState?.type === 'store_media' && curState?.status === 'running') ||
      runtime.hasActiveManualJob()
    ) {
      return;
    }
  }

  // Only manual user-triggered syncs preempt/cancel an existing running job;
  // passive background warmups are serialized via `backgroundWarmupChain`.
  const existingState = runtime.getState();
  const shouldYieldAfterCancel = Boolean(
    !isBackgroundWarmup &&
      existingState &&
      (existingState.status === 'running' ||
        existingState.status === 'paused' ||
        existingState.status === 'rate_limited')
  );
  if (shouldYieldAfterCancel && existingState) {
    runtime.cancelJob(existingState.id);
  } else if (!isBackgroundWarmup) {
    runtime.bumpCriticLoopToken();
    runtime.drainPauseWaiters();
  }

  const myToken = runtime.bumpMediaSyncLoopToken();
  if (shouldYieldAfterCancel) {
    // Brief yield to allow clean loop termination of the preempted run
    await new Promise<void>((r) => setTimeout(r, 10));
    if (runtime.getMediaSyncLoopToken() !== myToken) {
      return;
    }
  }

  const alreadyEnrichedForHydration: CanonicalGame[] = [];
  const evalOptions: StoreMediaSyncEvalOptions = {
    isManualSync,
    isPostHydration,
  };
  const hostPlatform = resolveSyncHostPlatform();
  const maxRepairTier: MediaRepairPriorityTier =
    options?.maxRepairTier ?? (isBackgroundWarmup ? 2 : 3);

  const eligibleEntries: Array<{
    game: CanonicalGame;
    priority: MediaRepairPriorityTier;
    index: number;
  }> = [];
  for (let idx = 0; idx < games.length; idx++) {
    const g = games[idx];
    const evalResult = evaluateGameNeedsStoreMediaSync(g, forceRefresh, evalOptions);
    if (evalResult.alreadyEnriched) {
      alreadyEnrichedForHydration.push(g);
    }
    if (evalResult.eligible) {
      const priority = computeMediaRepairPriority(g, undefined, hostPlatform);
      if (!forceRefresh && priority > maxRepairTier) {
        alreadyEnrichedForHydration.push(g);
        continue;
      }
      eligibleEntries.push({ game: g, priority, index: idx });
    }
  }

  // Sort ascending by urgency tier (Tier 0 -> Tier 1 -> Tier 2 -> Tier 3)
  const sortedEntries = eligibleEntries.toSorted(
    (a, b) => a.priority - b.priority || a.index - b.index
  );
  const effectiveBatchCap =
    typeof options?.maxBatchSize === 'number' && options.maxBatchSize > 0
      ? options.maxBatchSize
      : isBackgroundWarmup && isPostHydration
        ? MAX_PASSIVE_REPAIR_PER_BOOT
        : sortedEntries.length;
  const eligibleGames = sortedEntries.slice(0, effectiveBatchCap).map((entry) => entry.game);

  if (
    alreadyEnrichedForHydration.length > 0 &&
    typeof window !== 'undefined' &&
    window.electronAPI?.offlineVault?.queueHydration
  ) {
    try {
      const hydrationBatch = alreadyEnrichedForHydration.map((g) =>
        buildHydrationGameEntry(g, extractStaticHydrationAssets(g, g.enrichedMetadata))
      );
      void window.electronAPI.offlineVault
        .queueHydration({ games: hydrationBatch })
        ?.catch?.(() => {});
    } catch {}
  }

  if (runtime.getMediaSyncLoopToken() !== myToken) {
    return;
  }

  const jobId = isBackgroundWarmup
    ? `auto-store-media-${Date.now()}-${myToken}`
    : `sync-store-media-${Date.now()}-${myToken}`;
  const handle = runtime.createMediaJobHandle(jobId, myToken);
  const isPreemptedOrStale = (): boolean => handle.isStale();
  const safeUpdateState = (partial: Partial<SyncJobState>): boolean =>
    handle.safeUpdateState(partial);

  runtime.setCancelled(false);
  runtime.drainPauseWaiters();

  if (eligibleGames.length === 0) {
    if (!isBackgroundWarmup) {
      runtime.setState({
        id: jobId,
        type: 'store_media',
        title: 'Sync Official Store Media',
        headline: 'Sync Official Store Media',
        total: 0,
        current: 0,
        status: 'completed',
        startedAt: Date.now(),
      });
      runtime.notify();
    }
    return;
  }

  runtime.setState({
    id: jobId,
    type: 'store_media',
    title: 'Syncing Official Store Media',
    headline: 'Syncing Official Store Media',
    total: eligibleGames.length,
    current: 0,
    currentItemName: eligibleGames[0]?.title,
    status: 'running',
    startedAt: Date.now(),
  });
  runtime.syncHeadlineAndPriorityFields();
  runtime.notify();

  try {
    if (onlineLifecycleManager.isOnline()) {
      const knownBatchAppIds: number[] = [];
      for (const eg of eligibleGames) {
        const effId = steamMatcher.getEffectiveSteamAppId(eg);
        if (effId && effId > 0) {
          knownBatchAppIds.push(effId);
        }
      }
      if (knownBatchAppIds.length > 0) {
        await steamApi
          .fetchStoreBrowseAssetsBatch(knownBatchAppIds, RequestPriority.P2_BACKGROUND)
          .catch(() => new Map());
        if (isPreemptedOrStale()) {
          return;
        }
      }
    }

    const retryCounts = new Map<string, number>();

    for (let i = 0; i < eligibleGames.length; i++) {
      if (isPreemptedOrStale()) {
        return;
      }
      if (runtime.isCancelled() || runtime.getState()?.status === 'cancelled') {
        break;
      }
      if (isBackgroundWarmup && !onlineLifecycleManager.isOnline()) {
        break;
      }

      const game = eligibleGames[i];
      if (
        !safeUpdateState({
          current: i,
          currentItemName: game.title,
        })
      ) {
        return;
      }

      // 1. Pause & Priority Preemption handling
      await runtime.waitWhilePausedOrPreempted(isPreemptedOrStale);
      if (isPreemptedOrStale()) return;
      if (
        isBackgroundWarmup &&
        isUserActivelyScrolling() &&
        !(typeof process !== 'undefined' && process.env.VITEST)
      ) {
        await waitUntilScrollIdle(1500);
        if (isPreemptedOrStale()) return;
      }
      if (runtime.isCancelled() || isPreemptedOrStale()) break;

      // 2. Multi-domain CDN / edge rate-limit cooldown handling
      const activeCooldownSec = requestScheduler.getMaxCooldownRemaining(MEDIA_SYNC_DOMAINS);
      if (activeCooldownSec > 0) {
        if (isBackgroundWarmup) {
          // C1: Abort passive background warmup immediately on any media domain cooldown
          break;
        }
        if (
          !safeUpdateState({
            status: 'rate_limited',
            cooldownSecondsRemaining: activeCooldownSec,
          })
        ) {
          return;
        }

        while (
          requestScheduler.getMaxCooldownRemaining(MEDIA_SYNC_DOMAINS) > 0 &&
          !runtime.isCancelled() &&
          !isPreemptedOrStale()
        ) {
          await new Promise<void>((r) => setTimeout(r, 1000));
          if (isPreemptedOrStale()) return;
          if (runtime.getState()?.status === 'rate_limited') {
            if (
              !safeUpdateState({
                cooldownSecondsRemaining:
                  requestScheduler.getMaxCooldownRemaining(MEDIA_SYNC_DOMAINS),
              })
            ) {
              return;
            }
          }
        }

        if (isPreemptedOrStale()) return;
        if (runtime.isCancelled()) break;

        if (
          !safeUpdateState({
            status: 'running',
            cooldownSecondsRemaining: undefined,
          })
        ) {
          return;
        }
      }

      // 3. Perform fetch (respecting Step 4 MetadataSourceRoute)
      const ov = getUserOverrideForGame(game);
      const route = inferMetadataRouteFromOverride(ov);
      const isNonSteamRouted =
        route?.mode === 'routed' &&
        (route.source === 'gog' ||
          route.source === 'epic' ||
          route.source === 'igdb' ||
          (route.source === 'custom' && String(route.matchedId || '').startsWith('xbox-')));
      let targetAppId =
        route?.source === 'steam' && route.steamAppId
          ? route.steamAppId
          : steamMatcher.getEffectiveSteamAppId(game);
      if (
        !isNonSteamRouted &&
        !targetAppId &&
        !game.isExplicitNonSteam &&
        game.steamAppId !== null &&
        ov?.steamAppId !== null &&
        onlineLifecycleManager.isOnline()
      ) {
        const dynamicallyMatchedId = await steamMatcher.matchGameToSteam(game.title, {
          releaseYear: game.releaseDate,
          developers: game.developers,
          priority: RequestPriority.P2_BACKGROUND,
        });
        if (isPreemptedOrStale()) return;
        if (dynamicallyMatchedId && dynamicallyMatchedId > 0) {
          targetAppId = dynamicallyMatchedId;
        }
      }
      const hasNonSteamPlatform = Boolean(
        game.platforms?.some(
          (p) => p.platformId === 'gog' || p.platformId === 'epic' || p.platformId === 'xbox'
        )
      );

      let gameCompletedWithoutAbort = false;
      if (isNonSteamRouted || targetAppId || hasNonSteamPlatform) {
        try {
          const existingMeta = game.enrichedMetadata;
          const existingHasFetchedAt =
            typeof existingMeta?.fetchedAt === 'number' && existingMeta.fetchedAt > 0;
          const existingHasSysReq = Boolean(
            existingMeta?.systemRequirements?.minimum?.trim() ||
              existingMeta?.systemRequirements?.recommended?.trim()
          );
          const existingHasMacReq = Boolean(
            existingMeta?.macRequirements?.minimum?.trim() ||
              existingMeta?.macRequirements?.recommended?.trim()
          );
          const existingNeedsForceRefresh = Boolean(
            forceRefresh ||
              existingMeta?.__quotaSlimmed === true ||
              (!hasGenuineStoreSynopsis(game, ov, undefined, null) &&
                !isLikelyNonStoreOrTestBranchTitle(game.title)) ||
              (existingMeta &&
                !existingHasFetchedAt &&
                (!existingHasSysReq || (isOwnedNativeMacGame(game) && !existingHasMacReq)))
          );
          const refreshed =
            isNonSteamRouted || !targetAppId
              ? await fallbackMetadataProvider.getEnrichedMetadataForNonSteamGame(game, ov)
              : await steamApi.fetchGameMetadata(targetAppId!, RequestPriority.P2_BACKGROUND, {
                  forceRefresh: existingNeedsForceRefresh,
                });
          if (isPreemptedOrStale()) return;

          const isSkeletonRefreshed = refreshed?.metadataQuality === 'skeleton_fallback';
          const hasRichExisting = Boolean(
            game.enrichedMetadata &&
              game.enrichedMetadata.metadataQuality !== 'skeleton_fallback'
          );
          const willApplyRefreshed = Boolean(
            refreshed && !(isSkeletonRefreshed && (hasRichExisting || isBackgroundWarmup))
          );
          if (
            willApplyRefreshed &&
            refreshed &&
            !isNonSteamRouted &&
            targetAppId &&
            ov &&
            route?.mode === 'routed'
          ) {
            updateRoutedMetadataSnapshot(game.id, {
              title: refreshed.name,
              shortDescription: refreshed.shortDescription,
              detailedDescription: refreshed.detailedDescription || refreshed.aboutTheGame,
              headerImage: refreshed.headerImage,
              developers: refreshed.developers,
              publishers: refreshed.publishers,
              genres: refreshed.genres,
              tags: refreshed.tags,
              releaseDate: refreshed.releaseDate,
            });
          }

          const latestOvAfterFetch = getUserOverrideForGame(game) ?? ov;
          const latestOvUpdatedAtMs = latestOvAfterFetch?.updatedAt
            ? Date.parse(latestOvAfterFetch.updatedAt) || 0
            : 0;
          const attemptNow = Math.max(Date.now(), latestOvUpdatedAtMs);
          const outcome: MediaSyncOutcome =
            !refreshed || isSkeletonRefreshed
              ? onlineLifecycleManager.isOnline()
                ? 'unavailable_404'
                : 'transient_error'
              : (refreshed.screenshots?.length || 0) === 0
                ? 'partial_no_screenshots'
                : (refreshed.movies?.length || 0) === 0
                  ? 'partial_no_trailers'
                  : 'complete';

          if (onlineLifecycleManager.isOnline()) {
            recordMediaSyncAttempt(game.id, outcome, undefined, undefined, attemptNow);
          }

          if (willApplyRefreshed && refreshed) {

            const preservePinnedSynopsis = Boolean(
              ov && (route?.customSynopsisEdited || route?.mode === 'custom')
            );
            const preservePinnedCover = Boolean(ov?.capsuleImage);
            const preservePinnedHeader = Boolean(ov?.headerImage);
            const validRefreshedShort =
              refreshed.shortDescription &&
              !isGenericPlaceholderSynopsis(refreshed.shortDescription, game.title)
                ? refreshed.shortDescription
                : undefined;
            const validRefreshedDevs =
              refreshed.developers?.filter((d) => d && d !== 'Unknown Developer') || [];
            const validRefreshedPubs =
              refreshed.publishers?.filter((p) => p && p !== 'Unknown Publisher') || [];

            const cachedBrowse =
              !isNonSteamRouted && targetAppId
                ? steamApi.peekCachedBrowseAssets(targetAppId)
                : null;
            const effectiveHeaderForCover =
              refreshed.headerImage || cachedBrowse?.headerImage || game.headerImage;
            const rawCandidateCapsule = refreshed.capsuleImage || cachedBrowse?.capsuleImage;
            const validRefreshedCapsule =
              rawCandidateCapsule &&
              !isUnsuitableCoverUrl(rawCandidateCapsule) &&
              !isGogCroppedHorizontalCover(rawCandidateCapsule, effectiveHeaderForCover)
                ? rawCandidateCapsule
                : undefined;

            const gogPlatForRecovery = game.platforms?.find((p) => p.platformId === 'gog');
            const artworkRecoveryCtx = {
              gameId: game.id,
              title: game.title,
              steamAppId: isNonSteamRouted ? game.steamAppId : targetAppId || game.steamAppId,
              gogId: gogPlatForRecovery?.platformGameId ?? null,
              userOverrideCapsule: ov?.capsuleImage ?? null,
              userOverrideHeader: ov?.headerImage ?? null,
              headerUrl: effectiveHeaderForCover,
            };

            const rawMergedEnriched =
              pickBestEnrichedMetadata(game.enrichedMetadata, refreshed) ||
              refreshed ||
              game.enrichedMetadata;
            const mergedEnriched = rawMergedEnriched
              ? {
                  ...rawMergedEnriched,
                  enrichedAt: rawMergedEnriched.enrichedAt || attemptNow,
                  ...(!isSkeletonRefreshed
                    ? {
                        fetchedAt:
                          rawMergedEnriched.fetchedAt || refreshed.fetchedAt || attemptNow,
                      }
                    : {}),
                  lastMediaSyncAttemptAt: attemptNow,
                  mediaSyncOutcome: outcome,
                }
              : rawMergedEnriched;

            const updatedGame: CanonicalGame = {
              ...game,
              steamAppId: isNonSteamRouted ? game.steamAppId : targetAppId || game.steamAppId,
              enrichedMetadata: mergedEnriched,
              headerImage: preservePinnedHeader
                ? ov!.headerImage!
                : pickPreferredHeaderImage(
                    game.headerImage,
                    refreshed.headerImage || cachedBrowse?.headerImage,
                    artworkRecoveryCtx
                  ) ||
                  refreshed.headerImage ||
                  game.headerImage,
              capsuleImage: preservePinnedCover
                ? ov!.capsuleImage!
                : pickPreferredCapsuleImage(
                    game.capsuleImage,
                    validRefreshedCapsule,
                    artworkRecoveryCtx
                  ) ||
                  validRefreshedCapsule ||
                  game.capsuleImage,
              shortDescription: preservePinnedSynopsis
                ? ov!.shortDescription || game.shortDescription
                : validRefreshedShort || game.shortDescription,
              detailedDescription:
                pickPreferredDetailedDescription(
                  game.detailedDescription,
                  refreshed.detailedDescription || refreshed.aboutTheGame
                ) ||
                refreshed.detailedDescription ||
                refreshed.aboutTheGame ||
                game.detailedDescription,
              developers: validRefreshedDevs.length ? validRefreshedDevs : game.developers,
              publishers: validRefreshedPubs.length ? validRefreshedPubs : game.publishers,
              genres: refreshed.genres?.length ? refreshed.genres : game.genres,
              tags: refreshed.tags?.length ? refreshed.tags : game.tags,
              releaseDate:
                pickPreferredReleaseDate(game.releaseDate, refreshed.releaseDate) ||
                game.releaseDate,
              reviewSummary: refreshed.reviewSummary || game.reviewSummary,
            };

            const healedSynopsis = Boolean(
              validRefreshedShort || hasGenuineStoreSynopsis(updatedGame, ov, undefined, null)
            );
            if (healedSynopsis) {
              clearDurableEmptySynopsisProbe(updatedGame.id);
            }

            if (!isSkeletonRefreshed && typeof window !== 'undefined') {
              if (
                (isNonSteamRouted ||
                  !targetAppId ||
                  updatedGame.id !== `steam-${targetAppId}`) &&
                window.electronAPI?.offlineVault?.saveGameDetail
              ) {
                try {
                  const isExplicitNonSteamSave = Boolean(
                    updatedGame.isExplicitNonSteam ||
                      isNonSteamRouted ||
                      latestOvAfterFetch?.isExplicitNonSteam ||
                      latestOvAfterFetch?.steamAppId === null
                  );
                  void window.electronAPI.offlineVault
                    .saveGameDetail({
                      gameId: updatedGame.id,
                      steamAppId: updatedGame.steamAppId ?? null,
                      canonicalTitle: updatedGame.title,
                      platforms: updatedGame.platforms,
                      enrichedMetadata: mergedEnriched || refreshed,
                      metadataQuality:
                        mergedEnriched?.metadataQuality ||
                        refreshed.metadataQuality ||
                        (targetAppId && !isNonSteamRouted ? 'authoritative' : 'scraped'),
                      enrichedAt: mergedEnriched?.enrichedAt || attemptNow,
                      ...(isExplicitNonSteamSave
                        ? { isExplicitNonSteam: true, forceReplaceEnriched: true }
                        : {}),
                    })
                    ?.catch?.(() => {});
                } catch {}
              }

              if (window.electronAPI?.offlineVault?.queueHydration) {
                try {
                  const assets = extractStaticHydrationAssets(updatedGame, refreshed);
                  if (assets.length > 0) {
                    void window.electronAPI.offlineVault
                      .queueHydration({
                        games: [buildHydrationGameEntry(updatedGame, assets)],
                      })
                      ?.catch?.(() => {});
                  }
                } catch {}
              }
            }

            onGameUpdated(updatedGame);
          } else if (onlineLifecycleManager.isOnline() && game.enrichedMetadata) {
            const stampedExistingMeta = {
              ...game.enrichedMetadata,
              enrichedAt: game.enrichedMetadata.enrichedAt || attemptNow,
              lastMediaSyncAttemptAt: attemptNow,
              mediaSyncOutcome: outcome,
            };
            const stampedGame: CanonicalGame = {
              ...game,
              enrichedMetadata: stampedExistingMeta,
            };
            if (
              stampedExistingMeta.metadataQuality !== 'skeleton_fallback' &&
              typeof window !== 'undefined' &&
              window.electronAPI?.offlineVault?.saveGameDetail
            ) {
              try {
                void window.electronAPI.offlineVault
                  .saveGameDetail({
                    gameId: stampedGame.id,
                    steamAppId: stampedGame.steamAppId ?? null,
                    canonicalTitle: stampedGame.title,
                    platforms: stampedGame.platforms,
                    enrichedMetadata: stampedExistingMeta,
                    metadataQuality: stampedExistingMeta.metadataQuality || 'storefront_native',
                    enrichedAt: stampedExistingMeta.enrichedAt,
                  })
                  ?.catch?.(() => {});
              } catch {}
            }
            onGameUpdated(stampedGame);
          }

          gameCompletedWithoutAbort = true;
          if (shouldWarmHltb && onlineLifecycleManager.isOnline() && !isPreemptedOrStale()) {
            try {
              const effectiveHltbAppId = targetAppId || game.steamAppId;
              if (!hasAttemptedHltbLookup(game.title, effectiveHltbAppId)) {
                const liveHltb = await fetchAndCacheHltb(game.title, effectiveHltbAppId).catch(
                  () => null
                );
                if (isPreemptedOrStale()) return;
                if (
                  liveHltb &&
                  typeof window !== 'undefined' &&
                  window.electronAPI?.offlineVault?.saveGameDetail
                ) {
                  void window.electronAPI.offlineVault
                    .saveGameDetail({
                      gameId: game.id,
                      steamAppId: effectiveHltbAppId ?? null,
                      canonicalTitle: game.title,
                      platforms: game.platforms,
                      hltb: { ...liveHltb } as Record<string, unknown>,
                    })
                    ?.catch?.(() => {});
                }
              }
            } catch {}
          }
        } catch (err: unknown) {
          if (isPreemptedOrStale()) return;
          const rateErr = (err && typeof err === 'object' ? err : {}) as MediaSyncRateError;
          const is429 =
            Boolean(rateErr.isRateLimited) ||
            rateErr.status === 429 ||
            rateErr.response?.status === 429;
          if (is429) {
            if (isBackgroundWarmup) {
              // C1: Abort passive background warmup immediately on rate limit
              break;
            }
            const attempt = (retryCounts.get(game.id) ?? 0) + 1;
            retryCounts.set(game.id, attempt);
            if (attempt <= MAX_RATE_LIMIT_RETRIES) {
              const cooldownSec = Math.max(
                requestScheduler.getMaxCooldownRemaining(MEDIA_SYNC_DOMAINS),
                typeof rateErr.cooldownRemaining === 'number' ? rateErr.cooldownRemaining : 0
              );
              const waitMs = Math.max(cooldownSec * 1000, 1000 * Math.pow(2, attempt - 1));
              if (
                !safeUpdateState({
                  status: 'rate_limited',
                  cooldownSecondsRemaining: Math.ceil(waitMs / 1000),
                })
              ) {
                return;
              }
              let remainingMs = waitMs;
              while (remainingMs > 0 && !runtime.isCancelled() && !isPreemptedOrStale()) {
                const sliceMs = Math.min(1000, remainingMs);
                await new Promise<void>((r) => setTimeout(r, sliceMs));
                if (isPreemptedOrStale()) return;
                remainingMs -= sliceMs;
                if (!runtime.isCancelled() && runtime.getState()?.status === 'rate_limited') {
                  const nextSec = Math.max(
                    Math.ceil(Math.max(0, remainingMs) / 1000),
                    requestScheduler.getMaxCooldownRemaining(MEDIA_SYNC_DOMAINS)
                  );
                  if (
                    !safeUpdateState({
                      cooldownSecondsRemaining: nextSec,
                    })
                  ) {
                    return;
                  }
                }
              }
              if (isPreemptedOrStale()) return;
              if (runtime.isCancelled()) break;
              if (
                !safeUpdateState({
                  status: 'running',
                  cooldownSecondsRemaining: undefined,
                })
              ) {
                return;
              }
              i--;
              await yieldToMainThread();
              if (isPreemptedOrStale()) return;
              continue;
            }
            console.warn(
              `[SyncJobManager] Rate-limit retries exhausted (${MAX_RATE_LIMIT_RETRIES}) for ${game.title}; advancing.`
            );
          } else {
            console.warn(
              `[SyncJobManager] Media sync error for ${game.title}:`,
              rateErr.message || err
            );
          }
          if (!runtime.isCancelled() && !isPreemptedOrStale() && onlineLifecycleManager.isOnline()) {
            recordMediaSyncAttempt(game.id, 'transient_error');
            gameCompletedWithoutAbort = true;
          }
        }
      }

      if (isPreemptedOrStale()) {
        return;
      }

      if (gameCompletedWithoutAbort) {
        options?.onGameAttempted?.(game.id);
      }

      if (isBackgroundWarmup && hasActiveMediaSyncCooldown()) {
        // C1: Abort passive background warmup immediately if this request triggered a cooldown
        break;
      }

      if (
        !safeUpdateState({
          current: i + 1,
        })
      ) {
        return;
      }
      await yieldToMainThread();
      if (isPreemptedOrStale()) {
        return;
      }
    }

    if (isPreemptedOrStale()) {
      return;
    }

    if (runtime.isCancelled() || runtime.getState()?.status === 'cancelled') {
      safeUpdateState({
        status: 'cancelled',
        currentItemName: undefined,
      });
    } else {
      safeUpdateState({
        status: 'completed',
        current: eligibleGames.length,
        currentItemName: undefined,
      });
    }
  } finally {
    if (runtime.getState()?.id === jobId) {
      try {
        flushPendingCatalogSave();
        steamApi.trimMemoryCache(30);
        if (typeof window !== 'undefined') {
          window.electronAPI?.trimMemory?.({ passive: true })?.catch?.(() => {});
        }
      } catch {}
    }
  }
}
