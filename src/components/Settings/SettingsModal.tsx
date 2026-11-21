import React from 'react';
import { Cloud, Settings, Wrench, X } from 'lucide-react';
import type { HostPlatform } from '../../contracts/hostPlatform';
import { ModalShell } from '../Common/ModalShell';
import { LAUNCH_BUTTON_FOCUS_CLASSES } from '../Launcher/LaunchConfig/LaunchConfigControls';
import { useSafeId } from '../../utils/useSafeId';
import { useSettingsFormState } from './useSettingsFormState';
import { SettingsLibrarySection } from './SettingsLibrarySection';
import { SettingsGeneralSection } from './SettingsGeneralSection';
import { SettingsMacOsBottleSection } from './SettingsMacOsBottleSection';
import { SettingsFooter } from './SettingsFooter';

export interface SettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
  onOpenRunnerSetup?: () => void;
  onOpenIntegrations?: () => void;
  initialSection?: 'general' | 'macos_bottle';
  hostPlatform?: HostPlatform;
}

export const SettingsModal: React.FC<SettingsModalProps> = ({
  isOpen,
  onClose,
  onOpenRunnerSetup,
  onOpenIntegrations,
  initialSection = 'general',
  hostPlatform,
}) => {
  const idPrefix = useSafeId('global-settings');
  const {
    hostCapabilities,
    isMacHost,
    draft,
    setDraft,
    isDirty,
    isSaving,
    saveError,
    showDiscardConfirm,
    macSectionRef,
    discardBtnRef,
    installedRunners,
    totalBottlesCount,
    handleCloseAttemptWhilePrevented,
    handleRequestClose,
    handleDiscardAndClose,
    handleResetToDefaults,
    handleSave,
    handleOpenRunnerSetup,
    handleOpenIntegrations,
  } = useSettingsFormState({
    isOpen,
    onClose,
    onOpenRunnerSetup,
    onOpenIntegrations,
    initialSection,
    hostPlatform,
  });

  if (!isOpen) return null;

  const ignoreLeadingTheLabelId = `${idPrefix}-ignore-leading-the-label`;
  const ignoreLeadingTheHintId = `${idPrefix}-ignore-leading-the-hint`;
  const pauseSyncLabelId = `${idPrefix}-pause-sync-label`;
  const pauseSyncHintId = `${idPrefix}-pause-sync-hint`;
  const pauseDownloadsLabelId = `${idPrefix}-pause-downloads-label`;
  const pauseDownloadsHintId = `${idPrefix}-pause-downloads-hint`;
  const defaultHudLabelId = `${idPrefix}-default-hud-label`;
  const defaultHudHintId = `${idPrefix}-default-hud-hint`;
  const hotkeyLabelId = `${idPrefix}-hotkey-label`;
  const hotkeyHintId = `${idPrefix}-hotkey-hint`;
  const autoShutdownLabelId = `${idPrefix}-auto-shutdown-label`;
  const autoShutdownHintId = `${idPrefix}-auto-shutdown-hint`;
  const unsavedWarningId = `${idPrefix}-unsaved-warning`;

  return (
    <ModalShell
      isOpen={isOpen}
      onClose={onClose}
      preventClose={isSaving || isDirty}
      closeOnBackdrop={!isSaving}
      onCloseAttemptWhilePrevented={handleCloseAttemptWhilePrevented}
      ariaLabelledBy="global-settings-modal-title"
      testId="global-settings-modal"
      className="w-full max-w-2xl"
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void handleSave();
        }}
        onClick={(e) => e.stopPropagation()}
        className="relative z-10 w-full max-w-2xl rounded-xl bg-[#131b26] border border-[#2a475e] shadow-2xl overflow-hidden text-steam-text flex flex-col max-h-[88vh] select-none overscroll-contain"
      >
        {/* Header */}
        <div className="px-5 py-4 bg-[#0e151f] border-b border-[#223447] flex items-center justify-between gap-3 shrink-0">
          <div className="flex items-center gap-3 min-w-0">
            <div className="p-2 rounded-lg bg-sky-500/15 border border-sky-400/30 text-sky-400 shrink-0">
              <Settings className="w-5 h-5" aria-hidden="true" />
            </div>
            <div className="min-w-0">
              <h2
                id="global-settings-modal-title"
                className="text-base font-bold text-white truncate"
              >
                Settings
              </h2>
              <p className="text-xs text-steam-subtext truncate">
                {hostCapabilities.supportsBottleDisplayScaler
                  ? 'Global library sorting, gameplay footprint, performance HUD & platform defaults for all games'
                  : 'Global library sorting, gameplay footprint & launch defaults for all games'}
              </p>
            </div>
          </div>

          <button
            type="button"
            data-testid="settings-close-btn"
            onClick={handleRequestClose}
            disabled={isSaving}
            className={`min-w-6 min-h-6 p-1.5 rounded-lg bg-white/5 hover:bg-white/10 text-steam-subtext hover:text-white transition-colors cursor-pointer disabled:opacity-50 ${LAUNCH_BUTTON_FOCUS_CLASSES}`}
            aria-label="Close settings"
          >
            <X className="w-4 h-4" aria-hidden="true" />
          </button>
        </div>

        {/* Scrollable Body */}
        <div className="p-5 space-y-5 overflow-y-auto overscroll-contain [scrollbar-gutter:stable] flex-1 bg-[#131b26] modal-scroll-body">
          <SettingsLibrarySection
            ignoreLeadingTheWhenSorting={draft.ignoreLeadingTheWhenSorting ?? true}
            labelId={ignoreLeadingTheLabelId}
            hintId={ignoreLeadingTheHintId}
            onToggleIgnoreLeadingThe={() =>
              setDraft((prev) => ({
                ...prev,
                ignoreLeadingTheWhenSorting: !(prev.ignoreLeadingTheWhenSorting ?? true),
              }))
            }
          />

          <SettingsGeneralSection
            idPrefix={idPrefix}
            draft={draft}
            hostCapabilities={hostCapabilities}
            defaultHudLabelId={defaultHudLabelId}
            defaultHudHintId={defaultHudHintId}
            pauseSyncLabelId={pauseSyncLabelId}
            pauseSyncHintId={pauseSyncHintId}
            pauseDownloadsLabelId={pauseDownloadsLabelId}
            pauseDownloadsHintId={pauseDownloadsHintId}
            onUpdateDraft={setDraft}
          />

          {isMacHost && (
            <SettingsMacOsBottleSection
              sectionRef={macSectionRef}
              idPrefix={idPrefix}
              draft={draft}
              installedRunners={installedRunners}
              totalBottlesCount={totalBottlesCount}
              hotkeyLabelId={hotkeyLabelId}
              hotkeyHintId={hotkeyHintId}
              autoShutdownLabelId={autoShutdownLabelId}
              autoShutdownHintId={autoShutdownHintId}
              onOpenRunnerSetup={handleOpenRunnerSetup}
              onUpdateDraft={setDraft}
            />
          )}

          {/* Library & Setup Quick Shortcuts */}
          <div className="rounded-lg bg-[#0e151f] border border-[#223447] p-3.5 flex flex-wrap items-center justify-between gap-2.5">
            <span className="text-[11px] font-semibold text-steam-subtext">
              Accounts, Offline Vault &amp; Environment Setup
            </span>
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                data-testid="settings-open-integrations-btn"
                onClick={handleOpenIntegrations}
                className={`min-h-[28px] inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-[#17212e] hover:bg-[#223144] border border-[#2a475e] text-xs font-semibold text-sky-300 hover:text-white transition-colors cursor-pointer ${LAUNCH_BUTTON_FOCUS_CLASSES}`}
              >
                <Cloud className="w-3.5 h-3.5" aria-hidden="true" />
                <span>Storefront Integrations &amp; Vault…</span>
              </button>
              <button
                type="button"
                data-testid="settings-open-runner-setup-btn"
                onClick={handleOpenRunnerSetup}
                className={`min-h-[28px] inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-[#17212e] hover:bg-[#223144] border border-[#2a475e] text-xs font-semibold text-emerald-300 hover:text-white transition-colors cursor-pointer ${LAUNCH_BUTTON_FOCUS_CLASSES}`}
              >
                <Wrench className="w-3.5 h-3.5" aria-hidden="true" />
                <span>
                  {hostCapabilities.supportsWindowsTranslation
                    ? 'Runner & Bottle Setup…'
                    : 'System Setup Wizard…'}
                </span>
              </button>
            </div>
          </div>
        </div>

        <SettingsFooter
          saveError={saveError}
          showDiscardConfirm={showDiscardConfirm}
          unsavedWarningId={unsavedWarningId}
          discardBtnRef={discardBtnRef}
          isDirty={isDirty}
          isSaving={isSaving}
          onResetToDefaults={handleResetToDefaults}
          onDiscardAndClose={handleDiscardAndClose}
          onRequestClose={handleRequestClose}
        />
      </form>
    </ModalShell>
  );
};
