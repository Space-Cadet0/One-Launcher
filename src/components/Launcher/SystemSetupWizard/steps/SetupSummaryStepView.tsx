import React from 'react';
import { KeyRound } from 'lucide-react';
import type {
  ClientLoginTargetId,
  EnvironmentHealthSnapshot,
  EnvironmentSetupProgressEvent,
  EnvironmentSetupTaskOutcome,
  EnvironmentSetupTaskRequest,
} from '../../../../contracts/environmentSetup';
import type { CompatibilityLayerType } from '../../../../contracts/launcher';
import type { StorefrontId } from '../../../../contracts/platform';
import { getStorefrontDisplayName } from '../../../Common/StorefrontIcon';
import { formatRunnerLabel } from '../setupWizardHelpers';
import { ProvisioningProgressPanel } from './ProvisioningProgressPanel';

export interface SetupSummaryStepViewProps {
  snapshot: EnvironmentHealthSnapshot;
  liveConnectedStorefronts: StorefrontId[];
  isMacHost: boolean;
  isWinHost: boolean;
  winPrereqsReady: boolean;
  chosenRunner: Exclude<CompatibilityLayerType, 'native'> | 'skip';
  effectiveBottleName: string;
  pendingActionableLogins: number;
  isProvisioningRunning: boolean;
  activeGuidedLoginTarget: ClientLoginTargetId | null;
  plannedTasks: EnvironmentSetupTaskRequest[];
  latestProgress: EnvironmentSetupProgressEvent | null;
  outcomes: EnvironmentSetupTaskOutcome[];
  lastRunError: string | null;
  onCancelProvisioning: () => void;
  onGoToClientLogins: () => void;
}

export const SetupSummaryStepView: React.FC<SetupSummaryStepViewProps> = ({
  snapshot,
  liveConnectedStorefronts,
  isMacHost,
  isWinHost,
  winPrereqsReady,
  chosenRunner,
  effectiveBottleName,
  pendingActionableLogins,
  isProvisioningRunning,
  activeGuidedLoginTarget,
  plannedTasks,
  latestProgress,
  outcomes,
  lastRunError,
  onCancelProvisioning,
  onGoToClientLogins,
}) => {
  return (
    <div className="space-y-4" data-testid="setup-step-summary">
      {/* Review Summary Grid (OS-Dynamic) */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <div className="rounded-lg bg-[#16202d] border border-[#2a475e]/80 p-3.5 space-y-1">
          <div className="text-[10px] font-semibold uppercase tracking-wider text-slate-300">
            Connected Stores
          </div>
          <div className="text-sm font-bold text-white">
            {liveConnectedStorefronts.length > 0
              ? liveConnectedStorefronts.map((s) => getStorefrontDisplayName(s)).join(', ')
              : 'None connected'}
          </div>
        </div>

        <div className="rounded-lg bg-[#16202d] border border-[#2a475e]/80 p-3.5 space-y-1">
          <div className="text-[10px] font-semibold uppercase tracking-wider text-slate-300">
            {isMacHost ? 'Windows on Mac' : isWinHost ? 'System Components' : 'System'}
          </div>
          <div className="text-sm font-bold text-white truncate">
            {isMacHost ? (
              chosenRunner === 'skip' ? (
                'Mac games only'
              ) : (
                `${formatRunnerLabel(chosenRunner)} • "${effectiveBottleName}"`
              )
            ) : isWinHost ? (
              winPrereqsReady ? (
                <span className="text-emerald-300">Ready</span>
              ) : (
                'Microsoft Visual C++'
              )
            ) : (
              <span className="text-emerald-300">Ready</span>
            )}
          </div>
        </div>

        <div className="rounded-lg bg-[#16202d] border border-[#2a475e]/80 p-3.5 space-y-1">
          <div className="text-[10px] font-semibold uppercase tracking-wider text-slate-300">
            Launcher Sign-Ins
          </div>
          <div className="text-sm font-bold text-white">
            {pendingActionableLogins > 0 ? (
              <button
                type="button"
                disabled={isProvisioningRunning || activeGuidedLoginTarget !== null}
                onClick={onGoToClientLogins}
                className="min-h-6 inline-flex items-center text-amber-300 hover:text-amber-200 underline cursor-pointer disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#66c0f4] rounded"
              >
                {pendingActionableLogins} need sign-in →
              </button>
            ) : (
              <span className="text-emerald-300">Ready</span>
            )}
          </div>
        </div>
      </div>

      <ProvisioningProgressPanel
        plannedTasks={plannedTasks}
        components={snapshot.components}
        isRunning={isProvisioningRunning}
        latestProgress={latestProgress}
        outcomes={outcomes}
        lastRunError={lastRunError}
        pendingSignInCount={pendingActionableLogins}
        onCancelProvisioning={onCancelProvisioning}
      />

      {!isProvisioningRunning &&
        outcomes.length > 0 &&
        !lastRunError &&
        pendingActionableLogins > 0 && (
          <div
            data-testid="post-provision-signin-callout"
            className="rounded-lg bg-[#131c27] border border-[#66c0f4]/55 p-3.5 flex flex-wrap items-center justify-between gap-3"
          >
            <div className="flex items-start gap-2.5 min-w-0 flex-1">
              <KeyRound className="w-4 h-4 text-[#66c0f4] shrink-0 mt-0.5" aria-hidden="true" />
              <div className="space-y-0.5 min-w-0">
                <div className="text-xs font-bold text-white">
                  {pendingActionableLogins} launcher
                  {pendingActionableLogins === 1 ? ' needs' : 's need'} sign-in
                </div>
                <p className="text-[11px] text-slate-200 leading-relaxed">
                  Sign in once now so your game downloads start right away.
                </p>
              </div>
            </div>
            <button
              type="button"
              data-testid="continue-to-guided-signins-btn"
              onClick={onGoToClientLogins}
              className="min-h-6 inline-flex items-center gap-1.5 px-4 py-2 rounded-md bg-[#66c0f4] text-slate-950 font-bold hover:brightness-110 transition-all text-xs shadow cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#66c0f4] shrink-0"
            >
              <span>Sign In Now ({pendingActionableLogins}) →</span>
            </button>
          </div>
        )}
    </div>
  );
};
