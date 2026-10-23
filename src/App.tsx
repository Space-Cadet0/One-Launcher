import { useState, useMemo, useEffect, useRef, useCallback, useDeferredValue, lazy, Suspense } from 'react';
import { CanonicalGame } from './contracts/game';
import { StorefrontId } from './contracts/platform';
import { scanLocalInstalledGames, scanLocalSteamAchievements } from './services/system/localSystemScanner';
import {
  cacheUserSteamAchievements,
  cacheUserGogAchievements,
  cacheUserEpicAchievements,
  getKnownSteamAchievements,
  getKnownGogAchievements,
  getKnownEpicAchievements,
} from './services/storage/knownGameAchievements';
import { reconcileAchievementSummaries } from './services/storage/achievementReconciliation';
import { steamAchievementsService } from './services/steam/steamAchievementsService';
import { achievementDetailService } from './services/achievements/achievementDetailService';
import { TopNavBar } from './components/Navigation/TopNavBar';
import { LibrarySidebar, clearFailedSidebarIconUrls } from './components/Library/LibrarySidebar';
import { SteamStorePage } from './components/SteamStoreDetail/SteamStorePage';
import {
  LibraryGridView,
  GridSortOption,
  loadPersistedGridSort,
  clearFailedCoverUrls,
} from './components/Library/LibraryGridView';
import { igdbCoverService, isUnsuitableCoverUrl } from './services/igdb/igdbCoverService';
import { GlobalSyncProgressBar } from './components/Navigation/GlobalSyncProgressBar';
import {
  markScrollActivity,
  waitUntilScrollIdle,
  yieldToMainThread,
} from './utils/scrollActivityTracker';
import { CollectionIcon } from './components/Common/CollectionIcon';
import { matchesLooseSearchQuery } from './services/common/titleUtils';
import { syncJobManager } from './services/network/syncJobManager';
import { RequestPriority } from './services/network/requestScheduler';
import { getUserOverrideForGame } from './services/storage/userOverrideStorage';
import {
  loadIntegrations,
  saveIntegrations,
  mergeStorefrontGames,
  loadCurrentCatalog,
  saveCurrentCatalog,
  flushPendingCatalogSave,
  connectGogIntegration,
  connectEpicIntegration,
  connectXboxIntegration,
} from './services/integrations/integrationStorage';
import { steamIntegration } from './services/integrations/steamIntegration';
import { gogIntegration, normalizeGogAvatarUrl } from './services/integrations/gogIntegration';
import { epicIntegration } from './services/integrations/epicIntegration';
import { steamMatcher } from './services/steam/steamMatcher';
import { steamApi } from './services/steam/steamApi';
import {
  fallbackMetadataProvider,
  isGenericPlaceholderSynopsis,
} from './services/steam/fallbackMetadataProvider';
import {
  sanitizeGameCatalog,
  normalizeCanonicalTitle,
  registerSuppressedCatalogEntries,
} from './services/integrations/catalogSanitizer';
import {
  AlertTriangle,
  CheckCircle2,
  Layers,
  Sliders,
} from 'lucide-react';
import {
  ActiveGameFilter,
  LibraryFilterState,
  DEFAULT_LIBRARY_FILTER_STATE,
  activeGameFilterToLibraryFilterState,
} from './contracts/filter';
import { matchesGameFilter } from './services/filter/gameFilterService';
import {
  buildLibraryFilterIndex,
  evaluateLibraryFilter,
} from './services/filter/libraryFilterIndex';
import { useNavigationHistory } from './hooks/useNavigationHistory';
import { useCriticScoreWarmup } from './hooks/useCriticScoreWarmup';
import { useCollectionsManager } from './hooks/useCollectionsManager';
import { useSyncNotice } from './hooks/useSyncNotice';
import { useLauncherHibernationState } from './hooks/useLauncherHibernationState';
import { usePostSessionReconciler } from './hooks/usePostSessionReconciler';
import { useCatalogOverrideSync } from './hooks/useCatalogOverrideSync';
import {
  reconcileCatalogTrophiesRecords,
  runIntelligentNonSteamMatchPass,
} from './utils/catalogMergeUtils';
import { launcherService } from './services/launcher/launcherService';
import { InstalledGameRecord } from './contracts/launcher';
import { InGameHibernationView } from './components/Launcher/InGameHibernationView';

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
const FixMatchWizardModal = lazy(() =>
  import('./components/Library/FixMatchWizardModal').then((m) => ({
    default: m.FixMatchWizardModal,
  }))
);
const LibraryMatchManagerModal = lazy(() =>
  import('./components/Library/LibraryMatchManagerModal').then((m) => ({
    default: m.LibraryMatchManagerModal,
  }))
);
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

export function App() {
  const [games, setGames] = useState<CanonicalGame[]>(() => {
    const saved = localStorage.getItem('universal_game_library_catalog');
    if (saved) {
      try {
        const parsed = JSON.parse(saved);
        if (Array.isArray(parsed) && parsed.length > 0) {
          const cleaned = parsed.map((g: CanonicalGame) => ({
            ...g,
            platforms: g.platforms.map((p) => ({
              ...p,
              installed: launcherService.isGameInstalled(g, p.platformId),
            })),
          }));
          const sanitized = sanitizeGameCatalog(cleaned, { allowNewPurchases: true });
          try {
            saveCurrentCatalog(sanitized, { skipSanitize: true });
            flushPendingCatalogSave();
          } catch {}
          return sanitized;
        }
      } catch (e) {
        console.error('Failed to parse cached games:', e);
      }
    }
    return [];
  });

  const mainContentRef = useRef<HTMLElement | null>(null);

  const getCurrentScroll = useCallback((): number => {
    if (!mainContentRef.current) return 0;
    if (mainContentRef.current.scrollTop > 0) return mainContentRef.current.scrollTop;
    const child = mainContentRef.current.firstElementChild as HTMLElement | null;
    if (child && child.scrollTop > 0) return child.scrollTop;
    return 0;
  }, []);

  // Navigation history & state stack with scroll restoration: defaults to All Games gridview
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

  // Scroll management: when new page loads, start at top (0); when pressing back/forward, restore previous scroll level
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

  const navigateSelectGame = (game: CanonicalGame) => {
    pushEntry({
      view: 'game',
      selectedGameId: game.id,
      activeFilter: null,
      activeGroupId: null,
      title: game.title,
    });
  };

  const [libraryFilterState, setLibraryFilterState] = useState<LibraryFilterState>(
    DEFAULT_LIBRARY_FILTER_STATE
  );
  const deferredLibraryFilterState = useDeferredValue(libraryFilterState);

  const navigateApplyFilter = (filter: ActiveGameFilter) => {
    setLibraryFilterState((prev) => activeGameFilterToLibraryFilterState(filter, prev, false));
    pushEntry({
      view: 'grid',
      selectedGameId: selectedGame?.id || null,
      activeFilter: filter,
      activeGroupId: null,
      title: `${filter.label}: ${filter.value}`,
    });
  };

  const navigateHome = () => {
    pushEntry({
      view: 'grid',
      selectedGameId: selectedGame?.id || null,
      activeFilter: null,
      activeGroupId: null,
      title: 'All Games',
      scrollY: getLastAllGamesScrollY(),
    });
  };

  // Collections state & handlers
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

  const navigateSelectGroup = (groupId: string | null) => {
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
  };

  const navigateClearFilter = () => {
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
  };
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedPlatform, setSelectedPlatform] = useState<StorefrontId | 'all'>('all');
  const [installedOnly, setInstalledOnly] = useState(false);
  const [isSyncing, setIsSyncing] = useState(false);
  const [isSyncingCurrentGame, setIsSyncingCurrentGame] = useState(false);
  const [isSyncingAllMedia, setIsSyncingAllMedia] = useState(false);
  const [isSyncingScores, setIsSyncingScores] = useState(false);
  const [isSyncingTrophies, setIsSyncingTrophies] = useState(false);
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
    setGames,
    setGameRefreshKey,
    showSyncNotice,
  });

  // Integrations modal state
  const [isIntegrationsModalOpen, setIsIntegrationsModalOpen] = useState(false);

  // Individual Achievements modal state
  const [isAchievementsModalOpen, setIsAchievementsModalOpen] = useState(false);
  const [achievementsModalGame, setAchievementsModalGame] = useState<CanonicalGame | null>(null);
  const [achievementsInitialStorefrontId, setAchievementsInitialStorefrontId] = useState<StorefrontId | undefined>(undefined);

  // Track scroll/wheel activity across ANY section or modal in the app so background syncs/saves yield cleanly
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

  // Subscribe to background sync job updates
  useEffect(() => {
    const unsub = syncJobManager.subscribe((state) => {
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
    return unsub;
  }, []);

  // Connected storefronts based strictly on authenticated integration state
  const connectedStorefronts = useMemo(() => {
    try {
      const integrations = loadIntegrations();
      return integrations.filter((i) => i.isConnected).map((i) => i.storefrontId);
    } catch {
      return [] as StorefrontId[];
    }
  }, [games, isIntegrationsModalOpen, gameRefreshKey]);

  // Synchronize installed game status, tokens, and achievements against the workstation and cloud
  useEffect(() => {
    if (typeof window !== 'undefined' && window.electronAPI?.getAppInfo) {
      window.electronAPI
        .getAppInfo()
        .then((info) => {
          const previousVersion = localStorage.getItem('one_launcher_last_run_version');
          const currentVersion = info?.version || '0.1.0';
          localStorage.setItem('one_launcher_last_run_version', currentVersion);
          if (
            (previousVersion && previousVersion !== currentVersion) ||
            info?.isUpdatedLaunch === true
          ) {
            showSyncNotice(
              `Updated to One Launcher v${currentVersion} — Your library, connected accounts, and installed games have been preserved.`,
              8000
            );
          }
        })
        .catch(() => {});
    }

    // Reconcile saved native Electron tokens (Steam, GOG, Epic) into local integrations state
    if (typeof window !== 'undefined' && window.electronAPI?.getSavedTokens) {
      window.electronAPI
        .getSavedTokens()
        .then((savedTokens: any) => {
          if (!savedTokens) return;
          let updatedIntegrations = loadIntegrations();
          let integrationsChanged = false;
          const activeCatalog = loadCurrentCatalog();

          // 1. Reconcile Steam saved token
          if (savedTokens?.steam?.steamId || savedTokens?.steam?.access_token) {
            const steamInteg = updatedIntegrations.find((i) => i.storefrontId === 'steam');
            const steamId = savedTokens.steam.steamId || steamInteg?.credentials?.steamId || steamInteg?.accountId;
            const accountName = savedTokens.steam.accountName || steamInteg?.accountName || 'Steam User';
            if (
              !steamInteg ||
              !steamInteg.isConnected ||
              !steamInteg.credentials?.steamId ||
              steamInteg.accountName !== accountName
            ) {
              const count =
                (Array.isArray(savedTokens.steam.games) && savedTokens.steam.games.length) ||
                steamInteg?.gamesCount ||
                activeCatalog.filter((g) => g.platforms.some((p) => p.platformId === 'steam')).length;
              updatedIntegrations = updatedIntegrations.map((i) =>
                i.storefrontId === 'steam'
                  ? {
                      ...i,
                      isConnected: true,
                      accountName,
                      accountId: steamId,
                      avatarUrl: savedTokens.steam.avatarUrl || i.avatarUrl,
                      gamesCount: count,
                      lastSyncedAt: savedTokens.steam.updatedAt || new Date().toISOString(),
                      authMethod: 'oauth' as const,
                      credentials: {
                        ...i.credentials,
                        steamId,
                      },
                      statusMessage: `Connected as ${accountName} (${count} titles synced)`,
                    }
                  : i
              );
              integrationsChanged = true;
            }
          }

          // 2. Reconcile GOG saved token
          if (savedTokens?.gog?.access_token) {
            const gogInteg = updatedIntegrations.find((i) => i.storefrontId === 'gog');
            const gogUserId = savedTokens.gog.user_id || gogInteg?.accountId;
            const gogAvatar = normalizeGogAvatarUrl(
              savedTokens.gog.avatarUrl || gogInteg?.avatarUrl,
              savedTokens.gog.avatars
            );
            const accountName =
              savedTokens.gog.username && savedTokens.gog.username !== 'GOG User'
                ? savedTokens.gog.username
                : gogInteg?.accountName || 'GOG User';
            if (
              !gogInteg ||
              !gogInteg.isConnected ||
              gogInteg.avatarUrl !== gogAvatar ||
              gogInteg.accountName !== accountName
            ) {
              const count =
                gogInteg?.gamesCount && gogInteg.gamesCount > 0
                  ? gogInteg.gamesCount
                  : activeCatalog.filter((g) => g.platforms.some((p) => p.platformId === 'gog')).length;
              updatedIntegrations = updatedIntegrations.map((i) =>
                i.storefrontId === 'gog'
                  ? {
                      ...i,
                      isConnected: true,
                      accountName,
                      accountId: gogUserId,
                      avatarUrl: gogAvatar || i.avatarUrl,
                      gamesCount: count,
                      lastSyncedAt: savedTokens.gog.updatedAt || new Date().toISOString(),
                      authMethod: 'oauth' as const,
                      credentials: {
                        gogUsername: accountName !== 'GOG User' ? accountName : i.credentials?.gogUsername,
                      },
                      statusMessage: `Connected as ${accountName} (${count} titles synced)`,
                    }
                  : i
              );
              integrationsChanged = true;
            }
          }

          // 3. Reconcile Epic saved token
          if (savedTokens?.epic?.access_token) {
            const epicInteg = updatedIntegrations.find((i) => i.storefrontId === 'epic');
            const displayName = savedTokens.epic.displayName || 'Epic User';
            if (
              !epicInteg ||
              !epicInteg.isConnected ||
              epicInteg.accountName !== displayName ||
              !epicInteg.credentials?.epicAccountId
            ) {
              const count =
                epicInteg?.gamesCount && epicInteg.gamesCount > 0
                  ? epicInteg.gamesCount
                  : activeCatalog.filter((g) => g.platforms.some((p) => p.platformId === 'epic')).length;
              updatedIntegrations = updatedIntegrations.map((i) =>
                i.storefrontId === 'epic'
                  ? {
                      ...i,
                      isConnected: true,
                      accountName: displayName,
                      accountId: savedTokens.epic.account_id,
                      gamesCount: count,
                      lastSyncedAt: savedTokens.epic.updatedAt || new Date().toISOString(),
                      authMethod: 'oauth' as const,
                      credentials: {
                        epicAccountId: savedTokens.epic.account_id,
                        epicTokenExpiresAt: savedTokens.epic.expires_at,
                      },
                      statusMessage: `Connected as ${displayName} (${count} titles synced)`,
                    }
                  : i
              );
              integrationsChanged = true;
            }
          }

          if (Array.isArray(savedTokens?.suppressedItems) && savedTokens.suppressedItems.length > 0) {
            registerSuppressedCatalogEntries(savedTokens.suppressedItems);
            integrationsChanged = true;
          }

          if (integrationsChanged) {
            saveIntegrations(updatedIntegrations);
          }

          // Sync live storefronts & trophies in background on startup (staggered sequentially to cap peak heap)
          if (window.electronAPI?.syncStore && launcherService.getRunningGames().length === 0) {
            const syncStore = window.electronAPI.syncStore;
            (async () => {
              if (launcherService.getRunningGames().length > 0) return;
              if (savedTokens?.steam?.access_token || savedTokens?.steam?.steamId) {
                try {
                  const syncRes: any = await syncStore('steam');
                  if (Array.isArray(syncRes?.suppressedItems) && syncRes.suppressedItems.length > 0) {
                    registerSuppressedCatalogEntries(syncRes.suppressedItems);
                  }
                  if (syncRes?.achievements && Object.keys(syncRes.achievements).length > 0) {
                    cacheUserSteamAchievements(syncRes.achievements);
                  }
                  if (syncRes?.success && syncRes.games?.length > 0) {
                    await waitUntilScrollIdle(1500);
                    await yieldToMainThread();
                    const verifiedGames = syncRes.games.map((g: CanonicalGame) => ({
                      ...g,
                      isVerifiedEntitlement: true,
                    }));
                    setGames((prev) => {
                      const merged = mergeStorefrontGames(prev, verifiedGames, 'steam');
                      saveCurrentCatalog(merged, { skipSanitize: true });
                      return merged;
                    });
                  }
                } catch {}
              }

              if (savedTokens?.gog?.access_token) {
                try {
                  await yieldToMainThread();
                  const syncRes: any = await syncStore('gog');
                  if (Array.isArray(syncRes?.suppressedItems) && syncRes.suppressedItems.length > 0) {
                    registerSuppressedCatalogEntries(syncRes.suppressedItems);
                  }
                  if (syncRes?.achievements && Object.keys(syncRes.achievements).length > 0) {
                    cacheUserGogAchievements(syncRes.achievements);
                  }
                  if (syncRes?.success && syncRes.games?.length > 0) {
                    await waitUntilScrollIdle(1500);
                    await yieldToMainThread();
                    const verifiedGames = syncRes.games.map((g: CanonicalGame) => ({
                      ...g,
                      isVerifiedEntitlement: true,
                    }));
                    setGames((prev) => {
                      const merged = mergeStorefrontGames(prev, verifiedGames, 'gog');
                      saveCurrentCatalog(merged, { skipSanitize: true });
                      return merged;
                    });
                  }
                } catch {}
              }

              if (savedTokens?.epic?.access_token) {
                try {
                  await yieldToMainThread();
                  const syncRes: any = await syncStore('epic');
                  if (Array.isArray(syncRes?.suppressedItems) && syncRes.suppressedItems.length > 0) {
                    registerSuppressedCatalogEntries(syncRes.suppressedItems);
                  }
                  if (syncRes?.achievements && Object.keys(syncRes.achievements).length > 0) {
                    cacheUserEpicAchievements(syncRes.achievements);
                  }
                  if (syncRes?.success && syncRes.games?.length > 0) {
                    await waitUntilScrollIdle(1500);
                    await yieldToMainThread();
                    const verifiedGames = syncRes.games.map((g: CanonicalGame) => ({
                      ...g,
                      isVerifiedEntitlement: true,
                    }));
                    setGames((prev) => {
                      const merged = mergeStorefrontGames(prev, verifiedGames, 'epic');
                      saveCurrentCatalog(merged, { skipSanitize: true });
                      return merged;
                    });
                  }
                } catch {}
              }

              window.electronAPI?.trimMemory?.({ passive: true })?.catch?.(() => {});
            })();
          }
        })
        .catch((e: any) => console.warn('Error reading Electron tokens:', e));
    }

    async function syncLocalInstallations() {
      await launcherService.initialize();

      let allInstalledRecords: InstalledGameRecord[] = launcherService.getInstalledRecords();
      if (allInstalledRecords.length === 0) {
        try {
          allInstalledRecords = await launcherService.scanAllInstalledGames(false, {
            silentInitialBoot: true,
          });
        } catch (e) {
          console.warn('Universal installed games scan warning:', e);
        }
      }

      const epicPlatformSupport: Record<string, { windows: boolean; mac: boolean }> | undefined = (
        allInstalledRecords as any
      )?.epicPlatformSupport;

      let steamAchs: Record<number, { unlocked: number; total: number; percentage: number }> = {};
      try {
        const scanned = await scanLocalSteamAchievements();
        if (scanned && Object.keys(scanned).length > 0) {
          steamAchs = scanned;
          cacheUserSteamAchievements(scanned);
        }
      } catch (e) {
        console.warn('Steam achievements local scan failed:', e);
      }

      let installedSteamAppIds: Set<number> | null = null;
      let installedGamesList: {
        platformId?: string;
        platformGameId?: string;
        storefrontAppId?: string;
        appId?: number;
        name?: string;
        title?: string;
        installPath?: string;
        executablePath?: string;
        isWindowsBinaryOnMac?: boolean;
        installSize?: number;
        version?: string;
        launchArguments?: string;
      }[] = [];
      if (allInstalledRecords.length > 0) {
        installedSteamAppIds = new Set(
          allInstalledRecords
            .filter((r) => r.platformId === 'steam' && (r.appId || !isNaN(Number(r.platformGameId))))
            .map((r) => Number(r.appId || r.platformGameId))
        );
        installedGamesList = allInstalledRecords.map((r) => ({
          platformId: r.platformId,
          platformGameId: r.platformGameId,
          appId: r.appId || (!isNaN(Number(r.platformGameId)) ? Number(r.platformGameId) : undefined),
          name: r.title,
          title: r.title,
          installPath: r.installPath,
          executablePath: r.executablePath,
          isWindowsBinaryOnMac: r.isWindowsBinaryOnMac,
          installSize: r.installSize,
          version: r.version,
          launchArguments: r.launchArguments,
        }));
      } else {
        try {
          const scanResult = await scanLocalInstalledGames();
          if (scanResult) {
            installedSteamAppIds = new Set(scanResult.installedSteamAppIds);
            if (scanResult.installedGames) {
              installedGamesList = scanResult.installedGames;
            }
          }
        } catch (e) {
          console.warn('Local installed games scan failed:', e);
        }
      }

      setGames((prevGames) => {
        let changed = false;
        const existingAppIds = new Set<number>();
        const existingPlatformKeys = new Set<string>();
        for (const g of prevGames) {
          if (g.steamAppId) existingAppIds.add(g.steamAppId);
          for (const p of g.platforms) {
            if (p.platformId && p.platformGameId) {
              existingPlatformKeys.add(`${p.platformId}:${String(p.platformGameId).trim().toLowerCase()}`);
            }
            if (p.platformId === 'steam' && p.platformGameId) {
              const num = parseInt(p.platformGameId, 10);
              if (!isNaN(num)) existingAppIds.add(num);
            }
          }
        }

        const updated = prevGames.map((game) => {
          let gameChanged = false;
          let epicPlatformsUpdated = false;
          const targetAppId = game.steamAppId;
          const ach = targetAppId
            ? (steamAchs[targetAppId] || getKnownSteamAchievements(targetAppId, game.title))
            : null;

          const updatedPlatforms = game.platforms.map((p) => {
            let pChanged = false;
            let newP = { ...p };

            // Reconcile installed record across all storefronts (steam, gog, epic, custom)
            const matchedRecord = allInstalledRecords.find(
              (r) =>
                r.platformId === p.platformId &&
                (String(r.platformGameId) === String(p.platformGameId) ||
                  (p.platformId === 'steam' &&
                    targetAppId &&
                    Number(r.appId || r.platformGameId) === Number(targetAppId)) ||
                  Boolean(p.installPath && r.installPath && r.installPath === p.installPath))
            );

            if (matchedRecord) {
              if (
                !p.installed ||
                p.installPath !== matchedRecord.installPath ||
                p.executablePath !== matchedRecord.executablePath ||
                p.launchArguments !== (matchedRecord.launchArguments || p.launchArguments) ||
                p.installSize !== matchedRecord.installSize ||
                p.version !== matchedRecord.version ||
                p.isWindowsBinaryOnMac !== matchedRecord.isWindowsBinaryOnMac
              ) {
                newP.installed = true;
                newP.installPath = matchedRecord.installPath || p.installPath;
                newP.executablePath = matchedRecord.executablePath || p.executablePath;
                if (matchedRecord.launchArguments || p.launchArguments) {
                  newP.launchArguments = matchedRecord.launchArguments || p.launchArguments;
                }
                newP.installSize = matchedRecord.installSize ?? p.installSize;
                newP.version = matchedRecord.version || p.version;
                newP.isWindowsBinaryOnMac =
                  matchedRecord.isWindowsBinaryOnMac ?? p.isWindowsBinaryOnMac;
                pChanged = true;
              }
            } else {
              const cfg = launcherService.getLaunchConfig(game.id, p.platformId);
              const hasCustomExe = Boolean(cfg?.customExecutablePath);
              const shouldBeInstalled =
                p.platformId === 'steam' && installedSteamAppIds
                  ? Boolean(targetAppId && installedSteamAppIds.has(targetAppId)) || hasCustomExe
                  : hasCustomExe;
              if (
                p.installed !== shouldBeInstalled ||
                (!shouldBeInstalled &&
                  Boolean(p.installPath || p.executablePath || p.launchArguments || p.isWindowsBinaryOnMac))
              ) {
                newP.installed = shouldBeInstalled;
                if (!shouldBeInstalled) {
                  delete newP.installPath;
                  delete newP.executablePath;
                  delete newP.launchArguments;
                  delete newP.isWindowsBinaryOnMac;
                }
                pChanged = true;
              }
            }

            if (p.platformId === 'steam') {
              if (ach && ach.total > 0) {
                const reconciled = reconcileAchievementSummaries(
                  p.achievements,
                  {
                    unlocked: ach.unlocked,
                    total: ach.total,
                    percentage: ach.percentage,
                    isMastered: ach.percentage >= 100 || (ach.total > 0 && ach.unlocked >= ach.total),
                    source: (ach as any).source || 'local_client_cache',
                    syncedAt: (ach as any).syncedAt,
                    hasConflict: (ach as any).hasConflict,
                    conflictDetails: (ach as any).conflictDetails,
                  },
                  { title: game.title, appId: targetAppId, store: 'steam' }
                );
                if (
                  reconciled &&
                  (!p.achievements ||
                    p.achievements.unlocked !== reconciled.unlocked ||
                    p.achievements.total !== reconciled.total ||
                    p.achievements.hasConflict !== reconciled.hasConflict)
                ) {
                  newP.achievements = reconciled;
                  pChanged = true;
                }
              }
            } else if (p.platformId === 'gog') {
              const gogAch = getKnownGogAchievements(p.platformGameId || game.id, game.title);
              if (gogAch && gogAch.total > 0) {
                const reconciled = reconcileAchievementSummaries(
                  p.achievements,
                  gogAch,
                  { title: game.title, store: 'gog' }
                );
                if (
                  reconciled &&
                  (!p.achievements ||
                    p.achievements.unlocked !== reconciled.unlocked ||
                    p.achievements.total !== reconciled.total ||
                    p.achievements.hasConflict !== reconciled.hasConflict)
                ) {
                  newP.achievements = reconciled;
                  pChanged = true;
                }
              }
            } else if (p.platformId === 'epic') {
              if (epicPlatformSupport) {
                const appKey = String(p.storefrontAppId || p.platformGameId || '').toLowerCase();
                const cleanAppKey = appKey.replace(/^epic-/i, '');
                const titleKey = normalizeCanonicalTitle(game.title);
                const rawTitleKey = game.title.toLowerCase().trim();
                const alnumTitleKey = (game.title || '').toLowerCase().replace(/[^a-z0-9]/g, '');
                const epicSupport =
                  (appKey ? epicPlatformSupport[appKey] : undefined) ||
                  (cleanAppKey ? epicPlatformSupport[cleanAppKey] : undefined) ||
                  (titleKey ? epicPlatformSupport[titleKey] : undefined) ||
                  (rawTitleKey ? epicPlatformSupport[rawTitleKey] : undefined) ||
                  (alnumTitleKey ? epicPlatformSupport[alnumTitleKey] : undefined);
                if (
                  epicSupport &&
                  (!p.platforms || p.platforms.mac !== Boolean(epicSupport.mac))
                ) {
                  newP.platforms = {
                    windows: true,
                    mac: Boolean(epicSupport.mac),
                    linux: false,
                  };
                  pChanged = true;
                  epicPlatformsUpdated = true;
                }
              }
              const epicAch = getKnownEpicAchievements(game.id, game.title);
              if (epicAch && epicAch.total > 0) {
                const reconciled = reconcileAchievementSummaries(
                  p.achievements,
                  epicAch,
                  { title: game.title, store: 'epic' }
                );
                if (
                  reconciled &&
                  (!p.achievements ||
                    p.achievements.unlocked !== reconciled.unlocked ||
                    p.achievements.total !== reconciled.total ||
                    p.achievements.hasConflict !== reconciled.hasConflict)
                ) {
                  newP.achievements = reconciled;
                  pChanged = true;
                }
              }
            }

            if (pChanged) {
              gameChanged = true;
              return newP;
            }
            return p;
          });

          if (gameChanged) {
            changed = true;
            return {
              ...game,
              platforms: updatedPlatforms,
              ...(epicPlatformsUpdated ? { nativePlatforms: undefined } : {}),
            };
          }
          return game;
        });

        // Automatically add any newly discovered local Steam, GOG, or Epic games detected on disk
        if (installedGamesList && installedGamesList.length > 0) {
          for (const item of installedGamesList) {
            const platId = (item.platformId || 'steam') as StorefrontId;
            const rawTitle = (item.title || item.name || '').trim();
            if (platId === 'steam') {
              const appId = Number(item.appId || item.platformGameId);
              if (!appId || isNaN(appId) || appId <= 0) continue;
              if (!existingAppIds.has(appId)) {
                existingAppIds.add(appId);
                existingPlatformKeys.add(`steam:${appId}`);
                const title = rawTitle || `Steam App ${appId}`;
                updated.push({
                  id: `steam-${appId}`,
                  title,
                  sortTitle: title.replace(/^(The|A|An)\s+/i, '').trim(),
                  steamAppId: appId,
                  isVerifiedEntitlement: true,
                  platforms: [
                    {
                      platformId: 'steam',
                      platformGameId: String(appId),
                      installed: true,
                      installPath: item.installPath,
                      executablePath: item.executablePath,
                      isWindowsBinaryOnMac: (item as any).isWindowsBinaryOnMac,
                      installSize: (item as any).installSize,
                      version: (item as any).version,
                      launchArguments: (item as any).launchArguments,
                    },
                  ],
                  headerImage: `https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/${appId}/header.jpg`,
                  capsuleImage: `https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/${appId}/library_600x900.jpg`,
                  shortDescription: '',
                  releaseDate: 'TBA',
                  developers: [],
                  publishers: [],
                  genres: [],
                  tags: [],
                });
                changed = true;
              }
            } else if (platId === 'gog' || platId === 'epic') {
              const storefrontAppId = String(
                item.platformGameId || item.storefrontAppId || (item.appId && item.appId > 0 ? item.appId : '')
              ).trim();
              if (!rawTitle || !storefrontAppId) continue;
              const platKey = `${platId}:${storefrontAppId.toLowerCase()}`;
              if (existingPlatformKeys.has(platKey)) continue;
              existingPlatformKeys.add(platKey);

              const normTitle = normalizeCanonicalTitle(rawTitle);
              const matchedIdx = normTitle
                ? updated.findIndex((g) => normalizeCanonicalTitle(g.title) === normTitle)
                : -1;
              if (matchedIdx >= 0) {
                const targetGame = updated[matchedIdx];
                if (!targetGame.platforms.some((p) => p.platformId === platId)) {
                  updated[matchedIdx] = {
                    ...targetGame,
                    platforms: [
                      ...targetGame.platforms,
                      {
                        platformId: platId,
                        platformGameId: storefrontAppId,
                        installed: true,
                        installPath: item.installPath,
                        executablePath: item.executablePath,
                        isWindowsBinaryOnMac: (item as any).isWindowsBinaryOnMac,
                        installSize: (item as any).installSize,
                        version: (item as any).version,
                        launchArguments: (item as any).launchArguments,
                      },
                    ],
                  };
                  changed = true;
                }
              } else {
                const matchedSteamId = steamMatcher.matchGameToSteamInstant(rawTitle) || undefined;
                updated.push({
                  id: matchedSteamId ? `steam-${matchedSteamId}` : `${platId}-${storefrontAppId}`,
                  title: rawTitle,
                  sortTitle: rawTitle.replace(/^(The|A|An)\s+/i, '').trim(),
                  steamAppId: matchedSteamId,
                  isVerifiedEntitlement: true,
                  platforms: [
                    {
                      platformId: platId,
                      platformGameId: storefrontAppId,
                      installed: true,
                      installPath: item.installPath,
                      executablePath: item.executablePath,
                      isWindowsBinaryOnMac: (item as any).isWindowsBinaryOnMac,
                      installSize: (item as any).installSize,
                      version: (item as any).version,
                      launchArguments: (item as any).launchArguments,
                    },
                  ],
                  headerImage: matchedSteamId
                    ? `https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/${matchedSteamId}/header.jpg`
                    : '',
                  capsuleImage: matchedSteamId
                    ? `https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/${matchedSteamId}/library_600x900.jpg`
                    : undefined,
                  shortDescription: '',
                  releaseDate: 'TBA',
                  developers: [],
                  publishers: [],
                  genres: [],
                  tags: [],
                });
                changed = true;
              }
            }
          }
        }

        if (changed) {
          saveCurrentCatalog(updated, { skipSanitize: true });
          return updated;
        }
        return prevGames;
      });

      // Background live Steam cloud sync for player achievements
      if (
        launcherService.getRunningGames().length === 0 &&
        loadIntegrations().some((i) => i.storefrontId === 'steam' && i.isConnected) &&
        !steamAchievementsService.hasRecentFullSync()
      ) {
        syncJobManager
          .trackTask('achievements', 'Steam Library', () =>
            steamAchievementsService.syncUserLibraryAchievements(loadCurrentCatalog())
          )
          .then((liveSyncMap) => {
            if (liveSyncMap && Object.keys(liveSyncMap).length > 0) {
              setGames((currentGames) => {
                let updatedAny = false;
                const refreshedCatalog = currentGames.map((game) => {
                  if (!game.steamAppId || !liveSyncMap[game.steamAppId]) return game;
                  const liveAch = liveSyncMap[game.steamAppId];
                  let platChanged = false;
                  const newPlatforms = game.platforms.map((p) => {
                    if (p.platformId === 'steam') {
                      if (
                        p.achievements?.unlocked !== liveAch.unlocked ||
                        p.achievements?.total !== liveAch.total
                      ) {
                        platChanged = true;
                        return { ...p, achievements: liveAch };
                      }
                    }
                    return p;
                  });
                  if (platChanged) {
                    updatedAny = true;
                    return { ...game, platforms: newPlatforms };
                  }
                  return game;
                });

                if (updatedAny) {
                  try {
                    saveCurrentCatalog(refreshedCatalog);
                  } catch {}
                  return refreshedCatalog;
                }
                return currentGames;
              });
            }
          })
          .catch((e) => console.warn('Background Steam achievements sync:', e));
      }
    }

    syncLocalInstallations();
  }, []);

  // Proactive Background Critic Score Warm-Up & Automatic Hydration
  useCriticScoreWarmup(games);

  // Reactively persist newly discovered Steam App IDs, GOG covers, game sessions, and installation events
  usePostSessionReconciler({ setGames, showSyncNotice });

  const handleToggleInstallStatus = (
    gameToToggle?: CanonicalGame | null,
    platformId?: StorefrontId
  ) => {
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

    setGames((prev) => {
      const updated = prev.map((g) => {
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
      saveCurrentCatalog(updated, { skipSanitize: true });
      return updated;
    });
  };

  const libraryFilterIndex = useMemo(
    () => buildLibraryFilterIndex(games),
    [games, gameRefreshKey]
  );

  // Filtered games list for the sidebar and grid
  const filteredGames = useMemo(() => {
    const baseFiltered = games.filter((game) => {
      // Platform filter
      if (selectedPlatform !== 'all') {
        const hasPlatform = game.platforms.some((p) => p.platformId === selectedPlatform);
        if (!hasPlatform) return false;
      }

      // Installed filter
      if (installedOnly) {
        const isInstalled =
          game.platforms.some((p) => p.installed) || launcherService.isGameInstalled(game);
        if (!isInstalled) return false;
      }

      // Search query (Title-only: display title and original storefront title)
      if (searchQuery.trim()) {
        const matchesTitle = matchesLooseSearchQuery(game.title, searchQuery);
        const matchesOrigTitle = matchesLooseSearchQuery(game.originalStoreTitle, searchQuery);
        if (!matchesTitle && !matchesOrigTitle) return false;
      }

      // Temporary Active Link Filter (Developer, Publisher, Feature like HDR available, Genre, Tag)
      if (activeFilter) {
        if (!matchesGameFilter(game, activeFilter)) return false;
      }

      return true;
    });

    return evaluateLibraryFilter(
      baseFiltered,
      libraryFilterIndex,
      deferredLibraryFilterState
    );
  }, [
    games,
    selectedPlatform,
    installedOnly,
    searchQuery,
    activeFilter,
    libraryFilterIndex,
    deferredLibraryFilterState,
  ]);

  // Active group data for grid view filtering
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

  // Shared helper to reconcile achievements and installation state across the game catalog
  const reconcileCatalogTrophies = useCallback(reconcileCatalogTrophiesRecords, []);

  // Trigger library cloud sync across all connected storefronts (Steam, GOG, Epic, Xbox)
  const handleTriggerSync = async () => {
    setIsSyncing(true);
    showSyncNotice('Syncing all connected storefront accounts & detecting new purchases...');

    try {
      const integrations = loadIntegrations();
      let currentCatalog = games;
      const initialCount = currentCatalog.length;

      // 0. Steam local achievements & local installation scan
      let installedSteamAppIds: Set<number> | null = null;
      let steamAchs: Record<number, any> = {};
      let gogAchs: Record<string, any> = {};
      let epicAchs: Record<string, any> = {};
      try {
        const [scannedAchs, scanResult] = await Promise.allSettled([
          scanLocalSteamAchievements(),
          scanLocalInstalledGames(),
        ]);
        if (scannedAchs.status === 'fulfilled' && scannedAchs.value && Object.keys(scannedAchs.value).length > 0) {
          steamAchs = scannedAchs.value;
          cacheUserSteamAchievements(steamAchs);
        }
        if (scanResult.status === 'fulfilled' && scanResult.value) {
          installedSteamAppIds = new Set(scanResult.value.installedSteamAppIds);
        }
      } catch {}

      // 1. Steam sync (owned games, playtime, lastPlayed & achievements)
      const steamInteg = integrations.find((i) => i.storefrontId === 'steam' && i.isConnected);
      if (steamInteg) {
        await syncJobManager.trackTask('storefront_libraries', 'Steam', async () => {
          try {
            if (typeof window !== 'undefined' && window.electronAPI?.syncStore) {
              const steamRes = await window.electronAPI.syncStore('steam');
              if (Array.isArray(steamRes?.suppressedItems) && steamRes.suppressedItems.length > 0) {
                registerSuppressedCatalogEntries(steamRes.suppressedItems);
              }
              if (steamRes?.achievements && Object.keys(steamRes.achievements).length > 0) {
                steamAchs = { ...steamAchs, ...steamRes.achievements };
                cacheUserSteamAchievements(steamAchs);
              }
              if (steamRes?.success && steamRes.games && steamRes.games.length > 0) {
                const verifiedSteamGames = steamRes.games.map((g: CanonicalGame) => ({
                  ...g,
                  isVerifiedEntitlement: true,
                }));
                currentCatalog = mergeStorefrontGames(currentCatalog, verifiedSteamGames, 'steam');
                try {
                  const liveAchs = await steamAchievementsService.syncUserLibraryAchievements(verifiedSteamGames);
                  if (liveAchs && Object.keys(liveAchs).length > 0) {
                    steamAchs = { ...steamAchs, ...liveAchs };
                    cacheUserSteamAchievements(steamAchs);
                  }
                } catch {}
              } else if (steamInteg.credentials?.steamId) {
                const res = await steamIntegration.fetchOwnedGames(steamInteg.credentials);
                currentCatalog = mergeStorefrontGames(currentCatalog, res.games, 'steam');
              }
            } else if (steamInteg.credentials?.steamId) {
              const res = await steamIntegration.fetchOwnedGames(steamInteg.credentials);
              currentCatalog = mergeStorefrontGames(currentCatalog, res.games, 'steam');
            }
          } catch (e) {
            console.warn('Steam sync warning:', e);
          }
        });
      }

      // 2. GOG sync (via Electron native store:sync or web fallback)
      const gogInteg = integrations.find((i) => i.storefrontId === 'gog' && i.isConnected);
      if (gogInteg) {
        await syncJobManager.trackTask('storefront_libraries', 'GOG.com', async () => {
          try {
            let syncedGog = false;
            if (typeof window !== 'undefined' && window.electronAPI?.syncStore) {
              const gogRes = await window.electronAPI.syncStore('gog', gogInteg.credentials);
              if (Array.isArray(gogRes?.suppressedItems) && gogRes.suppressedItems.length > 0) {
                registerSuppressedCatalogEntries(gogRes.suppressedItems);
              }
              if (gogRes?.achievements && Object.keys(gogRes.achievements).length > 0) {
                gogAchs = { ...gogAchs, ...gogRes.achievements };
                cacheUserGogAchievements(gogAchs);
              }
              if (gogRes?.success && gogRes.games && gogRes.games.length > 0) {
                const verifiedGogGames = gogRes.games.map((g: CanonicalGame) => ({
                  ...g,
                  isVerifiedEntitlement: true,
                }));
                currentCatalog = mergeStorefrontGames(currentCatalog, verifiedGogGames, 'gog');
                syncedGog = true;
              }
            }
            if (!syncedGog) {
              const { games: gogGames } = await connectGogIntegration(gogInteg.credentials || {});
              if (gogGames && gogGames.length > 0) {
                currentCatalog = mergeStorefrontGames(currentCatalog, gogGames, 'gog');
              }
            }
          } catch (e) {
            console.warn('GOG sync warning:', e);
          }
        });
      }

      // 3. Epic Games Store sync (via Electron native store:sync or web fallback)
      const epicInteg = integrations.find((i) => i.storefrontId === 'epic' && i.isConnected);
      if (epicInteg) {
        await syncJobManager.trackTask('storefront_libraries', 'Epic Games Store', async () => {
          try {
            let syncedEpic = false;
            if (typeof window !== 'undefined' && window.electronAPI?.syncStore) {
              const epicRes = await window.electronAPI.syncStore('epic', epicInteg.credentials);
              if (Array.isArray(epicRes?.suppressedItems) && epicRes.suppressedItems.length > 0) {
                registerSuppressedCatalogEntries(epicRes.suppressedItems);
              }
              if (epicRes?.achievements && Object.keys(epicRes.achievements).length > 0) {
                epicAchs = { ...epicAchs, ...epicRes.achievements };
                cacheUserEpicAchievements(epicAchs);
              }
              if (epicRes?.success && epicRes.games && epicRes.games.length > 0) {
                const verifiedEpicGames = epicRes.games.map((g: CanonicalGame) => ({
                  ...g,
                  isVerifiedEntitlement: true,
                }));
                currentCatalog = mergeStorefrontGames(currentCatalog, verifiedEpicGames, 'epic');
                syncedEpic = true;
              }
            }
            if (!syncedEpic) {
              const { games: epicGames } = await connectEpicIntegration(epicInteg.credentials || {});
              if (epicGames && epicGames.length > 0) {
                currentCatalog = mergeStorefrontGames(currentCatalog, epicGames, 'epic');
              }
            }
          } catch (e) {
            console.warn('Epic sync warning:', e);
          }
        });
      }

      // 4. Xbox sync
      const xboxInteg = integrations.find((i) => i.storefrontId === 'xbox' && i.isConnected);
      if (xboxInteg) {
        await syncJobManager.trackTask('storefront_libraries', 'Xbox', async () => {
          try {
            const { games: xboxGames } = await connectXboxIntegration(xboxInteg.credentials || {});
            currentCatalog = mergeStorefrontGames(currentCatalog, xboxGames, 'xbox');
          } catch (e) {
            console.warn('Xbox sync warning:', e);
          }
        });
      }

      // 5. Intelligent Steam Match Pass for Non-Steam Titles
      currentCatalog = runIntelligentNonSteamMatchPass(currentCatalog);

      // 6. Reconciliation pass: update achievements & local installed flags across current catalog
      currentCatalog = reconcileCatalogTrophies(
        currentCatalog,
        steamAchs,
        gogAchs,
        epicAchs,
        installedSteamAppIds
      );
      achievementDetailService.clearCache();

      // 7. Final catalog sanitization (removes raw hex hashes & Fortnite DLC entries)
      currentCatalog = sanitizeGameCatalog(currentCatalog);

      // 8. Update integration counts and last synced timestamps
      const steamCount = currentCatalog.filter((g) => g.platforms?.some((p) => p.platformId === 'steam')).length;
      const gogCount = currentCatalog.filter((g) => g.platforms?.some((p) => p.platformId === 'gog')).length;
      const epicCount = currentCatalog.filter((g) => g.platforms?.some((p) => p.platformId === 'epic')).length;
      const xboxCount = currentCatalog.filter((g) => g.platforms?.some((p) => p.platformId === 'xbox')).length;

      const nowIso = new Date().toISOString();
      const updatedIntegrations = integrations.map((item) => {
        if (!item.isConnected) return item;
        let count = item.gamesCount;
        if (item.storefrontId === 'steam') count = steamCount;
        else if (item.storefrontId === 'gog') count = gogCount;
        else if (item.storefrontId === 'epic') count = epicCount;
        else if (item.storefrontId === 'xbox') count = xboxCount;
        return {
          ...item,
          gamesCount: count,
          lastSyncedAt: nowIso,
          statusMessage: `Connected as ${item.accountName || 'User'} (${count} ${item.name} titles synced)`,
        };
      });
      saveIntegrations(updatedIntegrations);

      const newGamesDetected = Math.max(0, currentCatalog.length - initialCount);
      setGames(currentCatalog);
      saveCurrentCatalog(currentCatalog);
      setGameRefreshKey((k) => k + 1);

      if (newGamesDetected > 0) {
        showSyncNotice(
          `Sync complete! Detected ${newGamesDetected} newly added title${newGamesDetected === 1 ? '' : 's'} across your storefronts! (${currentCatalog.length} total titles)`,
          5000
        );
      } else {
        const connectedStores = updatedIntegrations.filter((i) => i.isConnected);
        const storeParts = connectedStores.map((i) => {
          if (i.storefrontId === 'steam') return `${steamCount} Steam`;
          if (i.storefrontId === 'gog') return `${gogCount} GOG`;
          if (i.storefrontId === 'epic') return `${epicCount} Epic`;
          if (i.storefrontId === 'xbox') return `${xboxCount} Xbox`;
          return `${i.gamesCount} ${i.name}`;
        });
        showSyncNotice(
          `All connected storefronts up to date: ${storeParts.join(', ')} titles (trophies & playtime refreshed)`,
          5000
        );
      }
    } catch (err: any) {
      showSyncNotice(`Sync notice: ${err?.message || 'Using cached verified catalog'}`, 5000);
    } finally {
      setIsSyncing(false);
      window.electronAPI?.trimMemory?.({ passive: true })?.catch?.(() => {});
    }
  };

  // Dedicated cross-storefront Trophy & Achievement synchronization (Steam, GOG, Epic)
  const handleSyncTrophies = async () => {
    if (isSyncingTrophies) return;
    setIsSyncingTrophies(true);
    showSyncNotice('Syncing trophies & achievements across Steam, GOG.com, and Epic Games Store...');

    try {
      const integrations = loadIntegrations();
      const steamAchs: Record<number, any> = {};
      const gogAchs: Record<string, any> = {};
      const epicAchs: Record<string, any> = {};

      await syncJobManager.startTrophySync(4, async (updateProgress, checkCancelled) => {
        // Step 1: Local Steam Client LibraryCache Scan
        updateProgress(0, 4, 'Scanning Local Steam Trophy Cache');
        try {
          const localScanned = await scanLocalSteamAchievements();
          if (localScanned && Object.keys(localScanned).length > 0) {
            Object.assign(steamAchs, localScanned);
            cacheUserSteamAchievements(steamAchs);
          }
        } catch {}
        if (checkCancelled()) return;

        // Step 2: Steam Cloud & Batch Achievements Sync
        updateProgress(1, 4, 'Syncing Steam Cloud Achievements');
        try {
          const liveSteam = await steamAchievementsService.syncUserLibraryAchievements(
            games,
            (_done, _total, currentTitle) => {
              if (!checkCancelled()) {
                updateProgress(1, 4, currentTitle ? `Steam: ${currentTitle}` : 'Syncing Steam Cloud Achievements');
              }
            },
            {
              forceRefresh: true,
              onBatchUpdated: (partialSteam) => {
                Object.assign(steamAchs, partialSteam);
                cacheUserSteamAchievements(steamAchs);
                setGames((prev) => {
                  const updated = reconcileCatalogTrophies(prev, steamAchs, gogAchs, epicAchs);
                  saveCurrentCatalog(updated);
                  return updated;
                });
              },
            }
          );
          if (liveSteam && Object.keys(liveSteam).length > 0) {
            Object.assign(steamAchs, liveSteam);
            cacheUserSteamAchievements(steamAchs);
          }
        } catch (err) {
          console.warn('Steam trophy sync warning:', err);
        }
        if (checkCancelled()) return;

        // Step 3: GOG Galaxy Achievements Sync
        updateProgress(2, 4, 'Syncing GOG Galaxy Achievements');
        try {
          const gogInteg = integrations.find((i) => i.storefrontId === 'gog' && i.isConnected);
          const gogUsername = gogInteg?.credentials?.gogUsername || gogInteg?.accountName;
          const gogToken = gogInteg?.credentials?.gogToken;
          const gogUserId = gogInteg?.accountId;
          const { achievements: fetchedGog } = await gogIntegration.fetchUserAchievementsAndStats(
            gogUsername || '',
            gogToken,
            gogUserId
          );
          if (fetchedGog && Object.keys(fetchedGog).length > 0) {
            Object.assign(gogAchs, fetchedGog);
            cacheUserGogAchievements(gogAchs);
          } else if (typeof window !== 'undefined' && window.electronAPI?.syncStore) {
            const gogRes = await window.electronAPI.syncStore('gog', gogInteg?.credentials);
            if (gogRes?.achievements && Object.keys(gogRes.achievements).length > 0) {
              Object.assign(gogAchs, gogRes.achievements);
              cacheUserGogAchievements(gogAchs);
            }
          }
        } catch (err) {
          console.warn('GOG trophy sync warning:', err);
        }
        if (checkCancelled()) return;

        // Step 4: Epic Games Store Achievements Sync
        updateProgress(3, 4, 'Syncing Epic Games Store Trophies');
        try {
          const epicInteg = integrations.find((i) => i.storefrontId === 'epic' && i.isConnected);
          const epicAccountId = epicInteg?.credentials?.epicAccountId || epicInteg?.accountId || '';
          const epicToken = epicInteg?.credentials?.epicToken;
          const fetchedEpic = await epicIntegration.fetchUserAchievements(epicAccountId, epicToken);
          if (fetchedEpic && Object.keys(fetchedEpic).length > 0) {
            Object.assign(epicAchs, fetchedEpic);
            cacheUserEpicAchievements(epicAchs);
          } else if (typeof window !== 'undefined' && window.electronAPI?.syncStore) {
            const epicRes = await window.electronAPI.syncStore('epic', epicInteg?.credentials);
            if (epicRes?.achievements && Object.keys(epicRes.achievements).length > 0) {
              Object.assign(epicAchs, epicRes.achievements);
              cacheUserEpicAchievements(epicAchs);
            }
          }
        } catch (err) {
          console.warn('Epic trophy sync warning:', err);
        }

        updateProgress(4, 4, 'Reconciling Storefront Trophies');
      });

      achievementDetailService.clearCache();

      let gamesWithTrophies = 0;
      setGames((prev) => {
        const reconciled = reconcileCatalogTrophies(prev, steamAchs, gogAchs, epicAchs);
        gamesWithTrophies = reconciled.filter((g) =>
          g.platforms.some((p) => p.achievements && (p.achievements.unlocked > 0 || p.achievements.total > 0))
        ).length;
        saveCurrentCatalog(reconciled);
        return reconciled;
      });

      setGameRefreshKey((k) => k + 1);
      showSyncNotice(
        `Trophies synced across Steam, GOG & Epic! (${gamesWithTrophies} titles with achievement data updated)`,
        5000
      );
    } catch (err: any) {
      showSyncNotice(`Trophy sync notice: ${err?.message || 'Finished syncing trophies'}`, 5000);
    } finally {
      setIsSyncingTrophies(false);
      window.electronAPI?.trimMemory?.({ passive: true })?.catch?.(() => {});
    }
  };

  // Check if syncing the currently viewed game is applicable
  const canSyncCurrentGame = useMemo(() => {
    return Boolean(!isGridView && selectedGame);
  }, [isGridView, selectedGame]);

  // Synchronize official store metadata, achievements, and media for a single game (On-Demand Priority)
  const handleSyncCurrentGame = async (gameToSync?: CanonicalGame) => {
    const target = gameToSync || selectedGame;
    if (!target || isSyncingCurrentGame) return;
    const targetAppId = steamMatcher.getEffectiveSteamAppId(target);
    const gogId = target.platforms?.find((p) => p.platformId === 'gog')?.platformGameId;

    // Evict any negative or stale caches for this game so manual sync always performs a fresh resolution
    igdbCoverService.evictCacheForGame(target.title, gogId, targetAppId);
    if (targetAppId) {
      steamApi.evictCache(targetAppId);
    }
    clearFailedCoverUrls(target.id);
    clearFailedSidebarIconUrls();

    setIsSyncingCurrentGame(true);
    showSyncNotice(
      targetAppId
        ? `Syncing ${target.title} from Steam...`
        : `Syncing ${target.title} store metadata...`
    );

    try {
      await syncJobManager.runPriorityAction('Syncing Game Media', target.title, async () => {
        if (!targetAppId) {
          const [refreshed, gogBoxArt, igdbCover] = await Promise.all([
            fallbackMetadataProvider.getEnrichedMetadataForNonSteamGame(target).catch(() => null),
            gogId
              ? igdbCoverService
                  .fetchGogVerticalCover(gogId, target.title, RequestPriority.P0_INTERACTIVE)
                  .catch(() => null)
              : Promise.resolve(null),
            igdbCoverService
              .fetchIgdbCover(
                target.title,
                target.releaseDate,
                RequestPriority.P0_INTERACTIVE
              )
              .catch(() => null),
          ]);

          const validRefreshedCapsule =
            gogBoxArt ||
            (refreshed?.capsuleImage && !isUnsuitableCoverUrl(refreshed.capsuleImage)
              ? refreshed.capsuleImage
              : undefined) ||
            igdbCover;

          if (refreshed || validRefreshedCapsule) {
            setGames((prevGames) => {
              const updated = prevGames.map((g) => {
                if (g.id === target.id) {
                  const cleanDevelopers = refreshed?.developers?.filter(
                    (d) => d && d !== 'Unknown Developer'
                  );
                  const existingValidCapsule =
                    g.capsuleImage && !isUnsuitableCoverUrl(g.capsuleImage)
                      ? g.capsuleImage
                      : undefined;
                  return {
                    ...g,
                    enrichedMetadata: refreshed || g.enrichedMetadata,
                    headerImage: refreshed?.headerImage || g.headerImage,
                    capsuleImage: validRefreshedCapsule || existingValidCapsule,
                    shortDescription:
                      refreshed?.shortDescription &&
                      !isGenericPlaceholderSynopsis(refreshed.shortDescription, target.title)
                        ? refreshed.shortDescription
                        : g.shortDescription,
                    detailedDescription:
                      refreshed?.detailedDescription ||
                      refreshed?.aboutTheGame ||
                      g.detailedDescription,
                    developers: cleanDevelopers?.length ? cleanDevelopers : g.developers,
                    publishers: refreshed?.publishers?.length ? refreshed.publishers : g.publishers,
                    releaseDate:
                      refreshed?.releaseDate && refreshed.releaseDate !== 'TBA'
                        ? refreshed.releaseDate
                        : g.releaseDate,
                    genres: refreshed?.genres?.length ? refreshed.genres : g.genres,
                    tags: refreshed?.tags?.length ? refreshed.tags : g.tags,
                    reviewSummary: refreshed?.reviewSummary || g.reviewSummary,
                  };
                }
                return g;
              });
              try {
                saveCurrentCatalog(updated);
              } catch {}
              return updated;
            });
            setGameRefreshKey((prev) => prev + 1);
            showSyncNotice(`Successfully synced ${target.title} metadata!`, 5000);
          } else {
            showSyncNotice(`No new metadata updates found for ${target.title}.`, 5000);
          }
          return;
        }

        try {
          const steamAchs = await scanLocalSteamAchievements();
          if (steamAchs && Object.keys(steamAchs).length > 0) {
            cacheUserSteamAchievements(steamAchs);
          }
        } catch {}

        const [refreshed, browseAssets, liveAchs] = await Promise.all([
          steamApi.fetchGameMetadata(targetAppId, RequestPriority.P0_INTERACTIVE),
          steamApi.fetchStoreBrowseAssets(targetAppId),
          steamAchievementsService.fetchPlayerGameAchievements(targetAppId),
        ]);

        let resolvedVerticalCover =
          (refreshed?.capsuleImage && !isUnsuitableCoverUrl(refreshed.capsuleImage)
            ? refreshed.capsuleImage
            : undefined) ||
          (browseAssets?.capsuleImage && !isUnsuitableCoverUrl(browseAssets.capsuleImage)
            ? browseAssets.capsuleImage
            : undefined);

        if (!resolvedVerticalCover) {
          resolvedVerticalCover =
            (await igdbCoverService
              .fetchIgdbCover(
                target.title,
                refreshed?.releaseDate || target.releaseDate,
                RequestPriority.P0_INTERACTIVE
              )
              .catch(() => null)) || undefined;
        }

        if (refreshed || browseAssets || resolvedVerticalCover || liveAchs) {
          setGames((prevGames) => {
            const updated = prevGames.map((g) => {
              if (g.id === target.id) {
                const updatedPlatforms = g.platforms.map((p) => {
                  if (p.platformId === 'steam' && liveAchs) {
                    return {
                      ...p,
                      achievements: liveAchs,
                    };
                  }
                  return p;
                });

                const existingValidCapsule =
                  g.capsuleImage && !isUnsuitableCoverUrl(g.capsuleImage)
                    ? g.capsuleImage
                    : undefined;

                return {
                  ...g,
                  steamAppId: targetAppId,
                  platforms: updatedPlatforms,
                  enrichedMetadata: refreshed || g.enrichedMetadata,
                  headerImage:
                    refreshed?.headerImage || browseAssets?.headerImage || g.headerImage,
                  capsuleImage: resolvedVerticalCover || existingValidCapsule,
                  iconUrl: browseAssets?.iconUrl || g.iconUrl,
                  shortDescription: refreshed?.shortDescription || g.shortDescription,
                  developers: refreshed?.developers?.length ? refreshed.developers : g.developers,
                  publishers: refreshed?.publishers?.length ? refreshed.publishers : g.publishers,
                  genres: refreshed?.genres?.length ? refreshed.genres : g.genres,
                  tags: refreshed?.tags?.length ? refreshed.tags : g.tags,
                  reviewSummary: refreshed?.reviewSummary || g.reviewSummary,
                };
              }
              return g;
            });
            try {
              saveCurrentCatalog(updated);
            } catch {}
            return updated;
          });
          setGameRefreshKey((prev) => prev + 1);
          showSyncNotice(`Successfully synced ${target.title} from Steam!`, 5000);
        } else {
          showSyncNotice(`No new updates found on Steam for ${target.title}.`, 5000);
        }
      });
    } catch (err: any) {
      showSyncNotice(`Sync notice: ${err?.message || 'Error syncing game'}`, 5000);
    } finally {
      setIsSyncingCurrentGame(false);
    }
  };

  // Synchronize official store media (screenshots, trailers, movies, descriptions) across library titles
  const handleSyncStoreMedia = async () => {
    if (isSyncingAllMedia) return;
    setIsSyncingAllMedia(true);
    showSyncNotice('Starting store media sync (trailers, screenshots & descriptions)...', 3000);

    const pendingMediaUpdates = new Map<string, CanonicalGame>();
    let mediaFlushTimer: ReturnType<typeof setTimeout> | null = null;
    const isVitest = typeof process !== 'undefined' && Boolean((process as any).env?.VITEST);

    const flushMediaBatch = () => {
      mediaFlushTimer = null;
      if (pendingMediaUpdates.size === 0) return;
      const batch = new Map(pendingMediaUpdates);
      pendingMediaUpdates.clear();

      setGames((prev) => {
        let changed = false;
        const next = prev.map((g) => {
          const updated = batch.get(g.id);
          if (updated) {
            changed = true;
            return updated;
          }
          return g;
        });
        if (!changed) return prev;
        saveCurrentCatalog(next, { skipSanitize: true });
        return next;
      });
    };

    try {
      await syncJobManager.startStoreMediaSync(games, (updatedGame) => {
        pendingMediaUpdates.set(updatedGame.id, updatedGame);
        if (isVitest) {
          flushMediaBatch();
        } else if (!mediaFlushTimer) {
          mediaFlushTimer = setTimeout(flushMediaBatch, 350);
        }
      });
      if (mediaFlushTimer) {
        clearTimeout(mediaFlushTimer);
        mediaFlushTimer = null;
      }
      flushMediaBatch();
      showSyncNotice('Store media sync complete! Refreshed trailers, screenshots & descriptions.', 5000);
    } catch (err: any) {
      if (mediaFlushTimer) {
        clearTimeout(mediaFlushTimer);
        mediaFlushTimer = null;
      }
      flushMediaBatch();
      showSyncNotice(`Media sync notice: ${err?.message || 'Finished media sync'}`, 5000);
    } finally {
      if (mediaFlushTimer) {
        clearTimeout(mediaFlushTimer);
        mediaFlushTimer = null;
      }
      setIsSyncingAllMedia(false);
      window.electronAPI?.trimMemory?.({ passive: true })?.catch?.(() => {});
    }
  };

  // Refresh and verify critic ratings across library titles
  const handleRefreshScores = async () => {
    if (isSyncingScores) return;
    setIsSyncingScores(true);
    showSyncNotice('Starting critic score refresh across OpenCritic, Metacritic & Steam...', 3000);

    try {
      await syncJobManager.startCriticScoreSync(games, {
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

      showSyncNotice(`Critic scores refreshed across your library.`, 5000);
    } catch (err: any) {
      console.warn('Score refresh error:', err);
      showSyncNotice('Finished refreshing available critic scores.', 5000);
    } finally {
      setIsSyncingScores(false);
      window.electronAPI?.trimMemory?.({ passive: true })?.catch?.(() => {});
    }
  };

  const handleGameUpdated = (updatedGame: CanonicalGame) => {
    setGames((prev) => {
      const updated = prev.map((g) => (g.id === updatedGame.id ? updatedGame : g));
      try {
        saveCurrentCatalog(updated);
      } catch {}
      return updated;
    });
  };

  // Individual Achievements Modal Handler
  const handleOpenAchievements = useCallback((gameToView?: CanonicalGame, storefrontId?: StorefrontId) => {
    const targetGame = gameToView || selectedGame;
    if (targetGame) {
      setAchievementsModalGame(targetGame);
      setAchievementsInitialStorefrontId(storefrontId);
      setIsAchievementsModalOpen(true);
    }
  }, [selectedGame]);

  if (isHibernating) {
    return (
      <InGameHibernationView
        runningGames={runningGames}
        onResumeFullUi={resumeFullUi}
      />
    );
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
        onToggleInstalledOnly={() => setInstalledOnly(!installedOnly)}
        totalGamesCount={games.length}
        filteredCount={filteredGames.length}
        isSyncing={isSyncing}
        onTriggerSync={handleTriggerSync}
        onOpenIntegrations={() => setIsIntegrationsModalOpen(true)}
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
        onOpenFixMatch={() => handleOpenFixMatch()}
        onOpenLibraryMatchManager={() => setIsMatchManagerOpen(true)}
        onOpenAchievements={() => handleOpenAchievements(selectedGame)}
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
            <AlertTriangle className="w-4 h-4 text-amber-400 flex-shrink-0" />
          ) : (
            <CheckCircle2 className="w-4 h-4 text-emerald-400 flex-shrink-0" />
          )}
          <span>{syncNotice}</span>
        </div>
      )}

      {/* Main Two-Column Layout */}
      <div className="flex-1 flex overflow-hidden">
        {/* Left Column: Steam Library Games List */}
        <LibrarySidebar
          games={filteredGames}
          selectedGameId={isGridView ? null : selectedGame?.id || null}
          onSelectGame={(game) => {
            navigateSelectGame(game);
          }}
          searchQuery={searchQuery}
          onSearchChange={setSearchQuery}
          selectedPlatform={selectedPlatform}
          onSelectPlatform={setSelectedPlatform}
          installedOnly={installedOnly}
          onToggleInstalledOnly={() => setInstalledOnly(!installedOnly)}
          collections={collections}
          onOpenManageCollectionsModal={handleOpenManageCollections}
          onToggleGameInCollection={handleToggleGameInCollection}
          onViewAllGamesGrid={navigateHome}
          onSelectGroupGrid={(groupId) => {
            navigateSelectGroup(groupId);
          }}
          activeGroupId={activeGroupId}
          isGridView={isGridView}
          activeFilter={activeFilter}
          onClearActiveFilter={navigateClearFilter}
          connectedStorefronts={connectedStorefronts}
        />

        {/* Right Main Pane: Steam Storefront Detail Layout OR Group/Whole Library Grid View */}
        <main
          ref={mainContentRef}
          onScroll={() => {
            if (mainContentRef.current) {
              saveCurrentScroll(mainContentRef.current.scrollTop);
            }
          }}
          style={{ overflowAnchor: 'none' }}
          className="flex-1 h-full overflow-y-auto bg-[#0b0f14] relative"
        >
          {isGridView || !selectedGame ? (
            <LibraryGridView
              games={activeGroupData ? activeGroupData.games : filteredGames}
              onSelectGame={(game) => {
                navigateSelectGame(game);
              }}
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
              groupIcon={
                activeFilter ? (
                  <Sliders className="w-6 h-6 text-steam-accent" />
                ) : activeGroupId === 'uncategorized' ? (
                  <Layers className="w-6 h-6 text-sky-400" />
                ) : activeGroupId ? (
                  <CollectionIcon
                    iconId={collections.find((c) => c.id === activeGroupId)?.icon}
                    collectionId={activeGroupId}
                    size={22}
                  />
                ) : undefined
              }
              onClearGroupFilter={activeGroupId ? navigateHome : undefined}
              activeFilter={activeFilter}
              onClearActiveFilter={navigateClearFilter}
              connectedStorefronts={connectedStorefronts}
              onFixMatch={handleOpenFixMatch}
              onHideGame={(g) => handleHideGame(g)}
              onSyncGameMedia={handleSyncCurrentGame}
              collections={collections}
              onToggleGameInCollection={handleToggleGameInCollection}
              onOpenManageCollectionsModal={handleOpenManageCollections}
              onViewAchievements={handleOpenAchievements}
              sortBy={gridSortBy}
              onSortChange={setGridSortBy}
              libraryFilterState={libraryFilterState}
              onUpdateLibraryFilterState={setLibraryFilterState}
              onResetLibraryFilterState={() => {
                setLibraryFilterState(DEFAULT_LIBRARY_FILTER_STATE);
                navigateClearFilter();
              }}
              libraryFilterIndex={libraryFilterIndex}
              unfilteredTotalCount={games.length}
            />
          ) : (
            <SteamStorePage
              key={currentEntry.selectedGameId || selectedGame.id}
              game={selectedGame}
              collections={collections}
              onBackToLibrary={navigateHome}
              onManageCollections={() => handleOpenManageCollections(selectedGame)}
              onToggleInstallStatus={(platId) => handleToggleInstallStatus(selectedGame, platId)}
              onApplyFilter={(filter) => {
                navigateApplyFilter(filter);
              }}
              onGameUpdated={handleGameUpdated}
              connectedStorefronts={connectedStorefronts}
              onOpenIntegrations={() => setIsIntegrationsModalOpen(true)}
              onFixMatch={() => handleOpenFixMatch(selectedGame)}
              onHideGame={(g, platId) => handleHideGame(g, platId)}
              onViewAchievements={(sfId) => handleOpenAchievements(selectedGame, sfId)}
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

      {/* Modal: Storefront Integrations & Cloud Sync (No Launchers Required) */}
      {isIntegrationsModalOpen && (
        <Suspense fallback={null}>
          <IntegrationsModal
            isOpen={isIntegrationsModalOpen}
            onClose={() => setIsIntegrationsModalOpen(false)}
            onLibraryUpdated={(newGames) => {
              setGames(newGames);
              saveCurrentCatalog(newGames, { skipSanitize: true });
              if (newGames.length > 0 && (!selectedGame || !newGames.some((g) => g.id === selectedGame.id))) {
                navigateSelectGame(newGames[0]);
              }
            }}
          />
        </Suspense>
      )}

      {/* Modal: Fix Match & Metadata Override Wizard */}
      {isFixMatchModalOpen && (
        <Suspense fallback={null}>
          <FixMatchWizardModal
            isOpen={isFixMatchModalOpen}
            game={fixMatchGame}
            onClose={() => {
              setIsFixMatchModalOpen(false);
              setFixMatchGame(null);
            }}
            onApplyOverride={handleApplyOverride}
            onResetOverride={handleResetOverride}
            onHideGame={handleHideGame}
            existingOverride={fixMatchGame ? getUserOverrideForGame(fixMatchGame) : undefined}
          />
        </Suspense>
      )}

      {/* Modal: Library Match & Overrides Studio */}
      {isMatchManagerOpen && (
        <Suspense fallback={null}>
          <LibraryMatchManagerModal
            isOpen={isMatchManagerOpen}
            games={games}
            onClose={() => setIsMatchManagerOpen(false)}
            onFixMatchForGame={(gameToFix) => {
              handleOpenFixMatch(gameToFix);
            }}
            onResetOverride={handleResetOverride}
            onResetOverrideForGame={handleResetOverride}
            onInspectGame={(gameToInspect) => {
              navigateSelectGame(gameToInspect);
            }}
            onSelectGame={(gameToSelect) => {
              navigateSelectGame(gameToSelect);
            }}
            onHideGame={handleHideGame}
            onUnhideEntry={handleUnhideEntry}
            onGameUpdated={handleGameUpdated}
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
            onClose={() => {
              setIsAchievementsModalOpen(false);
              setAchievementsModalGame(null);
              setAchievementsInitialStorefrontId(undefined);
            }}
          />
        </Suspense>
      )}

      {/* Slide-over Drawer: Universal Download & Installation Manager */}
      <Suspense fallback={null}>
        <DownloadManagerDrawer />
      </Suspense>

      {/* Global Sync Progress Bar Dock */}
      <GlobalSyncProgressBar />
    </div>
  );
};

export default App;

