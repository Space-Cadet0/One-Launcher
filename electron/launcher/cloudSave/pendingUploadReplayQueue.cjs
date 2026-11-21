// @ts-check
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { diagLog } = require('../../utils/diagnosticLogger.cjs');
const { getUserDataDir, isNetworkOnlineForLaunch } = require('../engineStateRegistry.cjs');
const { toHostFilesystemPath } = require('../securityAndPathUtils.cjs');
const {
  OS_METADATA_JUNK_REGEX,
  withCloudManifestFileLock,
  buildPerGameCloudSyncLockKey,
  withPerGameCloudSyncLock,
  pathExistsAsync,
  atomicWriteFileAsync,
} = require('./oneDriveAndPathGuards.cjs');

const PENDING_CLOUD_UPLOADS_FILENAME = 'pending_cloud_uploads.json';
const MAX_PENDING_CLOUD_UPLOADS = 100;

/**
 * @param {Record<string, any> | string} [options]
 * @returns {string}
 */
function getPendingCloudUploadsFilePath(options = {}) {
  const customDir =
    options && typeof options === 'object'
      ? options.userDataDir || options.baseDir
      : typeof options === 'string'
        ? options
        : undefined;
  return path.join(getUserDataDir(customDir), PENDING_CLOUD_UPLOADS_FILENAME);
}

/**
 * Compute deterministic `(localMaxMtimeMs, localFilesDigest, fileCount)` synchronously across
 * one or more local save paths, skipping OS metadata junk and symlinks.
 *
 * @param {string[]} [savePaths]
 * @returns {{ localMaxMtimeMs: number, localFilesDigest: string, fileCount: number }}
 */
function computeSavePathsStateSnapshot(savePaths = []) {
  const pathsList = Array.isArray(savePaths)
    ? savePaths.map((p) => String(p || '').trim()).filter(Boolean)
    : [];
  /** @type {string[]} */
  const digestLines = [];
  let maxMtimeMs = 0;
  let fileCount = 0;

  /**
   * @param {string} rootDir
   * @param {string} currentDir
   * @param {number} depth
   */
  const walk = (rootDir, currentDir, depth) => {
    if (depth > 12) return;
    let entries;
    try {
      entries = fs.readdirSync(currentDir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry || entry.isSymbolicLink() || OS_METADATA_JUNK_REGEX.test(entry.name)) continue;
      const fullPath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        walk(rootDir, fullPath, depth + 1);
      } else if (entry.isFile()) {
        try {
          const st = fs.lstatSync(fullPath);
          if (st.isSymbolicLink()) continue;
          const mtime = Math.trunc(st.mtimeMs || 0);
          if (mtime > maxMtimeMs) maxMtimeMs = mtime;
          const rel = path.relative(rootDir, fullPath).replace(/\\/g, '/');
          digestLines.push(`${rel}|${st.size}|${mtime}`);
          fileCount += 1;
        } catch {}
      }
    }
  };

  for (const rawPath of pathsList) {
    const hostPath = toHostFilesystemPath(rawPath);
    if (!hostPath || !fs.existsSync(hostPath)) continue;
    try {
      const st = fs.lstatSync(hostPath);
      if (st.isSymbolicLink()) continue;
      if (st.isFile()) {
        const mtime = Math.trunc(st.mtimeMs || 0);
        if (mtime > maxMtimeMs) maxMtimeMs = mtime;
        digestLines.push(`${path.basename(hostPath)}|${st.size}|${mtime}`);
        fileCount += 1;
      } else if (st.isDirectory()) {
        walk(hostPath, hostPath, 0);
      }
    } catch {}
  }

  digestLines.sort();
  const digest =
    digestLines.length > 0
      ? crypto.createHash('sha256').update(digestLines.join('\n')).digest('hex')
      : '';
  return {
    localMaxMtimeMs: maxMtimeMs,
    localFilesDigest: digest,
    fileCount,
  };
}

/**
 * Non-blocking asynchronous counterpart to `computeSavePathsStateSnapshot` using
 * `fs.promises.opendir` and `fs.promises.lstat`, producing bit-for-bit identical digests.
 *
 * @param {string[]} [savePaths]
 * @returns {Promise<{ localMaxMtimeMs: number, localFilesDigest: string, fileCount: number }>}
 */
async function computeSavePathsStateSnapshotAsync(savePaths = []) {
  const pathsList = Array.isArray(savePaths)
    ? savePaths.map((p) => String(p || '').trim()).filter(Boolean)
    : [];
  /** @type {string[]} */
  const digestLines = [];
  let maxMtimeMs = 0;
  let fileCount = 0;

  /**
   * @param {string} rootDir
   * @param {string} currentDir
   * @param {number} depth
   */
  const walkAsync = async (rootDir, currentDir, depth) => {
    if (depth > 12) return;
    let dirHandle = null;
    try {
      dirHandle = await fs.promises.opendir(currentDir);
    } catch {
      return;
    }
    try {
      for await (const entry of dirHandle) {
        if (!entry || entry.isSymbolicLink() || OS_METADATA_JUNK_REGEX.test(entry.name)) continue;
        const fullPath = path.join(currentDir, entry.name);
        let st;
        try {
          st = await fs.promises.lstat(fullPath);
        } catch {
          continue;
        }
        if (st.isSymbolicLink()) continue;
        if (st.isDirectory()) {
          await walkAsync(rootDir, fullPath, depth + 1);
        } else if (st.isFile()) {
          const mtime = Math.trunc(st.mtimeMs || 0);
          if (mtime > maxMtimeMs) maxMtimeMs = mtime;
          const rel = path.relative(rootDir, fullPath).replace(/\\/g, '/');
          digestLines.push(`${rel}|${st.size}|${mtime}`);
          fileCount += 1;
        }
      }
    } catch {}
  };

  for (const rawPath of pathsList) {
    const hostPath = toHostFilesystemPath(rawPath);
    if (!hostPath) continue;
    let st;
    try {
      st = await fs.promises.lstat(hostPath);
    } catch {
      continue;
    }
    if (st.isSymbolicLink()) continue;
    if (st.isFile()) {
      const mtime = Math.trunc(st.mtimeMs || 0);
      if (mtime > maxMtimeMs) maxMtimeMs = mtime;
      digestLines.push(`${path.basename(hostPath)}|${st.size}|${mtime}`);
      fileCount += 1;
    } else if (st.isDirectory()) {
      await walkAsync(hostPath, hostPath, 0);
    }
  }

  digestLines.sort();
  const digest =
    digestLines.length > 0
      ? crypto.createHash('sha256').update(digestLines.join('\n')).digest('hex')
      : '';
  return {
    localMaxMtimeMs: maxMtimeMs,
    localFilesDigest: digest,
    fileCount,
  };
}

/**
 * Load durable interrupted post-exit cloud uploads synchronously from `pending_cloud_uploads.json`.
 *
 * @param {Record<string, any>} [options]
 * @returns {Array<Record<string, any>>}
 */
function loadPendingCloudUploads(options = {}) {
  const filePath = getPendingCloudUploadsFilePath(options);
  try {
    if (!fs.existsSync(filePath)) return [];
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    if (Array.isArray(parsed)) {
      return parsed.filter(
        (item) => item && typeof item === 'object' && item.gameId && item.platformId
      );
    }
  } catch (err) {
    diagLog.warn('cloudSave.loadPendingUploadsFailed', err, { filePath });
  }
  return [];
}

/**
 * Asynchronous counterpart to `loadPendingCloudUploads` using `fs.promises.readFile`.
 *
 * @param {Record<string, any>} [options]
 * @returns {Promise<Array<Record<string, any>>>}
 */
async function loadPendingCloudUploadsAsync(options = {}) {
  const filePath = getPendingCloudUploadsFilePath(options);
  try {
    const raw = await fs.promises.readFile(filePath, 'utf8');
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      return parsed.filter(
        (item) => item && typeof item === 'object' && item.gameId && item.platformId
      );
    }
  } catch (err) {
    if (String(/** @type {any} */ (err)?.code || '').toUpperCase() !== 'ENOENT') {
      diagLog.warn('cloudSave.loadPendingUploadsAsyncFailed', err, { filePath });
    }
  }
  return [];
}

/**
 * Atomically persist an interrupted or offline post-exit cloud upload into `pending_cloud_uploads.json`
 * with full async timestamp & digest provenance so replay never clobbers newer remote saves and never
 * blocks the Electron main thread.
 *
 * @param {Record<string, any>} record
 * @param {Record<string, any>} [options]
 * @returns {Promise<Array<Record<string, any>>>}
 */
async function enqueuePendingCloudUpload(record, options = {}) {
  if (!record || typeof record !== 'object') return loadPendingCloudUploadsAsync(options);
  const gameId = String(record.gameId || '').trim();
  const platformId = String(record.platformId || '').trim().toLowerCase();
  if (!gameId || !['gog', 'epic', 'xbox'].includes(platformId)) {
    return loadPendingCloudUploadsAsync(options);
  }
  const filePath = getPendingCloudUploadsFilePath(options);
  const savePaths = Array.from(
    new Set(
      (Array.isArray(record.savePaths) ? record.savePaths : [])
        .map((p) => String(p || '').trim())
        .filter(Boolean)
    )
  );
  const snap =
    record.localMaxMtimeMs !== undefined && record.localFilesDigest !== undefined
      ? {
          localMaxMtimeMs: Number(record.localMaxMtimeMs) || 0,
          localFilesDigest: String(record.localFilesDigest || ''),
        }
      : await computeSavePathsStateSnapshotAsync(savePaths);

  const normalizedEntry = {
    gameId,
    platformId,
    platformGameId: String(record.platformGameId || gameId),
    queuedAt: record.queuedAt || new Date().toISOString(),
    lastSyncedAt: Number(record.lastSyncedAt || 0) || 0,
    localMaxMtimeMs: snap.localMaxMtimeMs,
    localFilesDigest: snap.localFilesDigest,
    savePaths,
    ...(record.title ? { title: String(record.title) } : {}),
    ...(record.installPath ? { installPath: String(record.installPath) } : {}),
    ...(record.winePrefix ? { winePrefix: String(record.winePrefix) } : {}),
    ...(typeof record.useCompatLayer === 'boolean'
      ? { useCompatLayer: record.useCompatLayer }
      : {}),
    ...(record.packageFamilyName ? { packageFamilyName: String(record.packageFamilyName) } : {}),
    ...(record.scid ? { scid: String(record.scid) } : {}),
    ...(record.fallbackScid ? { fallbackScid: String(record.fallbackScid) } : {}),
    ...(record.msaAppId ? { msaAppId: String(record.msaAppId) } : {}),
    ...(record.xboxTitleId ? { xboxTitleId: String(record.xboxTitleId) } : {}),
    ...(record.xboxProductId ? { xboxProductId: String(record.xboxProductId) } : {}),
    ...(record.appUserModelId ? { appUserModelId: String(record.appUserModelId) } : {}),
    ...(record.gogClientId ? { gogClientId: String(record.gogClientId) } : {}),
    ...(record.appName ? { appName: String(record.appName) } : {}),
  };

  return await withCloudManifestFileLock(filePath, async () => {
    let queue = await loadPendingCloudUploadsAsync(options);
    const idx = queue.findIndex(
      (item) => item.gameId === gameId && String(item.platformId).toLowerCase() === platformId
    );
    if (idx >= 0) {
      queue[idx] = {
        ...queue[idx],
        ...normalizedEntry,
        savePaths:
          normalizedEntry.savePaths.length > 0
            ? normalizedEntry.savePaths
            : queue[idx].savePaths || [],
      };
    } else {
      queue.push(normalizedEntry);
      if (queue.length > MAX_PENDING_CLOUD_UPLOADS) {
        queue = queue.slice(-MAX_PENDING_CLOUD_UPLOADS);
      }
    }
    await atomicWriteFileAsync(filePath, JSON.stringify(queue, null, 2));
    return queue;
  });
}

/**
 * Remove a resolved entry from `pending_cloud_uploads.json` asynchronously.
 *
 * @param {string} gameId
 * @param {string} platformId
 * @param {Record<string, any>} [options]
 * @returns {Promise<Array<Record<string, any>>>}
 */
async function removePendingCloudUpload(gameId, platformId, options = {}) {
  const cleanGameId = String(gameId || '').trim();
  const cleanPlatform = String(platformId || '').trim().toLowerCase();
  const filePath = getPendingCloudUploadsFilePath(options);
  return await withCloudManifestFileLock(filePath, async () => {
    const queue = await loadPendingCloudUploadsAsync(options);
    const next = queue.filter(
      (item) =>
        !(item.gameId === cleanGameId && String(item.platformId).toLowerCase() === cleanPlatform)
    );
    if (next.length !== queue.length) {
      await atomicWriteFileAsync(filePath, JSON.stringify(next, null, 2));
    }
    return next;
  });
}

/**
 * Factory creating conflict-safe replay operations wired to facade-injected backup & Xbox sync handlers.
 *
 * @param {{
 *   resolveDefaultPerSnapshotMaxBackupBytes: (options?: Record<string, any>) => number,
 *   createCloudSaveRollingBackupAsync: (...args: any[]) => Promise<any>,
 *   syncXboxCloudSaves: (...args: any[]) => Promise<any>,
 * }} deps
 */
function createPendingUploadReplayQueue(deps) {
  const {
    resolveDefaultPerSnapshotMaxBackupBytes,
    createCloudSaveRollingBackupAsync,
    syncXboxCloudSaves,
  } = deps;

  /**
   * Conflict-safe replay of a single queued pending cloud upload, serialized per game
   * via `withPerGameCloudSyncLock` so replay never overlaps active pre-launch / post-exit syncs:
   * 1. Fast-skips when offline (retaining queue entry).
   * 2. Snapshots a rolling local backup of every `savePaths` directory FIRST.
   * 3. Replays strictly in conflict-aware / bidirectional timestamp mode (NEVER `--force-upload`),
   *    comparing remote timestamps against `lastSyncedAt` so newer remote progress from another device
   *    is NEVER silently overwritten.
   *
   * @param {Record<string, any>} entry
   * @param {Record<string, any>} [runnerOrHandlers]
   * @param {Record<string, any>} [options]
   * @returns {Promise<Record<string, any>>}
   */
  async function replayPendingCloudUpload(entry, runnerOrHandlers = {}, options = {}) {
    if (!entry || typeof entry !== 'object' || !entry.gameId || !entry.platformId) {
      return { replayed: false, synced: false, reason: 'invalid_entry' };
    }
    if (!isNetworkOnlineForLaunch(options)) {
      return {
        replayed: false,
        synced: false,
        offlineSkipped: true,
        reason: 'offline_skipped',
        gameId: entry.gameId,
        platformId: entry.platformId,
      };
    }

    const platformId = String(entry.platformId).toLowerCase();
    const rawLockId =
      platformId === 'epic'
        ? String(entry.appName || entry.platformGameId || entry.gameId || '').trim()
        : String(entry.platformGameId || entry.gameId || '').trim();
    const lockKey = buildPerGameCloudSyncLockKey(platformId, rawLockId);

    const runReplay = async () => {
      const userDataDir = getUserDataDir(options.userDataDir);
      const safeId = String(entry.gameId).replace(/[^A-Za-z0-9._-]/g, '_');
      const backupQuotaOpts = {
        maxTotalBackupBytes: options.maxTotalBackupBytes,
        maxSnapshotsPerGame: options.maxSnapshotsPerGame,
        userDataDir,
        backupsRootDir: options.backupsRootDir,
        platform: options.platform || process.platform,
      };
      const maxBackupBytes =
        Number(options.maxBackupBytes) > 0
          ? Number(options.maxBackupBytes)
          : resolveDefaultPerSnapshotMaxBackupBytes(options);

      // Step 1: Mandatory rolling local backup BEFORE any bidirectional cloud sync
      /** @type {string[]} */
      const backupPaths = [];
      const savePaths = Array.isArray(entry.savePaths) ? entry.savePaths : [];
      for (let i = 0; i < savePaths.length; i += 1) {
        const hostPath = toHostFilesystemPath(savePaths[i]);
        if (!hostPath || !(await pathExistsAsync(hostPath))) continue;
        const backupRoot = path.join(
          userDataDir,
          'cloud_save_backups',
          platformId,
          safeId,
          `pending_replay_${i}`
        );
        try {
          const bRes = await createCloudSaveRollingBackupAsync(
            hostPath,
            backupRoot,
            maxBackupBytes,
            backupQuotaOpts
          );
          if (bRes?.backupPath) {
            backupPaths.push(bRes.backupPath);
          }
        } catch (backupErr) {
          diagLog.warn('cloudSave.pendingReplayBackupFailed', backupErr, {
            gameId: entry.gameId,
            platformId,
            hostPath,
          });
        }
      }

      const payload = {
        gameId: entry.gameId,
        platformId,
        platformGameId: entry.platformGameId || entry.gameId,
        title: entry.title || entry.gameId,
        installPath: entry.installPath || options.installPath,
        useCompatLayer: Boolean(entry.useCompatLayer ?? options.useCompatLayer),
        winePrefix: entry.winePrefix || options.winePrefix,
        ...(entry.gogClientId ? { gogClientId: entry.gogClientId } : {}),
        ...(entry.appName ? { appName: entry.appName } : {}),
        ...(entry.packageFamilyName ? { packageFamilyName: entry.packageFamilyName } : {}),
        ...(entry.scid ? { scid: entry.scid } : {}),
        ...(entry.fallbackScid ? { fallbackScid: entry.fallbackScid } : {}),
        ...(entry.msaAppId ? { msaAppId: entry.msaAppId } : {}),
        ...(entry.xboxTitleId ? { xboxTitleId: entry.xboxTitleId } : {}),
        ...(entry.xboxProductId ? { xboxProductId: entry.xboxProductId } : {}),
        ...(entry.appUserModelId ? { appUserModelId: entry.appUserModelId } : {}),
      };

      /** @type {any} */
      let syncRes = { synced: false, reason: 'unsupported_platform' };
      const replayOpts = {
        ...options,
        userDataDir,
        useCompatLayer: payload.useCompatLayer,
        winePrefix: payload.winePrefix,
        installPath: payload.installPath,
        ...(lockKey ? { _cloudSyncLockHeldKey: lockKey } : {}),
        ...(Number(entry.lastSyncedAt) > 0
          ? {
              pendingUploadLastSyncedAt: Number(entry.lastSyncedAt),
              fallbackLastSyncTsSec: Math.floor(Number(entry.lastSyncedAt) / 1000),
            }
          : {}),
      };

      if (platformId === 'gog' && typeof runnerOrHandlers.syncGogCloudSaves === 'function') {
        // Strictly bidirectional (`mode = 'both'`) — NEVER `--force-upload`!
        syncRes = await runnerOrHandlers.syncGogCloudSaves(payload, 'both', replayOpts);
      } else if (
        platformId === 'epic' &&
        typeof runnerOrHandlers.syncEpicCloudSaves === 'function'
      ) {
        // Strictly bidirectional (`mode = 'both'`) — NEVER `--force-upload`!
        syncRes = await runnerOrHandlers.syncEpicCloudSaves(payload, 'both', replayOpts);
      } else if (platformId === 'xbox') {
        const xboxSyncHandler =
          typeof runnerOrHandlers.syncXboxCloudSaves === 'function'
            ? runnerOrHandlers.syncXboxCloudSaves
            : syncXboxCloudSaves;
        // `pre_launch` mode performs bidirectional timestamp comparison (pulling newer remote before uploading dirty local)
        syncRes = await xboxSyncHandler(payload, 'pre_launch', replayOpts);
      }

      const conflictInReason = /conflict/i.test(String(syncRes?.reason || ''));
      const conflict = Boolean(syncRes?.conflictDetected || conflictInReason);

      if (syncRes?.synced) {
        await removePendingCloudUpload(entry.gameId, platformId, options);
        return {
          replayed: true,
          synced: true,
          conflict,
          backupPaths,
          gameId: entry.gameId,
          platformId,
          syncRes,
        };
      }

      return {
        replayed: false,
        synced: false,
        conflict,
        backupPaths,
        gameId: entry.gameId,
        platformId,
        reason: syncRes?.reason || 'replay_failed',
        syncRes,
      };
    };

    if (!lockKey || options._cloudSyncLockHeldKey === lockKey) {
      return runReplay();
    }
    return withPerGameCloudSyncLock(lockKey, runReplay);
  }

  /**
   * Replay all (or filtered) queued entries from `pending_cloud_uploads.json` in conflict-safe mode.
   *
   * @param {Record<string, any>} [runnerOrHandlers]
   * @param {Record<string, any>} [options]
   * @returns {Promise<{ attempted: number, replayed: number, conflicts: number, offlineSkipped?: boolean, results: Array<Record<string, any>> }>}
   */
  async function replayPendingCloudUploads(runnerOrHandlers = {}, options = {}) {
    if (!isNetworkOnlineForLaunch(options)) {
      return { attempted: 0, replayed: 0, conflicts: 0, offlineSkipped: true, results: [] };
    }
    const allQueued = await loadPendingCloudUploadsAsync(options);
    const filtered = allQueued.filter((entry) => {
      if (options.gameId && entry.gameId !== String(options.gameId)) return false;
      if (
        options.platformId &&
        String(entry.platformId).toLowerCase() !== String(options.platformId).toLowerCase()
      ) {
        return false;
      }
      return true;
    });

    /** @type {Array<Record<string, any>>} */
    const results = [];
    let replayed = 0;
    let conflicts = 0;
    for (const entry of filtered) {
      const res = await replayPendingCloudUpload(entry, runnerOrHandlers, options);
      results.push(res);
      if (res.replayed) replayed += 1;
      if (res.conflict) conflicts += 1;
    }
    return {
      attempted: filtered.length,
      replayed,
      conflicts,
      results,
    };
  }

  return {
    replayPendingCloudUpload,
    replayPendingCloudUploads,
  };
}

module.exports = {
  PENDING_CLOUD_UPLOADS_FILENAME,
  MAX_PENDING_CLOUD_UPLOADS,
  getPendingCloudUploadsFilePath,
  computeSavePathsStateSnapshot,
  computeSavePathsStateSnapshotAsync,
  loadPendingCloudUploads,
  loadPendingCloudUploadsAsync,
  enqueuePendingCloudUpload,
  removePendingCloudUpload,
  createPendingUploadReplayQueue,
};
