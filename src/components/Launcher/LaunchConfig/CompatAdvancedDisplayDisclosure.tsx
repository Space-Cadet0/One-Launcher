import React from 'react';
import { Maximize2, Monitor } from 'lucide-react';
import type {
  BottleDisplayScalingMode,
  DisplayAspectRatioMode,
} from '../../../contracts/launcher';
import { VIRTUAL_DESKTOP_RESOLUTION_OPTIONS } from './launchConfigHelpers';
import { LaunchDisclosure, LaunchSelect, SwitchControl } from './LaunchConfigControls';

export interface CompatAdvancedDisplayDisclosureParams {
  idPrefix: string;
  computedDisplayOverrideCount: number;
  effectiveDisplayAspectRatio: DisplayAspectRatioMode;
  globalAspectLabel: string;
  onChangeDisplayAspectRatio: (value: DisplayAspectRatioMode) => void;
  isAdvancedDisplayModeActive: boolean;
  effectiveDisplayScalingMode: BottleDisplayScalingMode;
  onChangeDisplayScalingMode: (value: BottleDisplayScalingMode) => void;
  showVirtualDesktopResolutionSelect: boolean;
  effectiveVirtualDesktopResolution: string;
  hasCustomVdResValue: boolean;
  onChangeVirtualDesktopResolution: (value: string) => void;
  isLegacy96DpiActive: boolean;
  onToggleLegacy96Dpi: () => void;
  effectiveEmulateModeset: boolean | undefined;
  onChangeEmulateModeset: (value: boolean | undefined) => void;
  emulateModesetHintText: string;
}

export function renderCompatAdvancedDisplayDisclosure({
  idPrefix,
  computedDisplayOverrideCount,
  effectiveDisplayAspectRatio,
  globalAspectLabel,
  onChangeDisplayAspectRatio,
  isAdvancedDisplayModeActive,
  effectiveDisplayScalingMode,
  onChangeDisplayScalingMode,
  showVirtualDesktopResolutionSelect,
  effectiveVirtualDesktopResolution,
  hasCustomVdResValue,
  onChangeVirtualDesktopResolution,
  isLegacy96DpiActive,
  onToggleLegacy96Dpi,
  effectiveEmulateModeset,
  onChangeEmulateModeset,
  emulateModesetHintText,
}: CompatAdvancedDisplayDisclosureParams): React.ReactElement {
  const legacy96DpiLabelId = `${idPrefix}-legacy-96dpi-label`;
  const legacy96DpiHintId = `${idPrefix}-legacy-96dpi-hint`;
  const advancedDisplaySelectId = `${idPrefix}-advanced-display-scaling-mode`;
  const advancedDisplayHintId = `${idPrefix}-advanced-display-scaling-mode-hint`;
  const displayAspectSelectId = `${idPrefix}-display-aspect-ratio`;
  const displayAspectHintId = `${idPrefix}-display-aspect-ratio-hint`;
  const virtualDesktopResSelectId = `${idPrefix}-virtual-desktop-res`;
  const virtualDesktopResHintId = `${idPrefix}-virtual-desktop-res-hint`;
  const emulateModesetSelectId = `${idPrefix}-emulate-modeset`;
  const emulateModesetHintId = `${idPrefix}-emulate-modeset-hint`;

  return (
    <div className="space-y-2.5">
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
                onChangeDisplayAspectRatio(e.target.value as DisplayAspectRatioMode)
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
                onChangeDisplayScalingMode(
                  val === '' ? 'default' : (val as BottleDisplayScalingMode)
                );
              }}
            >
              <option value="">Use Primary Display Mode</option>
              <option value="force_fullscreen">
                Force Fullscreen (Wrap Small &amp; Modern Windows)
              </option>
              <option value="virtual_desktop">Wine Virtual Desktop (Isolated Container)</option>
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
              onChange={(e) => onChangeVirtualDesktopResolution(e.target.value)}
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
            <p id={virtualDesktopResHintId} className="text-[10px] text-steam-subtext leading-snug">
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
              Off by default — Display Scaler v3 handles Retina &amp; HiDPI automatically. Enable
              only if an older game renders oversized UI or clipped menus at 192 DPI.
            </p>
          </div>
          <SwitchControl
            dataTestId="toggle-legacy-96dpi-mode"
            checked={isLegacy96DpiActive}
            ariaLabelledBy={legacy96DpiLabelId}
            ariaDescribedBy={legacy96DpiHintId}
            onChange={onToggleLegacy96Dpi}
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
              onChangeEmulateModeset(val === '' ? undefined : val === 'true');
            }}
          >
            <option value="">Bottle / Auto Default</option>
            <option value="true">Enabled (Emulate Win32 Modeset)</option>
            <option value="false">Disabled</option>
          </LaunchSelect>
          <p id={emulateModesetHintId} className="text-[10px] text-steam-subtext leading-snug">
            {emulateModesetHintText}
          </p>
        </div>
      </LaunchDisclosure>
    </div>
  );
}
