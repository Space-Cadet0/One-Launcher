import {
  useState,
  useMemo,
  useEffect,
  useRef,
  useCallback,
  useDeferredValue,
  Suspense,
} from 'react';
import { CanonicalGame } from './contracts/game';
import { StorefrontId } from './contracts/platform';
import {
  ActiveGameFilter,
  LibraryFilterState,
  DEFAULT_LIBRARY_FILTER_STATE,
  activeGameFilterToLibraryFilterState,
  doesLibraryFilterStateStillMatchActiveFilter,
} from './contracts/filter';
import type { SetupWizardStepId } from './contracts/environmentSetup';
import { TopNavBar } from './components/Navigation/TopNavBar';
import { GlobalSyncProgressBar } from './components/Navigation/GlobalSyncProgressBar';
import { LibrarySidebar } from './components/Library/LibrarySidebar';
import {
  LibraryGridView,
  GridSortOption,
  loadPersistedGridSort,
} from './components/Library/LibraryGridView';
import { CollectionIcon } from './components/Common/CollectionIcon';
import { ModalErrorBoundary } from './components/Common/ModalErrorBoundary';
import { InGameHibernationView } from './components/Launcher/InGameHibernationView';
import { markScrollActivity } from './utils/scrollActivityTracker';
import { matchesLooseSearchQuery } from './services/common/titleUtils';
import { getUserOverrideForGame } from './services/storage/userOverrideStorage';
import { USER_TAG_OVERRIDES_UPDATED_EVENT } from './services/storage/userTagStorage';
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
import { useNavigationHistory } from './hooks/useNavigationHistory';
import { useScrollRestoration } from './hooks/useScrollRestoration';
import { useDocumentTitle } from './hooks/useDocumentTitle';
import { useAppModalOrchestrator } from './hooks/useAppModalOrchestrator';
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

export { InGameHibernationView };

import { lazyWithRetry } from './utils/lazyWithRetry';
export { lazyWithRetry };

const SteamStorePage = lazyWithRetry(() =>
  import('./components/SteamStoreDetail/SteamStorePage').then((m) => ({
    default: m.SteamStorePage,
  }))
);
const ManageCollectionsModal = lazyWithRetry(() =>
  import('./components/Library/ManageCollectionsModal').then((m) => ({
    default: m.ManageCollectionsModal,
  }))
);
const IntegrationsModal = lazyWithRetry(() =>
  import('./components/Navigation/IntegrationsModal').then((m) => ({
    default: m.IntegrationsModal,
  }))
);
const FixMatchWizardModal = lazyWithRetry(() =>
  import('./components/Library/FixMatchWizardModal').then((m) => ({
    default: m.FixMatchWizardModal,
  }))
);
const LibraryMatchManagerModal = lazyWithRetry(() =>
  import('./components/Library/LibraryMatchManagerModal').then((m) => ({
    default: m.LibraryMatchManagerModal,
  }))
);
const GameAchievementsModal = lazyWithRetry(() =>
  import('./components/Achievements/GameAchievementsModal').then((m) => ({
    default: m.GameAchievementsModal,
  }))
);
const DownloadManagerDrawer = lazyWithRetry(() =>
  import('./components/Launcher/DownloadManagerDrawer').then((m) => ({
    default: m.DownloadManagerDrawer,
  }))
);
const SystemSetupWizardModal = lazyWithRetry(() =>
  import('./components/Launcher/SystemSetupWizard/SystemSetupWizardModal').then((m) => ({
    default: m.SystemSetupWizardModal,
  }))
);
const SettingsModal = lazyWithRetry(() =>
  import('./components/Settings/SettingsModal').then((m) => ({
    default: m.SettingsModal,
  }))
);

const NOOP_TOP_NAV_HOME_CLICK = () => {};

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
  const keys = new Set([...Object.keys(prev), ...Object.keys(next)]);

  for (const key of keys) {
    const valPrev: unknown = Reflect.get(prev, key);
    const valNext: unknown = Reflect.get(next, key);
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
    try {
      const loaded = loadCurrentCatalog();
      if (Array.isArray(loaded) && loaded.length > 0) {
        let anyInstallOverlay = false;
        const overlaid = loaded.map((g: CanonicalGame) => {
          let platChanged = false;
          const nextPlatforms = g.platforms.map((p) => {
            const nextInstalled = Boolean(
              p.installed || launcherService.isGameInstalled(g, p.platformId)
            );
            if (nextInstalled !== Boolean(p.installed)) {
              platChanged = true;
              return { ...p, installed: nextInstalled };
            }
            return p;
          });
          if (platChanged) {
            anyInstallOverlay = true;
            return { ...g, platforms: nextPlatforms };
          }
          return g;
        });
        return anyInstallOverlay ? overlaid : loaded;
      }
    } catch (e) {
      console.error('Failed to parse cached games:', e);
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
    updateCurrentEntry,
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
      libraryFilterState: DEFAULT_LIBRARY_FILTER_STATE,
    },
    getCurrentScroll
  );

  const isGridView = currentEntry.view === 'grid';
  const activeGroupId = currentEntry.activeGroupId;
  const activeFilter = currentEntry.activeFilter;
  const libraryFilterState = currentEntry.libraryFilterState ?? DEFAULT_LIBRARY_FILTER_STATE;
  const deferredLibraryFilterState = useDeferredValue(libraryFilterState);
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

  useScrollRestoration({
    containerRef: mainContentRef,
    navigationEntryId: currentEntry.id,
    targetScrollY: currentEntry.scrollY ?? 0,
  });

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
        libraryFilterState: activeFilter ? DEFAULT_LIBRARY_FILTER_STATE : libraryFilterState,
      });
    },
    [activeFilter, libraryFilterState, pushEntry]
  );

  const navigateApplyFilter = useCallback(
    (filter: ActiveGameFilter) => {
      const nextFilterState = activeGameFilterToLibraryFilterState(
        filter,
        libraryFilterState,
        false
      );
      pushEntry({
        view: 'grid',
        selectedGameId: selectedGame?.id || null,
        activeFilter: filter,
        activeGroupId: null,
        title: `${filter.label}: ${filter.value}`,
        libraryFilterState: nextFilterState,
      });
    },
    [libraryFilterState, pushEntry, selectedGame?.id]
  );

  const navigateHome = useCallback(() => {
    if (isGridView && !activeFilter && !activeGroupId) {
      updateCurrentEntry({ libraryFilterState: DEFAULT_LIBRARY_FILTER_STATE });
      return;
    }
    pushEntry({
      view: 'grid',
      selectedGameId: selectedGame?.id || null,
      activeFilter: null,
      activeGroupId: null,
      title: 'All Games',
      scrollY: getLastAllGamesScrollY(),
      libraryFilterState: activeFilter ? DEFAULT_LIBRARY_FILTER_STATE : libraryFilterState,
    });
  }, [
    activeFilter,
    activeGroupId,
    getLastAllGamesScrollY,
    isGridView,
    libraryFilterState,
    pushEntry,
    selectedGame?.id,
    updateCurrentEntry,
  ]);

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
        libraryFilterState: activeFilter ? DEFAULT_LIBRARY_FILTER_STATE : libraryFilterState,
      });
    },
    [activeFilter, collections, libraryFilterState, navigateHome, pushEntry, selectedGame?.id]
  );

  const navigateClearFilter = useCallback(() => {
    if (activeFilter) {
      pushEntry({
        view: 'grid',
        selectedGameId: selectedGame?.id || null,
        activeFilter: null,
        activeGroupId: activeGroupId,
        title: activeGroupId
          ? collections.find((c) => c.id === activeGroupId)?.name || 'Collection'
          : 'All Games',
        libraryFilterState: DEFAULT_LIBRARY_FILTER_STATE,
      });
      return;
    }
    updateCurrentEntry({ libraryFilterState: DEFAULT_LIBRARY_FILTER_STATE });
  }, [
    activeFilter,
    activeGroupId,
    collections,
    pushEntry,
    selectedGame?.id,
    updateCurrentEntry,
  ]);

  const [searchQuery, setSearchQuery] = useState('');
  const deferredSearchQuery = useDeferredValue(searchQuery);
  const [selectedPlatform, setSelectedPlatform] = useState<StorefrontId | 'all'>('all');
  const [installedOnly, setInstalledOnly] = useState(false);
  const [isSyncingAllMedia, setIsSyncingAllMedia] = useState(false);
  const [gameRefreshKey, setGameRefreshKey] = useState(0);
  const [tagOverridesVersion, setTagOverridesVersion] = useState(0);
  const [criticIndexRevision, setCriticIndexRevision] = useState(0);
  const [ignoreLeadingTheWhenSorting, setIgnoreLeadingTheWhenSorting] = useState<boolean>(
    () => launcherService.getPerformanceSettings?.()?.ignoreLeadingTheWhenSorting ?? true
  );

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.addEventListener !== 'function') {
      return undefined;
    }
    const handleTagOverridesUpdated = () => {
      setTagOverridesVersion((v) => v + 1);
    };
    window.addEventListener(USER_TAG_OVERRIDES_UPDATED_EVENT, handleTagOverridesUpdated);
    return () => {
      window.removeEventListener(USER_TAG_OVERRIDES_UPDATED_EVENT, handleTagOverridesUpdated);
    };
  }, []);

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.addEventListener !== 'function') {
      return undefined;
    }
    let debounceTimer: ReturnType<typeof setTimeout> | null = null;
    const scheduleCriticIndexRevision = (event?: Event) => {
      const detail = (
        event as CustomEvent<{
          refreshedAll?: boolean;
          immediate?: boolean;
          hydratedFromVault?: boolean;
        }> | undefined
      )?.detail;
      const isImmediate = Boolean(
        detail?.refreshedAll || detail?.immediate || detail?.hydratedFromVault
      );
      if (debounceTimer !== null) {
        clearTimeout(debounceTimer);
        debounceTimer = null;
      }
      if (isImmediate) {
        setCriticIndexRevision((v) => v + 1);
        return;
      }
      debounceTimer = setTimeout(() => {
        debounceTimer = null;
        setCriticIndexRevision((v) => v + 1);
      }, 150);
    };

    const handleOverrideIndexRevision = (event?: Event) => {
      const detail = (event as CustomEvent<Record<string, unknown> | undefined> | undefined)
        ?.detail;
      const eventType = typeof detail?.type === 'string' ? detail.type : undefined;
      if (
        eventType === 'confirmed-non-game' ||
        eventType === 'confirmed-non-game-batch' ||
        eventType === 'batch-confirmed-non-game' ||
        eventType === 'unconfirmed-non-game'
      ) {
        return;
      }
      scheduleCriticIndexRevision(event);
    };

    window.addEventListener('antigravity_critic_updated', scheduleCriticIndexRevision);
    window.addEventListener('antigravity:user-override-updated', handleOverrideIndexRevision);
    window.addEventListener('antigravity:user-override-removed', handleOverrideIndexRevision);
    window.addEventListener('antigravity_user_overrides_updated', handleOverrideIndexRevision);
    window.addEventListener('antigravity:staged-vault-hydrated', scheduleCriticIndexRevision);
    return () => {
      if (debounceTimer !== null) {
        clearTimeout(debounceTimer);
        debounceTimer = null;
      }
      window.removeEventListener('antigravity_critic_updated', scheduleCriticIndexRevision);
      window.removeEventListener('antigravity:user-override-updated', handleOverrideIndexRevision);
      window.removeEventListener('antigravity:user-override-removed', handleOverrideIndexRevision);
      window.removeEventListener('antigravity_user_overrides_updated', handleOverrideIndexRevision);
      window.removeEventListener('antigravity:staged-vault-hydrated', scheduleCriticIndexRevision);
    };
  }, []);

  useEffect(() => {
    const syncTitleSortSetting = () => {
      const next =
        launcherService.getPerformanceSettings?.()?.ignoreLeadingTheWhenSorting ?? true;
      setIgnoreLeadingTheWhenSorting((prev) => (prev === next ? prev : next));
    };
    syncTitleSortSetting();
    return launcherService.subscribe(syncTitleSortSetting);
  }, []);

  const { syncNotice, syncNoticeTone, showSyncNotice } = useSyncNotice();
  const { isHibernating, runningGames, resumeFullUi } = useLauncherHibernationState();
  const wasHibernatingRef = useRef(isHibernating);

  useEffect(() => {
    if (wasHibernatingRef.current && !isHibernating) {
      if (typeof document !== 'undefined') {
        const mainEl = document.getElementById('main-content');
        mainEl?.focus?.({ preventScroll: true });
      }
    }
    wasHibernatingRef.current = isHibernating;
  }, [isHibernating]);

  const lastExplicitlySavedCatalogRef = useRef<CanonicalGame[] | null>(games);
  const prevCommittedCatalogRef = useRef<CanonicalGame[]>(games);

  const handleExternalCatalogPersisted = useCallback((catalog: CanonicalGame[]) => {
    lastExplicitlySavedCatalogRef.current = catalog;
    prevCommittedCatalogRef.current = catalog;
  }, []);

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
    onCatalogPersisted: handleExternalCatalogPersisted,
    showSyncNotice,
  });

  const prevConnectedStorefrontsRef = useRef<StorefrontId[]>([]);
  const handleSetupStateChanged = useCallback(() => {
    setGameRefreshKey((k) => k + 1);
  }, []);

  const {
    isInteractiveModalBusy,
    isIntegrationsModalOpen,
    handleOpenIntegrationsModal,
    handleCloseIntegrationsModal,
    isAchievementsModalOpen,
    achievementsModalGame,
    achievementsInitialStorefrontId,
    handleOpenAchievements,
    handleCloseAchievementsModal,
    handleTopNavOpenAchievements,
    isDownloadDrawerOpen,
    handleOpenDownloadDrawer,
    handleCloseDownloadDrawer,
    isSettingsOpen,
    settingsInitialSection,
    handleTopNavOpenSettings,
    handleCloseSettingsModal,
    handleOpenIntegrationsFromSettings,
    isSystemSetupOpen,
    systemSetupMode,
    systemSetupInitialStep,
    systemSetupFocusComponent,
    systemSetupAlertCount,
    handleOpenSystemSetup,
    handleCloseSystemSetup,
    handleTopNavOpenSystemSetup,
  } = useAppModalOrchestrator({
    selectedGame,
    gamesRef: gamesLatestRef,
    connectedStorefrontsRef: prevConnectedStorefrontsRef,
    isCatalogVaultHydrated,
    isMatchManagerOpen,
    isFixMatchModalOpen,
    isManageCollectionsOpen,
    onSetupStateChanged: handleSetupStateChanged,
  });

  // Persist catalog state in commit phase (never inside pure setGames updaters),
  // strictly gated behind isCatalogVaultHydrated to eliminate cold-boot slim-overwrites-rich races.
  useEffect(() => {
    if (!isCatalogVaultHydrated) {
      return;
    }

    const prev = prevCommittedCatalogRef.current;
    prevCommittedCatalogRef.current = games;

    if (games.length === 0) return;
    if (lastExplicitlySavedCatalogRef.current === games) {
      return;
    }

    try {
      if (prev !== games && prev.length > 0) {
        if (prev.length === games.length) {
          const dirtyIds: string[] = [];
          let orderPreserved = true;
          for (let i = 0; i < games.length; i++) {
            if (prev[i].id !== games[i].id) {
              orderPreserved = false;
              break;
            }
            if (prev[i] !== games[i] && !isCanonicalGameMateriallyUnchanged(prev[i], games[i])) {
              dirtyIds.push(games[i].id);
            }
          }
          if (orderPreserved) {
            if (dirtyIds.length === 0) {
              lastExplicitlySavedCatalogRef.current = games;
              return;
            }
            if (dirtyIds.length < games.length) {
              lastExplicitlySavedCatalogRef.current = games;
              saveCurrentCatalog(games, { skipSanitize: true, dirtyGameIds: dirtyIds });
              return;
            }
          }
        }

        const prevById = new Map<string, CanonicalGame>();
        for (let i = 0; i < prev.length; i++) {
          const pg = prev[i];
          if (pg?.id) prevById.set(pg.id, pg);
        }
        const dirtyIds: string[] = [];
        for (let i = 0; i < games.length; i++) {
          const g = games[i];
          if (!g?.id) continue;
          const prevGame = prevById.get(g.id);
          if (!prevGame || (prevGame !== g && !isCanonicalGameMateriallyUnchanged(prevGame, g))) {
            dirtyIds.push(g.id);
          }
          if (prevGame) {
            prevById.delete(g.id);
          }
        }
        const removedIds = Array.from(prevById.keys());
        if (dirtyIds.length === 0 && removedIds.length === 0) {
          lastExplicitlySavedCatalogRef.current = games;
          return;
        }
        if (dirtyIds.length < games.length) {
          lastExplicitlySavedCatalogRef.current = games;
          saveCurrentCatalog(games, {
            skipSanitize: true,
            dirtyGameIds: dirtyIds,
            ...(removedIds.length > 0 ? { removedGameIds: removedIds } : {}),
          });
          return;
        }
      }

      lastExplicitlySavedCatalogRef.current = games;
      saveCurrentCatalog(games, { skipSanitize: true });
    } catch {}
  }, [games, isCatalogVaultHydrated]);

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

          const hydratedById = new Map<string, CanonicalGame>();
          for (let i = 0; i < hydrated.length; i++) {
            const hg = hydrated[i];
            if (hg?.id) hydratedById.set(hg.id, hg);
          }
          const mutatedIds: string[] = [];
          for (let i = 0; i < next.length; i++) {
            const ng = next[i];
            if (!ng?.id) continue;
            const hg = hydratedById.get(ng.id);
            if (!hg) {
              mutatedIds.push(ng.id);
            } else {
              hydratedById.delete(ng.id);
              if (!isCanonicalGameMateriallyUnchanged(hg, ng)) {
                mutatedIds.push(ng.id);
              }
            }
          }
          const removedIds = Array.from(hydratedById.keys());

          gamesLatestRef.current = next;
          lastExplicitlySavedCatalogRef.current = next;
          prevCommittedCatalogRef.current = next;

          if (mutatedIds.length > 0 || removedIds.length > 0) {
            try {
              saveCurrentCatalog(next, {
                skipSanitize: true,
                dirtyGameIds: mutatedIds,
                ...(removedIds.length > 0 ? { removedGameIds: removedIds } : {}),
              });
            } catch {}
          }

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
    const onScrollOrWheel = () => markScrollActivity();
    window.addEventListener('scroll', onScrollOrWheel, { capture: true, passive: true });
    window.addEventListener('wheel', onScrollOrWheel, { passive: true });
    return () => {
      window.removeEventListener('scroll', onScrollOrWheel, true);
      window.removeEventListener('wheel', onScrollOrWheel);
    };
  }, []);

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

  useLocalInstallSync({
    gamesRef: gamesLatestRef,
    setGames,
    overlayLauncherInstalledState,
    showSyncNotice,
    isModalOpen: isInteractiveModalBusy,
    isCatalogVaultHydrated,
    onCatalogPersisted: handleExternalCatalogPersisted,
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
    [games, gameRefreshKey, tagOverridesVersion, criticIndexRevision]
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

      if (deferredSearchQuery.trim()) {
        const matchesTitle = matchesLooseSearchQuery(game.title, deferredSearchQuery);
        const matchesOrigTitle = matchesLooseSearchQuery(game.originalStoreTitle, deferredSearchQuery);
        if (!matchesTitle && !matchesOrigTitle) return false;
      }

      if (activeFilter) {
        if (activeFilter.type === 'os' && selectedPlatform !== 'all') {
          const mappedOs = activeGameFilterToLibraryFilterState(activeFilter).osCompatibility;
          const platOsFlags = libraryFilterIndex.entriesById
            .get(game.id)
            ?.osFlagsByPlatform.get(selectedPlatform);
          if (mappedOs.length > 0) {
            if (!platOsFlags || !mappedOs.some((opt) => platOsFlags.has(opt))) return false;
          } else if (!matchesGameFilter(game, activeFilter)) {
            return false;
          }
        } else if (!matchesGameFilter(game, activeFilter)) {
          return false;
        }
      }

      return true;
    });

    return evaluateLibraryFilter(
      baseFiltered,
      libraryFilterIndex,
      deferredLibraryFilterState,
      selectedPlatform
    );
  }, [
    games,
    selectedPlatform,
    installedOnly,
    deferredSearchQuery,
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

  const handleToggleInstalledOnly = useCallback(() => {
    setInstalledOnly((prev) => !prev);
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

  const handleOpenRunnerSetupFromSettings = useCallback(() => {
    handleCloseSettingsModal();
    const initialStep: SetupWizardStepId =
      launcherService.getHostCapabilities().supportsWindowsTranslation
        ? 'compatibility'
        : 'prerequisites';
    handleOpenSystemSetup('health_check', initialStep);
  }, [handleCloseSettingsModal, handleOpenSystemSetup]);

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

  const handleUpdateLibraryFilterState = useCallback(
    (next: LibraryFilterState) => {
      if (activeFilter) {
        const bounds = {
          minYear: libraryFilterIndex.minReleaseYear,
          maxYear: libraryFilterIndex.maxReleaseYear,
        };
        if (!doesLibraryFilterStateStillMatchActiveFilter(activeFilter, next, bounds)) {
          pushEntry({
            view: 'grid',
            selectedGameId: selectedGame?.id || null,
            activeFilter: null,
            activeGroupId,
            title: activeGroupId
              ? collections.find((c) => c.id === activeGroupId)?.name || 'Collection'
              : 'All Games',
            libraryFilterState: next,
          });
          return;
        }
      }
      updateCurrentEntry({ libraryFilterState: next });
    },
    [
      activeFilter,
      activeGroupId,
      collections,
      libraryFilterIndex.maxReleaseYear,
      libraryFilterIndex.minReleaseYear,
      pushEntry,
      selectedGame?.id,
      updateCurrentEntry,
    ]
  );

  const handleResetLibraryFilterState = useCallback(() => {
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

  const presentStorefrontsRef = useRef<readonly StorefrontId[]>([]);
  const presentStorefrontsSigRef = useRef<string>('');
  const presentStorefronts = useMemo<readonly StorefrontId[]>(() => {
    const set = new Set<StorefrontId>();
    for (let i = 0; i < games.length; i++) {
      const plats = games[i]?.platforms;
      if (!plats) continue;
      for (let j = 0; j < plats.length; j++) {
        const pid = plats[j]?.platformId;
        if (pid) set.add(pid);
      }
    }
    const sorted = Array.from(set).sort();
    const sig = sorted.join('|');
    if (sig === presentStorefrontsSigRef.current) {
      return presentStorefrontsRef.current;
    }
    presentStorefrontsSigRef.current = sig;
    presentStorefrontsRef.current = sorted;
    return sorted;
  }, [games]);

  useDocumentTitle({
    isHibernating,
    runningGamesCount: runningGames.length,
    isGridView,
    selectedGameTitle: selectedGame?.title ?? null,
    activeFilterLabel: activeFilter?.label ?? null,
    activeFilterValue: activeFilter?.value ?? null,
    activeGroupName: activeGroupData?.name ?? null,
  });

  if (isHibernating) {
    return <InGameHibernationView runningGames={runningGames} onResumeFullUi={resumeFullUi} />;
  }

  const livePoliteAnnouncement =
    !isInteractiveModalBusy && syncNotice && syncNoticeTone !== 'warning' ? syncNotice : '';
  const liveAssertiveAnnouncement =
    !isInteractiveModalBusy && syncNotice && syncNoticeTone === 'warning' ? syncNotice : '';

  return (
    <div className="h-screen w-screen bg-[#0e141b] text-steam-text flex flex-col font-steam overflow-hidden">
      <a href="#main-content" className="ol-visually-hidden ol-skip-link">
        Skip to main content
      </a>

      {/* Persistent app-shell live regions mounted outside conditionally rendered banners (WCAG 4.1.3) */}
      <div
        data-testid="app-live-region-polite"
        role="status"
        aria-live="polite"
        aria-atomic="true"
        className="ol-visually-hidden"
      >
        {livePoliteAnnouncement}
      </div>
      <div
        data-testid="app-live-region-assertive"
        role="alert"
        aria-live="assertive"
        aria-atomic="true"
        className="ol-visually-hidden"
      >
        {liveAssertiveAnnouncement}
      </div>

      {/* Top Navigation Bar */}
      <TopNavBar
        selectedPlatform={selectedPlatform}
        onSelectPlatform={setSelectedPlatform}
        installedOnly={installedOnly}
        onToggleInstalledOnly={handleToggleInstalledOnly}
        totalGamesCount={games.length}
        filteredCount={filteredGames.length}
        isSyncing={isSyncing}
        onTriggerSync={handleTriggerSync}
        onOpenIntegrations={handleOpenIntegrationsModal}
        onHomeClick={NOOP_TOP_NAV_HOME_CLICK}
        canGoBack={canGoBack}
        onGoBack={goBack}
        backTitle={backTitle}
        canGoForward={canGoForward}
        onGoForward={goForward}
        forwardTitle={forwardTitle}
        connectedStorefronts={connectedStorefronts}
        presentStorefronts={presentStorefronts}
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
        onOpenSettings={handleTopNavOpenSettings}
        systemSetupAlertCount={systemSetupAlertCount}
        onOpenAchievements={handleTopNavOpenAchievements}
        onOpenDownloads={handleOpenDownloadDrawer}
      />

      {/* Sync / Telemetry Status Banner */}
      {syncNotice && (
        <div
          data-testid="sync-status-banner"
          className={`border-b py-1.5 px-4 text-center text-xs flex items-center justify-center gap-2 flex-shrink-0 transition-all ${
            syncNoticeTone === 'warning'
              ? 'bg-amber-950/90 border-amber-600/50 text-amber-200'
              : 'bg-emerald-950/90 border-emerald-600/50 text-emerald-300'
          }`}
        >
          {syncNoticeTone === 'warning' ? (
            <AlertTriangle className="w-4 h-4 text-amber-400 flex-shrink-0" aria-hidden="true" />
          ) : (
            <CheckCircle2 className="w-4 h-4 text-emerald-400 flex-shrink-0" aria-hidden="true" />
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
          ignoreLeadingTheWhenSorting={ignoreLeadingTheWhenSorting}
        />

        {/* Right Main Pane: Storefront Detail Layout OR Group/Whole Library Grid View */}
        <main
          id="main-content"
          tabIndex={-1}
          ref={mainContentRef}
          onScroll={handleMainScroll}
          style={{ overflowAnchor: 'none' }}
          className="flex-1 h-full overflow-y-auto bg-[#0b0f14] relative focus:outline-none focus-visible:ring-2 focus-visible:ring-steam-accent focus-visible:ring-inset"
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
              onUpdateLibraryFilterState={handleUpdateLibraryFilterState}
              onResetLibraryFilterState={handleResetLibraryFilterState}
              libraryFilterIndex={libraryFilterIndex}
              unfilteredTotalCount={games.length}
              isPreFiltered={deferredLibraryFilterState === libraryFilterState}
              ignoreLeadingTheWhenSorting={ignoreLeadingTheWhenSorting}
            />
          ) : (
            <Suspense
              fallback={
                <div className="p-8 text-xs text-steam-subtext">Loading game details...</div>
              }
            >
              <SteamStorePage
                key={currentEntry.selectedGameId || selectedGame.id}
                game={selectedGame}
                collections={collections}
                availableLibraryTags={libraryFilterIndex.tagCounts}
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
            </Suspense>
          )}
        </main>
      </div>

      {/* Modal: Manage Collections */}
      {isManageCollectionsOpen && (
        <ModalErrorBoundary
          modalName="Manage Collections"
          isOpen={isManageCollectionsOpen}
          onClose={handleCloseManageCollections}
        >
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
        </ModalErrorBoundary>
      )}

      {/* Modal: Storefront Integrations & Cloud Sync */}
      {isIntegrationsModalOpen && (
        <ModalErrorBoundary
          modalName="Storefront Integrations & Cloud Sync"
          isOpen={isIntegrationsModalOpen}
          onClose={handleCloseIntegrationsModal}
        >
          <Suspense fallback={null}>
            <IntegrationsModal
              isOpen={isIntegrationsModalOpen}
              onClose={handleCloseIntegrationsModal}
              onLibraryUpdated={handleIntegrationsLibraryUpdated}
            />
          </Suspense>
        </ModalErrorBoundary>
      )}

      {/* Modal: Library Match & Overrides Studio */}
      {isMatchManagerOpen && (
        <ModalErrorBoundary
          modalName="Library Match & Overrides Studio"
          isOpen={isMatchManagerOpen}
          onClose={handleCloseMatchManager}
        >
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
        </ModalErrorBoundary>
      )}

      {/* Modal: Fix Match & Metadata Override Wizard */}
      {isFixMatchModalOpen && (
        <ModalErrorBoundary
          modalName="Fix Match & Metadata Override Wizard"
          isOpen={isFixMatchModalOpen}
          onClose={handleCloseFixMatchModal}
        >
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
        </ModalErrorBoundary>
      )}

      {/* Modal: Multi-Storefront Individual Achievements Browser */}
      {isAchievementsModalOpen && (
        <ModalErrorBoundary
          modalName="Game Achievements"
          isOpen={isAchievementsModalOpen}
          onClose={handleCloseAchievementsModal}
        >
          <Suspense fallback={null}>
            <GameAchievementsModal
              isOpen={isAchievementsModalOpen}
              game={achievementsModalGame}
              initialStorefrontId={achievementsInitialStorefrontId}
              onClose={handleCloseAchievementsModal}
            />
          </Suspense>
        </ModalErrorBoundary>
      )}

      {/* Slide-over Drawer: Universal Download & Installation Manager */}
      {isDownloadDrawerOpen && (
        <ModalErrorBoundary
          modalName="Download Manager"
          isOpen={isDownloadDrawerOpen}
          onClose={handleCloseDownloadDrawer}
        >
          <Suspense fallback={null}>
            <DownloadManagerDrawer
              isOpen={isDownloadDrawerOpen}
              onClose={handleCloseDownloadDrawer}
            />
          </Suspense>
        </ModalErrorBoundary>
      )}

      {/* Modal: Unified System Setup Wizard & Environment Health / Repair */}
      {isSystemSetupOpen && (
        <ModalErrorBoundary
          modalName="System Setup Wizard"
          isOpen={isSystemSetupOpen}
          onClose={handleCloseSystemSetup}
        >
          <Suspense fallback={null}>
            <SystemSetupWizardModal
              isOpen={isSystemSetupOpen}
              mode={systemSetupMode}
              initialStep={systemSetupInitialStep}
              focusComponentId={systemSetupFocusComponent}
              connectedStorefronts={connectedStorefronts}
              catalogGames={games}
              onClose={handleCloseSystemSetup}
              onOpenIntegrationsModal={handleOpenIntegrationsModal}
              onLibraryUpdated={handleIntegrationsLibraryUpdated}
            />
          </Suspense>
        </ModalErrorBoundary>
      )}

      {/* Modal: Global Launcher & Gameplay Settings */}
      {isSettingsOpen && (
        <ModalErrorBoundary
          modalName="Global Settings"
          isOpen={isSettingsOpen}
          onClose={handleCloseSettingsModal}
        >
          <Suspense fallback={null}>
            <SettingsModal
              isOpen={isSettingsOpen}
              initialSection={settingsInitialSection}
              onClose={handleCloseSettingsModal}
              onOpenRunnerSetup={handleOpenRunnerSetupFromSettings}
              onOpenIntegrations={handleOpenIntegrationsFromSettings}
            />
          </Suspense>
        </ModalErrorBoundary>
      )}

      {/* Global Sync Progress Bar Dock */}
      <GlobalSyncProgressBar />
    </div>
  );
}

export default App;
