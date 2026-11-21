import React from 'react';
import { AlertTriangle, CheckCircle2, FolderOpen, Wrench } from 'lucide-react';
import type {
  CompatibilityLayerInfo,
  CompatibilityLayerType,
  CompatibilityLayerUpdateInfo,
  CompatibilityRunnerDescriptor,
} from '../../../contracts/launcher';
import { formatRunnerOptionLabel } from './launchConfigHelpers';
import {
  LAUNCH_BUTTON_FOCUS_CLASSES,
  LAUNCH_TEXT_INPUT_CLASSES,
  LaunchSelect,
} from './LaunchConfigControls';

export interface CompatRunnerAndBottleControlsParams {
  visibleCompatLayerOptions: ReadonlyArray<{
    value: Exclude<CompatibilityLayerType, 'native'>;
    label: string;
  }>;
  effectiveCompatSelectValue: CompatibilityLayerType;
  detectedLayers: CompatibilityLayerInfo[];
  runnerUpdates: Record<string, CompatibilityLayerUpdateInfo>;
  onSelectCompatibilityLayer: (layer: CompatibilityLayerType) => void;
  showBottleControl: boolean;
  isCrossOverFamily: boolean;
  effectiveAvailableBottles: string[];
  effectiveBottleControlValue: string;
  defaultResolvedBottle?: string;
  effectiveActiveLayer?: CompatibilityLayerInfo;
  bottlePlaceholder: string;
  onChangeWineBottleName: (value: string) => void;
  hasBottleArchMismatch: boolean;
  effectiveSelectedBottleName: string;
  effectiveRunnerDescriptor: CompatibilityRunnerDescriptor;
  effectiveUpdateInfo?: CompatibilityLayerUpdateInfo;
  effectiveInstalledVer?: string;
  sanitizedSecondaryBuild: string;
  resolvedBottleFolderPath?: string;
  onOpenBottleFolder?: () => void;
  onOpenRunnerManager: () => void;
}

export function renderCompatRunnerAndBottleControls({
  visibleCompatLayerOptions,
  effectiveCompatSelectValue,
  detectedLayers,
  runnerUpdates,
  onSelectCompatibilityLayer,
  showBottleControl,
  isCrossOverFamily,
  effectiveAvailableBottles,
  effectiveBottleControlValue,
  defaultResolvedBottle,
  effectiveActiveLayer,
  bottlePlaceholder,
  onChangeWineBottleName,
  hasBottleArchMismatch,
  effectiveSelectedBottleName,
  effectiveRunnerDescriptor,
  effectiveUpdateInfo,
  effectiveInstalledVer,
  sanitizedSecondaryBuild,
  resolvedBottleFolderPath,
  onOpenBottleFolder,
  onOpenRunnerManager,
}: CompatRunnerAndBottleControlsParams): React.ReactElement {
  return (
    <>
      {/* Primary 1 & 2: Compatibility Layer & Bottle */}
      <div className={`grid grid-cols-1 ${showBottleControl ? 'sm:grid-cols-2' : ''} gap-3`}>
        <div className="space-y-1.5">
          <label
            htmlFor="compat-runner-select"
            className="block text-[10px] font-bold uppercase tracking-wider text-steam-subtext"
          >
            Compatibility Layer
          </label>
          <LaunchSelect
            id="compat-runner-select"
            data-testid="compat-runner-select"
            aria-label="Compatibility Layer"
            value={effectiveCompatSelectValue}
            onChange={(e) =>
              onSelectCompatibilityLayer(e.target.value as CompatibilityLayerType)
            }
          >
            {visibleCompatLayerOptions.map((opt) => {
              const layerInfo = detectedLayers.find((l) => l.type === opt.value);
              const upd = runnerUpdates[opt.value];
              return (
                <option key={opt.value} value={opt.value}>
                  {formatRunnerOptionLabel(opt, layerInfo, upd)}
                </option>
              );
            })}
          </LaunchSelect>
        </div>

        {showBottleControl && (
          <div className="space-y-1.5">
            <label
              htmlFor="compat-target-bottle-control"
              className="block text-[10px] font-bold uppercase tracking-wider text-steam-subtext"
            >
              {isCrossOverFamily ? 'Target CrossOver Bottle' : 'Target Bottle Name'}
            </label>
            {effectiveAvailableBottles.length > 0 ? (
              <LaunchSelect
                id="compat-target-bottle-control"
                aria-label="Target Bottle Name"
                value={effectiveBottleControlValue}
                onChange={(e) => onChangeWineBottleName(e.target.value)}
              >
                <option value="">
                  Default Bottle ({defaultResolvedBottle || effectiveAvailableBottles[0]})
                </option>
                {effectiveAvailableBottles.map((b) => {
                  const bottleArch = effectiveActiveLayer?.bottleDetails?.[b]?.wineArch;
                  const archSuffix =
                    bottleArch === 'arm64'
                      ? ' (arm64 / FEX)'
                      : bottleArch === 'win64'
                        ? ' (Intel / win64)'
                        : '';
                  return (
                    <option key={b} value={b}>
                      {b}
                      {archSuffix}
                    </option>
                  );
                })}
              </LaunchSelect>
            ) : (
              <input
                id="compat-target-bottle-control"
                type="text"
                aria-label="Target Bottle Name"
                value={effectiveBottleControlValue}
                onChange={(e) => onChangeWineBottleName(e.target.value)}
                placeholder={bottlePlaceholder}
                autoComplete="off"
                spellCheck={false}
                autoCorrect="off"
                autoCapitalize="off"
                className={`${LAUNCH_TEXT_INPUT_CLASSES} font-mono`}
              />
            )}
            {hasBottleArchMismatch && (
              <div
                data-testid="compat-bottle-arch-mismatch-warning"
                role="alert"
                className="flex items-start gap-1.5 rounded bg-amber-950/45 border border-amber-500/45 px-2 py-1 text-[10px] text-amber-200"
              >
                <AlertTriangle
                  className="w-3 h-3 text-amber-400 shrink-0 mt-0.5"
                  aria-hidden="true"
                />
                <span>
                  Bottle &ldquo;{effectiveSelectedBottleName}&rdquo; does not match{' '}
                  {effectiveCompatSelectValue === 'crossover_preview_arm64'
                    ? 'arm64 / FEX (use "OneLauncher-arm64").'
                    : 'Intel / win64 (use "OneLauncher").'}
                </span>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Compact 1-line Runner Status Strip */}
      {effectiveActiveLayer ? (
        <div
          data-testid="runner-status-banner"
          className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-[#141d2b] border border-[#26384d] px-3 py-2 text-xs"
        >
          <div className="flex flex-wrap items-center gap-2 min-w-0">
            <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400 shrink-0" aria-hidden="true" />
            <span className="font-semibold text-white">{effectiveRunnerDescriptor.shortLabel}</span>
            <span
              data-testid="runner-installed-version"
              className="font-mono text-[11px] text-emerald-300"
            >
              v{effectiveInstalledVer || 'Detected'}
              {sanitizedSecondaryBuild ? ` · ${sanitizedSecondaryBuild}` : ''}
            </span>
            {effectiveActiveLayer.d3dmetalVersion && (
              <span
                data-testid="runner-d3dmetal-version"
                className="text-[10px] font-semibold px-2 py-0.5 rounded-full bg-sky-500/15 border border-sky-500/30 text-sky-300"
              >
                {(effectiveActiveLayer.availableD3DMetalVersions?.length || 0) > 1
                  ? `D3DMetal ${effectiveActiveLayer.availableD3DMetalVersions![0].version} / ${effectiveActiveLayer.availableD3DMetalVersions![1].version}`
                  : `D3DMetal ${effectiveActiveLayer.d3dmetalVersion}`}
              </span>
            )}
            {effectiveUpdateInfo?.updateAvailable && effectiveUpdateInfo.latestVersion && (
              <span
                data-testid="runner-update-available-badge"
                className="text-[10px] font-semibold px-2 py-0.5 rounded bg-amber-500/15 border border-amber-500/35 text-amber-300"
              >
                Update v{effectiveUpdateInfo.latestVersion}
              </span>
            )}
          </div>

          <div className="flex flex-wrap items-center gap-1.5 shrink-0">
            {resolvedBottleFolderPath && onOpenBottleFolder && (
              <button
                type="button"
                data-testid="open-bottle-folder-btn"
                onClick={onOpenBottleFolder}
                className={`min-h-[24px] inline-flex items-center gap-1 px-2 py-1 rounded bg-[#1b2838] hover:bg-[#25374d] border border-[#2a475e] text-[11px] font-semibold text-steam-subtext hover:text-white transition-colors cursor-pointer ${LAUNCH_BUTTON_FOCUS_CLASSES}`}
              >
                <FolderOpen className="w-3 h-3" aria-hidden="true" />
                <span>{isCrossOverFamily ? 'Bottle Folder' : 'Prefix Folder'}</span>
              </button>
            )}
            <button
              type="button"
              data-testid="manage-runners-bottles-btn"
              onClick={onOpenRunnerManager}
              className={`min-h-[24px] inline-flex items-center gap-1 px-2.5 py-1 rounded bg-sky-500/15 hover:bg-sky-500/25 border border-sky-400/40 text-[11px] font-semibold text-sky-200 hover:text-white transition-colors cursor-pointer ${LAUNCH_BUTTON_FOCUS_CLASSES}`}
            >
              <Wrench className="w-3 h-3" aria-hidden="true" />
              <span>Manage Runners &amp; Bottles…</span>
            </button>
          </div>
        </div>
      ) : (
        <div
          data-testid="runner-not-installed-callout"
          className="flex flex-wrap items-center justify-between gap-2.5 rounded-lg bg-amber-950/40 border border-amber-500/40 px-3 py-2 text-xs text-amber-200"
        >
          <div className="flex items-center gap-2 min-w-0">
            <AlertTriangle className="w-3.5 h-3.5 text-amber-400 shrink-0" aria-hidden="true" />
            <span className="truncate">
              <strong className="text-amber-300">{effectiveRunnerDescriptor.shortLabel}</strong> is
              not installed on this Mac.
            </span>
          </div>
          <button
            type="button"
            data-testid="manage-runners-bottles-btn"
            onClick={onOpenRunnerManager}
            className={`min-h-[24px] inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-sky-500/20 hover:bg-sky-500/30 border border-sky-400/50 text-[11px] font-bold text-sky-200 hover:text-white transition-colors cursor-pointer shrink-0 ${LAUNCH_BUTTON_FOCUS_CLASSES}`}
          >
            <Wrench className="w-3 h-3" aria-hidden="true" />
            <span>Manage Runners &amp; Bottles…</span>
          </button>
        </div>
      )}
    </>
  );
}
