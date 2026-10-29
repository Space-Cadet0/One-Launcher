import React from 'react';
import { CanonicalGame } from '../../contracts/game';
import { ModalShell } from '../Common/ModalShell';
import { StorefrontId } from '../../contracts/platform';
import { GameLaunchConfig } from '../../contracts/launcher';
import {
  Settings,
  X,
  Save,
  RotateCcw,
  CheckCircle2,
  AlertTriangle,
} from 'lucide-react';
import { getBadgeToneClasses } from './LaunchConfig/launchConfigHelpers';
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
} from './LaunchConfig/StorefrontLifecycleSection';
import { useGameLaunchConfigForm } from './LaunchConfig/useGameLaunchConfigForm';
import { useIsRealClientRenderer, useSafeId } from '../../utils/useSafeId';

export interface GameLaunchConfigModalProps {
  isOpen: boolean;
  game: CanonicalGame;
  initialPlatformId?: StorefrontId;
  onClose: () => void;
  onSaved?: (config: GameLaunchConfig) => void;
}

export const GameLaunchConfigModal: React.FC<GameLaunchConfigModalProps> = ({
  isOpen,
  game,
  initialPlatformId,
  onClose,
  onSaved,
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

  if (!isOpen) return null;

  const renderSection = <P extends object>(
    MemoComp: React.ComponentType<P>,
    BaseFn: (props: P) => React.ReactElement | null,
    props: P
  ): React.ReactElement | null =>
    isRealClientRenderer ? React.createElement(MemoComp, props) : BaseFn(props);

  const isBusy =
    form.isSaving ||
    form.isInstallingRunner ||
    form.isUpdatingRunner ||
    form.isRescanningRunners;

  return (
    <ModalShell
      isOpen={isOpen}
      onClose={onClose}
      preventClose={isBusy}
      closeOnBackdrop={!isBusy}
      lockOverlay={false}
      testId="launch-config-modal-overlay"
      ariaLabel={form.isWindowsHost ? 'Launch Settings' : 'Launch & Compatibility Settings'}
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
              <h2 className="text-base font-bold text-white truncate">
                {form.isWindowsHost
                  ? 'Launch Settings'
                  : form.isMacNativeBuild && !form.preview.visibleSections.compatibilityLayer
                    ? 'Launch Settings (macOS Native)'
                    : 'Launch & Compatibility Settings'}
              </h2>
              <p className="text-xs text-steam-subtext truncate">
                {form.isWindowsHost
                  ? 'Configure execution mode, custom executable & launch parameters for '
                  : form.isMacNativeBuild && !form.preview.visibleSections.compatibilityLayer
                    ? 'Configure native macOS execution mode, Metal HUD & launch parameters for '
                    : 'Configure execution mode, Wine/CrossOver bottles & launch parameters for '}
                <span className="font-semibold text-white">{game.title}</span>
              </p>
            </div>
          </div>

          <button
            type="button"
            onClick={onClose}
            disabled={isBusy}
            className="min-w-6 min-h-6 p-1.5 rounded-lg bg-white/5 hover:bg-white/10 text-steam-subtext hover:text-white transition-colors cursor-pointer disabled:opacity-50"
            aria-label="Close launch settings modal"
          >
            <X className="w-4 h-4" aria-hidden="true" />
          </button>
        </div>

        {/* Scrollable Content */}
        <div className="p-5 space-y-5 overflow-y-auto overscroll-contain flex-1 bg-[#131b26] modal-scroll-body">
          {renderSection(DetectedPipelineBanner, DetectedPipelineBannerBase, {
            game,
            preview: form.preview,
            buildBadgeTone: form.buildBadgeTone,
            discoveredTargetPath: form.discoveredTargetPath,
            preferredPlatformId: form.preferredPlatformId,
            draftsByPlatform: form.draftsByPlatform,
            onSelectStorefront: form.handleSelectStorefront,
          })}

          {/* Launch Mode */}
          <div className="space-y-2">
            <span className="block text-[11px] font-bold uppercase tracking-wider text-steam-subtext">
              Launch Mode
            </span>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              {form.visibleLaunchModes.map((mode) => {
                const modeNote = form.preview.modeNotes[mode.value];
                const isModeDisabled = Boolean(modeNote?.disabled);
                const isSelected = !isModeDisabled && form.activeDisplayMethod === mode.value;
                const dynamicDesc =
                  form.isWindowsHost &&
                  modeNote?.dynamicDesc &&
                  /CrossOver/i.test(modeNote.dynamicDesc)
                    ? mode.desc
                    : modeNote?.dynamicDesc || mode.desc;
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
                    className={`p-3 rounded-lg border text-left transition-colors flex flex-col justify-between ${
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

          {renderSection(FastLaunchWarningBanner, FastLaunchWarningBannerBase, {
            fastLaunchAdvisory: form.fastLaunchAdvisory,
            activeDisplayMethod: form.activeDisplayMethod,
            isInstalled: form.preview.isInstalled,
            preferredPlatformId: form.preferredPlatformId,
            mode: 'storefront_uri_only',
          })}

          {!form.preview.isInstalled &&
            renderSection(ExecutableAndArgsSection, ExecutableAndArgsSectionBase, {
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
              metalHud: form.metalHud,
              onToggleMetalHud: form.handleToggleMetalHud,
              sectionFilter: 'executable_only',
            })}

          {renderSection(CompatibilityLayerSection, CompatibilityLayerSectionBase, {
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
            isCheckingUpdates: form.isCheckingUpdates,
            isUpdatingRunner: form.isUpdatingRunner,
            onUpdateRunner: form.handleUpdateRunner,
            onCheckRunnerUpdates: form.handleCheckRunnerUpdates,
            resolvedBottleFolderPath: form.resolvedBottleFolderPath,
            onOpenBottleFolder: form.handleOpenBottleFolder,
            isRescanningRunners: form.isRescanningRunners,
            onRescanLayers: form.handleRescanLayers,
            isInstallingRunner: form.isInstallingRunner,
            onInstallRunnerViaBrew: form.handleInstallRunnerViaBrew,
            onDownloadRunner: form.handleDownloadRunner,
            runnerUpdateFeedback: form.runnerUpdateFeedback,
            runnerActionFeedback: form.runnerActionFeedback,
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
            isDlssSupportedBackend: form.isDlssSupportedBackend,
            isDxvkHudSupported: form.isDxvkHudSupported,
            crossoverDlss: form.crossoverDlss,
            onToggleCrossoverDlss: form.handleToggleCrossoverDlss,
            wineMsync: form.wineMsync,
            onToggleWineMsync: form.handleToggleWineMsync,
            wineEsync: form.wineEsync,
            onToggleWineEsync: form.handleToggleWineEsync,
            metalHud: form.metalHud,
            onToggleMetalHud: form.handleToggleMetalHud,
            dxvkHud: form.dxvkHud,
            onToggleDxvkHud: form.handleToggleDxvkHud,
          })}

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
            metalHud: form.metalHud,
            onToggleMetalHud: form.handleToggleMetalHud,
            sectionFilter: 'native_mac_only',
          })}

          {renderSection(StorefrontLifecycleSection, StorefrontLifecycleSectionBase, {
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
            onChangePostGameBehavior: form.handleChangePostGameBehavior,
            onTogglePauseSyncInGame: form.handleTogglePauseSyncInGame,
            onTogglePauseDownloadsInGame: form.handleTogglePauseDownloadsInGame,
            onToggleAutoShutdownWine: form.handleToggleAutoShutdownWine,
          })}

          {form.preview.isInstalled &&
            renderSection(ExecutableAndArgsSection, ExecutableAndArgsSectionBase, {
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
              metalHud: form.metalHud,
              onToggleMetalHud: form.handleToggleMetalHud,
              sectionFilter: 'executable_only',
            })}

          {renderSection(EnvironmentAndHooksSection, EnvironmentAndHooksSectionBase, {
            idPrefix,
            preview: form.preview,
            isWindowsHost: form.isWindowsHost,
            currentEnvMap: form.currentEnvMap,
            onToggleQuickEnv: form.handleToggleQuickEnv,
            envText: form.envText,
            onChangeEnvText: form.setEnvText,
            preLaunchCommand: form.preLaunchCommand,
            onChangePreLaunchCommand: form.setPreLaunchCommand,
            postExitCommand: form.postExitCommand,
            onChangePostExitCommand: form.setPostExitCommand,
          })}
        </div>

        {/* Footer */}
        <div className="px-5 py-3.5 bg-[#0e151f] border-t border-[#223447] flex items-center justify-between gap-3 shrink-0">
          <button
            type="button"
            data-testid="reset-launch-config-btn"
            onClick={form.handleResetDefaults}
            disabled={isBusy}
            className="inline-flex items-center gap-1.5 min-h-6 px-3 py-2 rounded-lg bg-[#17212e] hover:bg-[#223144] border border-[#2a475e] text-xs font-semibold text-steam-subtext hover:text-white transition-colors cursor-pointer disabled:opacity-50"
          >
            <RotateCcw className="w-3.5 h-3.5" aria-hidden="true" />
            <span>
              {form.isNativeInstalledBuild ? 'Reset to Recommended' : 'Reset to Auto-Detect'}
            </span>
          </button>

          <div className="flex items-center gap-2.5">
            <button
              type="button"
              onClick={onClose}
              disabled={isBusy}
              className="min-h-6 px-4 py-2 rounded-lg bg-[#1b2838] hover:bg-[#24354a] text-xs font-semibold text-steam-text hover:text-white transition-colors cursor-pointer disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={form.handleSave}
              disabled={form.isSaving}
              className="inline-flex items-center gap-1.5 min-h-6 px-5 py-2 rounded-lg font-bold text-xs text-white uppercase tracking-wider transition-opacity shadow-lg hover:brightness-110 disabled:opacity-50 cursor-pointer"
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
