import React from 'react';
import type {
  EnvironmentComponentId,
  EnvironmentComponentState,
  EnvironmentHealthSnapshot,
  SetupWizardOpenMode,
} from '../../../../contracts/environmentSetup';
import {
  AlertTriangle,
  CheckCircle2,
  ExternalLink,
  RefreshCw,
} from 'lucide-react';

export interface HostPrerequisitesStepProps {
  snapshot: EnvironmentHealthSnapshot;
  mode: SetupWizardOpenMode;
  selectedIds: ReadonlySet<EnvironmentComponentId>;
  forceRepairIds: ReadonlySet<EnvironmentComponentId>;
  focusComponentId?: EnvironmentComponentId;
  onToggleComponent: (id: EnvironmentComponentId) => void;
  onToggleForceRepair: (id: EnvironmentComponentId) => void;
}

function renderStatusPill(comp: EnvironmentComponentState): React.ReactElement {
  if (comp.wasPreviouslyConfigured && comp.status === 'missing') {
    return (
      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-amber-500/20 border border-amber-400/50 text-[10px] font-bold text-amber-200">
        <AlertTriangle className="w-3 h-3 text-amber-400 shrink-0" aria-hidden="true" />
        <span>Removed</span>
      </span>
    );
  }
  if (comp.status === 'ready') {
    return (
      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-emerald-500/20 border border-emerald-500/40 text-[10px] font-bold text-emerald-300">
        <CheckCircle2 className="w-3 h-3 text-emerald-400 shrink-0" aria-hidden="true" />
        <span>Installed</span>
      </span>
    );
  }
  if (comp.status === 'partially_configured') {
    return (
      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-amber-500/20 border border-amber-500/40 text-[10px] font-bold text-amber-200">
        <span>Needs Setup</span>
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-amber-500/20 border border-amber-500/40 text-[10px] font-bold text-amber-200">
      <span>Needed</span>
    </span>
  );
}

export const HostPrerequisitesStep: React.FC<HostPrerequisitesStepProps> = ({
  snapshot,
  mode,
  selectedIds,
  forceRepairIds,
  focusComponentId,
  onToggleComponent,
  onToggleForceRepair,
}) => {
  const isMac = snapshot.hostPlatform === 'darwin';
  const isWin = snapshot.hostPlatform === 'win32';
  const isAppleSiliconMac = isMac && snapshot.isAppleSiliconMac;
  const isRepairCapableMode = mode === 'health_check' || mode === 'repair';

  const handleOpenExternal = (url?: string) => {
    if (!url) return;
    const api = typeof window !== 'undefined' ? window.electronAPI : undefined;
    if (typeof api?.openExternalUrl === 'function') {
      void api.openExternalUrl(url);
    } else if (typeof api?.openExternal === 'function') {
      void api.openExternal(url);
    } else if (typeof window !== 'undefined') {
      window.open(url, '_blank', 'noopener,noreferrer');
    }
  };

  const renderPrerequisiteCard = (
    comp: EnvironmentComponentState,
    options?: {
      badgeOverride?: string;
      explanationOverride?: string;
    }
  ) => {
    const isReady = comp.status === 'ready';
    const isForceRepair = forceRepairIds.has(comp.id);
    const isChecked = isReady ? isForceRepair : selectedIds.has(comp.id);
    const isFocused = focusComponentId === comp.id;
    const canToggle = comp.canAutoInstall || isReady;

    return (
      <div
        key={comp.id}
        data-testid={`setup-prereq-card-${comp.id}`}
        className={`rounded-lg border p-3.5 transition-all ${
          isFocused
            ? 'bg-[#1b2838] border-[#66c0f4] shadow-lg shadow-[#66c0f4]/10'
            : comp.wasPreviouslyConfigured && comp.status === 'missing'
              ? 'bg-amber-950/30 border-amber-500/50'
              : isReady && !isForceRepair
                ? 'bg-[#16202d] border-emerald-500/45'
                : isChecked
                  ? 'bg-[#1b2838] border-[#66c0f4]/75'
                  : 'bg-[#16202d] border-[#2a475e]/80'
        }`}
      >
        <div className="flex flex-wrap items-start justify-between gap-2.5">
          <div className="flex items-start gap-2.5 min-w-0 flex-1">
            {comp.canAutoInstall && (
              <input
                type="checkbox"
                data-testid={`setup-toggle-${comp.id}`}
                aria-label={`Select ${comp.title}`}
                checked={isChecked}
                disabled={!canToggle || (isReady && !isRepairCapableMode)}
                onChange={() => {
                  if (isReady) {
                    if (isRepairCapableMode) {
                      onToggleForceRepair(comp.id);
                    }
                  } else {
                    onToggleComponent(comp.id);
                  }
                }}
                className="mt-0.5 w-4 h-4 rounded border-[#2a475e] bg-[#131c27] text-[#66c0f4] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#66c0f4] cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed shrink-0"
              />
            )}
            <div className="space-y-1 min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-xs font-bold text-white">{comp.title}</span>
                {!isReady && (
                  <span
                    className={`text-[10px] px-2 py-0.5 rounded border font-semibold ${
                      comp.recommendationTier === 'required'
                        ? 'bg-sky-500/20 border-sky-400/50 text-sky-200'
                        : 'bg-emerald-500/15 border-emerald-400/40 text-emerald-200'
                    }`}
                  >
                    {options?.badgeOverride || comp.recommendationBadge}
                  </span>
                )}
              </div>
              <p className="text-xs text-slate-300 leading-relaxed">
                {options?.explanationOverride || comp.whyExplanation}
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2 shrink-0">
            {renderStatusPill(comp)}
            {!isReady && comp.requiresExternalDownload && comp.externalDownloadUrl && (
              <button
                type="button"
                onClick={() => handleOpenExternal(comp.externalDownloadUrl)}
                className="min-h-6 inline-flex items-center gap-1 px-2.5 py-1 rounded-md bg-[#131c27] hover:bg-[#2a475e] border border-[#2a475e] text-[11px] font-semibold text-[#66c0f4] hover:text-white transition-colors cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#66c0f4]"
              >
                <ExternalLink className="w-3 h-3" aria-hidden="true" />
                <span>Download</span>
              </button>
            )}
            {isReady && isRepairCapableMode && comp.canAutoInstall && (
              <button
                type="button"
                data-testid={`setup-force-repair-${comp.id}`}
                onClick={() => onToggleForceRepair(comp.id)}
                className={`min-h-6 px-2.5 py-1 rounded-md border text-[11px] font-semibold transition-colors cursor-pointer inline-flex items-center gap-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#66c0f4] ${
                  isForceRepair
                    ? 'bg-amber-500/20 border-amber-400 text-amber-200'
                    : 'bg-[#1b2838] hover:bg-[#24354a] border-[#2a475e] text-slate-200 hover:text-white hover:border-[#66c0f4]'
                }`}
              >
                <RefreshCw className="w-3 h-3" aria-hidden="true" />
                <span>{isForceRepair ? 'Queued' : 'Reinstall'}</span>
              </button>
            )}
          </div>
        </div>
      </div>
    );
  };

  const webviewMissingOnWin =
    isWin && snapshot.components.win_webview2?.status === 'missing';

  const introCopy = isAppleSiliconMac
    ? 'Quick check to make sure your Mac has Apple’s built-in support for Windows and Intel Mac games. Missing items install automatically.'
    : isMac
      ? 'Quick check to make sure your Mac is ready before connecting your game accounts.'
      : isWin
        ? 'Quick check to make sure your PC has the standard Microsoft support files most Windows games need.'
        : 'Quick check to make sure your computer is ready to run games.';

  return (
    <div className="space-y-3.5" data-testid="setup-step-prerequisites">
      <div className="p-3 rounded-lg bg-[#131c27] border border-[#2a475e]/80 text-xs text-slate-200 leading-relaxed">
        {introCopy}
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-xs font-semibold uppercase tracking-wider text-slate-300">
          {isMac ? 'macOS System Check' : isWin ? 'Windows System Check' : 'System Check'}
        </span>
        <span className="text-[11px] text-slate-300">Checked automatically</span>
      </div>

      {isMac &&
        isAppleSiliconMac &&
        renderPrerequisiteCard(snapshot.components.rosetta2, {
          badgeOverride: 'Required',
          explanationOverride:
            'Built-in Apple tool that lets your Mac run Windows games and older Mac games.',
        })}

      {isMac && !isAppleSiliconMac && (
        <div
          data-testid="setup-prereq-card-rosetta2"
          className="rounded-lg bg-[#16202d] border border-emerald-500/45 p-3.5 flex items-center gap-2.5"
        >
          <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" aria-hidden="true" />
          <div className="text-xs text-slate-200">
            <strong className="text-white">Your Mac is ready.</strong> No extra system software is
            needed before connecting your game accounts.
          </div>
        </div>
      )}

      {isWin && (
        <div className="space-y-2.5">
          {renderPrerequisiteCard(snapshot.components.win_vcredist, {
            badgeOverride: 'Recommended',
            explanationOverride: 'Standard Microsoft support files needed by most PC games.',
          })}
          {webviewMissingOnWin && renderPrerequisiteCard(snapshot.components.win_webview2)}
        </div>
      )}

      {!isMac && !isWin && (
        <div className="rounded-lg bg-[#16202d] border border-emerald-500/45 p-3.5 flex items-center gap-2.5">
          <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" aria-hidden="true" />
          <div className="text-xs text-slate-200">
            <strong className="text-white">Your computer is ready.</strong> Click Next to connect
            your game accounts.
          </div>
        </div>
      )}
    </div>
  );
};
