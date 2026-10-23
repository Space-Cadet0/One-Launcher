import { useState, useEffect, useCallback, useRef } from 'react';
import { ActiveGameSession } from '../contracts/launcher';
import { launcherService } from '../services/launcher/launcherService';

export interface UseLauncherHibernationStateResult {
  isHibernating: boolean;
  runningGames: ActiveGameSession[];
  resumeFullUi: () => void;
}

function computeRunningGamesSignature(sessions: ActiveGameSession[]): string {
  if (!sessions || sessions.length === 0) return '';
  return sessions
    .map(
      (s) =>
        `${s.sessionId || ''}:${s.gameId}:${s.platformId || ''}:${s.status || ''}:${s.pid || ''}`
    )
    .sort()
    .join('|');
}

/**
 * Tracks in-game UI hibernation state and active running game sessions
 * with strict referential stability so unrelated launcher notifications
 * (download progress ticks, config saves, scans) never re-render <App />.
 */
export function useLauncherHibernationState(): UseLauncherHibernationStateResult {
  const [isHibernating, setIsHibernating] = useState<boolean>(() =>
    launcherService.isInGameHibernating()
  );
  const [runningGames, setRunningGames] = useState<ActiveGameSession[]>(() =>
    launcherService.getRunningGames()
  );
  const runningSigRef = useRef<string>(computeRunningGamesSignature(runningGames));

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.addEventListener !== 'function') return;

    const syncHibernateState = () => {
      const nextHib = launcherService.isInGameHibernating();
      setIsHibernating((prev) => (prev === nextHib ? prev : nextHib));

      const nextRunning = launcherService.getRunningGames();
      const nextSig = computeRunningGamesSignature(nextRunning);
      if (nextSig !== runningSigRef.current) {
        runningSigRef.current = nextSig;
        setRunningGames(nextRunning);
      }
    };

    window.addEventListener('antigravity:launcher-state-changed', syncHibernateState);
    window.addEventListener('antigravity:hibernate-state-changed', syncHibernateState);
    return () => {
      window.removeEventListener('antigravity:launcher-state-changed', syncHibernateState);
      window.removeEventListener('antigravity:hibernate-state-changed', syncHibernateState);
    };
  }, []);

  const resumeFullUi = useCallback(() => {
    launcherService.setInGameHibernating(false);
  }, []);

  return {
    isHibernating,
    runningGames,
    resumeFullUi,
  };
}
