import { useCallback, useEffect, useRef, useState } from 'react';
import { CanonicalGame } from '../../../contracts/game';
import { RequestPriority } from '../../../services/network/requestScheduler';
import {
  fallbackMetadataProvider,
  isGenericPlaceholderSynopsis,
} from '../../../services/steam/fallbackMetadataProvider';
import { steamApi } from '../../../services/steam/steamApi';
import {
  getUserOverrideForGame,
  loadUserOverrides,
} from '../../../services/storage/userOverrideStorage';
import { isUserActivelyScrolling } from '../../../utils/scrollActivityTracker';
import {
  clearDurableEmptySynopsisProbe,
  extractCleanSynopsisText,
  hasGenuineStoreSynopsis,
  isSynopsisAlreadyProbed,
  loadDurableEmptySynopsisProbeMap,
  recordDurableEmptySynopsisProbe,
} from './matchManagerDiagnostics';
import {
  moduleProbedResultsMap,
  moduleProbingSet,
  setModuleProbedResult,
} from './matchManagerCatalogIndex';

const PROBE_FLUSH_THROTTLE_MS = 2_000;
const INITIAL_PROBE_SCAN_DELAY_MS = 80;
const MAX_CONCURRENT_PROBES = 2;
const IS_VITEST_ENV = typeof process !== 'undefined' && Boolean(process.env?.VITEST);

function yieldBetweenProbeBatches(): Promise<void> {
  const g = globalThis as { scheduler?: { yield?: () => Promise<void> } };
  if (typeof g.scheduler?.yield === 'function') {
    return g.scheduler.yield();
  }
  return new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  });
}

export interface UseMatchStudioSynopsisProberParams {
  isOpen: boolean;
  isSuspended: boolean;
  games: CanonicalGame[];
  onGameUpdated?: (game: CanonicalGame) => void;
  onGamesBatchUpdated?: (games: CanonicalGame[]) => void;
}

export function useMatchStudioSynopsisProber({
  isOpen,
  isSuspended,
  games,
  onGameUpdated,
  onGamesBatchUpdated,
}: UseMatchStudioSynopsisProberParams): Record<string, string | null> {
  const [probedSynopsisMap, setProbedSynopsisMap] = useState<Record<string, string | null>>(() =>
    moduleProbedResultsMap.size > 0 ? Object.fromEntries(moduleProbedResultsMap) : {}
  );

  const gamesLatestRef = useRef(games);
  gamesLatestRef.current = games;
  const probedSynopsisMapLatestRef = useRef(probedSynopsisMap);
  probedSynopsisMapLatestRef.current = probedSynopsisMap;

  const pendingMapDeltaRef = useRef<Record<string, string | null>>({});
  const hasPendingMapDeltaRef = useRef(false);
  const pendingGameUpdatesRef = useRef<Map<string, CanonicalGame>>(new Map());
  const flushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const onGameUpdatedRef = useRef(onGameUpdated);
  onGameUpdatedRef.current = onGameUpdated;
  const onGamesBatchUpdatedRef = useRef(onGamesBatchUpdated);
  onGamesBatchUpdatedRef.current = onGamesBatchUpdated;

  useEffect(() => {
    return () => {
      if (IS_VITEST_ENV) {
        moduleProbedResultsMap.clear();
        moduleProbingSet.clear();
      }
    };
  }, []);

  const flushPendingGameUpdatesOnly = useCallback(() => {
    if (pendingGameUpdatesRef.current.size === 0) return;
    const queued = Array.from(pendingGameUpdatesRef.current.values());
    pendingGameUpdatesRef.current.clear();
    const batchCb = onGamesBatchUpdatedRef.current;
    if (batchCb) {
      batchCb(queued);
      return;
    }
    const singleCb = onGameUpdatedRef.current;
    if (singleCb) {
      for (const updated of queued) {
        singleCb(updated);
      }
    }
  }, []);

  const flushPendingProbeMapOnly = useCallback(() => {
    if (flushTimerRef.current !== null) {
      clearTimeout(flushTimerRef.current);
      flushTimerRef.current = null;
    }
    if (hasPendingMapDeltaRef.current) {
      const delta = pendingMapDeltaRef.current;
      pendingMapDeltaRef.current = {};
      hasPendingMapDeltaRef.current = false;
      setProbedSynopsisMap((prev) => ({ ...prev, ...delta }));
    }
  }, []);

  const flushPendingProbeState = useCallback(() => {
    flushPendingProbeMapOnly();
    flushPendingGameUpdatesOnly();
  }, [flushPendingProbeMapOnly, flushPendingGameUpdatesOnly]);

  const scheduleThrottledProbeFlush = useCallback(() => {
    if (flushTimerRef.current !== null) return;
    flushTimerRef.current = setTimeout(() => {
      flushTimerRef.current = null;
      flushPendingProbeMapOnly();
    }, PROBE_FLUSH_THROTTLE_MS);
  }, [flushPendingProbeMapOnly]);

  useEffect(() => {
    if (!isOpen) {
      flushPendingProbeState();
      return;
    }
    return () => {
      if (flushTimerRef.current !== null) {
        clearTimeout(flushTimerRef.current);
        flushTimerRef.current = null;
      }
      pendingMapDeltaRef.current = {};
      hasPendingMapDeltaRef.current = false;
      flushPendingGameUpdatesOnly();
    };
  }, [isOpen, flushPendingProbeState, flushPendingGameUpdatesOnly]);

  // Imperative bounded 2-worker P2_BACKGROUND synopsis probe loop scoped to [isOpen, isSuspended].
  useEffect(() => {
    if (!isOpen || isSuspended) return;

    let stopped = false;
    const abortController = new AbortController();
    const inFlightIds = new Set<string>();

    const waitWithAbort = (ms: number): Promise<void> =>
      new Promise<void>((resolve) => {
        if (stopped || abortController.signal.aborted) {
          resolve();
          return;
        }
        const onAbort = () => {
          clearTimeout(timer);
          resolve();
        };
        const timer = setTimeout(() => {
          abortController.signal.removeEventListener('abort', onAbort);
          resolve();
        }, ms);
        abortController.signal.addEventListener('abort', onAbort, { once: true });
      });

    const findNextBatch = (): CanonicalGame[] => {
      const currentGames = gamesLatestRef.current;
      const liveMap = probedSynopsisMapLatestRef.current;
      const overridesMap = loadUserOverrides();
      const probeMap = loadDurableEmptySynopsisProbeMap();
      const batch: CanonicalGame[] = [];
      for (let i = 0; i < currentGames.length; i += 1) {
        const game = currentGames[i];
        if (
          moduleProbingSet.has(game.id) ||
          moduleProbedResultsMap.has(game.id) ||
          Boolean(getUserOverrideForGame(game, overridesMap)) ||
          isSynopsisAlreadyProbed(game, undefined, liveMap, probeMap) ||
          hasGenuineStoreSynopsis(game, undefined, liveMap)
        ) {
          continue;
        }
        batch.push(game);
        if (batch.length >= MAX_CONCURRENT_PROBES) {
          break;
        }
      }
      return batch;
    };

    const runProbeLoop = async () => {
      await waitWithAbort(INITIAL_PROBE_SCAN_DELAY_MS);
      while (!stopped && !abortController.signal.aborted) {
        while (!stopped && !abortController.signal.aborted && isUserActivelyScrolling()) {
          await waitWithAbort(150);
        }
        if (stopped || abortController.signal.aborted) break;

        const batch = findNextBatch();
        if (batch.length === 0) {
          break;
        }

        await Promise.all(
          batch.map(async (game) => {
            if (stopped || abortController.signal.aborted) return;
            moduleProbingSet.add(game.id);
            inFlightIds.add(game.id);
            try {
              const fetchPromise = game.steamAppId
                ? steamApi.fetchGameMetadata(game.steamAppId, RequestPriority.P2_BACKGROUND)
                : (
                    fallbackMetadataProvider.getEnrichedMetadataForNonSteamGame as (
                      g: CanonicalGame,
                      onProg?: unknown,
                      opts?: unknown
                    ) => Promise<CanonicalGame['enrichedMetadata'] | null>
                  )(game, undefined, {
                    priority: RequestPriority.P2_BACKGROUND,
                    synopsisOnly: true,
                    signal: abortController.signal,
                  } as unknown);

              const res = await Promise.resolve(fetchPromise);
              inFlightIds.delete(game.id);
              if (stopped || abortController.signal.aborted) {
                if (!moduleProbedResultsMap.has(game.id)) {
                  moduleProbingSet.delete(game.id);
                }
                return;
              }

              const clean = extractCleanSynopsisText(
                res?.shortDescription || res?.aboutTheGame || res?.detailedDescription
              );
              if (res && clean.length >= 25 && !isGenericPlaceholderSynopsis(clean, game.title)) {
                setModuleProbedResult(game.id, clean);
                clearDurableEmptySynopsisProbe(game.id);
                const validDevs =
                  res.developers?.filter((d) => d && d !== 'Unknown Developer') || [];
                pendingGameUpdatesRef.current.set(game.id, {
                  ...game,
                  shortDescription:
                    res.shortDescription &&
                    !isGenericPlaceholderSynopsis(res.shortDescription, game.title)
                      ? res.shortDescription
                      : clean.slice(0, 280),
                  detailedDescription:
                    res.aboutTheGame || res.detailedDescription || game.detailedDescription,
                  developers: validDevs.length > 0 ? validDevs : game.developers,
                  releaseDate:
                    res.releaseDate && res.releaseDate !== 'TBA'
                      ? res.releaseDate
                      : game.releaseDate,
                  enrichedMetadata: res,
                });
                if (!stopped && !abortController.signal.aborted) {
                  pendingMapDeltaRef.current[game.id] = clean;
                  hasPendingMapDeltaRef.current = true;
                  scheduleThrottledProbeFlush();
                }
              } else {
                setModuleProbedResult(game.id, null);
                recordDurableEmptySynopsisProbe(game.id);
                if (!stopped && !abortController.signal.aborted) {
                  pendingMapDeltaRef.current[game.id] = null;
                  hasPendingMapDeltaRef.current = true;
                  scheduleThrottledProbeFlush();
                }
              }
            } catch {
              inFlightIds.delete(game.id);
              if (stopped || abortController.signal.aborted) {
                if (!moduleProbedResultsMap.has(game.id)) {
                  moduleProbingSet.delete(game.id);
                }
                return;
              }
              setModuleProbedResult(game.id, null);
              recordDurableEmptySynopsisProbe(game.id);
              if (!stopped && !abortController.signal.aborted) {
                pendingMapDeltaRef.current[game.id] = null;
                hasPendingMapDeltaRef.current = true;
                scheduleThrottledProbeFlush();
              }
            }
          })
        );

        if (!stopped && !abortController.signal.aborted) {
          await yieldBetweenProbeBatches();
        }
      }
    };

    void runProbeLoop();

    return () => {
      stopped = true;
      abortController.abort();
      for (const id of inFlightIds) {
        if (!moduleProbedResultsMap.has(id)) {
          moduleProbingSet.delete(id);
        }
      }
      inFlightIds.clear();
    };
  }, [isOpen, isSuspended, scheduleThrottledProbeFlush]);

  return probedSynopsisMap;
}
