import React from 'react';
import { AlertTriangle, RotateCcw, Save } from 'lucide-react';
import { LAUNCH_BUTTON_FOCUS_CLASSES } from '../Launcher/LaunchConfig/LaunchConfigControls';

export interface SettingsFooterProps {
  saveError: string | null;
  showDiscardConfirm: boolean;
  unsavedWarningId: string;
  discardBtnRef: React.MutableRefObject<HTMLButtonElement | null>;
  isDirty: boolean;
  isSaving: boolean;
  onResetToDefaults: () => void;
  onDiscardAndClose: () => void;
  onRequestClose: () => void;
}

export const SettingsFooter: React.FC<SettingsFooterProps> = ({
  saveError,
  showDiscardConfirm,
  unsavedWarningId,
  discardBtnRef,
  isDirty,
  isSaving,
  onResetToDefaults,
  onDiscardAndClose,
  onRequestClose,
}) => (
  <>
    {saveError && (
      <div
        data-testid="settings-save-error"
        role="alert"
        className="mx-5 mb-2 rounded-lg bg-red-950/70 border border-red-500/50 px-3 py-2 text-xs text-red-200 flex items-center gap-2 shrink-0"
      >
        <AlertTriangle className="w-4 h-4 text-red-400 shrink-0" aria-hidden="true" />
        <span>{saveError}</span>
      </div>
    )}

    {/* Reserved-space unsaved-changes confirmation bar (zero layout shift + aria-describedby target!) */}
    <div
      data-testid="settings-unsaved-confirm-bar"
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
      <span id={unsavedWarningId} role="status" aria-live="polite" className="text-amber-200">
        {showDiscardConfirm
          ? 'You have unsaved changes. Save settings or discard changes to close.'
          : ''}
      </span>
    </div>

    {/* Footer */}
    <div className="px-5 py-3.5 bg-[#0e151f] border-t border-[#223447] flex flex-wrap items-center justify-between gap-3 shrink-0">
      <button
        type="button"
        data-testid="settings-reset-defaults-btn"
        onClick={onResetToDefaults}
        disabled={isSaving}
        className={`inline-flex items-center gap-1.5 min-h-[28px] px-3 py-2 rounded-lg bg-[#17212e] hover:bg-[#223144] border border-[#2a475e] text-xs font-semibold text-steam-subtext hover:text-white transition-colors cursor-pointer disabled:opacity-50 ${LAUNCH_BUTTON_FOCUS_CLASSES}`}
      >
        <RotateCcw className="w-3.5 h-3.5" aria-hidden="true" />
        <span>Reset to Defaults</span>
      </button>

      <div className="flex items-center gap-2.5">
        <button
          ref={discardBtnRef}
          type="button"
          data-testid="settings-discard-changes-btn"
          onClick={onDiscardAndClose}
          disabled={!showDiscardConfirm || isSaving}
          tabIndex={showDiscardConfirm ? 0 : -1}
          aria-hidden={!showDiscardConfirm}
          aria-describedby={showDiscardConfirm ? unsavedWarningId : undefined}
          style={{ visibility: showDiscardConfirm ? 'visible' : 'hidden' }}
          className={`min-h-[28px] px-3.5 py-2 rounded-lg bg-rose-950/75 hover:bg-rose-900/80 border border-rose-500/50 text-xs font-semibold text-rose-200 hover:text-white transition-colors cursor-pointer ${LAUNCH_BUTTON_FOCUS_CLASSES}`}
        >
          Discard Changes
        </button>
        <button
          type="button"
          data-testid="settings-cancel-btn"
          onClick={onRequestClose}
          disabled={isSaving}
          className={`min-h-[28px] px-4 py-2 rounded-lg bg-[#1b2838] hover:bg-[#24354a] text-xs font-semibold text-steam-text hover:text-white transition-colors cursor-pointer disabled:opacity-50 ${LAUNCH_BUTTON_FOCUS_CLASSES}`}
        >
          Cancel
        </button>
        <button
          type="submit"
          data-testid="settings-save-btn"
          data-has-unsaved-changes={isDirty ? 'true' : 'false'}
          disabled={isSaving}
          className={`inline-flex items-center gap-1.5 min-h-[28px] px-5 py-2 rounded-lg font-bold text-xs text-white uppercase tracking-wider transition-opacity shadow-lg hover:brightness-110 disabled:opacity-50 cursor-pointer ${LAUNCH_BUTTON_FOCUS_CLASSES}`}
          style={{
            background: 'linear-gradient(to right, #059669 0%, #047857 100%)',
            boxShadow: '0 0 16px rgba(16, 185, 129, 0.35)',
          }}
        >
          <Save className="w-3.5 h-3.5" aria-hidden="true" />
          <span>{isSaving ? 'Saving...' : 'Save Settings'}</span>
        </button>
      </div>
    </div>
  </>
);
