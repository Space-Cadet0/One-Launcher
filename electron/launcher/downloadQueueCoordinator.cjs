// @ts-check
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn, execFile } = require('child_process');

const {
  toHostFilesystemPath,
  atomicWriteFileSync,
  atomicWriteSecureFileSync,
} = require('./securityAndPathUtils.cjs');
const {
  MAX_PLAUSIBLE_GAME_INSTALL_BYTES,
  sanitizeGameInstallSizeBytes,
  parseByteCountOrFormattedSize,
  parseStorageRequirementBytes,
  parseEpicManifestBuffer,
  parseSteamAcf,
  integrateSteamRateSamples,
  parseSteamContentLogForApp,
  deriveDefaultScidFromTitleId,
  inspectMicrosoftGameConfig,
} = require('./binaryAndManifestInspectors.cjs');
const { isProcessAlive, signalSubprocessTree } = require('./processTreeUtils.cjs');
const { resolveBottleSteamExe } = require('./wineAndCrossOverManager.cjs');

const {
  diagLog,
  getStoreSync,
  getXboxStorefrontModules,
  getXboxStoreLicenseRecoveryHook,
  getConfiguredUserDataDir,
  getUserDataDir,
  isTestEnvironment,
  resolveIsolatedHomedirAndUserData,
  emitDownloadUpdated,
  MAX_DISCOVERY_CACHE_ENTRIES,
  downloadQueueMap,
  downloadControllers,
  downloadSpeedTrackers,
  pausedByInGameTaskIds,
  installInfoSizeCache,
  steamPlatformSupportCache,
  xboxCompatibilityProbeCache,
  registerExternalCacheInvalidator,
  setBoundedMapEntry,
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
} = require('./engineStateRegistry.cjs');

const {
  discoverWindowsLocalDrivesAsync,
  hasWindowsGamingServicesInstalled,
  getDefaultInstallDir,
  getDiskSpace,
  getDirectorySizeFast,
} = require('./diskAndVolumeInspector.cjs');

const {
  isXboxChildGameFolder,
  collectXboxLibraryRoots,
  inspectInstalledXboxGameDir,
  queryTargetedAppxPackageAsync,
  resolveXboxClientBinaryPath,
} = require('./windowsXboxAppxAndMsixvcOrchestrator.cjs');

const {
  resolveMacAppBundleBinary,
  ensureMacAppCodeSignatureValid,
  flattenGogNestedInstallDir,
  findPrimaryExecutable,
  resolveSteamAppInfoLaunchSpec,
  resolveDefaultEngineLaunchArguments,
  discoverSteamLocations,
  normalizeComparableTitle,
  detectCompatibilityLayers,
  ensureCompatibilityLayerReady,
} = require('./macNativeInstallerAndCodesign.cjs');

const {
  syncEpicFirstPartyLauncher,
  ensureLegendaryConfigAndAuth,
  resolveEpicAppAndPlatforms,
} = require('./epicLegendaryAndEosCoordinator.cjs');

const {
  setGogDownloadTaskHooks,
  sanitizeDirectoryName,
  syncGogFirstPartyLauncher,
  ensureGogdlAuthConfig,
  clearStaleGogdlManifestCache,
  fetchGogV1Json,
  downloadGogV1Depot,
} = require('./gogRegistryAndDirectInstaller.cjs');

/** @type {((vdfText: string) => { steamId64: string, accountName: string, personaName: string, allowAutoLogin: boolean } | null) | null} */
let cachedParseSteamLoginUsersVdfDetails = null;
/** @type {((userDataDir: string, options: Record<string, any>) => Promise<Record<string, any>>) | null} */
let cachedLoadSavedTokensReadOnly = null;

function getParseSteamLoginUsersVdfDetails() {
  if (!cachedParseSteamLoginUsersVdfDetails) {
    const proberMod = /** @type {any} */ (require('./environmentHealthProber.cjs'));
    cachedParseSteamLoginUsersVdfDetails = proberMod.parseSteamLoginUsersVdfDetails;
  }
  return cachedParseSteamLoginUsersVdfDetails;
}

function getLoadSavedTokensReadOnly() {
  if (!cachedLoadSavedTokensReadOnly) {
    const proberMod = /** @type {any} */ (require('./environmentHealthProber.cjs'));
    cachedLoadSavedTokensReadOnly = proberMod.loadSavedTokensReadOnly;
  }
  return cachedLoadSavedTokensReadOnly;
}

/**
 * Resolve One Launcher's connected 17-digit SteamID64 asynchronously without touching sync vault I/O.
 *
 * @param {Record<string, any>} [options]
 * @returns {Promise<string>}
 */
async function resolveExpectedSteamId64Async(options = {}) {
  try {
    const loadTokens = getLoadSavedTokensReadOnly();
    if (typeof loadTokens !== 'function') return '';
    const { userDataDir } = resolveIsolatedHomedirAndUserData(options);
    if (!userDataDir) return '';
    const savedTokens = await loadTokens(userDataDir, options);
    const rawId = String(savedTokens?.steam?.steamId || '').trim();
    return /^\d{17}$/.test(rawId) ? rawId : '';
  } catch {
    return '';
  }
}

/**
 * Probe candidate `loginusers.vdf` paths asynchronously (read-only) to determine whether the
 * target Steam instance currently has an authenticated user session on disk (matching
 * `expectedSteamId64` when One Launcher has a connected Steam account).
 *
 * @param {Iterable<string>} vdfPaths
 * @param {string} [expectedSteamId64]
 * @returns {Promise<boolean>}
 */
async function hasAuthenticatedSteamSessionInVdfCandidates(vdfPaths, expectedSteamId64 = '') {
  if (!vdfPaths) return false;
  const parseVdf = getParseSteamLoginUsersVdfDetails();
  if (typeof parseVdf !== 'function') return false;
  const normalizedExpected =
    typeof expectedSteamId64 === 'string' && /^\d{17}$/.test(expectedSteamId64.trim())
      ? expectedSteamId64.trim()
      : '';
  const seen = new Set();
  for (const rawPath of vdfPaths) {
    const p = typeof rawPath === 'string' ? rawPath.trim() : '';
    if (!p || seen.has(p)) continue;
    seen.add(p);
    try {
      const text = await fs.promises.readFile(p, 'utf8');
      const parsed = parseVdf(text);
      if (parsed && parsed.steamId64) {
        if (!normalizedExpected || parsed.steamId64 === normalizedExpected) {
          return true;
        }
      }
    } catch {}
  }
  return false;
}

const DOWNLOAD_QUEUE_PERSIST_FILENAME = 'download_queue_v1.json';
/** @type {Set<string>} */
const rehydratedQueueDirs = new Set();

const TRUSTED_EXTERNAL_LAUNCHER_DOMAINS = Object.freeze([
  'ea.com',
  'ubisoftconnect.com',
  'ubisoft.com',
  'riotgames.com',
  'battle.net',
  'blizzard.com',
  'minecraft.net',
  'xbox.com',
  'microsoft.com',
]);

/**
 * Strictly validate an external launcher/storefront handoff URL against an official
 * publisher/storefront HTTPS domain allowlist (rejects control chars, credentials,
 * non-HTTPS schemes, non-standard ports, and untrusted hosts).
 * @param {any} rawUrl
 * @returns {string}
 */
function validateTrustedExternalLauncherUrl(rawUrl) {
  if (typeof rawUrl !== 'string') return '';
  const trimmed = rawUrl.trim();
  if (!trimmed || /[\x00-\x1f\x7f]/.test(trimmed)) return '';
  /** @type {URL} */
  let parsed;
  try {
    parsed = new URL(trimmed);
  } catch {
    return '';
  }
  if (parsed.protocol !== 'https:') return '';
  if (parsed.username || parsed.password) return '';
  if (parsed.port && parsed.port !== '443') return '';

  const hostname = parsed.hostname.toLowerCase().replace(/\.$/, '');
  if (!hostname) return '';

  const isAllowedDomain = TRUSTED_EXTERNAL_LAUNCHER_DOMAINS.some(
    (domain) => hostname === domain || hostname.endsWith(`.${domain}`)
  );
  if (!isAllowedDomain) return '';

  return parsed.toString();
}

registerExternalCacheInvalidator(() => {
  rehydratedQueueDirs.clear();
});

/**
 * Resolve the persistent queue JSON path for a given userDataDir (if persistence is appropriate).
 * @param {string} [explicitUserDataDir]
 * @returns {string | null}
 */
function resolveDownloadQueuePersistPath(explicitUserDataDir) {
  const configured = explicitUserDataDir || getConfiguredUserDataDir();
  if (!configured && isTestEnvironment()) {
    return null;
  }
  const resolvedDir = getUserDataDir(configured);
  if (!resolvedDir) return null;
  return path.join(resolvedDir, DOWNLOAD_QUEUE_PERSIST_FILENAME);
}

/**
 * Serialize resumable / active non-ephemeral tasks to `download_queue_v1.json` atomically.
 * @param {string} [explicitUserDataDir]
 */
function persistDownloadQueueToDisk(explicitUserDataDir) {
  try {
    const queueFilePath = resolveDownloadQueuePersistPath(explicitUserDataDir);
    if (!queueFilePath) return;

    const persistableTasks = [];
    for (const [, t] of downloadQueueMap.entries()) {
      if (!t || t.isSimulatedOrManual || t.manualControl) continue;
      if (!['queued', 'paused', 'downloading', 'extracting', 'verifying'].includes(t.status)) {
        continue;
      }
      const { _persistedUserDataDir, ...cleanTask } = t;
      persistableTasks.push({
        ...cleanTask,
        speedBytesPerSec: 0,
        etaSeconds: undefined,
      });
    }

    if (persistableTasks.length === 0 && !fs.existsSync(queueFilePath)) {
      return;
    }

    atomicWriteFileSync(
      queueFilePath,
      JSON.stringify(
        {
          schemaVersion: 1,
          updatedAt: new Date().toISOString(),
          tasks: persistableTasks,
        },
        null,
        2
      )
    );
  } catch (err) {
    diagLog.debug('persistDownloadQueueToDisk.error', err);
  }
}

/**
 * Rehydrate persisted tasks from `download_queue_v1.json` once per `userDataDir`.
 * Interrupted active tasks (`downloading`, `extracting`, `verifying`) are safely coerced to `'paused'`
 * so the user can resume them deterministically after an app restart.
 * @param {any} [options]
 */
function ensureDownloadQueueRehydrated(options = {}) {
  try {
    const explicitUserDataDir = options && typeof options === 'object' ? options.userDataDir : undefined;
    const queueFilePath = resolveDownloadQueuePersistPath(explicitUserDataDir);
    if (!queueFilePath) return;
    const dirKey = path.dirname(queueFilePath);
    if (rehydratedQueueDirs.has(dirKey)) return;
    rehydratedQueueDirs.add(dirKey);

    if (!fs.existsSync(queueFilePath)) return;
    const raw = JSON.parse(fs.readFileSync(queueFilePath, 'utf8'));
    const tasks = Array.isArray(raw?.tasks) ? raw.tasks : Array.isArray(raw) ? raw : [];
    let mutatedOnRehydrate = false;

    for (const entry of tasks) {
      if (!entry || typeof entry !== 'object' || !entry.taskId) continue;
      if (downloadQueueMap.has(entry.taskId)) continue;
      const wasActive = ['downloading', 'extracting', 'verifying'].includes(entry.status);
      const coercedStatus = wasActive ? 'paused' : entry.status === 'queued' ? 'queued' : 'paused';
      if (wasActive) {
        mutatedOnRehydrate = true;
      }
      downloadQueueMap.set(entry.taskId, {
        ...entry,
        status: coercedStatus,
        speedBytesPerSec: 0,
        etaSeconds: undefined,
        statusMessage:
          coercedStatus === 'paused' && wasActive
            ? 'Paused (resume after restart)'
            : entry.statusMessage || 'Download paused',
        _persistedUserDataDir: explicitUserDataDir || getConfiguredUserDataDir() || undefined,
      });
    }

    if (mutatedOnRehydrate) {
      persistDownloadQueueToDisk(explicitUserDataDir);
    }
  } catch (err) {
    diagLog.debug('ensureDownloadQueueRehydrated.error', err);
  }
}

function matchLast(/** @type {string} */ text, /** @type {RegExp} */ globalRegex) {
  if (!text) return null;
  const matches = Array.from(String(text).matchAll(globalRegex));
  return matches.length > 0 ? matches[matches.length - 1] : null;
}

function parseCliSizeToBytes(/** @type {any} */ valStr, unitStr = 'MiB') {
  const num = parseFloat(valStr);
  if (!Number.isFinite(num) || num < 0) return 0;
  const u = String(unitStr || 'MiB').toUpperCase();
  if (u === 'B' || u === 'BYTES') return Math.round(num);
  if (u === 'KIB' || u === 'KB') return Math.round(num * 1024);
  if (u === 'GIB' || u === 'GB') return Math.round(num * 1024 * 1024 * 1024);
  return Math.round(num * 1024 * 1024);
}

/**
 * Rolling Window + Exponential Moving Average (EMA) Download Speed Stabilizer.
 */
function computeSmoothedDownloadSpeed(/** @type {string} */ taskId, /** @type {any} */ sample = {}) {
  if (!taskId) return Math.max(0, Math.round(Number(sample.rawSpeedBytesPerSec || 0)));
  const now = typeof sample.nowMs === 'number' ? sample.nowMs : Date.now();
  const bytes =
    sample.bytesDownloaded !== undefined && sample.bytesDownloaded !== null
      ? Number(sample.bytesDownloaded)
      : undefined;
  const rawSpeed = Math.max(0, Math.round(Number(sample.rawSpeedBytesPerSec || 0)));
  const decompressedSpeed = Math.max(0, Math.round(Number(sample.decompressedSpeedBytesPerSec || 0)));

  let tracker = downloadSpeedTrackers.get(taskId);
  if (!tracker) {
    tracker = {
      emaSpeed: 0,
      samples: [],
      lastNonZeroTs: 0,
    };
    downloadSpeedTrackers.set(taskId, tracker);
  }

  tracker.samples.push({
    ts: now,
    bytes: bytes !== undefined && Number.isFinite(bytes) ? bytes : -1,
    rawSpeed,
  });

  while (tracker.samples.length > 2 && now - tracker.samples[0].ts > 6000) {
    tracker.samples.shift();
  }

  let rollingByteSpeed = 0;
  if (bytes !== undefined && bytes > 0) {
    for (let i = 0; i < tracker.samples.length - 1; i++) {
      const s = tracker.samples[i];
      const dtMs = now - s.ts;
      if (s.bytes >= 0 && bytes > s.bytes && dtMs >= 800 && dtMs <= 8000) {
        rollingByteSpeed = Math.round(((bytes - s.bytes) * 1000) / dtMs);
        break;
      }
    }
  }

  const recentRawSamples = tracker.samples
    .filter((/** @type {any} */ s) => now - s.ts <= 5000 && s.rawSpeed > 0)
    .map((/** @type {any} */ s) => s.rawSpeed);

  let rollingRawSpeed = 0;
  if (recentRawSamples.length >= 2) {
    const maxRecent = Math.max(...recentRawSamples);
    const filtered =
      maxRecent > 3 * 1024 * 1024
        ? recentRawSamples.filter((/** @type {number} */ v) => v >= maxRecent * 0.25 || recentRawSamples.length <= 2)
        : recentRawSamples;
    const pool = filtered.length > 0 ? filtered : recentRawSamples;
    rollingRawSpeed = Math.round(
      pool.reduce((/** @type {number} */ a, /** @type {number} */ b) => a + b, 0) / pool.length
    );
  } else if (recentRawSamples.length === 1) {
    rollingRawSpeed = recentRawSamples[0];
  }

  let targetSpeed = rawSpeed;
  if (rawSpeed > 0 && rollingByteSpeed > 0) {
    if (tracker.emaSpeed > 2 * 1024 * 1024 && rawSpeed < tracker.emaSpeed * 0.35) {
      targetSpeed = Math.max(rollingByteSpeed, rollingRawSpeed);
    } else if (tracker.emaSpeed > 2 * 1024 * 1024 && rawSpeed > tracker.emaSpeed * 1.45) {
      targetSpeed = Math.round(rollingByteSpeed * 0.65 + rawSpeed * 0.35);
    } else {
      targetSpeed = Math.round(rawSpeed * 0.5 + rollingByteSpeed * 0.5);
    }
  } else if (rawSpeed <= 0 && rollingByteSpeed > 0) {
    targetSpeed = rollingByteSpeed;
  } else if (rawSpeed > 0 && rollingRawSpeed > 0 && recentRawSamples.length >= 2) {
    targetSpeed = Math.round(rawSpeed * 0.45 + rollingRawSpeed * 0.55);
  }

  if (tracker.emaSpeed <= 0) {
    if (targetSpeed > 0) {
      tracker.emaSpeed = targetSpeed;
      tracker.lastNonZeroTs = now;
    }
    return tracker.emaSpeed;
  }

  if (targetSpeed > 0) {
    tracker.lastNonZeroTs = now;
    const ratio = targetSpeed / tracker.emaSpeed;
    if (ratio < 0.35) {
      const alpha = decompressedSpeed > 1024 * 1024 ? 0.05 : 0.1;
      const damped = Math.round(tracker.emaSpeed * (1 - alpha) + targetSpeed * alpha);
      tracker.emaSpeed = Math.max(damped, Math.round(tracker.emaSpeed * 0.88));
    } else if (ratio > 1.45) {
      const alpha = 0.22;
      tracker.emaSpeed = Math.round(tracker.emaSpeed * (1 - alpha) + targetSpeed * alpha);
    } else {
      const alpha = 0.28;
      tracker.emaSpeed = Math.round(tracker.emaSpeed * (1 - alpha) + targetSpeed * alpha);
    }
  } else if (now - tracker.lastNonZeroTs < 4000) {
    tracker.emaSpeed = Math.round(tracker.emaSpeed * 0.9);
  } else {
    tracker.emaSpeed = 0;
  }

  return tracker.emaSpeed;
}

function getDownloadQueue(/** @type {any} */ options = {}) {
  ensureDownloadQueueRehydrated(options);
  return Array.from(downloadQueueMap.values()).map((t) => {
    const { _persistedUserDataDir, ...publicTask } = t;
    return { ...publicTask };
  });
}

/**
 * Update a download task state and notify all listeners
 */
function updateDownloadTask(
  /** @type {string} */ taskId,
  /** @type {any} */ partial = {},
  /** @type {any} */ options = {}
) {
  const task = downloadQueueMap.get(taskId);
  if (!task) {
    return { success: false, error: `Download task ${taskId} not found.` };
  }

  const prevProgress = Number(task.progressPercent || 0);
  const prevBytes = Number(task.bytesDownloaded || 0);
  const prevStatus = task.status;

  Object.assign(task, partial);

  if (
    task.totalBytes > 0 &&
    partial.bytesDownloaded !== undefined &&
    partial.progressPercent === undefined &&
    !task.hasExplicitCliProgress
  ) {
    task.progressPercent = Math.min(100, Math.round((task.bytesDownloaded / task.totalBytes) * 100));
  }

  if (
    ['downloading', 'extracting', 'verifying'].includes(task.status) &&
    prevStatus !== 'queued'
  ) {
    if (task.progressPercent < prevProgress && task.status !== 'completed') {
      task.progressPercent = prevProgress;
    }
    if (task.bytesDownloaded < prevBytes && task.status !== 'completed') {
      task.bytesDownloaded = prevBytes;
    }
    if (
      task.totalBytes > 0 &&
      task.bytesDownloaded > task.totalBytes &&
      task.status !== 'completed'
    ) {
      task.totalBytes = task.bytesDownloaded;
    }
  }

  if (
    task.status === 'completed' ||
    task.status === 'failed' ||
    task.status === 'cancelled' ||
    task.status === 'paused'
  ) {
    downloadSpeedTrackers.delete(taskId);
  }

  if (task.status === 'completed') {
    task.progressPercent = 100;
    task.speedBytesPerSec = 0;
    task.etaSeconds = 0;
    task.completedAt = task.completedAt || new Date().toISOString();
    task.finalInstallPath =
      task.finalInstallPath || path.join(task.installDir, sanitizeDirectoryName(task.title));

    upsertManagedInstallRecord(
      {
        platformId: task.platformId,
        platformGameId: task.platformGameId,
        appId: task.platformId === 'steam' ? task.steamAppId : undefined,
        ...(task.xboxProductId ? { xboxProductId: task.xboxProductId } : {}),
        ...(task.packageFamilyName ? { packageFamilyName: task.packageFamilyName } : {}),
        ...(task.appUserModelId ? { appUserModelId: task.appUserModelId } : {}),
        ...(task.xboxTitleId ? { xboxTitleId: task.xboxTitleId } : {}),
        ...(task.scid ? { scid: task.scid } : {}),
        ...(task.msaAppId ? { msaAppId: task.msaAppId } : {}),
        ...(task.version ? { version: task.version } : {}),
        ...(task.isClientlessXboxInstall ? { isClientlessXboxInstall: true } : {}),
        title: task.title,
        installPath: task.finalInstallPath,
        executablePath: task.executablePath,
        installSize: task.totalBytes,
        runner: task.runner || 'one_launcher',
        isWindowsBinaryOnMac: task.isWindowsBinaryOnMac,
      },
      options.userDataDir
    );
  }

  if (!task.isSimulatedOrManual && !task.manualControl && prevStatus !== task.status) {
    persistDownloadQueueToDisk(options.userDataDir || task._persistedUserDataDir);
  }

  const { _persistedUserDataDir, ...publicTask } = task;
  emitDownloadUpdated({
    task: { ...publicTask },
    queue: getDownloadQueue(options),
  });

  return {
    success: true,
    task: { ...publicTask },
  };
}

setGogDownloadTaskHooks({
  updateDownloadTask,
  computeSmoothedDownloadSpeed,
});

/**
 * Background monitor for Steam downloads & installations via appmanifest_<appId>.acf + logs/content_log.txt
 */
function startSteamInstallMonitor(
  /** @type {string} */ taskId,
  /** @type {string | number} */ appId,
  /** @type {any} */ options = {}
) {
  const intervalMs = Number(options.steamPollIntervalMs || 1200);
  const locationsCacheTtlMs = Number(options.steamLocationsCacheTtlMs ?? 10000);
  const logTailMaxBytes = 512 * 1024;
  let lastBytes = 0;
  let lastTickTime = Date.now();
  /** @type {any} */
  let cachedLocations = null;
  let cachedLocationsAt = 0;
  /** @type {string | null} */
  let lastKnownManifestDir = null;
  let knownDownloadTotal = 0;
  let knownStageTotal = 0;
  let sawSteamActivity = false;
  let inFlightTick = false;

  const retriggerCtx =
    options &&
    options._steamAuthRetrigger &&
    typeof options._steamAuthRetrigger === 'object' &&
    typeof options._steamAuthRetrigger.retriggerInstallAsync === 'function'
      ? options._steamAuthRetrigger
      : null;
  const maxRetriggers = 2;
  let retriggerCount = 0;
  let authDetectedAtMs = 0;
  let lastRetriggerAtMs = 0;

  const resolveTaskStartedAtMs = (/** @type {any} */ taskObj) => {
    if (options.minLogTimestampMs !== undefined) {
      const overrideTs = Number(options.minLogTimestampMs);
      return Number.isFinite(overrideTs) && overrideTs > 0 ? overrideTs : 0;
    }
    if (!taskObj || !taskObj.startedAt) return 0;
    if (typeof taskObj.startedAt === 'number') {
      return Number.isFinite(taskObj.startedAt) && taskObj.startedAt > 0 ? taskObj.startedAt : 0;
    }
    const parsedTs = Date.parse(String(taskObj.startedAt));
    return Number.isFinite(parsedTs) && parsedTs > 0 ? parsedTs : 0;
  };

  const isRelevantParsedLog = (/** @type {any} */ parsedLog) =>
    Boolean(
      parsedLog &&
        (parsedLog.updateStarted ||
          parsedLog.updateCanceled ||
          parsedLog.isRunning ||
          parsedLog.fullyInstalled ||
          parsedLog.bytesToDownload > 0 ||
          parsedLog.bytesToStage > 0 ||
          parsedLog.phase)
    );

  const readContentLogTail = (
    /** @type {Iterable<string>} */ steamRoots,
    minTimestampMs = 0,
    nowMs = Date.now()
  ) => {
    /** @type {any} */
    let bestLogInfo = null;
    for (const root of steamRoots) {
      const candidateLogs = [
        path.join(root, 'logs', 'content_log.txt'),
        path.join(root, 'Steam', 'logs', 'content_log.txt'),
      ];
      for (const logPath of candidateLogs) {
        try {
          const st = fs.statSync(logPath);
          const size = Number(st.size || 0);
          if (size <= 0) continue;
          const readLen = Math.min(size, logTailMaxBytes);
          const fd = fs.openSync(logPath, 'r');
          let bytesRead = 0;
          const buf = Buffer.alloc(readLen);
          try {
            bytesRead = fs.readSync(fd, buf, 0, readLen, size - readLen);
          } finally {
            fs.closeSync(fd);
          }
          const parsedLog = parseSteamContentLogForApp(
            buf.subarray(0, bytesRead).toString('utf8'),
            String(appId),
            minTimestampMs,
            nowMs
          );
          if (isRelevantParsedLog(parsedLog)) {
            bestLogInfo = parsedLog;
          } else if (!bestLogInfo && parsedLog.speedBytesPerSec > 0) {
            bestLogInfo = parsedLog;
          }
        } catch {}
      }
    }
    return bestLogInfo;
  };

  const readContentLogTailAsync = async (
    /** @type {Iterable<string>} */ steamRoots,
    minTimestampMs = 0,
    nowMs = Date.now()
  ) => {
    /** @type {any} */
    let bestLogInfo = null;
    for (const root of steamRoots) {
      const candidateLogs = [
        path.join(root, 'logs', 'content_log.txt'),
        path.join(root, 'Steam', 'logs', 'content_log.txt'),
      ];
      for (const logPath of candidateLogs) {
        /** @type {fs.promises.FileHandle | null} */
        let fh = null;
        try {
          const st = await fs.promises.stat(logPath);
          const size = Number(st.size || 0);
          if (size <= 0) continue;
          const readLen = Math.min(size, logTailMaxBytes);
          fh = await fs.promises.open(logPath, 'r');
          const buf = Buffer.alloc(readLen);
          const { bytesRead } = await fh.read(buf, 0, readLen, size - readLen);
          await fh.close();
          fh = null;
          const parsedLog = parseSteamContentLogForApp(
            buf.subarray(0, bytesRead).toString('utf8'),
            String(appId),
            minTimestampMs,
            nowMs
          );
          if (isRelevantParsedLog(parsedLog)) {
            bestLogInfo = parsedLog;
          } else if (!bestLogInfo && parsedLog.speedBytesPerSec > 0) {
            bestLogInfo = parsedLog;
          }
        } catch {
          // logPath does not exist or unreadable
        } finally {
          if (fh) {
            try {
              await fh.close();
            } catch {}
          }
        }
      }
    }
    return bestLogInfo;
  };

  /** @type {NodeJS.Timeout | null} */
  let timer = null;
  const stopMonitor = () => {
    if (timer) {
      clearInterval(timer);
    }
    downloadControllers.delete(taskId);
  };

  const runTick = () => {
    if (inFlightTick) return;
    inFlightTick = true;
    (async () => {
      const task = downloadQueueMap.get(taskId);
      if (
        !task ||
        task.status === 'cancelled' ||
        task.status === 'completed' ||
        task.status === 'failed'
      ) {
        stopMonitor();
        return;
      }

      if (task.status === 'paused') {
        return;
      }

      const nowMs = Date.now();
      const minTimestampMs = resolveTaskStartedAtMs(task);
      const shouldRefreshLocations =
        !cachedLocations ||
        !cachedLocations.steamappsDirs ||
        (Array.isArray(cachedLocations.steamappsDirs)
          ? cachedLocations.steamappsDirs.length === 0
          : cachedLocations.steamappsDirs.size === 0) ||
        !lastKnownManifestDir ||
        nowMs - cachedLocationsAt >= locationsCacheTtlMs;
      if (shouldRefreshLocations) {
        cachedLocations = discoverSteamLocations(options);
        cachedLocationsAt = nowMs;
      }
      let { steamRoots, steamappsDirs } = cachedLocations;
      const logInfo = options.syncLogSnapshot
        ? readContentLogTail(steamRoots, minTimestampMs, nowMs)
        : await readContentLogTailAsync(steamRoots, minTimestampMs, nowMs);

      /** @type {any} */
      let parsed = null;
      /** @type {string | null} */
      let matchedSteamappsDir = null;
      let acfMtimeMs = 0;

      const findManifestInDirsAsync = async (/** @type {Iterable<string>} */ dirs) => {
        const orderedDirs = [];
        if (lastKnownManifestDir) {
          orderedDirs.push(lastKnownManifestDir);
        }
        for (const dir of dirs) {
          if (dir !== lastKnownManifestDir) {
            orderedDirs.push(dir);
          }
        }
        for (const steamappsDir of orderedDirs) {
          const acfPath = path.join(steamappsDir, `appmanifest_${appId}.acf`);
          try {
            const [acfStat, acfText] = await Promise.all([
              fs.promises.stat(acfPath),
              fs.promises.readFile(acfPath, 'utf8'),
            ]);
            const candidateParsed = parseSteamAcf(acfText);
            if (candidateParsed && String(candidateParsed.appId) === String(appId)) {
              parsed = candidateParsed;
              matchedSteamappsDir = steamappsDir;
              lastKnownManifestDir = steamappsDir;
              acfMtimeMs = Number(acfStat?.mtimeMs || 0);
              break;
            }
          } catch {}
        }
      };

      await findManifestInDirsAsync(steamappsDirs);
      if (!matchedSteamappsDir && !shouldRefreshLocations) {
        cachedLocations = discoverSteamLocations(options);
        cachedLocationsAt = nowMs;
        steamRoots = cachedLocations.steamRoots;
        steamappsDirs = cachedLocations.steamappsDirs;
        await findManifestInDirsAsync(steamappsDirs);
      }

      const latestTask = downloadQueueMap.get(taskId);
      if (
        !latestTask ||
        latestTask.status === 'cancelled' ||
        latestTask.status === 'completed' ||
        latestTask.status === 'failed' ||
        latestTask.status === 'paused'
      ) {
        return;
      }

      if (!parsed && sawSteamActivity && logInfo?.updateCanceled && !logInfo.isRunning) {
        stopMonitor();
        updateDownloadTask(
          taskId,
          {
            status: 'cancelled',
            speedBytesPerSec: 0,
            etaSeconds: undefined,
            statusMessage: 'Installation cancelled in Steam client',
          },
          options
        );
        return;
      }

      const acfDownloaded = Number(parsed?.BytesDownloaded || 0);
      const acfTotal = Number(parsed?.BytesToDownload || 0);
      const acfStaged = Number(parsed?.BytesStaged || 0);
      const acfToStage = Number(parsed?.BytesToStage || 0);
      let logDownloaded = Number(logInfo?.bytesDownloaded || 0);
      const logTotal = Number(logInfo?.bytesToDownload || 0);
      const logStaged = Number(logInfo?.bytesStaged || 0);
      const logToStage = Number(logInfo?.bytesToStage || 0);

      if (acfTotal > 0 || logTotal > 0) {
        knownDownloadTotal = acfTotal > 0 ? acfTotal : logTotal;
      }
      if (acfToStage > 0 || logToStage > 0) {
        knownStageTotal = acfToStage > 0 ? acfToStage : logToStage;
      }

      if (
        acfTotal > 0 &&
        acfDownloaded === 0 &&
        logDownloaded >= acfTotal * 0.9 &&
        (!logInfo?.checkpointTs ||
          (minTimestampMs > 0 && logInfo.checkpointTs < minTimestampMs - 15000))
      ) {
        logDownloaded = 0;
      }

      const stateFlags = parsed && parsed.StateFlags ? String(parsed.StateFlags).trim() : '';
      const stateFlagsNum = stateFlags && /^\d+$/.test(stateFlags) ? Number(stateFlags) : NaN;
      const isStateFlagInstalled =
        stateFlags === '4' ||
        (Number.isFinite(stateFlagsNum) &&
          (stateFlagsNum & 4) === 4 &&
          (stateFlagsNum & (2 | 256 | 512 | 1024 | 2048)) === 0);
      const isAcfActivelyUpdating =
        Number.isFinite(stateFlagsNum) && (stateFlagsNum & (256 | 1024)) !== 0;

      const downloadTotal = acfTotal > 0 ? acfTotal : logTotal > 0 ? logTotal : knownDownloadTotal;
      const stageTotal = acfToStage > 0 ? acfToStage : logToStage > 0 ? logToStage : knownStageTotal;

      let estimatedFromRates = 0;
      const lastRateSampleTs =
        Array.isArray(logInfo?.rateSamples) && logInfo.rateSamples.length > 0
          ? Number(logInfo.rateSamples[logInfo.rateSamples.length - 1].tsMs || 0)
          : 0;
      const hasRecentRateTelemetry =
        lastRateSampleTs > 0 && nowMs >= lastRateSampleTs && nowMs - lastRateSampleTs <= 120000;
      const canExtrapolateRates = Boolean(
        logInfo?.isDownloading ||
          (isAcfActivelyUpdating &&
            !logInfo?.isSuspended &&
            !logInfo?.isCommitting &&
            !logInfo?.fullyInstalled)
      );

      if (
        acfDownloaded > 0 &&
        acfMtimeMs > 0 &&
        canExtrapolateRates &&
        hasRecentRateTelemetry &&
        Array.isArray(logInfo?.rateSamples) &&
        logInfo.rateSamples.length > 0
      ) {
        const anchorTs = Math.max(acfMtimeMs, Number(logInfo.checkpointTs || 0));
        const deltaAfterAcf = integrateSteamRateSamples(logInfo.rateSamples, anchorTs, nowMs, true);
        const rawEst = acfDownloaded + deltaAfterAcf;
        estimatedFromRates =
          downloadTotal > 0 ? Math.min(Math.floor(downloadTotal * 0.98), rawEst) : rawEst;
      } else if (acfDownloaded === 0) {
        const baseEstimated = Number(logInfo?.estimatedBytesDownloaded || 0);
        let fallbackIntegrated = 0;
        if (
          baseEstimated === 0 &&
          acfMtimeMs > 0 &&
          canExtrapolateRates &&
          hasRecentRateTelemetry &&
          Array.isArray(logInfo?.rateSamples) &&
          logInfo.rateSamples.length > 0
        ) {
          fallbackIntegrated = integrateSteamRateSamples(logInfo.rateSamples, acfMtimeMs, nowMs, true);
        }
        const rawEst = Math.max(baseEstimated, fallbackIntegrated);
        estimatedFromRates =
          downloadTotal > 0 ? Math.min(Math.floor(downloadTotal * 0.98), rawEst) : rawEst;
      }

      const rawDownloadDone = Math.max(acfDownloaded, logDownloaded, estimatedFromRates);
      const downloadDone =
        downloadTotal > 0 ? Math.min(downloadTotal, rawDownloadDone) : rawDownloadDone;

      const stageDone =
        stageTotal > 0
          ? Math.min(stageTotal, Math.max(acfStaged, logStaged))
          : Math.max(acfStaged, logStaged);

      let effectiveTotal = 0;
      let effectiveDownloaded = 0;

      if (downloadTotal > 0) {
        effectiveTotal = downloadTotal;
        effectiveDownloaded = downloadDone;
      } else if (stageTotal > 0) {
        effectiveTotal = stageTotal;
        effectiveDownloaded = stageDone;
      } else {
        effectiveTotal = Number(parsed?.SizeOnDisk || 0) || latestTask.totalBytes || 0;
        effectiveDownloaded = downloadDone || stageDone || 0;
      }

      if (
        effectiveTotal > 0 &&
        latestTask.totalBytes === effectiveTotal &&
        Number(latestTask.bytesDownloaded || 0) > effectiveDownloaded
      ) {
        effectiveDownloaded = Math.min(effectiveTotal, Number(latestTask.bytesDownloaded));
      }

      const commonInstallPath =
        matchedSteamappsDir && parsed
          ? path.join(matchedSteamappsDir, 'common', parsed.installdir || String(appId))
          : null;

      let commonInstallExists = false;
      if (commonInstallPath) {
        try {
          await fs.promises.access(commonInstallPath);
          commonInstallExists = true;
        } catch {}
      }

      const isComplete =
        Boolean(parsed) &&
        (isStateFlagInstalled || Boolean(logInfo?.fullyInstalled)) &&
        commonInstallExists &&
        (acfTotal === 0 || acfDownloaded >= acfTotal || Boolean(logInfo?.fullyInstalled));

      if (isComplete && commonInstallPath) {
        stopMonitor();

        const hostPlat = options.platform || process.platform;
        const appInfoSpec = resolveSteamAppInfoLaunchSpec(
          matchedSteamappsDir || commonInstallPath,
          appId,
          commonInstallPath,
          { platform: hostPlat }
        );
        const exeDiscovery =
          appInfoSpec && appInfoSpec.executablePath
            ? {
                executablePath: appInfoSpec.executablePath,
                isWindowsBinaryOnMac: appInfoSpec.isWindowsBinaryOnMac,
              }
            : findPrimaryExecutable(commonInstallPath, {
                platform: hostPlat,
                hintName: parsed.name || latestTask.title,
              });
        const isInsideBottle = /(?:^|[\\/])(Bottles|drive_c)(?:[\\/]|$)/i.test(commonInstallPath);
        const isWinOnMac =
          Boolean(exeDiscovery.isWindowsBinaryOnMac) ||
          (hostPlat === 'darwin' && isInsideBottle);
        const launchArguments =
          appInfoSpec?.launchArguments ||
          resolveDefaultEngineLaunchArguments(commonInstallPath, exeDiscovery.executablePath);

        const finalSize =
          Number(parsed.SizeOnDisk || 0) ||
          getDirectorySizeFast(commonInstallPath, 3) ||
          effectiveTotal ||
          latestTask.totalBytes;

        upsertManagedInstallRecord(
          {
            platformId: 'steam',
            platformGameId: String(appId),
            appId: Number(appId),
            title: parsed.name || latestTask.title,
            installPath: commonInstallPath,
            executablePath: exeDiscovery.executablePath,
            ...(launchArguments ? { launchArguments } : {}),
            installSize: finalSize,
            version: parsed.buildid ? String(parsed.buildid) : undefined,
            runner: 'steam',
            isWindowsBinaryOnMac: isWinOnMac,
          },
          options.userDataDir
        );

        updateDownloadTask(
          taskId,
          {
            status: 'completed',
            progressPercent: 100,
            bytesDownloaded: finalSize,
            totalBytes: finalSize,
            speedBytesPerSec: 0,
            etaSeconds: 0,
            finalInstallPath: commonInstallPath,
            executablePath: exeDiscovery.executablePath,
            ...(launchArguments ? { launchArguments } : {}),
            runner: 'steam',
            isWindowsBinaryOnMac: isWinOnMac,
            statusMessage: 'Installed via Steam',
          },
          options
        );
        return;
      }

      const hasActiveLogProgress = Boolean(
        logInfo &&
          (logInfo.updateStarted ||
            logInfo.isRunning ||
            logInfo.fullyInstalled ||
            logInfo.bytesToDownload > 0 ||
            logInfo.bytesToStage > 0 ||
            logInfo.phase)
      );

      if (!parsed && !hasActiveLogProgress) {
        if (!sawSteamActivity && retriggerCtx && !retriggerCtx.wasAuthenticatedAtLaunch) {
          if (retriggerCount < maxRetriggers) {
            const nowAuthed = await hasAuthenticatedSteamSessionInVdfCandidates(
              retriggerCtx.vdfCandidates,
              retriggerCtx.expectedSteamId64
            );
            const postAuthTask = downloadQueueMap.get(taskId);
            if (
              !postAuthTask ||
              postAuthTask.status === 'cancelled' ||
              postAuthTask.status === 'completed' ||
              postAuthTask.status === 'failed' ||
              postAuthTask.status === 'paused'
            ) {
              return;
            }
            if (nowAuthed) {
              const checkNowMs = Date.now();
              if (!authDetectedAtMs) {
                authDetectedAtMs = checkNowMs;
                invalidateScanCaches();
                cachedLocations = null;
              }
              const postLoginDelayMs = Number(
                options.steamPostLoginRetriggerDelayMs ?? (isTestEnvironment(options) ? 20 : 2500)
              );
              const secondRetryDelayMs = Number(
                options.steamPostLoginSecondRetryMs ?? (isTestEnvironment(options) ? 80 : 8000)
              );
              if (retriggerCount === 0 && checkNowMs - authDetectedAtMs >= postLoginDelayMs) {
                retriggerCount = 1;
                lastRetriggerAtMs = checkNowMs;
                invalidateScanCaches();
                cachedLocations = null;
                try {
                  await retriggerCtx.retriggerInstallAsync();
                } catch (retriggerErr) {
                  diagLog.debug('startSteamInstallMonitor.retrigger', retriggerErr, {
                    taskId,
                    appId,
                    attempt: 1,
                  });
                }
              } else if (
                retriggerCount === 1 &&
                checkNowMs - lastRetriggerAtMs >= secondRetryDelayMs
              ) {
                retriggerCount = 2;
                lastRetriggerAtMs = checkNowMs;
                invalidateScanCaches();
                cachedLocations = null;
                try {
                  await retriggerCtx.retriggerInstallAsync();
                } catch (retriggerErr) {
                  diagLog.debug('startSteamInstallMonitor.retrigger', retriggerErr, {
                    taskId,
                    appId,
                    attempt: 2,
                  });
                }
              }
            }
          }

          const pendingAuthStatusMsg =
            retriggerCount >= 1 || authDetectedAtMs > 0
              ? retriggerCtx.launchedViaWineSteam
                ? 'Steam sign-in detected in bottle — triggering game download...'
                : 'Steam sign-in detected — triggering game download...'
              : retriggerCtx.launchedViaWineSteam
                ? 'Installing via Windows Steam in CrossOver / Wine (waiting for Steam sign-in — download starts automatically once signed in)...'
                : 'Installing via Steam client (waiting for Steam sign-in — download starts automatically once signed in)...';

          updateDownloadTask(
            taskId,
            {
              status: 'downloading',
              progressPercent: 0,
              bytesDownloaded: 0,
              speedBytesPerSec: 0,
              statusMessage: pendingAuthStatusMsg,
            },
            options
          );
          return;
        }

        updateDownloadTask(
          taskId,
          {
            status: 'downloading',
            progressPercent: 0,
            bytesDownloaded: 0,
            speedBytesPerSec: 0,
            statusMessage: 'Waiting for confirmation in Steam client...',
          },
          options
        );
        return;
      }

      sawSteamActivity = true;

      const phaseLabel =
        logInfo?.phase ||
        (acfStaged > 0 && acfTotal > 0 && acfDownloaded >= acfTotal ? 'Staging' : 'Downloading');

      if (logInfo?.isCommitting || /^finalizing$/i.test(phaseLabel)) {
        if (effectiveTotal > 0) {
          effectiveDownloaded = Math.max(effectiveDownloaded, Math.floor(effectiveTotal * 0.99));
        }
      }

      const rawRatio = effectiveTotal > 0 ? effectiveDownloaded / effectiveTotal : 0;
      let progressPercent =
        effectiveTotal > 0
          ? Math.min(99, Math.max(latestTask.progressPercent || 0, Math.floor(rawRatio * 100)))
          : latestTask.progressPercent || 0;

      if (logInfo?.isCommitting || /^finalizing$/i.test(phaseLabel)) {
        progressPercent = 99;
      } else if (effectiveDownloaded === 0 && /preallocating|allocating/i.test(phaseLabel)) {
        progressPercent = 0;
      }

      const now = Date.now();
      let rawSpeedBytesPerSec = canExtrapolateRates ? Number(logInfo?.speedBytesPerSec || 0) : 0;
      if (!rawSpeedBytesPerSec && effectiveDownloaded > lastBytes && now > lastTickTime) {
        rawSpeedBytesPerSec = Math.round(((effectiveDownloaded - lastBytes) * 1000) / (now - lastTickTime));
      }
      lastBytes = effectiveDownloaded;
      lastTickTime = now;

      const speedBytesPerSec =
        logInfo?.isSuspended || logInfo?.isCommitting
          ? 0
          : computeSmoothedDownloadSpeed(taskId, {
              bytesDownloaded: effectiveDownloaded,
              rawSpeedBytesPerSec,
              nowMs: now,
            });

      const etaSeconds =
        speedBytesPerSec > 0 && effectiveTotal > effectiveDownloaded
          ? Math.max(1, Math.round((effectiveTotal - effectiveDownloaded) / speedBytesPerSec))
          : logInfo?.isCommitting
            ? 1
            : latestTask.etaSeconds;

      const nextStatus = /staging|extracting|finalizing/i.test(phaseLabel)
        ? 'extracting'
        : /verifying/i.test(phaseLabel)
          ? 'verifying'
          : 'downloading';

      const statusMessage =
        effectiveDownloaded === 0 && /preallocating|allocating/i.test(phaseLabel)
          ? `Steam: Preallocating ${latestTask.title} (0%)...`
          : `Steam: ${phaseLabel} ${latestTask.title} (${progressPercent}%)...`;

      updateDownloadTask(
        taskId,
        {
          status: nextStatus,
          progressPercent,
          bytesDownloaded: effectiveDownloaded,
          totalBytes: effectiveTotal,
          speedBytesPerSec,
          etaSeconds,
          statusMessage,
        },
        options
      );
    })()
      .catch((tickErr) => {
        diagLog.debug('startSteamInstallMonitor.tick', tickErr, { taskId, appId });
      })
      .finally(() => {
        inFlightTick = false;
      });
  };

  timer = setInterval(runTick, intervalMs);
  if (typeof timer.unref === 'function') {
    timer.unref();
  }
  downloadControllers.set(taskId, { type: 'timer', timer });
  Promise.resolve().then(runTick);
  return timer;
}

/**
 * Background monitor for Windows Native GamingServices / Xbox App installations.
 * Uses targeted `Get-AppxPackage -Name '<identityName>'` (~60ms) instead of full package enumeration.
 */
function startXboxInstallMonitor(
  /** @type {string} */ taskId,
  /** @type {any} */ payload = {},
  /** @type {any} */ options = {}
) {
  const intervalMs = Math.max(250, Number(options.xboxInstallPollIntervalMs || 2000));
  const cleanStoreId = String(
    payload.cleanStoreId || payload.xboxProductId || payload.storeId || payload.platformGameId || ''
  )
    .replace(/^xbox[-_:]/i, '')
    .trim()
    .toUpperCase();
  const targetPfn = String(payload.packageFamilyName || '').trim();
  const targetIdentityName = String(payload.identityName || '').trim();
  const targetTitleNorm = normalizeComparableTitle(payload.title || '');

  let lastBytes = 0;
  let lastTickTime = Date.now();
  let inFlightTick = false;
  /** @type {NodeJS.Timeout | null} */
  let timer = null;

  const stopMonitor = () => {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
    downloadControllers.delete(taskId);
  };

  const queryAppxStatusAsync = async () => {
    if ((options.platform || process.platform) !== 'win32') return null;
    if (isTestEnvironment(options) && !options.execFileImpl && !options.execFileFn) {
      return null;
    }
    if (!targetPfn && !targetIdentityName) return null;
    const res = await queryTargetedAppxPackageAsync(
      {
        identityName: targetIdentityName,
        packageFamilyName: targetPfn,
        selectFields: 'Name,PackageFamilyName,InstallLocation,Status,Version',
      },
      options
    );
    return res && res.found && res.pkg ? res.pkg : null;
  };

  const runTick = () => {
    if (inFlightTick) return;
    inFlightTick = true;
    (async () => {
      const task = downloadQueueMap.get(taskId);
      if (
        !task ||
        task.status === 'cancelled' ||
        task.status === 'completed' ||
        task.status === 'failed'
      ) {
        stopMonitor();
        return;
      }
      if (task.status === 'paused') return;

      const scanRoots = collectXboxLibraryRoots({
        ...options,
        platform: options.platform || process.platform,
        customRoots: payload.installDir ? [payload.installDir, ...(options.customRoots || [])] : options.customRoots,
      });

      /** @type {string | null} */
      let matchedDir = null;
      /** @type {any} */
      let matchedInspected = null;

      for (const rootDir of scanRoots) {
        /** @type {fs.Dirent[]} */
        let subEntries = [];
        try {
          subEntries = await fs.promises.readdir(rootDir, { withFileTypes: true });
        } catch {
          continue;
        }
        for (const ent of subEntries) {
          if (!ent.isDirectory() || ent.name.startsWith('.')) continue;
          const candidateDir = path.join(rootDir, ent.name);
          const inspected = inspectInstalledXboxGameDir(candidateDir, {
            ...options,
            platform: options.platform || process.platform,
          });
          if (inspected) {
            const matchesId =
              (cleanStoreId &&
                String(inspected.xboxProductId || '').toUpperCase() === cleanStoreId) ||
              (targetPfn &&
                String(inspected.packageFamilyName || '').toLowerCase() ===
                  targetPfn.toLowerCase());
            const matchesTitle =
              !cleanStoreId &&
              !targetPfn &&
              targetTitleNorm &&
              normalizeComparableTitle(ent.name) === targetTitleNorm;
            if (matchesId || matchesTitle) {
              matchedDir = candidateDir;
              matchedInspected = inspected;
              break;
            }
          } else if (targetTitleNorm && normalizeComparableTitle(ent.name) === targetTitleNorm) {
            matchedDir = candidateDir;
          }
        }
        if (matchedInspected) break;
      }

      const appxInfo = await queryAppxStatusAsync();
      if (!matchedDir && appxInfo?.InstallLocation) {
        matchedDir = String(appxInfo.InstallLocation).trim();
        matchedInspected = inspectInstalledXboxGameDir(matchedDir, {
          ...options,
          platform: options.platform || process.platform,
        });
      }

      const latestTask = downloadQueueMap.get(taskId);
      if (
        !latestTask ||
        ['cancelled', 'completed', 'failed', 'paused'].includes(latestTask.status)
      ) {
        return;
      }

      const currentDiskBytes = matchedDir ? Math.max(0, getDirectorySizeFast(matchedDir, 4)) : 0;
      const effectiveTotal = Math.max(Number(latestTask.totalBytes || 0), currentDiskBytes);
      const appxReady = !appxInfo || !appxInfo.Status || /^ok$/i.test(String(appxInfo.Status));

      if (
        matchedInspected &&
        matchedInspected.executablePath &&
        fs.existsSync(matchedInspected.executablePath) &&
        appxReady &&
        (effectiveTotal === 0 || currentDiskBytes >= effectiveTotal * 0.95 || appxInfo?.InstallLocation)
      ) {
        stopMonitor();
        const finalSize =
          sanitizeGameInstallSizeBytes(currentDiskBytes) ||
          sanitizeGameInstallSizeBytes(effectiveTotal);

        upsertManagedInstallRecord(
          {
            platformId: 'xbox',
            platformGameId: matchedInspected.platformGameId || cleanStoreId || payload.platformGameId,
            xboxProductId: matchedInspected.xboxProductId || cleanStoreId || undefined,
            packageFamilyName: matchedInspected.packageFamilyName || targetPfn || undefined,
            appUserModelId: matchedInspected.appUserModelId || undefined,
            xboxTitleId: matchedInspected.xboxTitleId || undefined,
            scid: matchedInspected.scid || undefined,
            msaAppId: matchedInspected.msaAppId || undefined,
            title: matchedInspected.title || latestTask.title,
            installPath: matchedInspected.installPath || matchedDir,
            executablePath: matchedInspected.executablePath,
            installSize: finalSize,
            version: matchedInspected.version || appxInfo?.Version || undefined,
            runner: 'xbox',
            isWindowsBinaryOnMac: false,
          },
          options.userDataDir
        );
        invalidateScanCaches();

        updateDownloadTask(
          taskId,
          {
            status: 'completed',
            progressPercent: 100,
            bytesDownloaded: finalSize || effectiveTotal,
            totalBytes: finalSize || effectiveTotal,
            speedBytesPerSec: 0,
            etaSeconds: undefined,
            finalInstallPath: matchedInspected.installPath || matchedDir,
            executablePath: matchedInspected.executablePath,
            runner: 'xbox',
            statusMessage: 'Installed via Windows Xbox GamingServices',
          },
          options
        );
        return;
      }

      if (currentDiskBytes > 0) {
        const now = Date.now();
        const rawSpeed =
          currentDiskBytes > lastBytes && now > lastTickTime
            ? Math.round(((currentDiskBytes - lastBytes) * 1000) / (now - lastTickTime))
            : 0;
        lastBytes = currentDiskBytes;
        lastTickTime = now;

        const speedBytesPerSec = computeSmoothedDownloadSpeed(taskId, {
          bytesDownloaded: currentDiskBytes,
          rawSpeedBytesPerSec: rawSpeed,
          nowMs: now,
        });
        const pct =
          effectiveTotal > 0
            ? Math.min(99, Math.round((currentDiskBytes / effectiveTotal) * 100))
            : 0;
        const etaSeconds =
          speedBytesPerSec > 0 && effectiveTotal > currentDiskBytes
            ? Math.max(1, Math.round((effectiveTotal - currentDiskBytes) / speedBytesPerSec))
            : latestTask.etaSeconds;

        updateDownloadTask(
          taskId,
          {
            status: 'downloading',
            progressPercent: pct,
            bytesDownloaded: currentDiskBytes,
            totalBytes: effectiveTotal,
            speedBytesPerSec,
            etaSeconds,
            statusMessage: `Xbox GamingServices: Installing ${latestTask.title} (${pct}%)...`,
          },
          options
        );
      }
    })()
      .catch((tickErr) => {
        diagLog.debug('startXboxInstallMonitor.tick', tickErr, { taskId, cleanStoreId });
      })
      .finally(() => {
        inFlightTick = false;
      });
  };

  timer = setInterval(runTick, intervalMs);
  if (typeof timer.unref === 'function') timer.unref();
  downloadControllers.set(taskId, { type: 'timer', timer });
  Promise.resolve().then(runTick);
  return timer;
}

/**
 * Ensure Windows Steam (steam.exe) is installed inside a CrossOver / Wine bottle on macOS.
 */
async function ensureWindowsSteamInBottle(
  /** @type {any} */ layer,
  /** @type {string} */ bottleName,
  /** @type {string} */ bottlePath,
  /** @type {string | null} */ taskId,
  /** @type {any} */ options = {}
) {
  if (!bottlePath) return null;
  const existingSteamExe = resolveBottleSteamExe(bottlePath);
  if (existingSteamExe) return existingSteamExe;

  if (
    options.disableWineSteamSpawn ||
    options.homedir ||
    !layer?.binaryPath ||
    !fs.existsSync(layer.binaryPath)
  ) {
    return null;
  }

  try {
    if (taskId) {
      updateDownloadTask(
        taskId,
        {
          statusMessage: 'Bootstrapping Windows Steam client inside CrossOver bottle...',
        },
        options
      );
    }

    const tempDir = path.join(bottlePath, 'drive_c/windows/temp');
    fs.mkdirSync(tempDir, { recursive: true });
    const steamSetupPath = path.join(tempDir, 'SteamSetup.exe');

    if (!fs.existsSync(steamSetupPath) && typeof fetch === 'function') {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 30000);
      try {
        const res = await fetch('https://cdn.akamai.steamstatic.com/client/installer/SteamSetup.exe', {
          signal: controller.signal,
        });
        if (res.ok) {
          const arrayBuf = await res.arrayBuffer();
          fs.writeFileSync(steamSetupPath, Buffer.from(arrayBuf));
        }
      } finally {
        clearTimeout(timeout);
      }
    }

    if (!fs.existsSync(steamSetupPath)) {
      return null;
    }

    await new Promise((resolve) => {
      let finished = false;
      const done = () => {
        if (finished) return;
        finished = true;
        clearInterval(pollTimer);
        clearTimeout(maxTimer);
        resolve(undefined);
      };

      const pollTimer = setInterval(() => {
        if (resolveBottleSteamExe(bottlePath)) {
          done();
        }
      }, 500);
      if (typeof pollTimer.unref === 'function') pollTimer.unref();

      const maxTimer = setTimeout(done, 45000);
      if (typeof maxTimer.unref === 'function') maxTimer.unref();

      try {
        const child = spawn(layer.binaryPath, [steamSetupPath, '/S'], {
          env: {
            ...process.env,
            CX_BOTTLE: bottleName,
            WINEPREFIX: bottlePath,
          },
          stdio: 'ignore',
        });
        child.on('error', done);
        child.on('exit', done);
      } catch {
        done();
      }
    });

    return resolveBottleSteamExe(bottlePath);
  } catch {
    return null;
  }
}

async function sweepStaleGogTempBinsAsync(/** @type {string[]} */ targetDirs = []) {
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
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const ent of entries) {
      if (ent.isFile() && /^\.gog_v1_.*_main\.bin$/i.test(ent.name)) {
        const fullPath = path.join(dir, ent.name);
        if (activeBinPaths.has(path.resolve(fullPath))) continue;
        try {
          const st = await fs.promises.stat(fullPath);
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
}

/**
 * Resolve installation options, disk space, platform builds, and size telemetry for a game.
 */
async function getGameInstallInfo(/** @type {any} */ payload = {}, /** @type {any} */ options = {}) {
  const storeSync = getStoreSync();
  const platformId = payload.platformId || 'custom';
  const platformGameId = String(payload.platformGameId || payload.gameId || '');
  const platform = options.platform || process.platform;
  const homedir = options.homedir || os.homedir();

  let defaultInstallDir = getDefaultInstallDir(platformId, options);
  /** @type {string[]} */
  let availableInstallDirs;
  if (platform === 'darwin') {
    availableInstallDirs = [defaultInstallDir, '/Applications', path.join(homedir, 'Applications')];
  } else if (
    (platform === 'win32' &&
      (options.discoverWindowsDrivesInTest === true ||
        Array.isArray(options.mountedDriveRoots))) ||
    (process.platform === 'win32' && !options.homedir)
  ) {
    const localDrives = await discoverWindowsLocalDrivesAsync(options);
    const mountedDrives = localDrives.map((root) => path.win32.join(root, 'Games'));
    availableInstallDirs = Array.from(new Set([defaultInstallDir, ...mountedDrives]));
  } else {
    availableInstallDirs = [defaultInstallDir, 'C:\\Games', 'D:\\Games'];
  }

  const targetDir = payload.targetInstallDir || defaultInstallDir;
  let diskSpace = await getDiskSpace(targetDir, options);

  let estimatedSizeBytes = sanitizeGameInstallSizeBytes(
    payload.estimatedSizeBytes ? Number(payload.estimatedSizeBytes) : undefined
  );
  /** @type {number | undefined} */
  let downloadSizeBytes = undefined;
  /** @type {number | undefined} */
  let dlcSizeBytes = undefined;
  /** @type {any[]} */
  let availableInstallers = [];
  let canDirectDownload = false;
  let requiresStoreClientFallback = false;
  /** @type {any} */
  let xboxCompatibility = undefined;
  /** @type {string | undefined} */
  let externalLauncher = undefined;
  /** @type {string | undefined} */
  let externalLauncherUrl = undefined;
  let isCrossPlatformBottleInstall = false;
  const cacheScope =
    options.userDataDir || options.homedir ? `${options.userDataDir || options.homedir}:` : '';

  if (platformId === 'gog') {
    canDirectDownload = true;
    const savedTokens =
      options.savedTokens ||
      (storeSync && typeof storeSync.loadSavedTokens === 'function' ? storeSync.loadSavedTokens() : {});
    /** @type {any} */
    let authRes = null;
    if (!options.skipNetwork) {
      try {
        authRes = await ensureGogdlAuthConfig(options);
      } catch {}
    }
    let gogToken = options.gogAccessToken || authRes?.accessToken || savedTokens?.gog?.access_token;
    const cleanId = platformGameId.replace(/^gog-/i, '');
    const titleLabel = payload.title || 'Game';

    const readCachedGogOs = (/** @type {string} */ osKey) => {
      if (!cleanId) return null;
      const entry = installInfoSizeCache.get(`${cacheScope}gog:${cleanId}:${osKey}`);
      if (!entry) return null;
      return typeof entry === 'number' ? { diskSize: sanitizeGameInstallSizeBytes(entry) } : entry;
    };

    const cachedMac = readCachedGogOs('mac');
    const cachedWin = readCachedGogOs('windows');
    let macSizeBytes = sanitizeGameInstallSizeBytes(cachedMac?.diskSize);
    let macDownloadBytes = sanitizeGameInstallSizeBytes(cachedMac?.downloadSize);
    let macDlcBytes = sanitizeGameInstallSizeBytes(cachedMac?.dlcSize);
    let hasAuthoritativeMacDisk = Boolean(cachedMac?.fromGogdl && macSizeBytes);
    let winSizeBytes = sanitizeGameInstallSizeBytes(cachedWin?.diskSize);
    let winDownloadBytes = sanitizeGameInstallSizeBytes(cachedWin?.downloadSize);
    let winDlcBytes = sanitizeGameInstallSizeBytes(cachedWin?.dlcSize);
    let hasAuthoritativeWinDisk = Boolean(cachedWin?.fromGogdl && winSizeBytes);

    const fetchGogProduct = async (/** @type {string} */ token) => {
      if (!token || !cleanId || options.skipNetwork) return null;
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 4500);
      try {
        const res = await fetch(
          `https://api.gog.com/products/${encodeURIComponent(cleanId)}?expand=downloads,description`,
          {
            headers: {
              Authorization: `Bearer ${token}`,
              'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) GOGGalaxy/2.0',
            },
            signal: controller.signal,
          }
        );
        clearTimeout(timeout);
        if (res.ok) {
          return await res.json();
        }
        return null;
      } catch {
        clearTimeout(timeout);
        return null;
      }
    };

    const normalizeInstallerVersion = (/** @type {any} */ v) => {
      if (v === undefined || v === null) return undefined;
      const cleaned = String(v).trim().replace(/^[vV]+/, '');
      return cleaned || undefined;
    };

    /** @type {any} */
    let productData = null;
    if (cleanId && (!options.skipNetwork || options.mockGogProductData)) {
      productData = options.mockGogProductData || (await fetchGogProduct(gogToken));
      if (!options.mockGogProductData && (!productData || !productData.downloads) && gogToken) {
        try {
          const refreshedAuth = await ensureGogdlAuthConfig({
            ...options,
            forceTokenRefresh: true,
          });
          if (refreshedAuth?.accessToken && refreshedAuth.accessToken !== gogToken) {
            gogToken = refreshedAuth.accessToken;
            productData = await fetchGogProduct(gogToken);
          }
        } catch {}
      }

      if (productData && productData.downloads) {
        const rawInstallers = Array.isArray(productData?.downloads?.installers)
          ? productData.downloads.installers
          : [];
        const mappedInstallers = rawInstallers.map((/** @type {any} */ ins, /** @type {number} */ idx) => {
          const normOs =
            ins.os === 'mac' || ins.os === 'osx'
              ? 'mac'
              : ins.os === 'linux'
                ? 'linux'
                : 'windows';
          const baseName = ins.name || titleLabel;
          return {
            id: String(ins.id || `ins-${idx}`),
            name:
              normOs === 'mac'
                ? `${baseName} — Native macOS Build`
                : normOs === 'windows'
                  ? `${baseName} — Windows Build`
                  : baseName,
            os: normOs,
            language: ins.language || 'en',
            totalSizeBytes: sanitizeGameInstallSizeBytes(Number(ins.total_size || 0)),
            version: normalizeInstallerVersion(ins.version),
          };
        });

        const platformFiltered =
          platform === 'win32'
            ? mappedInstallers.filter((/** @type {any} */ i) => i.os === 'windows')
            : mappedInstallers.filter((/** @type {any} */ i) => i.os === 'mac' || i.os === 'windows');

        const osGroups = new Map();
        for (const ins of platformFiltered) {
          if (!osGroups.has(ins.os)) {
            osGroups.set(ins.os, []);
          }
          osGroups.get(ins.os).push(ins);
        }

        const dedupedInstallers = [];
        for (const [, candidates] of osGroups.entries()) {
          candidates.sort((/** @type {any} */ a, /** @type {any} */ b) => {
            const langDiff =
              (/^en/i.test(a.language || '') ? 0 : 1) - (/^en/i.test(b.language || '') ? 0 : 1);
            if (langDiff !== 0) return langDiff;
            return (b.totalSizeBytes || 0) - (a.totalSizeBytes || 0);
          });
          if (candidates[0]) {
            dedupedInstallers.push(candidates[0]);
          }
        }

        availableInstallers = dedupedInstallers;

        if (platform === 'win32') {
          availableInstallers = availableInstallers.map((i) => ({
            ...i,
            name: `${titleLabel} — Windows Native Build`,
          }));
        } else if (platform === 'darwin' && availableInstallers.length > 0) {
          const orderScore = (/** @type {string} */ osVal) =>
            osVal === 'mac' ? 0 : osVal === 'windows' ? 1 : 2;
          availableInstallers.sort((a, b) => orderScore(a.os) - orderScore(b.os));
          const hasMacInstaller = availableInstallers.some((i) => i.os === 'mac');
          if (!hasMacInstaller) {
            availableInstallers = availableInstallers.map((i) =>
              i.os === 'windows'
                ? {
                    ...i,
                    name: `${titleLabel} — Windows Build (CrossOver / Wine Fallback, No macOS Native Build)`,
                  }
                : i
            );
          }
        }

        const macFromProduct = availableInstallers.find((i) => i.os === 'mac')?.totalSizeBytes;
        const winFromProduct = availableInstallers.find((i) => i.os === 'windows')?.totalSizeBytes;
        if (!hasAuthoritativeMacDisk && macFromProduct) macSizeBytes = macFromProduct;
        if (!hasAuthoritativeWinDisk && winFromProduct) winSizeBytes = winFromProduct;
      }

      if (availableInstallers.length === 0 && !options.skipNetwork && !options.mockGogProductData) {
        const fetchBuilds = async (/** @type {string} */ osType) => {
          const controller = new AbortController();
          const timeout = setTimeout(() => controller.abort(), 3000);
          try {
            const res = await fetch(
              `https://content-system.gog.com/products/${encodeURIComponent(cleanId)}/os/${osType}/builds?generation=2`,
              { signal: controller.signal }
            );
            clearTimeout(timeout);
            if (res.ok) return /** @type {any} */ (await res.json());
          } catch {}
          clearTimeout(timeout);
          return null;
        };

        try {
          const [osxBuilds, winBuilds] = await Promise.all([
            platform === 'win32' ? Promise.resolve(null) : fetchBuilds('osx'),
            fetchBuilds('windows'),
          ]);
          const hasMacDepot =
            platform !== 'win32' && Array.isArray(osxBuilds?.items) && osxBuilds.items.length > 0;
          const hasWinDepot = Array.isArray(winBuilds?.items) && winBuilds.items.length > 0;

          if (hasMacDepot || hasWinDepot) {
            if (hasMacDepot) {
              availableInstallers.push({
                id: 'gog-mac-native',
                name: `${titleLabel} — Native macOS Build`,
                os: 'mac',
                language: 'en',
                totalSizeBytes: macSizeBytes,
                version: normalizeInstallerVersion(osxBuilds.items[0]?.version_name),
              });
            }
            if (hasWinDepot) {
              availableInstallers.push({
                id: platform === 'win32' ? 'gog-win-native' : 'gog-win-compat',
                name:
                  platform === 'win32'
                    ? `${titleLabel} — Windows Native Build`
                    : platform === 'darwin' && !hasMacDepot
                      ? `${titleLabel} — Windows Build (CrossOver / Wine Fallback, No macOS Native Build)`
                      : `${titleLabel} — Windows Build`,
                os: 'windows',
                language: 'en',
                totalSizeBytes: winSizeBytes,
                version: normalizeInstallerVersion(winBuilds.items[0]?.version_name),
              });
            }
          }
        } catch {}
      }
    }

    const storeSupportsWin =
      availableInstallers.some((i) => i.os === 'windows') ||
      Boolean(productData?.content_system_compatibility?.windows) ||
      Boolean(payload.storePlatforms?.windows);

    if (
      platform === 'darwin' &&
      availableInstallers.some((i) => i.os === 'mac') &&
      !availableInstallers.some((i) => i.os === 'windows') &&
      (productData?.content_system_compatibility?.windows === true ||
        payload.storePlatforms?.windows === true)
    ) {
      availableInstallers.push({
        id: 'gog-win-compat',
        name: `${titleLabel} — Windows Build via CrossOver / Wine`,
        os: 'windows',
        language: 'en',
        totalSizeBytes: winSizeBytes,
      });
    }

    const needsMacGogdl =
      platform === 'darwin' &&
      !hasAuthoritativeMacDisk &&
      (availableInstallers.some((i) => i.os === 'mac') ||
        (availableInstallers.length === 0 && !estimatedSizeBytes));
    const needsWinGogdl =
      !hasAuthoritativeWinDisk &&
      (availableInstallers.some((i) => i.os === 'windows') ||
        (availableInstallers.length === 0 && !estimatedSizeBytes));

    if (
      (needsMacGogdl || needsWinGogdl) &&
      cleanId &&
      !options.skipNetwork &&
      !options.mockGogProductData &&
      (!options.homedir || typeof options.execFileFn === 'function')
    ) {
      try {
        const execFileImpl = typeof options.execFileFn === 'function' ? options.execFileFn : execFile;
        const gogdlBin = findGogdlBinary(options);
        const gogAuthPath = authRes?.configPath || authRes?.gogAuthPath;
        if (gogdlBin && gogAuthPath && fs.existsSync(gogAuthPath)) {
          const extractNodeSizes = (/** @type {any} */ node) => {
            if (!node || typeof node !== 'object') return { diskSize: undefined, downloadSize: undefined };
            let rawDisk = Number(node.disk_size || node.download_size || 0);
            let rawDl = Number(node.download_size || node.disk_size || 0);
            if ((!Number.isFinite(rawDisk) || rawDisk <= 0) && node.size && typeof node.size === 'object') {
              const starNode =
                node.size['*'] && typeof node.size['*'] === 'object' ? node.size['*'] : null;
              const starDisk = Math.max(
                0,
                Number(starNode?.disk_size ?? starNode?.download_size ?? 0) || 0
              );
              const starDl = Math.max(
                0,
                Number(starNode?.download_size ?? starNode?.disk_size ?? 0) || 0
              );

              const langKeys = Object.keys(node.size).filter((k) => k !== '*');
              const enKey = langKeys.find((k) => /^en(?:[-_][a-z]+)?$|^english$/i.test(k));
              let langNode = enKey ? node.size[enKey] : null;
              if (!langNode && langKeys.length > 0) {
                let bestDisk = 0;
                for (const k of langKeys) {
                  const val = node.size[k];
                  const candDisk = Number(val?.disk_size ?? val?.download_size ?? 0) || 0;
                  if (candDisk > bestDisk) {
                    bestDisk = candDisk;
                    langNode = val;
                  }
                }
              }

              const langDisk = Math.max(
                0,
                Number(langNode?.disk_size ?? langNode?.download_size ?? 0) || 0
              );
              const langDl = Math.max(
                0,
                Number(langNode?.download_size ?? langNode?.disk_size ?? 0) || 0
              );

              rawDisk = starDisk + langDisk;
              rawDl = starDl + langDl;
            }
            const validDisk = sanitizeGameInstallSizeBytes(rawDisk);
            const validDl = sanitizeGameInstallSizeBytes(rawDl);
            return { diskSize: validDisk, downloadSize: validDl || validDisk };
          };

          const runGogdlInfo = (/** @type {string} */ osFlag) =>
            new Promise((resolve) => {
              execFileImpl(
                gogdlBin,
                ['--auth-config-path', gogAuthPath, 'info', cleanId, '--platform', osFlag],
                { timeout: 15000, maxBuffer: 8 * 1024 * 1024 },
                (/** @type {any} */ err, /** @type {any} */ stdout) => {
                  if (err || !stdout) return resolve(null);
                  try {
                    const jsonLine =
                      String(stdout || '')
                        .split(/\r?\n/)
                        .map((l) => l.trim())
                        .filter((l) => l.startsWith('{'))
                        .pop() || String(stdout || '').trim();
                    const infoJson = JSON.parse(jsonLine);
                    const baseSizes = extractNodeSizes(infoJson);
                    if (!baseSizes.diskSize) return resolve(null);
                    let dlcSum = 0;
                    if (Array.isArray(infoJson?.dlcs)) {
                      for (const dlc of infoJson.dlcs) {
                        const dlcSizes = extractNodeSizes(dlc);
                        if (dlcSizes.diskSize) dlcSum += dlcSizes.diskSize;
                      }
                    }
                    resolve({
                      diskSize: baseSizes.diskSize,
                      downloadSize: baseSizes.downloadSize,
                      dlcSize: sanitizeGameInstallSizeBytes(dlcSum),
                    });
                  } catch {
                    resolve(null);
                  }
                }
              );
            });

          const [macInfoRes, winInfoRes] = await Promise.all([
            needsMacGogdl ? runGogdlInfo('osx') : Promise.resolve(null),
            needsWinGogdl ? runGogdlInfo('windows') : Promise.resolve(null),
          ]);
          if (macInfoRes?.diskSize) {
            macSizeBytes = macInfoRes.diskSize;
            macDownloadBytes = macInfoRes.downloadSize;
            macDlcBytes = macInfoRes.dlcSize;
            hasAuthoritativeMacDisk = true;
          }
          if (winInfoRes?.diskSize) {
            winSizeBytes = winInfoRes.diskSize;
            winDownloadBytes = winInfoRes.downloadSize;
            winDlcBytes = winInfoRes.dlcSize;
            hasAuthoritativeWinDisk = true;
          }
        }
      } catch {}
    }

    if (cleanId) {
      if (macSizeBytes) {
        setBoundedMapEntry(
          installInfoSizeCache,
          `${cacheScope}gog:${cleanId}:mac`,
          {
            diskSize: macSizeBytes,
            downloadSize: macDownloadBytes,
            dlcSize: macDlcBytes,
            fromGogdl: hasAuthoritativeMacDisk,
          },
          MAX_DISCOVERY_CACHE_ENTRIES
        );
      }
      if (winSizeBytes) {
        setBoundedMapEntry(
          installInfoSizeCache,
          `${cacheScope}gog:${cleanId}:windows`,
          {
            diskSize: winSizeBytes,
            downloadSize: winDownloadBytes,
            dlcSize: winDlcBytes,
            fromGogdl: hasAuthoritativeWinDisk,
          },
          MAX_DISCOVERY_CACHE_ENTRIES
        );
      }
    }

    if (availableInstallers.length > 0) {
      availableInstallers = availableInstallers.map((ins) => {
        const isMac = ins.os === 'mac';
        const authoritativeOsDisk = isMac
          ? hasAuthoritativeMacDisk
            ? macSizeBytes
            : undefined
          : hasAuthoritativeWinDisk
            ? winSizeBytes
            : undefined;
        const resolvedTotal =
          authoritativeOsDisk ||
          ins.totalSizeBytes ||
          (isMac ? macSizeBytes : winSizeBytes) ||
          (!(isMac ? winSizeBytes : macSizeBytes) ? estimatedSizeBytes : undefined);
        const resolvedDl = isMac ? macDownloadBytes : winDownloadBytes;
        const resolvedDlc = isMac ? macDlcBytes : winDlcBytes;
        return {
          ...ins,
          totalSizeBytes: resolvedTotal,
          ...(resolvedDl ? { downloadSizeBytes: resolvedDl } : {}),
          ...(resolvedDlc ? { dlcSizeBytes: resolvedDlc } : {}),
        };
      });
    } else {
      const fallbackWinSize =
        winSizeBytes ||
        (!macSizeBytes ? estimatedSizeBytes : undefined) ||
        (options.homedir ? 2600 * 1024 * 1024 : undefined);
      const fallbackMacSize =
        macSizeBytes ||
        (!winSizeBytes ? estimatedSizeBytes : undefined) ||
        (options.homedir ? 2450 * 1024 * 1024 : undefined);
      if (platform === 'win32') {
        availableInstallers = [
          {
            id: 'gog-win-default',
            name: `${titleLabel} — Windows Native Build`,
            os: 'windows',
            language: 'en',
            totalSizeBytes: fallbackWinSize,
            ...(winDownloadBytes ? { downloadSizeBytes: winDownloadBytes } : {}),
            ...(winDlcBytes ? { dlcSizeBytes: winDlcBytes } : {}),
          },
        ];
      } else if (
        (payload.storePlatforms && payload.storePlatforms.mac === false) ||
        (productData?.content_system_compatibility &&
          productData.content_system_compatibility.osx === false &&
          storeSupportsWin)
      ) {
        availableInstallers = [
          {
            id: 'gog-win-default',
            name: `${titleLabel} — Windows Build (CrossOver / Wine Fallback, No macOS Native Build)`,
            os: 'windows',
            language: 'en',
            totalSizeBytes: fallbackWinSize,
            ...(winDownloadBytes ? { downloadSizeBytes: winDownloadBytes } : {}),
            ...(winDlcBytes ? { dlcSizeBytes: winDlcBytes } : {}),
          },
        ];
      } else if (
        payload.storePlatforms &&
        payload.storePlatforms.mac === true &&
        payload.storePlatforms.windows === false &&
        !storeSupportsWin
      ) {
        availableInstallers = [
          {
            id: 'gog-mac-default',
            name: `${titleLabel} (macOS Universal Installer)`,
            os: 'mac',
            language: 'en',
            totalSizeBytes: fallbackMacSize,
            ...(macDownloadBytes ? { downloadSizeBytes: macDownloadBytes } : {}),
            ...(macDlcBytes ? { dlcSizeBytes: macDlcBytes } : {}),
          },
        ];
      } else {
        availableInstallers = [
          {
            id: 'gog-mac-default',
            name: `${titleLabel} (macOS Universal Installer)`,
            os: 'mac',
            language: 'en',
            totalSizeBytes: fallbackMacSize,
            ...(macDownloadBytes ? { downloadSizeBytes: macDownloadBytes } : {}),
            ...(macDlcBytes ? { dlcSizeBytes: macDlcBytes } : {}),
          },
          {
            id: 'gog-win-default',
            name: `${titleLabel} (Windows x64 Installer — CrossOver / Wine)`,
            os: 'windows',
            language: 'en',
            totalSizeBytes: fallbackWinSize,
            ...(winDownloadBytes ? { downloadSizeBytes: winDownloadBytes } : {}),
            ...(winDlcBytes ? { dlcSizeBytes: winDlcBytes } : {}),
          },
        ];
      }
    }

    const primaryGogInstaller = availableInstallers[0];
    estimatedSizeBytes = sanitizeGameInstallSizeBytes(
      primaryGogInstaller?.totalSizeBytes || macSizeBytes || winSizeBytes || estimatedSizeBytes
    );
    downloadSizeBytes = sanitizeGameInstallSizeBytes(
      primaryGogInstaller?.downloadSizeBytes || macDownloadBytes || winDownloadBytes
    );
    dlcSizeBytes = sanitizeGameInstallSizeBytes(
      primaryGogInstaller?.dlcSizeBytes || macDlcBytes || winDlcBytes
    );
  } else if (platformId === 'epic') {
    const legendaryBin = findLegendaryBinary(options);
    canDirectDownload = Boolean(legendaryBin);
    requiresStoreClientFallback = !canDirectDownload;

    const epicInfo = resolveEpicAppAndPlatforms(payload, options);
    const titleLabel = payload.title || 'Game';
    const resolvedAppName =
      epicInfo.resolvedAppName || epicInfo.appName || platformGameId.replace(/^epic-/i, '');

    const userDataDir = getUserDataDir(options.userDataDir);
    let hasMacBuild = Boolean(epicInfo.hasMacBuild);
    let hasWindowsBuild = epicInfo.hasWindowsBuild !== false;
    let namespace = epicInfo.namespace;
    let catalogItemId = epicInfo.catalogItemId;
    /** @type {{ Mac: Set<string>, Windows: Set<string> }} */
    const dlcAppIdsByPlat = { Mac: new Set(), Windows: new Set() };

    if (resolvedAppName) {
      const metaDirs = [
        path.join(userDataDir, 'legendaryConfig', 'legendary', 'metadata'),
        path.join(homedir, '.config', 'legendary', 'metadata'),
        path.join(
          homedir,
          'Library',
          'Application Support',
          'heroic',
          'legendaryConfig',
          'legendary',
          'metadata'
        ),
        path.join(
          process.env.APPDATA || path.join(homedir, 'AppData', 'Roaming'),
          'heroic',
          'legendaryConfig',
          'legendary',
          'metadata'
        ),
        path.join(homedir, 'AppData', 'Roaming', 'heroic', 'legendaryConfig', 'legendary', 'metadata'),
      ];
      for (const metaDir of metaDirs) {
        const metaPath = path.join(metaDir, `${resolvedAppName}.json`);
        if (!fs.existsSync(metaPath)) continue;
        try {
          const metaJson = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
          namespace = namespace || metaJson?.namespace || metaJson?.metadata?.namespace;
          catalogItemId =
            catalogItemId ||
            metaJson?.id ||
            metaJson?.catalog_item_id ||
            metaJson?.metadata?.id;
          if (
            metaJson?.asset_infos &&
            typeof metaJson.asset_infos === 'object' &&
            Object.keys(metaJson.asset_infos).length > 0 &&
            epicInfo.hasWindowsBuild === undefined
          ) {
            hasWindowsBuild = Boolean(metaJson.asset_infos.Windows);
          }
          const dlcList = metaJson?.metadata?.dlcItemList || metaJson?.dlcItemList;
          if (Array.isArray(dlcList)) {
            for (const dlcItem of dlcList) {
              if (!Array.isArray(dlcItem?.releaseInfo)) continue;
              for (const rel of dlcItem.releaseInfo) {
                const dlcAppId = String(rel?.appId || '').trim();
                if (!dlcAppId) continue;
                const relPlats = Array.isArray(rel.platform) ? rel.platform : [];
                if (
                  relPlats.length === 0 ||
                  relPlats.some((/** @type {any} */ p) => /^mac$/i.test(String(p)))
                ) {
                  dlcAppIdsByPlat.Mac.add(dlcAppId);
                }
                if (
                  relPlats.length === 0 ||
                  relPlats.some((/** @type {any} */ p) => /^(windows|win32)$/i.test(String(p)))
                ) {
                  dlcAppIdsByPlat.Windows.add(dlcAppId);
                }
              }
            }
          }
          if (namespace && catalogItemId) break;
        } catch {}
      }
    }

    const isDualOsEpic = Boolean(hasMacBuild && hasWindowsBuild);
    /** @type {Array<'Mac' | 'Windows'>} */
    const targetPlats =
      platform === 'darwin'
        ? isDualOsEpic
          ? ['Mac', 'Windows']
          : hasMacBuild
            ? ['Mac']
            : ['Windows']
        : ['Windows'];

    /** @type {Record<'Mac' | 'Windows', { diskSize?: number, downloadSize?: number, dlcSize?: number }>} */
    const platStats = {
      Mac: { diskSize: undefined, downloadSize: undefined, dlcSize: undefined },
      Windows: { diskSize: undefined, downloadSize: undefined, dlcSize: undefined },
    };

    if (!estimatedSizeBytes && resolvedAppName) {
      for (const plat of targetPlats) {
        const cached = installInfoSizeCache.get(`${cacheScope}epic:${resolvedAppName}:${plat}`);
        if (cached) {
          if (typeof cached === 'number') {
            platStats[plat].diskSize = sanitizeGameInstallSizeBytes(cached);
          } else if (typeof cached === 'object') {
            platStats[plat].diskSize = sanitizeGameInstallSizeBytes(cached.diskSize);
            platStats[plat].downloadSize = sanitizeGameInstallSizeBytes(cached.downloadSize);
            platStats[plat].dlcSize = sanitizeGameInstallSizeBytes(cached.dlcSize);
          }
        }
      }
    }

    if (
      !estimatedSizeBytes &&
      resolvedAppName &&
      targetPlats.some((p) => !platStats[p].diskSize)
    ) {
      const installedJsonPaths = [
        path.join(userDataDir, 'legendaryConfig', 'legendary', 'installed.json'),
        path.join(homedir, '.config', 'legendary', 'installed.json'),
        path.join(
          homedir,
          'Library',
          'Application Support',
          'heroic',
          'legendaryConfig',
          'legendary',
          'installed.json'
        ),
        path.join(
          process.env.APPDATA || path.join(homedir, 'AppData', 'Roaming'),
          'heroic',
          'legendaryConfig',
          'legendary',
          'installed.json'
        ),
        path.join(homedir, 'AppData', 'Roaming', 'heroic', 'legendaryConfig', 'legendary', 'installed.json'),
      ];
      for (const legInstalledPath of installedJsonPaths) {
        try {
          if (!fs.existsSync(legInstalledPath)) continue;
          const rawInstalled = JSON.parse(fs.readFileSync(legInstalledPath, 'utf8'));
          const entry = rawInstalled?.[resolvedAppName];
          if (!entry) continue;
          const validInstSize = parseByteCountOrFormattedSize(entry.install_size);
          if (!validInstSize) continue;
          for (const plat of targetPlats) {
            if (
              !platStats[plat].diskSize &&
              (!entry.platform || String(entry.platform).toLowerCase() === plat.toLowerCase())
            ) {
              platStats[plat].diskSize = validInstSize;
            }
          }
        } catch {}
      }
    }

    if (resolvedAppName) {
      const manifestDirs = [
        path.join(userDataDir, 'legendaryConfig', 'legendary', 'manifests'),
        path.join(homedir, '.config', 'legendary', 'manifests'),
        path.join(
          homedir,
          'Library',
          'Application Support',
          'heroic',
          'legendaryConfig',
          'legendary',
          'manifests'
        ),
        path.join(
          process.env.APPDATA || path.join(homedir, 'AppData', 'Roaming'),
          'heroic',
          'legendaryConfig',
          'legendary',
          'manifests'
        ),
        path.join(homedir, 'AppData', 'Roaming', 'heroic', 'legendaryConfig', 'legendary', 'manifests'),
      ];

      /** @type {Array<{ dir: string, files: string[] }>} */
      const existingManifestDirs = [];
      for (const mDir of manifestDirs) {
        try {
          if (fs.existsSync(mDir)) {
            existingManifestDirs.push({ dir: mDir, files: fs.readdirSync(mDir) });
          }
        } catch {}
      }

      const resolveLocalManifestForApp = (
        /** @type {string} */ appId,
        /** @type {'Mac' | 'Windows'} */ targetPlat,
        /** @type {boolean} */ allowSingleOsPrefix
      ) => {
        const otherPlat = targetPlat === 'Mac' ? 'Windows' : 'Mac';
        const tier1Paths = [];
        const tier2Paths = [];

        for (const { dir, files } of existingManifestDirs) {
          for (const f of files) {
            if (!f.endsWith('.manifest')) continue;
            if (
              f.startsWith(`${appId}_${targetPlat}_`) ||
              f === `${appId}_${targetPlat}.manifest`
            ) {
              tier1Paths.push(path.join(dir, f));
            } else if (
              f === `${appId}.manifest` ||
              (allowSingleOsPrefix &&
                f.startsWith(`${appId}_`) &&
                !f.startsWith(`${appId}_${otherPlat}_`) &&
                f !== `${appId}_${otherPlat}.manifest`)
            ) {
              tier2Paths.push(path.join(dir, f));
            }
          }
        }

        const sortNewestFirst = (/** @type {string[]} */ paths) =>
          paths.sort((a, b) => {
            let ma = 0;
            let mb = 0;
            try {
              ma = fs.statSync(a).mtimeMs || 0;
            } catch {}
            try {
              mb = fs.statSync(b).mtimeMs || 0;
            } catch {}
            return mb - ma;
          });

        const ordered =
          tier1Paths.length > 0 ? sortNewestFirst(tier1Paths) : sortNewestFirst(tier2Paths);

        for (const fullPath of ordered) {
          try {
            const parsed = parseEpicManifestBuffer(fs.readFileSync(fullPath));
            const validDisk = sanitizeGameInstallSizeBytes(parsed?.diskSize);
            if (validDisk) {
              return {
                diskSize: validDisk,
                downloadSize: sanitizeGameInstallSizeBytes(parsed?.downloadSize) || validDisk,
              };
            }
          } catch {}
        }
        return null;
      };

      for (const plat of targetPlats) {
        if (!estimatedSizeBytes && !platStats[plat].diskSize) {
          const localBase = resolveLocalManifestForApp(resolvedAppName, plat, !isDualOsEpic);
          if (localBase) {
            platStats[plat].diskSize = localBase.diskSize;
            platStats[plat].downloadSize = localBase.downloadSize;
          }
        }

        if (!platStats[plat].dlcSize && dlcAppIdsByPlat[plat].size > 0) {
          let dlcTotal = 0;
          for (const dlcAppId of dlcAppIdsByPlat[plat]) {
            const localDlc = resolveLocalManifestForApp(dlcAppId, plat, !isDualOsEpic);
            if (localDlc?.diskSize) {
              dlcTotal += localDlc.diskSize;
            }
          }
          const validDlc = sanitizeGameInstallSizeBytes(dlcTotal);
          if (validDlc) {
            platStats[plat].dlcSize = validDlc;
          }
        }
      }
    }

    if (
      !estimatedSizeBytes &&
      resolvedAppName &&
      !options.skipNetwork &&
      targetPlats.some((p) => !platStats[p].diskSize)
    ) {
      try {
        const legAuth = await ensureLegendaryConfigAndAuth(options);
        let accessToken = legAuth?.accessToken;

        if (accessToken && namespace && catalogItemId) {
          const missingNetPlats = targetPlats.filter((p) => !platStats[p].diskSize);
          const fetchAssetsForPlat = async (
            /** @type {'Mac' | 'Windows'} */ plat,
            /** @type {string} */ token
          ) => {
            const assetsUrl = `https://launcher-public-service-prod06.ol.epicgames.com/launcher/api/public/assets/v2/platform/${plat}/namespace/${encodeURIComponent(namespace)}/catalogItem/${encodeURIComponent(catalogItemId)}/app/${encodeURIComponent(resolvedAppName)}/label/Live`;
            const ctrl = new AbortController();
            const t = setTimeout(() => ctrl.abort(), 4500);
            try {
              const res = await fetch(assetsUrl, {
                signal: ctrl.signal,
                headers: {
                  Authorization: `Bearer ${token}`,
                  'User-Agent':
                    'UELauncher/11.0.1-14907503+++Portal+Release-Live Windows/10.0.19041.1.256.64bit',
                },
              });
              clearTimeout(t);
              return { plat, res };
            } catch {
              clearTimeout(t);
              return { plat, res: null };
            }
          };

          let assetResponses = await Promise.all(
            missingNetPlats.map((plat) => fetchAssetsForPlat(plat, accessToken))
          );

          if (
            assetResponses.some(
              (r) => r.res && (r.res.status === 401 || r.res.status === 403)
            ) &&
            legAuth?.refreshToken &&
            storeSync &&
            typeof storeSync.renewEpicTokens === 'function'
          ) {
            try {
              const renewed = await storeSync.renewEpicTokens(legAuth.refreshToken);
              if (renewed && renewed.access_token) {
                accessToken = renewed.access_token;
                try {
                  const existingUserPath = path.join(legAuth.legendaryConfigPath, 'user.json');
                  const baseUser = fs.existsSync(existingUserPath)
                    ? JSON.parse(fs.readFileSync(existingUserPath, 'utf8'))
                    : {};
                  const updatedUser = { ...baseUser, ...renewed };
                  atomicWriteSecureFileSync(
                    existingUserPath,
                    JSON.stringify(updatedUser, null, 2),
                    options
                  );
                } catch {}
                assetResponses = await Promise.all(
                  missingNetPlats.map((plat) => fetchAssetsForPlat(plat, accessToken))
                );
              }
            } catch {}
          }

          await Promise.all(
            assetResponses.map(async ({ plat, res: assetsRes }) => {
              if (!assetsRes || !assetsRes.ok) return;
              try {
                /** @type {any} */
                const assetsData = await assetsRes.json();
                const manifests = assetsData?.elements?.[0]?.manifests || [];
                const manifestEntry = manifests.find((/** @type {any} */ m) => m && m.uri);
                if (!manifestEntry) return;
                let manifestUrl = manifestEntry.uri;
                if (
                  Array.isArray(manifestEntry.queryParams) &&
                  manifestEntry.queryParams.length > 0
                ) {
                  const qs = manifestEntry.queryParams
                    .filter((/** @type {any} */ q) => q && q.name)
                    .map((/** @type {any} */ q) => `${q.name}=${q.value}`)
                    .join('&');
                  if (qs) {
                    manifestUrl += (manifestUrl.includes('?') ? '&' : '?') + qs;
                  }
                }
                const mCtrl = new AbortController();
                const mTimeout = setTimeout(() => mCtrl.abort(), 5000);
                try {
                  const manifestRes = await fetch(manifestUrl, { signal: mCtrl.signal });
                  clearTimeout(mTimeout);
                  if (manifestRes.ok) {
                    const manifestBuf = Buffer.from(await manifestRes.arrayBuffer());
                    const parsedManifest = parseEpicManifestBuffer(manifestBuf);
                    const validDisk = sanitizeGameInstallSizeBytes(parsedManifest?.diskSize);
                    if (validDisk) {
                      platStats[plat].diskSize = validDisk;
                      platStats[plat].downloadSize =
                        sanitizeGameInstallSizeBytes(parsedManifest?.downloadSize) || validDisk;
                    }
                  }
                } catch {}
                clearTimeout(mTimeout);
              } catch {}
            })
          );
        }
      } catch {}
    }

    if (
      !estimatedSizeBytes &&
      legendaryBin &&
      resolvedAppName &&
      !options.skipNetwork &&
      !options.disableLegendarySpawn &&
      (!options.homedir || typeof options.execFileFn === 'function') &&
      targetPlats.some((p) => !platStats[p].diskSize)
    ) {
      try {
        const execFileImpl = typeof options.execFileFn === 'function' ? options.execFileFn : execFile;
        const legAuth = await ensureLegendaryConfigAndAuth(options);
        const missingLegPlats = targetPlats.filter((p) => !platStats[p].diskSize);
        await Promise.all(
          missingLegPlats.map(
            (plat) =>
              new Promise((resolve) => {
                execFileImpl(
                  legendaryBin,
                  ['info', resolvedAppName, '--platform', plat, '--json'],
                  { env: legAuth.env, timeout: 10000 },
                  (/** @type {any} */ err, /** @type {any} */ stdout) => {
                    if (err || !stdout) return resolve(undefined);
                    try {
                      const infoJson = JSON.parse(String(stdout).trim());
                      const validDisk = sanitizeGameInstallSizeBytes(
                        Number(
                          infoJson?.manifest?.disk_size || infoJson?.manifest?.download_size || 0
                        )
                      );
                      const validDl = sanitizeGameInstallSizeBytes(
                        Number(infoJson?.manifest?.download_size || 0)
                      );
                      if (validDisk) {
                        platStats[plat].diskSize = validDisk;
                        platStats[plat].downloadSize = validDl || validDisk;
                      }
                      const ownedDlcs = infoJson?.game?.owned_dlc || infoJson?.owned_dlc;
                      if (Array.isArray(ownedDlcs) && !platStats[plat].dlcSize) {
                        let dlcSum = 0;
                        for (const dlcEntry of ownedDlcs) {
                          const dSz = sanitizeGameInstallSizeBytes(
                            Number(
                              dlcEntry?.manifest?.disk_size ||
                                dlcEntry?.disk_size ||
                                dlcEntry?.manifest?.download_size ||
                                0
                            )
                          );
                          if (dSz) dlcSum += dSz;
                        }
                        const validDlc = sanitizeGameInstallSizeBytes(dlcSum);
                        if (validDlc) platStats[plat].dlcSize = validDlc;
                      }
                    } catch {}
                    resolve(undefined);
                  }
                );
              })
          )
        );
      } catch {}
    }

    if (
      !estimatedSizeBytes &&
      !options.skipNetwork &&
      (Number(payload.steamAppId) > 0 || payload.title) &&
      targetPlats.some((p) => !platStats[p].diskSize)
    ) {
      let targetSteamId = Number(payload.steamAppId) > 0 ? Number(payload.steamAppId) : null;
      if (!targetSteamId && payload.title) {
        const sCtrl = new AbortController();
        const sTimeout = setTimeout(() => sCtrl.abort(), 3000);
        try {
          const searchRes = await fetch(
            `https://store.steampowered.com/api/storesearch/?term=${encodeURIComponent(payload.title)}&l=english&cc=US`,
            { signal: sCtrl.signal }
          );
          clearTimeout(sTimeout);
          if (searchRes.ok) {
            /** @type {any} */
            const searchData = await searchRes.json();
            const normAlnum = (/** @type {any} */ s) =>
              String(s || '')
                .toLowerCase()
                .replace(/[^a-z0-9]/g, '');
            const stripEditions = (/** @type {any} */ s) =>
              normAlnum(
                String(s || '').replace(
                  /\b(?:epic\s+games\s+edition|standard\s+edition|game\s+of\s+the\s+year(?:\s+edition)?|goty(?:\s+edition)?|complete\s+edition|definitive\s+edition|deluxe\s+edition)\b/gi,
                  ''
                )
              );
            const normTarget = normAlnum(payload.title);
            const strippedTarget = stripEditions(payload.title);
            const matchedItem = (searchData?.items || []).find((/** @type {any} */ it) => {
              const itNorm = normAlnum(it?.name);
              if (!itNorm) return false;
              if (itNorm === normTarget) return true;
              const itStripped = stripEditions(it?.name);
              return Boolean(strippedTarget && itStripped && itStripped === strippedTarget);
            });
            if (matchedItem?.id) {
              targetSteamId = matchedItem.id;
            }
          }
        } catch {}
        clearTimeout(sTimeout);
      }

      if (targetSteamId) {
        const dCtrl = new AbortController();
        const dTimeout = setTimeout(() => dCtrl.abort(), 3000);
        try {
          const detRes = await fetch(
            `https://store.steampowered.com/api/appdetails?appids=${encodeURIComponent(targetSteamId)}`,
            {
              signal: dCtrl.signal,
              headers: {
                Cookie: 'birthtime=568022401; mature_content=1; wants_mature_content=1',
              },
            }
          );
          clearTimeout(dTimeout);
          if (detRes.ok) {
            const detJson = await detRes.json();
            const appData = detJson?.[targetSteamId]?.data;
            const pcReq =
              appData?.pc_requirements?.minimum || appData?.pc_requirements?.recommended;
            const macReq =
              appData?.mac_requirements?.minimum || appData?.mac_requirements?.recommended;
            const winSteamSize = sanitizeGameInstallSizeBytes(parseStorageRequirementBytes(pcReq));
            const macSteamSize = sanitizeGameInstallSizeBytes(parseStorageRequirementBytes(macReq));
            if (targetPlats.includes('Mac') && !platStats.Mac.diskSize) {
              platStats.Mac.diskSize = macSteamSize || winSteamSize;
            }
            if (targetPlats.includes('Windows') && !platStats.Windows.diskSize) {
              platStats.Windows.diskSize = winSteamSize || macSteamSize;
            }
          }
        } catch {}
        clearTimeout(dTimeout);
      }
    }

    if (resolvedAppName) {
      for (const plat of targetPlats) {
        if (platStats[plat].diskSize) {
          setBoundedMapEntry(
            installInfoSizeCache,
            `${cacheScope}epic:${resolvedAppName}:${plat}`,
            {
              diskSize: platStats[plat].diskSize,
              downloadSize: platStats[plat].downloadSize,
              dlcSize: platStats[plat].dlcSize,
            },
            MAX_DISCOVERY_CACHE_ENTRIES
          );
        }
      }
    }

    if (platform === 'darwin') {
      if (hasMacBuild) {
        availableInstallers = [
          {
            id: 'epic-mac-native',
            name: `${titleLabel} (macOS Native Build)`,
            os: 'mac',
            totalSizeBytes: platStats.Mac.diskSize || estimatedSizeBytes,
            ...(platStats.Mac.downloadSize
              ? { downloadSizeBytes: platStats.Mac.downloadSize }
              : {}),
            ...(platStats.Mac.dlcSize ? { dlcSizeBytes: platStats.Mac.dlcSize } : {}),
            version: epicInfo.macVersion,
          },
          ...(hasWindowsBuild
            ? [
                {
                  id: 'epic-win-compat',
                  name: `${titleLabel} (Windows Build via CrossOver / Wine)`,
                  os: 'windows',
                  totalSizeBytes: platStats.Windows.diskSize || estimatedSizeBytes,
                  ...(platStats.Windows.downloadSize
                    ? { downloadSizeBytes: platStats.Windows.downloadSize }
                    : {}),
                  ...(platStats.Windows.dlcSize
                    ? { dlcSizeBytes: platStats.Windows.dlcSize }
                    : {}),
                  version: epicInfo.winVersion,
                },
              ]
            : []),
        ];
      } else {
        availableInstallers = [
          {
            id: 'epic-win-compat',
            name: `${titleLabel} (Windows Build — CrossOver / Wine Fallback, No macOS Native Build)`,
            os: 'windows',
            totalSizeBytes: platStats.Windows.diskSize || estimatedSizeBytes,
            ...(platStats.Windows.downloadSize
              ? { downloadSizeBytes: platStats.Windows.downloadSize }
              : {}),
            ...(platStats.Windows.dlcSize ? { dlcSizeBytes: platStats.Windows.dlcSize } : {}),
            version: epicInfo.winVersion,
          },
        ];
      }
    } else {
      availableInstallers = [
        {
          id: 'epic-win-native',
          name: `${titleLabel} (Windows Native Build)`,
          os: 'windows',
          totalSizeBytes: platStats.Windows.diskSize || estimatedSizeBytes,
          ...(platStats.Windows.downloadSize
            ? { downloadSizeBytes: platStats.Windows.downloadSize }
            : {}),
          ...(platStats.Windows.dlcSize ? { dlcSizeBytes: platStats.Windows.dlcSize } : {}),
          version: epicInfo.winVersion,
        },
      ];
    }

    const primaryEpicInstaller = availableInstallers[0];
    estimatedSizeBytes = sanitizeGameInstallSizeBytes(
      primaryEpicInstaller?.totalSizeBytes || estimatedSizeBytes
    );
    downloadSizeBytes = sanitizeGameInstallSizeBytes(primaryEpicInstaller?.downloadSizeBytes);
    dlcSizeBytes = sanitizeGameInstallSizeBytes(primaryEpicInstaller?.dlcSizeBytes);
  } else if (platformId === 'steam') {
    canDirectDownload = false;
    requiresStoreClientFallback = true;
    const titleLabel = payload.title || 'Game';
    const cleanId = String(payload.steamAppId || platformGameId).replace(/^steam-/i, '');

    /** @type {number | undefined} */
    let installedDiskSize = undefined;
    /** @type {number | undefined} */
    let installedMacDiskSize = undefined;
    /** @type {number | undefined} */
    let installedWinDiskSize = undefined;
    /** @type {number | undefined} */
    let macParsedSize = undefined;
    /** @type {number | undefined} */
    let winParsedSize = undefined;

    try {
      /** @type {any} */
      const rawSteamDirs = discoverSteamLocations(options).steamappsDirs;
      /** @type {string[]} */
      const steamDirsArr = Array.isArray(rawSteamDirs)
        ? rawSteamDirs
        : rawSteamDirs instanceof Set
          ? Array.from(rawSteamDirs)
          : [];
      if (steamDirsArr.length > 0) {
        const steamCommonDirs = steamDirsArr.map((d) => path.join(d, 'common'));
        defaultInstallDir = steamCommonDirs[0];
        availableInstallDirs = Array.from(new Set([...steamCommonDirs, ...availableInstallDirs]));
        diskSpace = await getDiskSpace(payload.targetInstallDir || defaultInstallDir, options);
      }
      if (!estimatedSizeBytes && cleanId && steamDirsArr.length > 0) {
        for (const dir of steamDirsArr) {
          const acfPath = path.join(dir, `appmanifest_${cleanId}.acf`);
          if (fs.existsSync(acfPath)) {
            const parsedAcf = parseSteamAcf(fs.readFileSync(acfPath, 'utf8'));
            const acfSize = sanitizeGameInstallSizeBytes(
              Number(parsedAcf?.SizeOnDisk || parsedAcf?.BytesToDownload || 0)
            );
            if (acfSize) {
              installedDiskSize = installedDiskSize || acfSize;
              const isBottleDir = /(?:^|[\\/])(Bottles|drive_c)(?:[\\/]|$)/i.test(dir);
              if (platform === 'darwin' && isBottleDir) {
                installedWinDiskSize = installedWinDiskSize || acfSize;
              } else if (platform === 'darwin') {
                installedMacDiskSize = installedMacDiskSize || acfSize;
              } else {
                installedWinDiskSize = installedWinDiskSize || acfSize;
              }
            }
          }
        }
      }
    } catch {}

    if (!estimatedSizeBytes && cleanId) {
      const cachedSteam = installInfoSizeCache.get(`${cacheScope}steam:${cleanId}`);
      if (cachedSteam) {
        if (typeof cachedSteam === 'number') {
          const validCached = sanitizeGameInstallSizeBytes(cachedSteam);
          macParsedSize = validCached;
          winParsedSize = validCached;
        } else if (typeof cachedSteam === 'object') {
          macParsedSize = sanitizeGameInstallSizeBytes(cachedSteam.macParsedSize);
          winParsedSize = sanitizeGameInstallSizeBytes(cachedSteam.winParsedSize);
        }
      }
    }

    let macSupported = true;
    let winSupported = true;
    let platformSupportResolved = false;

    if (options.mockSteamAppDetails) {
      if (options.mockSteamAppDetails.platforms) {
        const platData = options.mockSteamAppDetails.platforms;
        macSupported = Boolean(platData.mac);
        winSupported = Boolean(platData.windows);
        platformSupportResolved = true;
      }
      const mockMacReq =
        options.mockSteamAppDetails.mac_requirements?.minimum ||
        options.mockSteamAppDetails.mac_requirements?.recommended;
      const mockPcReq =
        options.mockSteamAppDetails.pc_requirements?.minimum ||
        options.mockSteamAppDetails.pc_requirements?.recommended;
      if (mockMacReq && !macParsedSize) {
        macParsedSize = sanitizeGameInstallSizeBytes(parseStorageRequirementBytes(mockMacReq));
      }
      if (mockPcReq && !winParsedSize) {
        winParsedSize = sanitizeGameInstallSizeBytes(parseStorageRequirementBytes(mockPcReq));
      }
    } else if (payload.steamPlatforms && typeof payload.steamPlatforms === 'object') {
      macSupported = Boolean(payload.steamPlatforms.mac);
      winSupported = Boolean(payload.steamPlatforms.windows ?? true);
      if (cleanId) {
        setBoundedMapEntry(steamPlatformSupportCache, cleanId, { macSupported, winSupported }, 2000);
      }
      platformSupportResolved = true;
    } else if (cleanId && steamPlatformSupportCache.has(cleanId)) {
      const cachedPlat = steamPlatformSupportCache.get(cleanId);
      macSupported = Boolean(cachedPlat.macSupported);
      winSupported = Boolean(cachedPlat.winSupported);
      platformSupportResolved = true;
    }

    if (
      cleanId &&
      !options.skipNetwork &&
      !options.mockSteamAppDetails &&
      ((!platformSupportResolved && platform === 'darwin') ||
        (!estimatedSizeBytes && !installedDiskSize && !macParsedSize && !winParsedSize))
    ) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 3000);
      try {
        const res = await fetch(
          `https://store.steampowered.com/api/appdetails?appids=${encodeURIComponent(cleanId)}`,
          {
            signal: controller.signal,
            headers: {
              Cookie: 'birthtime=568022401; mature_content=1; wants_mature_content=1',
            },
          }
        );
        clearTimeout(timeout);
        if (res.ok) {
          const appDetails = await res.json();
          const appData = appDetails?.[cleanId]?.data;
          const platData = appData?.platforms;
          if (platData && !platformSupportResolved) {
            macSupported = Boolean(platData.mac);
            winSupported = Boolean(platData.windows);
            setBoundedMapEntry(
              steamPlatformSupportCache,
              cleanId,
              { macSupported, winSupported },
              2000
            );
            platformSupportResolved = true;
          }
          if (appData) {
            const macReqText =
              appData.mac_requirements?.minimum || appData.mac_requirements?.recommended;
            const pcReqText =
              appData.pc_requirements?.minimum || appData.pc_requirements?.recommended;
            macParsedSize =
              macParsedSize ||
              sanitizeGameInstallSizeBytes(parseStorageRequirementBytes(macReqText));
            winParsedSize =
              winParsedSize ||
              sanitizeGameInstallSizeBytes(parseStorageRequirementBytes(pcReqText));
            if (macParsedSize || winParsedSize) {
              setBoundedMapEntry(
                installInfoSizeCache,
                `${cacheScope}steam:${cleanId}`,
                { macParsedSize, winParsedSize },
                MAX_DISCOVERY_CACHE_ENTRIES
              );
            }
          }
        }
      } catch {}
      clearTimeout(timeout);
    }

    const resolvedSteamMacTotal =
      installedMacDiskSize || installedDiskSize || macParsedSize || winParsedSize || estimatedSizeBytes;
    const resolvedSteamWinTotal =
      installedWinDiskSize || installedDiskSize || winParsedSize || macParsedSize || estimatedSizeBytes;

    if (platform === 'darwin') {
      if (!macSupported && winSupported) {
        availableInstallers = [
          {
            id: 'steam-win-compat',
            name: `${titleLabel} (Windows Build via CrossOver — Windows Steam Bottle)`,
            os: 'windows',
            totalSizeBytes: resolvedSteamWinTotal,
          },
        ];
      } else {
        availableInstallers = [
          {
            id: 'steam-mac-native',
            name: `${titleLabel} (Steam Client — Native OS / Auto-Detect)`,
            os: 'mac',
            totalSizeBytes: resolvedSteamMacTotal,
          },
          {
            id: 'steam-win-compat',
            name: `${titleLabel} (Windows Build via CrossOver — Windows Steam Bottle)`,
            os: 'windows',
            totalSizeBytes: resolvedSteamWinTotal,
          },
        ];
      }
    } else {
      availableInstallers = [
        {
          id: 'steam-win-native',
          name: `${titleLabel} (Steam Client — Windows Native)`,
          os: 'windows',
          totalSizeBytes: resolvedSteamWinTotal,
        },
      ];
    }

    estimatedSizeBytes = sanitizeGameInstallSizeBytes(
      availableInstallers[0]?.totalSizeBytes || estimatedSizeBytes
    );
  } else if (platformId === 'xbox') {
    const titleLabel = payload.title || 'Game';
    const cleanStoreId = String(
      payload.xboxProductId || payload.storeId || platformGameId || ''
    )
      .replace(/^xbox[-_:]/i, '')
      .trim()
      .toUpperCase();
    const userDataDir = getUserDataDir(options.userDataDir);
    const xboxMods = getXboxStorefrontModules();
    const activeStoreSync = options.storeSync || storeSync;
    const authProvider =
      options.xboxAuthProvider ||
      (activeStoreSync && typeof activeStoreSync.getXboxAuthProvider === 'function'
        ? activeStoreSync.getXboxAuthProvider({ userDataDir })
        : null);

    const xboxDirs = collectXboxLibraryRoots({ ...options, platform });
    if (xboxDirs.length > 0) {
      defaultInstallDir = xboxDirs[0];
      availableInstallDirs = Array.from(new Set([...xboxDirs, ...availableInstallDirs]));
      diskSpace = await getDiskSpace(payload.targetInstallDir || defaultInstallDir, options);
    }

    const cachedSizes = cleanStoreId
      ? installInfoSizeCache.get(`${cacheScope}xbox:${cleanStoreId}`)
      : null;
    let resolvedDiskBytes = sanitizeGameInstallSizeBytes(
      cachedSizes?.diskSize || estimatedSizeBytes
    );
    let resolvedDlBytes = sanitizeGameInstallSizeBytes(
      cachedSizes?.downloadSize || payload.downloadSizeBytes
    );

    /** @type {any} */
    let deliveryInfo = options.mockXboxDeliveryInfo || null;
    if (
      !deliveryInfo &&
      cleanStoreId &&
      (!options.skipNetwork || typeof options.xboxPackageDeliveryResolver === 'function')
    ) {
      try {
        const resolveFn =
          options.xboxPackageDeliveryResolver || xboxMods?.resolveXboxPackageDeliveryInfo;
        if (typeof resolveFn === 'function') {
          deliveryInfo = await resolveFn({
            storeId: cleanStoreId,
            contentId: payload.contentId || payload.xboxDeliveryHints?.contentId,
            wuCategoryId: payload.wuCategoryId || payload.xboxDeliveryHints?.wuCategoryId,
            authProvider,
            userDataDir,
            fetchImpl: options.fetchImpl,
          });
        }
      } catch {}

      if (!deliveryInfo && typeof xboxMods?.fetchXboxProductMetadata === 'function' && !options.skipNetwork) {
        try {
          const meta = await xboxMods.fetchXboxProductMetadata(
            { xboxProductId: cleanStoreId, userDataDir },
            { userDataDir, fetchImpl: options.fetchImpl }
          );
          if (meta) {
            deliveryInfo = {
              storeId: meta.xboxProductId || cleanStoreId,
              contentId: meta.contentId,
              wuCategoryId: meta.wuCategoryId,
              packageFamilyName: meta.packageFamilyName,
              packageFullName: meta.packageFullName,
              maxDownloadSizeBytes: meta.maxDownloadSizeBytes,
              externalLauncher: meta.externalLauncher,
              externalLauncherUrl: meta.externalLauncherUrl,
              externalStorefrontHandoff: meta.externalStorefrontHandoff,
              downloadUrls: [],
            };
          }
        } catch {}
      }
    }

    if (deliveryInfo?.maxDownloadSizeBytes) {
      const sanitizedMaxDl = sanitizeGameInstallSizeBytes(deliveryInfo.maxDownloadSizeBytes);
      if (sanitizedMaxDl) {
        resolvedDlBytes = resolvedDlBytes || sanitizedMaxDl;
        resolvedDiskBytes = resolvedDiskBytes || sanitizedMaxDl;
      }
    }

    const probeKey = cleanStoreId || payload.msixvcPath || deliveryInfo?.primaryDownloadUrl || '';
    let rawProbe = probeKey ? xboxCompatibilityProbeCache.get(probeKey) : null;
    const canProbeContainer = Boolean(
      payload.msixvcPath ||
        options.mockXboxCompatibilityProbe ||
        (!options.skipNetwork &&
          Array.isArray(deliveryInfo?.downloadUrls) &&
          deliveryInfo.downloadUrls.length > 0)
    );

    if (!rawProbe && canProbeContainer) {
      if (options.mockXboxCompatibilityProbe) {
        rawProbe = options.mockXboxCompatibilityProbe;
      } else {
        const probeFn = options.probeMsixvcCompatibilityFn || xboxMods?.probeMsixvcCompatibility;
        if (typeof probeFn === 'function') {
          try {
            rawProbe = await probeFn({
              msixvcPath: payload.msixvcPath || undefined,
              urls: deliveryInfo?.downloadUrls,
              fetchImpl: options.fetchImpl,
              timeoutMs: 4500,
            });
          } catch {}
        }
      }
      if (rawProbe && probeKey) {
        setBoundedMapEntry(xboxCompatibilityProbeCache, probeKey, rawProbe, 500);
      }
    }

    if (rawProbe) {
      const extractedSz = sanitizeGameInstallSizeBytes(rawProbe.totalExtractedBytes);
      const containerSz = sanitizeGameInstallSizeBytes(rawProbe.totalContainerBytes);
      if (extractedSz) resolvedDiskBytes = extractedSz;
      if (containerSz) resolvedDlBytes = containerSz;

      xboxCompatibility = {
        tier: rawProbe.tier || 'tier_a_supported',
        canExtractAndRun: rawProbe.supportedOnMacBottle !== false,
        requiresCoreWindow: rawProbe.tier === 'tier_b_legacy_uwp',
        antiCheatDetected: rawProbe.tier === 'tier_c_kernel_anticheat',
        antiCheatSignals: Array.isArray(rawProbe.antiCheatSignals) ? rawProbe.antiCheatSignals : [],
        externalLauncher: rawProbe.externalLauncher || undefined,
        summary: rawProbe.reason || 'Supported GDK / Win32 x64 package',
        encryption: rawProbe.encryption,
      };
    }

    if (cleanStoreId && (resolvedDiskBytes || resolvedDlBytes)) {
      setBoundedMapEntry(
        installInfoSizeCache,
        `${cacheScope}xbox:${cleanStoreId}`,
        {
          diskSize: resolvedDiskBytes,
          downloadSize: resolvedDlBytes,
        },
        MAX_DISCOVERY_CACHE_ENTRIES
      );
    }

    const declaredExternalLauncher = String(
      payload.externalLauncher ||
        deliveryInfo?.externalLauncher ||
        rawProbe?.externalLauncher ||
        ''
    ).trim();
    const declaredExternalLauncherUrl = validateTrustedExternalLauncherUrl(
      payload.externalLauncherUrl ||
        deliveryInfo?.externalLauncherUrl ||
        rawProbe?.externalLauncherUrl ||
        ''
    );

    if (platform === 'darwin') {
      if (declaredExternalLauncher) {
        externalLauncher = declaredExternalLauncher;
        externalLauncherUrl = declaredExternalLauncherUrl;
      }
      if (
        declaredExternalLauncher &&
        (!deliveryInfo?.downloadUrls || deliveryInfo.downloadUrls.length === 0)
      ) {
        canDirectDownload = false;
        requiresStoreClientFallback = true;
        xboxCompatibility = xboxCompatibility
          ? {
              ...xboxCompatibility,
              externalLauncher: declaredExternalLauncher,
              ...(declaredExternalLauncherUrl
                ? { externalLauncherUrl: declaredExternalLauncherUrl }
                : {}),
            }
          : {
              tier: 'tier_a_supported',
              canExtractAndRun: false,
              requiresCoreWindow: false,
              antiCheatDetected: false,
              antiCheatSignals: [],
              externalLauncher: declaredExternalLauncher,
              ...(declaredExternalLauncherUrl
                ? { externalLauncherUrl: declaredExternalLauncherUrl }
                : {}),
              summary: `Requires external launcher (${declaredExternalLauncher}).`,
            };
        availableInstallers = [
          {
            id: 'xbox-external-mac-launcher',
            label: `${titleLabel} — ${declaredExternalLauncher}`,
            name: `${titleLabel} — ${declaredExternalLauncher}`,
            os: 'mac',
            sizeBytes: resolvedDiskBytes,
            totalSizeBytes: resolvedDiskBytes,
            externalLauncher: declaredExternalLauncher,
            externalLauncherUrl: declaredExternalLauncherUrl,
          },
        ];
      } else {
        isCrossPlatformBottleInstall = true;
        canDirectDownload = xboxCompatibility ? xboxCompatibility.canExtractAndRun !== false : true;
        requiresStoreClientFallback = false;
        availableInstallers = [
          {
            id: 'xbox-msixvc-win',
            label: 'Windows (MSIXVC Direct Streaming Decrypt)',
            name: `${titleLabel} — Windows (MSIXVC Direct Streaming Decrypt via CrossOver / Wine)`,
            os: 'windows',
            sizeBytes: resolvedDiskBytes,
            totalSizeBytes: resolvedDiskBytes,
            ...(resolvedDlBytes ? { downloadSizeBytes: resolvedDlBytes } : {}),
          },
        ];
      }
    } else {
      const hasMsixvcUrls = Boolean(
        payload.msixvcPath ||
          (Array.isArray(deliveryInfo?.downloadUrls) && deliveryInfo.downloadUrls.length > 0)
      );
      const explicitlyRequestedClientless =
        payload.installerId === 'xbox-msixvc-win' ||
        payload.preferClientlessExtraction === true ||
        options.preferClientlessExtraction === true ||
        Boolean(payload.msixvcPath);
      const explicitlyRequestedGamingServices =
        !explicitlyRequestedClientless &&
        (payload.installerId === 'xbox-win-gamingservices' ||
          payload.preferClientlessExtraction === false);
      const preferClientless = Boolean(
        explicitlyRequestedClientless ||
          (!explicitlyRequestedGamingServices &&
            (options.hasGamingServices === false ||
              (!options.homedir && !hasWindowsGamingServicesInstalled(options))))
      );
      canDirectDownload = Boolean(preferClientless && hasMsixvcUrls);
      requiresStoreClientFallback = !canDirectDownload;

      availableInstallers = [
        {
          id: 'xbox-win-gamingservices',
          label: 'Windows Native (Xbox GamingServices)',
          name: `${titleLabel} — Windows Native (Xbox GamingServices)`,
          os: 'windows',
          sizeBytes: resolvedDiskBytes,
          totalSizeBytes: resolvedDiskBytes,
          ...(resolvedDlBytes ? { downloadSizeBytes: resolvedDlBytes } : {}),
        },
        ...(hasMsixvcUrls
          ? [
              {
                id: 'xbox-msixvc-win',
                label: 'Windows (MSIXVC Direct Streaming Decrypt)',
                name: `${titleLabel} — Windows (MSIXVC Direct Streaming Decrypt — Clientless)`,
                os: 'windows',
                sizeBytes: resolvedDiskBytes,
                totalSizeBytes: resolvedDiskBytes,
                ...(resolvedDlBytes ? { downloadSizeBytes: resolvedDlBytes } : {}),
              },
            ]
          : []),
      ];
    }

    estimatedSizeBytes = sanitizeGameInstallSizeBytes(
      resolvedDiskBytes || availableInstallers[0]?.totalSizeBytes || estimatedSizeBytes
    );
    downloadSizeBytes = sanitizeGameInstallSizeBytes(resolvedDlBytes);
  }

  return {
    platformId,
    platformGameId,
    hostPlatform: platform,
    estimatedSizeBytes,
    ...(downloadSizeBytes ? { downloadSizeBytes } : {}),
    ...(dlcSizeBytes ? { dlcSizeBytes } : {}),
    defaultInstallDir,
    availableInstallDirs,
    availableInstallers,
    canDirectDownload,
    requiresStoreClientFallback,
    ...(isCrossPlatformBottleInstall ? { isCrossPlatformBottleInstall: true } : {}),
    ...(xboxCompatibility ? { xboxCompatibility } : {}),
    ...(externalLauncher !== undefined
      ? { externalLauncher, externalLauncherUrl: externalLauncherUrl ?? '' }
      : {}),
    diskSpace,
  };
}

/**
 * Start a game download / installation task
 */
async function installGame(
  /** @type {any} */ payload = {},
  /** @type {any} */ optionsOrProgress = {},
  /** @type {any} */ maybeOptions = {}
) {
  const options =
    typeof optionsOrProgress === 'function'
      ? { ...(maybeOptions || {}), onProgress: optionsOrProgress }
      : optionsOrProgress || {};
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
    if (!payload.installDir && typeof payload.installPath === 'string' && payload.installPath.trim()) {
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
      ...(!isSimulatedOrManual
        ? { _persistedUserDataDir: options.userDataDir || getConfiguredUserDataDir() || undefined }
        : {}),
    };

    downloadQueueMap.set(taskId, task);
    if (!isSimulatedOrManual) {
      persistDownloadQueueToDisk(options.userDataDir || task._persistedUserDataDir);
    }
    const { _persistedUserDataDir: _ignoredInitial, ...publicInitialTask } = task;
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
      const appId = payload.steamAppId || platformGameId.replace(/^steam-/i, '');
      const isWinCompatInstall =
        platform === 'darwin' &&
        (payload.os === 'windows' || payload.installerId === 'steam-win-compat');
      const expectedSteamId64 = await resolveExpectedSteamId64Async(options);
      let launchedViaWineSteam = false;
      /** @type {(() => Promise<void>) | null} */
      let dispatchSteamInstallTriggerAsync = null;
      /** @type {string[]} */
      let targetVdfCandidates = [];
      let wasAuthenticatedAtLaunch = true;
      const layers = isWinCompatInstall ? detectCompatibilityLayers(options) : [];

      if (isWinCompatInstall && !options.disableWineSteamSpawn && layers.length > 0) {
        const existingConfigs = getGameLaunchConfigs(options);
        const rawExistingConfig = (payload.gameId && existingConfigs[payload.gameId]) || {};
        const existingConfig = resolvePlatformLaunchConfig(rawExistingConfig, 'steam');
        const requestedLayerType = payload.compatibilityLayer || existingConfig.compatibilityLayer;
        const preferredLayer =
          (requestedLayerType && layers.find((l) => l.type === requestedLayerType)) ||
          layers.find((l) => l.type === 'crossover' || l.type === 'crossover_preview') ||
          layers[0];

        const explicitBottleName = String(
          payload.wineBottleName || existingConfig.wineBottleName || ''
        ).trim();
        const effectiveInstallBottleCfg = explicitBottleName
          ? { ...existingConfig, wineBottleName: explicitBottleName }
          : existingConfig;

        /** @type {Record<string, any>} */
        const env = { ...process.env };
        await ensureCompatibilityLayerReady(preferredLayer, effectiveInstallBottleCfg, env, options);

        const candidateBottles = [];
        const targetBottleName =
          explicitBottleName ||
          env.CX_BOTTLE ||
          (Array.isArray(preferredLayer.availableBottles) && preferredLayer.availableBottles[0]) ||
          'OneLauncher';
        const targetBottlePath =
          (explicitBottleName && preferredLayer.bottlesDir
            ? path.isAbsolute(explicitBottleName)
              ? explicitBottleName
              : path.join(preferredLayer.bottlesDir, explicitBottleName)
            : '') ||
          env.WINEPREFIX ||
          (preferredLayer.bottlesDir ? path.join(preferredLayer.bottlesDir, targetBottleName) : '');

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
            for (const bottleName of layer.availableBottles) {
              const bottlePath = path.join(layer.bottlesDir, bottleName);
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
          (typeof options.spawnFn === 'function' || fs.existsSync(resolvedTarget.layer.binaryPath))
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
              if (child && typeof child.unref === 'function') child.unref();
            };

            spawnWineSteamInstall();
            launchedViaWineSteam = true;
            targetVdfCandidates = bottleVdfCandidates;
            dispatchSteamInstallTriggerAsync = async () => {
              spawnWineSteamInstall();
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
            hostVdfCandidates.push(
              'C:\\Program Files (x86)\\Steam\\config\\loginusers.vdf',
              'C:\\Program Files\\Steam\\config\\loginusers.vdf'
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
        targetVdfCandidates = hostVdfCandidates;
        dispatchSteamInstallTriggerAsync = async () => {
          await openExternalUri(`steam://install/${appId}`, options);
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
          const authInfo = await ensureLegendaryConfigAndAuth({
            ...options,
            allowInteractiveAuth: true,
          });
          const spawnArgs = [
            'install',
            resolvedAppName,
            '--platform',
            epicPlatformFlag,
            '--base-path',
            installDir,
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

          let lastErrorLine = '';
          let sawAuthFailure = false;

          const onOutput = (/** @type {any} */ chunk) => {
            const text = String(chunk || '');
            if (
              /login failed! cannot continue with download process|stored credentials are no longer valid|invalid_refresh_token|errors\.com\.epicgames\.account\.auth_token/i.test(
                text
              )
            ) {
              sawAuthFailure = true;
            }
            const lines = text.split(/\r?\n/);
            for (const line of lines) {
              const errMatch = line.match(/(?:ERROR|CRITICAL):\s*(.+)/i);
              if (errMatch && errMatch[1]) {
                lastErrorLine = errMatch[1].trim();
              }
            }

            const currentTask = downloadQueueMap.get(taskId);
            if (!currentTask) return;

            const dlSizeMatch = matchLast(text, /Download size:\s*([\d.]+)\s*(KiB|MiB|GiB)/gi);
            if (dlSizeMatch) {
              const parsedTotal = parseCliSizeToBytes(dlSizeMatch[1], dlSizeMatch[2]);
              if (parsedTotal > 0) {
                currentTask.totalBytes = parsedTotal;
                currentTask.hasExactDownloadSize = true;
              }
            }

            const pctMatch = matchLast(text, /Progress:\s*([\d.]+)%?/gi);
            const dlMiBMatch = matchLast(text, /Downloaded:\s*([\d.]+)\s*(KiB|MiB|GiB|B)?/gi);
            const speedMatch =
              matchLast(text, /\+\s*Download\s*-\s*([\d.]+)\s*(KiB|MiB|GiB|B)\/s/gi) ||
              matchLast(text, /Download\s*-\s*([\d.]+)\s*(KiB|MiB|GiB|B)?/gi);
            const decompMatch = matchLast(
              text,
              /\/\s*([\d.]+)\s*(KiB|MiB|GiB|B)\/s\s*\(decompressed\)/gi
            );
            const etaMatch = matchLast(text, /ETA:\s*(\d+):(\d+):(\d+)/gi);

            if (pctMatch || dlMiBMatch || speedMatch || etaMatch) {
              /** @type {any} */
              const partialUpdate = {};
              if (pctMatch) {
                currentTask.hasExplicitCliProgress = true;
                partialUpdate.progressPercent = Math.min(99, Math.round(parseFloat(pctMatch[1])));
              } else {
                partialUpdate.progressPercent = currentTask.progressPercent;
              }
              if (dlMiBMatch) {
                currentTask.hasExplicitCliBytes = true;
                partialUpdate.bytesDownloaded = parseCliSizeToBytes(
                  dlMiBMatch[1],
                  dlMiBMatch[2] || 'MiB'
                );
              } else if (
                pctMatch &&
                !currentTask.hasExplicitCliBytes &&
                partialUpdate.bytesDownloaded === undefined
              ) {
                partialUpdate.bytesDownloaded = Math.round(
                  (partialUpdate.progressPercent / 100) * currentTask.totalBytes
                );
              }
              const rawCliSpeed = speedMatch
                ? parseCliSizeToBytes(speedMatch[1], speedMatch[2] || 'MiB')
                : 0;
              const decompCliSpeed = decompMatch
                ? parseCliSizeToBytes(decompMatch[1], decompMatch[2] || 'MiB')
                : 0;
              if (speedMatch || partialUpdate.bytesDownloaded !== undefined) {
                const smoothedSpeed = computeSmoothedDownloadSpeed(taskId, {
                  bytesDownloaded:
                    partialUpdate.bytesDownloaded !== undefined
                      ? partialUpdate.bytesDownloaded
                      : currentTask.bytesDownloaded,
                  rawSpeedBytesPerSec: rawCliSpeed,
                  decompressedSpeedBytesPerSec: decompCliSpeed,
                });
                if (smoothedSpeed > 0 || speedMatch) {
                  partialUpdate.speedBytesPerSec = smoothedSpeed;
                }
              }
              if (etaMatch) {
                const cliEta =
                  parseInt(etaMatch[1], 10) * 3600 +
                  parseInt(etaMatch[2], 10) * 60 +
                  parseInt(etaMatch[3], 10);
                const activeSpeed =
                  partialUpdate.speedBytesPerSec || currentTask.speedBytesPerSec || 0;
                const activeBytes =
                  partialUpdate.bytesDownloaded !== undefined
                    ? partialUpdate.bytesDownloaded
                    : currentTask.bytesDownloaded;
                if (
                  currentTask.etaSeconds > 0 &&
                  cliEta > currentTask.etaSeconds * 3 &&
                  activeSpeed > 0 &&
                  currentTask.totalBytes > activeBytes
                ) {
                  partialUpdate.etaSeconds = Math.max(
                    1,
                    Math.round((currentTask.totalBytes - activeBytes) / activeSpeed)
                  );
                } else {
                  partialUpdate.etaSeconds = cliEta;
                }
              }
              const displayPct =
                partialUpdate.progressPercent !== undefined
                  ? partialUpdate.progressPercent
                  : currentTask.progressPercent;
              partialUpdate.statusMessage = `Installing ${
                epicPlatformFlag === 'Mac' ? 'macOS build' : 'Windows build'
              } via Legendary (${displayPct}%)...`;

              updateDownloadTask(taskId, partialUpdate, options);
            }
          };

          if (child.stdout) child.stdout.on('data', onOutput);
          if (child.stderr) child.stderr.on('data', onOutput);
          child.on('exit', async (/** @type {number | null} */ code) => {
            const currentTask = downloadQueueMap.get(taskId);
            if (ctrl.pausedByUser || (currentTask && currentTask.status === 'paused')) {
              ctrl.exitedWhilePaused = true;
              ctrl.child = null;
              return;
            }
            downloadControllers.delete(taskId);
            if (currentTask && currentTask.status === 'cancelled') return;

            if (code === 0) {
              /** @type {any} */
              let installedEntry = null;
              const candidateInstalledFiles = [
                path.join(authInfo.legendaryConfigPath, 'installed.json'),
                path.join(homedir, 'Library/Application Support/heroic/legendaryConfig/legendary/installed.json'),
                path.join(
                  process.env.APPDATA || path.join(homedir, 'AppData', 'Roaming'),
                  'heroic',
                  'legendaryConfig',
                  'legendary',
                  'installed.json'
                ),
                path.join(homedir, 'AppData', 'Roaming', 'heroic', 'legendaryConfig', 'legendary', 'installed.json'),
                path.join(homedir, '.config/legendary/installed.json'),
              ];
              for (const instFile of candidateInstalledFiles) {
                if (!fs.existsSync(instFile)) continue;
                try {
                  const raw = JSON.parse(fs.readFileSync(instFile, 'utf8'));
                  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
                    installedEntry = raw[resolvedAppName] || raw[platformGameId] || null;
                  } else if (Array.isArray(raw)) {
                    installedEntry = raw.find(
                      (/** @type {any} */ x) =>
                        x &&
                        (x.app_name === resolvedAppName || x.app_name === platformGameId)
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

              /** @type {string | undefined} */
              let executablePath = undefined;
              if (installedEntry?.executable) {
                const cleanExe = String(installedEntry.executable).replace(/\\/g, path.sep);
                const candidateManifestExe = path.isAbsolute(cleanExe)
                  ? cleanExe
                  : path.join(actualInstallPath, cleanExe);
                if (fs.existsSync(candidateManifestExe)) {
                  executablePath =
                    candidateManifestExe.toLowerCase().endsWith('.app')
                      ? resolveMacAppBundleBinary(candidateManifestExe) || undefined
                      : candidateManifestExe;
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
                  const cleanExe = String(installedEntry.executable).replace(/\\/g, path.sep);
                  executablePath = path.isAbsolute(cleanExe)
                    ? cleanExe
                    : path.join(actualInstallPath, cleanExe);
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
                gameId: resolvedAppName || platformGameId,
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

              if (resolvedAppName && resolvedAppName !== platformGameId) {
                upsertManagedInstallRecord(
                  {
                    platformId: 'epic',
                    platformGameId: resolvedAppName,
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
                  ensureMacAppCodeSignatureValid(executablePath || actualInstallPath, options);
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
          `com.epicgames.launcher://apps/${encodeURIComponent(resolvedAppName)}?action=install`,
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
      const gogToken = options.gogAccessToken || authRes?.accessToken || savedTokens?.gog?.access_token;
      const gogdlBin = findGogdlBinary(options);
      const cleanId = platformGameId.replace(/^gog-/i, '');

      if (gogdlBin && gogToken && !options.disableGogdlSpawn) {
        try {
          const gogAuthPath =
            authRes?.configPath ||
            authRes?.gogAuthPath ||
            path.join(getUserDataDir(options.userDataDir), 'gog_store', 'auth.json');
          const gogPlatformFlag =
            payload.os === 'windows' ||
            (payload.installerId && String(payload.installerId).toLowerCase().includes('win'))
              ? 'windows'
              : platform === 'darwin'
                ? 'osx'
                : 'windows';

          try {
            const hostFinalInstallPath = toHostFilesystemPath(finalInstallPath);
            if (!fs.existsSync(hostFinalInstallPath)) {
              fs.mkdirSync(hostFinalInstallPath, { recursive: true });
            }
          } catch {}

          let isV1Build = false;
          if (!options.homedir && !options.skipNetwork) {
            try {
              const buildsCheck = await fetchGogV1Json(
                `https://content-system.gog.com/products/${encodeURIComponent(cleanId)}/os/${encodeURIComponent(gogPlatformFlag)}/builds?generation=2`,
                {},
                4000
              );
              if (buildsCheck?.items?.[0]?.generation === 1) {
                isV1Build = true;
              }
            } catch {}
          }

          if (isV1Build) {
            downloadGogV1Depot(
              {
                taskId,
                cleanId,
                platformGameId,
                title,
                gogPlatformFlag,
                finalInstallPath,
                gogToken,
                gogdlBin,
                gogAuthPath,
                platform,
                totalBytes,
                includeDlcs: payload.includeDlcs === true,
              },
              options
            ).catch((/** @type {any} */ v1Err) => {
              if (v1Err && v1Err.isPausedByUser) return;
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
          } else {
            const existingExeCheck = findPrimaryExecutable(finalInstallPath, {
              platform,
              hintName: title,
              preferWindowsExecutable: platform === 'darwin' && gogPlatformFlag === 'windows',
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
              finalInstallPath,
              payload.includeDlcs === true ? '--with-dlcs' : '--skip-dlcs',
              '--lang',
              gogLocale,
            ];

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

            let lastErrorLine = '';
            let gogReportedDiskSizeBytes = 0;

            const onGogOutput = (/** @type {any} */ chunk) => {
              const text = String(chunk || '');
              const lines = text.split(/\r?\n/);
              const currentTask = downloadQueueMap.get(taskId);
              let resolvedSizeOnChunk = false;

              for (const line of lines) {
                const errMatch = line.match(
                  /(?:ERROR|CRITICAL|Exception|[A-Za-z]+Error|Failed to execute script)[\]:\s]+(.+)/i
                );
                if (errMatch && errMatch[1]) {
                  lastErrorLine = errMatch[1].trim();
                }

                const sizeTupleMatch = line.match(/\([\d.]+,\s*['"][A-Z]+['"]\)\s*(\d+)/);
                if (sizeTupleMatch && currentTask) {
                  const parsedBytes = Number(sizeTupleMatch[1]);
                  if (parsedBytes > 0) {
                    if (/Disk size:/i.test(line) && !/Download size:/i.test(line)) {
                      const validDisk = sanitizeGameInstallSizeBytes(parsedBytes);
                      if (validDisk) {
                        gogReportedDiskSizeBytes = validDisk;
                        currentTask.diskSizeBytes = validDisk;
                      }
                      if (
                        !currentTask.hasExactDownloadSize &&
                        (!currentTask.totalBytes || currentTask.totalBytes <= 0)
                      ) {
                        currentTask.totalBytes = parsedBytes;
                        resolvedSizeOnChunk = true;
                      }
                    } else {
                      currentTask.totalBytes = parsedBytes;
                      currentTask.hasExactDownloadSize = true;
                      resolvedSizeOnChunk = true;
                    }
                  }
                }

                const diskSizeMatch = line.match(
                  /Disk size:\s*([\d.]+)\s*(KiB|MiB|GiB|TiB|KB|MB|GB|TB|B)/i
                );
                if (diskSizeMatch && currentTask && !sizeTupleMatch) {
                  const parsedDisk = sanitizeGameInstallSizeBytes(
                    parseCliSizeToBytes(diskSizeMatch[1], diskSizeMatch[2])
                  );
                  if (parsedDisk) {
                    gogReportedDiskSizeBytes = parsedDisk;
                    currentTask.diskSizeBytes = parsedDisk;
                    if (
                      !currentTask.hasExactDownloadSize &&
                      (!currentTask.totalBytes || currentTask.totalBytes <= 0)
                    ) {
                      currentTask.totalBytes = parsedDisk;
                      resolvedSizeOnChunk = true;
                    }
                  }
                }

                const dlSizeMatch = line.match(/Download size:\s*([\d.]+)\s*(KiB|MiB|GiB)/i);
                if (dlSizeMatch && currentTask && !sizeTupleMatch) {
                  const parsedTotal = parseCliSizeToBytes(dlSizeMatch[1], dlSizeMatch[2]);
                  if (parsedTotal > 0) {
                    currentTask.totalBytes = parsedTotal;
                    currentTask.hasExactDownloadSize = true;
                    resolvedSizeOnChunk = true;
                  }
                }

                const progressBytesMatch = line.match(/Progress:\s*[\d.]+\s+(\d+)\/(\d+)/i);
                if (progressBytesMatch && currentTask && Number(progressBytesMatch[2]) > 0) {
                  currentTask.totalBytes = Number(progressBytesMatch[2]);
                  const dlBytesVal = Math.max(
                    currentTask.downloadedBytes || currentTask.bytesDownloaded || 0,
                    Number(progressBytesMatch[1]) || 0
                  );
                  currentTask.downloadedBytes = dlBytesVal;
                  currentTask.bytesDownloaded = dlBytesVal;
                  resolvedSizeOnChunk = true;
                }
              }

              if (!currentTask) return;

              if (resolvedSizeOnChunk && currentTask.totalBytes > 0) {
                updateDownloadTask(
                  taskId,
                  {
                    totalBytes: currentTask.totalBytes,
                    downloadedBytes:
                      currentTask.downloadedBytes || currentTask.bytesDownloaded || 0,
                    bytesDownloaded:
                      currentTask.bytesDownloaded || currentTask.downloadedBytes || 0,
                  },
                  options
                );
              }

              if (
                currentTask.progressPercent === 0 &&
                (/\[V2\]\s*INFO:\s*Deleted:/i.test(text) || /Getting Dependencies repository/i.test(text))
              ) {
                updateDownloadTask(
                  taskId,
                  {
                    statusMessage: 'Allocating files & starting GOG download...',
                  },
                  options
                );
              }

              const pctMatch = matchLast(text, /Progress:\s*([\d.]+)%?/gi);
              const dlMiBMatch = matchLast(text, /Downloaded:\s*([\d.]+)\s*(KiB|MiB|GiB|B)?/gi);
              const speedMatch =
                matchLast(text, /\+\s*Download\s*-\s*([\d.]+)\s*(KiB|MiB|GiB|B)\/s/gi) ||
                matchLast(text, /Download\s*-\s*([\d.]+)\s*(KiB|MiB|GiB|B)?/gi);
              const decompMatch = matchLast(
                text,
                /\/\s*([\d.]+)\s*(KiB|MiB|GiB|B)\/s\s*\(decompressed\)/gi
              );
              const etaMatch = matchLast(text, /ETA:\s*(\d+):(\d+):(\d+)/gi);

              if (pctMatch || dlMiBMatch || speedMatch || etaMatch) {
                /** @type {any} */
                const partialUpdate = {};
                if (pctMatch) {
                  currentTask.hasExplicitCliProgress = true;
                  partialUpdate.progressPercent = Math.min(99, Math.round(parseFloat(pctMatch[1])));
                } else {
                  partialUpdate.progressPercent = currentTask.progressPercent;
                }
                if (dlMiBMatch) {
                  currentTask.hasExplicitCliBytes = true;
                  partialUpdate.bytesDownloaded = parseCliSizeToBytes(
                    dlMiBMatch[1],
                    dlMiBMatch[2] || 'MiB'
                  );
                } else if (
                  pctMatch &&
                  !currentTask.hasExplicitCliBytes &&
                  partialUpdate.bytesDownloaded === undefined
                ) {
                  partialUpdate.bytesDownloaded = Math.round(
                    (partialUpdate.progressPercent / 100) * currentTask.totalBytes
                  );
                }
                const rawCliSpeed = speedMatch
                  ? parseCliSizeToBytes(speedMatch[1], speedMatch[2] || 'MiB')
                  : 0;
                const decompCliSpeed = decompMatch
                  ? parseCliSizeToBytes(decompMatch[1], decompMatch[2] || 'MiB')
                  : 0;
                if (speedMatch || partialUpdate.bytesDownloaded !== undefined) {
                  const smoothedSpeed = computeSmoothedDownloadSpeed(taskId, {
                    bytesDownloaded:
                      partialUpdate.bytesDownloaded !== undefined
                        ? partialUpdate.bytesDownloaded
                        : currentTask.bytesDownloaded,
                    rawSpeedBytesPerSec: rawCliSpeed,
                    decompressedSpeedBytesPerSec: decompCliSpeed,
                  });
                  if (smoothedSpeed > 0 || speedMatch) {
                    partialUpdate.speedBytesPerSec = smoothedSpeed;
                  }
                }
                if (etaMatch) {
                  const cliEta =
                    parseInt(etaMatch[1], 10) * 3600 +
                    parseInt(etaMatch[2], 10) * 60 +
                    parseInt(etaMatch[3], 10);
                  const activeSpeed =
                    partialUpdate.speedBytesPerSec || currentTask.speedBytesPerSec || 0;
                  const activeBytes =
                    partialUpdate.bytesDownloaded !== undefined
                      ? partialUpdate.bytesDownloaded
                      : currentTask.bytesDownloaded;
                  if (
                    currentTask.etaSeconds > 0 &&
                    cliEta > currentTask.etaSeconds * 3 &&
                    activeSpeed > 0 &&
                    currentTask.totalBytes > activeBytes
                  ) {
                    partialUpdate.etaSeconds = Math.max(
                      1,
                      Math.round((currentTask.totalBytes - activeBytes) / activeSpeed)
                    );
                  } else {
                    partialUpdate.etaSeconds = cliEta;
                  }
                }
                const displayPct =
                  partialUpdate.progressPercent !== undefined
                    ? partialUpdate.progressPercent
                    : currentTask.progressPercent;
                partialUpdate.statusMessage = `Installing via gogdl (${displayPct}%)...`;
                updateDownloadTask(taskId, partialUpdate, options);
              }
            };

            if (child.stdout) child.stdout.on('data', onGogOutput);
            if (child.stderr) child.stderr.on('data', onGogOutput);
            child.on('exit', async (/** @type {number | null} */ code) => {
              const currentTask = downloadQueueMap.get(taskId);
              if (ctrl.pausedByUser || (currentTask && currentTask.status === 'paused')) {
                ctrl.exitedWhilePaused = true;
                ctrl.child = null;
                return;
              }
              downloadControllers.delete(taskId);
              if (currentTask && currentTask.status === 'cancelled') return;

              if (code === 0) {
                const targetScanDir = fs.existsSync(finalInstallPath) ? finalInstallPath : installDir;
                flattenGogNestedInstallDir(targetScanDir, cleanId);
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
                    if (v1FallbackErr && v1FallbackErr.isPausedByUser) return;
                  }
                }

                const isWindowsBinaryOnMac =
                  platform === 'darwin' &&
                  (gogPlatformFlag === 'windows' || Boolean(exeDiscovery.isWindowsBinaryOnMac));

                const resolvedGogInstallSize =
                  sanitizeGameInstallSizeBytes(
                    gogReportedDiskSizeBytes || currentTask?.diskSizeBytes
                  ) ||
                  sanitizeGameInstallSizeBytes(getDirectorySizeFast(targetScanDir, 4)) ||
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
                  syncGogFirstPartyLauncher(gogRecord, options);
                } catch {}

                updateDownloadTask(
                  taskId,
                  {
                    status: 'completed',
                    progressPercent: 100,
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
                        finalInstallPath,
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
                    if (v1FallbackErr && v1FallbackErr.isPausedByUser) return;
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
          }
        } catch (/** @type {any} */ err) {
          updateDownloadTask(
            taskId,
            {
              status: 'failed',
              speedBytesPerSec: 0,
              error: err.message,
              statusMessage: `Failed to start gogdl: ${err.message}`,
            },
            options
          );
        }
      } else if (!gogToken && !payload.downloadUrl) {
        await openExternalUri(`goggalaxy://openGameView/${platformGameId}`, options);
        updateDownloadTask(
          taskId,
          {
            statusMessage: 'Opened in GOG Galaxy client...',
          },
          options
        );
      }
    } else if (platformId === 'xbox') {
      const cleanStoreId = String(
        payload.xboxProductId || payload.storeId || platformGameId || ''
      )
        .replace(/^xbox[-_:]/i, '')
        .trim()
        .toUpperCase();

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

      if (
        platform === 'darwin' &&
        !validatedPayloadExternalUrl &&
        !payload.msixvcPath &&
        (!Array.isArray(payload.downloadUrls) || payload.downloadUrls.length === 0) &&
        !preResolvedDeliveryInfo
      ) {
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
          payload.installerId === 'xbox-external-mac-launcher' &&
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
                externalLauncher: meta.externalLauncher,
                externalLauncherUrl: meta.externalLauncherUrl,
                externalStorefrontHandoff: meta.externalStorefrontHandoff,
                downloadUrls: [],
              };
              preResolveError = null;
            }
          } catch {}
        }
      }

      const preResolvedDownloadUrls = Array.isArray(payload.downloadUrls)
        ? payload.downloadUrls
        : Array.isArray(preResolvedDeliveryInfo?.downloadUrls)
          ? preResolvedDeliveryInfo.downloadUrls
          : [];
      const validatedDeliveryExternalUrl = validateTrustedExternalLauncherUrl(
        preResolvedDeliveryInfo?.externalLauncherUrl || ''
      );
      const externalLauncherUrl =
        validatedPayloadExternalUrl ||
        (platform === 'darwin' &&
        (payload.installerId === 'xbox-external-mac-launcher' ||
          (!payload.msixvcPath && preResolvedDownloadUrls.length === 0))
          ? validatedDeliveryExternalUrl
          : '');

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
        const { _persistedUserDataDir: _ignoredHandoff, ...publicHandoffTask } = latestHandoffTask;
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

            const downloadUrls = Array.isArray(payload.downloadUrls)
              ? payload.downloadUrls
              : Array.isArray(deliveryInfo?.downloadUrls)
                ? deliveryInfo.downloadUrls
                : [];
            if (!payload.msixvcPath && downloadUrls.length === 0) {
              const fallbackHandoffUrl =
                platform === 'darwin'
                  ? validateTrustedExternalLauncherUrl(deliveryInfo?.externalLauncherUrl || '')
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
                      deviceContext = await authProvider.ensureDeviceContext({ forceRefresh: true });
                    }

                    if (!storeMsaToken) {
                      missingStoreLicensingTicket = true;
                      throw firstCikErr;
                    }

                    try {
                      const retryCikRes = await invokeAcquireCik(storeMsaToken);
                      applyCikResult(retryCikRes);
                    } catch (secondCikErr) {
                      if (!ranInteractiveLicenseRecovery && typeof recoverXboxLicenseFn === 'function') {
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

            const extractFn =
              options.extractMsixvcFn ||
              xboxMods?.extractMsixvcInWorker ||
              xboxMods?.extractMsixvcStream;
            if (typeof extractFn !== 'function') {
              if (!installPathExistedBefore) {
                try {
                  fs.rmSync(finalInstallPath, { recursive: true, force: true });
                } catch {}
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
                  try {
                    fs.rmSync(finalInstallPath, { recursive: true, force: true });
                  } catch {}
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
            const resolvedPrimaryExe =
              (extractedGameCfg?.primaryExecutable
                ? path.join(
                    extractedGameCfg.contentRootDir || finalInstallPath,
                    extractedGameCfg.primaryExecutable.replace(/\\/g, path.sep)
                  )
                : '') ||
              extractResult?.primaryExecutablePath ||
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
              sanitizeGameInstallSizeBytes(getDirectorySizeFast(finalInstallPath, 4)) ||
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
            try {
              const journalPath = path.join(finalInstallPath, '.onelauncher-xbox-journal.json');
              if (fs.existsSync(journalPath)) {
                fs.rmSync(journalPath, { force: true });
              }
            } catch {}

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
    const { _persistedUserDataDir: _ignoredLatest, ...publicLatestTask } = latestTask;
    return {
      success: true,
      message: `Started installation for ${title}`,
      task: { ...publicLatestTask },
    };
  } catch (/** @type {any} */ err) {
    return {
      success: false,
      error: err.message,
    };
  }
}

function pauseDownload(/** @type {string} */ taskId, /** @type {any} */ options = {}) {
  ensureDownloadQueueRehydrated(options);
  const task = downloadQueueMap.get(taskId);
  if (!task) {
    return { success: false, error: `Download task ${taskId} not found.` };
  }
  if (task.status !== 'downloading' && task.status !== 'queued') {
    const { _persistedUserDataDir, ...publicTask } = task;
    return {
      success: false,
      error: `Cannot pause download task in status "${task.status}".`,
      task: { ...publicTask },
    };
  }

  const targetPlatform = options.platform || process.platform;
  const ctrl = downloadControllers.get(taskId);
  if (ctrl) {
    ctrl.pausedByUser = true;
    if (ctrl.type === 'abort' && ctrl.controller) {
      try {
        ctrl.controller.abort();
      } catch {}
    } else if (ctrl.type === 'process' && ctrl.child) {
      if (targetPlatform === 'win32') {
        ctrl.exitedWhilePaused = true;
        signalSubprocessTree(ctrl.child, 'SIGKILL', options);
      } else {
        signalSubprocessTree(ctrl.child, 'SIGSTOP', options);
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

function resumeDownload(/** @type {string} */ taskId, /** @type {any} */ options = {}) {
  ensureDownloadQueueRehydrated(options);
  const task = downloadQueueMap.get(taskId);
  if (!task) {
    return { success: false, error: `Download task ${taskId} not found.` };
  }
  if (task.status !== 'paused' && task.status !== 'failed') {
    const { _persistedUserDataDir, ...publicTask } = task;
    return {
      success: false,
      error: `Cannot resume download task in status "${task.status}".`,
      task: { ...publicTask },
    };
  }

  const targetPlatform = options.platform || process.platform;
  const ctrl = downloadControllers.get(taskId);
  let shouldInvokeResumeFn = false;
  let shouldReinvokeInstallRequest = false;

  if (ctrl) {
    ctrl.pausedByUser = false;
    const pid = ctrl.type === 'process' && ctrl.child ? ctrl.child.pid : null;
    const canSigCont =
      Boolean(pid) &&
      !ctrl.exitedWhilePaused &&
      targetPlatform !== 'win32' &&
      isProcessAlive(pid);
    if (canSigCont) {
      Promise.resolve(signalSubprocessTree(ctrl.child, 'SIGCONT', options))
        .then((signaled) => {
          if (!signaled && ctrl && typeof ctrl.resumeInstallFn === 'function') {
            ctrl.exitedWhilePaused = false;
            return ctrl.resumeInstallFn();
          }
          return undefined;
        })
        .catch((err) => {
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
    ctrl.exitedWhilePaused = false;
    Promise.resolve()
      .then(() => ctrl.resumeInstallFn())
      .catch((err) => {
        diagLog.warn('resumeDownload.resumeInstallFn', err, { taskId });
      });
  } else if (shouldReinvokeInstallRequest && task.installRequest) {
    Promise.resolve()
      .then(() =>
        installGame(
          {
            ...task.installRequest,
            taskId,
            _resumingPausedInstall: true,
          },
          options
        )
      )
      .catch((err) => {
        diagLog.warn('resumeDownload.reinvokeInstallGame', err, { taskId });
      });
  }

  return updatedRes;
}

function terminateDownloadController(/** @type {any} */ ctrl, /** @type {any} */ options = {}) {
  if (!ctrl) return Promise.resolve();
  ctrl.cancelRequested = true;
  ctrl.pausedByUser = false;
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

function collectCandidateCancelledGogTempBins(/** @type {any} */ task, /** @type {any} */ ctrl) {
  /** @type {Set<string>} */
  const candidateBins = new Set();
  if (ctrl && typeof ctrl.tempBinPath === 'string' && ctrl.tempBinPath) {
    candidateBins.add(ctrl.tempBinPath);
  }
  if (task && typeof task.tempBinPath === 'string' && task.tempBinPath) {
    candidateBins.add(task.tempBinPath);
  }
  if (task && task.platformId === 'gog' && task.finalInstallPath) {
    const cleanId = String(task.platformGameId || task.gameId || '')
      .replace(/^gog[-_]/i, '')
      .trim();
    if (cleanId) {
      candidateBins.add(path.join(task.finalInstallPath, `.gog_v1_${cleanId}_main.bin`));
    }
  }
  return candidateBins;
}

function cleanupCancelledGogTempBins(/** @type {any} */ task, /** @type {any} */ ctrl) {
  const candidateBins = collectCandidateCancelledGogTempBins(task, ctrl);
  for (const binPath of candidateBins) {
    try {
      if (fs.existsSync(binPath)) {
        fs.unlinkSync(binPath);
      }
    } catch (/** @type {any} */ err) {
      if (err && err.code !== 'ENOENT') {
        diagLog.warn('cancelDownload.unlinkTempBin', err, { binPath });
      }
    }
  }
}

async function cleanupCancelledGogTempBinsAsync(/** @type {any} */ task, /** @type {any} */ ctrl) {
  const candidateBins = collectCandidateCancelledGogTempBins(task, ctrl);
  for (const binPath of candidateBins) {
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        if (!fs.existsSync(binPath)) break;
        fs.unlinkSync(binPath);
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

function cleanupCancelledXboxPartialInstall(/** @type {any} */ task, /** @type {any} */ ctrl) {
  if (!task || task.platformId !== 'xbox') return;
  const targetDir = ctrl?.xboxInstallPath || task.finalInstallPath;
  if (!targetDir || !fs.existsSync(targetDir)) return;

  for (const rName of ['.onelauncher-xbox-receipt.json', '.onelauncher-xbox-install.json']) {
    const rp = path.join(targetDir, rName);
    try {
      if (fs.existsSync(rp)) {
        const receipt = JSON.parse(fs.readFileSync(rp, 'utf8'));
        if (receipt && receipt.status === 'completed') {
          return;
        }
      }
    } catch {}
  }

  const sweepOlPartFiles = (/** @type {string} */ dir, depth = 0) => {
    if (depth > 8 || !fs.existsSync(dir)) return;
    /** @type {fs.Dirent[]} */
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      const fullPath = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        sweepOlPartFiles(fullPath, depth + 1);
      } else if (ent.isFile() && ent.name.endsWith('.olpart')) {
        try {
          fs.unlinkSync(fullPath);
        } catch {}
      }
    }
  };

  sweepOlPartFiles(targetDir, 0);
  for (const jName of [
    '.onelauncher-xbox-journal.json',
    '.onelauncher-xbox-receipt.json',
    '.onelauncher-xbox-install.json',
  ]) {
    const jp = path.join(targetDir, jName);
    try {
      if (fs.existsSync(jp)) {
        fs.unlinkSync(jp);
      }
    } catch {}
  }
}

function cancelDownload(/** @type {string} */ taskId, /** @type {any} */ options = {}) {
  ensureDownloadQueueRehydrated(options);
  pausedByInGameTaskIds.delete(taskId);
  const task = downloadQueueMap.get(taskId);
  if (!task) {
    return { success: false, error: `Download task ${taskId} not found.` };
  }

  const ctrl = downloadControllers.get(taskId);
  let termPromise = null;
  if (ctrl) {
    termPromise = terminateDownloadController(ctrl, options);
    downloadControllers.delete(taskId);
  }
  cleanupCancelledGogTempBins(task, ctrl);
  cleanupCancelledXboxPartialInstall(task, ctrl);
  if (termPromise) {
    termPromise
      .finally(() => {
        cleanupCancelledXboxPartialInstall(task, ctrl);
        return cleanupCancelledGogTempBinsAsync(task, ctrl);
      })
      .catch(() => {});
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

function clearDownloadQueue(/** @type {any} */ options = {}) {
  for (const [taskId, ctrl] of downloadControllers.entries()) {
    const task = downloadQueueMap.get(taskId);
    terminateDownloadController(ctrl, options);
    cleanupCancelledGogTempBins(task, ctrl);
    cleanupCancelledXboxPartialInstall(task, ctrl);
  }
  downloadControllers.clear();
  downloadSpeedTrackers.clear();
  pausedByInGameTaskIds.clear();
  downloadQueueMap.clear();
  rehydratedQueueDirs.clear();
  persistDownloadQueueToDisk(options?.userDataDir);
}

function shutdownDownloadEngine(/** @type {any} */ options = {}) {
  persistDownloadQueueToDisk(options?.userDataDir);
  for (const [, ctrl] of downloadControllers.entries()) {
    terminateDownloadController(ctrl, options);
  }
  downloadControllers.clear();
  downloadSpeedTrackers.clear();
}

function getPausedByInGameTaskIds() {
  return Array.from(pausedByInGameTaskIds);
}

function pauseActiveDownloadsForInGame(/** @type {any} */ options = {}) {
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

function resumeDownloadsPausedByInGame(/** @type {any} */ options = {}) {
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
  MAX_PLAUSIBLE_GAME_INSTALL_BYTES,
  TRUSTED_EXTERNAL_LAUNCHER_DOMAINS,
  validateTrustedExternalLauncherUrl,
  ensureDownloadQueueRehydrated,
  persistDownloadQueueToDisk,
  computeSmoothedDownloadSpeed,
  getDownloadQueue,
  updateDownloadTask,
  hasAuthenticatedSteamSessionInVdfCandidates,
  startSteamInstallMonitor,
  startXboxInstallMonitor,
  ensureWindowsSteamInBottle,
  sweepStaleGogTempBinsAsync,
  getGameInstallInfo,
  installGame,
  pauseDownload,
  resumeDownload,
  terminateDownloadController,
  cancelDownload,
  clearDownloadQueue,
  shutdownDownloadEngine,
  getPausedByInGameTaskIds,
  pauseActiveDownloadsForInGame,
  resumeDownloadsPausedByInGame,
};
