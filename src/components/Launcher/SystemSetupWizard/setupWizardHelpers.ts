import React from 'react';
import { Cloud, Download, KeyRound, Layers, ShieldCheck, Wrench } from 'lucide-react';
import type {
  EnvironmentComponentId,
  EnvironmentHealthSnapshot,
  EnvironmentSetupTaskOutcome,
  SetupWizardStepId,
} from '../../../contracts/environmentSetup';
import type { CompatibilityLayerType } from '../../../contracts/launcher';
import {
  isBottleRecordCompatibleWithRunner,
  isPersistedBottleCompatibleWithRunner,
  resolveDefaultBottleForRunner,
} from '../../../services/launcher/bottleArchitectureUtils';
import { environmentSetupService } from '../../../services/launcher/environmentSetupService';

export interface WizardStepMeta {
  id: SetupWizardStepId;
  number: number;
  shortTitle: string;
  fullTitle: string;
  icon: React.ComponentType<{ className?: string; 'aria-hidden'?: boolean | 'true' | 'false' }>;
}

export const MAC_WIZARD_STEPS: ReadonlyArray<WizardStepMeta> = [
  { id: 'accounts', number: 1, shortTitle: '1. Accounts', fullTitle: 'Accounts', icon: Cloud },
  {
    id: 'compatibility',
    number: 2,
    shortTitle: '2. Windows Games',
    fullTitle: 'Windows Games',
    icon: Layers,
  },
  { id: 'clients', number: 3, shortTitle: '3. Launchers', fullTitle: 'Launchers', icon: Download },
  { id: 'summary', number: 4, shortTitle: '4. Install', fullTitle: 'Install', icon: Wrench },
  { id: 'client_logins', number: 5, shortTitle: '5. Sign In', fullTitle: 'Sign In', icon: KeyRound },
];

export const WINDOWS_WIZARD_STEPS: ReadonlyArray<WizardStepMeta> = [
  {
    id: 'prerequisites',
    number: 1,
    shortTitle: '1. System',
    fullTitle: 'System',
    icon: ShieldCheck,
  },
  { id: 'accounts', number: 2, shortTitle: '2. Accounts', fullTitle: 'Accounts', icon: Cloud },
  { id: 'clients', number: 3, shortTitle: '3. Launchers', fullTitle: 'Launchers', icon: Download },
  { id: 'summary', number: 4, shortTitle: '4. Install', fullTitle: 'Install', icon: Wrench },
  { id: 'client_logins', number: 5, shortTitle: '5. Sign In', fullTitle: 'Sign In', icon: KeyRound },
];

export function getWizardStepsForHost(
  hostPlatform: EnvironmentHealthSnapshot['hostPlatform']
): ReadonlyArray<WizardStepMeta> {
  return hostPlatform === 'darwin' ? MAC_WIZARD_STEPS : WINDOWS_WIZARD_STEPS;
}

export const RUNNER_COMPONENT_MAP: ReadonlyArray<{
  runner: Exclude<CompatibilityLayerType, 'native'>;
  componentId: Extract<
    EnvironmentComponentId,
    | 'runner_crossover'
    | 'runner_crossover_preview'
    | 'runner_crossover_preview_arm64'
    | 'runner_wine'
    | 'runner_gptk'
  >;
}> = [
  { runner: 'crossover', componentId: 'runner_crossover' },
  { runner: 'crossover_preview', componentId: 'runner_crossover_preview' },
  { runner: 'crossover_preview_arm64', componentId: 'runner_crossover_preview_arm64' },
  { runner: 'wine', componentId: 'runner_wine' },
  { runner: 'gptk', componentId: 'runner_gptk' },
];

export function formatRunnerLabel(runner: Exclude<CompatibilityLayerType, 'native'>): string {
  switch (runner) {
    case 'crossover':
      return 'CrossOver';
    case 'crossover_preview':
      return 'CrossOver Preview';
    case 'crossover_preview_arm64':
      return 'CrossOver Preview (arm64 / FEX)';
    case 'wine':
      return 'Wine';
    case 'gptk':
      return 'Game Porting Toolkit';
    default:
      return runner;
  }
}

export function formatHostBadgeLabel(snap: EnvironmentHealthSnapshot): string {
  if (snap.hostPlatform === 'darwin') {
    return snap.isAppleSiliconMac ? 'macOS • Apple Silicon' : 'macOS • Intel';
  }
  if (snap.hostPlatform === 'win32') {
    return 'Windows PC';
  }
  return 'Desktop';
}

export function resolveInitialStep(
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
    focusComponentId === 'runner_crossover_preview_arm64' ||
    focusComponentId === 'runner_wine' ||
    focusComponentId === 'runner_gptk' ||
    focusComponentId === 'bottle_default'
  ) {
    return hostPlatform === 'darwin' ? 'compatibility' : 'prerequisites';
  }
  return 'clients';
}

export function resolveDefaultRunner(
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
    if (
      persistedRunner === 'crossover_preview_arm64' &&
      !snap.isAppleSiliconMac &&
      snap.components.runner_crossover_preview_arm64?.status !== 'ready'
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
      r.type !== 'native' && r.available !== false
  );
  if (firstDetected) {
    return firstDetected.type;
  }
  return 'crossover';
}

export function resolveRestoredBottleState(params: {
  snap: EnvironmentHealthSnapshot;
  resolvedRunner: Exclude<CompatibilityLayerType, 'native'> | 'skip';
  persistedRunnerType?: Exclude<CompatibilityLayerType, 'native'> | 'skip';
  persistedBottleName?: string;
}): { bottleMode: 'reuse_existing' | 'create_dedicated'; bottleName: string } {
  const { snap, resolvedRunner, persistedRunnerType, persistedBottleName } = params;
  const avail = snap.bottleSummary?.availableBottles ?? [];
  const compatAvail = avail.filter((b) => isBottleRecordCompatibleWithRunner(b, resolvedRunner));
  const persistedBottle = persistedBottleName?.trim();
  const canRestorePersisted = Boolean(
    persistedBottle &&
      (!persistedRunnerType || persistedRunnerType === resolvedRunner) &&
      isPersistedBottleCompatibleWithRunner(persistedBottle, resolvedRunner, snap)
  );
  const bottleName = canRestorePersisted
    ? persistedBottle!
    : resolveDefaultBottleForRunner(resolvedRunner, snap);
  const bottleMode: 'reuse_existing' | 'create_dedicated' = canRestorePersisted
    ? compatAvail.some((b) => b.name === persistedBottle)
      ? 'reuse_existing'
      : 'create_dedicated'
    : compatAvail.length > 0
      ? 'reuse_existing'
      : 'create_dedicated';
  return { bottleMode, bottleName };
}

export function readServiceRunnerUpdateOptInSet(
  focusComponentId?: EnvironmentComponentId,
  snap?: EnvironmentHealthSnapshot
): Set<EnvironmentComponentId> {
  const next = new Set<EnvironmentComponentId>();
  for (const entry of RUNNER_COMPONENT_MAP) {
    if (environmentSetupService.getRunnerUpdateOptIn(entry.componentId) === true) {
      next.add(entry.componentId);
    }
  }
  if (
    focusComponentId &&
    RUNNER_COMPONENT_MAP.some((entry) => entry.componentId === focusComponentId) &&
    snap?.components[focusComponentId]?.status === 'update_available' &&
    environmentSetupService.getRunnerUpdateOptIn(focusComponentId) === undefined
  ) {
    next.add(focusComponentId);
  }
  return next;
}

export function collectConfiguredReadyComponents(
  snap: EnvironmentHealthSnapshot,
  selectedIds: ReadonlySet<EnvironmentComponentId>,
  outcomes: ReadonlyArray<EnvironmentSetupTaskOutcome>
): EnvironmentComponentId[] {
  const failedOrCancelledIds = new Set(
    outcomes
      .filter((o) => o.status === 'failed' || o.status === 'cancelled')
      .map((o) => o.componentId)
  );
  const configured = new Set<EnvironmentComponentId>();
  for (const comp of Object.values(snap.components)) {
    if (comp && comp.status === 'ready') {
      configured.add(comp.id);
    }
  }
  for (const outcome of outcomes) {
    if (
      outcome.status === 'completed' &&
      outcome.action !== 'sync_first_party_manifests' &&
      !failedOrCancelledIds.has(outcome.componentId)
    ) {
      configured.add(outcome.componentId);
    }
  }
  for (const id of selectedIds) {
    if (snap.components[id]?.status === 'ready' && !failedOrCancelledIds.has(id)) {
      configured.add(id);
    }
  }
  return Array.from(configured);
}
