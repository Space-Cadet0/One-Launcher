import { useEffect, useRef, useCallback, Dispatch, SetStateAction, MutableRefObject } from 'react';
import { CanonicalGame } from '../contracts/game';
import { launcherService } from '../services/launcher/launcherService';
import { onlineLifecycleManager } from '../services/network/onlineLifecycleManager';
import { mergeUpdatedGamePreservingLivePlatformState } from '../services/integrations/integrationStorage';

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
  const attemptedWarmupIdsRef = useRef<Set<string>>(new Set());
  const offlineSkippedIdsRef = useRef<Set<string>>(new Set());
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
            const active = Boolean(
              state &&
                (state.type === 'store_media' ||
                  (state.type === 'multi' && state.activeCategories?.includes('store_media'))) &&
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
    if (isVitestEnv && !allowWarmupInTest) return;

    const isSessionSuspended = isHibernating || runningGamesCount > 0;

    if (isModalSuspended) {
      if (batchFlushTimerRef.current !== null) {
        clearTimeout(batchFlushTimerRef.current);
        batchFlushTimerRef.current = null;
      }
      if (autoMediaWarmupRunningRef.current) {
        void import('../services/network/syncJobManager')
          .then(({ syncJobManager }) => {
            if (!isModalSuspendedRef.current) return;
            const st = syncJobManager.getState();
            if (st && st.type === 'store_media' && st.status === 'running') {
              modalPausedJobIdRef.current = st.id;
              syncJobManager.pauseJob(st.id);
            }
          })
          .catch(() => {});
      }
      return;
    }

    if (modalPausedJobIdRef.current && !isSessionSuspended) {
      const pausedId = modalPausedJobIdRef.current;
      modalPausedJobIdRef.current = null;
      void import('../services/network/syncJobManager')
        .then(({ syncJobManager }) => {
          if (isModalSuspendedRef.current) return;
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

    if (isBootHydrating) return;

    if (isSessionSuspended || games.length === 0) return;

    let warmupTimer: ReturnType<typeof setTimeout> | null = null;

    const scheduleMediaWarmup = (delayMs = 6000) => {
      if (warmupTimer !== null) {
        clearTimeout(warmupTimer);
        warmupTimer = null;
      }
      if (isBootHydratingRef.current || isModalSuspendedRef.current) return;
      if (!onlineLifecycleManager.isOnline()) return;

      warmupTimer = setTimeout(() => {
        warmupTimer = null;
        if (isBootHydratingRef.current || isModalSuspendedRef.current) return;
        if (!onlineLifecycleManager.isOnline()) return;
        if (launcherService.getRunningGames().length > 0) return;
        if (launcherService.isInGameHibernating()) return;
        if (autoMediaWarmupRunningRef.current) return;

        void import('../services/network/syncJobManager')
          .then(({ syncJobManager, evaluateGameNeedsStoreMediaSync }) => {
            if (isBootHydratingRef.current || isModalSuspendedRef.current) return;
            if (!onlineLifecycleManager.isOnline()) return;
            if (launcherService.getRunningGames().length > 0) return;
            if (launcherService.isInGameHibernating()) return;
            if (autoMediaWarmupRunningRef.current) return;

            const activeJob = syncJobManager.getState();
            if (
              activeJob &&
              (activeJob.status === 'running' ||
                activeJob.status === 'paused' ||
                activeJob.status === 'rate_limited')
            ) {
              scheduleMediaWarmup(4000);
              return;
            }

            const gamesNeedingWarmup = gamesRef.current.filter((g) => {
              if (attemptedWarmupIdsRef.current.has(g.id)) return false;
              return evaluateGameNeedsStoreMediaSync(g, false).eligible;
            });

            if (gamesNeedingWarmup.length === 0) return;

            for (const g of gamesNeedingWarmup) {
              attemptedWarmupIdsRef.current.add(g.id);
            }

            const completedInRunIds = new Set<string>();
            const onWarmupGameUpdated = (updatedGame: CanonicalGame) => {
              completedInRunIds.add(updatedGame.id);
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
                if (!isModalSuspendedRef.current) {
                  flushWarmupBatch();
                }
              });
          })
          .catch(() => {});
      }, delayMs);
    };

    scheduleMediaWarmup(isVitestEnv ? 120 : 6000);

    let unsubscribeOnline: (() => void) | null = null;
    try {
      unsubscribeOnline = onlineLifecycleManager.onOnline(() => {
        if (offlineSkippedIdsRef.current.size > 0) {
          for (const id of offlineSkippedIdsRef.current) {
            attemptedWarmupIdsRef.current.delete(id);
          }
          offlineSkippedIdsRef.current.clear();
        }
        if (!isBootHydratingRef.current && !isModalSuspendedRef.current) {
          scheduleMediaWarmup(isVitestEnv ? 120 : 2500);
        }
      });
    } catch {}

    return () => {
      if (warmupTimer !== null) {
        clearTimeout(warmupTimer);
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
