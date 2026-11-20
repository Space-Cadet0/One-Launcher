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
  AlertTriangle,
  CheckCircle2,
  ExternalLink,
  Info,
  Settings,
  Zap,
} from 'lucide-react';
import {
  computeInGameFootprintBadge,
  formatGlobalInGameBehaviorDefaultLabel,
  getBadgeToneClasses,
  resolveEffectiveUiStorefrontLifecycle,
} from './launchConfigHelpers';
import { LAUNCH_BUTTON_FOCUS_CLASSES, LaunchSelect } from './LaunchConfigControls';

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
  /** Read-only global settings snapshot used purely for "Use Global Default (...)" labels */
  perfSettings: LauncherPerformanceSettings;
  onOpenGlobalSettings?: (section?: 'general' | 'macos_bottle') => void;
  /** @deprecated Global settings moved to dedicated SettingsModal; retained optional for call-site compatibility */
  onChangePostGameBehavior?: (value: PostGameLauncherBehavior) => void;
  onTogglePauseSyncInGame?: () => void;
  onTogglePauseDownloadsInGame?: () => void;
  onToggleAutoShutdownWine?: () => void;
  onChangeDefaultBottleDisplayScalingMode?: (value: GlobalBottleDisplayScalingMode) => void;
  onChangeDefaultDisplayAspectRatio?: (value: GlobalDisplayAspectRatioMode) => void;
  onToggleFullscreenHotkey?: () => void;
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
  onOpenGlobalSettings,
}: StorefrontLifecycleSectionProps): React.ReactElement {
  const isBottleContext =
    !isWindowsHost &&
    (preview.detectedBuildType === 'windows_exe_on_mac' ||
      activeDisplayMethod === 'compatibility_layer' ||
      preview.visibleSections.compatibilityLayer);

  const showStorefrontSection = preferredPlatformId !== 'custom';

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

  const handleOpenGlobalDefaults = () => {
    if (onOpenGlobalSettings) {
      onOpenGlobalSettings('general');
      return;
    }
    if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
      window.dispatchEvent(
        new CustomEvent('antigravity:open-settings', { detail: { section: 'general' } })
      );
    }
  };

  return (
    <div
      data-section="in-game-performance"
      data-testid="in-game-performance-section"
      className="space-y-3.5"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span
          data-testid="in-game-footprint-mode-badge"
          className={`text-[10px] px-2 py-0.5 rounded border font-semibold ${getBadgeToneClasses(
            footprintBadge.tone
          )}`}
        >
          {footprintBadge.label}
        </span>
        <button
          type="button"
          data-testid="edit-global-defaults-btn"
          onClick={handleOpenGlobalDefaults}
          className={`min-h-[24px] inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-[#17212e] hover:bg-[#223144] border border-[#2a475e] text-[11px] font-semibold text-sky-300 hover:text-white transition-colors cursor-pointer ${LAUNCH_BUTTON_FOCUS_CLASSES}`}
        >
          <Settings className="w-3 h-3" aria-hidden="true" />
          <span>Edit Global Defaults…</span>
        </button>
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
            Per-Game Override
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

      {/* Per-Game Storefront Launch Policy Card (filtered out for standalone custom games) */}
      {showStorefrontSection && (
        <div
          data-testid="storefront-launch-policy-card"
          className="rounded-lg bg-[#121a27] border border-[#24364b] p-3.5 space-y-3"
        >
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
                      <li key={idx} className="flex items-start gap-1.5 text-[11px] leading-snug">
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
    </div>
  );
}

export const StorefrontLifecycleSectionBase = StorefrontLifecycleSectionImpl;
export const StorefrontLifecycleSection = React.memo(StorefrontLifecycleSectionImpl);
StorefrontLifecycleSection.displayName = 'StorefrontLifecycleSection';
