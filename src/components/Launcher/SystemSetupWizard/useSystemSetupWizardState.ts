import { useEffect, useMemo, useRef, useState } from 'react';
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
  DEFAULT_ARM64_BOTTLE_NAME,
  DEFAULT_WIN64_BOTTLE_NAME,
  isBottleRecordCompatibleWithRunner,
  resolveDefaultBottleForRunner,
} from '../../../services/launcher/bottleArchitectureUtils';
import {
  buildFallbackEnvironmentSnapshot,
  buildProvisioningTasksFromSelection,
  computeDefaultSelectedComponents,
  environmentSetupService,
  getRemovedComponents,
  isCompleteHealthSnapshot,
} from '../../../services/launcher/environmentSetupService';
import { isValidBottleNameInput } from './steps/CompatibilityAndBottleStep';
import {
  collectConfiguredReadyComponents,
  getWizardStepsForHost,
  readServiceRunnerUpdateOptInSet,
  resolveDefaultRunner,
  resolveInitialStep,
  resolveRestoredBottleState,
  RUNNER_COMPONENT_MAP,
} from './setupWizardHelpers';

export interface UseSystemSetupWizardStateParams {
  isOpen: boolean;
  mode: SetupWizardOpenMode;
  initialStep?: SetupWizardStepId;
  focusComponentId?: EnvironmentComponentId;
  connectedStorefronts: StorefrontId[];
  onClose: () => void;
}

export function useSystemSetupWizardState({
  isOpen,
  mode,
  initialStep,
  focusComponentId,
  connectedStorefronts,
  onClose,
}: UseSystemSetupWizardStateParams) {
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
    const persistedWizard = environmentSetupService.getWizardState();
    const initialRunner = resolveDefaultRunner(initialSnap, persistedWizard?.preferredRunnerType);
    return resolveRestoredBottleState({
      snap: initialSnap,
      resolvedRunner: initialRunner,
      persistedRunnerType: persistedWizard?.preferredRunnerType,
      persistedBottleName: persistedWizard?.preferredBottleName,
    }).bottleMode;
  });
  const [bottleName, setBottleName] = useState<string>(() => {
    const initialSnap =
      environmentSetupService.getLastSnapshot() ??
      buildFallbackEnvironmentSnapshot(connectedStorefronts);
    const persistedWizard = environmentSetupService.getWizardState();
    const initialRunner = resolveDefaultRunner(initialSnap, persistedWizard?.preferredRunnerType);
    return resolveRestoredBottleState({
      snap: initialSnap,
      resolvedRunner: initialRunner,
      persistedRunnerType: persistedWizard?.preferredRunnerType,
      persistedBottleName: persistedWizard?.preferredBottleName,
    }).bottleName;
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
  const [runnerUpdateOptInIds, setRunnerUpdateOptInIds] = useState<Set<EnvironmentComponentId>>(
    () =>
      readServiceRunnerUpdateOptInSet(
        focusComponentId,
        environmentSetupService.getLastSnapshot() ??
          buildFallbackEnvironmentSnapshot(connectedStorefronts)
      )
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
  const hasUserCustomizedRunnerOrBottleRef = useRef<boolean>(false);
  const chosenRunnerRef = useRef(chosenRunner);
  chosenRunnerRef.current = chosenRunner;
  const bottleModeRef = useRef(bottleMode);
  bottleModeRef.current = bottleMode;
  const bottleNameRef = useRef(bottleName);
  bottleNameRef.current = bottleName;

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
      setRunnerUpdateOptInIds((prev) => {
        const synced = readServiceRunnerUpdateOptInSet(focusComponentId, nextSnap ?? undefined);
        if (prev.size === synced.size && Array.from(prev).every((id) => synced.has(id))) {
          return prev;
        }
        return synced;
      });
      setIsProvisioningRunning(environmentSetupService.isSetupRunning());
      setActiveGuidedLoginTarget(environmentSetupService.getActiveGuidedLoginTarget());
      setLatestProgress(environmentSetupService.getLatestProgress());
    };
    return environmentSetupService.subscribe(syncFromService);
  }, [isOpen, focusComponentId]);

  useEffect(() => {
    if (!isOpen) {
      hasUserCustomizedRunnerOrBottleRef.current = false;
      return undefined;
    }
    let active = true;
    hasUserCustomizedRunnerOrBottleRef.current = false;
    setIsProbing(true);

    Promise.all([
      environmentSetupService.loadWizardState(),
      environmentSetupService.probeHealth(connectedStorefronts, { forceFresh: true }),
    ])
      .then(([persistedState, probedSnap]) => {
        if (!active) return;
        setSnapshot(probedSnap);
        const resolvedRunner = resolveDefaultRunner(probedSnap, persistedState.preferredRunnerType);
        const avail = probedSnap.bottleSummary?.availableBottles ?? [];
        const { bottleMode: restoredBottleMode, bottleName: restoredBottleName } =
          resolveRestoredBottleState({
            snap: probedSnap,
            resolvedRunner,
            persistedRunnerType: persistedState.preferredRunnerType,
            persistedBottleName: persistedState.preferredBottleName,
          });
        if (!hasUserCustomizedRunnerOrBottleRef.current) {
          chosenRunnerRef.current = resolvedRunner;
          bottleModeRef.current = restoredBottleMode;
          bottleNameRef.current = restoredBottleName;
          setChosenRunner(resolvedRunner);
          setBottleMode(restoredBottleMode);
          setBottleName(restoredBottleName);
        }
        if (!hasUserCustomizedSelectionRef.current) {
          const activeRunner = hasUserCustomizedRunnerOrBottleRef.current
            ? chosenRunnerRef.current
            : resolvedRunner;
          const activeMode = hasUserCustomizedRunnerOrBottleRef.current
            ? bottleModeRef.current
            : restoredBottleMode;
          const activeBottleName = hasUserCustomizedRunnerOrBottleRef.current
            ? bottleNameRef.current
            : restoredBottleName;
          const nextSelected = computeDefaultSelectedComponents(probedSnap, connectedStorefronts, {
            chosenRunner: activeRunner,
            focusComponentId,
          });
          if (activeRunner !== 'skip') {
            const trimmedTarget =
              activeBottleName.trim() || resolveDefaultBottleForRunner(activeRunner, probedSnap);
            const matchedTarget = avail.find(
              (b) => b.name === trimmedTarget && isBottleRecordCompatibleWithRunner(b, activeRunner)
            );
            const needsDedicatedCreation =
              !matchedTarget &&
              (avail.length > 0
                ? activeMode === 'create_dedicated' || activeRunner === 'crossover_preview_arm64'
                : activeRunner === 'crossover_preview_arm64' &&
                  (probedSnap.bottleSummary?.runnerType !== 'crossover_preview_arm64' ||
                    probedSnap.bottleSummary?.recommendedBottleName !== trimmedTarget));
            if (needsDedicatedCreation) {
              const bottleComp = probedSnap.components.bottle_default;
              if (bottleComp && bottleComp.status !== 'not_applicable') {
                nextSelected.add('bottle_default');
              }
              const steamRelevant =
                connectedStorefronts.includes('steam') || connectedStorefronts.length === 0;
              const bottleSteamComp = probedSnap.components.bottle_steam;
              if (
                steamRelevant &&
                bottleSteamComp &&
                bottleSteamComp.status !== 'not_applicable'
              ) {
                nextSelected.add('bottle_steam');
              }
            }
          }
          setSelectedIds(nextSelected);
          setRunnerUpdateOptInIds(readServiceRunnerUpdateOptInSet(focusComponentId, probedSnap));
        }
      })
      .catch(() => {})
      .finally(() => {
        if (active) setIsProbing(false);
      });

    return () => {
      active = false;
      hasUserCustomizedRunnerOrBottleRef.current = false;
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
    : resolveDefaultBottleForRunner(chosenRunner, snapshot);

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
        runnerUpdateOptInIds,
      }),
    [
      snapshot,
      effectiveSelectedIds,
      chosenRunner,
      bottleMode,
      effectiveBottleName,
      gptkDmgPath,
      forceRepairIds,
      runnerUpdateOptInIds,
    ]
  );

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

  const syncBottleComponentSelection = (
    targetRunner: Exclude<CompatibilityLayerType, 'native'> | 'skip',
    targetMode: 'reuse_existing' | 'create_dedicated',
    targetBottleName: string
  ) => {
    if (targetRunner === 'skip') return;
    const avail = snapshot.bottleSummary?.availableBottles ?? [];
    const trimmedTarget =
      targetBottleName.trim() || resolveDefaultBottleForRunner(targetRunner, snapshot);
    const matchedTarget = avail.find(
      (b) => b.name === trimmedTarget && isBottleRecordCompatibleWithRunner(b, targetRunner)
    );
    const targetBottleExistsCompat = Boolean(matchedTarget);
    const needsDedicatedCreation =
      !targetBottleExistsCompat &&
      (avail.length > 0
        ? targetMode === 'create_dedicated' || targetRunner === 'crossover_preview_arm64'
        : targetRunner === 'crossover_preview_arm64');
    if (!needsDedicatedCreation) return;

    setSelectedIds((prev) => {
      const next = new Set(prev);
      const bottleComp = snapshot.components.bottle_default;
      if (bottleComp && bottleComp.status !== 'not_applicable') {
        next.add('bottle_default');
      }
      const steamRelevant =
        liveConnectedStorefronts.includes('steam') || liveConnectedStorefronts.length === 0;
      const bottleSteamComp = snapshot.components.bottle_steam;
      if (
        steamRelevant &&
        bottleSteamComp &&
        bottleSteamComp.status !== 'not_applicable' &&
        !matchedTarget?.hasSteam
      ) {
        next.add('bottle_steam');
      }
      return next;
    });
  };

  const handleChangeBottleMode = (nextMode: 'reuse_existing' | 'create_dedicated') => {
    hasUserCustomizedRunnerOrBottleRef.current = true;
    bottleModeRef.current = nextMode;
    setBottleMode(nextMode);
    syncBottleComponentSelection(chosenRunnerRef.current, nextMode, bottleNameRef.current);
  };

  const handleChangeBottleName = (nextName: string) => {
    hasUserCustomizedRunnerOrBottleRef.current = true;
    bottleNameRef.current = nextName;
    setBottleName(nextName);
    syncBottleComponentSelection(chosenRunnerRef.current, bottleModeRef.current, nextName);
  };

  const handleSelectRunner = (nextRunner: Exclude<CompatibilityLayerType, 'native'> | 'skip') => {
    hasUserCustomizedRunnerOrBottleRef.current = true;
    chosenRunnerRef.current = nextRunner;
    setChosenRunner(nextRunner);
    const nextRunnerComponentId =
      nextRunner !== 'skip'
        ? RUNNER_COMPONENT_MAP.find((e) => e.runner === nextRunner)?.componentId
        : undefined;
    for (const entry of RUNNER_COMPONENT_MAP) {
      if (entry.componentId !== nextRunnerComponentId) {
        environmentSetupService.setRunnerUpdateOptIn(entry.componentId, false);
      }
    }
    setRunnerUpdateOptInIds((prev) => {
      const next = new Set<EnvironmentComponentId>();
      if (nextRunnerComponentId && prev.has(nextRunnerComponentId)) {
        next.add(nextRunnerComponentId);
      }
      return next;
    });
    let resolvedNextBottleName = bottleNameRef.current.trim();
    let targetBottleExistsCompat = true;
    if (nextRunner !== 'skip') {
      const avail = snapshot.bottleSummary?.availableBottles ?? [];
      const compatBottles = avail.filter((b) => isBottleRecordCompatibleWithRunner(b, nextRunner));
      const trimmedCur = bottleNameRef.current.trim();
      const isDefaultBottle =
        !trimmedCur ||
        trimmedCur === DEFAULT_WIN64_BOTTLE_NAME ||
        trimmedCur === DEFAULT_ARM64_BOTTLE_NAME;
      const existingBottle = avail.find((b) => b.name === trimmedCur);
      const isExistingIncompatible =
        Boolean(existingBottle) && !isBottleRecordCompatibleWithRunner(existingBottle!, nextRunner);

      if (isDefaultBottle || isExistingIncompatible) {
        resolvedNextBottleName = resolveDefaultBottleForRunner(nextRunner, snapshot);
        const nextMode = compatBottles.length > 0 ? 'reuse_existing' : 'create_dedicated';
        bottleNameRef.current = resolvedNextBottleName;
        bottleModeRef.current = nextMode;
        setBottleName(resolvedNextBottleName);
        setBottleMode(nextMode);
      } else if (compatBottles.length === 0 && bottleModeRef.current === 'reuse_existing') {
        bottleModeRef.current = 'create_dedicated';
        setBottleMode('create_dedicated');
      }
      targetBottleExistsCompat = avail.some(
        (b) => b.name === resolvedNextBottleName && isBottleRecordCompatibleWithRunner(b, nextRunner)
      );
    }
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
        next.delete('bottle_ubisoft');
        next.delete('bottle_ea');
        next.delete('bottle_bnet');
        next.delete('bottle_rockstar');
        return next;
      }
      const match = RUNNER_COMPONENT_MAP.find((e) => e.runner === nextRunner);
      if (match) {
        const comp = snapshot.components[match.componentId];
        if (
          comp &&
          comp.status !== 'ready' &&
          comp.status !== 'update_available' &&
          comp.status !== 'not_applicable'
        ) {
          next.add(match.componentId);
        }
      }
      const avail = snapshot.bottleSummary?.availableBottles ?? [];
      const bottleComp = snapshot.components.bottle_default;
      const needsBottleCreation =
        !targetBottleExistsCompat && (avail.length > 0 || nextRunner === 'crossover_preview_arm64');
      if (
        bottleComp &&
        bottleComp.status !== 'not_applicable' &&
        (bottleComp.status !== 'ready' || needsBottleCreation)
      ) {
        next.add('bottle_default');
      }
      const steamRelevant =
        liveConnectedStorefronts.includes('steam') || liveConnectedStorefronts.length === 0;
      const bottleSteamComp = snapshot.components.bottle_steam;
      if (
        steamRelevant &&
        bottleSteamComp &&
        bottleSteamComp.status !== 'not_applicable' &&
        (bottleSteamComp.status === 'missing' || needsBottleCreation)
      ) {
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

  const handleToggleRunnerUpdate = (id: EnvironmentComponentId, enabled: boolean) => {
    hasUserCustomizedSelectionRef.current = true;
    environmentSetupService.setRunnerUpdateOptIn(id, enabled);
    setRunnerUpdateOptInIds((prev) => {
      const next = new Set(prev);
      if (enabled) {
        next.add(id);
      } else {
        next.delete(id);
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
    let nextRunner = chosenRunner;
    for (const comp of removedComponents) {
      const runnerEntry = RUNNER_COMPONENT_MAP.find((r) => r.componentId === comp.id);
      if (runnerEntry && snapshot.hostPlatform === 'darwin' && nextRunner === 'skip') {
        nextRunner = runnerEntry.runner;
      }
    }
    if (nextRunner !== chosenRunner) {
      handleSelectRunner(nextRunner);
    }
    setSelectedIds((prev) => {
      const nextSelected = new Set(prev);
      for (const comp of removedComponents) {
        nextSelected.add(comp.id);
      }
      return nextSelected;
    });
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
    const failedOrCancelledIds = new Set(
      runOutcomes
        .filter((o) => o.status === 'failed' || o.status === 'cancelled')
        .map((o) => o.componentId)
    );
    const completedComponentIds = runOutcomes
      .filter(
        (o) =>
          o.status === 'completed' &&
          o.action !== 'sync_first_party_manifests' &&
          !failedOrCancelledIds.has(o.componentId)
      )
      .map((o) => o.componentId);
    if (completedComponentIds.length > 0) {
      setForceRepairIds((prev) => {
        let changed = false;
        const next = new Set(prev);
        for (const id of completedComponentIds) {
          if (next.delete(id)) changed = true;
        }
        return changed ? next : prev;
      });
      setRunnerUpdateOptInIds((prev) => {
        let changed = false;
        const next = new Set(prev);
        for (const id of completedComponentIds) {
          if (next.delete(id)) changed = true;
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
    const configuredIds = collectConfiguredReadyComponents(nextSnapshot, selectedIds, runOutcomes);
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
  const pendingActionableLogins = counts.pendingClientLoginCount + counts.accountMismatchCount;

  const isInstallWorkDone = !isProvisioningRunning && plannedTasks.length === 0 && !lastRunError;
  const isSignInWorkDone =
    pendingActionableLogins === 0 || (activeStep === 'client_logins' && allPendingSkippedInQueue);
  const showFinishSetupBtn =
    isInstallWorkDone &&
    isSignInWorkDone &&
    activeGuidedLoginTarget === null &&
    (activeStep === 'client_logins' || activeStep === 'summary');
  const showNextStepBtn = Boolean(nextStep) && !(activeStep === 'summary' && showFinishSetupBtn);

  const isMacHost = snapshot.hostPlatform === 'darwin';
  const isWinHost = snapshot.hostPlatform === 'win32';
  const trimmedBottleForNext = bottleName.trim();
  const matchedBottleForNext = trimmedBottleForNext
    ? (snapshot.bottleSummary?.availableBottles ?? []).find((b) => b.name === trimmedBottleForNext)
    : undefined;
  const hasIncompatibleSelectedBottle = Boolean(
    isMacHost &&
      chosenRunner !== 'skip' &&
      matchedBottleForNext &&
      !isBottleRecordCompatibleWithRunner(matchedBottleForNext, chosenRunner)
  );
  const isBlockedFromAdvancingCompat = Boolean(
    activeStep === 'compatibility' &&
      isMacHost &&
      chosenRunner !== 'skip' &&
      (!isValidBottleNameInput(bottleName) || hasIncompatibleSelectedBottle)
  );
  const winPrereqsReady =
    isWinHost &&
    snapshot.components.win_vcredist?.status === 'ready' &&
    snapshot.components.win_webview2?.status !== 'missing';

  return {
    liveConnectedStorefronts,
    snapshot,
    setSnapshot,
    activeStep,
    wizardSteps,
    currentStepIdx,
    effectiveHighestReachedIdx,
    prevStep,
    nextStep,
    installStepNumber,
    chosenRunner,
    bottleMode,
    bottleName,
    effectiveBottleName,
    gptkDmgPath,
    setGptkDmgPath,
    selectedIds,
    forceRepairIds,
    runnerUpdateOptInIds,
    removedComponents,
    plannedTasks,
    isProbing,
    isProvisioningRunning,
    activeGuidedLoginTarget,
    latestProgress,
    outcomes,
    lastRunError,
    autoCloseGuidedLogin,
    setAutoCloseGuidedLogin,
    setAllPendingSkippedInQueue,
    pendingActionableLogins,
    showFinishSetupBtn,
    showNextStepBtn,
    isMacHost,
    isWinHost,
    isBlockedFromAdvancingCompat,
    winPrereqsReady,
    navigateToStep,
    handleRescanEnvironment,
    handleChangeBottleMode,
    handleChangeBottleName,
    handleSelectRunner,
    handleToggleComponent,
    handleToggleRunnerUpdate,
    handleToggleForceRepair,
    handleSelectRemovedComponentsForRepair,
    handleAccountsChanged,
    handleRunProvisioning,
    handleCancelProvisioning,
    handleCloseOrSkip,
    handleFinishSetup,
  };
}
