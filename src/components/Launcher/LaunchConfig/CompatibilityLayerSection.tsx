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
  Download,
  ExternalLink,
  FolderOpen,
  Gauge,
  Loader2,
  Maximize2,
  Monitor,
  RefreshCw,
  Sparkles,
  Wrench,
  X,
} from 'lucide-react';
import { environmentSetupService } from '../../../services/launcher/environmentSetupService';
import {
  COMPATIBILITY_RUNNER_DESCRIPTORS,
  launcherService,
} from '../../../services/launcher/launcherService';
import { formatBytes } from '../../../utils/formatBytes';
import {
  COMPAT_LAYER_OPTIONS,
  CROSSOVER_BACKEND_OPTIONS,
  VIRTUAL_DESKTOP_RESOLUTION_OPTIONS,
  formatGlobalBottleDisplayModeLabel,
  formatGlobalDisplayAspectLabel,
  formatRunnerOptionLabel,
  formatRunnerPhaseLabel,
  formatRunnerSecondaryBuildText,
  formatUserFacingPath,
  getBadgeToneClasses,
  getCrossOverGraphicsBackendPolicy,
  resolveWineSyncMode,
  type WineSyncMode,
} from './launchConfigHelpers';
import {
  LAUNCH_BUTTON_FOCUS_CLASSES,
  LAUNCH_TEXT_INPUT_CLASSES,
  LaunchSelect,
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
  activeSecondaryBuildText: string;
  activeRunnerProgress?: CompatibilityRunnerProgressEvent;
  isCheckingUpdates: boolean;
  isUpdatingRunner: boolean;
  onUpdateRunner: () => void;
  onCheckRunnerUpdates: () => void;
  onCancelRunnerOperation?: () => void;
  onInstallRunnerFromArchive?: () => void;
  onSwitchToStableCrossOver?: () => void;
  resolvedBottleFolderPath?: string;
  onOpenBottleFolder: () => void;
  isRescanningRunners: boolean;
  onRescanLayers: () => void;
  isInstallingRunner: boolean;
  isAnotherRunnerOperationActive?: boolean;
  onInstallRunnerViaBrew: () => void;
  onDownloadRunner: () => void;
  runnerUpdateFeedback: string | null;
  runnerActionFeedback: { tone: 'emerald' | 'amber' | 'sky'; text: string } | null;
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
  isDlssSupportedBackend: boolean;
  dlssUnavailableReason?: string;
  isDxvkHudSupported: boolean;
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
  metalHud: boolean;
  onToggleMetalHud: () => void;
  dxvkHud: boolean;
  onToggleDxvkHud: () => void;
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
    activeSecondaryBuildText,
    activeRunnerProgress,
    isCheckingUpdates,
    isUpdatingRunner,
    onUpdateRunner,
    onCheckRunnerUpdates,
    onInstallRunnerFromArchive,
    onSwitchToStableCrossOver,
    resolvedBottleFolderPath,
    onOpenBottleFolder,
    isRescanningRunners,
    onRescanLayers,
    isInstallingRunner,
    onInstallRunnerViaBrew,
    onDownloadRunner,
    runnerUpdateFeedback,
    runnerActionFeedback,
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
    isDlssSupportedBackend,
    isDxvkHudSupported,
    crossoverDlss,
    onToggleCrossoverDlss,
    wineMsync,
    onToggleWineMsync,
    wineEsync,
    onToggleWineEsync,
    metalHud,
    onToggleMetalHud,
    dxvkHud,
    onToggleDxvkHud,
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
  const effectiveRunnerProgress = wasLayerDowngradedForHost ? undefined : activeRunnerProgress;

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
  const effectiveIsDxvkHudSupported = wasLayerDowngradedForHost
    ? effectiveCompatSelectValue === 'wine' ||
      ((effectiveCompatSelectValue === 'crossover' ||
        effectiveCompatSelectValue === 'crossover_preview' ||
        effectiveCompatSelectValue === 'crossover_preview_arm64') &&
        (crossoverGraphicsBackend === 'auto' || crossoverGraphicsBackend === 'dxvk'))
    : isDxvkHudSupported;

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
  const effectiveFullscreenHotkeyEnabled = props.enableFullscreenHotkey ?? true;

  const resolvedScalingMode: GlobalBottleDisplayScalingMode =
    effectiveDisplayScalingMode === 'default' ? globalScalingMode : effectiveDisplayScalingMode;
  const showAspectRatioSelect =
    resolvedScalingMode === 'auto_fullscreen' || resolvedScalingMode === 'force_fullscreen';
  const showVirtualDesktopResolutionSelect = resolvedScalingMode === 'virtual_desktop';
  const globalModeLabel = formatGlobalBottleDisplayModeLabel(globalScalingMode);
  const globalAspectLabel = formatGlobalDisplayAspectLabel(globalAspectRatio);
  const hasCustomVdResValue = !VIRTUAL_DESKTOP_RESOLUTION_OPTIONS.some(
    (opt) => opt.value === effectiveVirtualDesktopResolution
  );

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

  const winePrefixInputId = `${idPrefix}-wine-prefix-path`;
  const winePrefixHintId = `${idPrefix}-wine-prefix-hint`;
  const graphicsBackendSelectId = `${idPrefix}-graphics-backend`;
  const graphicsBackendHintId = `${idPrefix}-graphics-backend-hint`;
  const highResModeSelectId = `${idPrefix}-high-res-mode`;
  const highResModeHintId = `${idPrefix}-high-res-mode-hint`;
  const dlssLabelId = `${idPrefix}-dlss-label`;
  const dlssHintId = `${idPrefix}-dlss-hint`;
  const metalfxSpatialSelectId = `${idPrefix}-metalfx-spatial-upscale`;
  const metalfxSpatialHintId = `${idPrefix}-metalfx-spatial-upscale-hint`;
  const preferredMaxFpsSelectId = `${idPrefix}-preferred-max-fps`;
  const preferredMaxFpsHintId = `${idPrefix}-preferred-max-fps-hint`;
  const displayScalingSelectId = `${idPrefix}-display-scaling-mode`;
  const displayScalingHintId = `${idPrefix}-display-scaling-mode-hint`;
  const displayAspectSelectId = `${idPrefix}-display-aspect-ratio`;
  const displayAspectHintId = `${idPrefix}-display-aspect-ratio-hint`;
  const virtualDesktopResSelectId = `${idPrefix}-virtual-desktop-res`;
  const virtualDesktopResHintId = `${idPrefix}-virtual-desktop-res-hint`;
  const emulateModesetSelectId = `${idPrefix}-emulate-modeset`;
  const emulateModesetHintId = `${idPrefix}-emulate-modeset-hint`;
  const forceLaaLabelId = `${idPrefix}-force-laa-label`;
  const forceLaaHintId = `${idPrefix}-force-laa-hint`;
  const metalHudLabelId = `${idPrefix}-metal-hud-label`;
  const metalHudHintId = `${idPrefix}-metal-hud-hint`;
  const dxvkHudLabelId = `${idPrefix}-dxvk-hud-label`;
  const dxvkHudHintId = `${idPrefix}-dxvk-hud-hint`;

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

  const canAutoInstallRunner =
    effectiveRunnerDescriptor.canAutoInstallDirect ??
    effectiveRunnerDescriptor.canAutoInstallViaBrew ??
    false;

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

  const isOperationActive = Boolean(
    effectiveRunnerProgress || isInstallingRunner || isUpdatingRunner
  );
  const isRunnerActionDisabled =
    isOperationActive || Boolean(props.isAnotherRunnerOperationActive);
  const effectiveOperation: 'install' | 'update' =
    effectiveRunnerProgress?.operation || (isUpdatingRunner ? 'update' : 'install');
  const isDeterminateDownload =
    effectiveRunnerProgress?.phase === 'downloading' &&
    typeof effectiveRunnerProgress.progressPercent === 'number' &&
    Number.isFinite(effectiveRunnerProgress.progressPercent);
  const determinatePercent = isDeterminateDownload
    ? Math.max(0, Math.min(100, Math.round(effectiveRunnerProgress!.progressPercent!)))
    : undefined;

  const hasByteTelemetry =
    typeof effectiveRunnerProgress?.bytesDownloaded === 'number' &&
    effectiveRunnerProgress.bytesDownloaded >= 0;

  return (
    <section
      data-section="compatibility-layer-settings"
      aria-label="macOS Compatibility Layer"
      className="rounded-lg bg-[#0e151f] border border-[#223447] p-3.5 space-y-4"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Cpu className="w-4 h-4 text-amber-400" aria-hidden="true" />
          <h3 className="text-xs font-bold text-white uppercase tracking-wider">
            macOS Compatibility Layer (CrossOver / Apple GPTK / Wine)
          </h3>
        </div>
        <div className="flex items-center gap-1.5">
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
          <span className="text-[10px] px-2 py-0.5 rounded bg-amber-500/15 border border-amber-500/30 text-amber-300 font-semibold">
            {detectedLayers.filter((l) => l.type !== 'native' && l.available !== false).length}{' '}
            Detected on System
          </span>
        </div>
      </div>

      <div className={`grid grid-cols-1 ${showBottleControl ? 'sm:grid-cols-2' : ''} gap-3`}>
        {/* Layer Type */}
        <div className="space-y-1.5">
          <label
            htmlFor="compat-runner-select"
            className="block text-[10px] font-bold uppercase tracking-wider text-steam-subtext"
          >
            Compatibility Runner
          </label>
          <LaunchSelect
            id="compat-runner-select"
            data-testid="compat-runner-select"
            aria-label="Compatibility Runner"
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

        {/* Bottle Selector or Name */}
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
                <option value="">Default Bottle ({defaultResolvedBottle || effectiveAvailableBottles[0]})</option>
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
                <AlertTriangle className="w-3 h-3 text-amber-400 shrink-0 mt-0.5" aria-hidden="true" />
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

      {/* Consolidated Runner Status & Live Background Progress Card */}
      <div
        data-testid="runner-details-card"
        className="rounded-lg bg-[#141d2b] border border-[#26384d] p-3 space-y-2.5"
      >
        <div
          data-testid="runner-version-update-row"
          className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-[#0e151f] border border-[#223447] px-3 py-2"
        >
          <div
            data-testid="runner-installed-version"
            className="flex flex-wrap items-center gap-2 text-xs"
          >
            <span className="font-bold text-white">{effectiveRunnerDescriptor.shortLabel}</span>
            {effectiveRunnerDescriptor.vendor && (
              <span className="text-[10px] px-1.5 py-0.5 rounded bg-white/5 border border-white/10 text-steam-subtext">
                {effectiveRunnerDescriptor.vendor}
              </span>
            )}
            {effectiveActiveLayer ? (
              <>
                <span className="font-mono text-[11px] font-semibold text-emerald-300">
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
              </>
            ) : (
              <>
                <span className="inline-flex items-center gap-1 text-[10px] font-bold px-2 py-0.5 rounded bg-amber-500/20 border border-amber-500/40 text-amber-300">
                  Not Installed
                </span>
                {effectiveUpdateInfo?.latestVersion && (
                  <span className="text-[11px] font-semibold text-steam-subtext">
                    Latest: v{effectiveUpdateInfo.latestVersion}
                  </span>
                )}
              </>
            )}
          </div>

          <div className="flex flex-wrap items-center gap-1.5">
            {isCheckingUpdates ? (
              <span className="inline-flex items-center gap-1 text-[10px] text-sky-300">
                <Loader2 className="w-3 h-3 animate-spin" aria-hidden="true" />
                <span>Checking for updates...</span>
              </span>
            ) : isPreviewBranch &&
              effectiveUpdateInfo?.authRequired &&
              !effectiveUpdateInfo?.updateAvailable ? (
              <>
                <span
                  data-testid="runner-auth-required-badge"
                  className="text-[10px] font-bold px-2 py-0.5 rounded bg-amber-500/20 border border-amber-500/40 text-amber-300"
                >
                  Sign-In Required
                </span>
                <button
                  type="button"
                  data-testid="sign-in-runner-btn"
                  aria-label={`Sign in to CodeWeavers for ${effectiveRunnerDescriptor.shortLabel}`}
                  onClick={onUpdateRunner}
                  disabled={isRunnerActionDisabled}
                  className={`min-h-6 min-w-6 inline-flex items-center gap-1 px-2.5 py-1 rounded bg-sky-500/20 hover:bg-sky-500/30 border border-sky-400/50 text-[10px] font-bold text-sky-200 hover:text-white transition-colors cursor-pointer disabled:opacity-50 ${LAUNCH_BUTTON_FOCUS_CLASSES}`}
                >
                  {isUpdatingRunner ? (
                    <>
                      <Loader2 className="w-3 h-3 animate-spin" aria-hidden="true" />
                      <span>Signing in...</span>
                    </>
                  ) : (
                    <>
                      <RefreshCw className="w-3 h-3" aria-hidden="true" />
                      <span>Sign In &amp; Check</span>
                    </>
                  )}
                </button>
              </>
            ) : effectiveActiveLayer && effectiveUpdateInfo?.updateAvailable ? (
              <>
                <span
                  data-testid="runner-update-available-badge"
                  className="text-[10px] font-bold px-2 py-0.5 rounded bg-amber-500/20 border border-amber-500/40 text-amber-300"
                >
                  Update Available: v{effectiveUpdateInfo.latestVersion}
                </span>
                <button
                  type="button"
                  data-testid="update-runner-btn"
                  aria-label={`Update ${effectiveRunnerDescriptor.shortLabel} to v${effectiveUpdateInfo.latestVersion}`}
                  onClick={onUpdateRunner}
                  disabled={isRunnerActionDisabled}
                  className={`min-h-6 min-w-6 inline-flex items-center gap-1 px-2.5 py-1 rounded bg-emerald-500/20 hover:bg-emerald-500/30 border border-emerald-400/50 text-[10px] font-bold text-emerald-200 hover:text-white transition-colors cursor-pointer disabled:opacity-50 ${LAUNCH_BUTTON_FOCUS_CLASSES}`}
                >
                  {isUpdatingRunner ? (
                    <>
                      <Loader2 className="w-3 h-3 animate-spin" aria-hidden="true" />
                      <span>Updating...</span>
                    </>
                  ) : (
                    <>
                      <Download className="w-3 h-3" aria-hidden="true" />
                      <span>Update</span>
                    </>
                  )}
                </button>
              </>
            ) : effectiveActiveLayer ? (
              <>
                <span
                  data-testid="runner-up-to-date-badge"
                  className="text-[10px] font-semibold px-2 py-0.5 rounded bg-emerald-500/15 border border-emerald-500/30 text-emerald-300"
                >
                  Up to Date
                </span>
                <button
                  type="button"
                  data-testid="check-runner-updates-btn"
                  onClick={onCheckRunnerUpdates}
                  disabled={isCheckingUpdates || isRunnerActionDisabled}
                  className={`min-h-6 min-w-6 inline-flex items-center gap-1 px-2 py-1 rounded bg-[#1b2838] hover:bg-[#25374d] border border-[#2a475e] text-[10px] font-semibold text-steam-subtext hover:text-white transition-colors cursor-pointer disabled:opacity-50 ${LAUNCH_BUTTON_FOCUS_CLASSES}`}
                >
                  <RefreshCw className="w-2.5 h-2.5" aria-hidden="true" />
                  <span>Check for Updates</span>
                </button>
                {effectiveCompatSelectValue === 'crossover_preview' &&
                  effectiveUpdateInfo?.stableSurpassesPreview &&
                  !effectiveUpdateInfo?.canAutoUpdate &&
                  onSwitchToStableCrossOver && (
                    <button
                      type="button"
                      data-testid="switch-to-stable-crossover-btn"
                      onClick={onSwitchToStableCrossOver}
                      disabled={isRunnerActionDisabled}
                      className={`min-h-6 min-w-6 inline-flex items-center gap-1 px-2.5 py-1 rounded bg-sky-500/20 hover:bg-sky-500/30 border border-sky-400/50 text-[10px] font-bold text-sky-200 hover:text-white transition-colors cursor-pointer disabled:opacity-50 ${LAUNCH_BUTTON_FOCUS_CLASSES}`}
                    >
                      <Download className="w-3 h-3" aria-hidden="true" />
                      <span>
                        {effectiveUpdateInfo.stableFallbackVersion
                          ? `Switch to CrossOver v${effectiveUpdateInfo.stableFallbackVersion}`
                          : 'Switch to Stable CrossOver'}
                      </span>
                    </button>
                  )}
              </>
            ) : null}
          </div>
        </div>

        {/* Live Background Runner Download / Install / Update Progress */}
        {isOperationActive && (
          <div
            data-testid="runner-live-progress-panel"
            className="rounded-lg bg-[#0e151f] border border-sky-500/35 p-2.5 space-y-2"
          >
            <div
              role="status"
              aria-live="polite"
              data-testid="runner-operation-status"
              className="flex flex-wrap items-center justify-between gap-2 text-[11px]"
            >
              <div className="flex items-center gap-1.5 min-w-0">
                <Loader2 className="w-3.5 h-3.5 text-sky-400 animate-spin shrink-0" aria-hidden="true" />
                <span className="font-semibold text-white">
                  {effectiveRunnerProgress
                    ? formatRunnerPhaseLabel(effectiveRunnerProgress.phase, effectiveOperation)
                    : effectiveOperation === 'update'
                      ? 'Updating runner...'
                      : 'Installing runner...'}
                </span>
                {effectiveRunnerProgress?.message && (
                  <span className="text-steam-subtext truncate">
                    — {effectiveRunnerProgress.message}
                  </span>
                )}
              </div>

              <div className="flex items-center gap-2 shrink-0">
                {hasByteTelemetry && (
                  <span className="font-mono text-[10px] text-sky-300">
                    {formatBytes(effectiveRunnerProgress!.bytesDownloaded!)}
                    {typeof effectiveRunnerProgress?.totalBytes === 'number' &&
                    effectiveRunnerProgress.totalBytes > 0
                      ? ` / ${formatBytes(effectiveRunnerProgress.totalBytes)}`
                      : ''}
                    {determinatePercent !== undefined ? ` (${determinatePercent}%)` : ''}
                  </span>
                )}
                {!hasByteTelemetry && determinatePercent !== undefined && (
                  <span className="font-mono text-[10px] text-sky-300">{determinatePercent}%</span>
                )}
                {props.onCancelRunnerOperation && (
                  <button
                    type="button"
                    data-testid="cancel-runner-operation-btn"
                    onClick={props.onCancelRunnerOperation}
                    className={`min-h-6 min-w-6 inline-flex items-center gap-1 px-2 py-0.5 rounded bg-rose-500/15 hover:bg-rose-500/25 border border-rose-400/40 text-[10px] font-semibold text-rose-200 hover:text-white transition-colors cursor-pointer ${LAUNCH_BUTTON_FOCUS_CLASSES}`}
                  >
                    <X className="w-3 h-3" aria-hidden="true" />
                    <span>Cancel</span>
                  </button>
                )}
              </div>
            </div>

            <progress
              data-testid="runner-operation-progress"
              className="ol-setup-progress w-full h-2 block"
              max={100}
              value={determinatePercent}
              aria-label={`${effectiveRunnerDescriptor.shortLabel} ${
                effectiveOperation === 'update' ? 'update' : 'installation'
              } progress`}
            />
          </div>
        )}

        <p className="text-[11px] text-steam-text leading-relaxed">
          {effectiveRunnerDescriptor.description}
        </p>
        <p className="text-[10px] text-steam-subtext leading-relaxed">
          <span className="font-semibold text-sky-300">Best for: </span>
          {effectiveRunnerDescriptor.bestFor}
        </p>

        {effectiveActiveLayer ? (
          <div className="pt-0.5 space-y-2">
            <div className="flex flex-wrap items-center justify-between gap-2 rounded bg-[#0e151f] border border-[#223447] px-2.5 py-1.5">
              <span className="text-[10px] font-mono text-sky-300/90 truncate">
                {formatUserFacingPath(effectiveActiveLayer.binaryPath)}
              </span>
              <div className="flex items-center gap-1.5 shrink-0">
                {resolvedBottleFolderPath && (
                  <button
                    type="button"
                    data-testid="open-bottle-folder-btn"
                    onClick={onOpenBottleFolder}
                    className={`min-h-6 min-w-6 inline-flex items-center gap-1 px-2 py-1 rounded bg-[#1b2838] hover:bg-[#25374d] border border-[#2a475e] text-[10px] font-semibold text-sky-300 hover:text-white transition-colors cursor-pointer ${LAUNCH_BUTTON_FOCUS_CLASSES}`}
                  >
                    <FolderOpen className="w-3 h-3" aria-hidden="true" />
                    <span>{isCrossOverFamily ? 'Open Bottle Folder' : 'Open Prefix Folder'}</span>
                  </button>
                )}
                <button
                  type="button"
                  data-testid="rescan-runners-btn"
                  onClick={onRescanLayers}
                  disabled={isRescanningRunners}
                  className={`min-h-6 min-w-6 inline-flex items-center gap-1 px-2 py-1 rounded bg-[#1b2838] hover:bg-[#25374d] border border-[#2a475e] text-[10px] font-semibold text-steam-subtext hover:text-white transition-colors cursor-pointer disabled:opacity-50 ${LAUNCH_BUTTON_FOCUS_CLASSES}`}
                >
                  <RefreshCw
                    className={`w-3 h-3 ${isRescanningRunners ? 'animate-spin' : ''}`}
                    aria-hidden="true"
                  />
                  <span>Re-Scan Runners</span>
                </button>
              </div>
            </div>
          </div>
        ) : (
          <div
            data-testid="runner-not-installed-callout"
            className="rounded-lg bg-amber-950/40 border border-amber-500/40 p-2.5 space-y-2"
          >
            <div className="flex items-start gap-2 text-xs text-amber-200">
              <AlertTriangle
                className="w-3.5 h-3.5 text-amber-400 shrink-0 mt-0.5"
                aria-hidden="true"
              />
              <div>
                <div className="font-bold text-amber-300">Runner Not Installed on This Mac</div>
                <div className="text-[11px] text-amber-100/90 mt-0.5">
                  {canAutoInstallRunner ? (
                    isPreviewBranch && effectiveUpdateInfo?.authRequired ? (
                      <>
                        CodeWeavers sign-in is required before{' '}
                        {effectiveRunnerDescriptor.shortLabel} can be checked or downloaded. Click{' '}
                        <strong>Sign In &amp; Check</strong> above to authenticate in-app.
                      </>
                    ) : isPreviewBranch ? (
                      <>
                        {effectiveRunnerDescriptor.shortLabel} is not currently installed in{' '}
                        <code className="font-mono">/Applications</code>. Click below to sign in to
                        CodeWeavers Preview in-app — One Launcher will automatically capture,
                        verify, and install the build.
                      </>
                    ) : (
                      <>
                        {effectiveRunnerDescriptor.shortLabel} is not currently installed in{' '}
                        <code className="font-mono">/Applications</code>. Click Install below to
                        download, verify, and install it automatically.
                      </>
                    )
                  ) : (
                    <>
                      {effectiveRunnerDescriptor.shortLabel} is not currently installed in{' '}
                      <code className="font-mono">/Applications</code>. Select CrossOver above for
                      1-click automatic installation, or download Preview from CodeWeavers.
                    </>
                  )}
                </div>
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-2 pt-0.5">
              {canAutoInstallRunner && !(isPreviewBranch && effectiveUpdateInfo?.authRequired) ? (
                <button
                  type="button"
                  data-testid="install-runner-brew-btn"
                  disabled={isRunnerActionDisabled}
                  onClick={onInstallRunnerViaBrew}
                  className={`min-h-6 min-w-6 inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-emerald-500/20 hover:bg-emerald-500/30 border border-emerald-400/50 text-[11px] font-bold text-emerald-200 hover:text-white transition-colors cursor-pointer disabled:opacity-50 ${LAUNCH_BUTTON_FOCUS_CLASSES}`}
                >
                  {isInstallingRunner ? (
                    <>
                      <Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden="true" />
                      <span>Installing...</span>
                    </>
                  ) : (
                    <>
                      <Download className="w-3.5 h-3.5" aria-hidden="true" />
                      <span>
                        {isPreviewBranch && !effectiveUpdateInfo?.downloadUrl
                          ? `Sign In & Install ${effectiveRunnerDescriptor.shortLabel} (${
                              effectiveRunnerDescriptor.estimatedDownloadMB
                                ? `~${effectiveRunnerDescriptor.estimatedDownloadMB} MB`
                                : '~480 MB'
                            })`
                          : `Install ${effectiveRunnerDescriptor.shortLabel}${
                              effectiveRunnerDescriptor.estimatedDownloadMB
                                ? ` (~${effectiveRunnerDescriptor.estimatedDownloadMB} MB)`
                                : ''
                            }`}
                      </span>
                    </>
                  )}
                </button>
              ) : !canAutoInstallRunner ? (
                <>
                  <button
                    type="button"
                    data-testid="download-runner-btn"
                    onClick={onDownloadRunner}
                    className={`min-h-6 min-w-6 inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-[#1b2838] hover:bg-[#25374d] border border-[#2a475e] text-[11px] font-semibold text-sky-300 hover:text-white transition-colors cursor-pointer ${LAUNCH_BUTTON_FOCUS_CLASSES}`}
                  >
                    <ExternalLink className="w-3.5 h-3.5" aria-hidden="true" />
                    <span>
                      {isPreviewBranch
                        ? 'Open Preview Portal'
                        : effectiveRunnerDescriptor.downloadLabel}{' '}
                      ↗
                    </span>
                  </button>
                  {onInstallRunnerFromArchive && (
                    <button
                      type="button"
                      data-testid="install-runner-archive-btn"
                      onClick={onInstallRunnerFromArchive}
                      disabled={isRunnerActionDisabled}
                      className={`min-h-6 min-w-6 inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-[#1b2838] hover:bg-[#25374d] border border-[#2a475e] text-[11px] font-semibold text-sky-300 hover:text-white transition-colors cursor-pointer disabled:opacity-50 ${LAUNCH_BUTTON_FOCUS_CLASSES}`}
                    >
                      <FolderOpen className="w-3.5 h-3.5" aria-hidden="true" />
                      <span>Install from Archive...</span>
                    </button>
                  )}
                </>
              ) : null}

              <button
                type="button"
                data-testid="rescan-runners-btn"
                onClick={onRescanLayers}
                disabled={isRescanningRunners}
                className={`min-h-6 min-w-6 inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-[#17212e] hover:bg-[#223144] border border-[#2a475e] text-[11px] font-semibold text-steam-subtext hover:text-white transition-colors cursor-pointer disabled:opacity-50 ${LAUNCH_BUTTON_FOCUS_CLASSES}`}
              >
                <RefreshCw
                  className={`w-3.5 h-3.5 ${isRescanningRunners ? 'animate-spin' : ''}`}
                  aria-hidden="true"
                />
                <span>Re-Scan Installed Runners</span>
              </button>

              <button
                type="button"
                data-testid="open-system-setup-wizard-btn"
                onClick={() =>
                  environmentSetupService.openWizard({
                    mode: 'repair',
                    initialStep: 'compatibility',
                  })
                }
                className={`min-h-6 min-w-6 inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-sky-500/20 hover:bg-sky-500/30 border border-sky-400/50 text-[11px] font-bold text-sky-200 hover:text-white transition-colors cursor-pointer ${LAUNCH_BUTTON_FOCUS_CLASSES}`}
              >
                <Wrench className="w-3.5 h-3.5" aria-hidden="true" />
                <span>Setup Wizard...</span>
              </button>
            </div>
          </div>
        )}

        {runnerUpdateFeedback && (() => {
          const isUpdateError =
            /\b(could not|failed|error|unavailable|busy|quit|unsupported|invalid)\b/i.test(
              runnerUpdateFeedback
            );
          return (
            <div
              data-testid="runner-update-feedback"
              role={isUpdateError ? 'alert' : 'status'}
              aria-live={isUpdateError ? 'assertive' : 'polite'}
              className="text-[11px] px-2.5 py-1.5 rounded border bg-sky-500/15 text-sky-200 border-sky-500/30"
            >
              {runnerUpdateFeedback}
            </div>
          );
        })()}

        {runnerActionFeedback && (() => {
          const isActionError = runnerActionFeedback.tone === 'amber';
          return (
            <div
              data-testid="runner-action-feedback"
              role={isActionError ? 'alert' : 'status'}
              aria-live={isActionError ? 'assertive' : 'polite'}
              className={`text-[11px] px-2.5 py-1.5 rounded border ${getBadgeToneClasses(
                runnerActionFeedback.tone
              )}`}
            >
              {runnerActionFeedback.text}
            </div>
          );
        })()}
      </div>

      {/* Custom Wine Prefix Path */}
      <div className="space-y-1.5">
        <div className="flex flex-wrap items-center justify-between gap-1">
          <label
            htmlFor={winePrefixInputId}
            className="block text-[10px] font-bold uppercase tracking-wider text-steam-subtext"
          >
            {isCrossOverFamily
              ? 'Custom WinePrefix Directory (Optional Bottle Override)'
              : 'WinePrefix Directory (Default: ~/Games/OneLauncher/Prefixes/default)'}
          </label>
          <span id={winePrefixHintId} className="text-[10px] text-steam-subtext">
            A self-contained Windows C: drive environment containing the game&apos;s registry,
            saves, and DirectX runtime
          </span>
        </div>
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
      </div>

      {/* Rendering & Display Settings Sub-Panel (CrossOver 26 vs Wine/GPTK) */}
      <div className="rounded-lg bg-[#141d2b] border border-[#26384d] p-3.5 space-y-3.5">
        <div className="flex flex-wrap items-center justify-between gap-1">
          <div className="flex items-center gap-1.5">
            <Sparkles className="w-3.5 h-3.5 text-sky-400" aria-hidden="true" />
            <h4 className="text-[11px] font-bold uppercase tracking-wider text-white">
              {preview.visibleSections.crossoverRendering
                ? 'CrossOver 26 Rendering & Display Settings'
                : 'Wine / GPTK Display & Synchronization Settings'}
            </h4>
          </div>
          <span className="text-[10px] text-steam-subtext">
            {preview.visibleSections.crossoverRendering
              ? 'Per-game bottle & graphics overrides'
              : 'Per-game prefix display & sync overrides'}
          </span>
        </div>

        {/* Graphics Backend (CrossOver only) */}
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
              surface="panel"
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

        {/* Per-Game D3DMetal Version Switcher (CrossOver Preview / Dual-D3DMetal Runners) */}
        {preview.visibleSections.crossoverRendering && effectiveShowD3DMetalVersionSelector && (
          <div
            data-testid="crossover-d3dmetal-version-section"
            className="rounded-lg bg-[#0e151f] border border-[#223447] p-2.5 space-y-2"
          >
            <div className="flex flex-wrap items-center justify-between gap-1">
              <span className="text-[10px] font-bold uppercase tracking-wider text-sky-300">
                D3DMetal Engine Version (Per-Game Override)
              </span>
              <span className="text-[10px] text-steam-subtext">
                Dual D3DMetal Bundled: v{effectivePrimaryD3DVer} &amp; v{effectiveFallbackD3DVer}
              </span>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
              {[
                {
                  value: 'auto' as CrossOverD3DMetalVersion,
                  testId: 'd3dmetal-version-auto',
                  title: `Auto / Default (D3DMetal ${effectivePrimaryD3DVer})`,
                  desc: `Uses D3DMetal ${effectivePrimaryD3DVer} by default while respecting CrossOver compatdb per-game profiles`,
                },
                {
                  value: '4' as CrossOverD3DMetalVersion,
                  testId: 'd3dmetal-version-4',
                  title: `Force D3DMetal ${effectivePrimaryD3DVer}`,
                  desc: `Forces lib/apple_gptk (D3DMetal ${effectivePrimaryD3DVer}), overriding any compatdb fallback`,
                },
                {
                  value: '3' as CrossOverD3DMetalVersion,
                  testId: 'd3dmetal-version-3',
                  title: `Force D3DMetal ${effectiveFallbackD3DVer} (Fallback)`,
                  desc: `Switches to lib/apple_gptk3 (D3DMetal ${effectiveFallbackD3DVer}) for games with regressions on ${effectivePrimaryD3DVer}`,
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
                    className={`min-h-6 text-left rounded-lg p-2 border transition-colors cursor-pointer flex flex-col justify-between gap-1 ${LAUNCH_BUTTON_FOCUS_CLASSES} ${
                      isSelected
                        ? 'bg-sky-500/15 border-sky-400 text-white'
                        : 'bg-[#141d2b] border-[#26384d] text-steam-subtext hover:border-[#385370] hover:text-white'
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
                    <span className="text-[10px] text-steam-subtext leading-snug">{item.desc}</span>
                  </button>
                );
              })}
            </div>
          </div>
        )}

        {/* DLSS (MetalFX Upscaling) — CrossOver only */}
        {preview.visibleSections.crossoverRendering && (
          <div className="flex items-center justify-between gap-3 rounded-lg bg-[#0e151f] border border-[#223447] px-3 py-2.5">
            <div className="min-w-0 space-y-0.5">
              <div className="flex flex-wrap items-center gap-2">
                <span id={dlssLabelId} className="text-xs font-semibold text-white">
                  DLSS (MetalFX Upscaling)
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
                  ? 'Exposes NVIDIA DLSS to the game (powered by Apple MetalFX) for D3DMetal & DXMT — select Quality / Balanced / Performance inside the game’s graphics settings.'
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

        {/* Rendering Pacing Row (MetalFX Spatial & Frame Rate Limit) */}
        <div
          className={`grid grid-cols-1 ${
            showMetalfxSpatialControl ? 'sm:grid-cols-2' : ''
          } gap-x-3 gap-y-3`}
        >
          {showMetalfxSpatialControl && (
            <div className="ol-subgrid-field">
              <label
                htmlFor={metalfxSpatialSelectId}
                className="text-[10px] font-bold uppercase tracking-wider text-steam-subtext flex items-center gap-1 self-end"
              >
                <Sparkles className="w-3 h-3 text-sky-400 shrink-0" aria-hidden="true" />
                <span>MetalFX Spatial (DXMT)</span>
              </label>
              <LaunchSelect
                id={metalfxSpatialSelectId}
                data-testid="metalfx-spatial-upscale-select"
                surface="panel"
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
              surface="panel"
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
              Caps maximum frame rate across D3DMetal, DXMT, and DXVK for smoother frame pacing and
              lower MacBook thermals.
            </p>
          </div>
        </div>

        {/* Dedicated Display, Fullscreen & Scaling Sub-Panel */}
        <div
          data-testid="display-fullscreen-scaling-panel"
          className="rounded-lg bg-[#0e151f] border border-[#223447] p-3 space-y-3"
        >
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-1.5">
              <Maximize2 className="w-3.5 h-3.5 text-sky-400 shrink-0" aria-hidden="true" />
              <h5 className="text-[10px] font-bold uppercase tracking-wider text-white">
                Display, Fullscreen &amp; Scaling
              </h5>
            </div>
            <span className="text-[10px] px-1.5 py-0.5 rounded bg-sky-500/15 border border-sky-500/30 text-sky-300 font-semibold">
              {effectiveFullscreenHotkeyEnabled
                ? 'Live Toggle: Ctrl+Option+F'
                : 'Per-Game Display Profile'}
            </span>
          </div>

          <div
            className={`grid grid-cols-1 ${
              showAspectRatioSelect || showVirtualDesktopResolutionSelect ? 'sm:grid-cols-2' : ''
            } gap-x-3 gap-y-3`}
          >
            <div className="ol-subgrid-field">
              <label
                htmlFor={displayScalingSelectId}
                className="text-[10px] font-bold uppercase tracking-wider text-steam-subtext flex items-center gap-1 self-end"
              >
                <Maximize2 className="w-3 h-3 text-sky-400 shrink-0" aria-hidden="true" />
                <span>Fullscreen &amp; Legacy Upscaling</span>
              </label>
              <LaunchSelect
                id={displayScalingSelectId}
                data-testid="display-scaling-mode-select"
                surface="panel"
                aria-label="Fullscreen & Legacy Upscaling"
                aria-describedby={displayScalingHintId}
                value={effectiveDisplayScalingMode}
                onChange={(e) =>
                  handleDisplayScalingModeChange(e.target.value as BottleDisplayScalingMode)
                }
              >
                <option value="default">Use Global Default ({globalModeLabel})</option>
                <option value="auto_fullscreen">
                  Auto Fullscreen &amp; Upscale Legacy Resolutions (Recommended)
                </option>
                <option value="force_fullscreen">
                  Force Fullscreen (Include Small Windowed Games)
                </option>
                <option value="native_driver">
                  Native Wine Window / Exclusive Fullscreen
                </option>
                <option value="windowed">Windowed (Movable macOS Window)</option>
                <option value="virtual_desktop">
                  Wine Virtual Desktop (Isolated Container)
                </option>
              </LaunchSelect>
              <p id={displayScalingHintId} className="text-[10px] text-steam-subtext leading-snug">
                {resolvedScalingMode === 'force_fullscreen'
                  ? 'Promotes both legacy CRT display modes and fixed small windowed games into notch-safe macOS fullscreen.'
                  : resolvedScalingMode === 'virtual_desktop'
                    ? 'Contains legacy DirectDraw / DirectX titles inside an isolated Wine virtual desktop window.'
                    : resolvedScalingMode === 'windowed'
                      ? 'Keeps bottled games in a movable, standard macOS window instead of entering fullscreen.'
                      : resolvedScalingMode === 'native_driver'
                        ? 'Delegates window management directly to Wine Mac Driver without automatic legacy upscaling.'
                        : 'Automatically upscales 640×480 / 800×600 / 1024×768 games into crisp, notch-safe macOS fullscreen.'}
              </p>
            </div>

            {showAspectRatioSelect && (
              <div className="ol-subgrid-field">
                <label
                  htmlFor={displayAspectSelectId}
                  className="text-[10px] font-bold uppercase tracking-wider text-steam-subtext flex items-center gap-1 self-end"
                >
                  <Monitor className="w-3 h-3 text-sky-400 shrink-0" aria-hidden="true" />
                  <span>Aspect Ratio &amp; Scaling Filter</span>
                </label>
                <LaunchSelect
                  id={displayAspectSelectId}
                  data-testid="display-aspect-ratio-select"
                  surface="panel"
                  aria-label="Aspect Ratio & Scaling Filter"
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
                  <option value="integer">
                    Integer Pixel-Perfect (Crisp Nearest-Neighbor)
                  </option>
                  <option value="stretch">Stretch to Fill Screen</option>
                </LaunchSelect>
                <p id={displayAspectHintId} className="text-[10px] text-steam-subtext leading-snug">
                  In-game shortcuts:{' '}
                  <kbd className="font-mono text-sky-300">Ctrl+Option+F</kbd> toggles Fullscreen /
                  Windowed; <kbd className="font-mono text-sky-300">Ctrl+Option+A</kbd> cycles
                  Aspect Ratio.
                </p>
              </div>
            )}

            {showVirtualDesktopResolutionSelect && (
              <div className="ol-subgrid-field">
                <label
                  htmlFor={virtualDesktopResSelectId}
                  className="text-[10px] font-bold uppercase tracking-wider text-steam-subtext flex items-center gap-1 self-end"
                >
                  <Monitor className="w-3 h-3 text-sky-400 shrink-0" aria-hidden="true" />
                  <span>Virtual Desktop Resolution</span>
                </label>
                <LaunchSelect
                  id={virtualDesktopResSelectId}
                  data-testid="virtual-desktop-resolution-select"
                  surface="panel"
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
                  Sets the fixed container resolution reported to legacy Win32 games inside Wine
                  Virtual Desktop.
                </p>
              </div>
            )}
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-3 gap-y-3 pt-1 border-t border-[#223447]/80">
            {/* High Resolution Mode (Retina 192 DPI) */}
            <div className="ol-subgrid-field">
              <label
                htmlFor={highResModeSelectId}
                className="text-[10px] font-bold uppercase tracking-wider text-steam-subtext flex items-center gap-1 self-end"
              >
                <Monitor className="w-3 h-3 text-sky-400 shrink-0" aria-hidden="true" />
                <span>High Resolution Mode (Retina 192 DPI)</span>
              </label>
              <LaunchSelect
                id={highResModeSelectId}
                data-testid="toggle-high-res-retina"
                surface="panel"
                aria-label="High Resolution Mode"
                aria-describedby={highResModeHintId}
                value={
                  crossoverHighResolutionMode === undefined
                    ? ''
                    : crossoverHighResolutionMode
                      ? 'true'
                      : 'false'
                }
                onChange={(e) => {
                  const val = e.target.value;
                  onChangeCrossoverHighResolutionMode(val === '' ? undefined : val === 'true');
                }}
              >
                <option value="">Bottle Default</option>
                <option value="true">Enabled (192 DPI Retina — Crisp UI/Text)</option>
                <option value="false">Disabled (96 DPI Standard — Higher FPS)</option>
              </LaunchSelect>
              <p id={highResModeHintId} className="text-[10px] text-steam-subtext leading-snug">
                Renders game menus and text at full Retina resolution (192 DPI) instead of upscaled
                96 DPI.
              </p>
            </div>

            {/* Display Mode Emulation */}
            <div className="ol-subgrid-field">
              <label
                htmlFor={emulateModesetSelectId}
                className="text-[10px] font-bold uppercase tracking-wider text-steam-subtext flex items-center gap-1 self-end"
              >
                <Monitor className="w-3 h-3 text-sky-400 shrink-0" aria-hidden="true" />
                <span>Display Mode Emulation</span>
              </label>
              <LaunchSelect
                id={emulateModesetSelectId}
                data-testid="emulate-modeset-select"
                surface="panel"
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
                <option value="true">Enabled (Fix Exclusive Fullscreen Loops)</option>
                <option value="false">Disabled</option>
              </LaunchSelect>
              <p id={emulateModesetHintId} className="text-[10px] text-steam-subtext leading-snug">
                Emulates Win32 display mode switches inside Wine Mac Driver without altering macOS
                desktop resolution.
              </p>
            </div>
          </div>
        </div>

        {/* Context-Aware 32-Bit 4 GB Address Space Override (WINE_LARGE_ADDRESS_AWARE) */}
        <div
          className={`flex items-center justify-between gap-3 rounded-lg border px-3 ${
            isLaaNotNeededAndOff
              ? 'bg-[#0e151f]/75 border-[#223447]/80 py-2'
              : 'bg-[#0e151f] border-[#223447] py-2.5'
          }`}
        >
          <div className="min-w-0 space-y-0.5">
            <div className="flex flex-wrap items-center gap-2">
              <span
                id={forceLaaLabelId}
                className={`text-xs font-semibold ${
                  isLaaNotNeededAndOff ? 'text-steam-text' : 'text-white'
                }`}
              >
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
              {isLaaNotNeededAndOff ? (
                <>
                  Detected a 64-bit Windows executable (<code className="font-mono">PE32+</code>)
                  with native full virtual address space;{' '}
                  <code className="font-mono text-sky-300">WINE_LARGE_ADDRESS_AWARE</code> only
                  applies to 32-bit x86 binaries.
                </>
              ) : (
                <>
                  Forces <code className="font-mono text-sky-300">WINE_LARGE_ADDRESS_AWARE=1</code>{' '}
                  for legacy 32-bit x86 games hitting 2 GB out-of-memory crashes. Leave off unless
                  needed—engines using high-bit pointer tagging can crash above 2 GB.
                </>
              )}
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

        {/* Group 1: CPU Thread Synchronization (Mutually Exclusive Radio Group) */}
        <fieldset className="border-0 p-0 m-0 min-w-0 space-y-2">
          <legend className="text-[10px] font-bold uppercase tracking-wider text-steam-subtext flex items-center gap-1 p-0">
            <Activity className="w-3 h-3 text-sky-400" aria-hidden="true" />
            <span>CPU Thread Synchronization</span>
          </legend>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
            {(
              [
                {
                  value: 'msync' as WineSyncMode,
                  testId: 'wine-sync-msync',
                  title: 'MSync',
                  badge: 'Recommended',
                  desc: 'macOS Mach semaphores for lowest multi-threaded latency.',
                },
                {
                  value: 'esync' as WineSyncMode,
                  testId: 'wine-sync-esync',
                  title: 'ESync',
                  badge: undefined,
                  desc: 'Eventfd compatibility mode when MSync has regressions.',
                },
                {
                  value: 'default' as WineSyncMode,
                  testId: 'wine-sync-default',
                  title: 'Default',
                  badge: undefined,
                  desc: 'Legacy wineserver sync for older single-threaded titles.',
                },
              ] as const
            ).map((opt) => {
              const isSelected = effectiveWineSyncMode === opt.value;
              return (
                <label
                  key={opt.value}
                  data-testid={opt.testId}
                  className="relative flex flex-col justify-between gap-1 rounded-lg border bg-[#0e151f] border-[#26384d] p-2.5 cursor-pointer transition-colors hover:border-[#385370] has-[:checked]:bg-sky-500/15 has-[:checked]:border-sky-400 has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-sky-400"
                >
                  <input
                    type="radio"
                    name={`${idPrefix}-wine-sync-mode`}
                    value={opt.value}
                    checked={isSelected}
                    onChange={() => handleSelectSyncMode(opt.value)}
                    className="ol-visually-hidden"
                  />
                  <div className="flex items-center justify-between gap-1.5">
                    <div className="flex items-center gap-1.5">
                      <span
                        aria-hidden="true"
                        className={`inline-flex h-3.5 w-3.5 items-center justify-center rounded-full border ${
                          isSelected
                            ? 'border-sky-400 bg-sky-400/20'
                            : 'border-[#3b5571] bg-[#141d2b]'
                        }`}
                      >
                        {isSelected && (
                          <span className="h-1.5 w-1.5 rounded-full bg-sky-300" />
                        )}
                      </span>
                      <span
                        className={`text-xs font-bold ${
                          isSelected ? 'text-sky-300' : 'text-white'
                        }`}
                      >
                        {opt.title}
                      </span>
                    </div>
                    {opt.badge && (
                      <span className="text-[9px] font-semibold px-1.5 py-0.5 rounded bg-emerald-500/15 border border-emerald-500/30 text-emerald-300">
                        {opt.badge}
                      </span>
                    )}
                  </div>
                  <span className="text-[10px] text-steam-subtext leading-snug">{opt.desc}</span>
                </label>
              );
            })}
          </div>
        </fieldset>

        {/* Group 2: Performance HUD Overlays */}
        <div className="space-y-2">
          <div className="text-[10px] font-bold uppercase tracking-wider text-steam-subtext flex items-center gap-1">
            <Gauge className="w-3 h-3 text-sky-400" aria-hidden="true" />
            <span>Performance HUD Overlays</span>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
            <div className="flex items-center justify-between gap-3 rounded-lg bg-[#0e151f] border border-[#223447] px-3 py-2.5">
              <div className="min-w-0 space-y-0.5">
                <span id={metalHudLabelId} className="block text-xs font-semibold text-white">
                  Apple Metal HUD
                </span>
                <p id={metalHudHintId} className="text-[10px] text-steam-subtext leading-snug">
                  Live Apple Metal FPS, frame-time graph, and GPU memory telemetry.
                </p>
              </div>
              <SwitchControl
                dataTestId="toggle-metal-hud"
                checked={metalHud}
                ariaLabelledBy={metalHudLabelId}
                ariaDescribedBy={metalHudHintId}
                onChange={onToggleMetalHud}
                tone="sky"
              />
            </div>

            <div className="flex items-center justify-between gap-3 rounded-lg bg-[#0e151f] border border-[#223447] px-3 py-2.5">
              <div className="min-w-0 space-y-0.5">
                <div className="flex flex-wrap items-center gap-1.5">
                  <span id={dxvkHudLabelId} className="text-xs font-semibold text-white">
                    DXVK / DXMT HUD
                  </span>
                  {!effectiveIsDxvkHudSupported && (
                    <span className="text-[9px] px-1.5 py-0.5 rounded bg-white/5 border border-white/15 text-steam-subtext font-medium">
                      Unavailable
                    </span>
                  )}
                </div>
                <p id={dxvkHudHintId} className="text-[10px] text-steam-subtext leading-snug">
                  {effectiveIsDxvkHudSupported
                    ? 'Displays Vulkan/DXVK pipeline statistics and shader compile status.'
                    : 'Requires DXVK or Auto backend (use Apple Metal HUD for D3DMetal & GPTK).'}
                </p>
              </div>
              <SwitchControl
                dataTestId="toggle-dxvk-hud"
                checked={effectiveIsDxvkHudSupported && dxvkHud}
                disabled={!effectiveIsDxvkHudSupported}
                title={
                  !effectiveIsDxvkHudSupported
                    ? 'DXVK HUD requires DXVK or Auto backend (not used by D3DMetal, DXMT, WineD3D, or Apple GPTK — use Metal HUD instead)'
                    : undefined
                }
                ariaLabelledBy={dxvkHudLabelId}
                ariaDescribedBy={dxvkHudHintId}
                onChange={onToggleDxvkHud}
                tone="sky"
              />
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

export const CompatibilityLayerSectionBase = CompatibilityLayerSectionImpl;
export const CompatibilityLayerSection = React.memo(CompatibilityLayerSectionImpl);
CompatibilityLayerSection.displayName = 'CompatibilityLayerSection';
