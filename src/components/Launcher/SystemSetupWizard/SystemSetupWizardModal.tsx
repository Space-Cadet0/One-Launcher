import React from 'react';
import type { CanonicalGame } from '../../../contracts/game';
import type { StorefrontId } from '../../../contracts/platform';
import type {
  EnvironmentComponentId,
  SetupWizardOpenMode,
  SetupWizardStepId,
} from '../../../contracts/environmentSetup';
import { environmentSetupService } from '../../../services/launcher/environmentSetupService';
import { getStorefrontDisplayName } from '../../Common/StorefrontIcon';
import { ModalShell } from '../../Common/ModalShell';
import { useSafeId } from '../../../utils/useSafeId';
import { HostPrerequisitesStep } from './steps/HostPrerequisitesStep';
import { StorefrontAccountsStep } from './steps/StorefrontAccountsStep';
import { CompatibilityAndBottleStep } from './steps/CompatibilityAndBottleStep';
import { StorefrontClientsStep } from './steps/StorefrontClientsStep';
import { GuidedClientSignInStep } from './steps/GuidedClientSignInStep';
import { SetupSummaryStepView } from './steps/SetupSummaryStepView';
import { formatHostBadgeLabel } from './setupWizardHelpers';
import { useSystemSetupWizardState } from './useSystemSetupWizardState';
import {
  AlertTriangle,
  ArrowLeft,
  ChevronRight,
  Play,
  RefreshCw,
  ShieldCheck,
  Sparkles,
  Wrench,
  X,
} from 'lucide-react';

export interface SystemSetupWizardModalProps {
  isOpen: boolean;
  mode?: SetupWizardOpenMode;
  initialStep?: SetupWizardStepId;
  focusComponentId?: EnvironmentComponentId;
  connectedStorefronts: StorefrontId[];
  catalogGames?: CanonicalGame[];
  onClose: () => void;
  onOpenIntegrationsModal?: () => void;
  onLibraryUpdated?: (games: CanonicalGame[]) => void;
}

export const SystemSetupWizardModal: React.FC<SystemSetupWizardModalProps> = ({
  isOpen,
  mode = 'health_check',
  initialStep,
  focusComponentId,
  connectedStorefronts,
  catalogGames,
  onClose,
  onOpenIntegrationsModal,
  onLibraryUpdated,
}) => {
  const titleId = useSafeId('system-setup-wizard-title');
  const wizard = useSystemSetupWizardState({
    isOpen,
    mode,
    initialStep,
    focusComponentId,
    connectedStorefronts,
    onClose,
  });

  if (!isOpen) return null;

  return (
    <ModalShell
      isOpen={isOpen}
      onClose={wizard.handleCloseOrSkip}
      preventClose={wizard.isProvisioningRunning}
      ariaLabelledBy={titleId}
      testId="system-setup-wizard-modal"
      className="w-full max-w-4xl"
    >
      <div
        className="bg-[#16202d] border border-[#2a475e] rounded-lg shadow-2xl w-full max-w-4xl max-h-[92vh] flex flex-col overflow-hidden text-slate-200 select-none overscroll-contain"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Modal Top Header */}
        <div className="px-6 py-4 border-b border-[#2a475e]/70 flex items-center justify-between gap-3 bg-[#131c27] shrink-0">
          <div className="flex items-center gap-3 min-w-0">
            <div className="w-9 h-9 rounded-lg bg-[#1b2838] border border-[#2a475e] flex items-center justify-center text-[#66c0f4] shadow-inner shrink-0">
              <ShieldCheck aria-hidden="true" className="w-5 h-5" />
            </div>

            <div className="min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <h2 id={titleId} className="text-base font-bold text-white tracking-wide">
                  Setup Wizard
                </h2>
                {wizard.removedComponents.length > 0 ? (
                  <span className="text-[10px] font-semibold uppercase px-2 py-0.5 rounded bg-amber-500/20 text-amber-200 border border-amber-500/40">
                    {wizard.removedComponents.length} Removed
                  </span>
                ) : mode === 'first_launch' ? (
                  <span className="text-[10px] font-semibold uppercase px-2 py-0.5 rounded bg-sky-500/20 text-sky-200 border border-sky-500/40">
                    First-Time Setup
                  </span>
                ) : null}
              </div>

              <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-slate-300 mt-0.5">
                <span className="inline-flex items-center px-1.5 py-0.5 rounded bg-[#1b2838] border border-[#2a475e] text-[10px] font-semibold text-sky-300">
                  {formatHostBadgeLabel(wizard.snapshot)}
                </span>
                <span>
                  Connected Stores:{' '}
                  <strong className="text-slate-100 font-medium">
                    {wizard.liveConnectedStorefronts.length > 0
                      ? wizard.liveConnectedStorefronts
                          .map((s) => getStorefrontDisplayName(s))
                          .join(', ')
                      : 'None yet'}
                  </strong>
                </span>
              </div>
            </div>
          </div>

          <div className="flex items-center gap-2 shrink-0">
            <button
              type="button"
              data-testid="setup-rescan-btn"
              disabled={wizard.isProbing || wizard.isProvisioningRunning}
              onClick={() => void wizard.handleRescanEnvironment()}
              className="min-h-6 inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-[#1b2838] border border-[#2a475e] text-slate-200 hover:text-white hover:border-[#66c0f4] transition-colors font-semibold text-xs cursor-pointer shadow disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#66c0f4]"
            >
              <RefreshCw
                className={`w-3.5 h-3.5 ${
                  wizard.isProbing ? 'ol-guided-spinner text-[#66c0f4]' : 'text-[#66c0f4]'
                }`}
                aria-hidden="true"
              />
              <span>{wizard.isProbing ? 'Refreshing...' : 'Refresh'}</span>
            </button>

            <button
              type="button"
              data-testid="setup-close-icon-btn"
              aria-label="Close Setup Wizard"
              disabled={wizard.isProvisioningRunning}
              onClick={wizard.handleCloseOrSkip}
              className="min-w-6 min-h-6 p-1.5 rounded-md text-slate-300 hover:text-white hover:bg-[#1b2838] transition-colors cursor-pointer disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#66c0f4]"
              title="Close Setup Wizard (Esc)"
            >
              <X aria-hidden="true" className="w-5 h-5" />
            </button>
          </div>
        </div>

        {/* Horizontal Pill Stepper Navigation */}
        <div className="px-6 py-3 border-b border-[#2a475e]/50 bg-[#16202d] flex items-center justify-between gap-3 text-xs shrink-0">
          <nav aria-label="Setup steps" className="flex items-center gap-2 flex-1 flex-wrap">
            {wizard.wizardSteps.map((step, idx) => {
              const isCurrent = wizard.activeStep === step.id;
              const StepIcon = step.icon;
              const isUnprogressed = idx > wizard.effectiveHighestReachedIdx;
              const isLockedByOperation =
                (wizard.isProvisioningRunning && step.id !== 'summary') ||
                (wizard.activeGuidedLoginTarget !== null && step.id !== 'client_logins');
              const isStepDisabled =
                isUnprogressed ||
                isLockedByOperation ||
                (idx > wizard.currentStepIdx && wizard.isBlockedFromAdvancingCompat);

              return (
                <div key={step.id} className="inline-flex items-center gap-2">
                  {idx > 0 && (
                    <ChevronRight
                      aria-hidden="true"
                      className="w-4 h-4 text-slate-500 shrink-0"
                    />
                  )}
                  <button
                    type="button"
                    data-testid={`setup-step-tab-${step.id}`}
                    aria-current={isCurrent ? 'step' : undefined}
                    disabled={isStepDisabled}
                    onClick={() => !isStepDisabled && wizard.navigateToStep(step.id)}
                    className={`min-h-6 flex items-center gap-2 px-3 py-1.5 rounded-md font-semibold transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#66c0f4] ${
                      isCurrent
                        ? 'bg-[#66c0f4] text-slate-950 shadow cursor-pointer'
                        : isStepDisabled
                          ? 'text-slate-600 cursor-not-allowed opacity-50'
                          : 'text-slate-300 hover:text-white hover:bg-[#1b2838] cursor-pointer'
                    }`}
                  >
                    <StepIcon aria-hidden="true" className="w-3.5 h-3.5 shrink-0" />
                    <span>{step.shortTitle}</span>
                  </button>
                </div>
              );
            })}
          </nav>

          <div className="text-[11px] text-slate-300 font-mono shrink-0">
            {`Step ${wizard.currentStepIdx + 1} of ${wizard.wizardSteps.length}`}
          </div>
        </div>

        {/* Modal Main Body Content */}
        <div className="flex-1 overflow-y-auto p-6 space-y-4 bg-[#101721] ol-studio-scroll-body">
          {/* Missing Previously Installed Items Banner */}
          {wizard.removedComponents.length > 0 && (
            <div
              role="region"
              aria-label="Missing setup items"
              data-testid="removed-components-banner"
              className="rounded-lg bg-amber-950/55 border border-amber-500/60 p-3.5 flex flex-wrap items-center justify-between gap-3"
            >
              <div className="flex items-start gap-2.5 min-w-0 flex-1">
                <AlertTriangle
                  className="w-4 h-4 text-amber-400 shrink-0 mt-0.5"
                  aria-hidden="true"
                />
                <div className="space-y-0.5 min-w-0">
                  <div className="text-xs font-bold text-amber-200">
                    Some setup items were removed ({wizard.removedComponents.length})
                  </div>
                  <p className="text-[11px] text-amber-100 leading-snug">
                    Missing:{' '}
                    <strong className="text-white">
                      {wizard.removedComponents.map((c) => c.title).join(', ')}
                    </strong>
                    . You can reinstall them without affecting your games.
                  </p>
                </div>
              </div>
              <button
                type="button"
                data-testid="repair-removed-components-btn"
                disabled={wizard.isProvisioningRunning}
                onClick={wizard.handleSelectRemovedComponentsForRepair}
                className="min-h-6 inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-amber-500/25 hover:bg-amber-500/35 border border-amber-400 text-xs font-bold text-amber-100 hover:text-white transition-colors cursor-pointer disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#66c0f4] shrink-0"
              >
                <Wrench className="w-3.5 h-3.5" aria-hidden="true" />
                <span>Reinstall Missing</span>
              </button>
            </div>
          )}

          {/* Active Step Content */}
          {wizard.activeStep === 'prerequisites' && !wizard.isMacHost && (
            <HostPrerequisitesStep
              snapshot={wizard.snapshot}
              mode={mode}
              selectedIds={wizard.selectedIds}
              forceRepairIds={wizard.forceRepairIds}
              focusComponentId={focusComponentId}
              onToggleComponent={wizard.handleToggleComponent}
              onToggleForceRepair={wizard.handleToggleForceRepair}
            />
          )}

          {wizard.activeStep === 'accounts' && (
            <StorefrontAccountsStep
              snapshot={wizard.snapshot}
              connectedStorefronts={wizard.liveConnectedStorefronts}
              onAccountsChanged={wizard.handleAccountsChanged}
              onOpenIntegrationsModal={
                onOpenIntegrationsModal
                  ? () => {
                      wizard.handleCloseOrSkip();
                      onOpenIntegrationsModal();
                    }
                  : undefined
              }
              onLibraryUpdated={onLibraryUpdated}
            />
          )}

          {wizard.activeStep === 'compatibility' && wizard.isMacHost && (
            <CompatibilityAndBottleStep
              snapshot={wizard.snapshot}
              chosenRunner={wizard.chosenRunner}
              onSelectRunner={wizard.handleSelectRunner}
              bottleMode={wizard.bottleMode}
              onChangeBottleMode={wizard.handleChangeBottleMode}
              bottleName={wizard.bottleName}
              onChangeBottleName={wizard.handleChangeBottleName}
              gptkDmgPath={wizard.gptkDmgPath}
              onChangeGptkDmgPath={wizard.setGptkDmgPath}
              runnerUpdateOptInIds={wizard.runnerUpdateOptInIds}
              onToggleRunnerUpdate={wizard.handleToggleRunnerUpdate}
            />
          )}

          {wizard.activeStep === 'clients' && (
            <StorefrontClientsStep
              snapshot={wizard.snapshot}
              mode={mode}
              chosenRunner={wizard.chosenRunner}
              connectedStorefronts={wizard.liveConnectedStorefronts}
              catalogGames={catalogGames}
              selectedIds={wizard.selectedIds}
              forceRepairIds={wizard.forceRepairIds}
              focusComponentId={focusComponentId}
              onToggleComponent={wizard.handleToggleComponent}
              onToggleForceRepair={wizard.handleToggleForceRepair}
            />
          )}

          {wizard.activeStep === 'client_logins' && (
            <GuidedClientSignInStep
              snapshot={wizard.snapshot}
              chosenRunner={wizard.chosenRunner}
              bottleName={wizard.effectiveBottleName}
              installStepNumber={wizard.installStepNumber}
              selectedIds={wizard.selectedIds}
              activeGuidedLoginTarget={wizard.activeGuidedLoginTarget}
              autoCloseOnSuccess={wizard.autoCloseGuidedLogin}
              onToggleAutoCloseOnSuccess={wizard.setAutoCloseGuidedLogin}
              onGoToProvisionStep={() => wizard.navigateToStep('summary')}
              onAllPendingSkippedChange={wizard.setAllPendingSkippedInQueue}
              onGuidedLoginCompleted={() => {
                const updated = environmentSetupService.getLastSnapshot();
                if (updated) wizard.setSnapshot(updated);
              }}
            />
          )}

          {wizard.activeStep === 'summary' && (
            <SetupSummaryStepView
              snapshot={wizard.snapshot}
              liveConnectedStorefronts={wizard.liveConnectedStorefronts}
              isMacHost={wizard.isMacHost}
              isWinHost={wizard.isWinHost}
              winPrereqsReady={wizard.winPrereqsReady}
              chosenRunner={wizard.chosenRunner}
              effectiveBottleName={wizard.effectiveBottleName}
              pendingActionableLogins={wizard.pendingActionableLogins}
              isProvisioningRunning={wizard.isProvisioningRunning}
              activeGuidedLoginTarget={wizard.activeGuidedLoginTarget}
              plannedTasks={wizard.plannedTasks}
              latestProgress={wizard.latestProgress}
              outcomes={wizard.outcomes}
              lastRunError={wizard.lastRunError}
              onCancelProvisioning={wizard.handleCancelProvisioning}
              onGoToClientLogins={() => wizard.navigateToStep('client_logins')}
            />
          )}
        </div>

        {/* Modal Bottom Action Footer Bar */}
        <div className="px-6 py-4 border-t border-[#2a475e]/70 bg-[#131c27] flex items-center justify-between gap-3 flex-wrap shrink-0">
          <div className="flex items-center gap-2 flex-wrap">
            {mode === 'first_launch' ? (
              <button
                type="button"
                data-testid="setup-skip-btn"
                disabled={wizard.isProvisioningRunning}
                onClick={wizard.handleCloseOrSkip}
                className="min-h-6 px-4 py-2 rounded-md border border-transparent text-slate-300 hover:text-white hover:bg-[#1b2838] transition-colors text-xs font-semibold cursor-pointer disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#66c0f4]"
              >
                Skip for Now
              </button>
            ) : (
              <button
                type="button"
                data-testid="setup-close-btn"
                disabled={wizard.isProvisioningRunning}
                onClick={wizard.handleCloseOrSkip}
                className="min-h-6 px-4 py-2 rounded-md border border-transparent text-slate-300 hover:text-white hover:bg-[#1b2838] transition-colors text-xs font-semibold cursor-pointer disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#66c0f4]"
              >
                Close
              </button>
            )}
          </div>

          <div className="flex items-center gap-2.5 flex-wrap">
            {wizard.prevStep && (
              <button
                type="button"
                data-testid="setup-prev-step-btn"
                disabled={wizard.isProvisioningRunning || wizard.activeGuidedLoginTarget !== null}
                onClick={() => wizard.navigateToStep(wizard.prevStep!.id)}
                className="min-h-6 px-4 py-2 rounded-md bg-[#1b2838] border border-[#2a475e] text-slate-200 hover:text-white hover:border-slate-400 transition-colors text-xs font-semibold flex items-center gap-1.5 cursor-pointer disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#66c0f4]"
              >
                <ArrowLeft aria-hidden="true" className="w-3.5 h-3.5" />
                <span>Back</span>
              </button>
            )}

            {wizard.activeStep === 'summary' && wizard.plannedTasks.length > 0 && (
              <button
                type="button"
                data-testid="run-provisioning-btn"
                disabled={wizard.isProvisioningRunning}
                onClick={() => wizard.handleRunProvisioning()}
                className="min-h-6 px-4 py-2 rounded-md bg-[#66c0f4] text-slate-950 font-bold hover:brightness-110 transition-all text-xs flex items-center gap-1.5 shadow cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#66c0f4]"
              >
                <Play aria-hidden="true" className="w-3.5 h-3.5 fill-slate-950" />
                <span>
                  {wizard.isProvisioningRunning
                    ? 'Installing...'
                    : `Install Selected (${wizard.plannedTasks.length})`}
                </span>
              </button>
            )}

            {wizard.showNextStepBtn && wizard.nextStep && (
              <button
                type="button"
                data-testid="setup-next-step-btn"
                disabled={
                  wizard.isProvisioningRunning ||
                  wizard.activeGuidedLoginTarget !== null ||
                  wizard.isBlockedFromAdvancingCompat
                }
                onClick={() => wizard.navigateToStep(wizard.nextStep!.id)}
                className={`min-h-6 px-4 py-2 rounded-md text-xs flex items-center gap-1.5 transition-all cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#66c0f4] ${
                  wizard.activeStep !== 'summary' ||
                  (wizard.plannedTasks.length === 0 &&
                    !wizard.lastRunError &&
                    wizard.pendingActionableLogins > 0)
                    ? 'bg-[#66c0f4] text-slate-950 font-bold hover:brightness-110 shadow'
                    : 'bg-[#1b2838] border border-[#2a475e] font-semibold text-slate-200 hover:text-white hover:border-slate-400'
                }`}
              >
                <span>
                  {wizard.activeStep === 'summary' &&
                  wizard.plannedTasks.length === 0 &&
                  wizard.pendingActionableLogins > 0
                    ? `Continue to Sign In (${wizard.pendingActionableLogins})`
                    : `Next: ${wizard.nextStep.fullTitle}`}
                </span>
                <ChevronRight aria-hidden="true" className="w-3.5 h-3.5" />
              </button>
            )}

            {wizard.showFinishSetupBtn && (
              <button
                type="button"
                data-testid="finish-setup-btn"
                disabled={wizard.isProvisioningRunning || wizard.activeGuidedLoginTarget !== null}
                onClick={wizard.handleFinishSetup}
                className="min-h-6 px-4 py-2 rounded-md bg-[#66c0f4] text-slate-950 font-bold hover:brightness-110 transition-all text-xs flex items-center gap-2 shadow-lg shadow-[#66c0f4]/20 cursor-pointer disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#66c0f4]"
              >
                <Sparkles aria-hidden="true" className="w-4 h-4 fill-slate-950" />
                <span>Finish Setup</span>
              </button>
            )}
          </div>
        </div>
      </div>
    </ModalShell>
  );
};
