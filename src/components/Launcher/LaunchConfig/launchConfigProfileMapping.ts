import type { CanonicalGame } from '../../../contracts/game';
import { getHostCapabilities, type HostPlatformCapabilities } from '../../../contracts/hostPlatform';
import type { StorefrontId } from '../../../contracts/platform';
import {
  type BottleDisplayScalingMode,
  type CompatibilityLayerInfo,
  type CompatibilityLayerType,
  type CrossOverD3DMetalVersion,
  type DisplayAspectRatioMode,
  type GlobalBottleDisplayScalingMode,
  type InGameLauncherBehavior,
  type LauncherPerformanceSettings,
  type LaunchMethod,
  migrateLegacyHudConfig,
  type PerformanceHudMode,
  type ResolvedLaunchModePreview,
  type StorefrontClientLifecyclePolicy,
  type StorefrontLaunchProfile,
} from '../../../contracts/launcher';
import { isBottleNameCompatibleWithRunner } from '../../../services/launcher/bottleArchitectureUtils';
import {
  COMPATIBILITY_RUNNER_DESCRIPTORS,
  launcherService,
} from '../../../services/launcher/launcherService';
import { resolveMetalfxSpatialEligibility } from './CompatibilityLayerSection';
import {
  type LaunchConfigSignatureFields,
  serializeLaunchConfigSignature,
} from './launchConfigDirtySignature';
import {
  LAUNCH_MODES,
  parseEnvVars,
  serializeEnvVars,
  stripManagedEnvVars,
} from './launchConfigHelpers';

export function resolveFormHostCapabilities(): HostPlatformCapabilities {
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

export function isHostSupportedCompatRunner(
  layerType: CompatibilityLayerType | undefined,
  hostArch: string
): layerType is Exclude<CompatibilityLayerType, 'native'> {
  return Boolean(
    layerType &&
      layerType !== 'native' &&
      COMPATIBILITY_RUNNER_DESCRIPTORS.some((d) => d.type === layerType) &&
      (layerType !== 'crossover_preview_arm64' || hostArch === 'arm64')
  );
}

export interface ParsedLaunchConfigFields extends LaunchConfigSignatureFields {
  signature: string;
}

export function parseLaunchConfigProfileFields(params: {
  game: CanonicalGame;
  targetPlatId: StorefrontId;
  source: StorefrontLaunchProfile | undefined;
  allRawLayers: CompatibilityLayerInfo[];
  hostArch: string;
}): ParsedLaunchConfigFields {
  const { game, targetPlatId, source, allRawLayers, hostArch } = params;
  const activeLayers = allRawLayers.filter(
    (l) => l.available !== false && isHostSupportedCompatRunner(l.type, hostArch)
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
  } else if (source?.launchMethod === 'auto' && initialPreview.availableModes.includes('auto')) {
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

  const defaultLayer: CompatibilityLayerType = isHostSupportedCompatRunner(
    source?.compatibilityLayer,
    hostArch
  )
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
  const isSavedBottleCompatible = isBottleNameCompatibleWithRunner(rawSavedBottle, defaultLayer, {
    allLayers: allRawLayers,
  });
  const resolvedWineBottleName =
    rawSavedBottle &&
    (!isSavedBottleInFallbackOptions ||
      ((wasSavedLayerRejected || hostArch !== 'arm64') && !isSavedBottleCompatible))
      ? ''
      : rawSavedBottle;

  const loadedCrossoverD3DVer: CrossOverD3DMetalVersion =
    source?.crossoverD3DMetalVersion ||
    (source?.environmentVariables?.CX_GRAPHICS_BACKEND_VERSION === '3' ||
    source?.environmentVariables?.CX_GRAPHICS_BACKEND_VERSION === '4'
      ? source.environmentVariables.CX_GRAPHICS_BACKEND_VERSION
      : 'auto');

  // Normalize legacy crossoverHighResolutionMode: true -> undefined (identical under Display Scaler v3)
  const normalizedHighResMode = source?.crossoverHighResolutionMode === false ? false : undefined;

  const envMaxFpsRaw =
    source?.environmentVariables?.DXVK_FRAME_RATE || source?.environmentVariables?.D3DM_MAX_FPS;
  const envMaxFpsParsed = envMaxFpsRaw ? Math.round(Number(envMaxFpsRaw)) : NaN;
  const loadedMaxFps =
    typeof source?.preferredMaxFrameRate === 'number' &&
    Number.isFinite(source.preferredMaxFrameRate) &&
    source.preferredMaxFrameRate > 0
      ? Math.round(source.preferredMaxFrameRate)
      : Number.isFinite(envMaxFpsParsed) && envMaxFpsParsed > 0
        ? envMaxFpsParsed
        : undefined;

  const envSpatialRaw = source?.environmentVariables?.DXMT_METALFX_SPATIAL_SWAPCHAIN;
  const envSpatialParsed = envSpatialRaw ? Number(envSpatialRaw) : NaN;
  const dxmtConfigRaw = source?.environmentVariables?.DXMT_CONFIG;
  const dxmtConfigSpatialMatch =
    typeof dxmtConfigRaw === 'string'
      ? /d3d11\.metalSpatialUpscaleFactor\s*=\s*([0-9.]+)/i.exec(dxmtConfigRaw)
      : null;
  const dxmtConfigSpatialParsed = dxmtConfigSpatialMatch ? Number(dxmtConfigSpatialMatch[1]) : NaN;
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

  const loadedDisplayAspectRatio: DisplayAspectRatioMode =
    source?.displayAspectRatio &&
    (source.displayAspectRatio === 'default' ||
      source.displayAspectRatio === 'preserve_aspect' ||
      source.displayAspectRatio === 'integer' ||
      source.displayAspectRatio === 'stretch')
      ? source.displayAspectRatio
      : 'default';

  const loadedVirtualDesktopResolution =
    typeof source?.virtualDesktopResolution === 'string' &&
    source.virtualDesktopResolution.trim().length > 0
      ? source.virtualDesktopResolution.trim().toLowerCase()
      : 'auto';

  const loadedForceLaa =
    source?.forceLargeAddressAware !== undefined
      ? Boolean(source.forceLargeAddressAware)
      : source?.environmentVariables?.WINE_LARGE_ADDRESS_AWARE === '1'
        ? true
        : source?.environmentVariables?.WINE_LARGE_ADDRESS_AWARE === '0'
          ? false
          : undefined;

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

  const loadedEnvText = serializeEnvVars(stripManagedEnvVars(source?.environmentVariables));
  const loadedPreLaunch = source?.preLaunchCommand || '';
  const loadedPostExit = source?.postExitCommand || '';
  const loadedInGameBehavior: 'default' | InGameLauncherBehavior =
    source?.inGameLauncherBehavior || 'default';

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

  const fields: LaunchConfigSignatureFields = {
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
  };

  return {
    ...fields,
    signature: serializeLaunchConfigSignature(fields),
  };
}

export function buildStorefrontLaunchProfile(params: {
  fields: LaunchConfigSignatureFields;
  isWindowsHost: boolean;
  preview: ResolvedLaunchModePreview;
  priorSource: StorefrontLaunchProfile | undefined;
  perfSettings: LauncherPerformanceSettings;
  isDlssSupportedBackend: boolean;
}): StorefrontLaunchProfile {
  const { fields, isWindowsHost, preview, priorSource, perfSettings, isDlssSupportedBackend } =
    params;
  const parsedEnv = stripManagedEnvVars(parseEnvVars(fields.envText)) || {};
  const includeCompatSettings = !isWindowsHost && preview.visibleSections.compatibilityLayer;
  const includeCrossoverOnly = includeCompatSettings && preview.visibleSections.crossoverRendering;

  const effectiveScalingMode: GlobalBottleDisplayScalingMode =
    fields.displayScalingMode === 'default'
      ? (perfSettings.defaultBottleDisplayScalingMode ?? 'auto_fullscreen')
      : fields.displayScalingMode;
  const normalizedVdRes = fields.virtualDesktopResolution.trim().toLowerCase();

  const candidateMethod: LaunchMethod =
    isWindowsHost && fields.launchMethod === 'compatibility_layer'
      ? preview.defaultLaunchMethod
      : preview.availableModes.includes(fields.launchMethod)
        ? fields.launchMethod
        : preview.defaultLaunchMethod;
  const normalizedMethod: LaunchMethod =
    preview.modeNotes[candidateMethod]?.disabled &&
    preview.availableModes.includes('direct') &&
    !preview.modeNotes.direct?.disabled
      ? 'direct'
      : candidateMethod;

  return {
    launchMethod: normalizedMethod,
    customExecutablePath: fields.customExecutablePath.trim() || undefined,
    workingDirectory: fields.workingDirectory.trim() || undefined,
    launchArguments: fields.launchArguments.trim() || undefined,
    compatibilityLayer:
      includeCompatSettings && fields.compatibilityLayer !== 'native'
        ? fields.compatibilityLayer
        : undefined,
    wineBottleName: includeCompatSettings ? fields.wineBottleName.trim() || undefined : undefined,
    winePrefixPath: includeCompatSettings ? fields.winePrefixPath.trim() || undefined : undefined,
    crossoverGraphicsBackend: includeCrossoverOnly ? fields.crossoverGraphicsBackend : undefined,
    crossoverD3DMetalVersion:
      includeCrossoverOnly && fields.crossoverD3DMetalVersion !== 'auto'
        ? fields.crossoverD3DMetalVersion
        : undefined,
    crossoverHighResolutionMode:
      includeCompatSettings && fields.crossoverHighResolutionMode === false ? false : undefined,
    crossoverDlss: includeCrossoverOnly
      ? isDlssSupportedBackend
        ? fields.crossoverDlss
        : false
      : undefined,
    preferredMaxFrameRate: includeCompatSettings ? fields.preferredMaxFrameRate : undefined,
    metalfxSpatialUpscaleFactor:
      includeCrossoverOnly &&
      resolveMetalfxSpatialEligibility({
        crossoverGraphicsBackend: fields.crossoverGraphicsBackend,
      }).supported
        ? fields.metalfxSpatialUpscaleFactor
        : undefined,
    displayScalingMode:
      includeCompatSettings && fields.displayScalingMode !== 'default'
        ? fields.displayScalingMode
        : undefined,
    displayAspectRatio:
      includeCompatSettings && fields.displayAspectRatio !== 'default'
        ? fields.displayAspectRatio
        : undefined,
    virtualDesktop:
      includeCompatSettings && effectiveScalingMode === 'virtual_desktop' ? true : undefined,
    virtualDesktopResolution:
      includeCompatSettings && effectiveScalingMode === 'virtual_desktop'
        ? normalizedVdRes || 'auto'
        : undefined,
    emulateModeset: includeCompatSettings ? fields.emulateModeset : undefined,
    forceLargeAddressAware: includeCompatSettings ? fields.forceLargeAddressAware : undefined,
    audioBufferClamp: includeCompatSettings ? priorSource?.audioBufferClamp : undefined,
    advertiseAvx: includeCompatSettings ? priorSource?.advertiseAvx : undefined,
    wineDebug: includeCompatSettings ? priorSource?.wineDebug : undefined,
    wineMsync: includeCompatSettings ? fields.wineMsync : undefined,
    wineEsync: includeCompatSettings ? fields.wineEsync : undefined,
    performanceHud: fields.performanceHud,
    metalHud: undefined,
    dxvkHud: undefined,
    environmentVariables: Object.keys(parsedEnv).length > 0 ? parsedEnv : undefined,
    preLaunchCommand: fields.preLaunchCommand.trim() || undefined,
    postExitCommand: fields.postExitCommand.trim() || undefined,
    inGameLauncherBehavior:
      fields.inGameLauncherBehavior !== 'default' ? fields.inGameLauncherBehavior : undefined,
    storefrontClientLifecycle:
      fields.storefrontClientLifecycle !== 'default'
        ? fields.storefrontClientLifecycle
        : undefined,
  };
}

export function buildVisibleLaunchModes(params: {
  preview: ResolvedLaunchModePreview;
  isWindowsHost: boolean;
  isMacNativeBuild: boolean;
  isNativeInstalledBuild: boolean;
}): { value: LaunchMethod; label: string; desc: string }[] {
  const { preview, isWindowsHost, isMacNativeBuild, isNativeInstalledBuild } = params;
  return LAUNCH_MODES.filter((m) => preview.availableModes.includes(m.value)).map((m) => {
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
}

export interface ReconciledDraftUpdates {
  draftUpdates: Partial<Record<StorefrontId, StorefrontLaunchProfile>>;
  baselineDraftPatches: Partial<
    Record<StorefrontId, Partial<Pick<LaunchConfigSignatureFields, 'compatibilityLayer' | 'wineBottleName'>>>
  >;
}

/**
 * Reconciles inactive platform drafts when cold-cache `detectCompatibilityLayers()` resolves.
 */
export function reconcileInactiveDraftsWithDetectedLayers(params: {
  layers: CompatibilityLayerInfo[];
  validLayers: CompatibilityLayerInfo[];
  currentPlatId: StorefrontId;
  currentHostArch: string;
  currentDrafts: Partial<Record<StorefrontId, StorefrontLaunchProfile>>;
  userEditedCompatPlatforms: Set<StorefrontId>;
  userResetPendingDetectPlatforms: Set<StorefrontId>;
}): ReconciledDraftUpdates {
  const {
    layers,
    validLayers,
    currentPlatId,
    currentHostArch,
    currentDrafts,
    userEditedCompatPlatforms,
    userResetPendingDetectPlatforms,
  } = params;

  const draftUpdates: Partial<Record<StorefrontId, StorefrontLaunchProfile>> = {};
  const baselineDraftPatches: ReconciledDraftUpdates['baselineDraftPatches'] = {};

  for (const [rawPlatId, draftProfile] of Object.entries(currentDrafts)) {
    const platId = rawPlatId as StorefrontId;
    if (platId === currentPlatId || !draftProfile) continue;

    if (userResetPendingDetectPlatforms.has(platId) && validLayers.length > 0) {
      userResetPendingDetectPlatforms.delete(platId);
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

    if (!userEditedCompatPlatforms.has(platId)) {
      const isDraftLayerSupported = isHostSupportedCompatRunner(
        draftProfile.compatibilityLayer,
        currentHostArch
      );
      if ((!draftProfile.compatibilityLayer || !isDraftLayerSupported) && validLayers.length > 0) {
        const autoLayer = validLayers[0].type;
        const rawBottle = draftProfile.wineBottleName || '';
        const autoBottles = validLayers[0].availableBottles || [];
        const isBottleValidForAuto =
          !rawBottle ||
          (isBottleNameCompatibleWithRunner(rawBottle, autoLayer, { allLayers: layers }) &&
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
          const isInTargetOptions = targetBottles.length === 0 || targetBottles.includes(rawBottle);
          const isCompatibleWithTarget = isBottleNameCompatibleWithRunner(
            rawBottle,
            draftProfile.compatibilityLayer,
            { allLayers: layers }
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

  return { draftUpdates, baselineDraftPatches };
}
