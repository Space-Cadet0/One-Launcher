// @ts-check
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFile } = require('node:child_process');
const {
  isProcessAlive,
  waitForProcessExit,
  signalSubprocessTree,
} = require('../processTreeUtils.cjs');
const { buildSafeChildEnvironment } = require('../securityAndPathUtils.cjs');
const {
  isBottleWinExeRunning,
  reapOrphanedGogOverlayProcesses,
  waitForGogPostExitFlush,
} = require('../storefrontReadinessBarrier.cjs');
const {
  syncXboxCloudSaves,
  buildCloudSyncTelemetryPayload,
  resolveXboxSaveLocations,
  enqueuePendingCloudUpload,
} = require('../cloudSaveEngine.cjs');
const {
  getXboxStorefrontModules,
  diagLog,
  getOfflineVaultLifecycleHooks,
  getUserDataDir,
  isTestEnvironment,
  emitSessionUpdated,
  activeSessions,
  inFlightLaunchAbortControllers,
  inFlightPostSessionByGame,
  pendingBottleLaunches,
  inFlightPostSessionByBottle,
  downloadQueueMap,
  pausedByInGameTaskIds,
  trimLauncherEngineMemory,
  normalizeStorefrontClientLifecycle,
  resolveEffectivePerformancePolicy,
} = require('../engineStateRegistry.cjs');
const {
  resolveTargetMacAppBundlePath,
  readMacBundleIdFromInfoPlist,
  discoverSteamLocations,
  resolveWineserverBinary,
  shutdownWinePrefix,
  prepareAlignedAuxBottleWineCommand,
  disposeHostDisplayMetricsListener,
} = require('../macNativeInstallerAndCodesign.cjs');
const {
  shutdownDownloadEngine,
  resumeDownloadsPausedByInGame,
} = require('../downloadQueueCoordinator.cjs');
const {
  resolveAnyChainedHandoffId,
  liveBottleDaemonEnvContractByPrefix,
  activePostExitCloudUploadJobs,
  DISPLAY_MODE_EMULATION_RECOMMENDATION,
  deleteBottleDaemonEnvContract,
  restoreHostDisplayConfiguration,
  terminateDisplayWatcherTree,
} = require('./bottleDisplayAndEnvController.cjs');
const {
  runApprovedLaunchHookCommand,
  disposeSessionResources,
  sanitizeEaBottleAutostartFallback,
  trackPostSessionPromise,
  killPosixProcessesMatchingWinExes,
} = require('./processWatchAndElevation.cjs');
const {
  syncGogCloudSaves,
  syncEpicCloudSaves,
  waitForSteamCloudSyncCompletion,
  shutdownEphemeralStorefrontClient,
  syncSessionPlaytimeToStorefront,
} = require('./storefrontLifecycleAndCloudSync.cjs');

/**
 * Finalize an active game session, compute playtime, run ordered post-exit cloud sync + prefix shutdown, and emit stop event
 */
function finalizeGameSession(/** @type {string} */ gameId, /** @type {any} */ options = {}) {
  const entry = activeSessions.get(gameId);
  if (!entry || entry.finalized) return null;
  entry.finalized = true;

  disposeSessionResources(entry, {
    closeXboxLoopback: false,
    options: { ...(entry.launchOptions || {}), ...(options || {}) },
  });

  const normalizedGameId = String(gameId || entry.session?.gameId || '');
  const resolvedPrefix = entry.winePrefix ? path.resolve(entry.winePrefix) : '';

  /** @type {(value?: any) => void} */
  let resolveGameBarrier = () => {};
  const postSessionBarrierPromise = new Promise((resolve) => {
    resolveGameBarrier = resolve;
  });
  /** @type {(value?: any) => void} */
  let resolveBottleBarrier = () => {};
  const bottleBarrierPromise = new Promise((resolve) => {
    resolveBottleBarrier = resolve;
  });

  if (normalizedGameId) {
    inFlightPostSessionByGame.set(normalizedGameId, postSessionBarrierPromise);
  }
  if (resolvedPrefix) {
    inFlightPostSessionByBottle.set(resolvedPrefix, bottleBarrierPromise);
  }

  activeSessions.delete(gameId);

  const elapsedMs = Math.max(0, Date.now() - (entry.startedMs || Date.now()));
  const durationSeconds = Math.max(1, Math.round(elapsedMs / 1000));
  const exitedAbnormally =
    !entry.stoppedByUser &&
    entry.exitCode !== null &&
    entry.exitCode !== undefined &&
    entry.exitCode !== 0;
  const crashedEarly = exitedAbnormally && elapsedMs < 30000;
  const displayModeErrorDetected = Boolean(
    !entry.stoppedByUser &&
      Number(entry.displayModeChangedErrorCount || 0) >= 2 &&
      (exitedAbnormally || elapsedMs < 45000)
  );
  const displayModeRecommendation = displayModeErrorDetected
    ? DISPLAY_MODE_EMULATION_RECOMMENDATION
    : undefined;

  let sessionMinutesPlayed;
  let crashError;
  if (crashedEarly) {
    sessionMinutesPlayed = 0;
    crashError =
      (entry.stderrBuffer || '')
        .trim()
        .split(/\r?\n/)
        .filter(Boolean)
        .slice(-3)
        .join(' | ')
        .slice(0, 300) || `Process exited with code ${entry.exitCode}`;
  } else {
    sessionMinutesPlayed = Math.max(1, Math.round(elapsedMs / 60000));
  }

  const lastPlayed = new Date().toISOString();

  const mergedOptions = {
    ...(entry.launchOptions || {}),
    ...(options || {}),
  };

  // SUP-05: Restore permanent host display mode & ColorSync gamma on abnormal exit / fatal signal
  if (!entry.stoppedByUser && (exitedAbnormally || Boolean(entry.exitSignal))) {
    restoreHostDisplayConfiguration(
      {
        gameId: normalizedGameId || entry.session?.gameId || '',
        exitCode: entry.exitCode,
        exitSignal: entry.exitSignal || null,
      },
      mergedOptions
    );
  }

  // SUP-01: Gate postExitCommand execution strictly on `isLaunchCommandApproved`
  if (entry.postExitCommand) {
    const safePostExitEnv = buildSafeChildEnvironment(
      process.env,
      entry.launchConfig?.environmentVariables,
      {},
      {
        gameId: entry.gameId || entry.session?.gameId || '',
        options: mergedOptions,
      }
    );
    void runApprovedLaunchHookCommand('postExitCommand', entry.postExitCommand, {
      gameId: entry.gameId || entry.session?.gameId || '',
      env: safePostExitEnv,
      cwd: entry.installPath || process.cwd(),
      launchConfig: entry.launchConfig || {},
      options: mergedOptions,
      logTag: 'finalizeGameSession.postExitCommand',
    }).catch(() => {});
  }
  const effectivePerfPolicy = resolveEffectivePerformancePolicy(
    entry.launchConfig || {},
    mergedOptions
  );

  const stoppedSession = {
    ...entry.session,
    status: 'stopping',
    ...(displayModeErrorDetected
      ? {
          displayModeErrorDetected: true,
          recommendation: displayModeRecommendation,
        }
      : {}),
  };

  if (displayModeErrorDetected) {
    diagLog.warn('finalizeGameSession.displayModeErrorDetected', {
      gameId: normalizedGameId || stoppedSession.gameId,
      platformId: stoppedSession.platformId,
      displayModeChangedErrorCount: Number(entry.displayModeChangedErrorCount || 0),
      exitCode: entry.exitCode,
      elapsedMs,
      recommendation: displayModeRecommendation,
    });
  }

  const willRunPostExitCloudSync = Boolean(
    !crashedEarly &&
      ((stoppedSession.platformId === 'epic' && entry.session?.launchMethod !== 'storefront_uri') ||
        (stoppedSession.platformId === 'gog' && entry.session?.launchMethod !== 'storefront_uri') ||
        (stoppedSession.platformId === 'xbox' &&
          entry.session?.launchMethod !== 'storefront_uri' &&
          !entry.isChainedPublisherLauncher) ||
        Boolean(entry.xboxLoopbackServer) ||
        (entry.bottleSteamRoot && (entry.steamAppId || entry.platformGameId)))
  );

  if (!willRunPostExitCloudSync && activeSessions.size === 0) {
    try {
      resumeDownloadsPausedByInGame(mergedOptions);
    } catch {}
  }

  emitSessionUpdated(
    {
      session: stoppedSession,
      event: 'stopped',
      sessionMinutesPlayed,
      durationSeconds,
      lastPlayed,
      ...(crashedEarly ? { error: crashError } : {}),
      ...(displayModeErrorDetected
        ? {
            displayModeErrorDetected: true,
            recommendation: displayModeRecommendation,
          }
        : {}),
    },
    mergedOptions
  );

  const emitCloudSyncTelemetry = (/** @type {string} */ direction, /** @type {any} */ syncResult) => {
    try {
      const telemetry = buildCloudSyncTelemetryPayload({
        gameId: stoppedSession.gameId,
        platformId: stoppedSession.platformId,
        direction,
        syncResult,
        isSteam: stoppedSession.platformId === 'steam',
      });
      if (telemetry) {
        emitSessionUpdated({ ...telemetry, session: stoppedSession }, mergedOptions);
      }
    } catch {}
  };

  const hasActiveOrPausedBottleDownload = () => {
    if (!resolvedPrefix) return false;
    const prefixWithSep = resolvedPrefix.endsWith(path.sep)
      ? resolvedPrefix
      : resolvedPrefix + path.sep;
    const hasBottleSteam = Boolean(
      entry.bottleSteamRoot ||
        fs.existsSync(path.join(resolvedPrefix, 'drive_c', 'Program Files (x86)', 'Steam', 'steam.exe')) ||
        fs.existsSync(path.join(resolvedPrefix, 'drive_c', 'Program Files', 'Steam', 'steam.exe'))
    );
    return Array.from(downloadQueueMap.values()).some((t) => {
      if (!t) return false;
      const isActiveOrInGamePaused =
        ['downloading', 'queued', 'extracting', 'verifying'].includes(t.status) ||
        pausedByInGameTaskIds.has(t.taskId);
      if (!isActiveOrInGamePaused) return false;
      const rawDir =
        typeof t.installDir === 'string' && t.installDir.trim() ? path.resolve(t.installDir) : '';
      if (rawDir && (rawDir === resolvedPrefix || rawDir.startsWith(prefixWithSep))) {
        return true;
      }
      if (hasBottleSteam && String(t.platformId || '').toLowerCase() === 'steam') {
        return true;
      }
      return false;
    });
  };

  const isPrefixBusyWithOtherSession = () =>
    Boolean(resolvedPrefix) &&
    ((pendingBottleLaunches.get(resolvedPrefix) || 0) > 0 ||
      hasActiveOrPausedBottleDownload() ||
      Array.from(activeSessions.values()).some(
        (other) =>
          other !== entry &&
          !other.finalized &&
          other.winePrefix &&
          path.resolve(other.winePrefix) === resolvedPrefix
      ));

  const shouldQueueFailedPostExitUpload = (/** @type {any} */ res) => {
    if (!res || res.synced === true) return false;
    const reason = String(res.reason || '').toLowerCase();
    if (
      !reason ||
      reason === 'skipped_in_test' ||
      reason === 'no_cloud_saves_configured' ||
      reason === 'no_cloud_save_folder_or_skipped' ||
      reason === 'nothing_to_sync' ||
      reason === 'title_storage_not_provisioned' ||
      reason === 'missing_client_id' ||
      reason === 'missing_app_name' ||
      reason === 'missing_game_id' ||
      reason === 'missing_scid_or_pfn' ||
      reason === 'no_resolvable_save_locations' ||
      reason === 'broad_known_folder_root_blocked' ||
      reason === 'unsafe_cloud_save_path_rejected'
    ) {
      return false;
    }
    return true;
  };

  // 1. Run post-exit Cloud Save uploads & Bottle Steam cloud_log barrier FIRST (before wineserver -k!)
  /** @type {Promise<any>} */
  let epicCloudSaveSyncPromise = Promise.resolve({ synced: false });
  if (
    !crashedEarly &&
    stoppedSession.platformId === 'epic' &&
    entry.session?.launchMethod !== 'storefront_uri'
  ) {
    const epicUploadJob = {
      record: {
        gameId: stoppedSession.gameId,
        platformId: 'epic',
        platformGameId: entry.platformGameId || stoppedSession.platformGameId,
        title: stoppedSession.title,
        lastSyncedAt: Number(entry.lastPreLaunchCloudSyncAt || 0) || 0,
        installPath: entry.installPath,
        winePrefix: entry.winePrefix,
        useCompatLayer: Boolean(entry.winePrefix),
        savePaths: [],
      },
      options: mergedOptions,
    };
    activePostExitCloudUploadJobs.add(epicUploadJob);
    epicCloudSaveSyncPromise = trackPostSessionPromise(
      syncEpicCloudSaves(
        {
          platformId: 'epic',
          platformGameId: entry.platformGameId || stoppedSession.platformGameId,
          gameId: stoppedSession.gameId,
          title: stoppedSession.title,
          installPath: entry.installPath,
        },
        'post_exit',
        {
          ...mergedOptions,
          useCompatLayer: Boolean(entry.winePrefix),
          winePrefix: entry.winePrefix,
          installPath: entry.installPath,
        }
      )
        .then(async (/** @type {any} */ res) => {
          if (res?.resolvedSavePath) {
            epicUploadJob.record.savePaths = [String(res.resolvedSavePath)];
          }
          if (shouldQueueFailedPostExitUpload(res)) {
            await enqueuePendingCloudUpload(epicUploadJob.record, mergedOptions).catch(() => {});
          }
          emitCloudSyncTelemetry('post_exit', res);
          return res;
        })
        .catch(async (/** @type {any} */ err) => {
          const failRes = {
            synced: false,
            reason: err && err.message ? err.message : 'sync_failed',
          };
          await enqueuePendingCloudUpload(epicUploadJob.record, mergedOptions).catch(() => {});
          emitCloudSyncTelemetry('post_exit', failRes);
          return failRes;
        })
        .finally(() => {
          activePostExitCloudUploadJobs.delete(epicUploadJob);
        })
    );
  }

  /** @type {Promise<any>} */
  let gogCloudSaveSyncPromise = Promise.resolve({ synced: false });
  if (
    !crashedEarly &&
    stoppedSession.platformId === 'gog' &&
    entry.session?.launchMethod !== 'storefront_uri'
  ) {
    const gogUploadJob = {
      record: {
        gameId: stoppedSession.gameId,
        platformId: 'gog',
        platformGameId: entry.platformGameId || stoppedSession.platformGameId,
        title: stoppedSession.title,
        lastSyncedAt: Number(entry.lastPreLaunchCloudSyncAt || 0) || 0,
        installPath: entry.installPath,
        winePrefix: entry.winePrefix,
        useCompatLayer: Boolean(entry.winePrefix),
        savePaths: [],
      },
      options: mergedOptions,
    };
    activePostExitCloudUploadJobs.add(gogUploadJob);
    gogCloudSaveSyncPromise = trackPostSessionPromise(
      syncGogCloudSaves(
        {
          platformId: 'gog',
          platformGameId: entry.platformGameId || stoppedSession.platformGameId,
          gameId: stoppedSession.gameId,
          title: stoppedSession.title,
          installPath: entry.installPath,
        },
        'post_exit',
        {
          ...mergedOptions,
          useCompatLayer: Boolean(entry.winePrefix),
          winePrefix: entry.winePrefix,
          installPath: entry.installPath,
        }
      )
        .then(async (/** @type {any} */ res) => {
          if (Array.isArray(res?.locations)) {
            gogUploadJob.record.savePaths = res.locations
              .map((l) => l?.resolvedPath)
              .filter(Boolean);
          }
          if (res?.clientId) {
            gogUploadJob.record.gogClientId = res.clientId;
          }
          if (shouldQueueFailedPostExitUpload(res)) {
            await enqueuePendingCloudUpload(gogUploadJob.record, mergedOptions).catch(() => {});
          }
          emitCloudSyncTelemetry('post_exit', res);
          return res;
        })
        .catch(async (/** @type {any} */ err) => {
          const failRes = {
            synced: false,
            reason: err && err.message ? err.message : 'sync_failed',
          };
          await enqueuePendingCloudUpload(gogUploadJob.record, mergedOptions).catch(() => {});
          emitCloudSyncTelemetry('post_exit', failRes);
          return failRes;
        })
        .finally(() => {
          activePostExitCloudUploadJobs.delete(gogUploadJob);
        })
    );
  }

  /** @type {Promise<any>} */
  let xboxCloudSaveSyncPromise = Promise.resolve({ synced: false });
  if (
    (stoppedSession.platformId === 'xbox' && !entry.isChainedPublisherLauncher) ||
    entry.xboxLoopbackServer
  ) {
    const xboxResolvedLocs = (() => {
      try {
        return resolveXboxSaveLocations(
          {
            packageFamilyName: entry.packageFamilyName,
            scid: entry.scid,
            fallbackScid: entry.fallbackScid,
            msaAppId: entry.msaAppId,
            xboxTitleId: entry.xboxTitleId,
            installPath: entry.installPath,
          },
          {
            ...mergedOptions,
            useCompatLayer: Boolean(entry.winePrefix),
            winePrefix: entry.winePrefix,
          }
        );
      } catch {
        return null;
      }
    })();
    const xboxUploadJob = {
      record: {
        gameId: stoppedSession.gameId,
        platformId: 'xbox',
        platformGameId: entry.platformGameId || stoppedSession.platformGameId,
        title: stoppedSession.title,
        lastSyncedAt: Number(entry.lastPreLaunchCloudSyncAt || 0) || 0,
        installPath: entry.installPath,
        winePrefix: entry.winePrefix,
        useCompatLayer: Boolean(entry.winePrefix),
        packageFamilyName: entry.packageFamilyName,
        scid: entry.scid,
        fallbackScid: entry.fallbackScid,
        msaAppId: entry.msaAppId,
        xboxTitleId: entry.xboxTitleId,
        xboxProductId: entry.xboxProductId,
        appUserModelId: entry.appUserModelId,
        savePaths: [xboxResolvedLocs?.wgsUserDir, xboxResolvedLocs?.wgsRootDir].filter(Boolean),
      },
      options: mergedOptions,
    };
    activePostExitCloudUploadJobs.add(xboxUploadJob);
    xboxCloudSaveSyncPromise = trackPostSessionPromise(
      (async () => {
        try {
          if (
            !crashedEarly &&
            entry.xboxLoopbackServer &&
            typeof entry.xboxLoopbackServer.flushPendingSaves === 'function'
          ) {
            await entry.xboxLoopbackServer.flushPendingSaves().catch(() => null);
          }

          if (
            !crashedEarly &&
            stoppedSession.platformId === 'xbox' &&
            entry.session?.launchMethod !== 'storefront_uri'
          ) {
            const rawRuntimeScids =
              entry.xboxLoopbackServer &&
              typeof entry.xboxLoopbackServer.getActiveScids === 'function'
                ? entry.xboxLoopbackServer.getActiveScids()
                : [];
            /** @type {string[]} */
            const dedupedRuntimeScids = [];
            const seenScidLower = new Set();
            if (Array.isArray(rawRuntimeScids)) {
              for (const rawScid of rawRuntimeScids) {
                const trimmedScid = String(rawScid || '').trim();
                const lowerScid = trimmedScid.toLowerCase();
                if (trimmedScid && !seenScidLower.has(lowerScid)) {
                  seenScidLower.add(lowerScid);
                  dedupedRuntimeScids.push(trimmedScid);
                }
              }
            }
            const scidsToSync =
              dedupedRuntimeScids.length > 0 ? dedupedRuntimeScids : [entry.scid];
            /** @type {any} */
            let lastRes = { synced: false, reason: 'skipped' };
            for (const activeScid of scidsToSync) {
              const effectiveFallbackScid =
                entry.fallbackScid ||
                (entry.scid &&
                activeScid &&
                String(entry.scid).toLowerCase() !== String(activeScid).toLowerCase()
                  ? entry.scid
                  : undefined);
              const res = await syncXboxCloudSaves(
                {
                  platformId: 'xbox',
                  platformGameId: entry.platformGameId || stoppedSession.platformGameId,
                  gameId: stoppedSession.gameId,
                  title: stoppedSession.title,
                  installPath: entry.installPath,
                  packageFamilyName: entry.packageFamilyName,
                  scid: activeScid,
                  fallbackScid: effectiveFallbackScid,
                  msaAppId: entry.msaAppId,
                  xboxTitleId: entry.xboxTitleId,
                  xboxProductId: entry.xboxProductId,
                  appUserModelId: entry.appUserModelId,
                },
                'post_exit',
                {
                  ...mergedOptions,
                  useCompatLayer: Boolean(entry.winePrefix),
                  winePrefix: entry.winePrefix,
                  installPath: entry.installPath,
                  isAppxRegistered: Boolean(entry.isAppxRegistered),
                  useGamingServicesRuntime: Boolean(entry.isAppxRegistered),
                  userDataDir: getUserDataDir(mergedOptions.userDataDir),
                }
              );
              if (shouldQueueFailedPostExitUpload(res)) {
                await enqueuePendingCloudUpload(
                  { ...xboxUploadJob.record, ...(activeScid ? { scid: activeScid } : {}) },
                  mergedOptions
                ).catch(() => {});
              }
              emitCloudSyncTelemetry('post_exit', res);
              lastRes = res;
            }
            return lastRes;
          }
          return { synced: false, reason: 'skipped' };
        } catch (/** @type {any} */ err) {
          const failRes = {
            synced: false,
            provider: 'xbox_connected_storage',
            reason: err && err.message ? err.message : 'sync_failed',
          };
          await enqueuePendingCloudUpload(xboxUploadJob.record, mergedOptions).catch(() => {});
          emitCloudSyncTelemetry('post_exit', failRes);
          return failRes;
        } finally {
          activePostExitCloudUploadJobs.delete(xboxUploadJob);
          if (entry.xboxLoopbackServer && typeof entry.xboxLoopbackServer.close === 'function') {
            try {
              await entry.xboxLoopbackServer.close();
            } catch {}
            entry.xboxLoopbackServer = null;
          }
        }
      })()
    );
  } else if (entry.xboxLoopbackServer && typeof entry.xboxLoopbackServer.close === 'function') {
    // SUP-03: Ensure Xbox loopback server closes even on early crash or non-Xbox sync bypass
    const srvToClose = entry.xboxLoopbackServer;
    entry.xboxLoopbackServer = null;
    xboxCloudSaveSyncPromise = trackPostSessionPromise(
      Promise.resolve()
        .then(() => srvToClose.close())
        .catch(() => {})
        .then(() => ({ synced: false, reason: 'closed_after_skip' }))
    );
  }

  const lifecyclePolicy =
    normalizeStorefrontClientLifecycle(entry.effectiveStorefrontLifecycle) ||
    effectivePerfPolicy.storefrontClientLifecycle;

  /** @type {Promise<any>} */
  let bottleSteamPostExitPromise = Promise.resolve({ completed: false });
  if (entry.bottleSteamRoot && (entry.steamAppId || entry.platformGameId)) {
    const cleanBottleAppId = String(entry.steamAppId || entry.platformGameId || '')
      .replace(/^steam[-_]/i, '')
      .trim();
    bottleSteamPostExitPromise = trackPostSessionPromise(
      (async () => {
        const cloudRes = await waitForSteamCloudSyncCompletion(
          entry.bottleSteamRoot,
          cleanBottleAppId,
          {
            ...mergedOptions,
            mode: 'post_exit',
            ignoreStaleLogAge: true,
          }
        );
        emitCloudSyncTelemetry('post_exit', cloudRes);
        let closedBottleSteam = false;
        if (
          entry.wokeBottleSteamByLauncher &&
          lifecyclePolicy === 'minimal_and_close_if_started' &&
          entry.wineBinary &&
          entry.bottleSteamExe &&
          !isPrefixBusyWithOtherSession()
        ) {
          const execFileImpl =
            typeof mergedOptions.execFileImpl === 'function'
              ? mergedOptions.execFileImpl
              : typeof mergedOptions.execFileFn === 'function'
                ? mergedOptions.execFileFn
                : execFile;
          await new Promise((resolve) => {
            try {
              const shutdownEnv = {
                ...(entry.launchEnv || process.env),
                ...(entry.winePrefix ? { WINEPREFIX: entry.winePrefix } : {}),
              };
              const alignedSteamShutdown = prepareAlignedAuxBottleWineCommand({
                wineBinary: entry.wineBinary,
                bottlePath: entry.winePrefix,
                env: shutdownEnv,
              });
              deleteBottleDaemonEnvContract(entry.winePrefix);
              execFileImpl(
                alignedSteamShutdown.binaryPath,
                [entry.bottleSteamExe, '-shutdown'],
                {
                  env: alignedSteamShutdown.env,
                  timeout: 5000,
                },
                () => resolve(undefined)
              );
              closedBottleSteam = true;
            } catch {
              resolve(undefined);
            }
          });
        }
        return { completed: true, cloudRes, closedBottleSteam };
      })().catch(() => ({ completed: false }))
    );
  }

  /** @type {Promise<any>} */
  let bottleGogPostExitPromise = Promise.resolve({ completed: false, closedBottleGog: false });
  if (
    entry.wokeBottleGogByLauncher &&
    lifecyclePolicy === 'minimal_and_close_if_started' &&
    entry.wineBinary &&
    entry.bottleGogExe
  ) {
    bottleGogPostExitPromise = trackPostSessionPromise(
      Promise.allSettled([gogCloudSaveSyncPromise])
        .then(async () => {
          if (isPrefixBusyWithOtherSession()) {
            return { completed: false, closedBottleGog: false };
          }
          await waitForGogPostExitFlush({
            platform: 'win32',
            bottlePath: entry.winePrefix,
            ...(typeof entry.gogCommLogPreExitOffset === 'number'
              ? { preExitOffset: entry.gogCommLogPreExitOffset }
              : {}),
            options: mergedOptions,
          });
          const execFileImpl =
            typeof mergedOptions.execFileImpl === 'function'
              ? mergedOptions.execFileImpl
              : typeof mergedOptions.execFileFn === 'function'
                ? mergedOptions.execFileFn
                : execFile;
          await new Promise((resolve) => {
            try {
              const shutdownEnv = {
                ...(entry.launchEnv || process.env),
                ...(entry.winePrefix ? { WINEPREFIX: entry.winePrefix } : {}),
              };
              const alignedGogShutdown = prepareAlignedAuxBottleWineCommand({
                wineBinary: entry.wineBinary,
                bottlePath: entry.winePrefix,
                env: shutdownEnv,
              });
              execFileImpl(
                alignedGogShutdown.binaryPath,
                [entry.bottleGogExe, '/command=shutdown'],
                {
                  env: alignedGogShutdown.env,
                  timeout: 12000,
                },
                () => resolve(undefined)
              );
            } catch {
              resolve(undefined);
            }
          });
          await reapOrphanedGogOverlayProcesses(mergedOptions);
          return { completed: true, closedBottleGog: true };
        })
        .catch(() => ({ completed: false, closedBottleGog: false }))
    );
  }

  /** @type {Promise<any>} */
  let bottleEpicPostExitPromise = Promise.resolve({ completed: false, closedBottleEpic: false });
  if (
    entry.wokeBottleEpicByLauncher &&
    lifecyclePolicy === 'minimal_and_close_if_started' &&
    entry.wineBinary &&
    entry.bottleEpicExe
  ) {
    bottleEpicPostExitPromise = trackPostSessionPromise(
      Promise.allSettled([epicCloudSaveSyncPromise])
        .then(async () => {
          if (isPrefixBusyWithOtherSession()) {
            return { completed: false, closedBottleEpic: false };
          }
          const execFileImpl =
            typeof mergedOptions.execFileImpl === 'function'
              ? mergedOptions.execFileImpl
              : typeof mergedOptions.execFileFn === 'function'
                ? mergedOptions.execFileFn
                : execFile;
          const runBottleTaskkill = (/** @type {string[]} */ args) =>
            new Promise((resolve) => {
              try {
                const shutdownEnv = {
                  ...(entry.launchEnv || process.env),
                  ...(entry.winePrefix ? { WINEPREFIX: entry.winePrefix } : {}),
                };
                const alignedEpicShutdown = prepareAlignedAuxBottleWineCommand({
                  wineBinary: entry.wineBinary,
                  bottlePath: entry.winePrefix,
                  env: shutdownEnv,
                });
                execFileImpl(
                  alignedEpicShutdown.binaryPath,
                  args,
                  {
                    env: alignedEpicShutdown.env,
                    timeout: 6000,
                  },
                  () => resolve(undefined)
                );
              } catch {
                resolve(undefined);
              }
            });
          await runBottleTaskkill(['taskkill', '/IM', 'EpicGamesLauncher.exe']);
          if (
            (!isTestEnvironment(mergedOptions) ||
              mergedOptions.enableStorefrontReadinessBarrier === true) &&
            entry.winePrefix
          ) {
            await new Promise((r) => {
              const t = setTimeout(r, 3500);
              if (typeof t.unref === 'function') t.unref();
            });
            if (
              await isBottleWinExeRunning('EpicGamesLauncher.exe', entry.winePrefix, mergedOptions)
            ) {
              await runBottleTaskkill(['taskkill', '/F', '/IM', 'EpicGamesLauncher.exe']);
            }
          }
          return { completed: true, closedBottleEpic: true };
        })
        .catch(() => ({ completed: false, closedBottleEpic: false }))
    );
  }

  /** @type {Promise<any>} */
  let hostSteamCloudSyncPromise = Promise.resolve({ completed: true, reason: 'no_active_cloud_job' });
  const willEphemeralShutdownHandleHostSteamCloud = Boolean(
    entry.wokeSteamByLauncher && lifecyclePolicy === 'minimal_and_close_if_started'
  );
  if (
    !crashedEarly &&
    stoppedSession.platformId === 'steam' &&
    !entry.bottleSteamRoot &&
    !willEphemeralShutdownHandleHostSteamCloud &&
    (entry.steamAppId || entry.platformGameId)
  ) {
    const cleanHostAppId = String(entry.steamAppId || entry.platformGameId || '')
      .replace(/^steam[-_]/i, '')
      .trim();
    const targetPlatform = mergedOptions.platform || process.platform;
    const candidateHostSteamRoot =
      mergedOptions.steamRoot ||
      entry.steamRoot ||
      (entry.steamClientBinaryPath && targetPlatform === 'win32'
        ? path.dirname(entry.steamClientBinaryPath)
        : targetPlatform === 'darwin' && (mergedOptions.homedir || !isTestEnvironment(mergedOptions))
          ? path.join(
              mergedOptions.homedir || os.homedir(),
              'Library',
              'Application Support',
              'Steam'
            )
          : '');
    if (cleanHostAppId && (candidateHostSteamRoot || targetPlatform === 'darwin')) {
      hostSteamCloudSyncPromise = trackPostSessionPromise(
        waitForSteamCloudSyncCompletion(candidateHostSteamRoot || '', cleanHostAppId, {
          ...mergedOptions,
          mode: 'post_exit',
          ignoreStaleLogAge: true,
        })
          .then((/** @type {any} */ res) => {
            emitCloudSyncTelemetry('post_exit', res);
            return res;
          })
          .catch(() => ({ completed: false }))
      );
    }
  }

  // 2. Chain Wine prefix shutdown strictly AFTER post-exit cloud sync & bottle storefront shutdown finish
  const entryPublisherHandoff = resolveAnyChainedHandoffId(entry.chainedLauncherHandoff);
  const hasActiveBottleStorefrontClient = Boolean(
    entry.launchedViaBottleSteam ||
      entry.wokeBottleGogByLauncher ||
      entry.wasBottleGogRunning ||
      entry.wokeBottleEpicByLauncher ||
      entry.wasBottleEpicRunning ||
      entry.isChainedPublisherLauncher
  );
  const shouldPreserveBottleStorefrontClient =
    hasActiveBottleStorefrontClient &&
    (lifecyclePolicy === 'minimal_keep_running' ||
      lifecyclePolicy === 'default_client' ||
      (lifecyclePolicy === 'minimal_and_close_if_started' &&
        ((entry.launchedViaBottleSteam && !entry.wokeBottleSteamByLauncher) ||
          (entry.wasBottleGogRunning && !entry.wokeBottleGogByLauncher) ||
          (entry.wasBottleEpicRunning && !entry.wokeBottleEpicByLauncher) ||
          (entry.isChainedPublisherLauncher &&
            entry.wasBottlePublisherRunning &&
            !entry.wokePublisherClientByLauncher))));

  /** @type {Promise<any>} */
  let bottlePublisherPostExitPromise = Promise.resolve({
    completed: false,
    closedBottlePublisher: false,
  });
  if (
    entryPublisherHandoff === 'ea' &&
    entry.wokePublisherClientByLauncher &&
    lifecyclePolicy === 'minimal_and_close_if_started' &&
    entry.wineBinary &&
    entry.winePrefix &&
    (shouldPreserveBottleStorefrontClient ||
      effectivePerfPolicy.autoShutdownWinePrefixOnExit === false)
  ) {
    bottlePublisherPostExitPromise = trackPostSessionPromise(
      Promise.allSettled([epicCloudSaveSyncPromise, bottleSteamPostExitPromise])
        .then(async () => {
          if (isPrefixBusyWithOtherSession()) {
            return { completed: false, closedBottlePublisher: false };
          }
          const execFileImpl =
            typeof mergedOptions.execFileImpl === 'function'
              ? mergedOptions.execFileImpl
              : typeof mergedOptions.execFileFn === 'function'
                ? mergedOptions.execFileFn
                : execFile;
          const runBottleCmd = (/** @type {string[]} */ cmdArgs) =>
            new Promise((resolve) => {
              try {
                const shutdownEnv = {
                  ...(entry.launchEnv || process.env),
                  ...(entry.winePrefix ? { WINEPREFIX: entry.winePrefix } : {}),
                };
                const alignedPubShutdown = prepareAlignedAuxBottleWineCommand({
                  wineBinary: entry.wineBinary,
                  bottlePath: entry.winePrefix,
                  env: shutdownEnv,
                  suppressGuiDialogs: true,
                });
                execFileImpl(
                  alignedPubShutdown.binaryPath,
                  cmdArgs,
                  { env: alignedPubShutdown.env, timeout: 6000 },
                  () => resolve(undefined)
                );
              } catch {
                resolve(undefined);
              }
            });
          await runBottleCmd([
            'reg',
            'delete',
            'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run',
            '/v',
            'EADM',
            '/f',
          ]);
          await runBottleCmd([
            'taskkill',
            '/F',
            '/IM',
            'EADesktop.exe',
            '/IM',
            'EALauncher.exe',
            '/IM',
            'EACefSubProcess.exe',
            '/IM',
            'EALocalHostSvc.exe',
            '/IM',
            'Link2EA.exe',
            '/IM',
            'EABackgroundService.exe',
          ]);
          return { completed: true, closedBottlePublisher: true };
        })
        .catch(() => ({ completed: false, closedBottlePublisher: false }))
    );
  }

  /** @type {Promise<any>} */
  let winePrefixShutdownPromise = Promise.resolve(false);
  if (
    (!entry.stopping ||
      entry.deferredPrefixShutdownToFinalize ||
      entry.launchedViaBottleSteam ||
      entry.wokeBottleGogByLauncher ||
      entry.wokeBottleEpicByLauncher ||
      entry.isChainedPublisherLauncher) &&
    !entry.wineShutdownHandledByStopGame &&
    !shouldPreserveBottleStorefrontClient &&
    entry.winePrefix &&
    (entry.wineserverBinary || entry.wineBinary) &&
    effectivePerfPolicy.autoShutdownWinePrefixOnExit !== false
  ) {
    winePrefixShutdownPromise = trackPostSessionPromise(
      Promise.allSettled([
        epicCloudSaveSyncPromise,
        gogCloudSaveSyncPromise,
        xboxCloudSaveSyncPromise,
        bottleSteamPostExitPromise,
        bottleGogPostExitPromise,
        bottleEpicPostExitPromise,
        bottlePublisherPostExitPromise,
      ])
        .then(async () => {
          if (
            entry.isChainedPublisherLauncher &&
            !isTestEnvironment(mergedOptions) &&
            !entry.stopping
          ) {
            await new Promise((r) => {
              const t = setTimeout(r, 3000);
              if (typeof t.unref === 'function') t.unref();
            });
          }
          if (isPrefixBusyWithOtherSession()) return false;
          deleteBottleDaemonEnvContract(entry.winePrefix);
          return shutdownWinePrefix(
            entry.wineserverBinary || entry.wineBinary,
            entry.winePrefix,
            3000
          ).then((res) => {
            if (typeof mergedOptions.onWinePrefixShutdown === 'function') {
              try {
                mergedOptions.onWinePrefixShutdown(entry.winePrefix, res);
              } catch {}
            }
            return res;
          });
        })
        .catch(() => false)
    );
  }

  Promise.allSettled([
    epicCloudSaveSyncPromise,
    gogCloudSaveSyncPromise,
    xboxCloudSaveSyncPromise,
    bottleSteamPostExitPromise,
    bottleGogPostExitPromise,
    bottleEpicPostExitPromise,
    bottlePublisherPostExitPromise,
    winePrefixShutdownPromise,
  ]).finally(() => {
    if (entryPublisherHandoff === 'ea' && entry.winePrefix) {
      sanitizeEaBottleAutostartFallback(entry.winePrefix, mergedOptions);
    }
    if (resolvedPrefix && inFlightPostSessionByBottle.get(resolvedPrefix) === bottleBarrierPromise) {
      inFlightPostSessionByBottle.delete(resolvedPrefix);
    }
    resolveBottleBarrier();
  });

  // 3. Sync playtime to storefront (skip GOG when launched via storefront_uri to avoid Galaxy double-count)
  /** @type {Promise<any>} */
  let storefrontSyncPromise = Promise.resolve(null);
  const skipGogStorefrontPlaytimeSync =
    stoppedSession.platformId === 'gog' && entry.session?.launchMethod === 'storefront_uri';
  if (
    !crashedEarly &&
    !skipGogStorefrontPlaytimeSync &&
    sessionMinutesPlayed > 0 &&
    stoppedSession.platformId &&
    ['epic', 'gog', 'steam', 'xbox'].includes(stoppedSession.platformId)
  ) {
    storefrontSyncPromise = trackPostSessionPromise(
      syncSessionPlaytimeToStorefront(
        {
          platformId: stoppedSession.platformId,
          platformGameId: entry.platformGameId || stoppedSession.platformGameId,
          gameId: stoppedSession.gameId,
          title: stoppedSession.title,
          installPath: entry.installPath,
          executablePath: stoppedSession.executablePath,
          xboxTitleId: entry.xboxTitleId,
          packageFamilyName: entry.packageFamilyName,
          startedAt:
            stoppedSession.startedAt || new Date(entry.startedMs || Date.now()).toISOString(),
          endedAt: lastPlayed,
          durationSeconds,
          sessionMinutesPlayed,
        },
        mergedOptions
      )
        .then((syncRes) => {
          if (
            syncRes &&
            typeof syncRes.storefrontTotalPlaytimeMinutes === 'number' &&
            syncRes.storefrontTotalPlaytimeMinutes > 0
          ) {
            emitSessionUpdated(
              {
                session: stoppedSession,
                event: 'playtime_synced',
                sessionMinutesPlayed,
                durationSeconds,
                lastPlayed,
                storefrontTotalPlaytimeMinutes: syncRes.storefrontTotalPlaytimeMinutes,
              },
              mergedOptions
            );
          }
          return syncRes;
        })
        .catch(() => null)
    );
  }

  // 4. Trigger ephemeral storefront client shutdown after playtime & cloud sync finish
  /** @type {Promise<any>} */
  let ephemeralClientShutdownPromise = Promise.resolve({ closed: false });
  if (
    entry.wokeGogGalaxyByLauncher ||
    entry.wokeSteamByLauncher ||
    entry.wokeEpicByLauncher ||
    entry.wokeXboxAppByLauncher ||
    entry.wokePublisherClientByLauncher ||
    entry.ephemeralClientWoken
  ) {
    ephemeralClientShutdownPromise = trackPostSessionPromise(
      Promise.allSettled([
        gogCloudSaveSyncPromise,
        epicCloudSaveSyncPromise,
        xboxCloudSaveSyncPromise,
      ]).then(() =>
        shutdownEphemeralStorefrontClient(entry, mergedOptions)
          .then((res) => {
            if (res && 'cloudSyncWait' in res && res.cloudSyncWait) {
              emitCloudSyncTelemetry('post_exit', res.cloudSyncWait);
            }
            return res;
          })
          .catch(() => ({ closed: false }))
      )
    );
    storefrontSyncPromise = trackPostSessionPromise(
      storefrontSyncPromise.finally(() => ephemeralClientShutdownPromise)
    );
  }

  Promise.allSettled([
    epicCloudSaveSyncPromise,
    gogCloudSaveSyncPromise,
    xboxCloudSaveSyncPromise,
    bottleSteamPostExitPromise,
    bottleGogPostExitPromise,
    bottleEpicPostExitPromise,
    bottlePublisherPostExitPromise,
    hostSteamCloudSyncPromise,
    winePrefixShutdownPromise,
    ephemeralClientShutdownPromise,
  ]).finally(() => {
    if (
      normalizedGameId &&
      inFlightPostSessionByGame.get(normalizedGameId) === postSessionBarrierPromise
    ) {
      inFlightPostSessionByGame.delete(normalizedGameId);
    }
    resolveGameBarrier();
    if (activeSessions.size === 0) {
      try {
        resumeDownloadsPausedByInGame(mergedOptions);
      } catch {}
    }
  });

  return {
    session: stoppedSession,
    sessionMinutesPlayed,
    durationSeconds,
    lastPlayed,
    postSessionBarrierPromise,
    storefrontSyncPromise,
    winePrefixShutdownPromise,
    ephemeralClientShutdownPromise,
    epicCloudSaveSyncPromise,
    gogCloudSaveSyncPromise,
    bottleSteamPostExitPromise,
    bottleGogPostExitPromise,
    bottleEpicPostExitPromise,
    ...(crashedEarly ? { error: crashError } : {}),
    ...(displayModeErrorDetected
      ? {
          displayModeErrorDetected: true,
          recommendation: displayModeRecommendation,
        }
      : {}),
  };
}

/**
 * Launch and supervise a game delegated through a chained publisher launcher
 * (`ubisoft`, `ea`, `bnet`, `rockstar`, `riot`) inside a macOS Wine/CrossOver bottle (`darwin`)
 * or natively on Windows (`win32`) / macOS native `.app` (`bnet`/`riot`), never executing
 * `GDKStubGame.exe` directly.
 *
 * @param {{
 *   gameId: string,
 *   normPlatformId: string,
 *   chainedHandoffId: string,
 *   payload: any,
 *   options: any,
 *   platform: string,
 *   launchConfig: any,
 *   effectivePerfPolicy: any,
 *   localInstallDir: string,
 *   isInstallInsideBottle: boolean,
 *   isWindowsBinaryOnMac: boolean,
 *   hasGdkStubIndicator: boolean,
 *   resolvedExePath?: string,
 *   installedRecord?: any,
 *   xboxReceipt?: any,
 *   acquireBottleLock: (resolvedPrefix: string) => Promise<void>,
 *   releasePendingBottleLock: () => void,
 *   releasePendingPlatformLock: () => void,
 * }} ctx
 */

/**
 * Stop a running game session cleanly (SIGTERM -> wineserver -k/-w teardown -> SIGKILL fallback)
 */
async function stopGame(/** @type {any} */ request = {}, /** @type {any} */ options = {}) {
  try {
    const reqObj =
      typeof request === 'string' ? { gameId: request, sessionId: request } : request || {};
    /** @type {string | null} */
    let targetKey = null;
    /** @type {any} */
    let targetEntry = null;

    if (reqObj.gameId && activeSessions.has(reqObj.gameId)) {
      targetKey = reqObj.gameId;
      targetEntry = activeSessions.get(reqObj.gameId);
    } else {
      for (const [k, entry] of activeSessions.entries()) {
        if (
          (reqObj.sessionId && entry.session.sessionId === reqObj.sessionId) ||
          (reqObj.pid && entry.session.pid === reqObj.pid) ||
          (reqObj.gameId && entry.session.platformGameId === String(reqObj.gameId))
        ) {
          targetKey = k;
          targetEntry = entry;
          break;
        }
      }
    }

    const requestedGameId = reqObj.gameId ? String(reqObj.gameId).trim() : '';
    if (!targetEntry || !targetKey) {
      if (requestedGameId && inFlightLaunchAbortControllers.has(requestedGameId)) {
        const launchCtrl = inFlightLaunchAbortControllers.get(requestedGameId);
        try {
          launchCtrl?.abort(new Error('Launch cancelled by user'));
        } catch {}
        emitSessionUpdated(
          {
            session: {
              gameId: requestedGameId,
              status: 'stopped',
              statusMessage: 'Launch cancelled',
            },
            gameId: requestedGameId,
            status: 'stopped',
            event: 'stopped',
            cancelled: true,
            statusMessage: 'Launch cancelled',
          },
          options
        );
        return {
          success: true,
          cancelled: true,
          message: 'Cancelled in-flight game launch.',
        };
      }
      return {
        success: false,
        error: 'No active running game session found.',
      };
    }

    if (inFlightLaunchAbortControllers.has(targetKey)) {
      try {
        inFlightLaunchAbortControllers.get(targetKey)?.abort(new Error('Launch stopped by user'));
      } catch {}
    }

    const mergedStopOptions = {
      ...(targetEntry.launchOptions || {}),
      ...(options || {}),
    };
    targetEntry.stopping = true;
    targetEntry.stoppedByUser = true;
    targetEntry.session.status = 'stopping';
    if (targetEntry.displayWatcherChild) {
      terminateDisplayWatcherTree(targetEntry.displayWatcherChild, mergedStopOptions);
      targetEntry.displayWatcherChild = null;
    }
    emitSessionUpdated(
      {
        session: { ...targetEntry.session },
        event: 'stopping',
      },
      mergedStopOptions
    );
    const isTestHomedir = Boolean(mergedStopOptions.homedir || reqObj.homedir);
    const isTestStopEnv =
      isTestEnvironment(mergedStopOptions) && mergedStopOptions.allowProcessCheckInTest !== true;
    const exePath = targetEntry.session?.executablePath || '';
    const exeBase =
      process.platform !== 'win32' && exePath.toLowerCase().endsWith('.exe')
        ? path.basename(exePath)
        : '';

    /** @type {string[]} */
    const stopWinExeTargets = [];
    if (exeBase && exeBase.length > 3) {
      stopWinExeTargets.push(exePath);
    }
    if (Array.isArray(targetEntry.targetExeBasenamesLower)) {
      for (const childExeName of targetEntry.targetExeBasenamesLower) {
        if (
          typeof childExeName === 'string' &&
          childExeName.length > 4 &&
          childExeName.toLowerCase() !== exeBase.toLowerCase()
        ) {
          stopWinExeTargets.push(childExeName);
        }
      }
    }
    if (!isTestStopEnv && stopWinExeTargets.length > 0) {
      await killPosixProcessesMatchingWinExes(
        stopWinExeTargets,
        'SIGTERM',
        targetEntry.winePrefix || ''
      );
    }
    if (Number(targetEntry.reLatchedBottleChildPid) > 0) {
      try {
        process.kill(Number(targetEntry.reLatchedBottleChildPid), 'SIGTERM');
      } catch {}
    }

    const stopExecFileImpl =
      mergedStopOptions.execFileImpl || mergedStopOptions.execFileFn || execFile;
    const stopKillImpl =
      typeof mergedStopOptions.killImpl === 'function'
        ? mergedStopOptions.killImpl
        : process.kill.bind(process);

    const stopPlatform = mergedStopOptions.platform || process.platform;
    const macAppBundlePath =
      stopPlatform === 'darwin' && !targetEntry.winePrefix
        ? resolveTargetMacAppBundlePath(exePath)
        : null;
    /** @type {string[]} */
    const macAppBundlePaths = [];
    if (macAppBundlePath) {
      macAppBundlePaths.push(path.resolve(macAppBundlePath));
      try {
        const realBundle = fs.realpathSync(macAppBundlePath);
        if (realBundle && !macAppBundlePaths.includes(realBundle)) {
          macAppBundlePaths.push(realBundle);
        }
      } catch {}
    }
    const macAppSeedPids = Array.from(
      new Set(
        [
          targetEntry.child && targetEntry.child.pid ? targetEntry.child.pid : null,
          targetEntry.pid,
          targetEntry.session?.pid,
          targetEntry.gamePid,
          targetEntry.session?.gamePid,
          targetEntry.reLatchedBottleChildPid,
        ]
          .map((v) => Number(v))
          .filter((n) => Number.isInteger(n) && n > 1 && n !== process.pid)
      )
    );
    /** @type {Map<number, string>} */
    const trackedMacAppPids = new Map();

    const snapshotMacAppBundleTree = () =>
      new Promise((resolve) => {
        if (!macAppBundlePath || isTestStopEnv) {
          return resolve({
            psFailed: false,
            orderedPids: /** @type {number[]} */ ([]),
            cmdByPid: /** @type {Map<number, string>} */ (new Map()),
          });
        }
        try {
          stopExecFileImpl(
            'ps',
            ['-axo', 'pid=,ppid=,command='],
            { timeout: 1500 },
            (/** @type {any} */ err, /** @type {any} */ stdout) => {
              if (err || !stdout) {
                return resolve({
                  psFailed: Boolean(err),
                  orderedPids: /** @type {number[]} */ ([]),
                  cmdByPid: /** @type {Map<number, string>} */ (new Map()),
                });
              }
              const parsed = collectMacAppBundleProcessTreePids(
                String(stdout),
                macAppBundlePaths,
                macAppSeedPids,
                process.pid
              );
              for (const cPid of parsed.orderedPids) {
                const cmd = parsed.cmdByPid.get(cPid) || '';
                if (cmd && !trackedMacAppPids.has(cPid)) {
                  trackedMacAppPids.set(cPid, cmd);
                }
              }
              resolve({
                psFailed: false,
                orderedPids: parsed.orderedPids,
                cmdByPid: parsed.cmdByPid,
              });
            }
          );
        } catch {
          resolve({
            psFailed: true,
            orderedPids: /** @type {number[]} */ ([]),
            cmdByPid: /** @type {Map<number, string>} */ (new Map()),
          });
        }
      });

    const signalMacAppBundleProcesses = async (/** @type {NodeJS.Signals} */ sig) => {
      if (!macAppBundlePath || isTestStopEnv) return [];
      const snap = await snapshotMacAppBundleTree();
      /** @type {number[]} */
      const pidsToSignal = [];
      /** @type {Set<number>} */
      const seen = new Set();

      // Include any previously captured descendants that survived reparenting (e.g. ./dosbox/dosbox -> ppid=1)
      for (const [prevPid, prevCmd] of trackedMacAppPids.entries()) {
        if (prevPid <= 1 || prevPid === process.pid || seen.has(prevPid)) continue;
        if (snap.orderedPids.includes(prevPid)) continue;
        const liveCmd = snap.cmdByPid.get(prevPid);
        const stillSameProcess =
          liveCmd !== undefined
            ? !prevCmd || liveCmd === prevCmd
            : snap.psFailed && isProcessAlive(prevPid, stopKillImpl);
        if (stillSameProcess) {
          seen.add(prevPid);
          pidsToSignal.push(prevPid);
        }
      }
      for (const cPid of snap.orderedPids) {
        if (cPid <= 1 || cPid === process.pid || seen.has(cPid)) continue;
        seen.add(cPid);
        pidsToSignal.push(cPid);
      }

      for (const cPid of pidsToSignal) {
        try {
          stopKillImpl(cPid, sig);
        } catch {}
      }
      return pidsToSignal;
    };

    if (macAppBundlePath && !isTestStopEnv) {
      // Snapshot full parent->child process tree BEFORE osascript/SIGTERM so reparented children stay tracked
      await snapshotMacAppBundleTree();
      if (!isTestHomedir && !isTestEnvironment(mergedStopOptions)) {
        const bundleId = readMacBundleIdFromInfoPlist(macAppBundlePath);
        if (bundleId && /^[A-Za-z0-9._-]+$/.test(bundleId)) {
          await new Promise((resolve) => {
            try {
              stopExecFileImpl(
                'osascript',
                ['-e', `tell application id "${bundleId}" to quit`],
                { timeout: 1500 },
                () => resolve(undefined)
              );
            } catch {
              resolve(undefined);
            }
          });
        }
      }
      await signalMacAppBundleProcesses('SIGTERM');
    }

    const effectivePerfPolicy = resolveEffectivePerformancePolicy(
      targetEntry.launchConfig || {},
      mergedStopOptions
    );

    const elevatedTargetPid = Number(targetEntry.elevatedTargetPid || 0);
    const usesLatchedPublisherChildPid = Boolean(
      targetEntry.launchedViaBottleSteam ||
        (targetEntry.launchedViaPublisherClient && Number(targetEntry.reLatchedBottleChildPid || 0) > 0)
    );
    const pid = usesLatchedPublisherChildPid
      ? Number(targetEntry.pid || targetEntry.session?.pid || 0) || null
      : elevatedTargetPid > 0
        ? elevatedTargetPid
        : (targetEntry.child && targetEntry.child.pid ? targetEntry.child.pid : null) ||
          Number(targetEntry.pid || targetEntry.session?.pid || 0) ||
          null;
    if (pid && pid > 1 && pid !== process.pid) {
      try {
        stopKillImpl(pid, 'SIGTERM');
      } catch {}
    }

    const sessionWinePrefix = targetEntry.winePrefix || null;
    const sessionWineBin = targetEntry.wineserverBinary || targetEntry.wineBinary || null;
    const entryPlatformId = targetEntry.session?.platformId || targetEntry.platformId || '';
    const needsDeferredPrefixShutdownForCloud = Boolean(
      targetEntry.launchedViaBottleSteam ||
        targetEntry.wokeBottleGogByLauncher ||
        targetEntry.wasBottleGogRunning ||
        targetEntry.wokeBottleEpicByLauncher ||
        targetEntry.wasBottleEpicRunning ||
        targetEntry.isChainedPublisherLauncher ||
        entryPlatformId === 'epic' ||
        entryPlatformId === 'gog' ||
        entryPlatformId === 'xbox' ||
        Boolean(targetEntry.xboxLoopbackServer)
    );
    const stopHostPlatform =
      mergedStopOptions.platform || options.platform || reqObj.platform || process.platform;

    let resolvedWineserverForStop = null;
    let canRunWineserverForStop = false;
    if (
      stopHostPlatform !== 'win32' &&
      sessionWinePrefix &&
      sessionWineBin &&
      effectivePerfPolicy.autoShutdownWinePrefixOnExit !== false
    ) {
      const resolvedWineserver = resolveWineserverBinary(sessionWineBin);
      const normWineserver = resolvedWineserver
        ? path.resolve(resolvedWineserver).replace(/\\/g, '/').toLowerCase()
        : '';
      const normTestHome = (options.homedir || reqObj.homedir || '')
        ? path.resolve(options.homedir || reqObj.homedir).replace(/\\/g, '/').toLowerCase()
        : '';
      const normTmpDir = path.resolve(os.tmpdir()).replace(/\\/g, '/').toLowerCase();
      const canRunWineserver =
        Boolean(resolvedWineserver) &&
        (!isTestHomedir ||
          (normTestHome && normWineserver.startsWith(normTestHome)) ||
          normWineserver.startsWith(normTmpDir) ||
          normWineserver.startsWith('/private/var/folders') ||
          normWineserver.startsWith('/var/folders'));
      resolvedWineserverForStop = resolvedWineserver;
      canRunWineserverForStop = canRunWineserver;
      if (needsDeferredPrefixShutdownForCloud && canRunWineserver) {
        targetEntry.deferredPrefixShutdownToFinalize = true;
      }
    }

    // Always allow the graceful SIGTERM exit window BEFORE falling back to `wineserver -k` or SIGKILL
    const graceWindowMs = Math.max(10, Number(mergedStopOptions.macStopGraceMs ?? 500));
    const graceStartMs = Date.now();
    let exitedGracefully = false;
    if (pid) {
      exitedGracefully = await waitForProcessExit(
        usesLatchedPublisherChildPid || elevatedTargetPid > 0 ? null : targetEntry.child,
        pid,
        graceWindowMs,
        stopKillImpl
      );
    }
    if (macAppBundlePath && !isTestStopEnv && trackedMacAppPids.size > 0) {
      const trackedList = Array.from(trackedMacAppPids.keys());
      const remainingGraceMs = Math.max(0, graceWindowMs - (Date.now() - graceStartMs));
      if (
        remainingGraceMs > 0 &&
        trackedList.some((cPid) => isProcessAlive(cPid, stopKillImpl))
      ) {
        const deadline = Date.now() + remainingGraceMs;
        await new Promise((resolve) => {
          const timer = setInterval(() => {
            if (
              Date.now() >= deadline ||
              !trackedList.some((cPid) => isProcessAlive(cPid, stopKillImpl))
            ) {
              clearInterval(timer);
              resolve(undefined);
            }
          }, 25);
          if (typeof timer.unref === 'function') timer.unref();
        });
      }
    }

    if (
      !needsDeferredPrefixShutdownForCloud &&
      canRunWineserverForStop &&
      resolvedWineserverForStop &&
      sessionWinePrefix
    ) {
      const resolvedSessionPrefix = path.resolve(sessionWinePrefix);
      const hasOtherActiveSessionInPrefix =
        (pendingBottleLaunches.get(resolvedSessionPrefix) || 0) > 0 ||
        Array.from(activeSessions.entries()).some(
          ([k, e]) =>
            k !== targetKey &&
            !e.finalized &&
            e.winePrefix &&
            path.resolve(e.winePrefix) === resolvedSessionPrefix
        );
      if (!hasOtherActiveSessionInPrefix) {
        targetEntry.wineShutdownHandledByStopGame = true;
        deleteBottleDaemonEnvContract(sessionWinePrefix);
        await shutdownWinePrefix(resolvedWineserverForStop, sessionWinePrefix, 2500);
      }
    }

    if (pid) {
      if (!exitedGracefully && isProcessAlive(pid, stopKillImpl)) {
        if (stopPlatform === 'win32') {
          try {
            await signalSubprocessTree(
              usesLatchedPublisherChildPid || elevatedTargetPid > 0
                ? { pid }
                : targetEntry.child || { pid },
              'SIGKILL',
              mergedStopOptions
            );
          } catch {}
          if (
            Number.isInteger(elevatedTargetPid) &&
            elevatedTargetPid > 0 &&
            targetEntry.child?._requireRunAs &&
            isProcessAlive(elevatedTargetPid, stopKillImpl) &&
            !isTestStopEnv
          ) {
            await new Promise((resolve) => {
              try {
                stopExecFileImpl(
                  'powershell.exe',
                  [
                    '-NoProfile',
                    '-NonInteractive',
                    '-WindowStyle',
                    'Hidden',
                    '-Command',
                    "Start-Process -FilePath 'taskkill.exe' -ArgumentList @('/PID',$env:ONE_KILL_PID,'/T','/F') -Verb RunAs -WindowStyle Hidden -Wait",
                  ],
                  {
                    timeout: 10000,
                    windowsHide: true,
                    env: { ...process.env, ONE_KILL_PID: String(elevatedTargetPid) },
                  },
                  () => resolve(undefined)
                );
              } catch {
                resolve(undefined);
              }
            });
          }
          if (
            elevatedTargetPid > 0 &&
            targetEntry.child?.pid &&
            targetEntry.child.pid !== elevatedTargetPid
          ) {
            try {
              stopKillImpl(targetEntry.child.pid, 'SIGTERM');
            } catch {}
          }
        } else if (pid > 1 && pid !== process.pid) {
          try {
            stopKillImpl(pid, 'SIGKILL');
          } catch {}
        }
        if (!isTestStopEnv && stopWinExeTargets.length > 0) {
          await killPosixProcessesMatchingWinExes(
            stopWinExeTargets,
            'SIGKILL',
            targetEntry.winePrefix || ''
          );
        }
        await waitForProcessExit(
          usesLatchedPublisherChildPid || elevatedTargetPid > 0 ? null : targetEntry.child,
          pid,
          400,
          stopKillImpl
        );
      }
    }
    if (macAppBundlePath && !isTestStopEnv) {
      // Escalate to SIGKILL for any surviving .app bundle process or descendant (e.g. sh / dosbox),
      // even if the outer `/usr/bin/open -W -a` wrapper already exited on SIGTERM.
      await signalMacAppBundleProcesses('SIGKILL');
    }

    const result = finalizeGameSession(targetKey, options) || {
      session: targetEntry.session,
      sessionMinutesPlayed: Math.max(1, Math.round((Date.now() - targetEntry.startedMs) / 60000)),
      postSessionBarrierPromise: null,
      storefrontSyncPromise: null,
    };

    if (options.awaitPostSessionBarrier && result.postSessionBarrierPromise) {
      await result.postSessionBarrierPromise;
    }

    let storefrontTotalPlaytimeMinutes = null;
    if (options.awaitStorefrontPlaytimeSync && result.storefrontSyncPromise) {
      const syncRes = await result.storefrontSyncPromise;
      if (syncRes && typeof syncRes.storefrontTotalPlaytimeMinutes === 'number') {
        storefrontTotalPlaytimeMinutes = syncRes.storefrontTotalPlaytimeMinutes;
      }
    }

    return {
      success: true,
      message: `Stopped ${targetEntry.session.title}`,
      session: result.session,
      sessionMinutesPlayed: result.sessionMinutesPlayed,
      ...(storefrontTotalPlaytimeMinutes !== null ? { storefrontTotalPlaytimeMinutes } : {}),
    };
  } catch (/** @type {any} */ err) {
    return {
      success: false,
      error: err.message,
    };
  }
}

function getRunningGames() {
  return Array.from(activeSessions.values()).map((entry) => ({ ...entry.session }));
}


function shutdownLauncherEngine(/** @type {any} */ options = {}) {
  shutdownDownloadEngine(options);
  liveBottleDaemonEnvContractByPrefix.clear();

  for (const [, entry] of activeSessions.entries()) {
    disposeSessionResources(entry, { closeXboxLoopback: true, options });
  }
  activeSessions.clear();

  try {
    disposeHostDisplayMetricsListener();
  } catch {}

  const vaultHooks = getOfflineVaultLifecycleHooks();
  if (vaultHooks && typeof vaultHooks.shutdown === 'function') {
    try {
      vaultHooks.shutdown();
    } catch {}
  }
  trimLauncherEngineMemory();
}


/**
 * Parse `ps -axo pid=,ppid=,command=` output and collect all PIDs belonging to a macOS `.app`
 * bundle (matching `${bundlePath}/Contents/` across `Contents/MacOS/`, `Contents/Resources/`,
 * etc.) plus every descendant PID reachable via parent->child links from those matched PIDs
 * and any provided `seedPids` (such as `/usr/bin/open` session PID or `gamePid`), ordered
 * deepest descendants first so child engines (`sh`, `./dosbox/dosbox`) are signaled before
 * parent wrappers. Never includes PID `<= 1` or `selfPid`.
 *
 * @param {string} psOutput
 * @param {string | string[]} macAppBundlePaths
 * @param {Array<number | null | undefined>} [seedPids]
 * @param {number} [selfPid]
 * @returns {{
 *   matchedRootPids: number[],
 *   orderedPids: number[],
 *   cmdByPid: Map<number, string>,
 * }}
 */
function collectMacAppBundleProcessTreePids(
  psOutput,
  macAppBundlePaths,
  seedPids = [],
  selfPid = process.pid
) {
  /** @type {Map<number, number[]>} */
  const childrenByPpid = new Map();
  /** @type {Map<number, string>} */
  const cmdByPid = new Map();
  /** @type {number[]} */
  const matchedRootPids = [];

  const rawPaths = Array.isArray(macAppBundlePaths) ? macAppBundlePaths : [macAppBundlePaths];
  const contentsPrefixesLower = Array.from(
    new Set(
      rawPaths
        .map((p) => String(p || '').trim())
        .filter(Boolean)
        .map((p) => {
          const normalized = p.startsWith('/')
            ? path.posix.resolve(p).replace(/\/+$/, '')
            : path.resolve(p).replace(/\\/g, '/').replace(/\/+$/, '');
          return `${normalized}/contents/`.toLowerCase();
        })
    )
  );

  for (const rawLine of String(psOutput || '').split(/\r?\n/)) {
    const m = rawLine.match(/^\s*(\d+)\s+(\d+)\s+(.+)$/);
    if (!m) continue;
    const cPid = Number.parseInt(m[1], 10);
    const pPid = Number.parseInt(m[2], 10);
    const cmd = m[3].trim();
    if (!Number.isInteger(cPid) || cPid <= 1) continue;
    cmdByPid.set(cPid, cmd);
    if (Number.isInteger(pPid) && pPid > 0 && pPid !== cPid) {
      let kids = childrenByPpid.get(pPid);
      if (!kids) {
        kids = [];
        childrenByPpid.set(pPid, kids);
      }
      kids.push(cPid);
    }
    if (cPid === selfPid || /^(?:\/bin\/|\/usr\/bin\/)?ps(?:\s|$)/i.test(cmd)) {
      continue;
    }
    const lowerCmd = cmd.replace(/\\/g, '/').toLowerCase();
    if (contentsPrefixesLower.some((prefix) => lowerCmd.includes(prefix))) {
      matchedRootPids.push(cPid);
    }
  }

  /** @type {number[]} */
  const rootQueue = [];
  /** @type {Set<number>} */
  const visited = new Set();
  const enqueueRoot = (/** @type {unknown} */ rawPid) => {
    const n = Number(rawPid);
    if (!Number.isInteger(n) || n <= 1 || n === selfPid || visited.has(n)) return;
    visited.add(n);
    rootQueue.push(n);
  };

  for (const mp of matchedRootPids) enqueueRoot(mp);
  for (const sp of Array.isArray(seedPids) ? seedPids : []) {
    const n = Number(sp);
    if (cmdByPid.has(n) || childrenByPpid.has(n)) {
      enqueueRoot(n);
    }
  }

  /** @type {number[]} */
  const bfsOrder = [];
  let idx = 0;
  while (idx < rootQueue.length) {
    const curr = rootQueue[idx++];
    bfsOrder.push(curr);
    const kids = childrenByPpid.get(curr);
    if (!kids) continue;
    for (const kid of kids) {
      if (kid <= 1 || kid === selfPid || visited.has(kid)) continue;
      visited.add(kid);
      rootQueue.push(kid);
    }
  }

  return {
    matchedRootPids,
    orderedPids: bfsOrder.reverse(),
    cmdByPid,
  };
}

module.exports = {
  finalizeGameSession,
  stopGame,
  getRunningGames,
  shutdownLauncherEngine,
  collectMacAppBundleProcessTreePids,
};
