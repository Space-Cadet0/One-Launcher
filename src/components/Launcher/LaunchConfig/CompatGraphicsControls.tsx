import React from 'react';
import { Activity, CheckCircle2, Gauge, Maximize2, Sparkles } from 'lucide-react';
import type {
  BottleDisplayScalingMode,
  CompatibilityLayerInfo,
  CrossOverD3DMetalVersion,
  CrossOverGraphicsBackend,
  GlobalBottleDisplayScalingMode,
  ResolvedLaunchModePreview,
} from '../../../contracts/launcher';
import {
  CROSSOVER_BACKEND_OPTIONS,
  type CrossOverGraphicsBackendPolicyDescriptor,
  type WineSyncMode,
} from './launchConfigHelpers';
import {
  LAUNCH_BUTTON_FOCUS_CLASSES,
  LAUNCH_TEXT_INPUT_CLASSES,
  LaunchSelect,
  SegmentedRadioGroup,
  SwitchControl,
} from './LaunchConfigControls';

const STANDARD_FPS_PRESETS = [30, 40, 60, 90, 120, 144] as const;

export interface CompatGraphicsControlsParams {
  idPrefix: string;
  preview: ResolvedLaunchModePreview;
  effectiveActiveLayer?: CompatibilityLayerInfo;
  crossoverGraphicsBackend: CrossOverGraphicsBackend;
  onChangeCrossoverGraphicsBackend: (backend: CrossOverGraphicsBackend) => void;
  activeBackendPolicy: CrossOverGraphicsBackendPolicyDescriptor;
  crossoverD3DMetalVersion: CrossOverD3DMetalVersion;
  onChangeCrossoverD3DMetalVersion: (version: CrossOverD3DMetalVersion) => void;
  effectiveShowD3DMetalVersionSelector: boolean;
  effectivePrimaryD3DVer: string;
  effectiveFallbackD3DVer: string;
  effectiveDisplayScalingMode: BottleDisplayScalingMode;
  onChangeDisplayScalingMode: (mode: BottleDisplayScalingMode) => void;
  resolvedScalingMode: GlobalBottleDisplayScalingMode;
  globalModeLabel: string;
  effectivePreferredMaxFrameRate?: number;
  onChangePreferredMaxFrameRate: (value: number | undefined) => void;
  effectiveIsDlssSupportedBackend: boolean;
  effectiveDlssUnavailableReason: string;
  crossoverDlss: boolean;
  onToggleCrossoverDlss: () => void;
  spatialEligibility: {
    supported: boolean;
    autoModeNote?: boolean;
    badge?: string;
    reason?: string;
  };
  unavailableSpatialBackendLabel: string;
  effectiveMetalfxSpatialUpscaleFactor?: number;
  onChangeMetalfxSpatialUpscaleFactor: (value: number | undefined) => void;
  effectiveWineSyncMode: WineSyncMode;
  onSelectSyncMode: (mode: WineSyncMode) => void;
  isConfirmed64BitBinary: boolean;
  isLaaNotNeededAndOff: boolean;
  effectiveForceLargeAddressAware: boolean;
  onToggleForceLaa: () => void;
  isCrossOverFamily: boolean;
  winePrefixPath: string;
  winePrefixPlaceholder: string;
  onChangeWinePrefixPath: (value: string) => void;
  onBrowseWinePrefix: () => void;
}

export function renderCompatGraphicsControls({
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
  onChangeDisplayScalingMode,
  resolvedScalingMode,
  globalModeLabel,
  effectivePreferredMaxFrameRate,
  onChangePreferredMaxFrameRate,
  effectiveIsDlssSupportedBackend,
  effectiveDlssUnavailableReason,
  crossoverDlss,
  onToggleCrossoverDlss,
  spatialEligibility,
  unavailableSpatialBackendLabel,
  effectiveMetalfxSpatialUpscaleFactor,
  onChangeMetalfxSpatialUpscaleFactor,
  effectiveWineSyncMode,
  onSelectSyncMode,
  isConfirmed64BitBinary,
  isLaaNotNeededAndOff,
  effectiveForceLargeAddressAware,
  onToggleForceLaa,
  isCrossOverFamily,
  winePrefixPath,
  winePrefixPlaceholder,
  onChangeWinePrefixPath,
  onBrowseWinePrefix,
}: CompatGraphicsControlsParams): React.ReactElement {
  const hasCustomFpsValue =
    typeof effectivePreferredMaxFrameRate === 'number' &&
    Number.isFinite(effectivePreferredMaxFrameRate) &&
    effectivePreferredMaxFrameRate > 0 &&
    !STANDARD_FPS_PRESETS.includes(
      effectivePreferredMaxFrameRate as (typeof STANDARD_FPS_PRESETS)[number]
    );

  const winePrefixInputId = `${idPrefix}-wine-prefix-path`;
  const winePrefixHintId = `${idPrefix}-wine-prefix-hint`;
  const graphicsBackendSelectId = `${idPrefix}-graphics-backend`;
  const graphicsBackendHintId = `${idPrefix}-graphics-backend-hint`;
  const dlssLabelId = `${idPrefix}-dlss-label`;
  const dlssHintId = `${idPrefix}-dlss-hint`;
  const metalfxSpatialSelectId = `${idPrefix}-metalfx-spatial-upscale`;
  const metalfxSpatialHintId = `${idPrefix}-metalfx-spatial-upscale-hint`;
  const preferredMaxFpsSelectId = `${idPrefix}-preferred-max-fps`;
  const preferredMaxFpsHintId = `${idPrefix}-preferred-max-fps-hint`;
  const displayScalingSelectId = `${idPrefix}-display-scaling-mode`;
  const displayScalingHintId = `${idPrefix}-display-scaling-mode-hint`;
  const forceLaaLabelId = `${idPrefix}-force-laa-label`;
  const forceLaaHintId = `${idPrefix}-force-laa-hint`;

  return (
    <>
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

      {/* Per-Game D3DMetal Version Switcher (CrossOver Preview dual D3DMetal) */}
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
                  <span className="text-[10px] text-steam-subtext leading-snug">{item.desc}</span>
                </button>
              );
            })}
          </div>
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
              onChangeDisplayScalingMode(e.target.value as BottleDisplayScalingMode)
            }
          >
            <option value="default">Use Global Default ({globalModeLabel})</option>
            <option value="auto_fullscreen">Auto Fullscreen (Recommended)</option>
            <option value="windowed">Windowed</option>
            {effectiveDisplayScalingMode === 'force_fullscreen' && (
              <option value="force_fullscreen">Force Fullscreen (Advanced)</option>
            )}
            {effectiveDisplayScalingMode === 'virtual_desktop' && (
              <option value="virtual_desktop">Virtual Desktop (Advanced)</option>
            )}
            {effectiveDisplayScalingMode === 'native_driver' && (
              <option value="native_driver">Native Driver (Legacy)</option>
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
                onChangePreferredMaxFrameRate(undefined);
                return;
              }
              const parsed = Math.round(Number(val));
              onChangePreferredMaxFrameRate(
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

      {/* DXMT MetalFX Spatial Upscaling (<select>) — always rendered for zero layout shift */}
      {preview.visibleSections.crossoverRendering && (
        <div className="space-y-1.5">
          <div className="flex flex-wrap items-center gap-2">
            <label
              htmlFor={metalfxSpatialSelectId}
              className="text-[10px] font-bold uppercase tracking-wider text-steam-subtext flex items-center gap-1"
            >
              <Sparkles className="w-3 h-3 text-sky-400 shrink-0" aria-hidden="true" />
              <span>MetalFX Spatial Upscaling (DXMT)</span>
            </label>
            {!spatialEligibility.supported && spatialEligibility.badge && (
              <span
                data-testid="metalfx-spatial-unavailable-badge"
                className="text-[10px] px-1.5 py-0.5 rounded bg-white/5 border border-white/15 text-steam-subtext font-medium"
              >
                {spatialEligibility.badge}
              </span>
            )}
          </div>
          <LaunchSelect
            id={metalfxSpatialSelectId}
            data-testid="metalfx-spatial-upscale-select"
            aria-describedby={metalfxSpatialHintId}
            disabled={!spatialEligibility.supported}
            value={
              spatialEligibility.supported && effectiveMetalfxSpatialUpscaleFactor !== undefined
                ? String(effectiveMetalfxSpatialUpscaleFactor)
                : ''
            }
            onChange={(e) => {
              if (!spatialEligibility.supported) return;
              const val = e.target.value;
              if (val === '') {
                onChangeMetalfxSpatialUpscaleFactor(undefined);
                return;
              }
              const parsed = Number(val);
              onChangeMetalfxSpatialUpscaleFactor(
                Number.isFinite(parsed) && parsed > 1 ? parsed : undefined
              );
            }}
          >
            {spatialEligibility.supported ? (
              <>
                <option value="">Off (Native Resolution)</option>
                <option value="1.33">1.33x (Ultra Quality)</option>
                <option value="1.5">1.5x (Quality)</option>
                <option value="1.7">1.7x (Balanced)</option>
                <option value="2">2.0x (Performance)</option>
              </>
            ) : (
              <option value="">{unavailableSpatialBackendLabel}</option>
            )}
          </LaunchSelect>
          <p
            id={metalfxSpatialHintId}
            data-testid="metalfx-spatial-upscale-hint"
            className="text-[10px] text-steam-subtext leading-snug"
          >
            {spatialEligibility.supported
              ? spatialEligibility.autoModeNote
                ? 'Applies DXMT driver-level MetalFX spatial swapchain upscaling when Auto selects DXMT for DirectX 10/11 games. Select DXMT explicitly if Auto routes a 64-bit game to D3DMetal.'
                : 'Applies DXMT driver-level MetalFX spatial swapchain upscaling for DirectX 10/11 games without built-in DLSS.'
              : spatialEligibility.reason}
          </p>
        </div>
      )}

      {/* Compatibility & Engine Tweaks */}
      <div className="pt-3 border-t border-[#1e2f42] space-y-3.5">
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
          onChange={onSelectSyncMode}
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
            onChange={onToggleForceLaa}
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
      </div>
    </>
  );
}
