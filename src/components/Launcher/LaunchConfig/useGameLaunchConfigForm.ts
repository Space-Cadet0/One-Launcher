import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { CanonicalGame } from '../../../contracts/game';
import { StorefrontId } from '../../../contracts/platform';
import {
  CompatibilityLayerInfo,
  CompatibilityLayerType,
  CompatibilityLayerUpdateInfo,
  CrossOverD3DMetalVersion,
  CrossOverGraphicsBackend,
  GameLaunchConfig,
  InGameLauncherBehavior,
  LauncherPerformanceSettings,
  LaunchMethod,
  PostGameLauncherBehavior,
  StorefrontClientLifecyclePolicy,
  StorefrontLaunchProfile,
} from '../../../contracts/launcher';
import {
  launcherService,
  COMPATIBILITY_RUNNER_DESCRIPTORS,
} from '../../../services/launcher/launcherService';
import { acquireModalOverlayLock } from '../../../utils/modalOverlayLock';
import {
  LAUNCH_MODES,
  parseEnvVars,
  resolveEffectiveUiStorefrontLifecycle,
  serializeEnvVars,
  stripManagedEnvVars,
} from './launchConfigHelpers';

interface LauncherServiceHostAware {
  isWindowsHost?: () => boolean;
}

function checkLauncherWindowsHost(): boolean {
  const svc = launcherService as typeof launcherService & LauncherServiceHostAware;
  return typeof svc.isWindowsHost === 'function' ? Boolean(svc.isWindowsHost()) : false;
}

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
  const [preferredPlatformId, setPreferredPlatformId] = useState<StorefrontId>('steam');
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
  const [wineMsync, setWineMsync] = useState<boolean>(true);
  const [wineEsync, setWineEsync] = useState<boolean>(false);
  const [metalHud, setMetalHud] = useState<boolean>(false);
  const [dxvkHud, setDxvkHud] = useState<boolean>(false);
  const [envText, setEnvText] = useState<string>('');
  const [preLaunchCommand, setPreLaunchCommand] = useState<string>('');
  const [postExitCommand, setPostExitCommand] = useState<string>('');
  const [inGameLauncherBehavior, setInGameLauncherBehavior] = useState<
    'default' | InGameLauncherBehavior
  >('default');
  const [storefrontClientLifecycle, setStorefrontClientLifecycle] = useState<
    'default' | StorefrontClientLifecyclePolicy
  >('default');
  const [perfSettings, setPerfSettings] = useState<LauncherPerformanceSettings>(() =>
    launcherService.getPerformanceSettings()
  );
  const [hasEditedGlobalPerfSettings, setHasEditedGlobalPerfSettings] = useState<boolean>(false);
  const [detectedLayers, setDetectedLayers] = useState<CompatibilityLayerInfo[]>([]);
  const [isSaving, setIsSaving] = useState<boolean>(false);
  const [isInstallingRunner, setIsInstallingRunner] = useState<boolean>(false);
  const [isRescanningRunners, setIsRescanningRunners] = useState<boolean>(false);
  const [runnerActionFeedback, setRunnerActionFeedback] = useState<{
    tone: 'emerald' | 'amber' | 'sky';
    text: string;
  } | null>(null);
  const [runnerUpdates, setRunnerUpdates] = useState<Record<string, CompatibilityLayerUpdateInfo>>(
    () => launcherService.getRunnerUpdates()
  );
  const [isCheckingUpdates, setIsCheckingUpdates] = useState<boolean>(false);
  const [isUpdatingRunner, setIsUpdatingRunner] = useState<boolean>(false);
  const [runnerUpdateFeedback, setRunnerUpdateFeedback] = useState<string | null>(null);
  const [, setInstallInfoTick] = useState(0);

  const loadFormFieldsForPlatform = useCallback(
    (
      targetPlatId: StorefrontId,
      drafts?: Partial<Record<StorefrontId, StorefrontLaunchProfile>>,
      layersOverride?: CompatibilityLayerInfo[]
    ) => {
      const source =
        drafts?.[targetPlatId] ?? launcherService.getLaunchConfig(game.id, targetPlatId);
      const activeLayers = (layersOverride || detectedLayers).filter((l) =>
        COMPATIBILITY_RUNNER_DESCRIPTORS.some((d) => d.type === l.type)
      );
      const initialPreview = launcherService.resolveEffectiveLaunchModePreview(
        game,
        targetPlatId,
        source
      );
      const isInitialNativeBuild =
        initialPreview.detectedBuildType === 'mac_native_app' ||
        initialPreview.detectedBuildType === 'mac_native_bin' ||
        initialPreview.detectedBuildType === 'windows_native';

      let resolvedMethod: LaunchMethod;
      if (
        source?.launchMethod &&
        source.launchMethod !== 'auto' &&
        initialPreview.availableModes.includes(source.launchMethod)
      ) {
        resolvedMethod = source.launchMethod;
      } else if (
        source?.launchMethod === 'auto' &&
        initialPreview.availableModes.includes('auto')
      ) {
        resolvedMethod = 'auto';
      } else if (
        isInitialNativeBuild &&
        targetPlatId === 'steam' &&
        source?.storefrontClientLifecycle === 'fast_direct_bypass' &&
        initialPreview.availableModes.includes('direct')
      ) {
        resolvedMethod = 'direct';
      } else {
        resolvedMethod = initialPreview.defaultLaunchMethod;
      }
      setLaunchMethod(resolvedMethod);

      setCustomExecutablePath(source?.customExecutablePath || '');
      setWorkingDirectory(source?.workingDirectory || '');
      setLaunchArguments(source?.launchArguments || '');
      const defaultLayer: CompatibilityLayerType =
        source?.compatibilityLayer &&
        COMPATIBILITY_RUNNER_DESCRIPTORS.some((d) => d.type === source.compatibilityLayer)
          ? source.compatibilityLayer
          : activeLayers[0]?.type && activeLayers[0].type !== 'native'
            ? activeLayers[0].type
            : 'crossover';
      setCompatibilityLayer(defaultLayer);
      setWineBottleName(source?.wineBottleName || '');
      setWinePrefixPath(source?.winePrefixPath || '');
      setCrossoverGraphicsBackend(source?.crossoverGraphicsBackend || 'auto');
      setCrossoverD3DMetalVersion(
        source?.crossoverD3DMetalVersion ||
          (source?.environmentVariables?.CX_GRAPHICS_BACKEND_VERSION === '3' ||
          source?.environmentVariables?.CX_GRAPHICS_BACKEND_VERSION === '4'
            ? source.environmentVariables.CX_GRAPHICS_BACKEND_VERSION
            : 'auto')
      );
      setCrossoverHighResolutionMode(source?.crossoverHighResolutionMode);
      setCrossoverDlss(Boolean(source?.crossoverDlss));
      const loadedMsync =
        source?.wineMsync !== undefined
          ? source.wineMsync
          : source?.environmentVariables?.WINEMSYNC === '0'
            ? false
            : true;
      let loadedEsync =
        source?.wineEsync !== undefined
          ? source.wineEsync
          : source?.environmentVariables?.WINEESYNC === '1'
            ? true
            : false;
      if (loadedMsync && loadedEsync) {
        loadedEsync = false;
      }
      setWineMsync(loadedMsync);
      setWineEsync(loadedEsync);
      setMetalHud(
        source?.metalHud !== undefined
          ? source.metalHud
          : source?.environmentVariables?.MTL_HUD_ENABLED === '1'
      );
      setDxvkHud(
        source?.dxvkHud !== undefined
          ? source.dxvkHud
          : Boolean(source?.environmentVariables?.DXVK_HUD)
      );
      setEnvText(serializeEnvVars(stripManagedEnvVars(source?.environmentVariables)));
      setPreLaunchCommand(source?.preLaunchCommand || '');
      setPostExitCommand(source?.postExitCommand || '');
      setInGameLauncherBehavior(source?.inGameLauncherBehavior || 'default');
      const isWinHostForLoad =
        initialPreview.hostPlatform === 'win32' ||
        checkLauncherWindowsHost() ||
        (typeof window !== 'undefined' && window.electronAPI?.platform === 'win32');
      const isBottleContextForLoad =
        !isWinHostForLoad &&
        (initialPreview.detectedBuildType === 'windows_exe_on_mac' ||
          resolvedMethod === 'compatibility_layer' ||
          initialPreview.visibleSections.compatibilityLayer);
      if (source?.storefrontClientLifecycle && source.storefrontClientLifecycle !== 'default') {
        if (
          targetPlatId === 'gog' &&
          !isBottleContextForLoad &&
          source.storefrontClientLifecycle === 'default_client'
        ) {
          setStorefrontClientLifecycle('minimal_keep_running');
        } else {
          setStorefrontClientLifecycle(source.storefrontClientLifecycle);
        }
      } else {
        setStorefrontClientLifecycle('default');
      }
      setRunnerActionFeedback(null);
      setRunnerUpdateFeedback(null);
    },
    [game, detectedLayers]
  );

  useEffect(() => {
    if (!isOpen) return;
    let active = true;

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

    setDraftsByPlatform(initialDrafts);
    setPreferredPlatformId(startPlatId);
    setPerfSettings(launcherService.getPerformanceSettings());
    setHasEditedGlobalPerfSettings(false);

    const initialLayers = launcherService.getCompatibilityLayers();
    const initialRunnerUpdates = launcherService.getRunnerUpdates();
    setDetectedLayers(initialLayers);
    setRunnerUpdates(initialRunnerUpdates);
    loadFormFieldsForPlatform(startPlatId, initialDrafts, initialLayers);

    launcherService
      .detectInstalledStorefrontClients()
      .then(() => {
        if (!active) return;
        setInstallInfoTick((t) => t + 1);
      })
      .catch(() => {});

    if (!launcherService.isGameInstalled(game, startPlatId)) {
      launcherService
        .getGameInstallInfo(game, startPlatId)
        .then(() => {
          if (!active) return;
          setInstallInfoTick((t) => t + 1);
        })
        .catch(() => {});
    }

    launcherService.detectCompatibilityLayers().then((layers) => {
      if (!active) return;
      if (JSON.stringify(layers) !== JSON.stringify(initialLayers)) {
        setDetectedLayers(layers);
      }
      const validLayers = layers.filter((l) =>
        COMPATIBILITY_RUNNER_DESCRIPTORS.some((d) => d.type === l.type)
      );
      const activeSource =
        initialDrafts[startPlatId] ?? launcherService.getLaunchConfig(game.id, startPlatId);
      if (!activeSource?.compatibilityLayer && validLayers.length > 0) {
        setCompatibilityLayer((prev) =>
          prev === validLayers[0].type ? prev : validLayers[0].type
        );
      }
    });

    const winHost =
      checkLauncherWindowsHost() ||
      (typeof window !== 'undefined' && window.electronAPI?.platform === 'win32');

    if (!winHost) {
      const hasCachedUpdates = Object.keys(initialRunnerUpdates).length > 0;
      if (!hasCachedUpdates) {
        setIsCheckingUpdates(true);
      }
      launcherService
        .checkCompatibilityLayerUpdates()
        .then((updates) => {
          if (!active) return;
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
          if (active && !hasCachedUpdates) setIsCheckingUpdates(false);
        });
    }

    return () => {
      active = false;
    };
  }, [isOpen, game.id, initialPlatformId]);

  useEffect(() => {
    if (!isOpen) return;
    return acquireModalOverlayLock();
  }, [isOpen]);

  const selectedRunnerDescriptor =
    COMPATIBILITY_RUNNER_DESCRIPTORS.find((d) => d.type === compatibilityLayer) ||
    COMPATIBILITY_RUNNER_DESCRIPTORS[0];
  const activeLayer = detectedLayers.find((l) => l.type === compatibilityLayer);
  const activeUpdateInfo = runnerUpdates[compatibilityLayer];
  const availableBottles = activeLayer?.availableBottles || [];

  const activeInstalledVer = activeLayer?.version || activeUpdateInfo?.installedVersion;
  const activeInstalledBuild =
    activeLayer?.buildVersion || activeUpdateInfo?.installedBuildVersion;
  const activeInstalledDisplay =
    activeLayer?.displayVersion || activeUpdateInfo?.installedDisplayVersion;
  const activeSecondaryBuildText = useMemo(() => {
    const parts: string[] = [];
    if (
      activeInstalledDisplay &&
      activeInstalledDisplay !== activeInstalledVer &&
      activeInstalledDisplay !== `v${activeInstalledVer}`
    ) {
      parts.push(activeInstalledDisplay);
    }
    if (
      activeInstalledBuild &&
      (!activeInstalledDisplay || !activeInstalledDisplay.includes(activeInstalledBuild))
    ) {
      parts.push(`Build ${activeInstalledBuild}`);
    }
    return parts.join(' • ');
  }, [activeInstalledDisplay, activeInstalledVer, activeInstalledBuild]);

  const resolvedBottleFolderPath =
    winePrefixPath.trim() ||
    (activeLayer?.bottlesDir
      ? wineBottleName.trim() || activeLayer.availableBottles?.[0]
        ? `${activeLayer.bottlesDir.replace(/\/+$/, '')}/${
            wineBottleName.trim() || activeLayer.availableBottles![0]
          }`
        : activeLayer.bottlesDir
      : undefined);

  const installedRecord = isOpen
    ? launcherService.getInstalledRecordForGame(game, preferredPlatformId)
    : undefined;

  const explicitRendererPlatform =
    typeof window !== 'undefined' ? window.electronAPI?.platform : undefined;
  const isWindowsHost =
    explicitRendererPlatform === 'darwin' || explicitRendererPlatform === 'linux'
      ? false
      : checkLauncherWindowsHost() ||
        explicitRendererPlatform === 'win32' ||
        /^[A-Za-z]:\\/.test(
          workingDirectory ||
            customExecutablePath ||
            installedRecord?.installPath ||
            installedRecord?.executablePath ||
            game.platforms.find((p) => p.platformId === preferredPlatformId)?.installPath ||
            game.platforms[0]?.installPath ||
            ''
        );

  const isDlssSupportedBackend =
    crossoverGraphicsBackend === 'auto' ||
    crossoverGraphicsBackend === 'd3dmetal' ||
    crossoverGraphicsBackend === 'dxmt';

  const isDxvkHudSupported =
    compatibilityLayer === 'wine' ||
    ((compatibilityLayer === 'crossover' || compatibilityLayer === 'crossover_preview') &&
      (crossoverGraphicsBackend === 'auto' || crossoverGraphicsBackend === 'dxvk'));

  const primaryD3DVer =
    activeLayer?.availableD3DMetalVersions?.find((v) => v.isDefault || v.id === '4')?.version ||
    activeLayer?.d3dmetalVersion ||
    '4.0b3';
  const fallbackD3DVer =
    activeLayer?.availableD3DMetalVersions?.find((v) => v.id === '3')?.version || '3.0';
  const showD3DMetalVersionSelector =
    (compatibilityLayer === 'crossover_preview' ||
      Boolean(
        activeLayer?.availableD3DMetalVersions && activeLayer.availableD3DMetalVersions.length > 1
      )) &&
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

  const buildProfileFromCurrentState = (): StorefrontLaunchProfile => {
    const parsedEnv = stripManagedEnvVars(parseEnvVars(envText)) || {};
    const includeCompatSettings = !isWindowsHost && preview.visibleSections.compatibilityLayer;
    const includeCrossoverOnly =
      includeCompatSettings && preview.visibleSections.crossoverRendering;
    const includeMetalHud =
      !isWindowsHost &&
      (preview.visibleSections.compatibilityLayer || preview.visibleSections.nativeMacMetalHud);

    const candidateMethod: LaunchMethod =
      isWindowsHost && launchMethod === 'compatibility_layer'
        ? preview.defaultLaunchMethod
        : preview.availableModes.includes(launchMethod)
          ? launchMethod
          : preview.defaultLaunchMethod;
    const normalizedMethod: LaunchMethod =
      preview.modeNotes[candidateMethod]?.disabled &&
      preview.availableModes.includes('direct') &&
      !preview.modeNotes.direct?.disabled
        ? 'direct'
        : candidateMethod;

    return {
      launchMethod: normalizedMethod,
      customExecutablePath: customExecutablePath.trim() || undefined,
      workingDirectory: workingDirectory.trim() || undefined,
      launchArguments: launchArguments.trim() || undefined,
      compatibilityLayer:
        includeCompatSettings && compatibilityLayer !== 'native' ? compatibilityLayer : undefined,
      wineBottleName: includeCompatSettings ? wineBottleName.trim() || undefined : undefined,
      winePrefixPath: includeCompatSettings ? winePrefixPath.trim() || undefined : undefined,
      crossoverGraphicsBackend: includeCrossoverOnly ? crossoverGraphicsBackend : undefined,
      crossoverD3DMetalVersion:
        includeCrossoverOnly && crossoverD3DMetalVersion !== 'auto'
          ? crossoverD3DMetalVersion
          : undefined,
      crossoverHighResolutionMode: includeCompatSettings ? crossoverHighResolutionMode : undefined,
      crossoverDlss: includeCrossoverOnly
        ? isDlssSupportedBackend
          ? crossoverDlss
          : false
        : undefined,
      wineMsync: includeCompatSettings ? wineMsync : undefined,
      wineEsync: includeCompatSettings ? wineEsync : undefined,
      metalHud: includeMetalHud ? (metalHud ? true : undefined) : undefined,
      dxvkHud:
        includeCompatSettings && isDxvkHudSupported ? (dxvkHud ? true : undefined) : undefined,
      environmentVariables: Object.keys(parsedEnv).length > 0 ? parsedEnv : undefined,
      preLaunchCommand: preLaunchCommand.trim() || undefined,
      postExitCommand: postExitCommand.trim() || undefined,
      inGameLauncherBehavior:
        inGameLauncherBehavior !== 'default' ? inGameLauncherBehavior : undefined,
      storefrontClientLifecycle:
        storefrontClientLifecycle !== 'default' ? storefrontClientLifecycle : undefined,
    };
  };

  // Keep latest state ref so memoized section callbacks retain stable identity across edits
  const latestRef = useRef({
    preferredPlatformId,
    draftsByPlatform,
    customExecutablePath,
    workingDirectory,
    winePrefixPath,
    isWindowsHost,
    launchMethod,
    compatibilityLayer,
    selectedRunnerDescriptor,
    isCheckingUpdates,
    isUpdatingRunner,
    isInstallingRunner,
    resolvedBottleFolderPath,
    isNativeInstalledBuild,
    activeDisplayMethod,
    preview,
    loadFormFieldsForPlatform,
    buildProfileFromCurrentState,
    game,
  });
  latestRef.current = {
    preferredPlatformId,
    draftsByPlatform,
    customExecutablePath,
    workingDirectory,
    winePrefixPath,
    isWindowsHost,
    launchMethod,
    compatibilityLayer,
    selectedRunnerDescriptor,
    isCheckingUpdates,
    isUpdatingRunner,
    isInstallingRunner,
    resolvedBottleFolderPath,
    isNativeInstalledBuild,
    activeDisplayMethod,
    preview,
    loadFormFieldsForPlatform,
    buildProfileFromCurrentState,
    game,
  };

  const handleSelectStorefront = useCallback((nextPlatId: StorefrontId) => {
    const cur = latestRef.current;
    if (nextPlatId === cur.preferredPlatformId) return;
    const currentProfile = cur.buildProfileFromCurrentState();
    const nextDrafts: Partial<Record<StorefrontId, StorefrontLaunchProfile>> = {
      ...cur.draftsByPlatform,
      [cur.preferredPlatformId]: currentProfile,
    };
    setDraftsByPlatform(nextDrafts);
    setPreferredPlatformId(nextPlatId);
    cur.loadFormFieldsForPlatform(nextPlatId, nextDrafts);
    if (!launcherService.isGameInstalled(cur.game, nextPlatId)) {
      launcherService
        .getGameInstallInfo(cur.game, nextPlatId)
        .then(() => setInstallInfoTick((t) => t + 1))
        .catch(() => {});
    }
  }, []);

  const visibleLaunchModes = LAUNCH_MODES.filter((m) =>
    preview.availableModes.includes(m.value)
  ).map((m) => {
    if (m.value === 'auto') {
      if (!isWindowsHost && !preview.isInstalled && preview.hasDualMacAndWinBuild) {
        return {
          ...m,
          label: 'Native macOS Build (Recommended — Auto-Detect)',
          desc: 'Installs and launches the official Native macOS build automatically with zero translation overhead.',
        };
      }
      if (preview.detectedBuildType === 'windows_exe_on_mac') {
        return {
          ...m,
          label: 'Auto-Detect Compatibility Pipeline',
        };
      }
      if (!isWindowsHost && isMacNativeBuild) {
        return {
          ...m,
          label: 'Auto-Detect Native macOS Launch',
        };
      }
      return {
        ...m,
        label: 'Auto-Detect (Recommended)',
      };
    }
    if (m.value === 'compatibility_layer') {
      if (!preview.isInstalled) {
        if (!isWindowsHost && preview.hasDualMacAndWinBuild) {
          return {
            ...m,
            label: 'Pre-Configure Compatibility Runner & Bottle',
            desc: 'Use the Windows (.exe) build via CrossOver, GPTK, or Wine translation instead of the native macOS build.',
          };
        }
        return {
          ...m,
          label: 'Pre-Configure Compatibility Runner & Bottle',
          desc: 'Pre-select the macOS translation runner, target CrossOver bottle, and graphics settings before installing.',
        };
      }
      return {
        ...m,
        label: 'Custom Compatibility Runner & Bottle',
        desc: 'Pin a specific macOS translation runner (CrossOver, Apple GPTK, or Open-Source Wine), target bottle, and per-game graphics overrides.',
      };
    }
    if (m.value === 'direct') {
      const isRecommendedDirect =
        isNativeInstalledBuild &&
        preview.defaultLaunchMethod === 'direct' &&
        preview.modeNotes.direct?.badge === 'Recommended';
      if (!isWindowsHost && isMacNativeBuild) {
        return {
          ...m,
          label: isRecommendedDirect
            ? 'Direct macOS Application (Recommended)'
            : 'Direct macOS Application',
          desc: 'Launch native macOS application bundle or Mach-O binary directly with PID tracking.',
        };
      }
      if (isWindowsHost && preview.detectedBuildType === 'windows_native') {
        return {
          ...m,
          label: isRecommendedDirect
            ? 'Direct Executable (Recommended)'
            : 'Direct Executable (.exe)',
          desc: 'Spawn native Windows game binary directly and track PID session time.',
        };
      }
      return {
        ...m,
        label: 'Direct Executable (.exe / Binary)',
        desc: isWindowsHost
          ? 'Spawn native Windows game binary directly and track PID session time.'
          : m.desc,
      };
    }
    if (m.value === 'storefront_uri') {
      const isRecommendedUri =
        isNativeInstalledBuild &&
        preview.defaultLaunchMethod === 'storefront_uri' &&
        !preview.modeNotes.storefront_uri?.disabled;
      return {
        ...m,
        label: isRecommendedUri
          ? 'Storefront Client Protocol (Recommended)'
          : 'Storefront Client Protocol',
      };
    }
    return m;
  });

  const currentEnvMap = useMemo(() => parseEnvVars(envText), [envText]);

  const handleToggleQuickEnv = useCallback((key: string, val: string) => {
    setEnvText((prev) => {
      const next = { ...parseEnvVars(prev) };
      if (next[key] === val) {
        delete next[key];
      } else {
        next[key] = val;
      }
      return serializeEnvVars(next);
    });
  }, []);

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

  const handleRescanLayers = useCallback(async () => {
    setIsRescanningRunners(true);
    setRunnerActionFeedback(null);
    try {
      const refreshed = await launcherService.detectCompatibilityLayers();
      setDetectedLayers(refreshed);
      const cur = latestRef.current;
      const matched = refreshed.find((l) => l.type === cur.compatibilityLayer);
      if (matched) {
        setRunnerActionFeedback({
          tone: 'emerald',
          text: `Detected ${matched.name}${matched.version ? ` (${matched.version})` : ''} at ${matched.binaryPath}.`,
        });
      } else {
        setRunnerActionFeedback({
          tone: 'amber',
          text: `Scan complete (${refreshed.length} runner${refreshed.length === 1 ? '' : 's'} found). ${cur.selectedRunnerDescriptor.shortLabel} is still not detected.`,
        });
      }
    } finally {
      setIsRescanningRunners(false);
    }
  }, []);

  const handleCheckRunnerUpdates = useCallback(async () => {
    if (latestRef.current.isCheckingUpdates) return;
    setIsCheckingUpdates(true);
    setRunnerUpdateFeedback(null);
    try {
      const [updates, refreshedLayers] = await Promise.all([
        launcherService.checkCompatibilityLayerUpdates(),
        launcherService.detectCompatibilityLayers(),
      ]);
      if (updates && typeof updates === 'object') {
        setRunnerUpdates(updates);
      }
      if (Array.isArray(refreshedLayers)) {
        setDetectedLayers(refreshedLayers);
      }
      const cur = latestRef.current;
      const targetUpd = updates?.[cur.compatibilityLayer];
      if (targetUpd?.updateAvailable && targetUpd.latestVersion) {
        setRunnerUpdateFeedback(
          `Update available for ${cur.selectedRunnerDescriptor.shortLabel}: v${targetUpd.latestVersion}.`
        );
      } else if (targetUpd?.statusMessage) {
        setRunnerUpdateFeedback(targetUpd.statusMessage);
      } else {
        setRunnerUpdateFeedback(
          `${cur.selectedRunnerDescriptor.shortLabel} is up to date${
            targetUpd?.installedVersion ? ` (v${targetUpd.installedVersion})` : ''
          }.`
        );
      }
    } finally {
      setIsCheckingUpdates(false);
    }
  }, []);

  const handleUpdateRunner = useCallback(async () => {
    const cur = latestRef.current;
    if (cur.isUpdatingRunner || cur.compatibilityLayer === 'native') return;
    setIsUpdatingRunner(true);
    setRunnerUpdateFeedback(null);
    try {
      const res = await launcherService.updateCompatibilityLayer(
        cur.compatibilityLayer as Exclude<CompatibilityLayerType, 'native'>
      );
      const refreshedLayers =
        res.detectedLayers || (await launcherService.detectCompatibilityLayers());
      setDetectedLayers(refreshedLayers);
      if (res.updateInfo) {
        const latestFromService = launcherService.getRunnerUpdates();
        setRunnerUpdates((prev) => ({
          ...prev,
          ...latestFromService,
          [cur.compatibilityLayer]: res.updateInfo!,
        }));
      } else {
        setRunnerUpdates({ ...launcherService.getRunnerUpdates() });
      }
      setRunnerUpdateFeedback(res.message || res.error || null);
    } finally {
      setIsUpdatingRunner(false);
    }
  }, []);

  const handleInstallRunnerViaBrew = useCallback(async () => {
    const cur = latestRef.current;
    if (cur.isInstallingRunner || cur.compatibilityLayer === 'native') return;
    setIsInstallingRunner(true);
    setRunnerActionFeedback(null);
    try {
      const res = await launcherService.installCompatibilityLayer(
        cur.compatibilityLayer as Exclude<CompatibilityLayerType, 'native'>,
        'auto'
      );
      const refreshed = res.layers || (await launcherService.detectCompatibilityLayers());
      setDetectedLayers(refreshed);
      if (res.success) {
        setRunnerActionFeedback({
          tone: 'emerald',
          text:
            res.message ||
            `${cur.selectedRunnerDescriptor.shortLabel} installed via Homebrew and ready to use.`,
        });
      } else {
        setRunnerActionFeedback({
          tone: 'amber',
          text:
            res.error ||
            res.message ||
            `Could not auto-install ${cur.selectedRunnerDescriptor.shortLabel}. Try the official installer download.`,
        });
      }
    } finally {
      setIsInstallingRunner(false);
    }
  }, []);

  const handleDownloadRunner = useCallback(async () => {
    const cur = latestRef.current;
    if (cur.compatibilityLayer === 'native') return;
    const res = await launcherService.installCompatibilityLayer(
      cur.compatibilityLayer as Exclude<CompatibilityLayerType, 'native'>,
      'download'
    );
    setRunnerActionFeedback({
      tone: 'sky',
      text:
        res.message ||
        `Opened official ${cur.selectedRunnerDescriptor.shortLabel} download page. Click Re-Scan after installing.`,
    });
  }, []);

  const handleOpenBottleFolder = useCallback(async () => {
    const folderPath = latestRef.current.resolvedBottleFolderPath;
    if (!folderPath) return;
    if (typeof window !== 'undefined' && window.electronAPI?.browseLocalFiles) {
      await window.electronAPI.browseLocalFiles(folderPath);
    }
  }, []);

  const handleSelectCompatibilityLayer = useCallback((nextLayer: CompatibilityLayerType) => {
    setCompatibilityLayer(nextLayer);
    setRunnerActionFeedback(null);
    setRunnerUpdateFeedback(null);
  }, []);

  const handleToggleMetalHud = useCallback(() => {
    setMetalHud((prev) => !prev);
  }, []);

  const handleToggleCrossoverDlss = useCallback(() => {
    setCrossoverDlss((prev) => !prev);
  }, []);

  const handleToggleWineMsync = useCallback(() => {
    setWineMsync((prev) => {
      const next = !prev;
      if (next) setWineEsync(false);
      return next;
    });
  }, []);

  const handleToggleWineEsync = useCallback(() => {
    setWineEsync((prev) => {
      const next = !prev;
      if (next) setWineMsync(false);
      return next;
    });
  }, []);

  const handleToggleDxvkHud = useCallback(() => {
    setDxvkHud((prev) => !prev);
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

  const handleChangePostGameBehavior = useCallback((val: PostGameLauncherBehavior) => {
    setHasEditedGlobalPerfSettings(true);
    setPerfSettings((prev) => ({
      ...prev,
      postGameLauncherBehavior: val,
    }));
  }, []);

  const handleTogglePauseSyncInGame = useCallback(() => {
    setHasEditedGlobalPerfSettings(true);
    setPerfSettings((prev) => ({
      ...prev,
      pauseBackgroundSyncInGame: !prev.pauseBackgroundSyncInGame,
    }));
  }, []);

  const handleTogglePauseDownloadsInGame = useCallback(() => {
    setHasEditedGlobalPerfSettings(true);
    setPerfSettings((prev) => ({
      ...prev,
      pauseDownloadsInGame: !prev.pauseDownloadsInGame,
    }));
  }, []);

  const handleToggleAutoShutdownWine = useCallback(() => {
    setHasEditedGlobalPerfSettings(true);
    setPerfSettings((prev) => {
      const next = !prev.autoShutdownWinePrefixOnExit;
      return {
        ...prev,
        autoShutdownWinePrefixOnExit: next,
        suppressWineDebugLogging: next,
      };
    });
  }, []);

  const handleResetDefaults = async () => {
    await launcherService.resetLaunchConfig(game.id, preferredPlatformId);
    setDraftsByPlatform((prev) => {
      const next = { ...prev };
      delete next[preferredPlatformId];
      return next;
    });
    const validLayers = detectedLayers.filter((l) =>
      COMPATIBILITY_RUNNER_DESCRIPTORS.some((d) => d.type === l.type)
    );
    const resetPreview = launcherService.resolveEffectiveLaunchModePreview(
      game,
      preferredPlatformId,
      {}
    );
    setLaunchMethod(resetPreview.defaultLaunchMethod);
    setCustomExecutablePath('');
    setWorkingDirectory('');
    setLaunchArguments('');
    setCompatibilityLayer(validLayers[0]?.type || 'crossover');
    setWineBottleName('');
    setWinePrefixPath('');
    setCrossoverGraphicsBackend('auto');
    setCrossoverD3DMetalVersion('auto');
    setCrossoverHighResolutionMode(undefined);
    setCrossoverDlss(false);
    setWineMsync(true);
    setWineEsync(false);
    setMetalHud(false);
    setDxvkHud(false);
    setEnvText('');
    setPreLaunchCommand('');
    setPostExitCommand('');
    setInGameLauncherBehavior('default');
    setStorefrontClientLifecycle('default');
    setPerfSettings(launcherService.getPerformanceSettings());
    setHasEditedGlobalPerfSettings(false);
    setRunnerActionFeedback(null);
    setRunnerUpdateFeedback(null);
  };

  const handleSave = async () => {
    setIsSaving(true);
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

      await launcherService.saveLaunchConfig(config, preferredPlatformId);
      if (hasEditedGlobalPerfSettings) {
        await launcherService.savePerformanceSettings(perfSettings);
      }

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
    setWineBottleName,
    winePrefixPath,
    setWinePrefixPath,
    crossoverGraphicsBackend,
    setCrossoverGraphicsBackend,
    crossoverD3DMetalVersion,
    setCrossoverD3DMetalVersion,
    crossoverHighResolutionMode,
    setCrossoverHighResolutionMode,
    crossoverDlss,
    wineMsync,
    wineEsync,
    metalHud,
    dxvkHud,
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
    detectedLayers,
    isSaving,
    isInstallingRunner,
    isRescanningRunners,
    runnerActionFeedback,
    runnerUpdates,
    isCheckingUpdates,
    isUpdatingRunner,
    runnerUpdateFeedback,
    selectedRunnerDescriptor,
    activeLayer,
    activeUpdateInfo,
    availableBottles,
    activeInstalledVer,
    activeSecondaryBuildText,
    resolvedBottleFolderPath,
    isWindowsHost,
    isDlssSupportedBackend,
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
    currentEnvMap,
    buildBadgeTone,
    activeModeWarning,
    discoveredTargetPath,
    executablePathLabel,
    handleSelectStorefront,
    handleToggleQuickEnv,
    handleBrowseExecutable,
    handleBrowseWorkingDir,
    handleBrowseWinePrefix,
    handleRescanLayers,
    handleCheckRunnerUpdates,
    handleUpdateRunner,
    handleInstallRunnerViaBrew,
    handleDownloadRunner,
    handleOpenBottleFolder,
    handleSelectCompatibilityLayer,
    handleToggleMetalHud,
    handleToggleCrossoverDlss,
    handleToggleWineMsync,
    handleToggleWineEsync,
    handleToggleDxvkHud,
    handleChangeStorefrontClientLifecycle,
    handleChangePostGameBehavior,
    handleTogglePauseSyncInGame,
    handleTogglePauseDownloadsInGame,
    handleToggleAutoShutdownWine,
    handleResetDefaults,
    handleSave,
  };
}
