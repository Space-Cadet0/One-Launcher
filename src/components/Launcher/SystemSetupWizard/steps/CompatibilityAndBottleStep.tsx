import React, { useRef } from 'react';
import type { EnvironmentHealthSnapshot } from '../../../../contracts/environmentSetup';
import type { CompatibilityLayerType } from '../../../../contracts/launcher';
import type { ElectronAPI } from '../../../../types/electron';
import { launcherService } from '../../../../services/launcher/launcherService';
import {
  AlertCircle,
  AlertTriangle,
  CheckCircle2,
  Circle,
  ExternalLink,
  FolderOpen,
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
  gptkDmgPath: string;
  onChangeGptkDmgPath: (path: string) => void;
}

type ExtendedFileDialogBridge = ElectronAPI & {
  selectExecutableFile?: (defaultPath?: string) => Promise<string | null>;
};

export function isValidBottleNameInput(raw: string): boolean {
  const trimmed = raw.trim();
  if (!trimmed) return false;
  if (trimmed.includes('..')) return false;
  return /^[A-Za-z0-9 _.-]{1,64}$/.test(trimmed);
}

const GPTK_APPLE_DEV_URL = 'https://developer.apple.com/games/game-porting-toolkit/';

export const CompatibilityAndBottleStep: React.FC<CompatibilityAndBottleStepProps> = ({
  snapshot,
  chosenRunner,
  onSelectRunner,
  bottleMode,
  onChangeBottleMode,
  bottleName,
  onChangeBottleName,
  gptkDmgPath,
  onChangeGptkDmgPath,
}) => {
  const runnerRadioRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const reuseBottleRadioRef = useRef<HTMLButtonElement | null>(null);
  const createBottleRadioRef = useRef<HTMLButtonElement | null>(null);

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
  const wineComp = snapshot.components.runner_wine;
  const gptkComp = snapshot.components.runner_gptk;
  const availableBottles = snapshot.bottleSummary?.availableBottles ?? [];
  const bottleNameValid = isValidBottleNameInput(bottleName);

  const showGptkOption =
    snapshot.isAppleSiliconMac || gptkComp?.status === 'ready';

  const isCrossOverSelected =
    chosenRunner === 'crossover' || chosenRunner === 'crossover_preview';
  const crossoverOptionValue: Exclude<CompatibilityLayerType, 'native'> =
    crossoverPreviewComp?.status === 'ready' && crossoverComp?.status !== 'ready'
      ? 'crossover_preview'
      : 'crossover';

  const runnerOptions: ReadonlyArray<Exclude<CompatibilityLayerType, 'native'> | 'skip'> = [
    crossoverOptionValue,
    'wine',
    ...(showGptkOption ? (['gptk'] as const) : []),
    'skip',
  ];

  const normalizedSelectedValue: Exclude<CompatibilityLayerType, 'native'> | 'skip' =
    isCrossOverSelected ? crossoverOptionValue : chosenRunner;
  const selectedRunnerIndex = Math.max(0, runnerOptions.indexOf(normalizedSelectedValue));

  const crossoverIndex = runnerOptions.indexOf(crossoverOptionValue);
  const wineIndex = runnerOptions.indexOf('wine');
  const gptkIndex = runnerOptions.indexOf('gptk');
  const skipIndex = runnerOptions.indexOf('skip');

  const handleRunnerRadioKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
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
      onSelectRunner(runnerOptions[targetIndex]);
      runnerRadioRefs.current[targetIndex]?.focus();
    }
  };

  const canReuseBottle = availableBottles.length > 0;
  const isReuseBottleSelected = canReuseBottle && bottleMode === 'reuse_existing';
  const isCreateBottleSelected = !isReuseBottleSelected;

  const activateBottleMode = (
    mode: 'reuse_existing' | 'create_dedicated',
    focusButton = false
  ) => {
    if (mode === 'reuse_existing') {
      if (!canReuseBottle) return;
      onChangeBottleMode('reuse_existing');
      if (!availableBottles.some((b) => b.name === bottleName.trim())) {
        onChangeBottleName(availableBottles[0].name);
      }
      if (focusButton) {
        reuseBottleRadioRef.current?.focus();
      }
    } else {
      onChangeBottleMode('create_dedicated');
      if (!bottleName.trim()) {
        onChangeBottleName('OneLauncher');
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

  const handleBrowseGptkDmg = async () => {
    const api = (typeof window !== 'undefined' ? window.electronAPI : undefined) as
      | ExtendedFileDialogBridge
      | undefined;
    if (typeof api?.selectExecutableFile === 'function') {
      const picked = await api.selectExecutableFile(gptkDmgPath || undefined);
      if (picked) onChangeGptkDmgPath(picked);
      return;
    }
    const chosen = await launcherService.selectExecutable(gptkDmgPath || undefined);
    if (chosen) {
      onChangeGptkDmgPath(chosen);
    }
  };

  const handleOpenAppleGptkPage = async () => {
    const api = typeof window !== 'undefined' ? window.electronAPI : undefined;
    if (typeof api?.openExternalUrl === 'function') {
      await api.openExternalUrl(GPTK_APPLE_DEV_URL);
    } else if (typeof api?.openExternal === 'function') {
      await api.openExternal(GPTK_APPLE_DEV_URL);
    } else if (typeof window !== 'undefined') {
      window.open(GPTK_APPLE_DEV_URL, '_blank', 'noopener,noreferrer');
    }
  };

  const isLayerInstalled = (status: string | undefined): boolean =>
    status === 'ready' || status === 'update_available';

  const isCrossOverStdInstalled = isLayerInstalled(crossoverComp?.status);
  const isCrossOverPreviewInstalled = isLayerInstalled(crossoverPreviewComp?.status);
  const isCrossOverInstalled = isCrossOverStdInstalled || isCrossOverPreviewInstalled;
  const isCrossOverRemoved =
    !isCrossOverInstalled &&
    Boolean(
      crossoverComp?.wasPreviouslyConfigured || crossoverPreviewComp?.wasPreviouslyConfigured
    );

  const isWineInstalled = isLayerInstalled(wineComp?.status);
  const isWineRemoved = !isWineInstalled && Boolean(wineComp?.wasPreviouslyConfigured);

  const isGptkInstalled = isLayerInstalled(gptkComp?.status);
  const isGptkRemoved = !isGptkInstalled && Boolean(gptkComp?.wasPreviouslyConfigured);

  const installedLayerLabels: string[] = [];
  if (isCrossOverStdInstalled) {
    installedLayerLabels.push('CrossOver');
  } else if (isCrossOverPreviewInstalled) {
    installedLayerLabels.push('CrossOver Preview');
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
        className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-[#101721] border border-slate-500/60 text-[10px] font-semibold text-slate-200"
      >
        <Circle className="w-2.5 h-2.5 text-slate-400 shrink-0" aria-hidden="true" />
        <span>Not Installed</span>
      </span>
    );
  };

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
                <Circle className="w-2.5 h-2.5 text-slate-400 shrink-0" aria-hidden="true" />
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
          {/* 1. CrossOver */}
          <button
            ref={(el) => {
              if (crossoverIndex >= 0) runnerRadioRefs.current[crossoverIndex] = el;
            }}
            type="button"
            role="radio"
            aria-checked={isCrossOverSelected}
            tabIndex={selectedRunnerIndex === crossoverIndex ? 0 : -1}
            data-testid="setup-runner-crossover"
            onClick={() => onSelectRunner(crossoverOptionValue)}
            className={`min-h-6 text-left rounded-lg p-3.5 border transition-all cursor-pointer flex flex-col justify-between gap-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#66c0f4] ${
              isCrossOverSelected
                ? 'bg-[#1b2838] border-[#66c0f4] shadow-lg shadow-[#66c0f4]/10'
                : 'bg-[#16202d] border-[#2a475e]/80 hover:border-[#66c0f4]/70 hover:bg-[#1b2838]/80'
            }`}
          >
            <div className="space-y-1.5">
              <div className="flex flex-wrap items-center justify-between gap-1.5">
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="text-xs font-bold text-white">CrossOver</span>
                  <span className="px-2 py-0.5 rounded bg-sky-500/20 border border-sky-400/50 text-[10px] font-bold text-sky-200">
                    Recommended
                  </span>
                </div>
                {renderInstallStatusBadge(
                  'runner-install-status-crossover',
                  isCrossOverInstalled,
                  isCrossOverRemoved,
                  isCrossOverPreviewInstalled && !isCrossOverStdInstalled
                    ? 'Installed (Preview)'
                    : 'Installed'
                )}
              </div>
              <p className="text-[11px] text-slate-200 leading-relaxed">
                Best compatibility and performance for modern Windows games on Mac.
              </p>
            </div>
            {isCrossOverInstalled ? (
              <div className="rounded bg-emerald-950/35 border border-emerald-500/40 px-2.5 py-1.5 text-[10px] text-emerald-200 leading-snug">
                Installed on your Mac — ready to use.
              </div>
            ) : (
              <div className="rounded bg-amber-950/40 border border-amber-500/35 px-2.5 py-1.5 text-[10px] text-amber-200 leading-snug">
                Not installed yet — One Launcher will download it if selected. Paid app (14-day free
                trial).
              </div>
            )}
          </button>

          {/* 2. Wine */}
          <button
            ref={(el) => {
              if (wineIndex >= 0) runnerRadioRefs.current[wineIndex] = el;
            }}
            type="button"
            role="radio"
            aria-checked={chosenRunner === 'wine'}
            tabIndex={selectedRunnerIndex === wineIndex ? 0 : -1}
            data-testid="setup-runner-wine"
            onClick={() => onSelectRunner('wine')}
            className={`min-h-6 text-left rounded-lg p-3.5 border transition-all cursor-pointer flex flex-col justify-between gap-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#66c0f4] ${
              chosenRunner === 'wine'
                ? 'bg-[#1b2838] border-[#66c0f4] shadow-lg shadow-[#66c0f4]/10'
                : 'bg-[#16202d] border-[#2a475e]/80 hover:border-[#66c0f4]/70 hover:bg-[#1b2838]/80'
            }`}
          >
            <div className="space-y-1.5">
              <div className="flex flex-wrap items-center justify-between gap-1.5">
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="text-xs font-bold text-white">Wine</span>
                  <span className="px-2 py-0.5 rounded bg-sky-500/15 border border-sky-400/40 text-[10px] font-bold text-sky-200">
                    Free
                  </span>
                </div>
                {renderInstallStatusBadge(
                  'runner-install-status-wine',
                  isWineInstalled,
                  isWineRemoved
                )}
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

          {/* 3. Apple Game Porting Toolkit (Apple Silicon Macs only unless already installed) */}
          {showGptkOption && (
            <button
              ref={(el) => {
                if (gptkIndex >= 0) runnerRadioRefs.current[gptkIndex] = el;
              }}
              type="button"
              role="radio"
              aria-checked={chosenRunner === 'gptk'}
              tabIndex={selectedRunnerIndex === gptkIndex ? 0 : -1}
              data-testid="setup-runner-gptk"
              onClick={() => onSelectRunner('gptk')}
              className={`min-h-6 text-left rounded-lg p-3.5 border transition-all cursor-pointer flex flex-col justify-between gap-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#66c0f4] ${
                chosenRunner === 'gptk'
                  ? 'bg-[#1b2838] border-[#66c0f4] shadow-lg shadow-[#66c0f4]/10'
                  : 'bg-[#16202d] border-[#2a475e]/80 hover:border-[#66c0f4]/70 hover:bg-[#1b2838]/80'
              }`}
            >
              <div className="space-y-1.5">
                <div className="flex flex-wrap items-center justify-between gap-1.5">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="text-xs font-bold text-white">Apple Game Porting Toolkit</span>
                    <span className="px-2 py-0.5 rounded bg-[#131c27] border border-[#2a475e] text-[10px] font-bold text-slate-200">
                      Advanced
                    </span>
                  </div>
                  {renderInstallStatusBadge(
                    'runner-install-status-gptk',
                    isGptkInstalled,
                    isGptkRemoved
                  )}
                </div>
                <p className="text-[11px] text-slate-200 leading-relaxed">
                  Apple&rsquo;s developer tool. Skip this if you use CrossOver, which already
                  includes it.
                </p>
              </div>
              {isGptkInstalled ? (
                <div className="rounded bg-emerald-950/35 border border-emerald-500/40 px-2.5 py-1.5 text-[10px] text-emerald-200 leading-snug">
                  Installed on your Mac — ready to use.
                </div>
              ) : (
                <div className="rounded bg-[#131c27] border border-[#2a475e]/70 px-2.5 py-1.5 text-[10px] text-slate-300 leading-snug">
                  Not installed yet — requires downloading a .dmg file from Apple Developer.
                </div>
              )}
            </button>
          )}

          {/* 4. Mac Games Only */}
          <button
            ref={(el) => {
              if (skipIndex >= 0) runnerRadioRefs.current[skipIndex] = el;
            }}
            type="button"
            role="radio"
            aria-checked={chosenRunner === 'skip'}
            tabIndex={selectedRunnerIndex === skipIndex ? 0 : -1}
            data-testid="setup-runner-skip"
            onClick={() => onSelectRunner('skip')}
            className={`min-h-6 text-left rounded-lg p-3.5 border transition-all cursor-pointer flex flex-col justify-between gap-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#66c0f4] ${
              chosenRunner === 'skip'
                ? 'bg-[#1b2838] border-[#66c0f4] shadow-lg shadow-[#66c0f4]/10'
                : 'bg-[#16202d] border-[#2a475e]/80 hover:border-[#66c0f4]/70 hover:bg-[#1b2838]/80'
            }`}
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

      {/* Standalone GPTK .dmg Picker when GPTK is selected */}
      {chosenRunner === 'gptk' && showGptkOption && (
        <div
          data-testid="setup-gptk-dmg-panel"
          className="rounded-lg bg-[#16202d] border border-[#66c0f4]/55 p-3.5 space-y-2.5"
        >
          <div className="flex flex-wrap items-center justify-between gap-2">
            <label htmlFor="setup-gptk-dmg-field" className="text-xs font-bold text-white">
              Game Porting Toolkit (.dmg)
            </label>
            <button
              type="button"
              onClick={() => void handleOpenAppleGptkPage()}
              className="min-h-6 inline-flex items-center gap-1 px-2.5 py-1 rounded-md bg-[#131c27] hover:bg-[#2a475e] border border-[#2a475e] text-[11px] font-semibold text-[#66c0f4] hover:text-white transition-colors cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#66c0f4]"
            >
              <ExternalLink className="w-3 h-3" aria-hidden="true" />
              <span>Download from Apple ↗</span>
            </button>
          </div>
          <p id="setup-gptk-dmg-desc" className="text-[11px] text-slate-300 leading-relaxed">
            Download the Game Porting Toolkit .dmg from Apple Developer, then choose the file below.
          </p>
          <div className="flex items-center gap-2">
            <input
              id="setup-gptk-dmg-field"
              type="text"
              data-testid="setup-gptk-dmg-input"
              aria-describedby="setup-gptk-dmg-desc"
              value={gptkDmgPath}
              onChange={(e) => onChangeGptkDmgPath(e.target.value)}
              placeholder="~/Downloads/Game_Porting_Toolkit.dmg"
              autoComplete="off"
              autoCorrect="off"
              autoCapitalize="off"
              spellCheck={false}
              className="flex-1 rounded-md bg-[#131c27] border border-[#2a475e] px-3 py-1.5 text-xs text-white placeholder-slate-400 font-mono focus:outline-none focus:border-[#66c0f4] focus-visible:ring-2 focus-visible:ring-[#66c0f4]"
            />
            <button
              type="button"
              data-testid="setup-gptk-browse-btn"
              onClick={() => void handleBrowseGptkDmg()}
              className="min-h-6 inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-[#1b2838] hover:bg-[#24354a] border border-[#2a475e] hover:border-[#66c0f4] text-xs font-semibold text-[#66c0f4] hover:text-white transition-colors cursor-pointer shrink-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#66c0f4]"
            >
              <FolderOpen className="w-3.5 h-3.5" aria-hidden="true" />
              <span>Browse...</span>
            </button>
          </div>
        </div>
      )}

      {/* Bottle Configuration Section */}
      {chosenRunner !== 'skip' && (
        <div
          data-testid="setup-bottle-config-section"
          className="rounded-lg bg-[#16202d] border border-[#2a475e]/80 p-3.5 space-y-3"
        >
          <div className="flex items-center gap-2">
            <HardDrive className="w-4 h-4 text-[#66c0f4]" aria-hidden="true" />
            <span className="text-xs font-semibold uppercase tracking-wider text-slate-300">
              Windows Game Folder (Bottle)
            </span>
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
              className={`min-h-6 text-left rounded-lg p-3 border transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#66c0f4] ${
                !canReuseBottle
                  ? 'bg-[#131c27]/60 border-[#2a475e]/50 opacity-50 cursor-not-allowed'
                  : isReuseBottleSelected
                    ? 'bg-[#1b2838] border-[#66c0f4] shadow-lg shadow-[#66c0f4]/10 cursor-pointer'
                    : 'bg-[#131c27] border-[#2a475e]/80 hover:border-[#66c0f4]/70 cursor-pointer'
              }`}
            >
              <div className="flex items-center justify-between gap-2">
                <span className="text-xs font-bold text-white">Use Existing Bottle</span>
                {availableBottles.length > 0 && (
                  <span className="text-[10px] px-1.5 py-0.5 rounded bg-emerald-500/20 border border-emerald-500/40 text-emerald-300 font-bold">
                    {availableBottles.length} Found
                  </span>
                )}
              </div>
              <p className="text-[11px] text-slate-300 mt-1 leading-snug">
                {availableBottles.length > 0
                  ? 'Keeps your existing Windows apps and logins.'
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
              className={`min-h-6 text-left rounded-lg p-3 border transition-all cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#66c0f4] ${
                isCreateBottleSelected
                  ? 'bg-[#1b2838] border-[#66c0f4] shadow-lg shadow-[#66c0f4]/10'
                  : 'bg-[#131c27] border-[#2a475e]/80 hover:border-[#66c0f4]/70'
              }`}
            >
              <span className="text-xs font-bold text-white">
                Create New &ldquo;OneLauncher&rdquo; Bottle
              </span>
              <p className="text-[11px] text-slate-300 mt-1 leading-snug">
                Creates a clean folder for your Windows games and saves.
              </p>
            </button>
          </div>

          {/* Detected Existing Bottles List */}
          {availableBottles.length > 0 && (
            <div className="space-y-1.5">
              <div className="text-[11px] font-semibold text-slate-300">Existing Bottles</div>
              <div className="flex flex-wrap gap-2">
                {availableBottles.map((b) => {
                  const isActiveBottle =
                    bottleMode === 'reuse_existing' && bottleName.trim() === b.name;
                  return (
                    <button
                      key={`${b.runnerType}-${b.name}`}
                      type="button"
                      data-testid={`setup-existing-bottle-${b.name}`}
                      onClick={() => {
                        onChangeBottleMode('reuse_existing');
                        onChangeBottleName(b.name);
                      }}
                      className={`min-h-6 inline-flex flex-wrap items-center gap-1.5 px-2.5 py-1.5 rounded-md border text-xs transition-all cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#66c0f4] ${
                        isActiveBottle
                          ? 'bg-[#1b2838] border-[#66c0f4] text-white'
                          : 'bg-[#131c27] border-[#2a475e] text-slate-200 hover:border-[#66c0f4]/70'
                      }`}
                    >
                      <CheckCircle2
                        className={`w-3.5 h-3.5 ${
                          isActiveBottle ? 'text-[#66c0f4]' : 'text-slate-400'
                        }`}
                        aria-hidden="true"
                      />
                      <span className="font-semibold">{b.name}</span>
                      {b.hasSteam && (
                        <span className="text-[10px] px-1.5 py-0.2 rounded bg-sky-500/20 border border-sky-500/40 text-sky-200 font-semibold">
                          Steam
                        </span>
                      )}
                      {b.hasGogGalaxy && (
                        <span className="text-[10px] px-1.5 py-0.2 rounded bg-purple-500/20 border border-purple-500/40 text-purple-200 font-semibold">
                          GOG
                        </span>
                      )}
                      {b.hasEpicLauncher && (
                        <span className="text-[10px] px-1.5 py-0.2 rounded bg-amber-500/20 border border-amber-500/40 text-amber-200 font-semibold">
                          Epic
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>
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
                  Use 1–64 letters, numbers, spaces, dots, underscores, or hyphens (no
                  &ldquo;..&rdquo;).
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
              aria-describedby="setup-bottle-name-desc"
              aria-invalid={!bottleNameValid ? true : undefined}
              value={bottleName}
              onChange={(e) => onChangeBottleName(e.target.value)}
              placeholder="OneLauncher"
              maxLength={64}
              autoComplete="off"
              autoCorrect="off"
              autoCapitalize="off"
              spellCheck={false}
              className={`w-full rounded-md bg-[#131c27] border px-3 py-1.5 text-xs text-white placeholder-slate-400 focus:outline-none focus-visible:ring-2 focus-visible:ring-[#66c0f4] ${
                bottleNameValid
                  ? 'border-[#2a475e] focus:border-[#66c0f4]'
                  : 'border-rose-500 focus:border-rose-400'
              }`}
            />
          </div>
        </div>
      )}
    </div>
  );
};
