// @ts-check
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { diagLog } = require('../../utils/diagnosticLogger.cjs');
const {
  copyRealDirBoundedSync,
  copyRealDirBoundedAsync,
} = require('../boundedCopyUtils.cjs');
const { isContainedWithinRoot } = require('../securityAndPathUtils.cjs');
const { safeRemoveGameDirectoryAsync } = require('../uninstallSafety.cjs');
const {
  PROTECTED_PLATFORM_BUCKET_DIRS,
  resolveIsolatedDefaultHomedir,
  isWindowsKnownFolderRootPath,
  isBroadOneDriveKnownFolderRoot,
  inspectOneDrivePlaceholderStateAsync: defaultInspectOneDrivePlaceholderStateAsync,
} = require('./oneDriveAndPathGuards.cjs');

const DEFAULT_DARWIN_CLOUD_SAVE_MAX_BACKUP_BYTES = 1024 * 1024 * 1024;
const DEFAULT_WIN32_CLOUD_SAVE_MAX_BACKUP_BYTES = 256 * 1024 * 1024;
const DEFAULT_GLOBAL_CLOUD_SAVE_BACKUP_QUOTA_BYTES = 1024 * 1024 * 1024; // 1.0 GB global cap
const MIN_RETAINED_BACKUPS_PER_GAME = 2;

/**
 * @param {any} err
 * @returns {boolean}
 */
function isMissingErr(err) {
  const code = String(err?.code || '').toUpperCase();
  return code === 'ENOENT' || code === 'ENOTDIR';
}

/**
 * Returns true if `targetDir` equals `backupsRoot` itself or is one of the protected top-level
 * platform bucket directories (`gog`, `epic`, `xbox`, `steam`) directly inside `backupsRoot`.
 *
 * @param {string} targetDir
 * @param {string} backupsRoot
 * @returns {boolean}
 */
function isProtectedBackupRootOrPlatformBucket(targetDir, backupsRoot) {
  if (!targetDir || !backupsRoot) return true;
  const resolvedTarget = path.resolve(targetDir);
  const resolvedRoot = path.resolve(backupsRoot);
  const cmpTarget = process.platform === 'win32' ? resolvedTarget.toLowerCase() : resolvedTarget;
  const cmpRoot = process.platform === 'win32' ? resolvedRoot.toLowerCase() : resolvedRoot;
  if (cmpTarget === cmpRoot) return true;

  const parentDir = path.dirname(resolvedTarget);
  const cmpParent = process.platform === 'win32' ? parentDir.toLowerCase() : parentDir;
  if (cmpParent === cmpRoot) {
    const leaf = path.basename(resolvedTarget).toLowerCase();
    if (PROTECTED_PLATFORM_BUCKET_DIRS.has(leaf)) {
      return true;
    }
  }
  return false;
}

/**
 * Unlink a file, symlink, or Windows NTFS junction synchronously without recursing into targets.
 *
 * @param {string} entryPath
 * @param {boolean} isLink
 */
function unlinkEntryNoFollowSync(entryPath, isLink) {
  try {
    fs.unlinkSync(entryPath);
    return;
  } catch (err) {
    if (isMissingErr(err)) return;
    const code = String(/** @type {any} */ (err)?.code || '').toUpperCase();
    if (isLink && (code === 'EPERM' || code === 'EISDIR' || code === 'EACCES')) {
      try {
        fs.rmdirSync(entryPath);
        return;
      } catch (rmErr) {
        if (isMissingErr(rmErr)) return;
        throw rmErr;
      }
    }
    if (!isLink && (code === 'EPERM' || code === 'EACCES')) {
      try {
        fs.chmodSync(entryPath, 0o666);
        fs.unlinkSync(entryPath);
        return;
      } catch (retryErr) {
        if (isMissingErr(retryErr)) return;
        throw retryErr;
      }
    }
    throw err;
  }
}

/**
 * Remove an empty directory synchronously with read-only chmod fallback.
 *
 * @param {string} dirPath
 */
function removeEmptyDirSync(dirPath) {
  try {
    fs.rmdirSync(dirPath);
    return;
  } catch (err) {
    if (isMissingErr(err)) return;
    const code = String(/** @type {any} */ (err)?.code || '').toUpperCase();
    if (code === 'EPERM' || code === 'EACCES') {
      try {
        fs.chmodSync(dirPath, 0o777);
        fs.rmdirSync(dirPath);
        return;
      } catch (retryErr) {
        if (isMissingErr(retryErr)) return;
        throw retryErr;
      }
    }
    throw err;
  }
}

/**
 * Symlink- and junction-safe bottom-up synchronous remover scoped strictly inside `containmentRoot`,
 * refusing to remove `containmentRoot` itself or any top-level platform bucket (`gog`/`epic`/`xbox`/`steam`).
 *
 * @param {string} targetDir
 * @param {string} containmentRoot
 * @returns {boolean}
 */
function safeRemoveBackupDirSync(targetDir, containmentRoot) {
  if (!targetDir || !containmentRoot) return false;
  const resolvedTarget = path.resolve(targetDir);
  const resolvedRoot = path.resolve(containmentRoot);

  if (
    !isContainedWithinRoot(resolvedRoot, resolvedTarget) ||
    isProtectedBackupRootOrPlatformBucket(resolvedTarget, resolvedRoot)
  ) {
    return false;
  }

  let rootStat;
  try {
    rootStat = fs.lstatSync(resolvedTarget);
  } catch (err) {
    if (isMissingErr(err)) return false;
    throw err;
  }

  if (rootStat.isSymbolicLink()) {
    return false;
  }

  let realContainmentRoot = '';
  let realTarget = '';
  try {
    realContainmentRoot = fs.realpathSync(resolvedRoot);
    realTarget = fs.realpathSync(resolvedTarget);
  } catch {
    return false;
  }

  if (
    !isContainedWithinRoot(realContainmentRoot, realTarget) ||
    isProtectedBackupRootOrPlatformBucket(realTarget, realContainmentRoot)
  ) {
    return false;
  }

  if (!rootStat.isDirectory()) {
    unlinkEntryNoFollowSync(resolvedTarget, false);
    return true;
  }

  /** @type {Array<{ dirPath: string, visited: boolean, expectedDev: number | bigint, expectedIno: number | bigint }>} */
  const stack = [
    {
      dirPath: resolvedTarget,
      visited: false,
      expectedDev: rootStat.dev,
      expectedIno: rootStat.ino,
    },
  ];

  while (stack.length > 0) {
    const cur = stack[stack.length - 1];
    if (!cur.visited) {
      cur.visited = true;
      let preStat;
      try {
        preStat = fs.lstatSync(cur.dirPath);
      } catch (err) {
        if (isMissingErr(err)) {
          stack.pop();
          continue;
        }
        throw err;
      }

      if (preStat.isSymbolicLink()) {
        if (cur.dirPath === resolvedTarget) return false;
        unlinkEntryNoFollowSync(cur.dirPath, true);
        stack.pop();
        continue;
      }

      if (!preStat.isDirectory()) {
        unlinkEntryNoFollowSync(cur.dirPath, false);
        stack.pop();
        continue;
      }

      if (preStat.dev !== cur.expectedDev || preStat.ino !== cur.expectedIno) {
        return false;
      }

      let realCur = '';
      try {
        realCur = fs.realpathSync(cur.dirPath);
      } catch (realErr) {
        if (isMissingErr(realErr)) {
          stack.pop();
          continue;
        }
        throw realErr;
      }
      if (!isContainedWithinRoot(realTarget, realCur)) {
        return false;
      }

      let names;
      try {
        names = fs.readdirSync(cur.dirPath);
      } catch (readErr) {
        if (isMissingErr(readErr)) {
          stack.pop();
          continue;
        }
        throw readErr;
      }

      for (const name of names) {
        if (!name || name === '.' || name === '..') continue;
        const full = path.join(cur.dirPath, name);
        let childStat;
        try {
          childStat = fs.lstatSync(full);
        } catch (stErr) {
          if (isMissingErr(stErr)) continue;
          throw stErr;
        }
        if (childStat.isSymbolicLink()) {
          unlinkEntryNoFollowSync(full, true);
        } else if (childStat.isDirectory()) {
          stack.push({
            dirPath: full,
            visited: false,
            expectedDev: childStat.dev,
            expectedIno: childStat.ino,
          });
        } else {
          unlinkEntryNoFollowSync(full, false);
        }
      }
    } else {
      stack.pop();
      removeEmptyDirSync(cur.dirPath);
    }
  }

  return true;
}

/**
 * Symlink- and junction-safe asynchronous backup remover routing through
 * `uninstallSafety.safeRemoveGameDirectoryAsync` after verifying strict `lstat` + `realpath`
 * containment inside `containmentRoot` and protecting top-level platform bucket dirs.
 *
 * @param {string} targetDir
 * @param {string} containmentRoot
 * @returns {Promise<boolean>}
 */
async function safeRemoveBackupDirAsync(targetDir, containmentRoot) {
  if (!targetDir || !containmentRoot) return false;
  const resolvedTarget = path.resolve(targetDir);
  const resolvedRoot = path.resolve(containmentRoot);

  if (
    !isContainedWithinRoot(resolvedRoot, resolvedTarget) ||
    isProtectedBackupRootOrPlatformBucket(resolvedTarget, resolvedRoot)
  ) {
    return false;
  }

  let rootStat;
  try {
    rootStat = await fs.promises.lstat(resolvedTarget);
  } catch (err) {
    if (isMissingErr(err)) return false;
    throw err;
  }

  if (rootStat.isSymbolicLink()) {
    return false;
  }

  let realContainmentRoot = '';
  let realTarget = '';
  try {
    realContainmentRoot = await fs.promises.realpath(resolvedRoot);
    realTarget = await fs.promises.realpath(resolvedTarget);
  } catch {
    return false;
  }

  if (
    !isContainedWithinRoot(realContainmentRoot, realTarget) ||
    isProtectedBackupRootOrPlatformBucket(realTarget, realContainmentRoot)
  ) {
    return false;
  }

  return safeRemoveGameDirectoryAsync(resolvedTarget, { skipSafetyAssertion: true });
}

/**
 * @param {string} backupBaseOrUserDataDir
 * @param {Record<string, any>} [quotaOptions]
 * @returns {string}
 */
function resolveCloudSaveBackupsRootDir(backupBaseOrUserDataDir, quotaOptions = {}) {
  if (typeof quotaOptions?.backupsRootDir === 'string' && quotaOptions.backupsRootDir.trim()) {
    return path.resolve(quotaOptions.backupsRootDir.trim());
  }
  if (typeof quotaOptions?.userDataDir === 'string' && quotaOptions.userDataDir.trim()) {
    return path.join(path.resolve(quotaOptions.userDataDir.trim()), 'cloud_save_backups');
  }
  if (!backupBaseOrUserDataDir || typeof backupBaseOrUserDataDir !== 'string') {
    return '';
  }
  let curr = path.resolve(backupBaseOrUserDataDir);
  while (curr) {
    if (path.basename(curr).toLowerCase() === 'cloud_save_backups') {
      return curr;
    }
    const parent = path.dirname(curr);
    if (!parent || parent === curr) break;
    curr = parent;
  }
  const directCandidate = path.join(path.resolve(backupBaseOrUserDataDir), 'cloud_save_backups');
  if (fs.existsSync(directCandidate)) {
    return directCandidate;
  }
  return '';
}

/**
 * @param {string} dirPath
 * @returns {{ bytes: number, mtimeMs: number }}
 */
function computeRealDirStatsSync(dirPath) {
  let bytes = 0;
  let maxMtimeMs = 0;
  try {
    const rootSt = fs.lstatSync(dirPath);
    if (rootSt.isSymbolicLink() || !rootSt.isDirectory()) {
      return { bytes: 0, mtimeMs: 0 };
    }
    maxMtimeMs = Number(rootSt.mtimeMs || 0);
    const stack = [dirPath];
    while (stack.length > 0) {
      const cur = stack.pop();
      if (!cur) continue;
      let entries;
      try {
        entries = fs.readdirSync(cur, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const ent of entries) {
        const full = path.join(cur, ent.name);
        let st;
        try {
          st = fs.lstatSync(full);
        } catch {
          continue;
        }
        if (st.isSymbolicLink()) continue;
        if (st.mtimeMs > maxMtimeMs) maxMtimeMs = st.mtimeMs;
        if (st.isDirectory()) {
          stack.push(full);
        } else if (st.isFile()) {
          bytes += Number(st.size || 0);
        }
      }
    }
  } catch {}
  return { bytes, mtimeMs: maxMtimeMs };
}

/**
 * @param {string} backupsRootDir
 * @returns {Array<{ snapshotPath: string, snapshotName: string, seriesKey: string, bytes: number, mtimeMs: number }>}
 */
function collectCloudSaveSnapshotEntriesSync(backupsRootDir) {
  /** @type {Array<{ snapshotPath: string, snapshotName: string, seriesKey: string, bytes: number, mtimeMs: number }>} */
  const allSnapshots = [];
  if (!backupsRootDir || !fs.existsSync(backupsRootDir)) return allSnapshots;

  /**
   * @param {string} dir
   * @param {string[]} relSegments
   * @param {number} depth
   */
  const walk = (dir, relSegments, depth) => {
    if (depth > 4) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      if (!ent.isDirectory()) continue;
      const fullPath = path.join(dir, ent.name);
      try {
        const st = fs.lstatSync(fullPath);
        if (st.isSymbolicLink()) continue;
        if (ent.name.startsWith('snapshot_')) {
          const stats = computeRealDirStatsSync(fullPath);
          const gameScopeSegs =
            relSegments.length >= 2 ? relSegments.slice(0, 2) : relSegments.slice();
          const seriesKey = gameScopeSegs.join('/') || dir;
          allSnapshots.push({
            snapshotPath: fullPath,
            snapshotName: ent.name,
            seriesKey,
            bytes: stats.bytes,
            mtimeMs: stats.mtimeMs || Number(st.mtimeMs || 0),
          });
        } else {
          walk(fullPath, [...relSegments, ent.name], depth + 1);
        }
      } catch {}
    }
  };

  walk(backupsRootDir, [], 0);
  return allSnapshots;
}

/**
 * @param {string} dirPath
 * @returns {Promise<{ bytes: number, mtimeMs: number }>}
 */
async function computeRealDirStatsAsync(dirPath) {
  let bytes = 0;
  let maxMtimeMs = 0;
  try {
    const rootSt = await fs.promises.lstat(dirPath);
    if (rootSt.isSymbolicLink() || !rootSt.isDirectory()) {
      return { bytes: 0, mtimeMs: 0 };
    }
    maxMtimeMs = Number(rootSt.mtimeMs || 0);
    const stack = [dirPath];
    while (stack.length > 0) {
      const cur = stack.pop();
      if (!cur) continue;
      let dirHandle = null;
      try {
        dirHandle = await fs.promises.opendir(cur);
      } catch {
        continue;
      }
      try {
        for await (const ent of dirHandle) {
          const full = path.join(cur, ent.name);
          let st;
          try {
            st = await fs.promises.lstat(full);
          } catch {
            continue;
          }
          if (st.isSymbolicLink()) continue;
          if (st.mtimeMs > maxMtimeMs) maxMtimeMs = st.mtimeMs;
          if (st.isDirectory()) {
            stack.push(full);
          } else if (st.isFile()) {
            bytes += Number(st.size || 0);
          }
        }
      } catch {}
    }
  } catch {}
  return { bytes, mtimeMs: maxMtimeMs };
}

/**
 * @param {string} backupsRootDir
 * @returns {Promise<Array<{ snapshotPath: string, snapshotName: string, seriesKey: string, bytes: number, mtimeMs: number }>>}
 */
async function collectCloudSaveSnapshotEntriesAsync(backupsRootDir) {
  /** @type {Array<{ snapshotPath: string, snapshotName: string, seriesKey: string, bytes: number, mtimeMs: number }>} */
  const allSnapshots = [];
  if (!backupsRootDir) return allSnapshots;
  try {
    await fs.promises.access(backupsRootDir);
  } catch {
    return allSnapshots;
  }

  /**
   * @param {string} dir
   * @param {string[]} relSegments
   * @param {number} depth
   */
  const walk = async (dir, relSegments, depth) => {
    if (depth > 4) return;
    let dirHandle = null;
    try {
      dirHandle = await fs.promises.opendir(dir);
    } catch {
      return;
    }
    try {
      for await (const ent of dirHandle) {
        if (!ent.isDirectory()) continue;
        const fullPath = path.join(dir, ent.name);
        try {
          const st = await fs.promises.lstat(fullPath);
          if (st.isSymbolicLink()) continue;
          if (ent.name.startsWith('snapshot_')) {
            const stats = await computeRealDirStatsAsync(fullPath);
            const gameScopeSegs =
              relSegments.length >= 2 ? relSegments.slice(0, 2) : relSegments.slice();
            const seriesKey = gameScopeSegs.join('/') || dir;
            allSnapshots.push({
              snapshotPath: fullPath,
              snapshotName: ent.name,
              seriesKey,
              bytes: stats.bytes,
              mtimeMs: stats.mtimeMs || Number(st.mtimeMs || 0),
            });
          } else {
            await walk(fullPath, [...relSegments, ent.name], depth + 1);
          }
        } catch {}
      }
    } catch {}
  };

  await walk(backupsRootDir, [], 0);
  return allSnapshots;
}

/**
 * Factory creating backup creation, rolling quota enforcement, and safe game backup cleanup
 * bound to the facade's load-time `resolveDefaultPerSnapshotMaxBackupBytes` and spyable helpers.
 *
 * @param {{
 *   resolveDefaultPerSnapshotMaxBackupBytes: (options?: Record<string, any>) => number,
 *   inspectOneDrivePlaceholderStateAsync?: typeof defaultInspectOneDrivePlaceholderStateAsync,
 * }} deps
 */
function createBackupAndQuotaManager(deps) {
  const resolveDefaultPerSnapshotMaxBackupBytes = deps.resolveDefaultPerSnapshotMaxBackupBytes;
  const inspectOneDrive =
    typeof deps.inspectOneDrivePlaceholderStateAsync === 'function'
      ? deps.inspectOneDrivePlaceholderStateAsync
      : defaultInspectOneDrivePlaceholderStateAsync;

  /**
   * Enforces the global `1.0 GB` rolling backup quota (`maxTotalBackupBytes = 1024 * 1024 * 1024`)
   * across `cloud_save_backups`, evicting oldest backup archives by `mtime` across games while
   * ALWAYS retaining at least the `2` newest backups per game so no game ever loses rollback safety.
   *
   * @param {string} backupsRootOrUserDataDir
   * @param {Record<string, any>} [options]
   */
  function enforceCloudSaveBackupQuotaSync(backupsRootOrUserDataDir, options = {}) {
    const backupsRoot =
      resolveCloudSaveBackupsRootDir(backupsRootOrUserDataDir, options) ||
      (typeof backupsRootOrUserDataDir === 'string' && fs.existsSync(backupsRootOrUserDataDir)
        ? path.resolve(backupsRootOrUserDataDir)
        : '');
    if (!backupsRoot || !fs.existsSync(backupsRoot)) {
      return { evictedCount: 0, freedBytes: 0, totalBytes: 0 };
    }

    const maxTotalBackupBytes =
      typeof options.maxTotalBackupBytes === 'number' && options.maxTotalBackupBytes > 0
        ? options.maxTotalBackupBytes
        : typeof options.maxQuotaBytes === 'number' && options.maxQuotaBytes > 0
          ? options.maxQuotaBytes
          : DEFAULT_GLOBAL_CLOUD_SAVE_BACKUP_QUOTA_BYTES;
    const minRetainedPerGame =
      typeof options.minRetainedPerGame === 'number' && options.minRetainedPerGame >= 0
        ? Math.floor(options.minRetainedPerGame)
        : MIN_RETAINED_BACKUPS_PER_GAME;

    const snapshots = collectCloudSaveSnapshotEntriesSync(backupsRoot);
    let totalBytes = snapshots.reduce((acc, s) => acc + s.bytes, 0);
    if (totalBytes <= maxTotalBackupBytes) {
      return { evictedCount: 0, freedBytes: 0, totalBytes };
    }

    /** @type {Map<string, typeof snapshots>} */
    const byGame = new Map();
    for (const s of snapshots) {
      let list = byGame.get(s.seriesKey);
      if (!list) {
        list = [];
        byGame.set(s.seriesKey, list);
      }
      list.push(s);
    }

    /** @type {Set<string>} */
    const protectedPaths = new Set();
    for (const list of byGame.values()) {
      list.sort((a, b) => {
        const diff = b.mtimeMs - a.mtimeMs;
        if (Math.abs(diff) > 0.5) return diff;
        return b.snapshotName.localeCompare(a.snapshotName);
      });
      for (let i = 0; i < Math.min(minRetainedPerGame, list.length); i++) {
        protectedPaths.add(list[i].snapshotPath);
      }
    }

    const evictable = snapshots
      .filter((s) => !protectedPaths.has(s.snapshotPath))
      .sort((a, b) => {
        const diff = a.mtimeMs - b.mtimeMs;
        if (Math.abs(diff) > 0.5) return diff;
        return a.snapshotName.localeCompare(b.snapshotName);
      });

    let evictedCount = 0;
    let freedBytes = 0;
    for (const cand of evictable) {
      if (totalBytes <= maxTotalBackupBytes) break;
      if (!isContainedWithinRoot(backupsRoot, cand.snapshotPath)) continue;
      try {
        if (safeRemoveBackupDirSync(cand.snapshotPath, backupsRoot)) {
          totalBytes = Math.max(0, totalBytes - cand.bytes);
          freedBytes += cand.bytes;
          evictedCount++;
        }
      } catch (rmErr) {
        diagLog.warn('cloudSave.evictGlobalQuotaSync', rmErr, { snapshotPath: cand.snapshotPath });
      }
    }

    return { evictedCount, freedBytes, totalBytes };
  }

  /**
   * Asynchronous counterpart to `enforceCloudSaveBackupQuotaSync` routing directory deletions
   * through symlink-safe `uninstallSafety.safeRemoveGameDirectoryAsync`.
   *
   * @param {string} backupsRootOrUserDataDir
   * @param {Record<string, any>} [options]
   */
  async function enforceCloudSaveBackupQuotaAsync(backupsRootOrUserDataDir, options = {}) {
    let backupsRoot = resolveCloudSaveBackupsRootDir(backupsRootOrUserDataDir, options);
    if (!backupsRoot && typeof backupsRootOrUserDataDir === 'string' && backupsRootOrUserDataDir) {
      backupsRoot = path.resolve(backupsRootOrUserDataDir);
    }
    if (!backupsRoot) {
      return { evictedCount: 0, freedBytes: 0, totalBytes: 0 };
    }
    try {
      await fs.promises.access(backupsRoot);
    } catch {
      return { evictedCount: 0, freedBytes: 0, totalBytes: 0 };
    }

    const maxTotalBackupBytes =
      typeof options.maxTotalBackupBytes === 'number' && options.maxTotalBackupBytes > 0
        ? options.maxTotalBackupBytes
        : typeof options.maxQuotaBytes === 'number' && options.maxQuotaBytes > 0
          ? options.maxQuotaBytes
          : DEFAULT_GLOBAL_CLOUD_SAVE_BACKUP_QUOTA_BYTES;
    const minRetainedPerGame =
      typeof options.minRetainedPerGame === 'number' && options.minRetainedPerGame >= 0
        ? Math.floor(options.minRetainedPerGame)
        : MIN_RETAINED_BACKUPS_PER_GAME;

    const snapshots = await collectCloudSaveSnapshotEntriesAsync(backupsRoot);
    let totalBytes = snapshots.reduce((acc, s) => acc + s.bytes, 0);
    if (totalBytes <= maxTotalBackupBytes) {
      return { evictedCount: 0, freedBytes: 0, totalBytes };
    }

    /** @type {Map<string, typeof snapshots>} */
    const byGame = new Map();
    for (const s of snapshots) {
      let list = byGame.get(s.seriesKey);
      if (!list) {
        list = [];
        byGame.set(s.seriesKey, list);
      }
      list.push(s);
    }

    /** @type {Set<string>} */
    const protectedPaths = new Set();
    for (const list of byGame.values()) {
      list.sort((a, b) => {
        const diff = b.mtimeMs - a.mtimeMs;
        if (Math.abs(diff) > 0.5) return diff;
        return b.snapshotName.localeCompare(a.snapshotName);
      });
      for (let i = 0; i < Math.min(minRetainedPerGame, list.length); i++) {
        protectedPaths.add(list[i].snapshotPath);
      }
    }

    const evictable = snapshots
      .filter((s) => !protectedPaths.has(s.snapshotPath))
      .sort((a, b) => {
        const diff = a.mtimeMs - b.mtimeMs;
        if (Math.abs(diff) > 0.5) return diff;
        return a.snapshotName.localeCompare(b.snapshotName);
      });

    let evictedCount = 0;
    let freedBytes = 0;
    for (const cand of evictable) {
      if (totalBytes <= maxTotalBackupBytes) break;
      if (!isContainedWithinRoot(backupsRoot, cand.snapshotPath)) continue;
      try {
        if (await safeRemoveBackupDirAsync(cand.snapshotPath, backupsRoot)) {
          totalBytes = Math.max(0, totalBytes - cand.bytes);
          freedBytes += cand.bytes;
          evictedCount++;
        }
      } catch (rmErr) {
        diagLog.warn('cloudSave.evictGlobalQuotaAsync', rmErr, { snapshotPath: cand.snapshotPath });
      }
    }

    return { evictedCount, freedBytes, totalBytes };
  }

  /**
   * Optional uninstall / maintenance cleanup for a specific game's rolling backups under `cloud_save_backups`.
   * Protects top-level platform bucket directories (`gog`/`epic`/`xbox`/`steam`) from wildcard matching
   * and uses symlink/junction-safe removal.
   *
   * @param {string | Record<string, any>} gameIdOrPayload
   * @param {{ keepLatest?: number, userDataDir?: string, backupsRootDir?: string, homedir?: string, platformId?: string }} [options]
   */
  function cleanupGameBackups(gameIdOrPayload, options = {}) {
    const payloadObj =
      gameIdOrPayload && typeof gameIdOrPayload === 'object'
        ? gameIdOrPayload
        : { gameId: String(gameIdOrPayload || '') };
    const rawInputId = String(payloadObj.platformGameId || payloadObj.gameId || '').trim();
    if (!rawInputId) {
      return {
        cleaned: false,
        removedBackups: 0,
        retainedBackups: 0,
        remainingCount: 0,
        freedBytes: 0,
      };
    }

    const keepLatest =
      typeof options?.keepLatest === 'number' && options.keepLatest >= 0
        ? Math.floor(options.keepLatest)
        : typeof payloadObj?.keepLatest === 'number' && payloadObj.keepLatest >= 0
          ? Math.floor(payloadObj.keepLatest)
          : 0;

    let backupsRoot = resolveCloudSaveBackupsRootDir(
      options?.backupsRootDir || options?.userDataDir || '',
      options
    );
    if (!backupsRoot) {
      const home = resolveIsolatedDefaultHomedir(options);
      backupsRoot = path.join(home, '.one-launcher', 'cloud_save_backups');
    }
    if (!backupsRoot || !fs.existsSync(backupsRoot)) {
      return {
        cleaned: false,
        removedBackups: 0,
        retainedBackups: 0,
        remainingCount: 0,
        freedBytes: 0,
      };
    }

    const prefixMatch = /^(gog|epic|xbox|steam)[-_]/i.exec(rawInputId);
    const explicitPlatform = String(
      options?.platformId || payloadObj.platformId || (prefixMatch ? prefixMatch[1] : '')
    )
      .trim()
      .toLowerCase();

    if (explicitPlatform && !PROTECTED_PLATFORM_BUCKET_DIRS.has(explicitPlatform)) {
      return {
        cleaned: false,
        removedBackups: 0,
        retainedBackups: 0,
        remainingCount: 0,
        freedBytes: 0,
      };
    }

    const strippedId = rawInputId.replace(/^(gog|epic|xbox|steam)[-_]/i, '').trim();

    const candidateDirNames = new Set(
      [
        rawInputId,
        strippedId,
        rawInputId.replace(/[^A-Za-z0-9._-]/g, '_'),
        strippedId.replace(/[^A-Za-z0-9._-]/g, '_'),
        strippedId.replace(/[^a-zA-Z0-9_-]/g, '_'),
      ]
        .map((s) => s.trim().toLowerCase())
        .filter(
          (s) =>
            Boolean(s) &&
            s !== '.' &&
            s !== '..' &&
            !s.includes('/') &&
            !s.includes('\\') &&
            !s.includes('\0')
        )
    );

    if (candidateDirNames.size === 0) {
      return {
        cleaned: false,
        removedBackups: 0,
        retainedBackups: 0,
        remainingCount: 0,
        freedBytes: 0,
      };
    }

    const platformsToCheck = explicitPlatform
      ? [explicitPlatform]
      : ['gog', 'epic', 'xbox', 'steam'];

    /** @type {string[]} */
    const matchedGameDirs = [];
    for (const plat of platformsToCheck) {
      const platDir = path.join(backupsRoot, plat);
      if (!fs.existsSync(platDir)) continue;
      try {
        const platStat = fs.lstatSync(platDir);
        if (platStat.isSymbolicLink() || !platStat.isDirectory()) continue;
        for (const ent of fs.readdirSync(platDir, { withFileTypes: true })) {
          if (!ent.isDirectory() || ent.isSymbolicLink()) continue;
          if (candidateDirNames.has(ent.name.toLowerCase())) {
            const gameDir = path.join(platDir, ent.name);
            try {
              const gStat = fs.lstatSync(gameDir);
              if (gStat.isSymbolicLink() || !gStat.isDirectory()) continue;
            } catch {
              continue;
            }
            matchedGameDirs.push(gameDir);
          }
        }
      } catch {}
    }

    // Also check direct child under backupsRoot if tests organize `<backupsRoot>/<gameId>/snapshot_*`
    // NEVER match top-level platform bucket dirs (`gog`, `epic`, `xbox`, `steam`)!
    try {
      for (const ent of fs.readdirSync(backupsRoot, { withFileTypes: true })) {
        if (!ent.isDirectory() || ent.isSymbolicLink()) continue;
        const lowerName = ent.name.toLowerCase();
        if (PROTECTED_PLATFORM_BUCKET_DIRS.has(lowerName)) {
          continue;
        }
        if (candidateDirNames.has(lowerName)) {
          const directDir = path.join(backupsRoot, ent.name);
          try {
            const dStat = fs.lstatSync(directDir);
            if (dStat.isSymbolicLink() || !dStat.isDirectory()) continue;
          } catch {
            continue;
          }
          if (!matchedGameDirs.includes(directDir)) {
            matchedGameDirs.push(directDir);
          }
        }
      }
    } catch {}

    let removedBackups = 0;
    let retainedBackups = 0;
    let freedBytes = 0;

    for (const gameBackupDir of matchedGameDirs) {
      if (
        !isContainedWithinRoot(backupsRoot, gameBackupDir) ||
        isProtectedBackupRootOrPlatformBucket(gameBackupDir, backupsRoot)
      ) {
        continue;
      }
      const snapshots = collectCloudSaveSnapshotEntriesSync(gameBackupDir);
      snapshots.sort((a, b) => {
        const diff = b.mtimeMs - a.mtimeMs;
        if (Math.abs(diff) > 0.5) return diff;
        return b.snapshotName.localeCompare(a.snapshotName);
      });

      const toKeep = snapshots.slice(0, keepLatest);
      const toRemove = snapshots.slice(keepLatest);
      retainedBackups += toKeep.length;

      for (const rem of toRemove) {
        if (!isContainedWithinRoot(backupsRoot, rem.snapshotPath)) continue;
        try {
          if (safeRemoveBackupDirSync(rem.snapshotPath, backupsRoot)) {
            removedBackups++;
            freedBytes += rem.bytes;
          }
        } catch {}
      }

      if (keepLatest === 0) {
        try {
          safeRemoveBackupDirSync(gameBackupDir, backupsRoot);
        } catch {}
      }
    }

    return {
      cleaned: removedBackups > 0,
      removedBackups,
      retainedBackups,
      remainingCount: retainedBackups,
      freedBytes,
    };
  }

  /**
   * Create a bounded rolling backup of an existing local save directory
   * before pre-launch cloud save download so local progress can never be lost on conflict,
   * enforcing a global `1.0 GB` cap across `cloud_save_backups` while retaining >= 2 backups per game.
   *
   * @param {string} sourceDir
   * @param {string} backupBaseDir
   * @param {number | Record<string, any>} [maxBytes]
   * @param {Record<string, any>} [quotaOptions]
   */
  function createCloudSaveRollingBackup(sourceDir, backupBaseDir, maxBytes, quotaOptions = {}) {
    try {
      /** @type {number | undefined} */
      let numericMaxBytes = typeof maxBytes === 'number' ? maxBytes : undefined;
      if (maxBytes && typeof maxBytes === 'object') {
        quotaOptions = maxBytes;
        numericMaxBytes = undefined;
      }
      const effectiveMaxBytes =
        typeof numericMaxBytes === 'number' && numericMaxBytes > 0
          ? numericMaxBytes
          : typeof quotaOptions?.maxBackupBytes === 'number' && quotaOptions.maxBackupBytes > 0
            ? quotaOptions.maxBackupBytes
            : resolveDefaultPerSnapshotMaxBackupBytes(quotaOptions);

      if (!sourceDir || !backupBaseDir || !fs.existsSync(sourceDir)) {
        return { backedUp: false, reason: 'source_missing' };
      }
      if (isBroadOneDriveKnownFolderRoot(sourceDir) || isWindowsKnownFolderRootPath(sourceDir)) {
        return { backedUp: false, reason: 'broad_known_folder_root_blocked' };
      }
      const rootStat = fs.lstatSync(sourceDir);
      if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
        return { backedUp: false, reason: 'not_real_directory' };
      }

      let snapshotDir = path.join(backupBaseDir, `snapshot_${Date.now()}`);
      if (fs.existsSync(snapshotDir)) {
        snapshotDir = `${snapshotDir}_${Math.random().toString(36).slice(2, 6)}`;
      }

      const copyRes = copyRealDirBoundedSync(sourceDir, snapshotDir, effectiveMaxBytes, {
        requireNonEmpty: true,
      });
      if (!copyRes.copied) {
        const reason =
          copyRes.reason === 'exceeds_size_cap'
            ? `Save directory exceeds maximum backup size limit (${effectiveMaxBytes} bytes)`
            : copyRes.reason;
        return {
          backedUp: false,
          reason,
          ...(copyRes.totalBytes > 0 ? { totalBytes: copyRes.totalBytes } : {}),
        };
      }

      const maxPerGame =
        typeof quotaOptions?.maxSnapshotsPerGame === 'number' &&
        quotaOptions.maxSnapshotsPerGame >= 2
          ? Math.floor(quotaOptions.maxSnapshotsPerGame)
          : 3;

      const backupsRoot = resolveCloudSaveBackupsRootDir(backupBaseDir, quotaOptions);
      const pruneContainmentRoot = backupsRoot || path.resolve(backupBaseDir);

      try {
        const snapshots = fs
          .readdirSync(backupBaseDir, { withFileTypes: true })
          .filter((d) => d.isDirectory() && !d.isSymbolicLink() && d.name.startsWith('snapshot_'))
          .map((d) => d.name)
          .sort();
        if (snapshots.length > maxPerGame) {
          for (const oldName of snapshots.slice(0, snapshots.length - maxPerGame)) {
            try {
              safeRemoveBackupDirSync(path.join(backupBaseDir, oldName), pruneContainmentRoot);
            } catch (rmErr) {
              diagLog.warn('cloudSave.pruneBackupSync', rmErr, { backupBaseDir, oldName });
            }
          }
        }
      } catch (pruneErr) {
        diagLog.warn('cloudSave.listBackupsSync', pruneErr, { backupBaseDir });
      }

      if (backupsRoot) {
        enforceCloudSaveBackupQuotaSync(backupsRoot, quotaOptions);
      }

      return {
        backedUp: true,
        backupPath: snapshotDir,
        totalBytes: copyRes.totalBytes,
        fileCount: copyRes.fileCount,
      };
    } catch (err) {
      diagLog.warn('cloudSave.backupSyncFailed', err, { sourceDir, backupBaseDir });
      return {
        backedUp: false,
        reason: /** @type {any} */ (err)?.message || 'backup_failed',
      };
    }
  }

  /**
   * Asynchronous counterpart to `createCloudSaveRollingBackup` using `fs.promises` + `COPYFILE_FICLONE`,
   * OneDrive Files On-Demand cloud-placeholder guard (reusing `quotaOptions.precheckedPlaceholderState`
   * when already probed by the sync runner to avoid duplicate PowerShell spawns), and global `1.0 GB`
   * rolling backup quota enforcement.
   *
   * @param {string} sourceDir
   * @param {string} backupBaseDir
   * @param {number | Record<string, any>} [maxBytes]
   * @param {Record<string, any>} [quotaOptions]
   */
  async function createCloudSaveRollingBackupAsync(
    sourceDir,
    backupBaseDir,
    maxBytes,
    quotaOptions = {}
  ) {
    try {
      /** @type {number | undefined} */
      let numericMaxBytes = typeof maxBytes === 'number' ? maxBytes : undefined;
      if (maxBytes && typeof maxBytes === 'object') {
        quotaOptions = maxBytes;
        numericMaxBytes = undefined;
      }
      const effectiveMaxBytes =
        typeof numericMaxBytes === 'number' && numericMaxBytes > 0
          ? numericMaxBytes
          : typeof quotaOptions?.maxBackupBytes === 'number' && quotaOptions.maxBackupBytes > 0
            ? quotaOptions.maxBackupBytes
            : resolveDefaultPerSnapshotMaxBackupBytes(quotaOptions);

      if (!sourceDir || !backupBaseDir) {
        return { backedUp: false, reason: 'source_missing' };
      }
      if (isBroadOneDriveKnownFolderRoot(sourceDir) || isWindowsKnownFolderRootPath(sourceDir)) {
        return { backedUp: false, reason: 'broad_known_folder_root_blocked' };
      }
      /** @type {fs.Stats | null} */
      let rootStat = null;
      try {
        rootStat = await fs.promises.lstat(sourceDir);
      } catch {
        return { backedUp: false, reason: 'source_missing' };
      }
      if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
        return { backedUp: false, reason: 'not_real_directory' };
      }

      const placeholderState =
        quotaOptions &&
        quotaOptions.precheckedPlaceholderState &&
        typeof quotaOptions.precheckedPlaceholderState === 'object'
          ? quotaOptions.precheckedPlaceholderState
          : await inspectOneDrive(sourceDir, quotaOptions);
      if (placeholderState.blockedBroadRoot) {
        return { backedUp: false, reason: 'broad_known_folder_root_blocked' };
      }
      if (placeholderState.hasPlaceholders) {
        diagLog.warn(
          'cloudSave.oneDrivePlaceholderSkipped',
          'Skipped rolling backup on unhydrated OneDrive Files On-Demand placeholder files',
          {
            sourceDir,
            sampleFiles: Array.isArray(placeholderState.placeholderFiles)
              ? placeholderState.placeholderFiles.slice(0, 5)
              : [],
          }
        );
        return {
          backedUp: false,
          reason: 'onedrive_cloud_placeholder_skipped',
          placeholderFiles: placeholderState.placeholderFiles || [],
        };
      }

      let snapshotDir = path.join(backupBaseDir, `snapshot_${Date.now()}`);
      try {
        await fs.promises.access(snapshotDir);
        snapshotDir = `${snapshotDir}_${Math.random().toString(36).slice(2, 6)}`;
      } catch {
        // Unique snapshot directory
      }

      const copyRes = await copyRealDirBoundedAsync(sourceDir, snapshotDir, effectiveMaxBytes, {
        requireNonEmpty: true,
      });
      if (!copyRes.copied) {
        const reason =
          copyRes.reason === 'exceeds_size_cap'
            ? `Save directory exceeds maximum backup size limit (${effectiveMaxBytes} bytes)`
            : copyRes.reason;
        return {
          backedUp: false,
          reason,
          ...(copyRes.totalBytes > 0 ? { totalBytes: copyRes.totalBytes } : {}),
        };
      }

      const maxPerGame =
        typeof quotaOptions?.maxSnapshotsPerGame === 'number' &&
        quotaOptions.maxSnapshotsPerGame >= 2
          ? Math.floor(quotaOptions.maxSnapshotsPerGame)
          : 3;

      const backupsRoot = resolveCloudSaveBackupsRootDir(backupBaseDir, quotaOptions);
      const pruneContainmentRoot = backupsRoot || path.resolve(backupBaseDir);

      try {
        const entries = await fs.promises.readdir(backupBaseDir, { withFileTypes: true });
        const snapshots = entries
          .filter((d) => d.isDirectory() && !d.isSymbolicLink() && d.name.startsWith('snapshot_'))
          .map((d) => d.name)
          .sort();
        if (snapshots.length > maxPerGame) {
          for (const oldName of snapshots.slice(0, snapshots.length - maxPerGame)) {
            try {
              await safeRemoveBackupDirAsync(
                path.join(backupBaseDir, oldName),
                pruneContainmentRoot
              );
            } catch (rmErr) {
              diagLog.warn('cloudSave.pruneBackupAsync', rmErr, { backupBaseDir, oldName });
            }
          }
        }
      } catch (pruneErr) {
        diagLog.warn('cloudSave.listBackupsAsync', pruneErr, { backupBaseDir });
      }

      if (backupsRoot) {
        await enforceCloudSaveBackupQuotaAsync(backupsRoot, quotaOptions);
      }

      return {
        backedUp: true,
        backupPath: snapshotDir,
        totalBytes: copyRes.totalBytes,
        fileCount: copyRes.fileCount,
      };
    } catch (err) {
      diagLog.warn('cloudSave.backupAsyncFailed', err, { sourceDir, backupBaseDir });
      return {
        backedUp: false,
        reason: /** @type {any} */ (err)?.message || 'backup_failed',
      };
    }
  }

  return {
    enforceCloudSaveBackupQuotaSync,
    enforceCloudSaveBackupQuotaAsync,
    cleanupGameBackups,
    createCloudSaveRollingBackup,
    createCloudSaveRollingBackupAsync,
  };
}

module.exports = {
  DEFAULT_DARWIN_CLOUD_SAVE_MAX_BACKUP_BYTES,
  DEFAULT_WIN32_CLOUD_SAVE_MAX_BACKUP_BYTES,
  DEFAULT_GLOBAL_CLOUD_SAVE_BACKUP_QUOTA_BYTES,
  MIN_RETAINED_BACKUPS_PER_GAME,
  isProtectedBackupRootOrPlatformBucket,
  safeRemoveBackupDirSync,
  safeRemoveBackupDirAsync,
  resolveCloudSaveBackupsRootDir,
  computeRealDirStatsSync,
  computeRealDirStatsAsync,
  collectCloudSaveSnapshotEntriesSync,
  collectCloudSaveSnapshotEntriesAsync,
  createBackupAndQuotaManager,
};
