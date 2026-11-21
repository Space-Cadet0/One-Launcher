import React from 'react';
import {
  BottleDisplayScalingMode,
  CompatibilityLayerInfo,
  CompatibilityLayerType,
  CompatibilityLayerUpdateInfo,
  CompatibilityRunnerDescriptor,
  CompatibilityRunnerProgressEvent,
  CrossOverD3DMetalVersion,
  CrossOverGraphicsBackend,
  DisplayAspectRatioMode,
  GlobalBottleDisplayScalingMode,
  GlobalDisplayAspectRatioMode,
  InstalledGameRecord,
  LaunchMethod,
  resolveDefaultBottleForLayer,
  ResolvedLaunchModePreview,
  VirtualDesktopResolutionPreset,
} from '../../../contracts/launcher';
import type { StorefrontId } from '../../../contracts/platform';
import { Cpu } from 'lucide-react';
import {
  extractBottleNameFromPath,
  findCompatibleRunnerForBottle,
  hasBottleArchitectureMismatch,
  isArm64NamedBottle,
  isBottleNameCompatibleWithRunner,
  resolveBottleArchitectureFromLayers,
} from '../../../services/launcher/bottleArchitectureUtils';
import { environmentSetupService } from '../../../services/launcher/environmentSetupService';
import {
  COMPATIBILITY_RUNNER_DESCRIPTORS,
  launcherService,
} from '../../../services/launcher/launcherService';
import {
  COMPAT_LAYER_OPTIONS,
  VIRTUAL_DESKTOP_RESOLUTION_OPTIONS,
  formatGlobalBottleDisplayModeLabel,
  formatGlobalDisplayAspectLabel,
  formatRunnerSecondaryBuildText,
  formatUserFacingPath,
  getCrossOverGraphicsBackendPolicy,
  resolveWineSyncMode,
  type WineSyncMode,
} from './launchConfigHelpers';
import { renderCompatRunnerAndBottleControls } from './CompatRunnerAndBottleControls';
import { renderCompatGraphicsControls } from './CompatGraphicsControls';
import { renderCompatAdvancedDisplayDisclosure } from './CompatAdvancedDisplayDisclosure';

export interface DlssEligibilityResult {
  supported: boolean;
  reason?: string;
}

export function resolveDlssEligibility(params: {
  crossoverGraphicsBackend: CrossOverGraphicsBackend;
  activeLayer?: CompatibilityLayerInfo;
  preview?: Pick<ResolvedLaunchModePreview, 'executableArchitecture' | 'is32BitExecutable'>;
}): DlssEligibilityResult {
  const { crossoverGraphicsBackend, activeLayer, preview } = params;
  if (
    crossoverGraphicsBackend !== 'auto' &&
    crossoverGraphicsBackend !== 'd3dmetal' &&
    crossoverGraphicsBackend !== 'dxmt'
  ) {
    return { supported: false, reason: 'Not available with DXVK or WineD3D' };
  }

  const normalizedExecArch =
    typeof preview?.executableArchitecture === 'string'
      ? preview.executableArchitecture.trim().toLowerCase()
      : '';
  if (
    preview?.is32BitExecutable === true ||
    (normalizedExecArch !== '' &&
      (normalizedExecArch === 'x86' ||
        normalizedExecArch === 'i386' ||
        normalizedExecArch === 'ia32' ||
        normalizedExecArch === 'pe32' ||
        normalizedExecArch === '32-bit' ||
        normalizedExecArch === 'win32'))
  ) {
    return {
      supported: false,
      reason:
        'Requires a 64-bit Windows executable (DLSS is not supported on 32-bit x86 games).',
    };
  }

  const d3dMetalUnsupported =
    activeLayer?.supportsMetalFxDlssD3dMetal === false ||
    (typeof activeLayer?.darwinKernelMajor === 'number' &&
      activeLayer.darwinKernelMajor < 25);
  const dxmtUnsupported =
    activeLayer?.supportsMetalFxDlssDxmt === false ||
    (typeof activeLayer?.darwinKernelMajor === 'number' &&
      activeLayer.darwinKernelMajor < 23);

  if (crossoverGraphicsBackend === 'd3dmetal' && d3dMetalUnsupported) {
    return {
      supported: false,
      reason:
        'D3DMetal MetalFX DLSS requires macOS Tahoe 26+ on Apple Silicon (use DXMT on macOS Sonoma 14 / Sequoia 15).',
    };
  }

  if (crossoverGraphicsBackend === 'dxmt' && dxmtUnsupported) {
    return {
      supported: false,
      reason: 'DXMT MetalFX DLSS requires macOS Sonoma 14+ on Apple Silicon.',
    };
  }

  if (crossoverGraphicsBackend === 'auto' && d3dMetalUnsupported && dxmtUnsupported) {
    return {
      supported: false,
      reason:
        'MetalFX DLSS requires macOS Sonoma 14+ (DXMT) or macOS Tahoe 26+ (D3DMetal) on Apple Silicon.',
    };
  }

  return { supported: true };
}

export interface MetalfxSpatialEligibilityResult {
  supported: boolean;
  autoModeNote?: boolean;
  badge?: string;
  reason?: string;
}

export function resolveMetalfxSpatialEligibility(params: {
  crossoverGraphicsBackend: CrossOverGraphicsBackend;
}): MetalfxSpatialEligibilityResult {
  const { crossoverGraphicsBackend } = params;
  if (crossoverGraphicsBackend === 'dxmt') {
    return { supported: true };
  }
  if (crossoverGraphicsBackend === 'auto') {
    return { supported: true, autoModeNote: true };
  }
  if (crossoverGraphicsBackend === 'd3dmetal') {
    return {
      supported: false,
      badge: 'DXMT Only',
      reason:
        "MetalFX spatial swapchain upscaling is a DXMT-only feature — Apple's D3DMetal only exposes MetalFX via in-game NVIDIA DLSS above. Switch Graphics Backend to DXMT to use driver-level spatial scaling on DirectX 10/11 games.",
    };
  }
  return {
    supported: false,
    badge: 'DXMT Only',
    reason:
      'Requires the DXMT graphics backend (DirectX 10/11 on Metal). Not available with DXVK or WineD3D.',
  };
}

const NOOP = () => {};
const EMULATE_MODESET_HINT_TEXT = String.raw`Legacy X11 Driver\EmulateModeset fallback without changing macOS display mode.`;

export interface CompatibilityLayerSectionProps {
  idPrefix?: string;
  isWindowsHost: boolean;
  preview: ResolvedLaunchModePreview;
  activeDisplayMethod: LaunchMethod;
  detectedLayers: CompatibilityLayerInfo[];
  runnerUpdates: Record<string, CompatibilityLayerUpdateInfo>;
  compatibilityLayer: CompatibilityLayerType;
  onSelectCompatibilityLayer: (layer: CompatibilityLayerType) => void;
  availableBottles: string[];
  wineBottleName: string;
  onChangeWineBottleName: (value: string) => void;
  selectedRunnerDescriptor: CompatibilityRunnerDescriptor;
  activeLayer?: CompatibilityLayerInfo;
  activeUpdateInfo?: CompatibilityLayerUpdateInfo;
  activeInstalledVer?: string;
  activeSecondaryBuildText?: string;
  resolvedBottleFolderPath?: string;
  onOpenBottleFolder?: () => void;
  onOpenRunnerSetup?: () => void;
  winePrefixPath: string;
  onChangeWinePrefixPath: (value: string) => void;
  onBrowseWinePrefix: () => void;
  crossoverGraphicsBackend: CrossOverGraphicsBackend;
  onChangeCrossoverGraphicsBackend: (backend: CrossOverGraphicsBackend) => void;
  crossoverD3DMetalVersion: CrossOverD3DMetalVersion;
  onChangeCrossoverD3DMetalVersion: (version: CrossOverD3DMetalVersion) => void;
  showD3DMetalVersionSelector: boolean;
  primaryD3DVer: string;
  fallbackD3DVer: string;
  crossoverHighResolutionMode?: boolean;
  onChangeCrossoverHighResolutionMode: (value: boolean | undefined) => void;
  onToggleLegacy96DpiMode?: () => void;
  isDlssSupportedBackend: boolean;
  dlssUnavailableReason?: string;
  crossoverDlss: boolean;
  onToggleCrossoverDlss: () => void;
  metalfxSpatialUpscaleFactor?: number;
  onChangeMetalfxSpatialUpscaleFactor?: (value: number | undefined) => void;
  preferredMaxFrameRate?: number;
  onChangePreferredMaxFrameRate?: (value: number | undefined) => void;
  displayScalingMode?: BottleDisplayScalingMode;
  onChangeDisplayScalingMode?: (value: BottleDisplayScalingMode) => void;
  displayAspectRatio?: DisplayAspectRatioMode;
  onChangeDisplayAspectRatio?: (value: DisplayAspectRatioMode) => void;
  virtualDesktopResolution?: VirtualDesktopResolutionPreset | string;
  onChangeVirtualDesktopResolution?: (value: VirtualDesktopResolutionPreset | string) => void;
  defaultBottleDisplayScalingMode?: GlobalBottleDisplayScalingMode;
  defaultDisplayAspectRatio?: GlobalDisplayAspectRatioMode;
  enableFullscreenHotkey?: boolean;
  emulateModeset?: boolean;
  onChangeEmulateModeset?: (value: boolean | undefined) => void;
  forceLargeAddressAware?: boolean;
  onToggleForceLargeAddressAware?: () => void;
  wineMsync: boolean;
  onToggleWineMsync: () => void;
  wineEsync: boolean;
  onToggleWineEsync: () => void;
  wineSyncMode?: WineSyncMode;
  onSelectWineSyncMode?: (mode: WineSyncMode) => void;
  displayOverrideCount?: number;
  /** @deprecated Compatibility & Engine Tweaks now renders directly in the main Compatibility & Graphics card */
  compatOverrideCount?: number;
  renderSectionPart?: 'all' | 'primary' | 'advanced';
  installedRecord?: Pick<InstalledGameRecord, 'installPath' | 'executablePath'>;
  platformId?: StorefrontId;
  isFastDirectActive?: boolean;
  onAlignToInstallBottle?: (runnerType: CompatibilityLayerType, bottleName: string) => void;
  /** @deprecated Legacy embedded runner management props retained optional for call-site compatibility */
  activeRunnerProgress?: CompatibilityRunnerProgressEvent;
  isCheckingUpdates?: boolean;
  isUpdatingRunner?: boolean;
  onUpdateRunner?: () => void;
  onCheckRunnerUpdates?: () => void;
  onCancelRunnerOperation?: () => void;
  onInstallRunnerFromArchive?: () => void;
  onSwitchToStableCrossOver?: () => void;
  isRescanningRunners?: boolean;
  onRescanLayers?: () => void;
  isInstallingRunner?: boolean;
  isAnotherRunnerOperationActive?: boolean;
  onInstallRunnerViaBrew?: () => void;
  onDownloadRunner?: () => void;
  runnerUpdateFeedback?: string | null;
  runnerActionFeedback?: { tone: 'emerald' | 'amber' | 'sky'; text: string } | null;
  /** @deprecated Legacy split HUD props replaced by unified Performance HUD control */
  isDxvkHudSupported?: boolean;
  metalHud?: boolean;
  onToggleMetalHud?: () => void;
  dxvkHud?: boolean;
  onToggleDxvkHud?: () => void;
}

function CompatibilityLayerSectionImpl(
  props: CompatibilityLayerSectionProps
): React.ReactElement | null {
  const {
    idPrefix = 'launch-cfg',
    isWindowsHost,
    preview,
    activeDisplayMethod,
    detectedLayers,
    runnerUpdates,
    compatibilityLayer,
    onSelectCompatibilityLayer,
    availableBottles,
    wineBottleName,
    onChangeWineBottleName,
    selectedRunnerDescriptor,
    activeLayer,
    activeUpdateInfo,
    activeInstalledVer,
    activeSecondaryBuildText = '',
    resolvedBottleFolderPath,
    onOpenBottleFolder,
    onOpenRunnerSetup,
    winePrefixPath,
    onChangeWinePrefixPath,
    onBrowseWinePrefix,
    crossoverGraphicsBackend,
    onChangeCrossoverGraphicsBackend,
    crossoverD3DMetalVersion,
    onChangeCrossoverD3DMetalVersion,
    showD3DMetalVersionSelector,
    primaryD3DVer,
    fallbackD3DVer,
    crossoverHighResolutionMode,
    onChangeCrossoverHighResolutionMode,
    onToggleLegacy96DpiMode,
    isDlssSupportedBackend,
    crossoverDlss,
    onToggleCrossoverDlss,
    wineMsync,
    onToggleWineMsync,
    wineEsync,
    onToggleWineEsync,
    renderSectionPart = 'all',
  } = props;

  if (isWindowsHost || !preview.visibleSections.compatibilityLayer) {
    return null;
  }

  const hostArch = launcherService.getHostArch();
  const visibleCompatLayerOptions = COMPAT_LAYER_OPTIONS.filter(
    (opt) => opt.value !== 'crossover_preview_arm64' || hostArch === 'arm64'
  );
  const effectiveCompatSelectValue = visibleCompatLayerOptions.some(
    (opt) => opt.value === compatibilityLayer
  )
    ? compatibilityLayer
    : visibleCompatLayerOptions[0]?.value || 'crossover';
  const wasLayerDowngradedForHost = effectiveCompatSelectValue !== compatibilityLayer;

  const effectiveActiveLayer = wasLayerDowngradedForHost
    ? detectedLayers.find((l) => l.type === effectiveCompatSelectValue)
    : activeLayer;
  const effectiveAvailableBottles = wasLayerDowngradedForHost
    ? effectiveActiveLayer?.availableBottles || []
    : availableBottles;
  const effectiveRunnerDescriptor = wasLayerDowngradedForHost
    ? COMPATIBILITY_RUNNER_DESCRIPTORS.find((d) => d.type === effectiveCompatSelectValue) ||
      selectedRunnerDescriptor
    : selectedRunnerDescriptor;
  const effectiveUpdateInfo = wasLayerDowngradedForHost
    ? runnerUpdates[effectiveCompatSelectValue]
    : activeUpdateInfo;
  const effectiveInstalledVer = wasLayerDowngradedForHost
    ? effectiveActiveLayer?.version || effectiveUpdateInfo?.installedVersion
    : activeInstalledVer;
  const effectiveSecondaryBuildText = wasLayerDowngradedForHost
    ? formatRunnerSecondaryBuildText({
        installedVersion: effectiveInstalledVer,
        displayVersion:
          effectiveActiveLayer?.displayVersion || effectiveUpdateInfo?.installedDisplayVersion,
        buildVersion:
          effectiveActiveLayer?.buildVersion || effectiveUpdateInfo?.installedBuildVersion,
      })
    : activeSecondaryBuildText;

  const effectiveDlssEligibility = wasLayerDowngradedForHost
    ? resolveDlssEligibility({
        crossoverGraphicsBackend,
        activeLayer: effectiveActiveLayer,
        preview,
      })
    : null;
  const effectiveIsDlssSupportedBackend = wasLayerDowngradedForHost
    ? effectiveDlssEligibility!.supported
    : isDlssSupportedBackend;
  const effectiveDlssUnavailableReason = wasLayerDowngradedForHost
    ? effectiveDlssEligibility!.reason || 'Not available with DXVK or WineD3D'
    : props.dlssUnavailableReason ||
      resolveDlssEligibility({ crossoverGraphicsBackend, activeLayer: effectiveActiveLayer, preview })
        .reason ||
      'Not available with DXVK or WineD3D';
  const effectiveShowD3DMetalVersionSelector = wasLayerDowngradedForHost
    ? Boolean(
        effectiveActiveLayer?.availableD3DMetalVersions
          ? effectiveActiveLayer.availableD3DMetalVersions.length > 1
          : effectiveCompatSelectValue === 'crossover_preview' ||
            effectiveCompatSelectValue === 'crossover_preview_arm64'
      ) &&
      (crossoverGraphicsBackend === 'auto' || crossoverGraphicsBackend === 'd3dmetal')
    : showD3DMetalVersionSelector;
  const effectivePrimaryD3DVer = wasLayerDowngradedForHost
    ? effectiveActiveLayer?.availableD3DMetalVersions?.find((v) => v.isDefault || v.id === '4')
        ?.version ||
      effectiveActiveLayer?.d3dmetalVersion ||
      '4.0b3'
    : primaryD3DVer;
  const effectiveFallbackD3DVer = wasLayerDowngradedForHost
    ? effectiveActiveLayer?.availableD3DMetalVersions?.find((v) => v.id === '3')?.version || '3.0'
    : fallbackD3DVer;

  const effectiveMetalfxSpatialUpscaleFactor = props.metalfxSpatialUpscaleFactor;
  const handleMetalfxSpatialUpscaleChange = props.onChangeMetalfxSpatialUpscaleFactor ?? NOOP;

  const effectivePreferredMaxFrameRate = props.preferredMaxFrameRate;
  const handlePreferredMaxFrameRateChange = props.onChangePreferredMaxFrameRate ?? NOOP;

  const effectiveDisplayScalingMode: BottleDisplayScalingMode =
    props.displayScalingMode ?? 'default';
  const handleDisplayScalingModeChange = props.onChangeDisplayScalingMode ?? NOOP;

  const effectiveDisplayAspectRatio: DisplayAspectRatioMode =
    props.displayAspectRatio ?? 'default';
  const handleDisplayAspectRatioChange = props.onChangeDisplayAspectRatio ?? NOOP;

  const effectiveVirtualDesktopResolution =
    (props.virtualDesktopResolution ?? 'auto').trim().toLowerCase() || 'auto';
  const handleVirtualDesktopResolutionChange = props.onChangeVirtualDesktopResolution ?? NOOP;

  const globalScalingMode: GlobalBottleDisplayScalingMode =
    props.defaultBottleDisplayScalingMode ?? 'auto_fullscreen';
  const globalAspectRatio: GlobalDisplayAspectRatioMode =
    props.defaultDisplayAspectRatio ?? 'preserve_aspect';

  const resolvedScalingMode: GlobalBottleDisplayScalingMode =
    effectiveDisplayScalingMode === 'default' ? globalScalingMode : effectiveDisplayScalingMode;
  const showVirtualDesktopResolutionSelect = resolvedScalingMode === 'virtual_desktop';
  const globalModeLabel = formatGlobalBottleDisplayModeLabel(globalScalingMode);
  const globalAspectLabel = formatGlobalDisplayAspectLabel(globalAspectRatio);
  const hasCustomVdResValue = !VIRTUAL_DESKTOP_RESOLUTION_OPTIONS.some(
    (opt) => opt.value === effectiveVirtualDesktopResolution
  );

  const isLegacy96DpiActive = crossoverHighResolutionMode === false;
  const handleToggleLegacy96Dpi = () => {
    if (onToggleLegacy96DpiMode) {
      onToggleLegacy96DpiMode();
      return;
    }
    onChangeCrossoverHighResolutionMode(isLegacy96DpiActive ? undefined : false);
  };

  const effectiveEmulateModeset = props.emulateModeset;
  const handleEmulateModesetChange = props.onChangeEmulateModeset ?? NOOP;

  const effectiveForceLargeAddressAware = Boolean(props.forceLargeAddressAware);
  const handleToggleForceLaa = props.onToggleForceLargeAddressAware ?? NOOP;

  const effectiveWineSyncMode: WineSyncMode =
    props.wineSyncMode ?? resolveWineSyncMode(wineMsync, wineEsync);

  const handleSelectSyncMode = (nextMode: WineSyncMode) => {
    if (nextMode === effectiveWineSyncMode) return;
    if (props.onSelectWineSyncMode) {
      props.onSelectWineSyncMode(nextMode);
      return;
    }
    if (nextMode === 'msync') {
      if (!wineMsync) onToggleWineMsync();
    } else if (nextMode === 'esync') {
      if (!wineEsync) onToggleWineEsync();
    } else {
      if (wineMsync) onToggleWineMsync();
      else if (wineEsync) onToggleWineEsync();
    }
  };

  const handleOpenRunnerManager = () => {
    if (onOpenRunnerSetup) {
      onOpenRunnerSetup();
      return;
    }
    environmentSetupService.openWizard({
      mode: 'health_check',
      initialStep: 'compatibility',
    });
  };

  const activeBackendPolicy = getCrossOverGraphicsBackendPolicy(crossoverGraphicsBackend);
  const spatialEligibility = resolveMetalfxSpatialEligibility({ crossoverGraphicsBackend });
  const unavailableSpatialBackendLabel =
    crossoverGraphicsBackend === 'd3dmetal'
      ? 'Unavailable on D3DMetal'
      : crossoverGraphicsBackend === 'dxvk'
        ? 'Unavailable on DXVK'
        : 'Unavailable on WineD3D';

  const normalizedExecArch = (preview.executableArchitecture || '').trim().toLowerCase();
  const isConfirmed64BitBinary =
    preview.is32BitExecutable !== true &&
    (normalizedExecArch === 'x64' ||
      normalizedExecArch === 'amd64' ||
      normalizedExecArch === 'x86_64' ||
      normalizedExecArch === 'pe32+' ||
      normalizedExecArch === 'win64' ||
      normalizedExecArch === '64-bit' ||
      normalizedExecArch === '64bit' ||
      normalizedExecArch === 'arm64' ||
      normalizedExecArch === 'aarch64' ||
      normalizedExecArch === 'arm64ec' ||
      (normalizedExecArch === '' &&
        preview.is32BitExecutable === false &&
        (preview.detectedBuildType === 'windows_exe_on_mac' ||
          preview.detectedBuildType === 'windows_native')));
  const isLaaNotNeededAndOff = isConfirmed64BitBinary && !effectiveForceLargeAddressAware;

  const isPreviewBranch =
    effectiveCompatSelectValue === 'crossover_preview' ||
    effectiveCompatSelectValue === 'crossover_preview_arm64';
  const isCrossOverFamily = effectiveCompatSelectValue === 'crossover' || isPreviewBranch;
  const showBottleControl = isCrossOverFamily || effectiveAvailableBottles.length > 0;
  const winePrefixPlaceholder = effectiveActiveLayer?.bottlesDir
    ? `${formatUserFacingPath(effectiveActiveLayer.bottlesDir).replace(/\/+$/, '')}/...`
    : isPreviewBranch
      ? '~/Library/Application Support/CrossOver Preview/Bottles/...'
      : isCrossOverFamily
        ? '~/Library/Application Support/CrossOver/Bottles/...'
        : '~/Games/OneLauncher/Prefixes/default';
  const bottlePlaceholder =
    effectiveCompatSelectValue === 'crossover_preview_arm64'
      ? 'e.g. OneLauncher-arm64, Default'
      : 'e.g. OneLauncher, Steam, Default';

  const sanitizedSecondaryBuild = formatRunnerSecondaryBuildText({
    installedVersion: effectiveInstalledVer,
    displayVersion: effectiveSecondaryBuildText,
  });

  const layersForBottleLookup = [effectiveActiveLayer, activeLayer, ...detectedLayers];
  const trimmedWineBottleName = wineBottleName.trim();
  const anyLayerBottleArch = resolveBottleArchitectureFromLayers(
    trimmedWineBottleName,
    layersForBottleLookup
  );
  const isBottleOrphanForDowngradedHost = Boolean(
    wasLayerDowngradedForHost &&
      trimmedWineBottleName &&
      ((effectiveAvailableBottles.length > 0 &&
        !effectiveAvailableBottles.includes(trimmedWineBottleName)) ||
        anyLayerBottleArch === 'arm64' ||
        isArm64NamedBottle(trimmedWineBottleName))
  );
  const effectiveBottleControlValue = isBottleOrphanForDowngradedHost ? '' : wineBottleName;

  const effectivePlatformId: StorefrontId = props.platformId ?? preview.platformId;
  const effectiveIsFastDirectActive =
    props.isFastDirectActive ?? Boolean(preview.resolvedPolicy?.isFastDirectBypass);
  const installBottleName = extractBottleNameFromPath(
    props.installedRecord?.installPath ||
      props.installedRecord?.executablePath ||
      preview.installPath ||
      preview.executablePath
  );

  const baseDefaultResolvedBottle = resolveDefaultBottleForLayer(
    effectiveActiveLayer || {
      type: effectiveCompatSelectValue,
      availableBottles: effectiveAvailableBottles,
    },
    effectiveCompatSelectValue,
    effectiveRunnerDescriptor.defaultBottleName
  );
  const matchedInstallBottle =
    installBottleName &&
    effectiveAvailableBottles.find(
      (b) => b.toLowerCase() === installBottleName.toLowerCase()
    );
  const defaultResolvedBottle =
    matchedInstallBottle &&
    isBottleNameCompatibleWithRunner(matchedInstallBottle, effectiveCompatSelectValue, {
      layer: effectiveActiveLayer,
      allLayers: layersForBottleLookup,
    })
      ? matchedInstallBottle
      : baseDefaultResolvedBottle;
  const effectiveSelectedBottleName =
    effectiveBottleControlValue.trim() || defaultResolvedBottle || '';
  const hasBottleArchMismatch = hasBottleArchitectureMismatch(
    effectiveSelectedBottleName,
    effectiveCompatSelectValue,
    { allLayers: layersForBottleLookup }
  );

  const lookupBottleDetails = (
    bottleName: string
  ): NonNullable<CompatibilityLayerInfo['bottleDetails']>[string] | undefined => {
    const trimmed = bottleName.trim();
    if (!trimmed) return undefined;
    const lower = trimmed.toLowerCase();
    const readFromLayer = (layer?: CompatibilityLayerInfo) => {
      const details = layer?.bottleDetails;
      if (!details) return undefined;
      if (details[trimmed]) return details[trimmed];
      for (const [key, value] of Object.entries(details)) {
        if (key.trim().toLowerCase() === lower) {
          return value;
        }
      }
      return undefined;
    };
    const fromEffective = readFromLayer(effectiveActiveLayer);
    if (fromEffective) return fromEffective;
    for (const layer of layersForBottleLookup) {
      if (!layer || layer === effectiveActiveLayer) continue;
      const found = readFromLayer(layer);
      if (found) return found;
    }
    return undefined;
  };
  const targetBottleDetails = lookupBottleDetails(effectiveSelectedBottleName);

  const hasInstallBottleMismatch = Boolean(
    installBottleName &&
      effectiveSelectedBottleName &&
      installBottleName.toLowerCase() !== effectiveSelectedBottleName.toLowerCase()
  );
  const recommendedInstallRunner =
    hasInstallBottleMismatch && installBottleName
      ? findCompatibleRunnerForBottle(installBottleName, detectedLayers, {
          hostPlatform: preview.hostPlatform || 'darwin',
          hostArch,
        })
      : null;
  const recommendedInstallRunnerLabel = recommendedInstallRunner
    ? COMPATIBILITY_RUNNER_DESCRIPTORS.find((d) => d.type === recommendedInstallRunner.type)
        ?.shortLabel || recommendedInstallRunner.name
    : undefined;
  const handleAlignToInstallBottle = (
    runnerType: CompatibilityLayerType,
    bottleName: string
  ) => {
    if (props.onAlignToInstallBottle) {
      props.onAlignToInstallBottle(runnerType, bottleName);
      return;
    }
    onSelectCompatibilityLayer(runnerType);
    onChangeWineBottleName(bottleName);
  };

  const isAdvancedDisplayModeActive =
    effectiveDisplayScalingMode === 'force_fullscreen' ||
    effectiveDisplayScalingMode === 'virtual_desktop' ||
    effectiveDisplayScalingMode === 'native_driver';

  const computedDisplayOverrideCount =
    props.displayOverrideCount ??
    (effectiveDisplayAspectRatio !== 'default' ? 1 : 0) +
      (isAdvancedDisplayModeActive ? 1 : 0) +
      (isLegacy96DpiActive ? 1 : 0) +
      (effectiveEmulateModeset !== undefined ? 1 : 0);

  const showPrimary = renderSectionPart !== 'advanced';
  const showAdvanced = renderSectionPart !== 'primary';

  return (
    <div
      data-section="compatibility-layer-settings"
      className={showPrimary && showAdvanced ? 'space-y-4' : 'space-y-3'}
    >
      {showPrimary && (
        <div
          data-testid="compatibility-graphics-card"
          className="rounded-lg bg-[#0e151f] border border-[#223447] p-3.5 space-y-3.5"
        >
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <Cpu className="w-4 h-4 text-amber-400 shrink-0" aria-hidden="true" />
              <h3 className="text-xs font-bold text-white uppercase tracking-wider">
                Compatibility &amp; Graphics
              </h3>
            </div>
            <span
              className={`text-[10px] px-2 py-0.5 rounded border font-semibold ${
                activeDisplayMethod === 'compatibility_layer'
                  ? 'bg-sky-500/15 border-sky-500/30 text-sky-300'
                  : 'bg-emerald-500/15 border-emerald-500/30 text-emerald-300'
              }`}
            >
              {activeDisplayMethod === 'compatibility_layer'
                ? 'Custom Runner Pinned'
                : 'Auto-Detect Runner'}
            </span>
          </div>

          {renderCompatRunnerAndBottleControls({
            visibleCompatLayerOptions,
            effectiveCompatSelectValue,
            detectedLayers,
            runnerUpdates,
            onSelectCompatibilityLayer,
            showBottleControl,
            isCrossOverFamily,
            effectiveAvailableBottles,
            effectiveBottleControlValue,
            defaultResolvedBottle,
            effectiveActiveLayer,
            bottlePlaceholder,
            onChangeWineBottleName,
            hasBottleArchMismatch,
            effectiveSelectedBottleName,
            effectiveRunnerDescriptor,
            effectiveUpdateInfo,
            effectiveInstalledVer,
            sanitizedSecondaryBuild,
            resolvedBottleFolderPath,
            onOpenBottleFolder,
            onOpenRunnerManager: handleOpenRunnerManager,
            platformId: effectivePlatformId,
            isFastDirectActive: effectiveIsFastDirectActive,
            installBottleName,
            targetBottleDetails,
            recommendedInstallRunner,
            recommendedInstallRunnerLabel,
            onAlignToInstallBottle: handleAlignToInstallBottle,
          })}

          {renderCompatGraphicsControls({
            idPrefix,
            preview,
            effectiveActiveLayer,
            crossoverGraphicsBackend,
            onChangeCrossoverGraphicsBackend,
            activeBackendPolicy,
            crossoverD3DMetalVersion,
            onChangeCrossoverD3DMetalVersion,
            effectiveShowD3DMetalVersionSelector,
            effectivePrimaryD3DVer,
            effectiveFallbackD3DVer,
            effectiveDisplayScalingMode,
            onChangeDisplayScalingMode: handleDisplayScalingModeChange,
            resolvedScalingMode,
            globalModeLabel,
            effectivePreferredMaxFrameRate,
            onChangePreferredMaxFrameRate: handlePreferredMaxFrameRateChange,
            effectiveIsDlssSupportedBackend,
            effectiveDlssUnavailableReason,
            crossoverDlss,
            onToggleCrossoverDlss,
            spatialEligibility,
            unavailableSpatialBackendLabel,
            effectiveMetalfxSpatialUpscaleFactor,
            onChangeMetalfxSpatialUpscaleFactor: handleMetalfxSpatialUpscaleChange,
            effectiveWineSyncMode,
            onSelectSyncMode: handleSelectSyncMode,
            isConfirmed64BitBinary,
            isLaaNotNeededAndOff,
            effectiveForceLargeAddressAware,
            onToggleForceLaa: handleToggleForceLaa,
            isCrossOverFamily,
            winePrefixPath,
            winePrefixPlaceholder,
            onChangeWinePrefixPath,
            onBrowseWinePrefix,
          })}
        </div>
      )}

      {showAdvanced &&
        renderCompatAdvancedDisplayDisclosure({
          idPrefix,
          computedDisplayOverrideCount,
          effectiveDisplayAspectRatio,
          globalAspectLabel,
          onChangeDisplayAspectRatio: handleDisplayAspectRatioChange,
          isAdvancedDisplayModeActive,
          effectiveDisplayScalingMode,
          onChangeDisplayScalingMode: handleDisplayScalingModeChange,
          showVirtualDesktopResolutionSelect,
          effectiveVirtualDesktopResolution,
          hasCustomVdResValue,
          onChangeVirtualDesktopResolution: handleVirtualDesktopResolutionChange,
          isLegacy96DpiActive,
          onToggleLegacy96Dpi: handleToggleLegacy96Dpi,
          effectiveEmulateModeset,
          onChangeEmulateModeset: handleEmulateModesetChange,
          emulateModesetHintText: EMULATE_MODESET_HINT_TEXT,
        })}
    </div>
  );
}

export const CompatibilityLayerSectionBase = CompatibilityLayerSectionImpl;
export const CompatibilityLayerSection = React.memo(CompatibilityLayerSectionImpl);
CompatibilityLayerSection.displayName = 'CompatibilityLayerSection';
