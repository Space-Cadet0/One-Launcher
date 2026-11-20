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
  LaunchMethod,
  resolveDefaultBottleForLayer,
  ResolvedLaunchModePreview,
  VirtualDesktopResolutionPreset,
} from '../../../contracts/launcher';
import {
  Activity,
  AlertTriangle,
  CheckCircle2,
  Cpu,
  FolderOpen,
  Gauge,
  Maximize2,
  Monitor,
  Sparkles,
  Wrench,
} from 'lucide-react';
import { environmentSetupService } from '../../../services/launcher/environmentSetupService';
import {
  COMPATIBILITY_RUNNER_DESCRIPTORS,
  launcherService,
} from '../../../services/launcher/launcherService';
import {
  COMPAT_LAYER_OPTIONS,
  CROSSOVER_BACKEND_OPTIONS,
  VIRTUAL_DESKTOP_RESOLUTION_OPTIONS,
  formatGlobalBottleDisplayModeLabel,
  formatGlobalDisplayAspectLabel,
  formatRunnerOptionLabel,
  formatRunnerSecondaryBuildText,
  formatUserFacingPath,
  getCrossOverGraphicsBackendPolicy,
  resolveWineSyncMode,
  type WineSyncMode,
} from './launchConfigHelpers';
import {
  LAUNCH_BUTTON_FOCUS_CLASSES,
  LAUNCH_TEXT_INPUT_CLASSES,
  LaunchDisclosure,
  LaunchSelect,
  SegmentedRadioGroup,
  SwitchControl,
} from './LaunchConfigControls';

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

const STANDARD_FPS_PRESETS = [30, 40, 60, 90, 120, 144] as const;
const NOOP = () => {};

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
  compatOverrideCount?: number;
  renderSectionPart?: 'all' | 'primary' | 'advanced';
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
    if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
      window.dispatchEvent(
        new CustomEvent('antigravity:open-setup-wizard', {
          detail: { initialStep: 'compatibility' },
        })
      );
    }
    environmentSetupService.openWizard({
      mode: 'health_check',
      initialStep: 'compatibility',
    });
  };

  const activeBackendPolicy = getCrossOverGraphicsBackendPolicy(crossoverGraphicsBackend);
  const showMetalfxSpatialControl =
    preview.visibleSections.crossoverRendering &&
    (crossoverGraphicsBackend === 'auto' || crossoverGraphicsBackend === 'dxmt');
  const hasCustomFpsValue =
    typeof effectivePreferredMaxFrameRate === 'number' &&
    Number.isFinite(effectivePreferredMaxFrameRate) &&
    effectivePreferredMaxFrameRate > 0 &&
    !STANDARD_FPS_PRESETS.includes(
      effectivePreferredMaxFrameRate as (typeof STANDARD_FPS_PRESETS)[number]
    );

  const normalizedExecArch = (preview.executableArchitecture || '').trim().toLowerCase();
  const isConfirmed64BitBinary =
    preview.is32BitExecutable !== true &&
    (normalizedExecArch === 'x64' ||
      normalizedExecArch === 'amd64' ||
      normalizedExecArch === 'x86_64' ||
      normalizedExecArch === 'pe32+' ||
      normalizedExecArch === 'arm64');
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

  const trimmedWineBottleName = wineBottleName.trim();
  const anyLayerBottleArch =
    effectiveActiveLayer?.bottleDetails?.[trimmedWineBottleName]?.wineArch ||
    activeLayer?.bottleDetails?.[trimmedWineBottleName]?.wineArch ||
    detectedLayers.find((l) => l.bottleDetails?.[trimmedWineBottleName]?.wineArch)?.bottleDetails?.[
      trimmedWineBottleName
    ]?.wineArch;
  const isBottleOrphanForDowngradedHost = Boolean(
    wasLayerDowngradedForHost &&
      trimmedWineBottleName &&
      ((effectiveAvailableBottles.length > 0 &&
        !effectiveAvailableBottles.includes(trimmedWineBottleName)) ||
        anyLayerBottleArch === 'arm64' ||
        /-arm64$/i.test(trimmedWineBottleName))
  );
  const effectiveBottleControlValue = isBottleOrphanForDowngradedHost ? '' : wineBottleName;

  const defaultResolvedBottle = resolveDefaultBottleForLayer(
    effectiveActiveLayer || {
      type: effectiveCompatSelectValue,
      availableBottles: effectiveAvailableBottles,
    },
    effectiveCompatSelectValue,
    effectiveRunnerDescriptor.defaultBottleName
  );
  const effectiveSelectedBottleName =
    effectiveBottleControlValue.trim() || defaultResolvedBottle || '';
  const selectedBottleArch = effectiveSelectedBottleName
    ? effectiveActiveLayer?.bottleDetails?.[effectiveSelectedBottleName]?.wineArch ||
      activeLayer?.bottleDetails?.[effectiveSelectedBottleName]?.wineArch ||
      detectedLayers.find((l) => l.bottleDetails?.[effectiveSelectedBottleName]?.wineArch)
        ?.bottleDetails?.[effectiveSelectedBottleName]?.wineArch
    : undefined;
  const hasBottleArchMismatch = Boolean(
    effectiveSelectedBottleName &&
      ((effectiveCompatSelectValue === 'crossover_preview_arm64' &&
        (selectedBottleArch === 'win64' ||
          (!selectedBottleArch && /^OneLauncher$/i.test(effectiveSelectedBottleName)))) ||
        ((effectiveCompatSelectValue === 'crossover' ||
          effectiveCompatSelectValue === 'crossover_preview') &&
          (selectedBottleArch === 'arm64' || /-arm64$/i.test(effectiveSelectedBottleName))))
  );

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

  const computedCompatOverrideCount =
    props.compatOverrideCount ??
    (effectiveShowD3DMetalVersionSelector && crossoverD3DMetalVersion !== 'auto' ? 1 : 0) +
      (effectiveMetalfxSpatialUpscaleFactor !== undefined ? 1 : 0) +
      (effectiveWineSyncMode !== 'msync' ? 1 : 0) +
      (effectiveForceLargeAddressAware ? 1 : 0) +
      (winePrefixPath.trim() ? 1 : 0);

  const winePrefixInputId = `${idPrefix}-wine-prefix-path`;
  const winePrefixHintId = `${idPrefix}-wine-prefix-hint`;
  const graphicsBackendSelectId = `${idPrefix}-graphics-backend`;
  const graphicsBackendHintId = `${idPrefix}-graphics-backend-hint`;
  const legacy96DpiLabelId = `${idPrefix}-legacy-96dpi-label`;
  const legacy96DpiHintId = `${idPrefix}-legacy-96dpi-hint`;
  const dlssLabelId = `${idPrefix}-dlss-label`;
  const dlssHintId = `${idPrefix}-dlss-hint`;
  const metalfxSpatialSelectId = `${idPrefix}-metalfx-spatial-upscale`;
  const metalfxSpatialHintId = `${idPrefix}-metalfx-spatial-upscale-hint`;
  const preferredMaxFpsSelectId = `${idPrefix}-preferred-max-fps`;
  const preferredMaxFpsHintId = `${idPrefix}-preferred-max-fps-hint`;
  const displayScalingSelectId = `${idPrefix}-display-scaling-mode`;
  const displayScalingHintId = `${idPrefix}-display-scaling-mode-hint`;
  const advancedDisplaySelectId = `${idPrefix}-advanced-display-scaling-mode`;
  const advancedDisplayHintId = `${idPrefix}-advanced-display-scaling-mode-hint`;
  const displayAspectSelectId = `${idPrefix}-display-aspect-ratio`;
  const displayAspectHintId = `${idPrefix}-display-aspect-ratio-hint`;
  const virtualDesktopResSelectId = `${idPrefix}-virtual-desktop-res`;
  const virtualDesktopResHintId = `${idPrefix}-virtual-desktop-res-hint`;
  const emulateModesetSelectId = `${idPrefix}-emulate-modeset`;
  const emulateModesetHintId = `${idPrefix}-emulate-modeset-hint`;
  const forceLaaLabelId = `${idPrefix}-force-laa-label`;
  const forceLaaHintId = `${idPrefix}-force-laa-hint`;

  const showPrimary = renderSectionPart !== 'advanced';
  const showAdvanced = renderSectionPart !== 'primary';

  return (
    <div
      data-section="compatibility-layer-settings"
      className={showPrimary && showAdvanced ? 'space-y-4' : 'space-y-3'}
    >
      {showPrimary && (
        <div className="rounded-lg bg-[#0e151f] border border-[#223447] p-3.5 space-y-3.5">
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

          {/* Primary 1 & 2: Compatibility Layer & Bottle */}
          <div className={`grid grid-cols-1 ${showBottleControl ? 'sm:grid-cols-2' : ''} gap-3`}>
            <div className="space-y-1.5">
              <label
                htmlFor="compat-runner-select"
                className="block text-[10px] font-bold uppercase tracking-wider text-steam-subtext"
              >
                Compatibility Layer
              </label>
              <LaunchSelect
                id="compat-runner-select"
                data-testid="compat-runner-select"
                aria-label="Compatibility Layer"
                value={effectiveCompatSelectValue}
                onChange={(e) =>
                  onSelectCompatibilityLayer(e.target.value as CompatibilityLayerType)
                }
              >
                {visibleCompatLayerOptions.map((opt) => {
                  const layerInfo = detectedLayers.find((l) => l.type === opt.value);
                  const upd = runnerUpdates[opt.value];
                  return (
                    <option key={opt.value} value={opt.value}>
                      {formatRunnerOptionLabel(opt, layerInfo, upd)}
                    </option>
                  );
                })}
              </LaunchSelect>
            </div>

            {showBottleControl && (
              <div className="space-y-1.5">
                <label
                  htmlFor="compat-target-bottle-control"
                  className="block text-[10px] font-bold uppercase tracking-wider text-steam-subtext"
                >
                  {isCrossOverFamily ? 'Target CrossOver Bottle' : 'Target Bottle Name'}
                </label>
                {effectiveAvailableBottles.length > 0 ? (
                  <LaunchSelect
                    id="compat-target-bottle-control"
                    aria-label="Target Bottle Name"
                    value={effectiveBottleControlValue}
                    onChange={(e) => onChangeWineBottleName(e.target.value)}
                  >
                    <option value="">
                      Default Bottle ({defaultResolvedBottle || effectiveAvailableBottles[0]})
                    </option>
                    {effectiveAvailableBottles.map((b) => {
                      const bottleArch = effectiveActiveLayer?.bottleDetails?.[b]?.wineArch;
                      const archSuffix =
                        bottleArch === 'arm64'
                          ? ' (arm64 / FEX)'
                          : bottleArch === 'win64'
                            ? ' (Intel / win64)'
                            : '';
                      return (
                        <option key={b} value={b}>
                          {b}
                          {archSuffix}
                        </option>
                      );
                    })}
                  </LaunchSelect>
                ) : (
                  <input
                    id="compat-target-bottle-control"
                    type="text"
                    aria-label="Target Bottle Name"
                    value={effectiveBottleControlValue}
                    onChange={(e) => onChangeWineBottleName(e.target.value)}
                    placeholder={bottlePlaceholder}
                    autoComplete="off"
                    spellCheck={false}
                    autoCorrect="off"
                    autoCapitalize="off"
                    className={`${LAUNCH_TEXT_INPUT_CLASSES} font-mono`}
                  />
                )}
                {hasBottleArchMismatch && (
                  <div
                    data-testid="compat-bottle-arch-mismatch-warning"
                    role="alert"
                    className="flex items-start gap-1.5 rounded bg-amber-950/45 border border-amber-500/45 px-2 py-1 text-[10px] text-amber-200"
                  >
                    <AlertTriangle
                      className="w-3 h-3 text-amber-400 shrink-0 mt-0.5"
                      aria-hidden="true"
                    />
                    <span>
                      Bottle &ldquo;{effectiveSelectedBottleName}&rdquo; does not match{' '}
                      {effectiveCompatSelectValue === 'crossover_preview_arm64'
                        ? 'arm64 / FEX (use "OneLauncher-arm64").'
                        : 'Intel / win64 (use "OneLauncher").'}
                    </span>
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Compact 1-line Runner Status Strip (replaces 440-line embedded runner installer) */}
          {effectiveActiveLayer ? (
            <div
              data-testid="runner-status-banner"
              className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-[#141d2b] border border-[#26384d] px-3 py-2 text-xs"
            >
              <div className="flex flex-wrap items-center gap-2 min-w-0">
                <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400 shrink-0" aria-hidden="true" />
                <span className="font-semibold text-white">
                  {effectiveRunnerDescriptor.shortLabel}
                </span>
                <span
                  data-testid="runner-installed-version"
                  className="font-mono text-[11px] text-emerald-300"
                >
                  v{effectiveInstalledVer || 'Detected'}
                  {sanitizedSecondaryBuild ? ` · ${sanitizedSecondaryBuild}` : ''}
                </span>
                {effectiveActiveLayer.d3dmetalVersion && (
                  <span
                    data-testid="runner-d3dmetal-version"
                    className="text-[10px] font-semibold px-2 py-0.5 rounded-full bg-sky-500/15 border border-sky-500/30 text-sky-300"
                  >
                    {(effectiveActiveLayer.availableD3DMetalVersions?.length || 0) > 1
                      ? `D3DMetal ${effectiveActiveLayer.availableD3DMetalVersions![0].version} / ${effectiveActiveLayer.availableD3DMetalVersions![1].version}`
                      : `D3DMetal ${effectiveActiveLayer.d3dmetalVersion}`}
                  </span>
                )}
                {effectiveUpdateInfo?.updateAvailable && effectiveUpdateInfo.latestVersion && (
                  <span
                    data-testid="runner-update-available-badge"
                    className="text-[10px] font-semibold px-2 py-0.5 rounded bg-amber-500/15 border border-amber-500/35 text-amber-300"
                  >
                    Update v{effectiveUpdateInfo.latestVersion}
                  </span>
                )}
              </div>

              <div className="flex flex-wrap items-center gap-1.5 shrink-0">
                {resolvedBottleFolderPath && onOpenBottleFolder && (
                  <button
                    type="button"
                    data-testid="open-bottle-folder-btn"
                    onClick={onOpenBottleFolder}
                    className={`min-h-[24px] inline-flex items-center gap-1 px-2 py-1 rounded bg-[#1b2838] hover:bg-[#25374d] border border-[#2a475e] text-[11px] font-semibold text-steam-subtext hover:text-white transition-colors cursor-pointer ${LAUNCH_BUTTON_FOCUS_CLASSES}`}
                  >
                    <FolderOpen className="w-3 h-3" aria-hidden="true" />
                    <span>{isCrossOverFamily ? 'Bottle Folder' : 'Prefix Folder'}</span>
                  </button>
                )}
                <button
                  type="button"
                  data-testid="manage-runners-bottles-btn"
                  onClick={handleOpenRunnerManager}
                  className={`min-h-[24px] inline-flex items-center gap-1 px-2.5 py-1 rounded bg-sky-500/15 hover:bg-sky-500/25 border border-sky-400/40 text-[11px] font-semibold text-sky-200 hover:text-white transition-colors cursor-pointer ${LAUNCH_BUTTON_FOCUS_CLASSES}`}
                >
                  <Wrench className="w-3 h-3" aria-hidden="true" />
                  <span>Manage Runners &amp; Bottles…</span>
                </button>
              </div>
            </div>
          ) : (
            <div
              data-testid="runner-not-installed-callout"
              className="flex flex-wrap items-center justify-between gap-2.5 rounded-lg bg-amber-950/40 border border-amber-500/40 px-3 py-2 text-xs text-amber-200"
            >
              <div className="flex items-center gap-2 min-w-0">
                <AlertTriangle
                  className="w-3.5 h-3.5 text-amber-400 shrink-0"
                  aria-hidden="true"
                />
                <span className="truncate">
                  <strong className="text-amber-300">{effectiveRunnerDescriptor.shortLabel}</strong>{' '}
                  is not installed on this Mac.
                </span>
              </div>
              <button
                type="button"
                data-testid="manage-runners-bottles-btn"
                onClick={handleOpenRunnerManager}
                className={`min-h-[24px] inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-sky-500/20 hover:bg-sky-500/30 border border-sky-400/50 text-[11px] font-bold text-sky-200 hover:text-white transition-colors cursor-pointer shrink-0 ${LAUNCH_BUTTON_FOCUS_CLASSES}`}
              >
                <Wrench className="w-3 h-3" aria-hidden="true" />
                <span>Manage Runners &amp; Bottles…</span>
              </button>
            </div>
          )}

          {/* Primary 3: Graphics Backend (CrossOver only) */}
          {preview.visibleSections.crossoverRendering && (
            <div className="space-y-1.5">
              <div className="flex flex-wrap items-center justify-between gap-1">
                <label
                  htmlFor={graphicsBackendSelectId}
                  className="text-[10px] font-bold uppercase tracking-wider text-steam-subtext"
                >
                  Graphics Backend
                </label>
                <span
                  data-testid="graphics-backend-arch-badge"
                  className="text-[10px] font-semibold text-sky-300"
                >
                  {activeBackendPolicy.architectureBadge}
                </span>
              </div>
              <LaunchSelect
                id={graphicsBackendSelectId}
                aria-label="Graphics Backend"
                aria-describedby={graphicsBackendHintId}
                value={crossoverGraphicsBackend}
                onChange={(e) =>
                  onChangeCrossoverGraphicsBackend(e.target.value as CrossOverGraphicsBackend)
                }
              >
                {CROSSOVER_BACKEND_OPTIONS.map((opt) => {
                  const dynamicLabel =
                    opt.value === 'd3dmetal' && effectiveActiveLayer?.d3dmetalVersion
                      ? `D3DMetal (v${
                          crossoverD3DMetalVersion === '3' && effectiveShowD3DMetalVersionSelector
                            ? effectiveFallbackD3DVer
                            : effectiveActiveLayer.d3dmetalVersion
                        } — Apple GPTK 64-bit DirectX 11 & 12)`
                      : opt.label;
                  return (
                    <option key={opt.value} value={opt.value}>
                      {dynamicLabel}
                    </option>
                  );
                })}
              </LaunchSelect>
              <p
                id={graphicsBackendHintId}
                data-testid="graphics-backend-guidance"
                className="text-[10px] text-[#cbd5e1] leading-snug"
              >
                {activeBackendPolicy.guidance}
              </p>
            </div>
          )}

          {/* Primary 4 & 5: Display Mode & Frame Rate Limit */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-3 gap-y-3">
            <div className="ol-subgrid-field">
              <label
                htmlFor={displayScalingSelectId}
                className="text-[10px] font-bold uppercase tracking-wider text-steam-subtext flex items-center gap-1 self-end"
              >
                <Maximize2 className="w-3 h-3 text-sky-400 shrink-0" aria-hidden="true" />
                <span>Display Mode</span>
              </label>
              <LaunchSelect
                id={displayScalingSelectId}
                data-testid="display-scaling-mode-select"
                aria-label="Display Mode"
                aria-describedby={displayScalingHintId}
                value={effectiveDisplayScalingMode}
                onChange={(e) =>
                  handleDisplayScalingModeChange(e.target.value as BottleDisplayScalingMode)
                }
              >
                <option value="default">Use Global Default ({globalModeLabel})</option>
                <option value="auto_fullscreen">Auto Fullscreen (Recommended)</option>
                <option value="windowed">Windowed</option>
                {effectiveDisplayScalingMode === 'force_fullscreen' && (
                  <option value="force_fullscreen">Force Fullscreen (Advanced Override)</option>
                )}
                {effectiveDisplayScalingMode === 'virtual_desktop' && (
                  <option value="virtual_desktop">Wine Virtual Desktop (Advanced Override)</option>
                )}
                {effectiveDisplayScalingMode === 'native_driver' && (
                  <option value="native_driver">Native Wine Driver (Legacy Override)</option>
                )}
              </LaunchSelect>
              <p id={displayScalingHintId} className="text-[10px] text-steam-subtext leading-snug">
                {resolvedScalingMode === 'windowed'
                  ? 'Runs in a standard movable macOS window.'
                  : resolvedScalingMode === 'virtual_desktop'
                    ? 'Isolated Wine virtual desktop container (configure resolution in Advanced below).'
                    : resolvedScalingMode === 'force_fullscreen'
                      ? 'Forces even small windowed games into notch-safe fullscreen.'
                      : 'Native Retina passthrough for 64-bit games & automatic upscaling for legacy titles.'}
              </p>
            </div>

            <div className="ol-subgrid-field">
              <label
                htmlFor={preferredMaxFpsSelectId}
                className="text-[10px] font-bold uppercase tracking-wider text-steam-subtext flex items-center gap-1 self-end"
              >
                <Gauge className="w-3 h-3 text-sky-400 shrink-0" aria-hidden="true" />
                <span>Frame Rate Limit</span>
              </label>
              <LaunchSelect
                id={preferredMaxFpsSelectId}
                data-testid="preferred-max-fps-select"
                aria-describedby={preferredMaxFpsHintId}
                value={
                  effectivePreferredMaxFrameRate !== undefined
                    ? String(effectivePreferredMaxFrameRate)
                    : ''
                }
                onChange={(e) => {
                  const val = e.target.value;
                  if (val === '') {
                    handlePreferredMaxFrameRateChange(undefined);
                    return;
                  }
                  const parsed = Math.round(Number(val));
                  handlePreferredMaxFrameRateChange(
                    Number.isFinite(parsed) && parsed > 0 ? parsed : undefined
                  );
                }}
              >
                <option value="">Unlimited</option>
                {hasCustomFpsValue && (
                  <option value={String(effectivePreferredMaxFrameRate)}>
                    {effectivePreferredMaxFrameRate} FPS (Custom)
                  </option>
                )}
                {STANDARD_FPS_PRESETS.map((fps) => (
                  <option key={fps} value={String(fps)}>
                    {fps} FPS
                  </option>
                ))}
              </LaunchSelect>
              <p id={preferredMaxFpsHintId} className="text-[10px] text-steam-subtext leading-snug">
                Caps max FPS across D3DMetal, DXMT &amp; DXVK for smoother pacing and lower thermals.
              </p>
            </div>
          </div>

          {/* Primary 6: NVIDIA DLSS via MetalFX (CrossOver only) */}
          {preview.visibleSections.crossoverRendering && (
            <div className="flex items-center justify-between gap-3 rounded-lg bg-[#141d2b] border border-[#26384d] px-3 py-2.5">
              <div className="min-w-0 space-y-0.5">
                <div className="flex flex-wrap items-center gap-2">
                  <span id={dlssLabelId} className="text-xs font-semibold text-white">
                    NVIDIA DLSS via MetalFX
                  </span>
                  {!effectiveIsDlssSupportedBackend && (
                    <span className="text-[10px] px-1.5 py-0.5 rounded bg-white/5 border border-white/15 text-steam-subtext font-medium">
                      Unavailable
                    </span>
                  )}
                </div>
                <p
                  id={dlssHintId}
                  data-testid="crossover-dlss-hint"
                  className="text-[10px] text-steam-subtext leading-snug"
                >
                  {effectiveIsDlssSupportedBackend
                    ? 'Exposes NVIDIA DLSS to the game (powered by Apple MetalFX) for D3DMetal & DXMT.'
                    : effectiveDlssUnavailableReason}
                </p>
              </div>
              <SwitchControl
                dataTestId="toggle-crossover-dlss"
                checked={effectiveIsDlssSupportedBackend && crossoverDlss}
                disabled={!effectiveIsDlssSupportedBackend}
                ariaLabelledBy={dlssLabelId}
                ariaDescribedBy={dlssHintId}
                onChange={onToggleCrossoverDlss}
                tone="emerald"
              />
            </div>
          )}
        </div>
      )}

      {/* Collapsed Native <details> Advanced Disclosures (Bottled Games) */}
      {showAdvanced && (
        <div className="space-y-2.5">
          {/* Disclosure 1: Display & Legacy Scaling Overrides */}
          <LaunchDisclosure
            summary="Display & Legacy Scaling Overrides"
            subtitle="Aspect ratio, virtual desktop, 96 DPI & modeset"
            overrideCount={computedDisplayOverrideCount}
            testId="disclosure-display-overrides"
            summaryTestId="disclosure-display-overrides-summary"
            overrideBadgeTestId="disclosure-display-overrides-badge"
          >
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-3 gap-y-3">
              <div className="ol-subgrid-field">
                <label
                  htmlFor={displayAspectSelectId}
                  className="text-[10px] font-bold uppercase tracking-wider text-steam-subtext flex items-center gap-1 self-end"
                >
                  <Monitor className="w-3 h-3 text-sky-400 shrink-0" aria-hidden="true" />
                  <span>Aspect Ratio Override</span>
                </label>
                <LaunchSelect
                  id={displayAspectSelectId}
                  data-testid="display-aspect-ratio-select"
                  aria-label="Aspect Ratio Override"
                  aria-describedby={displayAspectHintId}
                  value={effectiveDisplayAspectRatio}
                  onChange={(e) =>
                    handleDisplayAspectRatioChange(e.target.value as DisplayAspectRatioMode)
                  }
                >
                  <option value="default">Use Global Default ({globalAspectLabel})</option>
                  <option value="preserve_aspect">
                    Preserve Aspect Ratio (4:3 Pillarbox / Notch-Safe)
                  </option>
                  <option value="integer">Integer Pixel-Perfect (Crisp Nearest-Neighbor)</option>
                  <option value="stretch">Stretch to Fill Screen</option>
                </LaunchSelect>
                <p id={displayAspectHintId} className="text-[10px] text-steam-subtext leading-snug">
                  In-game scaler shortcuts:{' '}
                  <kbd className="font-mono text-sky-300">Ctrl+Option+F</kbd> Fullscreen,{' '}
                  <kbd className="font-mono text-sky-300">Ctrl+Option+A</kbd> Aspect Ratio.
                </p>
              </div>

              <div className="ol-subgrid-field">
                <label
                  htmlFor={advancedDisplaySelectId}
                  className="text-[10px] font-bold uppercase tracking-wider text-steam-subtext flex items-center gap-1 self-end"
                >
                  <Maximize2 className="w-3 h-3 text-sky-400 shrink-0" aria-hidden="true" />
                  <span>Advanced Display Scaling Mode</span>
                </label>
                <LaunchSelect
                  id={advancedDisplaySelectId}
                  data-testid="advanced-display-scaling-select"
                  aria-describedby={advancedDisplayHintId}
                  value={isAdvancedDisplayModeActive ? effectiveDisplayScalingMode : ''}
                  onChange={(e) => {
                    const val = e.target.value;
                    handleDisplayScalingModeChange(
                      val === '' ? 'default' : (val as BottleDisplayScalingMode)
                    );
                  }}
                >
                  <option value="">Use Primary Display Mode</option>
                  <option value="force_fullscreen">
                    Force Fullscreen (Wrap Small &amp; Modern Windows)
                  </option>
                  <option value="virtual_desktop">
                    Wine Virtual Desktop (Isolated Container)
                  </option>
                  {effectiveDisplayScalingMode === 'native_driver' && (
                    <option value="native_driver">Native Wine Driver (Legacy)</option>
                  )}
                </LaunchSelect>
                <p id={advancedDisplayHintId} className="text-[10px] text-steam-subtext leading-snug">
                  Override automatic Display Scaler v3 behavior for stubborn legacy windows.
                </p>
              </div>
            </div>

            {showVirtualDesktopResolutionSelect && (
              <div className="space-y-1.5">
                <label
                  htmlFor={virtualDesktopResSelectId}
                  className="block text-[10px] font-bold uppercase tracking-wider text-steam-subtext"
                >
                  Virtual Desktop Resolution
                </label>
                <LaunchSelect
                  id={virtualDesktopResSelectId}
                  data-testid="virtual-desktop-resolution-select"
                  aria-label="Virtual Desktop Resolution"
                  aria-describedby={virtualDesktopResHintId}
                  value={effectiveVirtualDesktopResolution}
                  onChange={(e) => handleVirtualDesktopResolutionChange(e.target.value)}
                >
                  {VIRTUAL_DESKTOP_RESOLUTION_OPTIONS.map((opt) => (
                    <option key={opt.value} value={opt.value}>
                      {opt.label}
                    </option>
                  ))}
                  {hasCustomVdResValue && (
                    <option value={effectiveVirtualDesktopResolution}>
                      {effectiveVirtualDesktopResolution} (Custom)
                    </option>
                  )}
                </LaunchSelect>
                <p
                  id={virtualDesktopResHintId}
                  className="text-[10px] text-steam-subtext leading-snug"
                >
                  Fixed container resolution reported to Win32 games inside Wine Virtual Desktop.
                </p>
              </div>
            )}

            {/* Single Legacy 96 DPI Compatibility Mode Switch */}
            <div className="flex items-center justify-between gap-3 rounded-lg bg-[#141d2b] border border-[#26384d] px-3 py-2.5">
              <div className="min-w-0 space-y-0.5">
                <span id={legacy96DpiLabelId} className="block text-xs font-semibold text-white">
                  Legacy 96 DPI Compatibility Mode
                </span>
                <p id={legacy96DpiHintId} className="text-[10px] text-steam-subtext leading-snug">
                  Off by default — Display Scaler v3 handles Retina &amp; HiDPI automatically.
                  Enable only if an older game renders oversized UI or clipped menus at 192 DPI.
                </p>
              </div>
              <SwitchControl
                dataTestId="toggle-legacy-96dpi-mode"
                checked={isLegacy96DpiActive}
                ariaLabelledBy={legacy96DpiLabelId}
                ariaDescribedBy={legacy96DpiHintId}
                onChange={handleToggleLegacy96Dpi}
                tone="amber"
              />
            </div>

            {/* Display Mode Emulation */}
            <div className="space-y-1.5">
              <label
                htmlFor={emulateModesetSelectId}
                className="block text-[10px] font-bold uppercase tracking-wider text-steam-subtext"
              >
                Display Mode Emulation (X11 Legacy)
              </label>
              <LaunchSelect
                id={emulateModesetSelectId}
                data-testid="emulate-modeset-select"
                aria-describedby={emulateModesetHintId}
                value={
                  effectiveEmulateModeset === undefined
                    ? ''
                    : effectiveEmulateModeset
                      ? 'true'
                      : 'false'
                }
                onChange={(e) => {
                  const val = e.target.value;
                  handleEmulateModesetChange(val === '' ? undefined : val === 'true');
                }}
              >
                <option value="">Bottle / Auto Default</option>
                <option value="true">Enabled (Emulate Win32 Modeset)</option>
                <option value="false">Disabled</option>
              </LaunchSelect>
              <p id={emulateModesetHintId} className="text-[10px] text-steam-subtext leading-snug">
                Legacy X11 Driver\EmulateModeset fallback without changing macOS display mode.
              </p>
            </div>
          </LaunchDisclosure>

          {/* Disclosure 2: Compatibility & Engine Tweaks */}
          <LaunchDisclosure
            summary="Compatibility & Engine Tweaks"
            subtitle="MetalFX spatial, CPU sync, D3DMetal version & Wine prefix"
            overrideCount={computedCompatOverrideCount}
            testId="disclosure-compat-tweaks"
            summaryTestId="disclosure-compat-tweaks-summary"
            overrideBadgeTestId="disclosure-compat-tweaks-badge"
          >
            {/* Per-Game D3DMetal Version Switcher */}
            {preview.visibleSections.crossoverRendering && effectiveShowD3DMetalVersionSelector && (
              <div
                data-testid="crossover-d3dmetal-version-section"
                className="rounded-lg bg-[#141d2b] border border-[#26384d] p-2.5 space-y-2"
              >
                <div className="flex flex-wrap items-center justify-between gap-1">
                  <span className="text-[10px] font-bold uppercase tracking-wider text-sky-300">
                    D3DMetal Engine Version
                  </span>
                  <span className="text-[10px] text-steam-subtext">
                    Bundled: v{effectivePrimaryD3DVer} &amp; v{effectiveFallbackD3DVer}
                  </span>
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                  {[
                    {
                      value: 'auto' as CrossOverD3DMetalVersion,
                      testId: 'd3dmetal-version-auto',
                      title: `Auto (v${effectivePrimaryD3DVer})`,
                      desc: `Default D3DMetal ${effectivePrimaryD3DVer} with compatdb fallback`,
                    },
                    {
                      value: '4' as CrossOverD3DMetalVersion,
                      testId: 'd3dmetal-version-4',
                      title: `Force v${effectivePrimaryD3DVer}`,
                      desc: `Forces lib/apple_gptk (D3DMetal ${effectivePrimaryD3DVer})`,
                    },
                    {
                      value: '3' as CrossOverD3DMetalVersion,
                      testId: 'd3dmetal-version-3',
                      title: `Force v${effectiveFallbackD3DVer}`,
                      desc: `Fallback to lib/apple_gptk3 (D3DMetal ${effectiveFallbackD3DVer})`,
                    },
                  ].map((item) => {
                    const isSelected = crossoverD3DMetalVersion === item.value;
                    return (
                      <button
                        key={item.value}
                        type="button"
                        data-testid={item.testId}
                        aria-pressed={isSelected}
                        onClick={() => onChangeCrossoverD3DMetalVersion(item.value)}
                        className={`min-h-[28px] text-left rounded-lg p-2 border transition-colors cursor-pointer flex flex-col justify-between gap-1 ${LAUNCH_BUTTON_FOCUS_CLASSES} ${
                          isSelected
                            ? 'bg-sky-500/15 border-sky-400 text-white'
                            : 'bg-[#0e151f] border-[#26384d] text-steam-subtext hover:border-[#385370] hover:text-white'
                        }`}
                      >
                        <div className="flex items-center justify-between gap-1.5">
                          <span
                            className={`text-[11px] font-bold leading-tight ${
                              isSelected ? 'text-sky-300' : 'text-white'
                            }`}
                          >
                            {item.title}
                          </span>
                          {isSelected && (
                            <CheckCircle2
                              className="w-3.5 h-3.5 text-sky-400 shrink-0"
                              aria-hidden="true"
                            />
                          )}
                        </div>
                        <span className="text-[10px] text-steam-subtext leading-snug">
                          {item.desc}
                        </span>
                      </button>
                    );
                  })}
                </div>
              </div>
            )}

            {/* Preserved DXMT MetalFX Spatial Upscaling (<select>) */}
            {showMetalfxSpatialControl && (
              <div className="space-y-1.5">
                <label
                  htmlFor={metalfxSpatialSelectId}
                  className="text-[10px] font-bold uppercase tracking-wider text-steam-subtext flex items-center gap-1"
                >
                  <Sparkles className="w-3 h-3 text-sky-400 shrink-0" aria-hidden="true" />
                  <span>MetalFX Spatial Upscaling (DXMT)</span>
                </label>
                <LaunchSelect
                  id={metalfxSpatialSelectId}
                  data-testid="metalfx-spatial-upscale-select"
                  aria-describedby={metalfxSpatialHintId}
                  value={
                    effectiveMetalfxSpatialUpscaleFactor !== undefined
                      ? String(effectiveMetalfxSpatialUpscaleFactor)
                      : ''
                  }
                  onChange={(e) => {
                    const val = e.target.value;
                    if (val === '') {
                      handleMetalfxSpatialUpscaleChange(undefined);
                      return;
                    }
                    const parsed = Number(val);
                    handleMetalfxSpatialUpscaleChange(
                      Number.isFinite(parsed) && parsed > 1 ? parsed : undefined
                    );
                  }}
                >
                  <option value="">Off (Native Resolution)</option>
                  <option value="1.33">1.33x (Ultra Quality)</option>
                  <option value="1.5">1.5x (Quality)</option>
                  <option value="1.7">1.7x (Balanced)</option>
                  <option value="2">2.0x (Performance)</option>
                </LaunchSelect>
                <p id={metalfxSpatialHintId} className="text-[10px] text-steam-subtext leading-snug">
                  Applies DXMT driver-level MetalFX spatial swapchain upscaling for DirectX 10/11
                  games without built-in DLSS.
                </p>
              </div>
            )}

            {/* CPU Thread Synchronization (<fieldset> Radio Group) */}
            <SegmentedRadioGroup
              name={`${idPrefix}-wine-sync-mode`}
              legend={
                <>
                  <Activity className="w-3 h-3 text-sky-400 shrink-0" aria-hidden="true" />
                  <span>CPU Thread Synchronization</span>
                </>
              }
              value={effectiveWineSyncMode}
              options={[
                {
                  value: 'msync',
                  label: 'MSync',
                  badge: 'Recommended',
                  description: 'macOS Mach semaphores for lowest multi-threaded latency.',
                  testId: 'wine-sync-msync',
                },
                {
                  value: 'esync',
                  label: 'ESync',
                  description: 'Eventfd compatibility mode when MSync has regressions.',
                  testId: 'wine-sync-esync',
                },
                {
                  value: 'default',
                  label: 'Default',
                  description: 'Legacy wineserver sync for older single-threaded titles.',
                  testId: 'wine-sync-default',
                },
              ]}
              onChange={handleSelectSyncMode}
              columns={3}
              variant="cards"
              testId="wine-sync-mode-group"
            />

            {/* 32-Bit 4 GB Address Space Override */}
            <div className="flex items-center justify-between gap-3 rounded-lg bg-[#141d2b] border border-[#26384d] px-3 py-2.5">
              <div className="min-w-0 space-y-0.5">
                <div className="flex flex-wrap items-center gap-2">
                  <span id={forceLaaLabelId} className="text-xs font-semibold text-white">
                    32-Bit 4 GB Address Space Override
                  </span>
                  {isConfirmed64BitBinary && (
                    <span
                      data-testid="force-laa-64bit-badge"
                      className="text-[10px] px-1.5 py-0.5 rounded bg-white/5 border border-white/15 text-steam-subtext font-medium"
                    >
                      64-bit Binary — Not Needed
                    </span>
                  )}
                </div>
                <p id={forceLaaHintId} className="text-[10px] text-steam-subtext leading-snug">
                  {isLaaNotNeededAndOff
                    ? 'Detected a 64-bit Windows executable (PE32+); WINE_LARGE_ADDRESS_AWARE applies only to 32-bit x86 binaries.'
                    : 'Forces WINE_LARGE_ADDRESS_AWARE=1 for legacy 32-bit x86 games hitting 2 GB out-of-memory crashes.'}
                </p>
              </div>
              <SwitchControl
                dataTestId="toggle-force-laa"
                checked={effectiveForceLargeAddressAware}
                disabled={isLaaNotNeededAndOff}
                ariaLabelledBy={forceLaaLabelId}
                ariaDescribedBy={forceLaaHintId}
                onChange={handleToggleForceLaa}
                tone="amber"
              />
            </div>

            {/* Custom Wine Prefix Path */}
            <div className="space-y-1.5">
              <label
                htmlFor={winePrefixInputId}
                className="block text-[10px] font-bold uppercase tracking-wider text-steam-subtext"
              >
                {isCrossOverFamily
                  ? 'Custom WinePrefix Directory (Optional Bottle Override)'
                  : 'WinePrefix Directory'}
              </label>
              <div className="flex items-center gap-1.5">
                <input
                  id={winePrefixInputId}
                  type="text"
                  aria-describedby={winePrefixHintId}
                  value={winePrefixPath}
                  onChange={(e) => onChangeWinePrefixPath(e.target.value)}
                  placeholder={winePrefixPlaceholder}
                  autoComplete="off"
                  spellCheck={false}
                  autoCorrect="off"
                  autoCapitalize="off"
                  className={`${LAUNCH_TEXT_INPUT_CLASSES} flex-1 font-mono`}
                />
                <button
                  type="button"
                  onClick={onBrowseWinePrefix}
                  className={`min-h-6 h-9 px-3 rounded-lg bg-[#1b2838] hover:bg-[#25374d] border border-[#2a475e] text-xs font-semibold text-sky-300 hover:text-white transition-colors cursor-pointer shrink-0 ${LAUNCH_BUTTON_FOCUS_CLASSES}`}
                >
                  Browse...
                </button>
              </div>
              <p id={winePrefixHintId} className="text-[10px] text-steam-subtext leading-snug">
                Self-contained Windows C: drive environment containing registry, saves, and DirectX
                runtime.
              </p>
            </div>
          </LaunchDisclosure>
        </div>
      )}
    </div>
  );
}

export const CompatibilityLayerSectionBase = CompatibilityLayerSectionImpl;
export const CompatibilityLayerSection = React.memo(CompatibilityLayerSectionImpl);
CompatibilityLayerSection.displayName = 'CompatibilityLayerSection';
