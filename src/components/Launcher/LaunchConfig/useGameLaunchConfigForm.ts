import { useState, useEffect, useCallback, useMemo, useRef, type SetStateAction } from 'react';
import { CanonicalGame } from '../../../contracts/game';
import { getHostCapabilities, type HostPlatformCapabilities } from '../../../contracts/hostPlatform';
import { StorefrontId } from '../../../contracts/platform';
import {
  BottleDisplayScalingMode,
  CompatibilityLayerInfo,
  CompatibilityLayerType,
  CompatibilityLayerUpdateInfo,
  CompatibilityRunnerProgressEvent,
  CrossOverD3DMetalVersion,
  CrossOverGraphicsBackend,
  DisplayAspectRatioMode,
  GameLaunchConfig,
  GlobalBottleDisplayScalingMode,
  InGameLauncherBehavior,
  LauncherPerformanceSettings,
  LaunchMethod,
  migrateLegacyHudConfig,
  PerformanceHudMode,
  resolveDefaultBottleForLayer,
  StorefrontClientLifecyclePolicy,
  StorefrontLaunchProfile,
  VirtualDesktopResolutionPreset,
} from '../../../contracts/launcher';
import {
  launcherService,
  COMPATIBILITY_RUNNER_DESCRIPTORS,
} from '../../../services/launcher/launcherService';
import { acquireModalOverlayLock } from '../../../utils/modalOverlayLock';
import {
  formatRunnerSecondaryBuildText,
  LAUNCH_MODES,
  parseEnvVars,
  resolveEffectiveUiStorefrontLifecycle,
  resolveWineSyncMode,
  serializeEnvVars,
  stripManagedEnvVars,
  type WineSyncMode,
} from './launchConfigHelpers';
import {
  resolveDlssEligibility,
  resolveMetalfxSpatialEligibility,
} from './CompatibilityLayerSection';

function resolveFormHostCapabilities(): HostPlatformCapabilities {
  if (typeof launcherService.getHostCapabilities === 'function') {
    return launcherService.getHostCapabilities();
  }
  const explicitPlatform =
    typeof launcherService.isWindowsHost === 'function' && launcherService.isWindowsHost()
      ? 'win32'
      : typeof launcherService.getHostPlatform === 'function'
        ? launcherService.getHostPlatform()
        : undefined;
  const explicitArch =
    typeof launcherService.getHostArch === 'function' ? launcherService.getHostArch() : undefined;
  return getHostCapabilities(explicitPlatform, explicitArch);
}

function isFormBottleCompatibleWithRunner(
  bottleName: string,
  runnerType: CompatibilityLayerType,
  allLayers: CompatibilityLayerInfo[]
): boolean {
  if (!bottleName) return true;
  const targetLayer = allLayers.find((l) => l.type === runnerType);
  const bottleArch =
    targetLayer?.bottleDetails?.[bottleName]?.wineArch ||
    allLayers.find((l) => l.bottleDetails?.[bottleName]?.wineArch)?.bottleDetails?.[
      bottleName
    ]?.wineArch;
  if (runnerType === 'crossover_preview_arm64') {
    return bottleArch ? bottleArch === 'arm64' : !/^OneLauncher$/i.test(bottleName);
  }
  if (runnerType === 'crossover' || runnerType === 'crossover_preview') {
    return bottleArch ? bottleArch === 'win64' : !/-arm64$/i.test(bottleName);
  }
  return true;
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
  const [activeRunnerOpType, setActiveRunnerOpType] = useState<Exclude<
    CompatibilityLayerType,
    'native'
  > | null>(null);
  const [runnerUpdateFeedback, setRunnerUpdateFeedback] = useState<string | null>(null);
  const [runnerProgressByType, setRunnerProgressByType] = useState<
    Partial<Record<Exclude<CompatibilityLayerType, 'native'>, CompatibilityRunnerProgressEvent>>
  >(() => launcherService.getActiveRunnerOperations());
  const [, setInstallInfoTick] = useState(0);
  const userEditedCompatPlatformsRef = useRef<Set<StorefrontId>>(new Set());
  const userResetPendingDetectPlatformsRef = useRef<Set<StorefrontId>>(new Set());
  const hasDetectedLayersResolvedRef = useRef<boolean>(false);
  const latestDetectedLayersRef = useRef<CompatibilityLayerInfo[]>([]);
  const formSessionIdRef = useRef<number>(0);
  const compatEditEpochByPlatformRef = useRef<Partial<Record<StorefrontId, number>>>({});
  const activeRunnerOpTypeRef = useRef<Exclude<CompatibilityLayerType, 'native'> | null>(null);

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
      const isHostSupportedRunner = (layerType: CompatibilityLayerType | undefined): boolean =>
        Boolean(
          layerType &&
            COMPATIBILITY_RUNNER_DESCRIPTORS.some((d) => d.type === layerType) &&
            (layerType !== 'crossover_preview_arm64' || hostArch === 'arm64')
        );
      const allRawLayers = layersOverride || detectedLayers;
      const activeLayers = allRawLayers.filter(
        (l) => l.available !== false && isHostSupportedRunner(l.type)
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
      const defaultLayer: CompatibilityLayerType = isHostSupportedRunner(source?.compatibilityLayer)
        ? source!.compatibilityLayer!
        : activeLayers[0]?.type && activeLayers[0].type !== 'native'
          ? activeLayers[0].type
          : 'crossover';
      const rawSavedBottle = source?.wineBottleName || '';
      const wasSavedLayerRejected = Boolean(
        source?.compatibilityLayer &&
          source.compatibilityLayer !== 'native' &&
          source.compatibilityLayer !== defaultLayer
      );
      const fallbackLayerInfo = activeLayers.find((l) => l.type === defaultLayer);
      const fallbackAvailableBottles = fallbackLayerInfo?.availableBottles || [];
      const isSavedBottleInFallbackOptions =
        fallbackAvailableBottles.length === 0 || fallbackAvailableBottles.includes(rawSavedBottle);
      const isSavedBottleCompatible = isFormBottleCompatibleWithRunner(
        rawSavedBottle,
        defaultLayer,
        allRawLayers
      );
      const resolvedWineBottleName =
        rawSavedBottle &&
        (!isSavedBottleInFallbackOptions ||
          ((wasSavedLayerRejected || hostArch !== 'arm64') && !isSavedBottleCompatible))
          ? ''
          : rawSavedBottle;
      setCompatibilityLayer(defaultLayer);
      setWineBottleName(resolvedWineBottleName);
      setWinePrefixPath(source?.winePrefixPath || '');
      setCrossoverGraphicsBackend(source?.crossoverGraphicsBackend || 'auto');
      setCrossoverD3DMetalVersion(
        source?.crossoverD3DMetalVersion ||
          (source?.environmentVariables?.CX_GRAPHICS_BACKEND_VERSION === '3' ||
          source?.environmentVariables?.CX_GRAPHICS_BACKEND_VERSION === '4'
            ? source.environmentVariables.CX_GRAPHICS_BACKEND_VERSION
            : 'auto')
      );
      // Normalize legacy crossoverHighResolutionMode: true -> undefined (identical under Display Scaler v3)
      const normalizedHighResMode =
        source?.crossoverHighResolutionMode === false ? false : undefined;
      setCrossoverHighResolutionMode(normalizedHighResMode);
      setCrossoverDlss(Boolean(source?.crossoverDlss));
      const envMaxFpsRaw =
        source?.environmentVariables?.DXVK_FRAME_RATE ||
        source?.environmentVariables?.D3DM_MAX_FPS;
      const envMaxFpsParsed = envMaxFpsRaw ? Math.round(Number(envMaxFpsRaw)) : NaN;
      setPreferredMaxFrameRate(
        typeof source?.preferredMaxFrameRate === 'number' &&
          Number.isFinite(source.preferredMaxFrameRate) &&
          source.preferredMaxFrameRate > 0
          ? Math.round(source.preferredMaxFrameRate)
          : Number.isFinite(envMaxFpsParsed) && envMaxFpsParsed > 0
            ? envMaxFpsParsed
            : undefined
      );
      const envSpatialRaw = source?.environmentVariables?.DXMT_METALFX_SPATIAL_SWAPCHAIN;
      const envSpatialParsed = envSpatialRaw ? Number(envSpatialRaw) : NaN;
      const dxmtConfigRaw = source?.environmentVariables?.DXMT_CONFIG;
      const dxmtConfigSpatialMatch =
        typeof dxmtConfigRaw === 'string'
          ? /d3d11\.metalSpatialUpscaleFactor\s*=\s*([0-9.]+)/i.exec(dxmtConfigRaw)
          : null;
      const dxmtConfigSpatialParsed = dxmtConfigSpatialMatch
        ? Number(dxmtConfigSpatialMatch[1])
        : NaN;
      const loadedMetalfxSpatial =
        typeof source?.metalfxSpatialUpscaleFactor === 'number' &&
        Number.isFinite(source.metalfxSpatialUpscaleFactor) &&
        source.metalfxSpatialUpscaleFactor > 1
          ? source.metalfxSpatialUpscaleFactor
          : Number.isFinite(envSpatialParsed) && envSpatialParsed > 1
            ? envSpatialParsed
            : Number.isFinite(dxmtConfigSpatialParsed) && dxmtConfigSpatialParsed > 1
              ? dxmtConfigSpatialParsed
              : undefined;
      setMetalfxSpatialUpscaleFactor(loadedMetalfxSpatial);
      const loadedDisplayScalingMode: BottleDisplayScalingMode =
        source?.displayScalingMode &&
        (source.displayScalingMode === 'default' ||
          source.displayScalingMode === 'auto_fullscreen' ||
          source.displayScalingMode === 'force_fullscreen' ||
          source.displayScalingMode === 'native_driver' ||
          source.displayScalingMode === 'windowed' ||
          source.displayScalingMode === 'virtual_desktop')
          ? source.displayScalingMode
          : source?.virtualDesktop === true
            ? 'virtual_desktop'
            : 'default';
      setDisplayScalingMode(loadedDisplayScalingMode);
      const loadedDisplayAspectRatio: DisplayAspectRatioMode =
        source?.displayAspectRatio &&
        (source.displayAspectRatio === 'default' ||
          source.displayAspectRatio === 'preserve_aspect' ||
          source.displayAspectRatio === 'integer' ||
          source.displayAspectRatio === 'stretch')
          ? source.displayAspectRatio
          : 'default';
      setDisplayAspectRatio(loadedDisplayAspectRatio);
      const loadedVirtualDesktopResolution =
        typeof source?.virtualDesktopResolution === 'string' &&
        source.virtualDesktopResolution.trim().length > 0
          ? source.virtualDesktopResolution.trim().toLowerCase()
          : 'auto';
      setVirtualDesktopResolution(loadedVirtualDesktopResolution);
      setEmulateModeset(source?.emulateModeset);
      const loadedForceLaa =
        source?.forceLargeAddressAware !== undefined
          ? Boolean(source.forceLargeAddressAware)
          : source?.environmentVariables?.WINE_LARGE_ADDRESS_AWARE === '1'
            ? true
            : source?.environmentVariables?.WINE_LARGE_ADDRESS_AWARE === '0'
              ? false
              : undefined;
      setForceLargeAddressAware(loadedForceLaa);
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
      const hasExplicitHudField = Boolean(
        source &&
          (source.performanceHud !== undefined ||
            source.metalHud === true ||
            source.dxvkHud === true)
      );
      const loadedPerformanceHud: PerformanceHudMode = hasExplicitHudField
        ? (migrateLegacyHudConfig(source!).performanceHud ?? 'default')
        : source?.environmentVariables?.MTL_HUD_ENABLED === '1'
          ? 'on'
          : 'default';
      setPerformanceHud(loadedPerformanceHud);
      const loadedEnvText = serializeEnvVars(stripManagedEnvVars(source?.environmentVariables));
      setEnvText(loadedEnvText);
      const loadedPreLaunch = source?.preLaunchCommand || '';
      const loadedPostExit = source?.postExitCommand || '';
      setPreLaunchCommand(loadedPreLaunch);
      setPostExitCommand(loadedPostExit);
      const loadedInGameBehavior = source?.inGameLauncherBehavior || 'default';
      setInGameLauncherBehavior(loadedInGameBehavior);
      const isWinHostForLoad =
        initialPreview.hostPlatform === 'win32' || resolveFormHostCapabilities().isWindows;
      const isBottleContextForLoad =
        !isWinHostForLoad &&
        (initialPreview.detectedBuildType === 'windows_exe_on_mac' ||
          resolvedMethod === 'compatibility_layer' ||
          initialPreview.visibleSections.compatibilityLayer);
      let loadedLifecycle: 'default' | StorefrontClientLifecyclePolicy = 'default';
      if (source?.storefrontClientLifecycle && source.storefrontClientLifecycle !== 'default') {
        if (
          targetPlatId === 'gog' &&
          !isBottleContextForLoad &&
          source.storefrontClientLifecycle === 'default_client'
        ) {
          loadedLifecycle = 'minimal_keep_running';
        } else {
          loadedLifecycle = source.storefrontClientLifecycle;
        }
      }
      setStorefrontClientLifecycle(loadedLifecycle);
      const loadedCrossoverD3DVer: CrossOverD3DMetalVersion =
        source?.crossoverD3DMetalVersion ||
        (source?.environmentVariables?.CX_GRAPHICS_BACKEND_VERSION === '3' ||
        source?.environmentVariables?.CX_GRAPHICS_BACKEND_VERSION === '4'
          ? source.environmentVariables.CX_GRAPHICS_BACKEND_VERSION
          : 'auto');
      const loadedMaxFps =
        typeof source?.preferredMaxFrameRate === 'number' &&
        Number.isFinite(source.preferredMaxFrameRate) &&
        source.preferredMaxFrameRate > 0
          ? Math.round(source.preferredMaxFrameRate)
          : Number.isFinite(envMaxFpsParsed) && envMaxFpsParsed > 0
            ? envMaxFpsParsed
            : undefined;
      const loadedSignature = JSON.stringify({
        launchMethod: resolvedMethod,
        customExecutablePath: source?.customExecutablePath || '',
        workingDirectory: source?.workingDirectory || '',
        launchArguments: source?.launchArguments || '',
        compatibilityLayer: defaultLayer,
        wineBottleName: resolvedWineBottleName,
        winePrefixPath: source?.winePrefixPath || '',
        crossoverGraphicsBackend: source?.crossoverGraphicsBackend || 'auto',
        crossoverD3DMetalVersion: loadedCrossoverD3DVer,
        crossoverHighResolutionMode: normalizedHighResMode,
        crossoverDlss: Boolean(source?.crossoverDlss),
        preferredMaxFrameRate: loadedMaxFps,
        metalfxSpatialUpscaleFactor: loadedMetalfxSpatial,
        displayScalingMode: loadedDisplayScalingMode,
        displayAspectRatio: loadedDisplayAspectRatio,
        virtualDesktopResolution: loadedVirtualDesktopResolution,
        emulateModeset: source?.emulateModeset,
        forceLargeAddressAware: loadedForceLaa,
        wineMsync: loadedMsync,
        wineEsync: loadedEsync,
        performanceHud: loadedPerformanceHud,
        envText: loadedEnvText,
        preLaunchCommand: loadedPreLaunch,
        postExitCommand: loadedPostExit,
        inGameLauncherBehavior: loadedInGameBehavior,
        storefrontClientLifecycle: loadedLifecycle,
      });
      setBaselineFieldsByPlatform((prev) =>
        prev[targetPlatId] !== undefined ? prev : { ...prev, [targetPlatId]: loadedSignature }
      );
      setRunnerActionFeedback(null);
      setRunnerUpdateFeedback(null);
    },
    [game, detectedLayers]
  );

  useEffect(() => {
    if (!isOpen) {
      formSessionIdRef.current += 1;
      compatEditEpochByPlatformRef.current = {};
      userEditedCompatPlatformsRef.current.clear();
      userResetPendingDetectPlatformsRef.current.clear();
      hasDetectedLayersResolvedRef.current = false;
      latestDetectedLayersRef.current = [];
      setIsUpdatingRunner(false);
      setIsInstallingRunner(false);
      activeRunnerOpTypeRef.current = null;
      setActiveRunnerOpType(null);
      setIsRescanningRunners(false);
      setIsCheckingUpdates(false);
      return;
    }
    let active = true;
    formSessionIdRef.current += 1;
    const effectSessionId = formSessionIdRef.current;
    compatEditEpochByPlatformRef.current = {};
    userEditedCompatPlatformsRef.current.clear();
    userResetPendingDetectPlatformsRef.current.clear();
    hasDetectedLayersResolvedRef.current = false;
    setIsUpdatingRunner(false);
    setIsInstallingRunner(false);
    activeRunnerOpTypeRef.current = null;
    setActiveRunnerOpType(null);
    setIsRescanningRunners(false);
    setIsCheckingUpdates(false);

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
      const isLayerHostSupported = (layerType: CompatibilityLayerType | undefined): boolean =>
        Boolean(
          layerType &&
            layerType !== 'native' &&
            COMPATIBILITY_RUNNER_DESCRIPTORS.some((d) => d.type === layerType) &&
            (layerType !== 'crossover_preview_arm64' || currentHostArch === 'arm64')
        );
      const validLayers = layers.filter(
        (l) => l.available !== false && isLayerHostSupported(l.type)
      );
      const currentPlatId = latestRef.current.preferredPlatformId;

      const currentDrafts = latestRef.current.draftsByPlatform;
      const draftUpdates: Partial<Record<StorefrontId, StorefrontLaunchProfile>> = {};
      const baselineDraftPatches: Partial<
        Record<
          StorefrontId,
          { compatibilityLayer?: CompatibilityLayerType; wineBottleName?: string }
        >
      > = {};

      for (const [rawPlatId, draftProfile] of Object.entries(currentDrafts)) {
        const platId = rawPlatId as StorefrontId;
        if (platId === currentPlatId || !draftProfile) continue;

        if (userResetPendingDetectPlatformsRef.current.has(platId) && validLayers.length > 0) {
          userResetPendingDetectPlatformsRef.current.delete(platId);
          const autoLayer = validLayers[0].type;
          if (draftProfile.compatibilityLayer !== autoLayer || draftProfile.wineBottleName) {
            draftUpdates[platId] = {
              ...draftProfile,
              compatibilityLayer: autoLayer,
              wineBottleName: undefined,
            };
            baselineDraftPatches[platId] = {
              compatibilityLayer: autoLayer,
              wineBottleName: '',
            };
          }
          continue;
        }

        if (!userEditedCompatPlatformsRef.current.has(platId)) {
          const isDraftLayerSupported = isLayerHostSupported(draftProfile.compatibilityLayer);
          if (
            (!draftProfile.compatibilityLayer || !isDraftLayerSupported) &&
            validLayers.length > 0
          ) {
            const autoLayer = validLayers[0].type;
            const rawBottle = draftProfile.wineBottleName || '';
            const autoBottles = validLayers[0].availableBottles || [];
            const isBottleValidForAuto =
              !rawBottle ||
              (isFormBottleCompatibleWithRunner(rawBottle, autoLayer, layers) &&
                (autoBottles.length === 0 || autoBottles.includes(rawBottle)));
            draftUpdates[platId] = {
              ...draftProfile,
              compatibilityLayer: autoLayer,
              wineBottleName: isBottleValidForAuto ? draftProfile.wineBottleName : undefined,
            };
            baselineDraftPatches[platId] = {
              compatibilityLayer: autoLayer,
              ...(isBottleValidForAuto ? {} : { wineBottleName: '' }),
            };
          } else if (draftProfile.compatibilityLayer && isDraftLayerSupported && layers.length > 0) {
            const rawBottle = draftProfile.wineBottleName || '';
            if (rawBottle) {
              const targetLayer = validLayers.find((l) => l.type === draftProfile.compatibilityLayer);
              const targetBottles = targetLayer?.availableBottles || [];
              const isInTargetOptions =
                targetBottles.length === 0 || targetBottles.includes(rawBottle);
              const isCompatibleWithTarget = isFormBottleCompatibleWithRunner(
                rawBottle,
                draftProfile.compatibilityLayer,
                layers
              );
              if (!isInTargetOptions || (currentHostArch !== 'arm64' && !isCompatibleWithTarget)) {
                draftUpdates[platId] = {
                  ...draftProfile,
                  wineBottleName: undefined,
                };
                baselineDraftPatches[platId] = {
                  wineBottleName: '',
                };
              }
            }
          }
        } else if (draftProfile.compatibilityLayer && draftProfile.wineBottleName) {
          const targetLayer = layers.find(
            (l) => l.type === draftProfile.compatibilityLayer && l.available !== false
          );
          const targetAvailableBottles = targetLayer?.availableBottles || [];
          if (
            targetAvailableBottles.length > 0 &&
            !targetAvailableBottles.includes(draftProfile.wineBottleName)
          ) {
            draftUpdates[platId] = {
              ...draftProfile,
              wineBottleName: undefined,
            };
          }
        }
      }

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
            try {
              const parsed = JSON.parse(rawSig) as Record<string, unknown>;
              next[platId as StorefrontId] = JSON.stringify({ ...parsed, ...patch });
              changed = true;
            } catch {
              // ignore malformed baseline
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
            const rawSig = prev[currentPlatId];
            if (!rawSig) return prev;
            try {
              const parsed = JSON.parse(rawSig) as Record<string, unknown>;
              return {
                ...prev,
                [currentPlatId]: JSON.stringify({
                  ...parsed,
                  compatibilityLayer: autoLayer,
                  wineBottleName: '',
                }),
              };
            } catch {
              return prev;
            }
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
      const isSourceLayerHostSupported = isLayerHostSupported(activeSource?.compatibilityLayer);
      if ((!activeSource?.compatibilityLayer || !isSourceLayerHostSupported) && validLayers.length > 0) {
        const autoLayer = validLayers[0].type;
        setCompatibilityLayer((prev) => (prev === autoLayer ? prev : autoLayer));
        const rawSavedBottle = activeSource?.wineBottleName || '';
        const autoLayerBottles = validLayers[0].availableBottles || [];
        const isBottleValidForAuto =
          !rawSavedBottle ||
          (isFormBottleCompatibleWithRunner(rawSavedBottle, autoLayer, layers) &&
            (autoLayerBottles.length === 0 || autoLayerBottles.includes(rawSavedBottle)));
        const sanitizedBottle = isBottleValidForAuto ? rawSavedBottle : '';
        if (!isBottleValidForAuto) {
          setWineBottleName('');
        }
        setBaselineFieldsByPlatform((prev) => {
          const rawSig = prev[currentPlatId];
          if (!rawSig) return prev;
          try {
            const parsed = JSON.parse(rawSig) as Record<string, unknown>;
            return {
              ...prev,
              [currentPlatId]: JSON.stringify({
                ...parsed,
                compatibilityLayer: autoLayer,
                ...(isBottleValidForAuto ? {} : { wineBottleName: sanitizedBottle }),
              }),
            };
          } catch {
            return prev;
          }
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
        const isCompatibleWithTarget = isFormBottleCompatibleWithRunner(
          rawSavedBottle,
          targetRunner,
          layers
        );
        const shouldSanitizeOnColdLoad = Boolean(
          rawSavedBottle &&
            (!isInTargetOptions || (currentHostArch !== 'arm64' && !isCompatibleWithTarget))
        );
        if (shouldSanitizeOnColdLoad) {
          setWineBottleName((prev) => (prev === rawSavedBottle ? '' : prev));
          setBaselineFieldsByPlatform((prev) => {
            const rawSig = prev[currentPlatId];
            if (!rawSig) return prev;
            try {
              const parsed = JSON.parse(rawSig) as Record<string, unknown>;
              return {
                ...prev,
                [currentPlatId]: JSON.stringify({
                  ...parsed,
                  wineBottleName: '',
                }),
              };
            } catch {
              return prev;
            }
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

  useEffect(() => {
    if (!isOpen) return;
    return acquireModalOverlayLock();
  }, [isOpen]);

  // Keep read-only global defaults synchronized if the user edits SettingsModal while open
  useEffect(() => {
    if (!isOpen || typeof launcherService.subscribe !== 'function') return;
    return launcherService.subscribe(() => {
      const next = launcherService.getPerformanceSettings();
      setPerfSettings((prev) =>
        JSON.stringify(prev) === JSON.stringify(next) ? prev : next
      );
    });
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) return;
    let active = true;
    const sessionId = formSessionIdRef.current;
    setRunnerProgressByType(launcherService.getActiveRunnerOperations());
    const unsubscribe = launcherService.onRunnerProgress((event) => {
      if (!active || formSessionIdRef.current !== sessionId) return;
      const isTerminal =
        event.phase === 'completed' || event.phase === 'failed' || event.phase === 'cancelled';
      if (isTerminal) {
        setRunnerProgressByType((prev) => {
          if (!prev[event.runnerType]) return prev;
          const next = { ...prev };
          delete next[event.runnerType];
          return next;
        });
        if (event.phase === 'completed') {
          void launcherService.detectCompatibilityLayers().then((layers) => {
            if (!active || formSessionIdRef.current !== sessionId) return;
            if (Array.isArray(layers)) {
              hasDetectedLayersResolvedRef.current = true;
              latestDetectedLayersRef.current = layers;
              setDetectedLayers(layers);
            }
          });
          void launcherService.checkCompatibilityLayerUpdates().then((updates) => {
            if (!active || formSessionIdRef.current !== sessionId) return;
            if (updates && typeof updates === 'object') {
              setRunnerUpdates(updates);
            }
          });
        }
      } else {
        setRunnerProgressByType((prev) => ({
          ...prev,
          [event.runnerType]: event,
        }));
      }
    });
    return () => {
      active = false;
      unsubscribe();
    };
  }, [isOpen, game.id, initialPlatformId]);

  const selectedRunnerDescriptor =
    COMPATIBILITY_RUNNER_DESCRIPTORS.find((d) => d.type === compatibilityLayer) ||
    COMPATIBILITY_RUNNER_DESCRIPTORS[0];
  const activeLayer = detectedLayers.find((l) => l.type === compatibilityLayer);
  const activeUpdateInfo = runnerUpdates[compatibilityLayer];
  const availableBottles = activeLayer?.availableBottles || [];
  const activeRunnerProgress =
    compatibilityLayer !== 'native' ? runnerProgressByType[compatibilityLayer] : undefined;
  const isActiveOpOnSelectedRunner =
    !activeRunnerOpType || activeRunnerOpType === compatibilityLayer;
  const isAnotherRunnerOperationActive = Boolean(
    (isInstallingRunner || isUpdatingRunner) &&
      activeRunnerOpType &&
      activeRunnerOpType !== compatibilityLayer
  );
  const effectiveIsInstallingRunner =
    (isInstallingRunner && isActiveOpOnSelectedRunner) ||
    activeRunnerProgress?.operation === 'install';
  const effectiveIsUpdatingRunner =
    (isUpdatingRunner && isActiveOpOnSelectedRunner) ||
    activeRunnerProgress?.operation === 'update';
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
      JSON.stringify({
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
    const parsedEnv = stripManagedEnvVars(parseEnvVars(envText)) || {};
    const includeCompatSettings = !isWindowsHost && preview.visibleSections.compatibilityLayer;
    const includeCrossoverOnly =
      includeCompatSettings && preview.visibleSections.crossoverRendering;
    const priorSource =
      draftsByPlatform[preferredPlatformId] ??
      launcherService.getLaunchConfig(game.id, preferredPlatformId);

    const effectiveScalingMode: GlobalBottleDisplayScalingMode =
      displayScalingMode === 'default'
        ? (perfSettings.defaultBottleDisplayScalingMode ?? 'auto_fullscreen')
        : displayScalingMode;
    const normalizedVdRes = virtualDesktopResolution.trim().toLowerCase();

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
      crossoverHighResolutionMode:
        includeCompatSettings && crossoverHighResolutionMode === false ? false : undefined,
      crossoverDlss: includeCrossoverOnly
        ? isDlssSupportedBackend
          ? crossoverDlss
          : false
        : undefined,
      preferredMaxFrameRate: includeCompatSettings ? preferredMaxFrameRate : undefined,
      metalfxSpatialUpscaleFactor:
        includeCrossoverOnly &&
        resolveMetalfxSpatialEligibility({ crossoverGraphicsBackend }).supported
          ? metalfxSpatialUpscaleFactor
          : undefined,
      displayScalingMode:
        includeCompatSettings && displayScalingMode !== 'default' ? displayScalingMode : undefined,
      displayAspectRatio:
        includeCompatSettings && displayAspectRatio !== 'default' ? displayAspectRatio : undefined,
      virtualDesktop:
        includeCompatSettings && effectiveScalingMode === 'virtual_desktop' ? true : undefined,
      virtualDesktopResolution:
        includeCompatSettings && effectiveScalingMode === 'virtual_desktop'
          ? normalizedVdRes || 'auto'
          : undefined,
      emulateModeset: includeCompatSettings ? emulateModeset : undefined,
      forceLargeAddressAware: includeCompatSettings ? forceLargeAddressAware : undefined,
      audioBufferClamp: includeCompatSettings ? priorSource?.audioBufferClamp : undefined,
      advertiseAvx: includeCompatSettings ? priorSource?.advertiseAvx : undefined,
      wineDebug: includeCompatSettings ? priorSource?.wineDebug : undefined,
      wineMsync: includeCompatSettings ? wineMsync : undefined,
      wineEsync: includeCompatSettings ? wineEsync : undefined,
      performanceHud,
      metalHud: undefined,
      dxvkHud: undefined,
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
    selectedRunnerDescriptor,
    activeLayer,
    activeUpdateInfo,
    isCheckingUpdates,
    isUpdatingRunner: effectiveIsUpdatingRunner,
    isInstallingRunner: effectiveIsInstallingRunner,
    isAnotherRunnerOperationActive,
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
    selectedRunnerDescriptor,
    activeLayer,
    activeUpdateInfo,
    isCheckingUpdates,
    isUpdatingRunner: effectiveIsUpdatingRunner,
    isInstallingRunner: effectiveIsInstallingRunner,
    isAnotherRunnerOperationActive,
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
      if (isWindowsHost) {
        return {
          ...m,
          label: 'Auto-Detect (Recommended)',
          desc: 'Uses the native Windows executable or Storefront Client Protocol automatically.',
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
    const sessionId = formSessionIdRef.current;
    setIsRescanningRunners(true);
    setRunnerActionFeedback(null);
    try {
      const refreshed = await launcherService.detectCompatibilityLayers();
      if (formSessionIdRef.current !== sessionId) return;
      hasDetectedLayersResolvedRef.current = true;
      latestDetectedLayersRef.current = refreshed;
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
      if (formSessionIdRef.current === sessionId) {
        setIsRescanningRunners(false);
      }
    }
  }, []);

  const handleCheckRunnerUpdates = useCallback(async () => {
    if (latestRef.current.isCheckingUpdates) return;
    const sessionId = formSessionIdRef.current;
    setIsCheckingUpdates(true);
    setRunnerUpdateFeedback(null);
    try {
      const [updates, refreshedLayers] = await Promise.all([
        launcherService.checkCompatibilityLayerUpdates(),
        launcherService.detectCompatibilityLayers(),
      ]);
      if (formSessionIdRef.current !== sessionId) return;
      if (updates && typeof updates === 'object') {
        setRunnerUpdates(updates);
      }
      if (Array.isArray(refreshedLayers)) {
        hasDetectedLayersResolvedRef.current = true;
        latestDetectedLayersRef.current = refreshedLayers;
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
    } catch (err: unknown) {
      if (formSessionIdRef.current !== sessionId) return;
      const errMsg =
        err instanceof Error && err.message
          ? err.message
          : `Could not check for ${latestRef.current.selectedRunnerDescriptor.shortLabel} updates.`;
      setRunnerUpdateFeedback(errMsg);
    } finally {
      if (formSessionIdRef.current === sessionId) {
        setIsCheckingUpdates(false);
      }
    }
  }, []);

  const clearRunnerProgressEntry = useCallback(
    (runnerKey: Exclude<CompatibilityLayerType, 'native'>) => {
      setRunnerProgressByType((prev) => {
        if (!prev[runnerKey]) return prev;
        const next = { ...prev };
        delete next[runnerKey];
        return next;
      });
    },
    []
  );

  const applyStableCrossOverSwitch = useCallback(
    (targetPlatformId: StorefrontId, refreshedLayers: CompatibilityLayerInfo[]) => {
      const crossoverLayer = refreshedLayers.find((l) => l.type === 'crossover');
      const crossoverAvailable = crossoverLayer?.availableBottles || [];
      const isBottleValidForCrossover = (bottleValue: string): boolean => {
        if (!bottleValue) return true;
        const isInAvailable =
          crossoverAvailable.length === 0 || crossoverAvailable.includes(bottleValue);
        const isCompatible = isFormBottleCompatibleWithRunner(
          bottleValue,
          'crossover',
          refreshedLayers
        );
        return isInAvailable && isCompatible;
      };
      userEditedCompatPlatformsRef.current.add(targetPlatformId);
      userResetPendingDetectPlatformsRef.current.delete(targetPlatformId);
      if (latestRef.current.preferredPlatformId === targetPlatformId) {
        setCompatibilityLayer('crossover');
        const currentBottle = latestRef.current.wineBottleName.trim();
        if (currentBottle && !isBottleValidForCrossover(currentBottle)) {
          setWineBottleName('');
        }
      } else {
        setDraftsByPlatform((prev) => {
          const baseDraft =
            prev[targetPlatformId] ??
            launcherService.getLaunchConfig(latestRef.current.game.id, targetPlatformId);
          const draftBottle = baseDraft?.wineBottleName?.trim() || '';
          const shouldClearDraftBottle =
            Boolean(draftBottle) && !isBottleValidForCrossover(draftBottle);
          return {
            ...prev,
            [targetPlatformId]: {
              ...(baseDraft || {}),
              compatibilityLayer: 'crossover',
              ...(shouldClearDraftBottle ? { wineBottleName: undefined } : {}),
            },
          };
        });
        setDirtyInactivePlatforms((prev) =>
          prev.includes(targetPlatformId) ? prev : [...prev, targetPlatformId]
        );
      }
    },
    []
  );

  const handleUpdateRunner = useCallback(async () => {
    const cur = latestRef.current;
    if (
      cur.isUpdatingRunner ||
      cur.isInstallingRunner ||
      cur.isAnotherRunnerOperationActive ||
      cur.compatibilityLayer === 'native'
    ) {
      return;
    }
    const sessionId = formSessionIdRef.current;
    const runnerKey = cur.compatibilityLayer as Exclude<CompatibilityLayerType, 'native'>;
    const targetPlatformId = cur.preferredPlatformId;
    const targetCompatEpoch = compatEditEpochByPlatformRef.current[targetPlatformId] ?? 0;
    activeRunnerOpTypeRef.current = runnerKey;
    setActiveRunnerOpType(runnerKey);
    setIsUpdatingRunner(true);
    setRunnerUpdateFeedback(null);
    setRunnerActionFeedback(null);
    try {
      const isPreviewBranch =
        runnerKey === 'crossover_preview' || runnerKey === 'crossover_preview_arm64';
      const shouldSwitchPreviewToStable =
        runnerKey === 'crossover_preview' &&
        Boolean(cur.activeUpdateInfo?.stableSurpassesPreview) &&
        !cur.activeUpdateInfo?.canAutoUpdate;
      const shouldAuthenticateOnly =
        isPreviewBranch &&
        !shouldSwitchPreviewToStable &&
        Boolean(cur.activeUpdateInfo?.authRequired) &&
        !cur.activeUpdateInfo?.updateAvailable;

      const res = shouldSwitchPreviewToStable
        ? await launcherService.updateCompatibilityLayer('crossover_preview', {
            switchToStableCrossOver: true,
          })
        : shouldAuthenticateOnly
          ? await launcherService.updateCompatibilityLayer(runnerKey, { authenticateOnly: true })
          : await launcherService.updateCompatibilityLayer(runnerKey);
      if (formSessionIdRef.current !== sessionId) return;
      const refreshedLayers =
        res.detectedLayers || (await launcherService.detectCompatibilityLayers());
      if (formSessionIdRef.current !== sessionId) return;
      hasDetectedLayersResolvedRef.current = true;
      latestDetectedLayersRef.current = refreshedLayers;
      setDetectedLayers(refreshedLayers);
      if (res.updateInfo) {
        const latestFromService = launcherService.getRunnerUpdates();
        const targetInfoKey =
          res.updateInfo.runnerType || res.runnerType || cur.compatibilityLayer;
        setRunnerUpdates((prev) => ({
          ...prev,
          ...latestFromService,
          [targetInfoKey]: res.updateInfo!,
        }));
      } else {
        setRunnerUpdates({ ...launcherService.getRunnerUpdates() });
      }
      if (
        shouldSwitchPreviewToStable &&
        res.success &&
        refreshedLayers.some((l) => l.type === 'crossover') &&
        formSessionIdRef.current === sessionId &&
        (compatEditEpochByPlatformRef.current[targetPlatformId] ?? 0) === targetCompatEpoch
      ) {
        applyStableCrossOverSwitch(targetPlatformId, refreshedLayers);
      }
      setRunnerUpdateFeedback(res.message || res.error || null);
    } catch (err: unknown) {
      if (formSessionIdRef.current !== sessionId) return;
      const errMsg =
        err instanceof Error && err.message
          ? err.message
          : `Could not update ${cur.selectedRunnerDescriptor.shortLabel}.`;
      setRunnerUpdateFeedback(errMsg);
      setRunnerActionFeedback({ tone: 'amber', text: errMsg });
    } finally {
      if (activeRunnerOpTypeRef.current === runnerKey) {
        activeRunnerOpTypeRef.current = null;
      }
      if (formSessionIdRef.current === sessionId) {
        clearRunnerProgressEntry(runnerKey);
        setActiveRunnerOpType((prev) => (prev === runnerKey ? null : prev));
        setIsUpdatingRunner(false);
      }
    }
  }, [applyStableCrossOverSwitch, clearRunnerProgressEntry]);

  const handleInstallRunnerViaBrew = useCallback(async () => {
    const cur = latestRef.current;
    if (
      cur.isInstallingRunner ||
      cur.isUpdatingRunner ||
      cur.isAnotherRunnerOperationActive ||
      cur.compatibilityLayer === 'native'
    ) {
      return;
    }
    const sessionId = formSessionIdRef.current;
    const runnerKey = cur.compatibilityLayer as Exclude<CompatibilityLayerType, 'native'>;
    activeRunnerOpTypeRef.current = runnerKey;
    setActiveRunnerOpType(runnerKey);
    setIsInstallingRunner(true);
    setRunnerActionFeedback(null);
    try {
      const res = await launcherService.installCompatibilityLayer(runnerKey, 'auto');
      if (formSessionIdRef.current !== sessionId) return;
      const refreshed = res.layers || (await launcherService.detectCompatibilityLayers());
      if (formSessionIdRef.current !== sessionId) return;
      hasDetectedLayersResolvedRef.current = true;
      latestDetectedLayersRef.current = refreshed;
      setDetectedLayers(refreshed);
      setRunnerUpdates({ ...launcherService.getRunnerUpdates() });
      if (res.success) {
        setRunnerActionFeedback({
          tone: 'emerald',
          text:
            res.message ||
            `${cur.selectedRunnerDescriptor.shortLabel} downloaded, installed, and ready to use.`,
        });
      } else {
        setRunnerActionFeedback({
          tone: 'amber',
          text:
            res.error ||
            res.message ||
            `Could not install ${cur.selectedRunnerDescriptor.shortLabel}. Please check your internet connection and try again.`,
        });
      }
    } catch (err: unknown) {
      if (formSessionIdRef.current !== sessionId) return;
      const errMsg =
        err instanceof Error && err.message
          ? err.message
          : `Could not install ${cur.selectedRunnerDescriptor.shortLabel}. Please check your internet connection and try again.`;
      setRunnerActionFeedback({
        tone: 'amber',
        text: errMsg,
      });
    } finally {
      if (activeRunnerOpTypeRef.current === runnerKey) {
        activeRunnerOpTypeRef.current = null;
      }
      if (formSessionIdRef.current === sessionId) {
        clearRunnerProgressEntry(runnerKey);
        setActiveRunnerOpType((prev) => (prev === runnerKey ? null : prev));
        setIsInstallingRunner(false);
      }
    }
  }, [clearRunnerProgressEntry]);

  const handleInstallRunnerFromArchive = useCallback(async () => {
    const cur = latestRef.current;
    if (
      cur.isInstallingRunner ||
      cur.isUpdatingRunner ||
      cur.isAnotherRunnerOperationActive ||
      cur.compatibilityLayer === 'native'
    ) {
      return;
    }
    const sessionId = formSessionIdRef.current;
    const runnerKey = cur.compatibilityLayer as Exclude<CompatibilityLayerType, 'native'>;
    const isUpdatingMode = Boolean(cur.activeLayer);
    activeRunnerOpTypeRef.current = runnerKey;
    setActiveRunnerOpType(runnerKey);
    try {
      const archivePath = await launcherService.selectRunnerArchive();
      if (!archivePath || formSessionIdRef.current !== sessionId) return;

      const isDmg = archivePath.toLowerCase().endsWith('.dmg');
      const archiveOpts = {
        archivePath,
        ...(isDmg ? { dmgPath: archivePath } : {}),
      };

      if (cur.activeLayer) {
        setIsUpdatingRunner(true);
        setRunnerUpdateFeedback(null);
        const res = await launcherService.updateCompatibilityLayer(runnerKey, archiveOpts);
        if (formSessionIdRef.current !== sessionId) return;
        const refreshedLayers =
          res.detectedLayers || (await launcherService.detectCompatibilityLayers());
        if (formSessionIdRef.current !== sessionId) return;
        hasDetectedLayersResolvedRef.current = true;
        latestDetectedLayersRef.current = refreshedLayers;
        setDetectedLayers(refreshedLayers);
        if (res.updateInfo) {
          const latestFromService = launcherService.getRunnerUpdates();
          const targetInfoKey = res.updateInfo.runnerType || res.runnerType || runnerKey;
          setRunnerUpdates((prev) => ({
            ...prev,
            ...latestFromService,
            [targetInfoKey]: res.updateInfo!,
          }));
        } else {
          setRunnerUpdates({ ...launcherService.getRunnerUpdates() });
        }
        setRunnerUpdateFeedback(res.message || res.error || null);
      } else {
        setIsInstallingRunner(true);
        setRunnerActionFeedback(null);
        const res = await launcherService.installCompatibilityLayer(
          runnerKey,
          'direct',
          archiveOpts
        );
        if (formSessionIdRef.current !== sessionId) return;
        const refreshed = res.layers || (await launcherService.detectCompatibilityLayers());
        if (formSessionIdRef.current !== sessionId) return;
        hasDetectedLayersResolvedRef.current = true;
        latestDetectedLayersRef.current = refreshed;
        setDetectedLayers(refreshed);
        setRunnerUpdates({ ...launcherService.getRunnerUpdates() });
        setRunnerActionFeedback({
          tone: res.success ? 'emerald' : 'amber',
          text:
            res.message ||
            res.error ||
            (res.success
              ? `${cur.selectedRunnerDescriptor.shortLabel} installed from local archive.`
              : `Could not install ${cur.selectedRunnerDescriptor.shortLabel} from archive.`),
        });
      }
    } catch (err: unknown) {
      if (formSessionIdRef.current !== sessionId) return;
      const errMsg =
        err instanceof Error && err.message
          ? err.message
          : isUpdatingMode
            ? `Could not update ${cur.selectedRunnerDescriptor.shortLabel} from archive.`
            : `Could not install ${cur.selectedRunnerDescriptor.shortLabel} from archive.`;
      if (isUpdatingMode) {
        setRunnerUpdateFeedback(errMsg);
      }
      setRunnerActionFeedback({ tone: 'amber', text: errMsg });
    } finally {
      if (activeRunnerOpTypeRef.current === runnerKey) {
        activeRunnerOpTypeRef.current = null;
      }
      if (formSessionIdRef.current === sessionId) {
        clearRunnerProgressEntry(runnerKey);
        setActiveRunnerOpType((prev) => (prev === runnerKey ? null : prev));
        setIsUpdatingRunner(false);
        setIsInstallingRunner(false);
      }
    }
  }, [clearRunnerProgressEntry]);

  const handleCancelRunnerOperation = useCallback(async () => {
    const cur = latestRef.current;
    const trackedRunnerKey = activeRunnerOpTypeRef.current;
    if (!trackedRunnerKey && cur.compatibilityLayer === 'native') return;
    const sessionId = formSessionIdRef.current;
    const runnerKey =
      trackedRunnerKey ||
      (cur.compatibilityLayer as Exclude<CompatibilityLayerType, 'native'>);
    const opDescriptor =
      COMPATIBILITY_RUNNER_DESCRIPTORS.find((d) => d.type === runnerKey) ||
      cur.selectedRunnerDescriptor;
    await launcherService.cancelCompatibilityLayerOperation(runnerKey);
    if (formSessionIdRef.current !== sessionId) return;
    activeRunnerOpTypeRef.current = null;
    setActiveRunnerOpType(null);
    clearRunnerProgressEntry(runnerKey);
    setIsInstallingRunner(false);
    setIsUpdatingRunner(false);
    setRunnerActionFeedback({
      tone: 'amber',
      text: `${opDescriptor.shortLabel} operation cancelled.`,
    });
  }, [clearRunnerProgressEntry]);

  const handleSwitchToStableCrossOver = useCallback(async () => {
    const cur = latestRef.current;
    if (cur.isUpdatingRunner || cur.isInstallingRunner || cur.isAnotherRunnerOperationActive) return;
    const sessionId = formSessionIdRef.current;
    const targetPlatformId = cur.preferredPlatformId;
    const targetCompatEpoch = compatEditEpochByPlatformRef.current[targetPlatformId] ?? 0;
    activeRunnerOpTypeRef.current = 'crossover_preview';
    setActiveRunnerOpType('crossover_preview');
    setIsUpdatingRunner(true);
    setRunnerUpdateFeedback(null);
    try {
      const res = await launcherService.updateCompatibilityLayer('crossover_preview', {
        switchToStableCrossOver: true,
      });
      if (formSessionIdRef.current !== sessionId) return;
      const refreshedLayers =
        res.detectedLayers || (await launcherService.detectCompatibilityLayers());
      if (formSessionIdRef.current !== sessionId) return;
      hasDetectedLayersResolvedRef.current = true;
      latestDetectedLayersRef.current = refreshedLayers;
      setDetectedLayers(refreshedLayers);
      setRunnerUpdates({ ...launcherService.getRunnerUpdates() });
      if (
        res.success &&
        refreshedLayers.some((l) => l.type === 'crossover') &&
        formSessionIdRef.current === sessionId &&
        (compatEditEpochByPlatformRef.current[targetPlatformId] ?? 0) === targetCompatEpoch
      ) {
        applyStableCrossOverSwitch(targetPlatformId, refreshedLayers);
      }
      setRunnerUpdateFeedback(
        res.message ||
          res.error ||
          (res.success ? 'Switched to CrossOver Stable.' : 'Could not switch to CrossOver Stable.')
      );
    } catch (err: unknown) {
      if (formSessionIdRef.current !== sessionId) return;
      const errMsg =
        err instanceof Error && err.message
          ? err.message
          : 'Could not switch to CrossOver Stable.';
      setRunnerUpdateFeedback(errMsg);
    } finally {
      if (activeRunnerOpTypeRef.current === 'crossover_preview') {
        activeRunnerOpTypeRef.current = null;
      }
      if (formSessionIdRef.current === sessionId) {
        clearRunnerProgressEntry('crossover_preview');
        clearRunnerProgressEntry('crossover');
        setActiveRunnerOpType((prev) => (prev === 'crossover_preview' ? null : prev));
        setIsUpdatingRunner(false);
      }
    }
  }, [applyStableCrossOverSwitch, clearRunnerProgressEntry]);

  const handleDownloadRunner = useCallback(async () => {
    const cur = latestRef.current;
    if (cur.compatibilityLayer === 'native') return;
    const sessionId = formSessionIdRef.current;
    const res = await launcherService.installCompatibilityLayer(
      cur.compatibilityLayer as Exclude<CompatibilityLayerType, 'native'>,
      'download'
    );
    if (formSessionIdRef.current !== sessionId) return;
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
    const cur = latestRef.current;
    compatEditEpochByPlatformRef.current[cur.preferredPlatformId] =
      (compatEditEpochByPlatformRef.current[cur.preferredPlatformId] ?? 0) + 1;
    userEditedCompatPlatformsRef.current.add(cur.preferredPlatformId);
    userResetPendingDetectPlatformsRef.current.delete(cur.preferredPlatformId);
    setCompatibilityLayer(nextLayer);
    if (cur.wineBottleName) {
      const nextLayerObj = cur.detectedLayers.find((l) => l.type === nextLayer);
      const nextAvailable = nextLayerObj?.availableBottles || [];
      const isCompatible = isFormBottleCompatibleWithRunner(
        cur.wineBottleName,
        nextLayer,
        cur.detectedLayers
      );
      const isInNextAvailable =
        nextAvailable.length === 0 || nextAvailable.includes(cur.wineBottleName);
      if (!isCompatible || !isInNextAvailable) {
        setWineBottleName('');
      }
    }
    setRunnerActionFeedback(null);
    setRunnerUpdateFeedback(null);
  }, []);

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
      (l) =>
        l.available !== false &&
        COMPATIBILITY_RUNNER_DESCRIPTORS.some((d) => d.type === l.type) &&
        (l.type !== 'crossover_preview_arm64' || resetHostArch === 'arm64')
    );
    const resetPreview = launcherService.resolveEffectiveLaunchModePreview(
      game,
      targetPlatId,
      {}
    );
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
    const resetSignature = JSON.stringify({
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
    setRunnerActionFeedback(null);
    setRunnerUpdateFeedback(null);
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
    isInstallingRunner: effectiveIsInstallingRunner,
    isAnotherRunnerOperationActive,
    isRescanningRunners,
    runnerActionFeedback,
    runnerUpdates,
    isCheckingUpdates,
    isUpdatingRunner: effectiveIsUpdatingRunner,
    runnerUpdateFeedback,
    runnerProgressByType,
    activeRunnerProgress,
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
    handleRescanLayers,
    handleCheckRunnerUpdates,
    handleUpdateRunner,
    handleInstallRunnerViaBrew,
    handleInstallRunnerFromArchive,
    handleCancelRunnerOperation,
    handleSwitchToStableCrossOver,
    handleDownloadRunner,
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
