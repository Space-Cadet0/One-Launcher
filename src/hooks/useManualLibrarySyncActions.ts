import {
  useState,
  useMemo,
  useCallback,
  useRef,
  useEffect,
  Dispatch,
  SetStateAction,
  MutableRefObject,
} from 'react';
import type { CanonicalGame } from '../contracts/game';
import { mergeUpdatedGamePreservingLivePlatformState } from '../services/integrations/integrationStorage';
import { steamMatcher } from '../services/steam/steamMatcher';
import type { SyncNoticeTone } from './useSyncNotice';
import { getSyncErrorMessage, isVitestRuntime } from './syncActions/syncActionHelpers';
import { runStorefrontLibrarySync } from './syncActions/storefrontSyncRunner';
import { runStorefrontTrophySync } from './syncActions/trophySyncRunner';
import { runSingleGameSync } from './syncActions/singleGameSyncRunner';

export interface UseManualLibrarySyncActionsParams {
  games?: CanonicalGame[];
  gamesRef: MutableRefObject<CanonicalGame[]>;
  selectedGame: CanonicalGame | null;
  isGridView: boolean;
  isSyncingAllMedia: boolean;
  setIsSyncingAllMedia: Dispatch<SetStateAction<boolean>>;
  setGames: Dispatch<SetStateAction<CanonicalGame[]>>;
  setGameRefreshKey: Dispatch<SetStateAction<number>>;
  overlayLauncherInstalledState: (catalog: CanonicalGame[]) => CanonicalGame[];
  onCatalogPersisted?: (catalog: CanonicalGame[]) => void;
  showSyncNotice: (
    message: string | null,
    durationMs?: number | null,
    tone?: SyncNoticeTone
  ) => void;
}

/**
 * Encapsulates manual user-triggered sync actions (Storefront Libraries, Trophies,
 * Single-Game Store Metadata, Bulk Store Media, and Critic Scores) using dynamic `import()`
 * for heavy scraper/achievement modules, ref-backed re-entrancy locks, and referentially
 * stable callbacks.
 */
export function useManualLibrarySyncActions({
  gamesRef,
  selectedGame,
  isGridView,
  isSyncingAllMedia,
  setIsSyncingAllMedia,
  setGames,
  setGameRefreshKey,
  overlayLauncherInstalledState,
  onCatalogPersisted,
  showSyncNotice,
}: UseManualLibrarySyncActionsParams) {
  const [isSyncing, setIsSyncing] = useState(false);
  const [isSyncingCurrentGame, setIsSyncingCurrentGame] = useState(false);
  const [isSyncingScores, setIsSyncingScores] = useState(false);
  const [isSyncingTrophies, setIsSyncingTrophies] = useState(false);

  const isMountedRef = useRef<boolean>(true);
  const syncInFlightRef = useRef<boolean>(false);
  const trophySyncInFlightRef = useRef<boolean>(false);
  const currentGameSyncInFlightRef = useRef<boolean>(false);
  const mediaSyncInFlightRef = useRef<boolean>(false);
  const scoresSyncInFlightRef = useRef<boolean>(false);
  const mediaFlushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
      if (mediaFlushTimerRef.current !== null) {
        clearTimeout(mediaFlushTimerRef.current);
        mediaFlushTimerRef.current = null;
      }
    };
  }, []);

  const canSyncCurrentGame = useMemo(
    () => Boolean(!isGridView && selectedGame),
    [isGridView, selectedGame]
  );

  const handleTriggerSync = useCallback(async () => {
    if (syncInFlightRef.current) return;
    syncInFlightRef.current = true;
    setIsSyncing(true);
    showSyncNotice('Syncing all connected storefront accounts & detecting new purchases...');

    try {
      await runStorefrontLibrarySync({
        gamesRef,
        setGames,
        setGameRefreshKey,
        overlayLauncherInstalledState,
        onCatalogPersisted,
        showSyncNotice,
        isMountedRef,
      });
    } catch (err: unknown) {
      if (isMountedRef.current) {
        showSyncNotice(
          `Sync notice: ${getSyncErrorMessage(err, 'Using cached verified catalog')}`,
          5000
        );
      }
    } finally {
      syncInFlightRef.current = false;
      if (isMountedRef.current) {
        setIsSyncing(false);
      }
      if (typeof window !== 'undefined') {
        window.electronAPI?.trimMemory?.({ passive: true })?.catch?.(() => {});
      }
    }
  }, [
    gamesRef,
    onCatalogPersisted,
    overlayLauncherInstalledState,
    setGameRefreshKey,
    setGames,
    showSyncNotice,
  ]);

  const handleSyncTrophies = useCallback(async () => {
    if (isSyncingTrophies || trophySyncInFlightRef.current) return;
    trophySyncInFlightRef.current = true;
    setIsSyncingTrophies(true);
    showSyncNotice(
      'Syncing trophies & achievements across Steam, GOG.com, Epic Games Store, and Xbox...'
    );

    try {
      await runStorefrontTrophySync({
        gamesRef,
        setGames,
        setGameRefreshKey,
        onCatalogPersisted,
        showSyncNotice,
        isMountedRef,
      });
    } catch (err: unknown) {
      if (isMountedRef.current) {
        showSyncNotice(
          `Trophy sync notice: ${getSyncErrorMessage(err, 'Finished syncing trophies')}`,
          5000
        );
      }
    } finally {
      trophySyncInFlightRef.current = false;
      if (isMountedRef.current) {
        setIsSyncingTrophies(false);
      }
      if (typeof window !== 'undefined') {
        window.electronAPI?.trimMemory?.({ passive: true })?.catch?.(() => {});
      }
    }
  }, [
    gamesRef,
    isSyncingTrophies,
    onCatalogPersisted,
    setGameRefreshKey,
    setGames,
    showSyncNotice,
  ]);

  const handleSyncCurrentGame = useCallback(
    async (gameToSync?: CanonicalGame) => {
      const target = gameToSync || selectedGame;
      if (!target || isSyncingCurrentGame || currentGameSyncInFlightRef.current) return;
      const targetAppId = steamMatcher.getEffectiveSteamAppId(target);

      currentGameSyncInFlightRef.current = true;
      setIsSyncingCurrentGame(true);
      showSyncNotice(
        targetAppId
          ? `Syncing ${target.title} from Steam...`
          : `Syncing ${target.title} store metadata...`
      );

      try {
        await runSingleGameSync({
          target,
          gamesRef,
          setGames,
          setGameRefreshKey,
          onCatalogPersisted,
          showSyncNotice,
          isMountedRef,
        });
      } catch (err: unknown) {
        if (isMountedRef.current) {
          showSyncNotice(`Sync notice: ${getSyncErrorMessage(err, 'Error syncing game')}`, 5000);
        }
      } finally {
        currentGameSyncInFlightRef.current = false;
        if (isMountedRef.current) {
          setIsSyncingCurrentGame(false);
        }
      }
    },
    [
      gamesRef,
      isSyncingCurrentGame,
      onCatalogPersisted,
      selectedGame,
      setGameRefreshKey,
      setGames,
      showSyncNotice,
    ]
  );

  const handleSyncStoreMedia = useCallback(async () => {
    if (isSyncingAllMedia || mediaSyncInFlightRef.current) return;
    mediaSyncInFlightRef.current = true;
    setIsSyncingAllMedia(true);
    showSyncNotice('Starting store media sync (trailers, screenshots & descriptions)...', 3000);

    const pendingMediaUpdates = new Map<string, CanonicalGame>();
    const isVitest = isVitestRuntime();

    const clearPendingMediaFlushTimer = () => {
      if (mediaFlushTimerRef.current !== null) {
        clearTimeout(mediaFlushTimerRef.current);
        mediaFlushTimerRef.current = null;
      }
    };

    const flushMediaBatch = () => {
      mediaFlushTimerRef.current = null;
      if (!isMountedRef.current) {
        pendingMediaUpdates.clear();
        return;
      }
      if (pendingMediaUpdates.size === 0) return;
      const batch = new Map(pendingMediaUpdates);
      pendingMediaUpdates.clear();

      const applyBatch = (catalog: CanonicalGame[]): { next: CanonicalGame[]; changed: boolean } => {
        let changed = false;
        const next = catalog.map((g) => {
          const updated = batch.get(g.id);
          if (updated) {
            changed = true;
            return mergeUpdatedGamePreservingLivePlatformState(g, updated);
          }
          return g;
        });
        return { next: changed ? next : catalog, changed };
      };

      const prevSnapshot = gamesRef.current;
      const computed = applyBatch(prevSnapshot);
      if (computed.changed) {
        gamesRef.current = computed.next;
        setGames((latest) => {
          if (latest === prevSnapshot) {
            gamesRef.current = computed.next;
            return computed.next;
          }
          const recomputed = applyBatch(latest);
          if (!recomputed.changed) return latest;
          gamesRef.current = recomputed.next;
          return recomputed.next;
        });
      }
    };

    const updatedGameIds = new Set<string>();
    try {
      const { syncJobManager } = await import('../services/network/syncJobManager');
      await syncJobManager.startStoreMediaSync(
        gamesRef.current,
        (updatedGame) => {
          if (!isMountedRef.current) return;
          updatedGameIds.add(updatedGame.id);
          pendingMediaUpdates.set(updatedGame.id, updatedGame);
          if (isVitest) {
            flushMediaBatch();
          } else if (mediaFlushTimerRef.current === null) {
            mediaFlushTimerRef.current = setTimeout(flushMediaBatch, 350);
          }
        },
        { isManualSync: true }
      );
      clearPendingMediaFlushTimer();
      flushMediaBatch();
      if (isMountedRef.current) {
        const updatedCount = updatedGameIds.size;
        if (updatedCount > 0) {
          showSyncNotice(
            `Store media sync complete! Updated ${updatedCount} ${updatedCount === 1 ? 'title' : 'titles'} (trailers, screenshots, descriptions & specs).`,
            5000
          );
        } else {
          showSyncNotice(
            'All library store media & descriptions are already up to date.',
            5000
          );
        }
      }
    } catch (err: unknown) {
      clearPendingMediaFlushTimer();
      flushMediaBatch();
      if (isMountedRef.current) {
        showSyncNotice(
          `Media sync notice: ${getSyncErrorMessage(err, 'Finished media sync')}`,
          5000
        );
      }
    } finally {
      clearPendingMediaFlushTimer();
      mediaSyncInFlightRef.current = false;
      if (isMountedRef.current) {
        setIsSyncingAllMedia(false);
      }
      if (typeof window !== 'undefined') {
        window.electronAPI?.trimMemory?.({ passive: true })?.catch?.(() => {});
      }
    }
  }, [gamesRef, isSyncingAllMedia, setGames, setIsSyncingAllMedia, showSyncNotice]);

  const handleRefreshScores = useCallback(async () => {
    if (isSyncingScores || scoresSyncInFlightRef.current) return;
    scoresSyncInFlightRef.current = true;
    setIsSyncingScores(true);
    showSyncNotice('Starting critic score refresh across OpenCritic, Metacritic & Steam...', 3000);

    try {
      const { syncJobManager } = await import('../services/network/syncJobManager');
      await syncJobManager.startCriticScoreSync(gamesRef.current, {
        forceRefresh: true,
        isBackgroundWarmup: false,
      });

      if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
        window.dispatchEvent(
          new CustomEvent('antigravity_critic_updated', {
            detail: { refreshedAll: true },
          })
        );
      }

      if (isMountedRef.current) {
        showSyncNotice('Critic scores refreshed across your library.', 5000);
      }
    } catch (err: unknown) {
      console.warn('Score refresh error:', err);
      if (isMountedRef.current) {
        showSyncNotice('Finished refreshing available critic scores.', 5000);
      }
    } finally {
      scoresSyncInFlightRef.current = false;
      if (isMountedRef.current) {
        setIsSyncingScores(false);
      }
      if (typeof window !== 'undefined') {
        window.electronAPI?.trimMemory?.({ passive: true })?.catch?.(() => {});
      }
    }
  }, [gamesRef, isSyncingScores, showSyncNotice]);

  return {
    isSyncing,
    isSyncingCurrentGame,
    isSyncingScores,
    isSyncingTrophies,
    canSyncCurrentGame,
    handleTriggerSync,
    handleSyncTrophies,
    handleSyncCurrentGame,
    handleSyncStoreMedia,
    handleRefreshScores,
  };
}
