import React from 'react';
import { X } from 'lucide-react';
import { ModalShell } from '../../Common/ModalShell';

export interface RenderAboutModalArgs {
  isOpen: boolean;
  onClose: () => void;
  appVersion: string;
}

export function renderAboutModal({
  isOpen,
  onClose,
  appVersion,
}: RenderAboutModalArgs): React.ReactElement {
  return (
    <ModalShell
      isOpen={isOpen}
      onClose={onClose}
      ariaLabelledBy="about-one-launcher-title"
      testId="about-one-launcher-modal"
      className="w-full max-w-md rounded-xl border border-steam-border bg-[#131b26] p-6 shadow-2xl"
    >
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 id="about-one-launcher-title" className="text-base font-bold text-white">
            One Launcher
          </h2>
          {appVersion && (
            <p className="mt-0.5 text-xs text-slate-400 font-mono">Version v{appVersion}</p>
          )}
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close About dialog"
          className="min-w-6 min-h-6 inline-flex items-center justify-center rounded-lg p-1.5 text-slate-300 hover:bg-white/10 hover:text-white transition-colors cursor-pointer"
        >
          <X className="w-4 h-4" aria-hidden="true" />
        </button>
      </div>
      <p className="mt-3 text-xs leading-relaxed text-slate-300">
        Unified multi-storefront PC &amp; macOS game library, trophy tracker, and launch
        orchestrator.
      </p>
      <div className="mt-5 flex justify-end">
        <button
          type="button"
          onClick={onClose}
          className="rounded-lg bg-steam-accent px-4 py-1.5 text-xs font-bold text-black hover:brightness-110 transition-all cursor-pointer"
        >
          Close
        </button>
      </div>
    </ModalShell>
  );
}
