import React, { useState, useEffect, useRef } from 'react';
import { CanonicalGame } from '../../contracts/game';
import { ModalShell } from '../Common/ModalShell';
import { StorefrontId } from '../../contracts/platform';
import {
  CompatibilityLayerType,
  DiskSpaceInfo,
  DownloadTaskState,
  GameInstallInfo,
  resolveDefaultBottleForLayer,
} from '../../contracts/launcher';
import {
  getDefaultBottleNameForRunner,
  isBottleNameCompatibleWithRunner,
  resolveInstallBottleForRunner,
} from '../../services/launcher/bottleArchitectureUtils';
import { launcherService } from '../../services/launcher/launcherService';
import { environmentSetupService } from '../../services/launcher/environmentSetupService';
import { StorefrontIcon, getStorefrontDisplayName } from '../Common/StorefrontIcon';
import { useIsRealClientRenderer, useSafeId } from '../../utils/useSafeId';
import { Download, Loader2, X } from 'lucide-react';
import {
  buildGameInstallPayload,
  computeInstallModalPlan,
  deduplicateInstallers,
  resolveHeaderImageMediaUrl,
  resolveTargetSteamDisplayPath,
} from './InstallModal/installModalHelpers';
import {
  InstallCompatibilityBanners,
  InstallCompatibilityBannersBase,
} from './InstallModal/InstallCompatibilityBanners';
import {
  InstallBuildAndBottleSection,
  InstallBuildAndBottleSectionBase,
  InstallStorefrontSelector,
  InstallStorefrontSelectorBase,
} from './InstallModal/InstallBuildAndBottleSection';
import {
  InstallDestinationAndDiskSection,
  InstallDestinationAndDiskSectionBase,
} from './InstallModal/InstallDestinationAndDiskSection';

export interface GameInstallModalProps {
  isOpen: boolean;
  game: CanonicalGame;
  initialPlatformId?: StorefrontId;
  onClose: () => void;
  onInstallStarted?: (task?: DownloadTaskState) => void;
}

export const GameInstallModal: React.FC<GameInstallModalProps> = ({
  isOpen,
  game,
  initialPlatformId,
  onClose,
  onInstallStarted,
}) => {
  const isRealClientRenderer = useIsRealClientRenderer();
  const idPrefix = useSafeId('install-modal');
  const diskSpaceReqSeqRef = useRef<number>(0);
  const diskSpaceDebounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      diskSpaceReqSeqRef.current += 1;
      if (diskSpaceDebounceTimerRef.current) {
        clearTimeout(diskSpaceDebounceTimerRef.current);
        diskSpaceDebounceTimerRef.current = null;
      }
    };
  }, []);

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
    (typeof launcherService.isWindowsHost === 'function' && launcherService.isWindowsHost()) ||
    (typeof window !== 'undefined' && window.electronAPI?.platform === 'win32')
      ? 'windows'
      : 'mac'
  );
  const [diskSpace, setDiskSpace] = useState<DiskSpaceInfo | null>(null);
  const [createShortcut, setCreateShortcut] = useState<boolean>(true);
  const [includeDlcs, setIncludeDlcs] = useState<boolean>(
    () => selectedPlatformId === 'epic' || selectedPlatformId === 'gog'
  );
  const [preferClientlessExtraction, setPreferClientlessExtraction] = useState<boolean>(false);
  const [isStarting, setIsStarting] = useState<boolean>(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [, setEnvSetupRev] = useState<number>(0);

  useEffect(() => {
    if (!isOpen) return;
    return environmentSetupService.subscribe(() => {
      setEnvSetupRev((r) => r + 1);
    });
  }, [isOpen]);

  const hostArch =
    typeof launcherService.getHostArch === 'function' ? launcherService.getHostArch() : 'arm64';
  const allRawCompatLayers = isOpen ? launcherService.getCompatibilityLayers() : [];
  const compatLayers = isOpen
    ? allRawCompatLayers.filter(
        (l) =>
          l.type !== 'native' &&
          l.available !== false &&
          (l.type !== 'crossover_preview_arm64' || hostArch === 'arm64')
      )
    : [];
  const existingLaunchCfg = isOpen
    ? launcherService.getLaunchConfig(game.id, selectedPlatformId)
    : undefined;
  const [selectedCompatRunner, setSelectedCompatRunner] = useState<string>(() => {
    const saved = existingLaunchCfg?.compatibilityLayer;
    if (
      saved &&
      saved !== 'native' &&
      (saved !== 'crossover_preview_arm64' || hostArch === 'arm64') &&
      (compatLayers.length === 0 || compatLayers.some((l) => l.type === saved))
    ) {
      return saved;
    }
    return compatLayers[0]?.type || 'crossover';
  });
  const [selectedBottleName, setSelectedBottleName] = useState<string>(() =>
    resolveInstallBottleForRunner({
      savedBottleName: existingLaunchCfg?.wineBottleName,
      savedRunner: existingLaunchCfg?.compatibilityLayer,
      resolvedRunner: selectedCompatRunner,
      hostLayers: compatLayers,
      allLayers: allRawCompatLayers,
      hostArch,
    })
  );
  const selectedCompatRunnerRef = useRef<string>(selectedCompatRunner);
  const selectedBottleNameRef = useRef<string>(selectedBottleName);
  const userChangedCompatInSessionRef = useRef<boolean>(false);
  const [steamDiskQueryTracker] = useState<{ lastPath: string | null }>(() => ({
    lastPath: null,
  }));

  const activeCompatLayer =
    compatLayers.find((l) => l.type === selectedCompatRunner) || compatLayers[0];
  const effectiveCompatRunner = activeCompatLayer?.type || selectedCompatRunner;
  const compatibleInstallBottles = (activeCompatLayer?.availableBottles || []).filter((b) =>
    isBottleNameCompatibleWithRunner(b, effectiveCompatRunner, {
      layer: activeCompatLayer,
      allLayers: allRawCompatLayers,
    })
  );
  const defaultResolvedBottleName =
    resolveDefaultBottleForLayer(
      activeCompatLayer
        ? {
            type: effectiveCompatRunner,
            availableBottles: compatibleInstallBottles,
            bottleDetails: activeCompatLayer.bottleDetails,
          }
        : undefined,
      effectiveCompatRunner
    ) || getDefaultBottleNameForRunner(activeCompatLayer?.type || '');

  const isWindowsHost =
    (installInfo as { hostPlatform?: string } | null)?.hostPlatform === 'win32' ||
    (typeof launcherService.isWindowsHost === 'function' && launcherService.isWindowsHost()) ||
    (typeof window !== 'undefined' && window.electronAPI?.platform === 'win32') ||
    /^[A-Za-z]:\\/.test(installDir || installInfo?.defaultInstallDir || '');

  const effectiveSteamDisplayPath = resolveTargetSteamDisplayPath({
    isWindowsHost,
    selectedOs,
    activeCompatLayer,
    selectedBottleName,
    winePrefixPath: existingLaunchCfg?.winePrefixPath,
    installInfo,
    installDir,
  });

  const querySteamDiskSpaceIfChanged = (targetSteamPath: string) => {
    if (!isOpen || selectedPlatformId !== 'steam' || !targetSteamPath) return;
    if (steamDiskQueryTracker.lastPath === targetSteamPath) return;
    steamDiskQueryTracker.lastPath = targetSteamPath;
    if (diskSpaceDebounceTimerRef.current) {
      clearTimeout(diskSpaceDebounceTimerRef.current);
      diskSpaceDebounceTimerRef.current = null;
    }
    const reqId = ++diskSpaceReqSeqRef.current;
    launcherService
      .getDiskSpace(targetSteamPath)
      .then((ds) => {
        if (reqId === diskSpaceReqSeqRef.current && ds) {
          setDiskSpace(ds);
        }
      })
      .catch(() => {});
  };

  useEffect(() => {
    if (isOpen) {
      const targetPlat =
        initialPlatformId ||
        launcherService.getEffectivePlatformForGame(game)?.platformId ||
        game.platforms[0]?.platformId ||
        'steam';
      setSelectedPlatformId(targetPlat);
      setIncludeDlcs(targetPlat === 'epic' || targetPlat === 'gog');
      setPreferClientlessExtraction(false);
      setErrorMsg(null);
      userChangedCompatInSessionRef.current = false;

      const currentHostArch =
        typeof launcherService.getHostArch === 'function' ? launcherService.getHostArch() : 'arm64';
      const allCurrentLayers = launcherService.getCompatibilityLayers();
      const currentLayers = allCurrentLayers.filter(
        (l) =>
          l.type !== 'native' &&
          l.available !== false &&
          (l.type !== 'crossover_preview_arm64' || currentHostArch === 'arm64')
      );
      const platCfg = launcherService.getLaunchConfig(game.id, targetPlat);
      const savedRunner =
        platCfg?.compatibilityLayer &&
        platCfg.compatibilityLayer !== 'native' &&
        (platCfg.compatibilityLayer !== 'crossover_preview_arm64' || currentHostArch === 'arm64') &&
        (currentLayers.length === 0 ||
          currentLayers.some((l) => l.type === platCfg.compatibilityLayer))
          ? platCfg.compatibilityLayer
          : undefined;
      const syncedRunner = savedRunner || currentLayers[0]?.type || 'crossover';
      const syncedBottle = resolveInstallBottleForRunner({
        savedBottleName: platCfg?.wineBottleName,
        savedRunner: platCfg?.compatibilityLayer,
        resolvedRunner: syncedRunner,
        hostLayers: currentLayers,
        allLayers: allCurrentLayers,
        hostArch: currentHostArch,
      });
      selectedCompatRunnerRef.current = syncedRunner;
      selectedBottleNameRef.current = syncedBottle;
      setSelectedCompatRunner(syncedRunner);
      setSelectedBottleName(syncedBottle);
    } else {
      userChangedCompatInSessionRef.current = false;
      steamDiskQueryTracker.lastPath = null;
    }
  }, [isOpen, game.id, initialPlatformId]);

  useEffect(() => {
    if (!isOpen) return;
    let active = true;
    setIsLoadingInfo(true);
    setErrorMsg(null);
    steamDiskQueryTracker.lastPath = null;

    launcherService
      .getGameInstallInfo(game, selectedPlatformId)
      .then((info) => {
        if (!active) return;
        const winHost =
          (info as { hostPlatform?: string })?.hostPlatform === 'win32' ||
          (typeof launcherService.isWindowsHost === 'function' &&
            launcherService.isWindowsHost()) ||
          (typeof window !== 'undefined' && window.electronAPI?.platform === 'win32') ||
          /^[A-Za-z]:\\/.test(info.defaultInstallDir || '');

        const defaultDir =
          info.defaultInstallDir || (winHost ? 'C:\\Games\\OneLauncher' : '~/Games/OneLauncher');
        setInstallInfo(info);
        setInstallDir(defaultDir);

        const platCfg = launcherService.getLaunchConfig(game.id, selectedPlatformId);
        const currentHostArch =
          typeof launcherService.getHostArch === 'function'
            ? launcherService.getHostArch()
            : 'arm64';
        const allCurrentLayers = launcherService.getCompatibilityLayers();
        const currentLayers = allCurrentLayers.filter(
          (l) =>
            l.type !== 'native' &&
            l.available !== false &&
            (l.type !== 'crossover_preview_arm64' || currentHostArch === 'arm64')
        );
        const savedValidRunner =
          platCfg?.compatibilityLayer &&
          platCfg.compatibilityLayer !== 'native' &&
          (platCfg.compatibilityLayer !== 'crossover_preview_arm64' ||
            currentHostArch === 'arm64') &&
          (currentLayers.length === 0 ||
            currentLayers.some((l) => l.type === platCfg.compatibilityLayer))
            ? platCfg.compatibilityLayer
            : undefined;
        const resolvedRunner =
          userChangedCompatInSessionRef.current &&
          currentLayers.some((l) => l.type === selectedCompatRunnerRef.current)
            ? selectedCompatRunnerRef.current
            : savedValidRunner || currentLayers[0]?.type || 'crossover';
        const resolvedBottle =
          userChangedCompatInSessionRef.current &&
          currentLayers.some((l) => l.type === selectedCompatRunnerRef.current)
            ? selectedBottleNameRef.current
            : resolveInstallBottleForRunner({
                savedBottleName: platCfg?.wineBottleName,
                savedRunner: platCfg?.compatibilityLayer,
                resolvedRunner,
                hostLayers: currentLayers,
                allLayers: allCurrentLayers,
                hostArch: currentHostArch,
              });
        selectedCompatRunnerRef.current = resolvedRunner;
        selectedBottleNameRef.current = resolvedBottle;
        setSelectedCompatRunner(resolvedRunner);
        setSelectedBottleName(resolvedBottle);

        const deduped = deduplicateInstallers(info.availableInstallers, winHost);
        let chosenOs: 'mac' | 'windows' | 'linux' =
          winHost || selectedPlatformId === 'xbox' ? 'windows' : 'mac';
        if (deduped.length > 0) {
          const preferredInstaller = winHost
            ? deduped.find((i) => i.os === 'windows')
            : platCfg?.launchMethod === 'compatibility_layer' &&
                deduped.some((i) => i.os === 'windows')
              ? deduped.find((i) => i.os === 'windows')
              : deduped.find((i) => i.os === 'mac');
          const chosen = preferredInstaller || deduped[0];
          setSelectedInstallerId(chosen.id);
          chosenOs = winHost ? 'windows' : chosen.os;
          setSelectedOs(chosenOs);
        } else {
          setSelectedInstallerId(undefined);
          setSelectedOs(chosenOs);
        }

        if (diskSpaceDebounceTimerRef.current) {
          clearTimeout(diskSpaceDebounceTimerRef.current);
          diskSpaceDebounceTimerRef.current = null;
        }
        const reqId = ++diskSpaceReqSeqRef.current;

        if (selectedPlatformId === 'steam') {
          const resolvedLayer =
            currentLayers.find((l) => l.type === resolvedRunner) || currentLayers[0];
          const initialSteamPath = resolveTargetSteamDisplayPath({
            isWindowsHost: winHost,
            selectedOs: chosenOs,
            activeCompatLayer: resolvedLayer,
            selectedBottleName: resolvedBottle,
            winePrefixPath: platCfg?.winePrefixPath,
            installInfo: info,
            installDir: defaultDir,
          });
          steamDiskQueryTracker.lastPath = initialSteamPath;

          if (info.diskSpace) {
            setDiskSpace(info.diskSpace);
            if (info.diskSpace.targetPath && info.diskSpace.targetPath !== initialSteamPath) {
              launcherService
                .getDiskSpace(initialSteamPath)
                .then((ds) => {
                  if (active && reqId === diskSpaceReqSeqRef.current && ds) setDiskSpace(ds);
                })
                .catch(() => {});
            }
          } else {
            launcherService
              .getDiskSpace(initialSteamPath)
              .then((ds) => {
                if (active && reqId === diskSpaceReqSeqRef.current && ds) setDiskSpace(ds);
              })
              .catch(() => {});
          }
        } else if (info.diskSpace) {
          setDiskSpace(info.diskSpace);
        } else {
          launcherService
            .getDiskSpace(info.defaultInstallDir)
            .then((ds) => {
              if (active && reqId === diskSpaceReqSeqRef.current && ds) setDiskSpace(ds);
            })
            .catch(() => {});
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
      if (diskSpaceDebounceTimerRef.current) {
        clearTimeout(diskSpaceDebounceTimerRef.current);
        diskSpaceDebounceTimerRef.current = null;
      }
    };
  }, [isOpen, game.id, selectedPlatformId]);

  useEffect(() => {
    if (!isOpen || selectedPlatformId !== 'steam' || isLoadingInfo || !installInfo) {
      return;
    }
    querySteamDiskSpaceIfChanged(effectiveSteamDisplayPath);
  }, [isOpen, selectedPlatformId, effectiveSteamDisplayPath, isLoadingInfo, installInfo]);

  if (!isOpen) return null;

  const renderSection = <P extends object>(
    MemoComp: React.ComponentType<P>,
    BaseFn: (props: P) => React.ReactElement | null,
    props: P
  ): React.ReactElement | null =>
    isRealClientRenderer ? React.createElement(MemoComp, props) : BaseFn(props);

  const handleDirectoryChange = async (newDir: string, debounce = false) => {
    setInstallDir(newDir);
    if (diskSpaceDebounceTimerRef.current) {
      clearTimeout(diskSpaceDebounceTimerRef.current);
      diskSpaceDebounceTimerRef.current = null;
    }
    const reqId = ++diskSpaceReqSeqRef.current;
    const isTestEnv =
      (typeof process !== 'undefined' && process.env?.NODE_ENV === 'test') ||
      (typeof import.meta !== 'undefined' && import.meta.env?.MODE === 'test');
    if (debounce && !isTestEnv) {
      diskSpaceDebounceTimerRef.current = setTimeout(async () => {
        diskSpaceDebounceTimerRef.current = null;
        const ds = await launcherService.getDiskSpace(newDir);
        if (reqId === diskSpaceReqSeqRef.current && ds) {
          setDiskSpace(ds);
        }
      }, 250);
      return;
    }
    const ds = await launcherService.getDiskSpace(newDir);
    if (reqId === diskSpaceReqSeqRef.current && ds) {
      setDiskSpace(ds);
    }
  };

  const handleBrowseFolder = async () => {
    const chosen = await launcherService.selectFolder(installDir);
    if (chosen) {
      await handleDirectoryChange(chosen);
    }
  };

  const plan = computeInstallModalPlan({
    game,
    selectedPlatformId,
    selectedInstallerId,
    selectedOs,
    isWindowsHost,
    installInfo,
    diskSpace,
    includeDlcs,
    preferClientlessExtraction,
    compatLayers,
    allRawCompatLayers,
    activeCompatLayer,
    effectiveCompatRunner,
    selectedBottleName,
  });

  const envSnapshot = environmentSetupService.getLastSnapshot();
  const isWinSteamTarget =
    !isWindowsHost &&
    (selectedOs === 'windows' ||
      plan.selectedInstaller?.os === 'windows' ||
      plan.selectedInstaller?.id === 'steam-win-compat');
  const targetSteamLogin =
    selectedPlatformId === 'steam'
      ? envSnapshot?.clientLogins?.[isWinSteamTarget ? 'bottle_steam' : 'host_steam']
      : undefined;
  const showSteamSignInHint = Boolean(
    targetSteamLogin?.installed &&
      (!targetSteamLogin.authenticated || targetSteamLogin.accountMatchesOneLauncher === false)
  );

  const handleSelectPlatform = (platformId: StorefrontId) => {
    userChangedCompatInSessionRef.current = false;
    setSelectedPlatformId(platformId);
    setIncludeDlcs(platformId === 'epic' || platformId === 'gog');
    setPreferClientlessExtraction(false);
    setErrorMsg(null);
  };

  const handleSelectOsAndSyncSteamSpace = (
    nextOs: 'mac' | 'windows' | 'linux',
    installerId?: string
  ) => {
    if (installerId !== undefined) {
      setSelectedInstallerId(installerId);
    }
    setSelectedOs(nextOs);
    if (selectedPlatformId === 'steam') {
      querySteamDiskSpaceIfChanged(
        resolveTargetSteamDisplayPath({
          isWindowsHost,
          selectedOs: nextOs,
          activeCompatLayer,
          selectedBottleName,
          winePrefixPath: existingLaunchCfg?.winePrefixPath,
          installInfo,
          installDir,
        })
      );
    }
  };

  const handleSelectInstallerFromDropdown = (id: string) => {
    setSelectedInstallerId(id);
    const found = plan.uniqueInstallers.find((i) => i.id === id);
    if (found) {
      handleSelectOsAndSyncSteamSpace(found.os);
    }
  };

  const handleChangeCompatRunner = (nextRunner: string) => {
    userChangedCompatInSessionRef.current = true;
    selectedCompatRunnerRef.current = nextRunner;
    setSelectedCompatRunner(nextRunner);
    const nextLayer = compatLayers.find((l) => l.type === nextRunner) || compatLayers[0];
    const nextAvailableBottles = nextLayer?.availableBottles || [];
    let nextBottleName = selectedBottleNameRef.current || selectedBottleName;
    const isBottleCompatibleWithNext = isBottleNameCompatibleWithRunner(
      nextBottleName,
      nextRunner,
      {
        layer: nextLayer,
        allLayers: allRawCompatLayers,
      }
    );
    if (
      nextBottleName &&
      (!isBottleCompatibleWithNext || !nextAvailableBottles.includes(nextBottleName))
    ) {
      const nextCompatBottles = nextAvailableBottles.filter((b) =>
        isBottleNameCompatibleWithRunner(b, nextRunner, {
          layer: nextLayer,
          allLayers: allRawCompatLayers,
        })
      );
      nextBottleName =
        nextCompatBottles.length > 0
          ? resolveDefaultBottleForLayer(
              {
                type: nextRunner as CompatibilityLayerType,
                availableBottles: nextCompatBottles,
                bottleDetails: nextLayer?.bottleDetails,
              },
              nextRunner
            ) || ''
          : '';
      selectedBottleNameRef.current = nextBottleName;
      setSelectedBottleName(nextBottleName);
    }
    if (selectedPlatformId === 'steam') {
      querySteamDiskSpaceIfChanged(
        resolveTargetSteamDisplayPath({
          isWindowsHost,
          selectedOs,
          activeCompatLayer: nextLayer,
          selectedBottleName: nextBottleName,
          winePrefixPath: existingLaunchCfg?.winePrefixPath,
          installInfo,
          installDir,
        })
      );
    }
  };

  const handleChangeBottleName = (nextBottle: string) => {
    userChangedCompatInSessionRef.current = true;
    selectedBottleNameRef.current = nextBottle;
    setSelectedBottleName(nextBottle);
    if (selectedPlatformId === 'steam') {
      querySteamDiskSpaceIfChanged(
        resolveTargetSteamDisplayPath({
          isWindowsHost,
          selectedOs,
          activeCompatLayer,
          selectedBottleName: nextBottle,
          winePrefixPath: existingLaunchCfg?.winePrefixPath,
          installInfo,
          installDir,
        })
      );
    }
  };

  const handleStartInstall = async () => {
    if (
      isStarting ||
      plan.isInstallBlockedByDiskSpace ||
      plan.isXboxMacBlocked ||
      plan.hasSelectedBottleArchMismatch
    ) {
      return;
    }
    setIsStarting(true);
    setErrorMsg(null);

    try {
      launcherService.setSelectedStorefrontForGame(game.id, selectedPlatformId);

      if (!isWindowsHost) {
        if (
          selectedOs === 'windows' ||
          (selectedPlatformId === 'xbox' && !plan.isCrossPlatformMacLauncher)
        ) {
          const safeBottleName =
            selectedBottleName.trim() &&
            isBottleNameCompatibleWithRunner(selectedBottleName.trim(), effectiveCompatRunner, {
              layer: activeCompatLayer,
              allLayers: allRawCompatLayers,
            })
              ? selectedBottleName.trim()
              : undefined;
          await launcherService.saveLaunchConfig(
            {
              ...(existingLaunchCfg || { gameId: game.id, launchMethod: 'compatibility_layer' }),
              gameId: game.id,
              preferredPlatformId: selectedPlatformId,
              launchMethod: 'compatibility_layer',
              compatibilityLayer: (effectiveCompatRunner || 'crossover') as CompatibilityLayerType,
              wineBottleName: safeBottleName,
            },
            selectedPlatformId
          );
        } else if (
          selectedOs === 'mac' &&
          (existingLaunchCfg?.launchMethod === 'compatibility_layer' || game.platforms.length > 1)
        ) {
          await launcherService.saveLaunchConfig(
            {
              ...(existingLaunchCfg || { gameId: game.id, launchMethod: 'auto' }),
              gameId: game.id,
              preferredPlatformId: selectedPlatformId,
              launchMethod:
                existingLaunchCfg?.launchMethod === 'compatibility_layer'
                  ? 'auto'
                  : existingLaunchCfg?.launchMethod || 'auto',
              compatibilityLayer:
                existingLaunchCfg?.launchMethod === 'compatibility_layer'
                  ? undefined
                  : existingLaunchCfg?.compatibilityLayer,
            },
            selectedPlatformId
          );
        }
      } else if (game.platforms.length > 1) {
        await launcherService.saveLaunchConfig(
          {
            ...(existingLaunchCfg || { gameId: game.id, launchMethod: 'auto' }),
            gameId: game.id,
            preferredPlatformId: selectedPlatformId,
            launchMethod: existingLaunchCfg?.launchMethod || 'auto',
          },
          selectedPlatformId
        );
      }

      const installPayload = buildGameInstallPayload({
        game,
        selectedPlatformId,
        activePlatformObj: plan.activePlatformObj,
        installInfo,
        selectedInstaller: plan.selectedInstaller,
        selectedInstallerId,
        selectedOs,
        isWindowsHost,
        isChainedBottleInstaller: plan.isChainedBottleInstaller,
        isCrossPlatformMacLauncher: plan.isCrossPlatformMacLauncher,
        preferClientlessExtraction,
        installDir,
        createShortcut,
        includeDlcs,
        estimatedSizeBytes: plan.estimatedSizeBytes,
        effectiveCompatRunner,
        selectedBottleName,
      });
      const res = await launcherService.startInstall(installPayload);

      if (res.success) {
        onInstallStarted?.(res.task);
        onClose();
      } else {
        setErrorMsg(res.error || 'Failed to start installation.');
      }
    } catch (err: unknown) {
      setErrorMsg(
        err instanceof Error ? err.message : 'Unexpected error starting installation.'
      );
    } finally {
      setIsStarting(false);
    }
  };

  const installDirInputId = `${idPrefix}-dir-input`;
  const resolvedHeaderImage = resolveHeaderImageMediaUrl(game);

  return (
    <ModalShell
      isOpen={isOpen}
      onClose={onClose}
      preventClose={isStarting}
      closeOnBackdrop={!isStarting}
      ariaLabel={`Install ${game.title}`}
      className="w-full max-w-xl"
    >
      <div
        className="relative z-10 w-full max-w-xl rounded-xl bg-[#131b26] border border-[#2a475e] shadow-2xl overflow-hidden text-steam-text select-none overscroll-contain"
        onClick={(e) => e.stopPropagation()}
      >
        <div
          aria-hidden="true"
          data-testid="install-modal-scrim"
          className="sr-only pointer-events-none"
        />

        {/* Top Game Banner Header */}
        <div className="relative h-36 w-full bg-[#0b1017] overflow-hidden">
          {resolvedHeaderImage && (
            <img
              src={resolvedHeaderImage}
              alt={game.title}
              className="w-full h-full object-cover opacity-55"
            />
          )}
          <div className="absolute inset-0 bg-gradient-to-t from-[#131b26] via-[#131b26]/60 to-transparent" />

          <button
            type="button"
            onClick={onClose}
            disabled={isStarting}
            className="absolute top-3 right-3 min-w-6 min-h-6 p-1.5 rounded-lg bg-black/60 hover:bg-black/80 text-steam-subtext hover:text-white border border-white/10 transition-colors cursor-pointer disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-400"
            aria-label="Close install modal"
          >
            <X className="w-4 h-4" aria-hidden="true" />
          </button>

          <div className="absolute bottom-3 left-5 right-5 flex items-end justify-between gap-3">
            <div className="min-w-0">
              <div className="flex items-center gap-2 text-[11px] font-bold uppercase tracking-wider text-sky-400">
                <Download className="w-3.5 h-3.5" aria-hidden="true" />
                <span>Install Game</span>
              </div>
              <h2 className="text-xl font-extrabold text-white truncate drop-shadow">
                {game.title}
              </h2>
            </div>

            {game.platforms.length <= 1 && (
              <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-black/70 border border-white/15 text-xs font-semibold text-white shrink-0">
                <StorefrontIcon
                  storefrontId={selectedPlatformId}
                  decorative
                  className={`w-3.5 h-3.5 ${
                    selectedPlatformId === 'xbox' ? 'text-[#52d652]' : 'text-sky-400'
                  }`}
                />
                <span>{getStorefrontDisplayName(selectedPlatformId)}</span>
              </div>
            )}
          </div>
        </div>

        {/* Modal Body */}
        <div className="p-5 space-y-5 max-h-[75vh] overflow-y-auto overscroll-contain bg-[#131b26] modal-scroll-body">
          {renderSection(InstallStorefrontSelector, InstallStorefrontSelectorBase, {
            idPrefix,
            game,
            selectedPlatformId,
            onSelectPlatform: handleSelectPlatform,
          })}

          {renderSection(InstallCompatibilityBanners, InstallCompatibilityBannersBase, {
            gameTitle: game.title,
            selectedPlatformId,
            isWindowsHost,
            xboxCompat: plan.xboxCompat,
            isXboxMacBlocked: plan.isXboxMacBlocked,
            hasChainedBottleInstaller: plan.hasChainedBottleInstaller,
            isRiotKernelAntiCheat: plan.isRiotKernelAntiCheat,
            hasKernelAntiCheatRequirement: plan.hasKernelAntiCheatRequirement,
            isBattlEyeAntiCheat: plan.isBattlEyeAntiCheat,
            detectedAntiCheatName: plan.detectedAntiCheatName,
            isChainedWinInstaller: plan.isChainedWinInstaller,
            chainedLauncherName: plan.chainedLauncherName,
            showXboxPublisherAccountLinkCallout: plan.showXboxPublisherAccountLinkCallout,
            handoffKeyLower: plan.handoffKeyLower,
            showMacKernelAntiCheatWarning: plan.showMacKernelAntiCheatWarning,
          })}

          {renderSection(InstallBuildAndBottleSection, InstallBuildAndBottleSectionBase, {
            idPrefix,
            game,
            selectedPlatformId,
            isWindowsHost,
            isLoadingInfo,
            uniqueInstallers: plan.uniqueInstallers,
            hasMacBuildOption: plan.hasMacBuildOption,
            macInstaller: plan.macInstaller,
            winInstaller: plan.winInstaller,
            selectedInstaller: plan.selectedInstaller,
            selectedInstallerId,
            selectedOs,
            onSelectMacBuild: (installerId) => handleSelectOsAndSyncSteamSpace('mac', installerId),
            onSelectWinBuild: (installerId) =>
              handleSelectOsAndSyncSteamSpace('windows', installerId),
            onSelectInstallerFromDropdown: handleSelectInstallerFromDropdown,
            isCrossPlatformMacLauncher: plan.isCrossPlatformMacLauncher,
            isXboxMacBlocked: plan.isXboxMacBlocked,
            hasKernelAntiCheatRequirement: plan.hasKernelAntiCheatRequirement,
            detectedAntiCheatName: plan.detectedAntiCheatName,
            isChainedBottleInstaller: plan.isChainedBottleInstaller,
            chainedLauncherName: plan.chainedLauncherName,
            showPreinstallCompatConfig: plan.showPreinstallCompatConfig,
            compatLayers,
            allRawCompatLayers,
            activeCompatLayer,
            effectiveCompatRunner,
            selectedBottleName,
            defaultResolvedBottleName,
            hasSelectedBottleArchMismatch: plan.hasSelectedBottleArchMismatch,
            onChangeCompatRunner: handleChangeCompatRunner,
            onChangeBottleName: handleChangeBottleName,
          })}

          {renderSection(InstallDestinationAndDiskSection, InstallDestinationAndDiskSectionBase, {
            installDirInputId,
            selectedPlatformId,
            isWindowsHost,
            selectedOs,
            selectedBottleName,
            defaultResolvedBottleName,
            effectiveSteamDisplayPath,
            showSteamSignInHint,
            targetSteamLogin,
            installInfo,
            installDir,
            onDirectoryChange: (newDir, debounce) => void handleDirectoryChange(newDir, debounce),
            onBrowseFolder: () => void handleBrowseFolder(),
            diskSpace,
            baseEstimatedBytes: plan.baseEstimatedBytes,
            knownDlcBytes: plan.knownDlcBytes,
            estimatedSizeBytes: plan.estimatedSizeBytes,
            usedPercent: plan.usedPercent,
            installPercent: plan.installPercent,
            isVolumeMissing: plan.isVolumeMissing,
            hasEnoughSpaceOnTargetVolume: plan.hasEnoughSpaceOnTargetVolume,
            isExternalClientManagedDriveSelection: plan.isExternalClientManagedDriveSelection,
            isCaseSensitiveTargetVolume: plan.isCaseSensitiveTargetVolume,
            methodInfo: plan.methodInfo,
            includeDlcs,
            onChangeIncludeDlcs: setIncludeDlcs,
            preferClientlessExtraction,
            onChangePreferClientlessExtraction: setPreferClientlessExtraction,
            createShortcut,
            onChangeCreateShortcut: setCreateShortcut,
            errorMsg,
          })}
        </div>

        {/* Footer Actions */}
        <div className="px-5 py-3.5 bg-[#0e151f] border-t border-[#223447] flex items-center justify-end gap-2.5">
          <button
            type="button"
            onClick={onClose}
            disabled={isStarting}
            className="min-h-6 px-4 py-2 rounded-lg bg-[#1b2838] hover:bg-[#24354a] text-xs font-semibold text-steam-text hover:text-white transition-colors cursor-pointer disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-400"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleStartInstall}
            disabled={
              isStarting ||
              plan.isInstallBlockedByDiskSpace ||
              plan.isXboxMacBlocked ||
              plan.hasSelectedBottleArchMismatch
            }
            aria-describedby={
              plan.hasSelectedBottleArchMismatch ? 'preinstall-bottle-arch-warning' : undefined
            }
            className="inline-flex items-center gap-2 min-h-6 px-5 py-2 rounded-lg font-bold text-xs text-white uppercase tracking-wider transition-opacity shadow-lg hover:brightness-110 disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-400"
            style={{
              background: 'linear-gradient(to right, #0284c7 0%, #1d4ed8 100%)',
              boxShadow: '0 0 18px rgba(14, 165, 233, 0.4)',
            }}
          >
            {isStarting ? (
              <>
                <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" />
                <span>Starting...</span>
              </>
            ) : (
              <>
                <Download className="w-4 h-4" aria-hidden="true" />
                <span>Start Download &amp; Install</span>
              </>
            )}
          </button>
        </div>
      </div>
    </ModalShell>
  );
};
