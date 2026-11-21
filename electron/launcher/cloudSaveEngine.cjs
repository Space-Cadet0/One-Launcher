// @ts-check
'use strict';

const oneDriveAndPathGuards = require('./cloudSave/oneDriveAndPathGuards.cjs');
const backupAndQuotaManagerMod = require('./cloudSave/backupAndQuotaManager.cjs');
const savePathResolvers = require('./cloudSave/savePathResolvers.cjs');
const xboxCloudSaveSyncMod = require('./cloudSave/xboxCloudSaveSync.cjs');
const pendingUploadReplayQueueMod = require('./cloudSave/pendingUploadReplayQueue.cjs');
const gogAndEpicCloudRunnerMod = require('./cloudSave/gogAndEpicCloudRunner.cjs');

/**
 * Load-time host platform capture MUST remain directly inside `cloudSaveEngine.cjs` so
 * single-file `require.cache` eviction tests under mocked `process.platform` recalculate
 * `MODULE_LOAD_PLATFORM` and `DEFAULT_CLOUD_SAVE_MAX_BACKUP_BYTES` accurately per reload.
 */
const INITIAL_HOST_PLATFORM =
  /** @type {any} */ (globalThis).__ONE_LAUNCHER_INITIAL_HOST_PLATFORM__ ||
  (/** @type {any} */ (globalThis).__ONE_LAUNCHER_INITIAL_HOST_PLATFORM__ = process.platform);
const MODULE_LOAD_PLATFORM = process.platform;

/**
 * @param {Record<string, any>} [options]
 * @returns {number}
 */
function resolveDefaultPerSnapshotMaxBackupBytes(options = {}) {
  const effectivePlatform =
    options?.platform ||
    (process.platform !== INITIAL_HOST_PLATFORM ? process.platform : '') ||
    options?._boundPlatform ||
    MODULE_LOAD_PLATFORM ||
    process.platform;
  return effectivePlatform === 'win32'
    ? backupAndQuotaManagerMod.DEFAULT_WIN32_CLOUD_SAVE_MAX_BACKUP_BYTES
    : backupAndQuotaManagerMod.DEFAULT_DARWIN_CLOUD_SAVE_MAX_BACKUP_BYTES;
}

const DEFAULT_CLOUD_SAVE_MAX_BACKUP_BYTES = resolveDefaultPerSnapshotMaxBackupBytes({
  _boundPlatform: MODULE_LOAD_PLATFORM,
});

/**
 * Parse a standalone 10-digit Unix timestamp strictly from `gogdl save-sync` stdout
 * (never stderr, preventing noisy error/log digits from corrupting persisted sync timestamps).
 *
 * @param {{ stdout?: string, stderr?: string } | null | undefined} execRes
 * @param {number} [fallbackNowSec]
 * @returns {number}
 */
function parseGogdlSyncTimestampFromStdout(
  execRes,
  fallbackNowSec = Math.floor(Date.now() / 1000)
) {
  let updatedTs = fallbackNowSec;
  if (!execRes || typeof execRes !== 'object') {
    return updatedTs;
  }
  const stdoutOnly = String(execRes.stdout || '');
  const standaloneTsMatches = Array.from(
    stdoutOnly.matchAll(/^\s*(1[6-9]\d{8}|2\d{9})(?:\.\d+)?\s*$/gm)
  );
  if (standaloneTsMatches.length > 0) {
    const parsedCandidate = Math.floor(
      Number(standaloneTsMatches[standaloneTsMatches.length - 1][1])
    );
    if (Number.isFinite(parsedCandidate) && parsedCandidate > 0) {
      updatedTs = parsedCandidate;
    }
  } else {
    const trimmedLines = stdoutOnly
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean);
    const lastLine = trimmedLines[trimmedLines.length - 1] || '';
    if (/^\d{9,11}(?:\.\d+)?$/.test(lastLine)) {
      const numericLine = Math.floor(Number(lastLine));
      if (numericLine > 0) updatedTs = numericLine;
    }
  }
  return updatedTs;
}

const getExports = () => /** @type {Record<string, any>} */ (module.exports);

const backupManager = backupAndQuotaManagerMod.createBackupAndQuotaManager({
  resolveDefaultPerSnapshotMaxBackupBytes,
  inspectOneDrivePlaceholderStateAsync: (...args) =>
    getExports().inspectOneDrivePlaceholderStateAsync(...args),
});

const xboxSync = xboxCloudSaveSyncMod.createXboxCloudSaveSync({
  resolveDefaultPerSnapshotMaxBackupBytes,
  createCloudSaveRollingBackupAsync: (...args) =>
    getExports().createCloudSaveRollingBackupAsync(...args),
  resolveXboxSaveLocations: (...args) => getExports().resolveXboxSaveLocations(...args),
  getWaitForXboxCloudSaveFlush: () => getExports().waitForXboxCloudSaveFlush,
});

const pendingReplayQueue = pendingUploadReplayQueueMod.createPendingUploadReplayQueue({
  resolveDefaultPerSnapshotMaxBackupBytes,
  createCloudSaveRollingBackupAsync: (...args) =>
    getExports().createCloudSaveRollingBackupAsync(...args),
  syncXboxCloudSaves: (...args) => getExports().syncXboxCloudSaves(...args),
});

const createCloudSaveRunner = gogAndEpicCloudRunnerMod.createCloudSaveRunnerFactory({
  resolveDefaultPerSnapshotMaxBackupBytes,
  parseGogdlSyncTimestampFromStdout: (...args) =>
    getExports().parseGogdlSyncTimestampFromStdout(...args),
  inspectOneDrivePlaceholderStateAsync: (...args) =>
    getExports().inspectOneDrivePlaceholderStateAsync(...args),
  createCloudSaveRollingBackupAsync: (...args) =>
    getExports().createCloudSaveRollingBackupAsync(...args),
  enforceCloudSaveBackupQuotaAsync: (...args) =>
    getExports().enforceCloudSaveBackupQuotaAsync(...args),
  cleanupGameBackups: (...args) => getExports().cleanupGameBackups(...args),
  resolveGogCloudSaveLocations: (...args) => getExports().resolveGogCloudSaveLocations(...args),
  resolveEpicSavePathTemplate: (...args) => getExports().resolveEpicSavePathTemplate(...args),
  isSafeEpicSaveTemplateSyntax: (...args) => getExports().isSafeEpicSaveTemplateSyntax(...args),
  pruneGogCloudConfigsMap: (...args) => getExports().pruneGogCloudConfigsMap(...args),
  pruneCloudSaveStateForGameAsync: (...args) =>
    getExports().pruneCloudSaveStateForGameAsync(...args),
  syncXboxCloudSaves: (...args) => getExports().syncXboxCloudSaves(...args),
  waitForXboxCloudSaveFlush: (...args) => getExports().waitForXboxCloudSaveFlush(...args),
});

module.exports = {
  // Constants
  GOG_GALAXY_LAUNCHER_CLIENT_ID: oneDriveAndPathGuards.GOG_GALAXY_LAUNCHER_CLIENT_ID,
  MAX_GOG_CLOUD_CONFIG_CACHE_ENTRIES: oneDriveAndPathGuards.MAX_GOG_CLOUD_CONFIG_CACHE_ENTRIES,
  BENIGN_CLOUD_SYNC_SKIP_REASONS: oneDriveAndPathGuards.BENIGN_CLOUD_SYNC_SKIP_REASONS,
  DEFAULT_CLOUD_SAVE_MAX_BACKUP_BYTES,
  DEFAULT_GLOBAL_CLOUD_SAVE_BACKUP_QUOTA_BYTES:
    backupAndQuotaManagerMod.DEFAULT_GLOBAL_CLOUD_SAVE_BACKUP_QUOTA_BYTES,
  MIN_RETAINED_BACKUPS_PER_GAME: backupAndQuotaManagerMod.MIN_RETAINED_BACKUPS_PER_GAME,
  FILE_ATTRIBUTE_OFFLINE: oneDriveAndPathGuards.FILE_ATTRIBUTE_OFFLINE,
  FILE_ATTRIBUTE_RECALL_ON_OPEN: oneDriveAndPathGuards.FILE_ATTRIBUTE_RECALL_ON_OPEN,
  FILE_ATTRIBUTE_RECALL_ON_DATA_ACCESS:
    oneDriveAndPathGuards.FILE_ATTRIBUTE_RECALL_ON_DATA_ACCESS,
  PENDING_CLOUD_UPLOADS_FILENAME: pendingUploadReplayQueueMod.PENDING_CLOUD_UPLOADS_FILENAME,

  // OneDrive, path containment, bounded file open, locks & metadata hygiene
  hasWin32CloudPlaceholderAttributes: oneDriveAndPathGuards.hasWin32CloudPlaceholderAttributes,
  isOneDrivePath: oneDriveAndPathGuards.isOneDrivePath,
  isBroadOneDriveKnownFolderRoot: oneDriveAndPathGuards.isBroadOneDriveKnownFolderRoot,
  inspectOneDrivePlaceholderStateAsync:
    oneDriveAndPathGuards.inspectOneDrivePlaceholderStateAsync,
  openFileBoundedNoRecallAsync: oneDriveAndPathGuards.openFileBoundedNoRecallAsync,
  withCloudManifestFileLock: oneDriveAndPathGuards.withCloudManifestFileLock,
  withPerGameCloudSyncLock: oneDriveAndPathGuards.withPerGameCloudSyncLock,
  normalizePosixUtf8Locale: oneDriveAndPathGuards.normalizePosixUtf8Locale,
  purgeOsMetadataAndCountRealFilesSync:
    oneDriveAndPathGuards.purgeOsMetadataAndCountRealFilesSync,
  purgeOsMetadataAndCountRealFilesAsync:
    oneDriveAndPathGuards.purgeOsMetadataAndCountRealFilesAsync,

  // Rolling backup & global quota manager
  createCloudSaveRollingBackup: backupManager.createCloudSaveRollingBackup,
  createCloudSaveRollingBackupAsync: backupManager.createCloudSaveRollingBackupAsync,
  enforceCloudSaveBackupQuotaSync: backupManager.enforceCloudSaveBackupQuotaSync,
  enforceCloudSaveBackupQuotaAsync: backupManager.enforceCloudSaveBackupQuotaAsync,
  cleanupGameBackups: backupManager.cleanupGameBackups,

  // Save path resolvers, config/timestamp pruning & telemetry
  resolveGogCloudSaveLocations: savePathResolvers.resolveGogCloudSaveLocations,
  resolveEpicSavePathTemplate: savePathResolvers.resolveEpicSavePathTemplate,
  resolveXboxSaveLocations: savePathResolvers.resolveXboxSaveLocations,
  isSafeEpicSaveTemplateSyntax: savePathResolvers.isSafeEpicSaveTemplateSyntax,
  pruneGogCloudConfigsMap: savePathResolvers.pruneGogCloudConfigsMap,
  pruneCloudSaveStateForGame: savePathResolvers.pruneCloudSaveStateForGame,
  pruneCloudSaveStateForGameAsync: savePathResolvers.pruneCloudSaveStateForGameAsync,
  buildCloudSyncTelemetryPayload: savePathResolvers.buildCloudSyncTelemetryPayload,

  // Xbox Connected Storage & GamingServices flush
  isClientlessWindowsXboxGdkInstall: xboxCloudSaveSyncMod.isClientlessWindowsXboxGdkInstall,
  waitForXboxCloudSaveFlush: xboxSync.waitForXboxCloudSaveFlush,
  syncXboxCloudSaves: xboxSync.syncXboxCloudSaves,

  // Pending upload queue & conflict-safe replay
  computeSavePathsStateSnapshot: pendingUploadReplayQueueMod.computeSavePathsStateSnapshot,
  computeSavePathsStateSnapshotAsync:
    pendingUploadReplayQueueMod.computeSavePathsStateSnapshotAsync,
  loadPendingCloudUploads: pendingUploadReplayQueueMod.loadPendingCloudUploads,
  enqueuePendingCloudUpload: pendingUploadReplayQueueMod.enqueuePendingCloudUpload,
  removePendingCloudUpload: pendingUploadReplayQueueMod.removePendingCloudUpload,
  replayPendingCloudUpload: pendingReplayQueue.replayPendingCloudUpload,
  replayPendingCloudUploads: pendingReplayQueue.replayPendingCloudUploads,

  // GOG / Epic / Steam cloud runner & stdout timestamp parser
  parseGogdlSyncTimestampFromStdout,
  createCloudSaveRunner,
};
