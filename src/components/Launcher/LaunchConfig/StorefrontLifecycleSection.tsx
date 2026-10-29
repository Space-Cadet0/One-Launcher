import React from 'react';
import { StorefrontId } from '../../../contracts/platform';
import {
  InGameLauncherBehavior,
  LauncherPerformanceSettings,
  LaunchMethod,
  PostGameLauncherBehavior,
  ResolvedLaunchModePreview,
  StorefrontClientLifecyclePolicy,
  StorefrontLaunchPolicyView,
} from '../../../contracts/launcher';
import { launcherService } from '../../../services/launcher/launcherService';
import { Activity, AlertTriangle, CheckCircle2, ExternalLink, Info, Zap } from 'lucide-react';
import {
  computeInGameFootprintBadge,
  formatGlobalInGameBehaviorDefaultLabel,
  getBadgeToneClasses,
  resolveEffectiveUiStorefrontLifecycle,
} from './launchConfigHelpers';

export interface StorefrontLifecycleSectionProps {
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
}

function StorefrontLifecycleSectionImpl({
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

  return (
    <div
      data-section="in-game-performance"
      data-testid="in-game-performance-section"
      className="rounded-lg bg-[#0e151f] border border-[#223447] p-3.5 space-y-3.5"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Activity className="w-4 h-4 text-emerald-400 shrink-0" />
          <span className="text-xs font-bold text-white uppercase tracking-wider">
            In-Game Footprint &amp; Performance
          </span>
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

      {/* Per-Game One Launcher Window Footprint + Post-Exit Behavior */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div className="space-y-1">
          <label
            htmlFor="in-game-launcher-behavior-select"
            className="block text-[10px] font-bold uppercase tracking-wider text-steam-subtext"
          >
            One Launcher During Gameplay
          </label>
          <select
            id="in-game-launcher-behavior-select"
            aria-label="In-Game Launcher Behavior"
            data-testid="in-game-launcher-behavior-select"
            value={inGameLauncherBehavior}
            onChange={(e) => {
              const val = e.target.value as 'default' | InGameLauncherBehavior;
              onChangeInGameLauncherBehavior(val);
            }}
            className="w-full rounded-lg bg-[#141d2b] border border-[#2a475e] px-2.5 py-1.5 text-xs text-white focus:outline-none focus:border-sky-400"
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
          </select>
        </div>

        <div className="space-y-1">
          <label
            htmlFor="post-game-launcher-behavior-select"
            className="block text-[10px] font-bold uppercase tracking-wider text-steam-subtext"
          >
            When Game Exits
          </label>
          <select
            id="post-game-launcher-behavior-select"
            aria-label="When Game Exits"
            data-testid="post-game-launcher-behavior-select"
            value={perfSettings.postGameLauncherBehavior}
            onChange={(e) =>
              onChangePostGameBehavior(e.target.value as PostGameLauncherBehavior)
            }
            className="w-full rounded-lg bg-[#141d2b] border border-[#2a475e] px-2.5 py-1.5 text-xs text-white focus:outline-none focus:border-sky-400"
          >
            <option value="restore_window">
              {effectiveInGameBehavior === 'keep_open'
                ? 'Keep One Launcher Window Open'
                : 'Restore One Launcher Window'}
            </option>
            {showStayMinimizedPostExitOption && (
              <option value="stay_minimized">
                {isWindowsHost
                  ? 'Keep Hidden in System Tray'
                  : 'Keep Hidden in Menu Bar'}
              </option>
            )}
            <option value="exit_launcher">Quit One Launcher Automatically</option>
          </select>
        </div>
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
                <ExternalLink className="w-3.5 h-3.5 text-sky-400 shrink-0" />
              ) : (
                <Zap
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
                    <AlertTriangle className="w-4 h-4 text-orange-400 shrink-0 mt-0.5" />
                  ) : infoBox.severity === 'optimal' ? (
                    <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0 mt-0.5" />
                  ) : (
                    <Info className="w-4 h-4 text-sky-400 shrink-0 mt-0.5" />
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
            <div className="space-y-1">
              <label
                htmlFor="storefront-client-lifecycle-select"
                className="block text-[10px] font-bold uppercase tracking-wider text-steam-subtext"
              >
                {resolvedPolicyView.cardHeading} Mode
              </label>
              <select
                id="storefront-client-lifecycle-select"
                aria-label={resolvedPolicyView.cardHeading}
                data-testid="storefront-client-lifecycle-select"
                value={resolvedPolicyView.selectedDropdownValue}
                onChange={(e) =>
                  onChangeStorefrontClientLifecycle(
                    e.target.value as StorefrontClientLifecyclePolicy
                  )
                }
                className="w-full rounded-lg bg-[#141d2b] border border-[#2a475e] px-2.5 py-1.5 text-xs text-white focus:outline-none focus:border-sky-400"
              >
                {resolvedPolicyView.dropdownOptions.map((opt) => (
                  <option key={opt.value} value={opt.value}>
                    {opt.label}
                  </option>
                ))}
              </select>
            </div>
          )}
        </div>
      )}

      {/* Background Resource Controls (Wine cleanup strictly filtered to bottle/compatibility contexts) */}
      <div className="space-y-2 pt-0.5">
        <div className="text-[10px] font-bold uppercase tracking-wider text-steam-subtext">
          Background Activity During Gameplay
        </div>

        <div className="flex items-center justify-between gap-3 rounded-lg bg-[#141d2b] border border-[#26384d] px-3 py-2">
          <div className="min-w-0">
            <div className="text-xs font-semibold text-white">
              Pause Background Store Artwork &amp; Review Scans While Playing
            </div>
            <div className="text-[10px] text-steam-subtext">
              Suspends library metadata and critic score crawlers during gameplay (game Cloud Saves
              are unaffected)
            </div>
          </div>
          <button
            type="button"
            data-testid="toggle-pause-sync-in-game"
            aria-pressed={perfSettings.pauseBackgroundSyncInGame}
            onClick={onTogglePauseSyncInGame}
            className={`px-3 py-1 rounded-md text-xs font-bold border transition-colors shrink-0 cursor-pointer ${
              perfSettings.pauseBackgroundSyncInGame
                ? 'bg-emerald-500/20 border-emerald-400 text-emerald-300'
                : 'bg-[#0e151f] border-[#26384d] text-steam-subtext hover:text-white'
            }`}
          >
            {perfSettings.pauseBackgroundSyncInGame ? 'ON' : 'OFF'}
          </button>
        </div>

        <div className="flex items-center justify-between gap-3 rounded-lg bg-[#141d2b] border border-[#26384d] px-3 py-2">
          <div className="min-w-0">
            <div className="text-xs font-semibold text-white">
              Pause Active Game Downloads While Playing
            </div>
            <div className="text-[10px] text-steam-subtext">
              Pauses One Launcher downloads to free bandwidth and disk I/O during gameplay, then
              resumes on exit
            </div>
          </div>
          <button
            type="button"
            data-testid="toggle-pause-downloads-in-game"
            aria-pressed={perfSettings.pauseDownloadsInGame}
            onClick={onTogglePauseDownloadsInGame}
            className={`px-3 py-1 rounded-md text-xs font-bold border transition-colors shrink-0 cursor-pointer ${
              perfSettings.pauseDownloadsInGame
                ? 'bg-emerald-500/20 border-emerald-400 text-emerald-300'
                : 'bg-[#0e151f] border-[#26384d] text-steam-subtext hover:text-white'
            }`}
          >
            {perfSettings.pauseDownloadsInGame ? 'ON' : 'OFF'}
          </button>
        </div>

        {isBottleContext && (
          <div className="flex items-center justify-between gap-3 rounded-lg bg-[#141d2b] border border-[#26384d] px-3 py-2">
            <div className="min-w-0">
              <div className="text-xs font-semibold text-white">
                Close Idle Bottle Background Daemons After Exit (wineserver -k)
              </div>
              <div className="text-[10px] text-steam-subtext">
                Waits for Cloud Save uploads and active Bottle downloads to finish, then terminates
                leftover wineserver / winedevice processes and silences Wine debug logs
              </div>
            </div>
            <button
              type="button"
              data-testid="toggle-auto-shutdown-wine"
              aria-pressed={perfSettings.autoShutdownWinePrefixOnExit}
              onClick={onToggleAutoShutdownWine}
              className={`px-3 py-1 rounded-md text-xs font-bold border transition-colors shrink-0 cursor-pointer ${
                perfSettings.autoShutdownWinePrefixOnExit
                  ? 'bg-emerald-500/20 border-emerald-400 text-emerald-300'
                  : 'bg-[#0e151f] border-[#26384d] text-steam-subtext hover:text-white'
              }`}
            >
              {perfSettings.autoShutdownWinePrefixOnExit ? 'ON' : 'OFF'}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

export const StorefrontLifecycleSectionBase = StorefrontLifecycleSectionImpl;
export const StorefrontLifecycleSection = React.memo(StorefrontLifecycleSectionImpl);
StorefrontLifecycleSection.displayName = 'StorefrontLifecycleSection';
