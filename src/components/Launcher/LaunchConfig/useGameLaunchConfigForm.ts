import { useState, useEffect, useCallback, useMemo, useRef, type SetStateAction } from 'react';
import { CanonicalGame } from '../../../contracts/game';
import { StorefrontId } from '../../../contracts/platform';
import {
  BottleDisplayScalingMode,
  CompatibilityLayerInfo,
  CompatibilityLayerType,
  CompatibilityLayerUpdateInfo,
  CrossOverD3DMetalVersion,
  CrossOverGraphicsBackend,
  DisplayAspectRatioMode,
  GameLaunchConfig,
  InGameLauncherBehavior,
  LauncherPerformanceSettings,
  LaunchMethod,
  PerformanceHudMode,
  resolveDefaultBottleForLayer,
  StorefrontClientLifecyclePolicy,
  StorefrontLaunchProfile,
  VirtualDesktopResolutionPreset,
} from '../../../contracts/launcher';
import { isBottleNameCompatibleWithRunner } from '../../../services/launcher/bottleArchitectureUtils';
import {
  launcherService,
  COMPATIBILITY_RUNNER_DESCRIPTORS,
} from '../../../services/launcher/launcherService';
import {
  formatRunnerSecondaryBuildText,
  resolveEffectiveUiStorefrontLifecycle,
  resolveWineSyncMode,
  type WineSyncMode,
} from './launchConfigHelpers';
import {
  resolveDlssEligibility,
  resolveMetalfxSpatialEligibility,
} from './CompatibilityLayerSection';
import {
  patchLaunchConfigSignature,
  serializeLaunchConfigSignature,
} from './launchConfigDirtySignature';
import {
  buildStorefrontLaunchProfile,
  buildVisibleLaunchModes,
  isHostSupportedCompatRunner,
  parseLaunchConfigProfileFields,
  reconcileInactiveDraftsWithDetectedLayers,
  resolveFormHostCapabilities,
} from './launchConfigProfileMapping';
import {
  useLaunchConfigRunnerLifecycle,
  type RunnerLifecycleContextSnapshot,
} from './useLaunchConfigRunnerLifecycle';

export interface UseGameLaunchConfigFormParams {
  isOpen: boolean;
  game: CanonicalGame;
  initialPlatformId?: StorefrontId;
  onClose: () => void;
  onSaved?: (config: GameLaunchConfig) => void;
}

export function useGameLaunchConfigForm({
  isOpen,
  game,
  initialPlatformId,
  onClose,
  onSaved,
}: UseGameLaunchConfigFormParams) {
  const [preferredPlatformId, setPreferredPlatformId] = useState<StorefrontId>(
    () => initialPlatformId || game.platforms[0]?.platformId || 'steam'
  );
  const [draftsByPlatform, setDraftsByPlatform] = useState<
    Partial<Record<StorefrontId, StorefrontLaunchProfile>>
  >({});

  const [launchMethod, setLaunchMethod] = useState<LaunchMethod>('auto');
  const [customExecutablePath, setCustomExecutablePath] = useState<string>('');
  const [workingDirectory, setWorkingDirectory] = useState<string>('');
  const [launchArguments, setLaunchArguments] = useState<string>('');
  const [compatibilityLayer, setCompatibilityLayer] = useState<CompatibilityLayerType>('crossover');
  const [wineBottleName, setWineBottleName] = useState<string>('');
  const [winePrefixPath, setWinePrefixPath] = useState<string>('');
  const [crossoverGraphicsBackend, setCrossoverGraphicsBackend] =
    useState<CrossOverGraphicsBackend>('auto');
  const [crossoverD3DMetalVersion, setCrossoverD3DMetalVersion] =
    useState<CrossOverD3DMetalVersion>('auto');
  const [crossoverHighResolutionMode, setCrossoverHighResolutionMode] = useState<
    boolean | undefined
  >(undefined);
  const [crossoverDlss, setCrossoverDlss] = useState<boolean>(false);
  const [preferredMaxFrameRate, setPreferredMaxFrameRate] = useState<number | undefined>(
    undefined
  );
  const [metalfxSpatialUpscaleFactor, setMetalfxSpatialUpscaleFactor] = useState<
    number | undefined
  >(undefined);
  const [displayScalingMode, setDisplayScalingMode] =
    useState<BottleDisplayScalingMode>('default');
  const [displayAspectRatio, setDisplayAspectRatio] =
    useState<DisplayAspectRatioMode>('default');
  const [virtualDesktopResolution, setVirtualDesktopResolution] = useState<
    VirtualDesktopResolutionPreset | string
  >('auto');
  const [emulateModeset, setEmulateModeset] = useState<boolean | undefined>(undefined);
  const [forceLargeAddressAware, setForceLargeAddressAware] = useState<boolean | undefined>(
    undefined
  );
  const [wineMsync, setWineMsync] = useState<boolean>(true);
  const [wineEsync, setWineEsync] = useState<boolean>(false);
  const [performanceHud, setPerformanceHud] = useState<PerformanceHudMode>('default');
  const [envText, setEnvText] = useState<string>('');
  const [preLaunchCommand, setPreLaunchCommand] = useState<string>('');
  const [postExitCommand, setPostExitCommand] = useState<string>('');
  const [inGameLauncherBehavior, setInGameLauncherBehavior] = useState<
    'default' | InGameLauncherBehavior
  >('default');
  const [storefrontClientLifecycle, setStorefrontClientLifecycle] = useState<
    'default' | StorefrontClientLifecyclePolicy
  >('default');
  // Read-only global settings snapshot used purely to render resolved "Global Default (...)" labels
  const [perfSettings, setPerfSettings] = useState<LauncherPerformanceSettings>(() =>
    launcherService.getPerformanceSettings()
  );
  const [initialPlatformIdSnapshot, setInitialPlatformIdSnapshot] =
    useState<StorefrontId>('steam');
  const [dirtyInactivePlatforms, setDirtyInactivePlatforms] = useState<StorefrontId[]>([]);
  const [baselineFieldsByPlatform, setBaselineFieldsByPlatform] = useState<
    Partial<Record<StorefrontId, string>>
  >({});
  const [detectedLayers, setDetectedLayers] = useState<CompatibilityLayerInfo[]>(() =>
    launcherService.getCompatibilityLayers()
  );
  const [isSaving, setIsSaving] = useState<boolean>(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [runnerUpdates, setRunnerUpdates] = useState<Record<string, CompatibilityLayerUpdateInfo>>(
    () => launcherService.getRunnerUpdates()
  );
  const [, setInstallInfoTick] = useState(0);

  const userEditedCompatPlatformsRef = useRef<Set<StorefrontId>>(new Set());
  const userResetPendingDetectPlatformsRef = useRef<Set<StorefrontId>>(new Set());
  const hasDetectedLayersResolvedRef = useRef<boolean>(false);
  const latestDetectedLayersRef = useRef<CompatibilityLayerInfo[]>([]);
  const formSessionIdRef = useRef<number>(0);
  const compatEditEpochByPlatformRef = useRef<Partial<Record<StorefrontId, number>>>({});

  const selectedRunnerDescriptor =
    COMPATIBILITY_RUNNER_DESCRIPTORS.find((d) => d.type === compatibilityLayer) ||
    COMPATIBILITY_RUNNER_DESCRIPTORS[0];
  const activeLayer = detectedLayers.find((l) => l.type === compatibilityLayer);
  const activeUpdateInfo = runnerUpdates[compatibilityLayer];
  const availableBottles = activeLayer?.availableBottles || [];

  const runnerContextRef = useRef<RunnerLifecycleContextSnapshot>({
    game,
    preferredPlatformId,
    compatibilityLayer,
    wineBottleName,
    selectedRunnerDescriptor,
    activeLayer,
    activeUpdateInfo,
  });
  runnerContextRef.current = {
    game,
    preferredPlatformId,
    compatibilityLayer,
    wineBottleName,
    selectedRunnerDescriptor,
    activeLayer,
    activeUpdateInfo,
  };

  const runnerLifecycle = useLaunchConfigRunnerLifecycle({
    isOpen,
    gameId: game.id,
    initialPlatformId,
    compatibilityLayer,
    contextRef: runnerContextRef,
    formSessionIdRef,
    compatEditEpochByPlatformRef,
    userEditedCompatPlatformsRef,
    userResetPendingDetectPlatformsRef,
    hasDetectedLayersResolvedRef,
    latestDetectedLayersRef,
    setDetectedLayers,
    setRunnerUpdates,
    setCompatibilityLayer,
    setWineBottleName,
    setDraftsByPlatform,
    setDirtyInactivePlatforms,
  });

  const { resetRunnerLifecycleFlags, clearRunnerFeedback, setIsCheckingUpdates } = runnerLifecycle;

  const loadFormFieldsForPlatform = useCallback(
    (
      targetPlatId: StorefrontId,
      drafts?: Partial<Record<StorefrontId, StorefrontLaunchProfile>>,
      layersOverride?: CompatibilityLayerInfo[]
    ) => {
      const source =
        drafts?.[targetPlatId] ?? launcherService.getLaunchConfig(game.id, targetPlatId);
      const hostArch =
        typeof launcherService.getHostArch === 'function' ? launcherService.getHostArch() : 'arm64';
      const parsed = parseLaunchConfigProfileFields({
        game,
        targetPlatId,
        source,
        allRawLayers: layersOverride || detectedLayers,
        hostArch,
      });

      setLaunchMethod(parsed.launchMethod);
      setCustomExecutablePath(parsed.customExecutablePath);
      setWorkingDirectory(parsed.workingDirectory);
      setLaunchArguments(parsed.launchArguments);
      setCompatibilityLayer(parsed.compatibilityLayer);
      setWineBottleName(parsed.wineBottleName);
      setWinePrefixPath(parsed.winePrefixPath);
      setCrossoverGraphicsBackend(parsed.crossoverGraphicsBackend);
      setCrossoverD3DMetalVersion(parsed.crossoverD3DMetalVersion);
      setCrossoverHighResolutionMode(parsed.crossoverHighResolutionMode);
      setCrossoverDlss(parsed.crossoverDlss);
      setPreferredMaxFrameRate(parsed.preferredMaxFrameRate);
      setMetalfxSpatialUpscaleFactor(parsed.metalfxSpatialUpscaleFactor);
      setDisplayScalingMode(parsed.displayScalingMode);
      setDisplayAspectRatio(parsed.displayAspectRatio);
      setVirtualDesktopResolution(parsed.virtualDesktopResolution);
      setEmulateModeset(parsed.emulateModeset);
      setForceLargeAddressAware(parsed.forceLargeAddressAware);
      setWineMsync(parsed.wineMsync);
      setWineEsync(parsed.wineEsync);
      setPerformanceHud(parsed.performanceHud);
      setEnvText(parsed.envText);
      setPreLaunchCommand(parsed.preLaunchCommand);
      setPostExitCommand(parsed.postExitCommand);
      setInGameLauncherBehavior(parsed.inGameLauncherBehavior);
      setStorefrontClientLifecycle(parsed.storefrontClientLifecycle);
      setBaselineFieldsByPlatform((prev) =>
        prev[targetPlatId] !== undefined ? prev : { ...prev, [targetPlatId]: parsed.signature }
      );
      clearRunnerFeedback();
    },
    [game, detectedLayers, clearRunnerFeedback]
  );

  useEffect(() => {
    if (!isOpen) {
      formSessionIdRef.current += 1;
      compatEditEpochByPlatformRef.current = {};
      userEditedCompatPlatformsRef.current.clear();
      userResetPendingDetectPlatformsRef.current.clear();
      hasDetectedLayersResolvedRef.current = false;
      latestDetectedLayersRef.current = [];
      resetRunnerLifecycleFlags();
      return;
    }
    let active = true;
    formSessionIdRef.current += 1;
    const effectSessionId = formSessionIdRef.current;
    compatEditEpochByPlatformRef.current = {};
    userEditedCompatPlatformsRef.current.clear();
    userResetPendingDetectPlatformsRef.current.clear();
    hasDetectedLayersResolvedRef.current = false;
    resetRunnerLifecycleFlags();

    const existingBase = launcherService.getLaunchConfig(game.id);
    const effPlat = launcherService.getEffectivePlatformForGame(game);
    const startPlatId: StorefrontId =
      initialPlatformId ||
      existingBase?.preferredPlatformId ||
      effPlat?.platformId ||
      game.platforms[0]?.platformId ||
      'steam';

    const initialDrafts: Partial<Record<StorefrontId, StorefrontLaunchProfile>> = {
      ...(existingBase?.platformConfigs || {}),
    };

    const loadedPerf = launcherService.getPerformanceSettings();
    setDraftsByPlatform(initialDrafts);
    setPreferredPlatformId(startPlatId);
    setInitialPlatformIdSnapshot(startPlatId);
    setDirtyInactivePlatforms([]);
    setBaselineFieldsByPlatform({});
    setPerfSettings(loadedPerf);

    const initialLayers = launcherService.getCompatibilityLayers();
    const initialRunnerUpdates = launcherService.getRunnerUpdates();
    latestDetectedLayersRef.current = initialLayers;
    setDetectedLayers(initialLayers);
    setRunnerUpdates(initialRunnerUpdates);
    loadFormFieldsForPlatform(startPlatId, initialDrafts, initialLayers);

    launcherService
      .detectInstalledStorefrontClients()
      .then(() => {
        if (!active || formSessionIdRef.current !== effectSessionId) return;
        setInstallInfoTick((t) => t + 1);
      })
      .catch(() => {});

    if (!launcherService.isGameInstalled(game, startPlatId)) {
      launcherService
        .getGameInstallInfo(game, startPlatId)
        .then(() => {
          if (!active || formSessionIdRef.current !== effectSessionId) return;
          setInstallInfoTick((t) => t + 1);
        })
        .catch(() => {});
    }

    launcherService.detectCompatibilityLayers().then((layers) => {
      if (!active || formSessionIdRef.current !== effectSessionId) return;
      hasDetectedLayersResolvedRef.current = true;
      latestDetectedLayersRef.current = layers;
      if (JSON.stringify(layers) !== JSON.stringify(initialLayers)) {
        setDetectedLayers(layers);
      }
      const currentHostArch =
        typeof launcherService.getHostArch === 'function' ? launcherService.getHostArch() : 'arm64';
      const validLayers = layers.filter(
        (l) => l.available !== false && isHostSupportedCompatRunner(l.type, currentHostArch)
      );
      const currentPlatId = latestRef.current.preferredPlatformId;

      const { draftUpdates, baselineDraftPatches } = reconcileInactiveDraftsWithDetectedLayers({
        layers,
        validLayers,
        currentPlatId,
        currentHostArch,
        currentDrafts: latestRef.current.draftsByPlatform,
        userEditedCompatPlatforms: userEditedCompatPlatformsRef.current,
        userResetPendingDetectPlatforms: userResetPendingDetectPlatformsRef.current,
      });

      if (Object.keys(draftUpdates).length > 0) {
        setDraftsByPlatform((prev) => ({ ...prev, ...draftUpdates }));
      }
      if (Object.keys(baselineDraftPatches).length > 0) {
        setBaselineFieldsByPlatform((prev) => {
          const next = { ...prev };
          let changed = false;
          for (const [platId, patch] of Object.entries(baselineDraftPatches)) {
            const rawSig = next[platId as StorefrontId];
            if (!rawSig || !patch) continue;
            const patched = patchLaunchConfigSignature(rawSig, patch);
            if (patched && patched !== rawSig) {
              next[platId as StorefrontId] = patched;
              changed = true;
            }
          }
          return changed ? next : prev;
        });
      }

      if (userResetPendingDetectPlatformsRef.current.has(currentPlatId)) {
        userResetPendingDetectPlatformsRef.current.delete(currentPlatId);
        if (validLayers.length > 0) {
          const autoLayer = validLayers[0].type;
          setCompatibilityLayer((prev) => (prev === autoLayer ? prev : autoLayer));
          setWineBottleName('');
          setBaselineFieldsByPlatform((prev) => {
            const patched = patchLaunchConfigSignature(prev[currentPlatId], {
              compatibilityLayer: autoLayer,
              wineBottleName: '',
            });
            return patched ? { ...prev, [currentPlatId]: patched } : prev;
          });
        }
        return;
      }

      if (userEditedCompatPlatformsRef.current.has(currentPlatId)) {
        const currentLayer = latestRef.current.compatibilityLayer;
        const currentBottle = latestRef.current.wineBottleName.trim();
        if (currentBottle) {
          const targetLayer = layers.find(
            (l) => l.type === currentLayer && l.available !== false
          );
          const targetAvailableBottles = targetLayer?.availableBottles || [];
          if (
            targetAvailableBottles.length > 0 &&
            !targetAvailableBottles.includes(currentBottle)
          ) {
            setWineBottleName('');
          }
        }
        return;
      }

      const activeSource =
        latestRef.current.draftsByPlatform[currentPlatId] ??
        launcherService.getLaunchConfig(game.id, currentPlatId);
      const isSourceLayerHostSupported = isHostSupportedCompatRunner(
        activeSource?.compatibilityLayer,
        currentHostArch
      );
      if ((!activeSource?.compatibilityLayer || !isSourceLayerHostSupported) && validLayers.length > 0) {
        const autoLayer = validLayers[0].type;
        setCompatibilityLayer((prev) => (prev === autoLayer ? prev : autoLayer));
        const rawSavedBottle = activeSource?.wineBottleName || '';
        const autoLayerBottles = validLayers[0].availableBottles || [];
        const isBottleValidForAuto =
          !rawSavedBottle ||
          (isBottleNameCompatibleWithRunner(rawSavedBottle, autoLayer, { allLayers: layers }) &&
            (autoLayerBottles.length === 0 || autoLayerBottles.includes(rawSavedBottle)));
        const sanitizedBottle = isBottleValidForAuto ? rawSavedBottle : '';
        if (!isBottleValidForAuto) {
          setWineBottleName('');
        }
        setBaselineFieldsByPlatform((prev) => {
          const patched = patchLaunchConfigSignature(prev[currentPlatId], {
            compatibilityLayer: autoLayer,
            ...(isBottleValidForAuto ? {} : { wineBottleName: sanitizedBottle }),
          });
          return patched ? { ...prev, [currentPlatId]: patched } : prev;
        });
      } else if (
        activeSource?.compatibilityLayer &&
        isSourceLayerHostSupported &&
        layers.length > 0
      ) {
        const targetRunner = activeSource.compatibilityLayer;
        const rawSavedBottle = activeSource.wineBottleName || '';
        const targetLayer = validLayers.find((l) => l.type === targetRunner);
        const targetBottles = targetLayer?.availableBottles || [];
        const isInTargetOptions =
          targetBottles.length === 0 || targetBottles.includes(rawSavedBottle);
        const isCompatibleWithTarget = isBottleNameCompatibleWithRunner(
          rawSavedBottle,
          targetRunner,
          { allLayers: layers }
        );
        const shouldSanitizeOnColdLoad = Boolean(
          rawSavedBottle &&
            (!isInTargetOptions || (currentHostArch !== 'arm64' && !isCompatibleWithTarget))
        );
        if (shouldSanitizeOnColdLoad) {
          setWineBottleName((prev) => (prev === rawSavedBottle ? '' : prev));
          setBaselineFieldsByPlatform((prev) => {
            const patched = patchLaunchConfigSignature(prev[currentPlatId], {
              wineBottleName: '',
            });
            return patched ? { ...prev, [currentPlatId]: patched } : prev;
          });
        }
      }
    });

    const formHostCaps = resolveFormHostCapabilities();

    if (formHostCaps.supportsWindowsTranslation) {
      const hasCachedUpdates = Object.keys(initialRunnerUpdates).length > 0;
      if (!hasCachedUpdates) {
        setIsCheckingUpdates(true);
      }
      launcherService
        .checkCompatibilityLayerUpdates()
        .then((updates) => {
          if (!active || formSessionIdRef.current !== effectSessionId) return;
          if (
            updates &&
            typeof updates === 'object' &&
            JSON.stringify(updates) !== JSON.stringify(initialRunnerUpdates)
          ) {
            setRunnerUpdates(updates);
          }
        })
        .catch(() => {})
        .finally(() => {
          if (active && formSessionIdRef.current === effectSessionId && !hasCachedUpdates) {
            setIsCheckingUpdates(false);
          }
        });
    }

    return () => {
      active = false;
      formSessionIdRef.current += 1;
      compatEditEpochByPlatformRef.current = {};
      userEditedCompatPlatformsRef.current.clear();
      userResetPendingDetectPlatformsRef.current.clear();
      hasDetectedLayersResolvedRef.current = false;
    };
  }, [isOpen, game.id, initialPlatformId]);

  // Keep read-only global defaults & discovered binary metadata synchronized while open
  useEffect(() => {
    if (!isOpen || typeof launcherService.subscribe !== 'function') return;
    const readInstallMetaSig = () => {
      const rec =
        typeof launcherService.getInstalledRecordForGame === 'function'
          ? launcherService.getInstalledRecordForGame(game, preferredPlatformId)
          : undefined;
      return `${rec?.installPath || ''}|${rec?.executablePath || ''}|${rec?.executableArchitecture || ''}|${rec?.is32BitExecutable ?? ''}`;
    };
    let prevInstallSig = readInstallMetaSig();
    return launcherService.subscribe(() => {
      const next = launcherService.getPerformanceSettings();
      setPerfSettings((prev) => (JSON.stringify(prev) === JSON.stringify(next) ? prev : next));
      const nextInstallSig = readInstallMetaSig();
      if (nextInstallSig !== prevInstallSig) {
        prevInstallSig = nextInstallSig;
        setInstallInfoTick((t) => t + 1);
      }
    });
  }, [isOpen, game, preferredPlatformId]);

  const wineSyncMode: WineSyncMode = resolveWineSyncMode(wineMsync, wineEsync);

  const activeInstalledVer = activeLayer?.version || activeUpdateInfo?.installedVersion;
  const activeInstalledBuild =
    activeLayer?.buildVersion || activeUpdateInfo?.installedBuildVersion;
  const activeInstalledDisplay =
    activeLayer?.displayVersion || activeUpdateInfo?.installedDisplayVersion;
  const activeSecondaryBuildText = useMemo(
    () =>
      formatRunnerSecondaryBuildText({
        installedVersion: activeInstalledVer,
        displayVersion: activeInstalledDisplay,
        buildVersion: activeInstalledBuild,
      }),
    [activeInstalledDisplay, activeInstalledVer, activeInstalledBuild]
  );

  const defaultBottleForLayer = resolveDefaultBottleForLayer(
    activeLayer,
    compatibilityLayer,
    selectedRunnerDescriptor?.defaultBottleName
  );
  const effectiveResolvedBottle = wineBottleName.trim() || defaultBottleForLayer;
  const resolvedBottleFolderPath =
    winePrefixPath.trim() ||
    (activeLayer?.bottlesDir
      ? effectiveResolvedBottle
        ? `${activeLayer.bottlesDir.replace(/\/+$/, '')}/${effectiveResolvedBottle}`
        : activeLayer.bottlesDir
      : undefined);

  const installedRecord = isOpen
    ? launcherService.getInstalledRecordForGame(game, preferredPlatformId)
    : undefined;

  const hostCapabilities = resolveFormHostCapabilities();
  const explicitRendererPlatform =
    typeof window !== 'undefined' ? window.electronAPI?.platform : undefined;
  const isWindowsHost =
    hostCapabilities.isWindows ||
    (!(explicitRendererPlatform === 'darwin' || explicitRendererPlatform === 'linux') &&
      /^[A-Za-z]:\\/.test(
        workingDirectory ||
          customExecutablePath ||
          installedRecord?.installPath ||
          installedRecord?.executablePath ||
          game.platforms.find((p) => p.platformId === preferredPlatformId)?.installPath ||
          game.platforms[0]?.installPath ||
          ''
      ));

  const isDxvkHudSupported =
    compatibilityLayer === 'wine' ||
    ((compatibilityLayer === 'crossover' ||
      compatibilityLayer === 'crossover_preview' ||
      compatibilityLayer === 'crossover_preview_arm64') &&
      (crossoverGraphicsBackend === 'auto' || crossoverGraphicsBackend === 'dxvk'));

  const primaryD3DVer =
    activeLayer?.availableD3DMetalVersions?.find((v) => v.isDefault || v.id === '4')?.version ||
    activeLayer?.d3dmetalVersion ||
    '4.0b3';
  const fallbackD3DVer =
    activeLayer?.availableD3DMetalVersions?.find((v) => v.id === '3')?.version || '3.0';
  const showD3DMetalVersionSelector =
    Boolean(
      activeLayer?.availableD3DMetalVersions
        ? activeLayer.availableD3DMetalVersions.length > 1
        : compatibilityLayer === 'crossover_preview' ||
          compatibilityLayer === 'crossover_preview_arm64'
    ) &&
    (crossoverGraphicsBackend === 'auto' || crossoverGraphicsBackend === 'd3dmetal');

  const preview = launcherService.resolveEffectiveLaunchModePreview(game, preferredPlatformId, {
    launchMethod,
    compatibilityLayer,
    wineBottleName: wineBottleName.trim() || undefined,
    winePrefixPath: winePrefixPath.trim() || undefined,
    customExecutablePath: customExecutablePath.trim() || undefined,
    workingDirectory: workingDirectory.trim() || undefined,
    storefrontClientLifecycle,
  });

  const dlssEligibility = resolveDlssEligibility({
    crossoverGraphicsBackend,
    activeLayer,
    preview,
  });
  const isDlssSupportedBackend = dlssEligibility.supported;
  const dlssUnavailableReason = dlssEligibility.reason;

  const handleToggleForceLargeAddressAware = useCallback(() => {
    setForceLargeAddressAware((prev) => !prev);
  }, []);

  const hostPlatform: 'darwin' | 'win32' | 'linux' = isWindowsHost
    ? 'win32'
    : preview.hostPlatform || 'darwin';

  const rawDisplayMethod: LaunchMethod = preview.availableModes.includes(launchMethod)
    ? launchMethod
    : preview.defaultLaunchMethod;
  const activeDisplayMethod: LaunchMethod =
    preview.modeNotes[rawDisplayMethod]?.disabled &&
    preview.availableModes.includes('direct') &&
    !preview.modeNotes.direct?.disabled
      ? 'direct'
      : rawDisplayMethod;

  const isBottleContextForPolicy =
    !isWindowsHost &&
    (preview.detectedBuildType === 'windows_exe_on_mac' ||
      activeDisplayMethod === 'compatibility_layer' ||
      preview.visibleSections.compatibilityLayer);

  const effectiveStorefrontClientLifecycle: StorefrontClientLifecyclePolicy =
    resolveEffectiveUiStorefrontLifecycle({
      preferredPlatformId,
      isBottleContext: isBottleContextForPolicy,
      storefrontClientLifecycle,
      fallbackGlobalLifecycle: perfSettings.storefrontClientLifecycle,
    });

  const fastLaunchAdvisory = launcherService.getFastMinimalLaunchAdvisory({
    platformId: preview.platformId,
    detectedBuildType: preview.detectedBuildType,
    hostPlatform,
    launchMethod: activeDisplayMethod,
    storefrontClientLifecycle,
    globalStorefrontLifecycle: perfSettings.storefrontClientLifecycle,
    isInstalled: preview.isInstalled,
    executablePath: preview.executablePath,
  });

  const policyView = launcherService.getStorefrontLaunchPolicyView({
    platformId: preferredPlatformId,
    detectedBuildType: preview.detectedBuildType,
    activeDisplayMethod,
    effectiveLifecycle: effectiveStorefrontClientLifecycle,
    isInstalled: preview.isInstalled,
    hostPlatform,
  });

  const isMacNativeBuild =
    preview.detectedBuildType === 'mac_native_app' ||
    preview.detectedBuildType === 'mac_native_bin';

  const isNativeInstalledBuild =
    isMacNativeBuild || preview.detectedBuildType === 'windows_native';

  const currentFieldsSignature = useMemo(
    () =>
      serializeLaunchConfigSignature({
        launchMethod,
        customExecutablePath,
        workingDirectory,
        launchArguments,
        compatibilityLayer,
        wineBottleName,
        winePrefixPath,
        crossoverGraphicsBackend,
        crossoverD3DMetalVersion,
        crossoverHighResolutionMode,
        crossoverDlss,
        preferredMaxFrameRate,
        metalfxSpatialUpscaleFactor,
        displayScalingMode,
        displayAspectRatio,
        virtualDesktopResolution,
        emulateModeset,
        forceLargeAddressAware,
        wineMsync,
        wineEsync,
        performanceHud,
        envText,
        preLaunchCommand,
        postExitCommand,
        inGameLauncherBehavior,
        storefrontClientLifecycle,
      }),
    [
      launchMethod,
      customExecutablePath,
      workingDirectory,
      launchArguments,
      compatibilityLayer,
      wineBottleName,
      winePrefixPath,
      crossoverGraphicsBackend,
      crossoverD3DMetalVersion,
      crossoverHighResolutionMode,
      crossoverDlss,
      preferredMaxFrameRate,
      metalfxSpatialUpscaleFactor,
      displayScalingMode,
      displayAspectRatio,
      virtualDesktopResolution,
      emulateModeset,
      forceLargeAddressAware,
      wineMsync,
      wineEsync,
      performanceHud,
      envText,
      preLaunchCommand,
      postExitCommand,
      inGameLauncherBehavior,
      storefrontClientLifecycle,
    ]
  );

  const hasUnsavedChanges = useMemo(() => {
    const activeBaseline = baselineFieldsByPlatform[preferredPlatformId];
    const activeDirty =
      activeBaseline !== undefined ? currentFieldsSignature !== activeBaseline : false;
    const inactiveDirty = dirtyInactivePlatforms.some((platId) => platId !== preferredPlatformId);
    const platformSwitchedDirty =
      baselineFieldsByPlatform[initialPlatformIdSnapshot] !== undefined &&
      preferredPlatformId !== initialPlatformIdSnapshot;
    return activeDirty || inactiveDirty || platformSwitchedDirty;
  }, [
    baselineFieldsByPlatform,
    preferredPlatformId,
    currentFieldsSignature,
    dirtyInactivePlatforms,
    initialPlatformIdSnapshot,
  ]);

  const buildProfileFromCurrentState = (): StorefrontLaunchProfile => {
    const priorSource =
      draftsByPlatform[preferredPlatformId] ??
      launcherService.getLaunchConfig(game.id, preferredPlatformId);
    return buildStorefrontLaunchProfile({
      fields: {
        launchMethod,
        customExecutablePath,
        workingDirectory,
        launchArguments,
        compatibilityLayer,
        wineBottleName,
        winePrefixPath,
        crossoverGraphicsBackend,
        crossoverD3DMetalVersion,
        crossoverHighResolutionMode,
        crossoverDlss,
        preferredMaxFrameRate,
        metalfxSpatialUpscaleFactor,
        displayScalingMode,
        displayAspectRatio,
        virtualDesktopResolution,
        emulateModeset,
        forceLargeAddressAware,
        wineMsync,
        wineEsync,
        performanceHud,
        envText,
        preLaunchCommand,
        postExitCommand,
        inGameLauncherBehavior,
        storefrontClientLifecycle,
      },
      isWindowsHost,
      preview,
      priorSource,
      perfSettings,
      isDlssSupportedBackend,
    });
  };

  // Keep latest state ref so memoized section callbacks retain stable identity across edits
  const latestRef = useRef({
    preferredPlatformId,
    draftsByPlatform,
    baselineFieldsByPlatform,
    currentFieldsSignature,
    customExecutablePath,
    workingDirectory,
    winePrefixPath,
    isWindowsHost,
    launchMethod,
    compatibilityLayer,
    wineBottleName,
    detectedLayers,
    resolvedBottleFolderPath,
    isNativeInstalledBuild,
    activeDisplayMethod,
    preview,
    wineMsync,
    wineEsync,
    loadFormFieldsForPlatform,
    buildProfileFromCurrentState,
    game,
  });
  latestRef.current = {
    preferredPlatformId,
    draftsByPlatform,
    baselineFieldsByPlatform,
    currentFieldsSignature,
    customExecutablePath,
    workingDirectory,
    winePrefixPath,
    isWindowsHost,
    launchMethod,
    compatibilityLayer,
    wineBottleName,
    detectedLayers,
    resolvedBottleFolderPath,
    isNativeInstalledBuild,
    activeDisplayMethod,
    preview,
    wineMsync,
    wineEsync,
    loadFormFieldsForPlatform,
    buildProfileFromCurrentState,
    game,
  };

  const handleSelectStorefront = useCallback((nextPlatId: StorefrontId) => {
    const cur = latestRef.current;
    if (nextPlatId === cur.preferredPlatformId) return;
    const prevPlatId = cur.preferredPlatformId;
    const prevBaseline = cur.baselineFieldsByPlatform[prevPlatId];
    const wasPrevDirty =
      prevBaseline !== undefined && cur.currentFieldsSignature !== prevBaseline;
    setDirtyInactivePlatforms((prev) => {
      const filtered = prev.filter((id) => id !== prevPlatId && id !== nextPlatId);
      return wasPrevDirty ? [...filtered, prevPlatId] : filtered;
    });
    const currentProfile = cur.buildProfileFromCurrentState();
    const nextDrafts: Partial<Record<StorefrontId, StorefrontLaunchProfile>> = {
      ...cur.draftsByPlatform,
      [prevPlatId]: currentProfile,
    };
    setDraftsByPlatform(nextDrafts);
    setPreferredPlatformId(nextPlatId);
    cur.loadFormFieldsForPlatform(nextPlatId, nextDrafts);
    if (!launcherService.isGameInstalled(cur.game, nextPlatId)) {
      const sessionId = formSessionIdRef.current;
      launcherService
        .getGameInstallInfo(cur.game, nextPlatId)
        .then(() => {
          if (formSessionIdRef.current !== sessionId) return;
          setInstallInfoTick((t) => t + 1);
        })
        .catch(() => {});
    }
  }, []);

  const visibleLaunchModes = buildVisibleLaunchModes({
    preview,
    isWindowsHost,
    isMacNativeBuild,
    isNativeInstalledBuild,
  });

  const handleBrowseExecutable = useCallback(async () => {
    const cur = latestRef.current;
    const selected = await launcherService.selectExecutable(
      cur.customExecutablePath || cur.workingDirectory || undefined
    );
    if (selected) {
      setCustomExecutablePath(selected);
      if (!cur.workingDirectory.trim()) {
        const lastSep = Math.max(selected.lastIndexOf('/'), selected.lastIndexOf('\\'));
        if (lastSep > 0) {
          setWorkingDirectory(selected.slice(0, lastSep));
        }
      }
      if (cur.isWindowsHost) {
        setLaunchMethod('direct');
        if (cur.preferredPlatformId === 'steam') {
          setStorefrontClientLifecycle('fast_direct_bypass');
        }
      } else if (selected.toLowerCase().endsWith('.exe')) {
        if (cur.launchMethod === 'direct' || cur.launchMethod === 'storefront_uri') {
          setLaunchMethod('compatibility_layer');
        }
      } else {
        setLaunchMethod('direct');
        if (cur.preferredPlatformId === 'steam') {
          setStorefrontClientLifecycle('fast_direct_bypass');
        }
      }
    }
  }, []);

  const handleBrowseWorkingDir = useCallback(async () => {
    const selected = await launcherService.selectFolder(
      latestRef.current.workingDirectory || undefined
    );
    if (selected) {
      setWorkingDirectory(selected);
    }
  }, []);

  const handleBrowseWinePrefix = useCallback(async () => {
    const selected = await launcherService.selectFolder(
      latestRef.current.winePrefixPath || undefined
    );
    if (selected) {
      setWinePrefixPath(selected);
    }
  }, []);

  const handleOpenBottleFolder = useCallback(async () => {
    const folderPath = latestRef.current.resolvedBottleFolderPath;
    if (!folderPath) return;
    if (typeof window !== 'undefined' && window.electronAPI?.browseLocalFiles) {
      await window.electronAPI.browseLocalFiles(folderPath);
    }
  }, []);

  const handleSelectCompatibilityLayer = useCallback(
    (nextLayer: CompatibilityLayerType) => {
      const cur = latestRef.current;
      compatEditEpochByPlatformRef.current[cur.preferredPlatformId] =
        (compatEditEpochByPlatformRef.current[cur.preferredPlatformId] ?? 0) + 1;
      userEditedCompatPlatformsRef.current.add(cur.preferredPlatformId);
      userResetPendingDetectPlatformsRef.current.delete(cur.preferredPlatformId);
      setCompatibilityLayer(nextLayer);
      if (cur.wineBottleName) {
        const nextLayerObj = cur.detectedLayers.find((l) => l.type === nextLayer);
        const nextAvailable = nextLayerObj?.availableBottles || [];
        const isCompatible = isBottleNameCompatibleWithRunner(cur.wineBottleName, nextLayer, {
          allLayers: cur.detectedLayers,
        });
        const isInNextAvailable =
          nextAvailable.length === 0 || nextAvailable.includes(cur.wineBottleName);
        if (!isCompatible || !isInNextAvailable) {
          setWineBottleName('');
        }
      }
      clearRunnerFeedback();
    },
    [clearRunnerFeedback]
  );

  const handleChangeWineBottleName = useCallback((value: SetStateAction<string>) => {
    const curPlatId = latestRef.current.preferredPlatformId;
    userEditedCompatPlatformsRef.current.add(curPlatId);
    userResetPendingDetectPlatformsRef.current.delete(curPlatId);
    setWineBottleName(value);
  }, []);

  const handleSetCrossoverHighResolutionMode = useCallback((value: boolean | undefined) => {
    setCrossoverHighResolutionMode(value === false ? false : undefined);
  }, []);

  const handleToggleLegacy96DpiMode = useCallback(() => {
    setCrossoverHighResolutionMode((prev) => (prev === false ? undefined : false));
  }, []);

  /** @deprecated Legacy alias forwarding to unified `performanceHud` state */
  const handleToggleMetalHud = useCallback(() => {
    setPerformanceHud((prev) => (prev === 'on' ? 'off' : 'on'));
  }, []);

  /** @deprecated Legacy alias forwarding to unified `performanceHud` state */
  const handleToggleDxvkHud = useCallback(() => {
    setPerformanceHud((prev) => (prev === 'on' ? 'off' : 'on'));
  }, []);

  const handleToggleCrossoverDlss = useCallback(() => {
    setCrossoverDlss((prev) => !prev);
  }, []);

  const handleToggleWineMsync = useCallback(() => {
    const next = !latestRef.current.wineMsync;
    setWineMsync(next);
    if (next) {
      setWineEsync(false);
    }
  }, []);

  const handleToggleWineEsync = useCallback(() => {
    const next = !latestRef.current.wineEsync;
    setWineEsync(next);
    if (next) {
      setWineMsync(false);
    }
  }, []);

  const handleSelectWineSyncMode = useCallback((mode: WineSyncMode) => {
    if (mode === 'msync') {
      setWineMsync(true);
      setWineEsync(false);
    } else if (mode === 'esync') {
      setWineMsync(false);
      setWineEsync(true);
    } else {
      setWineMsync(false);
      setWineEsync(false);
    }
  }, []);

  const handleChangeStorefrontClientLifecycle = useCallback(
    (val: StorefrontClientLifecyclePolicy) => {
      setStorefrontClientLifecycle(val);
      const cur = latestRef.current;
      if (cur.isNativeInstalledBuild && cur.preferredPlatformId === 'steam') {
        if (val === 'fast_direct_bypass') {
          setLaunchMethod('direct');
        } else if (
          (cur.launchMethod === 'direct' || cur.activeDisplayMethod === 'direct') &&
          !cur.preview.modeNotes.storefront_uri?.disabled
        ) {
          setLaunchMethod('storefront_uri');
        }
      } else if (
        !cur.isWindowsHost &&
        cur.preferredPlatformId !== 'custom' &&
        cur.launchMethod === 'direct' &&
        val !== 'fast_direct_bypass'
      ) {
        setLaunchMethod(
          cur.preview.availableModes.includes('auto')
            ? 'auto'
            : cur.preview.availableModes.includes('compatibility_layer')
              ? 'compatibility_layer'
              : cur.preview.defaultLaunchMethod
        );
      }
    },
    []
  );

  const handleResetDefaults = async () => {
    const sessionId = formSessionIdRef.current;
    const targetPlatId = preferredPlatformId;
    compatEditEpochByPlatformRef.current[targetPlatId] =
      (compatEditEpochByPlatformRef.current[targetPlatId] ?? 0) + 1;
    userEditedCompatPlatformsRef.current.add(targetPlatId);
    if (!hasDetectedLayersResolvedRef.current && latestDetectedLayersRef.current.length === 0) {
      userResetPendingDetectPlatformsRef.current.add(targetPlatId);
    } else {
      userResetPendingDetectPlatformsRef.current.delete(targetPlatId);
    }
    await launcherService.resetLaunchConfig(game.id, targetPlatId);
    if (formSessionIdRef.current !== sessionId) return;
    setDraftsByPlatform((prev) => {
      const next = { ...prev };
      delete next[targetPlatId];
      return next;
    });
    const resetHostArch =
      typeof launcherService.getHostArch === 'function' ? launcherService.getHostArch() : 'arm64';
    const currentLayers = latestDetectedLayersRef.current;
    const validLayers = currentLayers.filter(
      (l) => l.available !== false && isHostSupportedCompatRunner(l.type, resetHostArch)
    );
    const resetPreview = launcherService.resolveEffectiveLaunchModePreview(game, targetPlatId, {});
    const resetLayer: CompatibilityLayerType = validLayers[0]?.type || 'crossover';
    if (latestRef.current.preferredPlatformId !== targetPlatId) {
      return;
    }
    setLaunchMethod(resetPreview.defaultLaunchMethod);
    setCustomExecutablePath('');
    setWorkingDirectory('');
    setLaunchArguments('');
    setCompatibilityLayer(resetLayer);
    setWineBottleName('');
    setWinePrefixPath('');
    setCrossoverGraphicsBackend('auto');
    setCrossoverD3DMetalVersion('auto');
    setCrossoverHighResolutionMode(undefined);
    setCrossoverDlss(false);
    setPreferredMaxFrameRate(undefined);
    setMetalfxSpatialUpscaleFactor(undefined);
    setDisplayScalingMode('default');
    setDisplayAspectRatio('default');
    setVirtualDesktopResolution('auto');
    setEmulateModeset(undefined);
    setForceLargeAddressAware(undefined);
    setWineMsync(true);
    setWineEsync(false);
    setPerformanceHud('default');
    setEnvText('');
    setPreLaunchCommand('');
    setPostExitCommand('');
    setInGameLauncherBehavior('default');
    setStorefrontClientLifecycle('default');
    const resetPerf = launcherService.getPerformanceSettings();
    setPerfSettings(resetPerf);
    setDirtyInactivePlatforms((prev) => prev.filter((id) => id !== targetPlatId));
    const resetSignature = serializeLaunchConfigSignature({
      launchMethod: resetPreview.defaultLaunchMethod,
      customExecutablePath: '',
      workingDirectory: '',
      launchArguments: '',
      compatibilityLayer: resetLayer,
      wineBottleName: '',
      winePrefixPath: '',
      crossoverGraphicsBackend: 'auto',
      crossoverD3DMetalVersion: 'auto',
      crossoverHighResolutionMode: undefined,
      crossoverDlss: false,
      preferredMaxFrameRate: undefined,
      metalfxSpatialUpscaleFactor: undefined,
      displayScalingMode: 'default',
      displayAspectRatio: 'default',
      virtualDesktopResolution: 'auto',
      emulateModeset: undefined,
      forceLargeAddressAware: undefined,
      wineMsync: true,
      wineEsync: false,
      performanceHud: 'default',
      envText: '',
      preLaunchCommand: '',
      postExitCommand: '',
      inGameLauncherBehavior: 'default',
      storefrontClientLifecycle: 'default',
    });
    setBaselineFieldsByPlatform((prev) => ({
      ...prev,
      [targetPlatId]: resetSignature,
    }));
    clearRunnerFeedback();
    setSaveError(null);
  };

  const handleSave = async () => {
    setIsSaving(true);
    setSaveError(null);
    try {
      const activeProfile = buildProfileFromCurrentState();
      const allPlatformConfigs: Partial<Record<StorefrontId, StorefrontLaunchProfile>> = {
        ...draftsByPlatform,
        [preferredPlatformId]: activeProfile,
      };
      const config: GameLaunchConfig = {
        gameId: game.id,
        preferredPlatformId,
        launchMethod: activeProfile.launchMethod || preview.defaultLaunchMethod,
        ...activeProfile,
        platformConfigs: allPlatformConfigs,
      };

      // Per-game save strictly writes ONLY per-game config — never mutates global settings!
      await launcherService.saveLaunchConfig(config, preferredPlatformId);

      if (typeof window !== 'undefined') {
        for (const [platId, prof] of Object.entries(allPlatformConfigs)) {
          if (prof?.customExecutablePath) {
            const platGameId =
              game.platforms.find((p) => p.platformId === platId)?.platformGameId || game.id;
            window.dispatchEvent(
              new CustomEvent('antigravity:game-installed', {
                detail: {
                  gameId: game.id,
                  platformId: platId as StorefrontId,
                  platformGameId: platGameId,
                  installPath: prof.workingDirectory || prof.customExecutablePath,
                  executablePath: prof.customExecutablePath,
                  installed: true,
                  isWindowsBinaryOnMac:
                    !isWindowsHost && /\.exe$/i.test(prof.customExecutablePath),
                },
              })
            );
          }
        }
      }

      onSaved?.(config);
      onClose();
    } catch (err: unknown) {
      const msg =
        err instanceof Error && err.message
          ? err.message
          : 'Failed to save launch configuration.';
      setSaveError(msg);
    } finally {
      setIsSaving(false);
    }
  };

  const buildBadgeTone: 'emerald' | 'sky' | 'amber' | 'slate' =
    preview.detectedBuildType === 'mac_native_app' ||
    preview.detectedBuildType === 'mac_native_bin' ||
    preview.detectedBuildType === 'windows_native'
      ? 'emerald'
      : preview.detectedBuildType === 'windows_exe_on_mac'
        ? 'amber'
        : 'slate';

  const activeModeNote =
    isWindowsHost && launchMethod === 'compatibility_layer'
      ? undefined
      : preview.modeNotes[launchMethod] || preview.modeNotes[activeDisplayMethod];
  const activeModeWarning = activeModeNote?.warning;
  const discoveredTargetPath = preview.executablePath || preview.installPath;

  const executablePathLabel = !preview.isInstalled
    ? 'Locate Existing Local Executable'
    : isWindowsHost
      ? 'Executable Path (.exe)'
      : isMacNativeBuild
        ? 'Application Bundle or Binary Path (.app / Mach-O)'
        : preview.detectedBuildType === 'windows_exe_on_mac'
          ? 'Windows Executable Path (.exe)'
          : 'Executable Path (.app, binary, or Windows .exe)';

  const displayOverrideCount =
    (displayAspectRatio !== 'default' ? 1 : 0) +
    (displayScalingMode === 'force_fullscreen' ||
    displayScalingMode === 'virtual_desktop' ||
    displayScalingMode === 'native_driver'
      ? 1
      : 0) +
    (crossoverHighResolutionMode === false ? 1 : 0) +
    (emulateModeset !== undefined ? 1 : 0);

  const isMetalfxSpatialEligible = resolveMetalfxSpatialEligibility({
    crossoverGraphicsBackend,
  }).supported;

  const compatOverrideCount =
    (showD3DMetalVersionSelector && crossoverD3DMetalVersion !== 'auto' ? 1 : 0) +
    (isMetalfxSpatialEligible && metalfxSpatialUpscaleFactor !== undefined ? 1 : 0) +
    (wineSyncMode !== 'msync' ? 1 : 0) +
    (forceLargeAddressAware === true ? 1 : 0) +
    (winePrefixPath.trim() ? 1 : 0);

  const executionOverrideCount =
    (launchArguments.trim() ? 1 : 0) +
    (customExecutablePath.trim() ? 1 : 0) +
    (workingDirectory.trim() ? 1 : 0) +
    (envText.trim() ? 1 : 0) +
    (preLaunchCommand.trim() ? 1 : 0) +
    (postExitCommand.trim() ? 1 : 0);

  const lifecycleOverrideCount =
    (inGameLauncherBehavior !== 'default' ? 1 : 0) +
    (storefrontClientLifecycle !== 'default' ? 1 : 0);

  return {
    preferredPlatformId,
    draftsByPlatform,
    launchMethod,
    setLaunchMethod,
    customExecutablePath,
    setCustomExecutablePath,
    workingDirectory,
    setWorkingDirectory,
    launchArguments,
    setLaunchArguments,
    compatibilityLayer,
    wineBottleName,
    setWineBottleName: handleChangeWineBottleName,
    winePrefixPath,
    setWinePrefixPath,
    crossoverGraphicsBackend,
    setCrossoverGraphicsBackend,
    crossoverD3DMetalVersion,
    setCrossoverD3DMetalVersion,
    crossoverHighResolutionMode,
    setCrossoverHighResolutionMode: handleSetCrossoverHighResolutionMode,
    handleToggleLegacy96DpiMode,
    crossoverDlss,
    preferredMaxFrameRate,
    setPreferredMaxFrameRate,
    metalfxSpatialUpscaleFactor,
    setMetalfxSpatialUpscaleFactor,
    displayScalingMode,
    setDisplayScalingMode,
    displayAspectRatio,
    setDisplayAspectRatio,
    virtualDesktopResolution,
    setVirtualDesktopResolution,
    emulateModeset,
    setEmulateModeset,
    forceLargeAddressAware,
    setForceLargeAddressAware,
    wineMsync,
    wineEsync,
    wineSyncMode,
    performanceHud,
    setPerformanceHud,
    /** @deprecated Derived alias for legacy hook consumers; persisted state uses `performanceHud` */
    metalHud: performanceHud === 'on',
    /** @deprecated Derived alias for legacy hook consumers; persisted state uses `performanceHud` */
    dxvkHud: performanceHud === 'on',
    envText,
    setEnvText,
    preLaunchCommand,
    setPreLaunchCommand,
    postExitCommand,
    setPostExitCommand,
    inGameLauncherBehavior,
    setInGameLauncherBehavior,
    storefrontClientLifecycle,
    setStorefrontClientLifecycle,
    perfSettings,
    hasUnsavedChanges,
    displayOverrideCount,
    compatOverrideCount,
    executionOverrideCount,
    lifecycleOverrideCount,
    detectedLayers,
    isSaving,
    saveError,
    isInstallingRunner: runnerLifecycle.isInstallingRunner,
    isAnotherRunnerOperationActive: runnerLifecycle.isAnotherRunnerOperationActive,
    isRescanningRunners: runnerLifecycle.isRescanningRunners,
    runnerActionFeedback: runnerLifecycle.runnerActionFeedback,
    runnerUpdates,
    isCheckingUpdates: runnerLifecycle.isCheckingUpdates,
    isUpdatingRunner: runnerLifecycle.isUpdatingRunner,
    runnerUpdateFeedback: runnerLifecycle.runnerUpdateFeedback,
    runnerProgressByType: runnerLifecycle.runnerProgressByType,
    activeRunnerProgress: runnerLifecycle.activeRunnerProgress,
    selectedRunnerDescriptor,
    activeLayer,
    activeUpdateInfo,
    availableBottles,
    activeInstalledVer,
    activeSecondaryBuildText,
    resolvedBottleFolderPath,
    isWindowsHost,
    isDlssSupportedBackend,
    dlssUnavailableReason,
    isDxvkHudSupported,
    primaryD3DVer,
    fallbackD3DVer,
    showD3DMetalVersionSelector,
    preview,
    activeDisplayMethod,
    effectiveStorefrontClientLifecycle,
    fastLaunchAdvisory,
    policyView,
    isMacNativeBuild,
    isNativeInstalledBuild,
    visibleLaunchModes,
    buildBadgeTone,
    activeModeWarning,
    discoveredTargetPath,
    executablePathLabel,
    handleSelectStorefront,
    handleBrowseExecutable,
    handleBrowseWorkingDir,
    handleBrowseWinePrefix,
    handleRescanLayers: runnerLifecycle.handleRescanLayers,
    handleCheckRunnerUpdates: runnerLifecycle.handleCheckRunnerUpdates,
    handleUpdateRunner: runnerLifecycle.handleUpdateRunner,
    handleInstallRunnerViaBrew: runnerLifecycle.handleInstallRunnerViaBrew,
    handleInstallRunnerFromArchive: runnerLifecycle.handleInstallRunnerFromArchive,
    handleCancelRunnerOperation: runnerLifecycle.handleCancelRunnerOperation,
    handleSwitchToStableCrossOver: runnerLifecycle.handleSwitchToStableCrossOver,
    handleDownloadRunner: runnerLifecycle.handleDownloadRunner,
    handleOpenBottleFolder,
    handleSelectCompatibilityLayer,
    handleToggleCrossoverDlss,
    handleToggleForceLargeAddressAware,
    handleToggleWineMsync,
    handleToggleWineEsync,
    handleSelectWineSyncMode,
    handleToggleMetalHud,
    handleToggleDxvkHud,
    handleChangeStorefrontClientLifecycle,
    handleResetDefaults,
    handleSave,
  };
}
