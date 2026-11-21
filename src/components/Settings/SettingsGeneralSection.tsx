import React from 'react';
import { Activity, Gauge } from 'lucide-react';
import type {
  InGameLauncherBehavior,
  LauncherPerformanceSettings,
  PostGameLauncherBehavior,
  StorefrontClientLifecyclePolicy,
} from '../../contracts/launcher';
import type { HostPlatformCapabilities } from '../../contracts/hostPlatform';
import {
  SegmentedRadioGroup,
  SwitchControl,
  type SegmentedRadioOption,
} from '../Launcher/LaunchConfig/LaunchConfigControls';

export interface SettingsGeneralSectionProps {
  idPrefix: string;
  draft: LauncherPerformanceSettings;
  hostCapabilities: HostPlatformCapabilities;
  defaultHudLabelId: string;
  defaultHudHintId: string;
  pauseSyncLabelId: string;
  pauseSyncHintId: string;
  pauseDownloadsLabelId: string;
  pauseDownloadsHintId: string;
  onUpdateDraft: (
    updater: (prev: LauncherPerformanceSettings) => LauncherPerformanceSettings
  ) => void;
}

export const SettingsGeneralSection: React.FC<SettingsGeneralSectionProps> = ({
  idPrefix,
  draft,
  hostCapabilities,
  defaultHudLabelId,
  defaultHudHintId,
  pauseSyncLabelId,
  pauseSyncHintId,
  pauseDownloadsLabelId,
  pauseDownloadsHintId,
  onUpdateDraft,
}) => {
  const inGameBehaviorOptions: readonly SegmentedRadioOption<InGameLauncherBehavior>[] = [
    {
      value: 'hide_tray_hibernate',
      label: 'Hibernate',
      badge: 'Recommended',
      description: hostCapabilities.isMac
        ? 'Hide to menu bar & pause UI GPU rendering'
        : 'Hide to system tray & pause UI GPU rendering',
      testId: 'settings-ingame-hibernate',
    },
    {
      value: 'minimize_taskbar',
      label: 'Minimize',
      description: hostCapabilities.isMac
        ? 'Minimize One Launcher to the Dock'
        : 'Minimize One Launcher to the taskbar',
      testId: 'settings-ingame-minimize',
    },
    {
      value: 'keep_open',
      label: 'Keep Open',
      description: 'Keep the One Launcher window open behind the game',
      testId: 'settings-ingame-keep-open',
    },
    ...(draft.inGameLauncherBehavior === 'zero_renderer_daemon'
      ? [
          {
            value: 'zero_renderer_daemon' as const,
            label: 'Zero-Renderer',
            description: 'Unload renderer window while playing (~45 MB RAM)',
            testId: 'settings-ingame-zero-renderer',
          },
        ]
      : []),
  ];

  const postGameOptions: readonly SegmentedRadioOption<PostGameLauncherBehavior>[] = [
    {
      value: 'restore_window',
      label: 'Restore Window',
      testId: 'settings-postgame-restore',
    },
    {
      value: 'stay_minimized',
      label: 'Keep Hidden',
      testId: 'settings-postgame-hidden',
    },
    {
      value: 'exit_launcher',
      label: 'Quit Launcher',
      testId: 'settings-postgame-quit',
    },
  ];

  const storefrontLifecycleOptions: readonly SegmentedRadioOption<StorefrontClientLifecyclePolicy>[] =
    [
      {
        value: 'minimal_and_close_if_started',
        label: 'Silent & Auto-Close',
        badge: 'Recommended',
        description: 'Minimal client for cloud saves & achievements, then closes after exit',
        testId: 'settings-lifecycle-minimal-close',
      },
      {
        value: 'minimal_keep_running',
        label: 'Minimal & Keep Warm',
        description: 'Runs silently and stays ready in background for faster next launch',
        testId: 'settings-lifecycle-minimal-keep',
      },
      {
        value: 'default_client',
        label: 'Standard Client',
        description: 'Uses the storefront desktop client with its full UI and overlays',
        testId: 'settings-lifecycle-default-client',
      },
      ...(draft.storefrontClientLifecycle === 'fast_direct_bypass'
        ? [
            {
              value: 'fast_direct_bypass' as const,
              label: 'Fast Direct Bypass',
              description: 'Skips launching storefront clients when possible',
              testId: 'settings-lifecycle-fast-bypass',
            },
          ]
        : []),
    ];

  return (
    <div
      data-testid="settings-section-general"
      className="rounded-lg bg-[#0e151f] border border-[#223447] p-4 space-y-4"
    >
      <div className="flex items-center gap-2">
        <Activity className="w-4 h-4 text-emerald-400 shrink-0" aria-hidden="true" />
        <h3 className="text-xs font-bold uppercase tracking-wider text-white">
          General &amp; Gameplay Footprint
        </h3>
      </div>

      <SegmentedRadioGroup
        name={`${idPrefix}-ingame-behavior`}
        legend="While Playing (In-Game Behavior)"
        value={draft.inGameLauncherBehavior}
        options={inGameBehaviorOptions}
        onChange={(val) => onUpdateDraft((prev) => ({ ...prev, inGameLauncherBehavior: val }))}
        columns={inGameBehaviorOptions.length === 4 ? 2 : 3}
        variant="cards"
        testId="settings-ingame-behavior-group"
      />

      <SegmentedRadioGroup
        name={`${idPrefix}-postgame-behavior`}
        legend="After Game Exits"
        value={draft.postGameLauncherBehavior}
        options={postGameOptions}
        onChange={(val) => onUpdateDraft((prev) => ({ ...prev, postGameLauncherBehavior: val }))}
        variant="pills"
        testId="settings-postgame-behavior-group"
      />

      <SegmentedRadioGroup
        name={`${idPrefix}-storefront-lifecycle`}
        legend="Default Storefront Client Lifecycle"
        value={draft.storefrontClientLifecycle}
        options={storefrontLifecycleOptions}
        onChange={(val) => onUpdateDraft((prev) => ({ ...prev, storefrontClientLifecycle: val }))}
        columns={storefrontLifecycleOptions.length === 4 ? 2 : 3}
        variant="cards"
        testId="settings-storefront-lifecycle-group"
      />

      <div className="space-y-2.5 pt-1 border-t border-[#223447]/80">
        <div className="flex items-center justify-between gap-3 rounded-lg bg-[#141d2b] border border-[#26384d] px-3 py-2.5">
          <div className="min-w-0 space-y-0.5">
            <span
              id={defaultHudLabelId}
              className="flex items-center gap-1.5 text-xs font-semibold text-white"
            >
              <Gauge className="w-3.5 h-3.5 text-sky-400 shrink-0" aria-hidden="true" />
              <span>
                {hostCapabilities.supportsMetalHud
                  ? 'Performance HUD Overlay'
                  : 'DXVK Performance HUD'}
              </span>
            </span>
            <p id={defaultHudHintId} className="text-[10px] text-steam-subtext leading-snug">
              {hostCapabilities.supportsMetalHud
                ? 'Shows FPS & GPU frametime overlay (Apple Metal HUD with automatic DXVK fallback)'
                : 'Shows FPS & frametime overlay on Vulkan / DXVK-wrapped games'}
            </p>
          </div>
          <SwitchControl
            dataTestId="settings-toggle-default-performance-hud"
            checked={Boolean(draft.defaultPerformanceHud)}
            ariaLabelledBy={defaultHudLabelId}
            ariaDescribedBy={defaultHudHintId}
            onChange={() =>
              onUpdateDraft((prev) => ({
                ...prev,
                defaultPerformanceHud: !prev.defaultPerformanceHud,
              }))
            }
            tone="sky"
          />
        </div>

        <div className="flex items-center justify-between gap-3 rounded-lg bg-[#141d2b] border border-[#26384d] px-3 py-2.5">
          <div className="min-w-0 space-y-0.5">
            <span id={pauseSyncLabelId} className="block text-xs font-semibold text-white">
              Pause Background Store Artwork &amp; Review Scans While Playing
            </span>
            <p id={pauseSyncHintId} className="text-[10px] text-steam-subtext leading-snug">
              Suspends library metadata and critic crawlers during gameplay (Cloud Saves are
              unaffected).
            </p>
          </div>
          <SwitchControl
            dataTestId="settings-toggle-pause-sync"
            checked={draft.pauseBackgroundSyncInGame}
            ariaLabelledBy={pauseSyncLabelId}
            ariaDescribedBy={pauseSyncHintId}
            onChange={() =>
              onUpdateDraft((prev) => ({
                ...prev,
                pauseBackgroundSyncInGame: !prev.pauseBackgroundSyncInGame,
              }))
            }
            tone="emerald"
          />
        </div>

        <div className="flex items-center justify-between gap-3 rounded-lg bg-[#141d2b] border border-[#26384d] px-3 py-2.5">
          <div className="min-w-0 space-y-0.5">
            <span id={pauseDownloadsLabelId} className="block text-xs font-semibold text-white">
              Pause Active Game Downloads While Playing
            </span>
            <p id={pauseDownloadsHintId} className="text-[10px] text-steam-subtext leading-snug">
              Frees network bandwidth and disk I/O during gameplay, then resumes on exit.
            </p>
          </div>
          <SwitchControl
            dataTestId="settings-toggle-pause-downloads"
            checked={draft.pauseDownloadsInGame}
            ariaLabelledBy={pauseDownloadsLabelId}
            ariaDescribedBy={pauseDownloadsHintId}
            onChange={() =>
              onUpdateDraft((prev) => ({
                ...prev,
                pauseDownloadsInGame: !prev.pauseDownloadsInGame,
              }))
            }
            tone="emerald"
          />
        </div>
      </div>
    </div>
  );
};
