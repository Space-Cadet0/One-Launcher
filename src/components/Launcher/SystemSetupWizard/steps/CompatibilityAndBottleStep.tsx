import React, { useRef, useState } from 'react';
import type {
  EnvironmentComponentId,
  EnvironmentComponentState,
  EnvironmentHealthSnapshot,
} from '../../../../contracts/environmentSetup';
import type { CompatibilityLayerType } from '../../../../contracts/launcher';
import { environmentSetupService } from '../../../../services/launcher/environmentSetupService';
import {
  LAUNCH_BUTTON_FOCUS_CLASSES,
  SwitchControl,
} from '../../LaunchConfig/LaunchConfigControls';
import {
  AlertCircle,
  AlertTriangle,
  ArrowUpCircle,
  CheckCircle2,
  Circle,
  HardDrive,
  Monitor,
} from 'lucide-react';

export interface CompatibilityAndBottleStepProps {
  snapshot: EnvironmentHealthSnapshot;
  chosenRunner: Exclude<CompatibilityLayerType, 'native'> | 'skip';
  onSelectRunner: (runner: Exclude<CompatibilityLayerType, 'native'> | 'skip') => void;
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
  const isCrossOverStdRemoved =
    !isCrossOverStdInstalled && Boolean(crossoverComp?.wasPreviouslyConfigured);
  const isCrossOverPreviewRemoved =
    !isCrossOverPreviewInstalled && Boolean(crossoverPreviewComp?.wasPreviouslyConfigured);
  const isCrossOverPreviewArm64Removed =
    !isCrossOverPreviewArm64Installed && Boolean(crossoverPreviewArm64Comp?.wasPreviouslyConfigured);

  const isWineInstalled = isLayerInstalled(wineComp?.status);
  const isWineRemoved = !isWineInstalled && Boolean(wineComp?.wasPreviouslyConfigured);

  const isGptkInstalled = isLayerInstalled(gptkComp?.status);
  const isGptkRemoved = !isGptkInstalled && Boolean(gptkComp?.wasPreviouslyConfigured);

  const showCrossOverPreviewOption = true;
  const showCrossOverPreviewArm64Option = Boolean(
    snapshot.isAppleSiliconMac || snapshot.hostArch === 'arm64'
  );

  const showGptkOption = snapshot.isAppleSiliconMac || isGptkInstalled;

  const runnerOptions: ReadonlyArray<Exclude<CompatibilityLayerType, 'native'> | 'skip'> = [
    'crossover',
    ...(showCrossOverPreviewOption ? (['crossover_preview'] as const) : []),
    ...(showCrossOverPreviewArm64Option ? (['crossover_preview_arm64'] as const) : []),
    'wine',
    ...(showGptkOption ? (['gptk'] as const) : []),
    'skip',
  ];

  const selectedRunnerIndex = Math.max(0, runnerOptions.indexOf(chosenRunner));

  const crossoverIndex = runnerOptions.indexOf('crossover');
  const crossoverPreviewIndex = runnerOptions.indexOf('crossover_preview');
  const crossoverPreviewArm64Index = runnerOptions.indexOf('crossover_preview_arm64');
  const wineIndex = runnerOptions.indexOf('wine');
  const gptkIndex = runnerOptions.indexOf('gptk');
  const skipIndex = runnerOptions.indexOf('skip');

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
    nextRunner: Exclude<CompatibilityLayerType, 'native'> | 'skip',
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
      const targetRunner = runnerOptions[targetIndex];
      const targetComp =
        targetRunner === 'crossover'
          ? crossoverComp
          : targetRunner === 'crossover_preview'
            ? crossoverPreviewComp
            : targetRunner === 'crossover_preview_arm64'
              ? crossoverPreviewArm64Comp
              : targetRunner === 'wine'
                ? wineComp
                : targetRunner === 'gptk'
                  ? gptkComp
                  : undefined;
      handleSelectRunnerCard(targetRunner, targetComp);
      runnerRadioRefs.current[targetIndex]?.focus();
    }
  };

  const defaultBottleForRunner =
    chosenRunner === 'crossover_preview_arm64' ? 'OneLauncher-arm64' : 'OneLauncher';

  const isBottleArchCompatible = (b: (typeof availableBottles)[number]): boolean => {
    const arch = b.wineArch || b.bottleArch;
    if (chosenRunner === 'crossover_preview_arm64') {
      return arch ? arch === 'arm64' : /-arm64$/i.test(b.name);
    }
    if (chosenRunner === 'crossover' || chosenRunner === 'crossover_preview') {
      return arch ? arch === 'win64' : !/-arm64$/i.test(b.name);
    }
    return true;
  };

  const compatibleBottles = availableBottles.filter(isBottleArchCompatible);
  const canReuseBottle = compatibleBottles.length > 0;
  const isReuseBottleSelected = canReuseBottle && bottleMode === 'reuse_existing';
  const isCreateBottleSelected = !isReuseBottleSelected;
  const matchedExistingBottle = availableBottles.find((b) => b.name === bottleName.trim());
  const hasIncompatibleSelectedBottle =
    Boolean(matchedExistingBottle) && !isBottleArchCompatible(matchedExistingBottle!);

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
  if (isCrossOverStdInstalled) {
    installedLayerLabels.push('CrossOver');
  }
  if (isCrossOverPreviewInstalled) {
    installedLayerLabels.push('CrossOver Preview');
  }
  if (isCrossOverPreviewArm64Installed) {
    installedLayerLabels.push('CrossOver Preview (arm64 / FEX)');
  }
  if (isWineInstalled) {
    installedLayerLabels.push('Wine');
  }
  if (isGptkInstalled) {
    installedLayerLabels.push('Game Porting Toolkit');
  }

  const renderInstallStatusBadge = (
    testId: string,
    installed: boolean,
    removed: boolean,
    installedText = 'Installed'
  ) => {
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
  };

  const renderUpdateAvailableBadge = (slug: string, comp?: EnvironmentComponentState) => {
    if (comp?.status !== 'update_available') return null;
    return (
      <span
        data-testid={`runner-update-badge-${slug}`}
        className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-amber-500/20 border border-amber-400/60 text-[10px] font-bold text-amber-200"
      >
        <ArrowUpCircle className="w-3 h-3 text-amber-300 shrink-0" aria-hidden="true" />
        <span>
          {comp.latestVersion
            ? `Update Available · v${comp.latestVersion}`
            : 'Update Available'}
        </span>
      </span>
    );
  };

  const renderRunnerUpdateOptInFooter = (
    slug: string,
    runnerType: Exclude<CompatibilityLayerType, 'native'>,
    comp?: EnvironmentComponentState
  ) => {
    if (!comp || comp.status !== 'update_available') return null;
    const optedIn = isRunnerUpdateOptedIn(comp.id);
    const labelId = `runner-update-optin-label-${slug}`;
    const descId = `runner-update-optin-desc-${slug}`;

    return (
      <div
        data-testid={`runner-update-optin-row-${slug}`}
        className="flex items-center justify-between gap-2.5 border-t border-[#2a475e]/70 px-3.5 py-2.5 bg-[#131c27]/90 rounded-b-lg"
      >
        <div className="min-w-0">
          <div id={labelId} className="text-[11px] font-semibold text-amber-200">
            {comp.latestVersion
              ? `Update to v${comp.latestVersion} during setup`
              : 'Update runner during setup'}
          </div>
          <p id={descId} className="text-[10px] text-slate-300 leading-snug">
            {comp.version
              ? `Currently v${comp.version} — optional in-place update.`
              : 'Optional in-place update.'}
          </p>
        </div>
        <SwitchControl
          checked={optedIn}
          onChange={() => handleToggleRunnerUpdate(comp.id, runnerType, !optedIn)}
          ariaLabelledBy={labelId}
          ariaDescribedBy={descId}
          dataTestId={`runner-update-toggle-${slug}`}
          tone="amber"
        />
      </div>
    );
  };

  const getRunnerCardShellClass = (isSelected: boolean): string =>
    `rounded-lg border transition-all flex flex-col justify-between ${
      isSelected
        ? 'bg-[#1b2838] border-[#66c0f4] shadow-lg shadow-[#66c0f4]/10'
        : 'bg-[#16202d] border-[#2a475e]/80 hover:border-[#66c0f4]/70 hover:bg-[#1b2838]/80'
    }`;

  return (
    <div className="space-y-4" data-testid="setup-step-compatibility">
      <div className="p-3 rounded-lg bg-[#131c27] border border-[#2a475e]/80 text-xs text-slate-200 leading-relaxed">
        Choose how One Launcher runs Windows-only games on your Mac. Your Windows games and saves
        stay neatly organized inside a dedicated folder (called a Bottle).
      </div>

      {/* Runner Selection Cards */}
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
          onKeyDown={handleRunnerRadioKeyDown}
        >
          {/* 1. CrossOver Stable */}
          <div className={getRunnerCardShellClass(chosenRunner === 'crossover')}>
            <button
              ref={(el) => {
                if (crossoverIndex >= 0) runnerRadioRefs.current[crossoverIndex] = el;
              }}
              type="button"
              role="radio"
              aria-checked={chosenRunner === 'crossover'}
              tabIndex={selectedRunnerIndex === crossoverIndex ? 0 : -1}
              data-testid="setup-runner-crossover"
              onClick={() => handleSelectRunnerCard('crossover', crossoverComp)}
              className={`min-h-6 w-full flex-1 text-left p-3.5 cursor-pointer flex flex-col justify-between gap-2 rounded-lg ${LAUNCH_BUTTON_FOCUS_CLASSES}`}
            >
              <div className="space-y-1.5">
                <div className="flex flex-wrap items-center justify-between gap-1.5">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="text-xs font-bold text-white">CrossOver</span>
                    <span className="px-2 py-0.5 rounded bg-sky-500/20 border border-sky-400/50 text-[10px] font-bold text-sky-200">
                      Recommended
                    </span>
                  </div>
                  <div className="flex flex-wrap items-center gap-1.5">
                    {renderInstallStatusBadge(
                      'runner-install-status-crossover',
                      isCrossOverStdInstalled,
                      isCrossOverStdRemoved
                    )}
                    {renderUpdateAvailableBadge('crossover', crossoverComp)}
                  </div>
                </div>
                <p className="text-[11px] text-slate-200 leading-relaxed">
                  Best compatibility and performance for modern Windows games on Mac.
                </p>
              </div>
              {isCrossOverStdInstalled ? (
                <div className="rounded bg-emerald-950/35 border border-emerald-500/40 px-2.5 py-1.5 text-[10px] text-emerald-200 leading-snug">
                  Installed on your Mac — ready to use.
                </div>
              ) : (
                <div className="rounded bg-amber-950/40 border border-amber-500/35 px-2.5 py-1.5 text-[10px] text-amber-200 leading-snug">
                  Not installed yet — One Launcher will download it if selected. Paid app (14-day
                  free trial).
                </div>
              )}
            </button>
            {renderRunnerUpdateOptInFooter('crossover', 'crossover', crossoverComp)}
          </div>

          {/* 2. CrossOver Preview */}
          {showCrossOverPreviewOption && (
            <div className={getRunnerCardShellClass(chosenRunner === 'crossover_preview')}>
              <button
                ref={(el) => {
                  if (crossoverPreviewIndex >= 0) {
                    runnerRadioRefs.current[crossoverPreviewIndex] = el;
                  }
                }}
                type="button"
                role="radio"
                aria-checked={chosenRunner === 'crossover_preview'}
                tabIndex={selectedRunnerIndex === crossoverPreviewIndex ? 0 : -1}
                data-testid="setup-runner-crossover-preview"
                onClick={() => handleSelectRunnerCard('crossover_preview', crossoverPreviewComp)}
                className={`min-h-6 w-full flex-1 text-left p-3.5 cursor-pointer flex flex-col justify-between gap-2 rounded-lg ${LAUNCH_BUTTON_FOCUS_CLASSES}`}
              >
                <div className="space-y-1.5">
                  <div className="flex flex-wrap items-center justify-between gap-1.5">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span className="text-xs font-bold text-white">CrossOver Preview</span>
                      <span className="px-2 py-0.5 rounded bg-purple-500/20 border border-purple-400/50 text-[10px] font-bold text-purple-200">
                        Preview
                      </span>
                    </div>
                    <div className="flex flex-wrap items-center gap-1.5">
                      {renderInstallStatusBadge(
                        'runner-install-status-crossover-preview',
                        isCrossOverPreviewInstalled,
                        isCrossOverPreviewRemoved
                      )}
                      {renderUpdateAvailableBadge('crossover-preview', crossoverPreviewComp)}
                    </div>
                  </div>
                  <p className="text-[11px] text-slate-200 leading-relaxed">
                    Early-access CodeWeavers build with bleeding-edge D3DMetal and Wine fixes.
                  </p>
                </div>
                {isCrossOverPreviewInstalled ? (
                  <div className="rounded bg-emerald-950/35 border border-emerald-500/40 px-2.5 py-1.5 text-[10px] text-emerald-200 leading-snug">
                    Installed on your Mac — ready to use alongside or instead of Stable.
                  </div>
                ) : (
                  <div className="rounded bg-[#131c27] border border-[#2a475e]/70 px-2.5 py-1.5 text-[10px] text-slate-300 leading-snug">
                    Not installed yet — sign in to CodeWeavers during setup to auto-download &amp;
                    install.
                  </div>
                )}
              </button>
              {renderRunnerUpdateOptInFooter(
                'crossover-preview',
                'crossover_preview',
                crossoverPreviewComp
              )}
            </div>
          )}

          {/* 2b. CrossOver Preview (arm64 / FEX) — Apple Silicon only */}
          {showCrossOverPreviewArm64Option && (
            <div className={getRunnerCardShellClass(chosenRunner === 'crossover_preview_arm64')}>
              <button
                ref={(el) => {
                  if (crossoverPreviewArm64Index >= 0) {
                    runnerRadioRefs.current[crossoverPreviewArm64Index] = el;
                  }
                }}
                type="button"
                role="radio"
                aria-checked={chosenRunner === 'crossover_preview_arm64'}
                tabIndex={selectedRunnerIndex === crossoverPreviewArm64Index ? 0 : -1}
                data-testid="setup-runner-crossover-preview-arm64"
                onClick={() =>
                  handleSelectRunnerCard('crossover_preview_arm64', crossoverPreviewArm64Comp)
                }
                className={`min-h-6 w-full flex-1 text-left p-3.5 cursor-pointer flex flex-col justify-between gap-2 rounded-lg ${LAUNCH_BUTTON_FOCUS_CLASSES}`}
              >
                <div className="space-y-1.5">
                  <div className="flex flex-wrap items-center justify-between gap-1.5">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span className="text-xs font-bold text-white">
                        CrossOver Preview (arm64 / FEX)
                      </span>
                      <span className="px-2 py-0.5 rounded bg-indigo-500/20 border border-indigo-400/50 text-[10px] font-bold text-indigo-200">
                        arm64 / FEX
                      </span>
                    </div>
                    <div className="flex flex-wrap items-center gap-1.5">
                      {renderInstallStatusBadge(
                        'runner-install-status-crossover-preview-arm64',
                        isCrossOverPreviewArm64Installed,
                        isCrossOverPreviewArm64Removed
                      )}
                      {renderUpdateAvailableBadge(
                        'crossover-preview-arm64',
                        crossoverPreviewArm64Comp
                      )}
                    </div>
                  </div>
                  <p className="text-[11px] text-slate-200 leading-relaxed">
                    Experimental arm64 Wine + FEX branch on Apple Silicon using an isolated{' '}
                    <span className="font-mono text-indigo-200">OneLauncher-arm64</span> bottle.
                  </p>
                </div>
                {isCrossOverPreviewArm64Installed ? (
                  <div className="rounded bg-emerald-950/35 border border-emerald-500/40 px-2.5 py-1.5 text-[10px] text-emerald-200 leading-snug">
                    Installed on your Mac — ready to use with dedicated arm64 bottles.
                  </div>
                ) : crossoverPreviewArm64Comp?.authRequired ? (
                  <div className="rounded bg-amber-950/40 border border-amber-500/35 px-2.5 py-1.5 text-[10px] text-amber-200 leading-snug">
                    CodeWeavers sign-in required — sign in during setup to download &amp; install
                    into &ldquo;OneLauncher-arm64&rdquo;.
                  </div>
                ) : (
                  <div className="rounded bg-[#131c27] border border-[#2a475e]/70 px-2.5 py-1.5 text-[10px] text-slate-300 leading-snug">
                    Not installed yet — sign in to CodeWeavers during setup to auto-download &amp;
                    install as CrossOver Preview arm64.
                  </div>
                )}
              </button>
              {renderRunnerUpdateOptInFooter(
                'crossover-preview-arm64',
                'crossover_preview_arm64',
                crossoverPreviewArm64Comp
              )}
            </div>
          )}

          {/* 3. Wine */}
          <div className={getRunnerCardShellClass(chosenRunner === 'wine')}>
            <button
              ref={(el) => {
                if (wineIndex >= 0) runnerRadioRefs.current[wineIndex] = el;
              }}
              type="button"
              role="radio"
              aria-checked={chosenRunner === 'wine'}
              tabIndex={selectedRunnerIndex === wineIndex ? 0 : -1}
              data-testid="setup-runner-wine"
              onClick={() => handleSelectRunnerCard('wine', wineComp)}
              className={`min-h-6 w-full flex-1 text-left p-3.5 cursor-pointer flex flex-col justify-between gap-2 rounded-lg ${LAUNCH_BUTTON_FOCUS_CLASSES}`}
            >
              <div className="space-y-1.5">
                <div className="flex flex-wrap items-center justify-between gap-1.5">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="text-xs font-bold text-white">Wine</span>
                    <span className="px-2 py-0.5 rounded bg-sky-500/15 border border-sky-400/40 text-[10px] font-bold text-sky-200">
                      Free
                    </span>
                  </div>
                  <div className="flex flex-wrap items-center gap-1.5">
                    {renderInstallStatusBadge(
                      'runner-install-status-wine',
                      isWineInstalled,
                      isWineRemoved
                    )}
                    {renderUpdateAvailableBadge('wine', wineComp)}
                  </div>
                </div>
                <p className="text-[11px] text-slate-200 leading-relaxed">
                  Free, open-source option. Works well for older and lighter Windows games.
                </p>
              </div>
              {isWineInstalled ? (
                <div className="rounded bg-emerald-950/35 border border-emerald-500/40 px-2.5 py-1.5 text-[10px] text-emerald-200 leading-snug">
                  Installed on your Mac — ready to use.
                </div>
              ) : (
                <div className="rounded bg-[#131c27] border border-[#2a475e]/70 px-2.5 py-1.5 text-[10px] text-slate-300 leading-snug">
                  Not installed yet — One Launcher will download it for free if selected.
                </div>
              )}
            </button>
            {renderRunnerUpdateOptInFooter('wine', 'wine', wineComp)}
          </div>

          {/* 4. Apple Game Porting Toolkit (Apple Silicon Macs only unless already installed) */}
          {showGptkOption && (
            <div className={getRunnerCardShellClass(chosenRunner === 'gptk')}>
              <button
                ref={(el) => {
                  if (gptkIndex >= 0) runnerRadioRefs.current[gptkIndex] = el;
                }}
                type="button"
                role="radio"
                aria-checked={chosenRunner === 'gptk'}
                tabIndex={selectedRunnerIndex === gptkIndex ? 0 : -1}
                data-testid="setup-runner-gptk"
                onClick={() => handleSelectRunnerCard('gptk', gptkComp)}
                className={`min-h-6 w-full flex-1 text-left p-3.5 cursor-pointer flex flex-col justify-between gap-2 rounded-lg ${LAUNCH_BUTTON_FOCUS_CLASSES}`}
              >
                <div className="space-y-1.5">
                  <div className="flex flex-wrap items-center justify-between gap-1.5">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span className="text-xs font-bold text-white">
                        Apple Game Porting Toolkit
                      </span>
                      <span className="px-2 py-0.5 rounded bg-[#131c27] border border-[#2a475e] text-[10px] font-bold text-slate-200">
                        Advanced
                      </span>
                    </div>
                    <div className="flex flex-wrap items-center gap-1.5">
                      {renderInstallStatusBadge(
                        'runner-install-status-gptk',
                        isGptkInstalled,
                        isGptkRemoved
                      )}
                      {renderUpdateAvailableBadge('gptk', gptkComp)}
                    </div>
                  </div>
                  <p className="text-[11px] text-slate-200 leading-relaxed">
                    Apple&rsquo;s DirectX-to-Metal runtime. Skip this if you use CrossOver, which
                    already includes D3DMetal.
                  </p>
                </div>
                {isGptkInstalled ? (
                  <div className="rounded bg-emerald-950/35 border border-emerald-500/40 px-2.5 py-1.5 text-[10px] text-emerald-200 leading-snug">
                    Installed on your Mac — ready to use.
                  </div>
                ) : (
                  <div className="rounded bg-[#131c27] border border-[#2a475e]/70 px-2.5 py-1.5 text-[10px] text-slate-300 leading-snug">
                    Not installed yet — 1-click automatic download &amp; install on Apple Silicon.
                  </div>
                )}
              </button>
              {renderRunnerUpdateOptInFooter('gptk', 'gptk', gptkComp)}
            </div>
          )}

          {/* 5. Mac Games Only */}
          <div className={getRunnerCardShellClass(chosenRunner === 'skip')}>
            <button
              ref={(el) => {
                if (skipIndex >= 0) runnerRadioRefs.current[skipIndex] = el;
              }}
              type="button"
              role="radio"
              aria-checked={chosenRunner === 'skip'}
              tabIndex={selectedRunnerIndex === skipIndex ? 0 : -1}
              data-testid="setup-runner-skip"
              onClick={() => handleSelectRunnerCard('skip')}
              className={`min-h-6 w-full flex-1 text-left p-3.5 cursor-pointer flex flex-col justify-between gap-2 rounded-lg ${LAUNCH_BUTTON_FOCUS_CLASSES}`}
            >
              <div className="space-y-1.5">
                <div className="flex flex-wrap items-center justify-between gap-1.5">
                  <span className="text-xs font-bold text-white">Mac Games Only</span>
                  <span className="px-2 py-0.5 rounded bg-[#131c27] border border-[#2a475e] text-[10px] font-semibold text-slate-300">
                    Skip
                  </span>
                </div>
                <p className="text-[11px] text-slate-200 leading-relaxed">
                  Skip Windows game support for now and only play Mac games.
                </p>
              </div>
              <div className="rounded bg-[#131c27] border border-[#2a475e]/70 px-2.5 py-1.5 text-[10px] text-slate-300 leading-snug">
                You can add Windows support anytime in Setup Wizard.
              </div>
            </button>
          </div>
        </div>
      </div>

      {/* Bottle Configuration Section */}
      {chosenRunner !== 'skip' && (
        <div
          data-testid="setup-bottle-config-section"
          className="rounded-lg bg-[#16202d] border border-[#2a475e]/80 p-3.5 space-y-3"
        >
          <div className="flex items-center gap-2">
            <HardDrive className="w-4 h-4 text-[#66c0f4]" aria-hidden="true" />
            <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-300">
              Windows Game Folder (Bottle)
            </h3>
          </div>

          {/* Mode Toggle: Use Existing vs Create New */}
          <div
            className="grid grid-cols-1 sm:grid-cols-2 gap-2.5"
            role="radiogroup"
            aria-label="Bottle setup mode"
            onKeyDown={handleBottleModeKeyDown}
          >
            <button
              ref={reuseBottleRadioRef}
              type="button"
              role="radio"
              aria-checked={isReuseBottleSelected}
              tabIndex={isReuseBottleSelected ? 0 : -1}
              data-testid="setup-bottle-mode-reuse"
              disabled={!canReuseBottle}
              onClick={() => activateBottleMode('reuse_existing')}
              className={`min-h-6 text-left rounded-lg p-3 border transition-all ${LAUNCH_BUTTON_FOCUS_CLASSES} ${
                !canReuseBottle
                  ? 'bg-[#131c27]/60 border-[#2a475e]/50 opacity-50 cursor-not-allowed'
                  : isReuseBottleSelected
                    ? 'bg-[#1b2838] border-[#66c0f4] shadow-lg shadow-[#66c0f4]/10 cursor-pointer'
                    : 'bg-[#131c27] border-[#2a475e]/80 hover:border-[#66c0f4]/70 cursor-pointer'
              }`}
            >
              <div className="flex items-center justify-between gap-2">
                <span className="text-xs font-bold text-white">Use Existing Bottle</span>
                {compatibleBottles.length > 0 && (
                  <span className="text-[10px] px-1.5 py-0.5 rounded bg-emerald-500/20 border border-emerald-500/40 text-emerald-300 font-bold">
                    {compatibleBottles.length} Compatible
                  </span>
                )}
              </div>
              <p className="text-[11px] text-slate-300 mt-1 leading-snug">
                {compatibleBottles.length > 0
                  ? 'Keeps your existing Windows apps and logins.'
                  : availableBottles.length > 0
                    ? `No ${chosenRunner === 'crossover_preview_arm64' ? 'arm64' : 'Intel / win64'} bottles found — create a dedicated "${defaultBottleForRunner}" bottle.`
                    : 'No existing bottles found on this Mac.'}
              </p>
            </button>

            <button
              ref={createBottleRadioRef}
              type="button"
              role="radio"
              aria-checked={isCreateBottleSelected}
              tabIndex={isCreateBottleSelected ? 0 : -1}
              data-testid="setup-bottle-mode-create"
              onClick={() => activateBottleMode('create_dedicated')}
              className={`min-h-6 text-left rounded-lg p-3 border transition-all cursor-pointer ${LAUNCH_BUTTON_FOCUS_CLASSES} ${
                isCreateBottleSelected
                  ? 'bg-[#1b2838] border-[#66c0f4] shadow-lg shadow-[#66c0f4]/10'
                  : 'bg-[#131c27] border-[#2a475e]/80 hover:border-[#66c0f4]/70'
              }`}
            >
              <span className="text-xs font-bold text-white">
                Create New &ldquo;{defaultBottleForRunner}&rdquo; Bottle
              </span>
              <p className="text-[11px] text-slate-300 mt-1 leading-snug">
                Creates a clean {chosenRunner === 'crossover_preview_arm64' ? 'arm64 / FEX ' : ''}folder for your Windows games and saves.
              </p>
            </button>
          </div>

          {/* Detected Existing Bottles List */}
          {availableBottles.length > 0 && (
            <div className="space-y-1.5">
              <div className="text-[11px] font-semibold text-slate-300">Existing Bottles</div>
              <div className="flex flex-wrap gap-2">
                {availableBottles.map((b) => {
                  const isCompatible = isBottleArchCompatible(b);
                  const bottleArch = b.wineArch || b.bottleArch;
                  const isActiveBottle =
                    bottleMode === 'reuse_existing' && bottleName.trim() === b.name;
                  return (
                    <button
                      key={`${b.runnerType}-${b.name}`}
                      type="button"
                      data-testid={`setup-existing-bottle-${b.name}`}
                      disabled={!isCompatible}
                      title={
                        !isCompatible
                          ? chosenRunner === 'crossover_preview_arm64'
                            ? 'Incompatible Intel (win64) bottle — use a dedicated arm64 bottle to prevent corruption.'
                            : 'Incompatible arm64 bottle — requires CrossOver Preview (arm64 / FEX).'
                          : undefined
                      }
                      onClick={() => {
                        if (!isCompatible) return;
                        onChangeBottleMode('reuse_existing');
                        onChangeBottleName(b.name);
                      }}
                      className={`min-h-6 inline-flex flex-wrap items-center gap-1.5 px-2.5 py-1.5 rounded-md border text-xs transition-all ${LAUNCH_BUTTON_FOCUS_CLASSES} ${
                        !isCompatible
                          ? 'bg-[#131c27]/50 border-[#2a475e]/40 text-slate-400 opacity-55 cursor-not-allowed'
                          : isActiveBottle
                            ? 'bg-[#1b2838] border-[#66c0f4] text-white cursor-pointer'
                            : 'bg-[#131c27] border-[#2a475e] text-slate-200 hover:border-[#66c0f4]/70 cursor-pointer'
                      }`}
                    >
                      <CheckCircle2
                        className={`w-3.5 h-3.5 ${
                          isActiveBottle ? 'text-[#66c0f4]' : 'text-slate-300'
                        }`}
                        aria-hidden="true"
                      />
                      <span className="font-semibold">{b.name}</span>
                      {(bottleArch === 'arm64' || /-arm64$/i.test(b.name)) && (
                        <span className="text-[10px] px-1.5 py-0.5 rounded bg-indigo-500/20 border border-indigo-400/50 text-indigo-200 font-semibold">
                          arm64 / FEX
                        </span>
                      )}
                      {bottleArch === 'win64' && (
                        <span className="text-[10px] px-1.5 py-0.5 rounded bg-slate-500/20 border border-slate-400/40 text-slate-200 font-semibold">
                          Intel / win64
                        </span>
                      )}
                      {b.hasSteam && (
                        <span className="text-[10px] px-1.5 py-0.5 rounded bg-sky-500/20 border border-sky-500/40 text-sky-200 font-semibold">
                          Steam
                        </span>
                      )}
                      {b.hasGogGalaxy && (
                        <span className="text-[10px] px-1.5 py-0.5 rounded bg-purple-500/20 border border-purple-500/40 text-purple-200 font-semibold">
                          GOG
                        </span>
                      )}
                      {b.hasEpicLauncher && (
                        <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-500/20 border border-amber-500/40 text-amber-200 font-semibold">
                          Epic
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>
              {hasIncompatibleSelectedBottle && (
                <div
                  id="setup-bottle-arch-warning"
                  data-testid="setup-bottle-arch-warning"
                  role="alert"
                  className="flex items-center gap-1.5 text-[11px] text-amber-200 mt-1"
                >
                  <AlertTriangle className="w-3.5 h-3.5 text-amber-400 shrink-0" aria-hidden="true" />
                  <span>
                    Bottle &ldquo;{bottleName.trim()}&rdquo; uses an incompatible architecture for{' '}
                    {chosenRunner === 'crossover_preview_arm64'
                      ? 'CrossOver Preview (arm64 / FEX) — use a dedicated arm64 bottle like "OneLauncher-arm64".'
                      : 'this Intel/Rosetta runner — choose a win64 bottle like "OneLauncher".'}
                  </span>
                </div>
              )}
            </div>
          )}

          {/* Editable Bottle Name Input */}
          <div className="space-y-1">
            <label
              htmlFor="setup-bottle-name-field"
              className="block text-[11px] font-semibold text-slate-200"
            >
              Bottle Name
            </label>
            {!bottleNameValid ? (
              <div
                id="setup-bottle-name-desc"
                role="alert"
                className="flex items-center gap-1.5 text-[11px] text-rose-300"
              >
                <AlertCircle className="w-3.5 h-3.5 text-rose-400 shrink-0" aria-hidden="true" />
                <span>
                  Use 1–64 letters, numbers, spaces, dots, underscores, or hyphens (cannot be
                  &ldquo;.&rdquo;, contain &ldquo;..&rdquo;, or start with &ldquo;-&rdquo;).
                </span>
              </div>
            ) : (
              <p id="setup-bottle-name-desc" className="text-[11px] text-slate-300">
                Where your Windows launchers and game saves are stored.
              </p>
            )}
            <input
              id="setup-bottle-name-field"
              type="text"
              data-testid="setup-bottle-name-input"
              aria-describedby={
                hasIncompatibleSelectedBottle
                  ? 'setup-bottle-name-desc setup-bottle-arch-warning'
                  : 'setup-bottle-name-desc'
              }
              aria-invalid={!bottleNameValid || hasIncompatibleSelectedBottle ? true : undefined}
              value={bottleName}
              onChange={(e) => onChangeBottleName(e.target.value)}
              placeholder={defaultBottleForRunner}
              maxLength={64}
              autoComplete="off"
              autoCorrect="off"
              autoCapitalize="off"
              spellCheck={false}
              className={`w-full rounded-md bg-[#131c27] border px-3 py-1.5 text-xs text-white placeholder-slate-400 focus:outline-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#66c0f4] ${
                bottleNameValid ? 'border-[#2a475e]' : 'border-rose-500'
              }`}
            />
          </div>
        </div>
      )}
    </div>
  );
};
