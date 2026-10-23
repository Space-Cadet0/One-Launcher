import React, { useState, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { CanonicalGame } from '../../contracts/game';
import { acquireModalOverlayLock, canPortalModalToBody } from '../../utils/modalOverlayLock';
import { StorefrontId, STOREFRONT_REGISTRY } from '../../contracts/platform';
import {
  DiskSpaceInfo,
  DownloadTaskState,
  GameInstallInfo,
} from '../../contracts/launcher';
import { launcherService } from '../../services/launcher/launcherService';
import { StorefrontIcon, getStorefrontDisplayName } from '../Common/StorefrontIcon';
import {
  Download,
  FolderOpen,
  HardDrive,
  X,
  AlertCircle,
  Cpu,
  Info,
  Loader2,
  CheckCircle2,
} from 'lucide-react';

export interface GameInstallModalProps {
  isOpen: boolean;
  game: CanonicalGame;
  initialPlatformId?: StorefrontId;
  onClose: () => void;
  onInstallStarted?: (task?: DownloadTaskState) => void;
}

function formatBytes(bytes?: number): string {
  if (!bytes || bytes <= 0) return 'Unknown';
  const gb = bytes / (1024 * 1024 * 1024);
  if (gb >= 1) {
    return `${gb.toFixed(1)} GB`;
  }
  const mb = bytes / (1024 * 1024);
  return `${Math.max(1, Math.round(mb))} MB`;
}

function formatVersion(v?: string): string {
  if (!v) return '';
  const cleaned = String(v).trim().replace(/^[vV]+/, '');
  return cleaned ? `v${cleaned}` : '';
}

type InstallerItem = NonNullable<GameInstallInfo['availableInstallers']>[number];

function deduplicateInstallers(
  installers?: GameInstallInfo['availableInstallers'],
  winHost = false
): InstallerItem[] {
  if (!installers || installers.length === 0) return [];

  let filtered = installers;
  if (winHost) {
    const winOnly = installers.filter((i) => i.os === 'windows');
    if (winOnly.length > 0) filtered = winOnly;
  } else {
    const nonLinux = installers.filter((i) => i.os !== 'linux');
    if (nonLinux.length > 0) filtered = nonLinux;
  }

  const byGroup = new Map<string, InstallerItem[]>();
  for (const ins of filtered) {
    const groupKey = ins.os;
    const list = byGroup.get(groupKey) || [];
    list.push(ins);
    byGroup.set(groupKey, list);
  }

  const bestPerGroup: InstallerItem[] = [];
  for (const [, candidates] of byGroup.entries()) {
    const sorted = [...candidates].sort((a, b) => {
      const langDiff =
        (/^en/i.test(a.language || '') ? 0 : 1) - (/^en/i.test(b.language || '') ? 0 : 1);
      if (langDiff !== 0) return langDiff;
      return (b.totalSizeBytes || 0) - (a.totalSizeBytes || 0);
    });
    bestPerGroup.push(sorted[0]);
  }

  const getSortRank = (item: InstallerItem): number => {
    if (winHost) {
      if (item.os === 'windows') return 0;
      if (item.os === 'mac') return 1;
      return 2;
    }
    if (item.os === 'mac') return 0;
    if (item.os === 'windows') return 1;
    return 2;
  };

  return bestPerGroup.sort((a, b) => getSortRank(a) - getSortRank(b));
}

let diskSpaceReqSeq = 0;
let diskSpaceDebounceTimer: ReturnType<typeof setTimeout> | null = null;

export const GameInstallModal: React.FC<GameInstallModalProps> = ({
  isOpen,
  game,
  initialPlatformId,
  onClose,
  onInstallStarted,
}) => {
  const [selectedPlatformId, setSelectedPlatformId] = useState<StorefrontId>(() => {
    return (
      initialPlatformId ||
      launcherService.getEffectivePlatformForGame(game)?.platformId ||
      game.platforms[0]?.platformId ||
      'steam'
    );
  });

  const [installInfo, setInstallInfo] = useState<GameInstallInfo | null>(null);
  const [isLoadingInfo, setIsLoadingInfo] = useState<boolean>(false);
  const [installDir, setInstallDir] = useState<string>('');
  const [selectedInstallerId, setSelectedInstallerId] = useState<string | undefined>(undefined);
  const [selectedOs, setSelectedOs] = useState<'mac' | 'windows' | 'linux'>(() =>
    (typeof (launcherService as any).isWindowsHost === 'function' &&
      (launcherService as any).isWindowsHost()) ||
    (typeof window !== 'undefined' && (window as any)?.electronAPI?.platform === 'win32')
      ? 'windows'
      : 'mac'
  );
  const [diskSpace, setDiskSpace] = useState<DiskSpaceInfo | null>(null);
  const [createShortcut, setCreateShortcut] = useState<boolean>(true);
  const [includeDlcs, setIncludeDlcs] = useState<boolean>(
    () => selectedPlatformId === 'epic' || selectedPlatformId === 'gog'
  );
  const [isStarting, setIsStarting] = useState<boolean>(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const compatLayers = isOpen
    ? launcherService.getCompatibilityLayers().filter((l) => l.type !== 'native')
    : [];
  const existingLaunchCfg = isOpen
    ? launcherService.getLaunchConfig(game.id, selectedPlatformId)
    : undefined;
  const [selectedCompatRunner, setSelectedCompatRunner] = useState<string>(() =>
    existingLaunchCfg?.compatibilityLayer && existingLaunchCfg.compatibilityLayer !== 'native'
      ? existingLaunchCfg.compatibilityLayer
      : compatLayers[0]?.type || 'crossover'
  );
  const [selectedBottleName, setSelectedBottleName] = useState<string>(() =>
    existingLaunchCfg?.wineBottleName || ''
  );
  const activeCompatLayer =
    compatLayers.find((l) => l.type === selectedCompatRunner) || compatLayers[0];

  const isWindowsHost =
    (installInfo as any)?.hostPlatform === 'win32' ||
    (typeof (launcherService as any).isWindowsHost === 'function' &&
      (launcherService as any).isWindowsHost()) ||
    (typeof window !== 'undefined' && (window as any)?.electronAPI?.platform === 'win32') ||
    /^[A-Za-z]:\\/.test(installDir || installInfo?.defaultInstallDir || '');

  useEffect(() => {
    if (isOpen) {
      const targetPlat =
        initialPlatformId ||
        launcherService.getEffectivePlatformForGame(game)?.platformId ||
        game.platforms[0]?.platformId ||
        'steam';
      setSelectedPlatformId(targetPlat);
      setIncludeDlcs(targetPlat === 'epic' || targetPlat === 'gog');
      setErrorMsg(null);
    }
  }, [isOpen, game.id, initialPlatformId]);

  useEffect(() => {
    if (!isOpen || isStarting || typeof window === 'undefined' || typeof window.addEventListener !== 'function') {
      return;
    }
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, isStarting, onClose]);

  useEffect(() => {
    if (!isOpen) return;
    let active = true;
    setIsLoadingInfo(true);
    setErrorMsg(null);

    launcherService
      .getGameInstallInfo(game, selectedPlatformId)
      .then((info) => {
        if (!active) return;
        const winHost =
          (info as any)?.hostPlatform === 'win32' ||
          (typeof (launcherService as any).isWindowsHost === 'function' &&
            (launcherService as any).isWindowsHost()) ||
          (typeof window !== 'undefined' && (window as any)?.electronAPI?.platform === 'win32') ||
          /^[A-Za-z]:\\/.test(info.defaultInstallDir || '');

        setInstallInfo(info);
        setInstallDir(
          info.defaultInstallDir || (winHost ? 'C:\\Games\\OneLauncher' : '~/Games/OneLauncher')
        );
        if (diskSpaceDebounceTimer) {
          clearTimeout(diskSpaceDebounceTimer);
          diskSpaceDebounceTimer = null;
        }
        const reqId = ++diskSpaceReqSeq;
        if (info.diskSpace) {
          setDiskSpace(info.diskSpace);
        } else {
          launcherService.getDiskSpace(info.defaultInstallDir).then((ds) => {
            if (active && reqId === diskSpaceReqSeq && ds) setDiskSpace(ds);
          });
        }

        const platCfg = launcherService.getLaunchConfig(game.id, selectedPlatformId);
        if (platCfg?.compatibilityLayer && platCfg.compatibilityLayer !== 'native') {
          setSelectedCompatRunner(platCfg.compatibilityLayer);
        }
        setSelectedBottleName(platCfg?.wineBottleName || '');

        const deduped = deduplicateInstallers(info.availableInstallers, winHost);
        if (deduped.length > 0) {
          const preferredInstaller = winHost
            ? deduped.find((i) => i.os === 'windows')
            : platCfg?.launchMethod === 'compatibility_layer' &&
                deduped.some((i) => i.os === 'windows')
              ? deduped.find((i) => i.os === 'windows')
              : deduped.find((i) => i.os === 'mac');
          const chosen = preferredInstaller || deduped[0];
          setSelectedInstallerId(chosen.id);
          setSelectedOs(winHost ? 'windows' : chosen.os);
        } else {
          setSelectedInstallerId(undefined);
          setSelectedOs(winHost ? 'windows' : 'mac');
        }
      })
      .catch((err) => {
        if (!active) return;
        setErrorMsg(err?.message || 'Could not load installation details.');
      })
      .finally(() => {
        if (active) setIsLoadingInfo(false);
      });

    return () => {
      active = false;
      if (diskSpaceDebounceTimer) {
        clearTimeout(diskSpaceDebounceTimer);
        diskSpaceDebounceTimer = null;
      }
    };
  }, [isOpen, game.id, selectedPlatformId]);

  useEffect(() => {
    if (!isOpen) return;
    return acquireModalOverlayLock();
  }, [isOpen]);

  if (!isOpen) return null;

  const handleDirectoryChange = async (newDir: string, debounce = false) => {
    setInstallDir(newDir);
    if (diskSpaceDebounceTimer) {
      clearTimeout(diskSpaceDebounceTimer);
      diskSpaceDebounceTimer = null;
    }
    const reqId = ++diskSpaceReqSeq;
    const isTestEnv =
      (typeof process !== 'undefined' && process.env?.NODE_ENV === 'test') ||
      (typeof import.meta !== 'undefined' && (import.meta as any).env?.MODE === 'test');
    if (debounce && !isTestEnv) {
      diskSpaceDebounceTimer = setTimeout(async () => {
        const ds = await launcherService.getDiskSpace(newDir);
        if (reqId === diskSpaceReqSeq && ds) {
          setDiskSpace(ds);
        }
      }, 250);
      return;
    }
    const ds = await launcherService.getDiskSpace(newDir);
    if (reqId === diskSpaceReqSeq && ds) {
      setDiskSpace(ds);
    }
  };

  const handleBrowseFolder = async () => {
    const chosen = await launcherService.selectFolder(installDir);
    if (chosen) {
      await handleDirectoryChange(chosen);
    }
  };

  const activePlatformObj =
    game.platforms.find((p) => p.platformId === selectedPlatformId) || game.platforms[0];

  const uniqueInstallers = deduplicateInstallers(installInfo?.availableInstallers, isWindowsHost);
  const hasMacBuildOption = uniqueInstallers.some((i) => i.os === 'mac');
  const macInstaller = uniqueInstallers.find((i) => i.os === 'mac');
  const winInstaller = uniqueInstallers.find((i) => i.os === 'windows');
  const selectedInstaller =
    uniqueInstallers.find((i) => i.id === selectedInstallerId) || uniqueInstallers[0];
  const estimatedSizeBytes =
    selectedInstaller?.totalSizeBytes ||
    installInfo?.estimatedSizeBytes ||
    activePlatformObj?.installSize ||
    0;

  const freeBytes = diskSpace?.freeBytes || 0;
  const totalBytes = diskSpace?.totalBytes || 1;
  const usedBytes = diskSpace?.usedBytes || Math.max(0, totalBytes - freeBytes);
  const usedPercent = Math.min(100, Math.round((usedBytes / totalBytes) * 100));
  const installPercent =
    estimatedSizeBytes > 0
      ? Math.min(100 - usedPercent, Math.max(1, Math.round((estimatedSizeBytes / totalBytes) * 100)))
      : 0;
  const hasEnoughSpace =
    estimatedSizeBytes === 0 || freeBytes === 0 || freeBytes >= estimatedSizeBytes;

  const handleStartInstall = async () => {
    if (isStarting) return;
    setIsStarting(true);
    setErrorMsg(null);

    try {
      if (!isWindowsHost) {
        if (selectedOs === 'windows') {
          await launcherService.saveLaunchConfig(
            {
              ...(existingLaunchCfg || { gameId: game.id, launchMethod: 'compatibility_layer' }),
              gameId: game.id,
              preferredPlatformId: selectedPlatformId,
              launchMethod: 'compatibility_layer',
              compatibilityLayer: (selectedCompatRunner || 'crossover') as any,
              wineBottleName: selectedBottleName.trim() || undefined,
            },
            selectedPlatformId
          );
        } else if (
          selectedOs === 'mac' &&
          (existingLaunchCfg?.launchMethod === 'compatibility_layer' ||
            (game.platforms.length > 1 &&
              existingLaunchCfg?.preferredPlatformId &&
              existingLaunchCfg.preferredPlatformId !== selectedPlatformId))
        ) {
          await launcherService.saveLaunchConfig(
            {
              ...(existingLaunchCfg || { gameId: game.id, launchMethod: 'auto' }),
              gameId: game.id,
              preferredPlatformId: selectedPlatformId,
              launchMethod: 'auto',
              compatibilityLayer: undefined,
            },
            selectedPlatformId
          );
        }
      }

      const res = await launcherService.startInstall({
        gameId: game.id,
        title: game.title,
        platformId: selectedPlatformId,
        platformGameId:
          installInfo?.platformGameId ||
          activePlatformObj?.platformGameId ||
          String(game.steamAppId || game.id),
        steamAppId: game.steamAppId,
        headerImage: game.headerImage,
        installDir:
          installDir.trim() || (isWindowsHost ? 'C:\\Games\\OneLauncher' : '~/Games/OneLauncher'),
        installerId: selectedInstallerId,
        os: isWindowsHost ? 'windows' : selectedOs,
        createShortcut,
        includeDlcs: selectedPlatformId === 'epic' || selectedPlatformId === 'gog' ? includeDlcs : false,
        estimatedSizeBytes: estimatedSizeBytes > 0 ? estimatedSizeBytes : undefined,
        totalBytes: estimatedSizeBytes > 0 ? estimatedSizeBytes : undefined,
        ...(!isWindowsHost && selectedOs === 'windows'
          ? {
              compatibilityLayer: selectedCompatRunner as any,
              wineBottleName: selectedBottleName.trim() || undefined,
            }
          : {}),
      } as any);

      if (res.success) {
        onInstallStarted?.(res.task);
        onClose();
      } else {
        setErrorMsg(res.error || 'Failed to start installation.');
      }
    } catch (err: any) {
      setErrorMsg(err?.message || 'Unexpected error starting installation.');
    } finally {
      setIsStarting(false);
    }
  };

  const getMethodDescription = (platId: StorefrontId) => {
    switch (platId) {
      case 'gog':
        return {
          title: 'Native gogdl CLI + GOG Direct Installer Pipeline',
          desc: isWindowsHost
            ? 'Downloads official DRM-free Windows game files directly from GOG CDN via bundled gogdl with automatic credential bridging.'
            : 'Installs via native gogdl integration with automatic credential bridging from your authenticated GOG session, or downloads and extracts DRM-free offline installer packages (.pkg / .dmg / .exe) directly into your target directory.',
        };
      case 'epic':
        return {
          title: 'Native Legendary CLI / Epic Games Store Pipeline',
          desc: isWindowsHost
            ? 'Downloads and verifies native Windows game files directly from Epic Games CDN via bundled Legendary CLI.'
            : 'Installs directly via native legendary integration with automatic credential bridging from your authenticated Epic session (or Heroic / Epic Games Launcher fallback) while monitoring real-time manifest progress.',
        };
      case 'steam':
        if (!isWindowsHost && selectedOs === 'windows') {
          return {
            title: 'CrossOver Windows Steam Bottle + Live ACF Progress Monitor',
            desc: 'Installs the Windows build inside your CrossOver bottle via Windows Steam (automatically bootstrapping Windows Steam if needed) and tracks real-time download progress via appmanifest_*.acf.',
          };
        }
        return {
          title: 'Steam Client Protocol + Live ACF Progress Monitor',
          desc: isWindowsHost
            ? 'Triggers Steam Client installation (steam://install/) and monitors real-time download progress via steamapps/appmanifest_*.acf.'
            : 'Triggers native Steam installation (`steam://install`) and tracks real-time `BytesDownloaded` / `BytesToDownload` directly from local `appmanifest_*.acf` files.',
        };
      default:
        return {
          title: 'Universal Game Installer',
          desc: 'Downloads and configures game files in your selected installation directory.',
        };
    }
  };

  const methodInfo = getMethodDescription(selectedPlatformId);

  const modalContent = (
    <div
      className="fixed inset-0 z-[100] isolate flex items-center justify-center p-4 select-none overflow-hidden overscroll-contain"
      onClick={onClose}
    >
      <div
        aria-hidden="true"
        className="fixed inset-0 bg-[#060a10]/95 pointer-events-none"
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-label={`Install ${game.title}`}
        className="relative z-10 w-full max-w-xl rounded-xl bg-[#131b26] border border-[#2a475e] shadow-2xl overflow-hidden text-steam-text"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Top Game Banner Header */}
        <div className="relative h-36 w-full bg-[#0b1017] overflow-hidden">
          {game.headerImage && (
            <img
              src={game.headerImage}
              alt={game.title}
              className="w-full h-full object-cover opacity-55"
            />
          )}
          <div className="absolute inset-0 bg-gradient-to-t from-[#131b26] via-[#131b26]/60 to-transparent" />

          <button
            type="button"
            onClick={onClose}
            className="absolute top-3 right-3 p-1.5 rounded-lg bg-black/60 hover:bg-black/80 text-steam-subtext hover:text-white border border-white/10 transition-colors cursor-pointer"
            aria-label="Close install modal"
          >
            <X className="w-4 h-4" />
          </button>

          <div className="absolute bottom-3 left-5 right-5 flex items-end justify-between gap-3">
            <div className="min-w-0">
              <div className="flex items-center gap-2 text-[11px] font-bold uppercase tracking-wider text-sky-400">
                <Download className="w-3.5 h-3.5" />
                <span>Install Game</span>
              </div>
              <h2 className="text-xl font-extrabold text-white truncate drop-shadow">
                {game.title}
              </h2>
            </div>

            {/* Single Storefront Badge if owned on 1 platform */}
            {game.platforms.length <= 1 && (
              <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-black/70 border border-white/15 text-xs font-semibold text-white shrink-0">
                <StorefrontIcon storefrontId={selectedPlatformId} className="w-3.5 h-3.5 text-sky-400" />
                <span>{getStorefrontDisplayName(selectedPlatformId)}</span>
              </div>
            )}
          </div>
        </div>

        {/* Modal Body */}
        <div className="p-5 space-y-5 max-h-[75vh] overflow-y-auto overscroll-contain bg-[#131b26] modal-scroll-body">
          {/* Storefront Selector if owned on > 1 platform */}
          {game.platforms.length > 1 && (
            <div className="space-y-1.5">
              <label className="block text-[11px] font-bold uppercase tracking-wider text-steam-subtext">
                Select Storefront Source ({game.platforms.length} Owned)
              </label>
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                {game.platforms.map((plat) => {
                  const isSelected = plat.platformId === selectedPlatformId;
                  const reg = STOREFRONT_REGISTRY[plat.platformId];
                  return (
                    <button
                      key={plat.platformId}
                      type="button"
                      onClick={() => {
                        setSelectedPlatformId(plat.platformId);
                        setIncludeDlcs(plat.platformId === 'epic' || plat.platformId === 'gog');
                        setErrorMsg(null);
                      }}
                      className={`flex items-center gap-2 px-3 py-2 rounded-lg border text-xs font-semibold transition-colors cursor-pointer ${
                        isSelected
                          ? 'bg-sky-500/20 border-sky-400 text-white shadow-[0_0_12px_rgba(56,189,248,0.25)]'
                          : 'bg-[#17212e] border-[#26384d] text-steam-subtext hover:text-white hover:bg-[#1d2a3a]'
                      }`}
                    >
                      <StorefrontIcon
                        storefrontId={plat.platformId}
                        className={`w-4 h-4 ${isSelected ? 'text-sky-400' : 'text-steam-subtext'}`}
                      />
                      <span className="truncate">
                        {reg?.name || getStorefrontDisplayName(plat.platformId)}
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          {/* Available Installer / OS Selector (hidden on Windows host since Windows builds are always native) */}
          {!isWindowsHost && (
            <div className="space-y-1.5">
              <label className="block text-[11px] font-bold uppercase tracking-wider text-steam-subtext">
                Platform & Installer Build
              </label>
              {isLoadingInfo ? (
                <div className="flex items-center gap-2 text-xs text-steam-subtext bg-[#17212e] border border-[#26384d] rounded-lg px-3.5 py-2.5">
                  <Loader2 className="w-4 h-4 animate-spin text-sky-400" />
                  <span>Querying {getStorefrontDisplayName(selectedPlatformId)} build manifest...</span>
                </div>
              ) : uniqueInstallers.length === 1 ? (
                <div className="space-y-2">
                  {selectedOs === 'mac' ? (
                    <div className="rounded-lg bg-emerald-950/40 border border-emerald-500/40 p-3 space-y-1">
                      <div className="flex items-center gap-1.5 text-[11px] font-extrabold uppercase tracking-wider text-emerald-400">
                        <CheckCircle2 className="w-3.5 h-3.5 shrink-0" />
                        <span>★ AUTO-DETECTED • NATIVE MACOS BUILD</span>
                      </div>
                      <p className="text-xs text-emerald-100/90 leading-relaxed">
                        {`Official macOS build${formatVersion(selectedInstaller?.version) ? ` (${formatVersion(selectedInstaller?.version)})` : ''}${selectedInstaller?.totalSizeBytes ? ` • ${formatBytes(selectedInstaller.totalSizeBytes)}` : ''} — runs natively on your Mac without translation layers.`}
                      </p>
                    </div>
                  ) : selectedOs === 'windows' ? (
                    <div className="rounded-lg bg-amber-950/50 border border-amber-500/40 p-3 space-y-1">
                      <div className="flex items-center gap-1.5 text-[11px] font-extrabold uppercase tracking-wider text-amber-400">
                        <Cpu className="w-3.5 h-3.5 shrink-0" />
                        <span>AUTO-DETECTED • WINDOWS BUILD (CROSSOVER / WINE)</span>
                      </div>
                      <p className="text-xs text-amber-100/90 leading-relaxed">
                        {`No native macOS build exists for this game on ${getStorefrontDisplayName(selectedPlatformId)}. One Launcher will automatically install the Windows build${formatVersion(selectedInstaller?.version) ? ` (${formatVersion(selectedInstaller?.version)})` : ''}${selectedInstaller?.totalSizeBytes ? ` • ${formatBytes(selectedInstaller.totalSizeBytes)}` : ''} and run it via CrossOver / Wine.`}
                      </p>
                    </div>
                  ) : (
                    <div className="rounded-lg bg-sky-950/40 border border-sky-500/40 p-3 space-y-1">
                      <div className="flex items-center gap-1.5 text-[11px] font-extrabold uppercase tracking-wider text-sky-400">
                        <CheckCircle2 className="w-3.5 h-3.5 shrink-0" />
                        <span>AUTO-DETECTED • LINUX BUILD</span>
                      </div>
                      <p className="text-xs text-sky-100/90 leading-relaxed">
                        {`Linux build${formatVersion(selectedInstaller?.version) ? ` (${formatVersion(selectedInstaller?.version)})` : ''}${selectedInstaller?.totalSizeBytes ? ` • ${formatBytes(selectedInstaller.totalSizeBytes)}` : ''}.`}
                      </p>
                    </div>
                  )}
                </div>
              ) : uniqueInstallers.length > 1 ? (
                <div className="space-y-2.5">
                  {macInstaller && winInstaller && (
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
                      <button
                        type="button"
                        data-testid="install-option-mac-native"
                        aria-pressed={selectedOs === 'mac'}
                        onClick={() => {
                          setSelectedInstallerId(macInstaller.id);
                          setSelectedOs('mac');
                        }}
                        className={`text-left rounded-lg p-3 border transition-colors cursor-pointer space-y-1.5 ${
                          selectedOs === 'mac'
                            ? 'bg-emerald-950/50 border-emerald-400 shadow-[0_0_14px_rgba(16,185,129,0.22)]'
                            : 'bg-[#17212e] border-[#26384d] hover:border-emerald-500/40 hover:bg-[#1b2736]'
                        }`}
                      >
                        <div className="flex items-center justify-between gap-1.5">
                          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-emerald-500/20 border border-emerald-500/40 text-[10px] font-extrabold uppercase tracking-wider text-emerald-300">
                            <CheckCircle2 className="w-3 h-3 text-emerald-400 shrink-0" />
                            <span>★ Recommended • Native macOS</span>
                          </span>
                        </div>
                        <div className="text-xs font-bold text-white">Native macOS Build</div>
                        <p className="text-[11px] text-steam-subtext leading-relaxed">
                          Official macOS build — runs natively on your Mac without translation layers.
                          {formatVersion(macInstaller.version)
                            ? ` (${formatVersion(macInstaller.version)})`
                            : ''}
                          {macInstaller.totalSizeBytes
                            ? ` • ${formatBytes(macInstaller.totalSizeBytes)}`
                            : ''}
                        </p>
                      </button>

                      <button
                        type="button"
                        data-testid="install-option-win-compat"
                        aria-pressed={selectedOs === 'windows'}
                        onClick={() => {
                          setSelectedInstallerId(winInstaller.id);
                          setSelectedOs('windows');
                        }}
                        className={`text-left rounded-lg p-3 border transition-colors cursor-pointer space-y-1.5 ${
                          selectedOs === 'windows'
                            ? 'bg-amber-950/50 border-amber-400 shadow-[0_0_14px_rgba(245,158,11,0.22)]'
                            : 'bg-[#17212e] border-[#26384d] hover:border-amber-500/40 hover:bg-[#1b2736]'
                        }`}
                      >
                        <div className="flex items-center justify-between gap-1.5">
                          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-amber-500/20 border border-amber-500/40 text-[10px] font-extrabold uppercase tracking-wider text-amber-300">
                            <Cpu className="w-3 h-3 text-amber-400 shrink-0" />
                            <span>Compatibility / Translation Layer</span>
                          </span>
                        </div>
                        <div className="text-xs font-bold text-white">
                          Windows Build (CrossOver / Wine)
                        </div>
                        <p className="text-[11px] text-steam-subtext leading-relaxed">
                          Installs the Windows build and runs via CrossOver, GPTK, or Wine translation.
                          {formatVersion(winInstaller.version)
                            ? ` (${formatVersion(winInstaller.version)})`
                            : ''}
                          {winInstaller.totalSizeBytes
                            ? ` • ${formatBytes(winInstaller.totalSizeBytes)}`
                            : ''}
                        </p>
                      </button>
                    </div>
                  )}
                  {!(macInstaller && winInstaller && uniqueInstallers.length <= 2) && (
                    <select
                      aria-label="Installer Build"
                      value={selectedInstallerId || ''}
                      onChange={(e) => {
                        const id = e.target.value;
                        setSelectedInstallerId(id);
                        const found = uniqueInstallers.find((i) => i.id === id);
                        if (found) setSelectedOs(found.os);
                      }}
                      className="w-full rounded-lg bg-[#17212e] border border-[#2a475e] px-3 py-2 text-xs text-white focus:outline-none focus:border-sky-400"
                    >
                      {uniqueInstallers.map((ins) => {
                        const ver = formatVersion(ins.version);
                        const sizeSuffix = ins.totalSizeBytes ? ` • ${formatBytes(ins.totalSizeBytes)}` : '';
                        const verSuffix = ver ? ` (${ver})` : '';
                        let optionLabel: string;
                        if (ins.os === 'mac') {
                          optionLabel = `★ Recommended: Native macOS Build${verSuffix}${sizeSuffix}`;
                        } else if (ins.os === 'windows') {
                          optionLabel = `${hasMacBuildOption ? 'Alternative: ' : ''}Windows Build via CrossOver / Wine${verSuffix}${sizeSuffix}`;
                        } else {
                          optionLabel = `Linux Build${verSuffix}${sizeSuffix}`;
                        }
                        return (
                          <option key={ins.id} value={ins.id}>
                            {optionLabel}
                          </option>
                        );
                      })}
                    </select>
                  )}
                  {selectedOs === 'mac' && (
                    <div className="flex items-start gap-2 text-[11px] text-emerald-300 bg-emerald-950/40 border border-emerald-500/40 rounded-lg px-3 py-2 leading-relaxed">
                      <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400 shrink-0 mt-0.5" />
                      <span>
                        ✓ Recommended: Official macOS build is available and auto-selected. Only choose the Windows (CrossOver / Wine) alternative if this game is an older 32-bit Mac port that won&apos;t launch on Apple Silicon.
                      </span>
                    </div>
                  )}
                  {selectedOs === 'windows' && (
                    <div className="flex items-start gap-2 text-[11px] text-amber-300 bg-amber-950/50 border border-amber-500/40 rounded-lg px-3 py-2 leading-relaxed">
                      <Cpu className="w-3.5 h-3.5 text-amber-400 shrink-0 mt-0.5" />
                      <span>
                        {hasMacBuildOption
                          ? 'Windows Compatibility Mode selected: Will install the Windows x64 build and run it through CrossOver / Wine instead of the native macOS build.'
                          : `No native macOS build exists for this game on ${getStorefrontDisplayName(selectedPlatformId)}. One Launcher will install the Windows build and run it via CrossOver / Wine.`}
                      </span>
                    </div>
                  )}
                </div>
              ) : (
                <div className="grid grid-cols-2 gap-2">
                  <button
                    type="button"
                    onClick={() => setSelectedOs('mac')}
                    className={`flex items-center justify-center gap-2 px-3 py-2 rounded-lg border text-xs font-semibold transition-colors cursor-pointer ${
                      selectedOs === 'mac'
                        ? 'bg-sky-500/20 border-sky-400 text-white'
                        : 'bg-[#17212e] border-[#26384d] text-steam-subtext hover:text-white'
                    }`}
                  >
                    <span>macOS / Auto-Detect</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => setSelectedOs('windows')}
                    className={`flex items-center justify-center gap-2 px-3 py-2 rounded-lg border text-xs font-semibold transition-colors cursor-pointer ${
                      selectedOs === 'windows'
                        ? 'bg-amber-500/20 border-amber-400 text-amber-200'
                        : 'bg-[#17212e] border-[#26384d] text-steam-subtext hover:text-white'
                    }`}
                  >
                    <Cpu className="w-3.5 h-3.5" />
                    <span>Windows (via CrossOver / Wine)</span>
                  </button>
                </div>
              )}
            </div>
          )}

          {/* Pre-Install Compatibility Runner & Bottle Selector (shown only on macOS when installing a Windows build) */}
          {!isWindowsHost && selectedOs === 'windows' && compatLayers.length > 0 && (
            <div
              data-testid="preinstall-compat-config"
              className="rounded-lg bg-[#0e151f] border border-[#223447] p-3.5 space-y-2.5"
            >
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-1.5">
                  <Cpu className="w-3.5 h-3.5 text-amber-400" />
                  <span className="text-[11px] font-bold uppercase tracking-wider text-white">
                    Compatibility Runner &amp; Target Bottle
                  </span>
                </div>
                <span className="text-[10px] text-steam-subtext">
                  Saved to game launch profile
                </span>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
                <div className="space-y-1">
                  <label className="block text-[10px] font-bold uppercase tracking-wider text-steam-subtext">
                    Compatibility Runner
                  </label>
                  <select
                    data-testid="preinstall-compat-runner"
                    aria-label="Compatibility Runner"
                    value={selectedCompatRunner}
                    onChange={(e) => setSelectedCompatRunner(e.target.value)}
                    className="w-full rounded-lg bg-[#141d2b] border border-[#2a475e] px-2.5 py-1.5 text-xs text-white focus:outline-none focus:border-sky-400"
                  >
                    {compatLayers.map((layer) => (
                      <option key={layer.type} value={layer.type}>
                        {layer.name}
                        {layer.version ? ` (v${layer.version})` : ''}
                      </option>
                    ))}
                  </select>
                </div>

                <div className="space-y-1">
                  <label className="block text-[10px] font-bold uppercase tracking-wider text-steam-subtext">
                    Target Bottle
                  </label>
                  <select
                    data-testid="preinstall-compat-bottle"
                    aria-label="Target Bottle"
                    value={selectedBottleName}
                    onChange={(e) => setSelectedBottleName(e.target.value)}
                    className="w-full rounded-lg bg-[#141d2b] border border-[#2a475e] px-2.5 py-1.5 text-xs text-white focus:outline-none focus:border-sky-400"
                  >
                    <option value="">
                      Default Bottle ({activeCompatLayer?.availableBottles?.[0] || 'OneLauncher'})
                    </option>
                    {(activeCompatLayer?.availableBottles || []).map((bottle) => (
                      <option key={bottle} value={bottle}>
                        {bottle}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
            </div>
          )}

          {/* Target Installation Directory */}
          {selectedPlatformId === 'steam' ? (
            (() => {
              const effectiveSteamDisplayPath = (() => {
                if (!isWindowsHost && selectedOs === 'windows') {
                  const isCrossOverLayer =
                    !activeCompatLayer ||
                    activeCompatLayer.type === 'crossover' ||
                    activeCompatLayer.type === 'crossover_preview' ||
                    Boolean(selectedBottleName);
                  if (isCrossOverLayer) {
                    const bottlesRoot = (
                      activeCompatLayer?.bottlesDir ||
                      '~/Library/Application Support/CrossOver/Bottles'
                    ).replace(/\/+$/, '');
                    const bottleName =
                      selectedBottleName || activeCompatLayer?.availableBottles?.[0] || 'Steam';
                    return `${bottlesRoot}/${bottleName}/drive_c/Program Files (x86)/Steam/steamapps/common`;
                  }
                  const prefixRoot = (
                    (activeCompatLayer as any)?.prefixPath ||
                    existingLaunchCfg?.winePrefixPath ||
                    '~/Games/OneLauncher/Prefixes/default'
                  ).replace(/\/+$/, '');
                  return `${prefixRoot}/drive_c/Program Files (x86)/Steam/steamapps/common`;
                }

                if (!isWindowsHost) {
                  const nativeCandidates = [
                    ...(installInfo?.availableInstallDirs || []),
                    installInfo?.defaultInstallDir,
                    installDir,
                  ].filter(
                    (d): d is string =>
                      typeof d === 'string' &&
                      d.length > 0 &&
                      !/\/Bottles\//i.test(d) &&
                      !/\/drive_c\//i.test(d)
                  );
                  return (
                    nativeCandidates[0] || '~/Library/Application Support/Steam/steamapps/common'
                  );
                }

                return (
                  installDir ||
                  installInfo?.defaultInstallDir ||
                  installInfo?.availableInstallDirs?.[0] ||
                  'C:\\Program Files (x86)\\Steam\\steamapps\\common'
                );
              })();

              return (
                <div
                  data-testid="steam-managed-install-location"
                  className="rounded-lg bg-[#0e151f] border border-[#223447] p-3.5 space-y-2"
                >
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex items-center gap-1.5">
                      <FolderOpen className="w-3.5 h-3.5 text-sky-400 shrink-0" />
                      <span className="text-[11px] font-bold uppercase tracking-wider text-white">
                        Steam Library Location
                      </span>
                    </div>
                    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-sky-500/15 border border-sky-500/30 text-[10px] font-bold uppercase tracking-wider text-sky-300">
                      Managed by Steam Client (steamapps/common)
                    </span>
                  </div>

                  <div
                    data-testid="steam-library-location-display"
                    className="min-w-0 max-w-full overflow-hidden rounded-lg border border-white/10 bg-[#141821] px-3 py-2.5 space-y-1"
                  >
                    <code
                      title={effectiveSteamDisplayPath}
                      className="truncate block text-xs font-mono text-gray-200"
                    >
                      {effectiveSteamDisplayPath}
                    </code>
                    <div className="text-[10px] text-steam-subtext truncate">
                      {!isWindowsHost && selectedOs === 'windows'
                        ? `CrossOver / Wine Bottle Steam Library (${
                            selectedBottleName ||
                            activeCompatLayer?.availableBottles?.[0] ||
                            'Steam'
                          })`
                        : 'Native Steam Library'}
                    </div>
                  </div>

                  <p className="text-[11px] text-steam-subtext leading-relaxed">
                    Steam manages the installation folder for Steam games. You will select or confirm your target Steam Library drive inside the Steam installation dialog when it opens.
                  </p>
                </div>
              );
            })()
          ) : (
            <div className="space-y-1.5">
              <div className="flex items-center justify-between">
                <label className="block text-[11px] font-bold uppercase tracking-wider text-steam-subtext">
                  Installation Directory
                </label>
                {installInfo?.availableInstallDirs && installInfo.availableInstallDirs.length > 1 && (
                  <select
                    value={
                      installInfo.availableInstallDirs
                        .filter((dir) => isWindowsHost || selectedOs !== 'windows' || dir !== '/Applications')
                        .includes(installDir)
                        ? installDir
                        : ''
                    }
                    onChange={(e) => {
                      if (e.target.value) handleDirectoryChange(e.target.value);
                    }}
                    className="text-[11px] bg-[#17212e] border border-[#2a475e] rounded px-2 py-0.5 text-sky-300 focus:outline-none"
                  >
                    <option value="" disabled>
                      Preset Locations...
                    </option>
                    {installInfo.availableInstallDirs
                      .filter((dir) => isWindowsHost || selectedOs !== 'windows' || dir !== '/Applications')
                      .map((dir) => (
                        <option key={dir} value={dir}>
                          {dir}
                        </option>
                      ))}
                  </select>
                )}
              </div>

              <div className="flex items-center gap-2">
                <input
                  type="text"
                  value={installDir}
                  onChange={(e) => handleDirectoryChange(e.target.value, true)}
                  placeholder="~/Games/OneLauncher"
                  className="flex-1 rounded-lg bg-[#0e151f] border border-[#2a475e] px-3 py-2 text-xs text-white font-mono focus:outline-none focus:border-sky-400"
                />
                <button
                  type="button"
                  onClick={handleBrowseFolder}
                  className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg bg-[#1b2838] hover:bg-[#25374d] border border-[#2a475e] text-xs font-semibold text-sky-300 hover:text-white transition-colors cursor-pointer shrink-0"
                >
                  <FolderOpen className="w-3.5 h-3.5" />
                  <span>Browse...</span>
                </button>
              </div>
            </div>
          )}

          {/* Live Disk Space Indicator Bar */}
          <div className="rounded-lg bg-[#0e151f] border border-[#223447] p-3.5 space-y-2">
            <div className="flex items-center justify-between text-xs">
              <div className="flex items-center gap-1.5 text-steam-subtext font-medium">
                <HardDrive className="w-3.5 h-3.5 text-sky-400" />
                <span>Disk Space</span>
              </div>
              <div className="flex items-center gap-3">
                <span className="text-steam-subtext">
                  Estimated Size:{' '}
                  <strong className="text-white">
                    {estimatedSizeBytes > 0 ? formatBytes(estimatedSizeBytes) : 'Store Managed'}
                  </strong>
                </span>
                <span className="text-steam-subtext">
                  Free Space:{' '}
                  <strong className={hasEnoughSpace ? 'text-emerald-400' : 'text-red-400'}>
                    {diskSpace ? formatBytes(diskSpace.freeBytes) : 'Checking...'}
                  </strong>
                </span>
              </div>
            </div>

            {/* Storage Progress Bar */}
            <div className="w-full h-2 rounded-full bg-[#1b2838] overflow-hidden flex">
              <div
                className="h-full bg-slate-600"
                style={{ width: `${usedPercent}%` }}
                title={`Used Space: ${usedPercent}%`}
              />
              {installPercent > 0 && (
                <div
                  className={`h-full ${
                    hasEnoughSpace ? 'bg-sky-400' : 'bg-red-500'
                  }`}
                  style={{ width: `${installPercent}%` }}
                  title={`Required for Install: ${formatBytes(estimatedSizeBytes)}`}
                />
              )}
            </div>

            {!hasEnoughSpace && (
              <div className="flex items-center gap-1.5 text-[11px] text-red-400 pt-0.5">
                <AlertCircle className="w-3.5 h-3.5 shrink-0" />
                <span>Insufficient disk space on target volume for this installation.</span>
              </div>
            )}
            {(selectedPlatformId === 'epic' || selectedPlatformId === 'gog') && includeDlcs && (
              <div
                data-testid="dlc-disk-space-note"
                className="flex items-center gap-1.5 text-[11px] text-steam-subtext pt-0.5"
              >
                <Info className="w-3.5 h-3.5 text-sky-400 shrink-0" />
                <span>
                  Base game size shown above; total required disk space may increase when owned DLCs &amp; expansions are included.
                </span>
              </div>
            )}
          </div>

          {/* Installation Method Notice */}
          <div className="rounded-lg bg-[#162231]/90 border border-[#2a475e]/70 p-3 flex items-start gap-2.5 text-xs">
            <Info className="w-4 h-4 text-sky-400 shrink-0 mt-0.5" />
            <div className="space-y-0.5">
              <div className="font-semibold text-white flex items-center gap-1.5">
                <span>{methodInfo.title}</span>
                {selectedPlatformId === 'gog' && (
                  <span className="text-[10px] px-1.5 py-0.2 rounded bg-emerald-500/20 text-emerald-300 border border-emerald-500/40 font-bold">
                    DRM-Free Direct
                  </span>
                )}
              </div>
              <p className="text-[11px] text-steam-subtext leading-relaxed">{methodInfo.desc}</p>
            </div>
          </div>

          {/* Owned DLCs & Expansions Toggle (GOG & Epic) */}
          {(selectedPlatformId === 'gog' || selectedPlatformId === 'epic') && (
            <label className="flex items-start gap-2.5 rounded-lg bg-[#0e151f] border border-[#223447] p-3 text-xs text-steam-text cursor-pointer hover:border-[#2a475e] transition-colors">
              <input
                type="checkbox"
                data-testid="toggle-include-dlcs"
                checked={includeDlcs}
                aria-checked={includeDlcs}
                onChange={(e) =>
                  setIncludeDlcs(
                    typeof e?.target?.checked === 'boolean' ? e.target.checked : !includeDlcs
                  )
                }
                className="mt-0.5 rounded border-steam-border bg-[#0e151f] text-sky-500 focus:ring-0"
              />
              <div className="space-y-0.5 min-w-0">
                <div className="font-semibold text-white">Include Owned DLCs &amp; Expansions</div>
                <div className="text-[11px] text-steam-subtext leading-snug">
                  Downloads owned expansions, season pass content, and bonus DLC depots alongside the base game
                </div>
              </div>
            </label>
          )}

          {/* Options Checkbox */}
          <label className="flex items-center gap-2 text-xs text-steam-text cursor-pointer">
            <input
              type="checkbox"
              checked={createShortcut}
              onChange={(e) => setCreateShortcut(e.target.checked)}
              className="rounded border-steam-border bg-[#0e151f] text-sky-500 focus:ring-0"
            />
            <span>Automatically register executable & launch configuration on completion</span>
          </label>

          {errorMsg && (
            <div className="rounded-lg bg-red-950/70 border border-red-500/50 p-3 text-xs text-red-200 flex items-center gap-2">
              <AlertCircle className="w-4 h-4 text-red-400 shrink-0" />
              <span>{errorMsg}</span>
            </div>
          )}
        </div>

        {/* Footer Actions */}
        <div className="px-5 py-3.5 bg-[#0e151f] border-t border-[#223447] flex items-center justify-end gap-2.5">
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-2 rounded-lg bg-[#1b2838] hover:bg-[#24354a] text-xs font-semibold text-steam-text hover:text-white transition-colors cursor-pointer"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleStartInstall}
            disabled={isStarting || !hasEnoughSpace}
            className="inline-flex items-center gap-2 px-5 py-2 rounded-lg font-bold text-xs text-white uppercase tracking-wider transition-opacity shadow-lg hover:brightness-110 disabled:opacity-50 cursor-pointer"
            style={{
              background: 'linear-gradient(to right, #0ea5e9 0%, #2563eb 100%)',
              boxShadow: '0 0 18px rgba(14, 165, 233, 0.4)',
            }}
          >
            {isStarting ? (
              <>
                <Loader2 className="w-4 h-4 animate-spin" />
                <span>Starting...</span>
              </>
            ) : (
              <>
                <Download className="w-4 h-4" />
                <span>Start Download & Install</span>
              </>
            )}
          </button>
        </div>
      </div>
    </div>
  );

  return canPortalModalToBody() ? createPortal(modalContent, document.body) : modalContent;
};
