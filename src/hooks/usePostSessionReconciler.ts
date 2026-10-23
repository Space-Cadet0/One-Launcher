import { useEffect, Dispatch, SetStateAction } from 'react';
import { CanonicalGame } from '../contracts/game';
import { scanLocalSteamAchievements } from '../services/system/localSystemScanner';
import {
  cacheUserSteamAchievements,
  cacheUserGogAchievements,
  cacheUserEpicAchievements,
} from '../services/storage/knownGameAchievements';
import { achievementDetailService } from '../services/achievements/achievementDetailService';
import { saveCurrentCatalog } from '../services/integrations/integrationStorage';
import { reconcileCatalogTrophiesRecords } from '../utils/catalogMergeUtils';
import { SyncNoticeTone } from './useSyncNotice';
import { isUserActivelyScrolling } from '../utils/scrollActivityTracker';

export interface UsePostSessionReconcilerParams {
  setGames: Dispatch<SetStateAction<CanonicalGame[]>>;
  showSyncNotice: (
    message: string | null,
    durationMs?: number | null,
    tone?: SyncNoticeTone
  ) => void;
}

/**
 * Reactively persists newly discovered Steam App IDs, GOG covers, post-session playtime/trophies,
 * and installation/uninstallation events with full unmount timer cleanup.
 */
export function usePostSessionReconciler({
  setGames,
  showSyncNotice,
}: UsePostSessionReconcilerParams): void {
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.addEventListener !== 'function') return;

    const pendingSteamMatches = new Map<string, number>();
    const pendingGogCovers = new Map<string, string>();
    let batchUpdateTimer: ReturnType<typeof setTimeout> | null = null;
    const isVitest = typeof process !== 'undefined' && Boolean((process as any).env?.VITEST);

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

      setGames((prevGames) => {
        let changed = false;
        const nextGames = prevGames.map((g) => {
          let updatedGame = g;

          if (steamSnapshot.size > 0 && !updatedGame.steamAppId && !updatedGame.isExplicitNonSteam) {
            const matchedId = steamSnapshot.get(updatedGame.title.toLowerCase().trim());
            if (matchedId) {
              changed = true;
              updatedGame = { ...updatedGame, steamAppId: matchedId };
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

        if (changed) {
          try {
            saveCurrentCatalog(nextGames, { skipSanitize: true });
          } catch {}
          return nextGames;
        }
        return prevGames;
      });
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

    const handleSteamMatchUpdated = (e: any) => {
      const { title, steamAppId } = e.detail || {};
      if (!title || typeof steamAppId !== 'number' || steamAppId <= 0) return;
      pendingSteamMatches.set(title.toLowerCase().trim(), steamAppId);
      scheduleMediaBatchFlush();
    };

    const handleGogCoverUpdated = (e: any) => {
      const { gogId, coverUrl } = e.detail || {};
      if (!gogId || !coverUrl) return;
      const cleanGogId = String(gogId).replace(/^gog-/, '');
      pendingGogCovers.set(cleanGogId, coverUrl);
      scheduleMediaBatchFlush();
    };

    const handleGameSessionEnded = (e: any) => {
      const detail = e.detail || {};
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

      let previousUnlocked = 0;
      let matchedGameTitle = '';

      setGames((prevGames) => {
        let changed = false;
        const nextGames = prevGames.map((g) => {
          const isGameMatch =
            g.id === gameId ||
            Boolean(
              platformGameId &&
                g.platforms.some(
                  (p) =>
                    (!platformId || p.platformId === platformId) &&
                    String(p.platformGameId) === String(platformGameId)
                )
            );
          if (!isGameMatch) return g;
          changed = true;
          matchedGameTitle = g.title || matchedGameTitle;
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
              if (p.achievements?.unlocked) {
                previousUnlocked = Math.max(previousUnlocked, p.achievements.unlocked);
              }
              return {
                ...p,
                playtimeMinutes: hasStorefrontTotal
                  ? storefrontTotalPlaytimeMinutes
                  : (p.playtimeMinutes || 0) + addedMinutes,
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

      if (Number(sessionMinutesPlayed) > 0 || hasStorefrontTotal) {
        if (
          platformId === 'epic' &&
          typeof window !== 'undefined' &&
          (window as any).electronAPI?.fetchEpicAchievements
        ) {
          (async () => {
            try {
              const res = await (window as any).electronAPI.fetchEpicAchievements({});
              const fetchedEpic =
                res?.achievements ||
                (res && typeof res === 'object' && !('achievements' in res) ? res : null);
              if (fetchedEpic && Object.keys(fetchedEpic).length > 0) {
                cacheUserEpicAchievements(fetchedEpic);
                achievementDetailService.clearCache();
                setGames((currentGames) => {
                  const prevTarget = currentGames.find(
                    (g) =>
                      g.id === gameId ||
                      Boolean(
                        platformGameId &&
                          g.platforms.some(
                            (p) =>
                              p.platformId === 'epic' &&
                              String(p.platformGameId) === String(platformGameId)
                          )
                      )
                  );
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
                  const nextTarget = reconciled.find(
                    (g) =>
                      g.id === gameId ||
                      Boolean(
                        platformGameId &&
                          g.platforms.some(
                            (p) =>
                              p.platformId === 'epic' &&
                              String(p.platformGameId) === String(platformGameId)
                          )
                      )
                  );
                  const nextAch = nextTarget?.platforms.find(
                    (p) => p.platformId === 'epic'
                  )?.achievements;
                  if (nextAch && nextAch.unlocked > prevCount) {
                    const gameTitle = nextTarget?.title || matchedGameTitle || 'Game';
                    showSyncNotice(
                      `🏆 Trophy Unlocked! ${gameTitle} now has ${nextAch.unlocked}/${nextAch.total} Epic Trophies`,
                      5000
                    );
                  }
                  try {
                    saveCurrentCatalog(reconciled);
                  } catch {}
                  return reconciled;
                });
              }
            } catch (err) {
              console.warn('Post-session Epic trophy refresh warning:', err);
            }
          })();
        } else if (
          platformId === 'gog' &&
          typeof window !== 'undefined' &&
          (window as any).electronAPI?.fetchGogAchievements
        ) {
          (async () => {
            try {
              const res = await (window as any).electronAPI.fetchGogAchievements({});
              const fetchedGog =
                res?.achievements ||
                (res && typeof res === 'object' && !('achievements' in res) ? res : null);
              if (fetchedGog && Object.keys(fetchedGog).length > 0) {
                cacheUserGogAchievements(fetchedGog);
                achievementDetailService.clearCache();
                setGames((currentGames) => {
                  const prevTarget = currentGames.find(
                    (g) =>
                      g.id === gameId ||
                      Boolean(
                        platformGameId &&
                          g.platforms.some(
                            (p) =>
                              p.platformId === 'gog' &&
                              String(p.platformGameId) === String(platformGameId)
                          )
                      )
                  );
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
                  const nextTarget = reconciled.find(
                    (g) =>
                      g.id === gameId ||
                      Boolean(
                        platformGameId &&
                          g.platforms.some(
                            (p) =>
                              p.platformId === 'gog' &&
                              String(p.platformGameId) === String(platformGameId)
                          )
                      )
                  );
                  const nextAch = nextTarget?.platforms.find(
                    (p) => p.platformId === 'gog'
                  )?.achievements;
                  if (nextAch && nextAch.unlocked > prevCount) {
                    const gameTitle = nextTarget?.title || matchedGameTitle || 'Game';
                    showSyncNotice(
                      `🏆 Trophy Unlocked! ${gameTitle} now has ${nextAch.unlocked}/${nextAch.total} GOG Trophies`,
                      5000
                    );
                  }
                  try {
                    saveCurrentCatalog(reconciled);
                  } catch {}
                  return reconciled;
                });
              }
            } catch (err) {
              console.warn('Post-session GOG trophy refresh warning:', err);
            }
          })();
        } else if (platformId === 'steam') {
          (async () => {
            try {
              const scannedSteam = await scanLocalSteamAchievements();
              if (scannedSteam && Object.keys(scannedSteam).length > 0) {
                cacheUserSteamAchievements(scannedSteam);
                achievementDetailService.clearCache();
                setGames((currentGames) => {
                  const prevTarget = currentGames.find(
                    (g) =>
                      g.id === gameId ||
                      Boolean(
                        platformGameId &&
                          g.platforms.some(
                            (p) =>
                              p.platformId === 'steam' &&
                              String(p.platformGameId) === String(platformGameId)
                          )
                      )
                  );
                  const prevCount = Math.max(
                    previousUnlocked,
                    prevTarget?.platforms.find((p) => p.platformId === 'steam')?.achievements
                      ?.unlocked || 0
                  );
                  const reconciled = reconcileCatalogTrophiesRecords(
                    currentGames,
                    scannedSteam,
                    {},
                    {}
                  );
                  const nextTarget = reconciled.find(
                    (g) =>
                      g.id === gameId ||
                      Boolean(
                        platformGameId &&
                          g.platforms.some(
                            (p) =>
                              p.platformId === 'steam' &&
                              String(p.platformGameId) === String(platformGameId)
                          )
                      )
                  );
                  const nextAch = nextTarget?.platforms.find(
                    (p) => p.platformId === 'steam'
                  )?.achievements;
                  if (nextAch && nextAch.unlocked > prevCount) {
                    const gameTitle = nextTarget?.title || matchedGameTitle || 'Game';
                    showSyncNotice(
                      `🏆 Trophy Unlocked! ${gameTitle} now has ${nextAch.unlocked}/${nextAch.total} Steam Trophies`,
                      5000
                    );
                  }
                  try {
                    saveCurrentCatalog(reconciled);
                  } catch {}
                  return reconciled;
                });
              }
            } catch (err) {
              console.warn('Post-session Steam trophy refresh warning:', err);
            }
          })();
        }
      }
    };

    const handleGameInstalled = (e: any) => {
      const detail = e.detail || {};
      const {
        gameId,
        platformId,
        platformGameId,
        installed,
        installPath,
        executablePath,
        isWindowsBinaryOnMac,
      } = detail;
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

          let matchedAny = false;
          let gameChanged = false;
          let updatedPlatforms = g.platforms.map((p, idx) => {
            const isPlatMatch =
              !platformId ||
              p.platformId === platformId ||
              (platformGameId && String(p.platformGameId) === String(platformGameId)) ||
              (g.platforms.length === 1 && idx === 0);
            if (isPlatMatch) {
              matchedAny = true;
              if (!installed) {
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
              const nextWinOnMac =
                isWindowsBinaryOnMac !== undefined ? isWindowsBinaryOnMac : p.isWindowsBinaryOnMac;
              if (
                p.installed === true &&
                p.installPath === nextInstallPath &&
                p.executablePath === nextExePath &&
                p.isWindowsBinaryOnMac === nextWinOnMac
              ) {
                return p;
              }
              gameChanged = true;
              return {
                ...p,
                installed: true,
                installPath: nextInstallPath,
                executablePath: nextExePath,
                isWindowsBinaryOnMac: nextWinOnMac,
              };
            }
            return p;
          });
          if (!matchedAny && !platformId && !installed) {
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
      if (batchUpdateTimer) {
        clearTimeout(batchUpdateTimer);
        batchUpdateTimer = null;
      }
      window.removeEventListener('antigravity:steam-match-updated', handleSteamMatchUpdated);
      window.removeEventListener('antigravity:gog-cover-updated', handleGogCoverUpdated);
      window.removeEventListener('antigravity:game-session-ended', handleGameSessionEnded);
      window.removeEventListener('antigravity:game-installed', handleGameInstalled);
    };
  }, [setGames, showSyncNotice]);
}
