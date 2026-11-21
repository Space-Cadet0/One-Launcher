import { useEffect, useRef, useCallback, Dispatch, SetStateAction, MutableRefObject } from 'react';
import { CanonicalGame } from '../contracts/game';
import { launcherService } from '../services/launcher/launcherService';
import { onlineLifecycleManager } from '../services/network/onlineLifecycleManager';
import { mergeUpdatedGamePreservingLivePlatformState } from '../services/integrations/integrationStorage';
import { isUserActivelyScrolling } from '../utils/scrollActivityTracker';

export interface UseBackgroundMediaWarmupParams {
  games: CanonicalGame[];
  gamesRef: MutableRefObject<CanonicalGame[]>;
  isHibernating: boolean;
  runningGamesCount: number;
  isModalSuspended?: boolean;
  isBootHydrating?: boolean;
  setGames: Dispatch<SetStateAction<CanonicalGame[]>>;
  setIsSyncingAllMedia: Dispatch<SetStateAction<boolean>>;
}

interface WarmupWindowFlags extends Window {
  __ENABLE_AUTO_STORE_MEDIA_WARMUP__?: boolean;
  __ENABLE_AUTO_HLTB_WARMUP__?: boolean;
}

function isVitestRuntime(): boolean {
  if (typeof import.meta !== 'undefined' && import.meta.env?.MODE === 'test') {
    return true;
  }
  return typeof process !== 'undefined' && Boolean(process.env?.VITEST);
}

/**
 * Post-first-paint background store-media & offline-vault warmup and SyncJobManager
 * active-media subscription. Dynamically imports `syncJobManager` so scraper/enricher
 * dependencies stay out of the critical cold-startup bundle.
 */
export function useBackgroundMediaWarmup({
  games,
  gamesRef,
  isHibernating,
  runningGamesCount,
  isModalSuspended = false,
  isBootHydrating = false,
  setGames,
  setIsSyncingAllMedia,
}: UseBackgroundMediaWarmupParams): void {
  const autoMediaWarmupRunningRef = useRef<boolean>(false);
  const autoHltbTrickleRunningRef = useRef<boolean>(false);
  const hasQueuedSessionP2CoversRef = useRef<boolean>(false);
  const attemptedWarmupIdsRef = useRef<Set<string>>(new Set());
  const offlineSkippedIdsRef = useRef<Set<string>>(new Set());
  const attemptedHltbIdsRef = useRef<Set<string>>(new Set());
  const offlineSkippedHltbIdsRef = useRef<Set<string>>(new Set());
  const pendingWarmupUpdatesRef = useRef<Map<string, CanonicalGame>>(new Map());
  const batchFlushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isModalSuspendedRef = useRef<boolean>(Boolean(isModalSuspended));
  isModalSuspendedRef.current = Boolean(isModalSuspended);
  const isBootHydratingRef = useRef<boolean>(Boolean(isBootHydrating));
  isBootHydratingRef.current = Boolean(isBootHydrating);
  const modalPausedJobIdRef = useRef<string | null>(null);

  const flushWarmupBatch = useCallback(() => {
    if (batchFlushTimerRef.current !== null) {
      clearTimeout(batchFlushTimerRef.current);
      batchFlushTimerRef.current = null;
    }
    if (isModalSuspendedRef.current) {
      // Defer flushing to App state while an interactive modal (e.g. Match Studio) is open;
      // items stay in pendingWarmupUpdatesRef and flush in a single batch on modal close.
      return;
    }
    if (pendingWarmupUpdatesRef.current.size === 0) return;
    const batch = new Map(pendingWarmupUpdatesRef.current);
    pendingWarmupUpdatesRef.current.clear();

    const prev = gamesRef.current;
    let changed = false;
    const next = prev.map((g) => {
      const updated = batch.get(g.id);
      if (updated) {
        if (
          updated.enrichedMetadata?.metadataQuality === 'skeleton_fallback' &&
          g.enrichedMetadata &&
          g.enrichedMetadata.metadataQuality !== 'skeleton_fallback'
        ) {
          return g;
        }
        changed = true;
        return mergeUpdatedGamePreservingLivePlatformState(g, updated);
      }
      return g;
    });
    if (changed) {
      gamesRef.current = next;
      setGames(next);
    }
  }, [gamesRef, setGames]);

  // Ensure pending timer is cleared on unmount
  useEffect(() => {
    return () => {
      if (batchFlushTimerRef.current !== null) {
        clearTimeout(batchFlushTimerRef.current);
        batchFlushTimerRef.current = null;
      }
    };
  }, []);

  // Subscribe to background sync job state post-first-paint
  useEffect(() => {
    let cancelled = false;
    let unsub: (() => void) | null = null;

    const timer = setTimeout(() => {
      void import('../services/network/syncJobManager')
        .then(({ syncJobManager }) => {
          if (cancelled) return;
          unsub = syncJobManager.subscribe((state) => {
            if (cancelled) return;
            const hasStoreMediaCategory = Boolean(
              state?.activeCategoryKeys?.includes('store_media') ||
                state?.activeCategories?.some((category) => {
                  const normalized = category.trim().toLowerCase();
                  return normalized === 'store_media' || normalized === 'store media';
                })
            );
            const active = Boolean(
              state &&
                (state.type === 'store_media' ||
                  (state.type === 'multi' && hasStoreMediaCategory)) &&
                (state.status === 'running' ||
                  state.status === 'paused' ||
                  state.status === 'rate_limited')
            );
            setIsSyncingAllMedia((prev) => (prev === active ? prev : active));
          });
        })
        .catch(() => {});
    }, 0);

    return () => {
      cancelled = true;
      clearTimeout(timer);
      unsub?.();
    };
  }, [setIsSyncingAllMedia]);

  // Incremental polite store-metadata & offline-vault warmup
  useEffect(() => {
    const isVitestEnv = isVitestRuntime();
    const allowWarmupInTest =
      typeof window !== 'undefined' &&
      Boolean((window as WarmupWindowFlags).__ENABLE_AUTO_STORE_MEDIA_WARMUP__);
    const allowHltbTrickleInTest =
      typeof window !== 'undefined' &&
      Boolean((window as WarmupWindowFlags).__ENABLE_AUTO_HLTB_WARMUP__);
    const canRunHltbTrickle =
      (!isVitestEnv || allowHltbTrickleInTest) &&
      typeof window !== 'undefined' &&
      Boolean(window.electronAPI?.searchHltb);
    if (isVitestEnv && !allowWarmupInTest && !allowHltbTrickleInTest) return;

    const isSessionSuspended = isHibernating || runningGamesCount > 0;

    let cancelled = false;

    if (isModalSuspended) {
      if (batchFlushTimerRef.current !== null) {
        clearTimeout(batchFlushTimerRef.current);
        batchFlushTimerRef.current = null;
      }
      if (autoMediaWarmupRunningRef.current) {
        void import('../services/network/syncJobManager')
          .then(({ syncJobManager }) => {
            if (cancelled || !isModalSuspendedRef.current) return;
            const st = syncJobManager.getState();
            if (st && st.type === 'store_media' && st.status === 'running') {
              modalPausedJobIdRef.current = st.id;
              syncJobManager.pauseJob(st.id);
            }
          })
          .catch(() => {});
      }
      return () => {
        cancelled = true;
      };
    }

    if (modalPausedJobIdRef.current && !isSessionSuspended) {
      const pausedId = modalPausedJobIdRef.current;
      modalPausedJobIdRef.current = null;
      void import('../services/network/syncJobManager')
        .then(({ syncJobManager }) => {
          if (cancelled || isModalSuspendedRef.current) return;
          const st = syncJobManager.getState();
          if (st && st.id === pausedId && st.status === 'paused') {
            syncJobManager.resumeJob(pausedId);
          }
        })
        .catch(() => {});
    }

    if (!isSessionSuspended && pendingWarmupUpdatesRef.current.size > 0) {
      flushWarmupBatch();
    }

    if (isBootHydrating || isSessionSuspended || games.length === 0) {
      return () => {
        cancelled = true;
      };
    }

    let warmupTimer: ReturnType<typeof setTimeout> | null = null;
    let hltbTrickleTimer: ReturnType<typeof setTimeout> | null = null;

    const scheduleHltbTrickle = (delayMs = 900) => {
      if (hltbTrickleTimer !== null) {
        clearTimeout(hltbTrickleTimer);
        hltbTrickleTimer = null;
      }
      if (!canRunHltbTrickle || cancelled) return;
      if (isBootHydratingRef.current || isModalSuspendedRef.current) return;
      if (!onlineLifecycleManager.isOnline()) return;

      hltbTrickleTimer = setTimeout(() => {
        hltbTrickleTimer = null;
        if (!canRunHltbTrickle || cancelled) return;
        if (isBootHydratingRef.current || isModalSuspendedRef.current) return;
        if (!onlineLifecycleManager.isOnline()) return;
        if (launcherService.getRunningGames().length > 0) return;
        if (launcherService.isInGameHibernating()) return;
        if (autoHltbTrickleRunningRef.current) return;
        if (isUserActivelyScrolling()) {
          scheduleHltbTrickle(1200);
          return;
        }

        void Promise.all([
          import('../services/network/syncJobManager'),
          import('../services/hltb/howLongToBeat'),
        ])
          .then(
            ([
              { syncJobManager },
              { hasAttemptedHltbLookup, fetchAndCacheHltb, seedHltbFromVaultIfMissing },
            ]) => {
              if (!canRunHltbTrickle || cancelled) return;
              if (isBootHydratingRef.current || isModalSuspendedRef.current) return;
              if (!onlineLifecycleManager.isOnline()) return;
              if (launcherService.getRunningGames().length > 0) return;
              if (launcherService.isInGameHibernating()) return;
              if (autoHltbTrickleRunningRef.current) return;
              if (isUserActivelyScrolling()) {
                scheduleHltbTrickle(1200);
                return;
              }

              const activeJob = syncJobManager.getState();
              const hasActiveManualJob = Boolean(
                activeJob &&
                  !activeJob.id.startsWith('auto-') &&
                  (activeJob.status === 'running' ||
                    activeJob.status === 'paused' ||
                    activeJob.status === 'rate_limited')
              );
              if (hasActiveManualJob || autoMediaWarmupRunningRef.current) {
                scheduleHltbTrickle(2500);
                return;
              }

              const nextGame = gamesRef.current.find((g) => {
                if (!g?.id || !g?.title) return false;
                if (attemptedHltbIdsRef.current.has(g.id)) return false;
                return !hasAttemptedHltbLookup(g.title, g.steamAppId);
              });

              if (!nextGame) return;

              attemptedHltbIdsRef.current.add(nextGame.id);
              autoHltbTrickleRunningRef.current = true;

              void (async () => {
                try {
                  if (
                    typeof window !== 'undefined' &&
                    window.electronAPI?.offlineVault?.getGameDetail
                  ) {
                    const vaultDetail = await window.electronAPI.offlineVault
                      .getGameDetail(nextGame.id)
                      .catch(() => null);
                    if (vaultDetail?.hltb) {
                      const seeded = seedHltbFromVaultIfMissing(
                        nextGame.title,
                        nextGame.steamAppId,
                        vaultDetail.hltb
                      );
                      if (seeded) return;
                    }
                  }

                  const liveHltb = await fetchAndCacheHltb(nextGame.title, nextGame.steamAppId);
                  if (liveHltb && typeof window !== 'undefined') {
                    window.electronAPI?.offlineVault
                      ?.saveGameDetail?.({
                        gameId: nextGame.id,
                        steamAppId: nextGame.steamAppId ?? null,
                        canonicalTitle: nextGame.title,
                        hltb: { ...liveHltb },
                      })
                      ?.catch?.(() => {});
                  }
                } catch {
                  // Ignore background HLTB trickle error
                } finally {
                  autoHltbTrickleRunningRef.current = false;
                  if (!onlineLifecycleManager.isOnline()) {
                    offlineSkippedHltbIdsRef.current.add(nextGame.id);
                    return;
                  }
                  if (!cancelled) {
                    scheduleHltbTrickle(isVitestEnv ? 30 : 900);
                  }
                }
              })();
            }
          )
          .catch(() => {});
      }, delayMs);
    };

    const scheduleMediaWarmup = (delayMs = 6000) => {
      if (warmupTimer !== null) {
        clearTimeout(warmupTimer);
        warmupTimer = null;
      }
      if (cancelled) return;
      if (isVitestEnv && !allowWarmupInTest) return;
      if (isBootHydratingRef.current || isModalSuspendedRef.current) return;
      if (!onlineLifecycleManager.isOnline()) return;

      warmupTimer = setTimeout(() => {
        warmupTimer = null;
        if (cancelled) return;
        if (isBootHydratingRef.current || isModalSuspendedRef.current) return;
        if (!onlineLifecycleManager.isOnline()) return;
        if (launcherService.getRunningGames().length > 0) return;
        if (launcherService.isInGameHibernating()) return;
        if (autoMediaWarmupRunningRef.current) return;

        void Promise.all([
          import('../services/network/syncJobManager'),
          import('../services/storage/stagedCacheService'),
        ])
          .then(
            async ([
              {
                syncJobManager,
                evaluateGameNeedsStoreMediaSync,
                computeMediaRepairPriority,
                buildP2CoverHydrationBatch,
                hasActiveMediaSyncCooldown,
                MAX_PASSIVE_REPAIR_PER_BOOT,
              },
              { isStagedVaultHydrationComplete, whenStagedCacheHydrated },
            ]) => {
              if (!isStagedVaultHydrationComplete()) {
                await whenStagedCacheHydrated();
              }
              if (cancelled) return;
              if (isBootHydratingRef.current || isModalSuspendedRef.current) return;
              if (!onlineLifecycleManager.isOnline()) return;
              if (launcherService.getRunningGames().length > 0) return;
              if (launcherService.isInGameHibernating()) return;
              if (autoMediaWarmupRunningRef.current) return;

              const queueSessionP2CoversOnce = () => {
                if (hasQueuedSessionP2CoversRef.current) return;
                if (!onlineLifecycleManager.isOnline()) return;
                if (
                  typeof window === 'undefined' ||
                  !window.electronAPI?.offlineVault?.queueHydration
                ) {
                  return;
                }
                const currentCatalog = gamesRef.current;
                if (!currentCatalog || currentCatalog.length === 0) return;
                const p2Batch = buildP2CoverHydrationBatch(currentCatalog);
                if (p2Batch.length === 0) return;
                hasQueuedSessionP2CoversRef.current = true;
                try {
                  void window.electronAPI.offlineVault
                    .queueHydration({ games: p2Batch })
                    ?.catch?.(() => {});
                } catch {
                  // Ignore vault IPC errors
                }
              };

              if (hasActiveMediaSyncCooldown()) {
                // C1: Abort passive warmup immediately when any media domain is in cooldown
                queueSessionP2CoversOnce();
                return;
              }

              const activeJob = syncJobManager.getState();
              const hasActiveManualJob = Boolean(
                activeJob &&
                  !activeJob.id.startsWith('auto-') &&
                  (activeJob.status === 'running' ||
                    activeJob.status === 'paused' ||
                    activeJob.status === 'rate_limited')
              );
              if (hasActiveManualJob) {
                scheduleMediaWarmup(4000);
                return;
              }

              const eligibleWithPriority: Array<{
                game: CanonicalGame;
                priority: 0 | 1 | 2 | 3;
                index: number;
              }> = [];
              const catalogSnapshot = gamesRef.current;
              for (let idx = 0; idx < catalogSnapshot.length; idx++) {
                const g = catalogSnapshot[idx];
                if (attemptedWarmupIdsRef.current.has(g.id)) continue;
                if (!evaluateGameNeedsStoreMediaSync(g, false, { isPostHydration: true }).eligible) {
                  continue;
                }
                const priority = computeMediaRepairPriority(g);
                // C1: Restrict passive startup warmup strictly to Tiers 0–2
                // (Tier 3 non-active-host backfill heals on detail open or manual sync).
                if (priority > 2) continue;
                eligibleWithPriority.push({ game: g, priority, index: idx });
              }

              eligibleWithPriority.sort((a, b) => a.priority - b.priority || a.index - b.index);
              const gamesNeedingWarmup = eligibleWithPriority
                .slice(0, MAX_PASSIVE_REPAIR_PER_BOOT)
                .map((entry) => entry.game);

              if (gamesNeedingWarmup.length === 0) {
                queueSessionP2CoversOnce();
                scheduleHltbTrickle(900);
                return;
              }

              // C1: Mark each game in attemptedWarmupIdsRef ONLY after per-game completion so
              // an interruption (cooldown, offline, game launch) never permanently skips the rest.
              const completedInRunIds = new Set<string>();
              const onWarmupGameUpdated = (updatedGame: CanonicalGame) => {
                completedInRunIds.add(updatedGame.id);
                attemptedWarmupIdsRef.current.add(updatedGame.id);
                if (updatedGame.enrichedMetadata?.metadataQuality === 'skeleton_fallback') {
                  return;
                }
                pendingWarmupUpdatesRef.current.set(updatedGame.id, updatedGame);
                if (isModalSuspendedRef.current) {
                  return;
                }
                if (isVitestEnv) {
                  flushWarmupBatch();
                } else if (batchFlushTimerRef.current === null) {
                  batchFlushTimerRef.current = setTimeout(flushWarmupBatch, 500);
                }
              };

              autoMediaWarmupRunningRef.current = true;
              Promise.resolve(
                syncJobManager.startStoreMediaSync(gamesNeedingWarmup, onWarmupGameUpdated, {
                  incremental: true,
                  isBackgroundWarmup: true,
                  isPostHydration: true,
                  maxRepairTier: 2,
                  maxBatchSize: MAX_PASSIVE_REPAIR_PER_BOOT,
                  onGameAttempted: (gameId) => {
                    completedInRunIds.add(gameId);
                    attemptedWarmupIdsRef.current.add(gameId);
                  },
                })
              )
                .catch(() => {})
                .finally(() => {
                  autoMediaWarmupRunningRef.current = false;
                  if (!onlineLifecycleManager.isOnline()) {
                    for (const g of gamesNeedingWarmup) {
                      if (!completedInRunIds.has(g.id)) {
                        offlineSkippedIdsRef.current.add(g.id);
                      }
                    }
                  }
                  if (!cancelled && !isModalSuspendedRef.current) {
                    flushWarmupBatch();
                    queueSessionP2CoversOnce();
                    scheduleHltbTrickle(900);
                  }
                });
            }
          )
          .catch(() => {});
      }, delayMs);
    };

    scheduleMediaWarmup(isVitestEnv ? 120 : 6000);
    if (canRunHltbTrickle) {
      scheduleHltbTrickle(isVitestEnv ? 60 : 6500);
    }

    let unsubscribeOnline: (() => void) | null = null;
    try {
      unsubscribeOnline = onlineLifecycleManager.onOnline(() => {
        if (cancelled) return;
        if (offlineSkippedIdsRef.current.size > 0) {
          for (const id of offlineSkippedIdsRef.current) {
            attemptedWarmupIdsRef.current.delete(id);
          }
          offlineSkippedIdsRef.current.clear();
        }
        if (offlineSkippedHltbIdsRef.current.size > 0) {
          for (const id of offlineSkippedHltbIdsRef.current) {
            attemptedHltbIdsRef.current.delete(id);
          }
          offlineSkippedHltbIdsRef.current.clear();
        }
        if (!isBootHydratingRef.current && !isModalSuspendedRef.current) {
          scheduleMediaWarmup(isVitestEnv ? 120 : 2500);
          if (canRunHltbTrickle) {
            scheduleHltbTrickle(isVitestEnv ? 60 : 3000);
          }
        }
      });
    } catch {}

    return () => {
      cancelled = true;
      if (warmupTimer !== null) {
        clearTimeout(warmupTimer);
      }
      if (hltbTrickleTimer !== null) {
        clearTimeout(hltbTrickleTimer);
      }
      unsubscribeOnline?.();
    };
  }, [
    games.length,
    isHibernating,
    runningGamesCount,
    isModalSuspended,
    isBootHydrating,
    gamesRef,
    setGames,
    flushWarmupBatch,
  ]);
}
