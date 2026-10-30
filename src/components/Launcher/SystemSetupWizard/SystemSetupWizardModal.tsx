import React, { useEffect, useMemo, useRef, useState } from 'react';
import type { CanonicalGame } from '../../../contracts/game';
import type { CompatibilityLayerType } from '../../../contracts/launcher';
import type { StorefrontId } from '../../../contracts/platform';
import type {
  ClientLoginTargetId,
  EnvironmentComponentId,
  EnvironmentHealthSnapshot,
  EnvironmentSetupProgressEvent,
  EnvironmentSetupTaskOutcome,
  SetupWizardOpenMode,
  SetupWizardStepId,
} from '../../../contracts/environmentSetup';
import {
  buildFallbackEnvironmentSnapshot,
  buildProvisioningTasksFromSelection,
  computeDefaultSelectedComponents,
  environmentSetupService,
  getRemovedComponents,
  isCompleteHealthSnapshot,
} from '../../../services/launcher/environmentSetupService';
import { getStorefrontDisplayName } from '../../Common/StorefrontIcon';
import { ModalShell } from '../../Common/ModalShell';
import { useSafeId } from '../../../utils/useSafeId';
import { HostPrerequisitesStep } from './steps/HostPrerequisitesStep';
import { StorefrontAccountsStep } from './steps/StorefrontAccountsStep';
import {
  CompatibilityAndBottleStep,
  isValidBottleNameInput,
} from './steps/CompatibilityAndBottleStep';
import { StorefrontClientsStep } from './steps/StorefrontClientsStep';
import { GuidedClientSignInStep } from './steps/GuidedClientSignInStep';
import { ProvisioningProgressPanel } from './steps/ProvisioningProgressPanel';
import {
  AlertTriangle,
  ArrowLeft,
  ChevronRight,
  Cloud,
  Download,
  KeyRound,
  Layers,
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
  onClose: () => void;
  onOpenIntegrationsModal?: () => void;
  onLibraryUpdated?: (games: CanonicalGame[]) => void;
}

interface WizardStepMeta {
  id: SetupWizardStepId;
  number: number;
  shortTitle: string;
  fullTitle: string;
  icon: React.ComponentType<{ className?: string; 'aria-hidden'?: boolean | 'true' | 'false' }>;
}

const MAC_WIZARD_STEPS: ReadonlyArray<WizardStepMeta> = [
  {
    id: 'accounts',
    number: 1,
    shortTitle: '1. Accounts',
    fullTitle: 'Accounts',
    icon: Cloud,
  },
  {
    id: 'compatibility',
    number: 2,
    shortTitle: '2. Windows Games',
    fullTitle: 'Windows Games',
    icon: Layers,
  },
  {
    id: 'clients',
    number: 3,
    shortTitle: '3. Launchers',
    fullTitle: 'Launchers',
    icon: Download,
  },
  {
    id: 'summary',
    number: 4,
    shortTitle: '4. Install',
    fullTitle: 'Install',
    icon: Wrench,
  },
  {
    id: 'client_logins',
    number: 5,
    shortTitle: '5. Sign In',
    fullTitle: 'Sign In',
    icon: KeyRound,
  },
];

const WINDOWS_WIZARD_STEPS: ReadonlyArray<WizardStepMeta> = [
  {
    id: 'prerequisites',
    number: 1,
    shortTitle: '1. System',
    fullTitle: 'System',
    icon: ShieldCheck,
  },
  {
    id: 'accounts',
    number: 2,
    shortTitle: '2. Accounts',
    fullTitle: 'Accounts',
    icon: Cloud,
  },
  {
    id: 'clients',
    number: 3,
    shortTitle: '3. Launchers',
    fullTitle: 'Launchers',
    icon: Download,
  },
  {
    id: 'summary',
    number: 4,
    shortTitle: '4. Install',
    fullTitle: 'Install',
    icon: Wrench,
  },
  {
    id: 'client_logins',
    number: 5,
    shortTitle: '5. Sign In',
    fullTitle: 'Sign In',
    icon: KeyRound,
  },
];

function getWizardStepsForHost(
  hostPlatform: EnvironmentHealthSnapshot['hostPlatform']
): ReadonlyArray<WizardStepMeta> {
  return hostPlatform === 'darwin' ? MAC_WIZARD_STEPS : WINDOWS_WIZARD_STEPS;
}

const RUNNER_COMPONENT_MAP: ReadonlyArray<{
  runner: Exclude<CompatibilityLayerType, 'native'>;
  componentId: Extract<
    EnvironmentComponentId,
    'runner_crossover' | 'runner_crossover_preview' | 'runner_wine' | 'runner_gptk'
  >;
}> = [
  { runner: 'crossover', componentId: 'runner_crossover' },
  { runner: 'crossover_preview', componentId: 'runner_crossover_preview' },
  { runner: 'wine', componentId: 'runner_wine' },
  { runner: 'gptk', componentId: 'runner_gptk' },
];

function formatRunnerLabel(runner: Exclude<CompatibilityLayerType, 'native'>): string {
  switch (runner) {
    case 'crossover':
      return 'CrossOver';
    case 'crossover_preview':
      return 'CrossOver Preview';
    case 'wine':
      return 'Wine';
    case 'gptk':
      return 'Game Porting Toolkit';
    default:
      return runner;
  }
}

function formatHostBadgeLabel(snap: EnvironmentHealthSnapshot): string {
  if (snap.hostPlatform === 'darwin') {
    return snap.isAppleSiliconMac ? 'macOS • Apple Silicon' : 'macOS • Intel';
  }
  if (snap.hostPlatform === 'win32') {
    return 'Windows PC';
  }
  return 'Desktop';
}

function resolveInitialStep(
  hostPlatform: EnvironmentHealthSnapshot['hostPlatform'],
  initialStep?: SetupWizardStepId,
  focusComponentId?: EnvironmentComponentId
): SetupWizardStepId {
  const defaultFirstStep: SetupWizardStepId =
    hostPlatform === 'darwin' ? 'accounts' : 'prerequisites';

  if (initialStep) {
    if (initialStep === 'prerequisites' && hostPlatform === 'darwin') {
      return 'accounts';
    }
    if (initialStep === 'compatibility' && hostPlatform !== 'darwin') {
      return 'prerequisites';
    }
    return initialStep;
  }
  if (!focusComponentId) return defaultFirstStep;
  if (focusComponentId === 'rosetta2') {
    return defaultFirstStep;
  }
  if (focusComponentId === 'win_vcredist' || focusComponentId === 'win_webview2') {
    return defaultFirstStep;
  }
  if (
    focusComponentId === 'runner_crossover' ||
    focusComponentId === 'runner_crossover_preview' ||
    focusComponentId === 'runner_wine' ||
    focusComponentId === 'runner_gptk' ||
    focusComponentId === 'bottle_default'
  ) {
    return hostPlatform === 'darwin' ? 'compatibility' : 'prerequisites';
  }
  return 'clients';
}

function resolveDefaultRunner(
  snap: EnvironmentHealthSnapshot,
  persistedRunner?: Exclude<CompatibilityLayerType, 'native'> | 'skip'
): Exclude<CompatibilityLayerType, 'native'> | 'skip' {
  if (snap.hostPlatform !== 'darwin') {
    return 'skip';
  }
  if (persistedRunner) {
    if (
      persistedRunner === 'gptk' &&
      !snap.isAppleSiliconMac &&
      snap.components.runner_gptk?.status !== 'ready'
    ) {
      return 'crossover';
    }
    return persistedRunner;
  }
  if (snap.bottleSummary?.runnerType) {
    return snap.bottleSummary.runnerType;
  }
  const firstDetected = snap.detectedRunners.find(
    (r): r is typeof r & { type: Exclude<CompatibilityLayerType, 'native'> } =>
      r.type !== 'native'
  );
  if (firstDetected) {
    return firstDetected.type;
  }
  return 'crossover';
}

function collectConfiguredReadyComponents(
  snap: EnvironmentHealthSnapshot,
  selectedIds: ReadonlySet<EnvironmentComponentId>,
  outcomes: ReadonlyArray<EnvironmentSetupTaskOutcome>
): EnvironmentComponentId[] {
  const configured = new Set<EnvironmentComponentId>();
  for (const comp of Object.values(snap.components)) {
    if (comp && comp.status === 'ready') {
      configured.add(comp.id);
    }
  }
  for (const outcome of outcomes) {
    if (outcome.status === 'completed') {
      configured.add(outcome.componentId);
    }
  }
  for (const id of selectedIds) {
    if (snap.components[id]?.status === 'ready') {
      configured.add(id);
    }
  }
  return Array.from(configured);
}

export const SystemSetupWizardModal: React.FC<SystemSetupWizardModalProps> = ({
  isOpen,
  mode = 'health_check',
  initialStep,
  focusComponentId,
  connectedStorefronts,
  onClose,
  onOpenIntegrationsModal,
  onLibraryUpdated,
}) => {
  const titleId = useSafeId('system-setup-wizard-title');

  const [liveConnectedStorefronts, setLiveConnectedStorefronts] =
    useState<StorefrontId[]>(connectedStorefronts);
  const [snapshot, setSnapshot] = useState<EnvironmentHealthSnapshot>(
    () =>
      environmentSetupService.getLastSnapshot() ??
      buildFallbackEnvironmentSnapshot(connectedStorefronts)
  );
  const [activeStep, setActiveStep] = useState<SetupWizardStepId>(() => {
    const initialSnap =
      environmentSetupService.getLastSnapshot() ??
      buildFallbackEnvironmentSnapshot(connectedStorefronts);
    return resolveInitialStep(initialSnap.hostPlatform, initialStep, focusComponentId);
  });
  const [highestReachedStepIdx, setHighestReachedStepIdx] = useState<number>(() => {
    const initialSnap =
      environmentSetupService.getLastSnapshot() ??
      buildFallbackEnvironmentSnapshot(connectedStorefronts);
    const steps = getWizardStepsForHost(initialSnap.hostPlatform);
    const resolved = resolveInitialStep(initialSnap.hostPlatform, initialStep, focusComponentId);
    return Math.max(
      0,
      steps.findIndex((s) => s.id === resolved)
    );
  });
  const [chosenRunner, setChosenRunner] = useState<
    Exclude<CompatibilityLayerType, 'native'> | 'skip'
  >(() =>
    resolveDefaultRunner(
      environmentSetupService.getLastSnapshot() ??
        buildFallbackEnvironmentSnapshot(connectedStorefronts),
      environmentSetupService.getWizardState()?.preferredRunnerType
    )
  );
  const [bottleMode, setBottleMode] = useState<'reuse_existing' | 'create_dedicated'>(() => {
    const initialSnap =
      environmentSetupService.getLastSnapshot() ??
      buildFallbackEnvironmentSnapshot(connectedStorefronts);
    return (initialSnap.bottleSummary?.availableBottles?.length ?? 0) > 0
      ? 'reuse_existing'
      : (initialSnap.bottleSummary?.recommendedBottleMode ?? 'create_dedicated');
  });
  const [bottleName, setBottleName] = useState<string>(() => {
    const persisted = environmentSetupService.getWizardState()?.preferredBottleName;
    if (persisted) return persisted;
    const initialSnap =
      environmentSetupService.getLastSnapshot() ??
      buildFallbackEnvironmentSnapshot(connectedStorefronts);
    return initialSnap.bottleSummary?.recommendedBottleName || 'OneLauncher';
  });
  const [gptkDmgPath, setGptkDmgPath] = useState<string>('');
  const [selectedIds, setSelectedIds] = useState<Set<EnvironmentComponentId>>(() => {
    const initialSnap =
      environmentSetupService.getLastSnapshot() ??
      buildFallbackEnvironmentSnapshot(connectedStorefronts);
    const initialRunner = resolveDefaultRunner(
      initialSnap,
      environmentSetupService.getWizardState()?.preferredRunnerType
    );
    return computeDefaultSelectedComponents(initialSnap, connectedStorefronts, {
      chosenRunner: initialRunner,
    });
  });
  const [forceRepairIds, setForceRepairIds] = useState<Set<EnvironmentComponentId>>(
    () => new Set()
  );
  const [isProbing, setIsProbing] = useState<boolean>(false);
  const [isProvisioningRunning, setIsProvisioningRunning] = useState<boolean>(() =>
    environmentSetupService.isSetupRunning()
  );
  const [activeGuidedLoginTarget, setActiveGuidedLoginTarget] =
    useState<ClientLoginTargetId | null>(() =>
      environmentSetupService.getActiveGuidedLoginTarget()
    );
  const [latestProgress, setLatestProgress] = useState<EnvironmentSetupProgressEvent | null>(() =>
    environmentSetupService.getLatestProgress()
  );
  const [outcomes, setOutcomes] = useState<EnvironmentSetupTaskOutcome[]>([]);
  const [lastRunError, setLastRunError] = useState<string | null>(null);
  const [autoCloseGuidedLogin, setAutoCloseGuidedLogin] = useState<boolean>(true);
  const [allPendingSkippedInQueue, setAllPendingSkippedInQueue] = useState<boolean>(false);

  const hasUserCustomizedSelectionRef = useRef<boolean>(false);
  const chosenRunnerRef = useRef(chosenRunner);
  chosenRunnerRef.current = chosenRunner;

  const wizardSteps = useMemo(
    () => getWizardStepsForHost(snapshot.hostPlatform),
    [snapshot.hostPlatform]
  );

  useEffect(() => {
    setLiveConnectedStorefronts(connectedStorefronts);
  }, [connectedStorefronts]);

  useEffect(() => {
    if (!isOpen) return;
    const resolvedStep = resolveInitialStep(snapshot.hostPlatform, initialStep, focusComponentId);
    const steps = getWizardStepsForHost(snapshot.hostPlatform);
    setActiveStep(resolvedStep);
    setHighestReachedStepIdx(
      Math.max(
        0,
        steps.findIndex((s) => s.id === resolvedStep)
      )
    );
    hasUserCustomizedSelectionRef.current = false;
    setOutcomes([]);
    setLastRunError(null);
    setAllPendingSkippedInQueue(false);
  }, [isOpen, initialStep, focusComponentId, mode, snapshot.hostPlatform]);

  useEffect(() => {
    if (!wizardSteps.some((s) => s.id === activeStep)) {
      setActiveStep(wizardSteps[0].id);
    }
  }, [wizardSteps, activeStep]);

  useEffect(() => {
    if (!isOpen) return undefined;
    const syncFromService = () => {
      const nextSnap = environmentSetupService.getLastSnapshot();
      if (nextSnap) {
        setSnapshot(nextSnap);
      }
      setIsProvisioningRunning(environmentSetupService.isSetupRunning());
      setActiveGuidedLoginTarget(environmentSetupService.getActiveGuidedLoginTarget());
      setLatestProgress(environmentSetupService.getLatestProgress());
    };
    return environmentSetupService.subscribe(syncFromService);
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) return undefined;
    let active = true;
    setIsProbing(true);

    Promise.all([
      environmentSetupService.loadWizardState(),
      environmentSetupService.probeHealth(connectedStorefronts, { forceFresh: true }),
    ])
      .then(([persistedState, probedSnap]) => {
        if (!active) return;
        setSnapshot(probedSnap);
        const resolvedRunner = resolveDefaultRunner(
          probedSnap,
          persistedState.preferredRunnerType
        );
        setChosenRunner(resolvedRunner);
        const avail = probedSnap.bottleSummary?.availableBottles ?? [];
        setBottleMode(
          avail.length > 0
            ? 'reuse_existing'
            : (probedSnap.bottleSummary?.recommendedBottleMode ?? 'create_dedicated')
        );
        setBottleName(
          persistedState.preferredBottleName ||
            probedSnap.bottleSummary?.recommendedBottleName ||
            avail[0]?.name ||
            'OneLauncher'
        );
        if (!hasUserCustomizedSelectionRef.current) {
          setSelectedIds(
            computeDefaultSelectedComponents(probedSnap, connectedStorefronts, {
              chosenRunner: resolvedRunner,
            })
          );
        }
      })
      .catch(() => {})
      .finally(() => {
        if (active) setIsProbing(false);
      });

    return () => {
      active = false;
    };
  }, [isOpen]);

  const removedComponents = useMemo(
    () =>
      getRemovedComponents(snapshot).filter(
        (comp) => !(snapshot.hostPlatform === 'darwin' && comp.id === 'rosetta2')
      ),
    [snapshot]
  );

  const effectiveSelectedIds = useMemo(() => {
    if (snapshot.hostPlatform !== 'darwin' || !selectedIds.has('rosetta2')) {
      return selectedIds;
    }
    const next = new Set(selectedIds);
    next.delete('rosetta2');
    return next;
  }, [selectedIds, snapshot.hostPlatform]);

  const effectiveBottleName = isValidBottleNameInput(bottleName)
    ? bottleName.trim()
    : snapshot.bottleSummary?.recommendedBottleName || 'OneLauncher';

  const plannedTasks = useMemo(
    () =>
      buildProvisioningTasksFromSelection({
        snapshot,
        selectedIds: effectiveSelectedIds,
        chosenRunner,
        bottleMode,
        bottleName: effectiveBottleName,
        gptkDmgPath,
        forceRepairIds,
      }),
    [
      snapshot,
      effectiveSelectedIds,
      chosenRunner,
      bottleMode,
      effectiveBottleName,
      gptkDmgPath,
      forceRepairIds,
    ]
  );

  if (!isOpen) return null;

  const navigateToStep = (targetStepId: SetupWizardStepId) => {
    setActiveStep(targetStepId);
    const targetIdx = wizardSteps.findIndex((s) => s.id === targetStepId);
    if (targetIdx >= 0) {
      setHighestReachedStepIdx((prev) => Math.max(prev, targetIdx));
    }
  };

  const handleRescanEnvironment = async () => {
    if (isProbing || isProvisioningRunning) return;
    setIsProbing(true);
    try {
      const fresh = await environmentSetupService.probeHealth(liveConnectedStorefronts, {
        forceFresh: true,
      });
      setSnapshot(fresh);
      if (!hasUserCustomizedSelectionRef.current) {
        setSelectedIds(
          computeDefaultSelectedComponents(fresh, liveConnectedStorefronts, {
            chosenRunner: chosenRunnerRef.current,
          })
        );
      }
    } finally {
      setIsProbing(false);
    }
  };

  const handleSelectRunner = (
    nextRunner: Exclude<CompatibilityLayerType, 'native'> | 'skip'
  ) => {
    setChosenRunner(nextRunner);
    setSelectedIds((prev) => {
      const next = new Set(prev);
      for (const entry of RUNNER_COMPONENT_MAP) {
        next.delete(entry.componentId);
      }
      if (nextRunner === 'skip') {
        next.delete('bottle_default');
        next.delete('bottle_steam');
        next.delete('bottle_gog');
        next.delete('bottle_epic');
        return next;
      }
      const match = RUNNER_COMPONENT_MAP.find((e) => e.runner === nextRunner);
      if (match) {
        const comp = snapshot.components[match.componentId];
        if (comp && comp.status !== 'ready' && comp.status !== 'not_applicable') {
          next.add(match.componentId);
        }
      }
      const bottleComp = snapshot.components.bottle_default;
      if (bottleComp && bottleComp.status !== 'ready' && bottleComp.status !== 'not_applicable') {
        next.add('bottle_default');
      }
      const steamRelevant =
        liveConnectedStorefronts.includes('steam') || liveConnectedStorefronts.length === 0;
      if (steamRelevant && snapshot.components.bottle_steam?.status === 'missing') {
        next.add('bottle_steam');
      }
      return next;
    });
  };

  const handleToggleComponent = (id: EnvironmentComponentId) => {
    hasUserCustomizedSelectionRef.current = true;
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };

  const handleToggleForceRepair = (id: EnvironmentComponentId) => {
    hasUserCustomizedSelectionRef.current = true;
    const enabling = !forceRepairIds.has(id);
    setForceRepairIds((prevForce) => {
      const nextForce = new Set(prevForce);
      if (enabling) {
        nextForce.add(id);
      } else {
        nextForce.delete(id);
      }
      return nextForce;
    });
    setSelectedIds((prevSel) => {
      const nextSel = new Set(prevSel);
      if (enabling) {
        nextSel.add(id);
      } else {
        nextSel.delete(id);
      }
      return nextSel;
    });
  };

  const handleSelectRemovedComponentsForRepair = () => {
    hasUserCustomizedSelectionRef.current = true;
    const nextSelected = new Set(selectedIds);
    let nextRunner = chosenRunner;
    for (const comp of removedComponents) {
      nextSelected.add(comp.id);
      const runnerEntry = RUNNER_COMPONENT_MAP.find((r) => r.componentId === comp.id);
      if (runnerEntry && snapshot.hostPlatform === 'darwin' && nextRunner === 'skip') {
        nextRunner = runnerEntry.runner;
      }
    }
    if (nextRunner !== chosenRunner) {
      setChosenRunner(nextRunner);
    }
    setSelectedIds(nextSelected);
    navigateToStep('summary');
  };

  const handleAccountsChanged = (nextConnected: StorefrontId[]) => {
    setLiveConnectedStorefronts(nextConnected);
    const latestSnap = environmentSetupService.getLastSnapshot() ?? snapshot;
    if (!hasUserCustomizedSelectionRef.current) {
      setSelectedIds(
        computeDefaultSelectedComponents(latestSnap, nextConnected, {
          chosenRunner: chosenRunnerRef.current,
        })
      );
    }
  };

  const handleRunProvisioning = async () => {
    if (isProvisioningRunning || plannedTasks.length === 0) return;
    setLastRunError(null);
    setOutcomes([]);
    environmentSetupService.clearProgressHistory();

    const result = await environmentSetupService.runSetupTasks({
      tasks: plannedTasks,
      connectedStorefronts: liveConnectedStorefronts,
    });

    const runOutcomes = result.outcomes || [];
    setOutcomes(runOutcomes);
    const completedComponentIds = runOutcomes
      .filter((o) => o.status === 'completed')
      .map((o) => o.componentId);
    if (completedComponentIds.length > 0) {
      setForceRepairIds((prev) => {
        let changed = false;
        const next = new Set(prev);
        for (const id of completedComponentIds) {
          if (next.delete(id)) {
            changed = true;
          }
        }
        return changed ? next : prev;
      });
    }
    const nextSnapshot = isCompleteHealthSnapshot(result.snapshot) ? result.snapshot : snapshot;
    if (isCompleteHealthSnapshot(result.snapshot)) {
      setSnapshot(result.snapshot);
    }
    if (!result.success && result.error) {
      setLastRunError(result.error);
    }

    const nowIso = new Date().toISOString();
    const configuredIds = collectConfiguredReadyComponents(
      nextSnapshot,
      selectedIds,
      runOutcomes
    );
    await environmentSetupService.saveWizardState({
      lastHealthCheckAt: nowIso,
      ...(snapshot.hostPlatform === 'darwin'
        ? {
            preferredRunnerType: chosenRunner,
            preferredBottleName: effectiveBottleName,
          }
        : {}),
      addConfiguredComponents: configuredIds,
    });
  };

  const handleCancelProvisioning = () => {
    void environmentSetupService.cancelActiveSetup();
  };

  const handleCloseOrSkip = () => {
    if (isProvisioningRunning) return;
    const inFlightGuidedTarget = environmentSetupService.getActiveGuidedLoginTarget();
    if (inFlightGuidedTarget) {
      void environmentSetupService.cancelGuidedLogin(inFlightGuidedTarget);
    }
    const nowIso = new Date().toISOString();
    void environmentSetupService.saveWizardState({
      dismissedAt: nowIso,
      lastHealthCheckAt: nowIso,
    });
    onClose();
  };

  const handleFinishSetup = () => {
    if (isProvisioningRunning) return;
    const inFlightGuidedTarget = environmentSetupService.getActiveGuidedLoginTarget();
    if (inFlightGuidedTarget) {
      void environmentSetupService.cancelGuidedLogin(inFlightGuidedTarget);
    }
    const nowIso = new Date().toISOString();
    const configuredIds = collectConfiguredReadyComponents(snapshot, selectedIds, outcomes);
    void environmentSetupService
      .saveWizardState({
        completedAt: nowIso,
        lastHealthCheckAt: nowIso,
        ...(snapshot.hostPlatform === 'darwin'
          ? {
              preferredRunnerType: chosenRunner,
              preferredBottleName: effectiveBottleName,
            }
          : {}),
        addConfiguredComponents: configuredIds,
      })
      .then(() => {
        void environmentSetupService.probeHealth(liveConnectedStorefronts, { forceFresh: true });
      });
    onClose();
  };

  const currentStepIdx = Math.max(
    0,
    wizardSteps.findIndex((s) => s.id === activeStep)
  );
  const effectiveHighestReachedIdx = Math.max(highestReachedStepIdx, currentStepIdx);
  const prevStep = currentStepIdx > 0 ? wizardSteps[currentStepIdx - 1] : null;
  const nextStep =
    currentStepIdx >= 0 && currentStepIdx < wizardSteps.length - 1
      ? wizardSteps[currentStepIdx + 1]
      : null;
  const installStepNumber = wizardSteps.find((s) => s.id === 'summary')?.number ?? 4;

  const { counts } = snapshot;
  const pendingActionableLogins =
    counts.pendingClientLoginCount + counts.accountMismatchCount;

  const isInstallWorkDone =
    !isProvisioningRunning && plannedTasks.length === 0 && !lastRunError;
  const isSignInWorkDone =
    pendingActionableLogins === 0 ||
    (activeStep === 'client_logins' && allPendingSkippedInQueue);
  const showFinishSetupBtn =
    isInstallWorkDone &&
    isSignInWorkDone &&
    activeGuidedLoginTarget === null &&
    (activeStep === 'client_logins' || activeStep === 'summary');
  const showNextStepBtn =
    Boolean(nextStep) && !(activeStep === 'summary' && showFinishSetupBtn);

  const isMacHost = snapshot.hostPlatform === 'darwin';
  const isWinHost = snapshot.hostPlatform === 'win32';
  const winPrereqsReady =
    isWinHost &&
    snapshot.components.win_vcredist?.status === 'ready' &&
    snapshot.components.win_webview2?.status !== 'missing';

  return (
    <ModalShell
      isOpen={isOpen}
      onClose={handleCloseOrSkip}
      preventClose={isProvisioningRunning}
      ariaLabelledBy={titleId}
      testId="system-setup-wizard-modal"
      className="w-full max-w-4xl"
    >
      <div
        className="bg-[#16202d] border border-[#2a475e] rounded-lg shadow-2xl w-full max-w-4xl max-h-[92vh] flex flex-col overflow-hidden text-slate-200 animate-in fade-in duration-150 select-none overscroll-contain"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Modal Top Header (Matches Fix & Match Wizard) */}
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
                {removedComponents.length > 0 ? (
                  <span className="text-[10px] font-semibold uppercase px-2 py-0.5 rounded bg-amber-500/20 text-amber-200 border border-amber-500/40">
                    {removedComponents.length} Removed
                  </span>
                ) : mode === 'first_launch' ? (
                  <span className="text-[10px] font-semibold uppercase px-2 py-0.5 rounded bg-sky-500/20 text-sky-200 border border-sky-500/40">
                    First-Time Setup
                  </span>
                ) : null}
              </div>

              <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-slate-300 mt-0.5">
                <span className="inline-flex items-center px-1.5 py-0.5 rounded bg-[#1b2838] border border-[#2a475e] text-[10px] font-semibold text-sky-300">
                  {formatHostBadgeLabel(snapshot)}
                </span>
                <span>
                  Connected Stores:{' '}
                  <strong className="text-slate-100 font-medium">
                    {liveConnectedStorefronts.length > 0
                      ? liveConnectedStorefronts.map((s) => getStorefrontDisplayName(s)).join(', ')
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
              disabled={isProbing || isProvisioningRunning}
              onClick={() => void handleRescanEnvironment()}
              className="min-h-6 inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-[#1b2838] border border-[#2a475e] text-slate-200 hover:text-white hover:border-[#66c0f4] transition-colors font-semibold text-xs cursor-pointer shadow disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#66c0f4]"
            >
              <RefreshCw
                className={`w-3.5 h-3.5 ${
                  isProbing ? 'ol-guided-spinner text-[#66c0f4]' : 'text-[#66c0f4]'
                }`}
                aria-hidden="true"
              />
              <span>{isProbing ? 'Refreshing...' : 'Refresh'}</span>
            </button>

            <button
              type="button"
              data-testid="setup-close-icon-btn"
              aria-label="Close Setup Wizard"
              disabled={isProvisioningRunning}
              onClick={handleCloseOrSkip}
              className="min-w-6 min-h-6 p-1.5 rounded-md text-slate-300 hover:text-white hover:bg-[#1b2838] transition-colors cursor-pointer disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#66c0f4]"
              title="Close Setup Wizard (Esc)"
            >
              <X aria-hidden="true" className="w-5 h-5" />
            </button>
          </div>
        </div>

        {/* Horizontal Pill Stepper Navigation (Matches Fix & Match Wizard) */}
        <div className="px-6 py-3 border-b border-[#2a475e]/50 bg-[#16202d] flex items-center justify-between gap-3 text-xs shrink-0">
          <nav aria-label="Setup steps" className="flex items-center gap-2 flex-1 flex-wrap">
            {wizardSteps.map((step, idx) => {
              const isCurrent = activeStep === step.id;
              const StepIcon = step.icon;
              const isUnprogressed = idx > effectiveHighestReachedIdx;
              const isLockedByOperation =
                (isProvisioningRunning && step.id !== 'summary') ||
                (activeGuidedLoginTarget !== null && step.id !== 'client_logins');
              const isStepDisabled = isUnprogressed || isLockedByOperation;

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
                    onClick={() => !isStepDisabled && navigateToStep(step.id)}
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
            {`Step ${currentStepIdx + 1} of ${wizardSteps.length}`}
          </div>
        </div>

        {/* Modal Main Body Content */}
        <div className="flex-1 overflow-y-auto p-6 space-y-4 custom-scrollbar bg-[#101721] ol-studio-scroll-body">
          {/* Missing Previously Installed Items Banner */}
          {removedComponents.length > 0 && (
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
                    Some setup items were removed ({removedComponents.length})
                  </div>
                  <p className="text-[11px] text-amber-100 leading-snug">
                    Missing:{' '}
                    <strong className="text-white">
                      {removedComponents.map((c) => c.title).join(', ')}
                    </strong>
                    . You can reinstall them without affecting your games.
                  </p>
                </div>
              </div>
              <button
                type="button"
                data-testid="repair-removed-components-btn"
                disabled={isProvisioningRunning}
                onClick={handleSelectRemovedComponentsForRepair}
                className="min-h-6 inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-amber-500/25 hover:bg-amber-500/35 border border-amber-400 text-xs font-bold text-amber-100 hover:text-white transition-colors cursor-pointer disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#66c0f4] shrink-0"
              >
                <Wrench className="w-3.5 h-3.5" aria-hidden="true" />
                <span>Reinstall Missing</span>
              </button>
            </div>
          )}

          {/* Active Step Content */}
          {activeStep === 'prerequisites' && !isMacHost && (
            <HostPrerequisitesStep
              snapshot={snapshot}
              mode={mode}
              selectedIds={selectedIds}
              forceRepairIds={forceRepairIds}
              focusComponentId={focusComponentId}
              onToggleComponent={handleToggleComponent}
              onToggleForceRepair={handleToggleForceRepair}
            />
          )}

          {activeStep === 'accounts' && (
            <StorefrontAccountsStep
              snapshot={snapshot}
              connectedStorefronts={liveConnectedStorefronts}
              onAccountsChanged={handleAccountsChanged}
              onOpenIntegrationsModal={
                onOpenIntegrationsModal
                  ? () => {
                      handleCloseOrSkip();
                      onOpenIntegrationsModal();
                    }
                  : undefined
              }
              onLibraryUpdated={onLibraryUpdated}
            />
          )}

          {activeStep === 'compatibility' && isMacHost && (
            <CompatibilityAndBottleStep
              snapshot={snapshot}
              chosenRunner={chosenRunner}
              onSelectRunner={handleSelectRunner}
              bottleMode={bottleMode}
              onChangeBottleMode={setBottleMode}
              bottleName={bottleName}
              onChangeBottleName={setBottleName}
              gptkDmgPath={gptkDmgPath}
              onChangeGptkDmgPath={setGptkDmgPath}
            />
          )}

          {activeStep === 'clients' && (
            <StorefrontClientsStep
              snapshot={snapshot}
              mode={mode}
              chosenRunner={chosenRunner}
              connectedStorefronts={liveConnectedStorefronts}
              selectedIds={selectedIds}
              forceRepairIds={forceRepairIds}
              focusComponentId={focusComponentId}
              onToggleComponent={handleToggleComponent}
              onToggleForceRepair={handleToggleForceRepair}
            />
          )}

          {activeStep === 'client_logins' && (
            <GuidedClientSignInStep
              snapshot={snapshot}
              chosenRunner={chosenRunner}
              bottleName={effectiveBottleName}
              installStepNumber={installStepNumber}
              selectedIds={selectedIds}
              activeGuidedLoginTarget={activeGuidedLoginTarget}
              autoCloseOnSuccess={autoCloseGuidedLogin}
              onToggleAutoCloseOnSuccess={setAutoCloseGuidedLogin}
              onGoToProvisionStep={() => navigateToStep('summary')}
              onAllPendingSkippedChange={setAllPendingSkippedInQueue}
              onGuidedLoginCompleted={() => {
                const updated = environmentSetupService.getLastSnapshot();
                if (updated) setSnapshot(updated);
              }}
            />
          )}

          {activeStep === 'summary' && (
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
                        onClick={() => navigateToStep('client_logins')}
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
                onCancelProvisioning={handleCancelProvisioning}
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
                      <KeyRound
                        className="w-4 h-4 text-[#66c0f4] shrink-0 mt-0.5"
                        aria-hidden="true"
                      />
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
                      onClick={() => navigateToStep('client_logins')}
                      className="min-h-6 inline-flex items-center gap-1.5 px-4 py-2 rounded-md bg-[#66c0f4] text-slate-950 font-bold hover:brightness-110 transition-all text-xs shadow cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#66c0f4] shrink-0"
                    >
                      <span>Sign In Now ({pendingActionableLogins}) →</span>
                    </button>
                  </div>
                )}
            </div>
          )}
        </div>

        {/* Modal Bottom Action Footer Bar (Matches Fix & Match Wizard) */}
        <div className="px-6 py-4 border-t border-[#2a475e]/70 bg-[#131c27] flex items-center justify-between gap-3 flex-wrap shrink-0">
          <div className="flex items-center gap-2 flex-wrap">
            {mode === 'first_launch' ? (
              <button
                type="button"
                data-testid="setup-skip-btn"
                disabled={isProvisioningRunning}
                onClick={handleCloseOrSkip}
                className="min-h-6 px-4 py-2 rounded-md border border-transparent text-slate-300 hover:text-white hover:bg-[#1b2838] transition-colors text-xs font-semibold cursor-pointer disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#66c0f4]"
              >
                Skip for Now
              </button>
            ) : (
              <button
                type="button"
                data-testid="setup-close-btn"
                disabled={isProvisioningRunning}
                onClick={handleCloseOrSkip}
                className="min-h-6 px-4 py-2 rounded-md border border-transparent text-slate-300 hover:text-white hover:bg-[#1b2838] transition-colors text-xs font-semibold cursor-pointer disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#66c0f4]"
              >
                Close
              </button>
            )}
          </div>

          <div className="flex items-center gap-2.5 flex-wrap">
            {prevStep && (
              <button
                type="button"
                data-testid="setup-prev-step-btn"
                disabled={isProvisioningRunning || activeGuidedLoginTarget !== null}
                onClick={() => navigateToStep(prevStep.id)}
                className="min-h-6 px-4 py-2 rounded-md bg-[#1b2838] border border-[#2a475e] text-slate-200 hover:text-white hover:border-slate-400 transition-colors text-xs font-semibold flex items-center gap-1.5 cursor-pointer disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#66c0f4]"
              >
                <ArrowLeft aria-hidden="true" className="w-3.5 h-3.5" />
                <span>Back</span>
              </button>
            )}

            {activeStep === 'summary' && plannedTasks.length > 0 && (
              <button
                type="button"
                data-testid="run-provisioning-btn"
                disabled={isProvisioningRunning}
                onClick={() => void handleRunProvisioning()}
                className="min-h-6 px-4 py-2 rounded-md bg-[#66c0f4] text-slate-950 font-bold hover:brightness-110 transition-all text-xs flex items-center gap-1.5 shadow cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#66c0f4]"
              >
                <Play aria-hidden="true" className="w-3.5 h-3.5 fill-slate-950" />
                <span>
                  {isProvisioningRunning
                    ? 'Installing...'
                    : `Install Selected (${plannedTasks.length})`}
                </span>
              </button>
            )}

            {showNextStepBtn && nextStep && (
              <button
                type="button"
                data-testid="setup-next-step-btn"
                disabled={
                  isProvisioningRunning ||
                  activeGuidedLoginTarget !== null ||
                  (activeStep === 'compatibility' &&
                    isMacHost &&
                    chosenRunner !== 'skip' &&
                    !isValidBottleNameInput(bottleName))
                }
                onClick={() => navigateToStep(nextStep.id)}
                className={`min-h-6 px-4 py-2 rounded-md text-xs flex items-center gap-1.5 transition-all cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#66c0f4] ${
                  activeStep !== 'summary' ||
                  (plannedTasks.length === 0 && !lastRunError && pendingActionableLogins > 0)
                    ? 'bg-[#66c0f4] text-slate-950 font-bold hover:brightness-110 shadow'
                    : 'bg-[#1b2838] border border-[#2a475e] font-semibold text-slate-200 hover:text-white hover:border-slate-400'
                }`}
              >
                <span>
                  {activeStep === 'summary' &&
                  plannedTasks.length === 0 &&
                  pendingActionableLogins > 0
                    ? `Continue to Sign In (${pendingActionableLogins})`
                    : `Next: ${nextStep.fullTitle}`}
                </span>
                <ChevronRight aria-hidden="true" className="w-3.5 h-3.5" />
              </button>
            )}

            {showFinishSetupBtn && (
              <button
                type="button"
                data-testid="finish-setup-btn"
                disabled={isProvisioningRunning || activeGuidedLoginTarget !== null}
                onClick={handleFinishSetup}
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
