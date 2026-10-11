import { useState, useMemo, useEffect, useRef, useCallback } from 'react';
import { CanonicalGame } from './contracts/game';
import { StorefrontId } from './contracts/platform';
import { GameCollection } from './contracts/collection';
import { mergeScannedSteamGames } from './services/storage/librarySync';
import { FULL_USER_STEAM_GAMES } from './services/storage/fullUserSteamGames';
import { loadCollections, saveCollections } from './services/storage/collectionStorage';
import { scanLocalInstalledGames, scanLocalSteamAchievements } from './services/system/localSystemScanner';
import {
  cacheUserSteamAchievements,
  getKnownSteamAchievements,
  getKnownGogAchievements,
  getKnownEpicAchievements,
} from './services/storage/knownGameAchievements';
import { reconcileAchievementSummaries } from './services/storage/achievementReconciliation';
import { steamAchievementsService } from './services/steam/steamAchievementsService';
import { TopNavBar } from './components/Navigation/TopNavBar';
import { LibrarySidebar } from './components/Library/LibrarySidebar';
import { SteamStorePage } from './components/SteamStoreDetail/SteamStorePage';
import { LibraryGridView } from './components/Library/LibraryGridView';
import { ManageCollectionsModal } from './components/Library/ManageCollectionsModal';
import { IntegrationsModal } from './components/Navigation/IntegrationsModal';
import {
  loadIntegrations,
  saveIntegrations,
  mergeStorefrontGames,
  saveCurrentCatalog,
  connectGogIntegration,
  connectEpicIntegration,
  connectXboxIntegration,
} from './services/integrations/integrationStorage';
import { steamIntegration } from './services/integrations/steamIntegration';
import { steamMatcher } from './services/steam/steamMatcher';
import { steamApi } from './services/steam/steamApi';
import { sanitizeGameCatalog } from './services/integrations/catalogSanitizer';
import { GOG_USER_LIBRARY, EPIC_USER_LIBRARY } from './services/storage/storefrontLibraries';
import {
  CheckCircle2,
  Star,
  Play,
  Clock,
  Trophy,
  Layers,
  Bookmark,
  Sliders,
} from 'lucide-react';
import { ActiveGameFilter } from './contracts/filter';
import { matchesGameFilter } from './services/filter/gameFilterService';
import { useNavigationHistory } from './hooks/useNavigationHistory';

export function App() {
  const [games, setGames] = useState<CanonicalGame[]>(() => {
    // Clear any stale cached games with obsolete mock installed flags
    const saved = localStorage.getItem('universal_game_library_catalog');
    if (saved) {
      try {
        const parsed = JSON.parse(saved);
        if (Array.isArray(parsed) && parsed.length > 0) {
          const cleaned = parsed
            .filter((g: CanonicalGame) => g.steamAppId !== 3010850 && !g.title.toLowerCase().includes('e-day'))
            .map((g: CanonicalGame) => ({
              ...g,
              platforms: g.platforms.map((p) => ({ ...p, installed: false })),
            }));
          let sanitized = sanitizeGameCatalog(mergeScannedSteamGames(cleaned));

          const steamCount = sanitized.filter((g: CanonicalGame) => g.platforms?.some((p) => p.platformId === 'steam')).length;
          if (steamCount < FULL_USER_STEAM_GAMES.length) {
            sanitized = sanitizeGameCatalog(mergeScannedSteamGames(sanitized));
          }

          const gogCount = sanitized.filter((g: CanonicalGame) => g.platforms?.some((p) => p.platformId === 'gog')).length;
          if (gogCount < GOG_USER_LIBRARY.length) {
            sanitized = sanitizeGameCatalog(mergeStorefrontGames(sanitized, GOG_USER_LIBRARY, 'gog'));
          }

          const integrations = loadIntegrations();
          const epicInteg = integrations.find((i) => i.storefrontId === 'epic');
          const isExplicitlyDisconnected = epicInteg?.statusMessage === 'Disconnected';

          const epicCount = sanitized.filter((g: CanonicalGame) => g.platforms?.some((p) => p.platformId === 'epic')).length;
          if (!isExplicitlyDisconnected && epicCount < EPIC_USER_LIBRARY.length) {
            sanitized = sanitizeGameCatalog(mergeStorefrontGames(sanitized, EPIC_USER_LIBRARY, 'epic'));
          }

          try {
            localStorage.setItem('universal_game_library_catalog', JSON.stringify(sanitized));
          } catch {}
          return sanitized;
        }
      } catch (e) {
        console.error('Failed to parse cached games:', e);
      }
    }
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

  const selectedGame = useMemo(() => {
    if (!currentEntry.selectedGameId) {
      return games[0] || null;
    }
    return games.find((g) => g.id === currentEntry.selectedGameId) || games[0] || null;
  }, [games, currentEntry.selectedGameId]);

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
  const [gameRefreshKey, setGameRefreshKey] = useState(0);
  const [syncNotice, setSyncNotice] = useState<string | null>(null);

  // Collections state
  const [collections, setCollections] = useState<GameCollection[]>(() => loadCollections());
  const [isManageCollectionsOpen, setIsManageCollectionsOpen] = useState(false);
  const [collectionModalGame, setCollectionModalGame] = useState<CanonicalGame | null>(null);

  // Integrations modal state
  const [isIntegrationsModalOpen, setIsIntegrationsModalOpen] = useState(false);

  // Connected storefronts based strictly on authenticated integration state
  const connectedStorefronts = useMemo(() => {
    try {
      const integrations = loadIntegrations();
      return integrations.filter((i) => i.isConnected).map((i) => i.storefrontId);
    } catch {
      return ['steam', 'gog'] as StorefrontId[];
    }
  }, [games, isIntegrationsModalOpen]);

  // Synchronize installed game status and achievements against the workstation and cloud
  useEffect(() => {
    async function syncLocalInstallations() {
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
      try {
        const scanResult = await scanLocalInstalledGames();
        if (scanResult) {
          installedSteamAppIds = new Set(scanResult.installedSteamAppIds);
        }
      } catch (e) {
        console.warn('Local installed games scan failed:', e);
      }

      setGames((prevGames) => {
        let changed = false;
        const updated = prevGames.map((game) => {
          let gameChanged = false;
          const targetAppId = game.steamAppId;
          const ach = targetAppId
            ? (steamAchs[targetAppId] || getKnownSteamAchievements(targetAppId, game.title))
            : null;

          const updatedPlatforms = game.platforms.map((p) => {
            let pChanged = false;
            let newP = { ...p };

            if (p.platformId === 'steam') {
              if (installedSteamAppIds) {
                const shouldBeInstalled = targetAppId ? installedSteamAppIds.has(targetAppId) : false;
                if (p.installed !== shouldBeInstalled) {
                  newP.installed = shouldBeInstalled;
                  pChanged = true;
                }
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
            } else if (installedSteamAppIds && p.installed) {
              newP.installed = false;
              pChanged = true;
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

        if (changed) {
          localStorage.setItem('universal_game_library_catalog', JSON.stringify(updated));
          return updated;
        }
        return prevGames;
      });

      // Background live Steam cloud sync for player achievements
      steamAchievementsService
        .syncUserLibraryAchievements(games)
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

    syncLocalInstallations();
  }, []);

  const handleToggleInstallStatus = (gameToToggle?: CanonicalGame | null) => {
    const target = gameToToggle || selectedGame;
    if (!target) return;

    setGames((prev) => {
      const updated = prev.map((g) => {
        if (g.id === target.id) {
          const currentlyInstalled = g.platforms.some((p) => p.installed);
          const nextState = !currentlyInstalled;
          return {
            ...g,
            platforms: g.platforms.map((p) => ({ ...p, installed: nextState })),
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
        const isInstalled = game.platforms.some((p) => p.installed);
        if (!isInstalled) return false;
      }

      // Search query
      if (searchQuery.trim()) {
        const q = searchQuery.toLowerCase();
        const matchesTitle = game.title.toLowerCase().includes(q);
        const matchesDev = game.developers.some((d) => d.toLowerCase().includes(q));
        const matchesTags = game.tags.some((t) => t.toLowerCase().includes(q));
        if (!matchesTitle && !matchesDev && !matchesTags) return false;
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
      if (steamInteg?.credentials?.steamId) {
        try {
          const res = await steamIntegration.fetchOwnedGames(steamInteg.credentials);
          currentCatalog = mergeStorefrontGames(currentCatalog, res.games, 'steam');
        } catch (e) {
          console.warn('Steam sync warning:', e);
        }
      }

      // 2. GOG sync (via Electron native store:sync or web fallback)
      const gogInteg = integrations.find((i) => i.storefrontId === 'gog' && i.isConnected);
      if (gogInteg) {
        try {
          if (typeof window !== 'undefined' && (window as any).electronAPI?.syncStore) {
            const gogRes = await (window as any).electronAPI.syncStore('gog');
            if (gogRes?.success && gogRes.games?.length > 0) {
              currentCatalog = mergeStorefrontGames(currentCatalog, gogRes.games, 'gog');
            }
          } else {
            const { games: gogGames } = await connectGogIntegration(gogInteg.credentials || {});
            currentCatalog = mergeStorefrontGames(currentCatalog, gogGames, 'gog');
          }
        } catch (e) {
          console.warn('GOG sync warning:', e);
        }
      }

      // 3. Epic Games Store sync (via Electron native store:sync or web fallback)
      const epicInteg = integrations.find((i) => i.storefrontId === 'epic' && i.isConnected);
      if (epicInteg) {
        try {
          if (typeof window !== 'undefined' && (window as any).electronAPI?.syncStore) {
            const epicRes = await (window as any).electronAPI.syncStore('epic');
            if (epicRes?.success && epicRes.games?.length > 0) {
              currentCatalog = mergeStorefrontGames(currentCatalog, epicRes.games, 'epic');
            }
          } else {
            const { games: epicGames } = await connectEpicIntegration(epicInteg.credentials || {});
            currentCatalog = mergeStorefrontGames(currentCatalog, epicGames, 'epic');
          }
        } catch (e) {
          console.warn('Epic sync warning:', e);
        }
      }

      // 4. Xbox sync
      const xboxInteg = integrations.find((i) => i.storefrontId === 'xbox' && i.isConnected);
      if (xboxInteg) {
        try {
          const { games: xboxGames } = await connectXboxIntegration(xboxInteg.credentials || {});
          currentCatalog = mergeStorefrontGames(currentCatalog, xboxGames, 'xbox');
        } catch (e) {
          console.warn('Xbox sync warning:', e);
        }
      }

      // 5. Intelligent Steam Match Pass for Non-Steam Titles
      currentCatalog = currentCatalog.map((g) => {
        if (g.steamAppId) return g;
        const matched = steamMatcher.matchGameToSteamInstant(g.title);
        if (matched) {
          return {
            ...g,
            steamAppId: matched,
            id: `steam-${matched}`,
            headerImage: `https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/${matched}/header.jpg`,
            capsuleImage: `https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/${matched}/library_600x900_2x.jpg`,
          };
        }
        return g;
      });

      // 6. Reconciliation pass: update achievements & local installed flags across current catalog
      currentCatalog = currentCatalog.map((game) => {
        const targetAppId = game.steamAppId;
        const ach = targetAppId
          ? (steamAchs[targetAppId] || getKnownSteamAchievements(targetAppId, game.title))
          : null;

        const updatedPlatforms = game.platforms.map((p) => {
          let newP = { ...p };

          if (p.platformId === 'steam') {
            if (installedSteamAppIds) {
              newP.installed = targetAppId ? installedSteamAppIds.has(targetAppId) : false;
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
            const gogAch = getKnownGogAchievements(p.platformGameId || game.id, game.title);
            if (gogAch && gogAch.total > 0) {
              const reconciled = reconcileAchievementSummaries(
                p.achievements,
                gogAch,
                { title: game.title, store: 'gog' }
              );
              if (reconciled) newP.achievements = reconciled;
            }
          } else if (p.platformId === 'epic') {
            const epicAch = getKnownEpicAchievements(game.id, game.title);
            if (epicAch && epicAch.total > 0) {
              const reconciled = reconcileAchievementSummaries(
                p.achievements,
                epicAch,
                { title: game.title, store: 'epic' }
              );
              if (reconciled) newP.achievements = reconciled;
            }
          }
          return newP;
        });

        return { ...game, platforms: updatedPlatforms };
      });

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

  // Check if syncing the currently viewed game from Steam is applicable
  const canSyncCurrentGame = useMemo(() => {
    if (isGridView || !selectedGame) return false;
    if (selectedGame.steamAppId) return true;
    const matched = steamMatcher.matchGameToSteamInstant(selectedGame.title);
    return Boolean(matched);
  }, [isGridView, selectedGame]);

  // Synchronize official Steam metadata, achievements, and media for the current game
  const handleSyncCurrentGame = async () => {
    if (!selectedGame || isSyncingCurrentGame) return;
    const targetAppId = selectedGame.steamAppId || steamMatcher.matchGameToSteamInstant(selectedGame.title);
    if (!targetAppId) return;

    setIsSyncingCurrentGame(true);
    setSyncNotice(`Syncing ${selectedGame.title} from Steam...`);

    try {
      try {
        const steamAchs = await scanLocalSteamAchievements();
        if (steamAchs && Object.keys(steamAchs).length > 0) {
          cacheUserSteamAchievements(steamAchs);
        }
      } catch {}

      const [refreshed, liveAchs] = await Promise.all([
        steamApi.fetchGameMetadata(targetAppId),
        steamAchievementsService.fetchPlayerGameAchievements(targetAppId),
      ]);

      if (refreshed || liveAchs) {
        setGames((prevGames) => {
          const updated = prevGames.map((g) => {
            if (g.id === selectedGame.id) {
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
        setSyncNotice(`Successfully synced ${selectedGame.title} from Steam!`);
      } else {
        setSyncNotice(`No new updates found on Steam for ${selectedGame.title}.`);
      }
    } catch (err: any) {
      setSyncNotice(`Steam sync notice: ${err?.message || 'Error syncing game'}`);
    } finally {
      setIsSyncingCurrentGame(false);
      setTimeout(() => setSyncNotice(null), 5000);
    }
  };

  // Synchronize official store media (screenshots, trailers, movies, descriptions) across library titles
  const handleSyncAllMedia = async () => {
    if (isSyncingAllMedia) return;
    setIsSyncingAllMedia(true);
    setSyncNotice('Starting store media sync (trailers, screenshots & descriptions)...');

    try {
      const eligibleGames = games.filter((g) => {
        return Boolean(g.steamAppId || steamMatcher.matchGameToSteamInstant(g.title));
      });

      const totalEligible = eligibleGames.length;
      setSyncNotice(`Syncing store media for ${totalEligible} library titles...`);

      let updatedCount = 0;
      const chunkSize = 5;
      let updatedCatalog = [...games];

      for (let i = 0; i < eligibleGames.length; i += chunkSize) {
        const chunk = eligibleGames.slice(i, i + chunkSize);

        await Promise.all(
          chunk.map(async (game) => {
            const targetAppId = game.steamAppId || steamMatcher.matchGameToSteamInstant(game.title);
            if (!targetAppId) return;

            try {
              const refreshed = await steamApi.fetchGameMetadata(targetAppId);
              if (refreshed) {
                const idx = updatedCatalog.findIndex((g) => g.id === game.id);
                if (idx >= 0) {
                  const g = updatedCatalog[idx];
                  updatedCatalog[idx] = {
                    ...g,
                    steamAppId: targetAppId,
                    enrichedMetadata: refreshed || g.enrichedMetadata,
                    headerImage: refreshed.headerImage || g.headerImage,
                    capsuleImage: refreshed.capsuleImage || g.capsuleImage,
                    shortDescription: refreshed.shortDescription || g.shortDescription,
                    developers: refreshed.developers?.length ? refreshed.developers : g.developers,
                    publishers: refreshed.publishers?.length ? refreshed.publishers : g.publishers,
                    genres: refreshed.genres?.length ? refreshed.genres : g.genres,
                    tags: refreshed.tags?.length ? refreshed.tags : g.tags,
                    reviewSummary: refreshed.reviewSummary || g.reviewSummary,
                  };
                  updatedCount++;
                }
              }
            } catch (err) {
              console.warn(`Media sync failed for ${game.title}:`, err);
            }
          })
        );

        if (steamApi.isStoreRateLimited()) {
          console.warn('Steam Store API rate limit reached, finishing with available cached media.');
          break;
        }
      }

      setGames(updatedCatalog);
      saveCurrentCatalog(updatedCatalog);
      setGameRefreshKey((prev) => prev + 1);

      setSyncNotice(
        `Store media sync complete! Refreshed trailers, screenshots & descriptions for ${updatedCount} titles.`
      );
    } catch (err: any) {
      setSyncNotice(`Media sync notice: ${err?.message || 'Finished media sync'}`);
    } finally {
      setIsSyncingAllMedia(false);
      setTimeout(() => setSyncNotice(null), 6000);
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

  // Collection Management Handlers
  const handleOpenManageCollections = (game?: CanonicalGame) => {
    setCollectionModalGame(game || null);
    setIsManageCollectionsOpen(true);
  };

  const handleCreateCollection = (name: string) => {
    const newCol: GameCollection = {
      id: `col-${Date.now()}`,
      name,
      gameIds: collectionModalGame ? [collectionModalGame.id] : [],
    };
    const updated = [...collections, newCol];
    setCollections(updated);
    saveCollections(updated);
  };

  const handleRenameCollection = (id: string, newName: string) => {
    const updated = collections.map((c) => (c.id === id ? { ...c, name: newName } : c));
    setCollections(updated);
    saveCollections(updated);
  };

  const handleDeleteCollection = (id: string) => {
    const updated = collections.filter((c) => c.id !== id);
    setCollections(updated);
    saveCollections(updated);
  };

  const handleToggleGameInCollection = (collectionId: string, gameId: string) => {
    const updated = collections.map((c) => {
      if (c.id === collectionId) {
        const has = c.gameIds.includes(gameId);
        return {
          ...c,
          gameIds: has ? c.gameIds.filter((id) => id !== gameId) : [...c.gameIds, gameId],
        };
      }
      return c;
    });
    setCollections(updated);
    saveCollections(updated);
  };

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
        onSyncAllMedia={handleSyncAllMedia}
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
                ) : activeGroupId === 'favorites' ? (
                  <Star className="w-6 h-6 fill-amber-400 text-amber-400" />
                ) : activeGroupId === 'currently-playing' ? (
                  <Play className="w-6 h-6 fill-emerald-400 text-emerald-400" />
                ) : activeGroupId === 'backlog' ? (
                  <Clock className="w-6 h-6 text-sky-400" />
                ) : activeGroupId === 'completed' ? (
                  <Trophy className="w-6 h-6 text-yellow-400" />
                ) : activeGroupId === 'uncategorized' ? (
                  <Layers className="w-6 h-6 text-sky-400" />
                ) : activeGroupId ? (
                  <Bookmark className="w-6 h-6 text-steam-accent" />
                ) : undefined
              }
              onClearGroupFilter={activeGroupId ? navigateHome : undefined}
              activeFilter={activeFilter}
              onClearActiveFilter={navigateClearFilter}
              connectedStorefronts={connectedStorefronts}
            />
          ) : (
            <SteamStorePage
              key={`${selectedGame.id}-${gameRefreshKey}`}
              game={selectedGame}
              collections={collections}
              onBackToLibrary={navigateHome}
              onManageCollections={() => handleOpenManageCollections(selectedGame)}
              onToggleInstallStatus={() => handleToggleInstallStatus(selectedGame)}
              onApplyFilter={(filter) => {
                navigateApplyFilter(filter);
              }}
              onGameUpdated={handleGameUpdated}
              connectedStorefronts={connectedStorefronts}
              onOpenIntegrations={() => setIsIntegrationsModalOpen(true)}
            />
          )}
        </main>
      </div>

      {/* Modal: Manage Collections */}
      <ManageCollectionsModal
        isOpen={isManageCollectionsOpen}
        onClose={() => setIsManageCollectionsOpen(false)}
        collections={collections}
        game={collectionModalGame}
        onCreateCollection={handleCreateCollection}
        onRenameCollection={handleRenameCollection}
        onDeleteCollection={handleDeleteCollection}
        onToggleGameInCollection={handleToggleGameInCollection}
      />

      {/* Modal: Storefront Integrations & Cloud Sync (No Launchers Required) */}
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
    </div>
  );
}

export default App;
