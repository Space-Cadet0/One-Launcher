import React, { useRef, useState } from 'react';
import { Monitor } from 'lucide-react';
import type {
  EnvironmentComponentId,
  EnvironmentComponentState,
  EnvironmentHealthSnapshot,
} from '../../../../contracts/environmentSetup';
import type { CompatibilityLayerType } from '../../../../contracts/launcher';
import {
  getDefaultBottleNameForRunner,
  isBottleRecordCompatibleWithRunner,
} from '../../../../services/launcher/bottleArchitectureUtils';
import { environmentSetupService } from '../../../../services/launcher/environmentSetupService';
import {
  renderRunnerSelectionCards,
  type RunnerCardRenderEntry,
  type SetupRunnerChoice,
} from './RunnerSelectionCards';
import { renderBottleProvisioningCard } from './BottleProvisioningCard';

export interface CompatibilityAndBottleStepProps {
  snapshot: EnvironmentHealthSnapshot;
  chosenRunner: SetupRunnerChoice;
  onSelectRunner: (runner: SetupRunnerChoice) => void;
  bottleMode: 'reuse_existing' | 'create_dedicated';
  onChangeBottleMode: (mode: 'reuse_existing' | 'create_dedicated') => void;
  bottleName: string;
  onChangeBottleName: (name: string) => void;
  gptkDmgPath?: string;
  onChangeGptkDmgPath?: (path: string) => void;
  selectedIds?: ReadonlySet<EnvironmentComponentId>;
  runnerUpdateOptInIds?: ReadonlySet<EnvironmentComponentId>;
  onToggleComponent?: (id: EnvironmentComponentId) => void;
  onToggleRunnerUpdate?: (id: EnvironmentComponentId, enabled: boolean) => void;
}

export function isValidBottleNameInput(raw: string): boolean {
  const trimmed = raw.trim();
  if (!trimmed) return false;
  if (trimmed.startsWith('-')) return false;
  if (trimmed === '.' || trimmed.includes('..')) return false;
  return /^[A-Za-z0-9 _.-]{1,64}$/.test(trimmed);
}

const INSTALLED_NOTE_CLASS =
  'rounded bg-emerald-950/35 border border-emerald-500/40 px-2.5 py-1.5 text-[10px] text-emerald-200 leading-snug';
const AMBER_NOTE_CLASS =
  'rounded bg-amber-950/40 border border-amber-500/35 px-2.5 py-1.5 text-[10px] text-amber-200 leading-snug';
const NEUTRAL_NOTE_CLASS =
  'rounded bg-[#131c27] border border-[#2a475e]/70 px-2.5 py-1.5 text-[10px] text-slate-300 leading-snug';

export const CompatibilityAndBottleStep: React.FC<CompatibilityAndBottleStepProps> = ({
  snapshot,
  chosenRunner,
  onSelectRunner,
  bottleMode,
  onChangeBottleMode,
  bottleName,
  onChangeBottleName,
  selectedIds,
  runnerUpdateOptInIds,
  onToggleComponent,
  onToggleRunnerUpdate,
}) => {
  const runnerRadioRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const reuseBottleRadioRef = useRef<HTMLButtonElement | null>(null);
  const createBottleRadioRef = useRef<HTMLButtonElement | null>(null);
  const [localUpdateOptIn, setLocalUpdateOptIn] = useState<
    Partial<Record<EnvironmentComponentId, boolean>>
  >(() => ({
    runner_crossover: environmentSetupService.getRunnerUpdateOptIn('runner_crossover'),
    runner_crossover_preview: environmentSetupService.getRunnerUpdateOptIn(
      'runner_crossover_preview'
    ),
    runner_crossover_preview_arm64: environmentSetupService.getRunnerUpdateOptIn(
      'runner_crossover_preview_arm64'
    ),
    runner_wine: environmentSetupService.getRunnerUpdateOptIn('runner_wine'),
    runner_gptk: environmentSetupService.getRunnerUpdateOptIn('runner_gptk'),
  }));

  if (snapshot.hostPlatform !== 'darwin') {
    return (
      <div className="space-y-4" data-testid="setup-step-compatibility-win32">
        <div className="rounded-lg bg-[#16202d] border border-emerald-500/45 p-4 space-y-2">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <Monitor className="w-5 h-5 text-emerald-400 shrink-0" aria-hidden="true" />
              <h3 className="text-sm font-bold text-white">Ready for Windows Games</h3>
            </div>
            <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded bg-emerald-500/20 border border-emerald-500/40 text-[10px] font-bold text-emerald-300">
              <span>Ready</span>
            </span>
          </div>
          <p className="text-xs text-slate-200 leading-relaxed">
            Your PC runs Windows games natively — no extra compatibility tools are needed.
          </p>
        </div>
      </div>
    );
  }

  const crossoverComp = snapshot.components.runner_crossover;
  const crossoverPreviewComp = snapshot.components.runner_crossover_preview;
  const crossoverPreviewArm64Comp = snapshot.components.runner_crossover_preview_arm64;
  const wineComp = snapshot.components.runner_wine;
  const gptkComp = snapshot.components.runner_gptk;
  const availableBottles = snapshot.bottleSummary?.availableBottles ?? [];
  const bottleNameValid = isValidBottleNameInput(bottleName);

  const isLayerInstalled = (status: string | undefined): boolean =>
    status === 'ready' || status === 'update_available';

  const isCrossOverStdInstalled = isLayerInstalled(crossoverComp?.status);
  const isCrossOverPreviewInstalled = isLayerInstalled(crossoverPreviewComp?.status);
  const isCrossOverPreviewArm64Installed = isLayerInstalled(crossoverPreviewArm64Comp?.status);
  const isWineInstalled = isLayerInstalled(wineComp?.status);
  const isGptkInstalled = isLayerInstalled(gptkComp?.status);

  const showCrossOverPreviewArm64Option = Boolean(
    snapshot.isAppleSiliconMac || snapshot.hostArch === 'arm64'
  );
  const showGptkOption = snapshot.isAppleSiliconMac || isGptkInstalled;

  const runnerEntries: RunnerCardRenderEntry[] = [
    {
      runner: 'crossover',
      slug: 'crossover',
      testId: 'setup-runner-crossover',
      title: 'CrossOver',
      badgeText: 'Recommended',
      badgeClassName:
        'px-2 py-0.5 rounded bg-sky-500/20 border border-sky-400/50 text-[10px] font-bold text-sky-200',
      description: 'Best compatibility and performance for modern Windows games on Mac.',
      component: crossoverComp,
      installed: isCrossOverStdInstalled,
      removed: !isCrossOverStdInstalled && Boolean(crossoverComp?.wasPreviouslyConfigured),
      statusNote: isCrossOverStdInstalled
        ? 'Installed on your Mac — ready to use.'
        : 'Not installed yet — One Launcher will download it if selected. Paid app (14-day free trial).',
      statusNoteClassName: isCrossOverStdInstalled ? INSTALLED_NOTE_CLASS : AMBER_NOTE_CLASS,
      updateOptInRunner: 'crossover',
    },
    {
      runner: 'crossover_preview',
      slug: 'crossover-preview',
      testId: 'setup-runner-crossover-preview',
      title: 'CrossOver Preview',
      badgeText: 'Preview',
      badgeClassName:
        'px-2 py-0.5 rounded bg-purple-500/20 border border-purple-400/50 text-[10px] font-bold text-purple-200',
      description: 'Early-access CodeWeavers build with bleeding-edge D3DMetal and Wine fixes.',
      component: crossoverPreviewComp,
      installed: isCrossOverPreviewInstalled,
      removed:
        !isCrossOverPreviewInstalled && Boolean(crossoverPreviewComp?.wasPreviouslyConfigured),
      statusNote: isCrossOverPreviewInstalled
        ? 'Installed on your Mac — ready to use alongside or instead of Stable.'
        : 'Not installed yet — sign in to CodeWeavers during setup to auto-download & install.',
      statusNoteClassName: isCrossOverPreviewInstalled ? INSTALLED_NOTE_CLASS : NEUTRAL_NOTE_CLASS,
      updateOptInRunner: 'crossover_preview',
    },
    ...(showCrossOverPreviewArm64Option
      ? [
          {
            runner: 'crossover_preview_arm64' as const,
            slug: 'crossover-preview-arm64',
            testId: 'setup-runner-crossover-preview-arm64',
            title: 'CrossOver Preview (arm64 / FEX)',
            badgeText: 'arm64 / FEX',
            badgeClassName:
              'px-2 py-0.5 rounded bg-indigo-500/20 border border-indigo-400/50 text-[10px] font-bold text-indigo-200',
            description: (
              <>
                Experimental arm64 Wine + FEX branch on Apple Silicon using an isolated{' '}
                <span className="font-mono text-indigo-200">OneLauncher-arm64</span> bottle.
              </>
            ),
            component: crossoverPreviewArm64Comp,
            installed: isCrossOverPreviewArm64Installed,
            removed:
              !isCrossOverPreviewArm64Installed &&
              Boolean(crossoverPreviewArm64Comp?.wasPreviouslyConfigured),
            statusNote: isCrossOverPreviewArm64Installed
              ? 'Installed on your Mac — ready to use with dedicated arm64 bottles.'
              : crossoverPreviewArm64Comp?.authRequired
                ? 'CodeWeavers sign-in required — sign in during setup to download & install into “OneLauncher-arm64”.'
                : 'Not installed yet — sign in to CodeWeavers during setup to auto-download & install as CrossOver Preview arm64.',
            statusNoteClassName: isCrossOverPreviewArm64Installed
              ? INSTALLED_NOTE_CLASS
              : crossoverPreviewArm64Comp?.authRequired
                ? AMBER_NOTE_CLASS
                : NEUTRAL_NOTE_CLASS,
            updateOptInRunner: 'crossover_preview_arm64' as const,
          },
        ]
      : []),
    {
      runner: 'wine',
      slug: 'wine',
      testId: 'setup-runner-wine',
      title: 'Wine',
      badgeText: 'Free',
      badgeClassName:
        'px-2 py-0.5 rounded bg-sky-500/15 border border-sky-400/40 text-[10px] font-bold text-sky-200',
      description: 'Free, open-source option. Works well for older and lighter Windows games.',
      component: wineComp,
      installed: isWineInstalled,
      removed: !isWineInstalled && Boolean(wineComp?.wasPreviouslyConfigured),
      statusNote: isWineInstalled
        ? 'Installed on your Mac — ready to use.'
        : 'Not installed yet — One Launcher will download it for free if selected.',
      statusNoteClassName: isWineInstalled ? INSTALLED_NOTE_CLASS : NEUTRAL_NOTE_CLASS,
      updateOptInRunner: 'wine',
    },
    ...(showGptkOption
      ? [
          {
            runner: 'gptk' as const,
            slug: 'gptk',
            testId: 'setup-runner-gptk',
            title: 'Apple Game Porting Toolkit',
            badgeText: 'Advanced',
            badgeClassName:
              'px-2 py-0.5 rounded bg-[#131c27] border border-[#2a475e] text-[10px] font-bold text-slate-200',
            description:
              'Apple’s DirectX-to-Metal runtime. Skip this if you use CrossOver, which already includes D3DMetal.',
            component: gptkComp,
            installed: isGptkInstalled,
            removed: !isGptkInstalled && Boolean(gptkComp?.wasPreviouslyConfigured),
            statusNote: isGptkInstalled
              ? 'Installed on your Mac — ready to use.'
              : 'Not installed yet — 1-click automatic download & install on Apple Silicon.',
            statusNoteClassName: isGptkInstalled ? INSTALLED_NOTE_CLASS : NEUTRAL_NOTE_CLASS,
            updateOptInRunner: 'gptk' as const,
          },
        ]
      : []),
    {
      runner: 'skip',
      slug: 'skip',
      testId: 'setup-runner-skip',
      title: 'Mac Games Only',
      badgeText: 'Skip',
      badgeClassName:
        'px-2 py-0.5 rounded bg-[#131c27] border border-[#2a475e] text-[10px] font-semibold text-slate-300',
      description: 'Skip Windows game support for now and only play Mac games.',
      installed: false,
      removed: false,
      statusNote: 'You can add Windows support anytime in Setup Wizard.',
      statusNoteClassName: NEUTRAL_NOTE_CLASS,
    },
  ];

  const runnerOptions = runnerEntries.map((entry) => entry.runner);
  const selectedRunnerIndex = Math.max(0, runnerOptions.indexOf(chosenRunner));

  const isRunnerUpdateOptedIn = (componentId: EnvironmentComponentId): boolean => {
    if (runnerUpdateOptInIds) {
      return runnerUpdateOptInIds.has(componentId);
    }
    const localVal = localUpdateOptIn[componentId];
    if (localVal !== undefined) {
      return localVal;
    }
    const serviceVal = environmentSetupService.getRunnerUpdateOptIn(componentId);
    if (serviceVal !== undefined) {
      return serviceVal;
    }
    return selectedIds ? selectedIds.has(componentId) : false;
  };

  const handleSelectRunnerCard = (
    nextRunner: SetupRunnerChoice,
    comp?: EnvironmentComponentState
  ) => {
    if (comp?.status === 'update_available' && !isRunnerUpdateOptedIn(comp.id)) {
      environmentSetupService.setRunnerUpdateOptIn(comp.id, false);
    }
    onSelectRunner(nextRunner);
  };

  const handleToggleRunnerUpdate = (
    componentId: EnvironmentComponentId,
    runnerType: Exclude<CompatibilityLayerType, 'native'>,
    nextEnabled: boolean
  ) => {
    setLocalUpdateOptIn((prev) => ({
      ...prev,
      [componentId]: nextEnabled,
    }));
    environmentSetupService.setRunnerUpdateOptIn(componentId, nextEnabled);
    if (nextEnabled && chosenRunner === 'skip') {
      onSelectRunner(runnerType);
    }
    if (onToggleRunnerUpdate) {
      onToggleRunnerUpdate(componentId, nextEnabled);
    } else if (onToggleComponent && selectedIds && selectedIds.has(componentId) !== nextEnabled) {
      onToggleComponent(componentId);
    }
  };

  const handleRunnerRadioKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const targetRole = (e.target as HTMLElement | null)?.getAttribute?.('role');
    if (targetRole && targetRole !== 'radio' && targetRole !== 'radiogroup') {
      return;
    }

    let targetIndex: number | null = null;
    if (e.key === 'ArrowDown' || e.key === 'ArrowRight') {
      targetIndex = (selectedRunnerIndex + 1) % runnerOptions.length;
    } else if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') {
      targetIndex = (selectedRunnerIndex - 1 + runnerOptions.length) % runnerOptions.length;
    } else if (e.key === 'Home') {
      targetIndex = 0;
    } else if (e.key === 'End') {
      targetIndex = runnerOptions.length - 1;
    }

    if (targetIndex !== null) {
      e.preventDefault();
      const targetEntry = runnerEntries[targetIndex];
      handleSelectRunnerCard(targetEntry.runner, targetEntry.component);
      runnerRadioRefs.current[targetIndex]?.focus();
    }
  };

  const defaultBottleForRunner = getDefaultBottleNameForRunner(chosenRunner);
  const compatibleBottles = availableBottles.filter((b) =>
    isBottleRecordCompatibleWithRunner(b, chosenRunner)
  );
  const canReuseBottle = compatibleBottles.length > 0;
  const isReuseBottleSelected = canReuseBottle && bottleMode === 'reuse_existing';
  const isCreateBottleSelected = !isReuseBottleSelected;
  const matchedExistingBottle = availableBottles.find((b) => b.name === bottleName.trim());
  const hasIncompatibleSelectedBottle =
    Boolean(matchedExistingBottle) &&
    !isBottleRecordCompatibleWithRunner(matchedExistingBottle!, chosenRunner);

  const activateBottleMode = (
    mode: 'reuse_existing' | 'create_dedicated',
    focusButton = false
  ) => {
    if (mode === 'reuse_existing') {
      if (!canReuseBottle) return;
      onChangeBottleMode('reuse_existing');
      if (!compatibleBottles.some((b) => b.name === bottleName.trim())) {
        onChangeBottleName(compatibleBottles[0].name);
      }
      if (focusButton) {
        reuseBottleRadioRef.current?.focus();
      }
    } else {
      onChangeBottleMode('create_dedicated');
      if (!bottleName.trim()) {
        onChangeBottleName(defaultBottleForRunner);
      }
      if (focusButton) {
        createBottleRadioRef.current?.focus();
      }
    }
  };

  const handleBottleModeKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const enabledModes: ReadonlyArray<'reuse_existing' | 'create_dedicated'> = canReuseBottle
      ? ['reuse_existing', 'create_dedicated']
      : ['create_dedicated'];
    const currentIdx = Math.max(
      0,
      enabledModes.indexOf(isReuseBottleSelected ? 'reuse_existing' : 'create_dedicated')
    );

    let targetIdx: number | null = null;
    if (e.key === 'ArrowDown' || e.key === 'ArrowRight') {
      targetIdx = (currentIdx + 1) % enabledModes.length;
    } else if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') {
      targetIdx = (currentIdx - 1 + enabledModes.length) % enabledModes.length;
    } else if (e.key === 'Home') {
      targetIdx = 0;
    } else if (e.key === 'End') {
      targetIdx = enabledModes.length - 1;
    }

    if (targetIdx !== null) {
      e.preventDefault();
      activateBottleMode(enabledModes[targetIdx], true);
    }
  };

  const installedLayerLabels: string[] = [];
  if (isCrossOverStdInstalled) installedLayerLabels.push('CrossOver');
  if (isCrossOverPreviewInstalled) installedLayerLabels.push('CrossOver Preview');
  if (isCrossOverPreviewArm64Installed) installedLayerLabels.push('CrossOver Preview (arm64 / FEX)');
  if (isWineInstalled) installedLayerLabels.push('Wine');
  if (isGptkInstalled) installedLayerLabels.push('Game Porting Toolkit');

  return (
    <div className="space-y-4" data-testid="setup-step-compatibility">
      <div className="p-3 rounded-lg bg-[#131c27] border border-[#2a475e]/80 text-xs text-slate-200 leading-relaxed">
        Choose how One Launcher runs Windows-only games on your Mac. Your Windows games and saves
        stay neatly organized inside a dedicated folder (called a Bottle).
      </div>

      {renderRunnerSelectionCards({
        installedLayerLabels,
        chosenRunner,
        runnerOptions,
        selectedRunnerIndex,
        runnerRadioRefs,
        entries: runnerEntries,
        onKeyDown: handleRunnerRadioKeyDown,
        onSelectRunnerCard: handleSelectRunnerCard,
        isRunnerUpdateOptedIn,
        onToggleRunnerUpdate: handleToggleRunnerUpdate,
      })}

      {chosenRunner !== 'skip' &&
        renderBottleProvisioningCard({
          chosenRunner,
          defaultBottleForRunner,
          availableBottles,
          compatibleBottles,
          canReuseBottle,
          isReuseBottleSelected,
          isCreateBottleSelected,
          bottleMode,
          bottleName,
          bottleNameValid,
          hasIncompatibleSelectedBottle,
          reuseBottleRadioRef,
          createBottleRadioRef,
          onBottleModeKeyDown: handleBottleModeKeyDown,
          onActivateBottleMode: activateBottleMode,
          onSelectExistingBottle: (name) => {
            onChangeBottleMode('reuse_existing');
            onChangeBottleName(name);
          },
          onChangeBottleName,
        })}
    </div>
  );
};
