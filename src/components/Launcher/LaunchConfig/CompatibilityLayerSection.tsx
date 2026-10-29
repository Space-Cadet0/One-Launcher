import React from 'react';
import {
  CompatibilityLayerInfo,
  CompatibilityLayerType,
  CompatibilityLayerUpdateInfo,
  CompatibilityRunnerDescriptor,
  CrossOverD3DMetalVersion,
  CrossOverGraphicsBackend,
  LaunchMethod,
  ResolvedLaunchModePreview,
} from '../../../contracts/launcher';
import {
  Activity,
  AlertTriangle,
  CheckCircle2,
  Cpu,
  Download,
  ExternalLink,
  FolderOpen,
  Loader2,
  Monitor,
  RefreshCw,
  Sparkles,
} from 'lucide-react';
import {
  COMPAT_LAYER_OPTIONS,
  CROSSOVER_BACKEND_OPTIONS,
  formatRunnerOptionLabel,
  getBadgeToneClasses,
} from './launchConfigHelpers';

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
  isCheckingUpdates: boolean;
  isUpdatingRunner: boolean;
  onUpdateRunner: () => void;
  onCheckRunnerUpdates: () => void;
  resolvedBottleFolderPath?: string;
  onOpenBottleFolder: () => void;
  isRescanningRunners: boolean;
  onRescanLayers: () => void;
  isInstallingRunner: boolean;
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
  isDxvkHudSupported: boolean;
  crossoverDlss: boolean;
  onToggleCrossoverDlss: () => void;
  wineMsync: boolean;
  onToggleWineMsync: () => void;
  wineEsync: boolean;
  onToggleWineEsync: () => void;
  metalHud: boolean;
  onToggleMetalHud: () => void;
  dxvkHud: boolean;
  onToggleDxvkHud: () => void;
}

function CompatibilityLayerSectionImpl({
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
  isCheckingUpdates,
  isUpdatingRunner,
  onUpdateRunner,
  onCheckRunnerUpdates,
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
}: CompatibilityLayerSectionProps): React.ReactElement | null {
  const winePrefixInputId = `${idPrefix}-wine-prefix-path`;
  const graphicsBackendSelectId = `${idPrefix}-graphics-backend`;
  const highResModeSelectId = `${idPrefix}-high-res-mode`;

  if (isWindowsHost || !preview.visibleSections.compatibilityLayer) {
    return null;
  }

  const isCrossOverFamily =
    compatibilityLayer === 'crossover' || compatibilityLayer === 'crossover_preview';
  const showBottleControl = isCrossOverFamily || availableBottles.length > 0;
  const winePrefixPlaceholder =
    compatibilityLayer === 'crossover_preview'
      ? '~/Library/Application Support/CrossOver Preview/Bottles/...'
      : compatibilityLayer === 'crossover'
        ? '~/Library/Application Support/CrossOver/Bottles/...'
        : '~/Games/OneLauncher/Prefixes/default';

  return (
    <div
      data-section="compatibility-layer-settings"
      className="rounded-lg bg-[#0e151f] border border-[#223447] p-3.5 space-y-4"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Cpu className="w-4 h-4 text-amber-400" />
          <span className="text-xs font-bold text-white uppercase tracking-wider">
            macOS Compatibility Layer (CrossOver / Apple GPTK / Wine)
          </span>
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
            {detectedLayers.filter((l) => l.type !== 'native').length} Detected on System
          </span>
        </div>
      </div>

      <div className={`grid grid-cols-1 ${showBottleControl ? 'sm:grid-cols-2' : ''} gap-3`}>
        {/* Layer Type */}
        <div className="space-y-1">
          <label
            htmlFor="compat-runner-select"
            className="block text-[10px] font-bold uppercase tracking-wider text-steam-subtext"
          >
            Compatibility Runner
          </label>
          <select
            id="compat-runner-select"
            data-testid="compat-runner-select"
            aria-label="Compatibility Runner"
            value={compatibilityLayer}
            onChange={(e) =>
              onSelectCompatibilityLayer(e.target.value as CompatibilityLayerType)
            }
            className="w-full rounded-lg bg-[#141d2b] border border-[#2a475e] px-2.5 py-1.5 text-xs text-white focus:outline-none focus:border-sky-400"
          >
            {COMPAT_LAYER_OPTIONS.map((opt) => {
              const layerInfo = detectedLayers.find((l) => l.type === opt.value);
              const upd = runnerUpdates[opt.value];
              return (
                <option key={opt.value} value={opt.value}>
                  {formatRunnerOptionLabel(opt, layerInfo, upd)}
                </option>
              );
            })}
          </select>
        </div>

        {/* Bottle Selector or Name (filtered out for standalone WinePrefix runners without bottles) */}
        {showBottleControl && (
          <div className="space-y-1">
            <label
              htmlFor="compat-target-bottle-control"
              className="block text-[10px] font-bold uppercase tracking-wider text-steam-subtext"
            >
              {isCrossOverFamily ? 'Target CrossOver Bottle' : 'Target Bottle Name'}
            </label>
            {availableBottles.length > 0 ? (
              <select
                id="compat-target-bottle-control"
                aria-label="Target Bottle Name"
                value={wineBottleName}
                onChange={(e) => onChangeWineBottleName(e.target.value)}
                className="w-full rounded-lg bg-[#141d2b] border border-[#2a475e] px-2.5 py-1.5 text-xs text-white focus:outline-none focus:border-sky-400"
              >
                <option value="">Default Bottle ({availableBottles[0]})</option>
                {availableBottles.map((b) => (
                  <option key={b} value={b}>
                    {b}
                  </option>
                ))}
              </select>
            ) : (
              <input
                id="compat-target-bottle-control"
                type="text"
                aria-label="Target Bottle Name"
                value={wineBottleName}
                onChange={(e) => onChangeWineBottleName(e.target.value)}
                placeholder="e.g. OneLauncher, Steam, Default"
                spellCheck={false}
                autoCorrect="off"
                autoCapitalize="off"
                className="w-full rounded-lg bg-[#141d2b] border border-[#2a475e] px-2.5 py-1.5 text-xs text-white font-mono focus:outline-none focus:border-sky-400"
              />
            )}
          </div>
        )}
      </div>

      {/* Heroic-Inspired Runner Details & Status Card */}
      <div
        data-testid="runner-details-card"
        className="rounded-lg bg-[#141d2b] border border-[#26384d] p-3 space-y-2.5"
      >
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <span className="text-xs font-bold text-white">
              {selectedRunnerDescriptor.shortLabel}
            </span>
            <span className="text-[10px] px-1.5 py-0.5 rounded bg-white/5 border border-white/10 text-steam-subtext">
              {selectedRunnerDescriptor.vendor}
            </span>
          </div>
          {activeLayer ? (
            <span className="inline-flex items-center gap-1 text-[10px] font-bold px-2 py-0.5 rounded bg-emerald-500/20 border border-emerald-500/40 text-emerald-300">
              <span>✓ Installed &amp; Ready</span>
              {activeInstalledVer ? <span>(v{activeInstalledVer})</span> : null}
            </span>
          ) : (
            <span className="inline-flex items-center gap-1 text-[10px] font-bold px-2 py-0.5 rounded bg-amber-500/20 border border-amber-500/40 text-amber-300">
              Not Installed
            </span>
          )}
        </div>

        {/* Version & Update Row */}
        <div
          data-testid="runner-version-update-row"
          className="flex flex-wrap items-center justify-between gap-2 rounded bg-[#0e151f] border border-[#223447] px-2.5 py-1.5"
        >
          <div
            data-testid="runner-installed-version"
            className="flex flex-wrap items-center gap-1.5 text-[11px]"
          >
            {activeLayer ? (
              <>
                <span className="font-semibold text-white">
                  Installed Version: v{activeInstalledVer || 'Detected'}
                </span>
                {activeSecondaryBuildText && (
                  <span className="text-[10px] text-steam-subtext">({activeSecondaryBuildText})</span>
                )}
                {activeLayer.d3dmetalVersion && (
                  <span
                    data-testid="runner-d3dmetal-version"
                    className="text-[10px] font-semibold px-1.5 py-0.5 rounded bg-sky-500/15 border border-sky-500/30 text-sky-300"
                  >
                    {(activeLayer.availableD3DMetalVersions?.length || 0) > 1
                      ? `D3DMetal: v${activeLayer.availableD3DMetalVersions![0].version} (Default) / v${activeLayer.availableD3DMetalVersions![1].version}`
                      : `D3DMetal: v${activeLayer.d3dmetalVersion}`}
                  </span>
                )}
              </>
            ) : activeUpdateInfo?.latestVersion ? (
              <span className="font-semibold text-steam-subtext">
                Latest Available: v{activeUpdateInfo.latestVersion}
              </span>
            ) : (
              <span className="text-steam-subtext">Not installed on this Mac</span>
            )}
          </div>

          <div className="flex flex-wrap items-center gap-1.5">
            {isCheckingUpdates ? (
              <span className="inline-flex items-center gap-1 text-[10px] text-sky-300">
                <Loader2 className="w-3 h-3 animate-spin" />
                <span>Checking for updates...</span>
              </span>
            ) : activeLayer && activeUpdateInfo?.updateAvailable ? (
              <>
                <span
                  data-testid="runner-update-available-badge"
                  className="text-[10px] font-bold px-2 py-0.5 rounded bg-amber-500/20 border border-amber-500/40 text-amber-300"
                >
                  Update Available: v{activeUpdateInfo.latestVersion}
                </span>
                <button
                  type="button"
                  data-testid="update-runner-btn"
                  onClick={onUpdateRunner}
                  disabled={isUpdatingRunner}
                  className="inline-flex items-center gap-1 px-2.5 py-1 rounded bg-emerald-500/20 hover:bg-emerald-500/30 border border-emerald-400/50 text-[10px] font-bold text-emerald-200 hover:text-white transition-colors cursor-pointer disabled:opacity-50"
                >
                  {isUpdatingRunner ? (
                    <>
                      <Loader2 className="w-3 h-3 animate-spin" />
                      <span>Updating Runner...</span>
                    </>
                  ) : (
                    <>
                      <Download className="w-3 h-3" />
                      <span>Update to v{activeUpdateInfo.latestVersion}</span>
                    </>
                  )}
                </button>
              </>
            ) : activeLayer ? (
              <>
                <span
                  data-testid="runner-up-to-date-badge"
                  className="text-[10px] font-semibold px-2 py-0.5 rounded bg-emerald-500/15 border border-emerald-500/30 text-emerald-300"
                >
                  Up to Date{activeInstalledVer ? ` (v${activeInstalledVer})` : ''}
                </span>
                <button
                  type="button"
                  data-testid="check-runner-updates-btn"
                  onClick={onCheckRunnerUpdates}
                  disabled={isCheckingUpdates}
                  className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-[#1b2838] hover:bg-[#25374d] border border-[#2a475e] text-[10px] font-semibold text-steam-subtext hover:text-white transition-colors cursor-pointer disabled:opacity-50"
                >
                  <RefreshCw className="w-2.5 h-2.5" />
                  <span>Check for Updates</span>
                </button>
              </>
            ) : null}
          </div>
        </div>

        <p className="text-[11px] text-steam-text leading-relaxed">
          {selectedRunnerDescriptor.description}
        </p>
        <p className="text-[10px] text-steam-subtext leading-relaxed">
          <span className="font-semibold text-sky-300">Best for: </span>
          {selectedRunnerDescriptor.bestFor}
        </p>

        {activeLayer ? (
          <div className="pt-1 space-y-2">
            <div className="flex flex-wrap items-center justify-between gap-2 rounded bg-[#0e151f] border border-[#223447] px-2.5 py-1.5">
              <span className="text-[10px] font-mono text-sky-300/90 truncate">
                {activeLayer.binaryPath}
              </span>
              <div className="flex items-center gap-1.5 shrink-0">
                {resolvedBottleFolderPath && (
                  <button
                    type="button"
                    data-testid="open-bottle-folder-btn"
                    onClick={onOpenBottleFolder}
                    className="inline-flex items-center gap-1 px-2 py-1 rounded bg-[#1b2838] hover:bg-[#25374d] border border-[#2a475e] text-[10px] font-semibold text-sky-300 hover:text-white transition-colors cursor-pointer"
                  >
                    <FolderOpen className="w-3 h-3" />
                    <span>{isCrossOverFamily ? 'Open Bottle Folder' : 'Open Prefix Folder'}</span>
                  </button>
                )}
                <button
                  type="button"
                  data-testid="rescan-runners-btn"
                  onClick={onRescanLayers}
                  disabled={isRescanningRunners}
                  className="inline-flex items-center gap-1 px-2 py-1 rounded bg-[#1b2838] hover:bg-[#25374d] border border-[#2a475e] text-[10px] font-semibold text-steam-subtext hover:text-white transition-colors cursor-pointer disabled:opacity-50"
                >
                  <RefreshCw className={`w-3 h-3 ${isRescanningRunners ? 'animate-spin' : ''}`} />
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
              <AlertTriangle className="w-3.5 h-3.5 text-amber-400 shrink-0 mt-0.5" />
              <div>
                <div className="font-bold text-amber-300">Runner Not Installed on This Mac</div>
                <div className="text-[11px] text-amber-100/90 mt-0.5">
                  {selectedRunnerDescriptor.shortLabel} is not currently detected in{' '}
                  <code className="font-mono">/Applications</code> or Homebrew. Install it below or
                  select an installed runner above.
                </div>
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-2 pt-0.5">
              {selectedRunnerDescriptor.canAutoInstallViaBrew && (
                <button
                  type="button"
                  data-testid="install-runner-brew-btn"
                  disabled={isInstallingRunner}
                  onClick={onInstallRunnerViaBrew}
                  className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-emerald-500/20 hover:bg-emerald-500/30 border border-emerald-400/50 text-[11px] font-bold text-emerald-200 hover:text-white transition-colors cursor-pointer disabled:opacity-50"
                >
                  {isInstallingRunner ? (
                    <>
                      <Loader2 className="w-3.5 h-3.5 animate-spin" />
                      <span>Installing via Homebrew...</span>
                    </>
                  ) : (
                    <>
                      <Download className="w-3.5 h-3.5" />
                      <span>
                        Install {selectedRunnerDescriptor.shortLabel} Automatically (Homebrew)
                      </span>
                    </>
                  )}
                </button>
              )}

              <button
                type="button"
                data-testid="download-runner-btn"
                onClick={onDownloadRunner}
                className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-[#1b2838] hover:bg-[#25374d] border border-[#2a475e] text-[11px] font-semibold text-sky-300 hover:text-white transition-colors cursor-pointer"
              >
                <ExternalLink className="w-3.5 h-3.5" />
                <span>{selectedRunnerDescriptor.downloadLabel} ↗</span>
              </button>

              <button
                type="button"
                data-testid="rescan-runners-btn"
                onClick={onRescanLayers}
                disabled={isRescanningRunners}
                className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-[#17212e] hover:bg-[#223144] border border-[#2a475e] text-[11px] font-semibold text-steam-subtext hover:text-white transition-colors cursor-pointer disabled:opacity-50"
              >
                <RefreshCw
                  className={`w-3.5 h-3.5 ${isRescanningRunners ? 'animate-spin' : ''}`}
                />
                <span>Re-Scan Installed Runners</span>
              </button>
            </div>

            {selectedRunnerDescriptor.brewCommandDisplay && (
              <div className="flex items-center gap-2 pt-0.5">
                <span className="text-[10px] text-amber-200/80">Homebrew CLI:</span>
                <code className="text-[10px] font-mono bg-black/40 border border-amber-500/30 text-amber-200 px-2 py-0.5 rounded select-all">
                  {selectedRunnerDescriptor.brewCommandDisplay}
                </code>
              </div>
            )}
          </div>
        )}

        {runnerUpdateFeedback && (
          <div
            data-testid="runner-update-feedback"
            className="text-[11px] px-2.5 py-1.5 rounded border bg-sky-500/15 text-sky-200 border-sky-500/30"
          >
            {runnerUpdateFeedback}
          </div>
        )}

        {runnerActionFeedback && (
          <div
            className={`text-[11px] px-2.5 py-1.5 rounded border ${getBadgeToneClasses(
              runnerActionFeedback.tone
            )}`}
          >
            {runnerActionFeedback.text}
          </div>
        )}
      </div>

      {/* Custom Wine Prefix Path */}
      <div className="space-y-1">
        <div className="flex flex-wrap items-center justify-between gap-1">
          <label
            htmlFor={winePrefixInputId}
            className="block text-[10px] font-bold uppercase tracking-wider text-steam-subtext"
          >
            {isCrossOverFamily
              ? 'Custom WinePrefix Directory (Optional Bottle Override)'
              : 'WinePrefix Directory (Default: ~/Games/OneLauncher/Prefixes/default)'}
          </label>
          <span className="text-[10px] text-steam-subtext">
            A self-contained Windows C: drive environment containing the game&apos;s registry,
            saves, and DirectX runtime
          </span>
        </div>
        <div className="flex items-center gap-1.5">
          <input
            id={winePrefixInputId}
            type="text"
            value={winePrefixPath}
            onChange={(e) => onChangeWinePrefixPath(e.target.value)}
            placeholder={winePrefixPlaceholder}
            autoComplete="off"
            spellCheck={false}
            autoCorrect="off"
            autoCapitalize="off"
            className="flex-1 rounded-lg bg-[#141d2b] border border-[#2a475e] px-2.5 py-1.5 text-xs text-white font-mono focus:outline-none focus:border-sky-400"
          />
          <button
            type="button"
            onClick={onBrowseWinePrefix}
            className="px-2.5 py-1.5 rounded-lg bg-[#1b2838] hover:bg-[#25374d] border border-[#2a475e] text-xs font-semibold text-sky-300 hover:text-white transition-colors cursor-pointer shrink-0"
          >
            Browse...
          </button>
        </div>
      </div>

      {/* Rendering & Display Settings Sub-Panel (CrossOver 26 vs Wine/GPTK) */}
      <div className="rounded-lg bg-[#141d2b] border border-[#26384d] p-3 space-y-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-1.5">
            <Sparkles className="w-3.5 h-3.5 text-sky-400" />
            <span className="text-[11px] font-bold uppercase tracking-wider text-white">
              {preview.visibleSections.crossoverRendering
                ? 'CrossOver 26 Rendering & Display Settings'
                : 'Wine / GPTK Display & Synchronization Settings'}
            </span>
          </div>
          <span className="text-[10px] text-steam-subtext">
            {preview.visibleSections.crossoverRendering
              ? 'Per-game bottle & graphics overrides'
              : 'Per-game prefix display & sync overrides'}
          </span>
        </div>

        <div
          className={`grid grid-cols-1 ${
            preview.visibleSections.crossoverRendering ? 'sm:grid-cols-2' : ''
          } gap-3`}
        >
          {/* Graphics Backend (CrossOver only) */}
          {preview.visibleSections.crossoverRendering && (
            <div className="space-y-1">
              <label
                htmlFor={graphicsBackendSelectId}
                className="block text-[10px] font-bold uppercase tracking-wider text-steam-subtext"
              >
                Graphics Backend
              </label>
              <select
                id={graphicsBackendSelectId}
                aria-label="Graphics Backend"
                value={crossoverGraphicsBackend}
                onChange={(e) =>
                  onChangeCrossoverGraphicsBackend(e.target.value as CrossOverGraphicsBackend)
                }
                className="w-full rounded-lg bg-[#0e151f] border border-[#2a475e] px-2.5 py-1.5 text-xs text-white focus:outline-none focus:border-sky-400"
              >
                {CROSSOVER_BACKEND_OPTIONS.map((opt) => {
                  const dynamicLabel =
                    opt.value === 'd3dmetal' && activeLayer?.d3dmetalVersion
                      ? `D3DMetal (v${
                          crossoverD3DMetalVersion === '3' && showD3DMetalVersionSelector
                            ? fallbackD3DVer
                            : activeLayer.d3dmetalVersion
                        } — Apple GPTK DirectX 11 & 12)`
                      : opt.label;
                  return (
                    <option key={opt.value} value={opt.value}>
                      {dynamicLabel}
                    </option>
                  );
                })}
              </select>
              <p className="text-[10px] text-steam-subtext leading-snug">
                Translates DirectX graphics to Apple Metal. Auto selects D3DMetal or DXMT for
                DirectX 11/12 and DXVK/WineD3D for older titles.
              </p>
            </div>
          )}

          {/* High Resolution Mode (Retina 192 DPI) */}
          <div className="space-y-1">
            <label
              htmlFor={highResModeSelectId}
              className="text-[10px] font-bold uppercase tracking-wider text-steam-subtext flex items-center gap-1"
            >
              <Monitor className="w-3 h-3 text-sky-400" />
              <span>High Resolution Mode (Retina 192 DPI)</span>
            </label>
            <select
              id={highResModeSelectId}
              aria-label="High Resolution Mode"
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
              className="w-full rounded-lg bg-[#0e151f] border border-[#2a475e] px-2.5 py-1.5 text-xs text-white focus:outline-none focus:border-sky-400"
            >
              <option value="">Bottle Default</option>
              <option value="true">Enabled (192 DPI Retina — Crisp UI/Text)</option>
              <option value="false">Disabled (96 DPI Standard — Higher FPS)</option>
            </select>
            <p className="text-[10px] text-steam-subtext leading-snug">
              Renders game menus and text at full Retina resolution (192 DPI) instead of upscaled 96
              DPI.
            </p>
          </div>
        </div>

        {/* Per-Game D3DMetal Version Switcher (CrossOver Preview / Dual-D3DMetal Runners) */}
        {preview.visibleSections.crossoverRendering && showD3DMetalVersionSelector && (
          <div
            data-testid="crossover-d3dmetal-version-section"
            className="rounded-lg bg-[#0e151f] border border-[#223447] p-2.5 space-y-2"
          >
            <div className="flex flex-wrap items-center justify-between gap-1">
              <label className="text-[10px] font-bold uppercase tracking-wider text-sky-300">
                D3DMetal Engine Version (Per-Game Override)
              </label>
              <span className="text-[10px] text-steam-subtext">
                Dual D3DMetal Bundled: v{primaryD3DVer} &amp; v{fallbackD3DVer}
              </span>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
              {[
                {
                  value: 'auto' as CrossOverD3DMetalVersion,
                  testId: 'd3dmetal-version-auto',
                  title: `Auto / Default (D3DMetal ${primaryD3DVer})`,
                  desc: `Uses D3DMetal ${primaryD3DVer} by default while respecting CrossOver compatdb per-game profiles`,
                },
                {
                  value: '4' as CrossOverD3DMetalVersion,
                  testId: 'd3dmetal-version-4',
                  title: `Force D3DMetal ${primaryD3DVer}`,
                  desc: `Forces lib/apple_gptk (D3DMetal ${primaryD3DVer}), overriding any compatdb fallback`,
                },
                {
                  value: '3' as CrossOverD3DMetalVersion,
                  testId: 'd3dmetal-version-3',
                  title: `Force D3DMetal ${fallbackD3DVer} (Fallback)`,
                  desc: `Switches to lib/apple_gptk3 (D3DMetal ${fallbackD3DVer}) for games with regressions on ${primaryD3DVer}`,
                },
              ].map((item) => {
                const isSelected = crossoverD3DMetalVersion === item.value;
                return (
                  <button
                    key={item.value}
                    type="button"
                    data-testid={item.testId}
                    onClick={() => onChangeCrossoverD3DMetalVersion(item.value)}
                    className={`text-left rounded-lg p-2 border transition-colors cursor-pointer flex flex-col justify-between gap-1 ${
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
                      {isSelected && <CheckCircle2 className="w-3.5 h-3.5 text-sky-400 shrink-0" />}
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
          <div className="flex items-center justify-between gap-3 rounded-lg bg-[#0e151f] border border-[#223447] px-3 py-2">
            <div className="min-w-0">
              <div className="text-xs font-semibold text-white">DLSS (MetalFX Upscaling)</div>
              <div className="text-[10px] text-steam-subtext">
                {isDlssSupportedBackend
                  ? 'Exposes NVIDIA DLSS to the game (powered by Apple MetalFX) for D3DMetal & DXMT — select Quality / Balanced / Performance inside the game’s graphics settings.'
                  : 'Not available with DXVK or WineD3D'}
              </div>
            </div>
            <button
              type="button"
              disabled={!isDlssSupportedBackend}
              onClick={onToggleCrossoverDlss}
              className={`px-3 py-1 rounded-md text-xs font-bold border transition-colors shrink-0 ${
                !isDlssSupportedBackend
                  ? 'bg-[#17212e] border-[#26384d] text-steam-subtext/40 cursor-not-allowed'
                  : crossoverDlss
                    ? 'bg-emerald-500/20 border-emerald-400 text-emerald-300 cursor-pointer'
                    : 'bg-[#17212e] border-[#26384d] text-steam-subtext hover:text-white cursor-pointer'
              }`}
            >
              {!isDlssSupportedBackend ? 'Unavailable' : crossoverDlss ? 'Enabled' : 'Disabled'}
            </button>
          </div>
        )}

        {/* Synchronization & HUD Overlays */}
        <div className="space-y-1.5">
          <label className="text-[10px] font-bold uppercase tracking-wider text-steam-subtext flex items-center gap-1">
            <Activity className="w-3 h-3 text-sky-400" />
            <span>Synchronization &amp; HUD Overlays</span>
          </label>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
            <button
              type="button"
              onClick={onToggleWineMsync}
              className={`px-2.5 py-1.5 rounded-lg border text-xs font-semibold transition-colors cursor-pointer flex items-center justify-between ${
                wineMsync
                  ? 'bg-emerald-500/20 border-emerald-400 text-emerald-300'
                  : 'bg-[#0e151f] border-[#26384d] text-steam-subtext hover:text-white'
              }`}
            >
              <span>MSync</span>
              <span className="text-[10px] font-bold">{wineMsync ? 'ON' : 'OFF'}</span>
            </button>

            <button
              type="button"
              onClick={onToggleWineEsync}
              className={`px-2.5 py-1.5 rounded-lg border text-xs font-semibold transition-colors cursor-pointer flex items-center justify-between ${
                wineEsync
                  ? 'bg-emerald-500/20 border-emerald-400 text-emerald-300'
                  : 'bg-[#0e151f] border-[#26384d] text-steam-subtext hover:text-white'
              }`}
            >
              <span>ESync</span>
              <span className="text-[10px] font-bold">{wineEsync ? 'ON' : 'OFF'}</span>
            </button>

            <button
              type="button"
              onClick={onToggleMetalHud}
              className={`px-2.5 py-1.5 rounded-lg border text-xs font-semibold transition-colors cursor-pointer flex items-center justify-between ${
                metalHud
                  ? 'bg-sky-500/20 border-sky-400 text-sky-300'
                  : 'bg-[#0e151f] border-[#26384d] text-steam-subtext hover:text-white'
              }`}
            >
              <span>Metal HUD</span>
              <span className="text-[10px] font-bold">{metalHud ? 'ON' : 'OFF'}</span>
            </button>

            <button
              type="button"
              data-testid="toggle-dxvk-hud"
              disabled={!isDxvkHudSupported}
              title={
                !isDxvkHudSupported
                  ? 'DXVK HUD requires DXVK or Auto backend (not used by D3DMetal, DXMT, WineD3D, or Apple GPTK — use Metal HUD instead)'
                  : undefined
              }
              onClick={onToggleDxvkHud}
              className={`px-2.5 py-1.5 rounded-lg border text-xs font-semibold transition-colors flex items-center justify-between ${
                !isDxvkHudSupported
                  ? 'bg-[#0e151f]/60 border-[#26384d]/60 text-steam-subtext/40 cursor-not-allowed'
                  : dxvkHud
                    ? 'bg-sky-500/20 border-sky-400 text-sky-300 cursor-pointer'
                    : 'bg-[#0e151f] border-[#26384d] text-steam-subtext hover:text-white cursor-pointer'
              }`}
            >
              <span>DXVK HUD</span>
              <span className="text-[10px] font-bold">
                {!isDxvkHudSupported ? 'N/A' : dxvkHud ? 'ON' : 'OFF'}
              </span>
            </button>
          </div>
          <p className="text-[10px] text-steam-subtext leading-snug">
            {isDxvkHudSupported
              ? 'MSync (recommended on macOS) and ESync accelerate multi-threaded CPU synchronization. Metal HUD and DXVK HUD display live FPS and frame-time overlays.'
              : 'MSync (recommended on macOS) and ESync accelerate multi-threaded CPU synchronization. Metal HUD displays live Apple Metal FPS & frame-time overlays (DXVK HUD requires DXVK).'}
          </p>
        </div>
      </div>
    </div>
  );
}

export const CompatibilityLayerSectionBase = CompatibilityLayerSectionImpl;
export const CompatibilityLayerSection = React.memo(CompatibilityLayerSectionImpl);
CompatibilityLayerSection.displayName = 'CompatibilityLayerSection';
