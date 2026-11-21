// @ts-check
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn, execFile } = require('node:child_process');

const {
  toHostFilesystemPath,
  atomicWriteFileSync,
  isContainedWithinRoot,
} = require('../securityAndPathUtils.cjs');
const {
  isSafeToDeleteInstallPath,
  safeRemoveGameDirectoryAsync,
} = require('../uninstallSafety.cjs');
const {
  sanitizeGameInstallSizeBytes,
  deriveDefaultScidFromTitleId,
  inspectMicrosoftGameConfig,
} = require('../binaryAndManifestInspectors.cjs');
const {
  isProcessAlive,
  waitForProcessExit,
  signalSubprocessTree,
} = require('../processTreeUtils.cjs');
const { resolveBottleSteamExe } = require('../wineAndCrossOverManager.cjs');
const {
  diagLog,
  getStoreSync,
  getXboxStorefrontModules,
  getXboxStoreLicenseRecoveryHook,
  getConfiguredUserDataDir,
  getUserDataDir,
  resolveIsolatedHomedirAndUserData,
  emitDownloadUpdated,
  downloadQueueMap,
  downloadControllers,
  downloadSpeedTrackers,
  pausedByInGameTaskIds,
  evictExecutableDiscoveryCacheForPath,
  invalidateScanCaches,
  toLocalFsPath,
  resolveWindowsNodeShebangSpawn,
  openExternalUri,
  resolveHostLocaleInfo,
  findLegendaryBinary,
  findGogdlBinary,
  writeManagedInstallSentinel,
  upsertManagedInstallRecord,
  resolvePlatformLaunchConfig,
  getGameLaunchConfigs,
  saveGameLaunchConfig,
} = require('../engineStateRegistry.cjs');
const {
  hasWindowsGamingServicesInstalled,
  getDefaultInstallDir,
  getDiskSpace,
  getDirectorySizeFastAsync,
} = require('../diskAndVolumeInspector.cjs');
const {
  isXboxChildGameFolder,
  resolveXboxClientBinaryPath,
} = require('../windowsXboxAppxAndMsixvcOrchestrator.cjs');
const macNativeInstallerAndCodesign = /** @type {any} */ (
  require('../macNativeInstallerAndCodesign.cjs')
);
const {
  resolveMacAppBundleBinary,
  ensureMacAppCodeSignatureValidAsync,
  flattenGogNestedInstallDir,
  findPrimaryExecutable,
  discoverSteamLocations,
  isValidBottleDirectory,
  inspectBottleConfMetadata,
  detectCompatibilityLayers,
  ensureCompatibilityLayerReady,
} = macNativeInstallerAndCodesign;
const {
  syncEpicFirstPartyLauncher,
  ensureLegendaryConfigAndAuth,
  extractEpicThirdPartyPartnerMetadata,
  resolveEpicAppAndPlatforms,
} = require('../epicLegendaryAndEosCoordinator.cjs');
const {
  sanitizeDirectoryName,
  syncGogFirstPartyLauncher,
  ensureGogdlAuthConfig,
  clearStaleGogdlManifestCache,
  fetchGogV1Json,
  downloadGogV1Depot,
  downloadGogV2Depot,
} = require('../gogRegistryAndDirectInstaller.cjs');
const {
  inFlightInstallKeys,
  resolveAnyChainedHandoffId,
  normalizeRequestedCompatibilityLayerType,
  validateTrustedExternalLauncherUrl,
  validateSafeSteamAppId,
  validateSafeGogProductId,
  validateSafeCliIdentifier,
  validateSafeCliPathArg,
  resolveContainedExecutablePath,
  buildActiveDownloadDedupKey,
  findActiveDuplicateDownloadTask,
  toPublicDownloadTask,
  isTaskCancelledOrPaused,
  clearRehydratedQueueDirs,
  clearPendingBroadcastTimers,
  persistDownloadQueueToDisk,
  ensureDownloadQueueRehydrated,
  computeSmoothedDownloadSpeed,
  getDownloadQueue,
  updateDownloadTask,
} = require('./downloadQueueStore.cjs');
const {
  createLegendaryProgressParser,
  createGogdlProgressParser,
} = require('./cliProgressParser.cjs');
const {
  resolveExpectedSteamId64Async,
  hasAuthenticatedSteamSessionInVdfCandidates,
  ensureWindowsSteamInBottle,
  startSteamInstallMonitor,
} = require('./steamDownloadMonitor.cjs');
const {
  startXboxInstallMonitor,
  executeChainedPublisherInstallFlow,
} = require('./xboxAndChainedDownloaders.cjs');

/** @type {Map<string, Promise<any>>} */
const taskTransitionLocks = new Map();

/**
 * Symlink-safe stale GOG V1 temp `.bin` sweeper (skips symlinks via `lstat` and enforces containment).
 *
 * @param {string[]} [targetDirs]
 */
async function sweepStaleGogTempBinsAsync(targetDirs = []) {
  const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
  const activeBinPaths = new Set();
  for (const [, t] of downloadQueueMap.entries()) {
    if (
      t &&
      t.tempBinPath &&
      ['downloading', 'paused', 'queued', 'extracting', 'verifying'].includes(t.status)
    ) {
      activeBinPaths.add(path.resolve(t.tempBinPath));
    }
  }
  const now = Date.now();
  for (const dir of targetDirs) {
    if (!dir || typeof dir !== 'string') continue;
    /** @type {fs.Dirent[]} */
    let entries = [];
    try {
      const dirSt = await fs.promises.lstat(dir);
      if (dirSt.isSymbolicLink() || !dirSt.isDirectory()) continue;
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const ent of entries) {
      if (ent.isSymbolicLink() || !ent.isFile() || !/^\.gog_v1_.*_main\.bin$/i.test(ent.name)) {
        continue;
      }
      const fullPath = path.join(dir, ent.name);
      if (!isContainedWithinRoot(dir, fullPath)) continue;
      if (activeBinPaths.has(path.resolve(fullPath))) continue;
      try {
        const st = await fs.promises.lstat(fullPath);
        if (st.isSymbolicLink() || !st.isFile()) continue;
        if (now - st.mtimeMs > SEVEN_DAYS_MS) {
          await fs.promises.unlink(fullPath);
        }
      } catch (/** @type {any} */ err) {
        if (err && err.code !== 'ENOENT') {
          diagLog.warn('sweepStaleGogTempBinsAsync.unlink', err, { fullPath });
        }
      }
    }
  }
}

/**
 * Safely unlink a regular non-symlink file strictly contained inside `expectedRoot` (if provided).
 *
 * @param {string} filePath
 * @param {string} [expectedRoot]
 */
function unlinkRegularFileSyncSafe(filePath, expectedRoot) {
  if (!filePath || typeof filePath !== 'string') return;
  if (expectedRoot && !isContainedWithinRoot(expectedRoot, filePath)) return;
  try {
    const st = fs.lstatSync(filePath);
    if (st.isSymbolicLink() || !st.isFile()) return;
    fs.unlinkSync(filePath);
  } catch (/** @type {any} */ err) {
    if (err && err.code !== 'ENOENT') {
      diagLog.debug('unlinkRegularFileSyncSafe.error', err, { filePath });
    }
  }
}

/**
 * Safely remove a non-symlink staging artifact file or directory contained inside `parentDir`
 * without ever following symlinks or deleting anything outside `parentDir`.
 *
 * @param {string} parentDir
 * @param {string} artifactPath
 * @param {number} [depth]
 */
function removeContainedStagingArtifactSync(parentDir, artifactPath, depth = 0) {
  if (depth > 8 || !parentDir || !artifactPath) return;
  if (!isContainedWithinRoot(parentDir, artifactPath)) return;
  let st;
  try {
    st = fs.lstatSync(artifactPath);
  } catch {
    return;
  }
  if (st.isSymbolicLink()) {
    try {
      fs.unlinkSync(artifactPath);
    } catch {}
    return;
  }
  if (!st.isDirectory()) {
    try {
      fs.unlinkSync(artifactPath);
    } catch {}
    return;
  }
  /** @type {fs.Dirent[]} */
  let entries = [];
  try {
    entries = fs.readdirSync(artifactPath, { withFileTypes: true });
  } catch {
    return;
  }
  for (const ent of entries) {
    if (ent.name === '.' || ent.name === '..') continue;
    const childPath = path.join(artifactPath, ent.name);
    if (!isContainedWithinRoot(parentDir, childPath)) continue;
    if (ent.isSymbolicLink()) {
      try {
        fs.unlinkSync(childPath);
      } catch {}
    } else if (ent.isDirectory()) {
      removeContainedStagingArtifactSync(parentDir, childPath, depth + 1);
    } else {
      try {
        fs.unlinkSync(childPath);
      } catch {}
    }
  }
  try {
    fs.rmdirSync(artifactPath);
  } catch {}
}

/**
 * Route failed/empty partial install directory removal through `uninstallSafety.cjs`
 * (`safeRemoveGameDirectoryAsync`) — NEVER calling raw `fs.rmSync(finalInstallPath)`.
 *
 * @param {string} targetDir
 * @param {string} installParentDir
 * @param {Record<string, any>} [options]
 */
async function safeRemovePartialInstallDirAsync(targetDir, installParentDir, options = {}) {
  if (!targetDir || typeof targetDir !== 'string') return;
  try {
    const safetyOpts = {
      ...options,
      ...(installParentDir ? { libraryRoot: installParentDir } : {}),
    };
    if (!isSafeToDeleteInstallPath(targetDir, safetyOpts)) {
      diagLog.warn(
        'safeRemovePartialInstallDirAsync.blocked',
        new Error('Refused unsafe partial install directory deletion'),
        { targetDir }
      );
      return;
    }
    await safeRemoveGameDirectoryAsync(targetDir, safetyOpts);
  } catch (err) {
    diagLog.debug('safeRemovePartialInstallDirAsync.error', err, { targetDir });
  }
}

/**
 * Start a game download / installation task with active-download deduplication,
 * strict URI/CLI/path-containment guards, line-buffered CLI output parsers,
 * post-`await` cancel/pause checks, and guarded `spawn().on('error')` handlers.
 *
 * @param {any} [payload]
 * @param {any} [optionsOrProgress]
 * @param {any} [maybeOptions]
 */
async function installGame(payload = {}, optionsOrProgress = {}, maybeOptions = {}) {
  const options =
    typeof optionsOrProgress === 'function'
      ? { ...(maybeOptions || {}), onProgress: optionsOrProgress }
      : optionsOrProgress || {};
  let acquiredDedupKey = '';
  try {
    const storeSync = getStoreSync();
    const platform = options.platform || process.platform;
    const { homedir } = resolveIsolatedHomedirAndUserData(options);
    const platformId = payload.platformId || 'custom';
    const platformGameId = String(payload.platformGameId || payload.gameId || '');
    const gameId = String(payload.gameId || `${platformId}-${platformGameId}`);
    const title = String(payload.title || gameId);
    const sanitizedTitle = sanitizeDirectoryName(title);

    const isSimulatedOrManual = Boolean(
      payload.manualControl ||
        payload.mockDownload ||
        payload.simulateDownload ||
        options.simulateDownload
    );
    if (!isSimulatedOrManual) {
      ensureDownloadQueueRehydrated(options);
    }

    const isResumeOrInternalRetry = Boolean(
      payload._resumingPausedInstall ||
        payload._retriedAfterReauth ||
        payload._retriedThirdPartyChained ||
        (payload.taskId && downloadQueueMap.has(payload.taskId))
    );

    if (!isSimulatedOrManual && !isResumeOrInternalRetry) {
      const dedupKey = buildActiveDownloadDedupKey(
        platformId,
        payload.steamAppId || payload.xboxProductId || platformGameId,
        platform
      );
      if (dedupKey) {
        const existingActive = findActiveDuplicateDownloadTask(
          platformId,
          payload.steamAppId || payload.xboxProductId || platformGameId,
          platform,
          payload.taskId
        );
        if (existingActive) {
          return {
            success: true,
            deduplicated: true,
            alreadyActive: true,
            message: `Download already in progress for ${existingActive.title || title}`,
            task: toPublicDownloadTask(existingActive),
          };
        }
        if (inFlightInstallKeys.has(dedupKey)) {
          return {
            success: false,
            deduplicated: true,
            error: `Download is already starting for ${title}.`,
          };
        }
        inFlightInstallKeys.add(dedupKey);
        acquiredDedupKey = dedupKey;
      }
    }

    const isClientlessXboxMode = Boolean(
      platformId === 'xbox' &&
        (platform === 'darwin' ||
          payload.preferClientlessExtraction === true ||
          options.preferClientlessExtraction === true ||
          payload.installerId === 'xbox-msixvc-win' ||
          Boolean(payload.msixvcPath))
    );

    let installDir = '';
    let finalInstallPath = '';
    if (
      !payload.installDir &&
      typeof payload.installPath === 'string' &&
      payload.installPath.trim()
    ) {
      finalInstallPath = path.resolve(payload.installPath.trim());
      installDir = path.dirname(finalInstallPath);
    } else {
      installDir =
        payload.installDir ||
        getDefaultInstallDir(platformId, {
          ...options,
          platform,
          homedir,
          ...(isClientlessXboxMode ? { clientlessMsixvc: true } : {}),
        });
    }
    if (platformId === 'xbox') {
      const trimmedDir = String(installDir || '').trim();
      if (!finalInstallPath && trimmedDir) {
        if (path.basename(trimmedDir).toLowerCase() === sanitizedTitle.toLowerCase()) {
          finalInstallPath = path.resolve(trimmedDir);
          installDir = path.dirname(finalInstallPath);
        } else if (isXboxChildGameFolder(trimmedDir)) {
          installDir = path.dirname(path.resolve(trimmedDir));
          finalInstallPath = path.join(installDir, sanitizedTitle);
        } else {
          finalInstallPath = path.join(installDir, sanitizedTitle);
        }
      } else if (
        finalInstallPath &&
        trimmedDir &&
        isXboxChildGameFolder(trimmedDir) &&
        path.basename(trimmedDir).toLowerCase() !== sanitizedTitle.toLowerCase()
      ) {
        installDir = path.dirname(path.resolve(trimmedDir));
        finalInstallPath = path.join(installDir, path.basename(finalInstallPath));
      }
    }
    if (!finalInstallPath) {
      finalInstallPath = path.join(installDir, sanitizedTitle);
    }

    const totalBytes = Number(
      payload.totalBytes ||
        payload.estimatedSizeBytes ||
        (isSimulatedOrManual ? 120 * 1024 * 1024 : 0)
    );
    const initialSpeed = isSimulatedOrManual ? 18 * 1024 * 1024 : 0;
    const initialEta =
      isSimulatedOrManual && totalBytes > 0
        ? Math.max(1, Math.round(totalBytes / (18 * 1024 * 1024)))
        : undefined;

    try {
      const hostInstallDir = toHostFilesystemPath(installDir);
      if (hostInstallDir && !fs.existsSync(hostInstallDir)) {
        fs.mkdirSync(hostInstallDir, { recursive: true });
      }
    } catch {}

    const taskId = payload.taskId || `dl-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    if (platformId === 'gog' && !isSimulatedOrManual) {
      sweepStaleGogTempBinsAsync([installDir, finalInstallPath]).catch(() => {});
    }
    const existingResumedTask =
      payload._resumingPausedInstall && downloadQueueMap.has(taskId)
        ? downloadQueueMap.get(taskId)
        : null;

    const resolvedSteamAppId =
      platformId === 'steam'
        ? Number(payload.steamAppId || String(platformGameId).replace(/^steam-/i, '')) || undefined
        : undefined;

    const sanitizedInstallRequest = {
      gameId,
      title,
      platformId,
      platformGameId,
      ...(resolvedSteamAppId ? { steamAppId: resolvedSteamAppId } : {}),
      ...(payload.xboxProductId ? { xboxProductId: payload.xboxProductId } : {}),
      ...(payload.storeId ? { storeId: payload.storeId } : {}),
      ...(payload.contentId ? { contentId: payload.contentId } : {}),
      ...(payload.wuCategoryId ? { wuCategoryId: payload.wuCategoryId } : {}),
      ...(payload.packageFamilyName ? { packageFamilyName: payload.packageFamilyName } : {}),
      ...(typeof payload.preferClientlessExtraction === 'boolean'
        ? { preferClientlessExtraction: payload.preferClientlessExtraction }
        : {}),
      ...(payload.msixvcPath ? { msixvcPath: payload.msixvcPath } : {}),
      installDir,
      ...(payload.os ? { os: payload.os } : {}),
      ...(payload.installerId ? { installerId: payload.installerId } : {}),
      ...(payload.compatibilityLayer ? { compatibilityLayer: payload.compatibilityLayer } : {}),
      ...(payload.wineBottle ? { wineBottle: payload.wineBottle } : {}),
      ...(payload.wineBottleName ? { wineBottleName: payload.wineBottleName } : {}),
      ...(payload.chainedLauncherHandoff || payload.chainedRequiresLauncherHandoff
        ? {
            chainedLauncherHandoff:
              payload.chainedLauncherHandoff || payload.chainedRequiresLauncherHandoff,
          }
        : {}),
      ...(typeof payload.isExternalLauncherStubPackage === 'boolean'
        ? { isExternalLauncherStubPackage: payload.isExternalLauncherStubPackage }
        : {}),
      ...(payload.externalStorefrontHandoff
        ? { externalStorefrontHandoff: payload.externalStorefrontHandoff }
        : {}),
      ...(payload.externalLauncher ? { externalLauncher: payload.externalLauncher } : {}),
      ...(payload.chainedExternalInstallId
        ? { chainedExternalInstallId: payload.chainedExternalInstallId }
        : {}),
      ...(payload.chainedHandoffTopology
        ? { chainedHandoffTopology: payload.chainedHandoffTopology }
        : {}),
      ...(payload.epicPartnerRegistryPath
        ? { epicPartnerRegistryPath: payload.epicPartnerRegistryPath }
        : {}),
      includeDlcs: Boolean(payload.includeDlcs),
      ...(payload.headerImage ? { headerImage: payload.headerImage } : {}),
      ...(totalBytes > 0 ? { estimatedSizeBytes: totalBytes } : {}),
    };

    const task = {
      taskId,
      gameId,
      title,
      platformId,
      platformGameId,
      steamAppId: resolvedSteamAppId,
      headerImage: payload.headerImage,
      installDir,
      status: 'downloading',
      progressPercent: existingResumedTask ? Number(existingResumedTask.progressPercent || 0) : 0,
      bytesDownloaded: existingResumedTask ? Number(existingResumedTask.bytesDownloaded || 0) : 0,
      totalBytes:
        existingResumedTask && Number(existingResumedTask.totalBytes || 0) > 0
          ? Number(existingResumedTask.totalBytes)
          : totalBytes,
      speedBytesPerSec: initialSpeed,
      etaSeconds: initialEta,
      statusMessage: existingResumedTask ? `Resuming ${title}...` : `Downloading ${title}...`,
      startedAt: existingResumedTask?.startedAt || new Date().toISOString(),
      finalInstallPath,
      manualControl: Boolean(payload.manualControl),
      isSimulatedOrManual,
      installRequest: existingResumedTask?.installRequest || sanitizedInstallRequest,
      _hostPlatform: platform,
      ...(!isSimulatedOrManual
        ? { _persistedUserDataDir: options.userDataDir || getConfiguredUserDataDir() || undefined }
        : {}),
    };

    downloadQueueMap.set(taskId, task);
    if (!isSimulatedOrManual) {
      persistDownloadQueueToDisk(options.userDataDir || task._persistedUserDataDir);
    }
    const publicInitialTask = toPublicDownloadTask(task);
    emitDownloadUpdated({ task: { ...publicInitialTask }, queue: getDownloadQueue(options) });

    if (payload.manualControl) {
      return {
        success: true,
        message: `Queued installation for ${title}`,
        task: { ...publicInitialTask },
      };
    }

    if (payload.mockDownload || payload.simulateDownload || options.simulateDownload) {
      const stepMs = Number(payload.stepIntervalMs || 60);
      const timer = setInterval(() => {
        const current = downloadQueueMap.get(taskId);
        if (
          !current ||
          current.status === 'cancelled' ||
          current.status === 'completed' ||
          current.status === 'failed'
        ) {
          clearInterval(timer);
          return;
        }
        if (current.status === 'paused') {
          return;
        }

        const nextBytes = Math.min(
          current.totalBytes,
          current.bytesDownloaded + Math.ceil(current.totalBytes * 0.25)
        );
        const pct = Math.min(100, Math.round((nextBytes / current.totalBytes) * 100));

        if (pct < 100) {
          updateDownloadTask(
            taskId,
            {
              bytesDownloaded: nextBytes,
              progressPercent: pct,
              speedBytesPerSec: 24 * 1024 * 1024,
              etaSeconds: Math.max(
                1,
                Math.round((current.totalBytes - nextBytes) / (24 * 1024 * 1024))
              ),
              statusMessage: `Downloading ${current.title} (${pct}%)...`,
            },
            options
          );
        } else {
          clearInterval(timer);
          updateDownloadTask(
            taskId,
            {
              status: 'extracting',
              bytesDownloaded: current.totalBytes,
              progressPercent: 100,
              speedBytesPerSec: 0,
              statusMessage: `Extracting ${current.title}...`,
            },
            options
          );

          try {
            const hostFinalInstallPath = toHostFilesystemPath(finalInstallPath);
            if (!fs.existsSync(hostFinalInstallPath)) {
              fs.mkdirSync(hostFinalInstallPath, { recursive: true });
            }
            const exeFileName =
              platform === 'darwin'
                ? `${sanitizeDirectoryName(title)}.sh`
                : `${sanitizeDirectoryName(title)}.exe`;
            const hostExePath = path.join(hostFinalInstallPath, exeFileName);
            fs.writeFileSync(hostExePath, '#!/bin/sh\necho "Running"\n', { mode: 0o755 });
            current.executablePath = path.join(finalInstallPath, exeFileName);
          } catch {}

          updateDownloadTask(
            taskId,
            {
              status: 'completed',
              statusMessage: 'Installation complete',
              executablePath: current.executablePath,
            },
            options
          );
        }
      }, stepMs);
      if (typeof timer.unref === 'function') timer.unref();
      downloadControllers.set(taskId, { type: 'timer', timer });

      return {
        success: true,
        message: `Started installation for ${title}`,
        task: { ...publicInitialTask },
      };
    }

    if (platformId === 'steam') {
      const appId = validateSafeSteamAppId(payload.steamAppId || platformGameId);
      if (!appId) {
        const invalidSteamErr = `Invalid Steam AppID for ${title}.`;
        updateDownloadTask(
          taskId,
          {
            status: 'failed',
            speedBytesPerSec: 0,
            etaSeconds: undefined,
            error: invalidSteamErr,
            statusMessage: invalidSteamErr,
          },
          options
        );
        return { success: false, error: invalidSteamErr };
      }

      const isWinCompatInstall =
        platform === 'darwin' &&
        (payload.os === 'windows' || payload.installerId === 'steam-win-compat');
      const expectedSteamId64 = await resolveExpectedSteamId64Async(options);
      if (isTaskCancelledOrPaused(taskId)) {
        return { success: false, error: 'Download cancelled or paused.' };
      }

      let launchedViaWineSteam = false;
      /** @type {(() => Promise<void>) | null} */
      let dispatchSteamInstallTriggerAsync = null;
      /** @type {string[]} */
      let targetVdfCandidates = [];
      let wasAuthenticatedAtLaunch = true;
      const layers = isWinCompatInstall ? detectCompatibilityLayers(options) : [];
      const hostArch = String(
        options.arch || options.hostArch || process.arch || 'arm64'
      ).toLowerCase();
      const existingConfigs = isWinCompatInstall ? getGameLaunchConfigs(options) : {};
      const rawExistingConfig =
        isWinCompatInstall && payload.gameId ? existingConfigs[payload.gameId] || {} : {};
      const existingConfig = isWinCompatInstall
        ? resolvePlatformLaunchConfig(rawExistingConfig, 'steam')
        : {};
      const requestedLayerType = isWinCompatInstall
        ? normalizeRequestedCompatibilityLayerType(
            payload.compatibilityLayer ||
              payload.launchConfig?.compatibilityLayer ||
              options.compatibilityLayer ||
              existingConfig.compatibilityLayer
          )
        : '';
      const failSteamWinCompatFast = (/** @type {string} */ errMsg) => {
        downloadControllers.delete(taskId);
        updateDownloadTask(
          taskId,
          {
            status: 'failed',
            speedBytesPerSec: 0,
            etaSeconds: undefined,
            error: errMsg,
            statusMessage: errMsg,
          },
          options
        );
        return { success: false, error: errMsg };
      };

      if (
        isWinCompatInstall &&
        !options.disableWineSteamSpawn &&
        requestedLayerType === 'crossover_preview_arm64' &&
        hostArch !== 'arm64'
      ) {
        return failSteamWinCompatFast(
          'CrossOver Preview (arm64 / FEX) requires an Apple Silicon (arm64) Mac and is unsupported on Intel x86_64 Macs.'
        );
      }

      if (
        isWinCompatInstall &&
        !options.disableWineSteamSpawn &&
        requestedLayerType &&
        layers.length === 0
      ) {
        return failSteamWinCompatFast(
          `Compatibility runner "${requestedLayerType}" is not installed.`
        );
      }

      if (isWinCompatInstall && !options.disableWineSteamSpawn && layers.length > 0) {
        const matchedRequestedLayer = requestedLayerType
          ? layers.find(
              (/** @type {any} */ l) =>
                l && (l.type === requestedLayerType || l.id === requestedLayerType)
            )
          : null;
        if (requestedLayerType) {
          if (!matchedRequestedLayer) {
            return failSteamWinCompatFast(
              `Compatibility runner "${requestedLayerType}" is not installed.`
            );
          }
          if (
            matchedRequestedLayer.available === false ||
            (matchedRequestedLayer.type === 'crossover_preview_arm64' && hostArch !== 'arm64')
          ) {
            return failSteamWinCompatFast(
              matchedRequestedLayer.type === 'crossover_preview_arm64'
                ? 'CrossOver Preview (arm64 / FEX) requires an Apple Silicon (arm64) Mac and is unsupported on Intel x86_64 Macs.'
                : `Compatibility runner "${requestedLayerType}" is unavailable on this host.`
            );
          }
        }
        const preferredLayer =
          matchedRequestedLayer ||
          layers.find(
            (/** @type {any} */ l) =>
              l &&
              l.available !== false &&
              (l.type === 'crossover' ||
                l.type === 'crossover_preview' ||
                l.type === 'crossover_preview_arm64')
          ) ||
          layers.find((/** @type {any} */ l) => l && l.available !== false) ||
          null;

        if (!preferredLayer) {
          if (
            hostArch !== 'arm64' &&
            layers.some((/** @type {any} */ l) => l && l.type === 'crossover_preview_arm64')
          ) {
            return failSteamWinCompatFast(
              'CrossOver Preview (arm64 / FEX) requires an Apple Silicon (arm64) Mac and is unsupported on Intel x86_64 Macs.'
            );
          }
        } else {
          if (
            preferredLayer.type === 'crossover_preview_arm64' &&
            (hostArch !== 'arm64' || preferredLayer.available === false)
          ) {
            return failSteamWinCompatFast(
              'CrossOver Preview (arm64 / FEX) requires an Apple Silicon (arm64) Mac and is unsupported on Intel x86_64 Macs.'
            );
          }

          const explicitBottleName = String(
            payload.wineBottleName || existingConfig.wineBottleName || ''
          ).trim();
          const effectiveInstallBottleCfg = explicitBottleName
            ? { ...existingConfig, wineBottleName: explicitBottleName }
            : existingConfig;

          /** @type {Record<string, any>} */
          const env = { ...process.env };
          try {
            await ensureCompatibilityLayerReady(
              preferredLayer,
              effectiveInstallBottleCfg,
              env,
              options
            );
          } catch (/** @type {any} */ compatErr) {
            return failSteamWinCompatFast(
              compatErr?.message || String(compatErr || 'Compatibility layer preparation failed.')
            );
          }
          if (isTaskCancelledOrPaused(taskId)) {
            return { success: false, error: 'Download cancelled or paused.' };
          }

          const preferredIsArm64 = preferredLayer.type === 'crossover_preview_arm64';
          const isBottleArchCompatibleForInstall = (
            /** @type {any} */ layerObj,
            /** @type {string} */ bName,
            /** @type {string} */ bPath
          ) => {
            const confMeta =
              layerObj?.bottleDetails?.[bName] ||
              (bPath ? inspectBottleConfMetadata(bPath) : {});
            const arch =
              confMeta?.wineArch ||
              (bPath && isValidBottleDirectory(bPath, false) ? 'win64' : undefined);
            if (!arch) {
              return preferredIsArm64
                ? layerObj?.type === 'crossover_preview_arm64'
                : layerObj?.type !== 'crossover_preview_arm64';
            }
            return preferredIsArm64 ? arch === 'arm64' : arch !== 'arm64';
          };
          const compatiblePreferredBottles = Array.isArray(preferredLayer.availableBottles)
            ? preferredLayer.availableBottles.filter((/** @type {string} */ bName) =>
                isBottleArchCompatibleForInstall(
                  preferredLayer,
                  bName,
                  preferredLayer.bottlesDir ? path.join(preferredLayer.bottlesDir, bName) : ''
                )
              )
            : [];
          const preferredFallbackBottleName = preferredIsArm64
            ? 'OneLauncher-arm64'
            : 'OneLauncher';

          const candidateBottles = [];
          const targetBottleName =
            explicitBottleName ||
            env.CX_BOTTLE ||
            compatiblePreferredBottles.find(
              (/** @type {string} */ b) =>
                b.toLowerCase() === preferredFallbackBottleName.toLowerCase()
            ) ||
            compatiblePreferredBottles[0] ||
            preferredFallbackBottleName;
          const targetBottlePath =
            (explicitBottleName && preferredLayer.bottlesDir
              ? path.isAbsolute(explicitBottleName)
                ? explicitBottleName
                : path.join(preferredLayer.bottlesDir, explicitBottleName)
              : '') ||
            env.WINEPREFIX ||
            (preferredLayer.bottlesDir
              ? path.join(preferredLayer.bottlesDir, targetBottleName)
              : '');

          if (targetBottlePath) {
            candidateBottles.push({
              layer: preferredLayer,
              bottleName: targetBottleName,
              bottlePath: targetBottlePath,
            });
          }

          if (!explicitBottleName || !targetBottlePath || !fs.existsSync(targetBottlePath)) {
            for (const layer of layers) {
              if (!layer.bottlesDir || !Array.isArray(layer.availableBottles)) continue;
              if (
                preferredIsArm64 &&
                (layer.type === 'crossover' || layer.type === 'crossover_preview')
              ) {
                continue;
              }
              if (!preferredIsArm64 && layer.type === 'crossover_preview_arm64') {
                continue;
              }
              for (const bottleName of layer.availableBottles) {
                const bottlePath = path.join(layer.bottlesDir, bottleName);
                if (!isBottleArchCompatibleForInstall(layer, bottleName, bottlePath)) continue;
                if (!candidateBottles.some((b) => b.bottlePath === bottlePath)) {
                  candidateBottles.push({ layer, bottleName, bottlePath });
                }
              }
            }
          }

          /** @type {any} */
          let resolvedTarget = null;
          if (explicitBottleName && targetBottlePath && fs.existsSync(targetBottlePath)) {
            const explicitSteamExe = resolveBottleSteamExe(targetBottlePath);
            if (explicitSteamExe) {
              resolvedTarget = {
                layer: preferredLayer,
                bottleName: targetBottleName,
                bottlePath: targetBottlePath,
                foundSteamExe: explicitSteamExe,
              };
            }
          } else {
            for (const cand of candidateBottles) {
              const foundSteamExe = resolveBottleSteamExe(cand.bottlePath);
              if (foundSteamExe) {
                resolvedTarget = { ...cand, foundSteamExe };
                break;
              }
            }
          }

          if (
            !resolvedTarget &&
            targetBottlePath &&
            preferredLayer.binaryPath &&
            fs.existsSync(preferredLayer.binaryPath)
          ) {
            const bootstrappedExe = await ensureWindowsSteamInBottle(
              preferredLayer,
              targetBottleName,
              targetBottlePath,
              taskId,
              options
            );
            if (isTaskCancelledOrPaused(taskId)) {
              return { success: false, error: 'Download cancelled or paused.' };
            }
            if (bootstrappedExe) {
              resolvedTarget = {
                layer: preferredLayer,
                bottleName: targetBottleName,
                bottlePath: targetBottlePath,
                foundSteamExe: bootstrappedExe,
              };
            }
          }

          if (
            resolvedTarget &&
            resolvedTarget.foundSteamExe &&
            resolvedTarget.layer.binaryPath &&
            (typeof options.spawnFn === 'function' ||
              fs.existsSync(resolvedTarget.layer.binaryPath))
          ) {
            try {
              const bottleVdfCandidates = [
                path.join(path.dirname(resolvedTarget.foundSteamExe), 'config', 'loginusers.vdf'),
                path.join(
                  resolvedTarget.bottlePath,
                  'drive_c/Program Files (x86)/Steam/config/loginusers.vdf'
                ),
                path.join(
                  resolvedTarget.bottlePath,
                  'drive_c/Program Files/Steam/config/loginusers.vdf'
                ),
              ];
              wasAuthenticatedAtLaunch = await hasAuthenticatedSteamSessionInVdfCandidates(
                bottleVdfCandidates,
                expectedSteamId64
              );
              if (isTaskCancelledOrPaused(taskId)) {
                return { success: false, error: 'Download cancelled or paused.' };
              }

              const spawnWineSteamInstall = () => {
                const wineArgs = [resolvedTarget.foundSteamExe, `steam://install/${appId}`];
                const spawnOpts = {
                  env: {
                    ...process.env,
                    ...env,
                    CX_BOTTLE: resolvedTarget.bottleName,
                    WINEPREFIX: resolvedTarget.bottlePath,
                  },
                  stdio: /** @type {'ignore'} */ ('ignore'),
                  detached: process.platform !== 'win32',
                };
                const child =
                  typeof options.spawnFn === 'function'
                    ? options.spawnFn(resolvedTarget.layer.binaryPath, wineArgs, spawnOpts)
                    : (() => {
                        const resolvedWineSteamSpawn = resolveWindowsNodeShebangSpawn(
                          resolvedTarget.layer.binaryPath,
                          wineArgs
                        );
                        return spawn(
                          resolvedWineSteamSpawn.cmd,
                          resolvedWineSteamSpawn.args,
                          spawnOpts
                        );
                      })();
                // P0-12: Always attach immediate error listener to prevent uncaught spawn crashes
                if (child && typeof child.on === 'function') {
                  child.on('error', (/** @type {any} */ spawnErr) => {
                    diagLog.warn('installGame.wineSteamSpawnError', spawnErr, {
                      taskId,
                      appId,
                      binaryPath: resolvedTarget.layer.binaryPath,
                    });
                  });
                }
                if (child && typeof child.unref === 'function') child.unref();
              };

              spawnWineSteamInstall();
              launchedViaWineSteam = true;
              targetVdfCandidates = bottleVdfCandidates;
              dispatchSteamInstallTriggerAsync = async () => {
                if (!isTaskCancelledOrPaused(taskId)) {
                  spawnWineSteamInstall();
                }
              };

              if (payload.gameId) {
                try {
                  saveGameLaunchConfig(
                    {
                      ...existingConfig,
                      gameId: payload.gameId,
                      preferredPlatformId: 'steam',
                      launchMethod: 'compatibility_layer',
                      compatibilityLayer: resolvedTarget.layer.type,
                      wineBottleName: resolvedTarget.bottleName,
                    },
                    options
                  );
                } catch {}
              }
            } catch {}
          }
        }
      } else if (platform === 'darwin' && !isWinCompatInstall && payload.gameId) {
        try {
          const existingConfigs = getGameLaunchConfigs(options);
          const rawExistingConfig = existingConfigs[payload.gameId] || {};
          const existingConfig = resolvePlatformLaunchConfig(rawExistingConfig, 'steam');
          if (existingConfig?.launchMethod === 'compatibility_layer') {
            saveGameLaunchConfig(
              {
                ...existingConfig,
                gameId: payload.gameId,
                preferredPlatformId: 'steam',
                launchMethod: 'auto',
              },
              options
            );
          }
        } catch {}
      }

      if (
        !launchedViaWineSteam &&
        (!isWinCompatInstall || options.disableWineSteamSpawn || layers.length === 0)
      ) {
        const { homedir: resolvedHome } = resolveIsolatedHomedirAndUserData(options);
        const discoveredHostSteam = discoverSteamLocations(options);
        /** @type {string[]} */
        const hostVdfCandidates = [];
        if (
          typeof options.hostSteamLoginUsersVdfPath === 'string' &&
          options.hostSteamLoginUsersVdfPath.trim()
        ) {
          hostVdfCandidates.push(options.hostSteamLoginUsersVdfPath.trim());
        }
        if (platform === 'darwin' && resolvedHome) {
          hostVdfCandidates.push(
            path.join(resolvedHome, 'Library/Application Support/Steam/config/loginusers.vdf')
          );
        } else if (platform === 'win32' && resolvedHome) {
          hostVdfCandidates.push(
            path.join(resolvedHome, 'Program Files (x86)/Steam/config/loginusers.vdf'),
            path.join(resolvedHome, 'Steam/config/loginusers.vdf')
          );
          if (!options.homedir) {
            const winEnv = options.env && typeof options.env === 'object' ? options.env : process.env;
            const rawSysDrive = String(options.systemDrive || winEnv.SYSTEMDRIVE || winEnv.SystemDrive || 'C:')
              .trim()
              .replace(/[\\/]+$/, '');
            const sysRoot = /^[A-Za-z]:$/.test(rawSysDrive) ? `${rawSysDrive}\\` : 'C:\\';
            const pfX86 =
              winEnv['ProgramFiles(x86)'] ||
              winEnv['PROGRAMFILES(X86)'] ||
              path.win32.join(sysRoot, 'Program Files (x86)');
            const pf64 =
              winEnv.ProgramFiles ||
              winEnv.PROGRAMFILES ||
              path.win32.join(sysRoot, 'Program Files');
            hostVdfCandidates.push(
              path.win32.join(pfX86, 'Steam', 'config', 'loginusers.vdf'),
              path.win32.join(pf64, 'Steam', 'config', 'loginusers.vdf')
            );
          }
        } else if (resolvedHome) {
          hostVdfCandidates.push(
            path.join(resolvedHome, '.local/share/Steam/config/loginusers.vdf'),
            path.join(resolvedHome, '.steam/steam/config/loginusers.vdf')
          );
        }
        if (discoveredHostSteam && discoveredHostSteam.steamRoots) {
          for (const root of discoveredHostSteam.steamRoots) {
            if (!root) continue;
            hostVdfCandidates.push(
              path.join(root, 'config', 'loginusers.vdf'),
              path.join(root, 'Steam', 'config', 'loginusers.vdf')
            );
          }
        }

        wasAuthenticatedAtLaunch = await hasAuthenticatedSteamSessionInVdfCandidates(
          hostVdfCandidates,
          expectedSteamId64
        );
        if (isTaskCancelledOrPaused(taskId)) {
          return { success: false, error: 'Download cancelled or paused.' };
        }
        targetVdfCandidates = hostVdfCandidates;
        dispatchSteamInstallTriggerAsync = async () => {
          if (!isTaskCancelledOrPaused(taskId)) {
            await openExternalUri(`steam://install/${appId}`, options);
          }
        };
        await openExternalUri(`steam://install/${appId}`, options);
      }

      const initialSteamStatusMessage = wasAuthenticatedAtLaunch
        ? launchedViaWineSteam
          ? 'Installing via Windows Steam in CrossOver / Wine (monitoring appmanifest)...'
          : 'Installing via Steam client (monitoring appmanifest & content_log)...'
        : launchedViaWineSteam
          ? 'Installing via Windows Steam in CrossOver / Wine (waiting for Steam sign-in — download starts automatically once signed in)...'
          : 'Installing via Steam client (waiting for Steam sign-in — download starts automatically once signed in)...';

      updateDownloadTask(
        taskId,
        {
          statusMessage: initialSteamStatusMessage,
        },
        options
      );

      if (!options.disableSteamMonitor) {
        const monitorOptions =
          !wasAuthenticatedAtLaunch && dispatchSteamInstallTriggerAsync
            ? {
                ...options,
                _steamAuthRetrigger: {
                  wasAuthenticatedAtLaunch: false,
                  launchedViaWineSteam,
                  expectedSteamId64,
                  vdfCandidates: targetVdfCandidates,
                  retriggerInstallAsync: dispatchSteamInstallTriggerAsync,
                },
              }
            : options;
        startSteamInstallMonitor(taskId, appId, monitorOptions);
      }
    } else if (platformId === 'epic') {
      const legendaryBin = findLegendaryBinary(options);
      const epicInfo = resolveEpicAppAndPlatforms(payload, options);
      const resolvedAppName =
        epicInfo.resolvedAppName || platformGameId.replace(/^epic-/i, '') || platformGameId;
      const safeAppName = validateSafeCliIdentifier(resolvedAppName);

      const isExplicitEpicChainedInstaller = /^epic-chained-(?:bottle|host|win)-launcher$/i.test(
        String(payload.installerId || '')
      );
      let epicChainedHandoff = resolveAnyChainedHandoffId(
        epicInfo.chainedLauncherHandoff ||
          payload.chainedLauncherHandoff ||
          payload.externalStorefrontHandoff ||
          (isExplicitEpicChainedInstaller ? payload.externalLauncher : '')
      );
      let epicPartnerRegPath =
        epicInfo.epicPartnerRegistryPath ||
        (typeof payload.epicPartnerRegistryPath === 'string' &&
        payload.epicPartnerRegistryPath.trim()
          ? payload.epicPartnerRegistryPath.trim()
          : undefined);

      if (
        !epicChainedHandoff &&
        (payload.chainedHandoffTopology === 'partner_launcher_link' ||
          isExplicitEpicChainedInstaller) &&
        legendaryBin &&
        safeAppName &&
        !options.skipNetwork &&
        !options.disableLegendarySpawn
      ) {
        try {
          const execFileImpl =
            typeof options.execFileFn === 'function' ? options.execFileFn : execFile;
          const legAuth = await ensureLegendaryConfigAndAuth(options);
          if (isTaskCancelledOrPaused(taskId)) {
            return { success: false, error: 'Download cancelled or paused.' };
          }
          const probedPartner = await new Promise((resolve) => {
            execFileImpl(
              legendaryBin,
              ['info', safeAppName, '--platform', 'Windows', '--json'],
              { env: legAuth.env, timeout: 10000 },
              (/** @type {any} */ err, /** @type {any} */ stdout) => {
                if (err || !stdout) return resolve(null);
                try {
                  resolve(extractEpicThirdPartyPartnerMetadata(JSON.parse(String(stdout).trim())));
                } catch {
                  resolve(null);
                }
              }
            );
          });
          if (probedPartner?.chainedLauncherHandoff) {
            epicChainedHandoff = probedPartner.chainedLauncherHandoff;
          }
          if (!epicPartnerRegPath && probedPartner?.epicPartnerRegistryPath) {
            epicPartnerRegPath = probedPartner.epicPartnerRegistryPath;
          }
        } catch {}
      }

      if (
        epicChainedHandoff ||
        isExplicitEpicChainedInstaller ||
        payload.chainedHandoffTopology === 'partner_launcher_link'
      ) {
        return await executeChainedPublisherInstallFlow(
          {
            taskId,
            task,
            payload: {
              ...payload,
              ...(epicInfo.chainedExternalInstallId && !payload.chainedExternalInstallId
                ? { chainedExternalInstallId: epicInfo.chainedExternalInstallId }
                : {}),
            },
            platform,
            platformId: 'epic',
            platformGameId: platformGameId || resolvedAppName,
            title,
            cleanStoreId: '',
            chainedHandoffId: epicChainedHandoff,
            chainedHandoffTopology: 'partner_launcher_link',
            epicPartnerRegistryPath: epicPartnerRegPath,
          },
          options
        );
      }

      if (!safeAppName) {
        const invalidAppErr = `Invalid Epic Games app identifier for ${title}.`;
        updateDownloadTask(
          taskId,
          {
            status: 'failed',
            speedBytesPerSec: 0,
            etaSeconds: undefined,
            error: invalidAppErr,
            statusMessage: invalidAppErr,
          },
          options
        );
        return { success: false, error: invalidAppErr };
      }

      let epicPlatformFlag = 'Windows';
      if (platform === 'darwin') {
        if (payload.os === 'windows' || payload.installerId === 'epic-win-compat') {
          epicPlatformFlag = 'Windows';
        } else {
          epicPlatformFlag = epicInfo.hasMacBuild ? 'Mac' : 'Windows';
        }
      }

      if (legendaryBin && !options.disableLegendarySpawn) {
        try {
          const safeInstallDir = validateSafeCliPathArg(installDir);
          if (!safeInstallDir) {
            throw new Error(`Invalid install directory path for Legendary: ${installDir}`);
          }
          const authInfo = await ensureLegendaryConfigAndAuth({
            ...options,
            allowInteractiveAuth: true,
          });
          if (isTaskCancelledOrPaused(taskId)) {
            return { success: false, error: 'Download cancelled or paused.' };
          }

          const spawnArgs = [
            'install',
            safeAppName,
            '--platform',
            epicPlatformFlag,
            '--base-path',
            safeInstallDir,
            payload.includeDlcs === true ? '--with-dlcs' : '--skip-dlcs',
            '--skip-sdl',
            '-y',
          ];

          const spawnImpl = typeof options.spawnFn === 'function' ? options.spawnFn : spawn;
          const resolvedLegSpawn =
            spawnImpl === spawn
              ? resolveWindowsNodeShebangSpawn(legendaryBin, spawnArgs)
              : { cmd: legendaryBin, args: spawnArgs };
          const child = spawnImpl(resolvedLegSpawn.cmd, resolvedLegSpawn.args, {
            stdio: ['ignore', 'pipe', 'pipe'],
            env: authInfo.env,
            ...(typeof options.spawnFn !== 'function' &&
            platform !== 'win32' &&
            process.platform !== 'win32'
              ? { detached: true }
              : {}),
          });
          /** @type {any} */
          const ctrl = {
            type: 'process',
            child,
            pausedByUser: false,
            cancelRequested: false,
            exitedWhilePaused: false,
            resumeInstallFn: () =>
              installGame({ ...payload, taskId, _resumingPausedInstall: true }, options),
          };
          downloadControllers.set(taskId, ctrl);

          const legParser = createLegendaryProgressParser({
            taskId,
            epicPlatformFlag,
            options,
          });

          let childSettled = false;

          // P0-12: Immediate error listener so ENOENT / EACCES / Gatekeeper errors fail cleanly
          if (child && typeof child.on === 'function') {
            child.on('error', (/** @type {any} */ spawnErr) => {
              if (childSettled) return;
              childSettled = true;
              const currentTask = downloadQueueMap.get(taskId);
              if (ctrl.pausedByUser || (currentTask && currentTask.status === 'paused')) {
                ctrl.exitedWhilePaused = true;
                ctrl.child = null;
                return;
              }
              downloadControllers.delete(taskId);
              if (ctrl.cancelRequested || (currentTask && currentTask.status === 'cancelled')) {
                return;
              }
              const errMsg = spawnErr?.message || String(spawnErr || 'Legendary process failed');
              diagLog.warn('installGame.legendarySpawnError', spawnErr, {
                taskId,
                appName: safeAppName,
              });
              updateDownloadTask(
                taskId,
                {
                  status: 'failed',
                  speedBytesPerSec: 0,
                  etaSeconds: undefined,
                  error: errMsg,
                  statusMessage: `Failed to start Legendary: ${errMsg}`,
                },
                options
              );
            });
          }

          if (child.stdout) child.stdout.on('data', legParser.onStdout);
          if (child.stderr) child.stderr.on('data', legParser.onStderr);
          child.on('exit', async (/** @type {number | null} */ code) => {
            if (childSettled) return;
            childSettled = true;
            legParser.flush();
            const { lastErrorLine, sawAuthFailure } = legParser.getState();

            const currentTask = downloadQueueMap.get(taskId);
            if (ctrl.pausedByUser || (currentTask && currentTask.status === 'paused')) {
              ctrl.exitedWhilePaused = true;
              ctrl.child = null;
              return;
            }
            downloadControllers.delete(taskId);
            if (ctrl.cancelRequested || (currentTask && currentTask.status === 'cancelled')) return;

            if (code === 0) {
              /** @type {any} */
              let installedEntry = null;
              const candidateInstalledFiles = [
                path.join(authInfo.legendaryConfigPath, 'installed.json'),
                path.join(
                  homedir,
                  'Library/Application Support/heroic/legendaryConfig/legendary/installed.json'
                ),
                path.join(
                  process.env.APPDATA || path.join(homedir, 'AppData', 'Roaming'),
                  'heroic',
                  'legendaryConfig',
                  'legendary',
                  'installed.json'
                ),
                path.join(
                  homedir,
                  'AppData',
                  'Roaming',
                  'heroic',
                  'legendaryConfig',
                  'legendary',
                  'installed.json'
                ),
                path.join(homedir, '.config/legendary/installed.json'),
              ];
              for (const instFile of candidateInstalledFiles) {
                if (!fs.existsSync(instFile)) continue;
                try {
                  const raw = JSON.parse(fs.readFileSync(instFile, 'utf8'));
                  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
                    installedEntry = raw[safeAppName] || raw[platformGameId] || null;
                  } else if (Array.isArray(raw)) {
                    installedEntry = raw.find(
                      (/** @type {any} */ x) =>
                        x && (x.app_name === safeAppName || x.app_name === platformGameId)
                    );
                  }
                  if (installedEntry) break;
                } catch {}
              }

              const actualInstallPath =
                installedEntry && (installedEntry.install_path || installedEntry.installPath)
                  ? toLocalFsPath(installedEntry.install_path || installedEntry.installPath)
                  : fs.existsSync(finalInstallPath)
                    ? finalInstallPath
                    : installDir;

              // Enforce strict root containment on manifest-declared executablePath
              /** @type {string | undefined} */
              let executablePath = undefined;
              if (installedEntry?.executable) {
                const containedManifestExe = resolveContainedExecutablePath(
                  actualInstallPath,
                  installedEntry.executable
                );
                if (containedManifestExe && fs.existsSync(containedManifestExe)) {
                  const resolvedCandidate = containedManifestExe.toLowerCase().endsWith('.app')
                    ? resolveMacAppBundleBinary(containedManifestExe) || ''
                    : containedManifestExe;
                  if (
                    resolvedCandidate &&
                    isContainedWithinRoot(actualInstallPath, resolvedCandidate)
                  ) {
                    executablePath = resolvedCandidate;
                  }
                }
              }

              const exeDiscovery = findPrimaryExecutable(actualInstallPath, {
                platform,
                hintName: title,
                preferWindowsExecutable: platform === 'darwin' && epicPlatformFlag === 'Windows',
              });

              if (!executablePath) {
                executablePath = exeDiscovery.executablePath || undefined;
                if (!executablePath && installedEntry?.executable) {
                  const containedFallback = resolveContainedExecutablePath(
                    actualInstallPath,
                    installedEntry.executable
                  );
                  if (containedFallback) {
                    executablePath = containedFallback;
                  }
                }
              }

              const isWindowsBinaryOnMac =
                platform === 'darwin' &&
                (epicPlatformFlag === 'Windows' ||
                  Boolean(executablePath && executablePath.toLowerCase().endsWith('.exe')) ||
                  Boolean(!executablePath && exeDiscovery.isWindowsBinaryOnMac));

              const installSize =
                Number(installedEntry?.install_size || 0) || currentTask?.totalBytes || totalBytes;

              writeManagedInstallSentinel(actualInstallPath, {
                store: 'epic',
                gameId: safeAppName || platformGameId,
                installKind: 'epic-legendary',
              });

              upsertManagedInstallRecord(
                {
                  platformId: 'epic',
                  platformGameId,
                  title,
                  installPath: actualInstallPath,
                  executablePath,
                  installSize,
                  version: installedEntry?.version ? String(installedEntry.version) : undefined,
                  runner: 'legendary',
                  isWindowsBinaryOnMac,
                },
                options.userDataDir
              );

              if (safeAppName && safeAppName !== platformGameId) {
                upsertManagedInstallRecord(
                  {
                    platformId: 'epic',
                    platformGameId: safeAppName,
                    title,
                    installPath: actualInstallPath,
                    executablePath,
                    installSize,
                    version: installedEntry?.version ? String(installedEntry.version) : undefined,
                    runner: 'legendary',
                    isWindowsBinaryOnMac,
                  },
                  options.userDataDir
                );
              }

              try {
                syncEpicFirstPartyLauncher({ ...options, runLegendaryEglSync: true });
              } catch {}

              if (platform === 'darwin' && !isWindowsBinaryOnMac) {
                try {
                  void ensureMacAppCodeSignatureValidAsync(
                    executablePath || actualInstallPath,
                    options
                  ).catch(() => {});
                } catch {}
              }

              updateDownloadTask(
                taskId,
                {
                  status: 'completed',
                  progressPercent: 100,
                  bytesDownloaded: installSize,
                  totalBytes: installSize,
                  finalInstallPath: actualInstallPath,
                  executablePath,
                  runner: 'legendary',
                  isWindowsBinaryOnMac,
                  statusMessage:
                    epicPlatformFlag === 'Mac'
                      ? 'Installed native macOS build via Legendary'
                      : 'Installed Windows build via Legendary',
                },
                options
              );
            } else {
              if (
                !payload._retriedThirdPartyChained &&
                /(?:third[- ]party\s+launcher|ThirdPartyManagedApp|(?:The\s+)?EA\s+App|Origin\s+client|Ubisoft\s+Connect|Uplay)/i.test(
                  lastErrorLine
                )
              ) {
                const fallbackHandoff = /ubisoft|uplay/i.test(lastErrorLine) ? 'ubisoft' : 'ea';
                await executeChainedPublisherInstallFlow(
                  {
                    taskId,
                    task,
                    payload: { ...payload, _retriedThirdPartyChained: true },
                    platform,
                    platformId: 'epic',
                    platformGameId: platformGameId || safeAppName,
                    title,
                    cleanStoreId: '',
                    chainedHandoffId: fallbackHandoff,
                    chainedHandoffTopology: 'partner_launcher_link',
                    epicPartnerRegistryPath: epicPartnerRegPath,
                  },
                  options
                );
                return;
              }
              if (sawAuthFailure && !payload._retriedAfterReauth) {
                updateDownloadTask(
                  taskId,
                  {
                    statusMessage:
                      'Epic Games session expired — refreshing authentication and retrying install...',
                  },
                  options
                );

                try {
                  const staleUserJson = path.join(authInfo.legendaryConfigPath, 'user.json');
                  if (fs.existsSync(staleUserJson)) {
                    fs.unlinkSync(staleUserJson);
                  }
                } catch {}

                const retryAuth = await ensureLegendaryConfigAndAuth({
                  ...options,
                  forceTokenRefresh: true,
                  allowInteractiveAuth: true,
                });

                if (isTaskCancelledOrPaused(taskId, ctrl)) return;

                if (retryAuth?.authenticated && retryAuth?.accessToken) {
                  await installGame(
                    {
                      ...payload,
                      taskId,
                      _retriedAfterReauth: true,
                    },
                    options
                  );
                  return;
                }

                const expiredMsg =
                  'Epic Games session expired. Please reconnect your Epic Games account in Store Connections and try installing again.';
                updateDownloadTask(
                  taskId,
                  {
                    status: 'failed',
                    speedBytesPerSec: 0,
                    etaSeconds: undefined,
                    error: expiredMsg,
                    statusMessage: expiredMsg,
                  },
                  options
                );
                return;
              }

              const errMsg = lastErrorLine || `Legendary exited with code ${code}`;
              updateDownloadTask(
                taskId,
                {
                  status: 'failed',
                  speedBytesPerSec: 0,
                  etaSeconds: undefined,
                  error: errMsg,
                  statusMessage: `Installation failed: ${errMsg}`,
                },
                options
              );
            }
          });
        } catch (/** @type {any} */ spawnErr) {
          updateDownloadTask(
            taskId,
            {
              status: 'failed',
              speedBytesPerSec: 0,
              etaSeconds: undefined,
              error: spawnErr.message,
              statusMessage: `Failed to start Legendary: ${spawnErr.message}`,
            },
            options
          );
        }
      } else {
        await openExternalUri(
          `com.epicgames.launcher://apps/${encodeURIComponent(safeAppName)}?action=install`,
          options
        );
        updateDownloadTask(
          taskId,
          {
            statusMessage: 'Installing via Epic Games Launcher...',
          },
          options
        );
      }
    } else if (platformId === 'gog') {
      const savedTokens =
        options.savedTokens ||
        (storeSync && typeof storeSync.loadSavedTokens === 'function' ? storeSync.loadSavedTokens() : {});
      /** @type {any} */
      let authRes = null;
      try {
        authRes = await ensureGogdlAuthConfig(options);
      } catch {}
      if (isTaskCancelledOrPaused(taskId)) {
        return { success: false, error: 'Download cancelled or paused.' };
      }

      const gogToken = options.gogAccessToken || authRes?.accessToken || savedTokens?.gog?.access_token;
      const gogdlBin = findGogdlBinary(options);
      const cleanId = validateSafeGogProductId(platformGameId);
      if (!cleanId) {
        const invalidGogErr = `Invalid GOG product identifier for ${title}.`;
        updateDownloadTask(
          taskId,
          {
            status: 'failed',
            speedBytesPerSec: 0,
            etaSeconds: undefined,
            error: invalidGogErr,
            statusMessage: invalidGogErr,
          },
          options
        );
        return { success: false, error: invalidGogErr };
      }

      const canUseNativeDepot =
        Boolean(options.useNativeGogDepotDownloader) ||
        (!options.homedir && !options.skipNetwork && typeof options.spawnFn !== 'function');

      if (gogToken && !options.disableGogdlSpawn && (gogdlBin || canUseNativeDepot)) {
        try {
          const gogAuthPath = validateSafeCliPathArg(
            authRes?.configPath ||
              authRes?.gogAuthPath ||
              path.join(getUserDataDir(options.userDataDir), 'gog_store', 'auth.json')
          );
          const safeFinalInstallPath = validateSafeCliPathArg(finalInstallPath);
          if (!gogAuthPath || !safeFinalInstallPath) {
            throw new Error('Invalid GOG auth or destination directory path.');
          }
          const gogPlatformFlag =
            payload.os === 'windows' ||
            (payload.installerId && String(payload.installerId).toLowerCase().includes('win'))
              ? 'windows'
              : platform === 'darwin'
                ? 'osx'
                : 'windows';

          try {
            const hostFinalInstallPath = toHostFilesystemPath(safeFinalInstallPath);
            if (!fs.existsSync(hostFinalInstallPath)) {
              fs.mkdirSync(hostFinalInstallPath, { recursive: true });
            }
          } catch {}

          /** @type {any} */
          let buildsCheck = null;
          let isV1Build = false;
          let isV2Build = false;
          if (canUseNativeDepot) {
            try {
              buildsCheck = await fetchGogV1Json(
                `https://content-system.gog.com/products/${encodeURIComponent(cleanId)}/os/${encodeURIComponent(gogPlatformFlag)}/builds?generation=2`,
                {},
                4000,
                options.fetchImpl || fetch
              );
              if (buildsCheck?.items?.[0]?.generation === 1) {
                isV1Build = true;
              } else if (
                Array.isArray(buildsCheck?.items) &&
                buildsCheck.items.some((/** @type {any} */ b) => b && b.generation === 2)
              ) {
                isV2Build = true;
              }
            } catch {}
          }
          if (isTaskCancelledOrPaused(taskId)) {
            return { success: false, error: 'Download cancelled or paused.' };
          }

          if (canUseNativeDepot && isV2Build) {
            downloadGogV2Depot(
              {
                taskId,
                cleanId,
                platformGameId,
                title,
                gogPlatformFlag,
                finalInstallPath: safeFinalInstallPath,
                gogToken,
                gogdlBin,
                gogAuthPath,
                platform,
                totalBytes,
                includeDlcs: payload.includeDlcs === true,
                buildsJson: buildsCheck,
              },
              options
            ).catch((/** @type {any} */ v2Err) => {
              if (v2Err && (v2Err.isPausedByUser || v2Err.isCancelledByUser)) return;
              const curTask = downloadQueueMap.get(taskId);
              if (curTask && curTask.status === 'cancelled') return;
              updateDownloadTask(
                taskId,
                {
                  status: 'failed',
                  speedBytesPerSec: 0,
                  etaSeconds: undefined,
                  error: v2Err.message,
                  statusMessage: `V2 depot installation failed: ${v2Err.message}`,
                },
                options
              );
            });
          } else if (canUseNativeDepot && isV1Build) {
            downloadGogV1Depot(
              {
                taskId,
                cleanId,
                platformGameId,
                title,
                gogPlatformFlag,
                finalInstallPath: safeFinalInstallPath,
                gogToken,
                gogdlBin,
                gogAuthPath,
                platform,
                totalBytes,
                includeDlcs: payload.includeDlcs === true,
              },
              options
            ).catch((/** @type {any} */ v1Err) => {
              if (v1Err && (v1Err.isPausedByUser || v1Err.isCancelledByUser)) return;
              const curTask = downloadQueueMap.get(taskId);
              if (curTask && curTask.status === 'cancelled') return;
              updateDownloadTask(
                taskId,
                {
                  status: 'failed',
                  speedBytesPerSec: 0,
                  etaSeconds: undefined,
                  error: v1Err.message,
                  statusMessage: `V1 depot installation failed: ${v1Err.message}`,
                },
                options
              );
            });
          } else if (gogdlBin) {
            const existingExeCheck = findPrimaryExecutable(safeFinalInstallPath, {
              platform,
              hintName: title,
              preferWindowsExecutable: platform === 'darwin' && gogPlatformFlag === 'windows',
              readOnly: true,
            });
            if (!existingExeCheck.executablePath && !payload._resumingPausedInstall) {
              clearStaleGogdlManifestCache(cleanId, options);
            }

            const gogLocale = resolveHostLocaleInfo(options).gogLocale || 'en-US';
            const gogArgs = [
              '--auth-config-path',
              gogAuthPath,
              'download',
              cleanId,
              '--platform',
              gogPlatformFlag,
              '--path',
              safeFinalInstallPath,
              payload.includeDlcs === true ? '--with-dlcs' : '--skip-dlcs',
              '--lang',
              gogLocale,
            ];
            if (typeof options.spawnFn !== 'function' && !options.homedir) {
              gogArgs.push(
                '--max-workers',
                String(Math.min(6, Math.max(2, os.cpus()?.length || 4)))
              );
            }

            const spawnImpl = typeof options.spawnFn === 'function' ? options.spawnFn : spawn;
            const resolvedGogdlSpawn =
              spawnImpl === spawn
                ? resolveWindowsNodeShebangSpawn(gogdlBin, gogArgs)
                : { cmd: gogdlBin, args: gogArgs };
            const child = spawnImpl(resolvedGogdlSpawn.cmd, resolvedGogdlSpawn.args, {
              stdio: ['ignore', 'pipe', 'pipe'],
              env: { ...process.env, PYTHONUNBUFFERED: '1' },
              ...(typeof options.spawnFn !== 'function' &&
              platform !== 'win32' &&
              process.platform !== 'win32'
                ? { detached: true }
                : {}),
            });
            /** @type {any} */
            const ctrl = {
              type: 'process',
              child,
              gogV2InstallPath: safeFinalInstallPath,
              pausedByUser: false,
              cancelRequested: false,
              exitedWhilePaused: false,
              resumeInstallFn: () =>
                installGame({ ...payload, taskId, _resumingPausedInstall: true }, options),
            };
            downloadControllers.set(taskId, ctrl);

            updateDownloadTask(
              taskId,
              {
                status: 'downloading',
                statusMessage: payload._resumingPausedInstall
                  ? `Resuming ${title} via gogdl...`
                  : 'Initializing GOG depot & verifying manifest via gogdl...',
              },
              options
            );

            const gogParser = createGogdlProgressParser({ taskId, options });
            let childSettled = false;

            // P0-12: Immediate error listener so ENOENT / EACCES / Gatekeeper errors fail cleanly
            if (child && typeof child.on === 'function') {
              child.on('error', (/** @type {any} */ spawnErr) => {
                if (childSettled) return;
                childSettled = true;
                const currentTask = downloadQueueMap.get(taskId);
                if (ctrl.pausedByUser || (currentTask && currentTask.status === 'paused')) {
                  ctrl.exitedWhilePaused = true;
                  ctrl.child = null;
                  return;
                }
                downloadControllers.delete(taskId);
                if (ctrl.cancelRequested || (currentTask && currentTask.status === 'cancelled')) {
                  return;
                }
                const errMsg = spawnErr?.message || String(spawnErr || 'gogdl process failed');
                diagLog.warn('installGame.gogdlSpawnError', spawnErr, {
                  taskId,
                  cleanId,
                });
                updateDownloadTask(
                  taskId,
                  {
                    status: 'failed',
                    speedBytesPerSec: 0,
                    etaSeconds: undefined,
                    error: errMsg,
                    statusMessage: `Failed to start gogdl: ${errMsg}`,
                  },
                  options
                );
              });
            }

            if (child.stdout) child.stdout.on('data', gogParser.onStdout);
            if (child.stderr) child.stderr.on('data', gogParser.onStderr);
            child.on('exit', async (/** @type {number | null} */ code) => {
              if (childSettled) return;
              childSettled = true;
              gogParser.flush();
              const { lastErrorLine, gogReportedDiskSizeBytes } = gogParser.getState();

              const currentTask = downloadQueueMap.get(taskId);
              if (ctrl.pausedByUser || (currentTask && currentTask.status === 'paused')) {
                ctrl.exitedWhilePaused = true;
                ctrl.child = null;
                return;
              }
              downloadControllers.delete(taskId);
              if (ctrl.cancelRequested || (currentTask && currentTask.status === 'cancelled')) return;

              if (code === 0) {
                const targetScanDir = fs.existsSync(safeFinalInstallPath)
                  ? safeFinalInstallPath
                  : installDir;
                evictExecutableDiscoveryCacheForPath(targetScanDir);
                flattenGogNestedInstallDir(targetScanDir, cleanId);
                evictExecutableDiscoveryCacheForPath(targetScanDir);
                const exeDiscovery = findPrimaryExecutable(targetScanDir, {
                  platform,
                  hintName: title,
                  preferWindowsExecutable: platform === 'darwin' && gogPlatformFlag === 'windows',
                });

                if (!exeDiscovery.executablePath && !options.homedir && !options.skipNetwork) {
                  try {
                    await downloadGogV1Depot(
                      {
                        taskId,
                        cleanId,
                        platformGameId,
                        title,
                        gogPlatformFlag,
                        finalInstallPath: targetScanDir,
                        gogToken,
                        gogdlBin,
                        gogAuthPath,
                        platform,
                        totalBytes: currentTask?.totalBytes || totalBytes,
                        includeDlcs: payload.includeDlcs === true,
                      },
                      options
                    );
                    return;
                  } catch (/** @type {any} */ v1FallbackErr) {
                    if (
                      v1FallbackErr &&
                      (v1FallbackErr.isPausedByUser || v1FallbackErr.isCancelledByUser)
                    ) {
                      return;
                    }
                  }
                }

                const isWindowsBinaryOnMac =
                  platform === 'darwin' &&
                  (gogPlatformFlag === 'windows' || Boolean(exeDiscovery.isWindowsBinaryOnMac));

                const resolvedGogInstallSize =
                  sanitizeGameInstallSizeBytes(
                    gogReportedDiskSizeBytes || currentTask?.diskSizeBytes
                  ) ||
                  sanitizeGameInstallSizeBytes(await getDirectorySizeFastAsync(targetScanDir, 4)) ||
                  sanitizeGameInstallSizeBytes(currentTask?.totalBytes || totalBytes);

                writeManagedInstallSentinel(targetScanDir, {
                  store: 'gog',
                  gameId: cleanId || platformGameId,
                  installKind: 'gog-direct',
                });

                const gogRecord = {
                  platformId: 'gog',
                  platformGameId,
                  title,
                  installPath: targetScanDir,
                  executablePath: exeDiscovery.executablePath,
                  installSize: resolvedGogInstallSize,
                  runner: 'gogdl',
                  isWindowsBinaryOnMac,
                };

                upsertManagedInstallRecord(gogRecord, options.userDataDir);
                try {
                  syncGogFirstPartyLauncher(gogRecord, {
                    ...options,
                    alreadyFlattened: true,
                    ignoreActiveDownloadGuard: true,
                  });
                } catch {}

                updateDownloadTask(
                  taskId,
                  {
                    status: 'completed',
                    progressPercent: 100,
                    installSize: resolvedGogInstallSize,
                    finalInstallPath: targetScanDir,
                    executablePath: exeDiscovery.executablePath,
                    runner: 'gogdl',
                    isWindowsBinaryOnMac,
                    statusMessage:
                      gogPlatformFlag === 'osx'
                        ? 'Installed native macOS build via gogdl'
                        : 'Installed Windows build via gogdl',
                  },
                  options
                );
              } else {
                if (
                  !options.homedir &&
                  !options.skipNetwork &&
                  /KeyError:\s*'size'|Failed to execute script/i.test(lastErrorLine)
                ) {
                  try {
                    await downloadGogV1Depot(
                      {
                        taskId,
                        cleanId,
                        platformGameId,
                        title,
                        gogPlatformFlag,
                        finalInstallPath: safeFinalInstallPath,
                        gogToken,
                        gogdlBin,
                        gogAuthPath,
                        platform,
                        totalBytes: currentTask?.totalBytes || totalBytes,
                        includeDlcs: payload.includeDlcs === true,
                      },
                      options
                    );
                    return;
                  } catch (/** @type {any} */ v1FallbackErr) {
                    if (
                      v1FallbackErr &&
                      (v1FallbackErr.isPausedByUser || v1FallbackErr.isCancelledByUser)
                    ) {
                      return;
                    }
                  }
                }

                const errMsg = lastErrorLine || `gogdl exited with code ${code}`;
                updateDownloadTask(
                  taskId,
                  {
                    status: 'failed',
                    speedBytesPerSec: 0,
                    etaSeconds: undefined,
                    error: errMsg,
                    statusMessage: `Installation failed: ${errMsg}`,
                  },
                  options
                );
              }
            });
          } else {
            updateDownloadTask(
              taskId,
              {
                status: 'failed',
                speedBytesPerSec: 0,
                error:
                  'Unable to reach GOG Content System and no local gogdl fallback binary is available.',
                statusMessage: 'Failed to reach GOG Content System',
              },
              options
            );
          }
        } catch (/** @type {any} */ err) {
          updateDownloadTask(
            taskId,
            {
              status: 'failed',
              speedBytesPerSec: 0,
              etaSeconds: undefined,
              error: err.message,
              statusMessage: `Failed to start gogdl: ${err.message}`,
            },
            options
          );
        }
      } else if (!gogToken && !payload.downloadUrl) {
        await openExternalUri(`goggalaxy://openGameView/${encodeURIComponent(cleanId)}`, options);
        updateDownloadTask(
          taskId,
          {
            statusMessage: 'Opened in GOG Galaxy client...',
          },
          options
        );
      }
    } else if (platformId === 'xbox' || resolveAnyChainedHandoffId(platformId)) {
      const cleanStoreId =
        platformId === 'xbox'
          ? String(payload.xboxProductId || payload.storeId || platformGameId || '')
              .replace(/^xbox[-_:]/i, '')
              .trim()
              .toUpperCase()
          : '';

      const rawPayloadExternalUrl =
        typeof payload.externalLauncherUrl === 'string' ? payload.externalLauncherUrl.trim() : '';
      const validatedPayloadExternalUrl = validateTrustedExternalLauncherUrl(rawPayloadExternalUrl);
      if (rawPayloadExternalUrl && !validatedPayloadExternalUrl) {
        const untrustedErr =
          'Rejected untrusted externalLauncherUrl: must use HTTPS on an allowlisted official publisher domain.';
        updateDownloadTask(
          taskId,
          {
            status: 'failed',
            speedBytesPerSec: 0,
            etaSeconds: undefined,
            error: untrustedErr,
            statusMessage: `Xbox installation failed: ${untrustedErr}`,
          },
          options
        );
        return {
          success: false,
          error: untrustedErr,
        };
      }

      /** @type {any} */
      let preResolvedDeliveryInfo = payload.deliveryInfo || options.mockXboxDeliveryInfo || null;
      /** @type {any} */
      let preResolveError = null;

      const needsDeliveryPreResolve =
        platformId === 'xbox' &&
        !validatedPayloadExternalUrl &&
        !payload.msixvcPath &&
        (!Array.isArray(payload.downloadUrls) || payload.downloadUrls.length === 0) &&
        !preResolvedDeliveryInfo &&
        (platform === 'darwin' ||
          !options.skipNetwork ||
          typeof options.xboxPackageDeliveryResolver === 'function' ||
          typeof options.resolveXboxDeliveryFn === 'function');

      if (needsDeliveryPreResolve) {
        const userDataDir = getUserDataDir(options.userDataDir);
        const xboxMods = getXboxStorefrontModules();
        const activeStoreSync = options.storeSync || storeSync;
        const authProvider =
          options.xboxAuthProvider ||
          (activeStoreSync && typeof activeStoreSync.getXboxAuthProvider === 'function'
            ? activeStoreSync.getXboxAuthProvider({ userDataDir })
            : null);
        const resolveFn =
          options.xboxPackageDeliveryResolver ||
          options.resolveXboxDeliveryFn ||
          xboxMods?.resolveXboxPackageDeliveryInfo;
        if (typeof resolveFn === 'function') {
          try {
            preResolvedDeliveryInfo = await resolveFn({
              storeId: cleanStoreId,
              contentId: payload.contentId || payload.xboxDeliveryHints?.contentId,
              wuCategoryId: payload.wuCategoryId || payload.xboxDeliveryHints?.wuCategoryId,
              authProvider,
              userDataDir,
              fetchImpl: options.fetchImpl,
            });
          } catch (resolveErr) {
            preResolveError = resolveErr;
          }
        } else {
          preResolveError = new Error('Xbox package delivery resolver is unavailable.');
        }

        if (
          !preResolvedDeliveryInfo &&
          typeof xboxMods?.fetchXboxProductMetadata === 'function' &&
          !options.skipNetwork
        ) {
          try {
            const meta = await xboxMods.fetchXboxProductMetadata(
              { xboxProductId: cleanStoreId, userDataDir },
              { userDataDir, fetchImpl: options.fetchImpl }
            );
            if (meta) {
              preResolvedDeliveryInfo = {
                storeId: meta.xboxProductId || cleanStoreId,
                contentId: meta.contentId,
                wuCategoryId: meta.wuCategoryId,
                packageFamilyName: meta.packageFamilyName,
                packageFullName: meta.packageFullName,
                maxDownloadSizeBytes: meta.maxDownloadSizeBytes,
                pcMaxInstallSizeBytes: meta.pcMaxInstallSizeBytes,
                isExternalLauncherStubPackage: Boolean(meta.isExternalLauncherStubPackage),
                isCrossPlatformLauncherRuntime: Boolean(meta.isCrossPlatformLauncherRuntime),
                externalLauncher: meta.externalLauncher,
                externalLauncherUrl: meta.externalLauncherUrl,
                externalStorefrontHandoff: meta.externalStorefrontHandoff,
                downloadUrls: [],
              };
              preResolveError = null;
            }
          } catch {}
        }
        if (isTaskCancelledOrPaused(taskId)) {
          return { success: false, error: 'Download cancelled or paused.' };
        }
      }

      const validatedDeliveryExternalUrl = validateTrustedExternalLauncherUrl(
        preResolvedDeliveryInfo?.externalLauncherUrl || ''
      );

      const isExternalLauncherStubPkg = Boolean(
        payload.isExternalLauncherStubPackage === true ||
          preResolvedDeliveryInfo?.isExternalLauncherStubPackage === true
      );

      let chainedHandoffId = resolveAnyChainedHandoffId(
        payload.chainedLauncherHandoff ||
          payload.chainedRequiresLauncherHandoff ||
          payload.externalStorefrontHandoff ||
          preResolvedDeliveryInfo?.chainedLauncherHandoff ||
          preResolvedDeliveryInfo?.chainedRequiresLauncherHandoff ||
          preResolvedDeliveryInfo?.externalStorefrontHandoff ||
          (isExternalLauncherStubPkg
            ? preResolvedDeliveryInfo?.externalLauncher || payload.externalLauncher || ''
            : '') ||
          (platformId !== 'xbox' ? platformId : '')
      );
      if (
        !chainedHandoffId &&
        (payload.installerId === 'xbox-chained-bottle-launcher' ||
          payload.installerId === 'xbox-chained-win-launcher' ||
          payload.installerId === 'xbox-chained-host-launcher')
      ) {
        chainedHandoffId = resolveAnyChainedHandoffId(payload.externalLauncher || '');
      }
      const isChainedInstallFlow = Boolean(
        chainedHandoffId ||
          payload.installerId === 'xbox-chained-bottle-launcher' ||
          payload.installerId === 'xbox-chained-win-launcher' ||
          payload.installerId === 'xbox-chained-host-launcher'
      );

      const externalLauncherUrl = isChainedInstallFlow
        ? ''
        : preResolvedDeliveryInfo?.isCrossPlatformLauncherRuntime === true ||
            (isExternalLauncherStubPkg &&
              !chainedHandoffId &&
              Boolean(validatedPayloadExternalUrl || validatedDeliveryExternalUrl))
          ? validatedPayloadExternalUrl || validatedDeliveryExternalUrl
          : platform === 'darwin' &&
              payload.installerId === 'xbox-external-mac-launcher' &&
              !chainedHandoffId
            ? validatedPayloadExternalUrl ||
              (!/ubisoft|ea\.com|battle\.net|blizzard\.com|riotgames|rockstargames/i.test(
                validatedDeliveryExternalUrl
              )
                ? validatedDeliveryExternalUrl
                : '')
            : '';

      if (isChainedInstallFlow) {
        return await executeChainedPublisherInstallFlow(
          {
            taskId,
            task,
            payload,
            platform,
            platformId,
            platformGameId,
            title,
            cleanStoreId,
            chainedHandoffId,
            chainedHandoffTopology:
              payload.chainedHandoffTopology ||
              (platformId === 'xbox' ? 'publisher_managed' : undefined),
          },
          options
        );
      }

      const explicitlyRequestedClientless =
        payload.installerId === 'xbox-msixvc-win' ||
        payload.preferClientlessExtraction === true ||
        options.preferClientlessExtraction === true ||
        Boolean(payload.msixvcPath);
      const explicitlyRequestedGamingServices =
        !explicitlyRequestedClientless &&
        (payload.installerId === 'xbox-win-gamingservices' ||
          payload.preferClientlessExtraction === false);

      const useDirectMsixvcExtractor =
        !externalLauncherUrl &&
        (platform === 'darwin'
          ? payload.installerId !== 'xbox-external-mac-launcher'
          : explicitlyRequestedClientless ||
            (!explicitlyRequestedGamingServices &&
              (options.hasGamingServices === false ||
                (!options.homedir && !hasWindowsGamingServicesInstalled(options)))));

      if (externalLauncherUrl) {
        const resolvedExternalLauncher =
          String(
            preResolvedDeliveryInfo?.externalLauncher ||
              payload.externalLauncher ||
              'External Launcher'
          ).trim() || 'External Launcher';
        await openExternalUri(externalLauncherUrl, options);
        const handoffMessage = `Opened ${resolvedExternalLauncher} download for ${title}...`;
        updateDownloadTask(
          taskId,
          {
            speedBytesPerSec: 0,
            etaSeconds: undefined,
            statusMessage: handoffMessage,
          },
          options
        );
        const latestHandoffTask = downloadQueueMap.get(taskId) || task;
        const publicHandoffTask = toPublicDownloadTask(latestHandoffTask);
        downloadControllers.delete(taskId);
        downloadQueueMap.delete(taskId);
        if (!isSimulatedOrManual) {
          persistDownloadQueueToDisk(options.userDataDir || task._persistedUserDataDir);
        }
        emitDownloadUpdated({
          task: { ...publicHandoffTask },
          queue: getDownloadQueue(options),
        });
        return {
          success: true,
          status: 'external_handoff',
          externalLauncher: resolvedExternalLauncher,
          externalUri: externalLauncherUrl,
          message: handoffMessage,
          task: { ...publicHandoffTask },
        };
      } else if (platform === 'darwin' && payload.installerId === 'xbox-external-mac-launcher') {
        const errMsg = `No trusted HTTPS external launcher download URL resolved for ${title} (${cleanStoreId || 'unknown'}).`;
        updateDownloadTask(
          taskId,
          {
            status: 'failed',
            speedBytesPerSec: 0,
            etaSeconds: undefined,
            error: errMsg,
            statusMessage: `Xbox installation failed: ${errMsg}`,
          },
          options
        );
        return {
          success: false,
          error: errMsg,
        };
      } else if (useDirectMsixvcExtractor) {
        const controller = new AbortController();
        /** @type {any} */
        const ctrl = {
          type: 'abort',
          controller,
          xboxInstallPath: finalInstallPath,
          pausedByUser: false,
          cancelRequested: false,
          exitedWhilePaused: false,
          resumeInstallFn: () =>
            installGame({ ...payload, taskId, _resumingPausedInstall: true }, options),
        };
        downloadControllers.set(taskId, ctrl);

        (async () => {
          try {
            const userDataDir = getUserDataDir(options.userDataDir);
            const xboxMods = getXboxStorefrontModules();
            const activeStoreSync = options.storeSync || storeSync;
            const authProvider =
              options.xboxAuthProvider ||
              (activeStoreSync && typeof activeStoreSync.getXboxAuthProvider === 'function'
                ? activeStoreSync.getXboxAuthProvider({ userDataDir })
                : null);

            updateDownloadTask(
              taskId,
              {
                status: 'downloading',
                statusMessage: payload._resumingPausedInstall
                  ? `Resuming Xbox MSIXVC package for ${title}...`
                  : `Resolving Xbox package delivery & license keys for ${title}...`,
              },
              options
            );

            let deliveryInfo =
              preResolvedDeliveryInfo ||
              payload.deliveryInfo ||
              options.mockXboxDeliveryInfo ||
              null;
            if (!deliveryInfo && !payload.msixvcPath) {
              if (preResolveError) {
                throw preResolveError;
              }
              const resolveFn =
                options.xboxPackageDeliveryResolver ||
                options.resolveXboxDeliveryFn ||
                xboxMods?.resolveXboxPackageDeliveryInfo;
              if (typeof resolveFn !== 'function') {
                throw new Error('Xbox package delivery resolver is unavailable.');
              }
              deliveryInfo = await resolveFn({
                storeId: cleanStoreId,
                contentId: payload.contentId || payload.xboxDeliveryHints?.contentId,
                wuCategoryId: payload.wuCategoryId || payload.xboxDeliveryHints?.wuCategoryId,
                authProvider,
                userDataDir,
                fetchImpl: options.fetchImpl,
              });
            }
            if (isTaskCancelledOrPaused(taskId, ctrl)) return;

            const downloadUrls = Array.isArray(payload.downloadUrls)
              ? payload.downloadUrls
              : Array.isArray(deliveryInfo?.downloadUrls)
                ? deliveryInfo.downloadUrls
                : [];
            if (
              !payload.msixvcPath &&
              (downloadUrls.length === 0 || deliveryInfo?.isExternalLauncherStubPackage === true)
            ) {
              const deferredChainedHandoffId = resolveAnyChainedHandoffId(
                deliveryInfo?.externalStorefrontHandoff ||
                  deliveryInfo?.chainedLauncherHandoff ||
                  deliveryInfo?.chainedRequiresLauncherHandoff ||
                  deliveryInfo?.externalLauncher ||
                  payload.externalLauncher
              );
              if (deferredChainedHandoffId) {
                downloadControllers.delete(taskId);
                await installGame(
                  {
                    ...payload,
                    taskId,
                    isExternalLauncherStubPackage: Boolean(
                      deliveryInfo?.isExternalLauncherStubPackage
                    ),
                    externalStorefrontHandoff: deferredChainedHandoffId,
                    chainedLauncherHandoff: deferredChainedHandoffId,
                    installerId:
                      platform === 'darwin'
                        ? 'xbox-chained-bottle-launcher'
                        : 'xbox-chained-win-launcher',
                  },
                  options
                );
                return;
              }

              const candidateFallbackUrl = validateTrustedExternalLauncherUrl(
                deliveryInfo?.externalLauncherUrl || ''
              );
              const isPublisherWebUrl =
                /ubisoft|ea\.com|battle\.net|blizzard\.com|riotgames|rockstargames/i.test(
                  candidateFallbackUrl
                );
              const fallbackHandoffUrl =
                platform === 'darwin' &&
                candidateFallbackUrl &&
                (deliveryInfo?.isCrossPlatformLauncherRuntime === true || !isPublisherWebUrl)
                  ? candidateFallbackUrl
                  : '';
              if (fallbackHandoffUrl) {
                const fallbackLauncher =
                  String(
                    deliveryInfo?.externalLauncher ||
                      payload.externalLauncher ||
                      'External Launcher'
                  ).trim() || 'External Launcher';
                await openExternalUri(fallbackHandoffUrl, options);
                downloadControllers.delete(taskId);
                updateDownloadTask(
                  taskId,
                  {
                    speedBytesPerSec: 0,
                    etaSeconds: undefined,
                    statusMessage: `Opened ${fallbackLauncher} download for ${title}...`,
                  },
                  options
                );
                downloadQueueMap.delete(taskId);
                if (!isSimulatedOrManual) {
                  persistDownloadQueueToDisk(options.userDataDir || task._persistedUserDataDir);
                }
                return;
              }
              throw new Error(
                `No MSIXVC download URL resolved for ${title} (${cleanStoreId || 'unknown'}). Ensure your Xbox / Game Pass account has an active entitlement.`
              );
            }

            const requiredBytes = Number(
              deliveryInfo?.maxDownloadSizeBytes || totalBytes || 0
            );
            if (requiredBytes > 0) {
              const ds = await getDiskSpace(installDir, options);
              if (isTaskCancelledOrPaused(taskId, ctrl)) return;
              if (
                ds &&
                typeof ds.freeBytes === 'number' &&
                ds.freeBytes > 0 &&
                ds.freeBytes < requiredBytes + 512 * 1024 * 1024
              ) {
                /** @type {any} */
                const spaceErr = new Error(
                  `Insufficient disk space in ${installDir} (need ${Math.ceil((requiredBytes + 512 * 1024 * 1024) / (1024 * 1024 * 1024))} GB free).`
                );
                spaceErr.code = 'ENOSPC';
                throw spaceErr;
              }
            }

            let deviceContext = options.xboxDeviceContext || null;
            let cik = payload.cik || options.xboxCik || null;
            /** @type {any} */
            let cikMap = payload.cikMap || options.xboxCikMap || null;

            let missingStoreLicensingTicket = false;
            /** @type {any} */
            let lastCikError = null;
            const resolvedContentId = String(
              payload.contentId || deliveryInfo?.contentId || ''
            ).trim();
            if (!cik && resolvedContentId && authProvider) {
              const recoverXboxLicenseFn =
                options.xboxStoreLicenseRecoveryHook !== undefined
                  ? options.xboxStoreLicenseRecoveryHook
                  : getXboxStoreLicenseRecoveryHook();
              let ranInteractiveLicenseRecovery = false;

              const runInteractiveStoreLicenseRecovery = async () => {
                if (
                  ranInteractiveLicenseRecovery ||
                  typeof recoverXboxLicenseFn !== 'function' ||
                  ctrl.cancelRequested ||
                  ctrl.pausedByUser
                ) {
                  return false;
                }
                ranInteractiveLicenseRecovery = true;
                updateDownloadTask(
                  taskId,
                  {
                    statusMessage:
                      'Sign in once in the Microsoft window to authorize game decryption...',
                  },
                  options
                );
                const recRes = await recoverXboxLicenseFn({
                  gameId,
                  cleanStoreId,
                  title,
                  contentId: resolvedContentId,
                  userDataDir,
                });
                if (!ctrl.cancelRequested && !ctrl.pausedByUser) {
                  updateDownloadTask(
                    taskId,
                    {
                      statusMessage: 'Acquiring Microsoft Store content license...',
                    },
                    options
                  );
                }
                return Boolean(recRes?.recovered);
              };

              try {
                let storeMsaToken =
                  typeof authProvider.getStoreMsaToken === 'function'
                    ? await authProvider.getStoreMsaToken({ forLicensing: true })
                    : null;
                if (isTaskCancelledOrPaused(taskId, ctrl)) return;

                if (!storeMsaToken && typeof recoverXboxLicenseFn === 'function') {
                  await runInteractiveStoreLicenseRecovery();
                  if (ctrl.pausedByUser || ctrl.cancelRequested) return;
                  storeMsaToken =
                    typeof authProvider.getStoreMsaToken === 'function'
                      ? await authProvider.getStoreMsaToken({ forLicensing: true })
                      : null;
                }

                if (!deviceContext && typeof authProvider.ensureDeviceContext === 'function') {
                  deviceContext = await authProvider.ensureDeviceContext();
                }
                if (isTaskCancelledOrPaused(taskId, ctrl)) return;

                if (!storeMsaToken) {
                  missingStoreLicensingTicket = true;
                }

                const acquireCikFn = options.acquireContentCikFn || xboxMods?.acquireContentCik;
                const applyCikResult = (/** @type {any} */ cikRes) => {
                  if (!cikRes) return;
                  cik = cikRes.cikBuffer || cikRes.cikHex || null;
                  if (Array.isArray(cikRes.keys) && cikRes.keys.length > 0) {
                    cikMap = {};
                    for (const k of cikRes.keys) {
                      if (k.keyId && (k.cikBuffer || k.cikHex)) {
                        cikMap[String(k.keyId).toLowerCase()] = k.cikBuffer || k.cikHex;
                      }
                    }
                  }
                };

                const invokeAcquireCik = async (/** @type {string} */ msaTicket) => {
                  const savedXboxVault =
                    typeof storeSync?.loadSavedTokens === 'function'
                      ? storeSync.loadSavedTokens(userDataDir ? { userDataDir } : undefined)?.xbox
                      : null;
                  return acquireCikFn({
                    contentId: resolvedContentId,
                    msaStoreToken: msaTicket,
                    localTicketReference: savedXboxVault?.msaPuid || undefined,
                    deviceContext,
                    packageFullNames: deliveryInfo?.packageFullName
                      ? [deliveryInfo.packageFullName]
                      : [],
                    satisfyingEntitlementKeys: deliveryInfo?.satisfyingEntitlementKeys || [],
                    fetchImpl: options.fetchImpl,
                  });
                };

                if (storeMsaToken && deviceContext && typeof acquireCikFn === 'function') {
                  try {
                    const cikRes = await invokeAcquireCik(storeMsaToken);
                    applyCikResult(cikRes);
                  } catch (/** @type {any} */ firstCikErr) {
                    const errStatus = Number(firstCikErr?.status || 0);
                    const errMsg =
                      firstCikErr instanceof Error ? firstCikErr.message : String(firstCikErr);
                    const isAuthTicketError =
                      errStatus === 401 ||
                      /InvalidMsaTicket|Unauthorized|ticket|401/i.test(errMsg);
                    if (!isAuthTicketError) {
                      throw firstCikErr;
                    }

                    storeMsaToken =
                      typeof authProvider.getStoreMsaToken === 'function'
                        ? await authProvider.getStoreMsaToken({
                            forLicensing: true,
                            forceRefresh: true,
                          })
                        : null;

                    if (!storeMsaToken && typeof recoverXboxLicenseFn === 'function') {
                      await runInteractiveStoreLicenseRecovery();
                      if (ctrl.pausedByUser || ctrl.cancelRequested) return;
                      storeMsaToken =
                        typeof authProvider.getStoreMsaToken === 'function'
                          ? await authProvider.getStoreMsaToken({ forLicensing: true })
                          : null;
                    }

                    if (typeof authProvider.ensureDeviceContext === 'function') {
                      deviceContext = await authProvider.ensureDeviceContext({
                        forceRefresh: true,
                      });
                    }

                    if (!storeMsaToken) {
                      missingStoreLicensingTicket = true;
                      throw firstCikErr;
                    }

                    try {
                      const retryCikRes = await invokeAcquireCik(storeMsaToken);
                      applyCikResult(retryCikRes);
                    } catch (secondCikErr) {
                      if (
                        !ranInteractiveLicenseRecovery &&
                        typeof recoverXboxLicenseFn === 'function'
                      ) {
                        const recovered = await runInteractiveStoreLicenseRecovery();
                        if (ctrl.pausedByUser || ctrl.cancelRequested) return;
                        if (recovered && typeof authProvider.getStoreMsaToken === 'function') {
                          storeMsaToken = await authProvider.getStoreMsaToken({
                            forLicensing: true,
                          });
                          if (storeMsaToken) {
                            const finalCikRes = await invokeAcquireCik(storeMsaToken);
                            applyCikResult(finalCikRes);
                          }
                        } else {
                          throw secondCikErr;
                        }
                      } else {
                        throw secondCikErr;
                      }
                    }
                  }
                  if (!cik && (!cikMap || Object.keys(cikMap).length === 0)) {
                    throw new Error('Microsoft Store returned an empty content license key.');
                  }
                } else if (storeMsaToken && !deviceContext) {
                  throw new Error('Microsoft Store device license context is unavailable.');
                }
              } catch (cikErr) {
                lastCikError = cikErr;
                diagLog.warn('installGame.xboxAcquireCik', cikErr, {
                  gameId,
                  cleanStoreId,
                  contentId: resolvedContentId,
                });
              }
            }

            if (isTaskCancelledOrPaused(taskId, ctrl)) return;

            const installPathExistedBefore = fs.existsSync(finalInstallPath);

            if (
              !payload.msixvcPath &&
              !cik &&
              (!cikMap || Object.keys(cikMap).length === 0) &&
              resolvedContentId &&
              (missingStoreLicensingTicket || lastCikError)
            ) {
              if (missingStoreLicensingTicket) {
                throw new Error(
                  `Microsoft Store content license authorization was cancelled or incomplete for ${title}. Retry the download or reconnect Xbox in Settings -> Integrations to authorize Store decryption.`
                );
              }
              const cikErrMsg =
                lastCikError instanceof Error ? lastCikError.message : String(lastCikError);
              throw new Error(
                `Microsoft Store content license check failed for ${title}: ${cikErrMsg}`
              );
            }

            await fs.promises.mkdir(toHostFilesystemPath(finalInstallPath), { recursive: true });
            if (isTaskCancelledOrPaused(taskId, ctrl)) return;

            const extractFn =
              options.extractMsixvcFn ||
              xboxMods?.extractMsixvcInWorker ||
              xboxMods?.extractMsixvcStream;
            if (typeof extractFn !== 'function') {
              if (!installPathExistedBefore) {
                await safeRemovePartialInstallDirAsync(finalInstallPath, installDir, options);
              }
              throw new Error('Xbox MSIXVC streaming extractor is unavailable.');
            }

            let lastProgressAt = Date.now();
            let lastProgressBytes = 0;

            /** @type {any} */
            let extractResult;
            try {
              extractResult = await extractFn({
                installDir: finalInstallPath,
                msixvcPath: payload.msixvcPath || undefined,
                urls: downloadUrls,
                fileName: deliveryInfo?.fileName || undefined,
                cik,
                cikMap,
                deviceKey: deviceContext?.deviceKeyBuffer || undefined,
                keepResumeJournal: false,
                signal: controller.signal,
                onProgress: (/** @type {any} */ prog) => {
                  if (!prog || ctrl.pausedByUser || ctrl.cancelRequested) return;
                  const curTask = downloadQueueMap.get(taskId);
                  if (!curTask || ['paused', 'cancelled', 'completed'].includes(curTask.status)) {
                    return;
                  }
                  const now = Date.now();
                  const dlBytes = Math.max(0, Number(prog.bytesDownloaded || 0));
                  const totBytes = Math.max(
                    dlBytes,
                    Number(prog.totalBytes || curTask.totalBytes || totalBytes || 0)
                  );
                  const elapsedSec = Math.max(0.05, (now - lastProgressAt) / 1000);
                  const rawInstSpeed =
                    Number(prog.speedBytesPerSec || 0) ||
                    (dlBytes > lastProgressBytes
                      ? Math.round((dlBytes - lastProgressBytes) / elapsedSec)
                      : 0);
                  lastProgressAt = now;
                  lastProgressBytes = dlBytes;

                  const smoothedSpeed = computeSmoothedDownloadSpeed(taskId, {
                    bytesDownloaded: dlBytes,
                    rawSpeedBytesPerSec: rawInstSpeed,
                    nowMs: now,
                  });
                  const pct =
                    prog.progressPercent !== undefined
                      ? Math.min(99, Math.max(0, Math.round(Number(prog.progressPercent))))
                      : totBytes > 0
                        ? Math.min(99, Math.round((dlBytes / totBytes) * 100))
                        : 0;
                  const etaSeconds =
                    smoothedSpeed > 0 && totBytes > dlBytes
                      ? Math.max(1, Math.round((totBytes - dlBytes) / smoothedSpeed))
                      : undefined;

                  updateDownloadTask(
                    taskId,
                    {
                      status: prog.phase === 'finalizing' ? 'extracting' : 'downloading',
                      progressPercent: pct,
                      bytesDownloaded: dlBytes,
                      totalBytes: totBytes,
                      speedBytesPerSec: smoothedSpeed,
                      etaSeconds,
                      statusMessage:
                        prog.message || `Decrypting & streaming ${title} (${pct}%)...`,
                    },
                    options
                  );
                },
              });
            } catch (extractErr) {
              if (!ctrl.pausedByUser && !installPathExistedBefore) {
                const hasCompletedReceipt = (() => {
                  for (const rName of [
                    '.onelauncher-xbox-receipt.json',
                    '.onelauncher-xbox-install.json',
                  ]) {
                    const rp = path.join(finalInstallPath, rName);
                    if (!fs.existsSync(rp)) continue;
                    try {
                      if (JSON.parse(fs.readFileSync(rp, 'utf8'))?.status === 'completed') {
                        return true;
                      }
                    } catch {}
                  }
                  return false;
                })();
                const hasCompletedJournalFiles = (() => {
                  for (const jName of [
                    '.onelauncher-xbox-journal.json',
                    '.onelauncher-xbox-install.json',
                  ]) {
                    const jp = path.join(finalInstallPath, jName);
                    if (!fs.existsSync(jp)) continue;
                    try {
                      const cf = JSON.parse(fs.readFileSync(jp, 'utf8'))?.completedFiles;
                      if (Array.isArray(cf) && cf.length > 0) return true;
                      if (cf && typeof cf === 'object' && Object.keys(cf).length > 0) return true;
                    } catch {}
                  }
                  return false;
                })();
                if (!hasCompletedReceipt && !hasCompletedJournalFiles) {
                  await safeRemovePartialInstallDirAsync(finalInstallPath, installDir, options);
                }
              }

              const rawMsg = extractErr instanceof Error ? extractErr.message : String(extractErr);
              if (/CIK|encrypted|decrypt/i.test(rawMsg)) {
                if (missingStoreLicensingTicket) {
                  throw new Error(
                    `Microsoft Store content license authorization was cancelled or incomplete for ${title}. Retry the download or reconnect Xbox in Settings -> Integrations to authorize Store decryption.`
                  );
                }
                if (lastCikError) {
                  const cikErrMsg =
                    lastCikError instanceof Error ? lastCikError.message : String(lastCikError);
                  throw new Error(
                    `Microsoft Store content license check failed for ${title}: ${cikErrMsg}`
                  );
                }
              }
              throw extractErr;
            }

            if (ctrl.pausedByUser || ctrl.cancelRequested) return;
            downloadControllers.delete(taskId);

            const extractedGameCfg = inspectMicrosoftGameConfig(finalInstallPath);
            // Enforce strict root containment on MicrosoftGame.config primaryExecutable and extractResult.primaryExecutablePath
            const cfgPrimaryExe = extractedGameCfg?.primaryExecutable
              ? resolveContainedExecutablePath(
                  extractedGameCfg.contentRootDir || finalInstallPath,
                  extractedGameCfg.primaryExecutable
                )
              : '';
            const containedCfgPrimaryExe =
              cfgPrimaryExe && isContainedWithinRoot(finalInstallPath, cfgPrimaryExe)
                ? cfgPrimaryExe
                : '';
            const containedExtractResultExe = extractResult?.primaryExecutablePath
              ? resolveContainedExecutablePath(
                  finalInstallPath,
                  extractResult.primaryExecutablePath
                )
              : '';
            const resolvedPrimaryExe =
              containedCfgPrimaryExe ||
              containedExtractResultExe ||
              findPrimaryExecutable(finalInstallPath, {
                platform,
                hintName: title,
                preferWindowsExecutable: true,
              }).executablePath;

            const resolvedPfn =
              extractedGameCfg?.packageFamilyName ||
              deliveryInfo?.packageFamilyName ||
              payload.packageFamilyName ||
              undefined;
            const resolvedTitleId =
              extractedGameCfg?.titleId || deliveryInfo?.xboxTitleId || undefined;
            const resolvedScid =
              extractedGameCfg?.scid ||
              (resolvedTitleId ? deriveDefaultScidFromTitleId(resolvedTitleId) : undefined);
            const resolvedMsaAppId =
              extractedGameCfg?.msaAppId || deliveryInfo?.msaAppId || undefined;
            const resolvedAumid = extractedGameCfg?.appUserModelId || undefined;
            const resolvedInstallBytes =
              sanitizeGameInstallSizeBytes(extractResult?.totalBytes) ||
              sanitizeGameInstallSizeBytes(await getDirectorySizeFastAsync(finalInstallPath, 4)) ||
              totalBytes;

            const receiptData = {
              schemaVersion: 1,
              status: 'completed',
              xboxProductId: cleanStoreId || undefined,
              title: extractedGameCfg?.displayName || title,
              packageFamilyName: resolvedPfn,
              packageFullName: deliveryInfo?.packageFullName || undefined,
              appUserModelId: resolvedAumid,
              xboxTitleId: resolvedTitleId,
              scid: resolvedScid,
              msaAppId: resolvedMsaAppId,
              contentId: resolvedContentId || extractResult?.contentId || undefined,
              executableRelPath: resolvedPrimaryExe
                ? path.relative(finalInstallPath, resolvedPrimaryExe).replace(/\\/g, '/')
                : undefined,
              installSizeBytes: resolvedInstallBytes,
              version: extractedGameCfg?.version || undefined,
              installedAt: new Date().toISOString(),
            };
            const serializedReceipt = JSON.stringify(receiptData, null, 2);
            atomicWriteFileSync(
              path.join(finalInstallPath, '.onelauncher-xbox-receipt.json'),
              serializedReceipt
            );
            atomicWriteFileSync(
              path.join(finalInstallPath, '.onelauncher-xbox-install.json'),
              serializedReceipt
            );
            writeManagedInstallSentinel(finalInstallPath, {
              store: 'xbox',
              gameId: cleanStoreId || platformGameId,
              installKind: platform === 'darwin' ? 'xbox-msixvc-mac' : 'xbox-msixvc-win',
            });
            unlinkRegularFileSyncSafe(
              path.join(finalInstallPath, '.onelauncher-xbox-journal.json'),
              finalInstallPath
            );

            const runnerName = platform === 'darwin' ? 'xbox_xgr' : 'xbox';
            upsertManagedInstallRecord(
              {
                platformId: 'xbox',
                platformGameId: cleanStoreId || platformGameId,
                xboxProductId: cleanStoreId || undefined,
                packageFamilyName: resolvedPfn,
                appUserModelId: resolvedAumid,
                xboxTitleId: resolvedTitleId,
                scid: resolvedScid,
                msaAppId: resolvedMsaAppId,
                title: extractedGameCfg?.displayName || title,
                installPath: finalInstallPath,
                executablePath: resolvedPrimaryExe,
                installSize: resolvedInstallBytes,
                version: extractedGameCfg?.version || undefined,
                runner: runnerName,
                isWindowsBinaryOnMac: platform === 'darwin',
                isClientlessXboxInstall: true,
              },
              options.userDataDir
            );
            invalidateScanCaches();

            updateDownloadTask(
              taskId,
              {
                status: 'completed',
                progressPercent: 100,
                bytesDownloaded: resolvedInstallBytes,
                totalBytes: resolvedInstallBytes,
                speedBytesPerSec: 0,
                etaSeconds: undefined,
                platformGameId: cleanStoreId || platformGameId,
                xboxProductId: cleanStoreId || undefined,
                packageFamilyName: resolvedPfn,
                appUserModelId: resolvedAumid,
                xboxTitleId: resolvedTitleId,
                scid: resolvedScid,
                msaAppId: resolvedMsaAppId,
                version: extractedGameCfg?.version || undefined,
                finalInstallPath,
                executablePath: resolvedPrimaryExe,
                runner: runnerName,
                isWindowsBinaryOnMac: platform === 'darwin',
                isClientlessXboxInstall: true,
                statusMessage:
                  platform === 'darwin'
                    ? 'Installed Xbox Windows build via MSIXVC streaming extractor'
                    : 'Installed Xbox build via direct MSIXVC streaming extractor',
              },
              options
            );
          } catch (/** @type {any} */ xboxDlErr) {
            const curTask = downloadQueueMap.get(taskId);
            if (
              ctrl.pausedByUser ||
              (curTask && curTask.status === 'paused') ||
              (xboxDlErr && xboxDlErr.name === 'AbortError' && !ctrl.cancelRequested)
            ) {
              ctrl.exitedWhilePaused = true;
              return;
            }
            downloadControllers.delete(taskId);
            if (ctrl.cancelRequested || (curTask && curTask.status === 'cancelled')) {
              return;
            }
            const errMsg = xboxDlErr?.message || String(xboxDlErr);
            updateDownloadTask(
              taskId,
              {
                status: 'failed',
                speedBytesPerSec: 0,
                etaSeconds: undefined,
                error: errMsg,
                statusMessage: `Xbox installation failed: ${errMsg}`,
              },
              options
            );
          }
        })();
      } else {
        const xboxClientBin = resolveXboxClientBinaryPath(options);
        const installUri = xboxClientBin
          ? `msxbox://game/?productId=${encodeURIComponent(cleanStoreId || platformGameId)}`
          : `ms-windows-store://pdp/?ProductId=${encodeURIComponent(cleanStoreId || platformGameId)}`;

        await openExternalUri(installUri, options);
        updateDownloadTask(
          taskId,
          {
            statusMessage: xboxClientBin
              ? 'Installing via Xbox GamingServices (monitoring XboxGames & Appx registration)...'
              : 'Opened in Microsoft Store (monitoring XboxGames & Appx registration)...',
          },
          options
        );

        if (!options.disableXboxMonitor) {
          startXboxInstallMonitor(taskId, { ...payload, cleanStoreId }, options);
        }
      }
    }

    const latestTask = downloadQueueMap.get(taskId) || task;
    return {
      success: true,
      message: `Started installation for ${title}`,
      task: toPublicDownloadTask(latestTask),
    };
  } catch (/** @type {any} */ err) {
    return {
      success: false,
      error: err.message,
    };
  } finally {
    if (acquiredDedupKey) {
      inFlightInstallKeys.delete(acquiredDedupKey);
    }
  }
}

/**
 * Serialize per-`taskId` `pauseDownload` / `resumeDownload` / `cancelDownload` async subprocess
 * transitions so `resumeDownload` never races a still-exiting paused CLI downloader and
 * `cancelDownload` never leaves a resumed process orphaned.
 *
 * @param {string} taskId
 * @param {() => Promise<any>} transitionFn
 * @returns {Promise<any>}
 */
function enqueueDownloadTaskTransition(taskId, transitionFn) {
  const prev = taskTransitionLocks.get(taskId) || Promise.resolve();
  const next = prev
    .catch(() => {})
    .then(transitionFn)
    .finally(() => {
      if (taskTransitionLocks.get(taskId) === next) {
        taskTransitionLocks.delete(taskId);
      }
    });
  taskTransitionLocks.set(taskId, next);
  return next;
}

/**
 * Terminate a checkpoint-resumable CLI subprocess (`gogdl`, `legendary`) cleanly on pause and
 * wait for real OS process exit so file locks and stale CDN sockets are closed before resume.
 *
 * @param {any} child
 * @param {string} targetPlatform
 * @param {any} [options]
 * @returns {Promise<void>}
 */
async function terminatePausedCheckpointSubprocess(child, targetPlatform, options = {}) {
  if (!child) return;
  const pid = Number(child.pid || 0);
  if (targetPlatform === 'win32') {
    await Promise.resolve(signalSubprocessTree(child, 'SIGKILL', options)).catch(() => {});
  } else {
    await Promise.resolve(signalSubprocessTree(child, 'SIGTERM', options)).catch(() => {});
  }
  if (pid > 0 && isProcessAlive(pid)) {
    const graceful = await waitForProcessExit(child, pid, targetPlatform === 'win32' ? 1200 : 800);
    if (!graceful && isProcessAlive(pid)) {
      await Promise.resolve(signalSubprocessTree(child, 'SIGKILL', options)).catch(() => {});
      await waitForProcessExit(child, pid, 500);
    }
  } else if (
    child.exitCode == null &&
    child.signalCode == null &&
    typeof child.kill === 'function'
  ) {
    try {
      child.kill('SIGTERM');
    } catch {}
  }
}

/**
 * @param {string} taskId
 * @param {any} [options]
 */
function pauseDownload(taskId, options = {}) {
  ensureDownloadQueueRehydrated(options);
  const task = downloadQueueMap.get(taskId);
  if (!task) {
    return { success: false, error: `Download task ${taskId} not found.` };
  }
  if (task.status !== 'downloading' && task.status !== 'queued') {
    return {
      success: false,
      error: `Cannot pause download task in status "${task.status}".`,
      task: toPublicDownloadTask(task),
    };
  }

  const targetPlatform = options.platform || process.platform;
  const ctrl = downloadControllers.get(taskId);
  if (ctrl) {
    ctrl.pausedByUser = true;
    const transitionEpoch = (Number(ctrl.transitionEpoch) || 0) + 1;
    ctrl.transitionEpoch = transitionEpoch;
    if (ctrl.type === 'abort' && ctrl.controller) {
      try {
        ctrl.controller.abort();
      } catch {}
    } else if (ctrl.type === 'process' && ctrl.child) {
      const childRef = ctrl.child;
      const usesCheckpointRestart =
        targetPlatform === 'win32' || typeof ctrl.resumeInstallFn === 'function';
      if (usesCheckpointRestart) {
        ctrl.exitedWhilePaused = true;
        enqueueDownloadTaskTransition(taskId, () =>
          terminatePausedCheckpointSubprocess(childRef, targetPlatform, options)
        ).catch(() => {});
      } else {
        enqueueDownloadTaskTransition(taskId, () =>
          Promise.resolve(signalSubprocessTree(childRef, 'SIGSTOP', options))
        ).catch(() => {});
      }
    }
  }

  if (Number(task.speedBytesPerSec || 0) > 0) {
    task.lastActiveSpeedBytesPerSec = Number(task.speedBytesPerSec);
  }

  return updateDownloadTask(
    taskId,
    {
      status: 'paused',
      speedBytesPerSec: 0,
      etaSeconds: undefined,
      statusMessage: 'Download paused',
    },
    options
  );
}

/**
 * @param {string} taskId
 * @param {any} [options]
 */
function resumeDownload(taskId, options = {}) {
  ensureDownloadQueueRehydrated(options);
  const task = downloadQueueMap.get(taskId);
  if (!task) {
    return { success: false, error: `Download task ${taskId} not found.` };
  }
  if (task.status !== 'paused' && task.status !== 'failed') {
    return {
      success: false,
      error: `Cannot resume download task in status "${task.status}".`,
      task: toPublicDownloadTask(task),
    };
  }

  const targetPlatform = options.platform || process.platform;
  const ctrl = downloadControllers.get(taskId);
  let shouldInvokeResumeFn = false;
  let shouldReinvokeInstallRequest = false;
  let resumeEpoch = 0;

  if (ctrl) {
    ctrl.pausedByUser = false;
    resumeEpoch = (Number(ctrl.transitionEpoch) || 0) + 1;
    ctrl.transitionEpoch = resumeEpoch;
    const pid = ctrl.type === 'process' && ctrl.child ? ctrl.child.pid : null;
    const canSigCont =
      Boolean(pid) &&
      !ctrl.exitedWhilePaused &&
      targetPlatform !== 'win32' &&
      isProcessAlive(pid);
    if (canSigCont) {
      enqueueDownloadTaskTransition(taskId, async () => {
        if (ctrl.cancelRequested || ctrl.pausedByUser || ctrl.transitionEpoch !== resumeEpoch) {
          return;
        }
        const sigRes = await Promise.resolve(signalSubprocessTree(ctrl.child, 'SIGCONT', options));
        const signaled =
          typeof sigRes === 'object' && sigRes !== null ? Boolean(sigRes.signaled) : Boolean(sigRes);
        if (
          !signaled &&
          !ctrl.cancelRequested &&
          !ctrl.pausedByUser &&
          ctrl.transitionEpoch === resumeEpoch &&
          typeof ctrl.resumeInstallFn === 'function'
        ) {
          ctrl.exitedWhilePaused = false;
          await ctrl.resumeInstallFn();
        }
      }).catch((err) => {
        diagLog.warn('resumeDownload.sigContFallback', err, { taskId });
      });
    } else if (typeof ctrl.resumeInstallFn === 'function') {
      shouldInvokeResumeFn = true;
    }
  } else if (task.installRequest && !task.manualControl && !task.isSimulatedOrManual) {
    shouldReinvokeInstallRequest = true;
  }

  const resumedSpeed =
    task.isSimulatedOrManual || task.manualControl
      ? Number(task.lastActiveSpeedBytesPerSec || 0) || 18 * 1024 * 1024
      : 0;

  const updatedRes = updateDownloadTask(
    taskId,
    {
      status: 'downloading',
      error: undefined,
      speedBytesPerSec: resumedSpeed,
      statusMessage: `Resuming ${task.title}...`,
    },
    options
  );

  if (shouldInvokeResumeFn && ctrl && typeof ctrl.resumeInstallFn === 'function') {
    enqueueDownloadTaskTransition(taskId, async () => {
      if (ctrl.cancelRequested || ctrl.pausedByUser || ctrl.transitionEpoch !== resumeEpoch) {
        return;
      }
      const latest = downloadQueueMap.get(taskId);
      if (!latest || latest.status === 'cancelled' || latest.status === 'paused') {
        return;
      }
      ctrl.exitedWhilePaused = false;
      await ctrl.resumeInstallFn();
    }).catch((err) => {
      diagLog.warn('resumeDownload.resumeInstallFn', err, { taskId });
    });
  } else if (shouldReinvokeInstallRequest && task.installRequest) {
    const reqSnapshot = {
      ...task.installRequest,
      taskId,
      _resumingPausedInstall: true,
    };
    enqueueDownloadTaskTransition(taskId, async () => {
      const latest = downloadQueueMap.get(taskId);
      if (!latest || latest.status === 'cancelled' || latest.status === 'paused') {
        return;
      }
      await installGame(reqSnapshot, options);
    }).catch((err) => {
      diagLog.warn('resumeDownload.reinvokeInstallGame', err, { taskId });
    });
  }

  return updatedRes;
}

/**
 * Terminate a download controller.
 * P0-11 fix: supports `{ isPause: true }` so `gracefulShutdownDownloads` preserves
 * `ctrl.pausedByUser = true` and `ctrl.cancelRequested = false`, preventing partial
 * Xbox MSIXVC / storefront downloads from being deleted on normal app quit!
 *
 * @param {any} ctrl
 * @param {any} [options]
 * @returns {Promise<void>}
 */
function terminateDownloadController(ctrl, options = {}) {
  if (!ctrl) return Promise.resolve();
  const isPause = Boolean(options && options.isPause === true);
  if (isPause) {
    ctrl.pausedByUser = true;
    ctrl.cancelRequested = false;
  } else {
    ctrl.cancelRequested = true;
    ctrl.pausedByUser = false;
  }
  if (ctrl.timer) {
    try {
      clearInterval(ctrl.timer);
    } catch {}
  }
  if (ctrl.type === 'abort' && ctrl.controller && typeof ctrl.controller.abort === 'function') {
    try {
      ctrl.controller.abort();
    } catch {}
  }
  if (ctrl.type === 'process' && ctrl.child) {
    const targetPlatform = options.platform || process.platform;
    if (targetPlatform === 'win32') {
      return Promise.resolve(signalSubprocessTree(ctrl.child, 'SIGKILL', options)).then(() => {});
    }
    const contP = Promise.resolve(signalSubprocessTree(ctrl.child, 'SIGCONT', options));
    const termP = Promise.resolve(signalSubprocessTree(ctrl.child, 'SIGTERM', options));
    const pid = ctrl.child.pid;
    if (pid) {
      const killTimer = setTimeout(() => {
        if (isProcessAlive(pid)) {
          signalSubprocessTree(ctrl.child, 'SIGKILL', options);
        }
      }, 1500);
      if (typeof killTimer.unref === 'function') {
        killTimer.unref();
      }
    }
    return Promise.allSettled([contP, termP]).then(() => {});
  }
  return Promise.resolve();
}

/**
 * @param {any} task
 * @param {any} ctrl
 * @returns {Set<string>}
 */
function collectCandidateCancelledGogTempBins(task, ctrl) {
  /** @type {Set<string>} */
  const candidateBins = new Set();
  if (ctrl && typeof ctrl.tempBinPath === 'string' && ctrl.tempBinPath) {
    candidateBins.add(ctrl.tempBinPath);
  }
  if (task && typeof task.tempBinPath === 'string' && task.tempBinPath) {
    candidateBins.add(task.tempBinPath);
  }
  if (task && task.platformId === 'gog' && task.finalInstallPath) {
    const cleanId = validateSafeGogProductId(task.platformGameId || task.gameId);
    if (cleanId) {
      const candidate = path.join(task.finalInstallPath, `.gog_v1_${cleanId}_main.bin`);
      if (isContainedWithinRoot(task.finalInstallPath, candidate)) {
        candidateBins.add(candidate);
      }
    }
  }
  return candidateBins;
}

/**
 * Symlink-safe synchronous removal of cancelled GOG V1 temp bins.
 * @param {any} task
 * @param {any} ctrl
 */
function cleanupCancelledGogTempBins(task, ctrl) {
  const candidateBins = collectCandidateCancelledGogTempBins(task, ctrl);
  for (const binPath of candidateBins) {
    try {
      const st = fs.lstatSync(binPath);
      if (st.isSymbolicLink() || !st.isFile()) continue;
      fs.unlinkSync(binPath);
    } catch (/** @type {any} */ err) {
      if (err && err.code !== 'ENOENT') {
        diagLog.warn('cancelDownload.unlinkTempBin', err, { binPath });
      }
    }
  }
}

/**
 * Symlink-safe async removal with transient Windows lock backoff.
 * @param {any} task
 * @param {any} ctrl
 */
async function cleanupCancelledGogTempBinsAsync(task, ctrl) {
  const candidateBins = collectCandidateCancelledGogTempBins(task, ctrl);
  for (const binPath of candidateBins) {
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        const st = await fs.promises.lstat(binPath);
        if (st.isSymbolicLink() || !st.isFile()) break;
        await fs.promises.unlink(binPath);
        break;
      } catch (/** @type {any} */ err) {
        if (!err || err.code === 'ENOENT') break;
        const isTransientLock =
          err.code === 'EBUSY' || err.code === 'EPERM' || err.code === 'EACCES';
        if (!isTransientLock || attempt === 3) {
          diagLog.warn('cancelDownload.unlinkTempBinAsync', err, { binPath, attempt });
          break;
        }
        await new Promise((resolve) => {
          const t = setTimeout(resolve, 60 * (attempt + 1));
          if (typeof t.unref === 'function') t.unref();
        });
      }
    }
  }
}

/**
 * Symlink-safe recursive `.olpart` sweeper (sync variant for immediate cancel cleanup).
 * Never traverses symbolic links or unlinks targets outside `rootDir`.
 *
 * @param {string} rootDir
 * @param {string} dir
 * @param {number} [depth]
 */
function sweepOlPartFilesSyncSafe(rootDir, dir, depth = 0) {
  if (depth > 8) return;
  let dirStat;
  try {
    dirStat = fs.lstatSync(dir);
  } catch {
    return;
  }
  if (dirStat.isSymbolicLink() || !dirStat.isDirectory()) return;
  if (!isContainedWithinRoot(rootDir, dir)) return;

  /** @type {fs.Dirent[]} */
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const ent of entries) {
    if (ent.name === '.' || ent.name === '..' || ent.isSymbolicLink()) continue;
    const fullPath = path.join(dir, ent.name);
    if (!isContainedWithinRoot(rootDir, fullPath)) continue;
    if (ent.isDirectory()) {
      sweepOlPartFilesSyncSafe(rootDir, fullPath, depth + 1);
    } else if (ent.isFile() && ent.name.endsWith('.olpart')) {
      unlinkRegularFileSyncSafe(fullPath, rootDir);
    }
  }
}

/**
 * Symlink-safe recursive `.olpart` sweeper (async non-blocking variant for post-exit sweep).
 *
 * @param {string} rootDir
 * @param {string} dir
 * @param {number} [depth]
 */
async function sweepOlPartFilesAsyncSafe(rootDir, dir, depth = 0) {
  if (depth > 8) return;
  let dirStat;
  try {
    dirStat = await fs.promises.lstat(dir);
  } catch {
    return;
  }
  if (dirStat.isSymbolicLink() || !dirStat.isDirectory()) return;
  if (!isContainedWithinRoot(rootDir, dir)) return;

  /** @type {fs.Dirent[]} */
  let entries = [];
  try {
    entries = await fs.promises.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const ent of entries) {
    if (ent.name === '.' || ent.name === '..' || ent.isSymbolicLink()) continue;
    const fullPath = path.join(dir, ent.name);
    if (!isContainedWithinRoot(rootDir, fullPath)) continue;
    if (ent.isDirectory()) {
      await sweepOlPartFilesAsyncSafe(rootDir, fullPath, depth + 1);
    } else if (ent.isFile() && ent.name.endsWith('.olpart')) {
      try {
        const fStat = await fs.promises.lstat(fullPath);
        if (!fStat.isSymbolicLink() && fStat.isFile()) {
          await fs.promises.unlink(fullPath);
        }
      } catch {}
    }
  }
}

/**
 * @param {any} task
 * @param {any} ctrl
 */
function cleanupCancelledXboxPartialInstall(task, ctrl) {
  if (!task || task.platformId !== 'xbox') return;
  const targetDir = ctrl?.xboxInstallPath || task.finalInstallPath;
  if (!targetDir) return;
  let rootSt;
  try {
    rootSt = fs.lstatSync(targetDir);
  } catch {
    return;
  }
  if (rootSt.isSymbolicLink() || !rootSt.isDirectory()) return;

  for (const rName of ['.onelauncher-xbox-receipt.json', '.onelauncher-xbox-install.json']) {
    const rp = path.join(targetDir, rName);
    try {
      const rpSt = fs.lstatSync(rp);
      if (rpSt.isFile() && !rpSt.isSymbolicLink()) {
        const receipt = JSON.parse(fs.readFileSync(rp, 'utf8'));
        if (receipt && receipt.status === 'completed') {
          return;
        }
      }
    } catch {}
  }

  sweepOlPartFilesSyncSafe(targetDir, targetDir, 0);
  for (const jName of [
    '.onelauncher-xbox-journal.json',
    '.onelauncher-xbox-receipt.json',
    '.onelauncher-xbox-install.json',
  ]) {
    unlinkRegularFileSyncSafe(path.join(targetDir, jName), targetDir);
  }
}

/**
 * Non-blocking post-exit Xbox partial install sweeper (symlink-safe).
 *
 * @param {any} task
 * @param {any} ctrl
 */
async function cleanupCancelledXboxPartialInstallAsync(task, ctrl) {
  if (!task || task.platformId !== 'xbox') return;
  const targetDir = ctrl?.xboxInstallPath || task.finalInstallPath;
  if (!targetDir) return;
  let rootSt;
  try {
    rootSt = await fs.promises.lstat(targetDir);
  } catch {
    return;
  }
  if (rootSt.isSymbolicLink() || !rootSt.isDirectory()) return;

  for (const rName of ['.onelauncher-xbox-receipt.json', '.onelauncher-xbox-install.json']) {
    const rp = path.join(targetDir, rName);
    try {
      const rpSt = await fs.promises.lstat(rp);
      if (rpSt.isFile() && !rpSt.isSymbolicLink()) {
        const receipt = JSON.parse(await fs.promises.readFile(rp, 'utf8'));
        if (receipt && receipt.status === 'completed') {
          return;
        }
      }
    } catch {}
  }

  await sweepOlPartFilesAsyncSafe(targetDir, targetDir, 0);
  for (const jName of [
    '.onelauncher-xbox-journal.json',
    '.onelauncher-xbox-receipt.json',
    '.onelauncher-xbox-install.json',
  ]) {
    const jp = path.join(targetDir, jName);
    if (!isContainedWithinRoot(targetDir, jp)) continue;
    try {
      const st = await fs.promises.lstat(jp);
      if (!st.isSymbolicLink() && st.isFile()) {
        await fs.promises.unlink(jp);
      }
    } catch {}
  }
}

/**
 * Symlink-safe synchronous GOG V2 partial staging artifact sweeper.
 *
 * @param {any} task
 * @param {any} ctrl
 */
function cleanupCancelledGogV2PartialInstall(task, ctrl) {
  if (!task || task.platformId !== 'gog') return;
  /** @type {Set<string>} */
  const candidateRoots = new Set();
  for (const rawDir of [ctrl?.gogV2InstallPath, task.finalInstallPath]) {
    if (typeof rawDir === 'string' && rawDir.trim()) {
      candidateRoots.add(toHostFilesystemPath(rawDir));
    }
  }

  const removeStagingArtifacts = (/** @type {string} */ rootDir, /** @type {string} */ dir) => {
    for (const metaName of [
      '.onelauncher-gog-v2-resume.json',
      '.gogdl-resume',
      '.gogdl-download-cache',
    ]) {
      const target = path.join(dir, metaName);
      removeContainedStagingArtifactSync(rootDir, target, 0);
    }
  };

  for (const targetDir of candidateRoots) {
    if (!targetDir) continue;
    let st;
    try {
      st = fs.lstatSync(targetDir);
    } catch {
      continue;
    }
    if (st.isSymbolicLink() || !st.isDirectory()) continue;

    sweepOlPartFilesSyncSafe(targetDir, targetDir, 0);
    removeStagingArtifacts(targetDir, targetDir);
    try {
      const children = fs.readdirSync(targetDir, { withFileTypes: true });
      for (const child of children) {
        if (child.isSymbolicLink() || !child.isDirectory() || child.name.startsWith('.')) {
          continue;
        }
        const childDir = path.join(targetDir, child.name);
        if (isContainedWithinRoot(targetDir, childDir)) {
          removeStagingArtifacts(targetDir, childDir);
        }
      }
    } catch {}
  }
}

/**
 * Non-blocking post-exit GOG V2 partial staging artifact sweeper (symlink-safe).
 *
 * @param {any} task
 * @param {any} ctrl
 */
async function cleanupCancelledGogV2PartialInstallAsync(task, ctrl) {
  if (!task || task.platformId !== 'gog') return;
  /** @type {Set<string>} */
  const candidateRoots = new Set();
  for (const rawDir of [ctrl?.gogV2InstallPath, task.finalInstallPath]) {
    if (typeof rawDir === 'string' && rawDir.trim()) {
      candidateRoots.add(toHostFilesystemPath(rawDir));
    }
  }

  const removeStagingArtifactsAsync = async (
    /** @type {string} */ rootDir,
    /** @type {string} */ dir
  ) => {
    for (const metaName of [
      '.onelauncher-gog-v2-resume.json',
      '.gogdl-resume',
      '.gogdl-download-cache',
    ]) {
      const target = path.join(dir, metaName);
      if (!isContainedWithinRoot(rootDir, target)) continue;
      let st;
      try {
        st = await fs.promises.lstat(target);
      } catch {
        continue;
      }
      if (st.isSymbolicLink() || !st.isDirectory()) {
        try {
          await fs.promises.unlink(target);
        } catch {}
      } else {
        try {
          await safeRemoveGameDirectoryAsync(target, { skipSafetyAssertion: true });
        } catch {}
      }
    }
  };

  for (const targetDir of candidateRoots) {
    if (!targetDir) continue;
    let st;
    try {
      st = await fs.promises.lstat(targetDir);
    } catch {
      continue;
    }
    if (st.isSymbolicLink() || !st.isDirectory()) continue;

    await sweepOlPartFilesAsyncSafe(targetDir, targetDir, 0);
    await removeStagingArtifactsAsync(targetDir, targetDir);
    try {
      const children = await fs.promises.readdir(targetDir, { withFileTypes: true });
      for (const child of children) {
        if (child.isSymbolicLink() || !child.isDirectory() || child.name.startsWith('.')) {
          continue;
        }
        const childDir = path.join(targetDir, child.name);
        if (isContainedWithinRoot(targetDir, childDir)) {
          await removeStagingArtifactsAsync(targetDir, childDir);
        }
      }
    } catch {}
  }
}

/**
 * Cancel an active or paused download cleanly without repeating duplicate sync tree walks.
 * Immediate symlink-safe cleanup handles already-materialized partial staging files synchronously,
 * and when an active controller was running, a non-blocking async sweep runs after termination
 * to mop up any trailing files released on process exit.
 *
 * @param {string} taskId
 * @param {any} [options]
 */
function cancelDownload(taskId, options = {}) {
  ensureDownloadQueueRehydrated(options);
  pausedByInGameTaskIds.delete(taskId);
  const task = downloadQueueMap.get(taskId);
  if (!task) {
    return { success: false, error: `Download task ${taskId} not found.` };
  }

  const ctrl = downloadControllers.get(taskId);
  if (ctrl) {
    ctrl.cancelRequested = true;
    ctrl.pausedByUser = false;
    ctrl.transitionEpoch = (Number(ctrl.transitionEpoch) || 0) + 1;
    downloadControllers.delete(taskId);
    if (ctrl.type === 'abort' && ctrl.controller && typeof ctrl.controller.abort === 'function') {
      try {
        ctrl.controller.abort();
      } catch {}
    }
    if (ctrl.timer) {
      try {
        clearInterval(ctrl.timer);
      } catch {}
    }
  }

  cleanupCancelledGogTempBins(task, ctrl);
  cleanupCancelledGogV2PartialInstall(task, ctrl);
  cleanupCancelledXboxPartialInstall(task, ctrl);

  if (ctrl) {
    enqueueDownloadTaskTransition(taskId, async () => {
      await terminateDownloadController(ctrl, options);
      await cleanupCancelledGogV2PartialInstallAsync(task, ctrl);
      await cleanupCancelledXboxPartialInstallAsync(task, ctrl);
      await cleanupCancelledGogTempBinsAsync(task, ctrl);
    }).catch(() => {});
  }

  return updateDownloadTask(
    taskId,
    {
      status: 'cancelled',
      speedBytesPerSec: 0,
      etaSeconds: undefined,
      tempBinPath: undefined,
      statusMessage: 'Download cancelled',
    },
    options
  );
}

/**
 * @param {any} [options]
 */
function clearDownloadQueue(options = {}) {
  for (const [taskId, ctrl] of downloadControllers.entries()) {
    const task = downloadQueueMap.get(taskId);
    terminateDownloadController(ctrl, options);
    cleanupCancelledGogTempBins(task, ctrl);
    cleanupCancelledGogV2PartialInstall(task, ctrl);
    cleanupCancelledXboxPartialInstall(task, ctrl);
  }
  clearPendingBroadcastTimers();
  downloadControllers.clear();
  downloadSpeedTrackers.clear();
  pausedByInGameTaskIds.clear();
  downloadQueueMap.clear();
  clearRehydratedQueueDirs();
  inFlightInstallKeys.clear();
  persistDownloadQueueToDisk(options?.userDataDir);
}

/**
 * @param {any} [options]
 */
function shutdownDownloadEngine(options = {}) {
  persistDownloadQueueToDisk(options?.userDataDir);
  clearPendingBroadcastTimers();
  for (const [, ctrl] of downloadControllers.entries()) {
    terminateDownloadController(ctrl, { ...options, isPause: true });
  }
  downloadControllers.clear();
  downloadSpeedTrackers.clear();
  inFlightInstallKeys.clear();
}

/**
 * Gracefully pause and drain active download subprocesses during app `before-quit` within a
 * bounded timeout (`timeoutMs`), preserving checkpoint journals and partial installs on disk
 * (P0-11: passes `{ isPause: true }` to `terminateDownloadController` so normal app quit NEVER
 * deletes partial Xbox MSIXVC or storefront downloads).
 *
 * @param {number} [timeoutMs=3000]
 * @param {any} [options]
 * @returns {Promise<void>}
 */
async function gracefulShutdownDownloads(timeoutMs = 3000, options = {}) {
  const safeTimeoutMs = Math.max(250, Math.min(15000, Number(timeoutMs) || 3000));
  /** @type {Promise<any>[]} */
  const shutdownPromises = [];

  for (const [taskId, task] of downloadQueueMap.entries()) {
    if (task && task.status === 'downloading') {
      try {
        updateDownloadTask(
          taskId,
          {
            status: 'paused',
            speedBytesPerSec: 0,
            etaSeconds: undefined,
            statusMessage: 'Paused on exit',
          },
          options
        );
      } catch {}
    }
  }

  for (const [taskId, ctrl] of downloadControllers.entries()) {
    ctrl.pausedByUser = true;
    ctrl.cancelRequested = false;
    ctrl.exitedWhilePaused = true;
    ctrl.transitionEpoch = (Number(ctrl.transitionEpoch) || 0) + 1;
    shutdownPromises.push(
      enqueueDownloadTaskTransition(taskId, async () => {
        await terminateDownloadController(ctrl, { ...options, isPause: true });
        const pid = ctrl.type === 'process' && ctrl.child ? Number(ctrl.child.pid || 0) : 0;
        if (pid > 0 && isProcessAlive(pid)) {
          await waitForProcessExit(ctrl.child, pid, Math.min(1200, safeTimeoutMs));
        }
      })
    );
  }

  clearPendingBroadcastTimers();
  downloadControllers.clear();
  downloadSpeedTrackers.clear();
  inFlightInstallKeys.clear();
  persistDownloadQueueToDisk(options?.userDataDir);

  if (shutdownPromises.length > 0) {
    await Promise.race([
      Promise.allSettled(shutdownPromises),
      new Promise((resolve) => {
        const t = setTimeout(resolve, safeTimeoutMs);
        if (typeof t.unref === 'function') t.unref();
      }),
    ]);
  }
}

function getPausedByInGameTaskIds() {
  return Array.from(pausedByInGameTaskIds);
}

/**
 * @param {any} [options]
 */
function pauseActiveDownloadsForInGame(options = {}) {
  ensureDownloadQueueRehydrated(options);
  const pausedTaskIds = [];
  for (const [taskId, task] of downloadQueueMap.entries()) {
    if (!task) continue;
    if (task.status === 'downloading' || task.status === 'queued') {
      const res = pauseDownload(taskId, options);
      if (res && res.success) {
        pausedByInGameTaskIds.add(taskId);
        pausedTaskIds.push(taskId);
        try {
          updateDownloadTask(taskId, { statusMessage: 'Paused while in-game' }, options);
        } catch {}
      }
    }
  }
  return { pausedTaskIds };
}

/**
 * @param {any} [options]
 */
function resumeDownloadsPausedByInGame(options = {}) {
  const resumedTaskIds = [];
  for (const taskId of Array.from(pausedByInGameTaskIds)) {
    pausedByInGameTaskIds.delete(taskId);
    const task = downloadQueueMap.get(taskId);
    if (task && task.status === 'paused') {
      const res = resumeDownload(taskId, options);
      if (res && res.success) {
        resumedTaskIds.push(taskId);
      }
    }
  }
  return { resumedTaskIds };
}

module.exports = {
  sweepStaleGogTempBinsAsync,
  installGame,
  pauseDownload,
  resumeDownload,
  terminateDownloadController,
  cancelDownload,
  clearDownloadQueue,
  shutdownDownloadEngine,
  gracefulShutdownDownloads,
  getPausedByInGameTaskIds,
  pauseActiveDownloadsForInGame,
  resumeDownloadsPausedByInGame,
};
