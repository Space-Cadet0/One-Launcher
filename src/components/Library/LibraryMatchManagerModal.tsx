import React, { useState, useMemo, useEffect, useRef, useCallback } from 'react';
import { CanonicalGame } from '../../contracts/game';
import { UserGameOverride } from '../../contracts/override';
import { StorefrontId } from '../../contracts/platform';
import {
  loadUserOverrides,
  getUserOverrideForGame,
  getUserOverridesRevision,
  loadConfirmedNonGameKeys,
} from '../../services/storage/userOverrideStorage';
import {
  getSuppressedCatalogEntries,
  normalizeCanonicalTitle,
  SuppressedCatalogEntry,
} from '../../services/integrations/catalogSanitizer';
import { matchesLooseSearchQuery } from '../../services/common/titleUtils';
import { RequestPriority } from '../../services/network/requestScheduler';
import { ModalShell } from '../Common/ModalShell';
import { VirtualListRows } from '../Common/VirtualContainers';
import {
  isGenericPlaceholderSynopsis,
  fallbackMetadataProvider,
} from '../../services/steam/fallbackMetadataProvider';
import { steamApi } from '../../services/steam/steamApi';
import { isUserActivelyScrolling } from '../../utils/scrollActivityTracker';
import {
  useIsRealClientRenderer,
  useSafeDeferredValue,
  useSafeId,
} from '../../utils/useSafeId';
import {
  AutoFilteredSubFilter,
  estimateMatchManagerRowSize,
  FilterTab,
  LibraryMatchManagerModalProps,
  MatchManagerFlatRow,
  MatchStudioSectionKey,
  UnmatchedDiagnosticReason,
  UnmatchedReasonCode,
  UnmatchedSubFilter,
} from './MatchManager/matchManagerTypes';
import {
  classifyAutoFilteredSubCategory,
  clearDurableEmptySynopsisProbe,
  extractCleanSynopsisText,
  getGranularUnmatchedReasons,
  getSynopsisProbeRevision,
  hasDeveloperOrReleaseYear,
  hasDurableEmptySynopsisProbe,
  hasGenuineStoreSynopsis,
  isLikelyNonStoreOrTestBranchTitle,
  isSynopsisAlreadyProbed,
  loadDurableEmptySynopsisProbeMap,
  recordDurableEmptySynopsisProbe,
} from './MatchManager/matchManagerDiagnostics';
import {
  renderMatchManagerFooter,
  renderMatchManagerHeaderAndTabs,
} from './MatchManager/MatchManagerHeaderTabs';
import {
  buildMatchManagerFlatRows,
  MatchManagerRowRenderContext,
  MatchManagerVirtualRow,
  renderMatchManagerFlatRow,
  ResetOverrideContext,
} from './MatchManager/MatchManagerRows';

export type {
  LibraryMatchManagerModalProps,
  UnmatchedReasonCode,
  UnmatchedDiagnosticReason,
};
export {
  extractCleanSynopsisText,
  isLikelyNonStoreOrTestBranchTitle,
  hasGenuineStoreSynopsis,
  hasDeveloperOrReleaseYear,
  isSynopsisAlreadyProbed,
  getGranularUnmatchedReasons,
  hasDurableEmptySynopsisProbe,
  recordDurableEmptySynopsisProbe,
  clearDurableEmptySynopsisProbe,
};

const PROBE_FLUSH_THROTTLE_MS = 2_000;
const INITIAL_PROBE_SCAN_DELAY_MS = 80;
const MAX_CONCURRENT_PROBES = 2;
const IS_VITEST_ENV = typeof process !== 'undefined' && Boolean(process.env?.VITEST);
const STUDIO_TITLE_COLLATOR = new Intl.Collator(undefined, {
  numeric: true,
  sensitivity: 'base',
});

interface CatalogLookupIndex {
  byId: Map<string, CanonicalGame>;
  byIdLower: Map<string, CanonicalGame>;
  byPlatComposite: Map<string, CanonicalGame>;
  byPlatCompositeLower: Map<string, CanonicalGame>;
  bySinglePlatComposite: Map<string, CanonicalGame>;
  bySinglePlatCompositeLower: Map<string, CanonicalGame>;
}

const EMPTY_CATALOG_LOOKUP: CatalogLookupIndex = {
  byId: new Map(),
  byIdLower: new Map(),
  byPlatComposite: new Map(),
  byPlatCompositeLower: new Map(),
  bySinglePlatComposite: new Map(),
  bySinglePlatCompositeLower: new Map(),
};

interface IndexedUnmatchedItem {
  game: CanonicalGame;
  reasons: UnmatchedDiagnosticReason[];
  searchFields: string[];
}

interface IndexedGameItem {
  game: CanonicalGame;
  searchFields: string[];
}

interface IndexedSuppressedItem {
  entry: SuppressedCatalogEntry;
  subCategory: Exclude<AutoFilteredSubFilter, 'all'>;
  searchFields: string[];
}

interface IndexedOverrideItem {
  override: UserGameOverride;
  matchedGame?: CanonicalGame;
  searchFields: string[];
}

interface CachedUnmatchedDiagEntry {
  overridesRev: number;
  probeRev: number;
  eventRev: number;
  hasProbedEntry: boolean;
  probedVal: string | null | undefined;
  item: IndexedUnmatchedItem | null;
}

interface CachedLowConfDiagEntry {
  overridesRev: number;
  eventRev: number;
  isUnmatched: boolean;
  item: IndexedGameItem | null;
}

const moduleProbedResultsMap = new Map<string, string | null>();
const moduleProbingSet = new Set<string>();
let moduleStudioEventRevision = 0;
let lastSeenOverridesMapRef: Record<string, UserGameOverride> | null = null;
let syntheticOverridesMapRev = 0;
let moduleUnmatchedDiagWeakMap = new WeakMap<CanonicalGame, CachedUnmatchedDiagEntry>();
let moduleLowConfDiagWeakMap = new WeakMap<CanonicalGame, CachedLowConfDiagEntry>();

export function resetStudioSessionCachesForTests(): void {
  moduleProbedResultsMap.clear();
  moduleProbingSet.clear();
  moduleStudioEventRevision += 1;
  lastSeenOverridesMapRef = null;
  moduleUnmatchedDiagWeakMap = new WeakMap();
  moduleLowConfDiagWeakMap = new WeakMap();
}

function resolveEffectiveOverridesRevision(
  overridesMap: Record<string, UserGameOverride>
): number {
  if (overridesMap !== lastSeenOverridesMapRef) {
    lastSeenOverridesMapRef = overridesMap;
    syntheticOverridesMapRev += 1;
  }
  const storageRev =
    typeof getUserOverridesRevision === 'function' ? getUserOverridesRevision() : 0;
  return storageRev * 1_000_003 + syntheticOverridesMapRev;
}

type ExtendedLibraryMatchManagerModalProps = Omit<
  LibraryMatchManagerModalProps,
  'onResetOverride' | 'onResetOverrideForGame'
> & {
  onResetOverride?: (gameId: string, context?: ResetOverrideContext) => void;
  onResetOverrideForGame?: (gameId: string, context?: ResetOverrideContext) => void;
};

function getFlatRowKey(row: MatchManagerFlatRow): string {
  return row.key;
}

function yieldBetweenProbeBatches(): Promise<void> {
  const g = globalThis as { scheduler?: { yield?: () => Promise<void> } };
  if (typeof g.scheduler?.yield === 'function') {
    return g.scheduler.yield();
  }
  return new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  });
}

function collectGameSearchFields(game: CanonicalGame): string[] {
  const fields: string[] = [];
  if (game.title) fields.push(game.title);
  if (game.originalStoreTitle) fields.push(game.originalStoreTitle);
  if (game.id) fields.push(game.id);
  if (game.platforms) {
    for (let i = 0; i < game.platforms.length; i += 1) {
      const p = game.platforms[i];
      if (p.platformId) fields.push(p.platformId);
      if (p.platformGameId) fields.push(p.platformGameId);
      if (p.originalTitle) fields.push(p.originalTitle);
    }
  }
  return fields;
}

function matchesAnySearchField(fields: readonly string[], query: string): boolean {
  for (let i = 0; i < fields.length; i += 1) {
    if (matchesLooseSearchQuery(fields[i], query)) {
      return true;
    }
  }
  return false;
}

export const LibraryMatchManagerModal: React.FC<ExtendedLibraryMatchManagerModalProps> = ({
  isOpen,
  games,
  initialTab,
  onClose,
  onFixMatchForGame,
  onResetOverride,
  onResetOverrideForGame,
  onInspectGame,
  onSelectGame,
  onHideGame,
  onUnhideEntry,
  onGameUpdated,
  onGamesBatchUpdated,
  isSuspended = false,
}) => {
  const handleInspect = onInspectGame || onSelectGame;
  const handleReset = onResetOverride || onResetOverrideForGame;

  const isRealClientRenderer = useIsRealClientRenderer();
  const titleId = useSafeId('library-match-manager-title');
  const panelId = useSafeId('library-match-manager-panel');
  const searchInputId = useSafeId('library-match-manager-search');

  const [searchQuery, setSearchQuery] = useState('');
  const deferredSearchQuery = useSafeDeferredValue(searchQuery);
  const [activeTab, setActiveTab] = useState<FilterTab>(initialTab ?? 'needs_attention');
  const [unmatchedSubFilter, setUnmatchedSubFilter] = useState<UnmatchedSubFilter>('all');
  const [autoFilteredSubFilter, setAutoFilteredSubFilter] = useState<AutoFilteredSubFilter>('all');
  const [expandedSections, setExpandedSections] = useState<Record<string, boolean>>({
    unmatched: true,
    low_confidence: true,
    user_suppressed: true,
    suppressed: true,
    confirmed_suppressed: true,
    overrides: true,
    merged: true,
  });
  const [selectedNonGameIds, setSelectedNonGameIds] = useState<Set<string>>(new Set());
  const [overrideTick, setOverrideTick] = useState(0);
  const [nonGameConfirmTick, setNonGameConfirmTick] = useState(0);
  const [probedSynopsisMap, setProbedSynopsisMap] = useState<Record<string, string | null>>(() =>
    moduleProbedResultsMap.size > 0 ? Object.fromEntries(moduleProbedResultsMap) : {}
  );
  const [scrollEl, setScrollEl] = useState<HTMLDivElement | null>(null);

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

  const handleInspectRef = useRef(handleInspect);
  handleInspectRef.current = handleInspect;
  const onResetOverrideRef = useRef(onResetOverride);
  onResetOverrideRef.current = onResetOverride;
  const onResetOverrideForGameRef = useRef(onResetOverrideForGame);
  onResetOverrideForGameRef.current = onResetOverrideForGame;
  const onFixMatchForGameRef = useRef(onFixMatchForGame);
  onFixMatchForGameRef.current = onFixMatchForGame;
  const onHideGameRef = useRef(onHideGame);
  onHideGameRef.current = onHideGame;
  const onUnhideEntryRef = useRef(onUnhideEntry);
  onUnhideEntryRef.current = onUnhideEntry;
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  // Suspension snapshot caches while FixMatchWizardModal is stacked on top
  const cachedLookupRef = useRef<CatalogLookupIndex>(EMPTY_CATALOG_LOOKUP);
  const hasHydratedLookupRef = useRef(false);
  const cachedBaseUnmatchedRef = useRef<{
    items: IndexedUnmatchedItem[];
    idSet: Set<string>;
  }>({ items: [], idSet: new Set() });
  const hasHydratedUnmatchedRef = useRef(false);
  const cachedBaseLowConfRef = useRef<IndexedGameItem[]>([]);
  const hasHydratedLowConfRef = useRef(false);
  const cachedBaseSuppressedRef = useRef<{
    userSuppressed: IndexedSuppressedItem[];
    autoFiltered: IndexedSuppressedItem[];
  }>({ userSuppressed: [], autoFiltered: [] });
  const hasHydratedSuppressedRef = useRef(false);
  const cachedBaseOverridesRef = useRef<IndexedOverrideItem[]>([]);
  const hasHydratedOverridesRef = useRef(false);
  const cachedBaseMergedRef = useRef<IndexedGameItem[]>([]);
  const hasHydratedMergedRef = useRef(false);

  useEffect(() => {
    return () => {
      if (IS_VITEST_ENV) {
        moduleProbedResultsMap.clear();
        moduleProbingSet.clear();
      }
    };
  }, []);

  // Preload FixMatchWizardModal chunk on idle when Studio opens so clicking "Fix Match" opens in <16ms
  useEffect(() => {
    if (!isOpen || !isRealClientRenderer || IS_VITEST_ENV) return undefined;
    const g = globalThis as {
      requestIdleCallback?: (cb: () => void, opts?: { timeout?: number }) => number;
      cancelIdleCallback?: (id: number) => void;
    };
    if (typeof g.requestIdleCallback === 'function') {
      const idleId = g.requestIdleCallback(
        () => {
          void import('./FixMatchWizardModal').catch(() => {});
        },
        { timeout: 1_500 }
      );
      return () => {
        if (typeof g.cancelIdleCallback === 'function') {
          g.cancelIdleCallback(idleId);
        }
      };
    }
    const timer = setTimeout(() => {
      void import('./FixMatchWizardModal').catch(() => {});
    }, 120);
    return () => clearTimeout(timer);
  }, [isOpen, isRealClientRenderer]);

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

  useEffect(() => {
    if (!isOpen) return;
    const handleUpdate = (event?: Event) => {
      const detail = (event as CustomEvent<{ type?: string }> | undefined)?.detail;
      const eventType = detail?.type;
      if (
        eventType === 'confirmed-non-game' ||
        eventType === 'confirmed-non-game-batch' ||
        eventType === 'batch-confirmed-non-game' ||
        eventType === 'unconfirmed-non-game'
      ) {
        setNonGameConfirmTick((t) => t + 1);
        return;
      }
      moduleStudioEventRevision += 1;
      setOverrideTick((t) => t + 1);
    };
    const handleRemoved = () => {
      moduleStudioEventRevision += 1;
      setOverrideTick((t) => t + 1);
    };
    window.addEventListener('antigravity:user-override-updated', handleUpdate);
    window.addEventListener('antigravity:user-override-removed', handleRemoved);
    return () => {
      window.removeEventListener('antigravity:user-override-updated', handleUpdate);
      window.removeEventListener('antigravity:user-override-removed', handleRemoved);
    };
  }, [isOpen]);

  // Imperative bounded 2-worker P2_BACKGROUND synopsis probe loop scoped to [isOpen, isSuspended].
  // Never self-cancels on games/probedSynopsisMap renders, yields between batches, pauses on scroll,
  // aborts immediately on suspend/close, and persists negative probe results durably.
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
                moduleProbedResultsMap.set(game.id, clean);
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
                moduleProbedResultsMap.set(game.id, null);
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
              moduleProbedResultsMap.set(game.id, null);
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

  const toggleSection = useCallback((key: MatchStudioSectionKey) => {
    setExpandedSections((prev) => ({ ...prev, [key]: !prev[key] }));
  }, []);

  const handleOpenExternalUrl = useCallback((url?: string) => {
    if (!url) return;
    const electronAPI = typeof window !== 'undefined' ? window.electronAPI : undefined;
    if (electronAPI?.openExternal) {
      void electronAPI.openExternal(url);
    } else if (typeof window !== 'undefined') {
      window.open(url, '_blank', 'noopener,noreferrer');
    }
  }, []);

  const stableInspect = useCallback((game: CanonicalGame) => {
    handleInspectRef.current?.(game);
  }, []);
  const stableReset = useCallback((gameId: string, context?: ResetOverrideContext) => {
    if (onResetOverrideRef.current) {
      if (context !== undefined) {
        onResetOverrideRef.current(gameId, context);
      } else {
        onResetOverrideRef.current(gameId);
      }
      return;
    }
    if (onResetOverrideForGameRef.current) {
      if (context !== undefined && onResetOverrideForGameRef.current.length >= 2) {
        onResetOverrideForGameRef.current(gameId, context);
      } else {
        onResetOverrideForGameRef.current(gameId);
      }
    }
  }, []);
  const stableFixMatch = useCallback((game: CanonicalGame) => {
    onFixMatchForGameRef.current(game);
  }, []);
  const stableHideGame = useCallback(
    (game: CanonicalGame, targetPlatformId?: StorefrontId) => {
      if (targetPlatformId !== undefined) {
        onHideGameRef.current?.(game, targetPlatformId);
      } else {
        onHideGameRef.current?.(game);
      }
    },
    []
  );
  const stableUnhideEntry = useCallback((entry: SuppressedCatalogEntry) => {
    onUnhideEntryRef.current?.(entry);
  }, []);
  const stableClose = useCallback(() => {
    onCloseRef.current();
  }, []);

  // Pre-build O(1) catalog lookup maps once per catalog change when open
  const catalogLookupIndex = useMemo<CatalogLookupIndex>(() => {
    if (!isOpen) return EMPTY_CATALOG_LOOKUP;
    if (isSuspended && hasHydratedLookupRef.current) return cachedLookupRef.current;

    const byId = new Map<string, CanonicalGame>();
    const byIdLower = new Map<string, CanonicalGame>();
    const byPlatComposite = new Map<string, CanonicalGame>();
    const byPlatCompositeLower = new Map<string, CanonicalGame>();
    const bySinglePlatComposite = new Map<string, CanonicalGame>();
    const bySinglePlatCompositeLower = new Map<string, CanonicalGame>();

    for (let i = 0; i < games.length; i += 1) {
      const g = games[i];
      byId.set(g.id, g);
      byIdLower.set(g.id.toLowerCase(), g);
      const isSinglePlat = g.platforms.length === 1;
      for (let j = 0; j < g.platforms.length; j += 1) {
        const p = g.platforms[j];
        const compKey = `${p.platformId}:${String(p.platformGameId)}`;
        const compLower = compKey.toLowerCase();
        const dashLower = `${p.platformId}-${String(p.platformGameId)}`.toLowerCase();
        if (!byPlatComposite.has(compKey)) {
          byPlatComposite.set(compKey, g);
        }
        if (!byPlatCompositeLower.has(compLower)) {
          byPlatCompositeLower.set(compLower, g);
        }
        if (!byIdLower.has(dashLower)) {
          byIdLower.set(dashLower, g);
        }
        if (isSinglePlat && !bySinglePlatComposite.has(compKey)) {
          bySinglePlatComposite.set(compKey, g);
        }
        if (isSinglePlat && !bySinglePlatCompositeLower.has(compLower)) {
          bySinglePlatCompositeLower.set(compLower, g);
        }
      }
    }

    const next: CatalogLookupIndex = {
      byId,
      byIdLower,
      byPlatComposite,
      byPlatCompositeLower,
      bySinglePlatComposite,
      bySinglePlatCompositeLower,
    };
    cachedLookupRef.current = next;
    hasHydratedLookupRef.current = true;
    return next;
  }, [isOpen, isSuspended, games]);

  // 1. Base Unmatched Games (computed & sorted ONCE per catalog/override/probe change, decoupled from searchQuery)
  const baseUnmatchedData = useMemo(() => {
    if (!isOpen) return { items: [] as IndexedUnmatchedItem[], idSet: new Set<string>() };
    if (isSuspended && hasHydratedUnmatchedRef.current) return cachedBaseUnmatchedRef.current;

    const overridesMap = loadUserOverrides();
    const overridesRev = resolveEffectiveOverridesRevision(overridesMap);
    const probeMap = loadDurableEmptySynopsisProbeMap();
    const probeRev = getSynopsisProbeRevision();
    const eventRev = moduleStudioEventRevision;
    const hasProbedMapEntries = Object.keys(probedSynopsisMap).length > 0;

    const items: IndexedUnmatchedItem[] = [];
    for (let i = 0; i < games.length; i += 1) {
      const game = games[i];
      const hasProbedEntryForGame =
        hasProbedMapEntries && Object.prototype.hasOwnProperty.call(probedSynopsisMap, game.id);
      const probedVal = hasProbedEntryForGame ? probedSynopsisMap[game.id] : undefined;

      const cachedDiag = moduleUnmatchedDiagWeakMap.get(game);
      if (
        cachedDiag &&
        cachedDiag.overridesRev === overridesRev &&
        cachedDiag.probeRev === probeRev &&
        cachedDiag.eventRev === eventRev &&
        cachedDiag.hasProbedEntry === hasProbedEntryForGame &&
        cachedDiag.probedVal === probedVal
      ) {
        if (cachedDiag.item) items.push(cachedDiag.item);
        continue;
      }

      if (getUserOverrideForGame(game, overridesMap)) {
        moduleUnmatchedDiagWeakMap.set(game, {
          overridesRev,
          probeRev,
          eventRev,
          hasProbedEntry: hasProbedEntryForGame,
          probedVal,
          item: null,
        });
        continue;
      }

      const reasons = getGranularUnmatchedReasons(game, undefined, probedSynopsisMap, probeMap);
      if (reasons.length === 0) {
        moduleUnmatchedDiagWeakMap.set(game, {
          overridesRev,
          probeRev,
          eventRev,
          hasProbedEntry: hasProbedEntryForGame,
          probedVal,
          item: null,
        });
        continue;
      }

      const hasFullArtwork = Boolean(game.capsuleImage && game.headerImage);
      const rawConf =
        typeof game.matchConfidence === 'number'
          ? game.matchConfidence <= 1
            ? game.matchConfidence * 100
            : game.matchConfidence
          : 0;
      const isLowConfCandidate =
        Boolean(game.needsMatchReview) || (rawConf > 0 && rawConf < 85);

      if (
        hasFullArtwork &&
        isLowConfCandidate &&
        !(
          reasons.some((r) => r.code === 'missing_synopsis') &&
          isLikelyNonStoreOrTestBranchTitle(game.title)
        )
      ) {
        moduleUnmatchedDiagWeakMap.set(game, {
          overridesRev,
          probeRev,
          eventRev,
          hasProbedEntry: hasProbedEntryForGame,
          probedVal,
          item: null,
        });
        continue;
      }

      const builtItem: IndexedUnmatchedItem = {
        game,
        reasons,
        searchFields: collectGameSearchFields(game),
      };
      moduleUnmatchedDiagWeakMap.set(game, {
        overridesRev,
        probeRev,
        eventRev,
        hasProbedEntry: hasProbedEntryForGame,
        probedVal,
        item: builtItem,
      });
      items.push(builtItem);
    }

    items.sort((a, b) => STUDIO_TITLE_COLLATOR.compare(a.game.title, b.game.title));
    const idSet = new Set<string>();
    for (let i = 0; i < items.length; i += 1) {
      idSet.add(items[i].game.id);
    }

    const next = { items, idSet };
    cachedBaseUnmatchedRef.current = next;
    hasHydratedUnmatchedRef.current = true;
    return next;
  }, [isOpen, isSuspended, games, overrideTick, probedSynopsisMap]);

  // 2. Base Low-Confidence Automatic Matches (decoupled from searchQuery)
  const baseLowConfidenceItems = useMemo<IndexedGameItem[]>(() => {
    if (!isOpen) return [];
    if (isSuspended && hasHydratedLowConfRef.current) return cachedBaseLowConfRef.current;

    const overridesMap = loadUserOverrides();
    const overridesRev = resolveEffectiveOverridesRevision(overridesMap);
    const eventRev = moduleStudioEventRevision;
    const unmatchedSet = baseUnmatchedData.idSet;
    const items: IndexedGameItem[] = [];
    for (let i = 0; i < games.length; i += 1) {
      const game = games[i];
      const isUnmatched = unmatchedSet.has(game.id);
      const cachedLowConf = moduleLowConfDiagWeakMap.get(game);
      if (
        cachedLowConf &&
        cachedLowConf.overridesRev === overridesRev &&
        cachedLowConf.eventRev === eventRev &&
        cachedLowConf.isUnmatched === isUnmatched
      ) {
        if (cachedLowConf.item) items.push(cachedLowConf.item);
        continue;
      }

      if (isUnmatched || getUserOverrideForGame(game, overridesMap)) {
        moduleLowConfDiagWeakMap.set(game, {
          overridesRev,
          eventRev,
          isUnmatched,
          item: null,
        });
        continue;
      }

      const rawConf =
        typeof game.matchConfidence === 'number'
          ? game.matchConfidence <= 1
            ? game.matchConfidence * 100
            : game.matchConfidence
          : undefined;

      const hasTitleShift =
        Boolean(game.originalStoreTitle) &&
        game.originalStoreTitle !== game.title &&
        normalizeCanonicalTitle(game.originalStoreTitle!) !==
          normalizeCanonicalTitle(game.title);

      const isLowConf =
        Boolean(game.needsMatchReview) ||
        (typeof rawConf === 'number' && rawConf > 0 && rawConf < 85) ||
        hasTitleShift;

      if (!isLowConf) {
        moduleLowConfDiagWeakMap.set(game, {
          overridesRev,
          eventRev,
          isUnmatched,
          item: null,
        });
        continue;
      }

      const builtItem: IndexedGameItem = {
        game,
        searchFields: collectGameSearchFields(game),
      };
      moduleLowConfDiagWeakMap.set(game, {
        overridesRev,
        eventRev,
        isUnmatched,
        item: builtItem,
      });
      items.push(builtItem);
    }

    items.sort((a, b) => STUDIO_TITLE_COLLATOR.compare(a.game.title, b.game.title));
    cachedBaseLowConfRef.current = items;
    hasHydratedLowConfRef.current = true;
    return items;
  }, [isOpen, isSuspended, games, baseUnmatchedData, overrideTick]);

  // 3. Base Suppressed & Filtered Storefront Entries (O(1) catalog check, pre-sorted once)
  const baseSuppressedSplit = useMemo(() => {
    if (!isOpen) {
      return {
        userSuppressed: [] as IndexedSuppressedItem[],
        autoFiltered: [] as IndexedSuppressedItem[],
      };
    }
    if (isSuspended && hasHydratedSuppressedRef.current) return cachedBaseSuppressedRef.current;

    const rawSuppressed = getSuppressedCatalogEntries();
    const userSuppressed: IndexedSuppressedItem[] = [];
    const autoFiltered: IndexedSuppressedItem[] = [];

    for (let i = 0; i < rawSuppressed.length; i += 1) {
      const entry = rawSuppressed[i];
      const compKey = `${entry.platformId}:${String(entry.platformGameId)}`;
      if (
        catalogLookupIndex.byId.has(entry.rawGame.id) ||
        catalogLookupIndex.byPlatComposite.has(compKey) ||
        catalogLookupIndex.byPlatCompositeLower.has(compKey.toLowerCase())
      ) {
        continue;
      }

      const searchFields: string[] = [];
      if (entry.rawTitle) searchFields.push(entry.rawTitle);
      if (entry.platformId) searchFields.push(entry.platformId);
      if (entry.platformGameId) searchFields.push(entry.platformGameId);
      if (entry.reason) searchFields.push(entry.reason);

      if (entry.reasonCategory === 'user_hidden') {
        userSuppressed.push({
          entry,
          subCategory: 'beta',
          searchFields,
        });
      } else {
        autoFiltered.push({
          entry,
          subCategory: classifyAutoFilteredSubCategory(entry),
          searchFields,
        });
      }
    }

    userSuppressed.sort((a, b) =>
      STUDIO_TITLE_COLLATOR.compare(a.entry.rawTitle, b.entry.rawTitle)
    );
    autoFiltered.sort((a, b) =>
      STUDIO_TITLE_COLLATOR.compare(a.entry.rawTitle, b.entry.rawTitle)
    );

    const next = { userSuppressed, autoFiltered };
    cachedBaseSuppressedRef.current = next;
    hasHydratedSuppressedRef.current = true;
    return next;
  }, [isOpen, isSuspended, catalogLookupIndex, overrideTick]);

  // 4. Base Manual Matching Overrides (O(1) catalog lookup, multi-key deduped by newest updatedAt)
  const baseOverrideItems = useMemo<IndexedOverrideItem[]>(() => {
    if (!isOpen) return [];
    if (isSuspended && hasHydratedOverridesRef.current) return cachedBaseOverridesRef.current;

    const allMap = loadUserOverrides();
    const keyToEntryIndex = new Map<string, number>();
    const dedupedList: Array<{ item: IndexedOverrideItem; updatedAtMs: number }> = [];

    for (const [dictKey, ov] of Object.entries(allMap)) {
      if (!ov || !ov.gameId) continue;

      let matchedGame =
        catalogLookupIndex.byId.get(ov.gameId) ??
        catalogLookupIndex.byIdLower.get(ov.gameId.toLowerCase()) ??
        catalogLookupIndex.byId.get(dictKey) ??
        catalogLookupIndex.byIdLower.get(dictKey.toLowerCase());

      if (!matchedGame && ov.steamAppId) {
        matchedGame = catalogLookupIndex.byId.get(`steam-${ov.steamAppId}`);
      }
      if (!matchedGame && ov.matchedStore === 'steam' && ov.matchedId) {
        matchedGame = catalogLookupIndex.byId.get(`steam-${String(ov.matchedId)}`);
      }
      if (!matchedGame && ov.platformId && ov.platformGameId) {
        const compKey = `${ov.platformId}:${String(ov.platformGameId)}`;
        const compLower = compKey.toLowerCase();
        matchedGame = ov.splitFromMerged
          ? (catalogLookupIndex.bySinglePlatComposite.get(compKey) ??
            catalogLookupIndex.bySinglePlatCompositeLower.get(compLower))
          : (catalogLookupIndex.byPlatComposite.get(compKey) ??
            catalogLookupIndex.byPlatCompositeLower.get(compLower));
        if (!matchedGame) {
          matchedGame = catalogLookupIndex.byIdLower.get(
            `${ov.platformId}-${String(ov.platformGameId)}`.toLowerCase()
          );
        }
      }

      const candidateKeys: string[] = [`gid:${ov.gameId.toLowerCase()}`];
      if (dictKey) {
        candidateKeys.push(`gid:${dictKey.toLowerCase()}`);
      }
      if (ov.platformId && ov.platformGameId) {
        candidateKeys.push(
          `plat:${ov.platformId.toLowerCase()}:${String(ov.platformGameId).toLowerCase()}`
        );
      }
      if (matchedGame) {
        const splitSuffix =
          ov.splitFromMerged && ov.platformId && ov.platformGameId && matchedGame.platforms.length > 1
            ? `:split:${ov.platformId.toLowerCase()}:${String(ov.platformGameId).toLowerCase()}`
            : '';
        candidateKeys.push(`matched:${matchedGame.id.toLowerCase()}${splitSuffix}`);
      }

      const searchFields: string[] = [];
      if (ov.title) searchFields.push(ov.title);
      if (ov.originalSourceTitle) searchFields.push(ov.originalSourceTitle);
      if (ov.matchedStore) searchFields.push(ov.matchedStore);
      if (ov.matchedId !== undefined && ov.matchedId !== null && String(ov.matchedId)) {
        searchFields.push(String(ov.matchedId));
      }
      if (ov.platformId) searchFields.push(ov.platformId);
      if (ov.platformGameId) searchFields.push(ov.platformGameId);
      if (matchedGame?.title) searchFields.push(matchedGame.title);
      if (matchedGame?.originalStoreTitle) searchFields.push(matchedGame.originalStoreTitle);
      if (matchedGame?.id) searchFields.push(matchedGame.id);

      const updatedAtMs = ov.updatedAt ? Date.parse(ov.updatedAt) || 0 : 0;
      const built: IndexedOverrideItem = { override: ov, matchedGame, searchFields };

      let existingIdx: number | undefined;
      for (let k = 0; k < candidateKeys.length; k += 1) {
        const found = keyToEntryIndex.get(candidateKeys[k]);
        if (found !== undefined) {
          existingIdx = found;
          break;
        }
      }

      if (existingIdx !== undefined) {
        if (updatedAtMs >= dedupedList[existingIdx].updatedAtMs) {
          dedupedList[existingIdx] = { item: built, updatedAtMs };
        }
        for (let k = 0; k < candidateKeys.length; k += 1) {
          keyToEntryIndex.set(candidateKeys[k], existingIdx);
        }
      } else {
        const nextIdx = dedupedList.length;
        dedupedList.push({ item: built, updatedAtMs });
        for (let k = 0; k < candidateKeys.length; k += 1) {
          keyToEntryIndex.set(candidateKeys[k], nextIdx);
        }
      }
    }

    const list = dedupedList.map((entry) => entry.item);
    list.sort((a, b) =>
      STUDIO_TITLE_COLLATOR.compare(a.override.title || '', b.override.title || '')
    );
    cachedBaseOverridesRef.current = list;
    hasHydratedOverridesRef.current = true;
    return list;
  }, [isOpen, isSuspended, catalogLookupIndex, overrideTick]);

  // 5. Base Merged Multi-Storefront Listings (pre-sorted once)
  const baseMergedItems = useMemo<IndexedGameItem[]>(() => {
    if (!isOpen) return [];
    if (isSuspended && hasHydratedMergedRef.current) return cachedBaseMergedRef.current;

    const items: IndexedGameItem[] = [];
    for (let i = 0; i < games.length; i += 1) {
      const game = games[i];
      if (!game.platforms || game.platforms.length <= 1) continue;
      items.push({
        game,
        searchFields: collectGameSearchFields(game),
      });
    }

    items.sort((a, b) => STUDIO_TITLE_COLLATOR.compare(a.game.title, b.game.title));
    cachedBaseMergedRef.current = items;
    hasHydratedMergedRef.current = true;
    return items;
  }, [isOpen, isSuspended, games]);

  // Fast downstream search filtering over deferredSearchQuery (zero re-sorting, zero diagnostic recomputation)
  const effectiveQuery = deferredSearchQuery.trim();

  const unmatchedWithReasons = useMemo(() => {
    if (!isOpen) return [];
    const base = baseUnmatchedData.items;
    if (!effectiveQuery) return base;
    return base.filter((item) => matchesAnySearchField(item.searchFields, effectiveQuery));
  }, [isOpen, baseUnmatchedData, effectiveQuery]);

  const unmatchedGames = useMemo(() => {
    if (!isOpen) return [];
    return unmatchedWithReasons.map((item) => item.game);
  }, [isOpen, unmatchedWithReasons]);

  const unmatchedSubCounts = useMemo(() => {
    if (!isOpen) return { all: 0, artwork: 0, synopsis: 0, dev_year: 0 };
    let artwork = 0;
    let synopsis = 0;
    let dev_year = 0;
    for (let i = 0; i < unmatchedWithReasons.length; i += 1) {
      const { reasons } = unmatchedWithReasons[i];
      if (reasons.some((r) => r.code === 'missing_all_art' || r.code === 'missing_vertical_cover')) {
        artwork += 1;
      }
      if (reasons.some((r) => r.code === 'missing_synopsis')) {
        synopsis += 1;
      }
      if (reasons.some((r) => r.code === 'missing_dev_year')) {
        dev_year += 1;
      }
    }
    return {
      all: unmatchedWithReasons.length,
      artwork,
      synopsis,
      dev_year,
    };
  }, [isOpen, unmatchedWithReasons]);

  const filteredUnmatchedItems = useMemo(() => {
    if (!isOpen) return [];
    if (unmatchedSubFilter === 'all') return unmatchedWithReasons;
    return unmatchedWithReasons.filter(({ reasons }) => {
      if (unmatchedSubFilter === 'artwork') {
        return reasons.some(
          (r) => r.code === 'missing_all_art' || r.code === 'missing_vertical_cover'
        );
      }
      if (unmatchedSubFilter === 'synopsis') {
        return reasons.some((r) => r.code === 'missing_synopsis');
      }
      if (unmatchedSubFilter === 'dev_year') {
        return reasons.some((r) => r.code === 'missing_dev_year');
      }
      return true;
    });
  }, [isOpen, unmatchedWithReasons, unmatchedSubFilter]);

  const lowConfidenceGames = useMemo(() => {
    if (!isOpen) return [];
    const filtered = effectiveQuery
      ? baseLowConfidenceItems.filter((item) =>
          matchesAnySearchField(item.searchFields, effectiveQuery)
        )
      : baseLowConfidenceItems;
    return filtered.map((item) => item.game);
  }, [isOpen, baseLowConfidenceItems, effectiveQuery]);

  const userSuppressedEntries = useMemo(() => {
    if (!isOpen) return [];
    const base = baseSuppressedSplit.userSuppressed;
    const filtered = effectiveQuery
      ? base.filter((item) => matchesAnySearchField(item.searchFields, effectiveQuery))
      : base;
    return filtered.map((item) => item.entry);
  }, [isOpen, baseSuppressedSplit, effectiveQuery]);

  const searchedAutoFilteredItems = useMemo(() => {
    if (!isOpen) return [];
    const base = baseSuppressedSplit.autoFiltered;
    if (!effectiveQuery) return base;
    return base.filter((item) => matchesAnySearchField(item.searchFields, effectiveQuery));
  }, [isOpen, baseSuppressedSplit, effectiveQuery]);

  const { unreviewedAutoFilteredItems, confirmedAutoFilteredEntries } = useMemo(() => {
    if (!isOpen) {
      return {
        unreviewedAutoFilteredItems: [] as IndexedSuppressedItem[],
        confirmedAutoFilteredEntries: [] as SuppressedCatalogEntry[],
      };
    }
    const confirmedKeys = loadConfirmedNonGameKeys();
    const hasConfirmedKeys = confirmedKeys.size > 0;
    const unreviewed: IndexedSuppressedItem[] = [];
    const confirmed: SuppressedCatalogEntry[] = [];
    for (let i = 0; i < searchedAutoFilteredItems.length; i += 1) {
      const item = searchedAutoFilteredItems[i];
      const { entry } = item;
      const isConfirmed =
        hasConfirmedKeys &&
        (Boolean(
          entry.platformId &&
            entry.platformGameId &&
            (confirmedKeys.has(`${entry.platformId}:${entry.platformGameId}`) ||
              confirmedKeys.has(`${entry.platformId}-${entry.platformGameId}`))
        ) ||
          Boolean(
            entry.id && (confirmedKeys.has(entry.id) || confirmedKeys.has(`game:${entry.id}`))
          ));
      if (isConfirmed) {
        confirmed.push(entry);
      } else {
        unreviewed.push(item);
      }
    }
    return {
      unreviewedAutoFilteredItems: unreviewed,
      confirmedAutoFilteredEntries: confirmed,
    };
  }, [isOpen, searchedAutoFilteredItems, overrideTick, nonGameConfirmTick]);

  const unreviewedAutoFilteredEntries = useMemo(() => {
    if (!isOpen) return [];
    return unreviewedAutoFilteredItems.map((item) => item.entry);
  }, [isOpen, unreviewedAutoFilteredItems]);

  const autoFilteredSubCounts = useMemo(() => {
    if (!isOpen) {
      return { all: 0, beta: 0, prologue: 0, tool: 0, soundtrack: 0, dlc: 0 };
    }
    let beta = 0;
    let prologue = 0;
    let tool = 0;
    let soundtrack = 0;
    let dlc = 0;
    for (let i = 0; i < unreviewedAutoFilteredItems.length; i += 1) {
      const cat = unreviewedAutoFilteredItems[i].subCategory;
      if (cat === 'beta') beta += 1;
      else if (cat === 'prologue') prologue += 1;
      else if (cat === 'tool') tool += 1;
      else if (cat === 'soundtrack') soundtrack += 1;
      else if (cat === 'dlc') dlc += 1;
    }
    return {
      all: unreviewedAutoFilteredItems.length,
      beta,
      prologue,
      tool,
      soundtrack,
      dlc,
    };
  }, [isOpen, unreviewedAutoFilteredItems]);

  const filteredAutoFilteredEntries = useMemo(() => {
    if (!isOpen) return [];
    if (autoFilteredSubFilter === 'all') return unreviewedAutoFilteredEntries;
    const list: SuppressedCatalogEntry[] = [];
    for (let i = 0; i < unreviewedAutoFilteredItems.length; i += 1) {
      const item = unreviewedAutoFilteredItems[i];
      if (item.subCategory === autoFilteredSubFilter) {
        list.push(item.entry);
      }
    }
    return list;
  }, [isOpen, unreviewedAutoFilteredItems, unreviewedAutoFilteredEntries, autoFilteredSubFilter]);

  const selectedVisibleEntries = useMemo(() => {
    if (!isOpen || selectedNonGameIds.size === 0) return [];
    return filteredAutoFilteredEntries.filter((entry) => selectedNonGameIds.has(entry.id));
  }, [isOpen, filteredAutoFilteredEntries, selectedNonGameIds]);

  const overrideItems = useMemo(() => {
    if (!isOpen) return [];
    if (!effectiveQuery) return baseOverrideItems;
    return baseOverrideItems.filter((item) =>
      matchesAnySearchField(item.searchFields, effectiveQuery)
    );
  }, [isOpen, baseOverrideItems, effectiveQuery]);

  const mergedGames = useMemo(() => {
    if (!isOpen) return [];
    const filtered = effectiveQuery
      ? baseMergedItems.filter((item) => matchesAnySearchField(item.searchFields, effectiveQuery))
      : baseMergedItems;
    return filtered.map((item) => item.game);
  }, [isOpen, baseMergedItems, effectiveQuery]);

  const handleSelectTab = useCallback(
    (nextTab: FilterTab) => {
      setActiveTab(nextTab);
      scrollEl?.scrollTo?.({ top: 0 });
    },
    [scrollEl]
  );

  useEffect(() => {
    if (isOpen && initialTab) {
      setActiveTab(initialTab);
    }
  }, [isOpen, initialTab]);

  const showUnmatched = activeTab === 'needs_attention';
  const showLowConfidence = activeTab === 'needs_attention';
  const showUserSuppressed = activeTab === 'user_suppressed';
  const showSuppressed = activeTab === 'suppressed';
  const showOverrides = activeTab === 'overrides';
  const showMerged = activeTab === 'merged';

  // Single flattened discriminated-union virtualizer model for the entire scrollable studio body
  const flatRows = useMemo(() => {
    if (!isOpen) return [];
    return buildMatchManagerFlatRows({
      showUnmatched,
      showLowConfidence,
      showUserSuppressed,
      showSuppressed,
      showOverrides,
      showMerged,
      expandedSections,
      unmatchedGames,
      filteredUnmatchedItems,
      lowConfidenceGames,
      userSuppressedEntries,
      unreviewedAutoFilteredEntries,
      filteredAutoFilteredEntries,
      confirmedAutoFilteredEntries,
      overrideItems,
      mergedGames,
    });
  }, [
    isOpen,
    showUnmatched,
    showLowConfidence,
    showUserSuppressed,
    showSuppressed,
    showOverrides,
    showMerged,
    expandedSections,
    unmatchedGames,
    filteredUnmatchedItems,
    lowConfidenceGames,
    userSuppressedEntries,
    unreviewedAutoFilteredEntries,
    filteredAutoFilteredEntries,
    confirmedAutoFilteredEntries,
    overrideItems,
    mergedGames,
  ]);

  const hasInspect = Boolean(handleInspect);
  const hasReset = Boolean(handleReset);
  const hasHideGame = Boolean(onHideGame);
  const hasUnhideEntry = Boolean(onUnhideEntry);

  const rowRenderContext = useMemo<MatchManagerRowRenderContext>(
    () => ({
      toggleSection,
      unmatchedSubFilter,
      setUnmatchedSubFilter,
      unmatchedSubCounts,
      autoFilteredSubFilter,
      setAutoFilteredSubFilter,
      autoFilteredSubCounts,
      filteredAutoFilteredEntries,
      selectedVisibleEntries,
      selectedNonGameIds,
      setSelectedNonGameIds,
      handleInspect: hasInspect ? stableInspect : undefined,
      handleReset: hasReset ? stableReset : undefined,
      onFixMatchForGame: stableFixMatch,
      onHideGame: hasHideGame ? stableHideGame : undefined,
      onUnhideEntry: hasUnhideEntry ? stableUnhideEntry : undefined,
      onClose: stableClose,
      handleOpenExternalUrl,
    }),
    [
      toggleSection,
      unmatchedSubFilter,
      unmatchedSubCounts,
      autoFilteredSubFilter,
      autoFilteredSubCounts,
      filteredAutoFilteredEntries,
      selectedVisibleEntries,
      selectedNonGameIds,
      hasInspect,
      stableInspect,
      hasReset,
      stableReset,
      stableFixMatch,
      hasHideGame,
      stableHideGame,
      hasUnhideEntry,
      stableUnhideEntry,
      stableClose,
      handleOpenExternalUrl,
    ]
  );

  const renderVirtualFlatRow = useCallback(
    (row: MatchManagerFlatRow) => {
      const isSelected =
        row.kind === 'pending-suppressed-row'
          ? rowRenderContext.selectedNonGameIds.has(row.entry.id)
          : false;
      return (
        <MatchManagerVirtualRow row={row} isSelected={isSelected} ctx={rowRenderContext} />
      );
    },
    [rowRenderContext]
  );

  if (!isOpen) return null;

  return (
    <ModalShell
      isOpen={isOpen}
      onClose={onClose}
      ariaLabelledBy={titleId}
      className="w-full max-w-5xl"
    >
      <div
        className="bg-[#1b2838] border border-steam-border rounded-xl shadow-2xl w-full max-w-5xl h-[92vh] max-h-[92vh] flex flex-col overflow-hidden text-slate-200 animate-in fade-in duration-150 select-none"
        onClick={(e) => e.stopPropagation()}
      >
        {renderMatchManagerHeaderAndTabs({
          titleId,
          panelId,
          searchInputId,
          activeTab,
          setActiveTab: handleSelectTab,
          searchQuery,
          setSearchQuery,
          onClose,
          unmatchedCount: unmatchedGames.length,
          lowConfidenceCount: lowConfidenceGames.length,
          userSuppressedCount: userSuppressedEntries.length,
          unreviewedAutoFilteredCount: unreviewedAutoFilteredEntries.length,
          overrideCount: overrideItems.length,
          mergedCount: mergedGames.length,
        })}

        {/* Main Scrollable Accordion Body (Single Flattened Virtualizer) */}
        <div
          ref={setScrollEl}
          id={panelId}
          role="tabpanel"
          aria-labelledby={`${titleId}-tab-${activeTab}`}
          inert={isSuspended ? true : undefined}
          aria-hidden={Boolean(isSuspended) || undefined}
          className={`relative flex-1 overflow-y-auto p-6 custom-scrollbar ol-studio-scroll-body${
            isSuspended ? ' pointer-events-none' : ''
          }`}
        >
          {flatRows.length > 50 && isRealClientRenderer ? (
            <VirtualListRows
              items={flatRows}
              scrollElement={scrollEl}
              estimatedItemHeight={78}
              estimateItemSize={estimateMatchManagerRowSize}
              getItemKey={getFlatRowKey}
              renderItem={renderVirtualFlatRow}
            />
          ) : (
            flatRows.map((row) => renderMatchManagerFlatRow(row, rowRenderContext))
          )}
        </div>

        {renderMatchManagerFooter({
          totalGamesCount: games.length,
          unmatchedCount: unmatchedGames.length,
          lowConfidenceCount: lowConfidenceGames.length,
          overrideCount: overrideItems.length,
          userSuppressedCount: userSuppressedEntries.length,
          unreviewedAutoFilteredCount: unreviewedAutoFilteredEntries.length,
          confirmedAutoFilteredCount: confirmedAutoFilteredEntries.length,
          onClose,
        })}
      </div>
    </ModalShell>
  );
};
