import React from 'react';
import type {
  EnvironmentComponentId,
  EnvironmentComponentState,
  EnvironmentSetupProgressEvent,
  EnvironmentSetupTaskOutcome,
  EnvironmentSetupTaskRequest,
} from '../../../../contracts/environmentSetup';
import { formatBytes } from '../../../../utils/formatBytes';
import {
  AlertCircle,
  AlertTriangle,
  CheckCircle2,
  ExternalLink,
  Loader2,
  StopCircle,
  Wrench,
} from 'lucide-react';

export interface ProvisioningProgressPanelProps {
  plannedTasks: EnvironmentSetupTaskRequest[];
  components: Record<EnvironmentComponentId, EnvironmentComponentState>;
  isRunning: boolean;
  latestProgress: EnvironmentSetupProgressEvent | null;
  progressHistory?: EnvironmentSetupProgressEvent[];
  outcomes: EnvironmentSetupTaskOutcome[];
  lastRunError: string | null;
  pendingSignInCount?: number;
  onCancelProvisioning: () => void;
}

function describeTaskAction(
  task: EnvironmentSetupTaskRequest,
  components: Record<EnvironmentComponentId, EnvironmentComponentState>
): string {
  const compTitle = components[task.componentId]?.title || task.componentId;
  switch (task.action) {
    case 'install_rosetta2':
      return 'Install Apple Rosetta 2';
    case 'install_win_vcredist':
      return 'Install Microsoft Visual C++';
    case 'install_runner':
      return `Install ${compTitle}`;
    case 'ensure_bottle':
      return task.bottleMode === 'reuse_existing'
        ? `Set up existing "${task.bottleName || 'OneLauncher'}" bottle`
        : `Create "${task.bottleName || 'OneLauncher'}" bottle`;
    case 'install_client':
      return `Install ${compTitle}`;
    case 'sync_first_party_manifests':
      return 'Sync installed game folders';
    default:
      return compTitle;
  }
}

function renderOutcomeBadge(
  status: EnvironmentSetupTaskOutcome['status']
): React.ReactElement {
  switch (status) {
    case 'completed':
      return (
        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-emerald-500/20 border border-emerald-500/40 text-[10px] font-bold text-emerald-300">
          <CheckCircle2 className="w-3 h-3 text-emerald-400" aria-hidden="true" />
          <span>Installed</span>
        </span>
      );
    case 'skipped':
      return (
        <span className="inline-flex items-center px-2 py-0.5 rounded bg-[#1b2838] border border-[#2a475e] text-[10px] font-semibold text-slate-300">
          Skipped
        </span>
      );
    case 'opened_external':
      return (
        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-sky-500/20 border border-sky-400/50 text-[10px] font-bold text-sky-200">
          <ExternalLink className="w-3 h-3" aria-hidden="true" />
          <span>Opened Download</span>
        </span>
      );
    case 'cancelled':
      return (
        <span className="inline-flex items-center px-2 py-0.5 rounded bg-amber-500/20 border border-amber-500/40 text-[10px] font-bold text-amber-200">
          Cancelled
        </span>
      );
    case 'failed':
    default:
      return (
        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-rose-500/20 border border-rose-500/40 text-[10px] font-bold text-rose-200">
          <AlertCircle className="w-3 h-3 text-rose-400" aria-hidden="true" />
          <span>Failed</span>
        </span>
      );
  }
}

export const ProvisioningProgressPanel: React.FC<ProvisioningProgressPanelProps> = ({
  plannedTasks,
  components,
  isRunning,
  latestProgress,
  outcomes,
  lastRunError,
  pendingSignInCount = 0,
  onCancelProvisioning,
}) => {
  const completedCount = outcomes.filter((o) => o.status === 'completed').length;
  const failedCount = outcomes.filter((o) => o.status === 'failed').length;
  const hasFailure = Boolean(lastRunError) || failedCount > 0;
  const wasCancelled = !hasFailure && outcomes.some((o) => o.status === 'cancelled');

  const determinatePercent =
    typeof latestProgress?.progressPercent === 'number' &&
    Number.isFinite(latestProgress.progressPercent)
      ? Math.max(0, Math.min(100, Math.round(latestProgress.progressPercent)))
      : !isRunning && outcomes.length > 0
        ? 100
        : undefined;

  const statusAnnouncement = isRunning
    ? latestProgress?.message || 'Installing selected items...'
    : outcomes.length > 0
      ? hasFailure
        ? `Setup finished with ${failedCount || 1} issue${
            (failedCount || 1) === 1 ? '' : 's'
          } (${completedCount} of ${outcomes.length} completed).`
        : wasCancelled
          ? 'Installation cancelled.'
          : `Setup complete (${completedCount} installed).`
      : hasFailure
        ? 'Setup finished with 1 issue.'
        : plannedTasks.length > 0
          ? `${plannedTasks.length} item${plannedTasks.length === 1 ? '' : 's'} ready to install.`
          : 'Everything you selected is already installed.';

  return (
    <div className="space-y-3.5" data-testid="provisioning-progress-panel">
      {/* Live Progress Bar & Polite Status Region */}
      {(isRunning || outcomes.length > 0 || hasFailure) && (
        <div className="rounded-lg bg-[#16202d] border border-[#2a475e]/80 p-3.5 space-y-2.5">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div
              role="status"
              aria-live="polite"
              className="flex items-center gap-2 text-xs font-semibold text-white min-w-0"
            >
              {isRunning ? (
                <Loader2
                  className="w-4 h-4 text-[#66c0f4] shrink-0 ol-guided-spinner"
                  aria-hidden="true"
                />
              ) : hasFailure ? (
                <AlertCircle className="w-4 h-4 text-rose-400 shrink-0" aria-hidden="true" />
              ) : wasCancelled ? (
                <AlertTriangle className="w-4 h-4 text-amber-400 shrink-0" aria-hidden="true" />
              ) : (
                <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" aria-hidden="true" />
              )}
              <span className="truncate">{statusAnnouncement}</span>
            </div>

            <div className="flex items-center gap-2.5 shrink-0">
              {latestProgress && latestProgress.totalSteps > 0 && isRunning && (
                <span className="text-[11px] text-slate-300">
                  {Math.min(latestProgress.stepIndex + 1, latestProgress.totalSteps)} of{' '}
                  {latestProgress.totalSteps}
                </span>
              )}
              {typeof determinatePercent === 'number' && (
                <span className="text-[11px] font-mono font-bold text-[#66c0f4]">
                  {determinatePercent}%
                </span>
              )}
              {isRunning && (
                <button
                  type="button"
                  data-testid="cancel-provisioning-btn"
                  onClick={onCancelProvisioning}
                  className="min-h-6 inline-flex items-center gap-1 px-2.5 py-1 rounded-md bg-rose-950/60 hover:bg-rose-900/70 border border-rose-500/50 text-[11px] font-bold text-rose-200 hover:text-white transition-colors cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#66c0f4]"
                >
                  <StopCircle className="w-3.5 h-3.5" aria-hidden="true" />
                  <span>Cancel</span>
                </button>
              )}
            </div>
          </div>

          <progress
            className="ol-setup-progress w-full h-2.5 block"
            max={100}
            value={determinatePercent}
            aria-label="Installation progress"
            aria-valuetext={
              isRunning && latestProgress?.message ? latestProgress.message : undefined
            }
          />

          {latestProgress &&
            isRunning &&
            typeof latestProgress.bytesDownloaded === 'number' &&
            latestProgress.bytesDownloaded > 0 && (
              <div className="text-[11px] font-mono text-slate-300 flex items-center justify-end">
                <span>
                  {formatBytes(latestProgress.bytesDownloaded)}
                  {typeof latestProgress.totalBytes === 'number' && latestProgress.totalBytes > 0
                    ? ` / ${formatBytes(latestProgress.totalBytes)}`
                    : ''}
                </span>
              </div>
            )}

          {lastRunError && !isRunning && (
            <div
              role="alert"
              className="rounded bg-rose-950/60 border border-rose-500/50 px-3 py-2 text-xs text-rose-200 flex items-center gap-2"
            >
              <AlertCircle className="w-4 h-4 text-rose-400 shrink-0" aria-hidden="true" />
              <span>{lastRunError}</span>
            </div>
          )}
        </div>
      )}

      {/* Polite status announcer when idle before run */}
      {!isRunning && outcomes.length === 0 && !hasFailure && (
        <div role="status" aria-live="polite" className="sr-only">
          {statusAnnouncement}
        </div>
      )}

      {/* Task Outcomes (Post-Run or Partial Run) */}
      {outcomes.length > 0 && (
        <div className="rounded-lg bg-[#16202d] border border-[#2a475e]/80 p-3.5 space-y-2.5">
          <div className="text-xs font-semibold uppercase tracking-wider text-slate-300">
            Installed Items ({outcomes.length})
          </div>
          <div className="space-y-1.5">
            {outcomes.map((outcome, idx) => {
              const compTitle =
                components[outcome.componentId]?.title || outcome.componentId;
              return (
                <div
                  key={`${outcome.componentId}-${outcome.action}-${idx}`}
                  data-testid={`setup-outcome-${outcome.componentId}-${outcome.action}`}
                  className="rounded-md bg-[#131c27] border border-[#2a475e]/70 px-3 py-2 flex flex-wrap items-center justify-between gap-2 text-xs"
                >
                  <div className="space-y-0.5 min-w-0 flex-1">
                    <div className="font-semibold text-white truncate">{compTitle}</div>
                    {outcome.error && (
                      <div className="text-[11px] text-rose-200">{outcome.error}</div>
                    )}
                  </div>
                  {renderOutcomeBadge(outcome.status)}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Planned Install Queue */}
      {plannedTasks.length > 0 ? (
        <div className="rounded-lg bg-[#16202d] border border-[#2a475e]/80 p-3.5 space-y-2.5">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="text-xs font-semibold uppercase tracking-wider text-slate-300 flex items-center gap-1.5">
              <Wrench className="w-3.5 h-3.5 text-[#66c0f4]" aria-hidden="true" />
              <span>Items to Install ({plannedTasks.length})</span>
            </div>
            <span className="text-[11px] text-slate-300">
              Already-installed apps won&rsquo;t be touched
            </span>
          </div>

          <ol className="space-y-1.5 list-none">
            {plannedTasks.map((task, idx) => (
              <li
                key={`${task.componentId}-${task.action}-${idx}`}
                data-testid={`planned-task-${task.componentId}-${task.action}`}
                className="rounded-md bg-[#131c27] border border-[#2a475e]/70 px-3 py-2 text-xs text-white font-medium"
              >
                <span className="text-slate-300 mr-1.5" aria-hidden="true">
                  {idx + 1}.
                </span>
                {describeTaskAction(task, components)}
              </li>
            ))}
          </ol>
        </div>
      ) : (
        outcomes.length === 0 &&
        !hasFailure && (
          <div className="rounded-lg bg-[#16202d] border border-emerald-500/45 px-3.5 py-3 text-xs text-emerald-200 flex items-center gap-2">
            <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" aria-hidden="true" />
            <span>
              {pendingSignInCount > 0
                ? 'Everything you selected is already installed. Next, sign in to your launchers.'
                : 'Everything you selected is already installed.'}
            </span>
          </div>
        )
      )}
    </div>
  );
};
