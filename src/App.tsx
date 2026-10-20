import { useState, useMemo, useEffect, useRef, useCallback, lazy, Suspense } from 'react';
import { CanonicalGame } from './contracts/game';
import { StorefrontId } from './contracts/platform';
import { mergeScannedSteamGames } from './services/storage/librarySync';
import { FULL_USER_STEAM_GAMES } from './services/storage/fullUserSteamGames';
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
import { LibrarySidebar } from './components/Library/LibrarySidebar';
import { SteamStorePage } from './components/SteamStoreDetail/SteamStorePage';
import {
  LibraryGridView,
  GridSortOption,
  loadPersistedGridSort,
} from './components/Library/LibraryGridView';
import { GlobalSyncProgressBar } from './components/Navigation/GlobalSyncProgressBar';
import { CollectionIcon } from './components/Common/CollectionIcon';
import { matchesNativeOsQuery } from './services/platform/nativeOsService';
import { matchesLooseSearchQuery } from './services/common/titleUtils';
import { syncJobManager } from './services/network/syncJobManager';
import { RequestPriority } from './services/network/requestScheduler';
import { UserGameOverride } from './contracts/override';
import {
  saveUserOverride,
  removeUserOverride,
  getUserOverrideForGame,
  applyUserOverrideToGame,
  hideStorefrontEntry,
  unhideStorefrontEntry,
} from './services/storage/userOverrideStorage';
import {
  loadIntegrations,
  saveIntegrations,
  mergeStorefrontGames,
  loadCurrentCatalog,
  saveCurrentCatalog,
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
  hasSameStorefrontConflict,
  SuppressedCatalogEntry,
  registerSuppressedCatalogEntries,
} from './services/integrations/catalogSanitizer';
import { GOG_USER_LIBRARY, EPIC_USER_LIBRARY } from './services/storage/storefrontLibraries';
import {
  CheckCircle2,
  Layers,
  Sliders,
} from 'lucide-react';
import { ActiveGameFilter } from './contracts/filter';
import { matchesGameFilter } from './services/filter/gameFilterService';
import { useNavigationHistory } from './hooks/useNavigationHistory';
import { useCriticScoreWarmup } from './hooks/useCriticScoreWarmup';
import { useCollectionsManager } from './hooks/useCollectionsManager';
import { launcherService } from './services/launcher/launcherService';
import { InstalledGameRecord } from './contracts/launcher';

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
            localStorage.setItem('universal_game_library_catalog', JSON.stringify(sanitized));
          } catch {}
          return sanitized;
        }
      } catch (e) {
        console.error('Failed to parse cached games:', e);
      }
    }
    if (
      FULL_USER_STEAM_GAMES.length > 0 ||
      GOG_USER_LIBRARY.length > 0 ||
      EPIC_USER_LIBRARY.length > 0
    ) {
      const defaultCatalog = sanitizeGameCatalog(
        mergeStorefrontGames(
          mergeStorefrontGames(mergeScannedSteamGames([]), GOG_USER_LIBRARY, 'gog'),
          EPIC_USER_LIBRARY,
          'epic'
        )
      );
      try {
        localStorage.setItem('universal_game_library_catalog', JSON.stringify(defaultCatalog));
      } catch {}
      return defaultCatalog;
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

  const navigateApplyFilter = (filter: ActiveGameFilter) => {
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
  const [syncNotice, setSyncNotice] = useState<string | null>(null);

  // Integrations modal state
  const [isIntegrationsModalOpen, setIsIntegrationsModalOpen] = useState(false);

  // Fix Match & User Override modal state
  const [isFixMatchModalOpen, setIsFixMatchModalOpen] = useState(false);
  const [fixMatchGame, setFixMatchGame] = useState<CanonicalGame | null>(null);
  const [isMatchManagerOpen, setIsMatchManagerOpen] = useState(false);

  // Individual Achievements modal state
  const [isAchievementsModalOpen, setIsAchievementsModalOpen] = useState(false);
  const [achievementsModalGame, setAchievementsModalGame] = useState<CanonicalGame | null>(null);
  const [achievementsInitialStorefrontId, setAchievementsInitialStorefrontId] = useState<StorefrontId | undefined>(undefined);

  // Subscribe to background sync job updates
  useEffect(() => {
    const unsub = syncJobManager.subscribe((state) => {
      const active = Boolean(
        state &&
          state.type !== 'achievements' &&
          (state.status === 'running' ||
            state.status === 'paused' ||
            state.status === 'rate_limited')
      );
      setIsSyncingAllMedia(active);
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
              !gogInteg.credentials?.gogToken ||
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
                        ...i.credentials,
                        gogToken: savedTokens.gog.access_token,
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
              !epicInteg.credentials?.epicToken
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
                        epicToken: savedTokens.epic.access_token,
                        epicRefreshToken: savedTokens.epic.refresh_token,
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

          // Sync live storefronts & trophies in background on startup
          if (window.electronAPI?.syncStore) {
            if (savedTokens?.steam?.access_token || savedTokens?.steam?.steamId) {
              window.electronAPI
                .syncStore('steam')
                .then((syncRes: any) => {
                  if (Array.isArray(syncRes?.suppressedItems) && syncRes.suppressedItems.length > 0) {
                    registerSuppressedCatalogEntries(syncRes.suppressedItems);
                  }
                  if (syncRes?.achievements && Object.keys(syncRes.achievements).length > 0) {
                    cacheUserSteamAchievements(syncRes.achievements);
                  }
                  if (syncRes?.success && syncRes.games?.length > 0) {
                    const verifiedGames = syncRes.games.map((g: CanonicalGame) => ({
                      ...g,
                      isVerifiedEntitlement: true,
                    }));
                    setGames((prev) => {
                      const merged = mergeStorefrontGames(prev, verifiedGames, 'steam');
                      saveCurrentCatalog(merged);
                      return merged;
                    });
                  }
                })
                .catch(() => {});
            }

            if (savedTokens?.gog?.access_token) {
              window.electronAPI
                .syncStore('gog')
                .then((syncRes: any) => {
                  if (Array.isArray(syncRes?.suppressedItems) && syncRes.suppressedItems.length > 0) {
                    registerSuppressedCatalogEntries(syncRes.suppressedItems);
                  }
                  if (syncRes?.achievements && Object.keys(syncRes.achievements).length > 0) {
                    cacheUserGogAchievements(syncRes.achievements);
                  }
                  if (syncRes?.success && syncRes.games?.length > 0) {
                    const verifiedGames = syncRes.games.map((g: CanonicalGame) => ({
                      ...g,
                      isVerifiedEntitlement: true,
                    }));
                    setGames((prev) => {
                      const merged = mergeStorefrontGames(prev, verifiedGames, 'gog');
                      saveCurrentCatalog(merged);
                      return merged;
                    });
                  }
                })
                .catch(() => {});
            }

            if (savedTokens?.epic?.access_token) {
              window.electronAPI
                .syncStore('epic')
                .then((syncRes: any) => {
                  if (Array.isArray(syncRes?.suppressedItems) && syncRes.suppressedItems.length > 0) {
                    registerSuppressedCatalogEntries(syncRes.suppressedItems);
                  }
                  if (syncRes?.achievements && Object.keys(syncRes.achievements).length > 0) {
                    cacheUserEpicAchievements(syncRes.achievements);
                  }
                  if (syncRes?.success && syncRes.games?.length > 0) {
                    const verifiedGames = syncRes.games.map((g: CanonicalGame) => ({
                      ...g,
                      isVerifiedEntitlement: true,
                    }));
                    setGames((prev) => {
                      const merged = mergeStorefrontGames(prev, verifiedGames, 'epic');
                      saveCurrentCatalog(merged);
                      return merged;
                    });
                  }
                })
                .catch(() => {});
            }
          }
        })
        .catch((e: any) => console.warn('Error reading Electron tokens:', e));
    }

    async function syncLocalInstallations() {
      await launcherService.initialize();

      let allInstalledRecords: InstalledGameRecord[] = launcherService.getInstalledRecords();
      if (allInstalledRecords.length === 0) {
        try {
          allInstalledRecords = await launcherService.scanAllInstalledGames();
        } catch (e) {
          console.warn('Universal installed games scan warning:', e);
        }
      }

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
      let installedGamesList: { platformId?: string; appId: number; name?: string; installPath?: string }[] = [];
      if (allInstalledRecords.length > 0) {
        installedSteamAppIds = new Set(
          allInstalledRecords
            .filter((r) => r.platformId === 'steam' && (r.appId || !isNaN(Number(r.platformGameId))))
            .map((r) => Number(r.appId || r.platformGameId))
        );
        installedGamesList = allInstalledRecords
          .filter((r) => r.platformId === 'steam' && (r.appId || !isNaN(Number(r.platformGameId))))
          .map((r) => ({
            platformId: r.platformId,
            appId: Number(r.appId || r.platformGameId),
            name: r.title,
            installPath: r.installPath,
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
        for (const g of prevGames) {
          if (g.steamAppId) existingAppIds.add(g.steamAppId);
          for (const p of g.platforms) {
            if (p.platformId === 'steam' && p.platformGameId) {
              const num = parseInt(p.platformGameId, 10);
              if (!isNaN(num)) existingAppIds.add(num);
            }
          }
        }

        const updated = prevGames.map((game) => {
          let gameChanged = false;
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
                    Number(r.appId || r.platformGameId) === Number(targetAppId)))
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
            return { ...game, platforms: updatedPlatforms };
          }
          return game;
        });

        // Add any newly installed Steam games detected on disk if Steam integration is connected
        const isSteamConnected = loadIntegrations().some((i) => i.storefrontId === 'steam' && i.isConnected);
        if (isSteamConnected && installedGamesList && installedGamesList.length > 0) {
          for (const item of installedGamesList) {
            if ((item.platformId && item.platformId !== 'steam') || !item.appId || item.appId <= 0) {
              continue;
            }
            if (!existingAppIds.has(item.appId)) {
              existingAppIds.add(item.appId);
              const title = item.name || `Steam App ${item.appId}`;
              updated.push({
                id: `steam-${item.appId}`,
                title,
                sortTitle: title,
                steamAppId: item.appId,
                isVerifiedEntitlement: true,
                platforms: [
                  {
                    platformId: 'steam',
                    platformGameId: String(item.appId),
                    installed: true,
                    installPath: item.installPath,
                  },
                ],
                headerImage: `https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/${item.appId}/header.jpg`,
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

        if (changed) {
          localStorage.setItem('universal_game_library_catalog', JSON.stringify(updated));
          return updated;
        }
        return prevGames;
      });

      // Background live Steam cloud sync for player achievements
      if (
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
  useEffect(() => {
    const handleSteamMatchUpdated = (e: any) => {
      const { title, steamAppId } = e.detail || {};
      if (!title || typeof steamAppId !== 'number' || steamAppId <= 0) return;
      const targetNorm = title.toLowerCase().trim();

      setGames((prevGames) => {
        let changed = false;
        const nextGames = prevGames.map((g) => {
          if (
            !g.steamAppId &&
            !g.isExplicitNonSteam &&
            g.title.toLowerCase().trim() === targetNorm
          ) {
            changed = true;
            return { ...g, steamAppId };
          }
          return g;
        });
        if (changed) {
          try {
            saveCurrentCatalog(nextGames);
          } catch {}
          return nextGames;
        }
        return prevGames;
      });
    };

    const handleGogCoverUpdated = (e: any) => {
      const { gogId, coverUrl } = e.detail || {};
      if (!gogId || !coverUrl) return;
      const cleanGogId = String(gogId).replace(/^gog-/, '');

      setGames((prevGames) => {
        let changed = false;
        const nextGames = prevGames.map((g) => {
          const gogPlat = g.platforms?.find((p) => p.platformId === 'gog');
          if (
            gogPlat &&
            String(gogPlat.platformGameId) === cleanGogId &&
            (!g.capsuleImage ||
              g.capsuleImage.includes('_glx_vertical_cover') ||
              g.capsuleImage === g.headerImage)
          ) {
            changed = true;
            return { ...g, capsuleImage: coverUrl };
          }
          return g;
        });
        if (changed) {
          try {
            saveCurrentCatalog(nextGames);
          } catch {}
          return nextGames;
        }
        return prevGames;
      });
    };

    const handleGameSessionEnded = (e: any) => {
      const detail = e.detail || {};
      const { gameId, platformId, platformGameId, sessionMinutesPlayed, lastPlayed } = detail;
      if (!gameId) return;

      const addedMinutes = Math.max(1, Number(sessionMinutesPlayed) || 1);
      const playedIso = lastPlayed || new Date().toISOString();

      setGames((prevGames) => {
        let changed = false;
        const nextGames = prevGames.map((g) => {
          if (g.id !== gameId) return g;
          changed = true;
          const targetPlatId = platformId || g.platforms[0]?.platformId;
          const hasExactPlatformMatch = g.platforms.some(
            (p) =>
              p.platformId === targetPlatId ||
              Boolean(platformGameId && String(p.platformGameId) === String(platformGameId))
          );
          const updatedPlatforms = g.platforms.map((p, idx) => {
            const isMatch = hasExactPlatformMatch
              ? p.platformId === targetPlatId ||
                Boolean(platformGameId && String(p.platformGameId) === String(platformGameId))
              : idx === 0;
            if (isMatch) {
              return {
                ...p,
                playtimeMinutes: (p.playtimeMinutes || 0) + addedMinutes,
                lastPlayed: playedIso,
              };
            }
            return p;
          });
          return { ...g, platforms: updatedPlatforms };
        });

        if (changed) {
          try {
            saveCurrentCatalog(nextGames);
          } catch {}
          return nextGames;
        }
        return prevGames;
      });
    };

    const handleGameInstalled = (e: any) => {
      const detail = e.detail || {};
      const { gameId, platformId, platformGameId, installed, installPath, executablePath } = detail;
      if (!gameId && !platformGameId) return;

      setGames((prevGames) => {
        let changed = false;
        const nextGames = prevGames.map((g) => {
          const isGameMatch =
            g.id === gameId ||
            (platformGameId &&
              g.platforms.some(
                (p) =>
                  p.platformId === platformId &&
                  String(p.platformGameId) === String(platformGameId)
              ));
          if (!isGameMatch) return g;

          changed = true;
          let matchedAny = false;
          let updatedPlatforms = g.platforms.map((p, idx) => {
            const isPlatMatch =
              !platformId ||
              p.platformId === platformId ||
              (platformGameId && String(p.platformGameId) === String(platformGameId)) ||
              (g.platforms.length === 1 && idx === 0);
            if (isPlatMatch) {
              matchedAny = true;
              if (!installed) {
                return {
                  ...p,
                  installed: false,
                  installPath: undefined,
                  executablePath: undefined,
                  installSize: undefined,
                  isWindowsBinaryOnMac: undefined,
                  launchArguments: undefined,
                };
              }
              return {
                ...p,
                installed: true,
                installPath: installPath !== undefined ? installPath : p.installPath,
                executablePath: executablePath !== undefined ? executablePath : p.executablePath,
              };
            }
            return p;
          });
          if (!matchedAny && !platformId && !installed) {
            updatedPlatforms = updatedPlatforms.map((p) => ({
              ...p,
              installed: false,
              installPath: undefined,
              executablePath: undefined,
              installSize: undefined,
              isWindowsBinaryOnMac: undefined,
              launchArguments: undefined,
            }));
          }
          return { ...g, platforms: updatedPlatforms };
        });

        if (changed) {
          try {
            saveCurrentCatalog(nextGames);
          } catch {}
          return nextGames;
        }
        return prevGames;
      });
    };

    window.addEventListener('antigravity:steam-match-updated', handleSteamMatchUpdated);
    window.addEventListener('antigravity:gog-cover-updated', handleGogCoverUpdated);
    window.addEventListener('antigravity:game-session-ended', handleGameSessionEnded);
    window.addEventListener('antigravity:game-installed', handleGameInstalled);
    return () => {
      window.removeEventListener('antigravity:steam-match-updated', handleSteamMatchUpdated);
      window.removeEventListener('antigravity:gog-cover-updated', handleGogCoverUpdated);
      window.removeEventListener('antigravity:game-session-ended', handleGameSessionEnded);
      window.removeEventListener('antigravity:game-installed', handleGameInstalled);
    };
  }, []);

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
      localStorage.setItem('universal_game_library_catalog', JSON.stringify(updated));
      return updated;
    });
  };

  // Filtered games list for the sidebar
  const filteredGames = useMemo(() => {
    return games.filter((game) => {
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

      // Search query
      if (searchQuery.trim()) {
        const matchesTitle = matchesLooseSearchQuery(game.title, searchQuery);
        const matchesOrigTitle = matchesLooseSearchQuery(game.originalStoreTitle, searchQuery);
        const matchesDev = (game.developers || []).some((d) =>
          matchesLooseSearchQuery(d, searchQuery)
        );
        const matchesGenres = (game.genres || []).some((g) =>
          matchesLooseSearchQuery(g, searchQuery)
        );
        const matchesTags = (game.tags || []).some((t) =>
          matchesLooseSearchQuery(t, searchQuery)
        );
        if (
          !matchesTitle &&
          !matchesOrigTitle &&
          !matchesDev &&
          !matchesGenres &&
          !matchesTags &&
          !matchesNativeOsQuery(game, searchQuery)
        )
          return false;
      }

      // Temporary Active Link Filter (Developer, Publisher, Feature like HDR available, Genre, Tag)
      if (activeFilter) {
        if (!matchesGameFilter(game, activeFilter)) return false;
      }

      return true;
    });
  }, [games, selectedPlatform, installedOnly, searchQuery, activeFilter]);

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
  const reconcileCatalogTrophies = useCallback(
    (
      catalog: CanonicalGame[],
      steamAchs: Record<number, any>,
      gogAchs: Record<string, any>,
      epicAchs: Record<string, any>,
      installedSteamAppIds?: Set<number> | null
    ): CanonicalGame[] => {
      return catalog.map((game) => {
        const targetAppId = game.steamAppId;
        const ach = targetAppId
          ? steamAchs[targetAppId] || getKnownSteamAchievements(targetAppId, game.title)
          : null;
        const titleLower = (game.title || '').toLowerCase().trim();
        const normTitle = titleLower.replace(/[:\-–—]/g, ' ').replace(/\s+/g, ' ').trim();

        const updatedPlatforms = game.platforms.map((p) => {
          const newP = { ...p };
          const rec = launcherService.getInstalledRecordForGame(game, p.platformId);
          if (rec && rec.platformId === p.platformId) {
            newP.installed = true;
            newP.installPath = rec.installPath || newP.installPath;
            newP.executablePath = rec.executablePath || newP.executablePath;
            newP.installSize = rec.installSize ?? newP.installSize;
            newP.version = rec.version || newP.version;
            newP.isWindowsBinaryOnMac = rec.isWindowsBinaryOnMac ?? newP.isWindowsBinaryOnMac;
          }

          if (p.platformId === 'steam') {
            if (installedSteamAppIds) {
              newP.installed =
                (targetAppId ? installedSteamAppIds.has(targetAppId) : false) ||
                launcherService.isGameInstalled(game, 'steam');
            }
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
              if (reconciled) newP.achievements = reconciled;
            }
          } else if (p.platformId === 'gog') {
            const gogId = String(p.platformGameId || game.id).replace(/^gog-/, '');
            const gogAch =
              gogAchs[gogId] ||
              gogAchs[`gog-${gogId}`] ||
              gogAchs[titleLower] ||
              gogAchs[normTitle] ||
              getKnownGogAchievements(p.platformGameId || game.id, game.title);
            if (gogAch && gogAch.total > 0) {
              const reconciled = reconcileAchievementSummaries(p.achievements, gogAch, {
                title: game.title,
                store: 'gog',
              });
              if (reconciled) newP.achievements = reconciled;
            }
          } else if (p.platformId === 'epic') {
            const epicId = String(p.platformGameId || game.id);
            const epicIdLower = epicId.toLowerCase();
            const epicAch =
              epicAchs[epicId] ||
              epicAchs[epicIdLower] ||
              epicAchs[`epic-${epicIdLower}`] ||
              epicAchs[titleLower] ||
              epicAchs[normTitle] ||
              getKnownEpicAchievements(p.platformGameId || game.id, game.title);
            if (epicAch && epicAch.total > 0) {
              const reconciled = reconcileAchievementSummaries(p.achievements, epicAch, {
                title: game.title,
                store: 'epic',
              });
              if (reconciled) newP.achievements = reconciled;
            }
          }
          return newP;
        });

        return { ...game, platforms: updatedPlatforms };
      });
    },
    []
  );

  // Trigger library cloud sync across all connected storefronts (Steam, GOG, Epic, Xbox)
  const handleTriggerSync = async () => {
    setIsSyncing(true);
    setSyncNotice('Syncing all connected storefront accounts & detecting new purchases...');

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
      const assignedSteamIds = new Map<number, CanonicalGame>();
      for (const existingGame of currentCatalog) {
        if (existingGame.steamAppId) {
          assignedSteamIds.set(existingGame.steamAppId, existingGame);
        }
      }
      currentCatalog = currentCatalog.map((g) => {
        if (g.steamAppId || g.isExplicitNonSteam) return g;
        const matched = steamMatcher.getEffectiveSteamAppId(g);
        if (matched) {
          const existingOwner = assignedSteamIds.get(matched);
          const conflictingOwner =
            (existingOwner &&
              existingOwner !== g &&
              (hasSameStorefrontConflict(existingOwner, g) ||
                normalizeCanonicalTitle(existingOwner.title) !== normalizeCanonicalTitle(g.title))) ||
            currentCatalog.some(
              (other) =>
                other !== g &&
                other.steamAppId === matched &&
                (hasSameStorefrontConflict(other, g) ||
                  normalizeCanonicalTitle(other.title) !== normalizeCanonicalTitle(g.title))
            );
          if (conflictingOwner) {
            return g;
          }
          const enriched: CanonicalGame = {
            ...g,
            steamAppId: matched,
            id: `steam-${matched}`,
            headerImage: `https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/${matched}/header.jpg`,
            capsuleImage: `https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/${matched}/library_600x900_2x.jpg`,
          };
          assignedSteamIds.set(matched, enriched);
          return enriched;
        }
        return g;
      });

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
        setSyncNotice(
          `Sync complete! Detected ${newGamesDetected} newly added title${newGamesDetected === 1 ? '' : 's'} across your storefronts! (${currentCatalog.length} total titles)`
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
        setSyncNotice(
          `All connected storefronts up to date: ${storeParts.join(', ')} titles (trophies & playtime refreshed)`
        );
      }
    } catch (err: any) {
      setSyncNotice(`Sync notice: ${err?.message || 'Using cached verified catalog'}`);
    } finally {
      setIsSyncing(false);
      setTimeout(() => setSyncNotice(null), 5000);
    }
  };

  // Dedicated cross-storefront Trophy & Achievement synchronization (Steam, GOG, Epic)
  const handleSyncTrophies = async () => {
    if (isSyncingTrophies) return;
    setIsSyncingTrophies(true);
    setSyncNotice('Syncing trophies & achievements across Steam, GOG.com, and Epic Games Store...');

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
      setSyncNotice(
        `Trophies synced across Steam, GOG & Epic! (${gamesWithTrophies} titles with achievement data updated)`
      );
    } catch (err: any) {
      setSyncNotice(`Trophy sync notice: ${err?.message || 'Finished syncing trophies'}`);
    } finally {
      setIsSyncingTrophies(false);
      setTimeout(() => setSyncNotice(null), 5000);
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

    setIsSyncingCurrentGame(true);
    setSyncNotice(
      targetAppId
        ? `Syncing ${target.title} from Steam...`
        : `Syncing ${target.title} store metadata...`
    );

    try {
      await syncJobManager.runPriorityAction('Syncing Game Media', target.title, async () => {
        if (!targetAppId) {
          const refreshed = await fallbackMetadataProvider.getEnrichedMetadataForNonSteamGame(target);
          if (refreshed) {
            setGames((prevGames) => {
              const updated = prevGames.map((g) => {
                if (g.id === target.id) {
                  const cleanDevelopers = refreshed.developers?.filter(
                    (d) => d && d !== 'Unknown Developer'
                  );
                  return {
                    ...g,
                    enrichedMetadata: refreshed,
                    headerImage: refreshed.headerImage || g.headerImage,
                    capsuleImage: refreshed.capsuleImage || g.capsuleImage,
                    shortDescription:
                      refreshed.shortDescription &&
                      !isGenericPlaceholderSynopsis(refreshed.shortDescription, target.title)
                        ? refreshed.shortDescription
                        : g.shortDescription,
                    detailedDescription:
                      refreshed.detailedDescription ||
                      refreshed.aboutTheGame ||
                      g.detailedDescription,
                    developers: cleanDevelopers?.length ? cleanDevelopers : g.developers,
                    publishers: refreshed.publishers?.length ? refreshed.publishers : g.publishers,
                    releaseDate:
                      refreshed.releaseDate && refreshed.releaseDate !== 'TBA'
                        ? refreshed.releaseDate
                        : g.releaseDate,
                    genres: refreshed.genres?.length ? refreshed.genres : g.genres,
                    tags: refreshed.tags?.length ? refreshed.tags : g.tags,
                    reviewSummary: refreshed.reviewSummary || g.reviewSummary,
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
            setSyncNotice(`Successfully synced ${target.title} metadata!`);
          } else {
            setSyncNotice(`No new metadata updates found for ${target.title}.`);
          }
          return;
        }

        try {
          const steamAchs = await scanLocalSteamAchievements();
          if (steamAchs && Object.keys(steamAchs).length > 0) {
            cacheUserSteamAchievements(steamAchs);
          }
        } catch {}

        const [refreshed, liveAchs] = await Promise.all([
          steamApi.fetchGameMetadata(targetAppId, RequestPriority.P0_INTERACTIVE),
          steamAchievementsService.fetchPlayerGameAchievements(targetAppId),
        ]);

        if (refreshed || liveAchs) {
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

                return {
                  ...g,
                  steamAppId: targetAppId,
                  platforms: updatedPlatforms,
                  enrichedMetadata: refreshed || g.enrichedMetadata,
                  headerImage: refreshed?.headerImage || g.headerImage,
                  capsuleImage: refreshed?.capsuleImage || g.capsuleImage,
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
          setSyncNotice(`Successfully synced ${target.title} from Steam!`);
        } else {
          setSyncNotice(`No new updates found on Steam for ${target.title}.`);
        }
      });
    } catch (err: any) {
      setSyncNotice(`Sync notice: ${err?.message || 'Error syncing game'}`);
    } finally {
      setIsSyncingCurrentGame(false);
      setTimeout(() => setSyncNotice(null), 5000);
    }
  };

  // Synchronize official store media (screenshots, trailers, movies, descriptions) across library titles
  const handleSyncStoreMedia = async () => {
    if (isSyncingAllMedia) return;
    setIsSyncingAllMedia(true);
    setSyncNotice('Starting store media sync (trailers, screenshots & descriptions)...');
    const initialNoticeTimer = setTimeout(() => setSyncNotice(null), 3000);

    try {
      await syncJobManager.startStoreMediaSync(games, (updatedGame) => {
        setGames((prev) => {
          const idx = prev.findIndex((g) => g.id === updatedGame.id);
          if (idx === -1) return prev;
          const next = [...prev];
          next[idx] = updatedGame;
          saveCurrentCatalog(next, { skipSanitize: true });
          return next;
        });
      });
      clearTimeout(initialNoticeTimer);
      setSyncNotice('Store media sync complete! Refreshed trailers, screenshots & descriptions.');
    } catch (err: any) {
      clearTimeout(initialNoticeTimer);
      setSyncNotice(`Media sync notice: ${err?.message || 'Finished media sync'}`);
    } finally {
      setIsSyncingAllMedia(false);
      setTimeout(() => setSyncNotice(null), 5000);
    }
  };

  // Refresh and verify critic ratings across library titles
  const handleRefreshScores = async () => {
    if (isSyncingScores) return;
    setIsSyncingScores(true);
    setSyncNotice('Starting critic score refresh across OpenCritic, Metacritic & Steam...');
    const initialNoticeTimer = setTimeout(() => setSyncNotice(null), 3000);

    try {
      await syncJobManager.startCriticScoreSync(games, {
        forceRefresh: true,
        isBackgroundWarmup: false,
      });

      if (typeof window !== 'undefined') {
        window.dispatchEvent(
          new CustomEvent('antigravity_critic_updated', {
            detail: { refreshedAll: true },
          })
        );
      }

      clearTimeout(initialNoticeTimer);
      setSyncNotice(`Critic scores refreshed across your library.`);
    } catch (err: any) {
      clearTimeout(initialNoticeTimer);
      console.warn('Score refresh error:', err);
      setSyncNotice('Finished refreshing available critic scores.');
    } finally {
      setIsSyncingScores(false);
      setTimeout(() => setSyncNotice(null), 5000);
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

  // User Game Override & Fix Match Handlers
  const handleOpenFixMatch = useCallback((gameToFix?: CanonicalGame) => {
    const targetGame = gameToFix || selectedGame;
    if (targetGame) {
      setFixMatchGame(targetGame);
      setIsFixMatchModalOpen(true);
    }
  }, [selectedGame]);

  const handleApplyOverride = useCallback(
    (override: UserGameOverride) => {
      saveUserOverride(override);

      const isSplitting = Boolean(
        override.splitFromMerged || (fixMatchGame as any)?.isSplittingFromMerged
      );

      setGames((prevGames) => {
        if (isSplitting && fixMatchGame && override.platformId) {
          // 1. Remove the split platform from any existing multi-storefront game
          const strippedGames: CanonicalGame[] = [];
          for (const g of prevGames) {
            const hasSplitPlat = g.platforms?.some(
              (p) =>
                p.platformId === override.platformId &&
                (!override.platformGameId ||
                  String(p.platformGameId) === String(override.platformGameId))
            );
            if (hasSplitPlat && g.platforms.length > 1) {
              const remainingPlats = g.platforms.filter(
                (p) =>
                  !(
                    p.platformId === override.platformId &&
                    (!override.platformGameId ||
                      String(p.platformGameId) === String(override.platformGameId))
                  )
              );
              if (remainingPlats.length > 0) {
                strippedGames.push({ ...g, platforms: remainingPlats });
              }
            } else if (hasSplitPlat && g.platforms.length === 1 && g.id === override.gameId) {
              // Replaced by the standalone split entry below
            } else {
              strippedGames.push(g);
            }
          }

          // 2. Construct the standalone split game and apply the user override
          const cleanBaseGame: CanonicalGame = { ...fixMatchGame, isVerifiedEntitlement: true };
          delete (cleanBaseGame as any).isSplittingFromMerged;
          const standaloneGame = applyUserOverrideToGame(cleanBaseGame, override, {
            invalidateEnrichedCache: true,
          });

          const sanitizedSplit = sanitizeGameCatalog([...strippedGames, standaloneGame], {
            allowNewPurchases: true,
          });
          try {
            saveCurrentCatalog(sanitizedSplit);
          } catch (err) {
            console.error('Failed to save updated catalog after split override:', err);
          }
          return sanitizedSplit;
        }

        let matchedAny = false;
        let updatedGames = prevGames.map((g) => {
          const isMatch =
            g.id === override.gameId ||
            Boolean(
              override.platformGameId &&
                g.platforms?.some(
                  (p) =>
                    p.platformGameId === override.platformGameId &&
                    (!override.platformId || p.platformId === override.platformId)
                )
            );
          if (isMatch) {
            matchedAny = true;
            return applyUserOverrideToGame(g, override, { invalidateEnrichedCache: true });
          }
          return g;
        });

        // If the user matched & restored a previously suppressed entry, append it into the active catalog
        if (!matchedAny && fixMatchGame) {
          const restoredGame = applyUserOverrideToGame(
            { ...fixMatchGame, isVerifiedEntitlement: true },
            override,
            {
              invalidateEnrichedCache: true,
            }
          );
          updatedGames = [...updatedGames, restoredGame];
        }

        const sanitized = sanitizeGameCatalog(updatedGames, {
          allowNewPurchases: true,
        });

        try {
          saveCurrentCatalog(sanitized);
        } catch (err) {
          console.error('Failed to save updated catalog after override:', err);
        }
        return sanitized;
      });

      setGameRefreshKey((prev) => prev + 1);
      setSyncNotice(
        isSplitting
          ? `Split & matched "${override.title || 'game'}" as an independent library entry!`
          : `Applied metadata & cover match for "${override.title || 'game'}"!`
      );
      setTimeout(() => {
        setSyncNotice((prev) => (prev?.includes(override.title || 'game') ? null : prev));
      }, 5000);
    },
    [fixMatchGame]
  );

  const handleResetOverride = useCallback((gameId: string) => {
    removeUserOverride(gameId);
    setGames((prevGames) => {
      const sanitized = sanitizeGameCatalog(prevGames);
      try {
        saveCurrentCatalog(sanitized);
      } catch {}
      return sanitized;
    });

    setGameRefreshKey((prev) => prev + 1);
    setSyncNotice('Reverted game match & metadata to default store settings.');
    setTimeout(() => setSyncNotice(null), 5000);
  }, []);

  const handleHideGame = useCallback(
    (gameToHide: CanonicalGame, targetPlatformId?: StorefrontId) => {
      hideStorefrontEntry(gameToHide, targetPlatformId);

      setGames((prevGames) => {
        const nextGames: CanonicalGame[] = [];
        for (const g of prevGames) {
          if (g.id === gameToHide.id) {
            if (targetPlatformId && g.platforms.length > 1) {
              const remainingPlats = g.platforms.filter((p) => p.platformId !== targetPlatformId);
              if (remainingPlats.length > 0) {
                nextGames.push({ ...g, platforms: remainingPlats });
              }
            }
            // Otherwise omit the hidden game completely
          } else if (
            targetPlatformId &&
            gameToHide.platforms.length === 1 &&
            g.platforms.length > 1 &&
            g.platforms.some(
              (p) =>
                p.platformId === targetPlatformId &&
                String(p.platformGameId) === String(gameToHide.platforms[0]?.platformGameId)
            )
          ) {
            const remainingPlats = g.platforms.filter(
              (p) =>
                !(
                  p.platformId === targetPlatformId &&
                  String(p.platformGameId) === String(gameToHide.platforms[0]?.platformGameId)
                )
            );
            if (remainingPlats.length > 0) {
              nextGames.push({ ...g, platforms: remainingPlats });
            }
          } else {
            nextGames.push(g);
          }
        }

        const sanitized = sanitizeGameCatalog(nextGames, { allowNewPurchases: true });
        try {
          saveCurrentCatalog(sanitized);
        } catch {}
        return sanitized;
      });

      if (
        !isGridView &&
        selectedGame?.id === gameToHide.id &&
        (!targetPlatformId || gameToHide.platforms.length <= 1)
      ) {
        navigateHome();
      }

      setGameRefreshKey((prev) => prev + 1);
      setSyncNotice(
        `Hidden "${gameToHide.title}"${
          targetPlatformId ? ` (${targetPlatformId.toUpperCase()})` : ''
        } — restore anytime in Library Match Studio > Suppressed & Filtered.`
      );
      setTimeout(() => setSyncNotice(null), 5000);
    },
    [isGridView, selectedGame]
  );

  const handleUnhideEntry = useCallback((entry: SuppressedCatalogEntry) => {
    const restoredSnapshot = unhideStorefrontEntry(
      entry.id,
      entry.platformId,
      entry.platformGameId
    );
    const candidateGame: CanonicalGame = {
      ...(restoredSnapshot || entry.rawGame),
      isVerifiedEntitlement: true,
    };

    setGames((prevGames) => {
      const sanitized = sanitizeGameCatalog([...prevGames, candidateGame], {
        allowNewPurchases: true,
      });
      try {
        saveCurrentCatalog(sanitized);
      } catch {}
      return sanitized;
    });

    setGameRefreshKey((prev) => prev + 1);
    setSyncNotice(`Restored "${entry.rawTitle || entry.rawGame.title}" back to your library!`);
    setTimeout(() => setSyncNotice(null), 5000);
  }, []);

  // Individual Achievements Modal Handler
  const handleOpenAchievements = useCallback((gameToView?: CanonicalGame, storefrontId?: StorefrontId) => {
    const targetGame = gameToView || selectedGame;
    if (targetGame) {
      setAchievementsModalGame(targetGame);
      setAchievementsInitialStorefrontId(storefrontId);
      setIsAchievementsModalOpen(true);
    }
  }, [selectedGame]);

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

      {/* Sync Status Banner */}
      {syncNotice && (
        <div className="bg-emerald-950/90 border-b border-emerald-600/50 py-1.5 px-4 text-center text-xs text-emerald-300 flex items-center justify-center gap-2 flex-shrink-0 transition-all">
          <CheckCircle2 className="w-4 h-4 text-emerald-400" />
          {syncNotice}
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
              localStorage.setItem('universal_game_library_catalog', JSON.stringify(newGames));
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

