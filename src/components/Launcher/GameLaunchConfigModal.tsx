import React, { useCallback, useEffect, useState } from 'react';
import { CanonicalGame } from '../../contracts/game';
import { ModalShell } from '../Common/ModalShell';
import { StorefrontId } from '../../contracts/platform';
import { GameLaunchConfig, PerformanceHudMode } from '../../contracts/launcher';
import { environmentSetupService } from '../../services/launcher/environmentSetupService';
import {
  Settings,
  X,
  Save,
  RotateCcw,
  CheckCircle2,
  AlertTriangle,
  ChevronRight,
  Gauge,
} from 'lucide-react';
import { getBadgeToneClasses } from './LaunchConfig/launchConfigHelpers';
import {
  LAUNCH_BUTTON_FOCUS_CLASSES,
  LaunchDisclosure,
  SegmentedRadioGroup,
} from './LaunchConfig/LaunchConfigControls';
import {
  DetectedPipelineBanner,
  DetectedPipelineBannerBase,
} from './LaunchConfig/DetectedPipelineBanner';
import {
  FastLaunchWarningBanner,
  FastLaunchWarningBannerBase,
} from './LaunchConfig/FastLaunchWarningBanner';
import {
  ExecutableAndArgsSection,
  ExecutableAndArgsSectionBase,
} from './LaunchConfig/ExecutableAndArgsSection';
import {
  CompatibilityLayerSection,
  CompatibilityLayerSectionBase,
} from './LaunchConfig/CompatibilityLayerSection';
import {
  EnvironmentAndHooksSection,
  EnvironmentAndHooksSectionBase,
} from './LaunchConfig/EnvironmentAndHooksSection';
import {
  StorefrontLifecycleSection,
  StorefrontLifecycleSectionBase,
  formatShortStorefrontPolicyLabel,
} from './LaunchConfig/StorefrontLifecycleSection';
import { useGameLaunchConfigForm } from './LaunchConfig/useGameLaunchConfigForm';
import { useIsRealClientRenderer, useSafeId } from '../../utils/useSafeId';

export interface GameLaunchConfigModalProps {
  isOpen: boolean;
  game: CanonicalGame;
  initialPlatformId?: StorefrontId;
  onClose: () => void;
  onSaved?: (config: GameLaunchConfig) => void;
  onOpenGlobalSettings?: (section?: 'general' | 'macos_bottle') => void;
  onOpenRunnerSetup?: () => void;
}

export const GameLaunchConfigModal: React.FC<GameLaunchConfigModalProps> = ({
  isOpen,
  game,
  initialPlatformId,
  onClose,
  onSaved,
  onOpenGlobalSettings,
  onOpenRunnerSetup,
}) => {
  const isRealClientRenderer = useIsRealClientRenderer();
  const idPrefix = useSafeId('launch-cfg');
  const form = useGameLaunchConfigForm({
    isOpen,
    game,
    initialPlatformId,
    onClose,
    onSaved,
  });

  const [showDiscardConfirm, setShowDiscardConfirm] = useState(false);
  const [executionOpenOverride, setExecutionOpenOverride] = useState<boolean | null>(null);

  const shouldAutoOpenExecution =
    form.activeDisplayMethod === 'direct' || !form.preview.isInstalled;

  useEffect(() => {
    if (!isOpen) {
      setShowDiscardConfirm(false);
      setExecutionOpenOverride(null);
    }
  }, [isOpen, game.id]);

  useEffect(() => {
    if (!form.hasUnsavedChanges && showDiscardConfirm) {
      setShowDiscardConfirm(false);
    }
  }, [form.hasUnsavedChanges, showDiscardConfirm]);

  useEffect(() => {
    if (shouldAutoOpenExecution) {
      setExecutionOpenOverride(true);
    }
  }, [shouldAutoOpenExecution]);

  const handleOpenGlobalSettings = useCallback(
    (section: 'general' | 'macos_bottle' = 'general') => {
      if (onOpenGlobalSettings) {
        onOpenGlobalSettings(section);
        return;
      }
      if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
        window.dispatchEvent(
          new CustomEvent('antigravity:open-settings', { detail: { section } })
        );
      }
    },
    [onOpenGlobalSettings]
  );

  const handleOpenRunnerSetup = useCallback(() => {
    if (onOpenRunnerSetup) {
      onOpenRunnerSetup();
      return;
    }
    environmentSetupService.openWizard({
      mode: 'health_check',
      initialStep: 'compatibility',
    });
  }, [onOpenRunnerSetup]);

  const isBusy = form.isSaving;

  const handleCloseAttemptWhilePrevented = useCallback(() => {
    if (!isBusy && form.hasUnsavedChanges) {
      setShowDiscardConfirm(true);
    }
  }, [isBusy, form.hasUnsavedChanges]);

  const handleRequestClose = useCallback(() => {
    if (isBusy) return;
    if (form.hasUnsavedChanges) {
      setShowDiscardConfirm(true);
      return;
    }
    onClose();
  }, [isBusy, form.hasUnsavedChanges, onClose]);

  const handleDiscardAndClose = useCallback(() => {
    if (isBusy) return;
    setShowDiscardConfirm(false);
    onClose();
  }, [isBusy, onClose]);

  if (!isOpen) return null;

  const renderSection = <P extends object>(
    MemoComp: React.ComponentType<P>,
    BaseFn: (props: P) => React.ReactElement | null,
    props: P
  ): React.ReactElement | null =>
    isRealClientRenderer ? React.createElement(MemoComp, props) : BaseFn(props);

  const dialogTitleId = `${idPrefix}-dialog-title`;
  const globalHudDefaultLabel = form.perfSettings.defaultPerformanceHud ? 'On' : 'Off';
  const hudHelperText = form.isWindowsHost
    ? 'Enables DXVK HUD (FPS & frametimes) on Vulkan / DXVK-wrapped games. For native DirectX titles, use Windows Game Bar (Win+G) or GPU driver overlays.'
    : form.preview.visibleSections.compatibilityLayer
      ? 'Uses Apple Metal HUD on D3DMetal & DXMT; automatically falls back to DXVK HUD when required by MoltenVK.'
      : 'Enables Apple Metal Performance HUD (MTL_HUD_ENABLED=1) for live FPS, frametime, and GPU memory telemetry.';

  const compatSectionProps = {
    idPrefix,
    isWindowsHost: form.isWindowsHost,
    preview: form.preview,
    activeDisplayMethod: form.activeDisplayMethod,
    detectedLayers: form.detectedLayers,
    runnerUpdates: form.runnerUpdates,
    compatibilityLayer: form.compatibilityLayer,
    onSelectCompatibilityLayer: form.handleSelectCompatibilityLayer,
    availableBottles: form.availableBottles,
    wineBottleName: form.wineBottleName,
    onChangeWineBottleName: form.setWineBottleName,
    selectedRunnerDescriptor: form.selectedRunnerDescriptor,
    activeLayer: form.activeLayer,
    activeUpdateInfo: form.activeUpdateInfo,
    activeInstalledVer: form.activeInstalledVer,
    activeSecondaryBuildText: form.activeSecondaryBuildText,
    resolvedBottleFolderPath: form.resolvedBottleFolderPath,
    onOpenBottleFolder: form.handleOpenBottleFolder,
    onOpenRunnerSetup: handleOpenRunnerSetup,
    winePrefixPath: form.winePrefixPath,
    onChangeWinePrefixPath: form.setWinePrefixPath,
    onBrowseWinePrefix: form.handleBrowseWinePrefix,
    crossoverGraphicsBackend: form.crossoverGraphicsBackend,
    onChangeCrossoverGraphicsBackend: form.setCrossoverGraphicsBackend,
    crossoverD3DMetalVersion: form.crossoverD3DMetalVersion,
    onChangeCrossoverD3DMetalVersion: form.setCrossoverD3DMetalVersion,
    showD3DMetalVersionSelector: form.showD3DMetalVersionSelector,
    primaryD3DVer: form.primaryD3DVer,
    fallbackD3DVer: form.fallbackD3DVer,
    crossoverHighResolutionMode: form.crossoverHighResolutionMode,
    onChangeCrossoverHighResolutionMode: form.setCrossoverHighResolutionMode,
    onToggleLegacy96DpiMode: form.handleToggleLegacy96DpiMode,
    isDlssSupportedBackend: form.isDlssSupportedBackend,
    dlssUnavailableReason: form.dlssUnavailableReason,
    crossoverDlss: form.crossoverDlss,
    onToggleCrossoverDlss: form.handleToggleCrossoverDlss,
    metalfxSpatialUpscaleFactor: form.metalfxSpatialUpscaleFactor,
    onChangeMetalfxSpatialUpscaleFactor: form.setMetalfxSpatialUpscaleFactor,
    preferredMaxFrameRate: form.preferredMaxFrameRate,
    onChangePreferredMaxFrameRate: form.setPreferredMaxFrameRate,
    displayScalingMode: form.displayScalingMode,
    onChangeDisplayScalingMode: form.setDisplayScalingMode,
    displayAspectRatio: form.displayAspectRatio,
    onChangeDisplayAspectRatio: form.setDisplayAspectRatio,
    virtualDesktopResolution: form.virtualDesktopResolution,
    onChangeVirtualDesktopResolution: form.setVirtualDesktopResolution,
    defaultBottleDisplayScalingMode: form.perfSettings.defaultBottleDisplayScalingMode,
    defaultDisplayAspectRatio: form.perfSettings.defaultDisplayAspectRatio,
    enableFullscreenHotkey: form.perfSettings.enableFullscreenHotkey,
    emulateModeset: form.emulateModeset,
    onChangeEmulateModeset: form.setEmulateModeset,
    forceLargeAddressAware: form.forceLargeAddressAware,
    onToggleForceLargeAddressAware: form.handleToggleForceLargeAddressAware,
    wineMsync: form.wineMsync,
    onToggleWineMsync: form.handleToggleWineMsync,
    wineEsync: form.wineEsync,
    onToggleWineEsync: form.handleToggleWineEsync,
    wineSyncMode: form.wineSyncMode,
    onSelectWineSyncMode: form.handleSelectWineSyncMode,
    displayOverrideCount: form.displayOverrideCount,
    installedRecord: form.installedRecord,
    platformId: form.preferredPlatformId,
    isFastDirectActive: form.isFastDirectActive,
    onAlignToInstallBottle: form.handleAlignToInstallBottle,
    numericSteamAppId: form.numericSteamAppId,
    bottleSteamFixState: form.bottleSteamFixState,
    onFixBottleSteam: form.handleFixBottleSteam,
    onCancelFixBottleSteam: form.handleCancelFixBottleSteam,
  };

  const activeStorefrontPolicyPill = (() => {
    if (form.preferredPlatformId === 'custom') return null;
    const { policyKey, severity } = form.policyView.infoBox;
    const label =
      policyKey === 'protocol_delegated'
        ? 'Storefront Protocol'
        : policyKey === 'clientless_epic' && !form.policyView.showDropdown
          ? 'Clientless EOS'
          : policyKey === 'clientless_epic' || policyKey === 'clientless_bottle_gog'
            ? 'Fast Direct Bypass'
            : formatShortStorefrontPolicyLabel(policyKey);
    const toneClasses =
      severity === 'warning'
        ? 'bg-amber-500/15 border-amber-400/40 text-amber-200'
        : severity === 'optimal'
          ? 'bg-emerald-500/15 border-emerald-400/35 text-emerald-200'
          : 'bg-sky-500/15 border-sky-400/35 text-sky-200';
    return { label, toneClasses };
  })();

  const showExecutionDisclosure =
    form.preview.visibleSections.executableAndArgs ||
    form.preview.visibleSections.environmentAndHooks;
  const isExecutionDisclosureOpen =
    executionOpenOverride !== null ? executionOpenOverride : shouldAutoOpenExecution;

  return (
    <ModalShell
      isOpen={isOpen}
      onClose={onClose}
      preventClose={isBusy || form.hasUnsavedChanges}
      closeOnBackdrop={!isBusy}
      onCloseAttemptWhilePrevented={handleCloseAttemptWhilePrevented}
      testId="launch-config-modal-overlay"
      ariaLabelledBy={dialogTitleId}
      className="w-full max-w-2xl"
    >
      <div
        className="relative z-10 w-full max-w-2xl rounded-xl bg-[#131b26] border border-[#2a475e] shadow-2xl overflow-hidden text-steam-text flex flex-col max-h-[88vh] select-none overscroll-contain"
        onClick={(e) => e.stopPropagation()}
      >
        <div
          aria-hidden="true"
          data-testid="launch-config-modal-scrim"
          className="sr-only pointer-events-none"
        />
        {/* Header */}
        <div className="px-5 py-4 bg-[#0e151f] border-b border-[#223447] flex items-center justify-between gap-3 shrink-0">
          <div className="flex items-center gap-3 min-w-0">
            <div className="p-2 rounded-lg bg-sky-500/15 border border-sky-400/30 text-sky-400 shrink-0">
              <Settings className="w-5 h-5" aria-hidden="true" />
            </div>
            <div className="min-w-0">
              <h2 id={dialogTitleId} className="text-base font-bold text-white truncate">
                {form.isWindowsHost
                  ? 'Launch Settings'
                  : form.isMacNativeBuild && !form.preview.visibleSections.compatibilityLayer
                    ? 'Launch Settings (macOS Native)'
                    : 'Launch & Compatibility Settings'}
              </h2>
              <p className="text-xs text-steam-subtext truncate">
                Per-game launch profile for <span className="font-semibold text-white">{game.title}</span>
              </p>
            </div>
          </div>

          <button
            type="button"
            data-testid="launch-config-close-btn"
            onClick={handleRequestClose}
            disabled={isBusy}
            className={`min-w-6 min-h-6 p-1.5 rounded-lg bg-white/5 hover:bg-white/10 text-steam-subtext hover:text-white transition-colors cursor-pointer disabled:opacity-50 ${LAUNCH_BUTTON_FOCUS_CLASSES}`}
            aria-label="Close launch settings modal"
          >
            <X className="w-4 h-4" aria-hidden="true" />
          </button>
        </div>

        {/* Scrollable Content */}
        <div className="p-5 space-y-4 overflow-y-auto overscroll-contain [scrollbar-gutter:stable] flex-1 bg-[#131b26] modal-scroll-body">
          {renderSection(DetectedPipelineBanner, DetectedPipelineBannerBase, {
            game,
            preview: form.preview,
            buildBadgeTone: form.buildBadgeTone,
            discoveredTargetPath: form.discoveredTargetPath,
            preferredPlatformId: form.preferredPlatformId,
            draftsByPlatform: form.draftsByPlatform,
            onSelectStorefront: form.handleSelectStorefront,
          })}

          {/* Primary Control 1: Launch Mode (only shown when > 1 valid mode exists) */}
          {form.visibleLaunchModes.length > 1 && (
            <div className="space-y-2">
              <h3 className="block text-[11px] font-bold uppercase tracking-wider text-steam-subtext">
                Launch Mode
              </h3>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                {form.visibleLaunchModes.map((mode) => {
                  const modeNote = form.preview.modeNotes[mode.value];
                  const isModeDisabled = Boolean(modeNote?.disabled);
                  const isSelected = !isModeDisabled && form.activeDisplayMethod === mode.value;
                  const dynamicDesc = modeNote?.dynamicDesc || mode.desc;
                  return (
                    <button
                      key={mode.value}
                      type="button"
                      data-launch-mode={mode.value}
                      disabled={isModeDisabled}
                      aria-disabled={isModeDisabled}
                      aria-pressed={isSelected}
                      onClick={() => {
                        if (isModeDisabled) return;
                        form.setLaunchMethod(mode.value);
                        if (form.isNativeInstalledBuild && form.preferredPlatformId === 'steam') {
                          if (mode.value === 'direct') {
                            form.setStorefrontClientLifecycle('fast_direct_bypass');
                          } else if (
                            mode.value === 'storefront_uri' &&
                            form.effectiveStorefrontClientLifecycle === 'fast_direct_bypass'
                          ) {
                            form.setStorefrontClientLifecycle('minimal_and_close_if_started');
                          }
                        }
                      }}
                      className={`min-h-[28px] p-3 rounded-lg border text-left transition-colors flex flex-col justify-between ${LAUNCH_BUTTON_FOCUS_CLASSES} ${
                        isModeDisabled
                          ? 'bg-[#121923] border-[#1f2e40] text-steam-subtext/60 opacity-55 cursor-not-allowed'
                          : isSelected
                            ? 'bg-sky-500/15 border-sky-400 text-white cursor-pointer'
                            : 'bg-[#17212e] border-[#26384d] text-steam-subtext hover:text-white hover:bg-[#1c2838] cursor-pointer'
                      }`}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span
                          className={
                            isModeDisabled
                              ? 'text-xs font-bold text-steam-subtext/70'
                              : 'text-xs font-bold text-white'
                          }
                        >
                          {mode.label}
                        </span>
                        <div className="flex items-center gap-1.5 shrink-0">
                          {modeNote?.badge && (
                            <span
                              className={`text-[10px] px-1.5 py-0.5 rounded border font-semibold ${getBadgeToneClasses(
                                modeNote.badgeTone
                              )}`}
                            >
                              {modeNote.badge}
                            </span>
                          )}
                          {isSelected && (
                            <CheckCircle2
                              className="w-3.5 h-3.5 text-sky-400 shrink-0"
                              aria-hidden="true"
                            />
                          )}
                        </div>
                      </div>
                      <p className="text-[10px] text-steam-subtext mt-1.5 leading-relaxed">
                        {dynamicDesc}
                      </p>
                      {isModeDisabled && modeNote?.disabledReason && (
                        <p className="text-[10px] text-amber-300/90 mt-1 font-medium leading-snug">
                          {modeNote.disabledReason}
                        </p>
                      )}
                    </button>
                  );
                })}
              </div>

              {form.activeModeWarning && (
                <div className="flex items-start gap-2.5 rounded-lg bg-amber-950/50 border border-amber-500/40 px-3 py-2.5 text-xs text-amber-200">
                  <AlertTriangle
                    className="w-4 h-4 text-amber-400 shrink-0 mt-0.5"
                    aria-hidden="true"
                  />
                  <span className="leading-relaxed">{form.activeModeWarning}</span>
                </div>
              )}
            </div>
          )}

          {renderSection(FastLaunchWarningBanner, FastLaunchWarningBannerBase, {
            fastLaunchAdvisory: form.fastLaunchAdvisory,
            activeDisplayMethod: form.activeDisplayMethod,
            isInstalled: form.preview.isInstalled,
            preferredPlatformId: form.preferredPlatformId,
            mode: 'storefront_uri_only',
          })}

          {/* Primary Controls 2-4: Compatibility & Graphics (Layer, Bottle, Backend, D3DMetal Version, Display Mode, FPS Cap, DLSS, MetalFX Spatial, CPU Sync, 4GB LAA & WinePrefix) */}
          {renderSection(CompatibilityLayerSection, CompatibilityLayerSectionBase, {
            ...compatSectionProps,
            renderSectionPart: 'primary',
          })}

          {/* Primary Control 5: Unified Performance HUD 3-way Segmented Radio (ALL platforms) */}
          <div className="rounded-lg bg-[#0e151f] border border-[#223447] p-3.5">
            <SegmentedRadioGroup<PerformanceHudMode>
              name={`${idPrefix}-performance-hud`}
              legend={
                <>
                  <Gauge className="w-3.5 h-3.5 text-sky-400 shrink-0" aria-hidden="true" />
                  <span>Performance HUD</span>
                </>
              }
              description={hudHelperText}
              descriptionId={`${idPrefix}-performance-hud-hint`}
              value={form.performanceHud}
              options={[
                {
                  value: 'default',
                  label: `Global Default (${globalHudDefaultLabel})`,
                  testId: 'performance-hud-default',
                },
                {
                  value: 'on',
                  label: 'On',
                  testId: 'performance-hud-on',
                },
                {
                  value: 'off',
                  label: 'Off',
                  testId: 'performance-hud-off',
                },
              ]}
              onChange={form.setPerformanceHud}
              variant="pills"
              testId="performance-hud-group"
            />
          </div>

          {/* Collapsed Native <details> Disclosures for Advanced & Rare Overrides */}
          <div className="space-y-2.5">
            {/* Disclosure 1 (Bottled): Display & Legacy Scaling Overrides */}
            {renderSection(CompatibilityLayerSection, CompatibilityLayerSectionBase, {
              ...compatSectionProps,
              renderSectionPart: 'advanced',
            })}

            {/* Disclosure 2: Execution, Arguments & Hooks */}
            {showExecutionDisclosure && (
              <LaunchDisclosure
                summary="Execution, Arguments & Hooks"
                subtitle="Launch args, custom executable, environment & shell hooks"
                overrideCount={form.executionOverrideCount}
                open={isExecutionDisclosureOpen ? true : undefined}
                onToggle={(nextOpen) => setExecutionOpenOverride(nextOpen)}
                testId="disclosure-execution-hooks"
                summaryTestId="disclosure-execution-hooks-summary"
                overrideBadgeTestId="disclosure-execution-hooks-badge"
              >
                {renderSection(ExecutableAndArgsSection, ExecutableAndArgsSectionBase, {
                  idPrefix,
                  preview: form.preview,
                  isWindowsHost: form.isWindowsHost,
                  executablePathLabel: form.executablePathLabel,
                  customExecutablePath: form.customExecutablePath,
                  onChangeCustomExecutablePath: form.setCustomExecutablePath,
                  onBrowseExecutable: form.handleBrowseExecutable,
                  workingDirectory: form.workingDirectory,
                  onChangeWorkingDirectory: form.setWorkingDirectory,
                  onBrowseWorkingDir: form.handleBrowseWorkingDir,
                  launchArguments: form.launchArguments,
                  onChangeLaunchArguments: form.setLaunchArguments,
                  sectionFilter: 'executable_only',
                })}

                {renderSection(EnvironmentAndHooksSection, EnvironmentAndHooksSectionBase, {
                  idPrefix,
                  preview: form.preview,
                  isWindowsHost: form.isWindowsHost,
                  envText: form.envText,
                  onChangeEnvText: form.setEnvText,
                  preLaunchCommand: form.preLaunchCommand,
                  onChangePreLaunchCommand: form.setPreLaunchCommand,
                  postExitCommand: form.postExitCommand,
                  onChangePostExitCommand: form.setPostExitCommand,
                })}
              </LaunchDisclosure>
            )}

            {/* Disclosure 3: Launcher & Storefront Lifecycle Overrides */}
            <details
              data-testid="disclosure-lifecycle-overrides"
              className="group rounded-lg bg-[#0e151f] border border-[#223447] overflow-hidden"
            >
              <summary
                data-testid="disclosure-lifecycle-overrides-summary"
                className={`list-none [&::-webkit-details-marker]:hidden min-h-[36px] px-3.5 py-2.5 flex items-center justify-between gap-2 cursor-pointer select-none hover:bg-[#141d2b]/70 transition-colors motion-reduce:transition-none ${LAUNCH_BUTTON_FOCUS_CLASSES}`}
              >
                <span className="flex items-center gap-2 min-w-0">
                  <ChevronRight
                    aria-hidden="true"
                    className="w-4 h-4 text-sky-400 shrink-0 transition-transform duration-150 motion-reduce:transition-none group-open:rotate-90"
                  />
                  <span className="text-xs font-bold text-white truncate">
                    Launcher &amp; Storefront Lifecycle Overrides
                  </span>
                  <span className="hidden sm:inline text-[10px] text-steam-subtext truncate">
                    — Per-game in-game behavior &amp; storefront policy
                  </span>
                </span>
                <span className="flex items-center gap-1.5 shrink-0">
                  {activeStorefrontPolicyPill && (
                    <span
                      data-testid="disclosure-lifecycle-policy-pill"
                      className={`text-[10px] font-semibold px-2 py-0.5 rounded-full border shrink-0 ${activeStorefrontPolicyPill.toneClasses}`}
                    >
                      {activeStorefrontPolicyPill.label}
                    </span>
                  )}
                  {form.lifecycleOverrideCount > 0 && (
                    <span
                      data-testid="disclosure-lifecycle-overrides-badge"
                      className="text-[10px] font-semibold px-2 py-0.5 rounded-full bg-sky-500/20 border border-sky-400/40 text-sky-200 shrink-0"
                    >
                      {form.lifecycleOverrideCount}{' '}
                      {form.lifecycleOverrideCount === 1 ? 'override' : 'overrides'}
                    </span>
                  )}
                </span>
              </summary>
              <div className="px-3.5 pb-3.5 pt-2.5 border-t border-[#223447]/80 space-y-3.5">
                {renderSection(StorefrontLifecycleSection, StorefrontLifecycleSectionBase, {
                  idPrefix,
                  isWindowsHost: form.isWindowsHost,
                  preview: form.preview,
                  activeDisplayMethod: form.activeDisplayMethod,
                  preferredPlatformId: form.preferredPlatformId,
                  inGameLauncherBehavior: form.inGameLauncherBehavior,
                  onChangeInGameLauncherBehavior: form.setInGameLauncherBehavior,
                  storefrontClientLifecycle: form.storefrontClientLifecycle,
                  onChangeStorefrontClientLifecycle: form.handleChangeStorefrontClientLifecycle,
                  policyView: form.policyView,
                  perfSettings: form.perfSettings,
                  onOpenGlobalSettings: handleOpenGlobalSettings,
                })}
              </div>
            </details>
          </div>
        </div>

        {form.saveError && (
          <div
            data-testid="launch-config-save-error"
            role="alert"
            className="mx-5 mb-2 rounded-lg bg-red-950/70 border border-red-500/50 px-3 py-2 text-xs text-red-200 flex items-center gap-2 shrink-0"
          >
            <AlertTriangle className="w-4 h-4 text-red-400 shrink-0" aria-hidden="true" />
            <span>{form.saveError}</span>
          </div>
        )}

        {/* Reserved-space unsaved-changes confirmation bar (zero layout shift, always-exposed live region!) */}
        <div
          data-testid="launch-config-unsaved-confirm-bar"
          className={`min-h-[34px] px-5 py-2 border-t flex items-center gap-2 text-xs shrink-0 transition-colors ${
            showDiscardConfirm
              ? 'bg-amber-950/55 border-amber-500/40 text-amber-200'
              : 'bg-transparent border-transparent text-transparent'
          }`}
        >
          <AlertTriangle
            className="w-3.5 h-3.5 text-amber-400 shrink-0"
            style={{ visibility: showDiscardConfirm ? 'visible' : 'hidden' }}
            aria-hidden="true"
          />
          <span role="status" aria-live="polite" className="text-amber-200">
            {showDiscardConfirm
              ? 'You have unsaved changes. Save configuration or discard changes to close.'
              : ''}
          </span>
        </div>

        {/* Footer */}
        <div className="px-5 py-3.5 bg-[#0e151f] border-t border-[#223447] flex flex-wrap items-center justify-between gap-3 shrink-0">
          <button
            type="button"
            data-testid="reset-launch-config-btn"
            onClick={form.handleResetDefaults}
            disabled={isBusy}
            className={`inline-flex items-center gap-1.5 min-h-[28px] px-3 py-2 rounded-lg bg-[#17212e] hover:bg-[#223144] border border-[#2a475e] text-xs font-semibold text-steam-subtext hover:text-white transition-colors cursor-pointer disabled:opacity-50 ${LAUNCH_BUTTON_FOCUS_CLASSES}`}
          >
            <RotateCcw className="w-3.5 h-3.5" aria-hidden="true" />
            <span>
              {form.isNativeInstalledBuild ? 'Reset to Recommended' : 'Reset to Auto-Detect'}
            </span>
          </button>

          <div className="flex items-center gap-2.5">
            <button
              type="button"
              data-testid="launch-config-discard-changes-btn"
              onClick={handleDiscardAndClose}
              disabled={!showDiscardConfirm || isBusy}
              tabIndex={showDiscardConfirm ? 0 : -1}
              aria-hidden={!showDiscardConfirm}
              style={{ visibility: showDiscardConfirm ? 'visible' : 'hidden' }}
              className={`min-h-[28px] px-3.5 py-2 rounded-lg bg-rose-950/75 hover:bg-rose-900/80 border border-rose-500/50 text-xs font-semibold text-rose-200 hover:text-white transition-colors cursor-pointer ${LAUNCH_BUTTON_FOCUS_CLASSES}`}
            >
              Discard Changes
            </button>
            <button
              type="button"
              data-testid="launch-config-cancel-btn"
              onClick={handleRequestClose}
              disabled={isBusy}
              className={`min-h-[28px] px-4 py-2 rounded-lg bg-[#1b2838] hover:bg-[#24354a] text-xs font-semibold text-steam-text hover:text-white transition-colors cursor-pointer disabled:opacity-50 ${LAUNCH_BUTTON_FOCUS_CLASSES}`}
            >
              Cancel
            </button>
            <button
              type="button"
              data-testid="launch-config-save-btn"
              data-has-unsaved-changes={form.hasUnsavedChanges ? 'true' : 'false'}
              onClick={form.handleSave}
              disabled={form.isSaving}
              className={`inline-flex items-center gap-1.5 min-h-[28px] px-5 py-2 rounded-lg font-bold text-xs text-white uppercase tracking-wider transition-opacity shadow-lg hover:brightness-110 disabled:opacity-50 cursor-pointer ${LAUNCH_BUTTON_FOCUS_CLASSES}`}
              style={{
                background: 'linear-gradient(to right, #059669 0%, #047857 100%)',
                boxShadow: '0 0 16px rgba(16, 185, 129, 0.35)',
              }}
            >
              <Save className="w-3.5 h-3.5" aria-hidden="true" />
              <span>{form.isSaving ? 'Saving...' : 'Save Configuration'}</span>
            </button>
          </div>
        </div>
      </div>
    </ModalShell>
  );
};
