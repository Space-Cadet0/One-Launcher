import { useState, useMemo, useCallback, Dispatch, SetStateAction, MutableRefObject } from 'react';
import { CanonicalGame, XboxGamePassSyncMode } from '../contracts/game';
import {
  scanLocalInstalledGames,
  scanLocalSteamAchievements,
} from '../services/system/localSystemScanner';
import {
  cacheUserSteamAchievements,
  cacheUserGogAchievements,
  cacheUserEpicAchievements,
  cacheUserXboxAchievements,
  CachedAchievementEntry,
} from '../services/storage/knownGameAchievements';
import {
  loadIntegrations,
  saveIntegrations,
  mergeStorefrontGames,
  saveCurrentCatalog,
  mergeUpdatedGamePreservingLivePlatformState,
  connectGogIntegration,
  connectEpicIntegration,
  connectXboxIntegration,
  loadXboxProfileState,
  saveXboxProfileState,
} from '../services/integrations/integrationStorage';
import {
  sanitizeGameCatalog,
  registerSuppressedCatalogEntries,
  SuppressedCatalogEntry,
} from '../services/integrations/catalogSanitizer';
import { steamMatcher } from '../services/steam/steamMatcher';
import { steamApi } from '../services/steam/steamApi';
import { RequestPriority } from '../services/network/requestScheduler';
import { onlineLifecycleManager } from '../services/network/onlineLifecycleManager';
import {
  reconcileCatalogTrophiesRecords,
  runIntelligentNonSteamMatchPass,
} from '../utils/catalogMergeUtils';
import { clearFailedCoverUrls } from '../components/Library/LibraryGridView';
import { clearFailedSidebarIconUrls } from '../components/Library/LibrarySidebar';
import { SyncNoticeTone } from './useSyncNotice';

export interface UseManualLibrarySyncActionsParams {
  games: CanonicalGame[];
  gamesRef: MutableRefObject<CanonicalGame[]>;
  selectedGame: CanonicalGame | null;
  isGridView: boolean;
  isSyncingAllMedia: boolean;
  setIsSyncingAllMedia: Dispatch<SetStateAction<boolean>>;
  setGames: Dispatch<SetStateAction<CanonicalGame[]>>;
  setGameRefreshKey: Dispatch<SetStateAction<number>>;
  overlayLauncherInstalledState: (catalog: CanonicalGame[]) => CanonicalGame[];
  showSyncNotice: (
    message: string | null,
    durationMs?: number | null,
    tone?: SyncNoticeTone
  ) => void;
}

function isVitestRuntime(): boolean {
  if (typeof import.meta !== 'undefined' && import.meta.env?.MODE === 'test') {
    return true;
  }
  return typeof process !== 'undefined' && Boolean(process.env?.VITEST);
}

function getErrorMessage(err: unknown, fallback: string): string {
  if (err instanceof Error && err.message) return err.message;
  if (err && typeof err === 'object' && 'message' in err) {
    const msg = (err as { message?: unknown }).message;
    if (typeof msg === 'string' && msg) return msg;
  }
  return fallback;
}

/**
 * Encapsulates manual user-triggered sync actions (Storefront Libraries, Trophies,
 * Single-Game Store Metadata, Bulk Store Media, and Critic Scores) using dynamic `import()`
 * for heavy scraper/achievement modules and 100% pure React 19 state updates.
 */
export function useManualLibrarySyncActions({
  games,
  gamesRef,
  selectedGame,
  isGridView,
  isSyncingAllMedia,
  setIsSyncingAllMedia,
  setGames,
  setGameRefreshKey,
  overlayLauncherInstalledState,
  showSyncNotice,
}: UseManualLibrarySyncActionsParams) {
  const [isSyncing, setIsSyncing] = useState(false);
  const [isSyncingCurrentGame, setIsSyncingCurrentGame] = useState(false);
  const [isSyncingScores, setIsSyncingScores] = useState(false);
  const [isSyncingTrophies, setIsSyncingTrophies] = useState(false);

  const canSyncCurrentGame = useMemo(
    () => Boolean(!isGridView && selectedGame),
    [isGridView, selectedGame]
  );

  const handleTriggerSync = useCallback(async () => {
    setIsSyncing(true);
    showSyncNotice('Syncing all connected storefront accounts & detecting new purchases...');

    try {
      const [{ syncJobManager }, { steamAchievementsService }, { steamIntegration }, { achievementDetailService }] =
        await Promise.all([
          import('../services/network/syncJobManager'),
          import('../services/steam/steamAchievementsService'),
          import('../services/integrations/steamIntegration'),
          import('../services/achievements/achievementDetailService'),
        ]);

      const integrations = loadIntegrations();
      let currentCatalog = gamesRef.current;
      const initialCount = currentCatalog.length;

      let installedSteamAppIds: Set<number> | null = null;
      let steamAchs: Record<number, CachedAchievementEntry> = {};
      let gogAchs: Record<string, CachedAchievementEntry> = {};
      let epicAchs: Record<string, CachedAchievementEntry> = {};
      let xboxAchs: Record<string, CachedAchievementEntry> = {};

      try {
        const [scannedAchs, scanResult] = await Promise.allSettled([
          scanLocalSteamAchievements(),
          scanLocalInstalledGames(),
        ]);
        if (
          scannedAchs.status === 'fulfilled' &&
          scannedAchs.value &&
          Object.keys(scannedAchs.value).length > 0
        ) {
          steamAchs = scannedAchs.value;
          cacheUserSteamAchievements(steamAchs);
        }
        if (scanResult.status === 'fulfilled' && scanResult.value?.success) {
          installedSteamAppIds = new Set(scanResult.value.installedSteamAppIds);
        }
      } catch {}

      const steamInteg = integrations.find((i) => i.storefrontId === 'steam' && i.isConnected);
      if (steamInteg) {
        await syncJobManager.trackTask('storefront_libraries', 'Steam', async () => {
          try {
            if (typeof window !== 'undefined' && window.electronAPI?.syncStore) {
              const steamRes = await window.electronAPI.syncStore('steam');
              if (Array.isArray(steamRes?.suppressedItems) && steamRes.suppressedItems.length > 0) {
                registerSuppressedCatalogEntries(
                  steamRes.suppressedItems as SuppressedCatalogEntry[]
                );
              }
              if (steamRes?.achievements && Object.keys(steamRes.achievements).length > 0) {
                steamAchs = {
                  ...steamAchs,
                  ...(steamRes.achievements as Record<number, CachedAchievementEntry>),
                };
                cacheUserSteamAchievements(steamAchs);
              }
              if (steamRes?.success && steamRes.games && steamRes.games.length > 0) {
                const verifiedSteamGames = steamRes.games.map((g) => ({
                  ...g,
                  isVerifiedEntitlement: true,
                }));
                currentCatalog = mergeStorefrontGames(currentCatalog, verifiedSteamGames, 'steam');
                try {
                  const liveAchs =
                    await steamAchievementsService.syncUserLibraryAchievements(verifiedSteamGames);
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

      const gogInteg = integrations.find((i) => i.storefrontId === 'gog' && i.isConnected);
      if (gogInteg) {
        await syncJobManager.trackTask('storefront_libraries', 'GOG.com', async () => {
          try {
            let syncedGog = false;
            if (typeof window !== 'undefined' && window.electronAPI?.syncStore) {
              const gogRes = await window.electronAPI.syncStore('gog', gogInteg.credentials);
              if (Array.isArray(gogRes?.suppressedItems) && gogRes.suppressedItems.length > 0) {
                registerSuppressedCatalogEntries(
                  gogRes.suppressedItems as SuppressedCatalogEntry[]
                );
              }
              if (gogRes?.achievements && Object.keys(gogRes.achievements).length > 0) {
                gogAchs = {
                  ...gogAchs,
                  ...(gogRes.achievements as Record<string, CachedAchievementEntry>),
                };
                cacheUserGogAchievements(gogAchs);
              }
              if (gogRes?.success && gogRes.games && gogRes.games.length > 0) {
                const verifiedGogGames = gogRes.games.map((g) => ({
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

      const epicInteg = integrations.find((i) => i.storefrontId === 'epic' && i.isConnected);
      if (epicInteg) {
        await syncJobManager.trackTask('storefront_libraries', 'Epic Games Store', async () => {
          try {
            let syncedEpic = false;
            if (typeof window !== 'undefined' && window.electronAPI?.syncStore) {
              const epicRes = await window.electronAPI.syncStore('epic', epicInteg.credentials);
              if (Array.isArray(epicRes?.suppressedItems) && epicRes.suppressedItems.length > 0) {
                registerSuppressedCatalogEntries(
                  epicRes.suppressedItems as SuppressedCatalogEntry[]
                );
              }
              if (epicRes?.achievements && Object.keys(epicRes.achievements).length > 0) {
                epicAchs = {
                  ...epicAchs,
                  ...(epicRes.achievements as Record<string, CachedAchievementEntry>),
                };
                cacheUserEpicAchievements(epicAchs);
              }
              if (epicRes?.success && epicRes.games && epicRes.games.length > 0) {
                const verifiedEpicGames = epicRes.games.map((g) => ({
                  ...g,
                  isVerifiedEntitlement: true,
                }));
                currentCatalog = mergeStorefrontGames(currentCatalog, verifiedEpicGames, 'epic');
                syncedEpic = true;
              }
            }
            if (!syncedEpic) {
              const { games: epicGames } = await connectEpicIntegration(
                epicInteg.credentials || {}
              );
              if (epicGames && epicGames.length > 0) {
                currentCatalog = mergeStorefrontGames(currentCatalog, epicGames, 'epic');
              }
            }
          } catch (e) {
            console.warn('Epic sync warning:', e);
          }
        });
      }

      const xboxInteg = integrations.find((i) => i.storefrontId === 'xbox' && i.isConnected);
      if (xboxInteg) {
        await syncJobManager.trackTask('storefront_libraries', 'Xbox', async () => {
          try {
            let syncedXbox = false;
            const cachedXboxProfile = loadXboxProfileState();
            const syncMode: XboxGamePassSyncMode =
              cachedXboxProfile?.syncMode || 'owned_and_played';
            if (typeof window !== 'undefined' && window.electronAPI?.syncStore) {
              const xboxRes = await window.electronAPI.syncStore('xbox', {
                ...(xboxInteg.credentials || {}),
                syncMode,
              });
              if (Array.isArray(xboxRes?.suppressedItems) && xboxRes.suppressedItems.length > 0) {
                registerSuppressedCatalogEntries(
                  xboxRes.suppressedItems as SuppressedCatalogEntry[]
                );
              }
              if (xboxRes?.achievements && Object.keys(xboxRes.achievements).length > 0) {
                xboxAchs = {
                  ...xboxAchs,
                  ...(xboxRes.achievements as Record<string, CachedAchievementEntry>),
                };
                cacheUserXboxAchievements(xboxAchs);
              }
              if (
                xboxRes?.gamertag ||
                xboxRes?.modernGamertag ||
                xboxRes?.xuid ||
                xboxRes?.avatarUrl ||
                typeof xboxRes?.gamerscore === 'number' ||
                xboxRes?.subscription
              ) {
                saveXboxProfileState({
                  connected: true,
                  gamertag: xboxRes.gamertag || xboxInteg.accountName,
                  modernGamertag:
                    xboxRes.modernGamertag || xboxRes.gamertag || xboxInteg.accountName,
                  xuid: xboxRes.xuid || xboxInteg.accountId,
                  avatarUrl: xboxRes.avatarUrl || xboxInteg.avatarUrl,
                  gamerscore: xboxRes.gamerscore ?? cachedXboxProfile?.gamerscore,
                  subscription: xboxRes.subscription ?? cachedXboxProfile?.subscription ?? null,
                  syncMode: xboxRes.syncMode || syncMode,
                  lastSyncedAt: new Date().toISOString(),
                });
              }
              if (xboxRes?.success && Array.isArray(xboxRes.games)) {
                const verifiedXboxGames = xboxRes.games.map((g) => ({
                  ...g,
                  isVerifiedEntitlement: true,
                }));
                currentCatalog = mergeStorefrontGames(currentCatalog, verifiedXboxGames, 'xbox');
                syncedXbox = true;
              }
            }
            if (!syncedXbox) {
              const { games: xboxGames } = await connectXboxIntegration({
                ...(xboxInteg.credentials || {}),
                syncMode,
              });
              currentCatalog = mergeStorefrontGames(currentCatalog, xboxGames, 'xbox');
            }
          } catch (e) {
            console.warn('Xbox sync warning:', e);
          }
        });
      }

      currentCatalog = runIntelligentNonSteamMatchPass(currentCatalog);
      currentCatalog = reconcileCatalogTrophiesRecords(
        currentCatalog,
        steamAchs,
        gogAchs,
        epicAchs,
        installedSteamAppIds,
        xboxAchs
      );
      if (onlineLifecycleManager.isOnline()) {
        achievementDetailService.clearCache();
      }

      currentCatalog = overlayLauncherInstalledState(sanitizeGameCatalog(currentCatalog));

      const steamCount = currentCatalog.filter((g) =>
        g.platforms?.some((p) => p.platformId === 'steam')
      ).length;
      const gogCount = currentCatalog.filter((g) =>
        g.platforms?.some((p) => p.platformId === 'gog')
      ).length;
      const epicCount = currentCatalog.filter((g) =>
        g.platforms?.some((p) => p.platformId === 'epic')
      ).length;
      const xboxCount = currentCatalog.filter((g) =>
        g.platforms?.some((p) => p.platformId === 'xbox')
      ).length;

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
      gamesRef.current = currentCatalog;
      setGames(currentCatalog);
      saveCurrentCatalog(currentCatalog);
      setGameRefreshKey((k) => k + 1);

      if (newGamesDetected > 0) {
        showSyncNotice(
          `Sync complete! Detected ${newGamesDetected} newly added title${
            newGamesDetected === 1 ? '' : 's'
          } across your storefronts! (${currentCatalog.length} total titles)`,
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
          `All connected storefronts up to date: ${storeParts.join(
            ', '
          )} titles (trophies & playtime refreshed)`,
          5000
        );
      }
    } catch (err: unknown) {
      showSyncNotice(
        `Sync notice: ${getErrorMessage(err, 'Using cached verified catalog')}`,
        5000
      );
    } finally {
      setIsSyncing(false);
      window.electronAPI?.trimMemory?.({ passive: true })?.catch?.(() => {});
    }
  }, [gamesRef, overlayLauncherInstalledState, setGameRefreshKey, setGames, showSyncNotice]);

  const handleSyncTrophies = useCallback(async () => {
    if (isSyncingTrophies) return;
    setIsSyncingTrophies(true);
    showSyncNotice(
      'Syncing trophies & achievements across Steam, GOG.com, Epic Games Store, and Xbox...'
    );

    try {
      const [
        { syncJobManager },
        { steamAchievementsService },
        { gogIntegration },
        { epicIntegration },
        { xboxIntegration },
        { achievementDetailService },
      ] = await Promise.all([
        import('../services/network/syncJobManager'),
        import('../services/steam/steamAchievementsService'),
        import('../services/integrations/gogIntegration'),
        import('../services/integrations/epicIntegration'),
        import('../services/integrations/xboxIntegration'),
        import('../services/achievements/achievementDetailService'),
      ]);

      const integrations = loadIntegrations();
      const steamAchs: Record<number, CachedAchievementEntry> = {};
      const gogAchs: Record<string, CachedAchievementEntry> = {};
      const epicAchs: Record<string, CachedAchievementEntry> = {};
      const xboxAchs: Record<string, CachedAchievementEntry> = {};

      await syncJobManager.startTrophySync(5, async (updateProgress, checkCancelled) => {
        updateProgress(0, 5, 'Scanning Local Steam Trophy Cache');
        try {
          const localScanned = await scanLocalSteamAchievements();
          if (localScanned && Object.keys(localScanned).length > 0) {
            Object.assign(steamAchs, localScanned);
            cacheUserSteamAchievements(steamAchs);
          }
        } catch {}
        if (checkCancelled()) return;

        updateProgress(1, 5, 'Syncing Steam Cloud Achievements');
        try {
          const liveSteam = await steamAchievementsService.syncUserLibraryAchievements(
            gamesRef.current,
            (_done, _total, currentTitle) => {
              if (!checkCancelled()) {
                updateProgress(
                  1,
                  5,
                  currentTitle ? `Steam: ${currentTitle}` : 'Syncing Steam Cloud Achievements'
                );
              }
            },
            {
              forceRefresh: true,
              onBatchUpdated: (partialSteam) => {
                Object.assign(steamAchs, partialSteam);
                cacheUserSteamAchievements(steamAchs);
                const reconciledPartial = reconcileCatalogTrophiesRecords(
                  gamesRef.current,
                  steamAchs,
                  gogAchs,
                  epicAchs,
                  null,
                  xboxAchs
                );
                gamesRef.current = reconciledPartial;
                setGames(reconciledPartial);
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

        updateProgress(2, 5, 'Syncing GOG Galaxy Achievements');
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

        updateProgress(3, 5, 'Syncing Epic Games Store Trophies');
        try {
          const epicInteg = integrations.find((i) => i.storefrontId === 'epic' && i.isConnected);
          const epicAccountId =
            epicInteg?.credentials?.epicAccountId || epicInteg?.accountId || '';
          const epicToken = epicInteg?.credentials?.epicToken;
          const fetchedEpic = await epicIntegration.fetchUserAchievements(
            epicAccountId,
            epicToken
          );
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
        if (checkCancelled()) return;

        updateProgress(4, 5, 'Syncing Xbox Live Achievements & Gamerscore');
        try {
          const xboxInteg = integrations.find((i) => i.storefrontId === 'xbox' && i.isConnected);
          const xboxPfns = Array.from(
            new Set(
              gamesRef.current
                .flatMap((g) => g.platforms)
                .filter((p) => p.platformId === 'xbox' && Boolean(p.packageFamilyName))
                .map((p) => p.packageFamilyName!)
            )
          );
          const fetchedXbox = await xboxIntegration.fetchUserAchievements(
            xboxPfns.length > 0 ? xboxPfns : undefined
          );
          if (fetchedXbox && Object.keys(fetchedXbox).length > 0) {
            Object.assign(xboxAchs, fetchedXbox);
            cacheUserXboxAchievements(xboxAchs);
          } else if (xboxInteg && typeof window !== 'undefined' && window.electronAPI?.syncStore) {
            const cachedProfile = loadXboxProfileState();
            const xboxRes = await window.electronAPI.syncStore('xbox', {
              ...(xboxInteg.credentials || {}),
              syncMode: cachedProfile?.syncMode || 'owned_and_played',
            });
            if (xboxRes?.achievements && Object.keys(xboxRes.achievements).length > 0) {
              Object.assign(xboxAchs, xboxRes.achievements);
              cacheUserXboxAchievements(xboxAchs);
            }
          }
        } catch (err) {
          console.warn('Xbox trophy sync warning:', err);
        }

        updateProgress(5, 5, 'Reconciling Storefront Trophies');
      });

      if (onlineLifecycleManager.isOnline()) {
        achievementDetailService.clearCache();
      }

      const reconciled = reconcileCatalogTrophiesRecords(
        gamesRef.current,
        steamAchs,
        gogAchs,
        epicAchs,
        null,
        xboxAchs
      );
      const gamesWithTrophies = reconciled.filter((g) =>
        g.platforms.some(
          (p) =>
            p.achievements &&
            (p.achievements.unlocked > 0 ||
              p.achievements.total > 0 ||
              (p.achievements.gamerscore?.earned ?? 0) > 0)
        )
      ).length;
      gamesRef.current = reconciled;
      setGames(reconciled);

      setGameRefreshKey((k) => k + 1);
      showSyncNotice(
        `Trophies synced across Steam, GOG, Epic & Xbox! (${gamesWithTrophies} titles with achievement data updated)`,
        5000
      );
    } catch (err: unknown) {
      showSyncNotice(
        `Trophy sync notice: ${getErrorMessage(err, 'Finished syncing trophies')}`,
        5000
      );
    } finally {
      setIsSyncingTrophies(false);
      window.electronAPI?.trimMemory?.({ passive: true })?.catch?.(() => {});
    }
  }, [gamesRef, isSyncingTrophies, setGameRefreshKey, setGames, showSyncNotice]);

  const handleSyncCurrentGame = useCallback(
    async (gameToSync?: CanonicalGame) => {
      const target = gameToSync || selectedGame;
      if (!target || isSyncingCurrentGame) return;
      const targetAppId = steamMatcher.getEffectiveSteamAppId(target);
      const gogId = target.platforms?.find((p) => p.platformId === 'gog')?.platformGameId;

      setIsSyncingCurrentGame(true);
      showSyncNotice(
        targetAppId
          ? `Syncing ${target.title} from Steam...`
          : `Syncing ${target.title} store metadata...`
      );

      try {
        const [
          { syncJobManager },
          { igdbCoverService, isUnsuitableCoverUrl },
          { fallbackMetadataProvider, isGenericPlaceholderSynopsis },
          { steamAchievementsService },
        ] = await Promise.all([
          import('../services/network/syncJobManager'),
          import('../services/igdb/igdbCoverService'),
          import('../services/steam/fallbackMetadataProvider'),
          import('../services/steam/steamAchievementsService'),
        ]);

        if (onlineLifecycleManager.isOnline()) {
          igdbCoverService.evictCacheForGame(target.title, gogId, targetAppId);
          if (targetAppId) {
            steamApi.evictCache(targetAppId);
          }
          clearFailedCoverUrls(target.id);
          clearFailedSidebarIconUrls();
        }

        await syncJobManager.runPriorityAction('Syncing Game Media', target.title, async () => {
          if (!targetAppId) {
            const [refreshed, gogBoxArt, igdbCover] = await Promise.all([
              fallbackMetadataProvider
                .getEnrichedMetadataForNonSteamGame(target)
                .catch(() => null),
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
              const updated = gamesRef.current.map((g) => {
                if (g.id === target.id) {
                  const cleanDevelopers = refreshed?.developers?.filter(
                    (d) => d && d !== 'Unknown Developer'
                  );
                  const existingValidCapsule =
                    g.capsuleImage && !isUnsuitableCoverUrl(g.capsuleImage)
                      ? g.capsuleImage
                      : undefined;
                  const safeRefreshed =
                    refreshed &&
                    refreshed.metadataQuality === 'skeleton_fallback' &&
                    g.enrichedMetadata &&
                    g.enrichedMetadata.metadataQuality !== 'skeleton_fallback'
                      ? undefined
                      : refreshed;
                  return {
                    ...g,
                    enrichedMetadata: safeRefreshed || g.enrichedMetadata,
                    headerImage: safeRefreshed?.headerImage || g.headerImage,
                    capsuleImage: validRefreshedCapsule || existingValidCapsule,
                    shortDescription:
                      safeRefreshed?.shortDescription &&
                      !isGenericPlaceholderSynopsis(safeRefreshed.shortDescription, target.title)
                        ? safeRefreshed.shortDescription
                        : g.shortDescription,
                    detailedDescription:
                      safeRefreshed?.detailedDescription ||
                      safeRefreshed?.aboutTheGame ||
                      g.detailedDescription,
                    developers: cleanDevelopers?.length ? cleanDevelopers : g.developers,
                    publishers: safeRefreshed?.publishers?.length
                      ? safeRefreshed.publishers
                      : g.publishers,
                    releaseDate:
                      safeRefreshed?.releaseDate && safeRefreshed.releaseDate !== 'TBA'
                        ? safeRefreshed.releaseDate
                        : g.releaseDate,
                    genres: safeRefreshed?.genres?.length ? safeRefreshed.genres : g.genres,
                    tags: safeRefreshed?.tags?.length ? safeRefreshed.tags : g.tags,
                    reviewSummary: safeRefreshed?.reviewSummary || g.reviewSummary,
                  };
                }
                return g;
              });
              gamesRef.current = updated;
              setGames(updated);
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
            const updated = gamesRef.current.map((g) => {
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
                const safeRefreshed =
                  refreshed &&
                  refreshed.metadataQuality === 'skeleton_fallback' &&
                  g.enrichedMetadata &&
                  g.enrichedMetadata.metadataQuality !== 'skeleton_fallback'
                    ? undefined
                    : refreshed;

                return {
                  ...g,
                  steamAppId: targetAppId,
                  platforms: updatedPlatforms,
                  enrichedMetadata: safeRefreshed || g.enrichedMetadata,
                  headerImage:
                    safeRefreshed?.headerImage || browseAssets?.headerImage || g.headerImage,
                  capsuleImage: resolvedVerticalCover || existingValidCapsule,
                  iconUrl: browseAssets?.iconUrl || g.iconUrl,
                  shortDescription: safeRefreshed?.shortDescription || g.shortDescription,
                  developers: safeRefreshed?.developers?.length
                    ? safeRefreshed.developers
                    : g.developers,
                  publishers: safeRefreshed?.publishers?.length
                    ? safeRefreshed.publishers
                    : g.publishers,
                  genres: safeRefreshed?.genres?.length ? safeRefreshed.genres : g.genres,
                  tags: safeRefreshed?.tags?.length ? safeRefreshed.tags : g.tags,
                  reviewSummary: safeRefreshed?.reviewSummary || g.reviewSummary,
                };
              }
              return g;
            });
            gamesRef.current = updated;
            setGames(updated);
            setGameRefreshKey((prev) => prev + 1);
            showSyncNotice(`Successfully synced ${target.title} from Steam!`, 5000);
          } else {
            showSyncNotice(`No new updates found on Steam for ${target.title}.`, 5000);
          }
        });
      } catch (err: unknown) {
        showSyncNotice(`Sync notice: ${getErrorMessage(err, 'Error syncing game')}`, 5000);
      } finally {
        setIsSyncingCurrentGame(false);
      }
    },
    [gamesRef, isSyncingCurrentGame, selectedGame, setGameRefreshKey, setGames, showSyncNotice]
  );

  const handleSyncStoreMedia = useCallback(async () => {
    if (isSyncingAllMedia) return;
    setIsSyncingAllMedia(true);
    showSyncNotice('Starting store media sync (trailers, screenshots & descriptions)...', 3000);

    const pendingMediaUpdates = new Map<string, CanonicalGame>();
    let mediaFlushTimer: ReturnType<typeof setTimeout> | null = null;
    const isVitest = isVitestRuntime();

    const flushMediaBatch = () => {
      mediaFlushTimer = null;
      if (pendingMediaUpdates.size === 0) return;
      const batch = new Map(pendingMediaUpdates);
      pendingMediaUpdates.clear();

      const prev = gamesRef.current;
      let changed = false;
      const next = prev.map((g) => {
        const updated = batch.get(g.id);
        if (updated) {
          changed = true;
          return mergeUpdatedGamePreservingLivePlatformState(g, updated);
        }
        return g;
      });
      if (changed) {
        gamesRef.current = next;
        setGames(next);
      }
    };

    try {
      const { syncJobManager } = await import('../services/network/syncJobManager');
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
      showSyncNotice(
        'Store media sync complete! Refreshed trailers, screenshots & descriptions.',
        5000
      );
    } catch (err: unknown) {
      if (mediaFlushTimer) {
        clearTimeout(mediaFlushTimer);
        mediaFlushTimer = null;
      }
      flushMediaBatch();
      showSyncNotice(
        `Media sync notice: ${getErrorMessage(err, 'Finished media sync')}`,
        5000
      );
    } finally {
      if (mediaFlushTimer) {
        clearTimeout(mediaFlushTimer);
        mediaFlushTimer = null;
      }
      setIsSyncingAllMedia(false);
      window.electronAPI?.trimMemory?.({ passive: true })?.catch?.(() => {});
    }
  }, [games, gamesRef, isSyncingAllMedia, setGames, setIsSyncingAllMedia, showSyncNotice]);

  const handleRefreshScores = useCallback(async () => {
    if (isSyncingScores) return;
    setIsSyncingScores(true);
    showSyncNotice('Starting critic score refresh across OpenCritic, Metacritic & Steam...', 3000);

    try {
      const { syncJobManager } = await import('../services/network/syncJobManager');
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

      showSyncNotice('Critic scores refreshed across your library.', 5000);
    } catch (err: unknown) {
      console.warn('Score refresh error:', err);
      showSyncNotice('Finished refreshing available critic scores.', 5000);
    } finally {
      setIsSyncingScores(false);
      window.electronAPI?.trimMemory?.({ passive: true })?.catch?.(() => {});
    }
  }, [games, isSyncingScores, showSyncNotice]);

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
