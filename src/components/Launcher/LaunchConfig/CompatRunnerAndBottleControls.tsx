import React from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  Download,
  FolderOpen,
  Info,
  Link2,
  Loader2,
  LogIn,
  Wrench,
} from 'lucide-react';
import type {
  CompatibilityLayerInfo,
  CompatibilityLayerType,
  CompatibilityLayerUpdateInfo,
  CompatibilityRunnerDescriptor,
} from '../../../contracts/launcher';
import type { StorefrontId } from '../../../contracts/platform';
import { formatRunnerOptionLabel } from './launchConfigHelpers';
import {
  LAUNCH_BUTTON_FOCUS_CLASSES,
  LAUNCH_TEXT_INPUT_CLASSES,
  LaunchSelect,
} from './LaunchConfigControls';

export type BottleDetailsEntry = NonNullable<CompatibilityLayerInfo['bottleDetails']>[string];

export type BottleSteamFixMode = 'install_and_signin' | 'signin_only' | 'link_only';

export interface BottleSteamFixState {
  active: boolean;
  statusText: string;
  errorText?: string | null;
  successText?: string | null;
  sourceMode?: BottleSteamFixMode;
}

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
  platformId?: StorefrontId;
  isFastDirectActive?: boolean;
  installBottleName?: string | null;
  targetBottleDetails?: BottleDetailsEntry;
  recommendedInstallRunner?: CompatibilityLayerInfo | null;
  recommendedInstallRunnerLabel?: string;
  onAlignToInstallBottle?: (runnerType: CompatibilityLayerType, bottleName: string) => void;
  numericSteamAppId?: number;
  bottleSteamFixState?: BottleSteamFixState;
  onFixBottleSteam?: (params: {
    mode: BottleSteamFixMode;
    runnerType?: CompatibilityLayerType;
    bottleName?: string;
  }) => void;
  onCancelFixBottleSteam?: () => void;
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
  platformId,
  isFastDirectActive = false,
  installBottleName,
  targetBottleDetails,
  recommendedInstallRunner,
  recommendedInstallRunnerLabel,
  onAlignToInstallBottle,
  numericSteamAppId,
  bottleSteamFixState,
  onFixBottleSteam,
  onCancelFixBottleSteam,
}: CompatRunnerAndBottleControlsParams): React.ReactElement {
  const hasInstallBottleMismatch = Boolean(
    installBottleName &&
      effectiveSelectedBottleName &&
      installBottleName.toLowerCase() !== effectiveSelectedBottleName.toLowerCase()
  );
  const isUninitializedBottleOnProbedLayer = Boolean(
    effectiveActiveLayer &&
      effectiveActiveLayer.available !== false &&
      effectiveActiveLayer.bottleDetails !== undefined &&
      effectiveSelectedBottleName &&
      !targetBottleDetails &&
      !hasBottleArchMismatch
  );
  const effectiveBottleHasSteam: boolean | undefined =
    typeof targetBottleDetails?.hasSteam === 'boolean'
      ? targetBottleDetails.hasSteam
      : isUninitializedBottleOnProbedLayer
        ? false
        : undefined;
  const showSteamReadinessChip = Boolean(
    platformId === 'steam' && typeof effectiveBottleHasSteam === 'boolean'
  );
  const isBottleSteamMissing = Boolean(
    platformId === 'steam' &&
      !isFastDirectActive &&
      effectiveBottleHasSteam === false
  );
  const isBottleSteamSignInNeeded = Boolean(
    platformId === 'steam' &&
      !isFastDirectActive &&
      targetBottleDetails?.hasSteam === true &&
      targetBottleDetails?.steamSignedIn === false
  );
  const isSteamAppLinkedInTargetBottle = Boolean(
    numericSteamAppId &&
      Array.isArray(targetBottleDetails?.installedSteamAppIds) &&
      targetBottleDetails.installedSteamAppIds.includes(numericSteamAppId)
  );
  const canLinkSteamAppIntoTargetBottle = Boolean(
    hasInstallBottleMismatch &&
      platformId === 'steam' &&
      targetBottleDetails?.hasSteam === true &&
      Array.isArray(targetBottleDetails?.installedSteamAppIds) &&
      Boolean(numericSteamAppId) &&
      !isSteamAppLinkedInTargetBottle
  );
  const isBottleSteamFixActive = Boolean(bottleSteamFixState?.active);
  const canTriggerBottleSteamFix = Boolean(
    onFixBottleSteam &&
      effectiveSelectedBottleName &&
      effectiveCompatSelectValue !== 'native'
  );
  const progressOwner: 'missing' | 'signin' | 'mismatch' | 'standalone' = (() => {
    const mode = bottleSteamFixState?.sourceMode;
    if (mode === 'link_only' && hasInstallBottleMismatch && installBottleName) {
      return 'mismatch';
    }
    if (mode === 'signin_only' && isBottleSteamSignInNeeded) {
      return 'signin';
    }
    if (mode === 'install_and_signin' && isBottleSteamMissing) {
      return 'missing';
    }
    if (isBottleSteamMissing) return 'missing';
    if (isBottleSteamSignInNeeded) return 'signin';
    if (hasInstallBottleMismatch && installBottleName) return 'mismatch';
    return 'standalone';
  })();

  const renderInlineFixProgress = (): React.ReactElement => (
    <div
      data-testid="compat-bottle-steam-fix-progress"
      role="status"
      aria-live="polite"
      className="flex flex-wrap items-center justify-between gap-2 rounded bg-[#0d1520]/85 border border-sky-400/40 px-2.5 py-1.5 text-[11px] text-sky-100"
    >
      <div className="flex items-center gap-2 min-w-0 flex-1">
        <Loader2
          className="w-3.5 h-3.5 text-sky-300 animate-spin motion-reduce:animate-none shrink-0"
          aria-hidden="true"
        />
        <span className="leading-snug break-words">
          {bottleSteamFixState?.statusText || 'Setting up Windows Steam...'}
        </span>
      </div>
      {onCancelFixBottleSteam && (
        <button
          type="button"
          data-testid="compat-cancel-bottle-steam-fix-btn"
          onClick={onCancelFixBottleSteam}
          className={`min-h-6 inline-flex items-center gap-1 px-2 py-0.5 rounded bg-white/10 hover:bg-white/20 border border-sky-300/40 text-[11px] font-semibold text-sky-100 hover:text-white transition-colors cursor-pointer shrink-0 ${LAUNCH_BUTTON_FOCUS_CLASSES}`}
        >
          <span>Cancel</span>
        </button>
      )}
    </div>
  );
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
            disabled={isBottleSteamFixActive}
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
                disabled={isBottleSteamFixActive}
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
                disabled={isBottleSteamFixActive}
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
            {showSteamReadinessChip &&
              (effectiveBottleHasSteam === false ? (
                <span
                  data-testid="compat-bottle-steam-readiness-chip"
                  data-steam-readiness="missing"
                  className="inline-flex items-center gap-1 text-[10px] font-semibold px-2 py-0.5 rounded-full bg-rose-500/15 border border-rose-400/40 text-rose-200"
                >
                  <AlertTriangle className="w-3 h-3 text-rose-400 shrink-0" aria-hidden="true" />
                  <span>No Steam in Bottle</span>
                </span>
              ) : targetBottleDetails?.steamSignedIn === false ? (
                <span
                  data-testid="compat-bottle-steam-readiness-chip"
                  data-steam-readiness="sign_in_needed"
                  className="inline-flex items-center gap-1 text-[10px] font-semibold px-2 py-0.5 rounded-full bg-amber-500/15 border border-amber-400/40 text-amber-200"
                >
                  <AlertTriangle className="w-3 h-3 text-amber-400 shrink-0" aria-hidden="true" />
                  <span>Steam Sign-In Needed</span>
                </span>
              ) : (
                <span
                  data-testid="compat-bottle-steam-readiness-chip"
                  data-steam-readiness="ready"
                  className="inline-flex items-center gap-1 text-[10px] font-semibold px-2 py-0.5 rounded-full bg-emerald-500/15 border border-emerald-400/35 text-emerald-200"
                >
                  <CheckCircle2 className="w-3 h-3 text-emerald-400 shrink-0" aria-hidden="true" />
                  <span>Steam Ready</span>
                </span>
              ))}
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

      {hasInstallBottleMismatch && installBottleName && (
        <div className="space-y-1.5">
          <div
            data-testid="compat-install-bottle-mismatch-warning"
            role="status"
            aria-live="polite"
            className="flex flex-col gap-2 rounded-lg bg-amber-950/45 border border-amber-500/45 px-3 py-2 text-xs text-amber-100"
          >
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-start gap-2 min-w-0 flex-1">
                <Info className="w-3.5 h-3.5 text-amber-300 shrink-0 mt-0.5" aria-hidden="true" />
                <span className="leading-snug">
                  {platformId === 'steam' &&
                  isSteamAppLinkedInTargetBottle &&
                  targetBottleDetails?.steamSignedIn !== false ? (
                    <>
                      Installed in bottle{' '}
                      <strong className="text-white">&ldquo;{installBottleName}&rdquo;</strong>, while
                      the selected target bottle is{' '}
                      <strong className="text-white">
                        &ldquo;{effectiveSelectedBottleName}&rdquo;
                      </strong>
                      . This game &amp; Steam Cloud are linked in &ldquo;
                      {effectiveSelectedBottleName}&rdquo; (non-cloud local files remain separate from
                      &ldquo;{installBottleName}&rdquo;).
                    </>
                  ) : (
                    <>
                      Installed in bottle{' '}
                      <strong className="text-white">&ldquo;{installBottleName}&rdquo;</strong>, while
                      the selected target bottle is{' '}
                      <strong className="text-white">
                        &ldquo;{effectiveSelectedBottleName}&rdquo;
                      </strong>
                      . Local saves and storefront installs in &ldquo;{installBottleName}&rdquo; are
                      isolated from &ldquo;{effectiveSelectedBottleName}&rdquo;.
                    </>
                  )}
                </span>
              </div>
              {(canLinkSteamAppIntoTargetBottle && canTriggerBottleSteamFix) ||
              (recommendedInstallRunner && onAlignToInstallBottle) ? (
                <div className="flex flex-wrap items-center gap-1.5 shrink-0">
                  {canLinkSteamAppIntoTargetBottle && canTriggerBottleSteamFix && (
                    <button
                      type="button"
                      data-testid="compat-fix-link-steam-game-btn"
                      disabled={isBottleSteamFixActive}
                      onClick={() =>
                        onFixBottleSteam?.({
                          mode: 'link_only',
                          runnerType: effectiveCompatSelectValue,
                          bottleName: effectiveSelectedBottleName,
                        })
                      }
                      className={`min-h-6 inline-flex items-center gap-1.5 px-2.5 py-1 rounded bg-emerald-500/20 hover:bg-emerald-500/30 border border-emerald-400/55 text-[11px] font-semibold text-emerald-100 hover:text-white transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed shrink-0 ${LAUNCH_BUTTON_FOCUS_CLASSES}`}
                    >
                      <Link2 className="w-3 h-3 shrink-0" aria-hidden="true" />
                      <span>Link Game into {effectiveSelectedBottleName}</span>
                    </button>
                  )}
                  {recommendedInstallRunner && onAlignToInstallBottle && (
                    <button
                      type="button"
                      data-testid="compat-align-install-bottle-btn"
                      disabled={isBottleSteamFixActive}
                      onClick={() =>
                        onAlignToInstallBottle(recommendedInstallRunner.type, installBottleName)
                      }
                      className={`min-h-6 inline-flex items-center gap-1.5 px-2.5 py-1 rounded bg-sky-500/20 hover:bg-sky-500/30 border border-sky-400/50 text-[11px] font-semibold text-sky-100 hover:text-white transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed shrink-0 ${LAUNCH_BUTTON_FOCUS_CLASSES}`}
                    >
                      <span>
                        Switch to {recommendedInstallRunnerLabel || recommendedInstallRunner.name} (
                        {installBottleName})
                      </span>
                    </button>
                  )}
                </div>
              ) : null}
            </div>
          </div>
          {isBottleSteamFixActive && progressOwner === 'mismatch' && renderInlineFixProgress()}
        </div>
      )}

      {isBottleSteamMissing && (
        <div className="space-y-1.5">
          <div
            data-testid="compat-bottle-steam-missing-warning"
            role="alert"
            className="flex flex-col gap-2 rounded-lg bg-rose-950/55 border border-rose-500/50 px-3 py-2.5 text-xs text-rose-100"
          >
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div className="flex items-start gap-2 min-w-0 flex-1">
                <AlertTriangle
                  className="w-4 h-4 text-rose-400 shrink-0 mt-0.5"
                  aria-hidden="true"
                />
                <span className="leading-snug">
                  <strong className="text-rose-200">No Steam in Bottle:</strong> Bottle &ldquo;
                  {effectiveSelectedBottleName}&rdquo; does not have Windows Steam installed. Steam
                  Client &amp; Steam Cloud Saves will not work until you switch to a bottle with
                  Steam, install Windows Steam into &ldquo;{effectiveSelectedBottleName}&rdquo;, or
                  enable Fast Bottle Launch (disables Steam Cloud).
                </span>
              </div>
              {canTriggerBottleSteamFix && (
                <button
                  type="button"
                  data-testid="compat-fix-install-bottle-steam-btn"
                  disabled={isBottleSteamFixActive}
                  onClick={() =>
                    onFixBottleSteam?.({
                      mode: 'install_and_signin',
                      runnerType: effectiveCompatSelectValue,
                      bottleName: effectiveSelectedBottleName,
                    })
                  }
                  className={`min-h-6 inline-flex items-center gap-1.5 px-2.5 py-1 rounded bg-emerald-500/20 hover:bg-emerald-500/30 border border-emerald-400/55 text-[11px] font-semibold text-emerald-100 hover:text-white transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed shrink-0 ${LAUNCH_BUTTON_FOCUS_CLASSES}`}
                >
                  <Download className="w-3 h-3 shrink-0" aria-hidden="true" />
                  <span>Install &amp; Set Up Steam in {effectiveSelectedBottleName}</span>
                </button>
              )}
            </div>
          </div>
          {isBottleSteamFixActive && progressOwner === 'missing' && renderInlineFixProgress()}
        </div>
      )}

      {isBottleSteamSignInNeeded && (
        <div className="space-y-1.5">
          <div
            data-testid="compat-bottle-steam-signin-warning"
            role="alert"
            className="flex flex-col gap-2 rounded-lg bg-amber-950/55 border border-amber-500/50 px-3 py-2.5 text-xs text-amber-100"
          >
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div className="flex items-start gap-2 min-w-0 flex-1">
                <AlertTriangle
                  className="w-4 h-4 text-amber-400 shrink-0 mt-0.5"
                  aria-hidden="true"
                />
                <span className="leading-snug">
                  <strong className="text-amber-200">Steam Sign-In Needed:</strong> Windows Steam is
                  installed in &ldquo;{effectiveSelectedBottleName}&rdquo; but is not signed in yet.
                  Sign in once to enable game launches and Steam Cloud Saves in this bottle.
                </span>
              </div>
              {canTriggerBottleSteamFix && (
                <button
                  type="button"
                  data-testid="compat-fix-signin-bottle-steam-btn"
                  disabled={isBottleSteamFixActive}
                  onClick={() =>
                    onFixBottleSteam?.({
                      mode: 'signin_only',
                      runnerType: effectiveCompatSelectValue,
                      bottleName: effectiveSelectedBottleName,
                    })
                  }
                  className={`min-h-6 inline-flex items-center gap-1.5 px-2.5 py-1 rounded bg-amber-500/20 hover:bg-amber-500/30 border border-amber-400/55 text-[11px] font-semibold text-amber-100 hover:text-white transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed shrink-0 ${LAUNCH_BUTTON_FOCUS_CLASSES}`}
                >
                  <LogIn className="w-3 h-3 shrink-0" aria-hidden="true" />
                  <span>Sign In to Steam ({effectiveSelectedBottleName})</span>
                </button>
              )}
            </div>
          </div>
          {isBottleSteamFixActive && progressOwner === 'signin' && renderInlineFixProgress()}
        </div>
      )}

      {isBottleSteamFixActive && progressOwner === 'standalone' && renderInlineFixProgress()}

      {!isBottleSteamFixActive && bottleSteamFixState?.errorText && (
        <div
          data-testid="compat-bottle-steam-fix-error"
          role="alert"
          className="flex items-start gap-2 rounded-lg bg-rose-950/55 border border-rose-500/45 px-3 py-2 text-xs text-rose-100"
        >
          <AlertTriangle className="w-3.5 h-3.5 text-rose-400 shrink-0 mt-0.5" aria-hidden="true" />
          <span className="leading-snug">{bottleSteamFixState.errorText}</span>
        </div>
      )}

      {!isBottleSteamFixActive &&
        !bottleSteamFixState?.errorText &&
        bottleSteamFixState?.successText && (
          <div
            data-testid="compat-bottle-steam-fix-success"
            role="status"
            aria-live="polite"
            className="flex items-start gap-2 rounded-lg bg-emerald-950/50 border border-emerald-500/45 px-3 py-2 text-xs text-emerald-100"
          >
            <CheckCircle2
              className="w-3.5 h-3.5 text-emerald-400 shrink-0 mt-0.5"
              aria-hidden="true"
            />
            <span className="leading-snug">{bottleSteamFixState.successText}</span>
          </div>
        )}
    </>
  );
}
