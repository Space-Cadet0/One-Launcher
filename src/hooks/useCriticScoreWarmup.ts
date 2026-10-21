import { useEffect } from 'react';
import { CanonicalGame } from '../contracts/game';
import { syncJobManager } from '../services/network/syncJobManager';

/**
 * Proactive background critic score warm-up and automatic hydration hook.
 * Delegates to SyncJobManager so progress is surfaced in GlobalSyncProgressBar,
 * persists across page navigation, and automatically pauses/resumes during on-demand actions.
 */
export function useCriticScoreWarmup(games: CanonicalGame[]) {
  useEffect(() => {
    if (!games || games.length === 0) return;

    const initialDelayMs =
      typeof process !== 'undefined' && Boolean((process as any).env?.VITEST) ? 350 : 2500;

    const timer = setTimeout(() => {
      syncJobManager.startCriticScoreSync(games, { isBackgroundWarmup: true }).catch(() => {});
    }, initialDelayMs);

    return () => {
      clearTimeout(timer);
    };
  }, [games.length]);
}
