import { useEffect, useRef } from 'react';
import { CanonicalGame } from '../contracts/game';
import { launcherService } from '../services/launcher/launcherService';
import { onlineLifecycleManager } from '../services/network/onlineLifecycleManager';

function isVitestRuntime(): boolean {
  if (typeof import.meta !== 'undefined' && import.meta.env?.MODE === 'test') {
    return true;
  }
  return typeof process !== 'undefined' && Boolean(process.env?.VITEST);
}

/**
 * Proactive background critic score warm-up and automatic hydration hook.
 * Dynamically imports SyncJobManager post-first-paint so scraper/enricher bundles
 * never bloat cold startup, while surfacing progress in GlobalSyncProgressBar and
 * automatically pausing/resuming during interactive modals, on-demand actions, or active game sessions.
 */
export function useCriticScoreWarmup(games: CanonicalGame[], isSuspended = false) {
  const isSuspendedRef = useRef<boolean>(isSuspended);
  isSuspendedRef.current = isSuspended;
  const warmupActiveRef = useRef<boolean>(false);
  const suspendedPausedJobIdRef = useRef<string | null>(null);

  useEffect(() => {
    if (isSuspended) {
      if (warmupActiveRef.current) {
        void import('../services/network/syncJobManager')
          .then(({ syncJobManager }) => {
            if (!isSuspendedRef.current) return;
            const st = syncJobManager.getState();
            if (st && st.type === 'critic_scores' && st.status === 'running') {
              suspendedPausedJobIdRef.current = st.id;
              syncJobManager.pauseJob(st.id);
            }
          })
          .catch(() => {});
      }
      return;
    }

    if (suspendedPausedJobIdRef.current) {
      const pausedId = suspendedPausedJobIdRef.current;
      suspendedPausedJobIdRef.current = null;
      void import('../services/network/syncJobManager')
        .then(({ syncJobManager }) => {
          if (isSuspendedRef.current) return;
          const st = syncJobManager.getState();
          if (st && st.id === pausedId && st.status === 'paused') {
            syncJobManager.resumeJob(pausedId);
          }
        })
        .catch(() => {});
    }

    if (!games || games.length === 0) return;

    const initialDelayMs = isVitestRuntime() ? 350 : 2500;

    let timer: ReturnType<typeof setTimeout> | null = null;

    const scheduleWarmup = () => {
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      if (isSuspendedRef.current) return;
      if (!onlineLifecycleManager.isOnline()) return;

      timer = setTimeout(() => {
        timer = null;
        if (isSuspendedRef.current) return;
        if (!onlineLifecycleManager.isOnline()) return;
        if (launcherService.getRunningGames().length > 0) return;
        void import('../services/network/syncJobManager')
          .then(({ syncJobManager }) => {
            if (isSuspendedRef.current) return;
            warmupActiveRef.current = true;
            return Promise.resolve(
              syncJobManager.startCriticScoreSync(games, { isBackgroundWarmup: true })
            ).finally(() => {
              warmupActiveRef.current = false;
            });
          })
          .catch(() => {
            warmupActiveRef.current = false;
          });
      }, initialDelayMs);
    };

    scheduleWarmup();

    let unsubscribeOnline: (() => void) | null = null;
    try {
      unsubscribeOnline = onlineLifecycleManager.onOnline(() => {
        if (!isSuspendedRef.current) {
          scheduleWarmup();
        }
      });
    } catch {}

    return () => {
      if (timer !== null) {
        clearTimeout(timer);
      }
      unsubscribeOnline?.();
    };
  }, [games.length, isSuspended]);
}
