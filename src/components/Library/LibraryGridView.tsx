import React, { useState, useRef, useMemo, useEffect, useLayoutEffect, useCallback } from 'react';
import { Layers, X } from 'lucide-react';
import { CanonicalGame } from '../../contracts/game';
import { OpenCriticData } from '../../contracts/critic';
import { StorefrontId } from '../../contracts/platform';
import { GameCollection } from '../../contracts/collection';
import {
  ActiveGameFilter,
  LibraryFilterState,
  DEFAULT_LIBRARY_FILTER_STATE,
  countActiveFilterCriteria,
} from '../../contracts/filter';
import {
  LibraryFilterIndex,
  buildLibraryFilterIndex,
  evaluateLibraryFilter,
  describeActiveFilterChips,
} from '../../services/filter/libraryFilterIndex';
import { VirtualGridRows } from '../Common/VirtualContainers';
import { getOpenCriticData } from '../../services/opencritic/openCritic';
import { steamMatcher } from '../../services/steam/steamMatcher';
import { steamApi } from '../../services/steam/steamApi';
import { isUserActivelyScrolling } from '../../utils/scrollActivityTracker';
import { parseTimestampMs } from '../../utils/dateUtils';
import { loadIntegrations } from '../../services/integrations/integrationStorage';
import {
  igdbCoverService,
  normalizeKey,
} from '../../services/igdb/igdbCoverService';
import { stripHtmlToPlainSynopsis } from '../../services/steam/fallbackMetadataProvider';
import { GameContextMenu } from './GameContextMenu';
import { loadUserOverrides } from '../../services/storage/userOverrideStorage';
import { launcherService } from '../../services/launcher/launcherService';
import { onlineLifecycleManager } from '../../services/network/onlineLifecycleManager';
import {
  isCurrentlyFastScrolling,
  addPendingFastScrollMount,
  removePendingFastScrollMount,
  recordScrollActivity,
  notifyImageUnmounted,
  scheduleScrollIdleMemoryTrim,
} from './Grid/gridScrollTracker';
import {
  TITLE_COLLATOR,
  isPlaceholderSynopsis,
  hasStoreSynopsis,
  getReleaseYear,
  globalAttemptedCoverLookups,
  clearAttemptedCoverLookups,
  clearFailedCoverUrls,
  getCoverCandidates,
  GridSortOption,
  GRID_SORT_STORAGE_KEY,
  GRID_RELEASE_YEAR_ORDER_STORAGE_KEY,
  isValidGridSortOption,
  loadPersistedGridSort,
  loadPersistedReleaseYearOrder,
  computeResponsiveColumnCount,
} from './Grid/gridCoverUtils';
import { GameCardCover } from './Grid/GameCardCover';
import { renderLibraryGridCard } from './Grid/LibraryGridCard';
import { renderGameHoverPopout } from './Grid/GameHoverPopout';
import { renderLibraryGridToolbar } from './Grid/LibraryGridToolbar';

export {
  GameCardCover,
  getCoverCandidates,
  clearAttemptedCoverLookups,
  clearFailedCoverUrls,
  isCurrentlyFastScrolling,
  addPendingFastScrollMount,
  removePendingFastScrollMount,
  recordScrollActivity,
  notifyImageUnmounted,
  scheduleScrollIdleMemoryTrim,
  GRID_SORT_STORAGE_KEY,
  GRID_RELEASE_YEAR_ORDER_STORAGE_KEY,
  isValidGridSortOption,
  loadPersistedGridSort,
  loadPersistedReleaseYearOrder,
};
export type { GridSortOption };

const HOVER_DELAY_MS = 400;

interface LibraryGridViewProps {
  games: CanonicalGame[];
  onSelectGame: (game: CanonicalGame) => void;
  searchQuery?: string;
  title?: string;
  subtitle?: string;
  groupIcon?: React.ReactNode;
  onClearGroupFilter?: () => void;
  activeFilter?: ActiveGameFilter | null;
  onClearActiveFilter?: () => void;
  connectedStorefronts?: StorefrontId[];
  onFixMatch?: (game: CanonicalGame) => void;
  onHideGame?: (game: CanonicalGame) => void;
  onSyncGameMedia?: (game: CanonicalGame) => void;
  collections?: GameCollection[];
  onToggleGameInCollection?: (collectionId: string, gameId: string) => void;
  onOpenManageCollectionsModal?: (game?: CanonicalGame) => void;
  onViewAchievements?: (game: CanonicalGame) => void;
  sortBy?: GridSortOption;
  onSortChange?: (sort: GridSortOption) => void;
  libraryFilterState?: LibraryFilterState;
  onUpdateLibraryFilterState?: (next: LibraryFilterState) => void;
  onResetLibraryFilterState?: () => void;
  libraryFilterIndex?: LibraryFilterIndex;
  unfilteredTotalCount?: number;
  isPreFiltered?: boolean;
}

interface IgdbCoverUpdatedDetail {
  title?: string;
  coverUrl?: string;
}

interface CriticUpdatedDetail {
  refreshedAll?: boolean;
  immediate?: boolean;
}

export const LibraryGridView: React.FC<LibraryGridViewProps> = ({
  games,
  onSelectGame,
  searchQuery,
  title,
  subtitle,
  groupIcon,
  onClearGroupFilter,
  activeFilter,
  onClearActiveFilter,
  connectedStorefronts,
  onFixMatch,
  onHideGame,
  onSyncGameMedia,
  collections,
  onToggleGameInCollection,
  onOpenManageCollectionsModal,
  onViewAchievements,
  sortBy: sortByProp,
  onSortChange,
  libraryFilterState,
  onUpdateLibraryFilterState,
  onResetLibraryFilterState,
  libraryFilterIndex,
  unfilteredTotalCount,
  isPreFiltered = false,
}) => {
  const gridContainerRef = useRef<HTMLDivElement | null>(null);

  // State index 0: contextMenu
  const [contextMenu, setContextMenu] = useState<{
    isOpen: boolean;
    x: number;
    y: number;
    game: CanonicalGame | null;
  }>({
    isOpen: false,
    x: 0,
    y: 0,
    game: null,
  });

  // State index 1: criticUpdateTick
  const [criticUpdateTick, setCriticUpdateTick] = useState(0);
  const interactionActiveRef = useRef(false);

  useEffect(() => {
    let criticThrottleTimer: ReturnType<typeof setTimeout> | null = null;
    const handleUpdate = (e?: Event) => {
      const detail = (e as CustomEvent<CriticUpdatedDetail | undefined> | undefined)?.detail;
      const isImmediate =
        Boolean(detail?.refreshedAll || detail?.immediate) ||
        Boolean(typeof process !== 'undefined' && process.env?.VITEST);
      if (isImmediate) {
        if (criticThrottleTimer) {
          clearTimeout(criticThrottleTimer);
          criticThrottleTimer = null;
        }
        setCriticUpdateTick((t) => t + 1);
        return;
      }
      if (!criticThrottleTimer) {
        const scheduleCriticFlush = (delayMs: number) => {
          criticThrottleTimer = setTimeout(() => {
            criticThrottleTimer = null;
            if (
              isCurrentlyFastScrolling() ||
              isUserActivelyScrolling() ||
              interactionActiveRef.current
            ) {
              scheduleCriticFlush(300);
              return;
            }
            setCriticUpdateTick((t) => t + 1);
          }, delayMs);
        };
        scheduleCriticFlush(450);
      }
    };

    const getLauncherGridSignature = () => {
      const running = launcherService
        .getRunningGames()
        .map((r) => `${r.gameId}:${r.platformId || ''}`)
        .sort()
        .join(',');
      const installed = launcherService
        .getInstalledRecords()
        .map(
          (i) => `${i.platformId}:${i.platformGameId || i.appId || ''}:${i.executablePath || ''}`
        )
        .sort()
        .join(',');
      return `${running}|${installed}`;
    };

    let prevSig = getLauncherGridSignature();
    window.addEventListener('antigravity_critic_updated', handleUpdate);
    const unsubLauncher = launcherService.subscribe(() => {
      const nextSig = getLauncherGridSignature();
      if (nextSig !== prevSig) {
        prevSig = nextSig;
        setCriticUpdateTick((t) => t + 1);
      }
    });
    return () => {
      if (criticThrottleTimer) {
        clearTimeout(criticThrottleTimer);
        criticThrottleTimer = null;
      }
      window.removeEventListener('antigravity_critic_updated', handleUpdate);
      unsubLauncher();
    };
  }, []);

  const connectedSet = useMemo(() => {
    if (connectedStorefronts !== undefined) {
      return new Set<StorefrontId>(connectedStorefronts);
    }
    try {
      const integrations = loadIntegrations();
      const connected = integrations.filter((i) => i.isConnected).map((i) => i.storefrontId);
      return new Set<StorefrontId>(connected);
    } catch {
      // Fallback
    }
    return new Set<StorefrontId>(['steam', 'gog', 'epic', 'xbox']);
  }, [connectedStorefronts]);

  // State index 2: hoveredGame (preserved for test harness state parity)
  const [hoveredGame, setHoveredGame] = useState<CanonicalGame | null>(null);
  interactionActiveRef.current = hoveredGame !== null || contextMenu.isOpen;
  const [hoverHeaderFailed, setHoverHeaderFailed] = useState<boolean>(false);
  const [previewPos, setPreviewPos] = useState<{ x: number; y: number; align: 'left' | 'right' }>({
    x: 0,
    y: 0,
    align: 'left',
  });

  useEffect(() => {
    setHoverHeaderFailed(false);
  }, [hoveredGame?.id]);

  useEffect(() => {
    return onlineLifecycleManager.onOnline(() => {
      clearFailedCoverUrls();
      setHoverHeaderFailed(false);
    });
  }, []);

  const [internalSortBy, setInternalSortBy] = useState<GridSortOption>(() =>
    sortByProp && isValidGridSortOption(sortByProp) ? sortByProp : loadPersistedGridSort()
  );

  useEffect(() => {
    if (sortByProp && isValidGridSortOption(sortByProp)) {
      setInternalSortBy(sortByProp);
    }
  }, [sortByProp]);

  const sortBy = sortByProp && isValidGridSortOption(sortByProp) ? sortByProp : internalSortBy;
  const hoverTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const popoutRef = useRef<HTMLDivElement | null>(null);
  const activeCardRef = useRef<HTMLDivElement | null>(null);
  const gamesRef = useRef(games);

  const [dynamicBlurb, setDynamicBlurb] = useState<{ id: string; blurb: string } | null>(null);
  const [coverOverrides, setCoverOverrides] = useState<Record<string, string | null>>({});

  const [overrideVersion, setOverrideVersion] = useState(0);
  useEffect(() => {
    const handleOverrideUpdate = (e?: Event) => {
      const detail = (e as CustomEvent<Record<string, unknown> | undefined> | undefined)?.detail;
      const eventType = typeof detail?.type === 'string' ? detail.type : undefined;
      if (
        eventType === 'confirmed-non-game' ||
        eventType === 'confirmed-non-game-batch' ||
        eventType === 'batch-confirmed-non-game' ||
        eventType === 'unconfirmed-non-game'
      ) {
        return;
      }
      const overrideObj =
        detail?.override && typeof detail.override === 'object'
          ? (detail.override as { gameId?: unknown })
          : undefined;
      const targetGameId =
        typeof detail?.gameId === 'string' && detail.gameId
          ? detail.gameId
          : typeof overrideObj?.gameId === 'string' && overrideObj.gameId
            ? overrideObj.gameId
            : undefined;
      if (targetGameId) {
        globalAttemptedCoverLookups.delete(targetGameId);
        const prefix = `${targetGameId}:`;
        for (const key of Array.from(globalAttemptedCoverLookups)) {
          if (key.startsWith(prefix)) {
            globalAttemptedCoverLookups.delete(key);
          }
        }
      } else {
        globalAttemptedCoverLookups.clear();
      }
      setOverrideVersion((v) => v + 1);
    };
    window.addEventListener('antigravity:user-override-updated', handleOverrideUpdate);
    return () => {
      window.removeEventListener('antigravity:user-override-updated', handleOverrideUpdate);
    };
  }, []);

  const [isFilterPanelOpen, setIsFilterPanelOpen] = useState(false);
  const [internalFilterState, setInternalFilterState] = useState<LibraryFilterState>(
    DEFAULT_LIBRARY_FILTER_STATE
  );
  const [releaseYearOrder, setReleaseYearOrder] = useState<'desc' | 'asc'>(() =>
    loadPersistedReleaseYearOrder()
  );
  const [gridLayoutMetrics, setGridLayoutMetrics] = useState<{
    scrollEl: HTMLElement | null;
    clientHeight: number;
    cols: number;
    rowHeight: number;
  }>({
    scrollEl: null,
    clientHeight: 0,
    cols: 6,
    rowHeight: 370,
  });

  useLayoutEffect(() => {
    const rootEl = gridContainerRef.current;
    if (!rootEl || typeof window === 'undefined') return undefined;
    const scrollEl =
      (typeof rootEl.closest === 'function'
        ? (rootEl.closest('main') as HTMLElement | null)
        : null) || rootEl.parentElement;
    if (!scrollEl) return undefined;

    const updateMetrics = () => {
      const clientHeight = scrollEl.clientHeight || 0;
      const viewportWidth = window.innerWidth || 1440;
      const cols = computeResponsiveColumnCount(viewportWidth);
      const containerWidth = Math.min(1600, rootEl.clientWidth || viewportWidth) - 48;
      const cardWidth = Math.max(140, (containerWidth - (cols - 1) * 16) / cols);
      const rowHeight = Math.max(260, Math.round(cardWidth * 1.5 + 56 + 16));
      setGridLayoutMetrics((prev) =>
        prev.scrollEl === scrollEl &&
        prev.clientHeight === clientHeight &&
        prev.cols === cols &&
        prev.rowHeight === rowHeight
          ? prev
          : { scrollEl, clientHeight, cols, rowHeight }
      );
    };

    updateMetrics();
    window.addEventListener('resize', updateMetrics, { passive: true });
    let resizeObserver: ResizeObserver | null = null;
    if (typeof ResizeObserver !== 'undefined') {
      resizeObserver = new ResizeObserver(updateMetrics);
      resizeObserver.observe(scrollEl);
    }
    return () => {
      window.removeEventListener('resize', updateMetrics);
      resizeObserver?.disconnect();
    };
  }, []);

  const effectiveFilterState = libraryFilterState ?? internalFilterState;
  const fallbackFilterIndex = useMemo(
    () => (libraryFilterIndex ? null : buildLibraryFilterIndex(games)),
    [libraryFilterIndex, games]
  );
  const effectiveFilterIndex = libraryFilterIndex ?? fallbackFilterIndex!;

  const handleUpdateFilterState = useCallback(
    (next: LibraryFilterState) => {
      setInternalFilterState(next);
      onUpdateLibraryFilterState?.(next);
    },
    [onUpdateLibraryFilterState]
  );

  const handleResetFilterState = useCallback(() => {
    setInternalFilterState(DEFAULT_LIBRARY_FILTER_STATE);
    onResetLibraryFilterState?.();
    onClearActiveFilter?.();
  }, [onResetLibraryFilterState, onClearActiveFilter]);

  const activeCriteriaCount = useMemo(
    () =>
      countActiveFilterCriteria(effectiveFilterState, {
        minYear: effectiveFilterIndex.minReleaseYear,
        maxYear: effectiveFilterIndex.maxReleaseYear,
      }),
    [effectiveFilterState, effectiveFilterIndex]
  );

  const activeFilterChips = useMemo(
    () => describeActiveFilterChips(effectiveFilterState, effectiveFilterIndex),
    [effectiveFilterState, effectiveFilterIndex]
  );

  const userOverridesMap = useMemo(() => loadUserOverrides(), [games, overrideVersion]);

  const handleNeedCoverLookup = useCallback((game: CanonicalGame) => {
    if (!onlineLifecycleManager.isOnline()) {
      const instant = igdbCoverService.getIgdbCoverInstant(game.title, game.steamAppId, game.id);
      if (instant) {
        setCoverOverrides((prev) =>
          prev[game.id] === instant ? prev : { ...prev, [game.id]: instant }
        );
      }
      return;
    }
    const targetAppId = steamMatcher.getEffectiveSteamAppId(game);
    const lookupKey = targetAppId ? `${game.id}:steam:${targetAppId}` : game.id;
    if (globalAttemptedCoverLookups.has(lookupKey)) return;
    globalAttemptedCoverLookups.add(lookupKey);

    const releaseYear = getReleaseYear(game, targetAppId);
    const isExplicitNonSteam = game.isExplicitNonSteam === true;

    const triggerIgdbLookup = () => {
      if (igdbCoverService.hasAttemptedIgdbCover(game.title, releaseYear)) {
        const instant = igdbCoverService.getIgdbCoverInstant(game.title, game.steamAppId, game.id);
        if (instant) {
          setCoverOverrides((prev) =>
            prev[game.id] === instant ? prev : { ...prev, [game.id]: instant }
          );
        }
        return;
      }

      igdbCoverService
        .fetchIgdbCover(game.title, releaseYear, undefined, { trackInGlobalBar: false })
        .then((resolvedCover) => {
          if (resolvedCover) {
            setCoverOverrides((prev) =>
              prev[game.id] === resolvedCover ? prev : { ...prev, [game.id]: resolvedCover }
            );
          }
        });
    };

    if (targetAppId && !isExplicitNonSteam) {
      steamApi
        .fetchStoreBrowseAssets(targetAppId)
        .then((assets) => {
          if (assets?.capsuleImage) {
            setCoverOverrides((prev) =>
              prev[game.id] === assets.capsuleImage!
                ? prev
                : { ...prev, [game.id]: assets.capsuleImage! }
            );
            return;
          }
          triggerIgdbLookup();
        })
        .catch(() => {
          triggerIgdbLookup();
        });
      return;
    }

    if (!targetAppId && !isExplicitNonSteam && !steamMatcher.hasAttemptedMatch(game.title)) {
      steamMatcher
        .matchGameToSteam(game.title, {
          releaseYear: game.releaseDate,
          developers: game.developers,
        })
        .then((matchedId) => {
          if (matchedId) {
            steamApi.fetchStoreBrowseAssets(matchedId).catch(() => null);
          }
        })
        .catch(() => null);
    }

    triggerIgdbLookup();
  }, []);

  useEffect(() => {
    const handleCoverUpdate = (e: Event) => {
      const detail = (e as CustomEvent<IgdbCoverUpdatedDetail | undefined>)?.detail;
      const titleVal = detail?.title;
      const coverUrl = detail?.coverUrl;
      if (titleVal && coverUrl) {
        setCoverOverrides((prev) => {
          const normTitle = normalizeKey(titleVal);
          let changed = false;
          let next: Record<string, string | null> | null = null;
          for (const g of gamesRef.current) {
            if (normalizeKey(g.title) === normTitle && prev[g.id] !== coverUrl) {
              if (!next) next = { ...prev };
              next[g.id] = coverUrl;
              changed = true;
            }
          }
          return changed && next ? next : prev;
        });
      }
    };
    window.addEventListener('antigravity:igdb-cover-updated', handleCoverUpdate);
    return () => {
      window.removeEventListener('antigravity:igdb-cover-updated', handleCoverUpdate);
    };
  }, []);

  useEffect(() => {
    gamesRef.current = games;
  }, [games]);

  const hoveredGameRef = useRef<CanonicalGame | null>(null);
  hoveredGameRef.current = hoveredGame;
  const contextMenuOpenRef = useRef<boolean>(false);
  contextMenuOpenRef.current = contextMenu.isOpen;
  const onSelectGameRef = useRef(onSelectGame);
  onSelectGameRef.current = onSelectGame;

  const startHoverForCard = useCallback((game: CanonicalGame, cardEl: HTMLDivElement) => {
    const currentHovered = hoveredGameRef.current;
    if (
      activeCardRef.current === cardEl &&
      (hoverTimeoutRef.current || currentHovered?.id === game.id)
    ) {
      return;
    }

    if (hoverTimeoutRef.current) clearTimeout(hoverTimeoutRef.current);

    if (currentHovered && currentHovered.id !== game.id) {
      setHoveredGame(null);
    }

    activeCardRef.current = cardEl;

    hoverTimeoutRef.current = setTimeout(() => {
      const currentRect = cardEl.getBoundingClientRect();
      const isRight = currentRect.right + 340 > window.innerWidth;
      setPreviewPos({
        x: isRight ? Math.max(12, currentRect.left - 330) : currentRect.right + 12,
        y: Math.max(80, Math.min(currentRect.top - 20, window.innerHeight - 440)),
        align: isRight ? 'right' : 'left',
      });
      setHoveredGame(game);
      hoverTimeoutRef.current = null;
    }, HOVER_DELAY_MS);
  }, []);

  // Fast auto-dismiss on scroll, wheel, window blur, or resize (zero 60-240 Hz mousemove layout thrashing)
  useEffect(() => {
    const handleDismiss = () => {
      if (hoverTimeoutRef.current) {
        clearTimeout(hoverTimeoutRef.current);
        hoverTimeoutRef.current = null;
      }
      setHoveredGame(null);
      activeCardRef.current = null;
    };

    const handleScrollOrWheel = (e: Event) => {
      handleDismiss();
      const target = e.target as HTMLElement | null;
      if (target && typeof target.scrollTop === 'number') {
        const key = target.tagName === 'MAIN' ? 'main' : 'sidebar';
        recordScrollActivity(target.scrollTop, key);
      } else {
        scheduleScrollIdleMemoryTrim();
      }
    };

    window.addEventListener('scroll', handleScrollOrWheel, true);
    window.addEventListener('wheel', handleScrollOrWheel, { passive: true });
    window.addEventListener('resize', handleDismiss, { passive: true });
    window.addEventListener('blur', handleDismiss);

    return () => {
      if (hoverTimeoutRef.current) {
        clearTimeout(hoverTimeoutRef.current);
        hoverTimeoutRef.current = null;
      }
      window.removeEventListener('scroll', handleScrollOrWheel, true);
      window.removeEventListener('wheel', handleScrollOrWheel);
      window.removeEventListener('resize', handleDismiss);
      window.removeEventListener('blur', handleDismiss);
    };
  }, []);

  // Live dynamic blurb fetching for newly synced games without a cached description
  useEffect(() => {
    if (!hoveredGame) return;
    const targetAppId = steamMatcher.getEffectiveSteamAppId(hoveredGame);
    if (!targetAppId) return;

    if (!hasStoreSynopsis(hoveredGame, targetAppId)) {
      let active = true;
      steamApi.fetchGameMetadata(targetAppId).then((meta) => {
        const plainBlurb = stripHtmlToPlainSynopsis(meta?.shortDescription, 280);
        if (active && plainBlurb && !isPlaceholderSynopsis(plainBlurb, hoveredGame.title)) {
          setDynamicBlurb({ id: hoveredGame.id, blurb: plainBlurb });
        }
      });
      return () => {
        active = false;
      };
    }
    return undefined;
  }, [hoveredGame?.id]);

  const handleSortChange = useCallback(
    (newSort: GridSortOption) => {
      setInternalSortBy(newSort);
      try {
        if (typeof window !== 'undefined' && window.localStorage) {
          window.localStorage.setItem(GRID_SORT_STORAGE_KEY, newSort);
        }
      } catch {
        // ignore storage errors
      }
      onSortChange?.(newSort);
      if (gridContainerRef.current?.parentElement) {
        gridContainerRef.current.parentElement.scrollTop = 0;
      }
    },
    [onSortChange]
  );

  const liveCriticMemoMap = useMemo(
    () => new Map<string, OpenCriticData | null>(),
    [effectiveFilterIndex, criticUpdateTick, overrideVersion]
  );

  const resolveGameCriticData = useCallback(
    (game: CanonicalGame): OpenCriticData | null => {
      if (liveCriticMemoMap.has(game.id)) {
        return liveCriticMemoMap.get(game.id) ?? null;
      }
      const indexedEntry = effectiveFilterIndex.entriesById.get(game.id);
      if (criticUpdateTick === 0 && overrideVersion === 0 && indexedEntry) {
        liveCriticMemoMap.set(game.id, indexedEntry.criticData);
        return indexedEntry.criticData;
      }
      const targetSteamId =
        indexedEntry?.effectiveSteamAppId ?? steamMatcher.getEffectiveSteamAppId(game);
      const oc = getOpenCriticData(
        targetSteamId || undefined,
        game.title,
        game.reviewSummary?.positivePercent,
        undefined,
        undefined,
        false,
        true
      );
      liveCriticMemoMap.set(game.id, oc);
      return oc;
    },
    [effectiveFilterIndex, criticUpdateTick, overrideVersion, liveCriticMemoMap]
  );

  const ratingSortTick = sortBy === 'rating' ? criticUpdateTick : 0;

  const sortedGames = useMemo(() => {
    const seenIds = new Set<string>();
    const uniqueGames: CanonicalGame[] = [];
    for (const g of games) {
      if (!g || !g.id || seenIds.has(g.id)) continue;
      seenIds.add(g.id);
      uniqueGames.push(g);
    }
    const filteredUniqueGames = isPreFiltered
      ? uniqueGames
      : evaluateLibraryFilter(uniqueGames, effectiveFilterIndex, effectiveFilterState);

    if (sortBy === 'rating') {
      const decorated = new Array<{ game: CanonicalGame; score: number; rec: number }>(
        filteredUniqueGames.length
      );
      for (let i = 0; i < filteredUniqueGames.length; i++) {
        const g = filteredUniqueGames[i];
        const oc = resolveGameCriticData(g);
        decorated[i] = {
          game: g,
          score: oc?.score ?? -1,
          rec: oc?.percentRecommended ?? -1,
        };
      }
      decorated.sort((a, b) => {
        if (b.score !== a.score) return b.score - a.score;
        if (b.rec !== a.rec) return b.rec - a.rec;
        return TITLE_COLLATOR.compare(a.game.title, b.game.title);
      });
      return decorated.map((d) => d.game);
    }

    return filteredUniqueGames.sort((a, b) => {
      if (sortBy === 'playtime') {
        const ptA = a.platforms.reduce((acc, p) => acc + (p.playtimeMinutes || 0), 0);
        const ptB = b.platforms.reduce((acc, p) => acc + (p.playtimeMinutes || 0), 0);
        return ptB - ptA;
      }
      if (sortBy === 'recent') {
        const getRecentMs = (g: CanonicalGame) => {
          let maxMs = 0;
          for (const p of g.platforms) {
            const ms = parseTimestampMs(p.lastPlayed);
            if (ms && ms > maxMs) maxMs = ms;
          }
          return maxMs;
        };
        return getRecentMs(b) - getRecentMs(a);
      }
      if (sortBy === 'release_year') {
        const yearA =
          effectiveFilterIndex.entriesById.get(a.id)?.releaseYear ??
          (Number(getReleaseYear(a, steamMatcher.getEffectiveSteamAppId(a))) || null);
        const yearB =
          effectiveFilterIndex.entriesById.get(b.id)?.releaseYear ??
          (Number(getReleaseYear(b, steamMatcher.getEffectiveSteamAppId(b))) || null);
        if (yearA === null && yearB !== null) return 1;
        if (yearA !== null && yearB === null) return -1;
        if (yearA !== null && yearB !== null && yearA !== yearB) {
          return releaseYearOrder === 'asc' ? yearA - yearB : yearB - yearA;
        }
        return TITLE_COLLATOR.compare(a.title, b.title);
      }
      return TITLE_COLLATOR.compare(a.title, b.title);
    });
  }, [
    games,
    sortBy,
    releaseYearOrder,
    overrideVersion,
    ratingSortTick,
    resolveGameCriticData,
    effectiveFilterIndex,
    effectiveFilterState,
    isPreFiltered,
  ]);

  const handleMouseEnter = useCallback(
    (game: CanonicalGame, e: React.MouseEvent<HTMLDivElement>) => {
      if (isUserActivelyScrolling() || isCurrentlyFastScrolling()) return;
      startHoverForCard(game, e.currentTarget);
    },
    [startHoverForCard]
  );

  const handleCardMouseLeave = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    if (hoverTimeoutRef.current) {
      clearTimeout(hoverTimeoutRef.current);
      hoverTimeoutRef.current = null;
    }

    const nextEl = e.relatedTarget as Node | null;
    if (popoutRef.current && nextEl && popoutRef.current.contains(nextEl)) {
      return;
    }

    setHoveredGame(null);
    activeCardRef.current = null;
  }, []);

  const handleCardContextMenu = useCallback((game: CanonicalGame, e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setHoveredGame(null);
    if (hoverTimeoutRef.current) {
      clearTimeout(hoverTimeoutRef.current);
      hoverTimeoutRef.current = null;
    }
    setContextMenu({
      isOpen: true,
      x: e.clientX,
      y: e.clientY,
      game,
    });
  }, []);

  const handlePopoutMouseLeave = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    if (hoverTimeoutRef.current) {
      clearTimeout(hoverTimeoutRef.current);
      hoverTimeoutRef.current = null;
    }

    const nextEl = e.relatedTarget as Node | null;
    if (activeCardRef.current && nextEl && activeCardRef.current.contains(nextEl)) {
      return;
    }

    setHoveredGame(null);
    activeCardRef.current = null;
  }, []);

  const handleDismissContextMenu = useCallback(() => {
    setContextMenu((prev) => ({ ...prev, isOpen: false, game: null }));
  }, []);

  const renderedCardsGrid = useMemo(() => {
    void criticUpdateTick;
    const gridRowClass =
      'grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 2xl:grid-cols-7 gap-4';

    const renderCard = (game: CanonicalGame, idx: number) =>
      renderLibraryGridCard({
        game,
        idx,
        sortBy,
        userOverridesMap,
        coverOverrides,
        connectedSet,
        effectiveFilterIndex,
        contextMenuOpenRef,
        onDismissContextMenu: handleDismissContextMenu,
        onSelectGame: (selected) => onSelectGameRef.current(selected),
        onNeedCoverLookup: handleNeedCoverLookup,
        onMouseEnter: handleMouseEnter,
        onMouseLeave: handleCardMouseLeave,
        onContextMenu: handleCardContextMenu,
        resolveGameCriticData,
      });

    if (
      sortedGames.length > 80 &&
      gridLayoutMetrics.scrollEl &&
      gridLayoutMetrics.clientHeight > 0
    ) {
      return (
        <VirtualGridRows
          items={sortedGames}
          scrollElement={gridLayoutMetrics.scrollEl}
          columnCount={gridLayoutMetrics.cols}
          estimatedRowHeight={gridLayoutMetrics.rowHeight}
          rowClassName={gridRowClass}
          renderCard={renderCard}
        />
      );
    }

    const isInitialPreMountLargeCatalog =
      sortedGames.length > 80 &&
      !gridLayoutMetrics.scrollEl &&
      typeof window !== 'undefined' &&
      (window.innerHeight || 0) > 0 &&
      !(typeof process !== 'undefined' && process.env?.VITEST);
    const nonVirtualItems = isInitialPreMountLargeCatalog
      ? sortedGames.slice(0, computeResponsiveColumnCount(window.innerWidth || 1440) * 6)
      : sortedGames;

    return (
      <div className={gridRowClass}>
        {nonVirtualItems.map((game, idx) => renderCard(game, idx))}
      </div>
    );
  }, [
    sortedGames,
    sortBy,
    releaseYearOrder,
    userOverridesMap,
    coverOverrides,
    connectedSet,
    effectiveFilterIndex,
    resolveGameCriticData,
    criticUpdateTick,
    gridLayoutMetrics,
    handleDismissContextMenu,
    handleNeedCoverLookup,
    handleMouseEnter,
    handleCardMouseLeave,
    handleCardContextMenu,
  ]);

  return useMemo(
    () => (
    <div
      ref={gridContainerRef}
      className="w-full min-h-full bg-[#0e141b] text-steam-text pb-28 relative select-none"
    >
      {/* Background ambient lighting */}
      <div className="absolute top-0 left-1/2 -translate-x-1/2 w-full max-w-[1600px] h-96 bg-[radial-gradient(ellipse_at_top,_rgba(102,192,244,0.12),_transparent_70%)] pointer-events-none opacity-60 z-0" />

      <div className="max-w-[1600px] mx-auto px-6 pt-6 space-y-6 relative">
        {renderLibraryGridToolbar({
          title,
          subtitle,
          groupIcon,
          sortedCount: sortedGames.length,
          unfilteredTotalCount: unfilteredTotalCount ?? games.length,
          activeFilter,
          onClearActiveFilter,
          onClearGroupFilter,
          activeCriteriaCount,
          activeFilterChips,
          isFilterPanelOpen,
          onToggleFilterPanel: () => setIsFilterPanelOpen((prev) => !prev),
          onCloseFilterPanel: () => setIsFilterPanelOpen(false),
          effectiveFilterState,
          effectiveFilterIndex,
          onUpdateFilterState: handleUpdateFilterState,
          onResetFilterState: handleResetFilterState,
          sortBy,
          onSortChange: handleSortChange,
          releaseYearOrder,
          onChangeReleaseYearOrder: setReleaseYearOrder,
        })}

        {/* Search status notice if filtering */}
        {searchQuery && (
          <div className="text-xs text-steam-subtext flex items-center gap-2">
            <span>Showing results for</span>
            <span className="text-white font-semibold bg-white/10 px-2 py-0.5 rounded">
              &quot;{searchQuery}&quot;
            </span>
            <span>({sortedGames.length} matching)</span>
          </div>
        )}

        {/* Empty State */}
        {sortedGames.length === 0 && (
          <div className="py-20 text-center flex flex-col items-center justify-center gap-3 bg-[#16202d]/50 rounded-lg border border-steam-border/60 p-8">
            <Layers aria-hidden="true" className="w-12 h-12 text-steam-subtext/70" />
            <h3 className="text-base font-bold text-white">
              {title ? `No games in "${title}"` : 'No games found'}
            </h3>
            <p className="text-xs text-steam-subtext max-w-sm">
              {title
                ? `You have not assigned any titles to the "${title}" collection yet. You can add games from the sidebar or any game detail page.`
                : 'No titles match your current filter or search criteria. Try clearing search or switching platforms.'}
            </p>
            {(activeFilter && onClearActiveFilter) || activeCriteriaCount > 0 ? (
              <button
                type="button"
                onClick={handleResetFilterState}
                className="min-h-6 mt-2 inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded bg-steam-accent text-black font-semibold text-xs hover:brightness-110 transition-all shadow cursor-pointer"
              >
                <X aria-hidden="true" className="w-3.5 h-3.5" />
                <span>Clear Filter &amp; View All Games</span>
              </button>
            ) : onClearGroupFilter ? (
              <button
                type="button"
                onClick={onClearGroupFilter}
                className="min-h-6 mt-2 inline-flex items-center gap-1.5 px-3 py-1.5 rounded bg-steam-accent text-black font-semibold text-xs hover:brightness-110 transition-all shadow cursor-pointer"
              >
                <span>View All Games</span>
              </button>
            ) : null}
          </div>
        )}

        {/* Game Covers Grid (Aspect Ratio ~2:3 Portrait Posters) */}
        {renderedCardsGrid}
      </div>

      {/* Floating Hover Preview Pane (Steam Popover Style) */}
      {hoveredGame &&
        renderGameHoverPopout({
          hoveredGame,
          previewPos,
          popoutRef,
          userOverridesMap,
          connectedSet,
          dynamicBlurb,
          hoverHeaderFailed,
          onSetHoverHeaderFailed: setHoverHeaderFailed,
          onPopoutMouseEnter: () => {
            if (hoverTimeoutRef.current) {
              clearTimeout(hoverTimeoutRef.current);
              hoverTimeoutRef.current = null;
            }
          },
          onPopoutMouseLeave: handlePopoutMouseLeave,
          onSelectGame,
          onContextMenu: handleCardContextMenu,
        })}

      {/* Branching Game Context Menu */}
      <GameContextMenu
        isOpen={contextMenu.isOpen}
        x={contextMenu.x}
        y={contextMenu.y}
        game={contextMenu.game}
        collections={collections || []}
        onClose={handleDismissContextMenu}
        onFixMatch={(game) => {
          if (onFixMatch) onFixMatch(game);
        }}
        onSyncStoreMedia={(game) => {
          if (onSyncGameMedia) onSyncGameMedia(game);
        }}
        onToggleCollection={(colId, gameId) => {
          if (onToggleGameInCollection) onToggleGameInCollection(colId, gameId);
        }}
        onManageCollections={(game) => {
          if (onOpenManageCollectionsModal) onOpenManageCollectionsModal(game);
        }}
        onViewAchievements={(game) => {
          if (onViewAchievements) onViewAchievements(game);
        }}
        onHideGame={
          onHideGame
            ? (game) => {
                setHoveredGame(null);
                onHideGame(game);
              }
            : undefined
        }
      />
    </div>
    ),
    [
      games,
      onSelectGame,
      searchQuery,
      title,
      subtitle,
      groupIcon,
      onClearGroupFilter,
      activeFilter,
      onClearActiveFilter,
      onFixMatch,
      onHideGame,
      onSyncGameMedia,
      collections,
      onToggleGameInCollection,
      onOpenManageCollectionsModal,
      onViewAchievements,
      unfilteredTotalCount,
      sortedGames,
      activeCriteriaCount,
      activeFilterChips,
      isFilterPanelOpen,
      effectiveFilterState,
      effectiveFilterIndex,
      handleUpdateFilterState,
      handleResetFilterState,
      sortBy,
      handleSortChange,
      releaseYearOrder,
      renderedCardsGrid,
      hoveredGame,
      previewPos,
      userOverridesMap,
      connectedSet,
      dynamicBlurb,
      hoverHeaderFailed,
      handlePopoutMouseLeave,
      handleCardContextMenu,
      contextMenu,
      handleDismissContextMenu,
    ]
  );
};
