import React, { useEffect, useRef, useState } from 'react';
import type {
  ClientLoginTargetId,
  EnvironmentComponentId,
  EnvironmentHealthSnapshot,
  GuidedClientLoginResult,
} from '../../../../contracts/environmentSetup';
import type { CompatibilityLayerType } from '../../../../contracts/launcher';
import { environmentSetupService } from '../../../../services/launcher/environmentSetupService';
import { StorefrontIcon } from '../../../Common/StorefrontIcon';
import {
  AlertTriangle,
  ArrowLeft,
  CheckCircle2,
  FastForward,
  Loader2,
  LogIn,
  Play,
  ShieldAlert,
  Square,
  XCircle,
} from 'lucide-react';

export interface GuidedClientSignInStepProps {
  snapshot: EnvironmentHealthSnapshot;
  chosenRunner: Exclude<CompatibilityLayerType, 'native'> | 'skip';
  bottleName: string;
  installStepNumber?: number;
  selectedIds: ReadonlySet<EnvironmentComponentId>;
  activeGuidedLoginTarget: ClientLoginTargetId | null;
  autoCloseOnSuccess: boolean;
  onToggleAutoCloseOnSuccess: (next: boolean) => void;
  onGuidedLoginCompleted: () => void;
  onGoToProvisionStep?: () => void;
  onAllPendingSkippedChange?: (allPendingSkipped: boolean) => void;
}

const ORDERED_TARGETS: ReadonlyArray<ClientLoginTargetId> = [
  'host_steam',
  'bottle_steam',
  'host_gog',
  'bottle_gog',
  'host_epic',
  'bottle_epic',
];

export const GuidedClientSignInStep: React.FC<GuidedClientSignInStepProps> = ({
  snapshot,
  chosenRunner,
  bottleName,
  installStepNumber,
  selectedIds,
  activeGuidedLoginTarget,
  autoCloseOnSuccess,
  onToggleAutoCloseOnSuccess,
  onGuidedLoginCompleted,
  onGoToProvisionStep,
  onAllPendingSkippedChange,
}) => {
  const [lastResults, setLastResults] = useState<
    Partial<Record<ClientLoginTargetId, GuidedClientLoginResult>>
  >({});
  const [queueTargets, setQueueTargets] = useState<ClientLoginTargetId[]>([]);
  const [queueCurrentIndex, setQueueCurrentIndex] = useState<number>(0);
  const [isQueueActive, setIsQueueActive] = useState<boolean>(false);
  const [queuePausedReason, setQueuePausedReason] = useState<string | null>(null);
  const [skippedInQueue, setSkippedInQueue] = useState<Set<ClientLoginTargetId>>(
    () => new Set()
  );

  const mountedRef = useRef<boolean>(true);
  const queueAbortRef = useRef<boolean>(false);
  const skipCurrentRef = useRef<boolean>(false);

  const isMac = snapshot.hostPlatform === 'darwin';
  const showBottleTargets = isMac && chosenRunner !== 'skip';
  const resolvedInstallStepNumber = installStepNumber ?? 4;

  const visibleTargets = ORDERED_TARGETS.filter((targetId) => {
    if (targetId.startsWith('bottle_') && !showBottleTargets) {
      return false;
    }
    return Boolean(snapshot.clientLogins[targetId]);
  });

  const installedTargets = visibleTargets.filter((targetId) =>
    Boolean(snapshot.clientLogins[targetId]?.installed)
  );

  const pendingTargets = installedTargets.filter((targetId) => {
    const probe = snapshot.clientLogins[targetId];
    return Boolean(
      probe?.installed && (!probe.authenticated || probe.accountMatchesOneLauncher === false)
    );
  });

  const signedInTargets = installedTargets.filter((targetId) => {
    const probe = snapshot.clientLogins[targetId];
    return Boolean(
      probe?.installed && probe.authenticated && probe.accountMatchesOneLauncher !== false
    );
  });

  const queuedButUninstalledTargets = visibleTargets.filter((targetId) => {
    const probe = snapshot.clientLogins[targetId];
    return Boolean(probe && !probe.installed && selectedIds.has(targetId));
  });

  const anyInstalled = installedTargets.length > 0;
  const allPendingSkipped =
    !isQueueActive &&
    pendingTargets.length > 0 &&
    pendingTargets.every((id) => skippedInQueue.has(id));

  const onAllPendingSkippedChangeRef = useRef(onAllPendingSkippedChange);
  onAllPendingSkippedChangeRef.current = onAllPendingSkippedChange;

  useEffect(() => {
    onAllPendingSkippedChangeRef.current?.(allPendingSkipped);
  }, [allPendingSkipped]);

  const effectiveRunnerType: Exclude<CompatibilityLayerType, 'native'> | undefined =
    chosenRunner !== 'skip'
      ? chosenRunner
      : (snapshot.bottleSummary?.runnerType ?? undefined);

  const autoCloseRef = useRef<boolean>(autoCloseOnSuccess);
  autoCloseRef.current = autoCloseOnSuccess;
  const bottleNameRef = useRef<string>(bottleName);
  bottleNameRef.current = bottleName;
  const effectiveRunnerRef = useRef<Exclude<CompatibilityLayerType, 'native'> | undefined>(
    effectiveRunnerType
  );
  effectiveRunnerRef.current = effectiveRunnerType;
  const onGuidedLoginCompletedRef = useRef(onGuidedLoginCompleted);
  onGuidedLoginCompletedRef.current = onGuidedLoginCompleted;

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      queueAbortRef.current = true;
      const inFlight = environmentSetupService.getActiveGuidedLoginTarget();
      if (inFlight) {
        void environmentSetupService.cancelGuidedLogin(inFlight);
      }
    };
  }, []);

  const handleStartSequentialQueue = async () => {
    if (isQueueActive || activeGuidedLoginTarget !== null) return;
    const targetsToRun = [...pendingTargets];
    if (targetsToRun.length === 0) return;

    queueAbortRef.current = false;
    skipCurrentRef.current = false;
    const localSkipped = new Set<ClientLoginTargetId>();
    setQueueTargets(targetsToRun);
    setQueueCurrentIndex(0);
    setQueuePausedReason(null);
    setSkippedInQueue(new Set());
    setIsQueueActive(true);
    onAllPendingSkippedChangeRef.current?.(false);

    for (let idx = 0; idx < targetsToRun.length; idx++) {
      if (queueAbortRef.current || !mountedRef.current) break;

      const targetId = targetsToRun[idx];
      const latestProbe =
        environmentSetupService.getLastSnapshot()?.clientLogins?.[targetId] ??
        snapshot.clientLogins[targetId];
      if (
        latestProbe?.installed &&
        latestProbe.authenticated &&
        latestProbe.accountMatchesOneLauncher !== false
      ) {
        continue;
      }

      if (!mountedRef.current) break;
      setQueueCurrentIndex(idx);
      skipCurrentRef.current = false;

      const isBottleScope = targetId.startsWith('bottle_');
      const currentRunner = effectiveRunnerRef.current;
      const currentBottle = bottleNameRef.current.trim() || 'OneLauncher';

      const result = await environmentSetupService.startGuidedLogin({
        targetId,
        ...(isBottleScope && currentRunner ? { runnerType: currentRunner } : {}),
        ...(isBottleScope ? { bottleName: currentBottle } : {}),
        autoCloseOnSuccess: autoCloseRef.current,
      });

      if (!mountedRef.current) return;

      setLastResults((prev) => ({
        ...prev,
        [targetId]: result,
      }));
      onGuidedLoginCompletedRef.current();

      if (queueAbortRef.current) {
        break;
      }

      if (skipCurrentRef.current) {
        localSkipped.add(targetId);
        setSkippedInQueue((prev) => {
          const next = new Set(prev);
          next.add(targetId);
          return next;
        });
        continue;
      }

      if (result.authenticated && result.probeState?.accountMatchesOneLauncher !== false) {
        continue;
      }

      setQueuePausedReason(
        result.error || result.message || 'Sign-in was not completed.'
      );
      setIsQueueActive(false);
      return;
    }

    if (mountedRef.current) {
      setIsQueueActive(false);
      if (!queueAbortRef.current) {
        const finalSnap = environmentSetupService.getLastSnapshot() ?? snapshot;
        const remainingPending = visibleTargets.filter((id) => {
          const p = finalSnap.clientLogins[id];
          return Boolean(
            p?.installed && (!p.authenticated || p.accountMatchesOneLauncher === false)
          );
        });
        const allRemainingSkipped =
          remainingPending.length > 0 && remainingPending.every((id) => localSkipped.has(id));
        onAllPendingSkippedChangeRef.current?.(allRemainingSkipped);
      }
    }
  };

  const handleSkipInQueue = async () => {
    if (!isQueueActive) return;
    skipCurrentRef.current = true;
    const activeId = activeGuidedLoginTarget ?? queueTargets[queueCurrentIndex];
    if (activeId) {
      await environmentSetupService.cancelGuidedLogin(activeId);
    }
  };

  const handleStopQueue = async () => {
    if (!isQueueActive) return;
    queueAbortRef.current = true;
    const activeId = activeGuidedLoginTarget ?? queueTargets[queueCurrentIndex];
    if (activeId) {
      await environmentSetupService.cancelGuidedLogin(activeId);
    }
    if (mountedRef.current) {
      setIsQueueActive(false);
    }
  };

  const handleStartGuidedLogin = async (targetId: ClientLoginTargetId) => {
    if (activeGuidedLoginTarget || isQueueActive) return;
    const probe = snapshot.clientLogins[targetId];
    const hasMismatch = Boolean(
      probe?.installed && probe.accountMatchesOneLauncher === false
    );
    const shouldForceInteractive = Boolean(probe?.authenticated && !hasMismatch);
    const isBottleScope = targetId.startsWith('bottle_');
    const result = await environmentSetupService.startGuidedLogin({
      targetId,
      ...(isBottleScope && effectiveRunnerType ? { runnerType: effectiveRunnerType } : {}),
      ...(isBottleScope ? { bottleName: bottleName.trim() || 'OneLauncher' } : {}),
      autoCloseOnSuccess,
      ...(shouldForceInteractive ? { forceInteractiveLogin: true } : {}),
    });
    if (!mountedRef.current) return;
    setLastResults((prev) => ({
      ...prev,
      [targetId]: result,
    }));
    onGuidedLoginCompleted();
  };

  const handleCancelWatch = async (targetId: ClientLoginTargetId) => {
    if (isQueueActive) {
      queueAbortRef.current = true;
      setIsQueueActive(false);
    }
    await environmentSetupService.cancelGuidedLogin(targetId);
  };

  const currentQueueTargetId = queueTargets[queueCurrentIndex];
  const currentQueueLabel =
    (currentQueueTargetId && snapshot.clientLogins[currentQueueTargetId]?.label) ||
    currentQueueTargetId ||
    'Launcher';

  return (
    <div className="space-y-4" data-testid="setup-step-client-logins">
      {/* Intro & Auto-Close Toggle */}
      <div className="space-y-3">
        <div className="p-3 rounded-lg bg-[#131c27] border border-[#2a475e]/80 text-xs text-slate-200 leading-relaxed">
          Sign in once to each launcher you installed (and check &ldquo;Remember me&rdquo;) so your
          game downloads start automatically.
        </div>

        {anyInstalled && (
          <label
            htmlFor="guided-login-autoclose-checkbox"
            className="flex items-center gap-2.5 rounded-lg bg-[#16202d] border border-[#2a475e]/80 px-3 py-2.5 text-xs text-slate-200 cursor-pointer hover:border-[#66c0f4]/60 transition-colors"
          >
            <input
              id="guided-login-autoclose-checkbox"
              type="checkbox"
              data-testid="guided-login-autoclose-toggle"
              checked={autoCloseOnSuccess}
              onChange={(e) => onToggleAutoCloseOnSuccess(e.target.checked)}
              className="w-4 h-4 rounded border-[#2a475e] bg-[#131c27] text-[#66c0f4] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#66c0f4] cursor-pointer shrink-0"
            />
            <span>Close each launcher automatically after signing in</span>
          </label>
        )}
      </div>

      {/* Sequential Sign-In Queue Banner */}
      {isQueueActive ? (
        <div
          data-testid="sequential-signin-banner"
          className="rounded-lg bg-[#1b2838] border border-[#66c0f4]/70 p-3.5 space-y-3"
        >
          <div className="flex flex-wrap items-center justify-between gap-2.5">
            <div
              role="status"
              aria-live="polite"
              className="flex items-center gap-2 text-xs font-bold text-white min-w-0"
            >
              <Loader2
                className="w-4 h-4 text-[#66c0f4] shrink-0 ol-guided-spinner"
                aria-hidden="true"
              />
              <span className="truncate">
                Signing in ({queueCurrentIndex + 1} of {queueTargets.length}): {currentQueueLabel}
              </span>
            </div>

            <div className="flex flex-wrap items-center gap-2 shrink-0">
              <button
                type="button"
                data-testid="sequential-signin-skip-btn"
                onClick={() => void handleSkipInQueue()}
                className="min-h-6 inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-[#131c27] hover:bg-[#24354a] border border-[#2a475e] hover:border-[#66c0f4] text-xs font-semibold text-slate-200 hover:text-white transition-colors cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#66c0f4]"
              >
                <FastForward className="w-3.5 h-3.5" aria-hidden="true" />
                <span>
                  {queueCurrentIndex < queueTargets.length - 1 ? 'Skip & Next' : 'Skip'}
                </span>
              </button>

              <button
                type="button"
                data-testid="sequential-signin-stop-btn"
                onClick={() => void handleStopQueue()}
                className="min-h-6 inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-rose-950/60 hover:bg-rose-900/70 border border-rose-500/50 text-xs font-bold text-rose-200 hover:text-white transition-colors cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#66c0f4]"
              >
                <Square className="w-3 h-3" aria-hidden="true" />
                <span>Stop</span>
              </button>
            </div>
          </div>

          <progress
            className="ol-setup-progress w-full h-2 block"
            max={Math.max(1, queueTargets.length)}
            value={queueCurrentIndex}
            aria-label="Launcher sign-in progress"
            aria-valuetext={`Step ${queueCurrentIndex + 1} of ${queueTargets.length}: Waiting for sign-in to ${currentQueueLabel}`}
          />

          <div className="flex flex-wrap items-center gap-1.5">
            {queueTargets.map((qId, idx) => {
              const label = snapshot.clientLogins[qId]?.label || qId;
              const isCurrent = idx === queueCurrentIndex;
              const isPast = idx < queueCurrentIndex;
              const wasSkipped = skippedInQueue.has(qId);

              const badgeStyle = isCurrent
                ? 'bg-[#66c0f4]/20 border-[#66c0f4] text-white font-bold'
                : isPast
                  ? wasSkipped
                    ? 'bg-[#131c27] border-[#2a475e] text-slate-300 font-semibold'
                    : 'bg-emerald-500/20 border-emerald-500/45 text-emerald-200 font-bold'
                  : 'bg-[#131c27] border-[#2a475e]/80 text-slate-300 font-medium';

              const statusTag = isCurrent
                ? 'Open'
                : isPast
                  ? wasSkipped
                    ? 'Skipped'
                    : 'Done'
                  : 'Next';

              return (
                <span
                  key={qId}
                  className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md border text-[11px] ${badgeStyle}`}
                >
                  <span>
                    {idx + 1}. {label}
                  </span>
                  <span className="text-[10px] opacity-90">({statusTag})</span>
                </span>
              );
            })}
          </div>
        </div>
      ) : pendingTargets.length > 0 ? (
        <div
          data-testid="sequential-signin-banner"
          className="rounded-lg bg-[#16202d] border border-[#66c0f4]/55 p-3.5 space-y-2.5"
        >
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="space-y-1 min-w-0 flex-1">
              <div className="text-xs font-bold text-white">
                {pendingTargets.length === 1
                  ? '1 launcher needs sign-in'
                  : `Sign in one by one (${pendingTargets.length} launchers)`}
              </div>
              <p className="text-[11px] text-slate-200 leading-relaxed">
                {pendingTargets
                  .map((id, i) => `${i + 1}. ${snapshot.clientLogins[id]?.label || id}`)
                  .join('  →  ')}
              </p>
            </div>

            <button
              type="button"
              data-testid="start-sequential-signin-btn"
              disabled={activeGuidedLoginTarget !== null}
              onClick={() => void handleStartSequentialQueue()}
              className="min-h-6 inline-flex items-center gap-1.5 px-4 py-2 rounded-md bg-[#66c0f4] text-slate-950 font-bold hover:brightness-110 text-xs shadow transition-all cursor-pointer disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#66c0f4] shrink-0"
            >
              <Play className="w-3.5 h-3.5 fill-slate-950" aria-hidden="true" />
              <span>
                {queuePausedReason
                  ? `Resume Sign-In (${pendingTargets.length})`
                  : pendingTargets.length === 1
                    ? 'Open & Sign In'
                    : `Sign In One by One (${pendingTargets.length})`}
              </span>
            </button>
          </div>

          {queuePausedReason && (
            <div className="rounded bg-amber-950/45 border border-amber-500/40 px-3 py-1.5 text-[11px] text-amber-200">
              Paused: {queuePausedReason}
            </div>
          )}
        </div>
      ) : anyInstalled ? (
        <div
          data-testid="all-installed-clients-signed-in-banner"
          className="rounded-lg bg-[#16202d] border border-emerald-500/45 p-3.5 flex items-center gap-2.5"
        >
          <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" aria-hidden="true" />
          <div className="space-y-0.5">
            <div className="text-xs font-bold text-emerald-200">All launchers signed in</div>
            <p className="text-[11px] text-slate-200">
              You&rsquo;re all set — click <strong className="text-white">Finish Setup</strong>{' '}
              below.
            </p>
          </div>
        </div>
      ) : queuedButUninstalledTargets.length === 0 ? (
        <div className="rounded-lg bg-[#16202d] border border-emerald-500/45 p-3.5 flex items-center gap-2.5">
          <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" aria-hidden="true" />
          <div className="text-xs text-slate-200">
            <strong className="text-white">No extra launcher sign-ins needed.</strong> Your games
            are ready to play.
          </div>
        </div>
      ) : null}

      {/* Hint when selected launchers have not been installed yet */}
      {queuedButUninstalledTargets.length > 0 && (
        <div
          data-testid="queued-uninstalled-clients-hint"
          className="rounded-lg bg-[#131c27] border border-[#66c0f4]/50 p-3 flex flex-wrap items-center justify-between gap-2.5"
        >
          <p className="text-[11px] text-slate-200 leading-relaxed min-w-0 flex-1">
            <strong className="text-white">
              {queuedButUninstalledTargets.length} selected launcher
              {queuedButUninstalledTargets.length === 1 ? ' hasn’t' : 's haven’t'} been installed
              yet:
            </strong>{' '}
            {queuedButUninstalledTargets
              .map((id) => snapshot.clientLogins[id]?.label || id)
              .join(', ')}
            . Install {queuedButUninstalledTargets.length === 1 ? 'it' : 'them'} in Step{' '}
            {resolvedInstallStepNumber} first.
          </p>
          {onGoToProvisionStep && (
            <button
              type="button"
              data-testid="go-to-provision-step-btn"
              disabled={isQueueActive || activeGuidedLoginTarget !== null}
              onClick={onGoToProvisionStep}
              className="min-h-6 inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-[#1b2838] hover:bg-[#24354a] border border-[#2a475e] hover:border-[#66c0f4] text-xs font-semibold text-[#66c0f4] hover:text-white transition-colors cursor-pointer disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#66c0f4] shrink-0"
            >
              <ArrowLeft className="w-3.5 h-3.5" aria-hidden="true" />
              <span>Back to Step {resolvedInstallStepNumber}: Install</span>
            </button>
          )}
        </div>
      )}

      {/* Installed Launcher Cards Separated into Needs Sign-In vs Signed In */}
      {installedTargets.length > 0 && (() => {
        const renderLauncherCard = (targetId: ClientLoginTargetId) => {
          const probe = snapshot.clientLogins[targetId];
          if (!probe) return null;

          const isWaiting = activeGuidedLoginTarget === targetId;
          const isOtherWaiting =
            activeGuidedLoginTarget !== null && activeGuidedLoginTarget !== targetId;
          const hasMismatch = probe.installed && probe.accountMatchesOneLauncher === false;
          const lastRes = lastResults[targetId];

          return (
            <div
              key={targetId}
              data-testid={`guided-login-card-${targetId}`}
              className={`rounded-lg border p-3.5 space-y-2.5 transition-all ${
                hasMismatch
                  ? 'bg-amber-950/30 border-amber-500/60'
                  : probe.authenticated
                    ? 'bg-[#16202d] border-emerald-500/45'
                    : 'bg-[#16202d] border-[#2a475e]/80'
              }`}
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-2.5 min-w-0">
                  <div className="w-8 h-8 rounded-lg bg-[#1b2838] border border-[#2a475e] flex items-center justify-center shrink-0">
                    <StorefrontIcon
                      storefrontId={probe.storefrontId}
                      decorative
                      className="w-4 h-4 text-[#66c0f4]"
                    />
                  </div>
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-xs font-bold text-white">{probe.label}</span>
                      {isMac && (
                        <span className="text-[10px] px-1.5 py-0.5 rounded bg-[#1b2838] border border-[#2a475e] text-slate-300 font-semibold">
                          {probe.scope === 'bottle' ? 'Windows' : 'Mac'}
                        </span>
                      )}
                    </div>
                    <p className="text-[11px] text-slate-300 mt-0.5">{probe.statusSummary}</p>
                  </div>
                </div>

                <div className="flex flex-wrap items-center gap-2 shrink-0">
                  {probe.authenticated && !hasMismatch ? (
                    <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded bg-emerald-500/20 border border-emerald-500/40 text-[10px] font-bold text-emerald-300">
                      <CheckCircle2 className="w-3 h-3 text-emerald-400" aria-hidden="true" />
                      <span>
                        Signed in
                        {probe.detectedAccountLabel ? ` (${probe.detectedAccountLabel})` : ''}
                      </span>
                    </span>
                  ) : (
                    <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded bg-amber-500/20 border border-amber-500/40 text-[10px] font-bold text-amber-200">
                      <AlertTriangle className="w-3 h-3 text-amber-400" aria-hidden="true" />
                      <span>{hasMismatch ? 'Different account' : 'Needs sign-in'}</span>
                    </span>
                  )}

                  {!isWaiting && (
                    <button
                      type="button"
                      data-testid={`guided-login-btn-${targetId}`}
                      aria-label={
                        probe.authenticated && !hasMismatch
                          ? `Open ${probe.label}`
                          : `Sign in to ${probe.label}`
                      }
                      disabled={isOtherWaiting || isQueueActive}
                      onClick={() => void handleStartGuidedLogin(targetId)}
                      className={`min-h-6 inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs transition-all cursor-pointer disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#66c0f4] ${
                        probe.authenticated && !hasMismatch
                          ? 'bg-[#1b2838] hover:bg-[#24354a] border border-[#2a475e] hover:border-[#66c0f4] font-semibold text-slate-200 hover:text-white'
                          : 'bg-[#66c0f4] text-slate-950 font-bold hover:brightness-110 shadow'
                      }`}
                    >
                      <LogIn className="w-3.5 h-3.5" aria-hidden="true" />
                      <span>
                        {probe.authenticated && !hasMismatch
                          ? `Open ${probe.label}`
                          : `Sign in to ${probe.label}`}
                      </span>
                    </button>
                  )}
                </div>
              </div>

              {/* Remember Me hint */}
              {probe.authenticated && probe.autoLoginEnabled === false && (
                <div className="rounded bg-amber-950/40 border border-amber-500/35 px-3 py-1.5 text-[11px] text-amber-200">
                  Tip: Turn on &ldquo;Remember me&rdquo; in {probe.label} so games start without
                  asking for your password.
                </div>
              )}

              {/* Account Mismatch Warning */}
              {hasMismatch && (
                <div
                  role="alert"
                  data-testid={`client-mismatch-${targetId}`}
                  className="rounded-lg bg-amber-950/65 border border-amber-400/60 p-3 flex flex-wrap items-center justify-between gap-2.5"
                >
                  <div className="flex items-start gap-2 min-w-0 flex-1">
                    <ShieldAlert
                      className="w-4 h-4 text-amber-400 shrink-0 mt-0.5"
                      aria-hidden="true"
                    />
                    <div className="space-y-0.5 min-w-0">
                      <div className="text-xs font-bold text-amber-200">
                        Different account signed in
                      </div>
                      <p className="text-[11px] text-amber-100 leading-snug">
                        {probe.mismatchReason ||
                          'This launcher is signed into a different account than One Launcher.'}
                      </p>
                    </div>
                  </div>
                  <button
                    type="button"
                    disabled={isWaiting || isOtherWaiting || isQueueActive}
                    onClick={() => void handleStartGuidedLogin(targetId)}
                    className="min-h-6 px-3 py-1.5 rounded-md bg-amber-500/25 hover:bg-amber-500/35 border border-amber-400 text-xs font-bold text-amber-100 hover:text-white transition-colors cursor-pointer disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#66c0f4] shrink-0"
                  >
                    Switch Account
                  </button>
                </div>
              )}

              {/* Live Waiting Watcher Banner */}
              {isWaiting && (
                <div
                  role={isQueueActive ? undefined : 'status'}
                  aria-live={isQueueActive ? undefined : 'polite'}
                  data-testid={`guided-login-watching-${targetId}`}
                  className="rounded-lg bg-[#131c27] border border-[#66c0f4]/55 p-3 flex flex-wrap items-center justify-between gap-3"
                >
                  <div className="flex items-center gap-2.5 min-w-0 flex-1">
                    <Loader2
                      className="w-4 h-4 text-[#66c0f4] shrink-0 ol-guided-spinner"
                      aria-hidden="true"
                    />
                    <span className="text-xs text-slate-100 leading-snug">
                      Sign in inside the launcher window (check &ldquo;Remember me&rdquo;).
                      Waiting for sign-in...
                    </span>
                  </div>
                  <button
                    type="button"
                    data-testid={`guided-login-cancel-${targetId}`}
                    onClick={() => void handleCancelWatch(targetId)}
                    className="min-h-6 inline-flex items-center gap-1 px-3 py-1 rounded-md bg-[#1b2838] hover:bg-[#24354a] border border-[#2a475e] hover:border-[#66c0f4] text-xs font-semibold text-slate-200 hover:text-white transition-colors cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#66c0f4] shrink-0"
                  >
                    <XCircle className="w-3.5 h-3.5" aria-hidden="true" />
                    <span>Cancel</span>
                  </button>
                </div>
              )}

              {/* Last Guided Login Outcome Feedback */}
              {!isWaiting && lastRes && (lastRes.error || lastRes.timedOut || lastRes.message) && (
                <div
                  className={`rounded px-2.5 py-1.5 text-[11px] border ${
                    lastRes.authenticated
                      ? 'bg-emerald-950/40 border-emerald-500/35 text-emerald-200'
                      : lastRes.cancelled
                        ? 'bg-[#131c27] border-[#2a475e] text-slate-300'
                        : 'bg-amber-950/40 border-amber-500/35 text-amber-200'
                  }`}
                >
                  {lastRes.error || lastRes.message}
                </div>
              )}
            </div>
          );
        };

        return (
          <div className="space-y-4">
            {pendingTargets.length > 0 && (
              <div data-testid="needs-signin-launchers-section" className="space-y-2.5">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <h3 className="inline-flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-amber-200">
                    <AlertTriangle
                      className="w-3.5 h-3.5 text-amber-400 shrink-0"
                      aria-hidden="true"
                    />
                    <span>Needs Sign-In ({pendingTargets.length})</span>
                  </h3>
                  <span className="text-[11px] text-slate-300">
                    Moves to Signed In once you sign in
                  </span>
                </div>
                {pendingTargets.map((targetId) => renderLauncherCard(targetId))}
              </div>
            )}

            {signedInTargets.length > 0 && (
              <div data-testid="signed-in-launchers-section" className="space-y-2.5">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <h3 className="inline-flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-emerald-300">
                    <CheckCircle2
                      className="w-3.5 h-3.5 text-emerald-400 shrink-0"
                      aria-hidden="true"
                    />
                    <span>Signed In ({signedInTargets.length})</span>
                  </h3>
                  <span className="text-[11px] text-slate-300">Ready to download &amp; play</span>
                </div>
                {signedInTargets.map((targetId) => renderLauncherCard(targetId))}
              </div>
            )}
          </div>
        );
      })()}
    </div>
  );
};
