import React from 'react';
import { AlertCircle, AlertTriangle, CheckCircle2, HardDrive } from 'lucide-react';
import type { EnvironmentHealthSnapshot } from '../../../../contracts/environmentSetup';
import type { CompatibilityLayerType } from '../../../../contracts/launcher';
import {
  isArm64NamedBottle,
  isBottleRecordCompatibleWithRunner,
} from '../../../../services/launcher/bottleArchitectureUtils';
import { LAUNCH_BUTTON_FOCUS_CLASSES } from '../../LaunchConfig/LaunchConfigControls';

type DiscoveredBottleSummary = NonNullable<
  NonNullable<EnvironmentHealthSnapshot['bottleSummary']>['availableBottles']
>[number];

export interface BottleProvisioningCardParams {
  chosenRunner: Exclude<CompatibilityLayerType, 'native'>;
  defaultBottleForRunner: string;
  availableBottles: ReadonlyArray<DiscoveredBottleSummary>;
  compatibleBottles: ReadonlyArray<DiscoveredBottleSummary>;
  canReuseBottle: boolean;
  isReuseBottleSelected: boolean;
  isCreateBottleSelected: boolean;
  bottleMode: 'reuse_existing' | 'create_dedicated';
  bottleName: string;
  bottleNameValid: boolean;
  hasIncompatibleSelectedBottle: boolean;
  reuseBottleRadioRef: React.MutableRefObject<HTMLButtonElement | null>;
  createBottleRadioRef: React.MutableRefObject<HTMLButtonElement | null>;
  onBottleModeKeyDown: (e: React.KeyboardEvent<HTMLDivElement>) => void;
  onActivateBottleMode: (mode: 'reuse_existing' | 'create_dedicated', focusButton?: boolean) => void;
  onSelectExistingBottle: (name: string) => void;
  onChangeBottleName: (name: string) => void;
}

export function renderBottleProvisioningCard({
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
  onBottleModeKeyDown,
  onActivateBottleMode,
  onSelectExistingBottle,
  onChangeBottleName,
}: BottleProvisioningCardParams): React.ReactElement {
  return (
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
        onKeyDown={onBottleModeKeyDown}
      >
        <button
          ref={reuseBottleRadioRef}
          type="button"
          role="radio"
          aria-checked={isReuseBottleSelected}
          tabIndex={isReuseBottleSelected ? 0 : -1}
          data-testid="setup-bottle-mode-reuse"
          disabled={!canReuseBottle}
          onClick={() => onActivateBottleMode('reuse_existing')}
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
          onClick={() => onActivateBottleMode('create_dedicated')}
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
            Creates a clean {chosenRunner === 'crossover_preview_arm64' ? 'arm64 / FEX ' : ''}folder
            for your Windows games and saves.
          </p>
        </button>
      </div>

      {/* Detected Existing Bottles List */}
      {availableBottles.length > 0 && (
        <div className="space-y-1.5">
          <div className="text-[11px] font-semibold text-slate-300">Existing Bottles</div>
          <div className="flex flex-wrap gap-2">
            {availableBottles.map((b) => {
              const isCompatible = isBottleRecordCompatibleWithRunner(b, chosenRunner);
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
                    onSelectExistingBottle(b.name);
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
                  {(bottleArch === 'arm64' || isArm64NamedBottle(b.name)) && (
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
  );
}
