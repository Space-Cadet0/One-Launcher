import React from 'react';
import { StorefrontId } from '../../../contracts/platform';
import {
  GlobalBottleDisplayScalingMode,
  GlobalDisplayAspectRatioMode,
  InGameLauncherBehavior,
  LauncherPerformanceSettings,
  LaunchMethod,
  PostGameLauncherBehavior,
  ResolvedLaunchModePreview,
  StorefrontClientLifecyclePolicy,
  StorefrontLaunchPolicyView,
} from '../../../contracts/launcher';
import { launcherService } from '../../../services/launcher/launcherService';
import {
  Activity,
  AlertTriangle,
  CheckCircle2,
  ExternalLink,
  Globe,
  Info,
  Maximize2,
  Monitor,
  Zap,
} from 'lucide-react';
import {
  computeInGameFootprintBadge,
  formatGlobalInGameBehaviorDefaultLabel,
  getBadgeToneClasses,
  resolveEffectiveUiStorefrontLifecycle,
} from './launchConfigHelpers';
import { LaunchSelect, SwitchControl } from './LaunchConfigControls';

export interface StorefrontLifecycleSectionProps {
  idPrefix?: string;
  isWindowsHost: boolean;
  preview: ResolvedLaunchModePreview;
  activeDisplayMethod: LaunchMethod;
  preferredPlatformId: StorefrontId;
  inGameLauncherBehavior: 'default' | InGameLauncherBehavior;
  onChangeInGameLauncherBehavior: (value: 'default' | InGameLauncherBehavior) => void;
  storefrontClientLifecycle: 'default' | StorefrontClientLifecyclePolicy;
  onChangeStorefrontClientLifecycle: (value: StorefrontClientLifecyclePolicy) => void;
  policyView?: StorefrontLaunchPolicyView;
  perfSettings: LauncherPerformanceSettings;
  onChangePostGameBehavior: (value: PostGameLauncherBehavior) => void;
  onTogglePauseSyncInGame: () => void;
  onTogglePauseDownloadsInGame: () => void;
  onToggleAutoShutdownWine: () => void;
  onChangeDefaultBottleDisplayScalingMode?: (value: GlobalBottleDisplayScalingMode) => void;
  onChangeDefaultDisplayAspectRatio?: (value: GlobalDisplayAspectRatioMode) => void;
  onToggleFullscreenHotkey?: () => void;
}

const NOOP = () => {};

function StorefrontLifecycleSectionImpl({
  idPrefix = 'launch-cfg',
  isWindowsHost,
  preview,
  activeDisplayMethod,
  preferredPlatformId,
  inGameLauncherBehavior,
  onChangeInGameLauncherBehavior,
  storefrontClientLifecycle,
  onChangeStorefrontClientLifecycle,
  policyView,
  perfSettings,
  onChangePostGameBehavior,
  onTogglePauseSyncInGame,
  onTogglePauseDownloadsInGame,
  onToggleAutoShutdownWine,
  onChangeDefaultBottleDisplayScalingMode = NOOP,
  onChangeDefaultDisplayAspectRatio = NOOP,
  onToggleFullscreenHotkey = NOOP,
}: StorefrontLifecycleSectionProps): React.ReactElement {
  const isBottleContext =
    !isWindowsHost &&
    (preview.detectedBuildType === 'windows_exe_on_mac' ||
      activeDisplayMethod === 'compatibility_layer' ||
      preview.visibleSections.compatibilityLayer);

  const showStorefrontSection = preferredPlatformId !== 'custom';

  const effectiveInGameBehavior: InGameLauncherBehavior =
    inGameLauncherBehavior === 'default'
      ? perfSettings.inGameLauncherBehavior
      : inGameLauncherBehavior;
  const showStayMinimizedPostExitOption =
    effectiveInGameBehavior !== 'keep_open' ||
    perfSettings.postGameLauncherBehavior === 'stay_minimized';

  const effectiveLifecycle: StorefrontClientLifecyclePolicy =
    resolveEffectiveUiStorefrontLifecycle({
      preferredPlatformId,
      isBottleContext,
      storefrontClientLifecycle,
      fallbackGlobalLifecycle: perfSettings.storefrontClientLifecycle,
    });

  const resolvedPolicyView: StorefrontLaunchPolicyView =
    policyView ||
    launcherService.getStorefrontLaunchPolicyView({
      platformId: preferredPlatformId,
      detectedBuildType: preview.detectedBuildType,
      activeDisplayMethod,
      effectiveLifecycle,
      isInstalled: preview.isInstalled,
      hostPlatform: isWindowsHost ? 'win32' : preview.hostPlatform || 'darwin',
    });

  const { infoBox } = resolvedPolicyView;

  const footprintBadge = computeInGameFootprintBadge({
    preferredPlatformId,
    activeDisplayMethod,
    inGameLauncherBehavior,
    storefrontClientLifecycle,
    perfSettings,
    isBottleContext,
  });

  const policyBadgeClasses =
    infoBox.severity === 'warning'
      ? 'bg-orange-500/20 text-orange-200 border-orange-500/45'
      : infoBox.severity === 'optimal'
        ? 'bg-emerald-500/20 text-emerald-300 border-emerald-500/40'
        : 'bg-sky-500/20 text-sky-300 border-sky-500/40';

  const infoBoxContainerClasses =
    infoBox.severity === 'warning'
      ? 'bg-orange-950/45 border-orange-500/50 text-orange-100'
      : infoBox.severity === 'optimal'
        ? 'bg-emerald-950/30 border-emerald-500/35 text-emerald-100'
        : 'bg-sky-950/30 border-sky-500/35 text-sky-100';

  const infoBoxHeadlineClasses =
    infoBox.severity === 'warning'
      ? 'text-orange-300'
      : infoBox.severity === 'optimal'
        ? 'text-emerald-300'
        : 'text-sky-300';

  const infoBoxSummaryClasses =
    infoBox.severity === 'warning'
      ? 'text-orange-100/90'
      : infoBox.severity === 'optimal'
        ? 'text-emerald-100/85'
        : 'text-sky-100/85';

  const innerCompatTestId =
    infoBox.policyKey === 'protocol_delegated'
      ? 'storefront-delegated-lifecycle-note'
      : infoBox.policyKey === 'clientless_epic' || infoBox.policyKey === 'clientless_bottle_gog'
        ? 'storefront-clientless-native-note'
        : infoBox.policyKey === 'fast_direct_bypass'
          ? 'fast-minimal-launch-warning'
          : undefined;

  const pauseSyncLabelId = `${idPrefix}-pause-sync-label`;
  const pauseSyncHintId = `${idPrefix}-pause-sync-hint`;
  const pauseDownloadsLabelId = `${idPrefix}-pause-downloads-label`;
  const pauseDownloadsHintId = `${idPrefix}-pause-downloads-hint`;
  const autoShutdownWineLabelId = `${idPrefix}-auto-shutdown-wine-label`;
  const autoShutdownWineHintId = `${idPrefix}-auto-shutdown-wine-hint`;
  const globalDisplayModeSelectId = `${idPrefix}-global-bottle-display-mode`;
  const globalDisplayModeHintId = `${idPrefix}-global-bottle-display-mode-hint`;
  const globalDisplayAspectSelectId = `${idPrefix}-global-display-aspect`;
  const globalDisplayAspectHintId = `${idPrefix}-global-display-aspect-hint`;
  const fullscreenHotkeyLabelId = `${idPrefix}-fullscreen-hotkey-label`;
  const fullscreenHotkeyHintId = `${idPrefix}-fullscreen-hotkey-hint`;

  const effectiveGlobalDisplayMode: GlobalBottleDisplayScalingMode =
    perfSettings.defaultBottleDisplayScalingMode ?? 'auto_fullscreen';
  const effectiveGlobalAspectRatio: GlobalDisplayAspectRatioMode =
    perfSettings.defaultDisplayAspectRatio ?? 'preserve_aspect';
  const effectiveFullscreenHotkey: boolean = perfSettings.enableFullscreenHotkey ?? true;

  return (
    <section
      data-section="in-game-performance"
      data-testid="in-game-performance-section"
      aria-label="In-Game Footprint & Performance"
      className="rounded-lg bg-[#0e151f] border border-[#223447] p-3.5 space-y-3.5"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Activity className="w-4 h-4 text-emerald-400 shrink-0" aria-hidden="true" />
          <h3 className="text-xs font-bold text-white uppercase tracking-wider">
            In-Game Footprint &amp; Performance
          </h3>
        </div>
        <span
          data-testid="in-game-footprint-mode-badge"
          className={`text-[10px] px-2 py-0.5 rounded border font-semibold ${getBadgeToneClasses(
            footprintBadge.tone
          )}`}
        >
          {footprintBadge.label}
        </span>
      </div>

      {/* Per-Game One Launcher Window Footprint */}
      <div className="space-y-1.5">
        <div className="flex flex-wrap items-center justify-between gap-1">
          <label
            htmlFor="in-game-launcher-behavior-select"
            className="text-[10px] font-bold uppercase tracking-wider text-steam-subtext"
          >
            One Launcher During Gameplay
          </label>
          <span className="text-[10px] px-1.5 py-0.5 rounded bg-sky-500/15 border border-sky-500/30 text-sky-300 font-semibold">
            Per-Game Profile
          </span>
        </div>
        <LaunchSelect
          id="in-game-launcher-behavior-select"
          aria-label="In-Game Launcher Behavior"
          data-testid="in-game-launcher-behavior-select"
          value={inGameLauncherBehavior}
          onChange={(e) => {
            const val = e.target.value as 'default' | InGameLauncherBehavior;
            onChangeInGameLauncherBehavior(val);
          }}
        >
          <option value="default">
            {formatGlobalInGameBehaviorDefaultLabel(perfSettings.inGameLauncherBehavior)}
          </option>
          <option value="hide_tray_hibernate">
            {isWindowsHost
              ? 'Hide to System Tray & Hibernate UI (Recommended — 0% GPU)'
              : 'Hide to Menu Bar & Hibernate UI (Recommended — 0% GPU)'}
          </option>
          <option value="zero_renderer_daemon">
            Zero-Renderer Background Mode (Lowest RAM ~45 MB)
          </option>
          <option value="minimize_taskbar">
            {isWindowsHost ? 'Minimize Window to Taskbar' : 'Minimize Window to Dock'}
          </option>
          <option value="keep_open">Keep One Launcher Window Open</option>
        </LaunchSelect>
      </div>

      {/* Unified Dynamic Storefront Launch Policy Card (filtered out for non-storefront custom games) */}
      {showStorefrontSection && (
        <div
          data-testid="storefront-launch-policy-card"
          className="rounded-lg bg-[#121a27] border border-[#24364b] p-3.5 space-y-3"
        >
          {/* Card Header Row */}
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-1.5">
              {infoBox.policyKey === 'protocol_delegated' ? (
                <ExternalLink className="w-3.5 h-3.5 text-sky-400 shrink-0" aria-hidden="true" />
              ) : (
                <Zap
                  aria-hidden="true"
                  className={`w-3.5 h-3.5 shrink-0 ${
                    infoBox.severity === 'warning'
                      ? 'text-orange-400'
                      : infoBox.severity === 'optimal'
                        ? 'text-emerald-400'
                        : 'text-sky-400'
                  }`}
                />
              )}
              <span
                data-testid="storefront-launch-policy-heading"
                className="text-xs font-bold text-white"
              >
                {resolvedPolicyView.cardHeading}
              </span>
            </div>
            <span
              className={`text-[10px] px-2 py-0.5 rounded border font-semibold ${policyBadgeClasses}`}
            >
              {infoBox.badgeLabel}
            </span>
          </div>

          {/* Structured Policy Info Box (rendered above dropdown for every option) */}
          <div
            data-testid="storefront-policy-info-box"
            data-policy-key={infoBox.policyKey}
            data-policy-severity={infoBox.severity}
            data-section={
              infoBox.policyKey === 'protocol_delegated'
                ? 'storefront-delegated-lifecycle-note'
                : undefined
            }
            className={`rounded-lg border p-3 text-xs ${infoBoxContainerClasses}`}
          >
            <div data-testid={innerCompatTestId} className="space-y-2">
              <div className="space-y-1">
                <div className="flex items-start gap-2">
                  {infoBox.severity === 'warning' ? (
                    <AlertTriangle
                      className="w-4 h-4 text-orange-400 shrink-0 mt-0.5"
                      aria-hidden="true"
                    />
                  ) : infoBox.severity === 'optimal' ? (
                    <CheckCircle2
                      className="w-4 h-4 text-emerald-400 shrink-0 mt-0.5"
                      aria-hidden="true"
                    />
                  ) : (
                    <Info className="w-4 h-4 text-sky-400 shrink-0 mt-0.5" aria-hidden="true" />
                  )}
                  <span className={`font-bold leading-snug ${infoBoxHeadlineClasses}`}>
                    {infoBox.headline}
                  </span>
                </div>
                <p className={`text-[11px] leading-relaxed ${infoBoxSummaryClasses}`}>
                  {infoBox.footprintSummary}
                </p>
              </div>

              {infoBox.includedFeatures.length > 0 && (
                <div className="space-y-1 pt-0.5">
                  <div
                    className={`text-[10px] font-bold uppercase tracking-wider ${
                      infoBox.severity === 'warning'
                        ? 'text-emerald-300/95'
                        : infoBox.severity === 'optimal'
                          ? 'text-emerald-300'
                          : 'text-sky-300'
                    }`}
                  >
                    Includes
                  </div>
                  <ul className="space-y-1">
                    {infoBox.includedFeatures.map((item, idx) => (
                      <li
                        key={idx}
                        className="flex items-start gap-1.5 text-[11px] leading-snug"
                      >
                        <span
                          aria-hidden="true"
                          className={`font-bold shrink-0 ${
                            infoBox.severity === 'info' ? 'text-sky-400' : 'text-emerald-400'
                          }`}
                        >
                          ✓
                        </span>
                        <span>{item}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {infoBox.excludedOrTradeoffs.length > 0 && (
                <div
                  className={`space-y-1 pt-2 border-t ${
                    infoBox.severity === 'warning'
                      ? 'border-orange-500/35'
                      : infoBox.severity === 'optimal'
                        ? 'border-emerald-500/20'
                        : 'border-sky-500/20'
                  }`}
                >
                  <div
                    className={`text-[10px] font-bold uppercase tracking-wider ${
                      infoBox.severity === 'warning'
                        ? 'text-orange-300'
                        : infoBox.severity === 'optimal'
                          ? 'text-emerald-200/80'
                          : 'text-sky-200/80'
                    }`}
                  >
                    {infoBox.severity === 'warning'
                      ? 'Does Not Include / Disabled'
                      : 'Trade-offs'}
                  </div>
                  <ul className="space-y-1">
                    {infoBox.excludedOrTradeoffs.map((item, idx) => (
                      <li
                        key={idx}
                        className={`flex items-start gap-1.5 text-[11px] leading-snug ${
                          infoBox.severity === 'warning'
                            ? 'text-orange-200/95 font-medium'
                            : infoBox.severity === 'optimal'
                              ? 'text-emerald-100/80'
                              : 'text-sky-100/80'
                        }`}
                      >
                        <span
                          aria-hidden="true"
                          className={`font-bold shrink-0 ${
                            infoBox.severity === 'warning' ? 'text-orange-400' : 'opacity-80'
                          }`}
                        >
                          {infoBox.severity === 'warning' ? '✕' : '•'}
                        </span>
                        <span>{item}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          </div>

          {/* Policy Dropdown (below Info Box) */}
          {resolvedPolicyView.showDropdown && (
            <div className="space-y-1.5">
              <label
                htmlFor="storefront-client-lifecycle-select"
                className="block text-[10px] font-bold uppercase tracking-wider text-steam-subtext"
              >
                {resolvedPolicyView.cardHeading} Mode
              </label>
              <LaunchSelect
                id="storefront-client-lifecycle-select"
                aria-label={resolvedPolicyView.cardHeading}
                data-testid="storefront-client-lifecycle-select"
                value={resolvedPolicyView.selectedDropdownValue}
                onChange={(e) =>
                  onChangeStorefrontClientLifecycle(
                    e.target.value as StorefrontClientLifecyclePolicy
                  )
                }
              >
                {resolvedPolicyView.dropdownOptions.map((opt) => (
                  <option key={opt.value} value={opt.value}>
                    {opt.label}
                  </option>
                ))}
              </LaunchSelect>
            </div>
          )}
        </div>
      )}

      {/* Global Gameplay Performance Defaults Sub-Card (distinctly badged as global scope) */}
      <div
        data-testid="global-gameplay-performance-card"
        className="rounded-lg bg-[#121a27] border border-[#24364b] p-3.5 space-y-3"
      >
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-1.5">
            <Globe className="w-3.5 h-3.5 text-amber-400 shrink-0" aria-hidden="true" />
            <h4 className="text-[11px] font-bold uppercase tracking-wider text-white">
              Global Gameplay Performance Defaults
            </h4>
          </div>
          <span
            data-testid="global-performance-scope-badge"
            className="text-[10px] px-2 py-0.5 rounded bg-amber-500/15 border border-amber-500/35 text-amber-300 font-semibold"
          >
            Applies to all games
          </span>
        </div>

        <div className="space-y-1.5">
          <label
            htmlFor="post-game-launcher-behavior-select"
            className="block text-[10px] font-bold uppercase tracking-wider text-steam-subtext"
          >
            When Game Exits
          </label>
          <LaunchSelect
            id="post-game-launcher-behavior-select"
            aria-label="When Game Exits"
            data-testid="post-game-launcher-behavior-select"
            surface="panel"
            value={perfSettings.postGameLauncherBehavior}
            onChange={(e) =>
              onChangePostGameBehavior(e.target.value as PostGameLauncherBehavior)
            }
          >
            <option value="restore_window">
              {effectiveInGameBehavior === 'keep_open'
                ? 'Keep One Launcher Window Open'
                : 'Restore One Launcher Window'}
            </option>
            {showStayMinimizedPostExitOption && (
              <option value="stay_minimized">
                {isWindowsHost ? 'Keep Hidden in System Tray' : 'Keep Hidden in Menu Bar'}
              </option>
            )}
            <option value="exit_launcher">Quit One Launcher Automatically</option>
          </LaunchSelect>
        </div>

        <div className="space-y-2 pt-0.5">
          <div className="flex items-center justify-between gap-3 rounded-lg bg-[#0e151f] border border-[#223447] px-3 py-2.5">
            <div className="min-w-0 space-y-0.5">
              <span id={pauseSyncLabelId} className="block text-xs font-semibold text-white">
                Pause Background Store Artwork &amp; Review Scans While Playing
              </span>
              <p id={pauseSyncHintId} className="text-[10px] text-steam-subtext leading-snug">
                Suspends library metadata and critic score crawlers during gameplay (game Cloud
                Saves are unaffected)
              </p>
            </div>
            <SwitchControl
              dataTestId="toggle-pause-sync-in-game"
              checked={perfSettings.pauseBackgroundSyncInGame}
              ariaLabelledBy={pauseSyncLabelId}
              ariaDescribedBy={pauseSyncHintId}
              onChange={onTogglePauseSyncInGame}
              tone="emerald"
            />
          </div>

          <div className="flex items-center justify-between gap-3 rounded-lg bg-[#0e151f] border border-[#223447] px-3 py-2.5">
            <div className="min-w-0 space-y-0.5">
              <span id={pauseDownloadsLabelId} className="block text-xs font-semibold text-white">
                Pause Active Game Downloads While Playing
              </span>
              <p id={pauseDownloadsHintId} className="text-[10px] text-steam-subtext leading-snug">
                Pauses One Launcher downloads to free bandwidth and disk I/O during gameplay, then
                resumes on exit
              </p>
            </div>
            <SwitchControl
              dataTestId="toggle-pause-downloads-in-game"
              checked={perfSettings.pauseDownloadsInGame}
              ariaLabelledBy={pauseDownloadsLabelId}
              ariaDescribedBy={pauseDownloadsHintId}
              onChange={onTogglePauseDownloadsInGame}
              tone="emerald"
            />
          </div>

          {isBottleContext && (
            <>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5 pt-0.5">
                <div className="rounded-lg bg-[#0e151f] border border-[#223447] p-2.5 ol-subgrid-field">
                  <label
                    htmlFor={globalDisplayModeSelectId}
                    className="text-[10px] font-bold uppercase tracking-wider text-steam-subtext flex items-center gap-1 self-end"
                  >
                    <Maximize2 className="w-3 h-3 text-sky-400 shrink-0" aria-hidden="true" />
                    <span>Default Bottled Display Mode</span>
                  </label>
                  <LaunchSelect
                    id={globalDisplayModeSelectId}
                    data-testid="global-bottle-display-mode-select"
                    surface="panel"
                    aria-label="Default Bottled Display Mode"
                    aria-describedby={globalDisplayModeHintId}
                    value={effectiveGlobalDisplayMode}
                    onChange={(e) =>
                      onChangeDefaultBottleDisplayScalingMode(
                        e.target.value as GlobalBottleDisplayScalingMode
                      )
                    }
                  >
                    <option value="auto_fullscreen">
                      Auto Fullscreen &amp; Upscale (Recommended)
                    </option>
                    <option value="force_fullscreen">
                      Force Fullscreen (All Bottled Windows)
                    </option>
                    <option value="native_driver">Native Wine Driver</option>
                    <option value="windowed">Windowed</option>
                    <option value="virtual_desktop">Wine Virtual Desktop</option>
                  </LaunchSelect>
                  <p
                    id={globalDisplayModeHintId}
                    className="text-[10px] text-steam-subtext leading-snug"
                  >
                    Global fallback for bottled Windows games set to Use Global Default.
                  </p>
                </div>

                <div className="rounded-lg bg-[#0e151f] border border-[#223447] p-2.5 ol-subgrid-field">
                  <label
                    htmlFor={globalDisplayAspectSelectId}
                    className="text-[10px] font-bold uppercase tracking-wider text-steam-subtext flex items-center gap-1 self-end"
                  >
                    <Monitor className="w-3 h-3 text-sky-400 shrink-0" aria-hidden="true" />
                    <span>Default Fullscreen Aspect Ratio</span>
                  </label>
                  <LaunchSelect
                    id={globalDisplayAspectSelectId}
                    data-testid="global-display-aspect-select"
                    surface="panel"
                    aria-label="Default Fullscreen Aspect Ratio"
                    aria-describedby={globalDisplayAspectHintId}
                    value={effectiveGlobalAspectRatio}
                    onChange={(e) =>
                      onChangeDefaultDisplayAspectRatio(
                        e.target.value as GlobalDisplayAspectRatioMode
                      )
                    }
                  >
                    <option value="preserve_aspect">
                      Preserve Aspect Ratio (4:3 Pillarbox / Notch-Safe)
                    </option>
                    <option value="integer">Integer Pixel-Perfect</option>
                    <option value="stretch">Stretch to Fill Screen</option>
                  </LaunchSelect>
                  <p
                    id={globalDisplayAspectHintId}
                    className="text-[10px] text-steam-subtext leading-snug"
                  >
                    Controls fullscreen geometry and upscaling filter across all bottled games.
                  </p>
                </div>
              </div>

              <div className="flex items-center justify-between gap-3 rounded-lg bg-[#0e151f] border border-[#223447] px-3 py-2.5">
                <div className="min-w-0 space-y-0.5">
                  <span
                    id={fullscreenHotkeyLabelId}
                    className="block text-xs font-semibold text-white"
                  >
                    In-Game Fullscreen Shortcut (Ctrl+Option+F)
                  </span>
                  <p
                    id={fullscreenHotkeyHintId}
                    className="text-[10px] text-steam-subtext leading-snug"
                  >
                    Registers global macOS shortcuts during active bottled sessions (
                    <kbd className="font-mono text-sky-300">Ctrl+Option+F</kbd> toggles Fullscreen /
                    Windowed; <kbd className="font-mono text-sky-300">Ctrl+Option+A</kbd> cycles
                    Aspect Ratio)
                  </p>
                </div>
                <SwitchControl
                  dataTestId="toggle-fullscreen-hotkey"
                  checked={effectiveFullscreenHotkey}
                  ariaLabelledBy={fullscreenHotkeyLabelId}
                  ariaDescribedBy={fullscreenHotkeyHintId}
                  onChange={onToggleFullscreenHotkey}
                  tone="emerald"
                />
              </div>

              <div className="flex items-center justify-between gap-3 rounded-lg bg-[#0e151f] border border-[#223447] px-3 py-2.5">
                <div className="min-w-0 space-y-0.5">
                  <span
                    id={autoShutdownWineLabelId}
                    className="block text-xs font-semibold text-white"
                  >
                    Close Idle Bottle Background Daemons After Exit (wineserver -k)
                  </span>
                  <p
                    id={autoShutdownWineHintId}
                    className="text-[10px] text-steam-subtext leading-snug"
                  >
                    Waits for Cloud Save uploads and active Bottle downloads to finish, then
                    terminates leftover wineserver / winedevice processes and silences Wine debug
                    logs
                  </p>
                </div>
                <SwitchControl
                  dataTestId="toggle-auto-shutdown-wine"
                  checked={perfSettings.autoShutdownWinePrefixOnExit}
                  ariaLabelledBy={autoShutdownWineLabelId}
                  ariaDescribedBy={autoShutdownWineHintId}
                  onChange={onToggleAutoShutdownWine}
                  tone="emerald"
                />
              </div>
            </>
          )}
        </div>
      </div>
    </section>
  );
}

export const StorefrontLifecycleSectionBase = StorefrontLifecycleSectionImpl;
export const StorefrontLifecycleSection = React.memo(StorefrontLifecycleSectionImpl);
StorefrontLifecycleSection.displayName = 'StorefrontLifecycleSection';
