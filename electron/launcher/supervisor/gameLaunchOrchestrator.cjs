// @ts-check
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { spawn, execFile } = require('node:child_process');
const {
  isProcessAlive,
  extractMatchedPidFromProcessOutput,
} = require('../processTreeUtils.cjs');
const {
  toHostFilesystemPath,
  atomicWriteFileSync,
  resolveHostWindowsKnownFolders,
  sanitizeSpawnEnvironmentMap,
  buildSafeChildEnvironment,
} = require('../securityAndPathUtils.cjs');
const {
  resolveDriveCPathCaseInsensitive,
  readWinePrefixShellFolders,
  resolveBottleSteamExe,
  resolveBundledXboxWinLauncherExePath,
  readVerifiedBridgeDllBuffer,
  stageWindowsClientlessXboxBridgeDlls,
  restoreWindowsClientlessXboxBridgeDlls,
  prepareXboxBottleEnvironment,
  upsertWineUserRegKey,
  mergeWineDllOverrides,
} = require('../wineAndCrossOverManager.cjs');
const {
  isHostGogGalaxyRunning,
  reapOrphanedGogOverlayProcesses,
  lineMatchesBottlePrefix,
  isBottleWinExeRunning,
  inspectRunningBottleSteam,
  probeLocalTcpPort,
  resolveGogCommunicationLogPath,
  resolveGogClientLogPath,
  waitForGogCommunicationServiceReady,
  waitForBottleEpicPortalReady,
  extractTrackedPidFromSteamGameProcessLog,
} = require('../storefrontReadinessBarrier.cjs');
const { hasBottleSteamAppManifest } = require('../mac/compatLayerRegistryAndDetection.cjs');
const {
  inspectWindowsExecutableHeader,
  hasMalformedBackslashExportForwarder,
  resolveEffectiveGameExecutableCapabilities,
  selectPreferredGogPlayTask,
  resolveParadoxLauncherSettings,
  resolveCaseInsensitiveRelFile,
  isCompatibleX86OrX64PeHeader,
  deriveDefaultScidFromTitleId,
  inspectMicrosoftGameConfig,
  inspectAppxManifest,
} = require('../binaryAndManifestInspectors.cjs');
const { executeGogGameScript } = require('../../storefronts/gog/gogScriptInterpreter.cjs');
const {
  normalizePosixUtf8Locale,
  syncXboxCloudSaves,
  buildCloudSyncTelemetryPayload,
  resolveXboxSaveLocations,
  loadPendingCloudUploads,
  replayPendingCloudUpload,
} = require('../cloudSaveEngine.cjs');
const {
  getStoreSync,
  getXboxStorefrontModules,
  diagLog,
  getUserDataDir,
  isTestEnvironment,
  resolveIsolatedHomedirAndUserData,
  emitSessionUpdated,
  activeSessions,
  inFlightLaunchesByGameId,
  inFlightLaunchAbortControllers,
  inFlightPostSessionByGame,
  pendingBottleLaunches,
  inFlightPostSessionByBottle,
  pendingEphemeralShutdowns,
  pendingStorefrontLaunches,
  recentDisplaySanitizeCache,
  pendingWineRegSyncByPrefix,
  setBoundedMapEntry,
  evictExecutableDiscoveryCacheForPath,
  toLocalFsPath,
  resolveWindowsNodeShebangSpawn,
  openExternalUri,
  isNetworkOnlineForLaunch,
  clearMacQuarantineAsync,
  resolveHostLocaleInfo,
  loadManagedInstalledGames,
  saveManagedInstalledGames,
  resolvePlatformLaunchConfig,
  getGameLaunchConfigs,
  resolveEffectivePerformancePolicy,
} = require('../engineStateRegistry.cjs');
const {
  findBestX86OrX64WindowsExe,
  hasXboxClientlessReceipt,
  ensureWindowsXboxAppxRegisteredAsync,
  isWindowsXboxAppRunning,
  activateWindowsXboxApplication,
  resolveXboxClientBinaryPath,
} = require('../windowsXboxAppxAndMsixvcOrchestrator.cjs');
const {
  isExcludedExecutable,
  ensureMacExecutablePermissions,
  ensureMacAppCodeSignatureValidAsync,
  doesGogInstallUseGalaxySdk,
  resolveMacAppBundleBinary,
  flattenGogNestedInstallDir,
  findPrimaryExecutable,
  resolveSteamAppInfoLaunchSpec,
  resolveDefaultEngineLaunchArguments,
  discoverSteamLocations,
  extractBottleRootFromPath,
  isValidBottleDirectory,
  inspectBottleConfMetadata,
  assertRunnerBottleArchCompatible,
  listBottleSubdirectories,
  detectCompatibilityLayers,
  stripKeysFromCxEnv,
  applyUnifiedPerformanceHudEnv,
  resolveSipSafeWineBinaryAndPreloadEnv,
  resolveWineserverBinary,
  shutdownWinePrefix,
  resolveBottleGogGalaxyExe,
  resolveBottleEpicLauncherExe,
  sanitizeWinePrefixDisplayConfigs,
  applyCrossOverPerGameSettings,
  buildDisplaySanitizeCacheKey,
  predictTargetBottlePrefix,
  ensureCompatibilityLayerReady,
  cleanNonApfsAppleDoubleTwins,
  alignWineMsyncWithLiveBottle,
  prepareCrossOverWineSpawnEnv,
  prepareAlignedAuxBottleWineCommand,
} = require('../macNativeInstallerAndCodesign.cjs');
const {
  ensureLegendaryConfigAndAuth,
  resolveEpicAppAndPlatforms,
  resolveEpicLaunchAuthArguments,
  resolveEpicClientBinaryPath,
} = require('../epicLegendaryAndEosCoordinator.cjs');
const {
  CHAINED_PUBLISHER_ECOSYSTEMS,
  discoverBottlePublisherLauncher,
  discoverHostPublisherLauncher,
} = require('../chainedPublisherLaunchers.cjs');
const {
  syncGogGameToGalaxy,
  ensureGogGalaxyBackgroundService,
  resolveGogGalaxyClientBinaryPath,
} = require('../gogRegistryAndDirectInstaller.cjs');
const { pauseActiveDownloadsForInGame } = require('../downloadQueueCoordinator.cjs');
const {
  toWineWindowsPath,
  isBottleWineserverActive,
} = require('../firstPartyRegistration.cjs');
const {
  isGdkStubExecutablePath,
  resolveSiblingLauncherStub,
} = require('../installedGameScanner.cjs');
const {
  resolveAnyChainedHandoffId,
  normalizeRequestedCompatibilityLayerType,
  normalizeWineArgumentBackslashes,
  liveBottleDaemonEnvContractByPrefix,
  normalizeBottlePrefixContractKey,
  deleteBottleDaemonEnvContract,
  getLiveBottleSteamUiMode,
  setLiveBottleSteamUiMode,
  computeBottleGraphicsEnvContract,
  stripDisplayScalerEnvFromClientEnv,
  stageBottleDisplayScalerBinaries,
  shouldWrapBottleSessionWithDisplayLauncher,
  formatDisplayScalerControlIni,
  writeActiveDisplaySessionManifestIni,
  attachBottleDisplayStatusPoller,
  sanitizeBottleBackgroundClientWakeEnv,
  recordBottledStderrChunk,
  doesCrossOverBinarySupportWaitChildren,
  discoverValidatedAppLocalProxyDllOverrides,
} = require('./bottleDisplayAndEnvController.cjs');
const {
  createGuardedSessionPoller,
  runApprovedLaunchHookCommand,
  isAuthoritativeInstallDirForMutation,
  disposeSessionResources,
  parseLaunchArguments,
  buildStorefrontLaunchUri,
  killPosixProcessesMatchingWinExe,
  isMacSipProtectedExecutableOrScript,
  isWindowsElevationRequiredError,
  spawnWindowsViaPowerShellStartProcess,
} = require('./processWatchAndElevation.cjs');
const {
  syncGogCloudSaves,
  syncEpicCloudSaves,
  waitForSteamColdStartupCloudReady,
  resolveSteamClientBinaryPath,
  resolveSteamClientLaunchCommand,
} = require('./storefrontLifecycleAndCloudSync.cjs');
const { finalizeGameSession } = require('./sessionFinalizerAndControl.cjs');
const {
  hasParadoxLauncherInstalledInBottle,
  checkBottlePublisherUiRunningAsync,
  checkHostWinPublisherUiRunningAsync,
  getEnsureChainedPublisherLauncherInstalled,
  BOTTLE_SYSTEM_DAEMON_EXE_SET,
  collectChainedGameCandidateExeNames,
  findLiveBottleGameChildPid,
  launchChainedPublisherGame,
} = require('./chainedPublisherLauncher.cjs');

/**
 * Compare two directory/bottle paths for equivalence (case-insensitive POSIX + realpath).
 *
 * @param {string | null | undefined} pathA
 * @param {string | null | undefined} pathB
 * @returns {boolean}
 */
function areSameBottleDirPath(pathA, pathB) {
  if (!pathA || !pathB) return false;
  const norm = (/** @type {string} */ p) =>
    path.resolve(p).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  if (norm(pathA) === norm(pathB)) return true;
  try {
    if (fs.existsSync(pathA) && fs.existsSync(pathB)) {
      return norm(fs.realpathSync(pathA)) === norm(fs.realpathSync(pathB));
    }
  } catch {}
  return false;
}

/**
 * Check whether an installed compatibility layer supports `targetArch` on `hostArch`.
 *
 * @param {any} layer
 * @param {'win64' | 'arm64' | string} targetArch
 * @param {string} hostArch
 * @returns {boolean}
 */
function layerSupportsBottleArch(layer, targetArch, hostArch) {
  if (!layer || layer.available === false) return false;
  if (layer.type === 'crossover_preview_arm64' && hostArch !== 'arm64') return false;
  const reqArch = String(targetArch || 'win64').toLowerCase();
  if (Array.isArray(layer.supportedBottleArches) && layer.supportedBottleArches.length > 0) {
    return layer.supportedBottleArches.some(
      (/** @type {any} */ a) => String(a || '').toLowerCase() === reqArch
    );
  }
  return reqArch === 'arm64'
    ? layer.type === 'crossover_preview_arm64'
    : layer.type !== 'crossover_preview_arm64';
}

/**
 * Check whether an installed, host-supported compatibility layer is ALREADY compatible with
 * `bottlePath` (matching bottle architecture AND owning `bottlePath` via `availableBottles` or
 * `bottlesDir`).
 *
 * @param {any} layer
 * @param {string} bottlePath
 * @param {string} hostArch
 * @returns {boolean}
 */
function isLayerCompatibleWithBottle(layer, bottlePath, hostArch) {
  if (!layer || !bottlePath) return false;
  const confMeta = inspectBottleConfMetadata(bottlePath);
  const targetArch = confMeta.wineArch || 'win64';
  if (!layerSupportsBottleArch(layer, targetArch, hostArch)) return false;
  const resolvedBottle = path.resolve(bottlePath);
  const bottleNameLower = path.basename(resolvedBottle).toLowerCase();
  const bottleParentDir = path.dirname(resolvedBottle);
  const hasBottleInAvailable =
    Array.isArray(layer.availableBottles) &&
    layer.availableBottles.some(
      (/** @type {any} */ b) => String(b || '').trim().toLowerCase() === bottleNameLower
    );
  const hasMatchingBottlesDir = Boolean(
    layer.bottlesDir && areSameBottleDirPath(layer.bottlesDir, bottleParentDir)
  );
  return hasBottleInAvailable || hasMatchingBottlesDir;
}

/**
 * Snapshot the current byte offset of host or bottle `EpicGamesLauncher.log` right before
 * session launch so post-exit `waitForEpicLauncherCloudSyncCompletion` neither scans stale
 * prior-session entries nor skips upload markers written during exit-detection latency.
 *
 * @param {{ platform?: string, bottlePath?: string | null, homedir?: string, options?: Record<string, any> }} [params]
 * @returns {number | undefined}
 */
function snapshotEpicLogPreExitOffset(params = {}) {
  const opts = params.options && typeof params.options === 'object' ? params.options : {};
  /** @type {string[]} */
  const candidates = [];
  const explicitRaw = opts.epicLogPath || opts.epicBottleLogPath;
  if (typeof explicitRaw === 'string' && explicitRaw.trim()) {
    candidates.push(explicitRaw.trim());
  } else if (Array.isArray(explicitRaw)) {
    for (const p of explicitRaw) {
      if (typeof p === 'string' && p.trim()) candidates.push(p.trim());
    }
  }

  if (candidates.length === 0) {
    const bottlePath = String(params.bottlePath || '').trim();
    if (bottlePath) {
      try {
        const bottleShellFolders = readWinePrefixShellFolders(bottlePath);
        if (bottleShellFolders?.appDataLocal) {
          candidates.push(
            path.join(
              bottleShellFolders.appDataLocal,
              'EpicGamesLauncher',
              'Saved',
              'Logs',
              'EpicGamesLauncher.log'
            )
          );
        }
      } catch {}
      const driveC = path.join(bottlePath, 'drive_c');
      /** @type {Set<string>} */
      const bottleUsers = new Set(['crossover']);
      try {
        const currentUser = os.userInfo().username;
        if (currentUser) bottleUsers.add(currentUser);
      } catch {}
      try {
        const usersDir = path.join(driveC, 'users');
        if (fs.existsSync(usersDir)) {
          for (const dirent of fs.readdirSync(usersDir, { withFileTypes: true })) {
            if (
              dirent.isDirectory() &&
              !dirent.name.startsWith('.') &&
              dirent.name.toLowerCase() !== 'public'
            ) {
              bottleUsers.add(dirent.name);
            }
          }
        }
      } catch {}
      for (const u of bottleUsers) {
        candidates.push(
          path.join(
            driveC,
            'users',
            u,
            'AppData',
            'Local',
            'EpicGamesLauncher',
            'Saved',
            'Logs',
            'EpicGamesLauncher.log'
          ),
          path.join(
            driveC,
            'users',
            u,
            'Local Settings',
            'Application Data',
            'EpicGamesLauncher',
            'Saved',
            'Logs',
            'EpicGamesLauncher.log'
          )
        );
      }
    } else {
      const targetPlatform = params.platform || opts.platform || process.platform;
      const homedir = String(params.homedir || opts.homedir || os.homedir());
      if (targetPlatform === 'win32') {
        const localAppData = String(
          opts.localAppDataDir ||
            process.env.LOCALAPPDATA ||
            path.join(homedir, 'AppData', 'Local')
        );
        candidates.push(
          localAppData.startsWith('/')
            ? path.join(
                localAppData,
                'EpicGamesLauncher',
                'Saved',
                'Logs',
                'EpicGamesLauncher.log'
              )
            : path.win32.join(
                localAppData,
                'EpicGamesLauncher',
                'Saved',
                'Logs',
                'EpicGamesLauncher.log'
              )
        );
      } else {
        candidates.push(
          path.join(
            homedir,
            'Library',
            'Logs',
            'Unreal Engine',
            'EpicGamesLauncher',
            'EpicGamesLauncher.log'
          ),
          path.join(
            homedir,
            'Library',
            'Application Support',
            'Epic',
            'EpicGamesLauncher',
            'Saved',
            'Logs',
            'EpicGamesLauncher.log'
          )
        );
      }
    }
  }

  for (const candidate of Array.from(new Set(candidates))) {
    try {
      if (candidate && fs.existsSync(candidate)) {
        const st = fs.statSync(candidate);
        if (st.isFile()) return st.size;
      }
    } catch {}
  }
  return candidates.length > 0 ? 0 : undefined;
}

/**
 * Select the best installed, host-supported compatibility layer for `bottlePath` based on its
 * `cxbottle.conf` architecture (`arm64` vs `win64`) and matching `bottlesDir`.
 *
 * @param {any[]} layers
 * @param {string} bottlePath
 * @param {string} hostArch
 * @returns {any | null}
 */
function selectRecommendedLayerForBottle(layers, bottlePath, hostArch) {
  if (!bottlePath || !Array.isArray(layers) || layers.length === 0) return null;
  const confMeta = inspectBottleConfMetadata(bottlePath);
  const targetArch = confMeta.wineArch || 'win64';
  const bottleParentDir = path.dirname(path.resolve(bottlePath));
  const preferredOrder =
    targetArch === 'arm64'
      ? ['crossover_preview_arm64']
      : ['crossover', 'crossover_preview', 'gptk', 'wine'];

  const archCompatible = layers.filter((l) => layerSupportsBottleArch(l, targetArch, hostArch));
  if (archCompatible.length === 0) return null;

  const pickByPreferredOrder = (/** @type {any[]} */ pool) => {
    for (const prefType of preferredOrder) {
      const hit = pool.find((l) => l && l.type === prefType);
      if (hit) return hit;
    }
    return pool[0] || null;
  };

  const dirMatched = archCompatible.filter(
    (l) => l && l.bottlesDir && areSameBottleDirPath(l.bottlesDir, bottleParentDir)
  );
  if (dirMatched.length > 0) {
    return pickByPreferredOrder(dirMatched);
  }
  return pickByPreferredOrder(archCompatible);
}

/**
 * Scan initialized bottles across detected layers for one that has both Windows `steam.exe`
 * and an `appmanifest_<appId>.acf` (directly or via `libraryfolders.vdf`).
 *
 * @param {any[]} layers
 * @param {string} steamAppId
 * @returns {string}
 */
function findBottleWithSteamAppManifest(layers, steamAppId) {
  if (!steamAppId || !Array.isArray(layers) || layers.length === 0) return '';
  /** @type {Set<string>} */
  const seenBottleKeys = new Set();
  for (const layer of layers) {
    if (!layer || !layer.bottlesDir || !Array.isArray(layer.availableBottles)) continue;
    for (const bName of layer.availableBottles) {
      if (!bName) continue;
      const bPath = path.resolve(path.join(layer.bottlesDir, bName));
      const key = bPath.replace(/\\/g, '/').toLowerCase();
      if (seenBottleKeys.has(key)) continue;
      seenBottleKeys.add(key);
      if (!fs.existsSync(bPath)) continue;
      if (resolveBottleSteamExe(bPath) && hasBottleSteamAppManifest(bPath, steamAppId)) {
        return bPath;
      }
    }
  }
  return '';
}

async function launchGame(/** @type {any} */ payload = {}, /** @type {any} */ options = {}) {
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
  if (inFlightLaunchesByGameId.has(gameId)) {
    return inFlightLaunchesByGameId.get(gameId);
  }

  const launchAbortController = new AbortController();
  const callerSignal = options?.signal;
  /** @type {(() => void) | null} */
  let onCallerAbort = null;
  if (callerSignal) {
    if (callerSignal.aborted) {
      launchAbortController.abort(callerSignal.reason);
    } else if (typeof callerSignal.addEventListener === 'function') {
      onCallerAbort = () => launchAbortController.abort(callerSignal.reason);
      callerSignal.addEventListener('abort', onCallerAbort, { once: true });
    }
  }
  inFlightLaunchAbortControllers.set(gameId, launchAbortController);

  const launchOpts = { ...options, signal: launchAbortController.signal };
  const rawPromise = launchGameInternal(payload, launchOpts, gameId, launchAbortController.signal);
  const trackedPromise = rawPromise.finally(() => {
    if (inFlightLaunchesByGameId.get(gameId) === trackedPromise) {
      inFlightLaunchesByGameId.delete(gameId);
    }
    if (inFlightLaunchAbortControllers.get(gameId) === launchAbortController) {
      inFlightLaunchAbortControllers.delete(gameId);
    }
    if (callerSignal && onCallerAbort && typeof callerSignal.removeEventListener === 'function') {
      try {
        callerSignal.removeEventListener('abort', onCallerAbort);
      } catch {}
    }
  });
  inFlightLaunchesByGameId.set(gameId, trackedPromise);
  return trackedPromise;
}

async function launchGameInternal(
  /** @type {any} */ payload = {},
  /** @type {any} */ options = {},
  /** @type {string} */ gameId = '',
  /** @type {AbortSignal | null} */ launchSignal = null
) {
  let lockedPlatformId = '';
  let lockedBottlePrefix = '';
  /** @type {{ xboxLoopbackServer: any, displayWatcherChild: any, displayControlFilePosix: string, displayStatusFilePosix: string }} */
  const pendingLaunchResources = {
    xboxLoopbackServer: null,
    displayWatcherChild: null,
    displayControlFilePosix: '',
    displayStatusFilePosix: '',
  };
  const cleanupPendingLaunchResources = () => {
    disposeSessionResources(pendingLaunchResources, { closeXboxLoopback: true, options });
    pendingLaunchResources.displayControlFilePosix = '';
    pendingLaunchResources.displayStatusFilePosix = '';
  };
  const isLaunchAborted = () => Boolean(launchSignal?.aborted);
  const abortedLaunchResult = () => {
    cleanupPendingLaunchResources();
    return {
      success: false,
      cancelled: true,
      error: 'Launch cancelled by user.',
    };
  };
  const acquireOrTransferBottleLock = async (/** @type {string | null | undefined} */ prefixPath) => {
    if (!prefixPath) return;
    const resolvedTargetPrefix = path.resolve(prefixPath);
    if (lockedBottlePrefix === resolvedTargetPrefix) {
      return;
    }
    // Increment new prefix BEFORE releasing old prefix so the new bottle is protected without any gap
    pendingBottleLaunches.set(
      resolvedTargetPrefix,
      (pendingBottleLaunches.get(resolvedTargetPrefix) || 0) + 1
    );
    if (lockedBottlePrefix) {
      const prevOld = pendingBottleLaunches.get(lockedBottlePrefix) || 0;
      if (prevOld <= 1) {
        pendingBottleLaunches.delete(lockedBottlePrefix);
      } else {
        pendingBottleLaunches.set(lockedBottlePrefix, prevOld - 1);
      }
    }
    lockedBottlePrefix = resolvedTargetPrefix;

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
          if (launchSignal && typeof launchSignal.addEventListener === 'function') {
            launchSignal.addEventListener(
              'abort',
              () => {
                clearTimeout(t);
                resolve(undefined);
              },
              { once: true }
            );
          }
        }),
      ]);
    }
  };
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
    if (isLaunchAborted()) {
      return abortedLaunchResult();
    }
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
          if (launchSignal && typeof launchSignal.addEventListener === 'function') {
            launchSignal.addEventListener(
              'abort',
              () => {
                clearTimeout(t);
                resolve(undefined);
              },
              { once: true }
            );
          }
        }),
      ]);
      if (isLaunchAborted()) {
        return abortedLaunchResult();
      }
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
    const rawMergedLaunchConfig = {
      ...platformSavedConfig,
      ...(payload.storefrontClientLifecycle
        ? { storefrontClientLifecycle: payload.storefrontClientLifecycle }
        : {}),
      ...platformPayloadConfig,
    };
    const rawSavedEnv =
      platformSavedConfig.environmentVariables &&
      typeof platformSavedConfig.environmentVariables === 'object'
        ? sanitizeSpawnEnvironmentMap(platformSavedConfig.environmentVariables, { gameId, options })
        : undefined;
    const rawInlineEnv =
      platformPayloadConfig.environmentVariables &&
      typeof platformPayloadConfig.environmentVariables === 'object'
        ? sanitizeSpawnEnvironmentMap(platformPayloadConfig.environmentVariables, { gameId, options })
        : undefined;
    const mergedSafeEnv =
      rawSavedEnv || rawInlineEnv
        ? { ...(rawSavedEnv || {}), ...(rawInlineEnv || {}) }
        : undefined;
    const launchConfig = {
      ...rawMergedLaunchConfig,
      ...(mergedSafeEnv ? { environmentVariables: mergedSafeEnv } : {}),
    };
    const effectivePerfPolicy = payload.performanceSettings
      ? resolveEffectivePerformancePolicy(launchConfig, payload.performanceSettings, options)
      : resolveEffectivePerformancePolicy(launchConfig, options);
    /** @type {any} */
    let gogWakeResult = null;
    /** @type {any} */
    let steamMinimalSpawnedResult = null;

    const rawLaunchMethod = launchConfig.launchMethod || payload.launchMethod || 'auto';
    const launchMethod = rawLaunchMethod === 'custom' ? 'auto' : rawLaunchMethod;
    const effectiveHostArch = String(options.arch || process.arch || 'arm64')
      .trim()
      .toLowerCase();
    if (
      platform === 'darwin' &&
      normalizeRequestedCompatibilityLayerType(
        launchConfig.compatibilityLayer || payload.compatibilityLayer
      ) === 'crossover_preview_arm64' &&
      effectiveHostArch !== 'arm64'
    ) {
      return {
        success: false,
        error:
          'Launch failed: CrossOver Preview (arm64 / FEX) requires an Apple Silicon (arm64) Mac and is unsupported on Intel x86_64.',
      };
    }
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
    // SUP-01: Verify authoritative installPath containment before flattening or chmod +x
    if (
      platform === 'darwin' &&
      localInstallDir &&
      !isInstallInsideBottle &&
      fs.existsSync(localInstallDir)
    ) {
      if (isAuthoritativeInstallDirForMutation(localInstallDir, options)) {
        try {
          flattenGogNestedInstallDir(localInstallDir);
          ensureMacExecutablePermissions(localInstallDir);
        } catch {}
      } else {
        diagLog.warn(
          'launchGame.skipUntrustedInstallDirMutation',
          'Skipped directory flatten/chmod for unverified installPath',
          { gameId, localInstallDir }
        );
      }
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
            if (!isExcludedExecutable(path.basename(relCand)) && !isGdkStubExecutablePath(relCand)) {
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
              !isGdkStubExecutablePath(candidateCfgExe) &&
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
        if (appInfoSpec && appInfoSpec.isWindowsBinaryOnMac) {
          isWindowsBinaryOnMac = true;
        }
        if (
          !resolvedExePath &&
          appInfoSpec &&
          appInfoSpec.executablePath &&
          fs.existsSync(appInfoSpec.executablePath)
        ) {
          resolvedExePath = appInfoSpec.executablePath;
        }
      }
    }

    // Intercept Chained Publisher Launcher titles & Xbox GDKStubGame.exe stub packages
    // while keeping Steam `storefront_depot_uri` (`link2ea://` / `uplay://`) titles on the Steam launch path
    let isSteamStorefrontDepotUri = false;
    let steamChainedPublisherHandoff = '';
    {
      const cleanLaunchLookupId = String(payload.platformGameId || gameId || '')
        .replace(/^(epic|gog|steam|xbox|ubisoft|ea|bnet|rockstar|riot)[-_:]/i, '')
        .trim();
      const managedRecordsForLaunch = loadManagedInstalledGames(
        resolveIsolatedHomedirAndUserData(options).userDataDir
      );
      const installedRecord = managedRecordsForLaunch.find(
        (/** @type {any} */ r) =>
          (r.platformId === payload.platformId &&
            ((payload.platformGameId &&
              r.platformGameId &&
              String(r.platformGameId) === String(payload.platformGameId)) ||
              (cleanLaunchLookupId &&
                r.platformGameId &&
                String(r.platformGameId) === cleanLaunchLookupId))) ||
          (localInstallDir &&
            r.installPath &&
            path.resolve(toLocalFsPath(r.installPath)) === path.resolve(localInstallDir))
      );

      const epicResolvedMeta =
        normPlatformId === 'epic' ? resolveEpicAppAndPlatforms(payload, options) : null;

      const standalonePublisherPlatform = ['ubisoft', 'ea', 'bnet', 'rockstar', 'riot'].includes(
        normPlatformId
      )
        ? normPlatformId
        : '';
      let chainedHandoffId = resolveAnyChainedHandoffId(
        payload.chainedLauncherHandoff ||
          payload.chainedRequiresLauncherHandoff ||
          payload.externalStorefrontHandoff ||
          installedRecord?.chainedLauncherHandoff ||
          installedRecord?.chainedRequiresLauncherHandoff ||
          installedRecord?.externalStorefrontHandoff ||
          xboxReceipt?.chainedLauncherHandoff ||
          xboxReceipt?.externalStorefrontHandoff ||
          epicResolvedMeta?.chainedLauncherHandoff ||
          appInfoSpec?.chainedLauncherHandoff ||
          standalonePublisherPlatform
      );

      const hasGdkStubIndicator = Boolean(
        isGdkStubExecutablePath(launchConfig.customExecutablePath || '') ||
          isGdkStubExecutablePath(resolvedExePath || '') ||
          isGdkStubExecutablePath(payload.executablePath || '') ||
          isGdkStubExecutablePath(installedRecord?.executablePath || '') ||
          xboxGameCfg?.isExternalLauncherStub
      );

      if (resolvedExePath && isGdkStubExecutablePath(resolvedExePath)) {
        resolvedExePath = undefined;
      }

      if (!chainedHandoffId && hasGdkStubIndicator) {
        const pfnProbe = String(
          xboxGameCfg?.packageFamilyName ||
            xboxAppxCfg?.packageFamilyName ||
            payload.packageFamilyName ||
            installedRecord?.packageFamilyName ||
            ''
        ).toLowerCase();
        if (pfnProbe.includes('ubisoft')) chainedHandoffId = 'ubisoft';
        else if (
          pfnProbe.includes('electronicarts') ||
          pfnProbe.includes('electronicartsmobile') ||
          pfnProbe.includes('_q5ha1ztykcgvj') ||
          pfnProbe.includes('.ea')
        ) {
          chainedHandoffId = 'ea';
        } else if (pfnProbe.includes('blizzard') || pfnProbe.includes('activision')) {
          chainedHandoffId = 'bnet';
        } else if (pfnProbe.includes('rockstar') || pfnProbe.includes('take-two')) {
          chainedHandoffId = 'rockstar';
        } else if (pfnProbe.includes('riotgames')) {
          chainedHandoffId = 'riot';
        }
      }

      if (!chainedHandoffId && hasGdkStubIndicator) {
        return {
          success: false,
          error:
            'This Xbox package is an external publisher launcher stub (GDKStubGame.exe) and cannot be executed directly.',
        };
      }

      if (normPlatformId === 'steam' && !hasGdkStubIndicator) {
        const steamProbeDir =
          localInstallDir ||
          (payload.installPath ? toLocalFsPath(payload.installPath) : '') ||
          (installedRecord?.installPath ? toLocalFsPath(installedRecord.installPath) : '');
        const hasSteamEaInstallerXml = Boolean(
          steamProbeDir &&
            fs.existsSync(path.join(steamProbeDir, '__Installer', 'installerdata.xml'))
        );
        if (
          chainedHandoffId ||
          hasSteamEaInstallerXml ||
          appInfoSpec?.requiresStorefrontProtocolLaunch ||
          payload.requiresStorefrontProtocolLaunch ||
          installedRecord?.requiresStorefrontProtocolLaunch ||
          payload.chainedHandoffTopology === 'storefront_depot_uri' ||
          installedRecord?.chainedHandoffTopology === 'storefront_depot_uri'
        ) {
          isSteamStorefrontDepotUri = true;
          steamChainedPublisherHandoff =
            chainedHandoffId ||
            resolveAnyChainedHandoffId(appInfoSpec?.chainedLauncherHandoff) ||
            (hasSteamEaInstallerXml ? 'ea' : '');
        }
      }

      if (chainedHandoffId && !isSteamStorefrontDepotUri) {
        const effectivePayload =
          epicResolvedMeta &&
          (epicResolvedMeta.epicPartnerRegistryPath || epicResolvedMeta.chainedExternalInstallId)
            ? {
                ...payload,
                ...(epicResolvedMeta.epicPartnerRegistryPath && !payload.epicPartnerRegistryPath
                  ? { epicPartnerRegistryPath: epicResolvedMeta.epicPartnerRegistryPath }
                  : {}),
                ...(epicResolvedMeta.chainedExternalInstallId && !payload.chainedExternalInstallId
                  ? { chainedExternalInstallId: epicResolvedMeta.chainedExternalInstallId }
                  : {}),
                ...(epicResolvedMeta.chainedHandoffTopology && !payload.chainedHandoffTopology
                  ? { chainedHandoffTopology: epicResolvedMeta.chainedHandoffTopology }
                  : {}),
              }
            : payload;
        const acquireBottleLock = async (/** @type {string} */ resolvedTargetPrefix) => {
          if (!resolvedTargetPrefix) return;
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
                platformId: payload.platformId || chainedHandoffId,
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
        };

        return await launchChainedPublisherGame({
          gameId,
          normPlatformId,
          chainedHandoffId,
          payload: effectivePayload,
          options,
          platform,
          launchConfig,
          effectivePerfPolicy,
          localInstallDir,
          isInstallInsideBottle,
          isWindowsBinaryOnMac,
          hasGdkStubIndicator,
          resolvedExePath,
          installedRecord,
          xboxReceipt,
          acquireBottleLock,
          releasePendingBottleLock,
          releasePendingPlatformLock,
        });
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
      platform === 'darwin' &&
      !launchConfig.customExecutablePath &&
      resolvedExePath &&
      /\.exe$/i.test(resolvedExePath)
    ) {
      const candidateGogDirs = Array.from(
        new Set([path.dirname(resolvedExePath), localInstallDir].filter(Boolean))
      );
      const resolvedBaseLower = path.basename(resolvedExePath).toLowerCase();
      for (const candidateGogDir of candidateGogDirs) {
        try {
          if (!fs.existsSync(candidateGogDir) || !fs.statSync(candidateGogDir).isDirectory()) {
            continue;
          }
          const gogInfoFile = fs
            .readdirSync(candidateGogDir)
            .find((f) => /^\.?goggame-\d+\.info$/i.test(f));
          if (!gogInfoFile) continue;
          const parsedInfo = JSON.parse(
            fs.readFileSync(path.join(candidateGogDir, gogInfoFile), 'utf8')
          );
          if (!Array.isArray(parsedInfo?.playTasks)) continue;
          const matchedLauncherTask = parsedInfo.playTasks.find(
            (/** @type {any} */ t) =>
              t &&
              typeof t.path === 'string' &&
              String(t.category || '').trim().toLowerCase() === 'launcher' &&
              !t.arguments &&
              path.win32.basename(t.path.trim()).toLowerCase() === resolvedBaseLower
          );
          if (!matchedLauncherTask) continue;
          const preferredTask = selectPreferredGogPlayTask(
            parsedInfo.playTasks,
            candidateGogDirs,
            { platform }
          );
          if (
            preferredTask &&
            typeof preferredTask.path === 'string' &&
            path.win32.basename(preferredTask.path.trim()).toLowerCase() !== resolvedBaseLower
          ) {
            const relTaskPath = String(preferredTask.path).trim().replace(/\\/g, '/');
            let directGameExe = resolveCaseInsensitiveRelFile(candidateGogDir, relTaskPath);
            if (
              !directGameExe &&
              typeof preferredTask.workingDir === 'string' &&
              preferredTask.workingDir.trim()
            ) {
              const relWork = String(preferredTask.workingDir).trim().replace(/\\/g, '/');
              directGameExe = resolveCaseInsensitiveRelFile(
                candidateGogDir,
                `${relWork}/${relTaskPath}`
              );
            }
            if (directGameExe && fs.existsSync(directGameExe)) {
              resolvedExePath = directGameExe;
              isWindowsBinaryOnMac = true;
              break;
            }
          }
        } catch {}
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

    const hasExplicitLaunchArgs = Boolean(
      (typeof launchConfig.launchArguments === 'string' && launchConfig.launchArguments.trim()) ||
        (Array.isArray(payload.launchArgs) && payload.launchArgs.length > 0) ||
        (typeof payload.launchArguments === 'string' && payload.launchArguments.trim())
    );
    if (resolvedExePath && !launchConfig.customExecutablePath && !hasExplicitLaunchArgs) {
      const siblingCandidate = resolveSiblingLauncherStub(
        resolvedExePath,
        localInstallDir || payload.installPath || ''
      );
      if (siblingCandidate && fs.existsSync(siblingCandidate)) {
        resolvedExePath = siblingCandidate;
      }
    }

    /** @type {any} */
    let resolvedExePeInfo = null;
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
      const requestedCompatLayer = normalizeRequestedCompatibilityLayerType(
        launchConfig.compatibilityLayer || payload.compatibilityLayer
      );
      let allowArm64PeForLaunch = false;
      if (platform === 'darwin' && effectiveHostArch === 'arm64') {
        if (requestedCompatLayer) {
          allowArm64PeForLaunch = requestedCompatLayer === 'crossover_preview_arm64';
        } else {
          const previewLayers = detectCompatibilityLayers(options);
          const autoLayer =
            previewLayers.find(
              (l) =>
                l.available !== false &&
                (l.type === 'crossover' ||
                  l.type === 'crossover_preview' ||
                  l.type === 'crossover_preview_arm64')
            ) ||
            previewLayers.find((l) => l.available !== false) ||
            previewLayers[0];
          allowArm64PeForLaunch = autoLayer?.type === 'crossover_preview_arm64';
        }
      }
      if (
        peInfo &&
        peInfo.exists &&
        peInfo.isValidPe &&
        !isCompatibleX86OrX64PeHeader(peInfo, {
          hostPlatform: platform,
          hostArch: options.arch || process.arch,
          allowArm64Pe: allowArm64PeForLaunch,
        })
      ) {
        const searchRoot = localInstallDir || payload.installPath || path.dirname(resolvedExePath);
        const compatibleAltExe = !launchConfig.customExecutablePath
          ? findBestX86OrX64WindowsExe(searchRoot, {
              strictPe: Boolean(options.strictPe),
              platform,
              arch: options.arch || process.arch,
            })
          : null;
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
      resolvedExePeInfo = peInfo;
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
    const env = buildSafeChildEnvironment(
      process.env,
      launchConfig.environmentVariables,
      {},
      { gameId, options }
    );

    // SUP-01: Execute approved pre-launch command asynchronously (strictly gated on isLaunchCommandApproved)
    if (launchConfig.preLaunchCommand) {
      const preLaunchCwd =
        localInstallDir && fs.existsSync(localInstallDir)
          ? localInstallDir
          : resolvedExePath && fs.existsSync(path.dirname(resolvedExePath))
            ? path.dirname(resolvedExePath)
            : process.cwd();
      await runApprovedLaunchHookCommand('preLaunchCommand', launchConfig.preLaunchCommand, {
        gameId,
        env,
        cwd: preLaunchCwd,
        launchConfig,
        options,
        logTag: 'launchGame.preLaunchCommand',
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
          Boolean(normalizeRequestedCompatibilityLayerType(launchConfig.compatibilityLayer))));

    const effectiveCaps =
      resolvedExePath &&
      resolvedExePath !== 'explorer.exe' &&
      /\.exe$/i.test(String(resolvedExePath))
        ? resolveEffectiveGameExecutableCapabilities(
            resolvedExePath,
            localInstallDir || '',
            {
              ...options,
              launchArguments: effectiveLaunchArgsStr,
            }
          )
        : null;

    if (platform === 'win32' && !useCompatLayer) {
      if (localInstallDir && fs.existsSync(localInstallDir)) {
        try {
          await executeGogGameScript(localInstallDir, {
            ...options,
            platform: 'win32',
          });
        } catch (winScriptErr) {
          diagLog.warn('launchGame.win32GogScriptNonFatal', winScriptErr, { gameId });
        }
      }

      if (effectiveCaps) {
        const rawCompatCombined = `${effectiveCaps.gogCompatibilityFlags || ''} ${effectiveCaps.launcherSettings?.environmentVars || ''}`;
        const isLegacyDpiSensitive = Boolean(
          effectiveCaps.usesLegacyDirectDrawOrD3d ||
            effectiveCaps.needsLegacyDisplayModeSynthesis ||
            /\b(?:16BITCOLOR|256COLOR|640X480)\b/i.test(rawCompatCombined)
        );
        const shouldKeepCompatToken = (/** @type {string} */ tok) => {
          if (!tok) return false;
          if (
            launchConfig.runAsAdmin !== true &&
            /^(?:RUNASADMIN|ElevateCreateProcess)$/i.test(tok)
          ) {
            return false;
          }
          if (isLegacyDpiSensitive && /^HIGHDPIAWARE$/i.test(tok)) {
            return false;
          }
          return true;
        };

        const compatTokens = [];
        if (effectiveCaps.gogCompatibilityFlags) {
          for (const tok of effectiveCaps.gogCompatibilityFlags.split(/\s+/)) {
            if (shouldKeepCompatToken(tok) && !compatTokens.includes(tok)) {
              compatTokens.push(tok);
            }
          }
        }
        if (effectiveCaps.launcherSettings?.environmentVars) {
          for (const pair of effectiveCaps.launcherSettings.environmentVars.split(/[;\r\n]+/)) {
            const eq = pair.indexOf('=');
            if (eq <= 0) continue;
            const envKey = pair.slice(0, eq).trim();
            const envVal = pair.slice(eq + 1).trim();
            if (!envKey || !envVal) continue;
            if (/^__COMPAT_LAYER$/i.test(envKey)) {
              for (const tok of envVal.split(/\s+/)) {
                if (shouldKeepCompatToken(tok) && !compatTokens.includes(tok)) {
                  compatTokens.push(tok);
                }
              }
            } else if (!launchConfig.environmentVariables?.[envKey] && env[envKey] === undefined) {
              env[envKey] = envVal;
            }
          }
        }
        if (
          compatTokens.length > 0 &&
          !launchConfig.environmentVariables?.__COMPAT_LAYER
        ) {
          const existingCompat = String(env.__COMPAT_LAYER || '')
            .trim()
            .split(/\s+/)
            .filter(Boolean);
          for (const tok of compatTokens) {
            if (!existingCompat.includes(tok)) {
              existingCompat.push(tok);
            }
          }
          env.__COMPAT_LAYER = existingCompat.join(' ');
        }
      }
    }

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

    const effectiveSteamAppId =
      payload.platformId === 'steam'
        ? String(payload.steamAppId || payload.platformGameId || '')
            .replace(/^steam[-_]/i, '')
            .trim()
        : '';

    const routeBottledWindowsUriToBottle = Boolean(
      useCompatLayer &&
        platform === 'darwin' &&
        launchMethod === 'storefront_uri' &&
        payload.platformId === 'steam' &&
        effectiveSteamAppId
    );
    const isBottledWindowsGogStorefrontUri = Boolean(
      useCompatLayer &&
        platform === 'darwin' &&
        launchMethod === 'storefront_uri' &&
        payload.platformId === 'gog'
    );

    const isFastMinimalBypass =
      !isSteamStorefrontDepotUri &&
      !routeBottledWindowsUriToBottle &&
      !isBottledWindowsGogStorefrontUri &&
      (effectivePerfPolicy.storefrontClientLifecycle === 'fast_direct_bypass' ||
        (payload.platformId === 'steam' && launchMethod === 'direct'));

    if (
      isSteamStorefrontDepotUri &&
      platform === 'darwin' &&
      !resolvedExePath &&
      isInstallInsideBottle &&
      localInstallDir
    ) {
      const enclosingBottle = extractBottleRootFromPath(localInstallDir);
      const fallbackBottleSteam = enclosingBottle ? resolveBottleSteamExe(enclosingBottle) : null;
      if (fallbackBottleSteam) {
        resolvedExePath = fallbackBottleSteam;
      }
    }

    const isAutoLikeMethod = launchMethod === 'auto' || launchMethod === 'custom';

    const isSteamAutoUriPreferred =
      payload.platformId === 'steam' &&
      (isAutoLikeMethod || isSteamStorefrontDepotUri) &&
      !isFastMinimalBypass &&
      !useCompatLayer &&
      !payload.customExecutablePath &&
      !launchConfig?.customExecutablePath &&
      Boolean(buildStorefrontLaunchUri(payload)) &&
      (platform === 'win32' ||
        (platform === 'darwin' && Boolean(resolveSteamClientBinaryPath(options))));

    // 1. Direct or Compatibility Layer execution when executable is available
    if (
      (resolvedExePath || routeBottledWindowsUriToBottle || isBottledWindowsGogStorefrontUri) &&
      !isSteamAutoUriPreferred &&
      (launchMethod !== 'storefront_uri' ||
        routeBottledWindowsUriToBottle ||
        isBottledWindowsGogStorefrontUri) &&
      (launchMethod === 'direct' ||
        isAutoLikeMethod ||
        launchMethod === 'compatibility_layer' ||
        useCompatLayer)
    ) {
      let spawnCmd = resolvedExePath;
      let spawnArgs = [...args];
      let actualLaunchMethod = 'direct';
      const preGeneratedSessionId = `session-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
      const effectiveDisplayScalingMode =
        effectivePerfPolicy.effectiveDisplayScalingMode || 'auto_fullscreen';
      const effectiveDisplayAspectRatio =
        effectivePerfPolicy.effectiveDisplayAspectRatio || 'preserve_aspect';
      const enableFullscreenHotkey = effectivePerfPolicy.enableFullscreenHotkey !== false;
      const initialBottleFullscreen =
        effectiveDisplayScalingMode === 'auto_fullscreen' ||
        effectiveDisplayScalingMode === 'force_fullscreen';
      let bottleDisplayControlFilePosix = '';
      let bottleDisplayStatusFilePosix = '';
      /** @type {ReturnType<typeof stageBottleDisplayScalerBinaries> | null} */
      let bottleDisplayStagedInfo = null;
      let bottleDisplayScalerWrapped = false;
      let bottleShouldWatchSteamGameDir = false;
      /** @type {string[]} */
      let bottleSteamDisplayDllArgs = [];
      /** @type {any} */
      let bottleDisplayWatcherChild = null;
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
      let shouldPingWarmBottleSteamOpenMain = false;
      /** @type {number | undefined} */
      let bottleSteamCloudLogSessionStartOffset;
      let bottleSteamGameProcessLogStartOffset = 0;
      let wasBottleSteamPublisherRunning = false;
      let wokeBottleSteamPublisherByLauncher = false;
      /** @type {string | null} */
      let bottleGogExe = null;
      let gogUriOriginalGameExeBasename = '';
      let shouldWakeBottleGog = false;
      let wasBottleGogRunning = false;
      let wokeBottleGogByLauncher = false;
      /** @type {string | null} */
      let bottleEpicExe = null;
      let shouldWakeBottleEpic = false;
      let wasBottleEpicRunning = false;
      let wokeBottleEpicByLauncher = false;
      let hasOtherActiveBottleSession = false;
      /** @type {Record<string, any>} */
      let outerCompatLayerCapOptions = options;
      let outerEffectiveCompatLaunchConfig = launchConfig;
      /** @type {any} */
      let initialAppLocalProxyInfo = {
        hasOverrides: false,
        envOverrideSpec: '',
        appDefaultsMap: {},
        validatedDllNames: [],
      };
      let initialAppLocalProxyDirsKey = '';
      let lastPreLaunchCloudSyncAt = 0;
      /** @type {string[]} */
      let mergedCompatTargetExeNames = [];
      /** @type {() => Promise<void>} */
      let recycleIdleBottleWineserverBeforeClientWake = async () => {};
      /** @type {any} */
      let xboxLoopbackServer = null;
      let wasXboxAppRunningAtStart = false;
      let wokeXboxAppByLauncher = false;
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
        const layers = detectCompatibilityLayers({
          ...options,
          ...(effectiveCaps?.isLegacy32BitOpenGl ? { preferLegacy32BitOpenGlWine: true } : {}),
        });
        const rawInstallBottleRoot = extractBottleRootFromPath(
          localInstallDir || resolvedExePath || ''
        );
        const installBottlePath =
          rawInstallBottleRoot && fs.existsSync(rawInstallBottleRoot)
            ? path.resolve(rawInstallBottleRoot)
            : '';
        const steamLibraryAffinityBottlePath =
          !installBottlePath && payload.platformId === 'steam' && effectiveSteamAppId
            ? findBottleWithSteamAppManifest(layers, effectiveSteamAppId)
            : '';
        const affinityBottlePath = installBottlePath || steamLibraryAffinityBottlePath;

        const rawPreferredType = launchConfig.compatibilityLayer || payload.compatibilityLayer;
        const preferredType = normalizeRequestedCompatibilityLayerType(rawPreferredType);
        if (
          preferredType === 'crossover_preview_arm64' &&
          platform === 'darwin' &&
          effectiveHostArch !== 'arm64'
        ) {
          return {
            success: false,
            error:
              'Launch failed: CrossOver Preview (arm64 / FEX) requires an Apple Silicon (arm64) Mac and is unsupported on Intel x86_64.',
          };
        }
        const explicitMatchedLayer = preferredType
          ? layers.find((l) => l && (l.type === preferredType || l.id === preferredType))
          : null;
        if (preferredType) {
          if (!explicitMatchedLayer) {
            return {
              success: false,
              error: `Launch failed: Requested compatibility runner "${preferredType}" is not installed.`,
            };
          }
          if (
            explicitMatchedLayer.available === false ||
            (explicitMatchedLayer.type === 'crossover_preview_arm64' &&
              platform === 'darwin' &&
              effectiveHostArch !== 'arm64')
          ) {
            return {
              success: false,
              error:
                explicitMatchedLayer.type === 'crossover_preview_arm64'
                  ? 'Launch failed: CrossOver Preview (arm64 / FEX) requires an Apple Silicon (arm64) Mac and is unsupported on Intel x86_64.'
                  : `Launch failed: Requested compatibility runner "${preferredType}" is unavailable on this host.`,
            };
          }
        }
        const defaultCandidateLayer =
          layers.find(
            (l) =>
              l &&
              l.available !== false &&
              !(
                l.type === 'crossover_preview_arm64' &&
                platform === 'darwin' &&
                effectiveHostArch !== 'arm64'
              ) &&
              (l.type === 'crossover' ||
                l.type === 'crossover_preview' ||
                l.type === 'crossover_preview_arm64')
          ) ||
          layers.find(
            (l) =>
              l &&
              l.available !== false &&
              !(
                l.type === 'crossover_preview_arm64' &&
                platform === 'darwin' &&
                effectiveHostArch !== 'arm64'
              )
          ) ||
          layers[0] ||
          null;
        const defaultCompatibleWithAffinity = Boolean(
          !preferredType &&
            affinityBottlePath &&
            defaultCandidateLayer &&
            isLayerCompatibleWithBottle(defaultCandidateLayer, affinityBottlePath, effectiveHostArch)
        );
        const affinityMatchedLayer =
          !preferredType && affinityBottlePath && !defaultCompatibleWithAffinity
            ? selectRecommendedLayerForBottle(layers, affinityBottlePath, effectiveHostArch)
            : null;
        let chosenLayer = preferredType
          ? explicitMatchedLayer
          : defaultCompatibleWithAffinity
            ? defaultCandidateLayer
            : affinityMatchedLayer || defaultCandidateLayer;

        if (!chosenLayer) {
          if (
            isAutoLikeMethod &&
            !routeBottledWindowsUriToBottle &&
            !isBottledWindowsGogStorefrontUri &&
            options.allowStorefrontFallbackOnMissingCompat
          ) {
            resolvedExePath = undefined;
          } else {
            return {
              success: false,
              error:
                'No Windows compatibility layer (CrossOver, Game Porting Toolkit, or Wine) detected on macOS to run this Windows executable.',
            };
          }
        } else {
          if (
            chosenLayer.type === 'crossover_preview_arm64' &&
            platform === 'darwin' &&
            effectiveHostArch !== 'arm64'
          ) {
            return {
              success: false,
              error:
                'Launch failed: CrossOver Preview (arm64 / FEX) requires an Apple Silicon (arm64) Mac and is unsupported on Intel x86_64.',
            };
          }
          let effectiveCompatLaunchConfig = launchConfig;
          if (
            !installBottlePath &&
            steamLibraryAffinityBottlePath &&
            !effectiveCompatLaunchConfig?.wineBottleName &&
            !effectiveCompatLaunchConfig?.winePrefixPath &&
            chosenLayer.bottlesDir &&
            areSameBottleDirPath(
              path.dirname(steamLibraryAffinityBottlePath),
              chosenLayer.bottlesDir
            ) &&
            layerSupportsBottleArch(
              chosenLayer,
              inspectBottleConfMetadata(steamLibraryAffinityBottlePath).wineArch || 'win64',
              effectiveHostArch
            )
          ) {
            effectiveCompatLaunchConfig = {
              ...effectiveCompatLaunchConfig,
              wineBottleName: path.basename(steamLibraryAffinityBottlePath),
            };
          }
          if (
            (effectiveCaps?.isLegacy32BitOpenGl ||
              effectiveCaps?.needsLegacyDisplayModeSynthesis) &&
            options.forceRequestedCompatLayer !== true &&
            chosenLayer.type === 'wine'
          ) {
            const readyCrossOverLayer = layers.find(
              (l) =>
                l.available !== false &&
                (l.type === 'crossover' ||
                  l.type === 'crossover_preview' ||
                  l.type === 'crossover_preview_arm64') &&
                l.binaryPath &&
                ((Array.isArray(l.availableBottles) && l.availableBottles.length > 0) ||
                  isTestEnvironment(options) ||
                  fs.existsSync(l.binaryPath))
            );
            if (readyCrossOverLayer) {
              diagLog.info('launchGame.routedLegacy32BitOpenGlToCrossOver', {
                gameId,
                fromRuntime: chosenLayer.name || chosenLayer.id || 'wine',
                toRuntime: readyCrossOverLayer.type,
              });
              chosenLayer = readyCrossOverLayer;
              if (
                effectiveCompatLaunchConfig?.winePrefixPath &&
                !/\/CrossOver(?: Preview(?: arm64)?)?\/Bottles\//i.test(
                  String(effectiveCompatLaunchConfig.winePrefixPath).replace(/\\/g, '/')
                )
              ) {
                effectiveCompatLaunchConfig = {
                  ...effectiveCompatLaunchConfig,
                  winePrefixPath: undefined,
                };
              }
            } else if (chosenLayer.legacy32BitOpenGlBinaryPath) {
              chosenLayer = {
                ...chosenLayer,
                binaryPath: chosenLayer.legacy32BitOpenGlBinaryPath,
              };
            }
          }

          let preCompatParadoxExe = '';
          if (resolvedExePath && /^dowser\.exe$/i.test(path.basename(resolvedExePath))) {
            const pdxCandidate =
              effectiveCaps?.paradoxDirectGameExe ||
              resolveParadoxLauncherSettings(
                resolvedExePath,
                localInstallDir || path.dirname(resolvedExePath)
              ).paradoxDirectGameExe ||
              '';
            if (pdxCandidate && fs.existsSync(pdxCandidate)) {
              preCompatParadoxExe = pdxCandidate;
            }
          }
          const preCompatProxyCandidateDirs = [
            resolvedExePath ? path.dirname(resolvedExePath) : '',
            localInstallDir || '',
            ...(preCompatParadoxExe ? [path.dirname(preCompatParadoxExe)] : []),
            ...(effectiveCaps?.targetExePaths || []).map((p) => path.dirname(p)),
          ].filter(Boolean);
          initialAppLocalProxyDirsKey = Array.from(
            new Set(preCompatProxyCandidateDirs.map((d) => path.resolve(d)))
          ).join('|');
          initialAppLocalProxyInfo = discoverValidatedAppLocalProxyDllOverrides(
            preCompatProxyCandidateDirs,
            effectiveCaps?.effectiveMachine || 'unknown',
            options
          );
          // Do NOT merge `initialAppLocalProxyInfo.envOverrideSpec` globally into `env.WINEDLLOVERRIDES`
          // here: for Bottle Steam launches, Wine `AppDefaults\<tExe>\DllOverrides` scopes proxy DLLs
          // strictly per game `.exe` without polluting `steam.exe` / `steamwebhelper.exe` or leaking to
          // subsequent games. Direct (`!shouldLaunchViaBottleSteam`) launches still merge it below.
          mergedCompatTargetExeNames = Array.from(
            new Set([
              ...(effectiveCaps?.targetExeBasenamesLower || []),
              ...(resolvedExePath ? [path.basename(resolvedExePath).toLowerCase()] : []),
              ...(preCompatParadoxExe ? [path.basename(preCompatParadoxExe).toLowerCase()] : []),
            ])
          ).filter((name) => Boolean(name && name.endsWith('.exe')));

          const compatLayerCapOptions = {
            ...options,
            gameId,
            runnerType: chosenLayer.type,
            isPreviewRunner:
              chosenLayer.type === 'crossover_preview' ||
              chosenLayer.type === 'crossover_preview_arm64',
            isPreviewArm64Runner: chosenLayer.type === 'crossover_preview_arm64',
            ...(chosenLayer.binaryPath ? { wineBinary: chosenLayer.binaryPath } : {}),
            ...(chosenLayer.version ? { runnerVersion: chosenLayer.version } : {}),
            ...(effectiveCaps ? { peCapabilities: effectiveCaps } : {}),
            ...(options.enableAudioBufferClamp === true ||
            (options.enableAudioBufferClamp !== false &&
              launchConfig?.audioBufferClamp === true)
              ? { enableAudioBufferClamp: true }
              : {}),
            enableLegacyDisplayModeSynthesis: Boolean(
              effectiveCaps?.needsLegacyDisplayModeSynthesis
            ),
            limitLegacy32BitGlExtensions: Boolean(effectiveCaps?.isLegacy32BitOpenGl),
            usesLegacyDirectDraw: Boolean(effectiveCaps?.usesLegacyDirectDrawOrD3d),
            displayScalingMode: effectivePerfPolicy.effectiveDisplayScalingMode,
            displayAspectRatio: effectivePerfPolicy.effectiveDisplayAspectRatio,
            exeName: resolvedExePath ? path.basename(resolvedExePath) : '',
            targetExeNames: mergedCompatTargetExeNames,
            ...(initialAppLocalProxyInfo.hasOverrides
              ? { appLocalDllOverrides: initialAppLocalProxyInfo.appDefaultsMap }
              : {}),
            ...(localInstallDir ? { installDir: localInstallDir } : {}),
            ...(resolvedExePath ? { executablePath: resolvedExePath } : {}),
          };
          outerCompatLayerCapOptions = compatLayerCapOptions;
          outerEffectiveCompatLaunchConfig = effectiveCompatLaunchConfig;

          const isUnmockedHostBottleInVitest =
            Boolean(process.env.VITEST || process.env.NODE_ENV === 'test') &&
            !options.allowBottleClientWakeInTest &&
            ((typeof options.bottleClientSpawnFn !== 'function' &&
              typeof options.gameSpawnFn !== 'function' &&
              typeof options.spawnFn !== 'function') ||
              String((chosenLayer && chosenLayer.binaryPath) || '').startsWith('/Applications/'));

          // L-02: Acquire `pendingBottleLaunches` and await `inFlightPostSessionByBottle` BEFORE
          // `ensureCompatibilityLayerReady` mutates bottle registry/config or runs idle `wineserver -k`.
          const predictedPrefix = predictTargetBottlePrefix(
            chosenLayer,
            effectiveCompatLaunchConfig,
            compatLayerCapOptions
          );
          if (predictedPrefix) {
            await acquireOrTransferBottleLock(predictedPrefix);
            if (isLaunchAborted()) {
              return abortedLaunchResult();
            }
          }

          const checkHasOtherActiveSessionInPrefix = (/** @type {string} */ prefixKey) =>
            Boolean(prefixKey) &&
            ((pendingBottleLaunches.get(prefixKey) || 0) > 1 ||
              Array.from(activeSessions.entries()).some(
                ([activeId, activeEntry]) =>
                  activeId !== gameId &&
                  !activeEntry.finalized &&
                  activeEntry.winePrefix &&
                  path.resolve(activeEntry.winePrefix) === prefixKey
              ));

          const hasCustomExecutable = Boolean(
            launchConfig?.customExecutablePath || payload.customExecutablePath
          );

          const computeNeedBottleClientsForPrefix = (/** @type {string | null} */ prefixDir) => {
            if (!prefixDir || isUnmockedHostBottleInVitest) {
              return { needSteam: false, needGog: false, needEpic: false };
            }
            let needSteam = false;
            let needGog = false;
            let needEpic = false;
            if (payload.platformId === 'steam') {
              const bSteam = resolveBottleSteamExe(prefixDir);
              needSteam = Boolean(
                bSteam &&
                  effectiveSteamAppId &&
                  !isFastMinimalBypass &&
                  !hasCustomExecutable &&
                  !options.disableBottleSteamLaunch &&
                  !options.disableBottleStorefrontLaunch
              );
            } else if (payload.platformId === 'gog') {
              const bGog = resolveBottleGogGalaxyExe(prefixDir);
              const gogSdk =
                options.strictGalaxySdkCheck === true
                  ? doesGogInstallUseGalaxySdk(localInstallDir, resolvedExePath)
                  : true;
              needGog = Boolean(
                bGog &&
                  !isFastMinimalBypass &&
                  options.usesGalaxySdk !== false &&
                  gogSdk &&
                  !options.disableBottleGogLaunch &&
                  !options.disableBottleStorefrontLaunch
              );
            } else if (payload.platformId === 'epic') {
              const bEpic = resolveBottleEpicLauncherExe(prefixDir);
              needEpic = Boolean(
                bEpic &&
                  !isFastMinimalBypass &&
                  !options.disableBottleEpicLaunch &&
                  !options.disableBottleStorefrontLaunch
              );
            }
            return { needSteam, needGog, needEpic };
          };

          // Run idle `wineserver -k` BEFORE `ensureCompatibilityLayerReady` when no bottle client is needed,
          // so `applyCrossOverPerGameSettings` writes static `.reg` files cleanly once with zero wasted live `reg.exe import`.
          let ranPreCompatIdleShutdownForPrefix = '';
          if (predictedPrefix && !checkHasOtherActiveSessionInPrefix(lockedBottlePrefix)) {
            if (
              !isTestEnvironment(options) &&
              resolvedExePath &&
              resolvedExePath.toLowerCase().endsWith('.exe')
            ) {
              await killPosixProcessesMatchingWinExe(
                resolvedExePath,
                'SIGKILL',
                localInstallDir || predictedPrefix || ''
              );
            }
            const preClientNeed = computeNeedBottleClientsForPrefix(predictedPrefix);
            if (!preClientNeed.needSteam && !preClientNeed.needGog && !preClientNeed.needEpic) {
              const candidateWineserver = resolveWineserverBinary(chosenLayer.binaryPath);
              const canRunWineserver =
                Boolean(candidateWineserver && predictedPrefix) &&
                (!options.homedir ||
                  String(candidateWineserver).startsWith(options.homedir) ||
                  String(candidateWineserver).startsWith(os.tmpdir()) ||
                  String(candidateWineserver).startsWith('/private/var/folders') ||
                  String(candidateWineserver).startsWith('/var/folders'));
              if (canRunWineserver) {
                deleteBottleDaemonEnvContract(predictedPrefix);
                await shutdownWinePrefix(chosenLayer.binaryPath, predictedPrefix, 2000);
                ranPreCompatIdleShutdownForPrefix = path.resolve(predictedPrefix);
              }
            }
          }

          compatResult = await ensureCompatibilityLayerReady(
            chosenLayer,
            effectiveCompatLaunchConfig,
            env,
            compatLayerCapOptions
          );
          if (isLaunchAborted()) {
            return abortedLaunchResult();
          }

          if (
            chosenLayer.type === 'crossover' ||
            chosenLayer.type === 'crossover_preview' ||
            chosenLayer.type === 'crossover_preview_arm64'
          ) {
            const resolvedBottleDir =
              env.WINEPREFIX ||
              (chosenLayer.bottlesDir && env.CX_BOTTLE
                ? path.join(chosenLayer.bottlesDir, env.CX_BOTTLE)
                : '');
            const isMissingOrUninitializedBottle =
              !resolvedBottleDir ||
              (options.skipBottleProvisioning === true
                ? !isValidBottleDirectory(resolvedBottleDir, false)
                : !fs.existsSync(resolvedBottleDir));
            if (isMissingOrUninitializedBottle) {
              const missingBottleLabel =
                env.CX_BOTTLE ||
                launchConfig.wineBottleName ||
                (chosenLayer.type === 'crossover_preview_arm64'
                  ? 'OneLauncher-arm64'
                  : 'OneLauncher');
              return {
                success: false,
                error: `CrossOver bottle "${missingBottleLabel}" is missing or does not exist at "${resolvedBottleDir || '(unresolved)'}". Provision or select a valid bottle first.`,
              };
            }
          }

          chosenCompatLayer = chosenLayer;
          targetWinePrefix = compatResult?.winePrefix || env.WINEPREFIX || null;
          if (
            resolvedExePeInfo &&
            resolvedExePeInfo.isValidPe &&
            (resolvedExePeInfo.isArm64 ||
              resolvedExePeInfo.isArm64Ec ||
              resolvedExePeInfo.machine === 0xaa64 ||
              resolvedExePeInfo.machine === 0xa641) &&
            (chosenLayer.type !== 'crossover_preview_arm64' ||
              (compatResult?.wineArch && compatResult.wineArch !== 'arm64') ||
              (targetWinePrefix &&
                fs.existsSync(path.join(targetWinePrefix, 'cxbottle.conf')) &&
                inspectBottleConfMetadata(targetWinePrefix).wineArch === 'win64'))
          ) {
            return {
              success: false,
              error: `Launch failed: Executable "${path.basename(resolvedExePath || 'game.exe')}" targets unsupported architecture (${resolvedExePeInfo.machineHex || '0xaa64'}) for ${chosenLayer.type}.`,
            };
          }

          // Cleanly transfer bottle lock & await post-session barrier if `compatResult.winePrefix` diverged from `predictedPrefix`
          if (targetWinePrefix) {
            await acquireOrTransferBottleLock(targetWinePrefix);
            if (isLaunchAborted()) {
              return abortedLaunchResult();
            }
          }

          if (targetWinePrefix) {
            alignWineMsyncWithLiveBottle(targetWinePrefix, env);
          }

          applyUnifiedPerformanceHudEnv({
            env,
            launchConfig: effectiveCompatLaunchConfig,
            perfSettings: effectivePerfPolicy,
            chosenLayer,
            backend: env.CX_GRAPHICS_BACKEND || effectiveCompatLaunchConfig?.crossoverGraphicsBackend || '',
            platform,
            useCompatLayer: true,
            wineBinaryPath: chosenLayer?.binaryPath || '',
            options,
            gameId,
            respectExistingEnvMetalHud: true,
            syncCxEnv: true,
          });

          if (payload.platformId === 'steam' && targetWinePrefix) {
            const bottleSteamRequired = Boolean(
              payload.platformId === 'steam' &&
                targetWinePrefix &&
                effectiveSteamAppId &&
                !isFastMinimalBypass &&
                !hasCustomExecutable &&
                !isUnmockedHostBottleInVitest &&
                !options.disableBottleSteamLaunch &&
                !options.disableBottleStorefrontLaunch
            );
            bottleSteamExe = !isUnmockedHostBottleInVitest || routeBottledWindowsUriToBottle
              ? resolveBottleSteamExe(targetWinePrefix)
              : null;
            const installBottleSteamExe = installBottlePath
              ? resolveBottleSteamExe(installBottlePath)
              : null;
            const recommendedLayerForGuard = affinityBottlePath
              ? selectRecommendedLayerForBottle(layers, affinityBottlePath, effectiveHostArch)
              : null;
            const recommendedCompatRunnerType = recommendedLayerForGuard?.type || '';
            const targetBottleName = path.basename(targetWinePrefix);
            const installBottleName = installBottlePath
              ? path.basename(installBottlePath)
              : undefined;

            // Guard 2A: Target bottle lacks `steam.exe` when Steam Client launch is required
            if ((bottleSteamRequired || routeBottledWindowsUriToBottle) && !bottleSteamExe) {
              const hasAnyBottleSteamOnHost =
                Boolean(installBottleSteamExe) ||
                (Array.isArray(layers) &&
                  layers.some((l) => {
                    if (!l) return false;
                    if (l.bottleDetails && typeof l.bottleDetails === 'object') {
                      if (
                        Object.values(l.bottleDetails).some((/** @type {any} */ d) =>
                          Boolean(d && d.hasSteam)
                        )
                      ) {
                        return true;
                      }
                    }
                    if (l.bottlesDir && Array.isArray(l.availableBottles)) {
                      return l.availableBottles.some((/** @type {string} */ bName) =>
                        Boolean(resolveBottleSteamExe(path.join(l.bottlesDir, bName)))
                      );
                    }
                    return false;
                  }));
              const shouldEnforceBottleSteamGuard =
                options.allowDirectFallbackWhenBottleSteamMissing !== true &&
                (Boolean(installBottlePath) ||
                  hasAnyBottleSteamOnHost ||
                  routeBottledWindowsUriToBottle ||
                  !isTestEnvironment(options) ||
                  options.enforceBottleSteamGuard === true);
              if (shouldEnforceBottleSteamGuard) {
                cleanupPendingLaunchResources();
                releasePendingBottleLock();
                releasePendingPlatformLock();
                return {
                  success: false,
                  errorCode: 'BOTTLE_STEAM_NOT_INSTALLED',
                  targetBottleName,
                  targetBottlePath: targetWinePrefix,
                  ...(chosenCompatLayer?.type ? { chosenRunnerType: chosenCompatLayer.type } : {}),
                  ...(installBottleName ? { installBottleName } : {}),
                  installBottleHasSteam: Boolean(installBottleSteamExe),
                  ...(recommendedCompatRunnerType
                    ? { recommendedRunnerType: recommendedCompatRunnerType }
                    : {}),
                  error:
                    installBottleName && installBottleSteamExe
                      ? `Cannot launch "${payload.title || gameId}" via Steam Client: bottle "${targetBottleName}" (${chosenLayer.name || chosenLayer.type}) does not have Windows Steam installed. This game and its Steam Cloud setup are installed in bottle "${installBottleName}". Open Launch Config to switch to a compatible runner for "${installBottleName}", install Steam into "${targetBottleName}", or choose Fast Bottle Launch (disables Steam Cloud).`
                      : `Cannot launch "${payload.title || gameId}" via Steam Client: bottle "${targetBottleName}" (${chosenLayer.name || chosenLayer.type}) does not have Windows Steam installed. Install Windows Steam into "${targetBottleName}" or choose Fast Bottle Launch (disables Steam Cloud) in Launch Config.`,
                };
              }
            }

            // Guard 2B: Target bottle has `steam.exe`, but differs from `installBottlePath` and
            // target Steam does not recognize `appmanifest_<appId>.acf` (read-only VDF check)
            if (
              bottleSteamRequired &&
              bottleSteamExe &&
              installBottlePath &&
              !areSameBottleDirPath(installBottlePath, targetWinePrefix) &&
              options.allowCrossBottleSteamWithoutManifest !== true &&
              !hasBottleSteamAppManifest(targetWinePrefix, effectiveSteamAppId)
            ) {
              cleanupPendingLaunchResources();
              releasePendingBottleLock();
              releasePendingPlatformLock();
              return {
                success: false,
                errorCode: 'BOTTLE_STEAM_APP_NOT_IN_TARGET_BOTTLE',
                targetBottleName,
                targetBottlePath: targetWinePrefix,
                ...(chosenCompatLayer?.type ? { chosenRunnerType: chosenCompatLayer.type } : {}),
                installBottleName,
                installBottleHasSteam: Boolean(installBottleSteamExe),
                ...(recommendedCompatRunnerType
                  ? { recommendedRunnerType: recommendedCompatRunnerType }
                  : {}),
                error: `Cannot launch "${payload.title || gameId}" via Steam Client: Steam in bottle "${targetBottleName}" (${chosenLayer.name || chosenLayer.type}) does not recognize Steam AppID ${effectiveSteamAppId} as installed (launching via -applaunch would open the Steam Install dialog). This game is installed in bottle "${installBottleName}". Open Launch Config to switch to a compatible runner for "${installBottleName}" or choose Fast Bottle Launch (disables Steam Cloud).`,
              };
            }

            shouldLaunchViaBottleSteam = Boolean(
              bottleSteamExe &&
                effectiveSteamAppId &&
                !isFastMinimalBypass &&
                !hasCustomExecutable &&
                !isUnmockedHostBottleInVitest &&
                !options.disableBottleSteamLaunch &&
                !options.disableBottleStorefrontLaunch
            );
            if (routeBottledWindowsUriToBottle) {
              if (!resolvedExePath && bottleSteamExe) {
                resolvedExePath = bottleSteamExe;
              }
              if (!shouldLaunchViaBottleSteam && !resolvedExePath) {
                cleanupPendingLaunchResources();
                releasePendingBottleLock();
                releasePendingPlatformLock();
                return {
                  success: false,
                  errorCode: 'BOTTLE_STEAM_NOT_INSTALLED',
                  targetBottleName,
                  targetBottlePath: targetWinePrefix,
                  ...(chosenCompatLayer?.type ? { chosenRunnerType: chosenCompatLayer.type } : {}),
                  ...(installBottleName ? { installBottleName } : {}),
                  installBottleHasSteam: Boolean(installBottleSteamExe),
                  ...(recommendedCompatRunnerType
                    ? { recommendedRunnerType: recommendedCompatRunnerType }
                    : {}),
                  error: `Cannot launch "${payload.title || gameId}" via Steam Client in bottle "${targetBottleName}": Windows Steam launch is unavailable for this bottle.`,
                };
              }
            }
            if (shouldLaunchViaBottleSteam && steamChainedPublisherHandoff) {
              wasBottleSteamPublisherRunning = await checkBottlePublisherUiRunningAsync(
                targetWinePrefix,
                steamChainedPublisherHandoff,
                options
              );
              const pubEcosystem = /** @type {Record<string, any>} */ (CHAINED_PUBLISHER_ECOSYSTEMS)[
                steamChainedPublisherHandoff
              ];
              if (
                options.skipPublisherProvisioning !== true &&
                pubEcosystem &&
                pubEcosystem.supportedInWineBottle
              ) {
                const discoveredBottlePub = discoverBottlePublisherLauncher(
                  targetWinePrefix,
                  steamChainedPublisherHandoff
                );
                if (
                  !discoveredBottlePub?.installed ||
                  typeof options.ensureChainedPublisherLauncherInstalledFn === 'function'
                ) {
                  emitSessionUpdated(
                    {
                      gameId,
                      platformId: payload.platformId || 'steam',
                      status: 'starting',
                      event: 'starting',
                      statusMessage: `Preparing ${pubEcosystem.displayName || steamChainedPublisherHandoff} in Wine bottle...`,
                    },
                    options
                  );
                  const ensureProvisionFn =
                    typeof options.ensureChainedPublisherLauncherInstalledFn === 'function'
                      ? options.ensureChainedPublisherLauncherInstalledFn
                      : getEnsureChainedPublisherLauncherInstalled();
                  try {
                    await ensureProvisionFn(
                      {
                        handoffId: steamChainedPublisherHandoff,
                        platform: 'darwin',
                        runnerLayer: chosenLayer,
                        bottleName: String(env.CX_BOTTLE || path.basename(targetWinePrefix)),
                        bottlePath: targetWinePrefix,
                      },
                      options
                    );
                  } catch (pubProvErr) {
                    diagLog.warn('launchGame.bottleSteamPublisherProvision', pubProvErr, {
                      gameId,
                      handoffId: steamChainedPublisherHandoff,
                    });
                  }
                }
              }
              wokeBottleSteamPublisherByLauncher = !wasBottleSteamPublisherRunning;
            }
          } else if (payload.platformId === 'gog' && targetWinePrefix) {
            bottleGogExe =
              !isUnmockedHostBottleInVitest || isBottledWindowsGogStorefrontUri
                ? resolveBottleGogGalaxyExe(targetWinePrefix)
                : null;
            if (isBottledWindowsGogStorefrontUri && !bottleGogExe) {
              const gogTargetBottleName = path.basename(targetWinePrefix);
              cleanupPendingLaunchResources();
              releasePendingBottleLock();
              releasePendingPlatformLock();
              return {
                success: false,
                errorCode: 'BOTTLE_GOG_GALAXY_NOT_INSTALLED',
                targetBottleName: gogTargetBottleName,
                targetBottlePath: targetWinePrefix,
                error: `Cannot launch "${payload.title || gameId}" via GOG Galaxy URI on macOS: bottle "${gogTargetBottleName}" (${chosenLayer.name || chosenLayer.type}) does not have Windows GOG Galaxy installed, and host macOS GOG Galaxy cannot launch Windows bottle games. Install Windows GOG Galaxy in "${gogTargetBottleName}" or switch Launch Method to Direct / Compatibility Layer in Launch Config.`,
              };
            }
            const origGogExePathForSdkCheck = resolvedExePath;
            if (isBottledWindowsGogStorefrontUri && bottleGogExe) {
              if (
                resolvedExePath &&
                path.basename(resolvedExePath).toLowerCase() !== 'galaxyclient.exe'
              ) {
                gogUriOriginalGameExeBasename = path.basename(resolvedExePath).trim().toLowerCase();
              }
              resolvedExePath = bottleGogExe;
              const cleanBottleGogId = String(payload.platformGameId || gameId || '')
                .trim()
                .replace(/^gog[-_]/i, '');
              if (cleanBottleGogId) {
                const gogRunArgs = ['/command=runGame', `/gameId=${cleanBottleGogId}`];
                if (localInstallDir) {
                  const winGogInstallDir = toWineWindowsPath(localInstallDir, targetWinePrefix);
                  if (winGogInstallDir) {
                    gogRunArgs.push(`/path=${winGogInstallDir}`);
                  }
                }
                args.unshift(...gogRunArgs);
              }
            }
            if (!isUnmockedHostBottleInVitest || isBottledWindowsGogStorefrontUri) {
              const gogInstallUsesSdk =
                isBottledWindowsGogStorefrontUri || options.strictGalaxySdkCheck !== true
                  ? true
                  : doesGogInstallUseGalaxySdk(localInstallDir, origGogExePathForSdkCheck);
              shouldWakeBottleGog = Boolean(
                bottleGogExe &&
                  !isFastMinimalBypass &&
                  (isBottledWindowsGogStorefrontUri || options.usesGalaxySdk !== false) &&
                  gogInstallUsesSdk &&
                  !options.disableBottleGogLaunch &&
                  !options.disableBottleStorefrontLaunch
              );
            }
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
          hasOtherActiveBottleSession = hasOtherActiveSessionInPrefix;

          recycleIdleBottleWineserverBeforeClientWake = async () => {
            if (
              hasOtherActiveBottleSession ||
              !targetWinePrefix ||
              !chosenCompatLayer?.binaryPath ||
              (isTestEnvironment(options) && options.recycleIdleBottleWineserver !== true) ||
              !isBottleWineserverActive(targetWinePrefix, options)
            ) {
              return;
            }
            const candidateWineserver = resolveWineserverBinary(chosenCompatLayer.binaryPath);
            const hasMockExec =
              typeof options.execFileImpl === 'function' ||
              typeof options.execFileFn === 'function';
            const canRunWineserver =
              Boolean((candidateWineserver || hasMockExec) && targetWinePrefix) &&
              (hasMockExec ||
                !options.homedir ||
                String(candidateWineserver).startsWith(options.homedir) ||
                String(candidateWineserver).startsWith(os.tmpdir()) ||
                String(candidateWineserver).startsWith('/private/var/folders') ||
                String(candidateWineserver).startsWith('/var/folders'));
            if (!canRunWineserver) return;
            const execFileForRecycle =
              typeof options.execFileImpl === 'function'
                ? options.execFileImpl
                : typeof options.execFileFn === 'function'
                  ? options.execFileFn
                  : execFile;
            deleteBottleDaemonEnvContract(targetWinePrefix);
            await shutdownWinePrefix(chosenCompatLayer.binaryPath, targetWinePrefix, 2500, {
              bottleName: String(env.CX_BOTTLE || ''),
              execFileFn: execFileForRecycle,
            });
            if (fs.existsSync(targetWinePrefix)) {
              try {
                applyCrossOverPerGameSettings(
                  targetWinePrefix,
                  outerCompatLayerCapOptions.exeName || '',
                  outerEffectiveCompatLaunchConfig,
                  {
                    ...outerCompatLayerCapOptions,
                    skipRegistrySpawn: true,
                    skipLiveWineRegSync: true,
                  }
                );
              } catch {}
            }
            alignWineMsyncWithLiveBottle(targetWinePrefix, env);
            diagLog.info('launchGame.recycledIdleBottleWineserverBeforeWake', {
              gameId,
              bottlePath: targetWinePrefix,
            });
          };

          if (!hasOtherActiveSessionInPrefix) {
            const resolvedPrefixForShutdown = targetWinePrefix ? path.resolve(targetWinePrefix) : '';
            const alreadyShutDownIdlePrefix =
              Boolean(resolvedPrefixForShutdown) &&
              ranPreCompatIdleShutdownForPrefix === resolvedPrefixForShutdown;
            if (
              !alreadyShutDownIdlePrefix &&
              !shouldLaunchViaBottleSteam &&
              !shouldWakeBottleGog &&
              !shouldWakeBottleEpic
            ) {
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
              const candidateWineserver = resolveWineserverBinary(chosenLayer.binaryPath);
              const canRunWineserver =
                Boolean(candidateWineserver && targetWinePrefix) &&
                (!options.homedir ||
                  String(candidateWineserver).startsWith(options.homedir) ||
                  String(candidateWineserver).startsWith(os.tmpdir()) ||
                  String(candidateWineserver).startsWith('/private/var/folders') ||
                  String(candidateWineserver).startsWith('/var/folders'));

              if (canRunWineserver) {
                deleteBottleDaemonEnvContract(targetWinePrefix);
                await shutdownWinePrefix(chosenLayer.binaryPath, targetWinePrefix, 2000);
              }
            }
          }

          if (
            targetWinePrefix &&
            localInstallDir &&
            fs.existsSync(targetWinePrefix) &&
            fs.existsSync(localInstallDir)
          ) {
            try {
              await executeGogGameScript(localInstallDir, {
                ...options,
                platform,
                bottleDir: targetWinePrefix,
                wineBinaryPath: chosenLayer.binaryPath,
              });
            } catch (bottleScriptErr) {
              diagLog.warn('launchGame.bottleGogScriptNonFatal', bottleScriptErr, { gameId });
            }
          }

          if (targetWinePrefix && fs.existsSync(targetWinePrefix)) {
            const installDirKey =
              localInstallDir && fs.existsSync(localInstallDir)
                ? path.resolve(localInstallDir)
                : '';
            const effectiveSanitizeHighRes = launchConfig.crossoverHighResolutionMode;
            const sanitizeKey = buildDisplaySanitizeCacheKey({
              prefixPath: targetWinePrefix,
              highResolutionMode: effectiveSanitizeHighRes,
              displayScalingMode: effectivePerfPolicy.effectiveDisplayScalingMode,
              displayAspectRatio: effectivePerfPolicy.effectiveDisplayAspectRatio,
              installDir: installDirKey,
            });
            const lastSanitizedAt = recentDisplaySanitizeCache.get(sanitizeKey) || 0;
            if (
              options.forceSanitizeDisplayConfigs === true ||
              Date.now() - lastSanitizedAt > 4000
            ) {
              try {
                sanitizeWinePrefixDisplayConfigs(targetWinePrefix, {
                  ...options,
                  ...(localInstallDir ? { installDir: localInstallDir } : {}),
                  ...(typeof effectiveSanitizeHighRes === 'boolean'
                    ? { highResolutionMode: effectiveSanitizeHighRes }
                    : {}),
                  displayScalingMode: effectivePerfPolicy.effectiveDisplayScalingMode,
                  displayAspectRatio: effectivePerfPolicy.effectiveDisplayAspectRatio,
                });
                setBoundedMapEntry(recentDisplaySanitizeCache, sanitizeKey, Date.now(), 256);
              } catch {}
            }
          }
        }
      }

      if (resolvedExePath) {
        if (isLaunchAborted()) {
          return abortedLaunchResult();
        }
        // L-10: Replay any interrupted post-exit cloud upload for this game in conflict-safe bidirectional mode before launching
        if (
          payload.platformId &&
          ['gog', 'epic', 'xbox'].includes(String(payload.platformId).toLowerCase()) &&
          isNetworkOnlineForLaunch(options)
        ) {
          try {
            const queuedUploads = loadPendingCloudUploads(options);
            const matchingPending = queuedUploads.find(
              (item) =>
                item.gameId === gameId &&
                String(item.platformId).toLowerCase() === String(payload.platformId).toLowerCase()
            );
            if (matchingPending) {
              await replayPendingCloudUpload(
                matchingPending,
                { syncGogCloudSaves, syncEpicCloudSaves, syncXboxCloudSaves },
                {
                  ...options,
                  useCompatLayer,
                  winePrefix: targetWinePrefix,
                  installPath: localInstallDir || payload.installPath,
                }
              );
            }
          } catch (replayErr) {
            diagLog.warn('launchGame.pendingCloudUploadReplay', replayErr, { gameId });
          }
        }

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
          let sharedEpicLegAuth = null;
          if (!options.skipAuthRefresh && !options.legendaryConfigDir && !options.legendaryConfigPath) {
            try {
              sharedEpicLegAuth = await ensureLegendaryConfigAndAuth(options);
            } catch {}
          }
          try {
            const epicPreSyncRes = await syncEpicCloudSaves(payload, 'pre_launch', {
              ...options,
              ...(sharedEpicLegAuth ? { prefetchedLegAuth: sharedEpicLegAuth } : {}),
              useCompatLayer,
              winePrefix: targetWinePrefix,
              installPath: localInstallDir || payload.installPath,
            });
            if (epicPreSyncRes && epicPreSyncRes.synced) {
              lastPreLaunchCloudSyncAt = Date.now();
            }
            emitPreLaunchCloudTelemetry(epicPreSyncRes);
          } catch (/** @type {any} */ epicSyncErr) {
            emitPreLaunchCloudTelemetry({
              synced: false,
              reason: epicSyncErr && epicSyncErr.message ? epicSyncErr.message : 'sync_failed',
            });
          }
          if (isLaunchAborted()) {
            return abortedLaunchResult();
          }
          try {
            const epicAuth = await resolveEpicLaunchAuthArguments(payload, {
              ...options,
              ...(sharedEpicLegAuth ? { prefetchedLegAuth: sharedEpicLegAuth } : {}),
            });
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
          if (!isBottledWindowsGogStorefrontUri) {
            try {
              const gogPreSyncRes = await syncGogCloudSaves(payload, 'pre_launch', {
                ...options,
                useCompatLayer,
                winePrefix: targetWinePrefix,
                installPath: localInstallDir || payload.installPath,
              });
              if (gogPreSyncRes && gogPreSyncRes.synced) {
                lastPreLaunchCloudSyncAt = Date.now();
              }
              emitPreLaunchCloudTelemetry(gogPreSyncRes);
            } catch (/** @type {any} */ gogSyncErr) {
              emitPreLaunchCloudTelemetry({
                synced: false,
                reason: gogSyncErr && gogSyncErr.message ? gogSyncErr.message : 'sync_failed',
              });
            }
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
          const isTransientOfflineXboxError = (/** @type {any} */ err) => {
            if (!err) return false;
            const code = String(err.code || err.cause?.code || '').toUpperCase();
            if (
              [
                'ENOTFOUND',
                'ETIMEDOUT',
                'ECONNREFUSED',
                'EAI_AGAIN',
                'ENETUNREACH',
                'EHOSTUNREACH',
                'ECONNRESET',
                'UND_ERR_CONNECT_TIMEOUT',
              ].includes(code)
            ) {
              return true;
            }
            const msg = String(err.message || err || '').toLowerCase();
            return /(?:enotfound|etimedout|econnrefused|eai_again|enetunreach|ehostunreach|econnreset|fetch failed|network\s*(?:error|unreachable|offline)|offline|dns|socket hang up)/i.test(
              msg
            );
          };
          const resolveXboxAuthAndSession = async () => {
            const xboxAuthProvider =
              options.xboxAuthProvider ||
              (activeStoreSync && typeof activeStoreSync.getXboxAuthProvider === 'function'
                ? activeStoreSync.getXboxAuthProvider({
                    userDataDir: resolveIsolatedHomedirAndUserData(options).userDataDir,
                  })
                : null);
            if (options.xboxSession) {
              return { xboxAuthProvider, xboxSession: options.xboxSession };
            }
            let xboxSession = null;
            let encounteredOfflineNetworkError =
              Boolean(options.offline === true) || !isNetworkOnlineForLaunch(options);
            if (
              !encounteredOfflineNetworkError &&
              xboxAuthProvider &&
              typeof xboxAuthProvider.getValidXboxSession === 'function'
            ) {
              try {
                xboxSession = await xboxAuthProvider.getValidXboxSession();
              } catch (/** @type {any} */ authErr) {
                if (isTransientOfflineXboxError(authErr)) {
                  encounteredOfflineNetworkError = true;
                }
                xboxSession = null;
              }
            }
            if (!xboxSession && xboxAuthProvider) {
              /** @type {any} */
              let authStatus = null;
              if (typeof xboxAuthProvider.getAuthStatus === 'function') {
                try {
                  authStatus = await Promise.resolve(xboxAuthProvider.getAuthStatus());
                } catch {
                  authStatus = null;
                }
              }
              const explicitlyLoggedOut = Boolean(
                authStatus &&
                  (authStatus.connected === false ||
                    authStatus.authenticated === false ||
                    authStatus.loggedOut === true)
              );
              if (
                !explicitlyLoggedOut &&
                (encounteredOfflineNetworkError || authStatus?.connected === true)
              ) {
                /** @type {any} */
                let cachedProfile = null;
                if (typeof xboxAuthProvider.getCachedProfile === 'function') {
                  try {
                    cachedProfile = await Promise.resolve(xboxAuthProvider.getCachedProfile());
                  } catch {
                    cachedProfile = null;
                  }
                } else if (
                  authStatus?.connected === true &&
                  typeof xboxAuthProvider.getUserProfile === 'function'
                ) {
                  try {
                    cachedProfile = await Promise.resolve(xboxAuthProvider.getUserProfile());
                  } catch {
                    cachedProfile = null;
                  }
                } else if (authStatus?.connected === true && authStatus?.xuid) {
                  cachedProfile = {
                    xuid: authStatus.xuid,
                    gamertag: authStatus.gamertag,
                    uhs: authStatus.uhs,
                  };
                }
                if (
                  cachedProfile &&
                  cachedProfile.xuid &&
                  cachedProfile.connected !== false &&
                  cachedProfile.loggedOut !== true
                ) {
                  xboxSession = {
                    ...cachedProfile,
                    xuid: String(cachedProfile.xuid),
                    gamertag: String(cachedProfile.gamertag || 'Xbox Player'),
                    uhs: String(cachedProfile.uhs || ''),
                    offline: true,
                  };
                }
              }
            }
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
                  userDataDir: resolveIsolatedHomedirAndUserData(options).userDataDir,
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
              if (xboxPreSyncRes && xboxPreSyncRes.synced) {
                lastPreLaunchCloudSyncAt = Date.now();
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

            const xboxPreLaunchSyncRes = await runXboxPreLaunchSync({
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
                    gameRootDir: localInstallDir || payload.installPath || undefined,
                    locale: payload.locale || options.locale || undefined,
                    storeProvider: options.xboxStoreProvider || undefined,
                    enableCloudSaveSync: true,
                    initialPreLaunchSync: xboxPreLaunchSyncRes || null,
                    fetchImpl: options.fetchImpl,
                  });
                pendingLaunchResources.xboxLoopbackServer = xboxLoopbackServer;
                if (xboxLoopbackServer && xboxLoopbackServer.env) {
                  Object.assign(env, xboxLoopbackServer.env);
                }
                const resolvedXgrLocale = String(
                  xboxLoopbackServer?.env?.ONE_XGR_LOCALE || env.ONE_XGR_LOCALE || ''
                ).trim();
                if (resolvedXgrLocale && !env.WINEUSERLOCALE) {
                  env.WINEUSERLOCALE = resolvedXgrLocale;
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

              const winXboxPreLaunchSyncRes = await runXboxPreLaunchSync({
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
                      gameRootDir: localInstallDir || payload.installPath || undefined,
                      locale: payload.locale || options.locale || undefined,
                      storeProvider: options.xboxStoreProvider || undefined,
                      enableCloudSaveSync: true,
                      initialPreLaunchSync: winXboxPreLaunchSyncRes || null,
                      fetchImpl: options.fetchImpl,
                    });
                  pendingLaunchResources.xboxLoopbackServer = xboxLoopbackServer;
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

              /** @type {any} */
              const winBridgeInfo = stagedWinBridge;
              if (
                options.disableXboxWinLauncher !== true &&
                winBridgeInfo?.requiresXgrInjection !== false
              ) {
                const resolvedWinLauncher =
                  winBridgeInfo?.winLauncherExePath ||
                  resolveBundledXboxWinLauncherExePath(options);
                const candidatePrimaryXgr =
                  winBridgeInfo?.primaryXgameruntimeDllPath ||
                  (resolvedExePath && resolvedExePath !== 'explorer.exe'
                    ? path.join(path.dirname(resolvedExePath), 'xgameruntime.dll')
                    : '');
                if (
                  resolvedWinLauncher &&
                  candidatePrimaryXgr &&
                  fs.existsSync(candidatePrimaryXgr)
                ) {
                  // XGR-06: Verify one_xgr_win_launcher*.exe SHA-256 before spawning
                  const verifiedWinLauncher = await readVerifiedBridgeDllBuffer(
                    resolvedWinLauncher,
                    { strictBridgeSha256: options.strictBridgeSha256 }
                  );
                  if (verifiedWinLauncher.buf) {
                    winClientlessLauncherExe = resolvedWinLauncher;
                    winClientlessPrimaryXgrDll = candidatePrimaryXgr;
                  } else {
                    diagLog.warn(
                      'launchGame.xboxWinLauncherSha256Failed',
                      'Blocked spawning unverified one_xgr_win_launcher binary',
                      { gameId, resolvedWinLauncher }
                    );
                  }
                }
              }
            } else {
              await runXboxPreLaunchSync({
                isAppxRegistered: true,
                useGamingServicesRuntime: true,
              });

              wasXboxAppRunningAtStart = await isWindowsXboxAppRunning(options);
              if (
                effectivePerfPolicy.storefrontClientLifecycle === 'default_client' &&
                !wasXboxAppRunningAtStart &&
                (!isTestEnvironment(options) ||
                  options.enableWindowsXboxDefaultClientLaunchInTest === true)
              ) {
                try {
                  const xboxAppSpawnImpl =
                    typeof options.xboxAppSpawnFn === 'function'
                      ? options.xboxAppSpawnFn
                      : typeof options.spawnFn === 'function'
                        ? options.spawnFn
                        : spawn;
                  const xboxAppChild = xboxAppSpawnImpl(
                    'explorer.exe',
                    ['shell:AppsFolder\\Microsoft.GamingApp_8wekyb3d8bbwe!Microsoft.Xbox.App'],
                    {
                      detached: true,
                      stdio: 'ignore',
                      windowsHide: false,
                    }
                  );
                  if (xboxAppChild && typeof xboxAppChild.unref === 'function') {
                    xboxAppChild.unref();
                  }
                  wokeXboxAppByLauncher = true;
                } catch (xboxAppWakeErr) {
                  diagLog.warn('launchGame.win32XboxDefaultClientWake', xboxAppWakeErr, { gameId });
                }
              }

              const canUseAumidActivation =
                Boolean(resolvedXboxAumid) &&
                !isFastMinimalBypass &&
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
          let wantDisplayLauncherWrap = false;
          if (platform === 'darwin' || (!options.platform && process.platform === 'darwin')) {
            if (
              effectivePerfPolicy.suppressWineDebugLogging !== false &&
              !launchConfig.wineDebug &&
              !launchConfig.environmentVariables?.WINEDEBUG &&
              (!env.WINEDEBUG || env.WINEDEBUG === '-all')
            ) {
              env.WINEDEBUG = '-all,err+system';
              if (
                env.CX_DEBUGMSG === '-all' &&
                !launchConfig.environmentVariables?.CX_DEBUGMSG
              ) {
                env.CX_DEBUGMSG = '-all,err+system';
              }
            }
            // Interface Contract 1: Pure Edge-to-Edge Symmetric Panel Span (ONE_LAUNCHER_SAFE_INSET_TOP: '0')
            const safeInsetTop =
              effectiveDisplayScalingMode !== 'off' && effectiveDisplayScalingMode !== 'windowed'
                ? 0
                : (typeof options?.safeInsetTop === 'number' && Number.isFinite(options.safeInsetTop)
                    ? Math.max(0, Math.min(80, Math.round(options.safeInsetTop)))
                    : 0);
            const shouldWrapDisplayScaler = shouldWrapBottleSessionWithDisplayLauncher(
              effectiveCaps,
              effectiveDisplayScalingMode,
              effectiveLaunchArgsStr
            );

            if (shouldWrapDisplayScaler) {
              env.ONE_LAUNCHER_DISPLAY_SCALING_MODE = effectiveDisplayScalingMode;
              env.ONE_LAUNCHER_DISPLAY_ASPECT = effectiveDisplayAspectRatio;
              env.ONE_LAUNCHER_SAFE_INSET_TOP = String(safeInsetTop);
              env.ONE_LAUNCHER_FULLSCREEN_HOTKEY = enableFullscreenHotkey ? '1' : '0';

              if (targetWinePrefix && fs.existsSync(targetWinePrefix)) {
                bottleDisplayStagedInfo = stageBottleDisplayScalerBinaries(targetWinePrefix, options);
                if (bottleDisplayStagedInfo.stageDirPosix) {
                  bottleDisplayControlFilePosix = path.join(
                    bottleDisplayStagedInfo.stageDirPosix,
                    `display_ctl_${preGeneratedSessionId}.ini`
                  );
                  bottleDisplayStatusFilePosix = path.join(
                    bottleDisplayStagedInfo.stageDirPosix,
                    `display_status_${preGeneratedSessionId}.json`
                  );
                  pendingLaunchResources.displayControlFilePosix = bottleDisplayControlFilePosix;
                  pendingLaunchResources.displayStatusFilePosix = bottleDisplayStatusFilePosix;
                  const winCtlFile = `C:\\ProgramData\\OneLauncher\\display_scaler\\display_ctl_${preGeneratedSessionId}.ini`;
                  const winStatusFile = `C:\\ProgramData\\OneLauncher\\display_scaler\\display_status_${preGeneratedSessionId}.json`;
                  try {
                    atomicWriteFileSync(
                      bottleDisplayControlFilePosix,
                      formatDisplayScalerControlIni(
                        1,
                        initialBottleFullscreen,
                        effectiveDisplayAspectRatio,
                        safeInsetTop
                      )
                    );
                    writeActiveDisplaySessionManifestIni(bottleDisplayStagedInfo.stageDirPosix, {
                      seq: 1,
                      mode: effectiveDisplayScalingMode,
                      aspect: effectiveDisplayAspectRatio,
                      safeInsetTop,
                      hotkey: enableFullscreenHotkey,
                      controlFileWin: winCtlFile,
                      statusFileWin: winStatusFile,
                    });
                  } catch {}
                  env.ONE_LAUNCHER_SCALER_DLL_X86 = bottleDisplayStagedInfo.winDllX86;
                  env.ONE_LAUNCHER_SCALER_DLL_X64 = bottleDisplayStagedInfo.winDllX64;
                  env.ONE_LAUNCHER_LAUNCHER_EXE_X86 = bottleDisplayStagedInfo.winLauncherX86;
                  env.ONE_LAUNCHER_LAUNCHER_EXE_X64 = bottleDisplayStagedInfo.winLauncherX64;
                  env.ONE_LAUNCHER_DISPLAY_CONTROL_FILE = winCtlFile;
                  env.ONE_LAUNCHER_DISPLAY_STATUS_FILE = winStatusFile;
                }
              }

              const canInjectDisplayScaler =
                (!isTestEnvironment(options) || options.enableDisplayScalerInTests === true) &&
                Boolean(bottleDisplayStagedInfo && bottleDisplayStagedInfo.allPresent);
              wantDisplayLauncherWrap = canInjectDisplayScaler;
            } else {
              delete env.ONE_LAUNCHER_SCALER_DLL_X86;
              delete env.ONE_LAUNCHER_SCALER_DLL_X64;
              delete env.ONE_LAUNCHER_LAUNCHER_EXE_X86;
              delete env.ONE_LAUNCHER_LAUNCHER_EXE_X64;
              delete env.ONE_LAUNCHER_DISPLAY_CONTROL_FILE;
              delete env.ONE_LAUNCHER_DISPLAY_STATUS_FILE;
              env.ONE_LAUNCHER_DISPLAY_SCALING_MODE =
                effectiveDisplayScalingMode === 'windowed' ? 'windowed' : 'off';
              env.ONE_LAUNCHER_DISPLAY_ASPECT = effectiveDisplayAspectRatio;
              env.ONE_LAUNCHER_SAFE_INSET_TOP = String(safeInsetTop);
              env.ONE_LAUNCHER_FULLSCREEN_HOTKEY = '0';
              if (targetWinePrefix && fs.existsSync(targetWinePrefix)) {
                const existingStageDir = path.join(
                  targetWinePrefix,
                  'drive_c',
                  'ProgramData',
                  'OneLauncher',
                  'display_scaler'
                );
                if (fs.existsSync(existingStageDir)) {
                  try {
                    writeActiveDisplaySessionManifestIni(existingStageDir, {
                      seq: 1,
                      mode: 'off',
                      aspect: effectiveDisplayAspectRatio,
                      safeInsetTop: 0,
                      hotkey: false,
                      controlFileWin: '',
                      statusFileWin: '',
                    });
                  } catch {}
                }
              }
              wantDisplayLauncherWrap = false;
            }
          }

          if (shouldLaunchViaBottleSteam && bottleSteamExe) {
            const execFileImpl =
              typeof options.execFileImpl === 'function'
                ? options.execFileImpl
                : typeof options.execFileFn === 'function'
                  ? options.execFileFn
                  : execFile;
            const steamProbe = await inspectRunningBottleSteam(targetWinePrefix || '', {
              ...options,
              platform,
            });
            wasBottleSteamRunning = Boolean(steamProbe.running);
            const observedSteamBackend = String(steamProbe.observedBackend || '');
            const observedSteamLaunchedSilent = Boolean(steamProbe.launchedSilent);

            const prefixContractKey = normalizeBottlePrefixContractKey(targetWinePrefix);
            const targetGraphicsContract = computeBottleGraphicsEnvContract(
              env,
              launchConfig?.environmentVariables
            );
            const desiredBackendLower = String(env.CX_GRAPHICS_BACKEND || 'auto')
              .trim()
              .toLowerCase();
            /** @type {'silent' | 'standard'} */
            const desiredBottleSteamUiMode =
              effectivePerfPolicy.storefrontClientLifecycle === 'default_client'
                ? 'standard'
                : 'silent';

            if (
              wasBottleSteamRunning &&
              !hasOtherActiveBottleSession &&
              targetWinePrefix &&
              options.enableWarmDaemonEnvRecycle !== false
            ) {
              const recordedContract = prefixContractKey
                ? liveBottleDaemonEnvContractByPrefix.get(prefixContractKey)
                : undefined;
              const hasRecordedContractMismatch =
                typeof recordedContract === 'string' && recordedContract !== targetGraphicsContract;
              const hasUnrecordedIncompatibleBackend =
                recordedContract === undefined &&
                ((Boolean(observedSteamBackend) && observedSteamBackend !== desiredBackendLower) ||
                  (Boolean(env.CX_GRAPHICS_BACKEND) &&
                    desiredBackendLower !== 'auto' &&
                    (!isTestEnvironment(options) || options.enableWarmDaemonEnvRecycle === true)));

              if (hasRecordedContractMismatch || hasUnrecordedIncompatibleBackend) {
                diagLog.info('launchGame.recycledWarmBottleSteamForGraphicsContract', {
                  gameId,
                  bottlePath: targetWinePrefix,
                  previousContract: recordedContract || null,
                  observedSteamBackend: observedSteamBackend || null,
                  targetContract: targetGraphicsContract,
                });
                try {
                  const shutdownSteamEnv = {
                    ...env,
                    WINEPREFIX: targetWinePrefix,
                  };
                  stripDisplayScalerEnvFromClientEnv(shutdownSteamEnv);
                  const alignedSteamShutdown = prepareAlignedAuxBottleWineCommand({
                    wineBinary: chosenCompatLayer.binaryPath,
                    bottlePath: targetWinePrefix,
                    env: shutdownSteamEnv,
                    suppressGuiDialogs: true,
                    layerType: chosenCompatLayer.type,
                  });
                  const steamExeForShutdown = bottleSteamExe;
                  await new Promise((resolve) => {
                    try {
                      execFileImpl(
                        alignedSteamShutdown.binaryPath,
                        [steamExeForShutdown, '-shutdown'],
                        {
                          cwd: path.dirname(steamExeForShutdown),
                          env: alignedSteamShutdown.env,
                          timeout: 4000,
                        },
                        () => resolve(undefined)
                      );
                    } catch {
                      resolve(undefined);
                    }
                  });
                  const maxSteamExitWaitMs =
                    options.bottleSteamShutdownWaitMs !== undefined
                      ? Math.max(0, Number(options.bottleSteamShutdownWaitMs))
                      : !isTestEnvironment(options) || options.awaitBottleSteamExitInTest === true
                        ? 10000
                        : 0;
                  if (maxSteamExitWaitMs > 0) {
                    const steamExitPollMs = Math.max(
                      20,
                      Number(options.bottleSteamShutdownPollMs || 300)
                    );
                    const steamExitDeadline = Date.now() + maxSteamExitWaitMs;
                    while (Date.now() < steamExitDeadline) {
                      const stillRunning = await isBottleWinExeRunning(
                        'steam.exe',
                        targetWinePrefix,
                        { ...options, platform }
                      );
                      if (!stillRunning) break;
                      const remainingMs = steamExitDeadline - Date.now();
                      if (remainingMs <= 0) break;
                      await new Promise((r) => {
                        const t = setTimeout(r, Math.min(steamExitPollMs, remainingMs));
                        if (typeof t.unref === 'function') t.unref();
                      });
                    }
                  }
                } catch {}
                deleteBottleDaemonEnvContract(targetWinePrefix);
                await shutdownWinePrefix(chosenCompatLayer.binaryPath, targetWinePrefix, 3000, {
                  bottleName: String(env.CX_BOTTLE || ''),
                  layerType: chosenCompatLayer.type,
                  execFileFn: execFileImpl,
                });
                if (fs.existsSync(targetWinePrefix)) {
                  try {
                    applyCrossOverPerGameSettings(
                      targetWinePrefix,
                      outerCompatLayerCapOptions.exeName || '',
                      outerEffectiveCompatLaunchConfig,
                      {
                        ...outerCompatLayerCapOptions,
                        skipRegistrySpawn: true,
                        skipLiveWineRegSync: true,
                      }
                    );
                  } catch {}
                }
                alignWineMsyncWithLiveBottle(targetWinePrefix, env);
                wasBottleSteamRunning = false;
              }
            } else if (!wasBottleSteamRunning) {
              await recycleIdleBottleWineserverBeforeClientWake();
            }

            if (!wasBottleSteamRunning) {
              if (prefixContractKey) {
                setBoundedMapEntry(
                  liveBottleDaemonEnvContractByPrefix,
                  prefixContractKey,
                  targetGraphicsContract,
                  128
                );
              }
              if (targetWinePrefix) {
                setLiveBottleSteamUiMode(targetWinePrefix, desiredBottleSteamUiMode);
              }
            } else if (targetWinePrefix) {
              const recordedSteamUiMode = getLiveBottleSteamUiMode(targetWinePrefix);
              const isWarmSteamSilent = Boolean(
                observedSteamLaunchedSilent || recordedSteamUiMode === 'silent'
              );
              if (desiredBottleSteamUiMode === 'standard' && isWarmSteamSilent) {
                shouldPingWarmBottleSteamOpenMain = true;
              } else if (desiredBottleSteamUiMode === 'standard') {
                setLiveBottleSteamUiMode(targetWinePrefix, 'standard');
              } else if (observedSteamLaunchedSilent && !recordedSteamUiMode) {
                setLiveBottleSteamUiMode(targetWinePrefix, 'silent');
              }
            }

            spawnCmd = chosenCompatLayer.binaryPath;
            const trimmedSteamDll =
              typeof env.WINEDLLOVERRIDES === 'string' ? env.WINEDLLOVERRIDES.trim() : '';
            const steamDllArgs =
              trimmedSteamDll &&
              (doesCrossOverBinarySupportWaitChildren(chosenCompatLayer.binaryPath) ||
                options.forceCrossOverDllFlag === true)
                ? ['--dll', trimmedSteamDll]
                : [];
            spawnArgs = [
              ...steamDllArgs,
              bottleSteamExe,
              ...(effectivePerfPolicy.storefrontClientLifecycle === 'default_client'
                ? []
                : ['-silent']),
              '-applaunch',
              String(effectiveSteamAppId),
              ...args,
            ];
            bottleSteamDisplayDllArgs = steamDllArgs;
            bottleShouldWatchSteamGameDir = Boolean(
              wantDisplayLauncherWrap && localInstallDir && targetWinePrefix
            );
            actualLaunchMethod = `compatibility_layer:${chosenCompatLayer.type}`;
          } else {
            spawnCmd = chosenCompatLayer.binaryPath;
            let resolvedParadoxDirectExe = '';
            if (resolvedExePath && /^dowser\.exe$/i.test(path.basename(resolvedExePath))) {
              const pdxResolved =
                effectiveCaps?.paradoxDirectGameExe ||
                resolveParadoxLauncherSettings(
                  resolvedExePath,
                  localInstallDir || path.dirname(resolvedExePath)
                ).paradoxDirectGameExe ||
                '';
              if (pdxResolved && fs.existsSync(pdxResolved)) {
                resolvedParadoxDirectExe = pdxResolved;
                if (!hasParadoxLauncherInstalledInBottle(targetWinePrefix)) {
                  resolvedExePath = pdxResolved;
                  const pdxExtraArgs = Array.isArray(effectiveCaps?.paradoxLauncherSettings?.exeArgs)
                    ? effectiveCaps.paradoxLauncherSettings.exeArgs
                    : [];
                  for (const extraArg of pdxExtraArgs) {
                    if (extraArg && !args.includes(extraArg)) {
                      args.push(extraArg);
                    }
                  }
                }
              }
            }
            const proxyCandidateDirs = [
              resolvedExePath ? path.dirname(resolvedExePath) : '',
              localInstallDir || '',
              ...(resolvedParadoxDirectExe ? [path.dirname(resolvedParadoxDirectExe)] : []),
              ...(effectiveCaps?.targetExePaths || []).map((p) => path.dirname(p)),
            ].filter(Boolean);
            const proxyDirsKey = Array.from(
              new Set(proxyCandidateDirs.map((d) => path.resolve(d)))
            ).join('|');
            const appLocalProxyInfo =
              initialAppLocalProxyDirsKey && proxyDirsKey === initialAppLocalProxyDirsKey
                ? initialAppLocalProxyInfo
                : discoverValidatedAppLocalProxyDllOverrides(
                    proxyCandidateDirs,
                    effectiveCaps?.effectiveMachine || 'unknown',
                    options
                  );
            if (appLocalProxyInfo.hasOverrides) {
              env.WINEDLLOVERRIDES = mergeWineDllOverrides(
                env.WINEDLLOVERRIDES,
                appLocalProxyInfo.envOverrideSpec
              );
              if (targetWinePrefix && fs.existsSync(targetWinePrefix)) {
                try {
                  const userRegPath = path.join(targetWinePrefix, 'user.reg');
                  const skipLiveSync = Boolean(
                    options.homedir || options.skipRegistrySpawn || options.skipLiveWineRegSync
                  );
                  const dllEntries = Object.entries(appLocalProxyInfo.appDefaultsMap).map(
                    ([k, v]) => /** @type {[string, any]} */ ([k, { type: 'sz', value: v }])
                  );
                  const targetBases = effectiveCaps?.targetExeBasenamesLower?.length
                    ? effectiveCaps.targetExeBasenamesLower
                    : resolvedExePath
                      ? [path.basename(resolvedExePath).toLowerCase()]
                      : [];
                  for (const tExe of targetBases) {
                    if (!tExe.endsWith('.exe')) continue;
                    upsertWineUserRegKey(
                      targetWinePrefix,
                      `Software\\Wine\\AppDefaults\\${tExe}\\DllOverrides`,
                      dllEntries,
                      {
                        ...options,
                        regFilePath: userRegPath,
                        skipLiveWineRegSync: skipLiveSync,
                      }
                    );
                  }
                } catch {}
              }
            }

            const isCrossOverWineWrapper =
              chosenCompatLayer.type === 'crossover' ||
              chosenCompatLayer.type === 'crossover_preview' ||
              chosenCompatLayer.type === 'crossover_preview_arm64' ||
              /CrossOver[^/\\]*\.app\/Contents\/SharedSupport\/CrossOver\/bin\/wine$/i.test(
                String(chosenCompatLayer.binaryPath || '')
              );
            const realCrossOverPerlWrapper = isCrossOverWineWrapper
              ? doesCrossOverBinarySupportWaitChildren(chosenCompatLayer.binaryPath)
              : false;
            const shouldPassWaitChildren =
              isCrossOverWineWrapper &&
              options.enableCrossOverWaitChildren !== false &&
              (options.enableCrossOverWaitChildren === true ||
                realCrossOverPerlWrapper ||
                Boolean(
                  effectiveCaps?.hasChildGameExecutable &&
                    (typeof options.gameSpawnFn === 'function' ||
                      typeof options.spawnFn === 'function')
                ));
            const waitChildrenArgs = shouldPassWaitChildren ? ['--wait-children'] : [];

            const trimmedDllOverrides =
              typeof env.WINEDLLOVERRIDES === 'string' ? env.WINEDLLOVERRIDES.trim() : '';
            const dllOverrideArgs =
              isCrossOverWineWrapper &&
              trimmedDllOverrides &&
              (payload.platformId === 'xbox' ||
                appLocalProxyInfo.hasOverrides ||
                Boolean(launchConfig.environmentVariables?.WINEDLLOVERRIDES) ||
                options.forceCrossOverDllFlag === true ||
                realCrossOverPerlWrapper)
                ? ['--dll', trimmedDllOverrides]
                : [];
            const effectiveWinePrefix =
              targetWinePrefix ||
              (resolvedExePath ? extractBottleRootFromPath(resolvedExePath) : '') ||
              '';
            const winTargetExePath = resolvedExePath
              ? toWineWindowsPath(resolvedExePath, effectiveWinePrefix)
              : '';
            const normalizedWineArgs = args.map((a) =>
              normalizeWineArgumentBackslashes(a, effectiveWinePrefix)
            );
            if (
              wantDisplayLauncherWrap &&
              !isBottledWindowsGogStorefrontUri &&
              bottleDisplayStagedInfo &&
              resolvedExePath
            ) {
              const chosenDisplayLauncherPosix = effectiveCaps?.is32Bit
                ? bottleDisplayStagedInfo.launcherX86Posix
                : bottleDisplayStagedInfo.launcherX64Posix;
              spawnArgs = [
                ...waitChildrenArgs,
                ...dllOverrideArgs,
                chosenDisplayLauncherPosix,
                '--dll-x86',
                bottleDisplayStagedInfo.winDllX86,
                '--dll-x64',
                bottleDisplayStagedInfo.winDllX64,
                '--',
                winTargetExePath || resolvedExePath,
                ...normalizedWineArgs,
              ];
              bottleDisplayScalerWrapped = true;
            } else {
              spawnArgs = [
                ...waitChildrenArgs,
                ...dllOverrideArgs,
                resolvedExePath,
                ...args,
              ];
              if (
                isBottledWindowsGogStorefrontUri &&
                wantDisplayLauncherWrap &&
                localInstallDir &&
                targetWinePrefix
              ) {
                bottleSteamDisplayDllArgs = dllOverrideArgs;
                bottleShouldWatchSteamGameDir = true;
              }
            }
            actualLaunchMethod = `compatibility_layer:${chosenCompatLayer.type}`;
          }
        } else if (platform === 'darwin' && resolvedExePath) {
          // Bug B Fix: apply unified Performance HUD env on native macOS launches AND forward
          // `--env MTL_HUD_ENABLED=1` (plus validated user env vars) before `-a` for `/usr/bin/open`.
          applyUnifiedPerformanceHudEnv({
            env,
            launchConfig,
            perfSettings: effectivePerfPolicy,
            chosenLayer: null,
            backend: '',
            platform,
            useCompatLayer: false,
            options,
            gameId,
          });
          const buildMacOpenEnvArgs = () => {
            /** @type {string[]} */
            const openEnvArgs = [];
            /** @type {Set<string>} */
            const seenKeys = new Set();
            if (env.MTL_HUD_ENABLED === '1') {
              openEnvArgs.push('--env', 'MTL_HUD_ENABLED=1');
              seenKeys.add('MTL_HUD_ENABLED');
            }
            const rawUserEnv =
              launchConfig.environmentVariables &&
              typeof launchConfig.environmentVariables === 'object'
                ? launchConfig.environmentVariables
                : null;
            if (rawUserEnv) {
              for (const rawKey of Object.keys(rawUserEnv)) {
                const cleanKey = String(rawKey || '').trim();
                if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(cleanKey)) continue;
                if (seenKeys.has(cleanKey)) continue;
                if (env[cleanKey] === undefined) continue;
                const valStr = String(env[cleanKey]);
                if (valStr.includes('\0')) continue;
                openEnvArgs.push('--env', `${cleanKey}=${valStr}`);
                seenKeys.add(cleanKey);
              }
            }
            return openEnvArgs;
          };
          const appBundleMatch = String(resolvedExePath).match(/^(.*?\.app)(?:[\\/]|$)/i);
          const enclosingAppBundle = appBundleMatch && appBundleMatch[1] ? appBundleMatch[1] : null;
          if (
            enclosingAppBundle &&
            (options.forceMacOpenLaunch === true ||
              (!isTestEnvironment(options) &&
                typeof options.spawnFn !== 'function' &&
                options.preferDirectMacBinary !== true))
          ) {
            spawnCmd = '/usr/bin/open';
            spawnArgs = [
              ...buildMacOpenEnvArgs(),
              '-W',
              '-a',
              enclosingAppBundle,
              ...(args.length > 0 ? ['--args', ...args] : []),
            ];
          } else if (resolvedExePath.endsWith('.app')) {
            const innerBin = resolveMacAppBundleBinary(resolvedExePath);
            if (
              options.forceMacOpenLaunch !== true &&
              innerBin &&
              innerBin !== resolvedExePath &&
              fs.existsSync(innerBin)
            ) {
              spawnCmd = innerBin;
              spawnArgs = [...args];
            } else {
              spawnCmd = '/usr/bin/open';
              spawnArgs = [
                ...buildMacOpenEnvArgs(),
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
          applyUnifiedPerformanceHudEnv({
            env,
            launchConfig,
            perfSettings: effectivePerfPolicy,
            chosenLayer: null,
            backend: '',
            platform,
            useCompatLayer: false,
            options,
            gameId,
          });
          spawnCmd = winClientlessLauncherExe;
          spawnArgs = ['--dll', winClientlessPrimaryXgrDll, '--', resolvedExePath, ...args];
          actualLaunchMethod = 'xbox_win_clientless_injector';
        } else {
          applyUnifiedPerformanceHudEnv({
            env,
            launchConfig,
            perfSettings: effectivePerfPolicy,
            chosenLayer: null,
            backend: '',
            platform,
            useCompatLayer: false,
            options,
            gameId,
          });
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
                const primaryQuarantineTarget =
                  targetQuarantinePath && fs.existsSync(targetQuarantinePath)
                    ? targetQuarantinePath
                    : localInstallDir && fs.existsSync(localInstallDir)
                      ? localInstallDir
                      : null;
                if (primaryQuarantineTarget) {
                  await clearMacQuarantineAsync(primaryQuarantineTarget, options);
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
              const primaryQuarantineTarget =
                targetQuarantinePath && fs.existsSync(targetQuarantinePath)
                  ? targetQuarantinePath
                  : localInstallDir && fs.existsSync(localInstallDir)
                    ? localInstallDir
                    : null;
              if (primaryQuarantineTarget) {
                await clearMacQuarantineAsync(primaryQuarantineTarget, options);
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
            !launchConfig.customExecutablePath &&
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

              const stage1Env = { ...env };
              stripDisplayScalerEnvFromClientEnv(stage1Env);
              const isArm64Stage1 =
                chosenCompatLayer.type === 'crossover_preview_arm64' ||
                compatResult?.wineArch === 'arm64';
              if (
                !isArm64Stage1 &&
                effectivePerfPolicy.storefrontClientLifecycle === 'default_client' &&
                (launchConfig?.crossoverGraphicsBackend === undefined ||
                  launchConfig?.crossoverGraphicsBackend === 'auto') &&
                !launchConfig?.environmentVariables?.CX_GRAPHICS_BACKEND &&
                !effectiveCaps?.is32Bit
              ) {
                delete stage1Env.CX_GRAPHICS_BACKEND;
                delete stage1Env.WINED3DMETAL;
                if (typeof stage1Env.CX_ENV === 'string' && stage1Env.CX_ENV) {
                  const cleanedStage1Cx = stripKeysFromCxEnv(stage1Env.CX_ENV, [
                    'CX_GRAPHICS_BACKEND',
                    'WINED3DMETAL',
                  ]);
                  if (cleanedStage1Cx) {
                    stage1Env.CX_ENV = cleanedStage1Cx;
                  } else {
                    delete stage1Env.CX_ENV;
                  }
                }
                const stage1PrefixKey = normalizeBottlePrefixContractKey(targetWinePrefix);
                if (stage1PrefixKey) {
                  setBoundedMapEntry(
                    liveBottleDaemonEnvContractByPrefix,
                    stage1PrefixKey,
                    computeBottleGraphicsEnvContract(stage1Env, launchConfig?.environmentVariables),
                    128
                  );
                }
              }
              const alignedStage1 = prepareAlignedAuxBottleWineCommand({
                wineBinary: chosenCompatLayer.binaryPath,
                bottlePath: targetWinePrefix,
                env: stage1Env,
                suppressGuiDialogs: false,
                layerType: chosenCompatLayer.type,
              });
              stripDisplayScalerEnvFromClientEnv(alignedStage1.env);
              const stage1Dll =
                typeof alignedStage1.env.WINEDLLOVERRIDES === 'string'
                  ? alignedStage1.env.WINEDLLOVERRIDES.trim()
                  : '';
              const stage1DllArgs =
                stage1Dll && doesCrossOverBinarySupportWaitChildren(chosenCompatLayer.binaryPath)
                  ? ['--dll', stage1Dll]
                  : [];
              const stage1BottleSteam = gameSpawnImpl(
                alignedStage1.binaryPath,
                [
                  ...stage1DllArgs,
                  bottleSteamExe,
                  ...(effectivePerfPolicy.storefrontClientLifecycle === 'default_client'
                    ? []
                    : ['-silent']),
                ],
                {
                  cwd: fs.existsSync(bottleSteamRoot) ? bottleSteamRoot : effectiveCwd,
                  env: alignedStage1.env,
                  stdio: 'ignore',
                  detached: true,
                }
              );
              if (stage1BottleSteam && typeof stage1BottleSteam.unref === 'function') {
                stage1BottleSteam.unref();
              }

              const coldStartRes = await waitForSteamColdStartupCloudReady(
                bottleSteamRoot,
                effectiveSteamAppId,
                {
                  ...options,
                  signal: launchSignal,
                  preBootLogOffset,
                  steamRootStrict: true,
                  isBottleSteam: true,
                  onStatusUpdate: (/** @type {string} */ statusMessage) => {
                    emitSessionUpdated(
                      {
                        gameId,
                        platformId: payload.platformId || 'steam',
                        status: 'starting',
                        event: 'starting',
                        statusMessage,
                      },
                      options
                    );
                  },
                  ...(typeof options.isSteamAliveFn === 'function'
                    ? { isSteamAliveFn: options.isSteamAliveFn }
                    : !isTestEnvironment(options) && targetWinePrefix
                      ? {
                          isSteamAliveFn: () =>
                            isBottleWinExeRunning('steam.exe', targetWinePrefix, {
                              ...options,
                              platform,
                            }),
                        }
                      : {}),
                }
              );
              if (coldStartRes?.reason === 'aborted' || isLaunchAborted()) {
                return abortedLaunchResult();
              }
              if (coldStartRes?.reason === 'steam_exited_early') {
                diagLog.warn(
                  'launcher.steamColdStartExitedEarly',
                  'Bottle Steam exited before startup cloud sync completed',
                  {
                    gameId,
                    appId: effectiveSteamAppId,
                    bottlePath: targetWinePrefix || undefined,
                    waitedMs: coldStartRes.waitedMs,
                  }
                );
              }
            } catch (coldStartErr) {
              diagLog.warn('launchGame.bottleSteamColdStartSync', coldStartErr, {
                gameId,
                appId: effectiveSteamAppId,
              });
            }
          } else if (
            shouldLaunchViaBottleSteam &&
            bottleSteamExe &&
            chosenCompatLayer &&
            chosenCompatLayer.binaryPath &&
            wasBottleSteamRunning &&
            shouldPingWarmBottleSteamOpenMain &&
            targetWinePrefix
          ) {
            try {
              const execFileForOpenMain =
                typeof options.execFileImpl === 'function'
                  ? options.execFileImpl
                  : typeof options.execFileFn === 'function'
                    ? options.execFileFn
                    : execFile;
              const openMainEnv = {
                ...env,
                WINEPREFIX: targetWinePrefix,
              };
              stripDisplayScalerEnvFromClientEnv(openMainEnv);
              const alignedStage2 = prepareAlignedAuxBottleWineCommand({
                wineBinary: chosenCompatLayer.binaryPath,
                bottlePath: targetWinePrefix,
                env: openMainEnv,
                suppressGuiDialogs: false,
                layerType: chosenCompatLayer.type,
              });
              stripDisplayScalerEnvFromClientEnv(alignedStage2.env);
              await new Promise((resolve) => {
                try {
                  execFileForOpenMain(
                    alignedStage2.binaryPath,
                    [bottleSteamExe, 'steam://open/main'],
                    {
                      cwd: path.dirname(bottleSteamExe),
                      env: alignedStage2.env,
                      timeout: 3000,
                    },
                    () => resolve(undefined)
                  );
                } catch {
                  resolve(undefined);
                }
              });
              setLiveBottleSteamUiMode(targetWinePrefix, 'standard');
            } catch (openMainErr) {
              diagLog.warn('launchGame.bottleSteamWarmOpenMain', openMainErr, {
                gameId,
                appId: effectiveSteamAppId,
              });
            }
          }

          if (shouldLaunchViaBottleSteam && bottleSteamExe) {
            const bottleSteamRootForOffsets = path.dirname(bottleSteamExe);
            const bottleCloudLogForSession = path.join(
              bottleSteamRootForOffsets,
              'logs',
              'cloud_log.txt'
            );
            try {
              bottleSteamCloudLogSessionStartOffset = fs.existsSync(bottleCloudLogForSession)
                ? fs.statSync(bottleCloudLogForSession).size
                : 0;
            } catch {
              bottleSteamCloudLogSessionStartOffset = 0;
            }
            const bottleGameProcessLogPath = path.join(
              bottleSteamRootForOffsets,
              'logs',
              'gameprocess_log.txt'
            );
            try {
              if (fs.existsSync(bottleGameProcessLogPath)) {
                bottleSteamGameProcessLogStartOffset = fs.statSync(bottleGameProcessLogPath).size;
              }
            } catch {}
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
                  await recycleIdleBottleWineserverBeforeClientWake();
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
                      await new Promise((r) => {
                        const t = setTimeout(r, 400);
                        if (typeof t.unref === 'function') t.unref();
                      });
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
                  const bgGogEnv = { ...env };
                  sanitizeBottleBackgroundClientWakeEnv(bgGogEnv, launchConfig);
                  const alignedBgGog = prepareAlignedAuxBottleWineCommand({
                    wineBinary: chosenCompatLayer.binaryPath,
                    bottlePath: targetWinePrefix,
                    env: bgGogEnv,
                    suppressGuiDialogs: false,
                    layerType: chosenCompatLayer.type,
                  });
                  const bgGogDll =
                    typeof alignedBgGog.env.WINEDLLOVERRIDES === 'string'
                      ? alignedBgGog.env.WINEDLLOVERRIDES.trim()
                      : '';
                  const bgGogDllArgs =
                    bgGogDll && doesCrossOverBinarySupportWaitChildren(chosenCompatLayer.binaryPath)
                      ? ['--dll', bgGogDll]
                      : [];
                  const bottleGogArgs = [
                    ...bgGogDllArgs,
                    bottleGogExe,
                    ...(effectivePerfPolicy.storefrontClientLifecycle === 'default_client'
                      ? []
                      : ['/launchViaAutoStart', '/runWithoutUpdating']),
                  ];
                  const bgBottleGog = bottleClientSpawnImpl(
                    alignedBgGog.binaryPath,
                    bottleGogArgs,
                    {
                      cwd: fs.existsSync(bottleGogRoot) ? bottleGogRoot : effectiveCwd,
                      env: alignedBgGog.env,
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
                  if (!wokeBottleGogByLauncher) {
                    await recycleIdleBottleWineserverBeforeClientWake();
                  }
                  let preBootEpicLogOffset = 0;
                  if (targetWinePrefix) {
                    // SUP-07: Resolve bottle AppData\Local dynamically instead of hardcoding `users/crossover`
                    const bottleShellFolders = readWinePrefixShellFolders(targetWinePrefix);
                    const epicAppDataLocal =
                      bottleShellFolders.appDataLocal ||
                      path.join(targetWinePrefix, 'drive_c', 'users', 'crossover', 'AppData', 'Local');
                    const candidateEpicLog = path.join(
                      epicAppDataLocal,
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
                  const bgEpicEnv = { ...env };
                  sanitizeBottleBackgroundClientWakeEnv(bgEpicEnv, launchConfig);
                  const alignedBgEpic = prepareAlignedAuxBottleWineCommand({
                    wineBinary: chosenCompatLayer.binaryPath,
                    bottlePath: targetWinePrefix,
                    env: bgEpicEnv,
                    suppressGuiDialogs: false,
                    layerType: chosenCompatLayer.type,
                  });
                  const bgEpicDll =
                    typeof alignedBgEpic.env.WINEDLLOVERRIDES === 'string'
                      ? alignedBgEpic.env.WINEDLLOVERRIDES.trim()
                      : '';
                  const bgEpicDllArgs =
                    bgEpicDll && doesCrossOverBinarySupportWaitChildren(chosenCompatLayer.binaryPath)
                      ? ['--dll', bgEpicDll]
                      : [];
                  const bottleEpicArgs = [
                    ...bgEpicDllArgs,
                    bottleEpicExe,
                    ...(effectivePerfPolicy.storefrontClientLifecycle === 'default_client'
                      ? []
                      : ['-silent']),
                  ];
                  const bgBottleEpic = bottleClientSpawnImpl(
                    alignedBgEpic.binaryPath,
                    bottleEpicArgs,
                    {
                      cwd: fs.existsSync(bottleEpicRoot) ? bottleEpicRoot : effectiveCwd,
                      env: alignedBgEpic.env,
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

          if (platform === 'darwin' && localInstallDir) {
            try {
              cleanNonApfsAppleDoubleTwins(localInstallDir, options);
            } catch {}
          }

          /** @type {Record<string, any>} */
          let spawnEnv = env;
          /** @type {Record<string, any>} */
          let watcherSpawnEnv = env;
          if (platform === 'darwin' && spawnEnv) {
            if (useCompatLayer && !isTestEnvironment(options)) {
              spawnEnv = { ...env };
              spawnCmd = resolveSipSafeWineBinaryAndPreloadEnv(spawnCmd, spawnEnv, {
                layerType: chosenCompatLayer?.type,
              });
              if (isMacSipProtectedExecutableOrScript(spawnCmd)) {
                // CrossOver's #!/usr/bin/perl wrapper consumes CX_ENV
                // and injects it into non-SIP wineloader; strip outer DYLD_INSERT_LIBRARIES on SIP Perl.
                delete spawnEnv.DYLD_INSERT_LIBRARIES;
              }
              watcherSpawnEnv = { ...spawnEnv };
              if (shouldLaunchViaBottleSteam) {
                stripDisplayScalerEnvFromClientEnv(spawnEnv);
              }
            } else if (useCompatLayer) {
              spawnEnv = { ...env };
              prepareCrossOverWineSpawnEnv(spawnCmd, spawnEnv, {
                layerType: chosenCompatLayer?.type,
              });
              watcherSpawnEnv = { ...spawnEnv };
              if (shouldLaunchViaBottleSteam) {
                stripDisplayScalerEnvFromClientEnv(spawnEnv);
              }
            } else if (
              spawnEnv.DYLD_INSERT_LIBRARIES &&
              !isTestEnvironment(options) &&
              isMacSipProtectedExecutableOrScript(spawnCmd)
            ) {
              spawnEnv = { ...env };
              delete spawnEnv.DYLD_INSERT_LIBRARIES;
              watcherSpawnEnv = spawnEnv;
            }
          } else if (shouldLaunchViaBottleSteam && spawnEnv) {
            watcherSpawnEnv = { ...spawnEnv };
            spawnEnv = { ...spawnEnv };
            stripDisplayScalerEnvFromClientEnv(spawnEnv);
          }

          // L-08: Await any late `upsertWineUserRegKey` / live `reg.exe import` immediately before spawning
          if (targetWinePrefix) {
            const pendingRegBeforeSpawn = pendingWineRegSyncByPrefix.get(
              path.resolve(targetWinePrefix)
            );
            if (pendingRegBeforeSpawn) {
              try {
                await pendingRegBeforeSpawn;
              } catch {}
            }
          }

          // L-01: Final cancellation barrier right before spawning so cancelled launches never ghost-spawn
          if (isLaunchAborted()) {
            return abortedLaunchResult();
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
                cleanupPendingLaunchResources();
                xboxLoopbackServer = null;
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
            if (
              bottleShouldWatchSteamGameDir &&
              bottleDisplayStagedInfo &&
              targetWinePrefix &&
              localInstallDir
            ) {
              try {
                let effectiveWatchDir = localInstallDir;
                if (bottleSteamExe && localInstallDir) {
                  try {
                    const installBasename = path.basename(localInstallDir);
                    if (installBasename && installBasename !== '.' && installBasename !== '..') {
                      const steamRootDir = path.dirname(bottleSteamExe);
                      const candidateLocalCommon =
                        resolveDriveCPathCaseInsensitive(steamRootDir, [
                          'steamapps',
                          'common',
                          installBasename,
                        ]) || path.join(steamRootDir, 'steamapps', 'common', installBasename);
                      if (
                        fs.existsSync(candidateLocalCommon) &&
                        fs.realpathSync(candidateLocalCommon) === fs.realpathSync(localInstallDir)
                      ) {
                        effectiveWatchDir = candidateLocalCommon;
                      }
                    }
                  } catch {}
                }
                const winWatchDir = toWineWindowsPath(effectiveWatchDir, targetWinePrefix);
                const rawWatchBottleArch = String(
                  compatResult?.wineArch ||
                    (targetWinePrefix ? inspectBottleConfMetadata(targetWinePrefix).wineArch : '') ||
                    (chosenCompatLayer?.type === 'crossover_preview_arm64' ? 'arm64' : '')
                )
                  .trim()
                  .toLowerCase();
                const is64BitWatchBottle =
                  rawWatchBottleArch === 'win64' ||
                  rawWatchBottleArch === 'arm64' ||
                  (rawWatchBottleArch !== 'win32' &&
                    (chosenCompatLayer?.type === 'crossover' ||
                      chosenCompatLayer?.type === 'crossover_preview' ||
                      chosenCompatLayer?.type === 'crossover_preview_arm64' ||
                      Boolean(effectiveCaps?.is64Bit)));
                const bottleWatchLauncherPosix = is64BitWatchBottle
                  ? bottleDisplayStagedInfo.launcherX64Posix ||
                    bottleDisplayStagedInfo.launcherX86Posix
                  : (effectiveCaps?.is64Bit
                      ? bottleDisplayStagedInfo.launcherX64Posix
                      : bottleDisplayStagedInfo.launcherX86Posix) ||
                    bottleDisplayStagedInfo.launcherX64Posix ||
                    bottleDisplayStagedInfo.launcherX86Posix;
                if (winWatchDir && bottleWatchLauncherPosix) {
                  bottleDisplayWatcherChild = gameSpawnImpl(
                    spawnCmd,
                    [
                      ...bottleSteamDisplayDllArgs,
                      bottleWatchLauncherPosix,
                      '--watch-dir',
                      winWatchDir,
                      '--dll-x86',
                      bottleDisplayStagedInfo.winDllX86,
                      '--dll-x64',
                      bottleDisplayStagedInfo.winDllX64,
                      '--timeout-ms',
                      '120000',
                    ],
                    {
                      cwd: effectiveCwd,
                      env: watcherSpawnEnv,
                      stdio: 'ignore',
                      detached: true,
                    }
                  );
                  if (
                    bottleDisplayWatcherChild &&
                    typeof bottleDisplayWatcherChild.unref === 'function'
                  ) {
                    bottleDisplayWatcherChild.unref();
                  }
                  pendingLaunchResources.displayWatcherChild = bottleDisplayWatcherChild;
                  bottleDisplayScalerWrapped = true;
                }
              } catch (watchSpawnErr) {
                diagLog.warn('launchGame.bottleSteamDisplayWatcher', watchSpawnErr, { gameId });
              }
            }

            const isBottledMacSession = Boolean(useCompatLayer && platform === 'darwin');
            const paradoxExpectedExe =
              effectiveCaps?.paradoxDirectGameExe ||
              (resolvedExePath && /^dowser\.exe$/i.test(path.basename(resolvedExePath))
                ? resolveParadoxLauncherSettings(
                    resolvedExePath,
                    localInstallDir || path.dirname(resolvedExePath)
                  ).paradoxDirectGameExe || null
                : null);
            const mergedTargetBasenames = Array.from(
              new Set([
                ...(effectiveCaps?.targetExeBasenamesLower || []),
                ...(gogUriOriginalGameExeBasename ? [gogUriOriginalGameExeBasename] : []),
                ...(paradoxExpectedExe
                  ? [path.basename(paradoxExpectedExe).trim().toLowerCase()]
                  : []),
              ])
            ).filter(Boolean);

            const resolvedWineBinary =
              useCompatLayer && chosenCompatLayer ? chosenCompatLayer.binaryPath || null : null;
            const resolvedWineserverBinary = resolvedWineBinary
              ? resolveWineserverBinary(resolvedWineBinary)
              : null;
            const resolvedWinePrefix = useCompatLayer
              ? compatResult?.winePrefix || env.WINEPREFIX || null
              : null;

            const session = {
              sessionId: preGeneratedSessionId,
              gameId,
              title: String(payload.title || gameId),
              platformId: payload.platformId || 'custom',
              platformGameId: String(payload.platformGameId || gameId),
              pid: shouldLaunchViaBottleSteam ? undefined : child.pid,
              startedAt: new Date().toISOString(),
              launchMethod: actualLaunchMethod,
              executablePath: resolvedExePath,
              status: 'running',
              isBottledSession: isBottledMacSession,
              ...(isBottledMacSession
                ? {
                    ...(resolvedWinePrefix ? { winePrefix: resolvedWinePrefix } : {}),
                    fullscreenActive: initialBottleFullscreen,
                    displayScalingMode: effectiveDisplayScalingMode,
                    displayAspectRatio: effectiveDisplayAspectRatio,
                    targetExeBasenamesLower: mergedTargetBasenames,
                  }
                : {}),
            };

            // CP-04 / P1-4: Snapshot GOG CommunicationService.log & GalaxyClient.log byte offsets
            // plus EpicGamesLauncher.log byte offset right before session starts so post-exit barriers
            // ignore stale prior-session entries and never miss lines written during exit detection.
            /** @type {number | undefined} */
            let gogCommLogPreExitOffset;
            /** @type {number | undefined} */
            let gogClientLogPreExitOffset;
            if (
              wokeBottleGogByLauncher ||
              isBottledWindowsGogStorefrontUri ||
              (gogWakeResult && gogWakeResult.started)
            ) {
              const isBottleGogScope = Boolean(
                wokeBottleGogByLauncher || isBottledWindowsGogStorefrontUri
              );
              const gogLogParams = {
                platform: isBottleGogScope ? 'win32' : platform,
                bottlePath: isBottleGogScope ? resolvedWinePrefix || undefined : undefined,
                homedir: options.homedir,
                options,
              };
              try {
                const gogLogPath = resolveGogCommunicationLogPath(gogLogParams);
                if (gogLogPath) {
                  gogCommLogPreExitOffset = fs.existsSync(gogLogPath)
                    ? fs.statSync(gogLogPath).size
                    : 0;
                }
              } catch {}
              try {
                const gogClientLogPath = resolveGogClientLogPath(gogLogParams);
                if (gogClientLogPath) {
                  gogClientLogPreExitOffset = fs.existsSync(gogClientLogPath)
                    ? fs.statSync(gogClientLogPath).size
                    : 0;
                }
              } catch {}
            }
            /** @type {number | undefined} */
            let epicLogPreExitOffset;
            if (
              wokeBottleEpicByLauncher ||
              (payload.platformId === 'epic' && Boolean(resolvedWinePrefix))
            ) {
              epicLogPreExitOffset = snapshotEpicLogPreExitOffset({
                platform: 'win32',
                bottlePath: resolvedWinePrefix,
                homedir: options.homedir,
                options,
              });
            }

            // Transfer resource ownership cleanly to `entry` so `finally` never disposes active handles
            pendingLaunchResources.xboxLoopbackServer = null;
            pendingLaunchResources.displayWatcherChild = null;
            pendingLaunchResources.displayControlFilePosix = '';
            pendingLaunchResources.displayStatusFilePosix = '';

            /** @type {any} */
            const entry = {
              session,
              platformId: session.platformId,
              child,
              pid: shouldLaunchViaBottleSteam ? 0 : child.pid || 0,
              elevatedTargetPid: 0,
              reLatchedBottleChildPid: 0,
              is64Bit: Boolean(effectiveCaps?.is64Bit),
              targetExeBasenamesLower: mergedTargetBasenames,
              ...(gogUriOriginalGameExeBasename ? { gogUriOriginalGameExeBasename } : {}),
              ...(isBottledWindowsGogStorefrontUri ? { isStorefrontUriLaunch: true } : {}),
              ...(paradoxExpectedExe ? { expectedGameExe: paradoxExpectedExe } : {}),
              pollTimer: null,
              startedMs: Date.now(),
              postExitCommand: launchConfig.postExitCommand,
              finalized: false,
              stopping: false,
              stderrBuffer: '',
              stderrCarryover: '',
              displayModeChangedErrorCount: 0,
              exitCode: null,
              stoppedByUser: false,
              wineBinary: resolvedWineBinary,
              wineserverBinary: resolvedWineserverBinary,
              winePrefix: resolvedWinePrefix,
              launchEnv: env,
              displayControlSeq: 1,
              displayControlFilePosix: bottleDisplayControlFilePosix || null,
              displayStatusFilePosix: bottleDisplayStatusFilePosix || null,
              displayScalerWrapped: bottleDisplayScalerWrapped,
              displayWatcherChild: bottleDisplayWatcherChild,
              chosenCompatLayerType: chosenCompatLayer?.type || null,
              installPath: localInstallDir || payload.installPath || '',
              platformGameId: String(payload.platformGameId || payload.steamAppId || gameId),
              steamAppId: effectiveSteamAppId || undefined,
              launchOptions: options,
              launchConfig,
              effectiveStorefrontLifecycle: effectivePerfPolicy.storefrontClientLifecycle,
              isFastDirectBypass: Boolean(isFastMinimalBypass),
              ...(typeof bottleSteamCloudLogSessionStartOffset === 'number'
                ? { steamCloudLogSessionStartOffset: bottleSteamCloudLogSessionStartOffset }
                : {}),
              wokeGogGalaxyByLauncher: Boolean(gogWakeResult && gogWakeResult.started),
              gogGalaxyClientPath: gogWakeResult ? gogWakeResult.clientPath || null : null,
              ...(typeof gogCommLogPreExitOffset === 'number'
                ? { gogCommLogPreExitOffset }
                : {}),
              ...(typeof gogClientLogPreExitOffset === 'number'
                ? { gogClientLogPreExitOffset }
                : {}),
              ...(typeof epicLogPreExitOffset === 'number' ? { epicLogPreExitOffset } : {}),
              wokeSteamByLauncher: false,
              steamClientBinaryPath: null,
              launchedViaBottleSteam: shouldLaunchViaBottleSteam,
              isSteamStorefrontDepotUri: isSteamStorefrontDepotUri || undefined,
              chainedLauncherHandoff: steamChainedPublisherHandoff || undefined,
              wasBottlePublisherRunning: wasBottleSteamPublisherRunning || undefined,
              wokePublisherClientByLauncher: wokeBottleSteamPublisherByLauncher || undefined,
              bottleSteamExe: shouldLaunchViaBottleSteam ? bottleSteamExe : null,
              bottleSteamRoot:
                shouldLaunchViaBottleSteam && bottleSteamExe ? path.dirname(bottleSteamExe) : null,
              wokeBottleSteamByLauncher: shouldLaunchViaBottleSteam
                ? !wasBottleSteamRunning
                : false,
              bottleGogExe:
                shouldWakeBottleGog || isBottledWindowsGogStorefrontUri ? bottleGogExe : null,
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
              wokeXboxAppByLauncher,
              lastPreLaunchCloudSyncAt,
              displayStatusTimer: null,
              lastObservedDisplayStatusMtimeMs: 0,
            };

            if (isBottledMacSession) {
              attachBottleDisplayStatusPoller(entry, options);
            }

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
                recordBottledStderrChunk(entry, chunk);
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
                const addBottleHintIfValid = (/** @type {any} */ exeCandidate) => {
                  if (!exeCandidate) return false;
                  const baseLower = path.win32.basename(String(exeCandidate)).trim().toLowerCase();
                  if (!baseLower || !baseLower.endsWith('.exe')) return false;
                  if (BOTTLE_SYSTEM_DAEMON_EXE_SET.has(baseLower)) return false;
                  if (isExcludedExecutable(baseLower)) return false;
                  if (candidateGameExeNames.has(baseLower)) return false;
                  candidateGameExeNames.add(baseLower);
                  return true;
                };
                addBottleHintIfValid(gogUriOriginalGameExeBasename);
                addBottleHintIfValid(resolvedExePath);
                addBottleHintIfValid(payload.executablePath);
                for (const discoveredExe of collectChainedGameCandidateExeNames(
                  localInstallDir || '',
                  resolvedExePath || ''
                )) {
                  candidateGameExeNames.add(discoveredExe);
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
                const hasAnyMockPsInput =
                  hasMockProcessSource || typeof options.mockProcessListOutput === 'string';
                const exitMissThreshold =
                  options.bottleSteamExitMissThreshold !== undefined
                    ? Math.max(1, Number(options.bottleSteamExitMissThreshold))
                    : isTestEnvironment(options) && hasAnyMockPsInput
                      ? 1
                      : 3;
                const trackedWin32HardFallbackMissThreshold = Math.max(
                  exitMissThreshold * 2,
                  isTestEnvironment(options) && hasAnyMockPsInput ? 2 : 6
                );
                const pollerNormTargetPrefix = resolvedWinePrefix
                  ? path
                      .resolve(resolvedWinePrefix)
                      .replace(/\\/g, '/')
                      .replace(/\/+$/, '')
                      .toLowerCase()
                  : '';
                const pollerNormRealTargetPrefix = resolvedWinePrefix
                  ? normalizeBottlePrefixContractKey(resolvedWinePrefix)
                  : '';
                const bottleGameProcLogFile =
                  entry.bottleSteamRoot && effectiveSteamAppId
                    ? path.join(entry.bottleSteamRoot, 'logs', 'gameprocess_log.txt')
                    : '';
                const escapedBottleAppId = String(effectiveSteamAppId || '').replace(
                  /[.*+?^${}()|[\]\\]/g,
                  '\\$&'
                );
                const bottleLogAddPidRegex = escapedBottleAppId
                  ? new RegExp(
                      `AppID\\s+${escapedBottleAppId}\\s+adding\\s+PID\\s+(\\d+)\\s+as\\s+a\\s+tracked\\s+process\\s+"([^"]+)"`,
                      'i'
                    )
                  : null;
                const bottleLogRemovePidRegex = escapedBottleAppId
                  ? new RegExp(
                      `(?:AppID\\s+${escapedBottleAppId}\\s+removing\\s+PID\\s+(\\d+)|No\\s+longer\\s+tracking\\s+PID\\s+(\\d+))`,
                      'i'
                    )
                  : null;
                /** @type {Set<string>} */
                const trackedWin32Pids = new Set();
                let sawAnyTrackedWin32Pid = false;
                let seenGameRunning = false;
                let consecutiveMisses = 0;
                let lastEmittedLatchedPid = 0;

                const refreshBottleGameProcessLog = () => {
                  if (!bottleGameProcLogFile || !bottleLogAddPidRegex || !bottleLogRemovePidRegex) {
                    return;
                  }
                  let fd = null;
                  try {
                    if (!fs.existsSync(bottleGameProcLogFile)) return;
                    const gpSt = fs.statSync(bottleGameProcLogFile);
                    if (!gpSt.isFile() || gpSt.size <= 0) return;
                    const effectiveStart =
                      gpSt.size < bottleSteamGameProcessLogStartOffset
                        ? 0
                        : Math.max(bottleSteamGameProcessLogStartOffset, gpSt.size - 131072);
                    const readLen = gpSt.size - effectiveStart;
                    if (readLen <= 0) return;
                    fd = fs.openSync(bottleGameProcLogFile, 'r');
                    const buf = Buffer.alloc(readLen);
                    const bytesRead = fs.readSync(fd, buf, 0, readLen, effectiveStart);
                    const sliceText = buf.subarray(0, bytesRead).toString('utf8');
                    trackedWin32Pids.clear();
                    for (const rawLogLine of sliceText.split(/\r?\n/)) {
                      const addMatch = bottleLogAddPidRegex.exec(rawLogLine);
                      if (addMatch) {
                        // Track Win32 PID purely as an opaque state count; NEVER pass to POSIX kill()
                        const winPidToken = addMatch[1];
                        const winExePath = addMatch[2];
                        if (winPidToken) {
                          trackedWin32Pids.add(winPidToken);
                          sawAnyTrackedWin32Pid = true;
                        }
                        if (addBottleHintIfValid(winExePath)) {
                          const newBase = path.win32.basename(winExePath).trim().toLowerCase();
                          bottleExeHints.push(newBase);
                          if (
                            Array.isArray(entry.targetExeBasenamesLower) &&
                            !entry.targetExeBasenamesLower.includes(newBase)
                          ) {
                            entry.targetExeBasenamesLower.push(newBase);
                          }
                          if (
                            entry.session &&
                            Array.isArray(entry.session.targetExeBasenamesLower) &&
                            !entry.session.targetExeBasenamesLower.includes(newBase)
                          ) {
                            entry.session.targetExeBasenamesLower.push(newBase);
                          }
                        }
                        continue;
                      }
                      const remMatch = bottleLogRemovePidRegex.exec(rawLogLine);
                      if (remMatch) {
                        const remPidToken = remMatch[1] || remMatch[2];
                        if (remPidToken) trackedWin32Pids.delete(remPidToken);
                      }
                    }
                  } catch {
                  } finally {
                    if (fd !== null) {
                      try {
                        fs.closeSync(fd);
                      } catch {}
                    }
                  }
                };

                const pollTimer = createGuardedSessionPoller({
                  intervalMs: bottlePollMs,
                  startupTimeoutMs: maxLaunchWaitMs,
                  startedMs: entry.startedMs,
                  isDone: () => Boolean(entry.finalized || entry.stopping),
                  onStop: () => {
                    entry.pollTimer = null;
                  },
                  onTick: async ({ timedOutStartup }) => {
                    refreshBottleGameProcessLog();

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
                        consecutiveMisses = 0;
                        return;
                      }
                      entry.pid = 0;
                      if (entry.session) {
                        entry.session.pid = undefined;
                      }
                    }

                    const handleBottleProcessList = (/** @type {any} */ err, /** @type {any} */ stdout) => {
                      if (err || entry.finalized || entry.stopping) return;
                      const scopedOutStr = String(stdout || '')
                        .split(/\r?\n/)
                        .filter((rawLine) => {
                          const trimmed = rawLine.trim();
                          if (!trimmed) return false;
                          return lineMatchesBottlePrefix(
                            trimmed,
                            pollerNormTargetPrefix,
                            pollerNormRealTargetPrefix
                          );
                        })
                        .join('\n');
                      const matchedPid = extractMatchedPidFromProcessOutput(
                        scopedOutStr,
                        bottleExeHints,
                        'darwin'
                      );
                      const lowerOut = scopedOutStr.toLowerCase();
                      const isPresent =
                        matchedPid > 0 || bottleExeHints.some((h) => h && lowerOut.includes(h));
                      if (isPresent) {
                        seenGameRunning = true;
                        consecutiveMisses = 0;
                        if (matchedPid > 0) {
                          entry.pid = matchedPid;
                          if (entry.session) {
                            entry.session.pid = matchedPid;
                          }
                          if (matchedPid !== lastEmittedLatchedPid) {
                            lastEmittedLatchedPid = matchedPid;
                            emitSessionUpdated(
                              {
                                gameId,
                                platformId: entry.platformId,
                                session: { ...entry.session },
                                status: 'running',
                                event: 'session_updated',
                              },
                              options
                            );
                          }
                        }
                      } else if (seenGameRunning || sawAnyTrackedWin32Pid) {
                        consecutiveMisses += 1;
                        const canFinalizeForTrackedWin32 =
                          trackedWin32Pids.size === 0 ||
                          consecutiveMisses >= trackedWin32HardFallbackMissThreshold;
                        if (consecutiveMisses >= exitMissThreshold && canFinalizeForTrackedWin32) {
                          entry.exitCode = 0;
                          finalizeGameSession(gameId, options);
                        }
                      } else if (timedOutStartup) {
                        entry.exitCode = 0;
                        finalizeGameSession(gameId, options);
                      }
                    };

                    if (typeof options.bottleSteamProcessListFn === 'function') {
                      const out = await Promise.resolve(options.bottleSteamProcessListFn()).catch(
                        () => null
                      );
                      if (out !== null) handleBottleProcessList(null, out);
                    } else if (typeof options.getProcessListOutput === 'function') {
                      const out = await Promise.resolve(options.getProcessListOutput()).catch(
                        () => null
                      );
                      if (out !== null) handleBottleProcessList(null, out);
                    } else if (
                      typeof options.execFileImpl === 'function' ||
                      typeof options.execFileFn === 'function' ||
                      !options.homedir
                    ) {
                      const bottlePsArgs =
                        platform === 'darwin'
                          ? ['eww', '-ax', '-o', 'pid=,command=']
                          : ['-ax', '-o', 'pid=,command='];
                      await new Promise((resolve) => {
                        execFileImpl(
                          'ps',
                          bottlePsArgs,
                          { timeout: 2500 },
                          (/** @type {any} */ err, /** @type {any} */ stdout) => {
                            handleBottleProcessList(err, stdout);
                            resolve(undefined);
                          }
                        );
                      });
                    } else if (typeof options.mockProcessListOutput === 'string') {
                      handleBottleProcessList(null, options.mockProcessListOutput);
                    }
                  },
                });
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

              const pollTimer = createGuardedSessionPoller({
                intervalMs: xboxPollMs,
                startupTimeoutMs: maxXboxBootstrapWaitMs,
                startedMs: entry.startedMs,
                isDone: () => Boolean(entry.finalized || entry.stopping),
                onStop: () => {
                  entry.pollTimer = null;
                },
                onTick: async ({ timedOutStartup }) => {
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

                    if (seenRealXboxGamePid || timedOutStartup) {
                      clearInterval(pollTimer);
                      entry.pollTimer = null;
                      finalizeWithXboxWakeCheck();
                    }
                  };

                  if (typeof options.getProcessListOutput === 'function') {
                    const out = await Promise.resolve(options.getProcessListOutput()).catch(
                      () => null
                    );
                    if (out !== null) handleWinProcOutput(null, out);
                  } else if (typeof options.mockProcessListOutput === 'string') {
                    handleWinProcOutput(null, options.mockProcessListOutput);
                  } else if (!options.homedir || options.execFileImpl || options.execFileFn) {
                    await new Promise((resolve) => {
                      execFileImpl(
                        'tasklist.exe',
                        ['/FO', 'CSV', '/NH'],
                        { timeout: 2500, windowsHide: true },
                        (/** @type {any} */ err, /** @type {any} */ stdout) => {
                          handleWinProcOutput(err, stdout);
                          resolve(undefined);
                        }
                      );
                    });
                  }
                },
              });
              entry.pollTimer = pollTimer;
            } else if (typeof child.on === 'function') {
              const triggerStandardExitFinalization = () => {
                if (entry.stopping) return;
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
              };

              child.on('exit', (/** @type {any} */ code, /** @type {any} */ signal) => {
                const computedExitCode =
                  typeof code === 'number'
                    ? code
                    : signal && !entry.stoppedByUser && !entry.stopping
                      ? -1
                      : 0;

                const applyExitCodeToEntry = () => {
                  if (entry.exitCode === null || entry.exitCode === undefined) {
                    entry.exitCode = computedExitCode;
                    if (signal && !entry.stoppedByUser && !entry.stopping) {
                      entry.exitSignal = signal;
                      if (!entry.stderrBuffer.trim()) {
                        entry.stderrBuffer = `Process terminated by signal ${signal}`;
                      }
                    }
                  }
                };

                if (entry.stopping || entry.stoppedByUser) {
                  applyExitCodeToEntry();
                  if (!entry.stopping) {
                    triggerStandardExitFinalization();
                  }
                  return;
                }

                const canCheckBottleChildProcesses =
                  useCompatLayer &&
                  (!isTestEnvironment(options) ||
                    typeof options.findLiveBottleGameChildPidFn === 'function' ||
                    typeof options.mockProcessListOutput === 'string' ||
                    typeof options.execFileImpl === 'function' ||
                    typeof options.execFileFn === 'function' ||
                    options.allowProcessCheckInTest === true);

                if (!canCheckBottleChildProcesses) {
                  applyExitCodeToEntry();
                  triggerStandardExitFinalization();
                  return;
                }

                void (async () => {
                  const childQueryParams = {
                    localInstallDir: entry.installPath,
                    resolvedExePath,
                    bottleDir: entry.winePrefix,
                    targetExeBasenamesLower: entry.targetExeBasenamesLower,
                    excludePid: child.pid || 0,
                  };
                  let liveChildPid = await findLiveBottleGameChildPid(childQueryParams, options);
                  if (
                    !liveChildPid &&
                    !entry.stopping &&
                    !entry.stoppedByUser &&
                    Date.now() - entry.startedMs < 15000 &&
                    (typeof options.mockProcessListOutput !== 'string' ||
                      options.bottleChildRetryDelayMs !== undefined) &&
                    (!options.homedir ||
                      typeof options.findLiveBottleGameChildPidFn === 'function' ||
                      options.bottleChildRetryDelayMs !== undefined ||
                      options.allowProcessCheckInTest === true)
                  ) {
                    const retryWaitMs =
                      options.bottleChildRetryDelayMs !== undefined
                        ? Math.max(0, Number(options.bottleChildRetryDelayMs))
                        : 350;
                    if (retryWaitMs > 0) {
                      await new Promise((r) => {
                        const t = setTimeout(r, retryWaitMs);
                        if (typeof t.unref === 'function') t.unref();
                      });
                    }
                    if (!entry.stopping && !entry.stoppedByUser) {
                      liveChildPid = await findLiveBottleGameChildPid(childQueryParams, options);
                    }
                  }

                  if (liveChildPid > 0 && !entry.stopping && !entry.stoppedByUser) {
                    diagLog.info('launchGame.reLatchedBottleChildProcess', {
                      gameId,
                      parentPid: child.pid || 0,
                      childPid: liveChildPid,
                    });
                    entry.exitCode = null;
                    entry.pid = liveChildPid;
                    entry.reLatchedBottleChildPid = liveChildPid;
                    if (entry.session) {
                      entry.session.pid = liveChildPid;
                    }
                    emitSessionUpdated(
                      {
                        gameId,
                        platformId: entry.platformId,
                        session: { ...entry.session },
                        status: 'running',
                        event: 'running',
                      },
                      options
                    );

                    const checkAliveFn =
                      typeof options.isProcessAliveFn === 'function'
                        ? options.isProcessAliveFn
                        : isProcessAlive;
                    const reLatchPollMs =
                      Number(options.bottleChildPollIntervalMs) > 0
                        ? Number(options.bottleChildPollIntervalMs)
                        : 1000;
                    let pollBusy = false;
                    const reLatchTimer = setInterval(() => {
                      if (pollBusy) return;
                      if (entry.stopping || entry.stoppedByUser || entry.finalized) {
                        clearInterval(reLatchTimer);
                        return;
                      }
                      if (entry.pid > 0 && checkAliveFn(entry.pid)) {
                        return;
                      }
                      pollBusy = true;
                      void findLiveBottleGameChildPid(
                        {
                          ...childQueryParams,
                          excludePid: entry.pid || child.pid || 0,
                        },
                        options
                      )
                        .then((nextPid) => {
                          if (entry.stopping || entry.stoppedByUser || entry.finalized) {
                            clearInterval(reLatchTimer);
                            return;
                          }
                          if (nextPid > 0 && nextPid !== entry.pid) {
                            entry.pid = nextPid;
                            entry.reLatchedBottleChildPid = nextPid;
                            if (entry.session) entry.session.pid = nextPid;
                            return;
                          }
                          clearInterval(reLatchTimer);
                          entry.pollTimer = null;
                          entry.exitCode = 0;
                          finalizeGameSession(gameId, options);
                        })
                        .finally(() => {
                          pollBusy = false;
                        });
                    }, reLatchPollMs);
                    if (typeof reLatchTimer.unref === 'function') reLatchTimer.unref();
                    entry.pollTimer = reLatchTimer;
                    return;
                  }

                  applyExitCodeToEntry();
                  triggerStandardExitFinalization();
                })();
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
                  if (child && typeof child.removeListener === 'function') {
                    child.removeListener('exit', finish);
                    child.removeListener('error', finish);
                  }
                  r(undefined);
                };
                const t = setTimeout(finish, startupWaitMs);
                if (typeof t.unref === 'function') t.unref();
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
                if (!entry.finalized && !entry.stopping) {
                  finalizeGameSession(gameId, options);
                }
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
          cleanupPendingLaunchResources();
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

    let wasHostSteamPublisherRunning = false;
    let wokeHostSteamPublisherByLauncher = false;
    if (platform === 'win32' && isSteamStorefrontDepotUri && steamChainedPublisherHandoff) {
      wasHostSteamPublisherRunning = await checkHostWinPublisherUiRunningAsync(
        steamChainedPublisherHandoff,
        options
      );
      if (steamChainedPublisherHandoff !== 'riot' && options.skipPublisherProvisioning !== true) {
        const hostPubLauncher = discoverHostPublisherLauncher(steamChainedPublisherHandoff, {
          ...options,
          platform: 'win32',
        });
        if (
          !hostPubLauncher?.installed ||
          typeof options.ensureChainedPublisherLauncherInstalledFn === 'function'
        ) {
          const pubEco = /** @type {Record<string, any>} */ (CHAINED_PUBLISHER_ECOSYSTEMS)[
            steamChainedPublisherHandoff
          ];
          emitSessionUpdated(
            {
              gameId,
              platformId: payload.platformId || 'steam',
              status: 'starting',
              event: 'starting',
              statusMessage: `Preparing ${pubEco?.displayName || steamChainedPublisherHandoff}...`,
            },
            options
          );
          const ensureProvisionFn =
            typeof options.ensureChainedPublisherLauncherInstalledFn === 'function'
              ? options.ensureChainedPublisherLauncherInstalledFn
              : getEnsureChainedPublisherLauncherInstalled();
          try {
            await ensureProvisionFn(
              {
                handoffId: steamChainedPublisherHandoff,
                platform: 'win32',
              },
              options
            );
          } catch (hostPubProvErr) {
            diagLog.warn('launchGame.win32SteamPublisherProvision', hostPubProvErr, {
              gameId,
              handoffId: steamChainedPublisherHandoff,
            });
          }
        }
      }
      wokeHostSteamPublisherByLauncher = !wasHostSteamPublisherRunning;
    }

    let uriHostSteamRoot = '';
    let steamGameProcessLogOffset = 0;
    /** @type {number | undefined} */
    let uriSteamCloudLogSessionStartOffset;
    const snapshotUriSteamCloudLogOffset = () => {
      if (payload.platformId !== 'steam' || !uriHostSteamRoot) return;
      const hostCloudLogForSession = path.join(uriHostSteamRoot, 'logs', 'cloud_log.txt');
      try {
        uriSteamCloudLogSessionStartOffset = fs.existsSync(hostCloudLogForSession)
          ? fs.statSync(hostCloudLogForSession).size
          : 0;
      } catch {
        uriSteamCloudLogSessionStartOffset = 0;
      }
    };
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
        const hasCustomOpenExternal =
          typeof options.openExternalFn === 'function' ||
          typeof options.onOpenExternal === 'function';
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
            platform === 'darwin' &&
            (typeof options.spawnFn !== 'function' || options.forceMacOpenSteamInTest === true)
              ? String(steamLaunchSpec.binaryPath).match(/^(.*?\.app)(?:\/|$)/i)
              : null;
          if (macSteamAppMatch && macSteamAppMatch[1] && steamLaunchSpec.useMinimalBinarySpawn) {
            const stage1Child = spawnImpl(
              '/usr/bin/open',
              ['-g', '-j', '-a', macSteamAppMatch[1], '--args', '-silent'],
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

          const coldStartRes = await waitForSteamColdStartupCloudReady(
            hostSteamRoot,
            steamAppIdVal,
            {
              ...options,
              signal: launchSignal,
              preBootLogOffset,
              onStatusUpdate: (/** @type {string} */ statusMessage) => {
                emitSessionUpdated(
                  {
                    gameId,
                    platformId: payload.platformId || 'steam',
                    status: 'starting',
                    event: 'starting',
                    statusMessage,
                  },
                  options
                );
              },
            }
          );
          if (coldStartRes?.reason === 'aborted' || isLaunchAborted()) {
            return abortedLaunchResult();
          }
          if (coldStartRes?.reason === 'steam_exited_early') {
            diagLog.warn(
              'launcher.steamColdStartExitedEarly',
              'Host Steam exited before startup cloud sync completed',
              {
                gameId,
                appId: steamAppIdVal,
                steamRoot: hostSteamRoot || undefined,
                waitedMs: coldStartRes.waitedMs,
              }
            );
          }

          snapshotUriSteamCloudLogOffset();

          if (steamLaunchSpec.useMinimalBinarySpawn) {
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
          } else if (
            effectivePerfPolicy.storefrontClientLifecycle === 'default_client' &&
            args.length > 0 &&
            steamLaunchSpec.binaryPath &&
            !hasCustomOpenExternal
          ) {
            const stage2Child = spawnImpl(
              steamLaunchSpec.binaryPath,
              ['-applaunch', steamAppIdVal, ...args],
              {
                detached: true,
                stdio: 'ignore',
                windowsHide: true,
              }
            );
            if (stage2Child && typeof stage2Child.unref === 'function') {
              stage2Child.unref();
            }
            steamMinimalSpawnedResult = steamLaunchSpec;
          }
        } else if (
          steamLaunchSpec &&
          steamLaunchSpec.useMinimalBinarySpawn &&
          steamLaunchSpec.binaryPath
        ) {
          snapshotUriSteamCloudLogOffset();
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
        } else if (
          steamLaunchSpec &&
          effectivePerfPolicy.storefrontClientLifecycle === 'default_client' &&
          args.length > 0 &&
          steamLaunchSpec.binaryPath &&
          !hasCustomOpenExternal
        ) {
          snapshotUriSteamCloudLogOffset();
          const spawnImpl = typeof options.spawnFn === 'function' ? options.spawnFn : spawn;
          const stage2Child = spawnImpl(
            steamLaunchSpec.binaryPath,
            ['-applaunch', steamAppIdVal, ...args],
            {
              detached: true,
              stdio: 'ignore',
              windowsHide: true,
            }
          );
          if (stage2Child && typeof stage2Child.unref === 'function') {
            stage2Child.unref();
          }
          steamMinimalSpawnedResult = steamLaunchSpec;
        }
      } catch {}
    }

    let wokeEpicByLauncher = false;
    if (payload.platformId === 'epic') {
      const checkEpicOut = (/** @type {any} */ outStr) => {
        for (const rawLine of String(outStr || '').split(/\r?\n/)) {
          const line = rawLine.trim();
          if (!line) continue;
          if (platform === 'darwin') {
            if (/\.exe\b|\/Bottles\/|WINEPREFIX=/i.test(line)) continue;
            if (
              /(?:Epic Games Launcher\.app\/Contents\/MacOS\/EpicGamesLauncher|(?:^|\/)EpicGamesLauncher(?:\s|$))/i.test(
                line
              )
            ) {
              return true;
            }
          } else if (/(?:EpicGamesLauncher|Epic Games Launcher)/i.test(line)) {
            return true;
          }
        }
        return false;
      };
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

    if (isLaunchAborted()) {
      return abortedLaunchResult();
    }
    if (!steamMinimalSpawnedResult && !gogCliSpawned) {
      if (uriSteamCloudLogSessionStartOffset === undefined) {
        snapshotUriSteamCloudLogOffset();
      }
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
      isBottledSession: false,
    };

    // CP-04 / P1-4: Snapshot GOG CommunicationService.log, GalaxyClient.log, and host
    // EpicGamesLauncher.log byte offsets for host storefront_uri launches
    /** @type {number | undefined} */
    let uriGogCommLogPreExitOffset;
    /** @type {number | undefined} */
    let uriGogClientLogPreExitOffset;
    if (payload.platformId === 'gog' || (gogWakeResult && gogWakeResult.started)) {
      const hostGogLogParams = {
        platform,
        homedir: options.homedir,
        options,
      };
      try {
        const hostGogLogPath = resolveGogCommunicationLogPath(hostGogLogParams);
        if (hostGogLogPath) {
          uriGogCommLogPreExitOffset = fs.existsSync(hostGogLogPath)
            ? fs.statSync(hostGogLogPath).size
            : 0;
        }
      } catch {}
      try {
        const hostGogClientLogPath = resolveGogClientLogPath(hostGogLogParams);
        if (hostGogClientLogPath) {
          uriGogClientLogPreExitOffset = fs.existsSync(hostGogClientLogPath)
            ? fs.statSync(hostGogClientLogPath).size
            : 0;
        }
      } catch {}
    }
    /** @type {number | undefined} */
    let uriEpicLogPreExitOffset;
    if (payload.platformId === 'epic') {
      uriEpicLogPreExitOffset = snapshotEpicLogPreExitOffset({
        platform,
        homedir: options.homedir,
        options,
      });
    }

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
      isFastDirectBypass: Boolean(isFastMinimalBypass),
      isStorefrontUriLaunch: true,
      ...(typeof uriSteamCloudLogSessionStartOffset === 'number'
        ? { steamCloudLogSessionStartOffset: uriSteamCloudLogSessionStartOffset }
        : {}),
      wokeGogGalaxyByLauncher: Boolean(gogWakeResult && gogWakeResult.started),
      gogGalaxyClientPath: gogWakeResult ? gogWakeResult.clientPath || null : null,
      ...(typeof uriGogCommLogPreExitOffset === 'number'
        ? { gogCommLogPreExitOffset: uriGogCommLogPreExitOffset }
        : {}),
      ...(typeof uriGogClientLogPreExitOffset === 'number'
        ? { gogClientLogPreExitOffset: uriGogClientLogPreExitOffset }
        : {}),
      ...(typeof uriEpicLogPreExitOffset === 'number'
        ? { epicLogPreExitOffset: uriEpicLogPreExitOffset }
        : {}),
      wokeSteamByLauncher: Boolean(
        steamMinimalSpawnedResult && steamMinimalSpawnedResult.wokeSteamByLauncher
      ),
      steamClientBinaryPath: steamMinimalSpawnedResult
        ? steamMinimalSpawnedResult.binaryPath || null
        : null,
      wokeEpicByLauncher: Boolean(wokeEpicByLauncher),
      isSteamStorefrontDepotUri: isSteamStorefrontDepotUri || undefined,
      chainedLauncherHandoff: steamChainedPublisherHandoff || undefined,
      wasHostPublisherRunning: wasHostSteamPublisherRunning || undefined,
      wokePublisherClientByLauncher: wokeHostSteamPublisherByLauncher || undefined,
    };

    const steamChainedExeCandidates = isSteamStorefrontDepotUri
      ? collectChainedGameCandidateExeNames(
          localInstallDir || (payload.installPath ? toLocalFsPath(payload.installPath) : ''),
          resolvedExePath || ''
        )
      : [];
    const maxSteamChainedBootstrapWaitMs = Number(options.chainedLauncherMaxBootstrapWaitMs ?? 90000);
    // SUP-02: Enforce a hard startup-latch deadline (120s default) for non-depot storefront URIs
    // so unlatched launches never poll forever or remain stuck in "Running".
    const effectiveUriStartupTimeoutMs = isSteamStorefrontDepotUri
      ? maxSteamChainedBootstrapWaitMs
      : Number(options.uriStartupTimeoutMs ?? 120000);

    const canMonitorSteamLog = Boolean(
      payload.platformId === 'steam' && uriHostSteamRoot && effectiveSteamAppId
    );
    if (
      (payload.installPath || localInstallDir || canMonitorSteamLog) &&
      !options.disableUriPolling
    ) {
      let seenRunningOnSystem = false;
      const pollIntervalMs = Number(options.uriPollIntervalMs || 4000);
      const execFileImpl =
        typeof options.execFileImpl === 'function'
          ? options.execFileImpl
          : typeof options.execFileFn === 'function'
            ? options.execFileFn
            : execFile;
      const pollTimer = createGuardedSessionPoller({
        intervalMs: pollIntervalMs,
        startupTimeoutMs: effectiveUriStartupTimeoutMs,
        startedMs: entry.startedMs,
        isDone: () => Boolean(entry.finalized),
        onStop: () => {
          entry.pollTimer = null;
        },
        onTick: ({ timedOutStartup }) => {
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

          if (
            canMonitorSteamLog &&
            (!isSteamStorefrontDepotUri || steamChainedExeCandidates.length === 0)
          ) {
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
          const filterUriExeHint = (/** @type {string} */ hint) => {
            if (!hint) return false;
            if (hint.endsWith('.exe')) {
              if (BOTTLE_SYSTEM_DAEMON_EXE_SET.has(hint)) return false;
              if (isExcludedExecutable(hint)) return false;
            }
            return true;
          };
          const exeHints = Array.from(
            new Set(
              [
                payload.executablePath ? path.basename(payload.executablePath).toLowerCase() : '',
                resolvedExePath ? path.basename(resolvedExePath).toLowerCase() : '',
                ...steamChainedExeCandidates,
                !isSteamStorefrontDepotUri && payload.installPath
                  ? path.basename(payload.installPath).toLowerCase()
                  : '',
              ].filter(filterUriExeHint)
            )
          );
          if (exeHints.length === 0) {
            if (seenRunningOnSystem || timedOutStartup) {
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
            } else if (seenRunningOnSystem || timedOutStartup) {
              finalizeGameSession(gameId, options);
            }
          };
          let settledSync = false;
          /** @type {(() => void) | null} */
          let resolvePoll = null;
          const finishPoll = () => {
            settledSync = true;
            if (resolvePoll) {
              const fn = resolvePoll;
              resolvePoll = null;
              fn();
            }
          };
          if (targetPlatform === 'win32') {
            execFileImpl(
              'tasklist.exe',
              ['/FO', 'CSV', '/NH'],
              { timeout: 2500, windowsHide: true },
              (/** @type {any} */ err, /** @type {any} */ stdout) => {
                handleProcessList(err, stdout);
                finishPoll();
              }
            );
          } else {
            execFileImpl(
              'ps',
              ['-ax', '-o', 'pid=,command='],
              { timeout: 2500 },
              (/** @type {any} */ err, /** @type {any} */ stdout) => {
                handleProcessList(err, stdout);
                finishPoll();
              }
            );
          }
          if (!settledSync) {
            return new Promise((resolve) => {
              if (settledSync) {
                resolve(undefined);
                return;
              }
              resolvePoll = () => resolve(undefined);
            });
          }
        },
      });
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
    cleanupPendingLaunchResources();
    releasePendingBottleLock();
    releasePendingPlatformLock();
  }
}


module.exports = {
  launchGame,
  launchGameInternal,
};
