import React from 'react';
import { Cpu, Maximize2, Monitor, Wrench } from 'lucide-react';
import type {
  CompatibilityLayerInfo,
  GlobalBottleDisplayScalingMode,
  GlobalDisplayAspectRatioMode,
  LauncherPerformanceSettings,
} from '../../contracts/launcher';
import {
  LAUNCH_BUTTON_FOCUS_CLASSES,
  SegmentedRadioGroup,
  SwitchControl,
  type SegmentedRadioOption,
} from '../Launcher/LaunchConfig/LaunchConfigControls';

export interface SettingsMacOsBottleSectionProps {
  sectionRef: React.MutableRefObject<HTMLDivElement | null>;
  idPrefix: string;
  draft: LauncherPerformanceSettings;
  installedRunners: readonly CompatibilityLayerInfo[];
  totalBottlesCount: number;
  hotkeyLabelId: string;
  hotkeyHintId: string;
  autoShutdownLabelId: string;
  autoShutdownHintId: string;
  onOpenRunnerSetup: () => void;
  onUpdateDraft: (
    updater: (prev: LauncherPerformanceSettings) => LauncherPerformanceSettings
  ) => void;
}

export const SettingsMacOsBottleSection: React.FC<SettingsMacOsBottleSectionProps> = ({
  sectionRef,
  idPrefix,
  draft,
  installedRunners,
  totalBottlesCount,
  hotkeyLabelId,
  hotkeyHintId,
  autoShutdownLabelId,
  autoShutdownHintId,
  onOpenRunnerSetup,
  onUpdateDraft,
}) => {
  const displayScalingOptions: readonly SegmentedRadioOption<GlobalBottleDisplayScalingMode>[] = [
    {
      value: 'auto_fullscreen',
      label: 'Auto Fullscreen',
      badge: 'Recommended',
      description:
        'Native Retina passthrough for 64-bit games & automatic upscaling for legacy games',
      testId: 'settings-display-auto-fullscreen',
    },
    {
      value: 'windowed',
      label: 'Windowed',
      description: 'Keep bottled Windows games inside a standard movable macOS window',
      testId: 'settings-display-windowed',
    },
    {
      value: 'force_fullscreen',
      label: 'Force Fullscreen',
      description: 'Promote even small fixed-size windowed titles into notch-safe fullscreen',
      testId: 'settings-display-force-fullscreen',
    },
    ...(draft.defaultBottleDisplayScalingMode === 'virtual_desktop'
      ? [
          {
            value: 'virtual_desktop' as const,
            label: 'Wine Virtual Desktop',
            description: 'Isolate games inside a Wine virtual desktop container',
            testId: 'settings-display-virtual-desktop',
          },
        ]
      : []),
    ...(draft.defaultBottleDisplayScalingMode === 'native_driver'
      ? [
          {
            value: 'native_driver' as const,
            label: 'Native Wine Driver',
            description: 'Delegate window sizing directly to the Wine Mac Driver',
            testId: 'settings-display-native-driver',
          },
        ]
      : []),
  ];

  const aspectRatioOptions: readonly SegmentedRadioOption<GlobalDisplayAspectRatioMode>[] = [
    {
      value: 'preserve_aspect',
      label: 'Preserve Aspect Ratio',
      testId: 'settings-aspect-preserve',
    },
    {
      value: 'integer',
      label: 'Integer Scale',
      testId: 'settings-aspect-integer',
    },
    {
      value: 'stretch',
      label: 'Stretch',
      testId: 'settings-aspect-stretch',
    },
  ];

  return (
    <div
      ref={sectionRef}
      data-testid="settings-section-macos-bottle"
      className="rounded-lg bg-[#0e151f] border border-[#223447] p-4 space-y-4"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Cpu className="w-4 h-4 text-amber-400 shrink-0" aria-hidden="true" />
          <h3 className="text-xs font-bold uppercase tracking-wider text-white">
            Windows Games on macOS (Defaults)
          </h3>
        </div>
        <span className="text-[10px] px-2 py-0.5 rounded bg-sky-500/15 border border-sky-500/30 text-sky-300 font-semibold">
          Applied to Bottled Games
        </span>
      </div>

      {/* Compact Runners & Bottles Summary Card */}
      <div
        data-testid="settings-runners-summary-card"
        className="flex flex-wrap items-center justify-between gap-3 rounded-lg bg-[#141d2b] border border-[#26384d] px-3 py-2.5"
      >
        <div className="min-w-0 space-y-0.5">
          <div className="text-xs font-semibold text-white">
            Compatibility Runners &amp; Bottles
          </div>
          <p className="text-[10px] text-steam-subtext leading-snug">
            {installedRunners.length > 0
              ? `${installedRunners.map((r) => (r.version ? `${r.name} v${r.version}` : r.name)).join(' · ')}${totalBottlesCount > 0 ? ` (${totalBottlesCount} ${totalBottlesCount === 1 ? 'bottle' : 'bottles'})` : ''}`
              : 'No Windows compatibility runners detected yet.'}
          </p>
        </div>
        <button
          type="button"
          data-testid="settings-manage-runners-btn"
          onClick={onOpenRunnerSetup}
          className={`min-h-[28px] inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-sky-500/15 hover:bg-sky-500/25 border border-sky-400/40 text-xs font-semibold text-sky-200 hover:text-white transition-colors cursor-pointer shrink-0 ${LAUNCH_BUTTON_FOCUS_CLASSES}`}
        >
          <Wrench className="w-3.5 h-3.5" aria-hidden="true" />
          <span>Manage Runners &amp; Bottles…</span>
        </button>
      </div>

      <SegmentedRadioGroup
        name={`${idPrefix}-default-display-mode`}
        legend={
          <>
            <Maximize2 className="w-3 h-3 text-sky-400 shrink-0" aria-hidden="true" />
            <span>Default Bottle Display Mode</span>
          </>
        }
        value={draft.defaultBottleDisplayScalingMode ?? 'auto_fullscreen'}
        options={displayScalingOptions}
        onChange={(val) =>
          onUpdateDraft((prev) => ({ ...prev, defaultBottleDisplayScalingMode: val }))
        }
        columns={displayScalingOptions.length >= 4 ? 2 : 3}
        variant="cards"
        testId="settings-default-display-mode"
      />

      <SegmentedRadioGroup
        name={`${idPrefix}-default-aspect-ratio`}
        legend={
          <>
            <Monitor className="w-3 h-3 text-sky-400 shrink-0" aria-hidden="true" />
            <span>Default Legacy Aspect Ratio</span>
          </>
        }
        value={draft.defaultDisplayAspectRatio ?? 'preserve_aspect'}
        options={aspectRatioOptions}
        onChange={(val) => onUpdateDraft((prev) => ({ ...prev, defaultDisplayAspectRatio: val }))}
        variant="pills"
        testId="settings-default-aspect-ratio"
      />

      <div className="space-y-2.5 pt-1 border-t border-[#223447]/80">
        <div className="flex items-center justify-between gap-3 rounded-lg bg-[#141d2b] border border-[#26384d] px-3 py-2.5">
          <div className="min-w-0 space-y-0.5">
            <span id={hotkeyLabelId} className="block text-xs font-semibold text-white">
              In-Game Fullscreen &amp; Aspect Hotkeys (Ctrl+Option+F / Ctrl+Option+A)
            </span>
            <p id={hotkeyHintId} className="text-[10px] text-steam-subtext leading-snug">
              Enables <kbd className="font-mono text-sky-300">Ctrl+Option+F</kbd> (Fullscreen) and{' '}
              <kbd className="font-mono text-sky-300">Ctrl+Option+A</kbd> (Aspect Ratio) inside
              display-scaled legacy Windows games.
            </p>
          </div>
          <SwitchControl
            dataTestId="settings-toggle-fullscreen-hotkey"
            checked={draft.enableFullscreenHotkey ?? true}
            ariaLabelledBy={hotkeyLabelId}
            ariaDescribedBy={hotkeyHintId}
            onChange={() =>
              onUpdateDraft((prev) => ({
                ...prev,
                enableFullscreenHotkey: !(prev.enableFullscreenHotkey ?? true),
              }))
            }
            tone="emerald"
          />
        </div>

        <div className="flex items-center justify-between gap-3 rounded-lg bg-[#141d2b] border border-[#26384d] px-3 py-2.5">
          <div className="min-w-0 space-y-0.5">
            <span id={autoShutdownLabelId} className="block text-xs font-semibold text-white">
              Close Idle Bottle Background Daemons After Exit
            </span>
            <p id={autoShutdownHintId} className="text-[10px] text-steam-subtext leading-snug">
              Waits for Cloud Save uploads and active Bottle downloads to finish, then terminates
              leftover wineserver / winedevice processes.
            </p>
          </div>
          <SwitchControl
            dataTestId="settings-toggle-auto-shutdown-wine"
            checked={draft.autoShutdownWinePrefixOnExit}
            ariaLabelledBy={autoShutdownLabelId}
            ariaDescribedBy={autoShutdownHintId}
            onChange={() =>
              onUpdateDraft((prev) => ({
                ...prev,
                autoShutdownWinePrefixOnExit: !prev.autoShutdownWinePrefixOnExit,
              }))
            }
            tone="emerald"
          />
        </div>
      </div>
    </div>
  );
};
