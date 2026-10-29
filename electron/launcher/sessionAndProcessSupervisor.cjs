const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { spawn, exec, execFile } = require('node:child_process');

const {
  isProcessAlive,
  waitForProcessExit,
  extractMatchedPidFromProcessOutput,
  signalSubprocessTree,
} = require('./processTreeUtils.cjs');
const {
  toHostFilesystemPath,
  atomicWriteFileSync,
  resolveHostWindowsKnownFolders,
} = require('./securityAndPathUtils.cjs');
const {
  resolveBottleSteamExe,
  resolveBundledXboxWinLauncherExePath,
  stageWindowsClientlessXboxBridgeDlls,
  restoreWindowsClientlessXboxBridgeDlls,
  prepareXboxBottleEnvironment,
} = require('./wineAndCrossOverManager.cjs');
const {
  discoverWindowsSteamRegistryPaths,
} = require('../utils/windowsRegistryDiscovery.cjs');
const {
  isHostGogGalaxyRunning,
  reapOrphanedGogOverlayProcesses,
  isBottleWinExeRunning,
  probeLocalTcpPort,
  resolveGogCommunicationLogPath,
  waitForGogCommunicationServiceReady,
  waitForGogPostExitFlush,
  waitForBottleEpicPortalReady,
  extractTrackedPidFromSteamGameProcessLog,
} = require('./storefrontReadinessBarrier.cjs');
const {
  inspectWindowsExecutableHeader,
  isCompatibleX86OrX64PeHeader,
  parseSteamAcf,
  deriveDefaultScidFromTitleId,
  inspectMicrosoftGameConfig,
  inspectAppxManifest,
} = require('./binaryAndManifestInspectors.cjs');
const {
  normalizePosixUtf8Locale,
  syncXboxCloudSaves,
  pruneCloudSaveStateForGame,
  buildCloudSyncTelemetryPayload,
  createCloudSaveRunner,
} = require('./cloudSaveEngine.cjs');

const {
  getStoreSync,
  getXboxStorefrontModules,
  diagLog,
  getOfflineVaultLifecycleHooks,
  getUserDataDir,
  isTestEnvironment,
  resolveIsolatedHomedirAndUserData,
  emitSessionUpdated,
  activeSessions,
  inFlightPostSessionByGame,
  pendingBottleLaunches,
  inFlightPostSessionByBottle,
  pendingEphemeralShutdowns,
  pendingStorefrontLaunches,
  downloadQueueMap,
  pausedByInGameTaskIds,
  inFlightPostSessionPromises,
  recentDisplaySanitizeCache,
  setBoundedMapEntry,
  evictExecutableDiscoveryCacheForPath,
  trimLauncherEngineMemory,
  invalidateScanCaches,
  toLocalFsPath,
  resolveWindowsNodeShebangSpawn,
  openExternalUri,
  resolveHostLocaleInfo,
  clearMacQuarantineAsync,
  findLegendaryBinary,
  findGogdlBinary,
  hasManagedInstallSentinel,
  loadManagedInstalledGames,
  saveManagedInstalledGames,
  normalizeStorefrontClientLifecycle,
  resolvePlatformLaunchConfig,
  getGameLaunchConfigs,
  resolveEffectivePerformancePolicy,
  isSafeToDeleteInstallPath,
  safeIsNumericAppId,
} = require('./engineStateRegistry.cjs');

const {
  findBestX86OrX64WindowsExe,
  isWindowsAppsProtectedPath,
  hasXboxClientlessReceipt,
  queryTargetedAppxPackageAsync,
  ensureWindowsXboxAppxRegisteredAsync,
  removeTargetedAppxPackageVerifiedAsync,
  isWindowsXboxAppRunning,
  activateWindowsXboxApplication,
  resolveXboxClientBinaryPath,
} = require('./windowsXboxAppxAndMsixvcOrchestrator.cjs');

const {
  isExcludedExecutable,
  ensureMacExecutablePermissions,
  resolveTargetMacAppBundlePath,
  readMacBundleIdFromInfoPlist,
  ensureMacAppCodeSignatureValidAsync,
  doesGogInstallUseGalaxySdk,
  resolveMacAppBundleBinary,
  flattenGogNestedInstallDir,
  findPrimaryExecutable,
  resolveSteamAppInfoLaunchSpec,
  resolveDefaultEngineLaunchArguments,
  discoverSteamLocations,
  extractBottleRootFromPath,
  removeSteamAppFromLibraryFoldersVdf,
  cleanupCrossOverSteamShortcuts,
  listBottleSubdirectories,
  detectCompatibilityLayers,
  resolveWineLayerMoltenVkPath,
  doesWineLayerHaveMoltenVkHudDeadlock,
  ensureWineMetalPreloadDylib,
  resolveSipSafeWineBinaryAndPreloadEnv,
  resolveWineserverBinary,
  shutdownWinePrefix,
  resolveBottleGogGalaxyExe,
  resolveBottleEpicLauncherExe,
  sanitizeWinePrefixDisplayConfigs,
  ensureCompatibilityLayerReady,
} = require('./macNativeInstallerAndCodesign.cjs');

const {
  unregisterEpicFirstPartyLauncher,
  getLegendaryConfigDir,
  ensureLegendaryConfigAndAuth,
  collectLocalEpicMetadataAndSupport,
  resolveEpicAppAndPlatforms,
  performJsonHttpRequest,
  resolveEpicLaunchAuthArguments,
  resolveEpicClientBinaryPath,
} = require('./epicLegendaryAndEosCoordinator.cjs');

const {
  syncGogGameToGalaxy,
  unregisterGogFirstPartyLauncher,
  ensureGogdlAuthConfig,
  ensureGogGalaxyBackgroundService,
  resolveGogGalaxyClientBinaryPath,
  clearStaleGogdlManifestCache,
  fetchGogV1Json,
} = require('./gogRegistryAndDirectInstaller.cjs');

const {
  shutdownDownloadEngine,
  pauseActiveDownloadsForInGame,
  resumeDownloadsPausedByInGame,
} = require('./downloadQueueCoordinator.cjs');

/**
 * Quote-aware command-line launch argument tokenizer.
 * Preserves inline quoted substrings (e.g., `--mod="path with spaces"` -> `['--mod=path with spaces']`),
 * supports single and double quotes, and handles `\"` / `\\` escapes inside double quotes without
 * corrupting Windows directory backslashes (`C:\Games\My Mod`).
 *
 * @param {string} argString
 * @returns {string[]}
 */
function parseLaunchArguments(argString) {
  if (!argString || typeof argString !== 'string') return [];
  /** @type {string[]} */
  const args = [];
  let current = '';
  let hasTokenChars = false;
  let inSingle = false;
  let inDouble = false;

  for (let i = 0; i < argString.length; i++) {
    const ch = argString[i];

    if (inSingle) {
      if (ch === "'") {
        inSingle = false;
      } else {
        current += ch;
      }
      continue;
    }

    if (inDouble) {
      if (ch === '"') {
        inDouble = false;
      } else if (ch === '\\' && i + 1 < argString.length) {
        const next = argString[i + 1];
        if (next === '"' || next === '\\') {
          current += next;
          i++;
        } else {
          current += ch;
        }
      } else {
        current += ch;
      }
      continue;
    }

    if (/\s/.test(ch)) {
      if (hasTokenChars) {
        args.push(current);
        current = '';
        hasTokenChars = false;
      }
      continue;
    }

    if (ch === '"') {
      inDouble = true;
      hasTokenChars = true;
      continue;
    }

    if (ch === "'") {
      inSingle = true;
      hasTokenChars = true;
      continue;
    }

    if (ch === '\\' && i + 1 < argString.length) {
      const next = argString[i + 1];
      if (next === '"' || next === "'") {
        current += next;
        hasTokenChars = true;
        i++;
        continue;
      }
    }

    current += ch;
    hasTokenChars = true;
  }

  if (hasTokenChars) {
    args.push(current);
  }

  return args;
}

/**
 * Build Storefront URI for protocol-based launching
 */
function buildStorefrontLaunchUri(/** @type {any} */ payload = {}) {
  const platformId = payload.platformId || 'steam';
  const gameId = payload.platformGameId || payload.steamAppId || payload.gameId;
  if (platformId === 'steam') {
    const appId = payload.steamAppId || payload.platformGameId;
    return appId ? `steam://rungameid/${appId}` : null;
  }
  if (platformId === 'gog') {
    const cleanGogId = String(gameId || '')
      .trim()
      .replace(/^gog[-_]/i, '');
    return cleanGogId ? `goggalaxy://launchGame/gog_${cleanGogId}` : null;
  }
  if (platformId === 'epic') {
    return gameId
      ? `com.epicgames.launcher://apps/${encodeURIComponent(String(gameId))}?action=launch&silent=true`
      : null;
  }
  if (platformId === 'xbox') {
    const cleanXboxId = String(payload.xboxProductId || gameId || '')
      .trim()
      .replace(/^xbox[-_]/i, '');
    return cleanXboxId ? `msxbox://game/?productId=${encodeURIComponent(cleanXboxId)}` : null;
  }
  return null;
}

function trackPostSessionPromise(/** @type {any} */ promise) {
  if (!promise || typeof promise.finally !== 'function') {
    return Promise.resolve(promise);
  }
  inFlightPostSessionPromises.add(promise);
  promise.finally(() => {
    inFlightPostSessionPromises.delete(promise);
  });
  return promise;
}

function killPosixProcessesMatchingWinExe(
  /** @type {string} */ exePath,
  /** @type {NodeJS.Signals} */ signal = 'SIGTERM',
  scopeHint = ''
) {
  return new Promise((resolve) => {
    if (!exePath || process.platform === 'win32') return resolve(undefined);
    const exeBase = path.basename(exePath);
    if (
      !exeBase ||
      exeBase.length <= 3 ||
      /^(?:steam|galaxyclient|epicgameslauncher)\.exe$/i.test(exeBase)
    ) {
      return resolve(undefined);
    }
    const escapedBase = exeBase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const exactTokenRe = new RegExp(`(?:^|[\\\\/\\s"'])${escapedBase}(?:\\s|["']|$)`, 'i');
    const normScope = scopeHint ? String(scopeHint).replace(/\\/g, '/').toLowerCase() : '';
    try {
      execFile('ps', ['-axo', 'pid=,command='], { timeout: 1500 }, (err, stdout) => {
        if (err || !stdout) return resolve(undefined);
        for (const rawLine of String(stdout).split(/\r?\n/)) {
          const m = rawLine.trim().match(/^(\d+)\s+(.+)$/);
          if (!m) continue;
          const candidatePid = Number.parseInt(m[1], 10);
          const cmd = m[2].trim();
          if (!candidatePid || candidatePid <= 1 || candidatePid === process.pid) continue;
          if (
            /^(?:\/bin\/|\/usr\/bin\/)?(?:ps|pkill|pgrep|grep|rg|vim|nvim|nano|less|tail|cat)\b/i.test(
              cmd
            )
          ) {
            continue;
          }
          if (!exactTokenRe.test(cmd)) continue;
          const lowerCmd = cmd.replace(/\\/g, '/').toLowerCase();
          const hasWineOrPathContext =
            (normScope && lowerCmd.includes(normScope)) ||
            /(?:wine|crossover|gameportingtoolkit|drive_c|[a-z]:\/)/i.test(lowerCmd);
          if (!hasWineOrPathContext) continue;
          try {
            process.kill(candidatePid, signal);
          } catch {}
        }
        resolve(undefined);
      });
    } catch {
      resolve(undefined);
    }
  });
}

function isMacSipProtectedExecutableOrScript(/** @type {string} */ binPath) {
  if (!binPath || typeof binPath !== 'string') return false;
  const resolved = path.resolve(binPath);
  const isSipPath = (/** @type {string} */ p) =>
    p.startsWith('/usr/bin/') ||
    p.startsWith('/bin/') ||
    p.startsWith('/sbin/') ||
    p.startsWith('/System/');
  if (isSipPath(resolved)) return true;
  /** @type {number | null} */
  let fd = null;
  try {
    if (!fs.existsSync(resolved)) return false;
    fd = fs.openSync(resolved, 'r');
    const head = Buffer.alloc(128);
    const bytesRead = fs.readSync(fd, head, 0, 128, 0);
    if (bytesRead >= 2 && head[0] === 0x23 && head[1] === 0x21) {
      const firstLine = head.subarray(2, bytesRead).toString('utf8').split(/\r?\n/)[0].trim();
      const interp = firstLine.split(/\s+/)[0] || '';
      if (isSipPath(interp)) return true;
    }
  } catch {
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {}
    }
  }
  return false;
}

/**
 * Determine whether a Windows spawn error genuinely requires UAC elevation (`ERROR_ELEVATION_REQUIRED` / 740).
 * Never triggers `-Verb RunAs` on generic libuv `UV_UNKNOWN` (-4094) or `WindowsApps` ACL errors for
 * real PE binaries unless the executable's PE `RT_MANIFEST` (or `.manifest` sidecar) requests elevation.
 */
function isWindowsElevationRequiredError(
  /** @type {any} */ err,
  exePath = '',
  /** @type {any} */ _options = {}
) {
  if (!err || typeof err !== 'object') return false;
  const msg = String(err.message || '');
  if (err.errno === 740 || /\b740\b|elevation/i.test(msg)) {
    return true;
  }
  if (exePath && isWindowsAppsProtectedPath(exePath)) {
    return false;
  }
  if (exePath && fs.existsSync(exePath)) {
    const peInfo = inspectWindowsExecutableHeader(exePath, { inspectElevationManifest: true });
    if (peInfo && peInfo.exists && peInfo.isValidPe && !peInfo.isSyntheticStub) {
      if (!('requiresElevation' in peInfo && peInfo.requiresElevation)) {
        return false;
      }
      return (
        err.code === 'EACCES' ||
        err.code === 'UNKNOWN' ||
        err.errno === -4094 ||
        err.errno === -4092 ||
        /eacces/i.test(msg)
      );
    }
  }
  return err.code === 'EACCES' || err.errno === -4094 || /eacces/i.test(msg);
}

function spawnWindowsViaPowerShellStartProcess(
  /** @type {any} */ gameSpawnImpl,
  /** @type {string} */ spawnCmd,
  /** @type {string[]} */ spawnArgs,
  /** @type {string} */ effectiveCwd,
  /** @type {Record<string, any>} */ baseEnv,
  requireRunAs = false
) {
  const psEnv = {
    ...baseEnv,
    ONE_LAUNCHER_PS_EXE: String(spawnCmd),
    ONE_LAUNCHER_PS_CWD: String(effectiveCwd),
    ONE_LAUNCHER_PS_ARGS_JSON: JSON.stringify(
      Array.isArray(spawnArgs) ? spawnArgs.map(String) : []
    ),
  };
  const verbClause = requireRunAs ? ' -Verb RunAs' : '';
  const psScript = [
    '$exe = $env:ONE_LAUNCHER_PS_EXE',
    '$wd = $env:ONE_LAUNCHER_PS_CWD',
    '$rawArgs = $env:ONE_LAUNCHER_PS_ARGS_JSON',
    '$argList = @()',
    'if ($rawArgs) { $parsed = ConvertFrom-Json -InputObject $rawArgs; if ($parsed -is [array]) { $argList = [string[]]$parsed } elseif ($null -ne $parsed) { $argList = @([string]$parsed) } }',
    `if ($argList.Count -gt 0) { $p = Start-Process -FilePath $exe -WorkingDirectory $wd -ArgumentList $argList${verbClause} -PassThru } else { $p = Start-Process -FilePath $exe -WorkingDirectory $wd${verbClause} -PassThru }`,
    "if ($null -ne $p) { [Console]::Out.WriteLine('OL_ELEVATED_PID=' + $p.Id); [Console]::Out.Flush(); try { $p.WaitForExit() } catch { Wait-Process -Id $p.Id -ErrorAction SilentlyContinue }; try { if ($null -ne $p.ExitCode) { exit $p.ExitCode } } catch {} }",
    'exit 0',
  ].join('; ');
  const child = gameSpawnImpl(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', psScript],
    {
      cwd: effectiveCwd,
      env: psEnv,
      detached: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    }
  );
  if (child && typeof child === 'object') {
    child._isPowerShellStartProcessWrapper = true;
    child._requireRunAs = Boolean(requireRunAs);
  }
  return child;
}

function hasActivePostSessionWork() {
  return inFlightPostSessionPromises.size > 0;
}

async function waitForActivePostSessionWork(timeoutMs = 10000) {
  if (inFlightPostSessionPromises.size === 0) {
    return { completed: true, remaining: 0 };
  }
  const activeSnapshot = Array.from(inFlightPostSessionPromises);
  const safeTimeoutMs = Math.max(250, Math.min(30000, Number(timeoutMs) || 10000));
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
  return {
    completed: !timedOut && inFlightPostSessionPromises.size === 0,
    remaining: inFlightPostSessionPromises.size,
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

/**
 * Finalize an active game session, compute playtime, run ordered post-exit cloud sync + prefix shutdown, and emit stop event
 */
function finalizeGameSession(/** @type {string} */ gameId, /** @type {any} */ options = {}) {
  const entry = activeSessions.get(gameId);
  if (!entry || entry.finalized) return null;
  entry.finalized = true;

  if (entry.pollTimer) {
    clearInterval(entry.pollTimer);
    entry.pollTimer = null;
  }

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
  const crashedEarly =
    !entry.stoppedByUser &&
    entry.exitCode !== null &&
    entry.exitCode !== undefined &&
    entry.exitCode !== 0 &&
    elapsedMs < 30000;

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

  if (entry.postExitCommand) {
    try {
      exec(entry.postExitCommand, { timeout: 5000, windowsHide: true }, () => {});
    } catch {}
  }

  const mergedOptions = {
    ...(entry.launchOptions || {}),
    ...(options || {}),
  };
  const effectivePerfPolicy = resolveEffectivePerformancePolicy(
    entry.launchConfig || {},
    mergedOptions
  );

  const stoppedSession = {
    ...entry.session,
    status: 'stopping',
  };

  const willRunPostExitCloudSync = Boolean(
    !crashedEarly &&
      ((stoppedSession.platformId === 'epic' && entry.session?.launchMethod !== 'storefront_uri') ||
        (stoppedSession.platformId === 'gog' && entry.session?.launchMethod !== 'storefront_uri') ||
        (stoppedSession.platformId === 'xbox' && entry.session?.launchMethod !== 'storefront_uri') ||
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

  // 1. Run post-exit Cloud Save uploads & Bottle Steam cloud_log barrier FIRST (before wineserver -k!)
  /** @type {Promise<any>} */
  let epicCloudSaveSyncPromise = Promise.resolve({ synced: false });
  if (
    !crashedEarly &&
    stoppedSession.platformId === 'epic' &&
    entry.session?.launchMethod !== 'storefront_uri'
  ) {
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
        .then((/** @type {any} */ res) => {
          emitCloudSyncTelemetry('post_exit', res);
          return res;
        })
        .catch((/** @type {any} */ err) => {
          const failRes = {
            synced: false,
            reason: err && err.message ? err.message : 'sync_failed',
          };
          emitCloudSyncTelemetry('post_exit', failRes);
          return failRes;
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
        .then((/** @type {any} */ res) => {
          emitCloudSyncTelemetry('post_exit', res);
          return res;
        })
        .catch((/** @type {any} */ err) => {
          const failRes = {
            synced: false,
            reason: err && err.message ? err.message : 'sync_failed',
          };
          emitCloudSyncTelemetry('post_exit', failRes);
          return failRes;
        })
    );
  }

  /** @type {Promise<any>} */
  let xboxCloudSaveSyncPromise = Promise.resolve({ synced: false });
  if (stoppedSession.platformId === 'xbox' || entry.xboxLoopbackServer) {
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
          emitCloudSyncTelemetry('post_exit', failRes);
          return failRes;
        } finally {
          if (entry.xboxLoopbackServer && typeof entry.xboxLoopbackServer.close === 'function') {
            try {
              await entry.xboxLoopbackServer.close();
            } catch {}
            entry.xboxLoopbackServer = null;
          }
        }
      })()
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
              execFileImpl(
                entry.wineBinary,
                [entry.bottleSteamExe, '-shutdown'],
                {
                  env: {
                    ...(entry.launchEnv || process.env),
                    ...(entry.winePrefix ? { WINEPREFIX: entry.winePrefix } : {}),
                  },
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
              execFileImpl(
                entry.wineBinary,
                [entry.bottleGogExe, '/command=shutdown'],
                {
                  env: {
                    ...(entry.launchEnv || process.env),
                    ...(entry.winePrefix ? { WINEPREFIX: entry.winePrefix } : {}),
                  },
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
                execFileImpl(
                  entry.wineBinary,
                  args,
                  {
                    env: {
                      ...(entry.launchEnv || process.env),
                      ...(entry.winePrefix ? { WINEPREFIX: entry.winePrefix } : {}),
                    },
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
            await new Promise((r) => setTimeout(r, 3500));
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
  if (
    !crashedEarly &&
    stoppedSession.platformId === 'steam' &&
    !entry.bottleSteamRoot &&
    !entry.wokeSteamByLauncher &&
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
  const hasActiveBottleStorefrontClient = Boolean(
    entry.launchedViaBottleSteam ||
      entry.wokeBottleGogByLauncher ||
      entry.wasBottleGogRunning ||
      entry.wokeBottleEpicByLauncher ||
      entry.wasBottleEpicRunning
  );
  const shouldPreserveBottleStorefrontClient =
    hasActiveBottleStorefrontClient &&
    (lifecyclePolicy === 'minimal_keep_running' ||
      lifecyclePolicy === 'default_client' ||
      (lifecyclePolicy === 'minimal_and_close_if_started' &&
        ((entry.launchedViaBottleSteam && !entry.wokeBottleSteamByLauncher) ||
          (entry.wasBottleGogRunning && !entry.wokeBottleGogByLauncher) ||
          (entry.wasBottleEpicRunning && !entry.wokeBottleEpicByLauncher))));

  /** @type {Promise<any>} */
  let winePrefixShutdownPromise = Promise.resolve(false);
  if (
    (!entry.stopping ||
      entry.deferredPrefixShutdownToFinalize ||
      entry.launchedViaBottleSteam ||
      entry.wokeBottleGogByLauncher ||
      entry.wokeBottleEpicByLauncher) &&
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
      ])
        .then(() => {
          if (isPrefixBusyWithOtherSession()) return false;
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
    winePrefixShutdownPromise,
  ]).finally(() => {
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
    entry.wokeXboxAppByLauncher
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
  };
}

/**
 * C) Direct Game Launcher, Process Monitor & Playtime Tracker
 */
async function launchGame(/** @type {any} */ payload = {}, /** @type {any} */ options = {}) {
  let lockedPlatformId = '';
  let lockedBottlePrefix = '';
  const releasePendingBottleLock = () => {
    if (!lockedBottlePrefix) return;
    const prev = pendingBottleLaunches.get(lockedBottlePrefix) || 0;
    if (prev <= 1) {
      pendingBottleLaunches.delete(lockedBottlePrefix);
    } else {
      pendingBottleLaunches.set(lockedBottlePrefix, prev - 1);
    }
    lockedBottlePrefix = '';
  };
  const releasePendingPlatformLock = () => {
    if (!lockedPlatformId) return;
    const prev = pendingStorefrontLaunches.get(lockedPlatformId) || 0;
    if (prev <= 1) {
      pendingStorefrontLaunches.delete(lockedPlatformId);
    } else {
      pendingStorefrontLaunches.set(lockedPlatformId, prev - 1);
    }
    lockedPlatformId = '';
  };

  try {
    const gameId = String(
      payload.gameId || `${payload.platformId || 'custom'}-${payload.platformGameId || 'game'}`
    );
    if (activeSessions.has(gameId)) {
      const existing = activeSessions.get(gameId);
      return {
        success: true,
        message: 'Game is already running',
        session: { ...existing.session },
      };
    }

    const normPlatformId = String(payload.platformId || '')
      .trim()
      .toLowerCase();
    if (normPlatformId) {
      lockedPlatformId = normPlatformId;
      pendingStorefrontLaunches.set(
        normPlatformId,
        (pendingStorefrontLaunches.get(normPlatformId) || 0) + 1
      );
      if (pendingEphemeralShutdowns.has(normPlatformId)) {
        const pendingCtrl = pendingEphemeralShutdowns.get(normPlatformId);
        pendingEphemeralShutdowns.delete(normPlatformId);
        if (pendingCtrl && typeof pendingCtrl.abort === 'function') {
          try {
            pendingCtrl.abort();
          } catch {}
        }
      }
    }

    if (inFlightPostSessionByGame.has(gameId)) {
      const inFlightGamePromise = inFlightPostSessionByGame.get(gameId);
      emitSessionUpdated(
        {
          gameId,
          platformId: payload.platformId || 'custom',
          status: 'starting',
          event: 'starting',
          statusMessage: 'Finishing previous cloud save upload...',
        },
        options
      );
      const barrierTimeoutMs = Math.max(
        0,
        Number(options.postSessionBarrierTimeoutMs ?? 20000)
      );
      await Promise.race([
        inFlightGamePromise,
        new Promise((resolve) => {
          const t = setTimeout(resolve, barrierTimeoutMs);
          if (typeof t.unref === 'function') t.unref();
        }),
      ]);
      if (activeSessions.has(gameId)) {
        const existing = activeSessions.get(gameId);
        return {
          success: true,
          message: 'Game is already running',
          session: { ...existing.session },
        };
      }
    }

    const emitPreLaunchCloudTelemetry = (/** @type {any} */ syncResult) => {
      try {
        const effectivePlatformId = payload.platformId || 'custom';
        const telemetry = buildCloudSyncTelemetryPayload({
          gameId,
          platformId: effectivePlatformId,
          direction: 'pre_launch',
          syncResult,
          isSteam: effectivePlatformId === 'steam',
        });
        if (telemetry) {
          emitSessionUpdated(telemetry, options);
        }
      } catch {}
    };

    const platform = options.platform || process.platform;
    const savedConfigs = getGameLaunchConfigs(options);
    const rawSavedConfig =
      savedConfigs[gameId] || (payload.gameId && savedConfigs[payload.gameId]) || {};
    const platformSavedConfig = resolvePlatformLaunchConfig(rawSavedConfig, payload.platformId);
    const platformPayloadConfig = resolvePlatformLaunchConfig(
      payload.launchConfig,
      payload.platformId
    );
    const launchConfig = {
      ...platformSavedConfig,
      ...(payload.storefrontClientLifecycle
        ? { storefrontClientLifecycle: payload.storefrontClientLifecycle }
        : {}),
      ...platformPayloadConfig,
    };
    const effectivePerfPolicy = resolveEffectivePerformancePolicy(launchConfig, options);
    /** @type {any} */
    let gogWakeResult = null;
    /** @type {any} */
    let steamMinimalSpawnedResult = null;

    const rawLaunchMethod = launchConfig.launchMethod || payload.launchMethod || 'auto';
    const launchMethod = rawLaunchMethod === 'custom' ? 'auto' : rawLaunchMethod;
    const preferWindowsExe =
      platform === 'darwin' &&
      launchMethod === 'compatibility_layer' &&
      !launchConfig.customExecutablePath;

    // Resolve executable path
    /** @type {string | undefined} */
    let resolvedExePath = undefined;
    let isWindowsBinaryOnMac = Boolean(payload.isWindowsBinaryOnMac);

    const localInstallDir = payload.installPath ? toLocalFsPath(payload.installPath) : '';
    const isInstallInsideBottle = /(?:^|[\\/])(Bottles|drive_c)(?:[\\/]|$)/i.test(localInstallDir);
    if (
      platform === 'darwin' &&
      localInstallDir &&
      !isInstallInsideBottle &&
      fs.existsSync(localInstallDir)
    ) {
      try {
        flattenGogNestedInstallDir(localInstallDir);
        ensureMacExecutablePermissions(localInstallDir);
      } catch {}
    }

    if (launchConfig.customExecutablePath) {
      const customCandidate = toLocalFsPath(launchConfig.customExecutablePath);
      if (fs.existsSync(customCandidate)) {
        resolvedExePath = customCandidate;
      }
    }

    /** @type {any} */
    let appInfoSpec = null;
    /** @type {any} */
    let xboxGameCfg = null;
    /** @type {any} */
    let xboxAppxCfg = null;
    /** @type {any} */
    let xboxReceipt = null;
    if (payload.platformId === 'xbox') {
      const xboxInspectRoot =
        localInstallDir ||
        payload.installPath ||
        (payload.executablePath ? path.dirname(toLocalFsPath(payload.executablePath)) : '');
      if (xboxInspectRoot) {
        for (const rName of ['.onelauncher-xbox-receipt.json', '.onelauncher-xbox-install.json']) {
          const rPath = path.join(xboxInspectRoot, rName);
          if (fs.existsSync(rPath)) {
            try {
              const parsedR = JSON.parse(fs.readFileSync(rPath, 'utf8'));
              if (parsedR && parsedR.status === 'completed') {
                xboxReceipt = parsedR;
                break;
              }
            } catch {}
          }
        }
        xboxGameCfg = inspectMicrosoftGameConfig(xboxInspectRoot);
        xboxAppxCfg = inspectAppxManifest(xboxInspectRoot);
        if (!launchConfig.customExecutablePath && !resolvedExePath) {
          const xboxExeCandidates = [];
          if (xboxGameCfg?.primaryExecutable) {
            const normPrimary = xboxGameCfg.primaryExecutable.replace(/\\/g, path.sep);
            xboxExeCandidates.push(
              path.join(xboxGameCfg.contentRootDir || xboxInspectRoot, normPrimary),
              path.join(xboxInspectRoot, normPrimary)
            );
          }
          if (xboxReceipt?.executableRelPath) {
            const relCand = path.join(
              xboxInspectRoot,
              String(xboxReceipt.executableRelPath).replace(/\\/g, path.sep)
            );
            if (!isExcludedExecutable(path.basename(relCand))) {
              xboxExeCandidates.push(relCand);
            }
          }
          if (xboxAppxCfg?.primaryExecutable) {
            const normAppxPrimary = xboxAppxCfg.primaryExecutable.replace(/\\/g, path.sep);
            xboxExeCandidates.push(
              path.join(xboxAppxCfg.contentRootDir || xboxInspectRoot, normAppxPrimary),
              path.join(xboxInspectRoot, normAppxPrimary)
            );
          }
          for (const candidateCfgExe of xboxExeCandidates) {
            if (
              candidateCfgExe &&
              !isExcludedExecutable(path.basename(candidateCfgExe)) &&
              !candidateCfgExe.toLowerCase().endsWith('.olpart') &&
              fs.existsSync(candidateCfgExe)
            ) {
              resolvedExePath = candidateCfgExe;
              if (platform === 'darwin' && /\.exe$/i.test(candidateCfgExe)) {
                isWindowsBinaryOnMac = true;
              }
              break;
            }
          }
          if (
            !xboxGameCfg &&
            xboxAppxCfg?.requiresCoreWindow &&
            !resolvedExePath &&
            platform === 'win32' &&
            (payload.appUserModelId || xboxAppxCfg?.appUserModelId)
          ) {
            resolvedExePath = 'explorer.exe';
          }
        }
      }
      if (
        platform === 'darwin' &&
        !xboxGameCfg &&
        xboxAppxCfg?.requiresCoreWindow &&
        !resolvedExePath
      ) {
        return {
          success: false,
          error:
            'Legacy UWP CoreWindow title requires Windows OS runtime; GDK desktop executables are required on macOS bottles.',
        };
      }
    } else if (!launchConfig.customExecutablePath && payload.platformId === 'steam') {
      const steamAppIdVal = String(payload.steamAppId || payload.platformGameId || '')
        .replace(/^steam[-_]/i, '')
        .trim();
      const searchInstallDir =
        localInstallDir ||
        (payload.executablePath ? path.dirname(toLocalFsPath(payload.executablePath)) : '');
      if (steamAppIdVal && searchInstallDir) {
        appInfoSpec = resolveSteamAppInfoLaunchSpec(
          searchInstallDir,
          steamAppIdVal,
          searchInstallDir,
          { platform }
        );
        if (
          !resolvedExePath &&
          appInfoSpec &&
          appInfoSpec.executablePath &&
          fs.existsSync(appInfoSpec.executablePath)
        ) {
          resolvedExePath = appInfoSpec.executablePath;
          if (appInfoSpec.isWindowsBinaryOnMac) {
            isWindowsBinaryOnMac = true;
          }
        }
      }
    }

    if (preferWindowsExe && !resolvedExePath && localInstallDir && fs.existsSync(localInstallDir)) {
      const winDiscovered = findPrimaryExecutable(localInstallDir, {
        platform,
        hintName: payload.title,
        preferWindowsExecutable: true,
      });
      if (winDiscovered.executablePath && fs.existsSync(winDiscovered.executablePath)) {
        resolvedExePath = winDiscovered.executablePath;
        isWindowsBinaryOnMac = Boolean(winDiscovered.isWindowsBinaryOnMac);
      }
    }

    if (
      platform === 'darwin' &&
      !preferWindowsExe &&
      !launchConfig.customExecutablePath &&
      !isInstallInsideBottle &&
      localInstallDir &&
      fs.existsSync(localInstallDir) &&
      !resolvedExePath &&
      payload.executablePath &&
      /\.exe$/i.test(payload.executablePath)
    ) {
      const discoveredNative = findPrimaryExecutable(localInstallDir, {
        platform,
        hintName: payload.title,
        preferWindowsExecutable: false,
      });
      if (
        discoveredNative?.executablePath &&
        !discoveredNative.isWindowsBinaryOnMac &&
        !/\.exe$/i.test(discoveredNative.executablePath) &&
        fs.existsSync(discoveredNative.executablePath)
      ) {
        resolvedExePath = discoveredNative.executablePath;
        isWindowsBinaryOnMac = false;
      }
    }

    if (!resolvedExePath && payload.executablePath) {
      const payloadCandidate = toLocalFsPath(payload.executablePath);
      if (fs.existsSync(payloadCandidate)) {
        resolvedExePath = payloadCandidate;
      }
    }
    if (
      platform === 'darwin' &&
      !launchConfig.customExecutablePath &&
      localInstallDir &&
      (!resolvedExePath ||
        !fs.existsSync(resolvedExePath) ||
        /[\\/]GOGLauncher$/i.test(resolvedExePath) ||
        /\.com$/i.test(resolvedExePath) ||
        isExcludedExecutable(path.basename(resolvedExePath)))
    ) {
      evictExecutableDiscoveryCacheForPath(localInstallDir);
      const discovered =
        !preferWindowsExe &&
        appInfoSpec &&
        appInfoSpec.executablePath &&
        fs.existsSync(appInfoSpec.executablePath)
          ? {
              executablePath: appInfoSpec.executablePath,
              isWindowsBinaryOnMac: appInfoSpec.isWindowsBinaryOnMac,
            }
          : findPrimaryExecutable(localInstallDir, {
              platform,
              hintName: payload.title,
              preferWindowsExecutable: preferWindowsExe,
            });
      if (discovered.executablePath) {
        resolvedExePath = discovered.executablePath;
        if (discovered.isWindowsBinaryOnMac) {
          isWindowsBinaryOnMac = true;
        } else if (!/\.exe$/i.test(discovered.executablePath)) {
          isWindowsBinaryOnMac = false;
        }
        if (payload.executablePath && resolvedExePath !== toLocalFsPath(payload.executablePath)) {
          try {
            const managed = loadManagedInstalledGames(options.userDataDir);
            let updatedManaged = false;
            for (const rec of managed) {
              if (
                (rec.installPath && path.resolve(rec.installPath) === path.resolve(localInstallDir)) ||
                (payload.platformGameId &&
                  String(rec.platformGameId) === String(payload.platformGameId) &&
                  rec.platformId === payload.platformId)
              ) {
                rec.executablePath = resolvedExePath;
                updatedManaged = true;
              }
            }
            if (updatedManaged) {
              saveManagedInstalledGames(managed, options.userDataDir);
            }
          } catch {}
        }
      }
    }
    if (!resolvedExePath && payload.installPath) {
      const discovered = findPrimaryExecutable(payload.installPath, {
        platform,
        hintName: payload.title,
        preferWindowsExecutable: preferWindowsExe,
      });
      resolvedExePath = discovered.executablePath || undefined;
      if (discovered.isWindowsBinaryOnMac) {
        isWindowsBinaryOnMac = true;
      } else if (discovered.executablePath && !/\.exe$/i.test(discovered.executablePath)) {
        isWindowsBinaryOnMac = false;
      }
    }

    if (
      resolvedExePath &&
      !launchConfig.customExecutablePath &&
      (/\.com$/i.test(resolvedExePath) || isExcludedExecutable(path.basename(resolvedExePath))) &&
      fs.existsSync(resolvedExePath)
    ) {
      const rediscovered = findPrimaryExecutable(
        localInstallDir || path.dirname(resolvedExePath),
        {
          platform,
          hintName: payload.title,
          preferWindowsExecutable: preferWindowsExe,
        }
      );
      if (rediscovered.executablePath) {
        resolvedExePath = rediscovered.executablePath;
        if (rediscovered.isWindowsBinaryOnMac) {
          isWindowsBinaryOnMac = true;
        }
      }
    }

    if (
      resolvedExePath &&
      resolvedExePath !== 'explorer.exe' &&
      resolvedExePath.toLowerCase().endsWith('.exe') &&
      fs.existsSync(resolvedExePath)
    ) {
      /** @type {any} */
      let peInfo = inspectWindowsExecutableHeader(resolvedExePath, {
        strictPe: Boolean(options.strictPe),
      });
      if (peInfo.is16BitDos && !launchConfig.customExecutablePath) {
        const rediscovered = findPrimaryExecutable(
          payload.installPath || path.dirname(resolvedExePath),
          {
            platform,
            hintName: payload.title,
            preferWindowsExecutable: preferWindowsExe,
          }
        );
        resolvedExePath = rediscovered.executablePath || undefined;
        if (rediscovered.isWindowsBinaryOnMac) {
          isWindowsBinaryOnMac = true;
        }
        peInfo =
          resolvedExePath &&
          resolvedExePath.toLowerCase().endsWith('.exe') &&
          fs.existsSync(resolvedExePath)
            ? inspectWindowsExecutableHeader(resolvedExePath, {
                strictPe: Boolean(options.strictPe),
              })
            : null;
      }
      if (
        peInfo &&
        peInfo.exists &&
        peInfo.isValidPe &&
        !isCompatibleX86OrX64PeHeader(peInfo, {
          hostPlatform: platform,
          hostArch: options.arch || process.arch,
        }) &&
        !launchConfig.customExecutablePath
      ) {
        const searchRoot = localInstallDir || payload.installPath || path.dirname(resolvedExePath);
        const compatibleAltExe = findBestX86OrX64WindowsExe(searchRoot, {
          strictPe: Boolean(options.strictPe),
          platform,
          arch: options.arch || process.arch,
        });
        if (compatibleAltExe && fs.existsSync(compatibleAltExe)) {
          diagLog.info('launchGame.peArchFallbackSelected', {
            gameId,
            rejectedExe: path.basename(resolvedExePath),
            rejectedMachine: peInfo.machineHex,
            selectedExe: path.basename(compatibleAltExe),
          });
          resolvedExePath = compatibleAltExe;
          peInfo = inspectWindowsExecutableHeader(resolvedExePath, {
            strictPe: Boolean(options.strictPe),
          });
        } else {
          return {
            success: false,
            error: `Launch failed: Executable "${path.basename(resolvedExePath)}" targets unsupported architecture (${peInfo.machineHex || 'ARM64'}) and no compatible x86/x64 executable was found in the installation.`,
          };
        }
      }
      if (resolvedExePath && peInfo && peInfo.exists && !peInfo.isValidPe) {
        return {
          success: false,
          error: `Launch failed: Game executable "${path.basename(resolvedExePath)}" is incomplete or corrupted (invalid Windows PE header). Please repair or reinstall the game.`,
        };
      }
    }

    if (
      platform === 'darwin' &&
      ((resolvedExePath && resolvedExePath.toLowerCase().endsWith('.exe')) ||
        /(?:^|[\\/])(Bottles|drive_c)(?:[\\/]|$)/i.test(
          String(resolvedExePath || payload.installPath || '')
        ))
    ) {
      isWindowsBinaryOnMac = true;
    }

    const effectiveLaunchArgsStr =
      launchConfig.launchArguments ||
      payload.launchArguments ||
      (appInfoSpec && appInfoSpec.launchArguments) ||
      resolveDefaultEngineLaunchArguments(
        localInstallDir || (resolvedExePath ? path.dirname(resolvedExePath) : ''),
        resolvedExePath
      );
    const args = parseLaunchArguments(effectiveLaunchArgsStr);
    /** @type {Record<string, any>} */
    const env = {
      ...process.env,
      ...(launchConfig.environmentVariables || {}),
    };

    // Execute optional pre-launch command asynchronously (never block Electron main thread)
    if (launchConfig.preLaunchCommand) {
      await new Promise((resolve) => {
        try {
          exec(
            launchConfig.preLaunchCommand,
            { timeout: 5000, windowsHide: true },
            (cmdErr) => {
              if (cmdErr) {
                diagLog.warn('launchGame.preLaunchCommand', cmdErr, { gameId });
              }
              resolve(undefined);
            }
          );
        } catch (syncErr) {
          diagLog.warn('launchGame.preLaunchCommandSpawn', syncErr, { gameId });
          resolve(undefined);
        }
      });
    }

    const isMacNativeExecutable =
      Boolean(resolvedExePath) &&
      !/\.(exe|bat|msi)$/i.test(String(resolvedExePath)) &&
      !isWindowsBinaryOnMac;
    const useCompatLayer =
      platform === 'darwin' &&
      (isWindowsBinaryOnMac ||
        Boolean(resolvedExePath && /\.(exe|bat|msi)$/i.test(resolvedExePath)) ||
        (launchMethod === 'compatibility_layer' && !isMacNativeExecutable) ||
        (!isMacNativeExecutable &&
          launchConfig.compatibilityLayer &&
          launchConfig.compatibilityLayer !== 'native'));

    const hasExplicitPerGameLifecycleOverride = Boolean(
      launchConfig.storefrontClientLifecycle &&
        launchConfig.storefrontClientLifecycle !== 'default'
    );
    if (
      useCompatLayer &&
      (payload.platformId === 'epic' || payload.platformId === 'xbox') &&
      !hasExplicitPerGameLifecycleOverride
    ) {
      effectivePerfPolicy.storefrontClientLifecycle = 'fast_direct_bypass';
      launchConfig.storefrontClientLifecycle = 'fast_direct_bypass';
    }

    const isFastMinimalBypass =
      effectivePerfPolicy.storefrontClientLifecycle === 'fast_direct_bypass' ||
      (payload.platformId === 'steam' && launchMethod === 'direct');

    const effectiveSteamAppId =
      payload.platformId === 'steam'
        ? String(payload.steamAppId || payload.platformGameId || '')
            .replace(/^steam[-_]/i, '')
            .trim()
        : '';

    const isAutoLikeMethod = launchMethod === 'auto' || launchMethod === 'custom';

    const isSteamAutoUriPreferred =
      payload.platformId === 'steam' &&
      isAutoLikeMethod &&
      !isFastMinimalBypass &&
      !useCompatLayer &&
      !payload.customExecutablePath &&
      !launchConfig?.customExecutablePath &&
      Boolean(buildStorefrontLaunchUri(payload)) &&
      (platform === 'win32' ||
        (platform === 'darwin' && Boolean(resolveSteamClientBinaryPath(options))));

    // 1. Direct or Compatibility Layer execution when executable is available
    if (
      resolvedExePath &&
      !isSteamAutoUriPreferred &&
      launchMethod !== 'storefront_uri' &&
      (launchMethod === 'direct' ||
        isAutoLikeMethod ||
        launchMethod === 'compatibility_layer' ||
        useCompatLayer)
    ) {
      let spawnCmd = resolvedExePath;
      let spawnArgs = [...args];
      let actualLaunchMethod = 'direct';
      /** @type {any} */
      let compatResult = null;
      /** @type {any} */
      let chosenCompatLayer = null;
      /** @type {string | null} */
      let targetWinePrefix = null;
      /** @type {string | null} */
      let bottleSteamExe = null;
      let shouldLaunchViaBottleSteam = false;
      let wasBottleSteamRunning = false;
      /** @type {string | null} */
      let bottleGogExe = null;
      let shouldWakeBottleGog = false;
      let wasBottleGogRunning = false;
      let wokeBottleGogByLauncher = false;
      /** @type {string | null} */
      let bottleEpicExe = null;
      let shouldWakeBottleEpic = false;
      let wasBottleEpicRunning = false;
      let wokeBottleEpicByLauncher = false;
      /** @type {any} */
      let xboxLoopbackServer = null;
      let wasXboxAppRunningAtStart = false;
      let launchedViaXboxActivationLatch = false;
      let activatedXboxPid = 0;
      let isXboxAppxRegisteredOnWin32 = false;
      let winClientlessLauncherExe = '';
      let winClientlessPrimaryXgrDll = '';

      const resolvedXboxPfn = String(
        xboxGameCfg?.packageFamilyName ||
          xboxAppxCfg?.packageFamilyName ||
          payload.packageFamilyName ||
          xboxReceipt?.packageFamilyName ||
          ''
      ).trim();
      const resolvedXboxTitleId = String(
        xboxGameCfg?.titleId || payload.xboxTitleId || xboxReceipt?.xboxTitleId || ''
      ).trim();
      let resolvedXboxScid = String(
        xboxGameCfg?.scid ||
          payload.scid ||
          xboxReceipt?.scid ||
          (resolvedXboxTitleId ? deriveDefaultScidFromTitleId(resolvedXboxTitleId) : '')
      )
        .trim()
        .toLowerCase();
      const resolvedXboxFallbackScid = String(
        xboxGameCfg?.fallbackScid || payload.fallbackScid || xboxReceipt?.fallbackScid || ''
      )
        .trim()
        .toLowerCase();
      const resolvedXboxMsaAppId = String(
        xboxGameCfg?.msaAppId || payload.msaAppId || xboxReceipt?.msaAppId || ''
      ).trim();
      const resolvedXboxProductId = String(
        payload.xboxProductId ||
          xboxGameCfg?.storeId ||
          xboxReceipt?.xboxProductId ||
          payload.platformGameId ||
          ''
      )
        .trim()
        .replace(/^xbox[-_]/i, '')
        .toUpperCase();
      const resolvedXboxAumid = String(
        xboxGameCfg?.appUserModelId ||
          xboxAppxCfg?.appUserModelId ||
          payload.appUserModelId ||
          xboxReceipt?.appUserModelId ||
          (resolvedXboxPfn ? `${resolvedXboxPfn}!App` : '')
      ).trim();

      if (useCompatLayer) {
        const layers = detectCompatibilityLayers(options);
        const preferredType = launchConfig.compatibilityLayer;
        let chosenLayer =
          (preferredType && preferredType !== 'native'
            ? layers.find((l) => l.type === preferredType || l.id === preferredType)
            : layers.find((l) => l.type === 'crossover' || l.type === 'crossover_preview')) ||
          layers[0];

        if (!chosenLayer) {
          if (isAutoLikeMethod && options.allowStorefrontFallbackOnMissingCompat) {
            resolvedExePath = undefined;
          } else {
            return {
              success: false,
              error:
                'No Windows compatibility layer (CrossOver, Game Porting Toolkit, or Wine) detected on macOS to run this Windows executable.',
            };
          }
        } else {
          compatResult = await ensureCompatibilityLayerReady(
            chosenLayer,
            launchConfig,
            env,
            options
          );

          if (chosenLayer.type === 'crossover' || chosenLayer.type === 'crossover_preview') {
            const resolvedBottleDir =
              env.WINEPREFIX ||
              (chosenLayer.bottlesDir && env.CX_BOTTLE
                ? path.join(chosenLayer.bottlesDir, env.CX_BOTTLE)
                : '');
            if (!resolvedBottleDir || !fs.existsSync(resolvedBottleDir)) {
              const fallbackLayer = layers.find(
                (l) =>
                  l.id !== chosenLayer.id &&
                  l.type !== 'crossover' &&
                  l.type !== 'crossover_preview'
              );
              if (fallbackLayer) {
                chosenLayer = fallbackLayer;
                delete env.CX_BOTTLE;
                compatResult = await ensureCompatibilityLayerReady(
                  chosenLayer,
                  launchConfig,
                  env,
                  options
                );
              }
            }
          }

          chosenCompatLayer = chosenLayer;
          targetWinePrefix = compatResult?.winePrefix || env.WINEPREFIX || null;

          if (targetWinePrefix) {
            const resolvedTargetPrefix = path.resolve(targetWinePrefix);
            lockedBottlePrefix = resolvedTargetPrefix;
            pendingBottleLaunches.set(
              resolvedTargetPrefix,
              (pendingBottleLaunches.get(resolvedTargetPrefix) || 0) + 1
            );

            if (inFlightPostSessionByBottle.has(resolvedTargetPrefix)) {
              const bottleInFlightPromise = inFlightPostSessionByBottle.get(resolvedTargetPrefix);
              emitSessionUpdated(
                {
                  gameId,
                  platformId: payload.platformId || 'custom',
                  status: 'starting',
                  event: 'starting',
                  statusMessage: 'Waiting for Wine bottle post-exit cloud sync...',
                },
                options
              );
              const bottleBarrierTimeoutMs = Math.max(
                0,
                Number(options.postSessionBarrierTimeoutMs ?? 20000)
              );
              await Promise.race([
                bottleInFlightPromise,
                new Promise((resolve) => {
                  const t = setTimeout(resolve, bottleBarrierTimeoutMs);
                  if (typeof t.unref === 'function') t.unref();
                }),
              ]);
            }
          }

          // Guard against Apple libMTLHud.dylib + older libMoltenVK.dylib static initializer deadlock
          // by injecting libone_metal_preload.dylib (`CFRunLoopRun` interpose on Thread 0) AND mirroring
          // into CX_DYLD_INSERT_LIBRARIES so CrossOver's #!/usr/bin/perl wrapper forwards it to wineloader.
          if (
            env.MTL_HUD_ENABLED === '1' &&
            chosenLayer.binaryPath &&
            doesWineLayerHaveMoltenVkHudDeadlock(chosenLayer.binaryPath)
          ) {
            const preloadDylib = ensureWineMetalPreloadDylib(options);
            const moltenVkPath = resolveWineLayerMoltenVkPath(chosenLayer.binaryPath);
            if (preloadDylib) {
              const existingInsert = String(env.DYLD_INSERT_LIBRARIES || '')
                .split(/:(?![\\/])/)
                .map((s) => s.trim())
                .filter(Boolean);
              if (!existingInsert.includes(preloadDylib)) {
                existingInsert.unshift(preloadDylib);
              }
              env.DYLD_INSERT_LIBRARIES = existingInsert.join(':');
              resolveSipSafeWineBinaryAndPreloadEnv(chosenLayer.binaryPath, env);
              if (moltenVkPath) {
                env.ONE_LAUNCHER_MOLTENVK_PATH = moltenVkPath;
              }
            } else {
              delete env.MTL_HUD_ENABLED;
            }
          }

          const isUnmockedHostBottleInVitest =
            Boolean(process.env.VITEST || process.env.NODE_ENV === 'test') &&
            !options.allowBottleClientWakeInTest &&
            ((typeof options.bottleClientSpawnFn !== 'function' &&
              typeof options.gameSpawnFn !== 'function' &&
              typeof options.spawnFn !== 'function') ||
              String((chosenLayer && chosenLayer.binaryPath) || '').startsWith('/Applications/'));

          if (payload.platformId === 'steam' && targetWinePrefix && !isUnmockedHostBottleInVitest) {
            bottleSteamExe = resolveBottleSteamExe(targetWinePrefix);
            shouldLaunchViaBottleSteam = Boolean(
              bottleSteamExe &&
                effectiveSteamAppId &&
                !isFastMinimalBypass &&
                !options.disableBottleSteamLaunch &&
                !options.disableBottleStorefrontLaunch
            );
          } else if (
            payload.platformId === 'gog' &&
            targetWinePrefix &&
            !isUnmockedHostBottleInVitest
          ) {
            bottleGogExe = resolveBottleGogGalaxyExe(targetWinePrefix);
            const gogInstallUsesSdk =
              options.strictGalaxySdkCheck === true
                ? doesGogInstallUseGalaxySdk(localInstallDir, resolvedExePath)
                : true;
            shouldWakeBottleGog = Boolean(
              bottleGogExe &&
                !isFastMinimalBypass &&
                options.usesGalaxySdk !== false &&
                gogInstallUsesSdk &&
                !options.disableBottleGogLaunch &&
                !options.disableBottleStorefrontLaunch
            );
          } else if (
            payload.platformId === 'epic' &&
            targetWinePrefix &&
            !isUnmockedHostBottleInVitest
          ) {
            bottleEpicExe = resolveBottleEpicLauncherExe(targetWinePrefix);
            shouldWakeBottleEpic = Boolean(
              bottleEpicExe &&
                !isFastMinimalBypass &&
                !options.disableBottleEpicLaunch &&
                !options.disableBottleStorefrontLaunch
            );
          }

          const hasOtherActiveSessionInPrefix =
            Boolean(lockedBottlePrefix) &&
            ((pendingBottleLaunches.get(lockedBottlePrefix) || 0) > 1 ||
              Array.from(activeSessions.entries()).some(
                ([activeId, activeEntry]) =>
                  activeId !== gameId &&
                  !activeEntry.finalized &&
                  activeEntry.winePrefix &&
                  path.resolve(activeEntry.winePrefix) === lockedBottlePrefix
              ));

          if (!hasOtherActiveSessionInPrefix) {
            if (
              !isTestEnvironment(options) &&
              resolvedExePath &&
              resolvedExePath.toLowerCase().endsWith('.exe')
            ) {
              await killPosixProcessesMatchingWinExe(
                resolvedExePath,
                'SIGKILL',
                localInstallDir || targetWinePrefix || ''
              );
            }

            if (!shouldLaunchViaBottleSteam && !shouldWakeBottleGog && !shouldWakeBottleEpic) {
              const candidateWineserver = resolveWineserverBinary(chosenLayer.binaryPath);
              const canRunWineserver =
                Boolean(candidateWineserver && targetWinePrefix) &&
                (!options.homedir ||
                  String(candidateWineserver).startsWith(options.homedir) ||
                  String(candidateWineserver).startsWith(os.tmpdir()) ||
                  String(candidateWineserver).startsWith('/private/var/folders') ||
                  String(candidateWineserver).startsWith('/var/folders'));

              if (canRunWineserver) {
                await shutdownWinePrefix(chosenLayer.binaryPath, targetWinePrefix, 2000);
              }
            }
          }

          if (targetWinePrefix && fs.existsSync(targetWinePrefix)) {
            const sanitizeKey = `${path.resolve(targetWinePrefix)}:${String(launchConfig.crossoverHighResolutionMode)}`;
            const lastSanitizedAt = recentDisplaySanitizeCache.get(sanitizeKey) || 0;
            if (
              options.forceSanitizeDisplayConfigs === true ||
              Date.now() - lastSanitizedAt > 4000
            ) {
              try {
                sanitizeWinePrefixDisplayConfigs(targetWinePrefix, {
                  ...options,
                  ...(typeof launchConfig.crossoverHighResolutionMode === 'boolean'
                    ? { highResolutionMode: launchConfig.crossoverHighResolutionMode }
                    : {}),
                });
                setBoundedMapEntry(recentDisplaySanitizeCache, sanitizeKey, Date.now(), 256);
              } catch {}
            }
          }
        }
      }

      if (resolvedExePath) {
        if (payload.platformId === 'steam' && effectiveSteamAppId) {
          env.SteamAppId = effectiveSteamAppId;
          env.SteamGameId = effectiveSteamAppId;
          const targetAppIdDir =
            launchConfig.workingDirectory && fs.existsSync(launchConfig.workingDirectory)
              ? launchConfig.workingDirectory
              : path.dirname(resolvedExePath);
          if (targetAppIdDir && fs.existsSync(targetAppIdDir)) {
            const steamAppIdTxt = path.join(targetAppIdDir, 'steam_appid.txt');
            try {
              if (!fs.existsSync(steamAppIdTxt)) {
                fs.writeFileSync(steamAppIdTxt, `${effectiveSteamAppId}\n`, 'utf8');
              }
            } catch {}
          }
        }

        if (payload.platformId === 'epic') {
          try {
            const epicPreSyncRes = await syncEpicCloudSaves(payload, 'pre_launch', {
              ...options,
              useCompatLayer,
              winePrefix: targetWinePrefix,
              installPath: localInstallDir || payload.installPath,
            });
            emitPreLaunchCloudTelemetry(epicPreSyncRes);
          } catch (/** @type {any} */ epicSyncErr) {
            emitPreLaunchCloudTelemetry({
              synced: false,
              reason: epicSyncErr && epicSyncErr.message ? epicSyncErr.message : 'sync_failed',
            });
          }
          try {
            const epicAuth = await resolveEpicLaunchAuthArguments(payload, options);
            if (epicAuth && Array.isArray(epicAuth.args)) {
              for (const flag of epicAuth.args) {
                const flagPrefix = String(flag).split('=')[0].toLowerCase();
                const alreadyPresent = args.some(
                  (existingArg) => String(existingArg).split('=')[0].toLowerCase() === flagPrefix
                );
                if (!alreadyPresent) {
                  args.push(flag);
                }
              }
            }
          } catch {}
        } else if (payload.platformId === 'gog') {
          try {
            const gogPreSyncRes = await syncGogCloudSaves(payload, 'pre_launch', {
              ...options,
              useCompatLayer,
              winePrefix: targetWinePrefix,
              installPath: localInstallDir || payload.installPath,
            });
            emitPreLaunchCloudTelemetry(gogPreSyncRes);
          } catch (/** @type {any} */ gogSyncErr) {
            emitPreLaunchCloudTelemetry({
              synced: false,
              reason: gogSyncErr && gogSyncErr.message ? gogSyncErr.message : 'sync_failed',
            });
          }

          const shouldWakeHostGog =
            !(useCompatLayer && platform === 'darwin') &&
            !isFastMinimalBypass &&
            options.usesGalaxySdk !== false &&
            options.disableGogGalaxyWake !== true &&
            !(
              options.strictGalaxySdkCheck === true &&
              !doesGogInstallUseGalaxySdk(localInstallDir, resolvedExePath)
            );
          if (shouldWakeHostGog) {
            if (
              !isTestEnvironment(options) ||
              options.gogGalaxyClientPath !== undefined ||
              options.allowGogWakeInTest === true ||
              typeof options.spawnFn === 'function'
            ) {
              emitSessionUpdated(
                {
                  gameId,
                  platformId: payload.platformId || 'gog',
                  status: 'starting',
                  event: 'starting',
                  statusMessage:
                    effectivePerfPolicy.storefrontClientLifecycle === 'default_client'
                      ? 'Starting GOG Galaxy client...'
                      : 'Starting GOG Galaxy background service...',
                },
                options
              );
            }
            try {
              gogWakeResult = await ensureGogGalaxyBackgroundService({
                ...options,
                storefrontClientLifecycle: effectivePerfPolicy.storefrontClientLifecycle,
              });
            } catch (gogWakeErr) {
              diagLog.warn('launchGame.hostGogWake', gogWakeErr, { gameId });
            }
          }
        } else if (payload.platformId === 'xbox') {
          const activeStoreSync = options.storeSync || getStoreSync();
          const resolveXboxAuthAndSession = async () => {
            const xboxAuthProvider =
              options.xboxAuthProvider ||
              (activeStoreSync && typeof activeStoreSync.getXboxAuthProvider === 'function'
                ? activeStoreSync.getXboxAuthProvider({
                    userDataDir: getUserDataDir(options.userDataDir),
                  })
                : null);
            const xboxSession =
              options.xboxSession ||
              (xboxAuthProvider && typeof xboxAuthProvider.getValidXboxSession === 'function'
                ? await xboxAuthProvider.getValidXboxSession().catch(() => null)
                : null);
            return { xboxAuthProvider, xboxSession };
          };
          const runXboxPreLaunchSync = async (/** @type {Record<string, any>} */ extraSyncOpts = {}) => {
            try {
              const xboxPreSyncRes = await syncXboxCloudSaves(
                {
                  ...payload,
                  packageFamilyName: resolvedXboxPfn,
                  scid: resolvedXboxScid,
                  fallbackScid: resolvedXboxFallbackScid || undefined,
                  msaAppId: resolvedXboxMsaAppId,
                  xboxTitleId: resolvedXboxTitleId,
                  xboxProductId: resolvedXboxProductId,
                  appUserModelId: resolvedXboxAumid,
                  installPath: localInstallDir || payload.installPath,
                },
                'pre_launch',
                {
                  ...options,
                  useCompatLayer,
                  winePrefix: targetWinePrefix,
                  installPath: localInstallDir || payload.installPath,
                  userDataDir: getUserDataDir(options.userDataDir),
                  ...extraSyncOpts,
                }
              );
              if (
                xboxPreSyncRes &&
                typeof xboxPreSyncRes.resolvedScid === 'string' &&
                xboxPreSyncRes.resolvedScid.trim()
              ) {
                resolvedXboxScid = xboxPreSyncRes.resolvedScid.trim().toLowerCase();
              }
              emitPreLaunchCloudTelemetry(xboxPreSyncRes);
              return xboxPreSyncRes;
            } catch (/** @type {any} */ xboxSyncErr) {
              const failTelemetry = {
                synced: false,
                provider: 'xbox_connected_storage',
                reason: xboxSyncErr && xboxSyncErr.message ? xboxSyncErr.message : 'sync_failed',
              };
              emitPreLaunchCloudTelemetry(failTelemetry);
              return failTelemetry;
            }
          };

          if (useCompatLayer) {
            const { xboxAuthProvider, xboxSession } = await resolveXboxAuthAndSession();

            // Provision bottle registry + Packages/<PFN>/SystemAppData/{wgs/t,xgs} FIRST so pre_launch
            // cloud save hydration always finds an initialized SystemAppData save tree on first launch.
            const xboxPrep = await prepareXboxBottleEnvironment({
              bottlePath: targetWinePrefix,
              compatLayer: chosenCompatLayer,
              installDir: localInstallDir || payload.installPath,
              executablePath: resolvedExePath,
              packageFamilyName: resolvedXboxPfn,
              xuid: xboxSession?.xuid,
              scid: resolvedXboxScid,
              env,
              advertiseAvx:
                launchConfig.advertiseAvx ??
                launchConfig.rosettaAdvertiseAvx ??
                env.ROSETTA_ADVERTISE_AVX,
              xboxBridgeDllPath: options.xboxBridgeDllPath,
              gameInputBridgeDllPath: options.gameInputBridgeDllPath,
              xboxAppNotifyBridgeDllPath: options.xboxAppNotifyBridgeDllPath,
            });

            await runXboxPreLaunchSync({
              xboxAuthProvider,
              xboxSession,
            });

            const xboxMods = getXboxStorefrontModules();
            if (xboxMods?.xboxRuntimeLoopbackServer?.startXboxRuntimeLoopbackServer) {
              try {
                xboxLoopbackServer =
                  await xboxMods.xboxRuntimeLoopbackServer.startXboxRuntimeLoopbackServer({
                    authProvider: xboxAuthProvider,
                    userProfile: xboxSession || undefined,
                    gameMetadata: {
                      titleId: resolvedXboxTitleId,
                      titleIdDecimal: xboxGameCfg?.titleIdDecimal || undefined,
                      scid: resolvedXboxScid,
                      fallbackScid: resolvedXboxFallbackScid || undefined,
                      msaAppId: resolvedXboxMsaAppId,
                      storeId: resolvedXboxProductId,
                      packageFamilyName: resolvedXboxPfn,
                      displayName: String(payload.title || xboxGameCfg?.displayName || gameId),
                      fullTrust: true,
                    },
                    saveRootDir: xboxPrep.systemAppDataDir || xboxPrep.wgsRootDir || undefined,
                    bottleUsersDir: xboxPrep.bottleUsersDir || undefined,
                    enableCloudSaveSync: true,
                    fetchImpl: options.fetchImpl,
                  });
                if (xboxLoopbackServer && xboxLoopbackServer.env) {
                  Object.assign(env, xboxLoopbackServer.env);
                }
              } catch (loopbackErr) {
                diagLog.warn('launchGame.xboxLoopbackServerFailed', loopbackErr, { gameId });
              }
            }
            if (resolvedXboxPfn) {
              env.ONE_XGR_PFN = resolvedXboxPfn;
              env.ONE_LAUNCHER_XBOX_PFN = resolvedXboxPfn;
            }
            if (resolvedXboxScid) {
              env.ONE_XGR_SCID = resolvedXboxScid;
              env.ONE_LAUNCHER_XBOX_SCID = resolvedXboxScid;
            }
            if (resolvedXboxProductId) env.ONE_XGR_STORE_ID = resolvedXboxProductId;
            if (resolvedXboxTitleId) env.ONE_XGR_TITLE_ID = resolvedXboxTitleId;
            if (resolvedXboxMsaAppId) env.ONE_XGR_MSA_APP_ID = resolvedXboxMsaAppId;
          } else if (platform === 'win32') {
            const installRootForWin = localInstallDir || payload.installPath || '';
            const hasClientlessReceipt = hasXboxClientlessReceipt(installRootForWin);
            const isClientlessWinXbox = Boolean(
              hasClientlessReceipt ||
                payload.isClientlessXboxInstall === true ||
                payload.runner === 'xbox_direct' ||
                payload.installerId === 'xbox-msixvc-win'
            );

            if (!isClientlessWinXbox) {
              isXboxAppxRegisteredOnWin32 = true;
            } else if (options.forceClientlessXboxOnWin32 !== true) {
              const appxRegCheck = await ensureWindowsXboxAppxRegisteredAsync(
                {
                  installDir: installRootForWin,
                  identityName:
                    xboxGameCfg?.identityName ||
                    xboxAppxCfg?.identityName ||
                    payload.identityName ||
                    '',
                  packageFamilyName: resolvedXboxPfn,
                },
                options
              );
              if (appxRegCheck.gamingServicesInstalled && appxRegCheck.registered) {
                isXboxAppxRegisteredOnWin32 = true;
                if (hasClientlessReceipt && installRootForWin) {
                  await restoreWindowsClientlessXboxBridgeDlls(installRootForWin).catch(() => null);
                }
              }
            }

            if (!isXboxAppxRegisteredOnWin32) {
              const { xboxAuthProvider, xboxSession } = await resolveXboxAuthAndSession();

              const stagedWinBridge = await stageWindowsClientlessXboxBridgeDlls({
                installDir: installRootForWin,
                executablePath: resolvedExePath,
                xboxBridgeDllPath: options.xboxBridgeDllPath,
                gameInputBridgeDllPath: options.gameInputBridgeDllPath,
                strictBridgeSha256: options.strictBridgeSha256,
              });

              let winSystemAppDataDir = '';
              try {
                const knownFolders = resolveHostWindowsKnownFolders(options) || {};
                const rawHostLocalAppData =
                  knownFolders.localAppData ||
                  knownFolders.appDataLocal ||
                  options.localAppData ||
                  (options.homedir
                    ? path.join(options.homedir, 'AppData', 'Local')
                    : process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'));
                const hostLocalAppData = toHostFilesystemPath(rawHostLocalAppData);
                if (
                  hostLocalAppData &&
                  resolvedXboxPfn &&
                  !/[\\/:*?"<>|]/.test(resolvedXboxPfn) &&
                  !resolvedXboxPfn.includes('..')
                ) {
                  const pkgRoot = path.join(hostLocalAppData, 'Packages', resolvedXboxPfn);
                  winSystemAppDataDir = path.join(pkgRoot, 'SystemAppData');
                  await Promise.all([
                    fs.promises.mkdir(path.join(winSystemAppDataDir, 'wgs', 't'), {
                      recursive: true,
                    }),
                    fs.promises.mkdir(path.join(winSystemAppDataDir, 'xgs'), { recursive: true }),
                    fs.promises.mkdir(path.join(pkgRoot, 'LocalState'), { recursive: true }),
                    fs.promises.mkdir(path.join(pkgRoot, 'TempState'), { recursive: true }),
                    fs.promises.mkdir(path.join(pkgRoot, 'AC'), { recursive: true }),
                    fs.promises.mkdir(path.join(pkgRoot, 'Settings'), { recursive: true }),
                  ]);
                }
              } catch {}

              await runXboxPreLaunchSync({
                xboxAuthProvider,
                xboxSession,
                isClientlessXboxGdk: true,
                isAppxRegistered: false,
                useGamingServicesRuntime: false,
              });

              const xboxMods = getXboxStorefrontModules();
              if (xboxMods?.xboxRuntimeLoopbackServer?.startXboxRuntimeLoopbackServer) {
                try {
                  xboxLoopbackServer =
                    await xboxMods.xboxRuntimeLoopbackServer.startXboxRuntimeLoopbackServer({
                      authProvider: xboxAuthProvider,
                      userProfile: xboxSession || undefined,
                      gameMetadata: {
                        titleId: resolvedXboxTitleId,
                        titleIdDecimal: xboxGameCfg?.titleIdDecimal || undefined,
                        scid: resolvedXboxScid,
                        fallbackScid: resolvedXboxFallbackScid || undefined,
                        msaAppId: resolvedXboxMsaAppId,
                        storeId: resolvedXboxProductId,
                        packageFamilyName: resolvedXboxPfn,
                        displayName: String(payload.title || xboxGameCfg?.displayName || gameId),
                        fullTrust: true,
                      },
                      saveRootDir: winSystemAppDataDir || undefined,
                      enableCloudSaveSync: true,
                      fetchImpl: options.fetchImpl,
                    });
                  if (xboxLoopbackServer && xboxLoopbackServer.env) {
                    Object.assign(env, xboxLoopbackServer.env);
                  }
                } catch (loopbackErr) {
                  diagLog.warn('launchGame.winXboxLoopbackServerFailed', loopbackErr, { gameId });
                }
              }

              if (resolvedXboxPfn) {
                env.ONE_XGR_PFN = resolvedXboxPfn;
                env.ONE_LAUNCHER_XBOX_PFN = resolvedXboxPfn;
              }
              if (resolvedXboxScid) {
                env.ONE_XGR_SCID = resolvedXboxScid;
                env.ONE_LAUNCHER_XBOX_SCID = resolvedXboxScid;
              }
              if (resolvedXboxProductId) env.ONE_XGR_STORE_ID = resolvedXboxProductId;
              if (resolvedXboxTitleId) env.ONE_XGR_TITLE_ID = resolvedXboxTitleId;
              if (resolvedXboxMsaAppId) env.ONE_XGR_MSA_APP_ID = resolvedXboxMsaAppId;

              if (options.disableXboxWinLauncher !== true) {
                const resolvedWinLauncher = resolveBundledXboxWinLauncherExePath(options);
                const candidatePrimaryXgr =
                  stagedWinBridge?.primaryXgameruntimeDllPath ||
                  (resolvedExePath && resolvedExePath !== 'explorer.exe'
                    ? path.join(path.dirname(resolvedExePath), 'xgameruntime.dll')
                    : '');
                if (
                  resolvedWinLauncher &&
                  candidatePrimaryXgr &&
                  fs.existsSync(candidatePrimaryXgr)
                ) {
                  winClientlessLauncherExe = resolvedWinLauncher;
                  winClientlessPrimaryXgrDll = candidatePrimaryXgr;
                }
              }
            } else {
              await runXboxPreLaunchSync({
                isAppxRegistered: true,
                useGamingServicesRuntime: true,
              });

              wasXboxAppRunningAtStart = await isWindowsXboxAppRunning(options);
              const canUseAumidActivation =
                Boolean(resolvedXboxAumid) &&
                !launchConfig.customExecutablePath &&
                options.disableXboxAumidActivation !== true &&
                (!isTestEnvironment(options) ||
                  typeof options.activateXboxApplicationFn === 'function' ||
                  options.enableXboxAumidActivationInTest === true);

              if (canUseAumidActivation) {
                const actRes = await activateWindowsXboxApplication(
                  resolvedXboxAumid,
                  effectiveLaunchArgsStr,
                  options
                );
                if (actRes && actRes.activated && actRes.pid > 0) {
                  activatedXboxPid = actRes.pid;
                  launchedViaXboxActivationLatch = true;
                  actualLaunchMethod = 'xbox_aumid_com';
                } else if (resolvedExePath === 'explorer.exe' && resolvedXboxAumid) {
                  args.length = 0;
                  args.push(`shell:AppsFolder\\${resolvedXboxAumid}`);
                  launchedViaXboxActivationLatch = true;
                  actualLaunchMethod = 'xbox_apps_folder';
                } else if (
                  localInstallDir &&
                  xboxGameCfg?.gameLaunchHelperExecutable &&
                  fs.existsSync(
                    path.join(
                      xboxGameCfg.contentRootDir || localInstallDir,
                      xboxGameCfg.gameLaunchHelperExecutable
                    )
                  )
                ) {
                  spawnCmd = path.join(
                    xboxGameCfg.contentRootDir || localInstallDir,
                    xboxGameCfg.gameLaunchHelperExecutable
                  );
                  launchedViaXboxActivationLatch = true;
                }
              } else if (resolvedExePath === 'explorer.exe' && resolvedXboxAumid) {
                args.length = 0;
                args.push(`shell:AppsFolder\\${resolvedXboxAumid}`);
                launchedViaXboxActivationLatch = true;
                actualLaunchMethod = 'xbox_apps_folder';
              }
            }
          } else {
            await runXboxPreLaunchSync();
          }
        }

        // Finalize spawn command & arguments (incorporating any Epic auth flags added to `args`)
        if (useCompatLayer && chosenCompatLayer) {
          if (shouldLaunchViaBottleSteam && bottleSteamExe) {
            const execFileImpl =
              typeof options.execFileImpl === 'function'
                ? options.execFileImpl
                : typeof options.execFileFn === 'function'
                  ? options.execFileFn
                  : execFile;
            const normTargetPrefix = targetWinePrefix
              ? path.resolve(targetWinePrefix).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
              : '';
            const checkBottleSteamRunning = (/** @type {any} */ outStr) => {
              const lines = String(outStr || '').split(/\r?\n/);
              for (const line of lines) {
                if (!/(?:^|[\\/\s"'])steam\.exe(?:\s|["']|$)/i.test(line)) continue;
                if (normTargetPrefix) {
                  const lowerLine = line.replace(/\\/g, '/').toLowerCase();
                  const envMatch = lowerLine.match(/wineprefix=(?:"([^"]+)"|'([^']+)'|(\S+))/i);
                  if (envMatch) {
                    const linePrefix = (envMatch[1] || envMatch[2] || envMatch[3] || '').replace(
                      /\/+$/,
                      ''
                    );
                    if (linePrefix && linePrefix !== normTargetPrefix) {
                      continue;
                    }
                  }
                  const bottleMatch = lowerLine.match(
                    /((?:[a-z]:)?\/[^\s"']*\/bottles\/[^/\s"']+)/i
                  );
                  if (bottleMatch && bottleMatch[1]) {
                    const lineBottle = bottleMatch[1].replace(/\/+$/, '');
                    if (
                      !normTargetPrefix.startsWith(lineBottle) &&
                      !lineBottle.startsWith(normTargetPrefix)
                    ) {
                      continue;
                    }
                  }
                }
                return true;
              }
              return false;
            };

            if (typeof options.mockProcessListOutput === 'string') {
              wasBottleSteamRunning = checkBottleSteamRunning(options.mockProcessListOutput);
            } else if (typeof options.getProcessListOutput === 'function') {
              try {
                wasBottleSteamRunning = checkBottleSteamRunning(
                  await options.getProcessListOutput()
                );
              } catch {}
            } else if (
              !options.homedir ||
              typeof options.execFileImpl === 'function' ||
              typeof options.execFileFn === 'function'
            ) {
              try {
                const psArgs =
                  platform === 'darwin' && execFileImpl === execFile
                    ? ['eww', '-ax', '-o', 'command=']
                    : ['-ax', '-o', 'command='];
                wasBottleSteamRunning = await new Promise((resolve) => {
                  execFileImpl('ps', psArgs, { timeout: 1500 }, (/** @type {any} */ err, /** @type {any} */ stdout) => {
                    resolve(!err && checkBottleSteamRunning(stdout));
                  });
                });
              } catch {
                wasBottleSteamRunning = false;
              }
            }

            spawnCmd = chosenCompatLayer.binaryPath;
            spawnArgs = [
              bottleSteamExe,
              ...(effectivePerfPolicy.storefrontClientLifecycle === 'default_client'
                ? []
                : ['-silent']),
              '-applaunch',
              String(effectiveSteamAppId),
              ...args,
            ];
            actualLaunchMethod = `compatibility_layer:${chosenCompatLayer.type}`;
          } else {
            spawnCmd = chosenCompatLayer.binaryPath;
            const isCrossOverWineWrapper =
              chosenCompatLayer.type === 'crossover' ||
              chosenCompatLayer.type === 'crossover_preview' ||
              /CrossOver[^/\\]*\.app\/Contents\/SharedSupport\/CrossOver\/bin\/wine$/i.test(
                String(chosenCompatLayer.binaryPath || '')
              );
            const dllOverrideArgs =
              payload.platformId === 'xbox' &&
              isCrossOverWineWrapper &&
              typeof env.WINEDLLOVERRIDES === 'string' &&
              env.WINEDLLOVERRIDES.trim()
                ? ['--dll', env.WINEDLLOVERRIDES.trim()]
                : [];
            spawnArgs = [...dllOverrideArgs, resolvedExePath, ...args];
            actualLaunchMethod = `compatibility_layer:${chosenCompatLayer.type}`;
          }
        } else if (platform === 'darwin' && resolvedExePath) {
          const appBundleMatch = String(resolvedExePath).match(/^(.*?\.app)(?:[\\/]|$)/i);
          const enclosingAppBundle = appBundleMatch && appBundleMatch[1] ? appBundleMatch[1] : null;
          if (
            enclosingAppBundle &&
            !isTestEnvironment(options) &&
            typeof options.spawnFn !== 'function' &&
            options.preferDirectMacBinary !== true
          ) {
            spawnCmd = '/usr/bin/open';
            spawnArgs = [
              '-W',
              '-a',
              enclosingAppBundle,
              ...(args.length > 0 ? ['--args', ...args] : []),
            ];
          } else if (resolvedExePath.endsWith('.app')) {
            const innerBin = resolveMacAppBundleBinary(resolvedExePath);
            if (innerBin && innerBin !== resolvedExePath && fs.existsSync(innerBin)) {
              spawnCmd = innerBin;
              spawnArgs = [...args];
            } else {
              spawnCmd = '/usr/bin/open';
              spawnArgs = [
                '-W',
                '-a',
                resolvedExePath,
                ...(args.length > 0 ? ['--args', ...args] : []),
              ];
            }
          } else {
            spawnArgs = [...args];
          }
        } else if (
          platform === 'win32' &&
          payload.platformId === 'xbox' &&
          !isXboxAppxRegisteredOnWin32 &&
          winClientlessLauncherExe &&
          winClientlessPrimaryXgrDll &&
          resolvedExePath !== 'explorer.exe'
        ) {
          spawnCmd = winClientlessLauncherExe;
          spawnArgs = ['--dll', winClientlessPrimaryXgrDll, '--', resolvedExePath, ...args];
          actualLaunchMethod = 'xbox_win_clientless_injector';
        } else {
          spawnArgs = [...args];
        }
      }

      if (resolvedExePath) {
        let shouldFallthroughToStorefrontUri = false;
        try {
          if (platform !== 'win32' && fs.existsSync(spawnCmd) && spawnCmd !== '/usr/bin/open') {
            try {
              const st = fs.statSync(spawnCmd);
              if (st.isFile() && (st.mode & 0o111) === 0) {
                fs.chmodSync(spawnCmd, 0o755);
              }
            } catch {}
            if (platform === 'darwin' && !options.homedir) {
              try {
                const appMatch = String(spawnCmd).match(/^(.*?\.app)(?:\/|$)/i);
                const targetQuarantinePath = appMatch ? appMatch[1] : spawnCmd;
                if (localInstallDir && fs.existsSync(localInstallDir)) {
                  await clearMacQuarantineAsync(localInstallDir, options);
                }
                if (targetQuarantinePath && targetQuarantinePath !== localInstallDir) {
                  await clearMacQuarantineAsync(targetQuarantinePath, options);
                }
              } catch {}
            }
          } else if (
            platform === 'darwin' &&
            !useCompatLayer &&
            !options.homedir &&
            spawnCmd === '/usr/bin/open'
          ) {
            try {
              const appMatch = String(resolvedExePath).match(/^(.*?\.app)(?:\/|$)/i);
              const targetQuarantinePath = appMatch ? appMatch[1] : resolvedExePath;
              if (localInstallDir && fs.existsSync(localInstallDir)) {
                await clearMacQuarantineAsync(localInstallDir, options);
              }
              if (targetQuarantinePath && targetQuarantinePath !== localInstallDir) {
                await clearMacQuarantineAsync(targetQuarantinePath, options);
              }
            } catch {}
          }

          if (platform === 'darwin' && !useCompatLayer) {
            try {
              await ensureMacAppCodeSignatureValidAsync(resolvedExePath || localInstallDir, options);
            } catch {}
          }

          let xboxDefaultCwd = '';
          if (
            payload.platformId === 'xbox' &&
            !launchConfig.workingDirectory &&
            xboxGameCfg?.contentRootDir
          ) {
            const candidateXboxCwd = xboxGameCfg.overrideWorkingDirectory
              ? path.resolve(xboxGameCfg.contentRootDir, xboxGameCfg.overrideWorkingDirectory)
              : xboxGameCfg.contentRootDir;
            if (fs.existsSync(candidateXboxCwd)) {
              xboxDefaultCwd = candidateXboxCwd;
            } else if (fs.existsSync(xboxGameCfg.contentRootDir)) {
              xboxDefaultCwd = xboxGameCfg.contentRootDir;
            }
          }
          const cwd =
            launchConfig.workingDirectory && fs.existsSync(launchConfig.workingDirectory)
              ? launchConfig.workingDirectory
              : shouldLaunchViaBottleSteam && bottleSteamExe
                ? path.dirname(bottleSteamExe)
                : xboxDefaultCwd || path.dirname(resolvedExePath);
          const effectiveCwd = fs.existsSync(cwd)
            ? cwd
            : resolveIsolatedHomedirAndUserData(options).homedir;

          const gameSpawnImpl =
            typeof options.gameSpawnFn === 'function'
              ? options.gameSpawnFn
              : typeof options.spawnFn === 'function' &&
                  options.useSpawnFnForGame !== false &&
                  payload.platformId !== 'gog'
                ? options.spawnFn
                : spawn;

          if (
            shouldLaunchViaBottleSteam &&
            bottleSteamExe &&
            chosenCompatLayer &&
            chosenCompatLayer.binaryPath &&
            !wasBottleSteamRunning &&
            !isFastMinimalBypass &&
            (!isTestEnvironment(options) || options.enableTwoStageSteamColdStart === true)
          ) {
            try {
              const bottleSteamRoot = path.dirname(bottleSteamExe);
              const bottleCloudLogPath = path.join(bottleSteamRoot, 'logs', 'cloud_log.txt');
              let preBootLogOffset = 0;
              try {
                if (fs.existsSync(bottleCloudLogPath)) {
                  preBootLogOffset = fs.statSync(bottleCloudLogPath).size;
                }
              } catch {}

              emitSessionUpdated(
                {
                  gameId,
                  platformId: payload.platformId || 'steam',
                  status: 'starting',
                  event: 'starting',
                  statusMessage: 'Starting Steam & syncing Steam Cloud...',
                },
                options
              );

              const stage1BottleSteam = gameSpawnImpl(
                chosenCompatLayer.binaryPath,
                [
                  bottleSteamExe,
                  ...(effectivePerfPolicy.storefrontClientLifecycle === 'default_client'
                    ? []
                    : ['-silent']),
                ],
                {
                  cwd: fs.existsSync(bottleSteamRoot) ? bottleSteamRoot : effectiveCwd,
                  env,
                  stdio: 'ignore',
                  detached: true,
                }
              );
              if (stage1BottleSteam && typeof stage1BottleSteam.unref === 'function') {
                stage1BottleSteam.unref();
              }

              await waitForSteamColdStartupCloudReady(bottleSteamRoot, effectiveSteamAppId, {
                ...options,
                preBootLogOffset,
                steamRootStrict: true,
                isBottleSteam: true,
              });
            } catch (coldStartErr) {
              diagLog.warn('launchGame.bottleSteamColdStartSync', coldStartErr, {
                gameId,
                appId: effectiveSteamAppId,
              });
            }
          }

          if (
            chosenCompatLayer &&
            chosenCompatLayer.binaryPath &&
            ((shouldWakeBottleGog && bottleGogExe) || (shouldWakeBottleEpic && bottleEpicExe))
          ) {
            const bottleClientSpawnImpl =
              typeof options.bottleClientSpawnFn === 'function'
                ? options.bottleClientSpawnFn
                : typeof options.gameSpawnFn === 'function'
                  ? options.gameSpawnFn
                  : typeof options.spawnFn === 'function'
                    ? options.spawnFn
                    : spawn;

            if (shouldWakeBottleGog && bottleGogExe) {
              await reapOrphanedGogOverlayProcesses(options);
              wasBottleGogRunning = await isBottleWinExeRunning(
                'GalaxyClient.exe',
                targetWinePrefix,
                options
              );
              if (!wasBottleGogRunning) {
                try {
                  if (!isTestEnvironment(options)) {
                    const portBusy = await probeLocalTcpPort(9977, '127.0.0.1', 300, options);
                    if (portBusy && !(await isHostGogGalaxyRunning(options))) {
                      await new Promise((r) => {
                        execFile(
                          '/usr/bin/pkill',
                          ['-TERM', '-f', 'GalaxyCommunication'],
                          () => r(undefined)
                        );
                      });
                      await new Promise((r) => setTimeout(r, 400));
                    }
                  }

                  const gogCommLog = resolveGogCommunicationLogPath({
                    platform: 'win32',
                    bottlePath: targetWinePrefix,
                    options,
                  });
                  let preBootGogLogOffset = 0;
                  try {
                    if (gogCommLog && fs.existsSync(gogCommLog)) {
                      preBootGogLogOffset = fs.statSync(gogCommLog).size;
                    }
                  } catch {}

                  emitSessionUpdated(
                    {
                      gameId,
                      platformId: payload.platformId || 'gog',
                      status: 'starting',
                      event: 'starting',
                      statusMessage: 'Starting Bottle GOG Galaxy SDK service...',
                    },
                    options
                  );

                  const bottleGogRoot = path.dirname(bottleGogExe);
                  const bottleGogArgs = [
                    bottleGogExe,
                    ...(effectivePerfPolicy.storefrontClientLifecycle === 'default_client'
                      ? []
                      : ['/launchViaAutoStart', '/runWithoutUpdating']),
                  ];
                  const bgBottleGog = bottleClientSpawnImpl(
                    chosenCompatLayer.binaryPath,
                    bottleGogArgs,
                    {
                      cwd: fs.existsSync(bottleGogRoot) ? bottleGogRoot : effectiveCwd,
                      env,
                      stdio: 'ignore',
                      detached: true,
                    }
                  );
                  if (bgBottleGog && typeof bgBottleGog.unref === 'function') {
                    bgBottleGog.unref();
                  }
                  wokeBottleGogByLauncher = true;

                  await waitForGogCommunicationServiceReady({
                    platform: 'win32',
                    bottlePath: targetWinePrefix,
                    preBootLogOffset: preBootGogLogOffset,
                    timeoutMs: 45000,
                    options,
                  });
                } catch (bgGogErr) {
                  diagLog.warn('launchGame.bottleGogWake', bgGogErr, { gameId });
                }
              } else {
                await waitForGogCommunicationServiceReady({
                  platform: 'win32',
                  bottlePath: targetWinePrefix,
                  alreadyRunning: true,
                  timeoutMs: 8000,
                  options,
                });
              }
            }

            if (shouldWakeBottleEpic && bottleEpicExe) {
              wasBottleEpicRunning = await isBottleWinExeRunning(
                'EpicGamesLauncher.exe',
                targetWinePrefix,
                options
              );
              if (!wasBottleEpicRunning) {
                try {
                  let preBootEpicLogOffset = 0;
                  if (targetWinePrefix) {
                    const candidateEpicLog = path.join(
                      targetWinePrefix,
                      'drive_c',
                      'users',
                      'crossover',
                      'AppData',
                      'Local',
                      'EpicGamesLauncher',
                      'Saved',
                      'Logs',
                      'EpicGamesLauncher.log'
                    );
                    try {
                      if (fs.existsSync(candidateEpicLog)) {
                        preBootEpicLogOffset = fs.statSync(candidateEpicLog).size;
                      }
                    } catch {}
                  }

                  emitSessionUpdated(
                    {
                      gameId,
                      platformId: payload.platformId || 'epic',
                      status: 'starting',
                      event: 'starting',
                      statusMessage: 'Starting Bottle Epic Games Launcher...',
                    },
                    options
                  );

                  const bottleEpicRoot = path.dirname(bottleEpicExe);
                  const bottleEpicArgs = [
                    bottleEpicExe,
                    ...(effectivePerfPolicy.storefrontClientLifecycle === 'default_client'
                      ? []
                      : ['-silent']),
                  ];
                  const bgBottleEpic = bottleClientSpawnImpl(
                    chosenCompatLayer.binaryPath,
                    bottleEpicArgs,
                    {
                      cwd: fs.existsSync(bottleEpicRoot) ? bottleEpicRoot : effectiveCwd,
                      env,
                      stdio: 'ignore',
                      detached: true,
                    }
                  );
                  if (bgBottleEpic && typeof bgBottleEpic.unref === 'function') {
                    bgBottleEpic.unref();
                  }
                  wokeBottleEpicByLauncher = true;

                  await waitForBottleEpicPortalReady({
                    bottlePath: targetWinePrefix,
                    preBootLogOffset: preBootEpicLogOffset,
                    timeoutMs: 25000,
                    options,
                  });
                } catch (bgEpicErr) {
                  diagLog.warn('launchGame.bottleEpicWake', bgEpicErr, { gameId });
                }
              }
            }
          }

          /** @type {Record<string, any>} */
          let spawnEnv = env;
          if (
            platform === 'darwin' &&
            spawnEnv &&
            spawnEnv.DYLD_INSERT_LIBRARIES &&
            !isTestEnvironment(options)
          ) {
            if (useCompatLayer) {
              spawnEnv = { ...env };
              spawnCmd = resolveSipSafeWineBinaryAndPreloadEnv(spawnCmd, spawnEnv);
              if (isMacSipProtectedExecutableOrScript(spawnCmd)) {
                // CrossOver's #!/usr/bin/perl wrapper consumes CX_DYLD_INSERT_LIBRARIES (mirrored above)
                // and injects it into non-SIP wineloader; strip outer DYLD_INSERT_LIBRARIES on SIP Perl.
                delete spawnEnv.DYLD_INSERT_LIBRARIES;
              }
            } else if (isMacSipProtectedExecutableOrScript(spawnCmd)) {
              spawnEnv = { ...env };
              delete spawnEnv.DYLD_INSERT_LIBRARIES;
            }
          }

          /** @type {any} */
          let child = null;
          if (activatedXboxPid > 0) {
            child = {
              pid: activatedXboxPid,
              stderr: null,
              on: () => {},
              once: () => {},
            };
          } else {
            try {
              if (
                platform === 'win32' &&
                !useCompatLayer &&
                payload.platformId === 'xbox' &&
                /\bgamelaunchhelper\.exe$/i.test(String(spawnCmd || ''))
              ) {
                launchedViaXboxActivationLatch = true;
              }
              const resolvedDirectSpawn =
                gameSpawnImpl === spawn
                  ? resolveWindowsNodeShebangSpawn(spawnCmd, spawnArgs)
                  : { cmd: spawnCmd, args: spawnArgs };
              child = gameSpawnImpl(resolvedDirectSpawn.cmd, resolvedDirectSpawn.args, {
                cwd: effectiveCwd,
                env: spawnEnv,
                stdio: ['ignore', 'ignore', 'pipe'],
                detached: false,
              });
              if (
                platform === 'win32' &&
                !useCompatLayer &&
                child &&
                child.pid === undefined &&
                typeof child.once === 'function'
              ) {
                const asyncSpawnErr = await new Promise((resolve) => {
                  let settled = false;
                  const finish = (/** @type {any} */ errVal) => {
                    if (settled) return;
                    settled = true;
                    resolve(errVal);
                  };
                  child.once('error', (/** @type {any} */ err) => finish(err));
                  child.once('spawn', () => finish(null));
                  const t = setTimeout(() => finish(null), 50);
                  if (typeof t.unref === 'function') t.unref();
                });
                if (asyncSpawnErr) {
                  throw asyncSpawnErr;
                }
              }
            } catch (/** @type {any} */ initialSpawnErr) {
              if (
                platform === 'win32' &&
                !useCompatLayer &&
                isWindowsElevationRequiredError(initialSpawnErr, spawnCmd, options)
              ) {
                child = spawnWindowsViaPowerShellStartProcess(
                  gameSpawnImpl,
                  spawnCmd,
                  spawnArgs,
                  effectiveCwd,
                  spawnEnv,
                  true
                );
              } else if (
                !useCompatLayer &&
                isAutoLikeMethod &&
                buildStorefrontLaunchUri(payload)
              ) {
                shouldFallthroughToStorefrontUri = true;
              } else if (platform === 'win32' && !useCompatLayer) {
                child = spawnWindowsViaPowerShellStartProcess(
                  gameSpawnImpl,
                  spawnCmd,
                  spawnArgs,
                  effectiveCwd,
                  spawnEnv,
                  false
                );
              } else {
                throw initialSpawnErr;
              }
            }
          }

          if (!shouldFallthroughToStorefrontUri && child) {
            const session = {
              sessionId: `session-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
              gameId,
              title: String(payload.title || gameId),
              platformId: payload.platformId || 'custom',
              platformGameId: String(payload.platformGameId || gameId),
              pid: shouldLaunchViaBottleSteam ? undefined : child.pid,
              startedAt: new Date().toISOString(),
              launchMethod: actualLaunchMethod,
              executablePath: resolvedExePath,
              status: 'running',
            };

            const resolvedWineBinary =
              useCompatLayer && chosenCompatLayer ? chosenCompatLayer.binaryPath || null : null;
            const resolvedWineserverBinary = resolvedWineBinary
              ? resolveWineserverBinary(resolvedWineBinary)
              : null;
            const resolvedWinePrefix = useCompatLayer
              ? compatResult?.winePrefix || env.WINEPREFIX || null
              : null;

            /** @type {any} */
            const entry = {
              session,
              platformId: session.platformId,
              child,
              pid: shouldLaunchViaBottleSteam ? 0 : child.pid || 0,
              elevatedTargetPid: 0,
              pollTimer: null,
              startedMs: Date.now(),
              postExitCommand: launchConfig.postExitCommand,
              finalized: false,
              stopping: false,
              stderrBuffer: '',
              exitCode: null,
              stoppedByUser: false,
              wineBinary: resolvedWineBinary,
              wineserverBinary: resolvedWineserverBinary,
              winePrefix: resolvedWinePrefix,
              launchEnv: env,
              installPath: localInstallDir || payload.installPath || '',
              platformGameId: String(payload.platformGameId || payload.steamAppId || gameId),
              steamAppId: effectiveSteamAppId || undefined,
              launchOptions: options,
              launchConfig,
              effectiveStorefrontLifecycle: effectivePerfPolicy.storefrontClientLifecycle,
              wokeGogGalaxyByLauncher: Boolean(gogWakeResult && gogWakeResult.started),
              gogGalaxyClientPath: gogWakeResult ? gogWakeResult.clientPath || null : null,
              wokeSteamByLauncher: false,
              steamClientBinaryPath: null,
              launchedViaBottleSteam: shouldLaunchViaBottleSteam,
              bottleSteamExe: shouldLaunchViaBottleSteam ? bottleSteamExe : null,
              bottleSteamRoot:
                shouldLaunchViaBottleSteam && bottleSteamExe ? path.dirname(bottleSteamExe) : null,
              wokeBottleSteamByLauncher: shouldLaunchViaBottleSteam
                ? !wasBottleSteamRunning
                : false,
              bottleGogExe: shouldWakeBottleGog ? bottleGogExe : null,
              wasBottleGogRunning,
              wokeBottleGogByLauncher,
              bottleEpicExe: shouldWakeBottleEpic ? bottleEpicExe : null,
              wasBottleEpicRunning,
              wokeBottleEpicByLauncher,
              xboxLoopbackServer,
              packageFamilyName: resolvedXboxPfn || undefined,
              scid: resolvedXboxScid || undefined,
              fallbackScid: resolvedXboxFallbackScid || undefined,
              isAppxRegistered: isXboxAppxRegisteredOnWin32 || undefined,
              msaAppId: resolvedXboxMsaAppId || undefined,
              xboxTitleId: resolvedXboxTitleId || undefined,
              xboxProductId: resolvedXboxProductId || undefined,
              appUserModelId: resolvedXboxAumid || undefined,
              wasXboxAppRunningAtStart,
              wokeXboxAppByLauncher: false,
            };

            if (
              child._isPowerShellStartProcessWrapper &&
              child.stdout &&
              typeof child.stdout.on === 'function'
            ) {
              let psStdoutHeader = '';
              child.stdout.on('data', (/** @type {any} */ chunk) => {
                if (psStdoutHeader.length < 512) {
                  psStdoutHeader += String(chunk || '');
                  const pidMatch = psStdoutHeader.match(/OL_ELEVATED_PID=(\d+)/);
                  if (pidMatch && pidMatch[1]) {
                    const latchedPid = Number.parseInt(pidMatch[1], 10);
                    if (latchedPid > 0) {
                      entry.elevatedTargetPid = latchedPid;
                      entry.pid = latchedPid;
                      if (entry.session) {
                        entry.session.pid = latchedPid;
                      }
                    }
                  }
                }
              });
            }

            if (child.stderr && typeof child.stderr.on === 'function') {
              child.stderr.on('data', (/** @type {any} */ chunk) => {
                if (entry.stderrBuffer.length < 4096) {
                  entry.stderrBuffer += String(chunk);
                }
              });
            }

            activeSessions.set(gameId, entry);
            releasePendingBottleLock();
            releasePendingPlatformLock();

            if (effectivePerfPolicy.pauseDownloadsInGame !== false) {
              try {
                pauseActiveDownloadsForInGame(options);
              } catch {}
            }
            emitSessionUpdated({ session: { ...session }, event: 'started' }, options);

            if (shouldLaunchViaBottleSteam) {
              if (typeof child.on === 'function') {
                child.on('error', (/** @type {any} */ err) => {
                  entry.exitCode = -1;
                  entry.stderrBuffer += '\n' + (err && err.message ? err.message : String(err));
                  if (!entry.stopping) {
                    finalizeGameSession(gameId, options);
                  }
                });
              }

              if (!options.disableBottleSteamPolling) {
                const candidateGameExeNames = new Set();
                if (resolvedExePath) {
                  candidateGameExeNames.add(path.basename(resolvedExePath).toLowerCase());
                }
                if (payload.executablePath) {
                  candidateGameExeNames.add(path.basename(payload.executablePath).toLowerCase());
                }
                if (localInstallDir && fs.existsSync(localInstallDir)) {
                  try {
                    const topEntries = fs.readdirSync(localInstallDir, { withFileTypes: true });
                    for (const ent of topEntries) {
                      if (
                        ent.isFile() &&
                        ent.name.toLowerCase().endsWith('.exe') &&
                        !/^(?:steam|steamwebhelper|steamservice|steamerrorreporter|unins\d+|vc_redist.*|dxsetup|unitycrashhandler.*|crashreportclient.*)\.exe$/i.test(
                          ent.name
                        )
                      ) {
                        candidateGameExeNames.add(ent.name.toLowerCase());
                      }
                    }
                  } catch {}
                }
                const bottleExeHints = Array.from(candidateGameExeNames).filter(Boolean);
                const bottlePollMs = Math.max(
                  15,
                  Number(options.bottleSteamPollIntervalMs || 1500)
                );
                const maxLaunchWaitMs = Number(options.bottleSteamMaxLaunchWaitMs ?? 120000);
                const execFileImpl =
                  typeof options.execFileImpl === 'function'
                    ? options.execFileImpl
                    : typeof options.execFileFn === 'function'
                      ? options.execFileFn
                      : execFile;
                const hasMockProcessSource =
                  typeof options.getProcessListOutput === 'function' ||
                  typeof options.execFileImpl === 'function' ||
                  typeof options.execFileFn === 'function' ||
                  typeof options.bottleSteamProcessListFn === 'function';
                let seenGameRunning = false;

                const pollTimer = setInterval(() => {
                  if (entry.finalized || entry.stopping) {
                    clearInterval(pollTimer);
                    entry.pollTimer = null;
                    return;
                  }

                  const trackedPid = Number(entry.pid || entry.session?.pid || 0);
                  if (
                    trackedPid > 0 &&
                    !hasMockProcessSource &&
                    typeof options.mockProcessListOutput !== 'string'
                  ) {
                    let trackedAlive = false;
                    try {
                      process.kill(trackedPid, 0);
                      trackedAlive = true;
                    } catch (/** @type {any} */ killErr) {
                      trackedAlive = Boolean(killErr && killErr.code === 'EPERM');
                    }
                    if (trackedAlive) {
                      seenGameRunning = true;
                      return;
                    }
                    entry.pid = 0;
                    if (entry.session) {
                      entry.session.pid = undefined;
                    }
                  }

                  const handleBottleProcessList = (/** @type {any} */ err, /** @type {any} */ stdout) => {
                    if (err || entry.finalized || entry.stopping) return;
                    const outStr = String(stdout || '');
                    const matchedPid = extractMatchedPidFromProcessOutput(
                      outStr,
                      bottleExeHints,
                      'darwin'
                    );
                    const lowerOut = outStr.toLowerCase();
                    const isPresent =
                      matchedPid > 0 || bottleExeHints.some((h) => h && lowerOut.includes(h));
                    if (isPresent) {
                      seenGameRunning = true;
                      if (matchedPid > 0) {
                        entry.pid = matchedPid;
                        if (entry.session) {
                          entry.session.pid = matchedPid;
                        }
                      }
                    } else if (seenGameRunning) {
                      entry.exitCode = 0;
                      finalizeGameSession(gameId, options);
                    } else if (
                      maxLaunchWaitMs > 0 &&
                      Date.now() - entry.startedMs >= maxLaunchWaitMs
                    ) {
                      entry.exitCode = 0;
                      finalizeGameSession(gameId, options);
                    }
                  };

                  if (typeof options.bottleSteamProcessListFn === 'function') {
                    Promise.resolve(options.bottleSteamProcessListFn())
                      .then((out) => handleBottleProcessList(null, out))
                      .catch(() => {});
                  } else if (typeof options.getProcessListOutput === 'function') {
                    Promise.resolve(options.getProcessListOutput())
                      .then((out) => handleBottleProcessList(null, out))
                      .catch(() => {});
                  } else if (
                    typeof options.execFileImpl === 'function' ||
                    typeof options.execFileFn === 'function' ||
                    !options.homedir
                  ) {
                    execFileImpl(
                      'ps',
                      ['-ax', '-o', 'pid=,command='],
                      { timeout: 2500 },
                      handleBottleProcessList
                    );
                  } else if (typeof options.mockProcessListOutput === 'string') {
                    handleBottleProcessList(null, options.mockProcessListOutput);
                  }
                }, bottlePollMs);

                if (typeof pollTimer.unref === 'function') {
                  pollTimer.unref();
                }
                entry.pollTimer = pollTimer;
              }
            } else if (launchedViaXboxActivationLatch && platform === 'win32') {
              const xboxPollMs = Math.max(25, Number(options.xboxPollIntervalMs || 1500));
              const maxXboxBootstrapWaitMs = Number(options.xboxMaxBootstrapWaitMs ?? 60000);
              const candidateXboxExes = new Set();
              if (
                resolvedExePath &&
                !/^(?:explorer|gamelaunchhelper)\.exe$/i.test(path.basename(resolvedExePath))
              ) {
                candidateXboxExes.add(path.basename(resolvedExePath).toLowerCase());
              }
              if (xboxGameCfg?.executables) {
                for (const ex of xboxGameCfg.executables) {
                  if (ex && !ex.isGameLaunchHelper && !ex.isHelperStub && ex.name) {
                    candidateXboxExes.add(path.posix.basename(ex.name).toLowerCase());
                  }
                }
              }
              const xboxExeHints = Array.from(candidateXboxExes).filter(Boolean);
              const execFileImpl = options.execFileImpl || options.execFileFn || execFile;
              let seenRealXboxGamePid = false;

              const pollTimer = setInterval(() => {
                if (entry.finalized || entry.stopping) {
                  clearInterval(pollTimer);
                  entry.pollTimer = null;
                  return;
                }

                const finalizeWithXboxWakeCheck = () => {
                  isWindowsXboxAppRunning(options)
                    .then((runningNow) => {
                      if (!wasXboxAppRunningAtStart && runningNow) {
                        entry.wokeXboxAppByLauncher = true;
                      }
                    })
                    .catch(() => {})
                    .finally(() => {
                      entry.exitCode = 0;
                      finalizeGameSession(gameId, options);
                    });
                };

                const handleWinProcOutput = (/** @type {any} */ err, /** @type {any} */ stdout) => {
                  if (err || entry.finalized || entry.stopping) return;
                  const outStr = String(stdout || '');
                  const matchedPid =
                    xboxExeHints.length > 0
                      ? extractMatchedPidFromProcessOutput(outStr, xboxExeHints, 'win32')
                      : 0;
                  if (matchedPid > 0) {
                    seenRealXboxGamePid = true;
                    entry.pid = matchedPid;
                    if (entry.session) entry.session.pid = matchedPid;
                    return;
                  }

                  const trackedPid = Number(entry.pid || entry.session?.pid || 0);
                  if (
                    trackedPid > 0 &&
                    typeof options.getProcessListOutput !== 'function' &&
                    typeof options.mockProcessListOutput !== 'string'
                  ) {
                    let alive = false;
                    try {
                      process.kill(trackedPid, 0);
                      alive = true;
                    } catch (/** @type {any} */ kErr) {
                      alive = Boolean(kErr && kErr.code === 'EPERM');
                    }
                    if (alive) {
                      if (Date.now() - entry.startedMs > 3000) {
                        seenRealXboxGamePid = true;
                      }
                      return;
                    }
                  }

                  if (
                    seenRealXboxGamePid ||
                    Date.now() - entry.startedMs >= maxXboxBootstrapWaitMs
                  ) {
                    clearInterval(pollTimer);
                    entry.pollTimer = null;
                    finalizeWithXboxWakeCheck();
                  }
                };

                if (typeof options.getProcessListOutput === 'function') {
                  Promise.resolve(options.getProcessListOutput())
                    .then((out) => handleWinProcOutput(null, out))
                    .catch(() => {});
                } else if (typeof options.mockProcessListOutput === 'string') {
                  handleWinProcOutput(null, options.mockProcessListOutput);
                } else if (!options.homedir || options.execFileImpl || options.execFileFn) {
                  execFileImpl(
                    'tasklist.exe',
                    ['/FO', 'CSV', '/NH'],
                    { timeout: 2500, windowsHide: true },
                    handleWinProcOutput
                  );
                }
              }, xboxPollMs);
              if (typeof pollTimer.unref === 'function') pollTimer.unref();
              entry.pollTimer = pollTimer;
            } else if (typeof child.on === 'function') {
              child.on('exit', (/** @type {any} */ code, /** @type {any} */ signal) => {
                if (entry.exitCode === null || entry.exitCode === undefined) {
                  if (typeof code === 'number') {
                    entry.exitCode = code;
                  } else if (signal && !entry.stoppedByUser && !entry.stopping) {
                    entry.exitCode = -1;
                    entry.exitSignal = signal;
                    if (!entry.stderrBuffer.trim()) {
                      entry.stderrBuffer = `Process terminated by signal ${signal}`;
                    }
                  } else {
                    entry.exitCode = 0;
                  }
                }
                if (entry.stopping) {
                  return;
                }
                if (child.stderr && !child.stderr.destroyed && child.stderr.readable) {
                  child.once('close', () => {
                    if (!entry.stopping) finalizeGameSession(gameId, options);
                  });
                  const flushTimer = setTimeout(() => {
                    if (!entry.stopping) finalizeGameSession(gameId, options);
                  }, 50);
                  if (typeof flushTimer.unref === 'function') flushTimer.unref();
                } else {
                  finalizeGameSession(gameId, options);
                }
              });

              child.on('error', (/** @type {any} */ err) => {
                entry.exitCode = -1;
                entry.stderrBuffer += '\n' + (err && err.message ? err.message : String(err));
                if (!entry.stopping) {
                  finalizeGameSession(gameId, options);
                }
              });
            }

            const startupWaitMs =
              options.startupWaitMs !== undefined
                ? Number(options.startupWaitMs)
                : options.homedir || options.skipStartupWait
                  ? 0
                  : 450;

            if (startupWaitMs > 0) {
              await new Promise((r) => {
                if (entry.exitCode !== null) return r(undefined);
                let done = false;
                const finish = () => {
                  if (done) return;
                  done = true;
                  clearTimeout(t);
                  r(undefined);
                };
                const t = setTimeout(finish, startupWaitMs);
                if (child && typeof child.once === 'function') {
                  child.once('exit', finish);
                  child.once('error', finish);
                }
              });
            }

            if (entry.exitCode !== null && entry.exitCode !== 0) {
              const rawStderr = (entry.stderrBuffer || '').trim();
              const fatalMatch = rawStderr.match(/Fatal Error:\s*(.+)/i);
              const stderrLines = rawStderr
                .split(/\r?\n/)
                .map((/** @type {string} */ l) => l.trim())
                .filter(Boolean);
              const extractedError =
                (fatalMatch && fatalMatch[0]) ||
                (stderrLines.length > 0 ? stderrLines[stderrLines.length - 1] : '') ||
                `Process exited immediately with code ${entry.exitCode}`;
              if (
                !useCompatLayer &&
                isAutoLikeMethod &&
                /spawn\s+UNKNOWN/i.test(extractedError) &&
                buildStorefrontLaunchUri(payload)
              ) {
                shouldFallthroughToStorefrontUri = true;
              } else {
                return {
                  success: false,
                  error: extractedError,
                  sessionMinutesPlayed: 0,
                };
              }
            } else {
              return {
                success: true,
                message: `Launched ${session.title}`,
                session: { ...session },
                executablePath: resolvedExePath,
              };
            }
          }
        } catch (/** @type {any} */ spawnErr) {
          if (xboxLoopbackServer && typeof xboxLoopbackServer.close === 'function') {
            try {
              await xboxLoopbackServer.close();
            } catch {}
            xboxLoopbackServer = null;
          }
          if (!useCompatLayer && isAutoLikeMethod && buildStorefrontLaunchUri(payload)) {
            shouldFallthroughToStorefrontUri = true;
          } else {
            return {
              success: false,
              error: `Failed to spawn game process: ${spawnErr.message}`,
            };
          }
        }
      }
    }

    releasePendingBottleLock();

    // 2. Storefront URI Launch (or 'auto' fallback when no local executable is found)
    const uri = buildStorefrontLaunchUri(payload);
    if (!uri) {
      return {
        success: false,
        error: 'No local executable or storefront protocol URI available to launch this game.',
      };
    }

    let uriHostSteamRoot = '';
    let steamGameProcessLogOffset = 0;
    if (payload.platformId === 'steam') {
      uriHostSteamRoot =
        options.steamRoot ||
        (platform === 'win32'
          ? (() => {
              const sBin = resolveSteamClientBinaryPath(options);
              return sBin ? path.dirname(sBin) : '';
            })()
          : !options.homedir && isTestEnvironment(options)
            ? ''
            : path.join(
                options.homedir || os.homedir(),
                'Library',
                'Application Support',
                'Steam'
              ));
      if (uriHostSteamRoot) {
        const gpLogPath = path.join(uriHostSteamRoot, 'logs', 'gameprocess_log.txt');
        try {
          if (fs.existsSync(gpLogPath)) {
            steamGameProcessLogOffset = fs.statSync(gpLogPath).size;
          }
        } catch {}
      }
    }

    if (
      payload.platformId === 'steam' &&
      (!options.homedir ||
        typeof options.spawnFn === 'function' ||
        Boolean(options.steamClientBinaryPath || options.customApplicationsDir) ||
        options.allowSteamMinimalSpawnInTest ||
        options.enableTwoStageSteamColdStart === true)
    ) {
      try {
        const steamAppIdVal = String(payload.steamAppId || payload.platformGameId || '')
          .replace(/^steam[-_]/i, '')
          .trim();
        const steamLaunchSpec = await resolveSteamClientLaunchCommand(steamAppIdVal, args, {
          ...options,
          launchConfig,
          storefrontClientLifecycle: effectivePerfPolicy.storefrontClientLifecycle,
        });
        if (
          steamLaunchSpec &&
          !steamLaunchSpec.alreadyRunning &&
          steamLaunchSpec.binaryPath &&
          !isFastMinimalBypass &&
          (!isTestEnvironment(options) || options.enableTwoStageSteamColdStart === true)
        ) {
          const spawnImpl = typeof options.spawnFn === 'function' ? options.spawnFn : spawn;
          const hostSteamRoot =
            options.steamRoot ||
            uriHostSteamRoot ||
            (platform === 'win32'
              ? path.dirname(steamLaunchSpec.binaryPath)
              : path.join(
                  options.homedir || os.homedir(),
                  'Library',
                  'Application Support',
                  'Steam'
                ));
          uriHostSteamRoot = hostSteamRoot;
          const hostCloudLogPath = hostSteamRoot
            ? path.join(hostSteamRoot, 'logs', 'cloud_log.txt')
            : '';
          let preBootLogOffset = 0;
          try {
            if (hostCloudLogPath && fs.existsSync(hostCloudLogPath)) {
              preBootLogOffset = fs.statSync(hostCloudLogPath).size;
            }
          } catch {}

          emitSessionUpdated(
            {
              gameId,
              platformId: payload.platformId || 'steam',
              status: 'starting',
              event: 'starting',
              statusMessage: 'Starting Steam & syncing Steam Cloud...',
            },
            options
          );

          const macSteamAppMatch =
            platform === 'darwin' && typeof options.spawnFn !== 'function'
              ? String(steamLaunchSpec.binaryPath).match(/^(.*?\.app)(?:\/|$)/i)
              : null;
          if (macSteamAppMatch && macSteamAppMatch[1] && steamLaunchSpec.useMinimalBinarySpawn) {
            const stage1Child = spawnImpl(
              '/usr/bin/open',
              [
                '-g',
                '-j',
                '-a',
                macSteamAppMatch[1],
                '--args',
                '-silent',
                '-nofriendsui',
                '-nochatui',
              ],
              {
                detached: true,
                stdio: 'ignore',
              }
            );
            if (stage1Child && typeof stage1Child.unref === 'function') {
              stage1Child.unref();
            }
          } else {
            const stage1Args = steamLaunchSpec.useMinimalBinarySpawn ? ['-silent'] : [];
            const stage1Child = spawnImpl(steamLaunchSpec.binaryPath, stage1Args, {
              detached: true,
              stdio: 'ignore',
              windowsHide: true,
            });
            if (stage1Child && typeof stage1Child.unref === 'function') {
              stage1Child.unref();
            }
          }

          await waitForSteamColdStartupCloudReady(hostSteamRoot, steamAppIdVal, {
            ...options,
            preBootLogOffset,
          });

          if (steamLaunchSpec.useMinimalBinarySpawn) {
            const hasCustomOpenExternal =
              typeof options.openExternalFn === 'function' ||
              typeof options.onOpenExternal === 'function';
            if (platform === 'win32' || (!hasCustomOpenExternal && steamLaunchSpec.binaryPath)) {
              const stage2Child = spawnImpl(steamLaunchSpec.binaryPath, steamLaunchSpec.args, {
                detached: true,
                stdio: 'ignore',
                windowsHide: true,
              });
              if (stage2Child && typeof stage2Child.unref === 'function') {
                stage2Child.unref();
              }
            } else {
              await openExternalUri(uri, options);
            }
            steamMinimalSpawnedResult = steamLaunchSpec;
          }
        } else if (
          steamLaunchSpec &&
          steamLaunchSpec.useMinimalBinarySpawn &&
          steamLaunchSpec.binaryPath
        ) {
          const spawnImpl = typeof options.spawnFn === 'function' ? options.spawnFn : spawn;
          const steamChild = spawnImpl(steamLaunchSpec.binaryPath, steamLaunchSpec.args, {
            detached: true,
            stdio: 'ignore',
            windowsHide: true,
          });
          if (steamChild && typeof steamChild.unref === 'function') {
            steamChild.unref();
          }
          steamMinimalSpawnedResult = steamLaunchSpec;
        }
      } catch {}
    }

    let wokeEpicByLauncher = false;
    if (payload.platformId === 'epic') {
      const checkEpicOut = (/** @type {any} */ outStr) =>
        /(?:EpicGamesLauncher|Epic Games Launcher)/i.test(String(outStr || ''));
      /** @type {boolean | null} */
      let wasHostEpicRunning = null;
      if (typeof options.mockProcessListOutput === 'string') {
        wasHostEpicRunning = checkEpicOut(options.mockProcessListOutput);
      } else if (typeof options.getProcessListOutput === 'function') {
        try {
          wasHostEpicRunning = checkEpicOut(await options.getProcessListOutput());
        } catch {}
      } else if (
        !options.homedir ||
        typeof options.execFileFn === 'function' ||
        typeof options.execFileImpl === 'function'
      ) {
        const execImpl =
          typeof options.execFileImpl === 'function'
            ? options.execFileImpl
            : typeof options.execFileFn === 'function'
              ? options.execFileFn
              : execFile;
        wasHostEpicRunning = await new Promise((resolve) => {
          try {
            if (platform === 'win32') {
              execImpl(
                'tasklist.exe',
                ['/FI', 'IMAGENAME eq EpicGamesLauncher.exe', '/NH'],
                { timeout: 1500, windowsHide: true },
                (/** @type {any} */ err, /** @type {any} */ stdout) =>
                  resolve(!err && checkEpicOut(stdout))
              );
            } else {
              execImpl(
                'ps',
                ['-ax', '-o', 'command='],
                { timeout: 1500 },
                (/** @type {any} */ err, /** @type {any} */ stdout) =>
                  resolve(!err && checkEpicOut(stdout))
              );
            }
          } catch {
            resolve(true);
          }
        });
      }
      if (wasHostEpicRunning === false) {
        wokeEpicByLauncher = true;
      }
    }

    let gogCliSpawned = false;
    if (payload.platformId === 'gog') {
      const cleanGogId = String(payload.platformGameId || gameId || '')
        .trim()
        .replace(/^gog[-_]/i, '');
      const gogInstallTarget =
        localInstallDir || (payload.installPath ? toLocalFsPath(payload.installPath) : '');

      if (
        gogInstallTarget &&
        fs.existsSync(gogInstallTarget) &&
        (!isTestEnvironment(options) ||
          Boolean(options.gogGalaxyDbPath || options.gogGalaxyConfigPath))
      ) {
        try {
          await syncGogGameToGalaxy(
            {
              platformGameId: payload.platformGameId || gameId,
              title: payload.title,
              installPath: gogInstallTarget,
              executablePath: resolvedExePath || payload.executablePath,
            },
            options
          );
        } catch {}
      }

      const canCheckHostGogForUri =
        !isTestEnvironment(options) ||
        options.mockProcessListOutput !== undefined ||
        typeof options.getProcessListOutput === 'function';

      if (
        platform === 'win32' &&
        typeof options.openExternalFn !== 'function' &&
        cleanGogId &&
        gogInstallTarget &&
        fs.existsSync(gogInstallTarget)
      ) {
        const galaxyClientExe = resolveGogGalaxyClientBinaryPath(options);
        if (galaxyClientExe) {
          try {
            if (canCheckHostGogForUri) {
              const wasWinGogRunning = await isHostGogGalaxyRunning({
                ...options,
                platform: 'win32',
              });
              if (!wasWinGogRunning) {
                gogWakeResult = {
                  found: true,
                  alreadyRunning: false,
                  started: true,
                  clientPath: galaxyClientExe,
                };
              }
            }
            const spawnImpl = typeof options.spawnFn === 'function' ? options.spawnFn : spawn;
            const gogChild = spawnImpl(
              galaxyClientExe,
              [`/command=runGame`, `/gameId=${cleanGogId}`, `/path=${gogInstallTarget}`],
              {
                detached: true,
                stdio: 'ignore',
                windowsHide: true,
              }
            );
            if (gogChild && typeof gogChild.unref === 'function') {
              gogChild.unref();
            }
            gogCliSpawned = true;
          } catch {}
        }
      }

      if (!gogCliSpawned) {
        const shouldPreWakeSilentMacGogForUri =
          platform === 'darwin' &&
          effectivePerfPolicy.storefrontClientLifecycle !== 'default_client' &&
          effectivePerfPolicy.storefrontClientLifecycle !== 'fast_direct_bypass' &&
          options.disableGogGalaxyWake !== true;

        if (shouldPreWakeSilentMacGogForUri) {
          try {
            const preWakeRes = await ensureGogGalaxyBackgroundService({
              ...options,
              platform,
              storefrontClientLifecycle: effectivePerfPolicy.storefrontClientLifecycle,
            });
            if (preWakeRes && !preWakeRes.skippedInTest) {
              gogWakeResult = preWakeRes;
            }
          } catch {}
        }

        if (!gogWakeResult && canCheckHostGogForUri) {
          try {
            const wasHostGogRunningForUri = await isHostGogGalaxyRunning({
              ...options,
              platform,
            });
            if (!wasHostGogRunningForUri) {
              const detectedHostClientPath = resolveGogGalaxyClientBinaryPath({
                ...options,
                platform,
              });
              gogWakeResult = {
                found: Boolean(detectedHostClientPath),
                alreadyRunning: false,
                started: true,
                clientPath: detectedHostClientPath,
              };
            }
          } catch {}
        }
      }
    }

    if (!steamMinimalSpawnedResult && !gogCliSpawned) {
      const shouldBackgroundUriOpen =
        payload.platformId === 'gog' &&
        platform === 'darwin' &&
        effectivePerfPolicy.storefrontClientLifecycle !== 'default_client';
      await openExternalUri(
        uri,
        shouldBackgroundUriOpen ? { ...options, activate: false } : options
      );
    }

    const session = {
      sessionId: `session-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      gameId,
      title: String(payload.title || gameId),
      platformId: payload.platformId || 'steam',
      platformGameId: String(payload.platformGameId || payload.steamAppId || gameId),
      pid: undefined,
      startedAt: new Date().toISOString(),
      launchMethod: 'storefront_uri',
      executablePath: resolvedExePath || payload.executablePath,
      status: 'running',
    };

    /** @type {any} */
    const entry = {
      session,
      platformId: session.platformId,
      child: null,
      startedMs: Date.now(),
      postExitCommand: launchConfig.postExitCommand,
      finalized: false,
      stopping: false,
      pollTimer: null,
      stderrBuffer: '',
      exitCode: null,
      stoppedByUser: false,
      wineBinary: null,
      wineserverBinary: null,
      winePrefix: null,
      installPath: localInstallDir || payload.installPath || '',
      platformGameId: String(payload.platformGameId || payload.steamAppId || gameId),
      steamAppId: effectiveSteamAppId || undefined,
      steamRoot: uriHostSteamRoot || undefined,
      launchOptions: options,
      launchConfig,
      effectiveStorefrontLifecycle: effectivePerfPolicy.storefrontClientLifecycle,
      wokeGogGalaxyByLauncher: Boolean(gogWakeResult && gogWakeResult.started),
      gogGalaxyClientPath: gogWakeResult ? gogWakeResult.clientPath || null : null,
      wokeSteamByLauncher: Boolean(
        steamMinimalSpawnedResult && steamMinimalSpawnedResult.wokeSteamByLauncher
      ),
      steamClientBinaryPath: steamMinimalSpawnedResult
        ? steamMinimalSpawnedResult.binaryPath || null
        : null,
      wokeEpicByLauncher: Boolean(wokeEpicByLauncher),
    };

    const canMonitorSteamLog = Boolean(
      payload.platformId === 'steam' && uriHostSteamRoot && effectiveSteamAppId
    );
    if ((payload.installPath || canMonitorSteamLog) && !options.disableUriPolling) {
      let seenRunningOnSystem = false;
      const pollIntervalMs = Number(options.uriPollIntervalMs || 4000);
      const execFileImpl = typeof options.execFileFn === 'function' ? options.execFileFn : execFile;
      const pollTimer = setInterval(() => {
        if (entry.finalized) {
          clearInterval(pollTimer);
          entry.pollTimer = null;
          return;
        }
        const trackedPid = Number(entry.session?.pid || entry.pid || 0);
        if (trackedPid > 0) {
          const isPidAliveFn =
            typeof options.isPidAliveFn === 'function' ? options.isPidAliveFn : null;
          let trackedAlive = false;
          if (isPidAliveFn) {
            try {
              trackedAlive = Boolean(isPidAliveFn(trackedPid));
            } catch {
              trackedAlive = false;
            }
          } else {
            try {
              process.kill(trackedPid, 0);
              trackedAlive = true;
            } catch (/** @type {any} */ killErr) {
              trackedAlive = Boolean(killErr && killErr.code === 'EPERM');
            }
          }
          if (trackedAlive) {
            seenRunningOnSystem = true;
            return;
          }
          entry.pid = 0;
          if (entry.session) {
            entry.session.pid = undefined;
          }
        }

        if (canMonitorSteamLog) {
          const steamLogPid = extractTrackedPidFromSteamGameProcessLog(
            uriHostSteamRoot,
            effectiveSteamAppId,
            steamGameProcessLogOffset,
            options
          );
          if (steamLogPid > 0) {
            seenRunningOnSystem = true;
            entry.pid = steamLogPid;
            if (entry.session) {
              entry.session.pid = steamLogPid;
            }
            return;
          }
        }

        const targetPlatform = options.platform || process.platform;
        const exeHints = [
          payload.executablePath ? path.basename(payload.executablePath).toLowerCase() : '',
          resolvedExePath ? path.basename(resolvedExePath).toLowerCase() : '',
          payload.installPath ? path.basename(payload.installPath).toLowerCase() : '',
        ].filter(Boolean);
        if (exeHints.length === 0) {
          if (seenRunningOnSystem) {
            finalizeGameSession(gameId, options);
          }
          return;
        }
        const handleProcessList = (/** @type {any} */ err, /** @type {any} */ stdout) => {
          if (err || !stdout || entry.finalized) return;
          const matchedPid = extractMatchedPidFromProcessOutput(
            stdout,
            exeHints,
            targetPlatform
          );
          const isPresent = matchedPid > 0;
          if (isPresent) {
            seenRunningOnSystem = true;
            if (matchedPid > 0) {
              entry.pid = matchedPid;
              if (entry.session) {
                entry.session.pid = matchedPid;
              }
            }
          } else if (seenRunningOnSystem) {
            finalizeGameSession(gameId, options);
          }
        };
        if (targetPlatform === 'win32') {
          execFileImpl(
            'tasklist.exe',
            ['/FO', 'CSV', '/NH'],
            { timeout: 2500, windowsHide: true },
            handleProcessList
          );
        } else {
          execFileImpl('ps', ['-ax', '-o', 'pid=,command='], { timeout: 2500 }, handleProcessList);
        }
      }, pollIntervalMs);
      if (typeof pollTimer.unref === 'function') {
        pollTimer.unref();
      }
      entry.pollTimer = pollTimer;
    }

    activeSessions.set(gameId, entry);
    releasePendingPlatformLock();

    if (effectivePerfPolicy.pauseDownloadsInGame !== false) {
      try {
        pauseActiveDownloadsForInGame(options);
      } catch {}
    }
    emitSessionUpdated({ session: { ...session }, event: 'started' }, options);

    return {
      success: true,
      message: `Opened via ${session.platformId.toUpperCase()} client (${uri})`,
      session: { ...session },
    };
  } catch (/** @type {any} */ err) {
    return {
      success: false,
      error: err.message,
    };
  } finally {
    releasePendingBottleLock();
    releasePendingPlatformLock();
  }
}

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

    if (!targetEntry || !targetKey) {
      return {
        success: false,
        error: 'No active running game session found.',
      };
    }

    targetEntry.stopping = true;
    targetEntry.stoppedByUser = true;
    targetEntry.session.status = 'stopping';
    emitSessionUpdated({
      session: { ...targetEntry.session },
      event: 'stopping',
    });

    const mergedStopOptions = {
      ...(targetEntry.launchOptions || {}),
      ...(options || {}),
    };
    const isTestHomedir = Boolean(mergedStopOptions.homedir || reqObj.homedir);
    const isTestStopEnv =
      isTestEnvironment(mergedStopOptions) && mergedStopOptions.allowProcessCheckInTest !== true;
    const exePath = targetEntry.session?.executablePath || '';
    const exeBase =
      process.platform !== 'win32' && exePath.toLowerCase().endsWith('.exe')
        ? path.basename(exePath)
        : '';

    if (!isTestStopEnv && exeBase && exeBase.length > 3) {
      await killPosixProcessesMatchingWinExe(exePath, 'SIGTERM', targetEntry.winePrefix || '');
    }

    const stopPlatform = mergedStopOptions.platform || process.platform;
    const macAppBundlePath =
      stopPlatform === 'darwin' && !targetEntry.winePrefix
        ? resolveTargetMacAppBundlePath(exePath)
        : null;
    const signalMacAppBundleProcesses = (/** @type {NodeJS.Signals} */ sig) =>
      new Promise((resolve) => {
        if (!macAppBundlePath || isTestStopEnv) return resolve(undefined);
        const macOsDirPrefix = `${path.resolve(macAppBundlePath)}/Contents/MacOS/`;
        try {
          execFile('ps', ['-axo', 'pid=,command='], { timeout: 1500 }, (err, stdout) => {
            if (!err && stdout) {
              for (const rawLine of String(stdout).split(/\r?\n/)) {
                const m = rawLine.trim().match(/^(\d+)\s+(.+)$/);
                if (!m) continue;
                const cPid = Number.parseInt(m[1], 10);
                if (cPid > 1 && cPid !== process.pid && m[2].includes(macOsDirPrefix)) {
                  try {
                    process.kill(cPid, sig);
                  } catch {}
                }
              }
            }
            resolve(undefined);
          });
        } catch {
          resolve(undefined);
        }
      });

    if (macAppBundlePath && !isTestHomedir && !isTestEnvironment(mergedStopOptions)) {
      const bundleId = readMacBundleIdFromInfoPlist(macAppBundlePath);
      if (bundleId && /^[A-Za-z0-9._-]+$/.test(bundleId)) {
        await new Promise((resolve) => {
          try {
            execFile(
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
      await signalMacAppBundleProcesses('SIGTERM');
    }

    const effectivePerfPolicy = resolveEffectivePerformancePolicy(
      targetEntry.launchConfig || {},
      mergedStopOptions
    );

    const elevatedTargetPid = Number(targetEntry.elevatedTargetPid || 0);
    const pid = targetEntry.launchedViaBottleSteam
      ? Number(targetEntry.pid || targetEntry.session?.pid || 0) || null
      : elevatedTargetPid > 0
        ? elevatedTargetPid
        : (targetEntry.child && targetEntry.child.pid ? targetEntry.child.pid : null) ||
          Number(targetEntry.pid || targetEntry.session?.pid || 0) ||
          null;
    if (pid) {
      try {
        process.kill(pid, 'SIGTERM');
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
        entryPlatformId === 'epic' ||
        entryPlatformId === 'gog'
    );
    const stopHostPlatform =
      mergedStopOptions.platform || options.platform || reqObj.platform || process.platform;
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
      if (needsDeferredPrefixShutdownForCloud) {
        if (canRunWineserver) {
          targetEntry.deferredPrefixShutdownToFinalize = true;
        }
      } else {
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
        if (!hasOtherActiveSessionInPrefix && canRunWineserver) {
          targetEntry.wineShutdownHandledByStopGame = true;
          await shutdownWinePrefix(resolvedWineserver, sessionWinePrefix, 2500);
        }
      }
    }

    if (pid) {
      const exitedGracefully = await waitForProcessExit(
        targetEntry.launchedViaBottleSteam || elevatedTargetPid > 0 ? null : targetEntry.child,
        pid,
        500
      );
      if (!exitedGracefully && isProcessAlive(pid)) {
        if (stopPlatform === 'win32') {
          try {
            await signalSubprocessTree(
              targetEntry.launchedViaBottleSteam || elevatedTargetPid > 0
                ? { pid }
                : targetEntry.child || { pid },
              'SIGKILL',
              mergedStopOptions
            );
          } catch {}
          if (
            elevatedTargetPid > 0 &&
            targetEntry.child?._requireRunAs &&
            isProcessAlive(elevatedTargetPid) &&
            !isTestStopEnv
          ) {
            const execFileImpl =
              mergedStopOptions.execFileImpl || mergedStopOptions.execFileFn || execFile;
            await new Promise((resolve) => {
              try {
                execFileImpl(
                  'powershell.exe',
                  [
                    '-NoProfile',
                    '-NonInteractive',
                    '-WindowStyle',
                    'Hidden',
                    '-Command',
                    `Start-Process -FilePath 'taskkill.exe' -ArgumentList @('/PID','${elevatedTargetPid}','/T','/F') -Verb RunAs -WindowStyle Hidden -Wait`,
                  ],
                  { timeout: 10000, windowsHide: true },
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
              process.kill(targetEntry.child.pid, 'SIGTERM');
            } catch {}
          }
        } else {
          try {
            process.kill(pid, 'SIGKILL');
          } catch {}
        }
        if (!isTestStopEnv && exeBase && exeBase.length > 3) {
          await killPosixProcessesMatchingWinExe(exePath, 'SIGKILL', targetEntry.winePrefix || '');
        }
        if (macAppBundlePath && !isTestStopEnv) {
          await signalMacAppBundleProcesses('SIGKILL');
        }
        await waitForProcessExit(
          targetEntry.launchedViaBottleSteam || elevatedTargetPid > 0 ? null : targetEntry.child,
          pid,
          400
        );
      }
    } else if (macAppBundlePath && !isTestStopEnv) {
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

/**
 * Discover native host Steam client binary (`steam.exe` on Windows, `steam_osx` on macOS)
 * while respecting isolated test overrides (`steamClientBinaryPath`, `customApplicationsDir`, `homedir`).
 */
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
          const renewed = await renewFn(refreshToken);
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
          const renewed = await renewGogFn(refreshToken);
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

async function verifyGameFiles(/** @type {any} */ payload = {}, /** @type {any} */ options = {}) {
  try {
    const { platformId, platformGameId, steamAppId, installPath, title } = payload;
    const targetPlatform = options.platform || process.platform;
    const execFileImpl =
      typeof options.execFileImpl === 'function'
        ? options.execFileImpl
        : typeof options.execFileFn === 'function'
          ? options.execFileFn
          : execFile;
    const canRunCliRepair =
      !options.skipCliRepair &&
      (!isTestEnvironment(options) ||
        typeof options.execFileImpl === 'function' ||
        typeof options.execFileFn === 'function' ||
        Boolean(options.legendaryBinaryPath) ||
        Boolean(options.gogdlBinaryPath) ||
        options.allowCliRepairInTest === true);

    if (installPath) {
      const localInstall = toLocalFsPath(installPath);
      if (!fs.existsSync(localInstall)) {
        return {
          success: false,
          error: `Installation directory not found: ${installPath}`,
        };
      }

      if (platformId === 'epic' && canRunCliRepair) {
        let appName = '';
        try {
          const resolved = resolveEpicAppAndPlatforms(payload, options);
          if (resolved && resolved.appName) {
            appName = String(resolved.appName).trim();
          }
        } catch {}
        if (!appName) {
          appName = String(payload.appName || platformGameId || payload.gameId || '')
            .replace(/^epic[-_]/i, '')
            .trim();
        }
        const legendaryBin =
          options.legendaryBinaryPath ||
          findLegendaryBinary(options) ||
          (typeof options.execFileImpl === 'function' || typeof options.execFileFn === 'function'
            ? 'legendary'
            : null);
        if (appName && legendaryBin) {
          const legendaryConfigPath = getLegendaryConfigDir(options);
          /** @type {any} */
          const cliRes = await new Promise((resolve) => {
            try {
              execFileImpl(
                legendaryBin,
                ['repair', appName, '-y'],
                {
                  env: {
                    ...process.env,
                    LC_ALL: normalizePosixUtf8Locale(options.env?.LC_ALL ?? process.env.LC_ALL),
                    LANG: normalizePosixUtf8Locale(options.env?.LANG ?? process.env.LANG),
                    ...(legendaryConfigPath ? { LEGENDARY_CONFIG_PATH: legendaryConfigPath } : {}),
                  },
                  timeout: 120000,
                },
                (/** @type {any} */ err, /** @type {any} */ stdout, /** @type {any} */ stderr) => {
                  const combined = `${stdout || ''}\n${stderr || ''}`;
                  resolve({ err, combined });
                }
              );
            } catch (/** @type {any} */ err) {
              resolve({ err, combined: '' });
            }
          });
          if (!cliRes.err && !/not installed|cannot find/i.test(cliRes.combined)) {
            const discovered = findPrimaryExecutable(localInstall, {
              platform: targetPlatform,
              hintName: title,
            });
            return {
              success: true,
              repairedViaCli: true,
              runner: 'legendary',
              message: `Verified and repaired Epic installation via Legendary (${title || appName}).`,
              installPath: localInstall,
              executablePath: discovered.executablePath,
            };
          }
        }
      } else if (platformId === 'gog' && canRunCliRepair) {
        const cleanId = String(platformGameId || payload.gameId || '')
          .replace(/^gog[-_]/i, '')
          .trim();
        const gogdlBin =
          options.gogdlBinaryPath ||
          findGogdlBinary(options) ||
          (typeof options.execFileImpl === 'function' || typeof options.execFileFn === 'function'
            ? 'gogdl'
            : null);
        let gogAuthPath = options.gogAuthConfigPath || null;
        if (!gogAuthPath && gogdlBin && !isTestEnvironment(options)) {
          try {
            const authRes = await ensureGogdlAuthConfig(options);
            gogAuthPath = authRes?.configPath || authRes?.gogAuthPath || null;
          } catch {}
        }
        if (cleanId && gogdlBin && gogAuthPath) {
          const discoveredForOs = findPrimaryExecutable(localInstall, {
            platform: targetPlatform,
            hintName: title,
          });
          const gogOs =
            targetPlatform === 'win32' || discoveredForOs.isWindowsBinaryOnMac ? 'windows' : 'osx';
          const gogLocale = resolveHostLocaleInfo(options).gogLocale || 'en-US';
          /** @type {any} */
          const cliRes = await new Promise((resolve) => {
            try {
              execFileImpl(
                gogdlBin,
                [
                  '--auth-config-path',
                  gogAuthPath,
                  'repair',
                  cleanId,
                  '--platform',
                  gogOs,
                  '--path',
                  localInstall,
                  '--skip-dlcs',
                  '--lang',
                  gogLocale,
                ],
                {
                  env: { ...process.env, PYTHONUNBUFFERED: '1' },
                  timeout: 120000,
                },
                (/** @type {any} */ err, /** @type {any} */ stdout, /** @type {any} */ stderr) => {
                  resolve({ err, combined: `${stdout || ''}\n${stderr || ''}` });
                }
              );
            } catch (/** @type {any} */ err) {
              resolve({ err, combined: '' });
            }
          });
          if (!cliRes.err && !/unrecognized arguments|invalid choice/i.test(cliRes.combined)) {
            return {
              success: true,
              repairedViaCli: true,
              runner: 'gogdl',
              message: `Verified and repaired GOG installation via gogdl (${title || cleanId}).`,
              installPath: localInstall,
              executablePath: discoveredForOs.executablePath,
            };
          }
        }
      } else if (platformId === 'xbox') {
        const gameCfg = inspectMicrosoftGameConfig(localInstall);
        const appxCfg = !gameCfg ? inspectAppxManifest(localInstall) : null;
        const resolvedPfn =
          payload.packageFamilyName ||
          gameCfg?.packageFamilyName ||
          appxCfg?.packageFamilyName ||
          '';
        const resolvedIdentityName =
          gameCfg?.identityName || appxCfg?.identityName || '';
        const hasClientlessReceipt = hasXboxClientlessReceipt(localInstall);

        if (targetPlatform === 'win32' && resolvedPfn && !hasClientlessReceipt && canRunCliRepair) {
          const appxCheck = await queryTargetedAppxPackageAsync(
            { identityName: resolvedIdentityName, packageFamilyName: resolvedPfn },
            { ...options, execFileImpl }
          );
          if (appxCheck.found && appxCheck.pkg && appxCheck.pkg.Status) {
            const st = appxCheck.pkg.Status;
            const isBadStringStatus =
              typeof st === 'string' && st.trim() !== '' && !/^(?:ok|normal|healthy|0)$/i.test(st.trim());
            const isBadObjStatus =
              typeof st === 'object' &&
              st !== null &&
              (st.Invalid === true ||
                st.Tampered === true ||
                st.Modified === true ||
                st.LicenseIssue === true ||
                st.DataOffline === true ||
                st.DependencyIssue === true);
            if (isBadStringStatus || isBadObjStatus) {
              return {
                success: false,
                error: `Xbox Appx package ${resolvedPfn} reported unhealthy status (${typeof st === 'string' ? st : JSON.stringify(st)}). Please repair via Xbox App or reinstall.`,
                installPath: localInstall,
              };
            }
          }
        }

        const primaryExe =
          (gameCfg?.primaryExecutable
            ? path.join(
                gameCfg.configDir || localInstall,
                gameCfg.primaryExecutable.replace(/\\/g, path.sep)
              )
            : '') ||
          findPrimaryExecutable(localInstall, {
            platform: targetPlatform,
            hintName: title,
            preferWindowsExecutable: true,
          }).executablePath;

        if (!primaryExe || !fs.existsSync(primaryExe)) {
          return {
            success: false,
            error: `Primary Xbox game executable not found in ${localInstall}.`,
            installPath: localInstall,
          };
        }

        const bottleRoot = extractBottleRootFromPath(localInstall);
        let repairedWinAppxRegistered = false;
        if (targetPlatform === 'darwin' && bottleRoot && resolvedPfn) {
          try {
            await prepareXboxBottleEnvironment({
              bottlePath: bottleRoot,
              env: {},
              packageFamilyName: resolvedPfn,
              installDir: localInstall,
              executablePath: primaryExe,
              scid: gameCfg?.scid || undefined,
              xboxBridgeDllPath: options.xboxBridgeDllPath,
              gameInputBridgeDllPath: options.gameInputBridgeDllPath,
              xboxAppNotifyBridgeDllPath: options.xboxAppNotifyBridgeDllPath,
            });
          } catch {}
        } else if (targetPlatform === 'win32' && hasClientlessReceipt) {
          try {
            if (options.forceClientlessXboxOnWin32 !== true) {
              const appxRegCheck = await ensureWindowsXboxAppxRegisteredAsync(
                {
                  installDir: localInstall,
                  identityName: resolvedIdentityName,
                  packageFamilyName: resolvedPfn,
                },
                { ...options, execFileImpl }
              );
              if (appxRegCheck.gamingServicesInstalled && appxRegCheck.registered) {
                repairedWinAppxRegistered = true;
                await restoreWindowsClientlessXboxBridgeDlls(localInstall);
              }
            }
            if (!repairedWinAppxRegistered) {
              await stageWindowsClientlessXboxBridgeDlls({
                installDir: localInstall,
                executablePath: primaryExe,
                xboxBridgeDllPath: options.xboxBridgeDllPath,
                gameInputBridgeDllPath: options.gameInputBridgeDllPath,
              });
            }
          } catch {}
        }

        return {
          success: true,
          runner:
            targetPlatform === 'darwin'
              ? 'xbox_xgr'
              : hasClientlessReceipt && !repairedWinAppxRegistered
                ? 'xbox_direct'
                : 'xbox',
          message: `Verified Xbox GDK installation integrity (${path.basename(primaryExe)} ready).`,
          installPath: localInstall,
          executablePath: primaryExe,
        };
      }

      const discovered = findPrimaryExecutable(localInstall, {
        platform: targetPlatform,
        hintName: title,
      });

      if (platformId === 'steam' && (steamAppId || platformGameId)) {
        await openExternalUri(`steam://validate/${steamAppId || platformGameId}`, options);
      }

      return {
        success: true,
        message: discovered.executablePath
          ? `Verified installation integrity (${path.basename(discovered.executablePath)} ready).`
          : 'Verified installation directory exists.',
        installPath: localInstall,
        executablePath: discovered.executablePath,
      };
    }

    if (platformId === 'steam' && (steamAppId || platformGameId)) {
      await openExternalUri(`steam://validate/${steamAppId || platformGameId}`, options);
      return {
        success: true,
        message: 'Triggered Steam file integrity validation.',
      };
    }

    return {
      success: false,
      error: 'No installation path available to verify.',
    };
  } catch (/** @type {any} */ err) {
    return {
      success: false,
      error: err.message,
    };
  }
}

async function uninstallGame(/** @type {any} */ payload = {}, /** @type {any} */ options = {}) {
  try {
    const {
      gameId,
      title,
      platformId,
      platformGameId,
      steamAppId,
      installPath,
      allowDeleteFiles,
    } = payload;
    const platform = options.platform || process.platform;
    const userDataDir = getUserDataDir(options.userDataDir);

    const cleanId = String(platformGameId || gameId || '')
      .replace(/^(epic|gog|steam|xbox)[-_:]/i, '')
      .trim();
    const appId = String(steamAppId || platformGameId || cleanId)
      .replace(/^steam[-_]/i, '')
      .trim();
    let localInstall = installPath ? toLocalFsPath(installPath) : '';
    const isBottlePath = (/** @type {any} */ p) =>
      /(?:^|[\\/])(Bottles|drive_c)(?:[\\/]|$)/i.test(String(p || ''));

    const managed = loadManagedInstalledGames(userDataDir);
    const matchedManagedRecord = managed.find(
      (/** @type {any} */ r) =>
        (r.platformId === platformId &&
          (String(r.platformGameId) === String(platformGameId) ||
            (cleanId && String(r.platformGameId) === cleanId) ||
            (appId && String(r.platformGameId) === appId))) ||
        (installPath && r.installPath === installPath) ||
        (localInstall && r.installPath && path.resolve(r.installPath) === path.resolve(localInstall))
    );
    if (!localInstall && matchedManagedRecord?.installPath) {
      localInstall = toLocalFsPath(matchedManagedRecord.installPath);
    }

    if (platformId === 'epic') {
      const resolvedAppNames = new Set();
      const resolvedCatalogItemIds = new Set();
      let resolvedInstallFromLeg = '';
      if (cleanId) {
        resolvedAppNames.add(cleanId);
        resolvedCatalogItemIds.add(cleanId);
      }
      if (platformGameId) {
        resolvedAppNames.add(String(platformGameId));
      }

      const homedir = options.homedir || os.homedir();
      const legendaryDirs = [
        path.join(userDataDir, 'legendaryConfig', 'legendary'),
        path.join(homedir, 'Library/Application Support/heroic/legendaryConfig/legendary'),
        path.join(homedir, '.config/legendary'),
        path.join(homedir, 'AppData/Roaming/heroic/legendaryConfig/legendary'),
      ];

      for (const legDir of legendaryDirs) {
        const assetsFile = path.join(legDir, 'assets.json');
        if (fs.existsSync(assetsFile)) {
          try {
            const rawAssets = JSON.parse(fs.readFileSync(assetsFile, 'utf8'));
            const lists = Array.isArray(rawAssets)
              ? [rawAssets]
              : rawAssets && typeof rawAssets === 'object'
                ? Object.values(rawAssets).filter(Array.isArray)
                : [];
            for (const list of lists) {
              for (const asset of list) {
                if (!asset || typeof asset !== 'object') continue;
                const aName = String(asset.app_name || asset.appName || '').trim();
                const cId = String(asset.catalog_item_id || asset.catalogItemId || '').trim();
                if (
                  (cleanId &&
                    (aName.toLowerCase() === cleanId.toLowerCase() ||
                      cId.toLowerCase() === cleanId.toLowerCase())) ||
                  (aName && resolvedAppNames.has(aName)) ||
                  (cId && resolvedCatalogItemIds.has(cId))
                ) {
                  if (aName) resolvedAppNames.add(aName);
                  if (cId) resolvedCatalogItemIds.add(cId);
                }
              }
            }
          } catch {}
        }

        const instFile = path.join(legDir, 'installed.json');
        if (fs.existsSync(instFile)) {
          const isManagedLegFile =
            path.resolve(instFile) ===
            path.resolve(path.join(userDataDir, 'legendaryConfig', 'legendary', 'installed.json'));
          try {
            const rawLeg = JSON.parse(fs.readFileSync(instFile, 'utf8'));
            if (rawLeg && typeof rawLeg === 'object' && !Array.isArray(rawLeg)) {
              let changed = false;
              for (const [k, val] of Object.entries(rawLeg)) {
                const v = /** @type {any} */ (val);
                const vApp = String(v?.app_name || v?.appName || k || '').trim();
                const vCat = String(v?.catalog_item_id || v?.catalogItemId || '').trim();
                const vInstallRaw = v?.install_path || v?.installPath || '';
                const vInstallLocal = vInstallRaw ? toLocalFsPath(vInstallRaw) : '';
                const matchesPath = Boolean(
                  (installPath && vInstallRaw === installPath) ||
                    (localInstall &&
                      vInstallLocal &&
                      path.resolve(vInstallLocal) === path.resolve(localInstall))
                );
                const matchesIds = Boolean(
                  resolvedAppNames.has(k) ||
                    resolvedAppNames.has(vApp) ||
                    (cleanId &&
                      (k.toLowerCase() === cleanId.toLowerCase() ||
                        vApp.toLowerCase() === cleanId.toLowerCase() ||
                        vCat.toLowerCase() === cleanId.toLowerCase())) ||
                    (vCat && resolvedCatalogItemIds.has(vCat))
                );
                if (matchesIds || matchesPath) {
                  if (k) resolvedAppNames.add(k);
                  if (vApp) resolvedAppNames.add(vApp);
                  if (vCat) resolvedCatalogItemIds.add(vCat);
                  if (!resolvedInstallFromLeg && vInstallLocal) {
                    resolvedInstallFromLeg = vInstallLocal;
                  }
                  if (isManagedLegFile) {
                    delete rawLeg[k];
                    changed = true;
                  }
                }
              }
              if (isManagedLegFile && changed) {
                atomicWriteFileSync(instFile, JSON.stringify(rawLeg, null, 2));
              }
            }
          } catch (legErr) {
            if (isManagedLegFile) {
              diagLog.warn('uninstallGame.legendaryInstalledCleanup', legErr, {
                gameId,
                platformGameId,
              });
            }
          }
        }
      }

      try {
        unregisterEpicFirstPartyLauncher(
          cleanId || platformGameId,
          installPath || resolvedInstallFromLeg,
          {
            ...options,
            catalogItemId: cleanId,
            resolvedAppNames: Array.from(resolvedAppNames),
            resolvedCatalogItemIds: Array.from(resolvedCatalogItemIds),
          }
        );
      } catch {}
    } else if (platformId === 'gog') {
      try {
        const unregRes = unregisterGogFirstPartyLauncher(
          cleanId || platformGameId,
          installPath,
          options
        );
        if (unregRes && unregRes.registryDeletePromise) {
          await unregRes.registryDeletePromise.catch(() => {});
        }
      } catch {}
      try {
        clearStaleGogdlManifestCache(cleanId || platformGameId, options);
      } catch {}
    } else if (platformId === 'steam' && appId) {
      let isBottleInstall = isBottlePath(localInstall);
      let removedLocalSteamFiles = false;
      let acfName = '';
      const discoveredBottleDirs = new Set();
      const hasValidNumericSteamId = safeIsNumericAppId(appId);

      if (isBottleInstall) {
        const br = extractBottleRootFromPath(localInstall);
        if (br) discoveredBottleDirs.add(br);
      }

      const candidateSteamappsDirs = new Set();
      try {
        const { steamappsDirs } = discoverSteamLocations(options);
        for (const d of steamappsDirs) {
          if (d) candidateSteamappsDirs.add(d);
        }
      } catch {}

      if (localInstall && /steamapps[\\/]common[\\/]/i.test(localInstall)) {
        candidateSteamappsDirs.add(path.resolve(localInstall, '..', '..'));
      }

      try {
        const layers = detectCompatibilityLayers(options);
        for (const layer of layers) {
          if (layer && layer.bottlesDir && fs.existsSync(layer.bottlesDir)) {
            for (const bottle of listBottleSubdirectories(layer.bottlesDir)) {
              const bPath = path.join(layer.bottlesDir, bottle);
              discoveredBottleDirs.add(bPath);
              const s1 = path.join(bPath, 'drive_c/Program Files (x86)/Steam/steamapps');
              const s2 = path.join(bPath, 'drive_c/Program Files/Steam/steamapps');
              if (fs.existsSync(s1)) candidateSteamappsDirs.add(s1);
              if (fs.existsSync(s2)) candidateSteamappsDirs.add(s2);
            }
          }
        }
      } catch {}

      if (hasValidNumericSteamId) {
        for (const steamappsDir of candidateSteamappsDirs) {
          if (!steamappsDir || !fs.existsSync(steamappsDir)) continue;
          const acfPath = path.join(steamappsDir, `appmanifest_${appId}.acf`);
          if (fs.existsSync(acfPath)) {
            /** @type {any} */
            let parsedAcf = null;
            try {
              parsedAcf = parseSteamAcf(fs.readFileSync(acfPath, 'utf8'));
            } catch {}
            if (parsedAcf && parsedAcf.name && !acfName) {
              acfName = parsedAcf.name;
            }
            if (isBottlePath(steamappsDir)) {
              isBottleInstall = true;
              const br = extractBottleRootFromPath(steamappsDir);
              if (br) discoveredBottleDirs.add(br);
            }
            try {
              fs.rmSync(acfPath, { force: true });
              removedLocalSteamFiles = true;
            } catch {}

            const installdir =
              parsedAcf && parsedAcf.installdir ? String(parsedAcf.installdir) : '';
            if (
              installdir &&
              !/[\\/\x00]/.test(installdir) &&
              installdir !== '.' &&
              installdir !== '..' &&
              !installdir.includes('..')
            ) {
              const acfCommonDir = path.join(steamappsDir, 'common', installdir);
              if (fs.existsSync(acfCommonDir) && isSafeToDeleteInstallPath(acfCommonDir, options)) {
                try {
                  fs.rmSync(acfCommonDir, { recursive: true, force: true });
                } catch {}
              }
            }

            const auxPaths = [
              path.join(steamappsDir, 'downloading', appId),
              path.join(steamappsDir, 'temp', appId),
              path.join(steamappsDir, 'shadercache', appId),
              path.join(steamappsDir, 'workshop', 'content', appId),
              path.join(steamappsDir, 'workshop', `appworkshop_${appId}.acf`),
            ];
            for (const aux of auxPaths) {
              if (fs.existsSync(aux)) {
                try {
                  fs.rmSync(aux, { recursive: true, force: true });
                } catch {}
              }
            }

            removeSteamAppFromLibraryFoldersVdf(steamappsDir, appId);
          }
        }
      }

      if (
        localInstall &&
        fs.existsSync(localInstall) &&
        isSafeToDeleteInstallPath(localInstall, options)
      ) {
        if (isBottlePath(localInstall)) {
          isBottleInstall = true;
        }
        try {
          fs.rmSync(localInstall, { recursive: true, force: true });
          removedLocalSteamFiles = true;
        } catch {}
      }

      if ((isBottleInstall || platform === 'darwin') && hasValidNumericSteamId) {
        try {
          cleanupCrossOverSteamShortcuts(
            appId,
            title || acfName,
            Array.from(discoveredBottleDirs),
            options
          );
        } catch {}
      }

      if (!isBottleInstall && !removedLocalSteamFiles && !allowDeleteFiles && hasValidNumericSteamId) {
        await openExternalUri(`steam://uninstall/${appId}`, options);
      }
    } else if (platformId === 'xbox') {
      const hasClientlessReceipt = hasXboxClientlessReceipt(localInstall);
      const isClientlessOrBottle =
        platform === 'darwin' || hasClientlessReceipt || isBottlePath(localInstall);

      let resolvedPfn = String(
        payload.packageFamilyName || matchedManagedRecord?.packageFamilyName || ''
      ).trim();
      let resolvedIdentityName = '';
      if (localInstall && fs.existsSync(localInstall)) {
        const gameCfg = inspectMicrosoftGameConfig(localInstall);
        const appxCfg = !gameCfg ? inspectAppxManifest(localInstall) : null;
        if (!resolvedPfn) {
          resolvedPfn = String(
            gameCfg?.packageFamilyName || appxCfg?.packageFamilyName || ''
          ).trim();
        }
        resolvedIdentityName = String(
          gameCfg?.identityName || appxCfg?.identityName || ''
        ).trim();
      }

      if (platform === 'win32' && !isClientlessOrBottle && resolvedPfn) {
        const appxRemoveRes = await removeTargetedAppxPackageVerifiedAsync(
          { identityName: resolvedIdentityName, packageFamilyName: resolvedPfn },
          options
        );
        if (!appxRemoveRes.removed && appxRemoveRes.stillInstalled) {
          diagLog.warn('uninstallGame.xboxRemoveAppxPackageStillInstalled', appxRemoveRes.error, {
            gameId,
            resolvedPfn,
          });
          return {
            success: false,
            error:
              appxRemoveRes.error ||
              `Failed to remove Xbox Appx package ${resolvedPfn}. The package is still installed.`,
            installPath,
          };
        }
      } else if (
        isClientlessOrBottle &&
        localInstall &&
        fs.existsSync(localInstall) &&
        isSafeToDeleteInstallPath(localInstall, options)
      ) {
        try {
          fs.rmSync(localInstall, { recursive: true, force: true });
        } catch (rmErr) {
          diagLog.warn('uninstallGame.xboxRemoveDir', rmErr, { localInstall });
        }
      }
    }

    // Remove from One Launcher managed records AFTER verified Appx / store removal succeeds
    const filtered = managed.filter((/** @type {any} */ r) => r !== matchedManagedRecord);
    if (filtered.length !== managed.length) {
      saveManagedInstalledGames(filtered, userDataDir);
    }

    if (localInstall && fs.existsSync(localInstall)) {
      const canDeleteLocal =
        Boolean(allowDeleteFiles) ||
        hasManagedInstallSentinel(localInstall) ||
        isBottlePath(localInstall) ||
        /steamapps[\\/]common[\\/]/i.test(localInstall) ||
        localInstall.includes('OneLauncher') ||
        localInstall.includes('one-launcher');

      if (canDeleteLocal && isSafeToDeleteInstallPath(localInstall, options)) {
        try {
          fs.rmSync(localInstall, { recursive: true, force: true });
        } catch {}
      }
    }

    try {
      pruneCloudSaveStateForGame(
        {
          platformId,
          gameId,
          platformGameId: cleanId || platformGameId,
        },
        userDataDir
      );
    } catch (pruneErr) {
      diagLog.warn('uninstallGame.pruneCloudSaveState', pruneErr, { gameId, platformId });
    }

    invalidateScanCaches();

    return {
      success: true,
      message: `Uninstalled ${title || gameId || platformGameId}`,
      installPath,
    };
  } catch (/** @type {any} */ err) {
    return {
      success: false,
      error: err.message,
    };
  }
}

function shutdownLauncherEngine(/** @type {any} */ options = {}) {
  shutdownDownloadEngine(options);

  for (const [, entry] of activeSessions.entries()) {
    if (entry && entry.pollTimer) {
      try {
        clearInterval(entry.pollTimer);
      } catch {}
      entry.pollTimer = null;
    }
  }
  const vaultHooks = getOfflineVaultLifecycleHooks();
  if (vaultHooks && typeof vaultHooks.shutdown === 'function') {
    try {
      vaultHooks.shutdown();
    } catch {}
  }
  trimLauncherEngineMemory();
}

module.exports = {
  parseLaunchArguments,
  buildStorefrontLaunchUri,
  trackPostSessionPromise,
  killPosixProcessesMatchingWinExe,
  isMacSipProtectedExecutableOrScript,
  isWindowsElevationRequiredError,
  spawnWindowsViaPowerShellStartProcess,
  hasActivePostSessionWork,
  waitForActivePostSessionWork,
  syncGogCloudSaves,
  syncEpicCloudSaves,
  waitForSteamColdStartupCloudReady,
  waitForSteamCloudSyncCompletion,
  finalizeGameSession,
  launchGame,
  stopGame,
  getRunningGames,
  resolveSteamClientBinaryPath,
  detectInstalledStorefrontClients,
  resolveSteamClientLaunchCommand,
  shutdownEphemeralStorefrontClient,
  syncSessionPlaytimeToStorefront,
  verifyGameFiles,
  uninstallGame,
  shutdownLauncherEngine,
};
