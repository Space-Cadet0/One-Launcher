import type { Dispatch, MutableRefObject, SetStateAction } from 'react';
import type { CanonicalGame, XboxGamePassSyncMode } from '../../contracts/game';
import {
  scanLocalInstalledGames,
  scanLocalSteamAchievements,
} from '../../services/system/localSystemScanner';
import {
  cacheUserSteamAchievements,
  cacheUserGogAchievements,
  cacheUserEpicAchievements,
  cacheUserXboxAchievements,
  type CachedAchievementEntry,
} from '../../services/storage/knownGameAchievements';
import {
  loadIntegrations,
  mergeStorefrontGames,
  saveCurrentCatalog,
  connectGogIntegration,
  connectEpicIntegration,
  connectXboxIntegration,
  loadXboxProfileState,
  saveXboxProfileState,
} from '../../services/integrations/integrationStorage';
import {
  sanitizeGameCatalog,
  registerSuppressedCatalogEntries,
} from '../../services/integrations/catalogSanitizer';
import { RequestPriority } from '../../services/network/requestScheduler';
import { onlineLifecycleManager } from '../../services/network/onlineLifecycleManager';
import {
  reconcileCatalogTrophiesRecords,
  runIntelligentNonSteamMatchPass,
} from '../../utils/catalogMergeUtils';
import type { SyncNoticeTone } from '../useSyncNotice';
import {
  computeCatalogDiffIds,
  refreshConnectedIntegrationCounts,
} from './syncActionHelpers';

type CoreSyncStorefrontId = 'steam' | 'gog' | 'epic' | 'xbox';

interface StorefrontMergeStep {
  storefrontId: CoreSyncStorefrontId;
  games: CanonicalGame[];
  options?: { authoritativeComplete?: boolean };
}

const CANONICAL_MERGE_ORDER: readonly CoreSyncStorefrontId[] = ['steam', 'gog', 'epic', 'xbox'];

export interface RunStorefrontLibrarySyncParams {
  gamesRef: MutableRefObject<CanonicalGame[]>;
  setGames: Dispatch<SetStateAction<CanonicalGame[]>>;
  setGameRefreshKey: Dispatch<SetStateAction<number>>;
  overlayLauncherInstalledState: (catalog: CanonicalGame[]) => CanonicalGame[];
  onCatalogPersisted?: (catalog: CanonicalGame[]) => void;
  showSyncNotice: (
    message: string | null,
    durationMs?: number | null,
    tone?: SyncNoticeTone
  ) => void;
  isMountedRef: MutableRefObject<boolean>;
}

/**
 * Runs manual multi-storefront library sync concurrently across all connected stores
 * via `Promise.allSettled`, merges results in deterministic canonical order
 * (`steam -> gog -> epic -> xbox`) against live `gamesRef.current`, and persists only
 * incremental `dirtyGameIds`/`removedGameIds`.
 */
export async function runStorefrontLibrarySync({
  gamesRef,
  setGames,
  setGameRefreshKey,
  overlayLauncherInstalledState,
  onCatalogPersisted,
  showSyncNotice,
  isMountedRef,
}: RunStorefrontLibrarySyncParams): Promise<void> {
  const [
    { syncJobManager },
    { steamAchievementsService },
    { steamIntegration },
    { achievementDetailService },
  ] = await Promise.all([
    import('../../services/network/syncJobManager'),
    import('../../services/steam/steamAchievementsService'),
    import('../../services/integrations/steamIntegration'),
    import('../../services/achievements/achievementDetailService'),
  ]);

  const priorityScopeId = syncJobManager.beginPriorityScope('Syncing Storefront Libraries');
  try {
    const integrations = loadIntegrations();
    const initialGameIds = new Set(gamesRef.current.map((g) => g.id));

    const mergesByStore = new Map<CoreSyncStorefrontId, StorefrontMergeStep>();
    let installedSteamAppIds: Set<number> | null = null;
    let localSteamAchs: Record<number, CachedAchievementEntry> = {};
    let storeSteamAchs: Record<number, CachedAchievementEntry> = {};
    let liveSteamAchs: Record<number, CachedAchievementEntry> = {};
    let gogAchs: Record<string, CachedAchievementEntry> = {};
    let epicAchs: Record<string, CachedAchievementEntry> = {};
    let xboxAchs: Record<string, CachedAchievementEntry> = {};

    const localScanTask = (async () => {
      const [scannedAchs, scanResult] = await Promise.allSettled([
        scanLocalSteamAchievements(),
        scanLocalInstalledGames(),
      ]);
      if (
        scannedAchs.status === 'fulfilled' &&
        scannedAchs.value &&
        Object.keys(scannedAchs.value).length > 0
      ) {
        localSteamAchs = scannedAchs.value;
        cacheUserSteamAchievements(localSteamAchs);
      }
      if (scanResult.status === 'fulfilled' && scanResult.value?.success) {
        installedSteamAppIds = new Set(scanResult.value.installedSteamAppIds);
      }
    })();

    const tasks: Array<Promise<void>> = [localScanTask];

    const steamInteg = integrations.find((i) => i.storefrontId === 'steam' && i.isConnected);
    if (steamInteg) {
      tasks.push(
        syncJobManager.trackTask('storefront_libraries', 'Steam', async () => {
          try {
            if (typeof window !== 'undefined' && window.electronAPI?.syncStore) {
              const steamRes = await window.electronAPI.syncStore('steam');
              if (Array.isArray(steamRes?.suppressedItems)) {
                registerSuppressedCatalogEntries(steamRes.suppressedItems, {
                  storefrontId: 'steam',
                  authoritativeComplete: Boolean(steamRes?.authoritativeComplete),
                  authoritativeGames: Array.isArray(steamRes?.games) ? steamRes.games : undefined,
                });
              }
              if (steamRes?.achievements && Object.keys(steamRes.achievements).length > 0) {
                storeSteamAchs = {
                  ...(steamRes.achievements as Record<number, CachedAchievementEntry>),
                };
                cacheUserSteamAchievements(storeSteamAchs);
              }
              if (steamRes?.success && steamRes.games && steamRes.games.length > 0) {
                const verifiedSteamGames = steamRes.games.map((g) => ({
                  ...g,
                  isVerifiedEntitlement: true,
                }));
                mergesByStore.set('steam', {
                  storefrontId: 'steam',
                  games: verifiedSteamGames,
                });
                try {
                  const liveAchs = await steamAchievementsService.syncUserLibraryAchievements(
                    verifiedSteamGames,
                    undefined,
                    { priority: RequestPriority.P1_VIEWPORT }
                  );
                  if (liveAchs && Object.keys(liveAchs).length > 0) {
                    liveSteamAchs = liveAchs;
                    cacheUserSteamAchievements(liveSteamAchs);
                  }
                } catch {}
              } else if (steamInteg.credentials?.steamId) {
                const res = await steamIntegration.fetchOwnedGames(steamInteg.credentials);
                mergesByStore.set('steam', {
                  storefrontId: 'steam',
                  games: res.games,
                });
              }
            } else if (steamInteg.credentials?.steamId) {
              const res = await steamIntegration.fetchOwnedGames(steamInteg.credentials);
              mergesByStore.set('steam', {
                storefrontId: 'steam',
                games: res.games,
              });
            }
          } catch (e) {
            console.warn('Steam sync warning:', e);
          }
        })
      );
    }

    const gogInteg = integrations.find((i) => i.storefrontId === 'gog' && i.isConnected);
    if (gogInteg) {
      tasks.push(
        syncJobManager.trackTask('storefront_libraries', 'GOG.com', async () => {
          try {
            let syncedGog = false;
            if (typeof window !== 'undefined' && window.electronAPI?.syncStore) {
              const gogRes = await window.electronAPI.syncStore('gog', gogInteg.credentials);
              if (Array.isArray(gogRes?.suppressedItems)) {
                registerSuppressedCatalogEntries(gogRes.suppressedItems, {
                  storefrontId: 'gog',
                  authoritativeComplete: Boolean(gogRes?.authoritativeComplete),
                  authoritativeGames: Array.isArray(gogRes?.games) ? gogRes.games : undefined,
                });
              }
              if (gogRes?.achievements && Object.keys(gogRes.achievements).length > 0) {
                gogAchs = {
                  ...gogAchs,
                  ...(gogRes.achievements as Record<string, CachedAchievementEntry>),
                };
                cacheUserGogAchievements(gogAchs);
              }
              if (gogRes?.success && Array.isArray(gogRes.games)) {
                if (gogRes.games.length > 0 || gogRes.authoritativeComplete === true) {
                  const verifiedGogGames = gogRes.games.map((g) => ({
                    ...g,
                    isVerifiedEntitlement: true,
                  }));
                  mergesByStore.set('gog', {
                    storefrontId: 'gog',
                    games: verifiedGogGames,
                    options: {
                      authoritativeComplete: Boolean(gogRes.authoritativeComplete),
                    },
                  });
                }
              }
              if (gogRes?.success || gogRes?.transientOffline) {
                syncedGog = true;
              }
            }
            if (!syncedGog) {
              const { games: gogGames, authoritativeComplete: gogAuthComplete } =
                await connectGogIntegration(gogInteg.credentials || {});
              const onlyGogGames = Array.isArray(gogGames)
                ? gogGames.filter((g) => g.platforms?.some((p) => p.platformId === 'gog'))
                : [];
              if (onlyGogGames.length > 0 || gogAuthComplete === true) {
                mergesByStore.set('gog', {
                  storefrontId: 'gog',
                  games: onlyGogGames,
                  options: {
                    authoritativeComplete: Boolean(gogAuthComplete),
                  },
                });
              }
            }
          } catch (e) {
            console.warn('GOG sync warning:', e);
          }
        })
      );
    }

    const epicInteg = integrations.find((i) => i.storefrontId === 'epic' && i.isConnected);
    if (epicInteg) {
      tasks.push(
        syncJobManager.trackTask('storefront_libraries', 'Epic Games Store', async () => {
          try {
            let syncedEpic = false;
            if (typeof window !== 'undefined' && window.electronAPI?.syncStore) {
              const epicRes = await window.electronAPI.syncStore('epic', epicInteg.credentials);
              if (Array.isArray(epicRes?.suppressedItems)) {
                registerSuppressedCatalogEntries(epicRes.suppressedItems, {
                  storefrontId: 'epic',
                  authoritativeComplete: Boolean(epicRes?.authoritativeComplete),
                  authoritativeGames: Array.isArray(epicRes?.games) ? epicRes.games : undefined,
                });
              }
              if (epicRes?.achievements && Object.keys(epicRes.achievements).length > 0) {
                epicAchs = {
                  ...epicAchs,
                  ...(epicRes.achievements as Record<string, CachedAchievementEntry>),
                };
                cacheUserEpicAchievements(epicAchs);
              }
              if (epicRes?.success && Array.isArray(epicRes.games)) {
                if (epicRes.games.length > 0 || epicRes.authoritativeComplete === true) {
                  const verifiedEpicGames = epicRes.games.map((g) => ({
                    ...g,
                    isVerifiedEntitlement: true,
                  }));
                  mergesByStore.set('epic', {
                    storefrontId: 'epic',
                    games: verifiedEpicGames,
                    options: {
                      authoritativeComplete: Boolean(epicRes.authoritativeComplete),
                    },
                  });
                }
              }
              if (epicRes?.success || epicRes?.transientOffline) {
                syncedEpic = true;
              }
            }
            if (!syncedEpic) {
              const { games: epicGames, authoritativeComplete: epicAuthComplete } =
                await connectEpicIntegration(epicInteg.credentials || {});
              const onlyEpicGames = Array.isArray(epicGames)
                ? epicGames.filter((g) => g.platforms?.some((p) => p.platformId === 'epic'))
                : [];
              if (onlyEpicGames.length > 0 || epicAuthComplete === true) {
                mergesByStore.set('epic', {
                  storefrontId: 'epic',
                  games: onlyEpicGames,
                  options: {
                    authoritativeComplete: Boolean(epicAuthComplete),
                  },
                });
              }
            }
          } catch (e) {
            console.warn('Epic sync warning:', e);
          }
        })
      );
    }

    const xboxInteg = integrations.find((i) => i.storefrontId === 'xbox' && i.isConnected);
    if (xboxInteg) {
      tasks.push(
        syncJobManager.trackTask('storefront_libraries', 'Xbox', async () => {
          try {
            let syncedXbox = false;
            const cachedXboxProfile = loadXboxProfileState();
            const syncMode: XboxGamePassSyncMode =
              cachedXboxProfile?.syncMode || 'owned_and_played';
            if (typeof window !== 'undefined' && window.electronAPI?.syncStore) {
              const xboxRes = await window.electronAPI.syncStore('xbox', {
                ...(xboxInteg.credentials || {}),
                syncMode,
                forceRefresh: true,
              });
              if (Array.isArray(xboxRes?.suppressedItems)) {
                registerSuppressedCatalogEntries(xboxRes.suppressedItems, {
                  storefrontId: 'xbox',
                  authoritativeComplete: Boolean(xboxRes?.authoritativeComplete),
                  authoritativeGames: Array.isArray(xboxRes?.games) ? xboxRes.games : undefined,
                });
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
                const xboxAuthoritativeComplete =
                  xboxRes.authoritativeComplete !== undefined
                    ? Boolean(xboxRes.authoritativeComplete)
                    : true;
                mergesByStore.set('xbox', {
                  storefrontId: 'xbox',
                  games: verifiedXboxGames,
                  options: {
                    authoritativeComplete: xboxAuthoritativeComplete,
                  },
                });
                syncedXbox = true;
              } else if (xboxRes?.transientOffline) {
                syncedXbox = true;
              }
            }
            if (!syncedXbox) {
              const { games: xboxGames, authoritativeComplete: xboxAuthComplete } =
                await connectXboxIntegration({
                  ...(xboxInteg.credentials || {}),
                  syncMode,
                  forceRefresh: true,
                });
              mergesByStore.set('xbox', {
                storefrontId: 'xbox',
                games: xboxGames,
                options: {
                  authoritativeComplete:
                    xboxAuthComplete !== undefined ? Boolean(xboxAuthComplete) : true,
                },
              });
            }
          } catch (e) {
            console.warn('Xbox sync warning:', e);
          }
        })
      );
    }

    await Promise.allSettled(tasks);

    const steamAchs: Record<number, CachedAchievementEntry> = {
      ...localSteamAchs,
      ...storeSteamAchs,
      ...liveSteamAchs,
    };
    if (Object.keys(steamAchs).length > 0) {
      cacheUserSteamAchievements(steamAchs);
    }

    const pendingStoreMerges: StorefrontMergeStep[] = [];
    for (const storeId of CANONICAL_MERGE_ORDER) {
      const step = mergesByStore.get(storeId);
      if (step) pendingStoreMerges.push(step);
    }

    if (onlineLifecycleManager.isOnline()) {
      achievementDetailService.clearCache();
    }

    const applyFetchedSyncToCatalog = (baseCatalog: CanonicalGame[]): CanonicalGame[] => {
      let merged = baseCatalog;
      for (const step of pendingStoreMerges) {
        merged = mergeStorefrontGames(merged, step.games, step.storefrontId, step.options);
      }
      merged = runIntelligentNonSteamMatchPass(merged);
      merged = reconcileCatalogTrophiesRecords(
        merged,
        steamAchs,
        gogAchs,
        epicAchs,
        installedSteamAppIds,
        xboxAchs
      );
      return overlayLauncherInstalledState(sanitizeGameCatalog(merged));
    };

    const liveBaseAtCommit = gamesRef.current;
    const committedCatalog = applyFetchedSyncToCatalog(liveBaseAtCommit);
    gamesRef.current = committedCatalog;
    if (isMountedRef.current) {
      setGames((latest) => {
        const next =
          latest === liveBaseAtCommit ? committedCatalog : applyFetchedSyncToCatalog(latest);
        gamesRef.current = next;
        return next;
      });
    }

    const finalCatalog = gamesRef.current;
    const { steamCount, gogCount, epicCount, xboxCount, updatedIntegrations } =
      refreshConnectedIntegrationCounts(finalCatalog);

    let newGamesDetected = 0;
    for (const g of finalCatalog) {
      if (!initialGameIds.has(g.id)) {
        newGamesDetected++;
      }
    }

    const { dirtyGameIds, removedGameIds } = computeCatalogDiffIds(liveBaseAtCommit, finalCatalog);
    if (dirtyGameIds.size > 0 || removedGameIds.size > 0) {
      saveCurrentCatalog(finalCatalog, {
        dirtyGameIds,
        removedGameIds: removedGameIds.size > 0 ? removedGameIds : undefined,
        skipSanitize: true,
      });
      onCatalogPersisted?.(finalCatalog);
    }

    if (isMountedRef.current) {
      setGameRefreshKey((k) => k + 1);
      if (newGamesDetected > 0) {
        showSyncNotice(
          `Sync complete! Detected ${newGamesDetected} newly added title${
            newGamesDetected === 1 ? '' : 's'
          } across your storefronts! (${finalCatalog.length} total titles)`,
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
    }
  } finally {
    syncJobManager.endPriorityScope(priorityScopeId);
  }
}
