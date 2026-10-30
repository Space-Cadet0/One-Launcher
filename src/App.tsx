import {
  useState,
  useMemo,
  useEffect,
  useRef,
  useCallback,
  useDeferredValue,
  startTransition,
  lazy,
  Suspense,
} from 'react';
import { CanonicalGame } from './contracts/game';
import { StorefrontId } from './contracts/platform';
import {
  ActiveGameFilter,
  LibraryFilterState,
  DEFAULT_LIBRARY_FILTER_STATE,
  activeGameFilterToLibraryFilterState,
} from './contracts/filter';
import type {
  EnvironmentComponentId,
  SetupWizardOpenMode,
  SetupWizardStepId,
} from './contracts/environmentSetup';
import { TopNavBar } from './components/Navigation/TopNavBar';
import { GlobalSyncProgressBar } from './components/Navigation/GlobalSyncProgressBar';
import { LibrarySidebar } from './components/Library/LibrarySidebar';
import {
  LibraryGridView,
  GridSortOption,
  loadPersistedGridSort,
} from './components/Library/LibraryGridView';
import { CollectionIcon } from './components/Common/CollectionIcon';
import { InGameHibernationView } from './components/Launcher/InGameHibernationView';
import { markScrollActivity } from './utils/scrollActivityTracker';
import { matchesLooseSearchQuery } from './services/common/titleUtils';
import { getUserOverrideForGame } from './services/storage/userOverrideStorage';
import {
  loadIntegrations,
  loadCurrentCatalog,
  saveCurrentCatalog,
  hydrateCatalogFromIndexedDb,
  reconcileCatalogGamesWithInstalledRecords,
  mergeUpdatedGamePreservingLivePlatformState,
  mergeHydratedCatalogPreservingLiveState,
} from './services/integrations/integrationStorage';
import { matchesGameFilter } from './services/filter/gameFilterService';
import {
  buildLibraryFilterIndex,
  evaluateLibraryFilter,
} from './services/filter/libraryFilterIndex';
import { launcherService } from './services/launcher/launcherService';
import {
  environmentSetupService,
  getRemovedComponents,
  OPEN_SYSTEM_SETUP_EVENT,
  shouldAutoOpenSetupWizardOnStartup,
  type OpenSystemSetupEventDetail,
} from './services/launcher/environmentSetupService';
import { useNavigationHistory } from './hooks/useNavigationHistory';
import { useCriticScoreWarmup } from './hooks/useCriticScoreWarmup';
import { useCollectionsManager } from './hooks/useCollectionsManager';
import { useSyncNotice } from './hooks/useSyncNotice';
import { useLauncherHibernationState } from './hooks/useLauncherHibernationState';
import { usePostSessionReconciler } from './hooks/usePostSessionReconciler';
import { useCatalogOverrideSync } from './hooks/useCatalogOverrideSync';
import { useLocalInstallSync } from './hooks/useLocalInstallSync';
import { useBackgroundMediaWarmup } from './hooks/useBackgroundMediaWarmup';
import { useManualLibrarySyncActions } from './hooks/useManualLibrarySyncActions';
import { AlertTriangle, CheckCircle2, Layers, Sliders } from 'lucide-react';

import { SteamStorePage } from './components/SteamStoreDetail/SteamStorePage';

export { InGameHibernationView };

const ManageCollectionsModal = lazy(() =>
  import('./components/Library/ManageCollectionsModal').then((m) => ({
    default: m.ManageCollectionsModal,
  }))
);
const IntegrationsModal = lazy(() =>
  import('./components/Navigation/IntegrationsModal').then((m) => ({
    default: m.IntegrationsModal,
  }))
);
const loadFixMatchWizardModal = () =>
  import('./components/Library/FixMatchWizardModal').then((m) => ({
    default: m.FixMatchWizardModal,
  }));
const loadLibraryMatchManagerModal = () =>
  import('./components/Library/LibraryMatchManagerModal').then((m) => ({
    default: m.LibraryMatchManagerModal,
  }));
const FixMatchWizardModal = lazy(loadFixMatchWizardModal);
const LibraryMatchManagerModal = lazy(loadLibraryMatchManagerModal);
const GameAchievementsModal = lazy(() =>
  import('./components/Achievements/GameAchievementsModal').then((m) => ({
    default: m.GameAchievementsModal,
  }))
);
const DownloadManagerDrawer = lazy(() =>
  import('./components/Launcher/DownloadManagerDrawer').then((m) => ({
    default: m.DownloadManagerDrawer,
  }))
);
const loadSystemSetupWizardModal = () =>
  import('./components/Launcher/SystemSetupWizard/SystemSetupWizardModal').then((m) => ({
    default: m.SystemSetupWizardModal,
  }));
const SystemSetupWizardModal = lazy(loadSystemSetupWizardModal);

function areShallowValuesEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (!Object.is(a[i], b[i])) return false;
    }
    return true;
  }
  return false;
}

function areShallowRecordsEqual(
  a: Record<string, unknown>,
  b: Record<string, unknown>
): boolean {
  if (a === b) return true;
  const keysA = Object.keys(a);
  const keysB = Object.keys(b);
  for (let i = 0; i < keysA.length; i++) {
    const k = keysA[i];
    const valA = a[k];
    if (valA === undefined) continue;
    if (!(k in b) || !areShallowValuesEqual(valA, b[k])) return false;
  }
  for (let i = 0; i < keysB.length; i++) {
    const k = keysB[i];
    if (b[k] !== undefined && a[k] === undefined) return false;
  }
  return true;
}

function isCanonicalGameMateriallyUnchanged(prev: CanonicalGame, next: CanonicalGame): boolean {
  if (prev === next) return true;
  const prevRec = prev as unknown as Record<string, unknown>;
  const nextRec = next as unknown as Record<string, unknown>;
  const keys = new Set([...Object.keys(prevRec), ...Object.keys(nextRec)]);

  for (const key of keys) {
    const valPrev = prevRec[key];
    const valNext = nextRec[key];
    if (Object.is(valPrev, valNext)) continue;

    if (
      key === 'enrichedMetadata' &&
      valPrev &&
      valNext &&
      typeof valPrev === 'object' &&
      typeof valNext === 'object'
    ) {
      if (
        areShallowRecordsEqual(
          valPrev as Record<string, unknown>,
          valNext as Record<string, unknown>
        )
      ) {
        continue;
      }
      return false;
    }

    if (key === 'platforms' && Array.isArray(valPrev) && Array.isArray(valNext)) {
      if (valPrev.length !== valNext.length) return false;
      let allSame = true;
      for (let i = 0; i < valPrev.length; i++) {
        const pPrev = valPrev[i];
        const pNext = valNext[i];
        if (
          pPrev !== pNext &&
          (!pPrev ||
            !pNext ||
            typeof pPrev !== 'object' ||
            typeof pNext !== 'object' ||
            !areShallowRecordsEqual(
              pPrev as Record<string, unknown>,
              pNext as Record<string, unknown>
            ))
        ) {
          allSame = false;
          break;
        }
      }
      if (allSame) continue;
      return false;
    }

    if (areShallowValuesEqual(valPrev, valNext)) continue;
    return false;
  }

  return true;
}

export function App() {
  const [games, setGames] = useState<CanonicalGame[]>(() => {
    const saved = localStorage.getItem('universal_game_library_catalog');
    if (saved) {
      try {
        const loaded = loadCurrentCatalog();
        if (Array.isArray(loaded) && loaded.length > 0) {
          return loaded.map((g: CanonicalGame) => ({
            ...g,
            platforms: g.platforms.map((p) => ({
              ...p,
              installed: Boolean(p.installed || launcherService.isGameInstalled(g, p.platformId)),
            })),
          }));
        }
      } catch (e) {
        console.error('Failed to parse cached games:', e);
      }
    }
    return [];
  });

  const gamesLatestRef = useRef<CanonicalGame[]>(games);
  gamesLatestRef.current = games;

  const mainContentRef = useRef<HTMLElement | null>(null);

  const getCurrentScroll = useCallback((): number => {
    if (!mainContentRef.current) return 0;
    if (mainContentRef.current.scrollTop > 0) return mainContentRef.current.scrollTop;
    const child = mainContentRef.current.firstElementChild as HTMLElement | null;
    if (child && child.scrollTop > 0) return child.scrollTop;
    return 0;
  }, []);

  const {
    currentEntry,
    canGoBack,
    backTitle,
    canGoForward,
    forwardTitle,
    pushEntry,
    goBack,
    goForward,
    saveCurrentScroll,
    getLastAllGamesScrollY,
  } = useNavigationHistory(
    {
      view: 'grid',
      selectedGameId: null,
      activeFilter: null,
      activeGroupId: null,
      title: 'All Games',
      scrollY: 0,
    },
    getCurrentScroll
  );

  const isGridView = currentEntry.view === 'grid';
  const activeGroupId = currentEntry.activeGroupId;
  const activeFilter = currentEntry.activeFilter;
  const [gridSortBy, setGridSortBy] = useState<GridSortOption>(() => loadPersistedGridSort());
  const [isCatalogVaultHydrated, setIsCatalogVaultHydrated] = useState<boolean>(false);

  const selectedGame = useMemo(() => {
    if (!currentEntry.selectedGameId) {
      return games[0] || null;
    }
    const targetId = currentEntry.selectedGameId;
    const directMatch = games.find((g) => g.id === targetId);
    if (directMatch) return directMatch;

    const platformMatch = games.find((g) =>
      g.platforms?.some(
        (p) =>
          `${p.platformId}-${p.platformGameId}` === targetId ||
          String(p.platformGameId) === targetId
      )
    );
    if (platformMatch) return platformMatch;

    if (currentEntry.title) {
      const normTitle = currentEntry.title.toLowerCase().trim();
      const titleMatch = games.find(
        (g) =>
          g.title.toLowerCase().trim() === normTitle ||
          (g.originalStoreTitle && g.originalStoreTitle.toLowerCase().trim() === normTitle)
      );
      if (titleMatch) return titleMatch;
    }

    return games[0] || null;
  }, [games, currentEntry.selectedGameId, currentEntry.title]);

  useEffect(() => {
    const targetScrollY = currentEntry.scrollY ?? 0;
    let attempts = 0;
    const maxAttempts = 10;

    const applyScroll = () => {
      if (!mainContentRef.current) return;
      mainContentRef.current.scrollTop = targetScrollY;
      const child = mainContentRef.current.firstElementChild as HTMLElement | null;
      if (child && child.scrollHeight > child.clientHeight) {
        child.scrollTop = targetScrollY;
      }
      attempts++;
      const currentY = mainContentRef.current.scrollTop || child?.scrollTop || 0;
      if (targetScrollY > 0 && Math.abs(currentY - targetScrollY) > 5 && attempts < maxAttempts) {
        requestAnimationFrame(applyScroll);
      }
    };

    applyScroll();
    const rafId = requestAnimationFrame(applyScroll);
    const t1 = setTimeout(applyScroll, 30);
    const t2 = setTimeout(applyScroll, 80);
    const t3 = setTimeout(applyScroll, 150);

    return () => {
      cancelAnimationFrame(rafId);
      clearTimeout(t1);
      clearTimeout(t2);
      clearTimeout(t3);
    };
  }, [currentEntry.id]);

  const navigateSelectGame = useCallback(
    (gameOrId: CanonicalGame | string) => {
      const resolved =
        typeof gameOrId === 'string'
          ? gamesLatestRef.current.find((g) => g.id === gameOrId) || {
              id: gameOrId,
              title: gameOrId,
            }
          : gameOrId;
      pushEntry({
        view: 'game',
        selectedGameId: resolved.id,
        activeFilter: null,
        activeGroupId: null,
        title: resolved.title,
      });
    },
    [pushEntry]
  );

  const [libraryFilterState, setLibraryFilterState] = useState<LibraryFilterState>(
    DEFAULT_LIBRARY_FILTER_STATE
  );
  const deferredLibraryFilterState = useDeferredValue(libraryFilterState);

  const navigateApplyFilter = useCallback(
    (filter: ActiveGameFilter) => {
      setLibraryFilterState((prev) => activeGameFilterToLibraryFilterState(filter, prev, false));
      pushEntry({
        view: 'grid',
        selectedGameId: selectedGame?.id || null,
        activeFilter: filter,
        activeGroupId: null,
        title: `${filter.label}: ${filter.value}`,
      });
    },
    [pushEntry, selectedGame?.id]
  );

  const navigateHome = useCallback(() => {
    pushEntry({
      view: 'grid',
      selectedGameId: selectedGame?.id || null,
      activeFilter: null,
      activeGroupId: null,
      title: 'All Games',
      scrollY: getLastAllGamesScrollY(),
    });
  }, [getLastAllGamesScrollY, pushEntry, selectedGame?.id]);

  const {
    collections,
    isManageCollectionsOpen,
    collectionModalGame,
    handleOpenManageCollections,
    handleCloseManageCollections,
    handleCreateCollection,
    handleRenameCollection,
    handleDeleteCollection,
    handleToggleGameInCollection,
    handleReorderCollections,
  } = useCollectionsManager();

  const navigateSelectGroup = useCallback(
    (groupId: string | null) => {
      if (!groupId) {
        navigateHome();
        return;
      }
      const colName =
        groupId === 'uncategorized'
          ? 'Uncategorized'
          : collections.find((c) => c.id === groupId)?.name || 'Collection';
      pushEntry({
        view: 'grid',
        selectedGameId: selectedGame?.id || null,
        activeFilter: null,
        activeGroupId: groupId,
        title: colName,
      });
    },
    [collections, navigateHome, pushEntry, selectedGame?.id]
  );

  const navigateClearFilter = useCallback(() => {
    setLibraryFilterState(DEFAULT_LIBRARY_FILTER_STATE);
    pushEntry({
      view: 'grid',
      selectedGameId: selectedGame?.id || null,
      activeFilter: null,
      activeGroupId: activeGroupId,
      title: activeGroupId
        ? collections.find((c) => c.id === activeGroupId)?.name || 'Collection'
        : 'All Games',
    });
  }, [activeGroupId, collections, pushEntry, selectedGame?.id]);

  const [searchQuery, setSearchQuery] = useState('');
  const [selectedPlatform, setSelectedPlatform] = useState<StorefrontId | 'all'>('all');
  const [installedOnly, setInstalledOnly] = useState(false);
  const [isSyncingAllMedia, setIsSyncingAllMedia] = useState(false);
  const [gameRefreshKey, setGameRefreshKey] = useState(0);

  const { syncNotice, syncNoticeTone, showSyncNotice } = useSyncNotice();
  const { isHibernating, runningGames, resumeFullUi } = useLauncherHibernationState();

  const {
    isFixMatchModalOpen,
    setIsFixMatchModalOpen,
    fixMatchGame,
    setFixMatchGame,
    isMatchManagerOpen,
    setIsMatchManagerOpen,
    handleOpenFixMatch,
    handleApplyOverride,
    handleResetOverride,
    handleHideGame,
    handleUnhideEntry,
  } = useCatalogOverrideSync({
    selectedGame,
    isGridView,
    navigateHome,
    gamesRef: gamesLatestRef,
    setGames,
    setGameRefreshKey,
    showSyncNotice,
  });

  const [isIntegrationsModalOpen, setIsIntegrationsModalOpen] = useState(false);
  const [isAchievementsModalOpen, setIsAchievementsModalOpen] = useState(false);
  const [achievementsModalGame, setAchievementsModalGame] = useState<CanonicalGame | null>(null);
  const [achievementsInitialStorefrontId, setAchievementsInitialStorefrontId] = useState<
    StorefrontId | undefined
  >(undefined);
  const [isDownloadDrawerOpen, setIsDownloadDrawerOpen] = useState(false);
  const [isSystemSetupOpen, setIsSystemSetupOpen] = useState(false);
  const [systemSetupMode, setSystemSetupMode] = useState<SetupWizardOpenMode>('health_check');
  const [systemSetupInitialStep, setSystemSetupInitialStep] = useState<
    SetupWizardStepId | undefined
  >(undefined);
  const [systemSetupFocusComponent, setSystemSetupFocusComponent] = useState<
    EnvironmentComponentId | undefined
  >(undefined);
  const [systemSetupAlertCount, setSystemSetupAlertCount] = useState<number>(
    () => environmentSetupService.getLastSnapshot()?.counts.removedSinceLastSetupCount || 0
  );
  const hasCheckedStartupWizardRef = useRef(false);
  const setupSessionBaselineSigRef = useRef<string>('');

  const lastExplicitlySavedCatalogRef = useRef<CanonicalGame[] | null>(null);
  const prevCommittedCatalogRef = useRef<CanonicalGame[]>(games);

  // Persist catalog state in commit phase (never inside pure setGames updaters)
  useEffect(() => {
    const prev = prevCommittedCatalogRef.current;
    prevCommittedCatalogRef.current = games;

    if (games.length === 0) return;
    if (lastExplicitlySavedCatalogRef.current === games) {
      return;
    }

    try {
      if (prev.length === games.length && prev !== games) {
        const dirtyIds: string[] = [];
        let orderPreserved = true;
        for (let i = 0; i < games.length; i++) {
          if (prev[i].id !== games[i].id) {
            orderPreserved = false;
            break;
          }
          if (prev[i] !== games[i]) {
            dirtyIds.push(games[i].id);
          }
        }
        if (orderPreserved) {
          if (dirtyIds.length === 0) return;
          if (dirtyIds.length < games.length) {
            saveCurrentCatalog(games, { skipSanitize: true, dirtyGameIds: dirtyIds });
            return;
          }
        }
      }
      saveCurrentCatalog(games, { skipSanitize: true });
    } catch {}
  }, [games]);

  const overlayLauncherInstalledState = useCallback((catalog: CanonicalGame[]): CanonicalGame[] => {
    const records = launcherService.getInstalledRecords();
    const authoritative = launcherService.hasAuthoritativeInstallScan();
    if (!authoritative && records.length === 0) return catalog;
    return reconcileCatalogGamesWithInstalledRecords(catalog, records, {
      authoritativeRemoval: authoritative,
      getHasCustomExe: (gameId, platformId) =>
        Boolean(launcherService.getLaunchConfig(gameId, platformId)?.customExecutablePath),
    });
  }, []);

  // Hydrate full catalog from IndexedDB vault when IndexedDB holds richer/overflow records
  useEffect(() => {
    let cancelled = false;
    hydrateCatalogFromIndexedDb()
      .then((hydrated) => {
        if (!cancelled && hydrated && hydrated.length > 0) {
          const prev = gamesLatestRef.current;
          const shouldUpgradeFromVault =
            hydrated.length >= prev.length ||
            prev.some((g) => !g.detailedDescription && !g.enrichedMetadata?.screenshots?.length);
          if (!shouldUpgradeFromVault) return;
          const merged = mergeHydratedCatalogPreservingLiveState(prev, hydrated);
          const next = overlayLauncherInstalledState(merged);
          gamesLatestRef.current = next;
          setGames(next);
        }
      })
      .catch(() => {})
      .finally(() => {
        if (!cancelled) {
          setIsCatalogVaultHydrated(true);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [overlayLauncherInstalledState]);

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.addEventListener !== 'function') return;
    const handleOpenDrawer = () => setIsDownloadDrawerOpen(true);
    window.addEventListener('antigravity:open-download-drawer', handleOpenDrawer);
    return () => {
      window.removeEventListener('antigravity:open-download-drawer', handleOpenDrawer);
    };
  }, []);

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.addEventListener !== 'function') return;
    const onScrollOrWheel = () => markScrollActivity();
    window.addEventListener('scroll', onScrollOrWheel, { capture: true, passive: true });
    window.addEventListener('wheel', onScrollOrWheel, { passive: true });
    return () => {
      window.removeEventListener('scroll', onScrollOrWheel, true);
      window.removeEventListener('wheel', onScrollOrWheel);
    };
  }, []);

  const prevConnectedStorefrontsRef = useRef<StorefrontId[]>([]);
  const connectedStorefronts = useMemo(() => {
    try {
      const integrations = loadIntegrations();
      const next = integrations.filter((i) => i.isConnected).map((i) => i.storefrontId);
      const prev = prevConnectedStorefrontsRef.current;
      if (prev.length === next.length && prev.every((id, idx) => id === next[idx])) {
        return prev;
      }
      prevConnectedStorefrontsRef.current = next;
      return next;
    } catch {
      return prevConnectedStorefrontsRef.current;
    }
  }, [games, isIntegrationsModalOpen, isSystemSetupOpen, gameRefreshKey]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const win = window as Window & {
      requestIdleCallback?: (cb: () => void, opts?: { timeout?: number }) => number;
      cancelIdleCallback?: (id: number) => void;
    };
    let idleHandle: number | null = null;
    let timerHandle: ReturnType<typeof setTimeout> | null = null;
    const preloadModals = () => {
      void loadLibraryMatchManagerModal().catch(() => {});
      void loadFixMatchWizardModal().catch(() => {});
    };
    if (typeof win.requestIdleCallback === 'function') {
      idleHandle = win.requestIdleCallback(preloadModals, { timeout: 2500 });
    } else {
      timerHandle = setTimeout(preloadModals, 1500);
    }
    return () => {
      if (idleHandle !== null && typeof win.cancelIdleCallback === 'function') {
        win.cancelIdleCallback(idleHandle);
      }
      if (timerHandle !== null) {
        clearTimeout(timerHandle);
      }
    };
  }, []);

  const isInteractiveModalBusy =
    isMatchManagerOpen || isFixMatchModalOpen || isIntegrationsModalOpen || isSystemSetupOpen;

  useEffect(() => {
    if (typeof window === 'undefined' || !window.electronAPI?.offlineVault) return;
    const vault = window.electronAPI.offlineVault as typeof window.electronAPI.offlineVault & {
      setModalBusy?: (busy: boolean) => Promise<unknown> | void;
    };
    const notifyBusy = (busy: boolean) => {
      try {
        const maybePromise = vault.setModalBusy?.(busy);
        if (maybePromise && typeof (maybePromise as Promise<unknown>).catch === 'function') {
          void (maybePromise as Promise<unknown>).catch(() => {});
        }
      } catch {}
    };
    notifyBusy(isInteractiveModalBusy);
    return () => {
      if (isInteractiveModalBusy) {
        notifyBusy(false);
      }
    };
  }, [isInteractiveModalBusy]);

  useLocalInstallSync({
    gamesRef: gamesLatestRef,
    setGames,
    overlayLauncherInstalledState,
    showSyncNotice,
    isModalOpen: isInteractiveModalBusy,
  });

  useCriticScoreWarmup(
    games,
    isHibernating || runningGames.length > 0 || isInteractiveModalBusy,
    !isCatalogVaultHydrated
  );

  useBackgroundMediaWarmup({
    games,
    gamesRef: gamesLatestRef,
    isHibernating,
    runningGamesCount: runningGames.length,
    isModalSuspended: isInteractiveModalBusy,
    isBootHydrating: !isCatalogVaultHydrated,
    setGames,
    setIsSyncingAllMedia,
  });

  usePostSessionReconciler({
    gamesRef: gamesLatestRef,
    setGames,
    showSyncNotice,
  });

  const {
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
  } = useManualLibrarySyncActions({
    games,
    gamesRef: gamesLatestRef,
    selectedGame,
    isGridView,
    isSyncingAllMedia,
    setIsSyncingAllMedia,
    setGames,
    setGameRefreshKey,
    overlayLauncherInstalledState,
    showSyncNotice,
  });

  const handleToggleInstallStatus = useCallback(
    (gameToToggle?: CanonicalGame | null, platformId?: StorefrontId) => {
      const target = gameToToggle || selectedGame;
      if (!target) return;

      const targetPlat = platformId
        ? target.platforms.find((p) => p.platformId === platformId)
        : undefined;
      const currentlyInstalled = targetPlat
        ? Boolean(targetPlat.installed) || launcherService.isGameInstalled(target, platformId)
        : target.platforms.some((p) => p.installed);
      const nextState = !currentlyInstalled;
      launcherService.setManualInstallStatus(target, nextState, platformId);

      const nextCatalog = gamesLatestRef.current.map((g) => {
        if (g.id === target.id) {
          return {
            ...g,
            platforms: g.platforms.map((p) =>
              !platformId || p.platformId === platformId
                ? nextState
                  ? { ...p, installed: true }
                  : {
                      ...p,
                      installed: false,
                      installPath: undefined,
                      executablePath: undefined,
                      installSize: undefined,
                      isWindowsBinaryOnMac: undefined,
                      launchArguments: undefined,
                    }
                : p
            ),
          };
        }
        return g;
      });
      gamesLatestRef.current = nextCatalog;
      setGames(nextCatalog);
    },
    [selectedGame]
  );

  const libraryFilterIndex = useMemo(
    () => buildLibraryFilterIndex(games),
    [games, gameRefreshKey]
  );

  const filteredGames = useMemo(() => {
    const baseFiltered = games.filter((game) => {
      if (selectedPlatform !== 'all') {
        const hasPlatform = game.platforms.some((p) => p.platformId === selectedPlatform);
        if (!hasPlatform) return false;
      }

      if (installedOnly) {
        const isInstalled =
          game.platforms.some((p) => p.installed) || launcherService.isGameInstalled(game);
        if (!isInstalled) return false;
      }

      if (searchQuery.trim()) {
        const matchesTitle = matchesLooseSearchQuery(game.title, searchQuery);
        const matchesOrigTitle = matchesLooseSearchQuery(game.originalStoreTitle, searchQuery);
        if (!matchesTitle && !matchesOrigTitle) return false;
      }

      if (activeFilter) {
        if (!matchesGameFilter(game, activeFilter)) return false;
      }

      return true;
    });

    return evaluateLibraryFilter(baseFiltered, libraryFilterIndex, deferredLibraryFilterState);
  }, [
    games,
    selectedPlatform,
    installedOnly,
    searchQuery,
    activeFilter,
    libraryFilterIndex,
    deferredLibraryFilterState,
  ]);

  const activeGroupData = useMemo(() => {
    if (!activeGroupId) return null;

    if (activeGroupId === 'uncategorized') {
      const categorizedIds = new Set(collections.flatMap((c) => c.gameIds));
      const groupGames = filteredGames.filter((g) => !categorizedIds.has(g.id));
      return {
        id: 'uncategorized',
        name: 'Uncategorized',
        games: groupGames,
        subtitle: 'Games that have not been assigned to any user collection',
      };
    }

    const col = collections.find((c) => c.id === activeGroupId);
    if (!col) return null;

    const groupGames = filteredGames.filter((g) => col.gameIds.includes(g.id));
    return {
      id: col.id,
      name: col.name,
      games: groupGames,
      subtitle: `Viewing titles in the ${col.name} collection`,
    };
  }, [activeGroupId, collections, filteredGames]);

  const handleGamesBatchUpdated = useCallback((updatedGames: CanonicalGame[]) => {
    if (!Array.isArray(updatedGames) || updatedGames.length === 0) return;

    const updatesById = new Map<string, CanonicalGame>();
    for (const ug of updatedGames) {
      if (!ug || !ug.id) continue;
      const prevQueued = updatesById.get(ug.id);
      updatesById.set(
        ug.id,
        prevQueued ? mergeUpdatedGamePreservingLivePlatformState(prevQueued, ug) : ug
      );
    }
    if (updatesById.size === 0) return;

    const currentCatalog = gamesLatestRef.current;
    const actuallyDirtyIds: string[] = [];
    let anyChanged = false;

    const nextCatalog = currentCatalog.map((g) => {
      const updatedGame = updatesById.get(g.id);
      if (!updatedGame) return g;

      const merged =
        updatedGame.enrichedMetadata?.metadataQuality === 'skeleton_fallback' &&
        g.enrichedMetadata &&
        g.enrichedMetadata.metadataQuality !== 'skeleton_fallback'
          ? mergeUpdatedGamePreservingLivePlatformState(g, {
              ...updatedGame,
              enrichedMetadata: g.enrichedMetadata,
            })
          : mergeUpdatedGamePreservingLivePlatformState(g, updatedGame);

      if (isCanonicalGameMateriallyUnchanged(g, merged)) {
        return g;
      }

      anyChanged = true;
      actuallyDirtyIds.push(g.id);
      return merged;
    });

    if (!anyChanged) return;

    gamesLatestRef.current = nextCatalog;
    lastExplicitlySavedCatalogRef.current = nextCatalog;
    prevCommittedCatalogRef.current = nextCatalog;
    try {
      saveCurrentCatalog(nextCatalog, {
        skipSanitize: true,
        dirtyGameIds: actuallyDirtyIds,
      });
    } catch {}
    setGames(nextCatalog);
  }, []);

  const handleGameUpdated = useCallback(
    (updatedGame: CanonicalGame) => {
      handleGamesBatchUpdated([updatedGame]);
    },
    [handleGamesBatchUpdated]
  );

  const handleOpenAchievements = useCallback(
    (gameToView?: CanonicalGame | null, storefrontId?: StorefrontId) => {
      const targetGame = gameToView || selectedGame;
      if (targetGame) {
        setAchievementsModalGame(targetGame);
        setAchievementsInitialStorefrontId(storefrontId);
        setIsAchievementsModalOpen(true);
      }
    },
    [selectedGame]
  );

  const handleToggleInstalledOnly = useCallback(() => {
    setInstalledOnly((prev) => !prev);
  }, []);

  const handleOpenIntegrationsModal = useCallback(() => {
    setIsIntegrationsModalOpen(true);
  }, []);

  const handleCloseIntegrationsModal = useCallback(() => {
    setIsIntegrationsModalOpen(false);
  }, []);

  const handleTopNavOpenFixMatch = useCallback(() => {
    handleOpenFixMatch();
  }, [handleOpenFixMatch]);

  const handleOpenMatchManager = useCallback(() => {
    setIsMatchManagerOpen(true);
  }, [setIsMatchManagerOpen]);

  const handleCloseMatchManager = useCallback(() => {
    setIsMatchManagerOpen(false);
    setIsFixMatchModalOpen(false);
    setFixMatchGame(null);
  }, [setFixMatchGame, setIsFixMatchModalOpen, setIsMatchManagerOpen]);

  const handleTopNavOpenAchievements = useCallback(() => {
    handleOpenAchievements();
  }, [handleOpenAchievements]);

  const handleOpenDownloadDrawer = useCallback(() => {
    setIsDownloadDrawerOpen(true);
  }, []);

  const handleCloseDownloadDrawer = useCallback(() => {
    setIsDownloadDrawerOpen(false);
  }, []);

  const computeSetupSessionSignature = useCallback((): string => {
    const ws = environmentSetupService.getWizardState();
    let connectedSig = '';
    try {
      connectedSig = loadIntegrations()
        .filter((i) => i.isConnected)
        .map((i) => i.storefrontId)
        .join(',');
    } catch {}
    return `${ws?.completedAt ?? ''}|${(ws?.configuredComponents ?? []).join(',')}|${connectedSig}`;
  }, []);

  const handleOpenSystemSetup = useCallback(
    (
      mode: SetupWizardOpenMode = 'health_check',
      initialStep?: SetupWizardStepId,
      focusComponentId?: EnvironmentComponentId
    ) => {
      setupSessionBaselineSigRef.current = computeSetupSessionSignature();
      setSystemSetupMode(mode);
      setSystemSetupInitialStep(initialStep);
      setSystemSetupFocusComponent(focusComponentId);
      setIsSystemSetupOpen(true);
    },
    [computeSetupSessionSignature]
  );

  const handleCloseSystemSetup = useCallback(() => {
    const didSetupOrAccountsChange =
      computeSetupSessionSignature() !== setupSessionBaselineSigRef.current;
    setIsSystemSetupOpen(false);
    setSystemSetupInitialStep(undefined);
    setSystemSetupFocusComponent(undefined);
    if (didSetupOrAccountsChange) {
      startTransition(() => {
        setGameRefreshKey((k) => k + 1);
      });
    }
  }, [computeSetupSessionSignature]);

  const handleTopNavOpenSystemSetup = useCallback(() => {
    handleOpenSystemSetup('health_check');
  }, [handleOpenSystemSetup]);

  useEffect(() => {
    const syncAlertCount = () => {
      const snap = environmentSetupService.getLastSnapshot();
      const nextCount = snap
        ? getRemovedComponents(snap).filter(
            (comp) => !(snap.hostPlatform === 'darwin' && comp.id === 'rosetta2')
          ).length
        : 0;
      setSystemSetupAlertCount((prev) => (prev === nextCount ? prev : nextCount));
    };
    syncAlertCount();
    return environmentSetupService.subscribe(syncAlertCount);
  }, []);

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.addEventListener !== 'function') return;
    const handleOpenEvent = (event: Event) => {
      const detail = (event as CustomEvent<OpenSystemSetupEventDetail | undefined>).detail;
      handleOpenSystemSetup(
        detail?.mode || 'health_check',
        detail?.initialStep,
        detail?.focusComponentId
      );
    };
    window.addEventListener(OPEN_SYSTEM_SETUP_EVENT, handleOpenEvent);
    return () => {
      window.removeEventListener(OPEN_SYSTEM_SETUP_EVENT, handleOpenEvent);
    };
  }, [handleOpenSystemSetup]);

  useEffect(() => {
    if (!isCatalogVaultHydrated || hasCheckedStartupWizardRef.current) return;
    hasCheckedStartupWizardRef.current = true;

    let cancelled = false;
    let idleHandle: number | null = null;
    let timerHandle: ReturnType<typeof setTimeout> | null = null;
    const win =
      typeof window !== 'undefined'
        ? (window as Window & {
            requestIdleCallback?: (cb: () => void, opts?: { timeout?: number }) => number;
            cancelIdleCallback?: (id: number) => void;
          })
        : undefined;

    void environmentSetupService
      .loadWizardState()
      .then((wizardState) => {
        if (cancelled) return;
        const isElectronRuntime =
          typeof window !== 'undefined' && Boolean(window.electronAPI?.isElectron);
        const shouldAutoOpen = shouldAutoOpenSetupWizardOnStartup({
          wizardState,
          connectedStorefrontsCount: connectedStorefronts.length,
          catalogGamesCount: gamesLatestRef.current.length,
          isElectronRuntime,
        });

        if (shouldAutoOpen) {
          handleOpenSystemSetup('first_launch');
          return;
        }

        if (
          isElectronRuntime &&
          typeof window !== 'undefined' &&
          typeof window.electronAPI?.probeEnvironmentHealth === 'function'
        ) {
          const runIdleProbe = () => {
            if (cancelled) return;
            void environmentSetupService.probeHealth(connectedStorefronts).catch(() => {});
          };
          if (win && typeof win.requestIdleCallback === 'function') {
            idleHandle = win.requestIdleCallback(runIdleProbe, { timeout: 4000 });
          } else {
            timerHandle = setTimeout(runIdleProbe, 3000);
          }
        }
      })
      .catch(() => {});

    return () => {
      cancelled = true;
      if (idleHandle !== null && win && typeof win.cancelIdleCallback === 'function') {
        win.cancelIdleCallback(idleHandle);
      }
      if (timerHandle !== null) {
        clearTimeout(timerHandle);
      }
    };
  }, [connectedStorefronts, handleOpenSystemSetup, isCatalogVaultHydrated]);

  const handleMainScroll = useCallback(() => {
    if (mainContentRef.current) {
      saveCurrentScroll(mainContentRef.current.scrollTop);
    }
  }, [saveCurrentScroll]);

  const handleGridHideGame = useCallback(
    (g: CanonicalGame) => {
      handleHideGame(g);
    },
    [handleHideGame]
  );

  const handleResetLibraryFilterState = useCallback(() => {
    setLibraryFilterState(DEFAULT_LIBRARY_FILTER_STATE);
    navigateClearFilter();
  }, [navigateClearFilter]);

  const handleStoreManageCollections = useCallback(() => {
    if (selectedGame) {
      handleOpenManageCollections(selectedGame);
    }
  }, [handleOpenManageCollections, selectedGame]);

  const handleStoreToggleInstallStatus = useCallback(
    (platId?: StorefrontId) => {
      handleToggleInstallStatus(selectedGame, platId);
    },
    [handleToggleInstallStatus, selectedGame]
  );

  const handleStoreFixMatch = useCallback(() => {
    if (selectedGame) {
      handleOpenFixMatch(selectedGame);
    }
  }, [handleOpenFixMatch, selectedGame]);

  const handleStoreViewAchievements = useCallback(
    (sfId?: StorefrontId) => {
      handleOpenAchievements(selectedGame, sfId);
    },
    [handleOpenAchievements, selectedGame]
  );

  const handleCloseFixMatchModal = useCallback(() => {
    setIsFixMatchModalOpen(false);
    setFixMatchGame(null);
  }, [setIsFixMatchModalOpen, setFixMatchGame]);

  const handleCloseAchievementsModal = useCallback(() => {
    setIsAchievementsModalOpen(false);
    setAchievementsModalGame(null);
    setAchievementsInitialStorefrontId(undefined);
  }, []);

  const handleIntegrationsLibraryUpdated = useCallback(
    (newGames: CanonicalGame[]) => {
      gamesLatestRef.current = newGames;
      lastExplicitlySavedCatalogRef.current = newGames;
      prevCommittedCatalogRef.current = newGames;
      setGames(newGames);
      setGameRefreshKey((k) => k + 1);
      saveCurrentCatalog(newGames, { skipSanitize: true });
      if (
        newGames.length > 0 &&
        (!selectedGame || !newGames.some((g) => g.id === selectedGame.id))
      ) {
        navigateSelectGame(newGames[0]);
      }
    },
    [navigateSelectGame, selectedGame]
  );

  const activeCollectionIconId = useMemo(
    () =>
      activeGroupId && activeGroupId !== 'uncategorized'
        ? collections.find((c) => c.id === activeGroupId)?.icon
        : undefined,
    [activeGroupId, collections]
  );

  const gridGroupIcon = useMemo(() => {
    if (activeFilter) {
      return <Sliders className="w-6 h-6 text-steam-accent" />;
    }
    if (activeGroupId === 'uncategorized') {
      return <Layers className="w-6 h-6 text-sky-400" />;
    }
    if (activeGroupId) {
      return (
        <CollectionIcon
          iconId={activeCollectionIconId}
          collectionId={activeGroupId}
          size={22}
        />
      );
    }
    return undefined;
  }, [activeCollectionIconId, activeFilter, activeGroupId]);

  if (isHibernating) {
    return <InGameHibernationView runningGames={runningGames} onResumeFullUi={resumeFullUi} />;
  }

  return (
    <div className="h-screen w-screen bg-[#0e141b] text-steam-text flex flex-col font-steam overflow-hidden">
      {/* Top Navigation Bar */}
      <TopNavBar
        searchQuery={searchQuery}
        onSearchChange={setSearchQuery}
        selectedPlatform={selectedPlatform}
        onSelectPlatform={setSelectedPlatform}
        installedOnly={installedOnly}
        onToggleInstalledOnly={handleToggleInstalledOnly}
        totalGamesCount={games.length}
        filteredCount={filteredGames.length}
        isSyncing={isSyncing}
        onTriggerSync={handleTriggerSync}
        onOpenIntegrations={handleOpenIntegrationsModal}
        onHomeClick={navigateHome}
        canGoBack={canGoBack}
        onGoBack={goBack}
        backTitle={backTitle}
        canGoForward={canGoForward}
        onGoForward={goForward}
        forwardTitle={forwardTitle}
        connectedStorefronts={connectedStorefronts}
        games={games}
        currentGameTitle={!isGridView && selectedGame ? selectedGame.title : undefined}
        canSyncCurrentGame={canSyncCurrentGame}
        isSyncingCurrentGame={isSyncingCurrentGame}
        onSyncCurrentGame={handleSyncCurrentGame}
        isSyncingAllMedia={isSyncingAllMedia}
        onSyncAllMedia={handleSyncStoreMedia}
        isSyncingScores={isSyncingScores}
        onRefreshScores={handleRefreshScores}
        isSyncingTrophies={isSyncingTrophies}
        onSyncTrophies={handleSyncTrophies}
        onOpenFixMatch={handleTopNavOpenFixMatch}
        onOpenLibraryMatchManager={handleOpenMatchManager}
        onOpenSystemSetup={handleTopNavOpenSystemSetup}
        systemSetupAlertCount={systemSetupAlertCount}
        onOpenAchievements={handleTopNavOpenAchievements}
        onOpenDownloads={handleOpenDownloadDrawer}
      />

      {/* Sync / Telemetry Status Banner */}
      {syncNotice && (
        <div
          data-testid="sync-status-banner"
          role="status"
          aria-live="polite"
          className={`border-b py-1.5 px-4 text-center text-xs flex items-center justify-center gap-2 flex-shrink-0 transition-all ${
            syncNoticeTone === 'warning'
              ? 'bg-amber-950/90 border-amber-600/50 text-amber-200'
              : 'bg-emerald-950/90 border-emerald-600/50 text-emerald-300'
          }`}
        >
          {syncNoticeTone === 'warning' ? (
            <AlertTriangle className="w-4 h-4 text-amber-400 flex-shrink-0" />
          ) : (
            <CheckCircle2 className="w-4 h-4 text-emerald-400 flex-shrink-0" />
          )}
          <span>{syncNotice}</span>
        </div>
      )}

      {/* Main Two-Column Layout */}
      <div className="flex-1 flex overflow-hidden">
        {/* Left Column: Library Games List */}
        <LibrarySidebar
          games={filteredGames}
          selectedGameId={isGridView ? null : selectedGame?.id || null}
          onSelectGame={navigateSelectGame}
          searchQuery={searchQuery}
          onSearchChange={setSearchQuery}
          selectedPlatform={selectedPlatform}
          onSelectPlatform={setSelectedPlatform}
          installedOnly={installedOnly}
          onToggleInstalledOnly={handleToggleInstalledOnly}
          collections={collections}
          onOpenManageCollectionsModal={handleOpenManageCollections}
          onToggleGameInCollection={handleToggleGameInCollection}
          onViewAllGamesGrid={navigateHome}
          onSelectGroupGrid={navigateSelectGroup}
          activeGroupId={activeGroupId}
          isGridView={isGridView}
          activeFilter={activeFilter}
          onClearActiveFilter={navigateClearFilter}
          connectedStorefronts={connectedStorefronts}
        />

        {/* Right Main Pane: Storefront Detail Layout OR Group/Whole Library Grid View */}
        <main
          ref={mainContentRef}
          onScroll={handleMainScroll}
          style={{ overflowAnchor: 'none' }}
          className="flex-1 h-full overflow-y-auto bg-[#0b0f14] relative"
        >
          {isGridView || !selectedGame ? (
            <LibraryGridView
              games={activeGroupData ? activeGroupData.games : filteredGames}
              onSelectGame={navigateSelectGame}
              searchQuery={searchQuery}
              title={
                activeFilter
                  ? `${activeFilter.label}: ${activeFilter.value}`
                  : activeGroupData
                    ? activeGroupData.name
                    : 'All Games'
              }
              subtitle={
                activeFilter
                  ? `Showing all games matching "${activeFilter.value}"`
                  : activeGroupData
                    ? activeGroupData.subtitle
                    : undefined
              }
              groupIcon={gridGroupIcon}
              onClearGroupFilter={activeGroupId ? navigateHome : undefined}
              activeFilter={activeFilter}
              onClearActiveFilter={navigateClearFilter}
              connectedStorefronts={connectedStorefronts}
              onFixMatch={handleOpenFixMatch}
              onHideGame={handleGridHideGame}
              onSyncGameMedia={handleSyncCurrentGame}
              collections={collections}
              onToggleGameInCollection={handleToggleGameInCollection}
              onOpenManageCollectionsModal={handleOpenManageCollections}
              onViewAchievements={handleOpenAchievements}
              sortBy={gridSortBy}
              onSortChange={setGridSortBy}
              libraryFilterState={libraryFilterState}
              onUpdateLibraryFilterState={setLibraryFilterState}
              onResetLibraryFilterState={handleResetLibraryFilterState}
              libraryFilterIndex={libraryFilterIndex}
              unfilteredTotalCount={games.length}
              isPreFiltered={deferredLibraryFilterState === libraryFilterState}
            />
          ) : (
            <SteamStorePage
              key={currentEntry.selectedGameId || selectedGame.id}
              game={selectedGame}
              collections={collections}
              onBackToLibrary={navigateHome}
              onManageCollections={handleStoreManageCollections}
              onToggleInstallStatus={handleStoreToggleInstallStatus}
              onApplyFilter={navigateApplyFilter}
              onGameUpdated={handleGameUpdated}
              connectedStorefronts={connectedStorefronts}
              onOpenIntegrations={handleOpenIntegrationsModal}
              onFixMatch={handleStoreFixMatch}
              onHideGame={handleHideGame}
              onViewAchievements={handleStoreViewAchievements}
            />
          )}
        </main>
      </div>

      {/* Modal: Manage Collections */}
      {isManageCollectionsOpen && (
        <Suspense fallback={null}>
          <ManageCollectionsModal
            isOpen={isManageCollectionsOpen}
            onClose={handleCloseManageCollections}
            collections={collections}
            game={collectionModalGame}
            onCreateCollection={handleCreateCollection}
            onRenameCollection={handleRenameCollection}
            onDeleteCollection={handleDeleteCollection}
            onToggleGameInCollection={handleToggleGameInCollection}
            onReorderCollections={handleReorderCollections}
          />
        </Suspense>
      )}

      {/* Modal: Storefront Integrations & Cloud Sync */}
      {isIntegrationsModalOpen && (
        <Suspense fallback={null}>
          <IntegrationsModal
            isOpen={isIntegrationsModalOpen}
            onClose={handleCloseIntegrationsModal}
            onLibraryUpdated={handleIntegrationsLibraryUpdated}
          />
        </Suspense>
      )}

      {/* Modal: Library Match & Overrides Studio */}
      {isMatchManagerOpen && (
        <Suspense fallback={null}>
          <LibraryMatchManagerModal
            isOpen={isMatchManagerOpen}
            isSuspended={isFixMatchModalOpen}
            games={games}
            onClose={handleCloseMatchManager}
            onFixMatchForGame={handleOpenFixMatch}
            onResetOverride={handleResetOverride}
            onResetOverrideForGame={handleResetOverride}
            onInspectGame={navigateSelectGame}
            onSelectGame={navigateSelectGame}
            onHideGame={handleHideGame}
            onUnhideEntry={handleUnhideEntry}
            onGameUpdated={handleGameUpdated}
            onGamesBatchUpdated={handleGamesBatchUpdated}
          />
        </Suspense>
      )}

      {/* Modal: Fix Match & Metadata Override Wizard */}
      {isFixMatchModalOpen && (
        <Suspense fallback={null}>
          <FixMatchWizardModal
            isOpen={isFixMatchModalOpen}
            game={fixMatchGame}
            onClose={handleCloseFixMatchModal}
            onApplyOverride={handleApplyOverride}
            onResetOverride={handleResetOverride}
            onHideGame={handleHideGame}
            existingOverride={fixMatchGame ? getUserOverrideForGame(fixMatchGame) : undefined}
          />
        </Suspense>
      )}

      {/* Modal: Multi-Storefront Individual Achievements Browser */}
      {isAchievementsModalOpen && (
        <Suspense fallback={null}>
          <GameAchievementsModal
            isOpen={isAchievementsModalOpen}
            game={achievementsModalGame}
            initialStorefrontId={achievementsInitialStorefrontId}
            onClose={handleCloseAchievementsModal}
          />
        </Suspense>
      )}

      {/* Slide-over Drawer: Universal Download & Installation Manager */}
      {isDownloadDrawerOpen && (
        <Suspense fallback={null}>
          <DownloadManagerDrawer
            isOpen={isDownloadDrawerOpen}
            onClose={handleCloseDownloadDrawer}
          />
        </Suspense>
      )}

      {/* Modal: Unified System Setup Wizard & Environment Health / Repair */}
      {isSystemSetupOpen && (
        <Suspense fallback={null}>
          <SystemSetupWizardModal
            isOpen={isSystemSetupOpen}
            mode={systemSetupMode}
            initialStep={systemSetupInitialStep}
            focusComponentId={systemSetupFocusComponent}
            connectedStorefronts={connectedStorefronts}
            onClose={handleCloseSystemSetup}
            onOpenIntegrationsModal={handleOpenIntegrationsModal}
            onLibraryUpdated={handleIntegrationsLibraryUpdated}
          />
        </Suspense>
      )}

      {/* Global Sync Progress Bar Dock */}
      <GlobalSyncProgressBar />
    </div>
  );
}

export default App;
