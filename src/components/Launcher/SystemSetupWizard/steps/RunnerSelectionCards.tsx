import React from 'react';
import { AlertTriangle, ArrowUpCircle, CheckCircle2, Circle } from 'lucide-react';
import type {
  EnvironmentComponentId,
  EnvironmentComponentState,
} from '../../../../contracts/environmentSetup';
import type { CompatibilityLayerType } from '../../../../contracts/launcher';
import {
  LAUNCH_BUTTON_FOCUS_CLASSES,
  SwitchControl,
} from '../../LaunchConfig/LaunchConfigControls';

export type SetupRunnerChoice = Exclude<CompatibilityLayerType, 'native'> | 'skip';

export interface RunnerCardRenderEntry {
  runner: SetupRunnerChoice;
  slug: string;
  testId: string;
  title: string;
  badgeText: string;
  badgeClassName: string;
  description: React.ReactNode;
  component?: EnvironmentComponentState;
  installed: boolean;
  removed: boolean;
  statusNote: React.ReactNode;
  statusNoteClassName: string;
  updateOptInRunner?: Exclude<CompatibilityLayerType, 'native'>;
}

export interface RunnerSelectionCardsParams {
  installedLayerLabels: string[];
  chosenRunner: SetupRunnerChoice;
  runnerOptions: ReadonlyArray<SetupRunnerChoice>;
  selectedRunnerIndex: number;
  runnerRadioRefs: React.MutableRefObject<Array<HTMLButtonElement | null>>;
  entries: ReadonlyArray<RunnerCardRenderEntry>;
  onKeyDown: (e: React.KeyboardEvent<HTMLDivElement>) => void;
  onSelectRunnerCard: (runner: SetupRunnerChoice, comp?: EnvironmentComponentState) => void;
  isRunnerUpdateOptedIn: (componentId: EnvironmentComponentId) => boolean;
  onToggleRunnerUpdate: (
    componentId: EnvironmentComponentId,
    runnerType: Exclude<CompatibilityLayerType, 'native'>,
    nextEnabled: boolean
  ) => void;
}

function renderInstallStatusBadge(
  testId: string,
  installed: boolean,
  removed: boolean,
  installedText = 'Installed'
): React.ReactElement {
  if (installed) {
    return (
      <span
        data-testid={testId}
        className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-emerald-500/20 border border-emerald-400/60 text-[10px] font-bold text-emerald-200"
      >
        <CheckCircle2 className="w-3 h-3 text-emerald-400 shrink-0" aria-hidden="true" />
        <span>{installedText}</span>
      </span>
    );
  }
  if (removed) {
    return (
      <span
        data-testid={testId}
        className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-amber-500/20 border border-amber-400/60 text-[10px] font-bold text-amber-200"
      >
        <AlertTriangle className="w-3 h-3 text-amber-400 shrink-0" aria-hidden="true" />
        <span>Not Installed (Removed)</span>
      </span>
    );
  }
  return (
    <span
      data-testid={testId}
      className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-[#101721] border border-slate-400/50 text-[10px] font-semibold text-slate-200"
    >
      <Circle className="w-2.5 h-2.5 text-slate-300 shrink-0" aria-hidden="true" />
      <span>Not Installed</span>
    </span>
  );
}

function renderUpdateAvailableBadge(
  slug: string,
  comp?: EnvironmentComponentState
): React.ReactElement | null {
  if (comp?.status !== 'update_available') return null;
  return (
    <span
      data-testid={`runner-update-badge-${slug}`}
      className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-amber-500/20 border border-amber-400/60 text-[10px] font-bold text-amber-200"
    >
      <ArrowUpCircle className="w-3 h-3 text-amber-300 shrink-0" aria-hidden="true" />
      <span>
        {comp.latestVersion ? `Update Available · v${comp.latestVersion}` : 'Update Available'}
      </span>
    </span>
  );
}

function getRunnerCardShellClass(isSelected: boolean): string {
  return `rounded-lg border transition-all flex flex-col justify-between ${
    isSelected
      ? 'bg-[#1b2838] border-[#66c0f4] shadow-lg shadow-[#66c0f4]/10'
      : 'bg-[#16202d] border-[#2a475e]/80 hover:border-[#66c0f4]/70 hover:bg-[#1b2838]/80'
  }`;
}

export function renderRunnerSelectionCards({
  installedLayerLabels,
  chosenRunner,
  runnerOptions,
  selectedRunnerIndex,
  runnerRadioRefs,
  entries,
  onKeyDown,
  onSelectRunnerCard,
  isRunnerUpdateOptedIn,
  onToggleRunnerUpdate,
}: RunnerSelectionCardsParams): React.ReactElement {
  return (
    <div className="space-y-2.5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-300">
          Windows Game Support on Mac
        </h3>
        <span
          data-testid="compat-installed-summary"
          className={`inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded text-[11px] font-semibold border ${
            installedLayerLabels.length > 0
              ? 'bg-emerald-500/15 border-emerald-500/45 text-emerald-200'
              : 'bg-[#131c27] border-[#2a475e] text-slate-300'
          }`}
        >
          {installedLayerLabels.length > 0 ? (
            <>
              <CheckCircle2 className="w-3 h-3 text-emerald-400 shrink-0" aria-hidden="true" />
              <span>Installed on this Mac: {installedLayerLabels.join(', ')}</span>
            </>
          ) : (
            <>
              <Circle className="w-2.5 h-2.5 text-slate-300 shrink-0" aria-hidden="true" />
              <span>None installed on this Mac yet</span>
            </>
          )}
        </span>
      </div>

      <div
        className="grid grid-cols-1 sm:grid-cols-2 gap-3"
        role="radiogroup"
        aria-label="Windows game support"
        onKeyDown={onKeyDown}
      >
        {entries.map((entry) => {
          const optionIndex = runnerOptions.indexOf(entry.runner);
          const isSelected = chosenRunner === entry.runner;
          const isSkip = entry.runner === 'skip';
          const comp = entry.component;
          const showUpdateFooter =
            Boolean(entry.updateOptInRunner) && comp && comp.status === 'update_available';

          return (
            <div key={entry.runner} className={getRunnerCardShellClass(isSelected)}>
              <button
                ref={(el) => {
                  if (optionIndex >= 0) runnerRadioRefs.current[optionIndex] = el;
                }}
                type="button"
                role="radio"
                aria-checked={isSelected}
                tabIndex={selectedRunnerIndex === optionIndex ? 0 : -1}
                data-testid={entry.testId}
                onClick={() => onSelectRunnerCard(entry.runner, comp)}
                className={`min-h-6 w-full flex-1 text-left p-3.5 cursor-pointer flex flex-col justify-between gap-2 rounded-lg ${LAUNCH_BUTTON_FOCUS_CLASSES}`}
              >
                <div className="space-y-1.5">
                  <div className="flex flex-wrap items-center justify-between gap-1.5">
                    {isSkip ? (
                      <>
                        <span className="text-xs font-bold text-white">{entry.title}</span>
                        <span className={entry.badgeClassName}>{entry.badgeText}</span>
                      </>
                    ) : (
                      <>
                        <div className="flex flex-wrap items-center gap-1.5">
                          <span className="text-xs font-bold text-white">{entry.title}</span>
                          <span className={entry.badgeClassName}>{entry.badgeText}</span>
                        </div>
                        <div className="flex flex-wrap items-center gap-1.5">
                          {renderInstallStatusBadge(
                            `runner-install-status-${entry.slug}`,
                            entry.installed,
                            entry.removed
                          )}
                          {renderUpdateAvailableBadge(entry.slug, comp)}
                        </div>
                      </>
                    )}
                  </div>
                  <p className="text-[11px] text-slate-200 leading-relaxed">{entry.description}</p>
                </div>
                <div className={entry.statusNoteClassName}>{entry.statusNote}</div>
              </button>

              {showUpdateFooter && comp && entry.updateOptInRunner && (
                <div
                  data-testid={`runner-update-optin-row-${entry.slug}`}
                  className="flex items-center justify-between gap-2.5 border-t border-[#2a475e]/70 px-3.5 py-2.5 bg-[#131c27]/90 rounded-b-lg"
                >
                  <div className="min-w-0">
                    <div
                      id={`runner-update-optin-label-${entry.slug}`}
                      className="text-[11px] font-semibold text-amber-200"
                    >
                      {comp.latestVersion
                        ? `Update to v${comp.latestVersion} during setup`
                        : 'Update runner during setup'}
                    </div>
                    <p
                      id={`runner-update-optin-desc-${entry.slug}`}
                      className="text-[10px] text-slate-300 leading-snug"
                    >
                      {comp.version
                        ? `Currently v${comp.version} — optional in-place update.`
                        : 'Optional in-place update.'}
                    </p>
                  </div>
                  <SwitchControl
                    checked={isRunnerUpdateOptedIn(comp.id)}
                    onChange={() =>
                      onToggleRunnerUpdate(
                        comp.id,
                        entry.updateOptInRunner!,
                        !isRunnerUpdateOptedIn(comp.id)
                      )
                    }
                    ariaLabelledBy={`runner-update-optin-label-${entry.slug}`}
                    ariaDescribedBy={`runner-update-optin-desc-${entry.slug}`}
                    dataTestId={`runner-update-toggle-${entry.slug}`}
                    tone="amber"
                  />
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
