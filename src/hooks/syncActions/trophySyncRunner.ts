import type { Dispatch, MutableRefObject, SetStateAction } from 'react';
import type { CanonicalGame } from '../../contracts/game';
import { scanLocalSteamAchievements } from '../../services/system/localSystemScanner';
import {
  cacheUserSteamAchievements,
  cacheUserGogAchievements,
  cacheUserEpicAchievements,
  cacheUserXboxAchievements,
  type CachedAchievementEntry,
} from '../../services/storage/knownGameAchievements';
import {
  loadIntegrations,
  loadXboxProfileState,
  saveCurrentCatalog,
} from '../../services/integrations/integrationStorage';
import { RequestPriority } from '../../services/network/requestScheduler';
import { onlineLifecycleManager } from '../../services/network/onlineLifecycleManager';
import { reconcileCatalogTrophiesRecords } from '../../utils/catalogMergeUtils';
import type { SyncNoticeTone } from '../useSyncNotice';
import { computeCatalogDiffIds } from './syncActionHelpers';

export interface RunStorefrontTrophySyncParams {
  gamesRef: MutableRefObject<CanonicalGame[]>;
  setGames: Dispatch<SetStateAction<CanonicalGame[]>>;
  setGameRefreshKey: Dispatch<SetStateAction<number>>;
  onCatalogPersisted?: (catalog: CanonicalGame[]) => void;
  showSyncNotice: (
    message: string | null,
    durationMs?: number | null,
    tone?: SyncNoticeTone
  ) => void;
  isMountedRef: MutableRefObject<boolean>;
}

export interface RunStorefrontTrophySyncResult {
  cancelled: boolean;
}

/**
 * Runs dedicated cross-storefront trophy synchronization via `syncJobManager.startTrophySync(...)`
 * directly — intentionally NOT wrapped in `beginPriorityScope` so `startTrophySync` never
 * self-preempts its own UI job state (P0-3).
 */
export async function runStorefrontTrophySync({
  gamesRef,
  setGames,
  setGameRefreshKey,
  onCatalogPersisted,
  showSyncNotice,
  isMountedRef,
}: RunStorefrontTrophySyncParams): Promise<RunStorefrontTrophySyncResult> {
  const [
    { syncJobManager },
    { steamAchievementsService },
    { gogIntegration },
    { epicIntegration },
    { xboxIntegration },
    { achievementDetailService },
  ] = await Promise.all([
    import('../../services/network/syncJobManager'),
    import('../../services/steam/steamAchievementsService'),
    import('../../services/integrations/gogIntegration'),
    import('../../services/integrations/epicIntegration'),
    import('../../services/integrations/xboxIntegration'),
    import('../../services/achievements/achievementDetailService'),
  ]);

  const integrations = loadIntegrations();
  const steamAchs: Record<number, CachedAchievementEntry> = {};
  const gogAchs: Record<string, CachedAchievementEntry> = {};
  const epicAchs: Record<string, CachedAchievementEntry> = {};
  const xboxAchs: Record<string, CachedAchievementEntry> = {};
  let wasCancelled = false;

  await syncJobManager.startTrophySync(5, async (updateProgress, checkCancelled) => {
    updateProgress(0, 5, 'Scanning Local Steam Trophy Cache');
    try {
      const localScanned = await scanLocalSteamAchievements();
      if (localScanned && Object.keys(localScanned).length > 0) {
        Object.assign(steamAchs, localScanned);
        cacheUserSteamAchievements(steamAchs);
      }
    } catch {}
    if (checkCancelled()) {
      wasCancelled = true;
      return;
    }

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
          priority: RequestPriority.P1_VIEWPORT,
          onBatchUpdated: (partialSteam) => {
            Object.assign(steamAchs, partialSteam);
            cacheUserSteamAchievements(steamAchs);
            const basePartial = gamesRef.current;
            const reconciledPartial = reconcileCatalogTrophiesRecords(
              basePartial,
              steamAchs,
              gogAchs,
              epicAchs,
              null,
              xboxAchs
            );
            gamesRef.current = reconciledPartial;
            if (isMountedRef.current) {
              setGames((latest) => {
                const next =
                  latest === basePartial
                    ? reconciledPartial
                    : reconcileCatalogTrophiesRecords(
                        latest,
                        steamAchs,
                        gogAchs,
                        epicAchs,
                        null,
                        xboxAchs
                      );
                gamesRef.current = next;
                return next;
              });
            }
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
    if (checkCancelled()) {
      wasCancelled = true;
      return;
    }

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
    if (checkCancelled()) {
      wasCancelled = true;
      return;
    }

    updateProgress(3, 5, 'Syncing Epic Games Store Trophies');
    try {
      const epicInteg = integrations.find((i) => i.storefrontId === 'epic' && i.isConnected);
      const epicAccountId = epicInteg?.credentials?.epicAccountId || epicInteg?.accountId || '';
      const epicToken = epicInteg?.credentials?.epicToken;
      const epicTargets = gamesRef.current.flatMap((g) =>
        g.platforms
          .filter((p) => p.platformId === 'epic' && Boolean(p.namespace))
          .map((p) => ({
            sandboxId: p.namespace!,
            namespace: p.namespace!,
            ...(p.storefrontAppId || p.platformGameId
              ? { appName: p.storefrontAppId || p.platformGameId }
              : {}),
            ...(p.catalogItemId ? { catalogItemId: p.catalogItemId } : {}),
            title: g.title,
          }))
      );
      const fetchedEpic = await epicIntegration.fetchUserAchievements(
        epicAccountId,
        epicToken,
        epicTargets.length > 0 ? epicTargets : undefined,
        epicTargets.length > 0 ? { forceRefresh: true } : undefined
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
    if (checkCancelled()) {
      wasCancelled = true;
      return;
    }

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
    if (checkCancelled()) {
      wasCancelled = true;
      return;
    }

    updateProgress(5, 5, 'Reconciling Storefront Trophies');
  });

  if (
    !wasCancelled &&
    syncJobManager.getState()?.type === 'achievements' &&
    syncJobManager.getState()?.status === 'cancelled'
  ) {
    wasCancelled = true;
  }

  if (onlineLifecycleManager.isOnline()) {
    achievementDetailService.clearCache();
  }

  const baseAtCommit = gamesRef.current;
  const reconciled = reconcileCatalogTrophiesRecords(
    baseAtCommit,
    steamAchs,
    gogAchs,
    epicAchs,
    null,
    xboxAchs
  );
  gamesRef.current = reconciled;
  if (isMountedRef.current) {
    setGames((latest) => {
      const next =
        latest === baseAtCommit
          ? reconciled
          : reconcileCatalogTrophiesRecords(
              latest,
              steamAchs,
              gogAchs,
              epicAchs,
              null,
              xboxAchs
            );
      gamesRef.current = next;
      return next;
    });
  }

  const finalCatalog = gamesRef.current;
  const { dirtyGameIds } = computeCatalogDiffIds(baseAtCommit, finalCatalog);
  if (dirtyGameIds.size > 0) {
    saveCurrentCatalog(finalCatalog, {
      dirtyGameIds,
      skipSanitize: true,
    });
    onCatalogPersisted?.(finalCatalog);
  }

  const gamesWithTrophies = finalCatalog.filter((g) =>
    g.platforms.some(
      (p) =>
        p.achievements &&
        (p.achievements.unlocked > 0 ||
          p.achievements.total > 0 ||
          (p.achievements.gamerscore?.earned ?? 0) > 0)
    )
  ).length;

  if (isMountedRef.current) {
    setGameRefreshKey((k) => k + 1);
    if (wasCancelled) {
      showSyncNotice('Trophy sync cancelled.', 4000);
    } else {
      showSyncNotice(
        `Trophies synced across Steam, GOG, Epic & Xbox! (${gamesWithTrophies} titles with achievement data updated)`,
        5000
      );
    }
  }

  return { cancelled: wasCancelled };
}
