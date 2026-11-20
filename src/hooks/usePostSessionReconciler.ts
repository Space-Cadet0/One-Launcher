import { useEffect, Dispatch, SetStateAction, MutableRefObject } from 'react';
import { CanonicalGame, StoreAchievementSummary } from '../contracts/game';
import { StorefrontId } from '../contracts/platform';
import { scanLocalSteamAchievements } from '../services/system/localSystemScanner';
import {
  cacheUserSteamAchievements,
  cacheUserGogAchievements,
  cacheUserEpicAchievements,
  cacheUserXboxAchievements,
  CachedAchievementEntry,
} from '../services/storage/knownGameAchievements';
import { reconcileCatalogTrophiesRecords } from '../utils/catalogMergeUtils';
import {
  normalizePlatformGameIdForLookup,
  saveCurrentCatalog,
  loadCurrentCatalog,
} from '../services/integrations/integrationStorage';
import { steamApi } from '../services/steam/steamApi';
import { RequestPriority } from '../services/network/requestScheduler';
import { getUserOverrideForGame } from '../services/storage/userOverrideStorage';
import { isMicrosoftStoreCdnUrl } from '../services/common/titleUtils';
import { sanitizeGameInstallSizeBytes } from '../utils/formatBytes';
import { SyncNoticeTone } from './useSyncNotice';
import { isUserActivelyScrolling } from '../utils/scrollActivityTracker';
import { onlineLifecycleManager } from '../services/network/onlineLifecycleManager';

export interface UsePostSessionReconcilerParams {
  gamesRef?: MutableRefObject<CanonicalGame[]>;
  setGames: Dispatch<SetStateAction<CanonicalGame[]>>;
  showSyncNotice: (
    message: string | null,
    durationMs?: number | null,
    tone?: SyncNoticeTone
  ) => void;
}

interface SteamMatchEventDetail {
  title?: string;
  steamAppId?: number;
}

interface GogCoverEventDetail {
  gogId?: string | number;
  coverUrl?: string;
}

interface GameSessionEndedEventDetail {
  sessionId?: string;
  sessionEvent?: 'stopped' | 'playtime_synced';
  gameId?: string;
  platformId?: StorefrontId;
  platformGameId?: string;
  sessionMinutesPlayed?: number;
  lastPlayed?: string;
  storefrontTotalPlaytimeMinutes?: number;
}

interface GameInstallLifecycleEventDetail {
  gameId?: string;
  platformId?: StorefrontId;
  platformGameId?: string;
  xboxProductId?: string;
  packageFamilyName?: string;
  appUserModelId?: string;
  xboxTitleId?: string;
  scid?: string;
  msaAppId?: string;
  version?: string;
  steamAppId?: number;
  installed?: boolean;
  installPath?: string;
  executablePath?: string;
  installSize?: number;
  launchArguments?: string;
  isWindowsBinaryOnMac?: boolean;
}

function isVitestRuntime(): boolean {
  if (typeof import.meta !== 'undefined' && import.meta.env?.MODE === 'test') {
    return true;
  }
  return typeof process !== 'undefined' && Boolean(process.env?.VITEST);
}

function computeMediaBatchUpdate(
  prevGames: CanonicalGame[],
  steamSnapshot: Map<string, number>,
  gogSnapshot: Map<string, string>
): {
  nextGames: CanonicalGame[];
  changed: boolean;
  missingBrowseAppIds: number[];
} {
  let changed = false;
  const missingSet = new Set<number>();

  const nextGames = prevGames.map((g) => {
    let updatedGame = g;

    if (steamSnapshot.size > 0 && !updatedGame.steamAppId && !updatedGame.isExplicitNonSteam) {
      const matchedId = steamSnapshot.get(updatedGame.title.toLowerCase().trim());
      if (matchedId) {
        changed = true;
        const ov = getUserOverrideForGame(updatedGame);
        const cachedBrowse = steamApi.peekCachedBrowseAssets(matchedId);
        if (!cachedBrowse?.capsuleImage) {
          missingSet.add(matchedId);
        }
        const nextCapsule =
          !ov?.capsuleImage &&
          cachedBrowse?.capsuleImage &&
          (!updatedGame.capsuleImage || isMicrosoftStoreCdnUrl(updatedGame.capsuleImage))
            ? cachedBrowse.capsuleImage
            : updatedGame.capsuleImage;
        const nextHeader =
          !ov?.headerImage &&
          cachedBrowse?.headerImage &&
          (!updatedGame.headerImage || isMicrosoftStoreCdnUrl(updatedGame.headerImage))
            ? cachedBrowse.headerImage
            : updatedGame.headerImage;
        updatedGame = {
          ...updatedGame,
          steamAppId: matchedId,
          capsuleImage: nextCapsule,
          headerImage: nextHeader || updatedGame.headerImage,
        };
      }
    }

    if (gogSnapshot.size > 0) {
      const gogPlat = updatedGame.platforms?.find((p) => p.platformId === 'gog');
      if (gogPlat) {
        const coverUrl = gogSnapshot.get(String(gogPlat.platformGameId));
        if (
          coverUrl &&
          (!updatedGame.capsuleImage ||
            updatedGame.capsuleImage.includes('_glx_vertical_cover') ||
            updatedGame.capsuleImage === updatedGame.headerImage)
        ) {
          changed = true;
          updatedGame = { ...updatedGame, capsuleImage: coverUrl };
        }
      }
    }

    return updatedGame;
  });

  return {
    nextGames: changed ? nextGames : prevGames,
    changed,
    missingBrowseAppIds: Array.from(missingSet),
  };
}

function computeBrowseAssetUpgrade(
  currentGames: CanonicalGame[],
  browseMap: Map<number, { capsuleImage?: string; headerImage?: string; iconUrl?: string }>
): { nextGames: CanonicalGame[]; changed: boolean } {
  let browseChanged = false;
  const upgradedGames = currentGames.map((g) => {
    if (!g.steamAppId || g.isExplicitNonSteam) return g;
    const assets = browseMap.get(g.steamAppId);
    if (!assets) return g;
    const ov = getUserOverrideForGame(g);
    const nextCapsule =
      !ov?.capsuleImage &&
      assets.capsuleImage &&
      (!g.capsuleImage || isMicrosoftStoreCdnUrl(g.capsuleImage))
        ? assets.capsuleImage
        : g.capsuleImage;
    const nextHeader =
      !ov?.headerImage &&
      assets.headerImage &&
      (!g.headerImage || isMicrosoftStoreCdnUrl(g.headerImage))
        ? assets.headerImage
        : g.headerImage;
    if (nextCapsule === g.capsuleImage && nextHeader === g.headerImage) {
      return g;
    }
    browseChanged = true;
    return {
      ...g,
      capsuleImage: nextCapsule,
      headerImage: nextHeader || g.headerImage,
    };
  });

  return {
    nextGames: browseChanged ? upgradedGames : currentGames,
    changed: browseChanged,
  };
}

function computeSessionEndedUpdate(
  prevGames: CanonicalGame[],
  detail: GameSessionEndedEventDetail,
  hasStorefrontTotal: boolean,
  addedMinutes: number,
  playedIso: string
): {
  nextGames: CanonicalGame[];
  changed: boolean;
  previousUnlocked: number;
  matchedGameTitle: string;
} {
  const { gameId, platformId, platformGameId, storefrontTotalPlaytimeMinutes } = detail;
  let changed = false;
  let previousUnlocked = 0;
  let matchedGameTitle = '';

  const nextGames = prevGames.map((g) => {
    const isGameMatch =
      g.id === gameId ||
      Boolean(
        platformGameId &&
          g.platforms.some(
            (p) =>
              (!platformId || p.platformId === platformId) &&
              (String(p.platformGameId) === String(platformGameId) ||
                (p.xboxProductId &&
                  String(p.xboxProductId).toUpperCase() ===
                    String(platformGameId).toUpperCase()) ||
                (p.xboxTitleId && String(p.xboxTitleId) === String(platformGameId)))
          )
      );
    if (!isGameMatch) return g;
    changed = true;
    matchedGameTitle = g.title || matchedGameTitle;
    const targetPlatId = platformId || g.platforms[0]?.platformId;
    const hasExactPlatformMatch = g.platforms.some(
      (p) =>
        p.platformId === targetPlatId ||
        Boolean(
          platformGameId &&
            (String(p.platformGameId) === String(platformGameId) ||
              (p.xboxProductId &&
                String(p.xboxProductId).toUpperCase() === String(platformGameId).toUpperCase()))
        )
    );
    const updatedPlatforms = g.platforms.map((p, idx) => {
      const isMatch = hasExactPlatformMatch
        ? p.platformId === targetPlatId ||
          Boolean(
            platformGameId &&
              (String(p.platformGameId) === String(platformGameId) ||
                (p.xboxProductId &&
                  String(p.xboxProductId).toUpperCase() ===
                    String(platformGameId).toUpperCase()))
          )
        : idx === 0;
      if (isMatch) {
        if (p.achievements?.unlocked) {
          previousUnlocked = Math.max(previousUnlocked, p.achievements.unlocked);
        }
        const prevPlaytime = p.playtimeMinutes || 0;
        const authoritativeMinutes = storefrontTotalPlaytimeMinutes ?? 0;
        const nextPlaytime = hasStorefrontTotal
          ? p.platformId === 'xbox'
            ? Math.max(prevPlaytime + addedMinutes, authoritativeMinutes)
            : authoritativeMinutes
          : prevPlaytime + addedMinutes;
        return {
          ...p,
          playtimeMinutes: nextPlaytime,
          lastPlayed: playedIso,
        };
      }
      return p;
    });
    return { ...g, platforms: updatedPlatforms };
  });

  return {
    nextGames: changed ? nextGames : prevGames,
    changed,
    previousUnlocked,
    matchedGameTitle,
  };
}

function computeInstallLifecycleUpdate(
  prevGames: CanonicalGame[],
  detail: GameInstallLifecycleEventDetail,
  defaultInstalled: boolean
): { nextGames: CanonicalGame[]; changed: boolean } {
  const {
    gameId,
    platformId,
    platformGameId,
    xboxProductId,
    packageFamilyName,
    appUserModelId,
    xboxTitleId,
    scid,
    msaAppId,
    version,
    steamAppId,
    installPath,
    executablePath,
    installSize,
    launchArguments,
    isWindowsBinaryOnMac,
  } = detail;

  const nextInstalled =
    typeof detail.installed === 'boolean' ? detail.installed : defaultInstalled;
  const normEventPlatGameId = normalizePlatformGameIdForLookup(platformGameId);
  const normXboxProductId = xboxProductId ? normalizePlatformGameIdForLookup(xboxProductId) : '';
  const normPfn = packageFamilyName ? String(packageFamilyName).trim().toLowerCase() : '';
  const normalizedSteamAppId =
    platformId === 'steam'
      ? Number(steamAppId || normEventPlatGameId) || undefined
      : undefined;

  let changed = false;
  const nextGames = prevGames.map((g) => {
    const isGameMatch =
      (Boolean(gameId) && g.id === gameId) ||
      (normalizedSteamAppId !== undefined && Number(g.steamAppId) === normalizedSteamAppId) ||
      Boolean(
        (normEventPlatGameId || normXboxProductId || normPfn) &&
          g.platforms.some((p) => {
            if (platformId && p.platformId !== platformId) return false;
            const normPId = normalizePlatformGameIdForLookup(p.platformGameId);
            const normStoreId = normalizePlatformGameIdForLookup(p.storefrontAppId);
            const pProdId = p.xboxProductId
              ? normalizePlatformGameIdForLookup(p.xboxProductId)
              : '';
            const pPfn = p.packageFamilyName
              ? String(p.packageFamilyName).trim().toLowerCase()
              : '';
            return (
              (Boolean(normEventPlatGameId) &&
                (normPId === normEventPlatGameId ||
                  normStoreId === normEventPlatGameId ||
                  pProdId === normEventPlatGameId ||
                  pPfn === normEventPlatGameId)) ||
              (Boolean(normXboxProductId) &&
                (pProdId === normXboxProductId || normPId === normXboxProductId)) ||
              (Boolean(normPfn) && (pPfn === normPfn || normPId === normPfn)) ||
              (normalizedSteamAppId !== undefined &&
                p.platformId === 'steam' &&
                normPId === String(normalizedSteamAppId))
            );
          })
      );
    if (!isGameMatch) return g;

    let matchedAny = false;
    let gameChanged = false;
    let updatedPlatforms = g.platforms.map((p, idx) => {
      const normPId = normalizePlatformGameIdForLookup(p.platformGameId);
      const normStoreId = normalizePlatformGameIdForLookup(p.storefrontAppId);
      const pProdId = p.xboxProductId ? normalizePlatformGameIdForLookup(p.xboxProductId) : '';
      const pPfn = p.packageFamilyName ? String(p.packageFamilyName).trim().toLowerCase() : '';
      const isPlatMatch =
        (!platformId && !normEventPlatGameId && !normXboxProductId && !normPfn) ||
        (platformId ? p.platformId === platformId : false) ||
        Boolean(
          normEventPlatGameId &&
            (!platformId || p.platformId === platformId) &&
            (normPId === normEventPlatGameId ||
              normStoreId === normEventPlatGameId ||
              pProdId === normEventPlatGameId ||
              pPfn === normEventPlatGameId)
        ) ||
        Boolean(
          normXboxProductId &&
            (!platformId || p.platformId === platformId) &&
            (pProdId === normXboxProductId || normPId === normXboxProductId)
        ) ||
        Boolean(
          normPfn &&
            (!platformId || p.platformId === platformId) &&
            (pPfn === normPfn || normPId === normPfn)
        ) ||
        (normalizedSteamAppId !== undefined &&
          p.platformId === 'steam' &&
          normPId === String(normalizedSteamAppId)) ||
        (!platformId && g.platforms.length === 1 && idx === 0);

      if (!isPlatMatch) return p;

      matchedAny = true;
      if (!nextInstalled) {
        if (
          p.installed === false &&
          p.installPath === undefined &&
          p.executablePath === undefined &&
          p.installSize === undefined &&
          p.isWindowsBinaryOnMac === undefined &&
          p.launchArguments === undefined
        ) {
          return p;
        }
        gameChanged = true;
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

      const nextInstallPath = installPath !== undefined ? installPath : p.installPath;
      const nextExePath = executablePath !== undefined ? executablePath : p.executablePath;
      const nextSize =
        installSize !== undefined
          ? sanitizeGameInstallSizeBytes(installSize)
          : sanitizeGameInstallSizeBytes(p.installSize);
      const nextVer = version !== undefined ? version : p.version;
      const nextLaunchArgs =
        launchArguments !== undefined ? launchArguments : p.launchArguments;
      const nextWinOnMac =
        isWindowsBinaryOnMac !== undefined ? isWindowsBinaryOnMac : p.isWindowsBinaryOnMac;
      const nextXboxProductId = xboxProductId || p.xboxProductId;
      const nextPackageFamilyName = packageFamilyName || p.packageFamilyName;
      const nextAppUserModelId = appUserModelId || p.appUserModelId;
      const nextXboxTitleId = xboxTitleId || p.xboxTitleId;
      const nextScid = scid || p.scid;
      const nextMsaAppId = msaAppId || p.msaAppId;

      if (
        p.installed === true &&
        p.installPath === nextInstallPath &&
        p.executablePath === nextExePath &&
        p.installSize === nextSize &&
        p.version === nextVer &&
        p.launchArguments === nextLaunchArgs &&
        p.isWindowsBinaryOnMac === nextWinOnMac &&
        p.xboxProductId === nextXboxProductId &&
        p.packageFamilyName === nextPackageFamilyName &&
        p.appUserModelId === nextAppUserModelId &&
        p.xboxTitleId === nextXboxTitleId &&
        p.scid === nextScid &&
        p.msaAppId === nextMsaAppId
      ) {
        return p;
      }

      gameChanged = true;
      const nextPlat = {
        ...p,
        installed: true,
        installPath: nextInstallPath,
        executablePath: nextExePath,
        ...(nextVer !== undefined ? { version: nextVer } : {}),
        ...(nextLaunchArgs !== undefined ? { launchArguments: nextLaunchArgs } : {}),
        ...(nextXboxProductId !== undefined ? { xboxProductId: nextXboxProductId } : {}),
        ...(nextPackageFamilyName !== undefined
          ? { packageFamilyName: nextPackageFamilyName }
          : {}),
        ...(nextAppUserModelId !== undefined ? { appUserModelId: nextAppUserModelId } : {}),
        ...(nextXboxTitleId !== undefined ? { xboxTitleId: nextXboxTitleId } : {}),
        ...(nextScid !== undefined ? { scid: nextScid } : {}),
        ...(nextMsaAppId !== undefined ? { msaAppId: nextMsaAppId } : {}),
        isWindowsBinaryOnMac: nextWinOnMac,
      };
      if (nextSize !== undefined) {
        nextPlat.installSize = nextSize;
      } else {
        delete nextPlat.installSize;
      }
      return nextPlat;
    });

    if (!matchedAny && !platformId && !nextInstalled) {
      updatedPlatforms = updatedPlatforms.map((p) => {
        if (
          p.installed === false &&
          p.installPath === undefined &&
          p.executablePath === undefined &&
          p.installSize === undefined &&
          p.isWindowsBinaryOnMac === undefined &&
          p.launchArguments === undefined
        ) {
          return p;
        }
        gameChanged = true;
        return {
          ...p,
          installed: false,
          installPath: undefined,
          executablePath: undefined,
          installSize: undefined,
          isWindowsBinaryOnMac: undefined,
          launchArguments: undefined,
        };
      });
    }

    if (!gameChanged) return g;
    changed = true;
    return { ...g, platforms: updatedPlatforms };
  });

  return {
    nextGames: changed ? nextGames : prevGames,
    changed,
  };
}

function normalizeAchievementRecordMap(
  raw: unknown
): Record<string, CachedAchievementEntry> | null {
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;
  if ('achievements' in obj && obj.achievements && typeof obj.achievements === 'object') {
    return obj.achievements as Record<string, CachedAchievementEntry>;
  }
  if (!('achievements' in obj)) {
    return obj as Record<string, CachedAchievementEntry>;
  }
  return null;
}

/**
 * Reactively persists newly discovered Steam App IDs, GOG covers, post-session playtime/trophies,
 * and installation/uninstallation events with full unmount timer cleanup and 100% pure state updaters.
 */
export function usePostSessionReconciler({
  gamesRef,
  setGames,
  showSyncNotice,
}: UsePostSessionReconcilerParams): void {
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.addEventListener !== 'function') return;

    const pendingSteamMatches = new Map<string, number>();
    const pendingGogCovers = new Map<string, string>();
    const MAX_RECONCILED_SESSION_IDS = 128;
    const FALLBACK_SESSION_DEDUPE_WINDOW_MS = 60_000;
    const reconciledAchievementsBySessionId = new Set<string>();
    const recentFallbackSessionRefreshAt = new Map<string, number>();
    let batchUpdateTimer: ReturnType<typeof setTimeout> | null = null;
    let persistCatalogTimer: ReturnType<typeof setTimeout> | null = null;
    let latestCatalogForPersist: CanonicalGame[] | null = null;
    const isVitest = isVitestRuntime();

    const recordBoundedSessionKey = (key: string) => {
      reconciledAchievementsBySessionId.add(key);
      while (reconciledAchievementsBySessionId.size > MAX_RECONCILED_SESSION_IDS) {
        const oldest = reconciledAchievementsBySessionId.values().next().value;
        if (oldest === undefined) break;
        reconciledAchievementsBySessionId.delete(oldest);
      }
    };

    const claimPostSessionAchievementRefresh = (
      detail: GameSessionEndedEventDetail
    ): boolean => {
      const explicitSessionId =
        typeof detail.sessionId === 'string' && detail.sessionId.trim()
          ? detail.sessionId.trim()
          : '';
      if (explicitSessionId) {
        if (reconciledAchievementsBySessionId.has(explicitSessionId)) {
          return false;
        }
        recordBoundedSessionKey(explicitSessionId);
        return true;
      }

      // Fallback key when sessionId is omitted (e.g. legacy emitters or unit tests)
      const nowMs = Date.now();
      const targetKey = `${detail.platformId || 'unknown'}:${String(
        detail.gameId || detail.platformGameId || ''
      )
        .trim()
        .toLowerCase()}`;
      const lastPlayedKey =
        typeof detail.lastPlayed === 'string' && detail.lastPlayed.trim()
          ? `${targetKey}:${detail.lastPlayed.trim()}`
          : '';
      if (lastPlayedKey && reconciledAchievementsBySessionId.has(lastPlayedKey)) {
        return false;
      }
      const prevAt = recentFallbackSessionRefreshAt.get(targetKey);
      const isPlaytimeFollowup =
        detail.sessionEvent === 'playtime_synced' ||
        (detail.sessionMinutesPlayed === 0 &&
          typeof detail.storefrontTotalPlaytimeMinutes === 'number' &&
          detail.storefrontTotalPlaytimeMinutes > 0);
      if (
        typeof prevAt === 'number' &&
        nowMs - prevAt < FALLBACK_SESSION_DEDUPE_WINDOW_MS &&
        isPlaytimeFollowup
      ) {
        return false;
      }
      if (lastPlayedKey) {
        recordBoundedSessionKey(lastPlayedKey);
      }
      recentFallbackSessionRefreshAt.set(targetKey, nowMs);
      while (recentFallbackSessionRefreshAt.size > MAX_RECONCILED_SESSION_IDS) {
        const oldestKey = recentFallbackSessionRefreshAt.keys().next().value;
        if (oldestKey === undefined) break;
        recentFallbackSessionRefreshAt.delete(oldestKey);
      }
      return true;
    };

    const readCurrentCatalogSnapshot = (): CanonicalGame[] => {
      if (gamesRef && Array.isArray(gamesRef.current)) {
        return gamesRef.current;
      }
      return loadCurrentCatalog();
    };

    const scheduleCatalogPersistence = (catalog: CanonicalGame[]) => {
      latestCatalogForPersist = catalog;
      if (isVitest) {
        saveCurrentCatalog(catalog, { skipSanitize: true });
        return;
      }
      if (persistCatalogTimer) {
        clearTimeout(persistCatalogTimer);
      }
      persistCatalogTimer = setTimeout(() => {
        persistCatalogTimer = null;
        if (latestCatalogForPersist) {
          saveCurrentCatalog(latestCatalogForPersist, { skipSanitize: true });
        }
      }, 1500);
    };

    const invalidateAndRefreshDetailedAchievements = async (
      targetGame: CanonicalGame | undefined,
      targetStorefront: StorefrontId,
      prevCount: number
    ): Promise<{ handledToast: boolean }> => {
      try {
        const { achievementDetailService } = await import(
          '../services/achievements/achievementDetailService'
        );
        if (!targetGame) {
          achievementDetailService.clearCache();
          return { handledToast: false };
        }

        // Snapshot previously unlocked achievement IDs before invalidating disk/memory cache
        const prevCachedMap = achievementDetailService.peekCachedGameAchievements(targetGame.id);
        const prevDetailedList = prevCachedMap?.[targetStorefront]?.achievements || [];
        const prevUnlockedIds = new Set<string>();
        for (const a of prevDetailedList) {
          if (a.unlocked) {
            if (a.id) prevUnlockedIds.add(a.id);
            if (a.apiName) prevUnlockedIds.add(a.apiName);
          }
        }
        const hadPrevExactList = prevDetailedList.length > 0 && prevCachedMap?.[targetStorefront]?.unlockPrecision !== 'summary_count_only';

        const electronApi = typeof window !== 'undefined' ? window.electronAPI : undefined;
        if (!electronApi?.getStoreAchievements) {
          if (onlineLifecycleManager.isOnline()) {
            await achievementDetailService.invalidateGame(targetGame.id);
          }
          return { handledToast: false };
        }

        // `fetchGameAchievements(targetGame, true)` already bypasses the cache short-circuit
        // and atomically overwrites memory + localStorage + IndexedDB + SQLite on success while
        // preserving the cached snapshot when offline (`F5`).
        const freshMap = await achievementDetailService.fetchGameAchievements(targetGame, true);
        const freshStoreData = freshMap?.[targetStorefront];
        if (!freshStoreData || (freshStoreData.total <= 0 && freshStoreData.unlocked <= 0)) {
          return { handledToast: false };
        }

        const summaryRecord: StoreAchievementSummary = {
          unlocked: freshStoreData.unlocked,
          total: freshStoreData.total,
          percentage: freshStoreData.percentage,
          isMastered: freshStoreData.isMastered,
          ...(freshStoreData.totalXp !== undefined
            ? { xp: { earned: freshStoreData.earnedXp ?? 0, total: freshStoreData.totalXp } }
            : {}),
          ...(freshStoreData.totalGamerscore !== undefined
            ? {
                gamerscore: {
                  earned: freshStoreData.earnedGamerscore ?? 0,
                  total: freshStoreData.totalGamerscore,
                },
              }
            : {}),
          source: freshStoreData.source === 'local_cache' ? 'local_client_cache' : 'live_cloud_api',
          syncedAt: freshStoreData.syncedAt || new Date().toISOString(),
        };

        // Reconcile detailed fresh summary back into catalog + known caches (especially vital for
        // Steam on macOS/CrossOver where local librarycache can be 0 while SSR/VDF has real unlocks)
        const currentGames = readCurrentCatalogSnapshot();
        const platEntry = targetGame.platforms.find((p) => p.platformId === targetStorefront);
        let reconciledGames = currentGames;
        if (targetStorefront === 'steam') {
          const steamAppId =
            targetGame.steamAppId ||
            (platEntry?.platformGameId ? parseInt(platEntry.platformGameId, 10) : 0);
          if (steamAppId > 0) {
            const steamRec: Record<number, StoreAchievementSummary> = { [steamAppId]: summaryRecord };
            cacheUserSteamAchievements(steamRec);
            reconciledGames = reconcileCatalogTrophiesRecords(currentGames, steamRec, {}, {});
          }
        } else if (targetStorefront === 'gog') {
          const gogKey = String(platEntry?.platformGameId || targetGame.id).replace(/^gog[-_]/i, '');
          const gogRec: Record<string, StoreAchievementSummary> = {
            [gogKey]: summaryRecord,
            [`gog-${gogKey}`]: summaryRecord,
            [targetGame.title.toLowerCase().trim()]: summaryRecord,
          };
          cacheUserGogAchievements(gogRec);
          reconciledGames = reconcileCatalogTrophiesRecords(currentGames, {}, gogRec, {});
        } else if (targetStorefront === 'epic') {
          const epicKey = String(platEntry?.platformGameId || targetGame.id).toLowerCase();
          const epicRec: Record<string, StoreAchievementSummary> = {
            [epicKey]: summaryRecord,
            [targetGame.title.toLowerCase().trim()]: summaryRecord,
            ...(platEntry?.namespace ? { [platEntry.namespace.toLowerCase()]: summaryRecord } : {}),
          };
          cacheUserEpicAchievements(epicRec);
          reconciledGames = reconcileCatalogTrophiesRecords(currentGames, {}, {}, epicRec);
        } else if (targetStorefront === 'xbox') {
          const xboxRec: Record<string, StoreAchievementSummary> = {
            [String(platEntry?.platformGameId || targetGame.id)]: summaryRecord,
            [targetGame.title.toLowerCase().trim()]: summaryRecord,
            ...(platEntry?.xboxTitleId ? { [platEntry.xboxTitleId]: summaryRecord } : {}),
            ...(platEntry?.xboxProductId ? { [platEntry.xboxProductId]: summaryRecord } : {}),
          };
          cacheUserXboxAchievements(xboxRec);
          reconciledGames = reconcileCatalogTrophiesRecords(
            currentGames,
            {},
            {},
            {},
            null,
            xboxRec
          );
        }

        if (reconciledGames !== currentGames) {
          if (gamesRef) {
            gamesRef.current = reconciledGames;
            setGames(reconciledGames);
          } else {
            setGames(reconciledGames);
          }
        }

        // Diff exact newly unlocked achievement names
        let newlyUnlocked = hadPrevExactList
          ? freshStoreData.achievements.filter(
              (a) =>
                a.unlocked && !prevUnlockedIds.has(a.id) && !prevUnlockedIds.has(a.apiName)
            )
          : [];

        const unlockDelta = freshStoreData.unlocked - prevCount;
        if (newlyUnlocked.length === 0 && unlockDelta > 0 && freshStoreData.unlockPrecision !== 'summary_count_only') {
          newlyUnlocked = [...freshStoreData.achievements]
            .filter((a) => a.unlocked)
            .sort((a, b) => {
              const tA =
                typeof a.unlockedAt === 'number'
                  ? a.unlockedAt
                  : a.unlockedAt
                    ? Date.parse(a.unlockedAt) || 0
                    : 0;
              const tB =
                typeof b.unlockedAt === 'number'
                  ? b.unlockedAt
                  : b.unlockedAt
                    ? Date.parse(b.unlockedAt) || 0
                    : 0;
              return tB - tA;
            })
            .slice(0, Math.min(unlockDelta, 5));
        }

        if (newlyUnlocked.length > 0 && (unlockDelta > 0 || hadPrevExactList)) {
          const firstTitle = newlyUnlocked[0].name;
          const extraSuffix =
            newlyUnlocked.length > 1 ? ` (+${newlyUnlocked.length - 1} more)` : '';
          showSyncNotice(
            `🏆 Unlocked "${firstTitle}"${extraSuffix} in ${targetGame.title} (${freshStoreData.unlocked}/${freshStoreData.total})`,
            6000
          );
          return { handledToast: true };
        }

        return { handledToast: false };
      } catch {
        return { handledToast: false };
      }
    };

    const flushPendingMediaUpdates = () => {
      batchUpdateTimer = null;
      if (pendingSteamMatches.size === 0 && pendingGogCovers.size === 0) return;
      if (!isVitest && isUserActivelyScrolling()) {
        batchUpdateTimer = setTimeout(flushPendingMediaUpdates, 300);
        return;
      }

      const steamSnapshot = new Map(pendingSteamMatches);
      const gogSnapshot = new Map(pendingGogCovers);
      pendingSteamMatches.clear();
      pendingGogCovers.clear();

      const snapshotGames = readCurrentCatalogSnapshot();
      const computed = computeMediaBatchUpdate(snapshotGames, steamSnapshot, gogSnapshot);

      if (gamesRef) {
        if (computed.changed) {
          gamesRef.current = computed.nextGames;
          setGames(computed.nextGames);
          scheduleCatalogPersistence(computed.nextGames);
        }
      } else {
        setGames((prevGames) => computeMediaBatchUpdate(prevGames, steamSnapshot, gogSnapshot).nextGames);
        if (computed.changed) {
          scheduleCatalogPersistence(computed.nextGames);
        }
      }

      if (computed.missingBrowseAppIds.length > 0) {
        void steamApi
          .fetchStoreBrowseAssetsBatch(
            computed.missingBrowseAppIds,
            RequestPriority.P1_VIEWPORT
          )
          .then((browseMap) => {
            if (!browseMap || browseMap.size === 0) return;
            if (gamesRef) {
              const upgraded = computeBrowseAssetUpgrade(gamesRef.current, browseMap);
              if (upgraded.changed) {
                gamesRef.current = upgraded.nextGames;
                setGames(upgraded.nextGames);
                scheduleCatalogPersistence(upgraded.nextGames);
              }
            } else {
              setGames((currentGames) => computeBrowseAssetUpgrade(currentGames, browseMap).nextGames);
            }
          })
          .catch(() => {});
      }
    };

    const scheduleMediaBatchFlush = () => {
      if (isVitest) {
        flushPendingMediaUpdates();
        return;
      }
      if (!batchUpdateTimer) {
        batchUpdateTimer = setTimeout(flushPendingMediaUpdates, 300);
      }
    };

    const handleSteamMatchUpdated = (event: Event) => {
      const detail = (event as CustomEvent<SteamMatchEventDetail>).detail;
      const title = detail?.title;
      const steamAppId = detail?.steamAppId;
      if (!title || typeof steamAppId !== 'number' || steamAppId <= 0) return;
      pendingSteamMatches.set(title.toLowerCase().trim(), steamAppId);
      scheduleMediaBatchFlush();
    };

    const handleGogCoverUpdated = (event: Event) => {
      const detail = (event as CustomEvent<GogCoverEventDetail>).detail;
      if (!detail?.gogId || !detail.coverUrl) return;
      const cleanGogId = String(detail.gogId).replace(/^gog-/, '');
      pendingGogCovers.set(cleanGogId, detail.coverUrl);
      scheduleMediaBatchFlush();
    };

    const handleGameSessionEnded = (event: Event) => {
      const detail = (event as CustomEvent<GameSessionEndedEventDetail>).detail || {};
      const {
        gameId,
        platformId,
        platformGameId,
        sessionMinutesPlayed,
        lastPlayed,
        storefrontTotalPlaytimeMinutes,
      } = detail;
      if (!gameId && !platformGameId) return;

      const hasStorefrontTotal =
        typeof storefrontTotalPlaytimeMinutes === 'number' && storefrontTotalPlaytimeMinutes > 0;
      const addedMinutes =
        sessionMinutesPlayed === 0 && hasStorefrontTotal
          ? 0
          : Math.max(1, Number(sessionMinutesPlayed) || 1);
      const playedIso = lastPlayed || new Date().toISOString();

      const snapshotBefore = readCurrentCatalogSnapshot();
      const preSessionResult = computeSessionEndedUpdate(
        snapshotBefore,
        detail,
        hasStorefrontTotal,
        addedMinutes,
        playedIso
      );
      const previousUnlocked = preSessionResult.previousUnlocked;
      const matchedGameTitle = preSessionResult.matchedGameTitle;

      if (gamesRef) {
        if (preSessionResult.changed) {
          gamesRef.current = preSessionResult.nextGames;
          setGames(preSessionResult.nextGames);
        }
      } else {
        setGames(
          (prevGames) =>
            computeSessionEndedUpdate(
              prevGames,
              detail,
              hasStorefrontTotal,
              addedMinutes,
              playedIso
            ).nextGames
        );
      }

      if (
        (Number(sessionMinutesPlayed) > 0 || hasStorefrontTotal) &&
        claimPostSessionAchievementRefresh(detail)
      ) {
        const electronApi = typeof window !== 'undefined' ? window.electronAPI : undefined;
        const matchedGame = preSessionResult.nextGames.find(
          (g) =>
            g.id === gameId ||
            Boolean(
              platformGameId &&
                g.platforms.some(
                  (p) =>
                    (!platformId || p.platformId === platformId) &&
                    (String(p.platformGameId) === String(platformGameId) ||
                      (p.xboxProductId &&
                        String(p.xboxProductId).toUpperCase() ===
                          String(platformGameId).toUpperCase()) ||
                      (p.xboxTitleId && String(p.xboxTitleId) === String(platformGameId)))
                )
            )
        );
        const matchedPlatform = matchedGame?.platforms.find(
          (p) =>
            (platformId && p.platformId === platformId) ||
            Boolean(
              platformGameId &&
                (String(p.platformGameId) === String(platformGameId) ||
                  (p.xboxProductId &&
                    String(p.xboxProductId).toUpperCase() ===
                      String(platformGameId).toUpperCase()) ||
                  (p.xboxTitleId && String(p.xboxTitleId) === String(platformGameId)))
            )
        );
        const scopedTitle = matchedGame?.title || matchedGameTitle || undefined;

        if (platformId === 'epic' && electronApi?.fetchEpicAchievements) {
          const resolvedNamespace = matchedPlatform?.namespace?.trim() || undefined;
          const resolvedAppName = String(
            matchedPlatform?.storefrontAppId ||
              matchedPlatform?.platformGameId ||
              platformGameId ||
              ''
          )
            .replace(/^epic[-_]/i, '')
            .trim();
          const resolvedCatalogItemId = matchedPlatform?.catalogItemId?.trim() || undefined;
          const epicScopePayload: Record<string, unknown> = {
            ...(resolvedNamespace
              ? { sandboxId: resolvedNamespace, namespace: resolvedNamespace }
              : {}),
            ...(resolvedAppName ? { appName: resolvedAppName } : {}),
            ...(resolvedCatalogItemId ? { catalogItemId: resolvedCatalogItemId } : {}),
            ...(scopedTitle ? { title: scopedTitle } : {}),
          };
          void (async () => {
            try {
              const res = await electronApi.fetchEpicAchievements!(epicScopePayload);
              const fetchedEpic = normalizeAchievementRecordMap(res);
              if (fetchedEpic && Object.keys(fetchedEpic).length > 0) {
                cacheUserEpicAchievements(fetchedEpic);

                const currentGames = readCurrentCatalogSnapshot();
                const matchesEpicGame = (g: CanonicalGame) =>
                  g.id === gameId ||
                  Boolean(
                    platformGameId &&
                      g.platforms.some(
                        (p) =>
                          p.platformId === 'epic' &&
                          String(p.platformGameId) === String(platformGameId)
                      )
                  );
                const prevTarget = currentGames.find(matchesEpicGame);
                const prevCount = Math.max(
                  previousUnlocked,
                  prevTarget?.platforms.find((p) => p.platformId === 'epic')?.achievements
                    ?.unlocked || 0
                );
                const reconciled = reconcileCatalogTrophiesRecords(
                  currentGames,
                  {},
                  {},
                  fetchedEpic
                );
                if (gamesRef) {
                  gamesRef.current = reconciled;
                  setGames(reconciled);
                } else {
                  setGames((prev) => reconcileCatalogTrophiesRecords(prev, {}, {}, fetchedEpic));
                }
                const nextTarget = reconciled.find(matchesEpicGame);
                const detailOutcome = await invalidateAndRefreshDetailedAchievements(
                  nextTarget || matchedGame,
                  'epic',
                  prevCount
                );
                const nextAch = nextTarget?.platforms.find(
                  (p) => p.platformId === 'epic'
                )?.achievements;
                if (!detailOutcome.handledToast && nextAch && nextAch.unlocked > prevCount) {
                  const gameTitle = nextTarget?.title || matchedGameTitle || 'Game';
                  showSyncNotice(
                    `🏆 Trophy Unlocked! ${gameTitle} now has ${nextAch.unlocked}/${nextAch.total} Epic Trophies`,
                    5000
                  );
                }
              } else if (matchedGame) {
                await invalidateAndRefreshDetailedAchievements(
                  matchedGame,
                  'epic',
                  previousUnlocked
                );
              }
            } catch (err) {
              console.warn('Post-session Epic trophy refresh warning:', err);
            }
          })();
        } else if (platformId === 'xbox' && electronApi?.fetchXboxAchievements) {
          const resolvedXboxTitleId =
            matchedPlatform?.xboxTitleId?.trim() ||
            (platformGameId && /^\d+$/.test(String(platformGameId).trim())
              ? String(platformGameId).trim()
              : undefined);
          const resolvedXboxProductId =
            matchedPlatform?.xboxProductId?.trim() ||
            (matchedPlatform?.platformGameId && !/^\d+$/.test(matchedPlatform.platformGameId)
              ? matchedPlatform.platformGameId.trim()
              : platformGameId && !/^\d+$/.test(String(platformGameId).trim())
                ? String(platformGameId).trim()
                : undefined);
          const resolvedXboxPfn = matchedPlatform?.packageFamilyName?.trim() || undefined;
          const xboxScopePayload: Record<string, unknown> = {
            ...(resolvedXboxTitleId ? { titleId: resolvedXboxTitleId } : {}),
            ...(resolvedXboxProductId ? { productId: resolvedXboxProductId } : {}),
            ...(resolvedXboxPfn ? { pfn: resolvedXboxPfn } : {}),
            ...(scopedTitle ? { title: scopedTitle } : {}),
          };
          void (async () => {
            try {
              const res = await electronApi.fetchXboxAchievements!(xboxScopePayload);
              const fetchedXbox = normalizeAchievementRecordMap(res);
              if (fetchedXbox && Object.keys(fetchedXbox).length > 0) {
                cacheUserXboxAchievements(fetchedXbox);

                const currentGames = readCurrentCatalogSnapshot();
                const matchesXboxGame = (g: CanonicalGame) =>
                  g.id === gameId ||
                  Boolean(
                    platformGameId &&
                      g.platforms.some(
                        (p) =>
                          p.platformId === 'xbox' &&
                          (String(p.platformGameId) === String(platformGameId) ||
                            (p.xboxProductId &&
                              String(p.xboxProductId).toUpperCase() ===
                                String(platformGameId).toUpperCase()) ||
                            (p.xboxTitleId && String(p.xboxTitleId) === String(platformGameId)))
                      )
                  );
                const prevTarget = currentGames.find(matchesXboxGame);
                const prevCount = Math.max(
                  previousUnlocked,
                  prevTarget?.platforms.find((p) => p.platformId === 'xbox')?.achievements
                    ?.unlocked || 0
                );
                const reconciled = reconcileCatalogTrophiesRecords(
                  currentGames,
                  {},
                  {},
                  {},
                  null,
                  fetchedXbox
                );
                if (gamesRef) {
                  gamesRef.current = reconciled;
                  setGames(reconciled);
                } else {
                  setGames((prev) =>
                    reconcileCatalogTrophiesRecords(prev, {}, {}, {}, null, fetchedXbox)
                  );
                }
                const nextTarget = reconciled.find(matchesXboxGame);
                const nextXboxPlat = nextTarget?.platforms.find((p) => p.platformId === 'xbox');
                const detailOutcome = await invalidateAndRefreshDetailedAchievements(
                  nextTarget || matchedGame,
                  'xbox',
                  prevCount
                );
                const nextAch = nextXboxPlat?.achievements;
                if (!detailOutcome.handledToast && nextAch && nextAch.unlocked > prevCount) {
                  const gameTitle = nextTarget?.title || matchedGameTitle || 'Game';
                  const gsText =
                    nextAch.gamerscore && nextAch.gamerscore.total > 0
                      ? ` (${nextAch.gamerscore.earned}/${nextAch.gamerscore.total} G)`
                      : '';
                  showSyncNotice(
                    `🏆 Achievement Unlocked! ${gameTitle} now has ${nextAch.unlocked}/${nextAch.total} Xbox Achievements${gsText}`,
                    5000
                  );
                }
                if (
                  nextTarget &&
                  nextXboxPlat &&
                  electronApi.offlineVault?.queueHydration &&
                  (!nextTarget.enrichedMetadata ||
                    nextTarget.enrichedMetadata.metadataQuality === 'storefront_native')
                ) {
                  electronApi.offlineVault
                    .queueHydration({
                      games: [
                        {
                          gameId: nextTarget.id,
                          title: nextTarget.title,
                          xboxProductId:
                            nextXboxPlat.xboxProductId ?? nextXboxPlat.platformGameId ?? null,
                          packageFamilyName: nextXboxPlat.packageFamilyName ?? null,
                          isInstalled: Boolean(nextTarget.platforms.some((p) => p.installed)),
                        },
                      ],
                    })
                    .catch(() => {});
                }
              } else if (matchedGame) {
                await invalidateAndRefreshDetailedAchievements(
                  matchedGame,
                  'xbox',
                  previousUnlocked
                );
              }
            } catch (err) {
              console.warn('Post-session Xbox achievement refresh warning:', err);
            }
          })();
        } else if (platformId === 'gog' && electronApi?.fetchGogAchievements) {
          const rawGogProductId = String(
            matchedPlatform?.platformGameId || platformGameId || gameId || ''
          )
            .replace(/^gog[-_]/i, '')
            .trim();
          const gogScopePayload: Record<string, unknown> = {
            ...(rawGogProductId ? { productId: rawGogProductId } : {}),
            ...(gameId || matchedGame?.id ? { gameId: gameId || matchedGame?.id } : {}),
            ...(scopedTitle ? { title: scopedTitle } : {}),
          };
          void (async () => {
            try {
              const res = await electronApi.fetchGogAchievements!(gogScopePayload);
              const fetchedGog = normalizeAchievementRecordMap(res);
              if (fetchedGog && Object.keys(fetchedGog).length > 0) {
                cacheUserGogAchievements(fetchedGog);

                const currentGames = readCurrentCatalogSnapshot();
                const matchesGogGame = (g: CanonicalGame) =>
                  g.id === gameId ||
                  Boolean(
                    platformGameId &&
                      g.platforms.some(
                        (p) =>
                          p.platformId === 'gog' &&
                          String(p.platformGameId) === String(platformGameId)
                      )
                  );
                const prevTarget = currentGames.find(matchesGogGame);
                const prevCount = Math.max(
                  previousUnlocked,
                  prevTarget?.platforms.find((p) => p.platformId === 'gog')?.achievements
                    ?.unlocked || 0
                );
                const reconciled = reconcileCatalogTrophiesRecords(
                  currentGames,
                  {},
                  fetchedGog,
                  {}
                );
                if (gamesRef) {
                  gamesRef.current = reconciled;
                  setGames(reconciled);
                } else {
                  setGames((prev) => reconcileCatalogTrophiesRecords(prev, {}, fetchedGog, {}));
                }
                const nextTarget = reconciled.find(matchesGogGame);
                const detailOutcome = await invalidateAndRefreshDetailedAchievements(
                  nextTarget || matchedGame,
                  'gog',
                  prevCount
                );
                const nextAch = nextTarget?.platforms.find(
                  (p) => p.platformId === 'gog'
                )?.achievements;
                if (!detailOutcome.handledToast && nextAch && nextAch.unlocked > prevCount) {
                  const gameTitle = nextTarget?.title || matchedGameTitle || 'Game';
                  showSyncNotice(
                    `🏆 Trophy Unlocked! ${gameTitle} now has ${nextAch.unlocked}/${nextAch.total} GOG Trophies`,
                    5000
                  );
                }
              } else if (matchedGame) {
                await invalidateAndRefreshDetailedAchievements(
                  matchedGame,
                  'gog',
                  previousUnlocked
                );
              }
            } catch (err) {
              console.warn('Post-session GOG trophy refresh warning:', err);
            }
          })();
        } else if (platformId === 'steam') {
          void (async () => {
            try {
              const scannedSteam = await scanLocalSteamAchievements();
              let handledToast = false;
              const currentGames = readCurrentCatalogSnapshot();
              const matchesSteamGame = (g: CanonicalGame) =>
                g.id === gameId ||
                Boolean(
                  platformGameId &&
                    g.platforms.some(
                      (p) =>
                        p.platformId === 'steam' &&
                        String(p.platformGameId) === String(platformGameId)
                    )
                );
              const prevTarget = currentGames.find(matchesSteamGame);
              const prevCount = Math.max(
                previousUnlocked,
                prevTarget?.platforms.find((p) => p.platformId === 'steam')?.achievements
                  ?.unlocked || 0
              );

              if (scannedSteam && Object.keys(scannedSteam).length > 0) {
                cacheUserSteamAchievements(scannedSteam);

                const reconciled = reconcileCatalogTrophiesRecords(
                  currentGames,
                  scannedSteam,
                  {},
                  {}
                );
                if (gamesRef) {
                  gamesRef.current = reconciled;
                  setGames(reconciled);
                } else {
                  setGames((prev) => reconcileCatalogTrophiesRecords(prev, scannedSteam, {}, {}));
                }
                const nextTarget = reconciled.find(matchesSteamGame);
                const detailOutcome = await invalidateAndRefreshDetailedAchievements(
                  nextTarget || matchedGame,
                  'steam',
                  prevCount
                );
                handledToast = detailOutcome.handledToast;
                const nextAch = nextTarget?.platforms.find(
                  (p) => p.platformId === 'steam'
                )?.achievements;
                if (!handledToast && nextAch && nextAch.unlocked > prevCount) {
                  const gameTitle = nextTarget?.title || matchedGameTitle || 'Game';
                  showSyncNotice(
                    `🏆 Trophy Unlocked! ${gameTitle} now has ${nextAch.unlocked}/${nextAch.total} Steam Trophies`,
                    5000
                  );
                }
              } else if (matchedGame) {
                await invalidateAndRefreshDetailedAchievements(
                  matchedGame,
                  'steam',
                  prevCount
                );
              }
            } catch (err) {
              console.warn('Post-session Steam trophy refresh warning:', err);
            }
          })();
        } else if (
          matchedGame &&
          platformId &&
          (platformId === 'epic' || platformId === 'gog' || platformId === 'xbox') &&
          electronApi?.getStoreAchievements
        ) {
          void invalidateAndRefreshDetailedAchievements(
            matchedGame,
            platformId,
            previousUnlocked
          );
        }
      }
    };

    const handleInstallEvent = (detail: GameInstallLifecycleEventDetail, defaultInstalled: boolean) => {
      if (
        !detail.gameId &&
        !detail.platformGameId &&
        !detail.steamAppId &&
        !detail.xboxProductId &&
        !detail.packageFamilyName
      ) {
        return;
      }

      if (gamesRef) {
        const res = computeInstallLifecycleUpdate(gamesRef.current, detail, defaultInstalled);
        if (res.changed) {
          gamesRef.current = res.nextGames;
          setGames(res.nextGames);
        }
      } else {
        setGames(
          (prevGames) => computeInstallLifecycleUpdate(prevGames, detail, defaultInstalled).nextGames
        );
      }
    };

    const handleGameInstalled = (event: Event) => {
      handleInstallEvent((event as CustomEvent<GameInstallLifecycleEventDetail>).detail || {}, true);
    };

    const handleGameUninstalled = (event: Event) => {
      handleInstallEvent((event as CustomEvent<GameInstallLifecycleEventDetail>).detail || {}, false);
    };

    window.addEventListener('antigravity:steam-match-updated', handleSteamMatchUpdated);
    window.addEventListener('antigravity:gog-cover-updated', handleGogCoverUpdated);
    window.addEventListener('antigravity:game-session-ended', handleGameSessionEnded);
    window.addEventListener('antigravity:game-installed', handleGameInstalled);
    window.addEventListener('antigravity:game-uninstalled', handleGameUninstalled);
    return () => {
      if (batchUpdateTimer) {
        clearTimeout(batchUpdateTimer);
        batchUpdateTimer = null;
      }
      if (persistCatalogTimer) {
        clearTimeout(persistCatalogTimer);
        persistCatalogTimer = null;
        if (latestCatalogForPersist) {
          saveCurrentCatalog(latestCatalogForPersist, { skipSanitize: true });
        }
      }
      window.removeEventListener('antigravity:steam-match-updated', handleSteamMatchUpdated);
      window.removeEventListener('antigravity:gog-cover-updated', handleGogCoverUpdated);
      window.removeEventListener('antigravity:game-session-ended', handleGameSessionEnded);
      window.removeEventListener('antigravity:game-installed', handleGameInstalled);
      window.removeEventListener('antigravity:game-uninstalled', handleGameUninstalled);
    };
  }, [gamesRef, setGames, showSyncNotice]);
}
