// @ts-check
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { spawn, execFile } = require('node:child_process');
const { discoverWindowsSteamRegistryPaths } = require('../../utils/windowsRegistryDiscovery.cjs');
const { inspectMicrosoftGameConfig } = require('../binaryAndManifestInspectors.cjs');
const {
  isHostGogGalaxyRunning,
  reapOrphanedGogOverlayProcesses,
  waitForGogPostExitFlush,
} = require('../storefrontReadinessBarrier.cjs');
const {
  syncXboxCloudSaves,
  enqueuePendingCloudUpload,
  replayPendingCloudUploads,
  createCloudSaveRunner,
} = require('../cloudSaveEngine.cjs');
const {
  getStoreSync,
  getXboxStorefrontModules,
  diagLog,
  getUserDataDir,
  isTestEnvironment,
  resolveIsolatedHomedirAndUserData,
  activeSessions,
  pendingBottleLaunches,
  pendingEphemeralShutdowns,
  pendingStorefrontLaunches,
  downloadQueueMap,
  pausedByInGameTaskIds,
  inFlightPostSessionPromises,
  toLocalFsPath,
  findLegendaryBinary,
  findGogdlBinary,
  normalizeStorefrontClientLifecycle,
  resolveEffectivePerformancePolicy,
} = require('../engineStateRegistry.cjs');
const { resolveXboxClientBinaryPath } = require('../windowsXboxAppxAndMsixvcOrchestrator.cjs');
const {
  discoverSteamLocations,
  detectCompatibilityLayers,
} = require('../macNativeInstallerAndCodesign.cjs');
const {
  renewEpicTokensSingleFlight,
  ensureLegendaryConfigAndAuth,
  getLegendaryConfigDir,
  collectLocalEpicMetadataAndSupport,
  resolveEpicAppAndPlatforms,
  performJsonHttpRequest,
  resolveEpicClientBinaryPath,
} = require('../epicLegendaryAndEosCoordinator.cjs');
const {
  renewGogTokensSingleFlight,
  ensureGogdlAuthConfig,
  resolveGogGalaxyClientBinaryPath,
  fetchGogV1Json,
} = require('../gogRegistryAndDirectInstaller.cjs');
const {
  resolveAnyChainedHandoffId,
  activePostExitCloudUploadJobs,
} = require('./bottleDisplayAndEnvController.cjs');

function hasActivePostSessionWork() {
  return inFlightPostSessionPromises.size > 0;
}

async function waitForActivePostSessionWork(timeoutMs = 20000) {
  if (inFlightPostSessionPromises.size === 0) {
    return { completed: true, remaining: 0 };
  }
  const activeSnapshot = Array.from(inFlightPostSessionPromises);
  const safeTimeoutMs = Math.max(250, Math.min(30000, Number(timeoutMs) || 20000));
  let timedOut = false;
  await Promise.race([
    Promise.allSettled(activeSnapshot),
    new Promise((resolve) => {
      const timer = setTimeout(() => {
        timedOut = true;
        resolve(undefined);
      }, safeTimeoutMs);
      if (typeof timer.unref === 'function') timer.unref();
    }),
  ]);
  let persistedPendingUploads = 0;
  if (timedOut && activePostExitCloudUploadJobs.size > 0) {
    for (const job of Array.from(activePostExitCloudUploadJobs)) {
      try {
        await enqueuePendingCloudUpload(job.record, job.options);
        persistedPendingUploads += 1;
      } catch {}
    }
  }
  return {
    completed: !timedOut && inFlightPostSessionPromises.size === 0,
    remaining: inFlightPostSessionPromises.size,
    ...(persistedPendingUploads > 0 ? { persistedPendingUploads } : {}),
  };
}

const {
  syncGogCloudSaves,
  syncEpicCloudSaves,
  waitForSteamColdStartupCloudReady,
  waitForSteamCloudSyncCompletion,
} = createCloudSaveRunner({
  resolveIsolatedHomedirAndUserData: (/** @type {any[]} */ ...args) =>
    resolveIsolatedHomedirAndUserData(...args),
  isTestEnvironment: (/** @type {any[]} */ ...args) => isTestEnvironment(...args),
  fetchGogV1Json: (
    /** @type {string} */ url,
    /** @type {any} */ headers,
    /** @type {any} */ timeoutMs,
    /** @type {any} */ fetchFn
  ) => fetchGogV1Json(url, headers, timeoutMs, fetchFn),
  findGogdlBinary: (/** @type {any[]} */ ...args) => findGogdlBinary(...args),
  ensureGogdlAuthConfig: (/** @type {any[]} */ ...args) => ensureGogdlAuthConfig(...args),
  resolveEpicAppAndPlatforms: (/** @type {any[]} */ ...args) => resolveEpicAppAndPlatforms(...args),
  ensureLegendaryConfigAndAuth: (/** @type {any[]} */ ...args) =>
    ensureLegendaryConfigAndAuth(...args),
  getLegendaryConfigDir: (/** @type {any[]} */ ...args) => getLegendaryConfigDir(...args),
  collectLocalEpicMetadataAndSupport: (/** @type {any[]} */ ...args) =>
    collectLocalEpicMetadataAndSupport(...args),
  findLegendaryBinary: (/** @type {any[]} */ ...args) => findLegendaryBinary(...args),
});


function resolveSteamClientBinaryPath(/** @type {any} */ options = {}) {
  const targetPlatform = options.platform || process.platform;
  const isTestEnv = Boolean(process.env.VITEST || process.env.NODE_ENV === 'test');

  if (options.steamClientBinaryPath !== undefined && options.steamClientBinaryPath !== null) {
    const explicitPath = String(options.steamClientBinaryPath).trim();
    if (!explicitPath) return null;
    return fs.existsSync(explicitPath) ? explicitPath : null;
  }

  if (targetPlatform === 'win32') {
    const winCandidates = [];
    if (options.customApplicationsDir) {
      winCandidates.push(
        path.join(options.customApplicationsDir, 'Steam', 'steam.exe'),
        path.join(options.customApplicationsDir, 'steam.exe')
      );
    }
    if (options.homedir) {
      winCandidates.push(
        path.join(options.homedir, 'Program Files (x86)', 'Steam', 'steam.exe'),
        path.join(options.homedir, 'Program Files', 'Steam', 'steam.exe')
      );
    }
    if (
      !options.customApplicationsDir &&
      (!options.homedir || options.allowSystemSteamInTest === true) &&
      (!isTestEnv || options.allowSystemSteamInTest === true)
    ) {
      const regSteam = discoverWindowsSteamRegistryPaths(options);
      if (regSteam.steamExe) {
        winCandidates.push(regSteam.steamExe);
      }
      const regSteamRoot = regSteam.steamRoot || regSteam.steamPath;
      if (regSteamRoot) {
        winCandidates.push(path.join(regSteamRoot, 'steam.exe'));
      }
      if (process.env['ProgramFiles(x86)']) {
        winCandidates.push(path.join(process.env['ProgramFiles(x86)'], 'Steam', 'steam.exe'));
      }
      if (process.env.ProgramFiles) {
        winCandidates.push(path.join(process.env.ProgramFiles, 'Steam', 'steam.exe'));
      }
      winCandidates.push(
        'C:\\Program Files (x86)\\Steam\\steam.exe',
        'C:\\Program Files\\Steam\\steam.exe'
      );
    }
    for (const c of winCandidates) {
      if (c && fs.existsSync(c)) return c;
    }
    return null;
  }

  if (targetPlatform === 'darwin') {
    const macCandidates = [];
    if (options.customApplicationsDir) {
      macCandidates.push(
        path.join(options.customApplicationsDir, 'Steam.app', 'Contents', 'MacOS', 'steam_osx'),
        path.join(options.customApplicationsDir, 'Contents', 'MacOS', 'steam_osx')
      );
    }
    if (options.homedir) {
      macCandidates.push(
        path.join(options.homedir, 'Applications', 'Steam.app', 'Contents', 'MacOS', 'steam_osx')
      );
    }
    if (
      !options.customApplicationsDir &&
      (!options.homedir || options.allowSystemSteamInTest === true) &&
      (!isTestEnv || options.allowSystemSteamInTest === true)
    ) {
      macCandidates.push(
        path.join(os.homedir(), 'Applications', 'Steam.app', 'Contents', 'MacOS', 'steam_osx'),
        '/Applications/Steam.app/Contents/MacOS/steam_osx'
      );
    }
    for (const c of macCandidates) {
      if (c && fs.existsSync(c)) return c;
    }
    return null;
  }

  return null;
}

/**
 * Detect whether official desktop storefront clients (Steam, GOG Galaxy, Epic Games Launcher, Xbox App)
 * are installed on the host OS.
 */
function detectInstalledStorefrontClients(/** @type {any} */ options = {}) {
  return {
    steam: Boolean(resolveSteamClientBinaryPath(options)),
    gog: Boolean(resolveGogGalaxyClientBinaryPath(options)),
    epic: Boolean(resolveEpicClientBinaryPath(options)),
    xbox: Boolean(resolveXboxClientBinaryPath(options)),
  };
}

/**
 * Resolve Steam client binary path and minimal launch command when Steam is not already running.
 */
async function resolveSteamClientLaunchCommand(
  /** @type {any} */ steamAppId,
  /** @type {any[]} */ extraArgs = [],
  /** @type {any} */ options = {}
) {
  const cleanAppId = String(steamAppId || '')
    .replace(/^steam[-_]/i, '')
    .trim();
  if (!cleanAppId) {
    return {
      useMinimalBinarySpawn: false,
      alreadyRunning: false,
      binaryPath: null,
      args: [],
      wokeSteamByLauncher: false,
    };
  }

  const rawPolicy =
    options.storefrontClientLifecycle ||
    resolveEffectivePerformancePolicy(options.launchConfig || {}, options).storefrontClientLifecycle;
  const policy = normalizeStorefrontClientLifecycle(rawPolicy) || rawPolicy;

  const targetPlatform = options.platform || process.platform;
  const execFileImpl =
    typeof options.execFileImpl === 'function'
      ? options.execFileImpl
      : typeof options.execFileFn === 'function'
        ? options.execFileFn
        : execFile;

  const binaryPath = resolveSteamClientBinaryPath(options);

  let alreadyRunning = false;
  const checkProcessList = (/** @type {any} */ stdoutStr) => {
    const out = String(stdoutStr || '');
    if (targetPlatform === 'win32') {
      return /steam\.exe/i.test(out);
    }
    return /(?:Steam\.app\/Contents\/MacOS\/steam_osx|(?:^|[\\/])steam_osx(?:\s|$)|(?:^|[\\/])steam\.exe(?:\s|$))/i.test(
      out
    );
  };

  if (typeof options.mockProcessListOutput === 'string') {
    alreadyRunning = checkProcessList(options.mockProcessListOutput);
  } else if (
    !options.homedir ||
    typeof options.execFileImpl === 'function' ||
    typeof options.execFileFn === 'function'
  ) {
    try {
      alreadyRunning = await new Promise((resolve) => {
        if (targetPlatform === 'win32') {
          execFileImpl(
            'tasklist.exe',
            ['/FI', 'IMAGENAME eq steam.exe', '/NH'],
            { timeout: 1500, windowsHide: true },
            (/** @type {any} */ err, /** @type {any} */ stdout) => {
              resolve(!err && checkProcessList(stdout));
            }
          );
        } else {
          execFileImpl(
            'ps',
            ['-ax', '-o', 'command='],
            { timeout: 1500 },
            (/** @type {any} */ err, /** @type {any} */ stdout) => {
              resolve(!err && checkProcessList(stdout));
            }
          );
        }
      });
    } catch {
      alreadyRunning = false;
    }
  }

  if (alreadyRunning || policy === 'default_client' || !binaryPath) {
    return {
      useMinimalBinarySpawn: false,
      alreadyRunning,
      binaryPath: binaryPath || null,
      args: [],
      wokeSteamByLauncher: false,
    };
  }

  const parsedExtraArgs = Array.isArray(extraArgs) ? extraArgs.filter(Boolean).map(String) : [];
  const minimalArgs =
    policy === 'fast_direct_bypass'
      ? [
          '-silent',
          '-nochatui',
          '-nofriendsui',
          '-nobrowser',
          '-applaunch',
          cleanAppId,
          ...parsedExtraArgs,
        ]
      : ['-silent', '-applaunch', cleanAppId, ...parsedExtraArgs];

  return {
    useMinimalBinarySpawn: true,
    alreadyRunning: false,
    wokeSteamByLauncher: true,
    binaryPath,
    args: minimalArgs,
  };
}

/**
 * Gracefully shut down an ephemeral storefront client that was woken specifically by One Launcher.
 */
async function shutdownEphemeralStorefrontClient(
  /** @type {any} */ sessionEntry = {},
  /** @type {any} */ options = {}
) {
  if (!sessionEntry || typeof sessionEntry !== 'object') {
    return { closed: false, shutDown: false, reason: 'invalid_session' };
  }

  const effectivePolicy = resolveEffectivePerformancePolicy(
    sessionEntry.launchConfig || {},
    options
  );
  const policy =
    normalizeStorefrontClientLifecycle(sessionEntry.effectiveStorefrontLifecycle) ||
    normalizeStorefrontClientLifecycle(options.storefrontClientLifecycle) ||
    effectivePolicy.storefrontClientLifecycle;

  if (policy !== 'minimal_and_close_if_started') {
    return { closed: false, shutDown: false, reason: 'policy_keep_running', policy };
  }

  const targetPlatform = options.platform || process.platform;
  const platformId = String(
    sessionEntry.platformId || sessionEntry.session?.platformId || ''
  ).toLowerCase();

  const hasOtherActivePlatformSession = () =>
    (platformId && (pendingStorefrontLaunches.get(platformId) || 0) > 0) ||
    Array.from(activeSessions.values()).some(
      (other) =>
        other !== sessionEntry &&
        !other.finalized &&
        String(other.platformId || other.session?.platformId || '').toLowerCase() === platformId
    );

  const hasActiveOrPausedDownloadsForPlatform = () =>
    options.hasActiveDownloads === true ||
    Array.from(downloadQueueMap.values()).some(
      (t) =>
        t &&
        (!platformId || String(t.platformId || '').toLowerCase() === platformId) &&
        (['downloading', 'queued', 'extracting', 'verifying'].includes(t.status) ||
          pausedByInGameTaskIds.has(t.taskId))
    );

  if (hasOtherActivePlatformSession()) {
    return { closed: false, shutDown: false, reason: 'other_session_active' };
  }
  if (hasActiveOrPausedDownloadsForPlatform()) {
    return { closed: false, shutDown: false, reason: 'active_download_in_progress' };
  }

  const abortCtrl = new AbortController();
  if (platformId) {
    const prevCtrl = pendingEphemeralShutdowns.get(platformId);
    if (prevCtrl && typeof prevCtrl.abort === 'function') {
      try {
        prevCtrl.abort();
      } catch {}
    }
    pendingEphemeralShutdowns.set(platformId, abortCtrl);
  }

  const getBusyOrAbortedReason = () => {
    if (abortCtrl.signal.aborted) return 'other_session_active';
    if (hasOtherActivePlatformSession()) return 'other_session_active';
    if (hasActiveOrPausedDownloadsForPlatform()) return 'active_download_in_progress';
    return null;
  };

  try {
    const defaultGraceMs =
      isTestEnvironment(options) ||
      options.skipCloudSyncGraceDelay === true ||
      typeof options.spawnFn === 'function' ||
      typeof options.execFileFn === 'function' ||
      typeof options.execFileImpl === 'function'
        ? 0
        : 5000;
    const graceMs =
      options.cloudSyncGraceMs !== undefined
        ? Math.max(0, Number(options.cloudSyncGraceMs) || 0)
        : defaultGraceMs;

    if (graceMs > 0) {
      await new Promise((resolve) => {
        let settled = false;
        const finish = () => {
          if (settled) return;
          settled = true;
          clearTimeout(t);
          abortCtrl.signal.removeEventListener('abort', finish);
          resolve(undefined);
        };
        const t = setTimeout(finish, graceMs);
        if (typeof t.unref === 'function') t.unref();
        abortCtrl.signal.addEventListener('abort', finish, { once: true });
      });
      const busyAfterGrace = getBusyOrAbortedReason();
      if (busyAfterGrace) {
        return { closed: false, shutDown: false, reason: busyAfterGrace };
      }
    }

    const spawnImpl = options.spawnFn || spawn;
    const execFileImpl =
      typeof options.execFileImpl === 'function'
        ? options.execFileImpl
        : typeof options.execFileFn === 'function'
          ? options.execFileFn
          : execFile;

    const shouldReapGogOverlay =
      !isTestEnvironment(options) ||
      options.allowOverlayReaperInTest === true ||
      typeof options.mockOverlayProcessList === 'string';

    if (platformId === 'gog' && sessionEntry.wokeGogGalaxyByLauncher === true) {
      const busyBeforeGogKill = getBusyOrAbortedReason();
      if (busyBeforeGogKill) {
        return { closed: false, shutDown: false, reason: busyBeforeGogKill };
      }

      const canCheckHostGogAlive =
        !isTestEnvironment(options) ||
        options.mockProcessListOutput !== undefined ||
        typeof options.getProcessListOutput === 'function';

      if (canCheckHostGogAlive) {
        const stillRunningBeforeFlush = await isHostGogGalaxyRunning({
          ...options,
          platform: targetPlatform,
        });
        if (!stillRunningBeforeFlush) {
          if (shouldReapGogOverlay) {
            await reapOrphanedGogOverlayProcesses(options);
          }
          return {
            closed: false,
            shutDown: false,
            alreadyClosed: true,
            platformId: 'gog',
            reason: 'already_exited',
          };
        }
      }

      const gogFlushWait = await waitForGogPostExitFlush({
        platform: targetPlatform,
        homedir: options.homedir,
        ...(typeof sessionEntry.gogCommLogPreExitOffset === 'number'
          ? { preExitOffset: sessionEntry.gogCommLogPreExitOffset }
          : {}),
        signal: abortCtrl.signal,
        options,
      });

      const busyAfterGogFlush = getBusyOrAbortedReason();
      if (busyAfterGogFlush) {
        return { closed: false, shutDown: false, reason: busyAfterGogFlush };
      }

      if (canCheckHostGogAlive && gogFlushWait && gogFlushWait.waitedMs > 0) {
        const stillRunningAfterFlush = await isHostGogGalaxyRunning({
          ...options,
          platform: targetPlatform,
        });
        if (!stillRunningAfterFlush) {
          if (shouldReapGogOverlay) {
            await reapOrphanedGogOverlayProcesses(options);
          }
          return {
            closed: false,
            shutDown: false,
            alreadyClosed: true,
            platformId: 'gog',
            reason: 'already_exited',
          };
        }
      }

      const clientPath =
        sessionEntry.gogGalaxyClientPath ||
        (!isTestEnvironment(options) && targetPlatform === 'win32'
          ? resolveGogGalaxyClientBinaryPath({ ...options, platform: 'win32' })
          : null) ||
        'GalaxyClient.exe';
      try {
        if (targetPlatform === 'win32') {
          const child = spawnImpl(clientPath, ['/command=shutdown'], {
            detached: true,
            stdio: 'ignore',
            windowsHide: true,
          });
          if (child && typeof child.unref === 'function') child.unref();
          if (shouldReapGogOverlay) {
            await reapOrphanedGogOverlayProcesses(options);
          }
          return {
            closed: true,
            shutDown: true,
            platformId: 'gog',
            method: 'command_shutdown',
            clientPath,
            ...(gogFlushWait && gogFlushWait.reason !== 'skipped_in_test'
              ? { postExitFlush: gogFlushWait }
              : {}),
          };
        } else if (targetPlatform === 'darwin') {
          const candidateAppOrBin =
            sessionEntry.gogGalaxyClientPath ||
            (!isTestEnvironment(options)
              ? resolveGogGalaxyClientBinaryPath({ ...options, platform: 'darwin' }) ||
                '/Applications/GOG Galaxy.app'
              : '');
          const macGalaxyBin = candidateAppOrBin
            ? candidateAppOrBin.endsWith('.app')
              ? path.join(candidateAppOrBin, 'Contents', 'MacOS', 'GOG Galaxy')
              : candidateAppOrBin
            : '';

          if (macGalaxyBin && fs.existsSync(macGalaxyBin)) {
            const cmdShutdownOk = await new Promise((resolve) => {
              try {
                execFileImpl(
                  macGalaxyBin,
                  ['--command=shutdown'],
                  { timeout: 6000 },
                  (/** @type {any} */ err) => resolve(!err)
                );
              } catch {
                resolve(false);
              }
            });
            if (cmdShutdownOk) {
              if (shouldReapGogOverlay) {
                await reapOrphanedGogOverlayProcesses(options);
              }
              return {
                closed: true,
                shutDown: true,
                platformId: 'gog',
                method: 'command_shutdown',
                clientPath: sessionEntry.gogGalaxyClientPath || null,
                ...(gogFlushWait && gogFlushWait.reason !== 'skipped_in_test'
                  ? { postExitFlush: gogFlushWait }
                  : {}),
              };
            }
          }

          const busyBeforeMacPkill = getBusyOrAbortedReason();
          if (busyBeforeMacPkill) {
            return { closed: false, shutDown: false, reason: busyBeforeMacPkill };
          }

          await new Promise((resolve) => {
            execFileImpl(
              '/usr/bin/pkill',
              ['-TERM', '-x', 'GOG Galaxy'],
              { timeout: 2500 },
              () => resolve(undefined)
            );
          });
          if (shouldReapGogOverlay) {
            await reapOrphanedGogOverlayProcesses(options);
          }
          return {
            closed: true,
            shutDown: true,
            platformId: 'gog',
            method: 'sigterm_quit',
            clientPath: sessionEntry.gogGalaxyClientPath || null,
            ...(gogFlushWait && gogFlushWait.reason !== 'skipped_in_test'
              ? { postExitFlush: gogFlushWait }
              : {}),
          };
        }
      } catch {
        return {
          closed: false,
          shutDown: false,
          platformId: 'gog',
          reason: 'shutdown_command_failed',
        };
      }
    }

    if (platformId === 'steam' && sessionEntry.wokeSteamByLauncher === true) {
      const steamAppId =
        sessionEntry.steamAppId ||
        sessionEntry.platformGameId ||
        sessionEntry.session?.platformGameId ||
        options.steamAppId ||
        '';
      const candidateSteamRoot =
        options.steamRoot ||
        sessionEntry.steamRoot ||
        sessionEntry.bottleSteamRoot ||
        (sessionEntry.steamClientBinaryPath && targetPlatform === 'win32'
          ? path.dirname(sessionEntry.steamClientBinaryPath)
          : targetPlatform === 'darwin' && (options.homedir || !isTestEnvironment(options))
            ? path.join(options.homedir || os.homedir(), 'Library', 'Application Support', 'Steam')
            : sessionEntry.steamClientBinaryPath
              ? path.dirname(sessionEntry.steamClientBinaryPath)
              : null) ||
        (() => {
          try {
            const locs = discoverSteamLocations(options);
            if (locs && locs.steamRoots) {
              const arr = Array.from(locs.steamRoots);
              return arr[0] || '';
            }
          } catch {}
          return '';
        })();

      let cloudWaitResult = options.preResolvedCloudWaitResult || null;
      if (!cloudWaitResult && steamAppId) {
        try {
          cloudWaitResult = await waitForSteamCloudSyncCompletion(
            candidateSteamRoot || '',
            steamAppId,
            {
              ...options,
              mode: 'post_exit',
              ignoreStaleLogAge: true,
              signal: abortCtrl.signal,
              abortOnSignal: true,
            }
          );
        } catch {}
      }

      const busyBeforeSteamKill = getBusyOrAbortedReason();
      if (busyBeforeSteamKill) {
        return { closed: false, shutDown: false, reason: busyBeforeSteamKill };
      }

      const steamBin = sessionEntry.steamClientBinaryPath || 'steam.exe';
      try {
        if (targetPlatform === 'win32') {
          const child = spawnImpl(steamBin, ['-shutdown'], {
            detached: true,
            stdio: 'ignore',
            windowsHide: true,
          });
          if (child && typeof child.unref === 'function') child.unref();
          if (
            sessionEntry.wokePublisherClientByLauncher === true &&
            resolveAnyChainedHandoffId(sessionEntry.chainedLauncherHandoff) === 'ea' &&
            !getBusyOrAbortedReason()
          ) {
            await new Promise((resolve) => {
              execFileImpl(
                'taskkill.exe',
                [
                  '/F',
                  '/IM',
                  'EADesktop.exe',
                  '/IM',
                  'EALauncher.exe',
                  '/IM',
                  'Link2EA.exe',
                  '/IM',
                  'EACefSubProcess.exe',
                  '/IM',
                  'EALocalHostSvc.exe',
                  '/IM',
                  'EABackgroundService.exe',
                ],
                { timeout: 4000, windowsHide: true },
                () => resolve(undefined)
              );
            });
          }
          return {
            closed: true,
            shutDown: true,
            platformId: 'steam',
            method: 'steam_shutdown_flag',
            binaryPath: steamBin,
            ...(cloudWaitResult ? { cloudSyncWait: cloudWaitResult } : {}),
          };
        } else if (targetPlatform === 'darwin') {
          if (
            typeof options.spawnFn === 'function' &&
            !options.execFileFn &&
            !options.execFileImpl
          ) {
            const child = spawnImpl(
              sessionEntry.steamClientBinaryPath ||
                '/Applications/Steam.app/Contents/MacOS/steam_osx',
              ['-shutdown'],
              { detached: true, stdio: 'ignore' }
            );
            if (child && typeof child.unref === 'function') child.unref();
            return {
              closed: true,
              shutDown: true,
              platformId: 'steam',
              method: 'steam_shutdown_flag',
              binaryPath: sessionEntry.steamClientBinaryPath || null,
              ...(cloudWaitResult ? { cloudSyncWait: cloudWaitResult } : {}),
            };
          }

          if (sessionEntry.steamClientBinaryPath) {
            const shutdownOk = await new Promise((resolve) => {
              try {
                execFileImpl(
                  sessionEntry.steamClientBinaryPath,
                  ['-shutdown'],
                  { timeout: 3000 },
                  (/** @type {any} */ err) => resolve(!err)
                );
              } catch {
                resolve(false);
              }
            });
            if (shutdownOk) {
              return {
                closed: true,
                shutDown: true,
                platformId: 'steam',
                method: 'steam_shutdown_flag',
                binaryPath: sessionEntry.steamClientBinaryPath,
                ...(cloudWaitResult ? { cloudSyncWait: cloudWaitResult } : {}),
              };
            }
          }

          const busyBeforeFallbackPkill = getBusyOrAbortedReason();
          if (busyBeforeFallbackPkill) {
            return { closed: false, shutDown: false, reason: busyBeforeFallbackPkill };
          }

          await new Promise((resolve) => {
            execFileImpl(
              '/usr/bin/pkill',
              ['-TERM', '-x', 'steam_osx'],
              { timeout: 2500 },
              () => resolve(undefined)
            );
          });
          return {
            closed: true,
            shutDown: true,
            platformId: 'steam',
            method: 'sigterm_quit',
            binaryPath: sessionEntry.steamClientBinaryPath || null,
            ...(cloudWaitResult ? { cloudSyncWait: cloudWaitResult } : {}),
          };
        }
      } catch {
        return {
          closed: false,
          shutDown: false,
          platformId: 'steam',
          reason: 'shutdown_command_failed',
        };
      }
    }

    if (platformId === 'epic' && sessionEntry.wokeEpicByLauncher === true) {
      const busyBeforeEpicKill = getBusyOrAbortedReason();
      if (busyBeforeEpicKill) {
        return { closed: false, shutDown: false, reason: busyBeforeEpicKill };
      }

      try {
        if (targetPlatform === 'win32') {
          if (
            typeof options.spawnFn === 'function' &&
            !options.execFileFn &&
            !options.execFileImpl
          ) {
            const child = spawnImpl('taskkill.exe', ['/IM', 'EpicGamesLauncher.exe'], {
              detached: true,
              stdio: 'ignore',
              windowsHide: true,
            });
            if (child && typeof child.unref === 'function') child.unref();
          } else {
            await new Promise((resolve) => {
              execFileImpl(
                'taskkill.exe',
                ['/IM', 'EpicGamesLauncher.exe'],
                { timeout: 4000, windowsHide: true },
                () => resolve(undefined)
              );
            });
          }

          if (!isTestEnvironment(options) || options.enableEpicForceKillFallback === true) {
            const waitMs = Math.max(0, Number(options.epicGracefulKillWaitMs ?? 3000));
            if (waitMs > 0) {
              await new Promise((resolve) => {
                let done = false;
                const finish = () => {
                  if (done) return;
                  done = true;
                  clearTimeout(t);
                  abortCtrl.signal.removeEventListener('abort', finish);
                  resolve(undefined);
                };
                const t = setTimeout(finish, waitMs);
                if (typeof t.unref === 'function') t.unref();
                abortCtrl.signal.addEventListener('abort', finish, { once: true });
              });
            }
            if (!getBusyOrAbortedReason()) {
              await new Promise((resolve) => {
                execFileImpl(
                  'taskkill.exe',
                  ['/F', '/IM', 'EpicGamesLauncher.exe'],
                  { timeout: 3000, windowsHide: true },
                  () => resolve(undefined)
                );
              });
            }
          }

          return {
            closed: true,
            shutDown: true,
            platformId: 'epic',
            method: 'taskkill_graceful',
            clientPath: sessionEntry.epicClientPath || null,
          };
        } else if (targetPlatform === 'darwin') {
          if (!isTestEnvironment(options) || options.preferOsascriptQuitOnDarwin === true) {
            const osaOk = await new Promise((resolve) => {
              try {
                execFileImpl(
                  '/usr/bin/osascript',
                  ['-e', 'tell application "Epic Games Launcher" to quit'],
                  { timeout: 4000 },
                  (/** @type {any} */ err) => resolve(!err)
                );
              } catch {
                resolve(false);
              }
            });
            if (osaOk) {
              return {
                closed: true,
                shutDown: true,
                platformId: 'epic',
                method: 'osascript_quit',
                clientPath: sessionEntry.epicClientPath || null,
              };
            }
          }

          const busyBeforeEpicPkill = getBusyOrAbortedReason();
          if (busyBeforeEpicPkill) {
            return { closed: false, shutDown: false, reason: busyBeforeEpicPkill };
          }

          await new Promise((resolve) => {
            execFileImpl(
              '/usr/bin/pkill',
              ['-TERM', '-x', 'EpicGamesLauncher'],
              { timeout: 2500 },
              () => resolve(undefined)
            );
          });
          return {
            closed: true,
            shutDown: true,
            platformId: 'epic',
            method: 'sigterm_quit',
            clientPath: sessionEntry.epicClientPath || null,
          };
        }
      } catch {
        return {
          closed: false,
          shutDown: false,
          platformId: 'epic',
          reason: 'shutdown_command_failed',
        };
      }
    }

    if (
      platformId === 'xbox' &&
      sessionEntry.wokeXboxAppByLauncher === true &&
      targetPlatform === 'win32'
    ) {
      const busyBeforeXboxKill = getBusyOrAbortedReason();
      if (busyBeforeXboxKill) {
        return { closed: false, shutDown: false, reason: busyBeforeXboxKill };
      }
      try {
        await new Promise((resolve) => {
          execFileImpl(
            'taskkill.exe',
            ['/IM', 'XboxPcApp.exe'],
            { timeout: 4000, windowsHide: true },
            () => resolve(undefined)
          );
        });
        return {
          closed: true,
          shutDown: true,
          platformId: 'xbox',
          method: 'taskkill_graceful',
          clientPath: sessionEntry.xboxClientPath || null,
        };
      } catch {
        return {
          closed: false,
          shutDown: false,
          platformId: 'xbox',
          reason: 'shutdown_command_failed',
        };
      }
    }

    const sessionChainedHandoff = resolveAnyChainedHandoffId(
      sessionEntry.chainedLauncherHandoff ||
        sessionEntry.chainedRequiresLauncherHandoff ||
        sessionEntry.chainedHandedOffTo ||
        sessionEntry.steamChainedPublisherHandoff ||
        sessionEntry.platformId
    );
    const wasPublisherWokenByLauncher = Boolean(
      sessionEntry.wokePublisherClientByLauncher === true ||
        sessionEntry.ephemeralClientWoken === true ||
        sessionEntry.wokeBottleSteamPublisherByLauncher === true ||
        (sessionEntry.wasRunningAtLaunch === false && Boolean(sessionChainedHandoff))
    );
    const sessionBottlePath = String(
      sessionEntry.winePrefix || sessionEntry.bottlePath || ''
    ).trim();

    if (
      targetPlatform === 'darwin' &&
      wasPublisherWokenByLauncher &&
      sessionBottlePath &&
      ['ea', 'ubisoft', 'bnet', 'rockstar'].includes(sessionChainedHandoff)
    ) {
      const resolvedBottlePrefix = path.resolve(sessionBottlePath);
      const hasOtherActiveSameBottleSession =
        (pendingBottleLaunches.get(resolvedBottlePrefix) || 0) > 0 ||
        Array.from(activeSessions.values()).some((other) => {
          if (!other || other === sessionEntry || other.finalized) return false;
          const otherPrefix = String(other.winePrefix || other.bottlePath || '').trim();
          return Boolean(otherPrefix && path.resolve(otherPrefix) === resolvedBottlePrefix);
        });
      const hasActivePublisherDownload = Array.from(downloadQueueMap.values()).some(
        (t) =>
          t &&
          (String(t.platformId || '').toLowerCase() === sessionChainedHandoff ||
            resolveAnyChainedHandoffId(t.chainedLauncherHandoff) === sessionChainedHandoff) &&
          (['downloading', 'queued', 'extracting', 'verifying'].includes(t.status) ||
            pausedByInGameTaskIds.has(t.taskId))
      );
      const busyBeforeBottlePubKill = getBusyOrAbortedReason();
      if (
        busyBeforeBottlePubKill ||
        hasOtherActiveSameBottleSession ||
        hasActivePublisherDownload
      ) {
        return {
          closed: false,
          shutDown: false,
          reason:
            busyBeforeBottlePubKill ||
            (hasOtherActiveSameBottleSession
              ? 'other_session_active'
              : 'active_download_in_progress'),
        };
      }

      /** @type {Record<string, string[]>} */
      const bottlePublisherDaemonExesByHandoff = {
        ea: [
          'eadesktop.exe',
          'eabackgroundservice.exe',
          'ealauncher.exe',
          'link2ea.exe',
          'eacefsubprocess.exe',
          'ealocalhostsvc.exe',
        ],
        ubisoft: [
          'upc.exe',
          'ubisoftconnect.exe',
          'ubisoftgamelauncher.exe',
          'ubisoftgamelauncher64.exe',
          'uplaywebcore.exe',
          'uplayservice.exe',
        ],
        bnet: ['battle.net.exe', 'battle.net launcher.exe', 'agent.exe', 'blizzardbrowser.exe'],
        rockstar: [
          'launcher.exe',
          'launcherpatcher.exe',
          'socialclubhelper.exe',
          'rockstarservice.exe',
        ],
      };
      const targetPubExes = bottlePublisherDaemonExesByHandoff[sessionChainedHandoff] || [];
      const bottleNormLower = resolvedBottlePrefix.replace(/\\/g, '/').toLowerCase();
      const killPidImpl =
        typeof options.killPidFn === 'function'
          ? options.killPidFn
          : (/** @type {number} */ pid, /** @type {string} */ sig) => process.kill(pid, sig);

      const readPsOutputAsync = async () => {
        if (typeof options.mockProcessListOutput === 'string') {
          return options.mockProcessListOutput;
        }
        if (typeof options.getProcessListOutput === 'function') {
          return String((await options.getProcessListOutput()) || '');
        }
        return await new Promise((resolve) => {
          try {
            execFileImpl(
              'ps',
              ['eww', '-axo', 'pid=,command='],
              { timeout: 2500 },
              (/** @type {any} */ err, /** @type {any} */ stdout) =>
                resolve(err ? '' : String(stdout || ''))
            );
          } catch {
            resolve('');
          }
        });
      };

      const findMatchingBottlePublisherPids = (/** @type {string} */ psText) => {
        /** @type {number[]} */
        const matched = [];
        for (const rawLine of String(psText || '').split(/\r?\n/)) {
          const m = rawLine.trim().match(/^(\d+)\s+(.+)$/);
          if (!m) continue;
          const cPid = Number.parseInt(m[1], 10);
          if (!(cPid > 1) || cPid === process.pid) continue;
          const cmdLower = m[2].replace(/\\/g, '/').toLowerCase();
          if (!cmdLower.includes(bottleNormLower)) continue;
          if (targetPubExes.some((exeName) => cmdLower.includes(exeName))) {
            matched.push(cPid);
          }
        }
        return matched;
      };

      try {
        const initialPs = await readPsOutputAsync();
        const pidsToTerminate = findMatchingBottlePublisherPids(initialPs);
        for (const pid of pidsToTerminate) {
          try {
            killPidImpl(pid, 'SIGTERM');
          } catch {}
        }
        const waitMs = Math.max(
          0,
          Number(options.bottlePublisherGracefulKillWaitMs ?? (isTestEnvironment(options) ? 0 : 800))
        );
        if (waitMs > 0 && pidsToTerminate.length > 0) {
          await new Promise((resolve) => {
            const t = setTimeout(resolve, waitMs);
            if (typeof t.unref === 'function') t.unref();
          });
          if (!getBusyOrAbortedReason()) {
            const followUpPs = await readPsOutputAsync();
            for (const stillPid of findMatchingBottlePublisherPids(followUpPs)) {
              try {
                killPidImpl(stillPid, 'SIGKILL');
              } catch {}
            }
          }
        }
        return {
          closed: true,
          shutDown: true,
          platformId: platformId || sessionChainedHandoff,
          chainedLauncherHandoff: sessionChainedHandoff,
          winePrefix: resolvedBottlePrefix,
          terminatedPids: pidsToTerminate,
          method: 'bottle_publisher_sigterm',
        };
      } catch {
        return {
          closed: false,
          shutDown: false,
          platformId: platformId || sessionChainedHandoff,
          reason: 'shutdown_command_failed',
        };
      }
    }

    if (
      sessionChainedHandoff === 'ea' &&
      wasPublisherWokenByLauncher &&
      targetPlatform === 'win32'
    ) {
      const hasOtherActiveEaSession = Array.from(activeSessions.values()).some(
        (other) =>
          other !== sessionEntry &&
          !other.finalized &&
          resolveAnyChainedHandoffId(other.chainedLauncherHandoff) === 'ea'
      );
      const hasActiveEaDownload = Array.from(downloadQueueMap.values()).some(
        (t) =>
          t &&
          (String(t.platformId || '').toLowerCase() === 'ea' ||
            resolveAnyChainedHandoffId(t.chainedLauncherHandoff) === 'ea') &&
          (['downloading', 'queued', 'extracting', 'verifying'].includes(t.status) ||
            pausedByInGameTaskIds.has(t.taskId))
      );
      const busyBeforeEaKill = getBusyOrAbortedReason();
      if (busyBeforeEaKill || hasOtherActiveEaSession || hasActiveEaDownload) {
        return {
          closed: false,
          shutDown: false,
          reason: busyBeforeEaKill || (hasOtherActiveEaSession ? 'other_session_active' : 'active_download_in_progress'),
        };
      }
      try {
        await new Promise((resolve) => {
          execFileImpl(
            'taskkill.exe',
            ['/IM', 'EADesktop.exe'],
            { timeout: 3000, windowsHide: true },
            () => resolve(undefined)
          );
        });
        const eaWaitMs = Math.max(
          0,
          Number(options.eaGracefulKillWaitMs ?? (isTestEnvironment(options) ? 0 : 1500))
        );
        if (eaWaitMs > 0) {
          await new Promise((resolve) => {
            const t = setTimeout(resolve, eaWaitMs);
            if (typeof t.unref === 'function') t.unref();
          });
        }
        if (!getBusyOrAbortedReason()) {
          await new Promise((resolve) => {
            execFileImpl(
              'taskkill.exe',
              [
                '/F',
                '/IM',
                'EADesktop.exe',
                '/IM',
                'EALauncher.exe',
                '/IM',
                'Link2EA.exe',
                '/IM',
                'EACefSubProcess.exe',
                '/IM',
                'EALocalHostSvc.exe',
                '/IM',
                'EABackgroundService.exe',
              ],
              { timeout: 4000, windowsHide: true },
              () => resolve(undefined)
            );
          });
        }
        return {
          closed: true,
          shutDown: true,
          platformId: platformId || 'ea',
          chainedLauncherHandoff: 'ea',
          method: 'taskkill_graceful',
        };
      } catch {
        return {
          closed: false,
          shutDown: false,
          platformId: platformId || 'ea',
          reason: 'shutdown_command_failed',
        };
      }
    }

    return { closed: false, shutDown: false, reason: 'not_woken_by_launcher' };
  } finally {
    if (platformId && pendingEphemeralShutdowns.get(platformId) === abortCtrl) {
      pendingEphemeralShutdowns.delete(platformId);
    }
  }
}

/**
 * Sync completed game session playtime to first-party storefront cloud APIs (Epic, GOG, Xbox)
 */
async function syncSessionPlaytimeToStorefront(
  /** @type {any} */ sessionInfo = {},
  /** @type {any} */ options = {}
) {
  const platformId = String(sessionInfo.platformId || 'custom').toLowerCase();
  const durationSeconds = Number(sessionInfo.durationSeconds || 0);
  const sessionMinutesPlayed = Number(
    sessionInfo.sessionMinutesPlayed !== undefined
      ? sessionInfo.sessionMinutesPlayed
      : durationSeconds > 0
        ? Math.max(1, Math.round(durationSeconds / 60))
        : 0
  );

  if (durationSeconds <= 0 || sessionMinutesPlayed <= 0) {
    return {
      synced: false,
      platformId,
      reason: 'zero_duration',
      storefrontTotalPlaytimeMinutes: null,
    };
  }

  const activeStoreSync = options.storeSync || getStoreSync();
  const savedTokens =
    options.savedTokens ||
    (activeStoreSync && typeof activeStoreSync.loadSavedTokens === 'function'
      ? activeStoreSync.loadSavedTokens()
      : {});

  if (platformId === 'epic') {
    let artifactId = String(sessionInfo.artifactId || sessionInfo.appName || '').trim();
    if (!artifactId) {
      try {
        const resolved = resolveEpicAppAndPlatforms(sessionInfo, options);
        if (resolved?.resolvedAppName) {
          artifactId = String(resolved.resolvedAppName).trim();
        }
      } catch {}
    }
    if (!artifactId) {
      artifactId = String(sessionInfo.platformGameId || sessionInfo.gameId || '')
        .replace(/^epic-/i, '')
        .trim();
    }

    const legAuth = await ensureLegendaryConfigAndAuth(options).catch(() => null);
    let accessToken =
      legAuth?.accessToken ||
      savedTokens?.epic?.access_token ||
      options.epicAccessToken ||
      null;
    let refreshToken =
      legAuth?.refreshToken ||
      savedTokens?.epic?.refresh_token ||
      options.epicRefreshToken ||
      null;
    let accountId =
      legAuth?.accountId ||
      savedTokens?.epic?.account_id ||
      options.epicAccountId ||
      '';

    if ((!accessToken || !accountId || !refreshToken) && legAuth?.legendaryConfigPath) {
      const userJsonFile = path.join(legAuth.legendaryConfigPath, 'user.json');
      if (fs.existsSync(userJsonFile)) {
        try {
          const parsedUser = JSON.parse(fs.readFileSync(userJsonFile, 'utf8'));
          accessToken = accessToken || parsedUser?.access_token || null;
          refreshToken = refreshToken || parsedUser?.refresh_token || null;
          accountId = accountId || parsedUser?.account_id || parsedUser?.in_app_id || '';
        } catch {}
      }
    }

    if (!accessToken || !accountId || !artifactId) {
      return {
        synced: false,
        platformId: 'epic',
        reason: 'missing_credentials_or_artifact',
        storefrontTotalPlaytimeMinutes: null,
      };
    }

    const endMs = sessionInfo.endedAt ? new Date(sessionInfo.endedAt).getTime() : Date.now();
    const validEndMs = Number.isNaN(endMs) ? Date.now() : endMs;
    const startMs = sessionInfo.startedAt
      ? new Date(sessionInfo.startedAt).getTime()
      : validEndMs - durationSeconds * 1000;
    const validStartMs =
      Number.isNaN(startMs) || startMs >= validEndMs
        ? validEndMs - durationSeconds * 1000
        : startMs;

    const startTimeIso = new Date(validStartMs).toISOString();
    const endTimeIso = new Date(validEndMs).toISOString();
    const machineId =
      options.machineId ||
      (typeof crypto.randomUUID === 'function'
        ? crypto.randomUUID()
        : crypto.randomBytes(16).toString('hex'));

    const putUrl = `https://library-service.live.use1a.on.epicgames.com/library/api/public/playtime/account/${encodeURIComponent(accountId)}`;
    const putBody = JSON.stringify({
      machineId,
      artifactId,
      startTime: startTimeIso,
      endTime: endTimeIso,
      startSegment: true,
      endSegment: true,
    });

    const executePut = (/** @type {string} */ token) =>
      performJsonHttpRequest(
        putUrl,
        {
          method: 'PUT',
          timeoutMs: 4000,
          headers: {
            Authorization: `bearer ${token}`,
            'Content-Type': 'application/json',
            Accept: 'application/json',
            'User-Agent':
              'UELauncher/11.0.1-14907503+++Portal+Release-Live Windows/10.0.19041.1.256.64bit',
          },
          body: putBody,
        },
        options.fetchFn
      );

    let putRes = await executePut(accessToken);

    if (!putRes.ok && (putRes.status === 401 || putRes.status === 403 || putRes.status === 400)) {
      const renewFn =
        options.renewEpicTokensFn ||
        (activeStoreSync && typeof activeStoreSync.renewEpicTokens === 'function'
          ? activeStoreSync.renewEpicTokens
          : null);
      let refreshedToken = null;
      if (refreshToken && typeof renewFn === 'function') {
        try {
          const renewed = await renewEpicTokensSingleFlight(refreshToken, (tok) => renewFn(tok));
          if (renewed?.access_token) {
            refreshedToken = renewed.access_token;
            if (activeStoreSync && typeof activeStoreSync.saveTokens === 'function') {
              try {
                activeStoreSync.saveTokens(
                  'epic',
                  {
                    ...(savedTokens?.epic || {}),
                    ...renewed,
                    account_id: renewed.account_id || accountId,
                  },
                  options
                );
              } catch {}
            }
          }
        } catch {}
      }
      if (!refreshedToken) {
        const forcedAuth = await ensureLegendaryConfigAndAuth({
          ...options,
          forceTokenRefresh: true,
        }).catch(() => null);
        if (forcedAuth?.accessToken && forcedAuth.accessToken !== accessToken) {
          refreshedToken = forcedAuth.accessToken;
        }
      }
      if (refreshedToken) {
        accessToken = refreshedToken;
        putRes = await executePut(accessToken);
      }
    }

    let storefrontTotalPlaytimeMinutes = null;
    const allUrl = `https://library-service.live.use1a.on.epicgames.com/library/api/public/playtime/account/${encodeURIComponent(accountId)}/all`;
    const getRes = await performJsonHttpRequest(
      allUrl,
      {
        method: 'GET',
        timeoutMs: 4000,
        headers: {
          Authorization: `bearer ${accessToken}`,
          Accept: 'application/json',
          'User-Agent':
            'UELauncher/11.0.1-14907503+++Portal+Release-Live Windows/10.0.19041.1.256.64bit',
        },
      },
      options.fetchFn
    );

    if (getRes.ok && Array.isArray(getRes.data)) {
      const matchedItem = getRes.data.find(
        (/** @type {any} */ item) =>
          item &&
          String(item.artifactId || '').toLowerCase() === String(artifactId).toLowerCase()
      );
      if (matchedItem && typeof matchedItem.totalTime === 'number' && matchedItem.totalTime > 0) {
        storefrontTotalPlaytimeMinutes = Math.max(1, Math.round(matchedItem.totalTime / 60));
      }
    }

    return {
      synced: Boolean(putRes.ok),
      platformId: 'epic',
      artifactId,
      storefrontTotalPlaytimeMinutes,
    };
  }

  if (platformId === 'gog') {
    const rawGogId = String(sessionInfo.platformGameId || sessionInfo.gameId || '')
      .replace(/^gog[-_]/i, '')
      .trim();
    let numericGameId = /^\d+$/.test(rawGogId) ? rawGogId : '';

    const searchDirs = [];
    if (sessionInfo.installPath) {
      searchDirs.push(toLocalFsPath(sessionInfo.installPath));
    }
    if (sessionInfo.executablePath) {
      searchDirs.push(path.dirname(toLocalFsPath(sessionInfo.executablePath)));
    }

    for (const dir of searchDirs) {
      if (numericGameId) break;
      if (!dir || !fs.existsSync(dir)) continue;
      try {
        const files = fs.readdirSync(dir);
        const infoFile = files.find((f) => /^goggame-\d+\.info$/i.test(f));
        if (infoFile) {
          const match = infoFile.match(/^goggame-(\d+)\.info$/i);
          if (match && match[1]) {
            numericGameId = match[1];
          }
        }
      } catch {}
    }

    const gogAuth = await ensureGogdlAuthConfig(options).catch(() => null);
    let accessToken =
      gogAuth?.accessToken ||
      savedTokens?.gog?.access_token ||
      options.gogAccessToken ||
      null;
    const refreshToken =
      gogAuth?.refreshToken ||
      savedTokens?.gog?.refresh_token ||
      options.gogRefreshToken ||
      null;
    let userId =
      gogAuth?.userId ||
      savedTokens?.gog?.user_id ||
      savedTokens?.gog?.userId ||
      options.gogUserId ||
      '';

    if (!userId && accessToken && String(accessToken).split('.').length === 3) {
      try {
        const payloadB64 = String(accessToken).split('.')[1];
        const decoded = JSON.parse(Buffer.from(payloadB64, 'base64').toString('utf8'));
        userId = String(decoded?.sub || decoded?.user_id || '').trim();
      } catch {}
    }

    if (!accessToken || !userId || !numericGameId) {
      return {
        synced: false,
        platformId: 'gog',
        reason: 'missing_credentials_or_game_id',
        storefrontTotalPlaytimeMinutes: null,
      };
    }

    const startMs = sessionInfo.startedAt
      ? new Date(sessionInfo.startedAt).getTime()
      : Date.now() - durationSeconds * 1000;
    const sessionDateSec = Math.floor(
      (Number.isNaN(startMs) ? Date.now() - durationSeconds * 1000 : startMs) / 1000
    );
    const timeMinutes = Math.max(1, sessionMinutesPlayed || Math.round(durationSeconds / 60));

    const postUrl = `https://gameplay.gog.com/clients/${encodeURIComponent(numericGameId)}/users/${encodeURIComponent(userId)}/sessions`;
    const postBody = JSON.stringify({
      session_date: sessionDateSec,
      time: timeMinutes,
    });

    const executePost = (/** @type {string} */ token) =>
      performJsonHttpRequest(
        postUrl,
        {
          method: 'POST',
          timeoutMs: 4000,
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
            Accept: 'application/json',
          },
          body: postBody,
        },
        options.fetchFn
      );

    let postRes = await executePost(accessToken);

    if (!postRes.ok && (postRes.status === 401 || postRes.status === 403) && refreshToken) {
      const renewGogFn =
        options.renewGogTokensFn ||
        (activeStoreSync && typeof activeStoreSync.renewGogTokens === 'function'
          ? activeStoreSync.renewGogTokens
          : null);
      if (typeof renewGogFn === 'function') {
        try {
          const renewed = await renewGogTokensSingleFlight(refreshToken, (tok) => renewGogFn(tok));
          if (renewed?.access_token) {
            accessToken = renewed.access_token;
            if (activeStoreSync && typeof activeStoreSync.saveTokens === 'function') {
              try {
                activeStoreSync.saveTokens(
                  'gog',
                  {
                    ...(savedTokens?.gog || {}),
                    ...renewed,
                    user_id: renewed.user_id || userId,
                  },
                  options
                );
              } catch {}
            }
            postRes = await executePost(accessToken);
          }
        } catch {}
      }
    }

    let storefrontTotalPlaytimeMinutes = null;
    if (postRes.data && typeof postRes.data === 'object') {
      const candidateTotal =
        postRes.data.total_time ??
        postRes.data.totalPlaytimeMinutes ??
        postRes.data.playtime;
      if (typeof candidateTotal === 'number' && candidateTotal > 0) {
        storefrontTotalPlaytimeMinutes = Math.max(1, Math.round(candidateTotal));
      }
    }

    return {
      synced: Boolean(postRes.ok),
      platformId: 'gog',
      gameId: numericGameId,
      storefrontTotalPlaytimeMinutes,
    };
  }

  if (platformId === 'steam') {
    return {
      synced: true,
      platformId: 'steam',
      storefrontTotalPlaytimeMinutes: null,
    };
  }

  if (platformId === 'xbox') {
    try {
      let titleId = String(sessionInfo.xboxTitleId || '').trim();
      if (!titleId && sessionInfo.installPath) {
        const cfg = inspectMicrosoftGameConfig(sessionInfo.installPath);
        if (cfg) {
          titleId = cfg.titleIdDecimal || cfg.titleId || '';
        }
      }
      let titleIdDecimal = titleId;
      if (
        titleId &&
        !/^\d+$/.test(titleId) &&
        /^[0-9a-fA-F]{1,8}$/.test(titleId.replace(/^0x/i, ''))
      ) {
        titleIdDecimal = String(parseInt(titleId.replace(/^0x/i, ''), 16));
      }

      const authProvider =
        options.xboxAuthProvider ||
        (activeStoreSync && typeof activeStoreSync.getXboxAuthProvider === 'function'
          ? activeStoreSync.getXboxAuthProvider({
              userDataDir: getUserDataDir(options.userDataDir),
            })
          : null);
      const session =
        options.xboxSession ||
        (authProvider && typeof authProvider.getValidXboxSession === 'function'
          ? await authProvider.getValidXboxSession().catch(() => null)
          : null);

      const xboxMods = getXboxStorefrontModules();
      if (
        !titleIdDecimal ||
        !session ||
        !session.xuid ||
        !session.authorizationHeader ||
        !xboxMods?.xboxAchievementsAndStats?.fetchXboxPlaytimeBatch
      ) {
        return {
          synced: false,
          platformId: 'xbox',
          reason: !titleIdDecimal ? 'missing_title_id' : 'missing_xbox_auth',
          storefrontTotalPlaytimeMinutes: null,
        };
      }

      const playtimeMap = await xboxMods.xboxAchievementsAndStats.fetchXboxPlaytimeBatch({
        xuid: session.xuid,
        authorizationHeader: session.authorizationHeader,
        titleIds: [titleIdDecimal],
        fetchImpl: options.fetchImpl,
      });
      const remoteMinutes = Number(
        (playtimeMap instanceof Map ? playtimeMap.get(titleIdDecimal) : 0) || 0
      );
      return {
        synced: true,
        platformId: 'xbox',
        storefrontTotalPlaytimeMinutes: Math.max(sessionMinutesPlayed, remoteMinutes),
      };
    } catch (/** @type {any} */ err) {
      return {
        synced: false,
        platformId: 'xbox',
        reason: err?.message || 'xbox_playtime_sync_failed',
        storefrontTotalPlaytimeMinutes: null,
      };
    }
  }

  return {
    synced: false,
    platformId,
    reason: 'unsupported_platform',
    storefrontTotalPlaytimeMinutes: null,
  };
}


async function replayPendingCloudUploadsForSupervisor(/** @type {any} */ options = {}) {
  return replayPendingCloudUploads(
    { syncGogCloudSaves, syncEpicCloudSaves, syncXboxCloudSaves },
    options
  );
}


module.exports = {
  hasActivePostSessionWork,
  waitForActivePostSessionWork,
  syncGogCloudSaves,
  syncEpicCloudSaves,
  waitForSteamColdStartupCloudReady,
  waitForSteamCloudSyncCompletion,
  resolveSteamClientBinaryPath,
  detectInstalledStorefrontClients,
  resolveSteamClientLaunchCommand,
  shutdownEphemeralStorefrontClient,
  syncSessionPlaytimeToStorefront,
  replayPendingCloudUploadsForSupervisor,
};
