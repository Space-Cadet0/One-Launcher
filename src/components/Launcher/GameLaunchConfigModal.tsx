import React, { useState, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { CanonicalGame } from '../../contracts/game';
import { acquireModalOverlayLock, canPortalModalToBody } from '../../utils/modalOverlayLock';
import { StorefrontId } from '../../contracts/platform';
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
  StorefrontClientLifecyclePolicy,
  StorefrontLaunchProfile,
} from '../../contracts/launcher';
import {
  launcherService,
  COMPATIBILITY_RUNNER_DESCRIPTORS,
} from '../../services/launcher/launcherService';
import {
  Settings,
  X,
  Save,
  RotateCcw,
  CheckCircle2,
  AlertTriangle,
} from 'lucide-react';
import {
  LAUNCH_MODES,
  getBadgeToneClasses,
  parseEnvVars,
  serializeEnvVars,
  stripManagedEnvVars,
} from './LaunchConfig/launchConfigHelpers';
import { DetectedPipelineBanner } from './LaunchConfig/DetectedPipelineBanner';
import { FastLaunchWarningBanner } from './LaunchConfig/FastLaunchWarningBanner';
import { ExecutableAndArgsSection } from './LaunchConfig/ExecutableAndArgsSection';
import { CompatibilityLayerSection } from './LaunchConfig/CompatibilityLayerSection';
import { EnvironmentAndHooksSection } from './LaunchConfig/EnvironmentAndHooksSection';
import { StorefrontLifecycleSection } from './LaunchConfig/StorefrontLifecycleSection';

export interface GameLaunchConfigModalProps {
  isOpen: boolean;
  game: CanonicalGame;
  initialPlatformId?: StorefrontId;
  onClose: () => void;
  onSaved?: (config: GameLaunchConfig) => void;
}

export const GameLaunchConfigModal: React.FC<GameLaunchConfigModalProps> = ({
  isOpen,
  game,
  initialPlatformId,
  onClose,
  onSaved,
}) => {
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

  const loadFormFieldsForPlatform = (
    targetPlatId: StorefrontId,
    drafts?: Partial<Record<StorefrontId, StorefrontLaunchProfile>>,
    layersOverride?: CompatibilityLayerInfo[]
  ) => {
    const source = drafts?.[targetPlatId] ?? launcherService.getLaunchConfig(game.id, targetPlatId);
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
      Boolean(
        typeof (launcherService as any).isWindowsHost === 'function' &&
          (launcherService as any).isWindowsHost()
      ) ||
      (typeof window !== 'undefined' && (window as any)?.electronAPI?.platform === 'win32');
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
  };

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
        setCompatibilityLayer((prev) => (prev === validLayers[0].type ? prev : validLayers[0].type));
      }
    });

    const winHost =
      (typeof (launcherService as any).isWindowsHost === 'function' &&
        (launcherService as any).isWindowsHost()) ||
      (typeof window !== 'undefined' && (window as any)?.electronAPI?.platform === 'win32');

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
    if (!isOpen || isSaving || typeof window === 'undefined' || typeof window.addEventListener !== 'function') {
      return;
    }
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, isSaving, onClose]);

  useEffect(() => {
    if (!isOpen) return;
    return acquireModalOverlayLock();
  }, [isOpen]);

  if (!isOpen) return null;

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
  const activeSecondaryBuildText = (() => {
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
  })();

  const resolvedBottleFolderPath =
    winePrefixPath.trim() ||
    (activeLayer?.bottlesDir
      ? wineBottleName.trim() || activeLayer.availableBottles?.[0]
        ? `${activeLayer.bottlesDir.replace(/\/+$/, '')}/${
            wineBottleName.trim() || activeLayer.availableBottles![0]
          }`
        : activeLayer.bottlesDir
      : undefined);

  const installedRecord = launcherService.getInstalledRecordForGame(game, preferredPlatformId);

  const isWindowsHost =
    (typeof (launcherService as any).isWindowsHost === 'function' &&
      (launcherService as any).isWindowsHost()) ||
    (typeof window !== 'undefined' && (window as any)?.electronAPI?.platform === 'win32') ||
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

  const effectiveStorefrontClientLifecycle: StorefrontClientLifecyclePolicy =
    storefrontClientLifecycle === 'default'
      ? perfSettings.storefrontClientLifecycle
      : storefrontClientLifecycle;

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

  const handleSelectStorefront = (nextPlatId: StorefrontId) => {
    if (nextPlatId === preferredPlatformId) return;
    const currentProfile = buildProfileFromCurrentState();
    const nextDrafts: Partial<Record<StorefrontId, StorefrontLaunchProfile>> = {
      ...draftsByPlatform,
      [preferredPlatformId]: currentProfile,
    };
    setDraftsByPlatform(nextDrafts);
    setPreferredPlatformId(nextPlatId);
    loadFormFieldsForPlatform(nextPlatId, nextDrafts);
    if (!launcherService.isGameInstalled(game, nextPlatId)) {
      launcherService
        .getGameInstallInfo(game, nextPlatId)
        .then(() => setInstallInfoTick((t) => t + 1))
        .catch(() => {});
    }
  };

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

  const currentEnvMap = parseEnvVars(envText);

  const handleToggleQuickEnv = (key: string, val: string) => {
    const next = { ...currentEnvMap };
    if (next[key] === val) {
      delete next[key];
    } else {
      next[key] = val;
    }
    setEnvText(serializeEnvVars(next));
  };

  const handleBrowseExecutable = async () => {
    const selected = await launcherService.selectExecutable(
      customExecutablePath || workingDirectory || undefined
    );
    if (selected) {
      setCustomExecutablePath(selected);
      if (!workingDirectory.trim()) {
        const lastSep = Math.max(selected.lastIndexOf('/'), selected.lastIndexOf('\\'));
        if (lastSep > 0) {
          setWorkingDirectory(selected.slice(0, lastSep));
        }
      }
      if (isWindowsHost) {
        setLaunchMethod('direct');
        if (preferredPlatformId === 'steam') {
          setStorefrontClientLifecycle('fast_direct_bypass');
        }
      } else if (selected.toLowerCase().endsWith('.exe')) {
        if (launchMethod === 'direct' || launchMethod === 'storefront_uri') {
          setLaunchMethod('compatibility_layer');
        }
      } else {
        setLaunchMethod('direct');
        if (preferredPlatformId === 'steam') {
          setStorefrontClientLifecycle('fast_direct_bypass');
        }
      }
    }
  };

  const handleBrowseWorkingDir = async () => {
    const selected = await launcherService.selectFolder(workingDirectory || undefined);
    if (selected) {
      setWorkingDirectory(selected);
    }
  };

  const handleBrowseWinePrefix = async () => {
    const selected = await launcherService.selectFolder(winePrefixPath || undefined);
    if (selected) {
      setWinePrefixPath(selected);
    }
  };

  const handleRescanLayers = async () => {
    setIsRescanningRunners(true);
    setRunnerActionFeedback(null);
    try {
      const refreshed = await launcherService.detectCompatibilityLayers();
      setDetectedLayers(refreshed);
      const matched = refreshed.find((l) => l.type === compatibilityLayer);
      if (matched) {
        setRunnerActionFeedback({
          tone: 'emerald',
          text: `Detected ${matched.name}${matched.version ? ` (${matched.version})` : ''} at ${matched.binaryPath}.`,
        });
      } else {
        setRunnerActionFeedback({
          tone: 'amber',
          text: `Scan complete (${refreshed.length} runner${refreshed.length === 1 ? '' : 's'} found). ${selectedRunnerDescriptor.shortLabel} is still not detected.`,
        });
      }
    } finally {
      setIsRescanningRunners(false);
    }
  };

  const handleCheckRunnerUpdates = async () => {
    if (isCheckingUpdates) return;
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
      const targetUpd = updates?.[compatibilityLayer];
      if (targetUpd?.updateAvailable && targetUpd.latestVersion) {
        setRunnerUpdateFeedback(
          `Update available for ${selectedRunnerDescriptor.shortLabel}: v${targetUpd.latestVersion}.`
        );
      } else if (targetUpd?.statusMessage) {
        setRunnerUpdateFeedback(targetUpd.statusMessage);
      } else {
        setRunnerUpdateFeedback(
          `${selectedRunnerDescriptor.shortLabel} is up to date${
            targetUpd?.installedVersion ? ` (v${targetUpd.installedVersion})` : ''
          }.`
        );
      }
    } finally {
      setIsCheckingUpdates(false);
    }
  };

  const handleUpdateRunner = async () => {
    if (isUpdatingRunner || compatibilityLayer === 'native') return;
    setIsUpdatingRunner(true);
    setRunnerUpdateFeedback(null);
    try {
      const res = await launcherService.updateCompatibilityLayer(
        compatibilityLayer as Exclude<CompatibilityLayerType, 'native'>
      );
      const refreshedLayers =
        res.detectedLayers || (await launcherService.detectCompatibilityLayers());
      setDetectedLayers(refreshedLayers);
      if (res.updateInfo) {
        const latestFromService = launcherService.getRunnerUpdates();
        setRunnerUpdates((prev) => ({
          ...prev,
          ...latestFromService,
          [compatibilityLayer]: res.updateInfo!,
        }));
      } else {
        setRunnerUpdates({ ...launcherService.getRunnerUpdates() });
      }
      setRunnerUpdateFeedback(res.message || res.error || null);
    } finally {
      setIsUpdatingRunner(false);
    }
  };

  const handleInstallRunnerViaBrew = async () => {
    if (isInstallingRunner || compatibilityLayer === 'native') return;
    setIsInstallingRunner(true);
    setRunnerActionFeedback(null);
    try {
      const res = await launcherService.installCompatibilityLayer(
        compatibilityLayer as Exclude<CompatibilityLayerType, 'native'>,
        'auto'
      );
      const refreshed = res.layers || (await launcherService.detectCompatibilityLayers());
      setDetectedLayers(refreshed);
      if (res.success) {
        setRunnerActionFeedback({
          tone: 'emerald',
          text:
            res.message ||
            `${selectedRunnerDescriptor.shortLabel} installed via Homebrew and ready to use.`,
        });
      } else {
        setRunnerActionFeedback({
          tone: 'amber',
          text:
            res.error ||
            res.message ||
            `Could not auto-install ${selectedRunnerDescriptor.shortLabel}. Try the official installer download.`,
        });
      }
    } finally {
      setIsInstallingRunner(false);
    }
  };

  const handleDownloadRunner = async () => {
    if (compatibilityLayer === 'native') return;
    const res = await launcherService.installCompatibilityLayer(
      compatibilityLayer as Exclude<CompatibilityLayerType, 'native'>,
      'download'
    );
    setRunnerActionFeedback({
      tone: 'sky',
      text:
        res.message ||
        `Opened official ${selectedRunnerDescriptor.shortLabel} download page. Click Re-Scan after installing.`,
    });
  };

  const handleOpenBottleFolder = async () => {
    if (!resolvedBottleFolderPath) return;
    if (typeof window !== 'undefined' && window.electronAPI?.browseLocalFiles) {
      await window.electronAPI.browseLocalFiles(resolvedBottleFolderPath);
    }
  };

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
    // Preserve global performance settings when resetting a per-game profile
    setPerfSettings(launcherService.getPerformanceSettings());
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
      await launcherService.savePerformanceSettings(perfSettings);

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

  const modalContent = (
    <div
      data-testid="launch-config-modal-overlay"
      className="fixed inset-0 z-[100] isolate flex items-center justify-center p-4 select-none overflow-hidden overscroll-contain"
      onClick={onClose}
    >
      <div
        aria-hidden="true"
        data-testid="launch-config-modal-scrim"
        className="fixed inset-0 bg-[#060a10]/95 pointer-events-none"
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-label={isWindowsHost ? 'Launch Settings' : 'Launch & Compatibility Settings'}
        className="relative z-10 w-full max-w-2xl rounded-xl bg-[#131b26] border border-[#2a475e] shadow-2xl overflow-hidden text-steam-text flex flex-col max-h-[88vh]"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="px-5 py-4 bg-[#0e151f] border-b border-[#223447] flex items-center justify-between gap-3 shrink-0">
          <div className="flex items-center gap-3 min-w-0">
            <div className="p-2 rounded-lg bg-sky-500/15 border border-sky-400/30 text-sky-400 shrink-0">
              <Settings className="w-5 h-5" />
            </div>
            <div className="min-w-0">
              <h2 className="text-base font-bold text-white truncate">
                {isWindowsHost
                  ? 'Launch Settings'
                  : isMacNativeBuild && !preview.visibleSections.compatibilityLayer
                    ? 'Launch Settings (macOS Native)'
                    : 'Launch & Compatibility Settings'}
              </h2>
              <p className="text-xs text-steam-subtext truncate">
                {isWindowsHost
                  ? 'Configure execution mode, custom executable & launch parameters for '
                  : isMacNativeBuild && !preview.visibleSections.compatibilityLayer
                    ? 'Configure native macOS execution mode, Metal HUD & launch parameters for '
                    : 'Configure execution mode, Wine/CrossOver bottles & launch parameters for '}
                <span className="font-semibold text-white">{game.title}</span>
              </p>
            </div>
          </div>

          <button
            type="button"
            onClick={onClose}
            className="p-1.5 rounded-lg bg-white/5 hover:bg-white/10 text-steam-subtext hover:text-white transition-colors cursor-pointer"
            aria-label="Close launch settings modal"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Scrollable Content */}
        <div className="p-5 space-y-5 overflow-y-auto overscroll-contain flex-1 bg-[#131b26] modal-scroll-body">
          {DetectedPipelineBanner({
            game,
            preview,
            buildBadgeTone,
            discoveredTargetPath,
            preferredPlatformId,
            draftsByPlatform,
            onSelectStorefront: handleSelectStorefront,
          })}

          {/* Launch Mode */}
          <div className="space-y-2">
            <label className="block text-[11px] font-bold uppercase tracking-wider text-steam-subtext">
              Launch Mode
            </label>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              {visibleLaunchModes.map((mode) => {
                const modeNote = preview.modeNotes[mode.value];
                const isModeDisabled = Boolean(modeNote?.disabled);
                const isSelected = !isModeDisabled && activeDisplayMethod === mode.value;
                const dynamicDesc =
                  isWindowsHost && modeNote?.dynamicDesc && /CrossOver/i.test(modeNote.dynamicDesc)
                    ? mode.desc
                    : modeNote?.dynamicDesc || mode.desc;
                return (
                  <button
                    key={mode.value}
                    type="button"
                    data-launch-mode={mode.value}
                    disabled={isModeDisabled}
                    aria-disabled={isModeDisabled}
                    aria-pressed={isSelected}
                    onClick={() => {
                      if (isModeDisabled) return;
                      setLaunchMethod(mode.value);
                      if (isNativeInstalledBuild && preferredPlatformId === 'steam') {
                        if (mode.value === 'direct') {
                          setStorefrontClientLifecycle('fast_direct_bypass');
                        } else if (
                          mode.value === 'storefront_uri' &&
                          effectiveStorefrontClientLifecycle === 'fast_direct_bypass'
                        ) {
                          setStorefrontClientLifecycle('minimal_and_close_if_started');
                        }
                      }
                    }}
                    className={`p-3 rounded-lg border text-left transition-colors flex flex-col justify-between ${
                      isModeDisabled
                        ? 'bg-[#121923] border-[#1f2e40] text-steam-subtext/60 opacity-55 cursor-not-allowed'
                        : isSelected
                          ? 'bg-sky-500/15 border-sky-400 text-white cursor-pointer'
                          : 'bg-[#17212e] border-[#26384d] text-steam-subtext hover:text-white hover:bg-[#1c2838] cursor-pointer'
                    }`}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span
                        className={
                          isModeDisabled
                            ? 'text-xs font-bold text-steam-subtext/70'
                            : 'text-xs font-bold text-white'
                        }
                      >
                        {mode.label}
                      </span>
                      <div className="flex items-center gap-1.5 shrink-0">
                        {modeNote?.badge && (
                          <span
                            className={`text-[10px] px-1.5 py-0.5 rounded border font-semibold ${getBadgeToneClasses(
                              modeNote.badgeTone
                            )}`}
                          >
                            {modeNote.badge}
                          </span>
                        )}
                        {isSelected && <CheckCircle2 className="w-3.5 h-3.5 text-sky-400 shrink-0" />}
                      </div>
                    </div>
                    <p className="text-[10px] text-steam-subtext mt-1.5 leading-relaxed">
                      {dynamicDesc}
                    </p>
                    {isModeDisabled && modeNote?.disabledReason && (
                      <p className="text-[10px] text-amber-300/90 mt-1 font-medium leading-snug">
                        {modeNote.disabledReason}
                      </p>
                    )}
                  </button>
                );
              })}
            </div>

            {activeModeWarning && (
              <div className="flex items-start gap-2.5 rounded-lg bg-amber-950/50 border border-amber-500/40 px-3 py-2.5 text-xs text-amber-200">
                <AlertTriangle className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" />
                <span className="leading-relaxed">{activeModeWarning}</span>
              </div>
            )}
          </div>

          {FastLaunchWarningBanner({
            fastLaunchAdvisory,
            activeDisplayMethod,
            isInstalled: preview.isInstalled,
            preferredPlatformId,
            mode: 'storefront_uri_only',
          })}

          {!preview.isInstalled &&
            ExecutableAndArgsSection({
              preview,
              isWindowsHost,
              executablePathLabel,
              customExecutablePath,
              onChangeCustomExecutablePath: (val) => {
                setCustomExecutablePath(val);
              },
              onBrowseExecutable: handleBrowseExecutable,
              workingDirectory,
              onChangeWorkingDirectory: (val) => {
                setWorkingDirectory(val);
              },
              onBrowseWorkingDir: handleBrowseWorkingDir,
              launchArguments,
              onChangeLaunchArguments: (val) => {
                setLaunchArguments(val);
              },
              metalHud,
              onToggleMetalHud: () => {
                setMetalHud((prev) => !prev);
              },
              sectionFilter: 'executable_only',
            })}

          {CompatibilityLayerSection({
            isWindowsHost,
            preview,
            activeDisplayMethod,
            detectedLayers,
            runnerUpdates,
            compatibilityLayer,
            onSelectCompatibilityLayer: (nextLayer) => {
              setCompatibilityLayer(nextLayer);
              setRunnerActionFeedback(null);
              setRunnerUpdateFeedback(null);
            },
            availableBottles,
            wineBottleName,
            onChangeWineBottleName: (nextBottle) => {
              setWineBottleName(nextBottle);
            },
            selectedRunnerDescriptor,
            activeLayer,
            activeUpdateInfo,
            activeInstalledVer,
            activeSecondaryBuildText,
            isCheckingUpdates,
            isUpdatingRunner,
            onUpdateRunner: handleUpdateRunner,
            onCheckRunnerUpdates: handleCheckRunnerUpdates,
            resolvedBottleFolderPath,
            onOpenBottleFolder: handleOpenBottleFolder,
            isRescanningRunners,
            onRescanLayers: handleRescanLayers,
            isInstallingRunner,
            onInstallRunnerViaBrew: handleInstallRunnerViaBrew,
            onDownloadRunner: handleDownloadRunner,
            runnerUpdateFeedback,
            runnerActionFeedback,
            winePrefixPath,
            onChangeWinePrefixPath: (nextPath) => {
              setWinePrefixPath(nextPath);
            },
            onBrowseWinePrefix: handleBrowseWinePrefix,
            crossoverGraphicsBackend,
            onChangeCrossoverGraphicsBackend: (val) => {
              setCrossoverGraphicsBackend(val);
            },
            crossoverD3DMetalVersion,
            onChangeCrossoverD3DMetalVersion: (val) => {
              setCrossoverD3DMetalVersion(val);
            },
            showD3DMetalVersionSelector,
            primaryD3DVer,
            fallbackD3DVer,
            crossoverHighResolutionMode,
            onChangeCrossoverHighResolutionMode: (val) => {
              setCrossoverHighResolutionMode(val);
            },
            isDlssSupportedBackend,
            isDxvkHudSupported,
            crossoverDlss,
            onToggleCrossoverDlss: () => {
              setCrossoverDlss((prev) => !prev);
            },
            wineMsync,
            onToggleWineMsync: () => {
              setWineMsync((prev) => {
                const next = !prev;
                if (next) setWineEsync(false);
                return next;
              });
            },
            wineEsync,
            onToggleWineEsync: () => {
              setWineEsync((prev) => {
                const next = !prev;
                if (next) setWineMsync(false);
                return next;
              });
            },
            metalHud,
            onToggleMetalHud: () => {
              setMetalHud((prev) => !prev);
            },
            dxvkHud,
            onToggleDxvkHud: () => {
              setDxvkHud((prev) => !prev);
            },
          })}

          {ExecutableAndArgsSection({
            preview,
            isWindowsHost,
            executablePathLabel,
            customExecutablePath,
            onChangeCustomExecutablePath: (val) => {
              setCustomExecutablePath(val);
            },
            onBrowseExecutable: handleBrowseExecutable,
            workingDirectory,
            onChangeWorkingDirectory: (val) => {
              setWorkingDirectory(val);
            },
            onBrowseWorkingDir: handleBrowseWorkingDir,
            launchArguments,
            onChangeLaunchArguments: (val) => {
              setLaunchArguments(val);
            },
            metalHud,
            onToggleMetalHud: () => {
              setMetalHud((prev) => !prev);
            },
            sectionFilter: 'native_mac_only',
          })}

          {StorefrontLifecycleSection({
            isWindowsHost,
            preview,
            activeDisplayMethod,
            preferredPlatformId,
            inGameLauncherBehavior,
            onChangeInGameLauncherBehavior: (val) => {
              setInGameLauncherBehavior(val);
            },
            storefrontClientLifecycle,
            onChangeStorefrontClientLifecycle: (val) => {
              setStorefrontClientLifecycle(val);
              if (isNativeInstalledBuild && preferredPlatformId === 'steam') {
                if (val === 'fast_direct_bypass') {
                  setLaunchMethod('direct');
                } else if (
                  (launchMethod === 'direct' || activeDisplayMethod === 'direct') &&
                  !preview.modeNotes.storefront_uri?.disabled
                ) {
                  setLaunchMethod('storefront_uri');
                }
              } else if (
                !isWindowsHost &&
                preferredPlatformId !== 'custom' &&
                launchMethod === 'direct' &&
                val !== 'fast_direct_bypass'
              ) {
                setLaunchMethod(
                  preview.availableModes.includes('auto')
                    ? 'auto'
                    : preview.availableModes.includes('compatibility_layer')
                      ? 'compatibility_layer'
                      : preview.defaultLaunchMethod
                );
              }
            },
            policyView,
            perfSettings,
            onChangePostGameBehavior: (val) => {
              setPerfSettings((prev) => ({
                ...prev,
                postGameLauncherBehavior: val,
              }));
            },
            onTogglePauseSyncInGame: () => {
              setPerfSettings((prev) => ({
                ...prev,
                pauseBackgroundSyncInGame: !prev.pauseBackgroundSyncInGame,
              }));
            },
            onTogglePauseDownloadsInGame: () => {
              setPerfSettings((prev) => ({
                ...prev,
                pauseDownloadsInGame: !prev.pauseDownloadsInGame,
              }));
            },
            onToggleAutoShutdownWine: () => {
              setPerfSettings((prev) => {
                const next = !prev.autoShutdownWinePrefixOnExit;
                return {
                  ...prev,
                  autoShutdownWinePrefixOnExit: next,
                  suppressWineDebugLogging: next,
                };
              });
            },
          })}

          {preview.isInstalled &&
            ExecutableAndArgsSection({
              preview,
              isWindowsHost,
              executablePathLabel,
              customExecutablePath,
              onChangeCustomExecutablePath: (val) => {
                setCustomExecutablePath(val);
              },
              onBrowseExecutable: handleBrowseExecutable,
              workingDirectory,
              onChangeWorkingDirectory: (val) => {
                setWorkingDirectory(val);
              },
              onBrowseWorkingDir: handleBrowseWorkingDir,
              launchArguments,
              onChangeLaunchArguments: (val) => {
                setLaunchArguments(val);
              },
              metalHud,
              onToggleMetalHud: () => {
                setMetalHud((prev) => !prev);
              },
              sectionFilter: 'executable_only',
            })}

          {EnvironmentAndHooksSection({
            preview,
            isWindowsHost,
            currentEnvMap,
            onToggleQuickEnv: handleToggleQuickEnv,
            envText,
            onChangeEnvText: (val) => {
              setEnvText(val);
            },
            preLaunchCommand,
            onChangePreLaunchCommand: (val) => {
              setPreLaunchCommand(val);
            },
            postExitCommand,
            onChangePostExitCommand: (val) => {
              setPostExitCommand(val);
            },
          })}
        </div>

        {/* Footer */}
        <div className="px-5 py-3.5 bg-[#0e151f] border-t border-[#223447] flex items-center justify-between gap-3 shrink-0">
          <button
            type="button"
            data-testid="reset-launch-config-btn"
            onClick={handleResetDefaults}
            className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg bg-[#17212e] hover:bg-[#223144] border border-[#2a475e] text-xs font-semibold text-steam-subtext hover:text-white transition-colors cursor-pointer"
          >
            <RotateCcw className="w-3.5 h-3.5" />
            <span>{isNativeInstalledBuild ? 'Reset to Recommended' : 'Reset to Auto-Detect'}</span>
          </button>

          <div className="flex items-center gap-2.5">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 rounded-lg bg-[#1b2838] hover:bg-[#24354a] text-xs font-semibold text-steam-text hover:text-white transition-colors cursor-pointer"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={handleSave}
              disabled={isSaving}
              className="inline-flex items-center gap-1.5 px-5 py-2 rounded-lg font-bold text-xs text-white uppercase tracking-wider transition-opacity shadow-lg hover:brightness-110 disabled:opacity-50 cursor-pointer"
              style={{
                background: 'linear-gradient(to right, #10b981 0%, #059669 100%)',
                boxShadow: '0 0 16px rgba(16, 185, 129, 0.35)',
              }}
            >
              <Save className="w-3.5 h-3.5" />
              <span>{isSaving ? 'Saving...' : 'Save Configuration'}</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  );

  return canPortalModalToBody() ? createPortal(modalContent, document.body) : modalContent;
};
