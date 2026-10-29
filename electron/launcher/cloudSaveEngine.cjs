'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFile } = require('node:child_process');
const { diagLog } = require('../utils/diagnosticLogger.cjs');
const {
  copyRealDirBoundedSync,
  copyRealDirBoundedAsync,
} = require('./boundedCopyUtils.cjs');
const {
  toHostFilesystemPath,
  atomicWriteFileSync,
  isContainedWithinRoot,
  recordImportedEpicInstall,
  resolveHostWindowsKnownFolders,
} = require('./securityAndPathUtils.cjs');
const { execCliWithTreeTimeout } = require('./processTreeUtils.cjs');
const { readWinePrefixShellFolders } = require('./wineAndCrossOverManager.cjs');
const {
  inspectMicrosoftGameConfig,
  inspectAppxManifest,
} = require('./binaryAndManifestInspectors.cjs');
const {
  formatWgsUserScidFolderName,
  parseWgsContainerBlobIndex,
  syncXboxTitleStorage,
} = require('../storefronts/xbox/xboxTitleStorageSync.cjs');

const MAX_GOG_CLOUD_CONFIG_CACHE_ENTRIES = 250;
const MAX_GOG_PRODUCT_CLIENT_ID_CACHE_ENTRIES = 500;
/**
 * Upstream public GOG Galaxy native desktop OAuth client ID (`heroic-gogdl`, RFC 8252 §8.5 —
 * NOT a private developer credential). Used to guard per-game GOG cloud-save client IDs from
 * being poisoned by the launcher-wide OAuth client ID, with optional env override support.
 */
const GOG_GALAXY_LAUNCHER_CLIENT_ID =
  String(process.env.ONE_LAUNCHER_GOG_CLIENT_ID || '').trim() || '46899977096215655';
const OS_METADATA_JUNK_REGEX = /^(?:\.DS_Store|\._.+|Thumbs\.db|desktop\.ini)$/i;
const virtualMockPreLaunchByExecFn = new WeakMap();

const BENIGN_CLOUD_SYNC_SKIP_REASONS = new Set([
  'no_cloud_saves_configured',
  'no_cloud_save_folder_or_skipped',
  'skipped_in_test',
  'not_installed',
  'no_active_cloud_job',
  'invalid_platform',
  'missing_game_id',
  'missing_app_name',
  'nothing_to_sync',
  'missing_xbox_auth',
  'missing_scid_or_pfn',
  'offline_skipped',
  'title_storage_not_provisioned',
  'onedrive_cloud_placeholder_skipped',
  'broad_known_folder_root_blocked',
]);

/** @type {Map<string, Promise<any>>} */
const cloudManifestLocksByPath = new Map();

/**
 * Serializes Read-Modify-Write updates to per-file cloud-save JSON manifests
 * (`one_launcher_gog_cloud_configs.json`, `one_launcher_cloud_sync_timestamps.json`, etc.)
 * through an in-process async mutex keyed by normalized file path.
 *
 * @template T
 * @param {string} filePath
 * @param {() => Promise<T> | T} taskFn
 * @returns {Promise<T>}
 */
function withCloudManifestFileLock(filePath, taskFn) {
  const key = path.resolve(String(filePath || '')).toLowerCase();
  const prev = cloudManifestLocksByPath.get(key) || Promise.resolve();
  /** @type {(value?: any) => void} */
  let releaseNext = () => {};
  const gate = new Promise((resolve) => {
    releaseNext = resolve;
  });
  const chained = prev.then(() => gate, () => gate);
  cloudManifestLocksByPath.set(key, chained);

  return prev
    .catch(() => {})
    .then(() => taskFn())
    .finally(() => {
      releaseNext();
      if (cloudManifestLocksByPath.get(key) === chained) {
        cloudManifestLocksByPath.delete(key);
      }
    });
}

function resolveIsolatedDefaultHomedir(opts = {}) {
  if (typeof opts?.homedir === 'string' && opts.homedir.trim()) {
    return opts.homedir.trim();
  }
  if (process.env.VITEST || process.env.NODE_ENV === 'test') {
    return path.join(os.tmpdir(), `one-launcher-test-home-${process.pid}`);
  }
  return os.homedir();
}

/**
 * Validate a per-game GOG OAuth/Cloud clientId and reject GOG Galaxy's first-party launcher
 * clientId (`46899977096215655`) unless explicitly allowed by an override test fixture.
 */
function sanitizeGogGameClientId(rawId, allowLauncherId = false) {
  if (rawId === null || rawId === undefined) return '';
  const trimmed = String(rawId).trim();
  if (!trimmed) return '';
  const lower = trimmed.toLowerCase();
  if (lower === 'null' || lower === 'undefined' || lower === 'false' || lower === 'nan') {
    return '';
  }
  if (!/^[A-Za-z0-9_-]{3,128}$/.test(trimmed)) {
    return '';
  }
  if (!allowLauncherId && trimmed === GOG_GALAXY_LAUNCHER_CLIENT_ID) {
    return '';
  }
  return trimmed;
}

/**
 * Normalize POSIX/macOS locale strings so PyInstaller Python's `locale.getlocale()` always
 * receives a valid `xx_YY.UTF-8` country-qualified locale instead of `C.UTF-8`, `UTF-8`, `C`, or `POSIX`.
 */
function normalizePosixUtf8Locale(val) {
  return typeof val === 'string' && /^[a-z]{2,3}_[A-Z]{2}\./.test(val.trim())
    ? val.trim()
    : 'en_US.UTF-8';
}

const DEFAULT_DARWIN_CLOUD_SAVE_MAX_BACKUP_BYTES = 1024 * 1024 * 1024;
const DEFAULT_WIN32_CLOUD_SAVE_MAX_BACKUP_BYTES = 256 * 1024 * 1024;
const DEFAULT_GLOBAL_CLOUD_SAVE_BACKUP_QUOTA_BYTES = 1024 * 1024 * 1024; // 1.0 GB global cap
const MIN_RETAINED_BACKUPS_PER_GAME = 2;

const INITIAL_HOST_PLATFORM =
  globalThis.__ONE_LAUNCHER_INITIAL_HOST_PLATFORM__ ||
  (globalThis.__ONE_LAUNCHER_INITIAL_HOST_PLATFORM__ = process.platform);
const MODULE_LOAD_PLATFORM = process.platform;

function resolveDefaultPerSnapshotMaxBackupBytes(options = {}) {
  const effectivePlatform =
    options?.platform ||
    (process.platform !== INITIAL_HOST_PLATFORM ? process.platform : '') ||
    options?._boundPlatform ||
    MODULE_LOAD_PLATFORM ||
    process.platform;
  return effectivePlatform === 'win32'
    ? DEFAULT_WIN32_CLOUD_SAVE_MAX_BACKUP_BYTES
    : DEFAULT_DARWIN_CLOUD_SAVE_MAX_BACKUP_BYTES;
}
const DEFAULT_CLOUD_SAVE_MAX_BACKUP_BYTES = resolveDefaultPerSnapshotMaxBackupBytes({
  _boundPlatform: MODULE_LOAD_PLATFORM,
});

const FILE_ATTRIBUTE_OFFLINE = 0x1000;
const FILE_ATTRIBUTE_RECALL_ON_OPEN = 0x00040000;
const FILE_ATTRIBUTE_RECALL_ON_DATA_ACCESS = 0x00400000;
const ONEDRIVE_CLOUD_PLACEHOLDER_MASK =
  FILE_ATTRIBUTE_OFFLINE | FILE_ATTRIBUTE_RECALL_ON_OPEN | FILE_ATTRIBUTE_RECALL_ON_DATA_ACCESS;

function hasWin32CloudPlaceholderAttributes(attrMask) {
  const num = Number(attrMask);
  if (!Number.isFinite(num) || num <= 0) return false;
  return (num & ONEDRIVE_CLOUD_PLACEHOLDER_MASK) !== 0;
}

function isOneDrivePath(targetPath) {
  if (!targetPath || typeof targetPath !== 'string') return false;
  return /(?:^|[\\/])onedrive(?:[^\\/]*)(?:[\\/]|$)/i.test(targetPath);
}

function isBroadOneDriveKnownFolderRoot(targetDir) {
  if (!targetDir || typeof targetDir !== 'string') return false;
  return isOneDrivePath(targetDir) && isWindowsKnownFolderRootPath(targetDir);
}

function isSparseOrOfflineStat(st, checkSparseBlocks = false) {
  if (!st || typeof st !== 'object') return false;
  if (
    hasWin32CloudPlaceholderAttributes(st.win32Attributes) ||
    hasWin32CloudPlaceholderAttributes(st.attributes)
  ) {
    return true;
  }
  if (
    checkSparseBlocks &&
    typeof st.size === 'number' &&
    st.size >= 4096 &&
    typeof st.blocks === 'number' &&
    st.blocks === 0
  ) {
    return true;
  }
  return false;
}

/**
 * Opens a file handle with a bounded timeout so OneDrive / network cloud-recall stalls can never
 * freeze One Launcher indefinitely.
 */
async function openFileBoundedNoRecallAsync(filePath, flags = 'r', timeoutMs = 2500) {
  let timedOut = false;
  let timer = null;
  const openPromise = fs.promises.open(filePath, flags).then(
    async (fh) => {
      if (timedOut) {
        try {
          await fh.close();
        } catch {}
        throw new Error('Bounded file open timed out after OneDrive/cloud stall');
      }
      return fh;
    }
  );
  const timeoutPromise = new Promise((_, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      const err = Object.assign(
        new Error(`File open timed out (${timeoutMs}ms): ${filePath}`),
        { code: 'ETIMEDOUT' }
      );
      reject(err);
    }, Math.max(50, Number(timeoutMs) || 2500));
    if (timer && typeof timer.unref === 'function') timer.unref();
  });
  try {
    return await Promise.race([openPromise, timeoutPromise]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Inspects a specific resolved game save subfolder for Windows OneDrive Files On-Demand cloud-only
 * placeholders (`FILE_ATTRIBUTE_OFFLINE = 0x1000`, `FILE_ATTRIBUTE_RECALL_ON_DATA_ACCESS = 0x00400000`)
 * via lightweight `fs.lstat` + bounded MFT attribute inspection without opening or hydrating cloud streams.
 * Explicitly refuses to scan broad parent `OneDrive\Documents` / `OneDrive\Saved Games` roots.
 */
async function inspectOneDrivePlaceholderStateAsync(targetDir, options = {}) {
  if (!targetDir || typeof targetDir !== 'string') {
    return { hasPlaceholders: false, blockedBroadRoot: false, placeholderFiles: [] };
  }
  if (isBroadOneDriveKnownFolderRoot(targetDir)) {
    return { hasPlaceholders: false, blockedBroadRoot: true, placeholderFiles: [] };
  }

  const effectivePlatform = options.platform || process.platform;
  const underOneDrive = isOneDrivePath(targetDir) || options.forceOneDriveCheck === true;
  const customAttrFn =
    typeof options.getWin32FileAttributes === 'function' ? options.getWin32FileAttributes : null;

  if (effectivePlatform !== 'win32' && !underOneDrive && !customAttrFn) {
    return { hasPlaceholders: false, blockedBroadRoot: false, placeholderFiles: [] };
  }

  let rootStat = null;
  try {
    rootStat = await fs.promises.lstat(targetDir);
  } catch {
    return { hasPlaceholders: false, blockedBroadRoot: false, placeholderFiles: [] };
  }
  if (rootStat.isSymbolicLink()) {
    return { hasPlaceholders: false, blockedBroadRoot: false, placeholderFiles: [] };
  }

  const placeholderFiles = [];
  const checkSingleFileStat = async (filePath, st) => {
    if (customAttrFn) {
      try {
        const attrMask = await customAttrFn(filePath, st);
        if (hasWin32CloudPlaceholderAttributes(attrMask)) {
          placeholderFiles.push(filePath);
          return;
        }
      } catch {}
    }
    if (isSparseOrOfflineStat(st, underOneDrive)) {
      placeholderFiles.push(filePath);
    }
  };

  if (rootStat.isFile()) {
    await checkSingleFileStat(targetDir, rootStat);
  } else if (rootStat.isDirectory()) {
    const stack = [{ dir: targetDir, depth: 0 }];
    let scannedEntries = 0;
    while (stack.length > 0 && scannedEntries < 2000 && placeholderFiles.length < 25) {
      const { dir, depth } = stack.pop();
      if (depth > 8) continue;
      let entries;
      try {
        entries = await fs.promises.readdir(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const ent of entries) {
        scannedEntries++;
        if (scannedEntries > 2000) break;
        const full = path.join(dir, ent.name);
        let st;
        try {
          st = await fs.promises.lstat(full);
        } catch {
          continue;
        }
        if (st.isSymbolicLink()) continue;
        if (st.isDirectory()) {
          stack.push({ dir: full, depth: depth + 1 });
        } else if (st.isFile()) {
          await checkSingleFileStat(full, st);
        }
      }
    }
  }

  // On win32 OneDrive folders, query NTFS directory MFT Attributes via PowerShell/attrib (no file open/recall!)
  const execFn =
    typeof options.oneDriveAttribExecImpl === 'function'
      ? options.oneDriveAttribExecImpl
      : effectivePlatform === 'win32' && underOneDrive && !process.env.VITEST
        ? execFile
        : null;

  if (placeholderFiles.length === 0 && execFn && underOneDrive) {
    const escapedPath = targetDir.replace(/'/g, "''");
    const psCmd = `Get-ChildItem -LiteralPath '${escapedPath}' -Recurse -Force -File -ErrorAction SilentlyContinue | Where-Object { ([int]$_.Attributes -band ${ONEDRIVE_CLOUD_PLACEHOLDER_MASK}) -ne 0 } | Select-Object -First 10 -ExpandProperty FullName`;
    const psDetected = await new Promise((resolve) => {
      try {
        execFn(
          'powershell.exe',
          ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', psCmd],
          { timeout: 2500, windowsHide: true, maxBuffer: 64 * 1024 },
          (err, stdout) => {
            if (!err && typeof stdout === 'string') {
              const lines = stdout
                .split(/\r?\n/)
                .map((l) => l.trim())
                .filter(Boolean);
              resolve(lines);
              return;
            }
            // Lightweight fallback to Win32 `attrib.exe` (checks 'O' offline / 'U' unpinned flags)
            try {
              execFn(
                'attrib.exe',
                [rootStat.isDirectory() ? path.win32.join(targetDir, '*') : targetDir, '/S'],
                { timeout: 2000, windowsHide: true, maxBuffer: 128 * 1024 },
                (attrErr, attrOut) => {
                  if (attrErr || typeof attrOut !== 'string') {
                    resolve([]);
                    return;
                  }
                  const found = [];
                  for (const ln of attrOut.split(/\r?\n/)) {
                    const flagsPart = ln.slice(0, 22);
                    const pathPart = ln.slice(21).trim();
                    if (pathPart && (flagsPart.includes('O') || (flagsPart.includes('U') && flagsPart.includes('M')))) {
                      found.push(pathPart);
                      if (found.length >= 10) break;
                    }
                  }
                  resolve(found);
                }
              );
            } catch {
              resolve([]);
            }
          }
        );
      } catch {
        resolve([]);
      }
    });
    for (const p of psDetected) {
      placeholderFiles.push(p);
    }
  }

  return {
    hasPlaceholders: placeholderFiles.length > 0,
    blockedBroadRoot: false,
    placeholderFiles,
  };
}

function isWindowsKnownFolderRootPath(targetDir) {
  if (!targetDir || typeof targetDir !== 'string') return false;
  const norm = targetDir.replace(/\\/g, '/').replace(/\/+$/, '');
  const segs = norm.split('/').filter(Boolean);
  if (segs.length < 2) return false;
  const leaf = segs[segs.length - 1].toLowerCase();
  const parent = segs[segs.length - 2].toLowerCase();
  const grand = segs.length >= 3 ? segs[segs.length - 3].toLowerCase() : '';

  if (parent === 'appdata' && (leaf === 'local' || leaf === 'roaming' || leaf === 'locallow')) {
    return true;
  }
  const knownFolderLeaves = new Set([
    'documents',
    'my documents',
    'saved games',
    'desktop',
    'downloads',
    'pictures',
    'my pictures',
    'music',
    'my music',
    'videos',
    'my videos',
    'onedrive',
    'favorites',
    'links',
    'contacts',
    'searches',
  ]);
  if (!knownFolderLeaves.has(leaf)) return false;
  if (grand === 'users' || parent.startsWith('onedrive')) {
    return true;
  }
  const hostHome = os.homedir().replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  if (hostHome && norm.toLowerCase() === `${hostHome}/${leaf}`) {
    return true;
  }
  return false;
}

/**
 * Recursively purge OS metadata junk files (`.DS_Store`, `._*`, `Thumbs.db`, `desktop.ini`)
 * from a save directory without traversing symlinks, and count remaining real save files.
 * Preserves `desktop.ini` on top-level Windows Known Folder roots (`Documents`, `Saved Games`,
 * `OneDrive\Documents`, `AppData\LocalLow`, etc.) without counting it as a save file, and avoids
 * recursing into broad parent `OneDrive\Documents` / `OneDrive\Saved Games` trees on `win32`.
 */
function purgeOsMetadataAndCountRealFilesSync(dirPath) {
  const summary = { exists: false, purgedCount: 0, realFileCount: 0 };
  if (!dirPath || typeof dirPath !== 'string') return summary;
  try {
    if (!fs.existsSync(dirPath)) return summary;
    const rootStat = fs.lstatSync(dirPath);
    if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
      return summary;
    }
    summary.exists = true;

    const isBroadOneDriveRoot = isBroadOneDriveKnownFolderRoot(dirPath);
    const stack = [dirPath];
    while (stack.length > 0) {
      const currentDir = stack.pop();
      const preserveRootDesktopIni = isWindowsKnownFolderRootPath(currentDir);
      let entries;
      try {
        entries = fs.readdirSync(currentDir);
      } catch {
        continue;
      }
      for (const name of entries) {
        const fullPath = path.join(currentDir, name);
        let entryStat;
        try {
          entryStat = fs.lstatSync(fullPath);
        } catch {
          continue;
        }
        if (entryStat.isSymbolicLink()) {
          continue;
        }
        if (entryStat.isDirectory()) {
          if (isBroadOneDriveRoot && process.platform === 'win32') {
            continue;
          }
          stack.push(fullPath);
          continue;
        }
        if (!entryStat.isFile()) {
          continue;
        }
        if (isSparseOrOfflineStat(entryStat, isOneDrivePath(fullPath))) {
          continue;
        }
        if (OS_METADATA_JUNK_REGEX.test(name)) {
          if (preserveRootDesktopIni && name.toLowerCase() === 'desktop.ini') {
            continue;
          }
          try {
            fs.unlinkSync(fullPath);
            summary.purgedCount += 1;
          } catch {
            // Ignore locked OS metadata files without counting them as real game saves
          }
        } else {
          summary.realFileCount += 1;
        }
      }
    }
  } catch (err) {
    diagLog.warn('cloudSave.purgeOsMetadataFailed', err, { dirPath });
  }
  return summary;
}

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

function collectCloudSaveSnapshotEntriesSync(backupsRootDir) {
  /** @type {Array<{ snapshotPath: string, snapshotName: string, seriesKey: string, bytes: number, mtimeMs: number }>} */
  const allSnapshots = [];
  if (!backupsRootDir || !fs.existsSync(backupsRootDir)) return allSnapshots;

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
 * Enforces the global `1.0 GB` rolling backup quota (`maxTotalBackupBytes = 1024 * 1024 * 1024`)
 * across `cloud_save_backups`, evicting oldest backup archives by `mtime` across games while
 * ALWAYS retaining at least the `2` newest backups per game so no game ever loses rollback safety.
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
      fs.rmSync(cand.snapshotPath, { recursive: true, force: true });
      totalBytes = Math.max(0, totalBytes - cand.bytes);
      freedBytes += cand.bytes;
      evictedCount++;
    } catch (rmErr) {
      diagLog.warn('cloudSave.evictGlobalQuotaSync', rmErr, { snapshotPath: cand.snapshotPath });
    }
  }

  return { evictedCount, freedBytes, totalBytes };
}

async function enforceCloudSaveBackupQuotaAsync(backupsRootOrUserDataDir, options = {}) {
  return enforceCloudSaveBackupQuotaSync(backupsRootOrUserDataDir, options);
}

/**
 * Optional uninstall / maintenance cleanup for a specific game's rolling backups under `cloud_save_backups`.
 * Supports `keepLatest` (default `0` to remove all backups for that uninstalled game, or `> 0` to keep the
 * `keepLatest` newest snapshots).
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
    return { cleaned: false, removedBackups: 0, retainedBackups: 0, remainingCount: 0, freedBytes: 0 };
  }

  const keepLatest =
    typeof options?.keepLatest === 'number' && options.keepLatest >= 0
      ? Math.floor(options.keepLatest)
      : typeof payloadObj?.keepLatest === 'number' && payloadObj.keepLatest >= 0
        ? Math.floor(payloadObj.keepLatest)
        : 0;

  let backupsRoot = resolveCloudSaveBackupsRootDir(options?.backupsRootDir || options?.userDataDir || '', options);
  if (!backupsRoot) {
    const home = resolveIsolatedDefaultHomedir(options);
    backupsRoot = path.join(home, '.one-launcher', 'cloud_save_backups');
  }
  if (!backupsRoot || !fs.existsSync(backupsRoot)) {
    return { cleaned: false, removedBackups: 0, retainedBackups: 0, remainingCount: 0, freedBytes: 0 };
  }

  const prefixMatch = /^(gog|epic|xbox|steam)[-_]/i.exec(rawInputId);
  const explicitPlatform = String(
    options?.platformId || payloadObj.platformId || (prefixMatch ? prefixMatch[1] : '')
  )
    .trim()
    .toLowerCase();
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
      .filter(Boolean)
  );

  const platformsToCheck = explicitPlatform
    ? [explicitPlatform]
    : ['gog', 'epic', 'xbox', 'steam'];

  const matchedGameDirs = [];
  for (const plat of platformsToCheck) {
    const platDir = path.join(backupsRoot, plat);
    if (!fs.existsSync(platDir)) continue;
    try {
      for (const ent of fs.readdirSync(platDir, { withFileTypes: true })) {
        if (!ent.isDirectory()) continue;
        if (candidateDirNames.has(ent.name.toLowerCase())) {
          matchedGameDirs.push(path.join(platDir, ent.name));
        }
      }
    } catch {}
  }

  // Also check direct child under backupsRoot if tests organize `<backupsRoot>/<gameId>/snapshot_*`
  try {
    for (const ent of fs.readdirSync(backupsRoot, { withFileTypes: true })) {
      if (!ent.isDirectory()) continue;
      if (candidateDirNames.has(ent.name.toLowerCase())) {
        const directDir = path.join(backupsRoot, ent.name);
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
    if (!isContainedWithinRoot(backupsRoot, gameBackupDir)) continue;
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
        fs.rmSync(rem.snapshotPath, { recursive: true, force: true });
        removedBackups++;
        freedBytes += rem.bytes;
      } catch {}
    }

    if (keepLatest === 0) {
      try {
        fs.rmSync(gameBackupDir, { recursive: true, force: true });
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
 */
function createCloudSaveRollingBackup(
  sourceDir,
  backupBaseDir,
  maxBytes,
  quotaOptions = {}
) {
  try {
    if (maxBytes && typeof maxBytes === 'object') {
      quotaOptions = maxBytes;
      maxBytes = undefined;
    }
    const effectiveMaxBytes =
      typeof maxBytes === 'number' && maxBytes > 0
        ? maxBytes
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
      typeof quotaOptions?.maxSnapshotsPerGame === 'number' && quotaOptions.maxSnapshotsPerGame >= 2
        ? Math.floor(quotaOptions.maxSnapshotsPerGame)
        : 3;

    try {
      const snapshots = fs
        .readdirSync(backupBaseDir, { withFileTypes: true })
        .filter((d) => d.isDirectory() && d.name.startsWith('snapshot_'))
        .map((d) => d.name)
        .sort();
      if (snapshots.length > maxPerGame) {
        for (const oldName of snapshots.slice(0, snapshots.length - maxPerGame)) {
          try {
            fs.rmSync(path.join(backupBaseDir, oldName), { recursive: true, force: true });
          } catch (rmErr) {
            diagLog.warn('cloudSave.pruneBackupSync', rmErr, { backupBaseDir, oldName });
          }
        }
      }
    } catch (pruneErr) {
      diagLog.warn('cloudSave.listBackupsSync', pruneErr, { backupBaseDir });
    }

    const backupsRoot = resolveCloudSaveBackupsRootDir(backupBaseDir, quotaOptions);
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
    return { backedUp: false, reason: err?.message || 'backup_failed' };
  }
}

/**
 * Asynchronous counterpart to `createCloudSaveRollingBackup` using `fs.promises` + `COPYFILE_FICLONE`,
 * OneDrive Files On-Demand cloud-placeholder guard, and global `1.0 GB` rolling backup quota enforcement.
 */
async function createCloudSaveRollingBackupAsync(
  sourceDir,
  backupBaseDir,
  maxBytes,
  quotaOptions = {}
) {
  try {
    if (maxBytes && typeof maxBytes === 'object') {
      quotaOptions = maxBytes;
      maxBytes = undefined;
    }
    const effectiveMaxBytes =
      typeof maxBytes === 'number' && maxBytes > 0
        ? maxBytes
        : typeof quotaOptions?.maxBackupBytes === 'number' && quotaOptions.maxBackupBytes > 0
          ? quotaOptions.maxBackupBytes
          : resolveDefaultPerSnapshotMaxBackupBytes(quotaOptions);

    if (!sourceDir || !backupBaseDir) {
      return { backedUp: false, reason: 'source_missing' };
    }
    if (isBroadOneDriveKnownFolderRoot(sourceDir) || isWindowsKnownFolderRootPath(sourceDir)) {
      return { backedUp: false, reason: 'broad_known_folder_root_blocked' };
    }
    let rootStat = null;
    try {
      rootStat = await fs.promises.lstat(sourceDir);
    } catch {
      return { backedUp: false, reason: 'source_missing' };
    }
    if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
      return { backedUp: false, reason: 'not_real_directory' };
    }

    const placeholderState = await inspectOneDrivePlaceholderStateAsync(sourceDir, quotaOptions);
    if (placeholderState.blockedBroadRoot) {
      return { backedUp: false, reason: 'broad_known_folder_root_blocked' };
    }
    if (placeholderState.hasPlaceholders) {
      diagLog.warn(
        'cloudSave.oneDrivePlaceholderSkipped',
        'Skipped rolling backup on unhydrated OneDrive Files On-Demand placeholder files',
        { sourceDir, sampleFiles: placeholderState.placeholderFiles.slice(0, 5) }
      );
      return {
        backedUp: false,
        reason: 'onedrive_cloud_placeholder_skipped',
        placeholderFiles: placeholderState.placeholderFiles,
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
      typeof quotaOptions?.maxSnapshotsPerGame === 'number' && quotaOptions.maxSnapshotsPerGame >= 2
        ? Math.floor(quotaOptions.maxSnapshotsPerGame)
        : 3;

    try {
      const entries = await fs.promises.readdir(backupBaseDir, { withFileTypes: true });
      const snapshots = entries
        .filter((d) => d.isDirectory() && d.name.startsWith('snapshot_'))
        .map((d) => d.name)
        .sort();
      if (snapshots.length > maxPerGame) {
        for (const oldName of snapshots.slice(0, snapshots.length - maxPerGame)) {
          try {
            await fs.promises.rm(path.join(backupBaseDir, oldName), {
              recursive: true,
              force: true,
            });
          } catch (rmErr) {
            diagLog.warn('cloudSave.pruneBackupAsync', rmErr, { backupBaseDir, oldName });
          }
        }
      }
    } catch (pruneErr) {
      diagLog.warn('cloudSave.listBackupsAsync', pruneErr, { backupBaseDir });
    }

    const backupsRoot = resolveCloudSaveBackupsRootDir(backupBaseDir, quotaOptions);
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
    return { backedUp: false, reason: err?.message || 'backup_failed' };
  }
}

function normalizeResolvedCloudSavePath(rawExpanded, targetPlatform, useCompatLayer) {
  if (!rawExpanded || typeof rawExpanded !== 'string') return '';
  if (
    targetPlatform === 'win32' &&
    !useCompatLayer &&
    (process.platform === 'win32' ||
      /^[A-Za-z]:[\\/]/.test(rawExpanded) ||
      rawExpanded.startsWith('\\\\'))
  ) {
    const winNorm = path.win32.normalize(rawExpanded.replace(/\//g, '\\'));
    return /^[A-Za-z]:\\$/.test(winNorm) || winNorm === '\\'
      ? winNorm
      : winNorm.replace(/\\+$/, '');
  }
  if (process.platform !== 'win32') {
    const converted = rawExpanded.replace(/\\/g, '/');
    if (/^[A-Za-z]:\//.test(converted)) {
      const winPosix = path.win32
        .normalize(rawExpanded.replace(/\//g, '\\'))
        .replace(/\\/g, '/');
      return /^[A-Za-z]:\/$/.test(winPosix) ? winPosix : winPosix.replace(/\/+$/, '');
    }
    const posixNorm = path.posix.normalize(converted);
    return posixNorm === '/' ? posixNorm : posixNorm.replace(/\/+$/, '');
  }
  const hostNorm = path.normalize(rawExpanded);
  return /^[A-Za-z]:\\$/.test(hostNorm) || hostNorm === '/' || hostNorm === '\\'
    ? hostNorm
    : hostNorm.replace(/[\\/]+$/, '');
}

/**
 * Resolve GOG remote-config cloudStorage locations across Windows (honoring OneDrive Known Folder
 * redirection), macOS native, and Wine/CrossOver bottles, enforcing strict anchor-root containment.
 */
function resolveGogCloudSaveLocations(locations, context = {}) {
  if (!Array.isArray(locations) || locations.length === 0) return [];

  const targetPlatform = context.platform || process.platform;
  const useCompatLayer = Boolean(context.useCompatLayer);
  const homedir = context.homedir || os.homedir();
  const installPath = context.installPath ? String(context.installPath) : '';

  let placeholderMap;
  if (useCompatLayer && context.winePrefix) {
    const shell = readWinePrefixShellFolders(context.winePrefix);
    placeholderMap = {
      INSTALL: installPath,
      DOCUMENTS: shell.documents,
      SAVED_GAMES: shell.savedGames,
      APPLICATION_DATA_LOCAL: shell.appDataLocal,
      LOCAL_APPLICATION_DATA: shell.appDataLocal,
      APPLICATION_DATA_LOCAL_LOW: shell.appDataLocalLow,
      APPLICATION_DATA_ROAMING: shell.appDataRoaming,
      APPLICATION_DATA: shell.appDataRoaming,
      APPLICATION_SUPPORT: shell.appDataLocal,
      HOME: shell.userProfile,
    };
  } else if (targetPlatform === 'win32') {
    const winKnown = resolveHostWindowsKnownFolders({
      homedir,
      windowsKnownFolders: context.windowsKnownFolders,
      windowsRegistryOutput: context.windowsRegistryOutput,
      env: context.env,
    });
    placeholderMap = {
      INSTALL: installPath,
      DOCUMENTS: winKnown.documents,
      SAVED_GAMES: winKnown.savedGames,
      APPLICATION_DATA_LOCAL: winKnown.localAppData,
      LOCAL_APPLICATION_DATA: winKnown.localAppData,
      APPLICATION_DATA_LOCAL_LOW: winKnown.localLowAppData,
      APPLICATION_DATA_ROAMING: winKnown.roamingAppData,
      APPLICATION_DATA: winKnown.roamingAppData,
      APPLICATION_SUPPORT: winKnown.localAppData,
      HOME: winKnown.homedir,
    };
  } else {
    const macAppSupport = path.join(homedir, 'Library', 'Application Support');
    placeholderMap = {
      INSTALL: installPath,
      DOCUMENTS: path.join(homedir, 'Documents'),
      SAVED_GAMES: path.join(homedir, 'Saved Games'),
      APPLICATION_DATA_LOCAL: macAppSupport,
      LOCAL_APPLICATION_DATA: macAppSupport,
      APPLICATION_DATA_LOCAL_LOW: macAppSupport,
      APPLICATION_DATA_ROAMING: macAppSupport,
      APPLICATION_DATA: macAppSupport,
      APPLICATION_SUPPORT: macAppSupport,
      HOME: homedir,
    };
  }

  const resolvedList = [];
  for (const loc of locations) {
    if (!loc || typeof loc.location !== 'string' || !loc.location.trim()) continue;
    const rawTemplate = loc.location.trim();
    if (rawTemplate.includes('\0')) continue;

    // Require a valid leading root placeholder token (`<?TOKEN?>`)
    let effectiveTemplate = rawTemplate;
    let anchorTokenName = '';

    if (/^<\?APPLICATION_DATA_LOCAL\?>[\\/]+\.\.[\\/]+LocalLow(?:[\\/]|$)/i.test(effectiveTemplate)) {
      anchorTokenName = 'APPLICATION_DATA_LOCAL_LOW';
      effectiveTemplate = effectiveTemplate.replace(
        /^<\?APPLICATION_DATA_LOCAL\?>[\\/]+\.\.[\\/]+LocalLow/i,
        '<?APPLICATION_DATA_LOCAL_LOW?>'
      );
    } else if (
      /^<\?APPLICATION_DATA_LOCAL\?>[\\/]+\.\.[\\/]+Roaming(?:[\\/]|$)/i.test(effectiveTemplate)
    ) {
      anchorTokenName = 'APPLICATION_DATA_ROAMING';
      effectiveTemplate = effectiveTemplate.replace(
        /^<\?APPLICATION_DATA_LOCAL\?>[\\/]+\.\.[\\/]+Roaming/i,
        '<?APPLICATION_DATA_ROAMING?>'
      );
    } else {
      const rootMatch = effectiveTemplate.match(/^<\?([A-Z0-9_]+)\?>(?:[\\/]|$)/i);
      if (!rootMatch) {
        diagLog.warn(
          'cloudSave.gogMissingRootPlaceholder',
          'Rejected GOG cloud save location without valid leading placeholder token',
          { location: rawTemplate }
        );
        continue;
      }
      anchorTokenName = String(rootMatch[1] || '').toUpperCase();
    }

    if (anchorTokenName === 'INSTALL' && !installPath) {
      continue;
    }

    const rawAnchorRoot = placeholderMap[anchorTokenName];
    if (!rawAnchorRoot) {
      continue;
    }

    let missingToken = false;
    const expanded = effectiveTemplate.replace(/<\?([A-Z0-9_]+)\?>/gi, (full, tokenName) => {
      const upper = String(tokenName || '').toUpperCase();
      if (Object.prototype.hasOwnProperty.call(placeholderMap, upper) && placeholderMap[upper]) {
        return placeholderMap[upper];
      }
      missingToken = true;
      return full;
    });

    if (missingToken || /<\?[^?]+\?>/.test(expanded)) continue;
    const normalizedAnchor = normalizeResolvedCloudSavePath(
      rawAnchorRoot,
      targetPlatform,
      useCompatLayer
    );
    const resolvedPath = normalizeResolvedCloudSavePath(
      expanded,
      targetPlatform,
      useCompatLayer
    );
    if (!normalizedAnchor || !resolvedPath) continue;

    const containmentPlatform =
      /^[A-Za-z]:[\\/]/.test(normalizedAnchor) || normalizedAnchor.startsWith('\\\\')
        ? 'win32'
        : 'posix';
    if (!isContainedWithinRoot(normalizedAnchor, resolvedPath, containmentPlatform)) {
      diagLog.warn(
        'cloudSave.gogPathTraversalBlocked',
        'Blocked GOG cloud save location escaping placeholder root',
        { location: rawTemplate, normalizedAnchor, resolvedPath }
      );
      continue;
    }

    resolvedList.push({
      name: loc.name ? String(loc.name) : '__default',
      location: rawTemplate,
      resolvedPath,
    });
  }

  return resolvedList;
}

/**
 * Expand Epic Games CloudSaveFolder / CloudSaveFolder_MAC templates across Windows (honoring
 * OneDrive Known Folder redirection), macOS, and Wine/CrossOver bottles with strict path containment.
 */
function resolveEpicSavePathTemplate(template, context = {}) {
  if (!template || typeof template !== 'string' || !template.trim()) return '';
  const rawTrimmed = template.trim();
  if (rawTrimmed.includes('\0')) return '';

  const targetPlatform = context.platform || process.platform;
  const useCompatLayer = Boolean(context.useCompatLayer);
  const homedir = context.homedir || os.homedir();
  const installPath = context.installPath ? String(context.installPath) : '';
  const epicAccountId = context.epicAccountId ? String(context.epicAccountId) : '';

  if (epicAccountId && (/[\\/]/.test(epicAccountId) || epicAccountId.includes('..'))) {
    diagLog.warn('cloudSave.invalidEpicAccountId', 'Rejected unsafe Epic account ID segment', {
      epicAccountId,
    });
    return '';
  }

  let userDir;
  let userProfile;
  let appData;
  let appDataLocalLow;
  let appDataRoaming;
  let userSavedGames;
  let userLibrary;

  if (useCompatLayer && context.winePrefix) {
    const shell = readWinePrefixShellFolders(context.winePrefix);
    userDir = shell.documents;
    userProfile = shell.userProfile;
    appData = shell.appDataLocal;
    appDataLocalLow = shell.appDataLocalLow;
    appDataRoaming = shell.appDataRoaming;
    userSavedGames = shell.savedGames;
    userLibrary = shell.appDataLocal;
  } else if (targetPlatform === 'win32') {
    const winKnown = resolveHostWindowsKnownFolders({
      homedir,
      windowsKnownFolders: context.windowsKnownFolders,
      windowsRegistryOutput: context.windowsRegistryOutput,
      env: context.env,
    });
    userDir = winKnown.documents;
    userProfile =
      context.windowsKnownFolders?.userProfile ||
      (context.homedir ? winKnown.homedir : context.env?.USERPROFILE || winKnown.homedir);
    appData = winKnown.localAppData;
    appDataLocalLow = winKnown.localLowAppData;
    appDataRoaming = winKnown.roamingAppData;
    userSavedGames = winKnown.savedGames;
    userLibrary = winKnown.localAppData;
  } else {
    userDir = path.join(homedir, 'Documents');
    userProfile = homedir;
    appData = path.join(homedir, 'Library', 'Application Support');
    appDataLocalLow = appData;
    appDataRoaming = appData;
    userSavedGames = path.join(homedir, 'Saved Games');
    userLibrary = path.join(homedir, 'Library');
  }

  const rootTokenMap = {
    USERDIR: userDir,
    USERPROFILE: userProfile,
    APPDATA: appData,
    LOCALAPPDATA: appData,
    APPDATALOCALLOW: appDataLocalLow,
    ROAMINGAPPDATA: appDataRoaming,
    USERSAVEDGAMES: userSavedGames,
    USERLIBRARY: userLibrary,
    INSTALLDIR: installPath,
  };

  let effectiveTemplate = rawTrimmed;
  let anchorKey = '';
  let rewrittenDarwinAppDataParent = false;

  if (/^\{AppData\}[\\/]+\.\.[\\/]+LocalLow(?:[\\/]|$)/i.test(effectiveTemplate)) {
    anchorKey = 'APPDATALOCALLOW';
    effectiveTemplate = effectiveTemplate.replace(
      /^\{AppData\}[\\/]+\.\.[\\/]+LocalLow/i,
      '{AppDataLocalLow}'
    );
  } else if (/^\{AppData\}[\\/]+\.\.[\\/]+Roaming(?:[\\/]|$)/i.test(effectiveTemplate)) {
    anchorKey = 'ROAMINGAPPDATA';
    effectiveTemplate = effectiveTemplate.replace(
      /^\{AppData\}[\\/]+\.\.[\\/]+Roaming/i,
      '{RoamingAppData}'
    );
  } else if (
    targetPlatform === 'darwin' &&
    !useCompatLayer &&
    /^\{AppData\}[\\/]+\.\.(?:[\\/]+|$)/i.test(effectiveTemplate)
  ) {
    anchorKey = 'USERLIBRARY';
    rewrittenDarwinAppDataParent = true;
    effectiveTemplate = effectiveTemplate.replace(
      /^\{AppData\}[\\/]+\.\.(?:[\\/]+|$)/i,
      '{UserLibrary}/'
    );
  } else {
    const leadMatch = effectiveTemplate.match(/^\{([A-Za-z0-9_]+)\}(?:[\\/]|$)/);
    if (!leadMatch) {
      diagLog.warn(
        'cloudSave.epicMissingRootPlaceholder',
        'Rejected Epic save path template without valid leading placeholder token',
        { template: rawTrimmed }
      );
      return '';
    }
    anchorKey = String(leadMatch[1] || '').toUpperCase();
  }

  const rawAnchorRoot = rootTokenMap[anchorKey];
  if (!rawAnchorRoot) {
    return '';
  }

  let unresolved = false;
  const expanded = effectiveTemplate.replace(/\{([^}]+)\}/g, (full, tokenName) => {
    const upper = String(tokenName || '').trim().toUpperCase();
    if (upper === 'EPICID') {
      if (!epicAccountId) {
        unresolved = true;
        return full;
      }
      return epicAccountId;
    }
    if (Object.prototype.hasOwnProperty.call(rootTokenMap, upper) && rootTokenMap[upper]) {
      return rootTokenMap[upper];
    }
    unresolved = true;
    return full;
  });

  if (unresolved || /\{[^}]+\}/.test(expanded)) {
    return '';
  }

  const normalizedAnchor = normalizeResolvedCloudSavePath(
    rawAnchorRoot,
    targetPlatform,
    useCompatLayer
  );
  const resolvedPath = normalizeResolvedCloudSavePath(
    expanded,
    targetPlatform,
    useCompatLayer
  );
  if (!normalizedAnchor || !resolvedPath) return '';

  if (rewrittenDarwinAppDataParent && resolvedPath === normalizedAnchor) {
    diagLog.warn(
      'cloudSave.epicPathTraversalBlocked',
      'Blocked Epic save path template pointing directly at macOS Library root via {AppData}/..',
      { template: rawTrimmed, normalizedAnchor, resolvedPath }
    );
    return '';
  }

  const containmentPlatform =
    /^[A-Za-z]:[\\/]/.test(normalizedAnchor) || normalizedAnchor.startsWith('\\\\')
      ? 'win32'
      : 'posix';
  if (!isContainedWithinRoot(normalizedAnchor, resolvedPath, containmentPlatform)) {
    diagLog.warn(
      'cloudSave.epicPathTraversalBlocked',
      'Blocked Epic save path template escaping placeholder root',
      { template: rawTrimmed, normalizedAnchor, resolvedPath }
    );
    return '';
  }

  return resolvedPath;
}

/**
 * Verify that an Epic `CloudSaveFolder` template is structurally safe (starts with a known
 * root placeholder and cannot escape it via `..`) even before `{EpicID}` or `{InstallDir}` is known.
 */
function isSafeEpicSaveTemplateSyntax(template) {
  if (!template || typeof template !== 'string' || !template.trim()) return false;
  const probe = resolveEpicSavePathTemplate(template, {
    platform: 'darwin',
    useCompatLayer: false,
    homedir: '/probe_home',
    installPath: '/probe_install',
    epicAccountId: 'probe_epic_account_id',
  });
  return Boolean(probe);
}

/**
 * Prune `one_launcher_gog_cloud_configs.json` map to at most `maxEntries` (default 250) by LRU,
 * while preserving sanitized `__productClientIds` (capped at 500 entries) so cached per-game
 * GOG client IDs are never evicted as remote-config entries or poisoned with Galaxy's launcher ID.
 */
function pruneGogCloudConfigsMap(cachedMap, maxEntries = MAX_GOG_CLOUD_CONFIG_CACHE_ENTRIES) {
  if (!cachedMap || typeof cachedMap !== 'object') return {};

  let sanitizedProductIds = null;
  if (
    cachedMap.__productClientIds &&
    typeof cachedMap.__productClientIds === 'object' &&
    !Array.isArray(cachedMap.__productClientIds)
  ) {
    const validPairs = Object.entries(cachedMap.__productClientIds)
      .map(([prodId, rawClientId]) => [String(prodId || '').trim(), sanitizeGogGameClientId(rawClientId)])
      .filter(([prodId, cid]) => Boolean(prodId && cid));
    const cappedPairs =
      validPairs.length > MAX_GOG_PRODUCT_CLIENT_ID_CACHE_ENTRIES
        ? validPairs.slice(-MAX_GOG_PRODUCT_CLIENT_ID_CACHE_ENTRIES)
        : validPairs;
    sanitizedProductIds = Object.fromEntries(cappedPairs);
  }

  const entries = Object.entries(cachedMap).filter(
    ([k, v]) => k && k !== '__productClientIds' && v && typeof v === 'object' && !Array.isArray(v)
  );

  const pruned = {};
  if (sanitizedProductIds) {
    pruned.__productClientIds = sanitizedProductIds;
  }

  if (entries.length <= maxEntries) {
    for (const [k, v] of entries) {
      pruned[k] = v;
    }
    return pruned;
  }

  entries.sort((a, b) => {
    const tsA = Number(a[1].lastAccessedAt || a[1].fetchedAt || 0);
    const tsB = Number(b[1].lastAccessedAt || b[1].fetchedAt || 0);
    return tsB - tsA;
  });
  for (const [k, v] of entries.slice(0, maxEntries)) {
    pruned[k] = v;
  }
  return pruned;
}

/**
 * Prune per-game sync timestamps (`one_launcher_cloud_sync_timestamps.json`) when uninstalling a game
 * so reinstalling the game later performs a clean cloud pull instead of skipping on a stale timestamp.
 */
function applyPruneCloudSaveTimestampsData(data, platformId, cleanId) {
  let modified = false;
  if (!data || typeof data !== 'object') return false;
  if ((!platformId || platformId === 'gog') && data.gog && typeof data.gog === 'object') {
    const prefix = `${cleanId}:`;
    for (const key of Object.keys(data.gog)) {
      if (key === cleanId || key.startsWith(prefix)) {
        delete data.gog[key];
        modified = true;
      }
    }
  }
  if ((!platformId || platformId === 'epic') && data.epic && typeof data.epic === 'object') {
    for (const key of Object.keys(data.epic)) {
      if (key === cleanId || key.startsWith(`${cleanId}:`)) {
        delete data.epic[key];
        modified = true;
      }
    }
  }
  if ((!platformId || platformId === 'xbox') && data.xbox && typeof data.xbox === 'object') {
    for (const key of Object.keys(data.xbox)) {
      if (key === cleanId || key.startsWith(`${cleanId}:`)) {
        delete data.xbox[key];
        modified = true;
      }
    }
  }
  return modified;
}

function pruneCloudSaveStateForGame(payload = {}, userDataDir) {
  if (!userDataDir || typeof userDataDir !== 'string') return false;
  const platformId = String(payload.platformId || '').toLowerCase();
  const cleanId = String(payload.platformGameId || payload.gameId || '')
    .replace(/^(epic|gog|steam|xbox)[-_]/i, '')
    .trim();
  if (!cleanId) return false;

  let modified = false;
  const timestampsPath = path.join(userDataDir, 'one_launcher_cloud_sync_timestamps.json');
  try {
    if (fs.existsSync(timestampsPath)) {
      const data = JSON.parse(fs.readFileSync(timestampsPath, 'utf8')) || {};
      modified = applyPruneCloudSaveTimestampsData(data, platformId, cleanId);
      if (modified) {
        atomicWriteFileSync(timestampsPath, JSON.stringify(data, null, 2));
      }
    }
  } catch (err) {
    diagLog.warn('cloudSave.pruneTimestampsOnUninstall', err, { cleanId, platformId });
  }
  return modified;
}

async function pruneCloudSaveStateForGameAsync(payload = {}, userDataDir) {
  if (!userDataDir || typeof userDataDir !== 'string') return false;
  const platformId = String(payload.platformId || '').toLowerCase();
  const cleanId = String(payload.platformGameId || payload.gameId || '')
    .replace(/^(epic|gog|steam|xbox)[-_]/i, '')
    .trim();
  if (!cleanId) return false;

  const timestampsPath = path.join(userDataDir, 'one_launcher_cloud_sync_timestamps.json');
  return withCloudManifestFileLock(timestampsPath, async () => {
    let modified = false;
    try {
      if (fs.existsSync(timestampsPath)) {
        const data = JSON.parse(await fs.promises.readFile(timestampsPath, 'utf8')) || {};
        modified = applyPruneCloudSaveTimestampsData(data, platformId, cleanId);
        if (modified) {
          atomicWriteFileSync(timestampsPath, JSON.stringify(data, null, 2));
        }
      }
    } catch (err) {
      diagLog.warn('cloudSave.pruneTimestampsOnUninstallAsync', err, { cleanId, platformId });
    }
    return modified;
  });
}

/**
 * Build standardized Cloud Save Sync Telemetry event payload (`Point 5.3`).
 */
function buildCloudSyncTelemetryPayload({
  gameId,
  platformId,
  direction = 'post_exit',
  syncResult = null,
  isSteam = false,
}) {
  if (!gameId || !platformId || !syncResult || typeof syncResult !== 'object') {
    return null;
  }
  const timestamp = new Date().toISOString();
  const reason = syncResult.reason ? String(syncResult.reason) : '';

  if (isSteam) {
    if (syncResult.completed === false && reason === 'timeout') {
      return {
        gameId,
        platformId,
        status: 'cloud_sync_warning',
        event: 'cloud_sync_warning',
        cloudSync: {
          gameId,
          platformId,
          direction,
          synced: false,
          status: 'cloud_sync_warning',
          reason: 'timeout',
          backupPath: null,
          timestamp,
        },
      };
    }
    if (
      syncResult.completed === true &&
      (reason === 'cloud_sync_completed' || reason === 'cloud_log_settled')
    ) {
      return {
        gameId,
        platformId,
        event: 'cloud_sync_complete',
        cloudSync: {
          gameId,
          platformId,
          direction,
          synced: true,
          status: 'cloud_sync_complete',
          reason,
          backupPath: null,
          timestamp,
        },
      };
    }
    return null;
  }

  const extraTelemetry = {
    ...(syncResult.provider ? { provider: String(syncResult.provider) } : {}),
    ...(typeof syncResult.filesSynced === 'number' ? { filesSynced: syncResult.filesSynced } : {}),
    ...(typeof syncResult.bytesSynced === 'number' ? { bytesSynced: syncResult.bytesSynced } : {}),
  };

  if (syncResult.synced === true) {
    return {
      gameId,
      platformId,
      event: 'cloud_sync_complete',
      cloudSync: {
        gameId,
        platformId,
        direction,
        synced: true,
        status: 'cloud_sync_complete',
        ...(reason ? { reason } : {}),
        ...extraTelemetry,
        backupPath: syncResult.backupPath || null,
        timestamp,
      },
    };
  }

  if (syncResult.synced === false) {
    if (!reason || BENIGN_CLOUD_SYNC_SKIP_REASONS.has(reason)) {
      return null;
    }
    return {
      gameId,
      platformId,
      status: 'cloud_sync_warning',
      event: 'cloud_sync_warning',
      cloudSync: {
        gameId,
        platformId,
        direction,
        synced: false,
        status: 'cloud_sync_warning',
        reason,
        ...extraTelemetry,
        backupPath: syncResult.backupPath || null,
        timestamp,
      },
    };
  }

  return null;
}

/**
 * Factory creating `syncGogCloudSaves`, `syncEpicCloudSaves`, and `waitForSteamCloudSyncCompletion`
 * wired to the launcher engine's binary/auth resolvers.
 */
function createCloudSaveRunner(deps) {
  const {
    resolveIsolatedHomedirAndUserData,
    isTestEnvironment,
    fetchGogV1Json,
    findGogdlBinary,
    ensureGogdlAuthConfig,
    resolveEpicAppAndPlatforms,
    ensureLegendaryConfigAndAuth,
    getLegendaryConfigDir,
    collectLocalEpicMetadataAndSupport,
    findLegendaryBinary,
  } = deps;

  async function syncGogCloudSaves(payload = {}, mode = 'both', options = {}) {
    try {
      if (payload.platformId !== 'gog') {
        return { synced: false, mode, reason: 'invalid_platform' };
      }
      const gameId = String(payload.platformGameId || payload.gameId || '')
        .replace(/^gog[-_]/i, '')
        .trim();
      if (!gameId) {
        return { synced: false, mode, reason: 'missing_game_id' };
      }

      const { homedir, userDataDir } = resolveIsolatedHomedirAndUserData(options);
      const targetPlatform = options.platform || process.platform;
      const useCompatLayer = Boolean(options.useCompatLayer || payload.useCompatLayer);
      const useWindowsLocations = targetPlatform === 'win32' || useCompatLayer;
      const installPath = String(payload.installPath || options.installPath || '').trim();
      const effectiveFetchImpl =
        typeof options.fetchImpl === 'function'
          ? options.fetchImpl
          : typeof options.fetchFn === 'function'
            ? options.fetchFn
            : undefined;
      const canUseNetwork =
        !isTestEnvironment(options) ||
        Boolean(effectiveFetchImpl) ||
        options.allowNetworkInTest === true;
      const hasRemoteConfigOverride = Boolean(
        options.gogRemoteConfigOverride && typeof options.gogRemoteConfigOverride === 'object'
      );

      const configCachePath = path.join(userDataDir, 'one_launcher_gog_cloud_configs.json');
      let cachedMap = {};
      try {
        if (fs.existsSync(configCachePath)) {
          cachedMap = JSON.parse(await fs.promises.readFile(configCachePath, 'utf8')) || {};
        }
      } catch (cacheReadErr) {
        diagLog.warn('cloudSave.gogReadConfigCache', cacheReadErr, { configCachePath });
      }

      // 1. Discover per-game GOG clientId (rejecting poisoned GOG_GALAXY_LAUNCHER_CLIENT_ID)
      let clientId = sanitizeGogGameClientId(
        options.gogClientId || payload.gogClientId || '',
        hasRemoteConfigOverride
      );

      if (!clientId && installPath && fs.existsSync(installPath)) {
        const candidateInfoPaths = [
          path.join(installPath, `goggame-${gameId}.info`),
          path.join(installPath, `.goggame-${gameId}.info`),
          path.join(installPath, 'Contents', 'Resources', `goggame-${gameId}.info`),
          path.join(installPath, 'Contents', 'Resources', `.goggame-${gameId}.info`),
        ];
        try {
          if (
            fs.statSync(installPath).isDirectory() &&
            !installPath.toLowerCase().endsWith('.app')
          ) {
            const entries = fs.readdirSync(installPath, { withFileTypes: true });
            for (const entry of entries) {
              if (entry.isDirectory() && entry.name.toLowerCase().endsWith('.app')) {
                candidateInfoPaths.push(
                  path.join(
                    installPath,
                    entry.name,
                    'Contents',
                    'Resources',
                    `goggame-${gameId}.info`
                  ),
                  path.join(
                    installPath,
                    entry.name,
                    'Contents',
                    'Resources',
                    `.goggame-${gameId}.info`
                  )
                );
              }
            }
          }
        } catch (dirErr) {
          diagLog.debug('cloudSave.gogScanInstallDir', dirErr, { installPath });
        }
        const parentDir = path.dirname(installPath);
        if (parentDir && parentDir !== installPath) {
          candidateInfoPaths.push(
            path.join(parentDir, `goggame-${gameId}.info`),
            path.join(parentDir, `.goggame-${gameId}.info`)
          );
        }

        for (const infoPath of candidateInfoPaths) {
          if (!infoPath || !fs.existsSync(infoPath)) continue;
          try {
            const parsedInfo = JSON.parse(await fs.promises.readFile(infoPath, 'utf8'));
            const candidateClientId = sanitizeGogGameClientId(
              parsedInfo?.clientId,
              hasRemoteConfigOverride
            );
            if (candidateClientId) {
              clientId = candidateClientId;
              break;
            }
          } catch (infoErr) {
            diagLog.warn('cloudSave.gogParseInfoJson', infoErr, { infoPath });
          }
        }
      }

      if (!clientId && cachedMap?.__productClientIds && typeof cachedMap.__productClientIds === 'object') {
        const cachedClientId = sanitizeGogGameClientId(
          cachedMap.__productClientIds[gameId],
          false
        );
        if (cachedClientId) {
          clientId = cachedClientId;
        }
      }

      if (!clientId && canUseNetwork) {
        const primaryOs = useWindowsLocations ? 'windows' : 'osx';
        const fallbackOs = primaryOs === 'osx' ? 'windows' : 'osx';
        const osCandidates = [primaryOs, fallbackOs];
        const generations = [2, 1];

        for (const gen of generations) {
          if (clientId) break;
          for (const osCandidate of osCandidates) {
            if (clientId) break;
            const buildsUrl = `https://content-system.gog.com/products/${encodeURIComponent(gameId)}/os/${osCandidate}/builds?generation=${gen}`;
            const buildsJson = await fetchGogV1Json(buildsUrl, {}, 8000, effectiveFetchImpl);
            if (!buildsJson || typeof buildsJson !== 'object') continue;

            const directCandidates = [
              ...(Array.isArray(buildsJson.items) ? buildsJson.items.map((it) => it?.clientId) : []),
              buildsJson.clientId,
              buildsJson.product?.clientId,
            ];
            for (const rawCid of directCandidates) {
              const cleaned = sanitizeGogGameClientId(rawCid, false);
              if (cleaned) {
                clientId = cleaned;
                break;
              }
            }

            if (!clientId && buildsJson?.items?.[0]?.link) {
              const repoJson = await fetchGogV1Json(
                buildsJson.items[0].link,
                {},
                8000,
                effectiveFetchImpl
              );
              const repoCid = sanitizeGogGameClientId(
                repoJson?.clientId || repoJson?.product?.clientId,
                false
              );
              if (repoCid) {
                clientId = repoCid;
              }
            }
          }
        }

        if (clientId) {
          try {
            await withCloudManifestFileLock(configCachePath, async () => {
              let freshMap = {};
              try {
                if (fs.existsSync(configCachePath)) {
                  freshMap = JSON.parse(await fs.promises.readFile(configCachePath, 'utf8')) || {};
                }
              } catch {}
              if (!freshMap.__productClientIds || typeof freshMap.__productClientIds !== 'object') {
                freshMap.__productClientIds = {};
              }
              freshMap.__productClientIds[gameId] = clientId;
              const pruned = pruneGogCloudConfigsMap(freshMap, MAX_GOG_CLOUD_CONFIG_CACHE_ENTRIES);
              cachedMap = pruned;
              atomicWriteFileSync(configCachePath, JSON.stringify(pruned, null, 2));
            });
          } catch (prodCacheErr) {
            diagLog.warn('cloudSave.gogWriteProductClientIdCache', prodCacheErr, {
              configCachePath,
              gameId,
            });
          }
        }
      }

      if (!clientId) {
        return { synced: false, gameId, mode, reason: 'missing_client_id' };
      }

      // 2. Fetch or read cached remote-config (7-day TTL, 250-entry LRU cap)
      const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
      let remoteConfig = options.gogRemoteConfigOverride || null;

      if (!remoteConfig) {
        const cachedEntry = cachedMap[clientId];
        if (
          cachedEntry &&
          cachedEntry.config &&
          typeof cachedEntry.fetchedAt === 'number' &&
          Date.now() - cachedEntry.fetchedAt < SEVEN_DAYS_MS
        ) {
          remoteConfig = cachedEntry.config;
          const accessedAt = Date.now();
          cachedEntry.lastAccessedAt = accessedAt;
          if (Object.keys(cachedMap).length > MAX_GOG_CLOUD_CONFIG_CACHE_ENTRIES) {
            try {
              await withCloudManifestFileLock(configCachePath, async () => {
                let freshMap = {};
                try {
                  if (fs.existsSync(configCachePath)) {
                    freshMap =
                      JSON.parse(await fs.promises.readFile(configCachePath, 'utf8')) || {};
                  }
                } catch {}
                if (freshMap[clientId] && typeof freshMap[clientId] === 'object') {
                  freshMap[clientId].lastAccessedAt = accessedAt;
                } else {
                  freshMap[clientId] = cachedEntry;
                }
                const pruned = pruneGogCloudConfigsMap(
                  freshMap,
                  MAX_GOG_CLOUD_CONFIG_CACHE_ENTRIES
                );
                cachedMap = pruned;
                atomicWriteFileSync(configCachePath, JSON.stringify(pruned, null, 2));
              });
            } catch (pruneErr) {
              diagLog.warn('cloudSave.gogPruneConfigCache', pruneErr, { configCachePath });
            }
          }
        } else if (canUseNetwork) {
          const rcUrl = `https://remote-config.gog.com/components/galaxy_client/clients/${encodeURIComponent(clientId)}?component_version=2.0.45`;
          const fetched = await fetchGogV1Json(rcUrl, {}, 8000, effectiveFetchImpl);
          if (fetched && typeof fetched === 'object') {
            remoteConfig = fetched;
            try {
              const now = Date.now();
              await withCloudManifestFileLock(configCachePath, async () => {
                let freshMap = {};
                try {
                  if (fs.existsSync(configCachePath)) {
                    freshMap =
                      JSON.parse(await fs.promises.readFile(configCachePath, 'utf8')) || {};
                  }
                } catch {}
                freshMap[clientId] = {
                  fetchedAt: now,
                  lastAccessedAt: now,
                  config: fetched,
                };
                const pruned = pruneGogCloudConfigsMap(
                  freshMap,
                  MAX_GOG_CLOUD_CONFIG_CACHE_ENTRIES
                );
                cachedMap = pruned;
                atomicWriteFileSync(configCachePath, JSON.stringify(pruned, null, 2));
              });
            } catch (cacheWriteErr) {
              diagLog.warn('cloudSave.gogWriteConfigCache', cacheWriteErr, { configCachePath });
            }
          } else if (cachedEntry && cachedEntry.config) {
            remoteConfig = cachedEntry.config;
          }
        }
      }

      if (!remoteConfig || typeof remoteConfig !== 'object') {
        return { synced: false, gameId, clientId, mode, reason: 'no_cloud_saves_configured' };
      }

      const contentRoot =
        remoteConfig.content && typeof remoteConfig.content === 'object'
          ? remoteConfig.content
          : remoteConfig;
      const osSection = useWindowsLocations
        ? contentRoot.Windows || contentRoot.windows
        : contentRoot.MacOS || contentRoot.macOS || contentRoot.OSX || contentRoot.osx;
      const cloudStorage = osSection?.cloudStorage;
      const rawLocations = Array.isArray(cloudStorage?.locations) ? cloudStorage.locations : [];

      if (!cloudStorage?.enabled && rawLocations.length === 0) {
        return { synced: false, gameId, clientId, mode, reason: 'no_cloud_saves_configured' };
      }

      const effectiveLocations =
        rawLocations.length > 0
          ? rawLocations
          : [
              {
                name: '__default',
                location: `<?APPLICATION_DATA_LOCAL?>/GOG.com/Galaxy/Applications/${clientId}/Storage/Shared/Files`,
              },
            ];

      const resolvedLocations = resolveGogCloudSaveLocations(effectiveLocations, {
        platform: targetPlatform,
        useCompatLayer,
        winePrefix: options.winePrefix || payload.winePrefix,
        installPath,
        homedir,
        clientId,
        windowsKnownFolders: options.windowsKnownFolders,
        windowsRegistryOutput: options.windowsRegistryOutput,
        env: options.env,
      });

      if (resolvedLocations.length === 0) {
        return { synced: false, gameId, clientId, mode, reason: 'no_resolvable_save_locations' };
      }

      // 3. Resolve gogdl binary & authConfigPath
      const gogdlBin = options.gogdlBinaryPath || findGogdlBinary(options);
      let authConfigPath = options.gogAuthConfigPath || null;
      if (!authConfigPath) {
        const authInfo = await ensureGogdlAuthConfig(options);
        if (authInfo && authInfo.authenticated && authInfo.gogAuthPath) {
          authConfigPath = authInfo.gogAuthPath;
        }
      }

      if (!gogdlBin || !authConfigPath) {
        return { synced: false, gameId, clientId, mode, reason: 'missing_gogdl_or_auth' };
      }

      // 4. Load per-location sync timestamps and execute gogdl save-sync with tree-kill timeout
      const timestampsPath = path.join(userDataDir, 'one_launcher_cloud_sync_timestamps.json');
      let timestampsData = {};
      try {
        if (fs.existsSync(timestampsPath)) {
          timestampsData = JSON.parse(await fs.promises.readFile(timestampsPath, 'utf8')) || {};
        }
      } catch (tsErr) {
        diagLog.warn('cloudSave.gogReadTimestamps', tsErr, { timestampsPath });
      }
      if (!timestampsData.gog || typeof timestampsData.gog !== 'object') {
        timestampsData.gog = {};
      }

      const backupQuotaOpts = {
        maxTotalBackupBytes: options.maxTotalBackupBytes,
        maxSnapshotsPerGame: options.maxSnapshotsPerGame,
        userDataDir,
        backupsRootDir: options.backupsRootDir,
        platform: targetPlatform,
        getWin32FileAttributes: options.getWin32FileAttributes,
        oneDriveAttribExecImpl: options.oneDriveAttribExecImpl,
        forceOneDriveCheck: options.forceOneDriveCheck,
      };

      const syncedLocations = [];
      const updatedTimestampDeltas = {};
      let anySuccess = false;
      let lastFailureReason = '';
      let lastBackupPath = null;
      const syncTimeoutMs = Number(options.cloudSyncTimeoutMs || 60000);

      for (const loc of resolvedLocations) {
        if (isBroadOneDriveKnownFolderRoot(loc.resolvedPath)) {
          diagLog.warn(
            'cloudSave.gogBroadOneDriveRootBlocked',
            'Blocked GOG cloud save sync on broad OneDrive Known Folder root without game subfolder',
            { gameId, resolvedPath: loc.resolvedPath }
          );
          lastFailureReason = 'broad_known_folder_root_blocked';
          continue;
        }

        const placeholderCheck = await inspectOneDrivePlaceholderStateAsync(
          loc.resolvedPath,
          backupQuotaOpts
        );
        if (placeholderCheck.hasPlaceholders) {
          diagLog.warn(
            'cloudSave.gogOneDrivePlaceholderSkipped',
            'Skipped GOG cloud save sync on unhydrated OneDrive Files On-Demand placeholder files',
            {
              gameId,
              resolvedPath: loc.resolvedPath,
              sampleFiles: placeholderCheck.placeholderFiles.slice(0, 5),
            }
          );
          lastFailureReason = 'onedrive_cloud_placeholder_skipped';
          continue;
        }

        const locKey = `${gameId}:${useWindowsLocations ? 'windows' : 'osx'}:${loc.name}`;
        const lastTs = Number(timestampsData.gog[locKey] || 0) || 0;
        const hostLocPath = toHostFilesystemPath(loc.resolvedPath);
        const hygiene = purgeOsMetadataAndCountRealFilesSync(hostLocPath);

        if (mode === 'pre_launch' || mode === 'both') {
          const safeLocName = String(loc.name || '__default').replace(/[^a-zA-Z0-9_-]/g, '_');
          const backupRoot = path.join(
            userDataDir,
            'cloud_save_backups',
            'gog',
            String(gameId),
            safeLocName
          );
          const backupRes = await createCloudSaveRollingBackupAsync(
            hostLocPath,
            backupRoot,
            Number(options.maxBackupBytes) > 0
              ? Number(options.maxBackupBytes)
              : resolveDefaultPerSnapshotMaxBackupBytes(options),
            backupQuotaOpts
          );
          if (backupRes?.backupPath) {
            lastBackupPath = backupRes.backupPath;
          }
          try {
            await fs.promises.mkdir(hostLocPath, { recursive: true });
          } catch (mkdirErr) {
            diagLog.warn('cloudSave.gogMkdirSaveDir', mkdirErr, { path: loc.resolvedPath });
          }
        } else if (!fs.existsSync(hostLocPath) || hygiene.realFileCount === 0) {
          continue;
        }

        const syncArgs = [
          '--auth-config-path',
          authConfigPath,
          'save-sync',
          loc.resolvedPath,
          String(gameId),
          '--ts',
          String(lastTs),
          '--os',
          useWindowsLocations ? 'windows' : 'osx',
        ];
        if (loc.name && loc.name !== '__default') {
          syncArgs.push('--name', loc.name);
        }
        if (mode === 'pre_launch') {
          syncArgs.push('--skip-upload');
        } else if (mode === 'post_exit') {
          syncArgs.push('--skip-download');
        }

        const execRes = await execCliWithTreeTimeout(
          gogdlBin,
          syncArgs,
          {
            env: {
              ...process.env,
              ...(useCompatLayer && options.winePrefix ? { WINEPREFIX: options.winePrefix } : {}),
            },
            timeout: syncTimeoutMs,
          },
          options
        );

        const combinedOutput = `${execRes.stdout}\n${execRes.stderr}`.trim();
        if (!execRes.err) {
          let updatedTs = Math.floor(Date.now() / 1000);
          const tsMatches = Array.from(combinedOutput.matchAll(/\b(1[6-9]\d{8}|2\d{9})\b/g));
          if (tsMatches.length > 0) {
            const parsedCandidate = Number(tsMatches[tsMatches.length - 1][1]);
            if (Number.isFinite(parsedCandidate) && parsedCandidate > 0) {
              updatedTs = parsedCandidate;
            }
          } else {
            const trimmedLines = combinedOutput
              .split(/\r?\n/)
              .map((l) => l.trim())
              .filter(Boolean);
            const lastLine = trimmedLines[trimmedLines.length - 1] || '';
            if (/^\d+(\.\d+)?$/.test(lastLine)) {
              const numericLine = Math.floor(Number(lastLine));
              if (numericLine > 0) updatedTs = numericLine;
            }
          }
          timestampsData.gog[locKey] = updatedTs;
          updatedTimestampDeltas[locKey] = updatedTs;
          anySuccess = true;
          syncedLocations.push({
            name: loc.name,
            resolvedPath: loc.resolvedPath,
            args: syncArgs,
            timestamp: updatedTs,
          });
        } else {
          lastFailureReason =
            combinedOutput || execRes.err.message || 'gogdl_save_sync_failed';
          diagLog.warn('cloudSave.gogSyncFailed', lastFailureReason, {
            gameId,
            mode,
            location: loc.name,
          });
        }
      }

      if (anySuccess) {
        try {
          await withCloudManifestFileLock(timestampsPath, async () => {
            let freshTimestamps = {};
            try {
              if (fs.existsSync(timestampsPath)) {
                freshTimestamps =
                  JSON.parse(await fs.promises.readFile(timestampsPath, 'utf8')) || {};
              }
            } catch {}
            if (!freshTimestamps.gog || typeof freshTimestamps.gog !== 'object') {
              freshTimestamps.gog = {};
            }
            for (const [k, v] of Object.entries(updatedTimestampDeltas)) {
              freshTimestamps.gog[k] = v;
            }
            atomicWriteFileSync(timestampsPath, JSON.stringify(freshTimestamps, null, 2));
          });
        } catch (tsWriteErr) {
          diagLog.warn('cloudSave.gogWriteTimestamps', tsWriteErr, { timestampsPath });
        }
        return {
          synced: true,
          gameId,
          clientId,
          mode,
          locations: syncedLocations,
          ...(lastBackupPath ? { backupPath: lastBackupPath } : {}),
        };
      }

      return {
        synced: false,
        gameId,
        clientId,
        mode,
        reason: lastFailureReason || 'nothing_to_sync',
        ...(lastBackupPath ? { backupPath: lastBackupPath } : {}),
      };
    } catch (err) {
      diagLog.warn('cloudSave.gogUnhandled', err, { mode });
      return {
        synced: false,
        mode,
        reason: err && err.message ? err.message : 'gog_sync_failed',
      };
    }
  }

  async function syncEpicCloudSaves(payload = {}, mode = 'both', options = {}) {
    try {
      let appName = '';
      try {
        const resolved = resolveEpicAppAndPlatforms(payload, options);
        if (resolved && resolved.appName) {
          appName = String(resolved.appName).trim();
        }
      } catch (resolveErr) {
        diagLog.debug('cloudSave.epicResolveApp', resolveErr);
      }
      if (!appName) {
        appName = String(payload.appName || payload.platformGameId || payload.gameId || '')
          .replace(/^epic[-_]/i, '')
          .trim();
      }
      if (!appName) {
        return { synced: false, appName: '', mode, reason: 'missing_app_name' };
      }

      const canRunSync =
        (!isTestEnvironment(options) && !options.skipCloudSaveSync) ||
        typeof options.execFileImpl === 'function' ||
        typeof options.execFileFn === 'function' ||
        options.allowCloudSaveSyncInTest === true;

      if (
        canRunSync &&
        !options.skipAuthRefresh &&
        !options.legendaryConfigDir &&
        !options.legendaryConfigPath
      ) {
        try {
          await ensureLegendaryConfigAndAuth(options);
        } catch (authErr) {
          diagLog.warn('cloudSave.epicEnsureAuth', authErr, { appName });
        }
      }

      const targetPlatform = options.platform || process.platform;
      const useCompatLayer = Boolean(options.useCompatLayer || payload.useCompatLayer);
      const winePrefix = options.winePrefix || payload.winePrefix || '';
      const installPath = String(payload.installPath || options.installPath || '').trim();
      const { homedir, userDataDir } = resolveIsolatedHomedirAndUserData(options);

      let hasCloudSaveFolder = Boolean(options.forceCloudSaveSync === true);
      let cloudSaveFolderTemplate = String(options.cloudSaveFolderTemplate || '').trim();
      if (cloudSaveFolderTemplate) {
        hasCloudSaveFolder = true;
      }

      const legCfgDir = getLegendaryConfigDir(options);
      if (!cloudSaveFolderTemplate) {
        const candidateMetaFiles = new Set();
        if (legCfgDir) {
          candidateMetaFiles.add(path.join(legCfgDir, 'metadata', `${appName}.json`));
          candidateMetaFiles.add(path.join(legCfgDir, 'legendary', 'metadata', `${appName}.json`));
        }
        try {
          const localSupport = collectLocalEpicMetadataAndSupport(options);
          if (localSupport && Array.isArray(localSupport.configDirs)) {
            for (const dir of localSupport.configDirs) {
              candidateMetaFiles.add(path.join(dir, 'metadata', `${appName}.json`));
            }
          }
        } catch (metaScanErr) {
          diagLog.debug('cloudSave.epicLocalSupport', metaScanErr, { appName });
        }

        for (const metaPath of candidateMetaFiles) {
          if (!metaPath || !fs.existsSync(metaPath)) continue;
          try {
            const parsed = JSON.parse(await fs.promises.readFile(metaPath, 'utf8'));
            const attrs =
              parsed?.metadata?.customAttributes || parsed?.customAttributes || {};
            const folderVal =
              targetPlatform === 'darwin' && !useCompatLayer
                ? attrs?.CloudSaveFolder_MAC?.value ||
                  attrs?.CloudSaveFolder_Mac?.value ||
                  attrs?.CloudSaveFolder?.value ||
                  ''
                : attrs?.CloudSaveFolder?.value ||
                  attrs?.CloudSaveFolder_MAC?.value ||
                  attrs?.CloudSaveFolder_Mac?.value ||
                  '';
            if (typeof folderVal === 'string' && folderVal.trim()) {
              hasCloudSaveFolder = true;
              cloudSaveFolderTemplate = folderVal.trim();
              break;
            }
          } catch (metaReadErr) {
            diagLog.warn('cloudSave.epicReadMetadataJson', metaReadErr, { metaPath });
          }
        }
      }

      if (!hasCloudSaveFolder) {
        return {
          synced: false,
          appName,
          mode,
          reason: 'no_cloud_save_folder_or_skipped',
        };
      }

      if (cloudSaveFolderTemplate && !isSafeEpicSaveTemplateSyntax(cloudSaveFolderTemplate)) {
        diagLog.warn(
          'cloudSave.epicUnsafeTemplateRejected',
          'Rejected Epic cloud save sync due to unsafe CloudSaveFolder template',
          { appName, cloudSaveFolderTemplate }
        );
        return {
          synced: false,
          appName,
          mode,
          cloudSaveFolder: cloudSaveFolderTemplate,
          reason: 'unsafe_cloud_save_path_rejected',
        };
      }

      if (!canRunSync) {
        return {
          synced: false,
          appName,
          mode,
          cloudSaveFolder: cloudSaveFolderTemplate || null,
          reason: 'skipped_in_test',
        };
      }

      const legendaryBin =
        options.legendaryBinaryPath ||
        findLegendaryBinary(options) ||
        (typeof options.execFileImpl === 'function' || typeof options.execFileFn === 'function'
          ? 'legendary'
          : null);
      if (!legendaryBin) {
        return {
          synced: false,
          appName,
          mode,
          reason: 'legendary_binary_not_found',
        };
      }

      let epicAccountId = String(options.epicAccountId || payload.epicAccountId || '').trim();
      if (!epicAccountId && legCfgDir) {
        const userJsonCandidates = [
          path.join(legCfgDir, 'user.json'),
          path.join(legCfgDir, 'legendary', 'user.json'),
        ];
        for (const uj of userJsonCandidates) {
          if (!fs.existsSync(uj)) continue;
          try {
            const parsedUser = JSON.parse(await fs.promises.readFile(uj, 'utf8'));
            if (parsedUser && parsedUser.account_id) {
              epicAccountId = String(parsedUser.account_id).trim();
              break;
            }
          } catch (ujErr) {
            diagLog.debug('cloudSave.epicReadUserJson', ujErr, { uj });
          }
        }
      }

      const legEnv = {
        ...process.env,
        ...(options.env || {}),
        LC_ALL: normalizePosixUtf8Locale(options.env?.LC_ALL ?? process.env.LC_ALL),
        LANG: normalizePosixUtf8Locale(options.env?.LANG ?? process.env.LANG),
        ...(legCfgDir ? { LEGENDARY_CONFIG_PATH: legCfgDir } : {}),
        ...(useCompatLayer && winePrefix ? { WINEPREFIX: winePrefix } : {}),
      };

      // Official Epic Games Launcher auto-import into Legendary installed.json when missing,
      // recording the external import in `one_launcher_epic_imports.json` so Windows uninstaller never deletes it!
      if (installPath && fs.existsSync(installPath) && legCfgDir) {
        let isRegisteredInLegendary = false;
        const installedJsonCandidates = [
          path.join(legCfgDir, 'installed.json'),
          path.join(legCfgDir, 'legendary', 'installed.json'),
        ];
        for (const instPath of installedJsonCandidates) {
          if (!fs.existsSync(instPath)) continue;
          try {
            const installedMap = JSON.parse(await fs.promises.readFile(instPath, 'utf8'));
            if (installedMap && typeof installedMap === 'object' && installedMap[appName]) {
              isRegisteredInLegendary = true;
              break;
            }
          } catch (instErr) {
            diagLog.warn('cloudSave.epicReadInstalledJson', instErr, { instPath });
          }
        }

        if (!isRegisteredInLegendary) {
          const importPlatform = useCompatLayer || targetPlatform === 'win32' ? 'Windows' : 'Mac';
          const importRes = await execCliWithTreeTimeout(
            legendaryBin,
            ['import', appName, installPath, '--platform', importPlatform, '--disable-check', '-y'],
            { env: legEnv, timeout: 15000 },
            options
          );
          if (!importRes.err) {
            recordImportedEpicInstall(appName, installPath, options);
          } else {
            diagLog.warn('cloudSave.epicImportFailed', importRes.err, { appName, installPath });
          }
        }
      }

      const resolvedSavePath = cloudSaveFolderTemplate
        ? resolveEpicSavePathTemplate(cloudSaveFolderTemplate, {
            platform: targetPlatform,
            useCompatLayer,
            winePrefix,
            installPath,
            epicAccountId,
            homedir,
            windowsKnownFolders: options.windowsKnownFolders,
            windowsRegistryOutput: options.windowsRegistryOutput,
            env: options.env,
          })
        : '';
      const hasCompleteResolvedSavePath =
        Boolean(resolvedSavePath) && !/\{[^}]+\}/.test(resolvedSavePath);

      const backupQuotaOpts = {
        maxTotalBackupBytes: options.maxTotalBackupBytes,
        maxSnapshotsPerGame: options.maxSnapshotsPerGame,
        userDataDir,
        backupsRootDir: options.backupsRootDir,
        platform: targetPlatform,
        getWin32FileAttributes: options.getWin32FileAttributes,
        oneDriveAttribExecImpl: options.oneDriveAttribExecImpl,
        forceOneDriveCheck: options.forceOneDriveCheck,
      };

      if (hasCompleteResolvedSavePath && isBroadOneDriveKnownFolderRoot(resolvedSavePath)) {
        diagLog.warn(
          'cloudSave.epicBroadOneDriveRootBlocked',
          'Blocked Epic cloud save sync on broad OneDrive Known Folder root without game subfolder',
          { appName, resolvedSavePath }
        );
        return {
          synced: false,
          appName,
          mode,
          cloudSaveFolder: cloudSaveFolderTemplate || null,
          resolvedSavePath,
          reason: 'broad_known_folder_root_blocked',
        };
      }

      const execMockFn =
        typeof options.execFileImpl === 'function'
          ? options.execFileImpl
          : typeof options.execFileFn === 'function'
            ? options.execFileFn
            : null;
      const hostResolvedSavePath = resolvedSavePath
        ? toHostFilesystemPath(resolvedSavePath)
        : '';
      const saveDirExistsBefore =
        hasCompleteResolvedSavePath &&
        Boolean(hostResolvedSavePath) &&
        fs.existsSync(hostResolvedSavePath);

      if (saveDirExistsBefore) {
        const placeholderCheck = await inspectOneDrivePlaceholderStateAsync(
          hostResolvedSavePath,
          backupQuotaOpts
        );
        if (placeholderCheck.hasPlaceholders) {
          diagLog.warn(
            'cloudSave.epicOneDrivePlaceholderSkipped',
            'Skipped Epic cloud save sync on unhydrated OneDrive Files On-Demand placeholder files',
            {
              appName,
              resolvedSavePath,
              sampleFiles: placeholderCheck.placeholderFiles.slice(0, 5),
            }
          );
          return {
            synced: false,
            appName,
            mode,
            cloudSaveFolder: cloudSaveFolderTemplate || null,
            resolvedSavePath,
            reason: 'onedrive_cloud_placeholder_skipped',
            placeholderFiles: placeholderCheck.placeholderFiles,
          };
        }
      }

      let realFileCount = 0;
      if (saveDirExistsBefore) {
        const hygiene = purgeOsMetadataAndCountRealFilesSync(hostResolvedSavePath);
        realFileCount = hygiene.realFileCount;
      }

      if (mode === 'post_exit' && hasCompleteResolvedSavePath) {
        const hadPureVirtualMockPreLaunch = Boolean(
          execMockFn &&
            !saveDirExistsBefore &&
            options.enforceEmptySaveGuard !== true &&
            virtualMockPreLaunchByExecFn.get(execMockFn)?.has(appName)
        );
        if ((!saveDirExistsBefore || realFileCount === 0) && !hadPureVirtualMockPreLaunch) {
          return {
            synced: false,
            appName,
            mode,
            cloudSaveFolder: cloudSaveFolderTemplate || null,
            resolvedSavePath,
            reason: 'nothing_to_sync',
          };
        }
      }

      let backupPath = null;
      if ((mode === 'pre_launch' || mode === 'both') && hasCompleteResolvedSavePath) {
        const safeAppName = appName.replace(/[^a-zA-Z0-9_-]/g, '_');
        const backupRoot = path.join(userDataDir, 'cloud_save_backups', 'epic', safeAppName);
        const backupRes = await createCloudSaveRollingBackupAsync(
          hostResolvedSavePath,
          backupRoot,
          Number(options.maxBackupBytes) > 0
            ? Number(options.maxBackupBytes)
            : resolveDefaultPerSnapshotMaxBackupBytes(options),
          backupQuotaOpts
        );
        if (backupRes?.backupPath) {
          backupPath = backupRes.backupPath;
        }
      }

      const syncArgs = ['sync-saves', appName, '-y'];
      if (mode === 'pre_launch') {
        syncArgs.push('--skip-upload');
      } else if (mode === 'post_exit') {
        syncArgs.push('--skip-download');
      }
      if (hasCompleteResolvedSavePath) {
        syncArgs.push('--save-path', resolvedSavePath);
      }

      const syncTimeoutMs = Number(options.cloudSyncTimeoutMs || 60000);
      const execRes = await execCliWithTreeTimeout(
        legendaryBin,
        syncArgs,
        {
          env: legEnv,
          timeout: syncTimeoutMs,
        },
        options
      );

      const combinedOutput = `${execRes.stdout}\n${execRes.stderr}`.trim();
      if (
        execRes.err ||
        /skipping due to --yes|Game\s+.*not\s+installed|not\s+installed|does not support cloud saves/i.test(
          combinedOutput
        )
      ) {
        const failReason = combinedOutput || execRes.err?.message || 'sync_saves_failed';
        diagLog.warn('cloudSave.epicSyncFailed', failReason, { appName, mode });
        return {
          synced: false,
          appName,
          mode,
          args: syncArgs,
          cloudSaveFolder: cloudSaveFolderTemplate || null,
          resolvedSavePath: hasCompleteResolvedSavePath ? resolvedSavePath : null,
          reason: failReason,
          ...(backupPath ? { backupPath } : {}),
        };
      }

      if (mode === 'pre_launch' && execMockFn && hasCompleteResolvedSavePath) {
        let appSet = virtualMockPreLaunchByExecFn.get(execMockFn);
        if (!saveDirExistsBefore && !fs.existsSync(resolvedSavePath)) {
          if (!appSet) {
            appSet = new Set();
            virtualMockPreLaunchByExecFn.set(execMockFn, appSet);
          }
          appSet.add(appName);
        } else if (appSet) {
          appSet.delete(appName);
        }
      }

      return {
        synced: true,
        appName,
        mode,
        args: syncArgs,
        cloudSaveFolder: cloudSaveFolderTemplate || null,
        resolvedSavePath: hasCompleteResolvedSavePath ? resolvedSavePath : null,
        ...(backupPath ? { backupPath } : {}),
      };
    } catch (err) {
      diagLog.warn('cloudSave.epicUnhandled', err, { mode });
      return {
        synced: false,
        appName: '',
        mode,
        reason: err && err.message ? err.message : 'sync_failed',
      };
    }
  }

  /**
   * Wait for cold-booted Steam (`-silent`) to finish its global client cloud sync AND any queued
   * `[AppID <cleanAppId>]` startup download/eval jobs before dispatching `-applaunch` / `steam://rungameid`.
   */
  async function waitForSteamColdStartupCloudReady(steamRoot, appId, options = {}) {
    if (isTestEnvironment(options) && options.enableTwoStageSteamColdStart !== true) {
      return { ready: true, waitedMs: 0, reason: 'skipped_in_test' };
    }

    const cleanAppId = String(appId || '')
      .replace(/^steam[-_]/i, '')
      .trim();
    const targetPlatform = options.platform || process.platform;
    const trimmedRoot = typeof steamRoot === 'string' ? steamRoot.trim() : '';

    const resolveLogPath = () => {
      const primary = trimmedRoot ? path.join(trimmedRoot, 'logs', 'cloud_log.txt') : '';
      if (primary && fs.existsSync(primary)) {
        return primary;
      }
      if (targetPlatform === 'darwin' && !options.steamRootStrict) {
        const macSupportLog = path.join(
          options.homedir || os.homedir(),
          'Library',
          'Application Support',
          'Steam',
          'logs',
          'cloud_log.txt'
        );
        if (fs.existsSync(macSupportLog)) {
          return macSupportLog;
        }
        return primary || macSupportLog;
      }
      return primary;
    };

    const initialLogPath = resolveLogPath();
    let baseOffset = 0;
    if (typeof options.preBootLogOffset === 'number' && options.preBootLogOffset >= 0) {
      baseOffset = options.preBootLogOffset;
    } else if (initialLogPath && fs.existsSync(initialLogPath)) {
      try {
        baseOffset = fs.statSync(initialLogPath).size;
      } catch {
        baseOffset = 0;
      }
    }

    const resolveConnectionLogPath = () => {
      const primary = trimmedRoot ? path.join(trimmedRoot, 'logs', 'connection_log.txt') : '';
      if (primary && fs.existsSync(primary)) {
        return primary;
      }
      if (targetPlatform === 'darwin' && !options.steamRootStrict) {
        const macConnLog = path.join(
          options.homedir || os.homedir(),
          'Library',
          'Application Support',
          'Steam',
          'logs',
          'connection_log.txt'
        );
        if (fs.existsSync(macConnLog)) {
          return macConnLog;
        }
        return primary || macConnLog;
      }
      return primary;
    };

    const initialConnLogPath = resolveConnectionLogPath();
    let baseConnOffset = 0;
    if (
      typeof options.preBootConnectionLogOffset === 'number' &&
      options.preBootConnectionLogOffset >= 0
    ) {
      baseConnOffset = options.preBootConnectionLogOffset;
    } else if (initialConnLogPath && fs.existsSync(initialConnLogPath)) {
      try {
        baseConnOffset = fs.statSync(initialConnLogPath).size;
      } catch {
        baseConnOffset = 0;
      }
    }

    const pollIntervalMs = Math.max(10, Number(options.pollIntervalMs || 250));
    const defaultStartupWaitMs = options.isBottleSteam ? 35000 : 25000;
    const maxStartupCloudWaitMs = Math.max(
      0,
      Number(options.maxStartupCloudWaitMs ?? defaultStartupWaitMs)
    );
    const settleAfterClientSyncMs =
      options.settleAfterClientSyncMs !== undefined
        ? Math.max(0, Number(options.settleAfterClientSyncMs))
        : 900;

    const readAppendedConnectionLogAsync = async () => {
      const connPath = resolveConnectionLogPath();
      if (!connPath || !fs.existsSync(connPath)) {
        return null;
      }
      let fh = null;
      try {
        fh = await openFileBoundedNoRecallAsync(connPath, 'r', 2500);
        const st = await fh.stat();
        const effectiveOffset = st.size < baseConnOffset ? 0 : baseConnOffset;
        const availableBytes = Math.max(0, st.size - effectiveOffset);
        if (availableBytes === 0) {
          return { text: '', size: st.size };
        }
        const readLen = Math.min(availableBytes, 131072);
        const startPos = st.size - readLen;
        const buf = Buffer.alloc(readLen);
        const { bytesRead } = await fh.read(buf, 0, readLen, startPos);
        return {
          text: buf.subarray(0, bytesRead).toString('utf8'),
          size: st.size,
        };
      } catch {
        return null;
      } finally {
        if (fh) {
          try {
            await fh.close();
          } catch {}
        }
      }
    };
    const connectionLogOnRegex = /RecvMsgClientLogOnResponse\(\)\s*:\s*processing complete/i;

    const readAppendedLogAsync = async () => {
      const logPath = resolveLogPath();
      if (!logPath || !fs.existsSync(logPath)) {
        return null;
      }
      let fh = null;
      try {
        fh = await openFileBoundedNoRecallAsync(logPath, 'r', 2500);
        const st = await fh.stat();
        const effectiveOffset = st.size < baseOffset ? 0 : baseOffset;
        const availableBytes = Math.max(0, st.size - effectiveOffset);
        if (availableBytes === 0) {
          return { text: '', size: st.size };
        }
        const maxRead = 262144;
        const readLen = Math.min(availableBytes, maxRead);
        const startPos = st.size - readLen;
        const buf = Buffer.alloc(readLen);
        const { bytesRead } = await fh.read(buf, 0, readLen, startPos);
        return {
          text: buf.subarray(0, bytesRead).toString('utf8'),
          size: st.size,
        };
      } catch (err) {
        diagLog.debug('cloudSave.steamColdStartReadLog', err, { logPath });
        return null;
      } finally {
        if (fh) {
          try {
            await fh.close();
          } catch {}
        }
      }
    };

    const clientSyncRegex =
      /OnRemoteStorageSyncedClient\(\)\s*-\s*result\s+OK|PerformSyncCloud\s*-\s*all\s+sync'd\s+up/i;
    const escapedAppId = cleanAppId ? cleanAppId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') : '';
    const appIdLineRegex = escapedAppId
      ? new RegExp(`(?:\\bAppID\\s*[:=]?\\s*${escapedAppId}\\b|\\[AppID\\s+${escapedAppId}\\])`, 'i')
      : null;

    const downloadQueuedRegex =
      /(?:Need\s+to\s+download\s+file|Need\s+to\s+sync\s+from\s+local\s+change\s+number|Starting\s+sync\s*\([^)]*down,|HTTP\s+download\s+.*\s+beginning)/i;
    const downloadCompleteRegex = /Download\s+complete/i;
    const inFlightStartRegex =
      /(?:Starting\s+sync|Need\s+to\s+upload\s+file|HTTP\s+upload\s+.*\s+beginning)/i;
    const anySyncCompleteRegex =
      /(?:Eval\s+complete|Download\s+complete|Upload\s+complete|AutoCloud\s+done|Nothing\s+to\s+sync)/i;
    const globalDownSyncStartRegex = /Starting\s+sync\s*\([^)]*down,/i;

    const evaluateStartupReadiness = (text) => {
      if (!text || !clientSyncRegex.test(text)) {
        return { ready: false };
      }

      const lines = text.split(/\r?\n/);
      let lastGlobalDownSyncIdx = -1;
      let lastGlobalOrAppSyncDoneIdx = -1;
      let lastAppDownloadQueuedIdx = -1;
      let lastAppDownloadCompleteIdx = -1;
      let lastAppInFlightStartIdx = -1;
      let lastAppCompletionIdx = -1;

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (!line) continue;

        if (globalDownSyncStartRegex.test(line)) {
          lastGlobalDownSyncIdx = i;
        }
        if (
          clientSyncRegex.test(line) ||
          downloadCompleteRegex.test(line) ||
          anySyncCompleteRegex.test(line)
        ) {
          lastGlobalOrAppSyncDoneIdx = i;
        }

        if (appIdLineRegex && appIdLineRegex.test(line)) {
          if (downloadQueuedRegex.test(line)) {
            lastAppDownloadQueuedIdx = i;
          }
          if (downloadCompleteRegex.test(line)) {
            lastAppDownloadCompleteIdx = i;
          }
          if (inFlightStartRegex.test(line)) {
            lastAppInFlightStartIdx = i;
          }
          if (anySyncCompleteRegex.test(line)) {
            lastAppCompletionIdx = i;
          }
        }
      }

      if (
        lastAppDownloadQueuedIdx !== -1 &&
        lastAppDownloadCompleteIdx <= lastAppDownloadQueuedIdx
      ) {
        return { ready: false };
      }

      if (lastAppInFlightStartIdx !== -1 && lastAppCompletionIdx <= lastAppInFlightStartIdx) {
        return { ready: false };
      }

      if (lastGlobalDownSyncIdx !== -1 && lastGlobalOrAppSyncDoneIdx < lastGlobalDownSyncIdx) {
        return { ready: false };
      }

      return { ready: true };
    };

    const sleepMs = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

    const startedWait = Date.now();
    let readySinceMs = 0;
    let readyAtSize = -1;
    let loginConfirmedAtMs = 0;
    const loginOnlySettleMs = Math.max(settleAfterClientSyncMs, 1500);

    const checkConnectionLogLoginAsync = async () => {
      if (loginConfirmedAtMs > 0) return true;
      const connSnap = await readAppendedConnectionLogAsync();
      if (connSnap && connSnap.text && connectionLogOnRegex.test(connSnap.text)) {
        loginConfirmedAtMs = Date.now();
        return true;
      }
      return false;
    };

    // Check immediately before sleeping in case already synced
    await checkConnectionLogLoginAsync();
    const firstSnap = await readAppendedLogAsync();
    if (firstSnap && evaluateStartupReadiness(firstSnap.text).ready) {
      readySinceMs = Date.now();
      readyAtSize = firstSnap.size;
      if (settleAfterClientSyncMs <= 0) {
        return {
          ready: true,
          waitedMs: Date.now() - startedWait,
          ...(loginConfirmedAtMs > 0 ? { loginConfirmed: true } : {}),
          reason: 'startup_cloud_synced',
        };
      }
    }

    while (Date.now() - startedWait < maxStartupCloudWaitMs) {
      const remainingBudget = maxStartupCloudWaitMs - (Date.now() - startedWait);
      if (remainingBudget <= 0) break;

      let waitSlice = pollIntervalMs;
      if (readySinceMs > 0 && settleAfterClientSyncMs > 0) {
        const remainingSettle = settleAfterClientSyncMs - (Date.now() - readySinceMs);
        waitSlice = Math.max(10, Math.min(pollIntervalMs, remainingSettle > 0 ? remainingSettle : 10));
      }
      await sleepMs(Math.min(waitSlice, remainingBudget));

      await checkConnectionLogLoginAsync();
      const snap = await readAppendedLogAsync();
      const now = Date.now();
      if (!snap || !snap.text) {
        readySinceMs = 0;
        readyAtSize = -1;
        if (loginConfirmedAtMs > 0 && now - loginConfirmedAtMs >= loginOnlySettleMs) {
          return {
            ready: true,
            waitedMs: now - startedWait,
            loginConfirmed: true,
            reason: 'connection_logged_on_settled',
          };
        }
        continue;
      }

      const evalRes = evaluateStartupReadiness(snap.text);
      if (!evalRes.ready) {
        readySinceMs = 0;
        readyAtSize = -1;
        continue;
      }

      if (readySinceMs === 0) {
        readySinceMs = now;
        readyAtSize = snap.size;
      } else if (snap.size !== readyAtSize) {
        // New activity occurred during settle window; ensure a fresh quiet settle window
        readySinceMs = now;
        readyAtSize = snap.size;
      }

      if (now - readySinceMs >= settleAfterClientSyncMs) {
        const confirmSnap = await readAppendedLogAsync();
        if (
          confirmSnap &&
          evaluateStartupReadiness(confirmSnap.text).ready &&
          confirmSnap.size === readyAtSize
        ) {
          return {
            ready: true,
            waitedMs: Date.now() - startedWait,
            ...(loginConfirmedAtMs > 0 ? { loginConfirmed: true } : {}),
            reason: 'startup_cloud_synced',
          };
        }
        readySinceMs = confirmSnap && evaluateStartupReadiness(confirmSnap.text).ready ? Date.now() : 0;
        readyAtSize = confirmSnap ? confirmSnap.size : -1;
      }
    }

    diagLog.warn('cloudSave.steamColdStartupTimeout', 'Steam cold-startup cloud sync wait timed out', {
      appId: cleanAppId,
      maxStartupCloudWaitMs,
    });
    return {
      ready: false,
      timedOut: true,
      waitedMs: Date.now() - startedWait,
      reason: 'timeout',
    };
  }

  /**
   * Poll `<steamRoot>/logs/cloud_log.txt` (with macOS `~/Library/Application Support/Steam/logs/cloud_log.txt`
   * fallback even when `steamRoot` is empty) asynchronously via `fs.promises.open` until active AutoCloud
   * upload jobs complete or settle.
   */
  async function waitForSteamCloudSyncCompletion(steamRoot, appId, options = {}) {
    const cleanAppId = String(appId || '')
      .replace(/^steam[-_]/i, '')
      .trim();
    if (!cleanAppId) {
      return { completed: true, waitedMs: 0, reason: 'no_active_cloud_job' };
    }

    const targetPlatform = options.platform || process.platform;
    const trimmedRoot = typeof steamRoot === 'string' ? steamRoot.trim() : '';
    let cloudLogPath = trimmedRoot ? path.join(trimmedRoot, 'logs', 'cloud_log.txt') : '';

    if (
      (!cloudLogPath || !fs.existsSync(cloudLogPath)) &&
      targetPlatform === 'darwin' &&
      !options.steamRootStrict
    ) {
      const macSupportLog = path.join(
        options.homedir || os.homedir(),
        'Library',
        'Application Support',
        'Steam',
        'logs',
        'cloud_log.txt'
      );
      if (fs.existsSync(macSupportLog)) {
        cloudLogPath = macSupportLog;
      }
    }

    if (!cloudLogPath || !fs.existsSync(cloudLogPath)) {
      return { completed: true, waitedMs: 0, reason: 'no_active_cloud_job' };
    }

    const readLogTailAsync = async () => {
      let fh = null;
      try {
        fh = await openFileBoundedNoRecallAsync(cloudLogPath, 'r', 2500);
        const st = await fh.stat();
        const maxRead = 65536;
        const readLen = Math.min(st.size, maxRead);
        const startPos = Math.max(0, st.size - readLen);
        const buf = Buffer.alloc(readLen);
        const { bytesRead } = await fh.read(buf, 0, readLen, startPos);
        return {
          text: buf.slice(0, bytesRead).toString('utf8'),
          size: st.size,
          mtimeMs: st.mtimeMs,
        };
      } catch (err) {
        diagLog.debug('cloudSave.steamReadLogTail', err, { cloudLogPath });
        return null;
      } finally {
        if (fh) {
          try {
            await fh.close();
          } catch {
            // Ignore close error
          }
        }
      }
    };

    const escapedAppId = cleanAppId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const appIdLineRegex = new RegExp(
      `(?:\\bAppID\\s*[:=]?\\s*${escapedAppId}\\b|\\[AppID\\s+${escapedAppId}\\])`,
      'i'
    );

    const exitUploadStartRegex =
      /(?:Starting\s+sync\s*\([^)]*(?:up,|AC\s+Exit)|Running\s+AutoCloud\s+on\s+exit|Need\s+to\s+upload\s+file|Upload\s+batch\s+initiated|HTTP\s+upload\s+.*\s+beginning|\bUploading\b)/i;
    const exitUploadCompletionRegex =
      /(?:Upload\s+complete|Sync\s+complete|Cloud\s+sync\s+complete|Syncing\s+to\s+Steam\s+Cloud\s+succeeded|AppCloudStateChange[^\n]*synced|Nothing\s+to\s+sync|0\s+files\s+to\s+upload|Job\s+complete|Job\s+Canceled|ReleaseAppLock)/i;
    const downloadStartRegex =
      /(?:Need\s+to\s+download\s+file|Need\s+to\s+sync\s+from\s+local\s+change\s+number|Starting\s+sync\s*\([^)]*down,|HTTP\s+download\s+.*\s+beginning|\bDownloading\b)/i;
    const downloadCompletionRegex = /Download\s+complete/i;
    const launchEvalStartRegex =
      /(?:Starting\s+sync\s*\((?:init,)?(?:AC\s+Launch,|eval,|down,|Get\s+App\s+Quota)|Running\s+AutoCloud\s+on\s+launch|Starting\s+sync|\bSyncing\b|Writing|Evaluating|Locking|in\s+progress|pending|queued)/i;
    const launchEvalCompletionRegex =
      /(?:AutoCloud\s+done|Eval\s+complete|Download\s+complete|GetAppQuotaUsage\s*-\s*Success)/i;
    const localAutoCloudScanOnlyRegex = /\bAutoCloud\s+complete\b/i;

    const inspectCloudState = (logSnapshot) => {
      if (!logSnapshot || !logSnapshot.text) {
        return { active: false, completed: false };
      }
      const lines = logSnapshot.text.split(/\r?\n/);
      let exitOrUploadActive = false;
      let launchOrEvalActive = false;
      let downloadPending = false;
      let sawCompletion = false;

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (!appIdLineRegex.test(line)) continue;

        // `AutoCloud complete` only marks local file hashing completion, NEVER network upload completion
        if (localAutoCloudScanOnlyRegex.test(line)) {
          continue;
        }

        if (exitUploadCompletionRegex.test(line)) {
          exitOrUploadActive = false;
          launchOrEvalActive = false;
          downloadPending = false;
          sawCompletion = true;
        } else if (exitUploadStartRegex.test(line)) {
          exitOrUploadActive = true;
        } else if (downloadCompletionRegex.test(line)) {
          downloadPending = false;
          launchOrEvalActive = false;
          sawCompletion = true;
        } else if (downloadStartRegex.test(line)) {
          downloadPending = true;
          launchOrEvalActive = true;
        } else if (launchEvalCompletionRegex.test(line)) {
          if (!downloadPending) {
            launchOrEvalActive = false;
            sawCompletion = true;
          }
        } else if (launchEvalStartRegex.test(line)) {
          launchOrEvalActive = true;
        }
      }

      const isActive = exitOrUploadActive || launchOrEvalActive || downloadPending;
      return {
        active: isActive,
        completed: !isActive && sawCompletion,
      };
    };

    const initialSnap = await readLogTailAsync();
    if (!initialSnap) {
      return { completed: true, waitedMs: 0, reason: 'no_active_cloud_job' };
    }

    const recentThresholdMs = Number(options.recentThresholdMs ?? 120000);
    if (
      options.mode !== 'post_exit' &&
      options.ignoreStaleLogAge !== true &&
      recentThresholdMs > 0 &&
      Date.now() - initialSnap.mtimeMs > recentThresholdMs
    ) {
      return { completed: true, waitedMs: 0, reason: 'no_active_cloud_job' };
    }

    const pollIntervalMs = Math.max(
      10,
      Number(options.pollIntervalMs || options.cloudSyncPollIntervalMs || 500)
    );
    const maxCloudWaitMs = Math.max(
      0,
      Number(options.maxCloudWaitMs ?? options.cloudSyncMaxWaitMs ?? 45000)
    );
    const settleMs =
      options.settleMs !== undefined ? Math.max(0, Number(options.settleMs)) : 15000;
    const abortSignal = options.signal || null;

    const waitTickWithAbort = (delayMs) =>
      new Promise((resolve) => {
        let settled = false;
        const onAbort = () => {
          if (settled) return;
          settled = true;
          clearTimeout(t);
          resolve();
        };
        const t = setTimeout(() => {
          if (settled) return;
          settled = true;
          if (abortSignal && typeof abortSignal.removeEventListener === 'function') {
            abortSignal.removeEventListener('abort', onAbort);
          }
          resolve();
        }, delayMs);
        if (
          abortSignal &&
          options.abortOnSignal === true &&
          typeof abortSignal.addEventListener === 'function'
        ) {
          abortSignal.addEventListener('abort', onAbort, { once: true });
        }
      });

    const startedWait = Date.now();
    let baselineSnap = initialSnap;
    let initialState = inspectCloudState(initialSnap);

    if (!initialState.active) {
      const postExitGraceMs =
        options.mode === 'post_exit'
          ? options.postExitGraceMs !== undefined
            ? Math.max(0, Number(options.postExitGraceMs))
            : isTestEnvironment(options)
              ? 0
              : 2500
          : 0;

      if (postExitGraceMs <= 0) {
        return { completed: true, waitedMs: 0, reason: 'no_active_cloud_job' };
      }

      const gracePollMs = Math.min(pollIntervalMs, 250);
      const initialByteSize = initialSnap.size;
      let observedActiveInGrace = false;

      while (Date.now() - startedWait < postExitGraceMs) {
        if (abortSignal && abortSignal.aborted && options.abortOnSignal === true) {
          return {
            completed: false,
            aborted: true,
            waitedMs: Date.now() - startedWait,
            reason: 'aborted',
          };
        }

        const remainingGrace = postExitGraceMs - (Date.now() - startedWait);
        await waitTickWithAbort(Math.max(10, Math.min(gracePollMs, remainingGrace)));

        if (abortSignal && abortSignal.aborted && options.abortOnSignal === true) {
          return {
            completed: false,
            aborted: true,
            waitedMs: Date.now() - startedWait,
            reason: 'aborted',
          };
        }

        const graceSnap = await readLogTailAsync();
        if (!graceSnap) {
          return {
            completed: true,
            waitedMs: Date.now() - startedWait,
            reason: 'cloud_log_removed',
          };
        }

        if (graceSnap.size !== initialByteSize) {
          const graceState = inspectCloudState(graceSnap);
          if (graceState.active) {
            baselineSnap = graceSnap;
            observedActiveInGrace = true;
            break;
          }
          // Check if Steam both started AND finished the AppID exit sync inside a single poll interval
          const newlyAppendedLen = Math.max(0, graceSnap.size - initialByteSize);
          const newlyAppendedSlice =
            newlyAppendedLen > 0 ? graceSnap.text.slice(-newlyAppendedLen) : graceSnap.text;
          const appendedLines = newlyAppendedSlice.split(/\r?\n/);
          const completedDuringGrace = appendedLines.some(
            (ln) => appIdLineRegex.test(ln) && exitUploadCompletionRegex.test(ln)
          );
          if (completedDuringGrace) {
            return {
              completed: true,
              waitedMs: Date.now() - startedWait,
              reason: 'cloud_sync_completed',
            };
          }
        }
      }

      if (!observedActiveInGrace) {
        return {
          completed: true,
          waitedMs: Date.now() - startedWait,
          reason: 'no_active_cloud_job',
        };
      }
    }

    let lastObservedSize = baselineSnap.size;
    let lastObservedMtime = baselineSnap.mtimeMs;
    let lastChangeWallMs = Date.now();

    while (Date.now() - startedWait < maxCloudWaitMs) {
      if (abortSignal && abortSignal.aborted && options.abortOnSignal === true) {
        return {
          completed: false,
          aborted: true,
          waitedMs: Date.now() - startedWait,
          reason: 'aborted',
        };
      }

      await waitTickWithAbort(pollIntervalMs);

      if (abortSignal && abortSignal.aborted && options.abortOnSignal === true) {
        return {
          completed: false,
          aborted: true,
          waitedMs: Date.now() - startedWait,
          reason: 'aborted',
        };
      }

      const snap = await readLogTailAsync();
      const now = Date.now();
      if (!snap) {
        return {
          completed: true,
          waitedMs: now - startedWait,
          reason: 'cloud_log_removed',
        };
      }

      if (snap.size !== lastObservedSize || snap.mtimeMs !== lastObservedMtime) {
        lastObservedSize = snap.size;
        lastObservedMtime = snap.mtimeMs;
        lastChangeWallMs = now;
      }

      const state = inspectCloudState(snap);
      if (!state.active) {
        return {
          completed: true,
          waitedMs: now - startedWait,
          reason: 'cloud_sync_completed',
        };
      }

      if (settleMs > 0 && now - lastChangeWallMs >= settleMs) {
        return {
          completed: true,
          waitedMs: now - startedWait,
          reason: 'cloud_log_settled',
        };
      }
    }

    diagLog.warn('cloudSave.steamSyncTimeout', 'Steam Cloud upload wait timed out', {
      appId: cleanAppId,
      cloudLogPath,
      maxCloudWaitMs,
    });
    return {
      completed: false,
      timedOut: true,
      waitedMs: Date.now() - startedWait,
      reason: 'timeout',
    };
  }

  function cleanupRunnerGameBackups(gameIdOrPayload, opts = {}) {
    const { homedir, userDataDir } = resolveIsolatedHomedirAndUserData(opts);
    return cleanupGameBackups(gameIdOrPayload, {
      homedir,
      userDataDir,
      ...opts,
    });
  }

  function enforceRunnerBackupQuota(opts = {}) {
    const { homedir, userDataDir } = resolveIsolatedHomedirAndUserData(opts);
    return enforceCloudSaveBackupQuotaAsync(opts.backupsRootDir || userDataDir, {
      homedir,
      userDataDir,
      ...opts,
    });
  }

  return {
    syncGogCloudSaves,
    syncEpicCloudSaves,
    syncXboxCloudSaves,
    waitForXboxCloudSaveFlush,
    waitForSteamColdStartupCloudReady,
    waitForSteamCloudSyncCompletion,
    cleanupGameBackups: cleanupRunnerGameBackups,
    enforceCloudSaveBackupQuota: enforceRunnerBackupQuota,
  };
}

/**
 * Resolves Xbox / GDK Connected Storage (`wgs`) and title save (`xgs`) locations across
 * Windows native (`%LOCALAPPDATA%\Packages\<PFN>\SystemAppData\wgs`) and macOS Wine/CrossOver bottles.
 */
function resolveXboxSaveLocations(payload = {}, context = {}) {
  const targetPlatform = context.platform || process.platform;
  const winePrefix = String(
    context.winePrefix || payload.winePrefix || context.bottlePath || payload.bottlePath || ''
  ).trim();
  const useCompatLayer = Boolean(
    context.useCompatLayer || payload.useCompatLayer || winePrefix
  );
  const homedir = resolveIsolatedDefaultHomedir(
    context.homedir ? context : payload.homedir ? payload : context
  );

  let packageFamilyName = String(payload.packageFamilyName || '').trim();
  let scid = String(payload.scid || '').trim().toLowerCase();
  let fallbackScid = String(payload.fallbackScid || context.fallbackScid || '')
    .trim()
    .toLowerCase();
  let msaAppId = String(payload.msaAppId || context.msaAppId || '').trim();
  let titleId = String(
    payload.xboxTitleId || payload.titleId || context.xboxTitleId || context.titleId || ''
  ).trim();
  const installPath = String(payload.installPath || context.installPath || '').trim();
  if (
    (!packageFamilyName || !scid || !fallbackScid || !msaAppId || !titleId || /^\d{9,}$/.test(titleId)) &&
    installPath
  ) {
    try {
      const cfg = inspectMicrosoftGameConfig(installPath);
      if (cfg) {
        if (!packageFamilyName && cfg.packageFamilyName) {
          packageFamilyName = cfg.packageFamilyName;
        }
        if (!scid && cfg.scid) {
          scid = String(cfg.scid).trim().toLowerCase();
        }
        if (!fallbackScid) {
          const cfgPrimaryScid = String(cfg.scid || '').trim().toLowerCase();
          const cfgFallbackScid = String(cfg.fallbackScid || '').trim().toLowerCase();
          if (cfgPrimaryScid && scid && cfgPrimaryScid !== scid) {
            fallbackScid = cfgPrimaryScid;
          } else if (cfgFallbackScid && cfgFallbackScid !== scid) {
            fallbackScid = cfgFallbackScid;
          }
        }
        if (!msaAppId && cfg.msaAppId) {
          msaAppId = String(cfg.msaAppId).trim();
        }
        if (
          cfg.titleId &&
          (!titleId || (/^\d{9,}$/.test(titleId) && /^[0-9A-Fa-f]{1,8}$/.test(cfg.titleId)))
        ) {
          titleId = String(cfg.titleId).trim();
        }
      } else {
        const appx = inspectAppxManifest(installPath);
        if (appx && !packageFamilyName && appx.packageFamilyName) {
          packageFamilyName = appx.packageFamilyName;
        }
      }
    } catch {}
  }

  if (
    !packageFamilyName ||
    packageFamilyName.includes('..') ||
    /[\\/:*?"<>|]/.test(packageFamilyName)
  ) {
    return null;
  }

  let localAppData = '';
  if (typeof context.localAppData === 'string' && context.localAppData.trim()) {
    localAppData = context.localAppData.trim();
  } else if (useCompatLayer && winePrefix) {
    const shell = readWinePrefixShellFolders(winePrefix);
    localAppData = shell.appDataLocal || '';
  } else if (targetPlatform === 'win32') {
    const winKnown = resolveHostWindowsKnownFolders({
      homedir,
      windowsKnownFolders: context.windowsKnownFolders,
      windowsRegistryOutput: context.windowsRegistryOutput,
      env: context.env,
    });
    localAppData = winKnown.localAppData || '';
  }

  if (!localAppData) return null;

  const useWinJoin =
    !useCompatLayer && targetPlatform === 'win32' && /^[A-Za-z]:[\\/]/.test(localAppData);
  const pJoin = useWinJoin ? path.win32.join : path.join;

  const packageRootDir = pJoin(localAppData, 'Packages', packageFamilyName);
  const systemAppDataDir = pJoin(packageRootDir, 'SystemAppData');
  const wgsRootDir = pJoin(systemAppDataDir, 'wgs');
  const xgsRootDir = pJoin(systemAppDataDir, 'xgs');
  const localStateDir = pJoin(packageRootDir, 'LocalState');

  let wgsUserDir = '';
  let xgsUserDir = '';
  const xuid = String(payload.xuid || context.xuid || '').trim();
  if (xuid && scid) {
    try {
      const folderName = formatWgsUserScidFolderName(xuid, scid);
      if (folderName) {
        wgsUserDir = pJoin(wgsRootDir, folderName);
        xgsUserDir = pJoin(xgsRootDir, folderName);
      }
    } catch {}
  }

  return {
    packageFamilyName,
    scid,
    ...(fallbackScid ? { fallbackScid } : {}),
    msaAppId,
    titleId,
    localAppData,
    packageRootDir,
    systemAppDataDir,
    wgsRootDir,
    xgsRootDir,
    localStateDir,
    wgsUserDir,
    xgsUserDir,
  };
}

async function inspectWgsFlushSnapshot(wgsRootDir) {
  let maxMtimeMs = 0;
  let totalEntries = 0;
  let hasActiveStaging = false;
  let hasMidSwapContainer = false;

  const zeroGuid = '00000000-0000-0000-0000-000000000000';

  const walk = async (dir, depth = 0) => {
    if (depth > 4) return;
    let entries;
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      const fullPath = path.join(dir, ent.name);
      let st;
      try {
        st = await fs.promises.lstat(fullPath);
      } catch {
        continue;
      }
      if (st.isSymbolicLink()) continue;
      totalEntries += 1;
      if (st.mtimeMs > maxMtimeMs) {
        maxMtimeMs = st.mtimeMs;
      }
      if (ent.isDirectory()) {
        if (depth === 0 && ent.name.toLowerCase() === 't') {
          try {
            const tempChildren = await fs.promises.readdir(fullPath);
            if (tempChildren.length > 0) {
              hasActiveStaging = true;
            }
          } catch {}
        }
        await walk(fullPath, depth + 1);
      } else if (ent.isFile() && /^container\.\d+$/i.test(ent.name)) {
        try {
          const buf = await fs.promises.readFile(fullPath);
          const parsedIndex = parseWgsContainerBlobIndex(buf);
          const records = Array.isArray(parsedIndex?.blobs)
            ? parsedIndex.blobs
            : Array.isArray(parsedIndex)
              ? parsedIndex
              : [];
          for (const rec of records) {
            if (
              rec.hasDualDistinctGuids ||
              (rec.fileNameGuid1 &&
                rec.fileNameGuid1 !== zeroGuid &&
                rec.fileNameGuid2 &&
                rec.fileNameGuid2 !== zeroGuid)
            ) {
              hasMidSwapContainer = true;
              break;
            }
          }
        } catch {}
      }
    }
  };

  await walk(wgsRootDir, 0);
  return { maxMtimeMs, totalEntries, hasActiveStaging, hasMidSwapContainer };
}

/**
 * Non-destructively waits for Windows `GamingServices` (`XGameSave`) to finish flushing
 * `SystemAppData\wgs` after game exit, then optionally snapshots a rolling backup.
 */
async function waitForXboxCloudSaveFlush(options = {}) {
  const resolved = options.wgsRootDir
    ? { wgsRootDir: options.wgsRootDir, packageFamilyName: options.packageFamilyName || '' }
    : resolveXboxSaveLocations(options, options);
  const wgsRootDir = resolved?.wgsRootDir || '';
  if (!wgsRootDir || !fs.existsSync(wgsRootDir)) {
    return {
      completed: true,
      waitedMs: 0,
      reason: 'no_cloud_saves_configured',
      backupPath: null,
    };
  }

  const pollIntervalMs = Math.max(25, Number(options.pollIntervalMs || 250));
  const quietWindowMs = Math.max(50, Number(options.quietWindowMs || 2000));
  const maxWaitMs = Math.max(quietWindowMs, Number(options.maxWaitMs || 15000));
  const startedAt = Date.now();
  let lastMutationAt = startedAt;
  let prevSig = '';
  let timedOut = false;

  while (Date.now() - startedAt < maxWaitMs) {
    const snap = await inspectWgsFlushSnapshot(wgsRootDir);
    const sig = `${snap.totalEntries}:${Math.round(snap.maxMtimeMs)}:${snap.hasActiveStaging ? 1 : 0}:${snap.hasMidSwapContainer ? 1 : 0}`;
    const now = Date.now();
    if (prevSig && sig !== prevSig) {
      lastMutationAt = now;
    } else if (!prevSig && snap.maxMtimeMs > 0 && now - snap.maxMtimeMs < quietWindowMs) {
      lastMutationAt = Math.max(startedAt, snap.maxMtimeMs);
    }
    prevSig = sig;

    if (
      !snap.hasActiveStaging &&
      !snap.hasMidSwapContainer &&
      now - lastMutationAt >= quietWindowMs
    ) {
      break;
    }

    if (now - startedAt + pollIntervalMs >= maxWaitMs) {
      if (snap.hasActiveStaging || snap.hasMidSwapContainer || now - lastMutationAt < quietWindowMs) {
        timedOut = true;
      }
      break;
    }
    await new Promise((r) => setTimeout(r, pollIntervalMs));
  }

  let backupPath = null;
  if (typeof options.userDataDir === 'string' && options.userDataDir.trim()) {
    const rawId = String(
      options.gameId || options.platformGameId || resolved?.packageFamilyName || 'xbox_game'
    ).replace(/[^A-Za-z0-9._-]/g, '_');
    const backupDir = path.join(options.userDataDir, 'cloud_save_backups', 'xbox', rawId);
    const backupRes = await createCloudSaveRollingBackupAsync(
      wgsRootDir,
      backupDir,
      Number(options.maxBackupBytes) > 0
        ? Number(options.maxBackupBytes)
        : resolveDefaultPerSnapshotMaxBackupBytes(options),
      {
        maxTotalBackupBytes: options.maxTotalBackupBytes,
        maxSnapshotsPerGame: options.maxSnapshotsPerGame,
        userDataDir: options.userDataDir,
        backupsRootDir: options.backupsRootDir,
        platform: options.platform || process.platform,
        getWin32FileAttributes: options.getWin32FileAttributes,
        oneDriveAttribExecImpl: options.oneDriveAttribExecImpl,
      }
    );
    if (backupRes?.backedUp) {
      backupPath = backupRes.backupPath;
    }
  }

  return {
    completed: !timedOut,
    timedOut,
    waitedMs: Date.now() - startedAt,
    reason: timedOut ? 'timeout' : 'wgs_flushed',
    backupPath,
  };
}

/**
 * Detects whether a Windows Xbox install is a clientless One Launcher GDK install (`xbox-msixvc-win`)
 * without OS `GamingServices` / Appx AUMID registration, requiring Direct Title Storage REST sync
 * against `titlestorage.xboxlive.com` instead of waiting on `GamingServices` flush.
 */
function isClientlessWindowsXboxGdkInstall(payload = {}, options = {}) {
  if (
    payload?.isAppxRegistered === true ||
    options?.isAppxRegistered === true ||
    payload?.useGamingServicesRuntime === true ||
    options?.useGamingServicesRuntime === true
  ) {
    return false;
  }
  const installKind = String(payload?.installKind || options?.installKind || '')
    .trim()
    .toLowerCase();
  const launchMethod = String(payload?.launchMethod || options?.launchMethod || '')
    .trim()
    .toLowerCase();
  const runner = String(payload?.runner || options?.runner || '')
    .trim()
    .toLowerCase();

  if (
    installKind === 'xbox-gamingservices' ||
    installKind === 'xbox-appx' ||
    launchMethod === 'xbox-aumid' ||
    launchMethod === 'xbox-protocol' ||
    runner === 'xbox-aumid' ||
    runner === 'xbox-protocol'
  ) {
    return false;
  }

  if (
    payload?.isClientlessXboxGdk === true ||
    options?.isClientlessXboxGdk === true ||
    installKind === 'xbox-msixvc-win' ||
    launchMethod === 'xbox-msixvc-win' ||
    runner === 'xbox-msixvc-win'
  ) {
    return true;
  }

  const installPath = String(payload?.installPath || options?.installPath || '').trim();
  if (!installPath) {
    return false;
  }

  const checkDirs = [installPath];
  const baseLower = path.basename(installPath.replace(/[\\/]+$/, '')).toLowerCase();
  if (baseLower === 'content') {
    const parent = path.dirname(installPath.replace(/[\\/]+$/, ''));
    if (parent && parent !== installPath) {
      checkDirs.push(parent);
    }
  }

  for (const dir of checkDirs) {
    try {
      if (
        fs.existsSync(path.join(dir, '.onelauncher-xbox-receipt.json')) ||
        fs.existsSync(path.join(dir, '.one_launcher_managed'))
      ) {
        return true;
      }
    } catch {}
  }

  return false;
}

/**
 * Dual-OS Xbox Connected Storage (`wgs`) Cloud Save Sync orchestrator:
 * - Windows Native OS (`win32` with `GamingServices`/Appx): non-destructively observes `GamingServices` flush + rolling backup.
 * - Windows Clientless GDK (`xbox-msixvc-win`) & macOS Bottle (`darwin` / `useCompatLayer`): syncs
 *   `SystemAppData/wgs/<HexXuid>_<Scid>` directly against `titlestorage.xboxlive.com` (`json/users/xuid(<xuid>)/scids/<scid>/savedgames/...`).
 */
async function syncXboxCloudSaves(payload = {}, mode = 'pre_launch', options = {}) {
  if (mode && typeof mode === 'object') {
    options = mode;
    mode = String(payload?.mode || payload?.direction || 'pre_launch');
  }
  const effectivePlatform = options.platform || process.platform;
  const winePrefix = String(
    options.winePrefix || payload.winePrefix || options.bottlePath || payload.bottlePath || ''
  ).trim();
  const useCompatLayer = Boolean(
    options.useCompatLayer ||
      payload.useCompatLayer ||
      winePrefix ||
      effectivePlatform === 'darwin'
  );
  const isClientlessWinGdk =
    effectivePlatform === 'win32' &&
    !useCompatLayer &&
    isClientlessWindowsXboxGdkInstall(payload, options);

  const xboxBackupQuotaOpts = {
    maxTotalBackupBytes: options.maxTotalBackupBytes,
    maxSnapshotsPerGame: options.maxSnapshotsPerGame,
    userDataDir: options.userDataDir,
    backupsRootDir: options.backupsRootDir,
    platform: effectivePlatform,
    getWin32FileAttributes: options.getWin32FileAttributes,
    oneDriveAttribExecImpl: options.oneDriveAttribExecImpl,
  };
  const effectiveMaxBackupBytes =
    Number(options.maxBackupBytes) > 0
      ? Number(options.maxBackupBytes)
      : resolveDefaultPerSnapshotMaxBackupBytes(options);

  // 1. Windows Native OS Path: GamingServices owns live XGameSave cloud sync (non-clientless only)
  if (effectivePlatform === 'win32' && !useCompatLayer && !isClientlessWinGdk) {
    const locs = resolveXboxSaveLocations(payload, {
      ...options,
      platform: 'win32',
      useCompatLayer: false,
    });
    const hostWgsRootDir = locs?.wgsRootDir ? toHostFilesystemPath(locs.wgsRootDir) : '';
    if (!locs || !hostWgsRootDir || !fs.existsSync(hostWgsRootDir)) {
      return {
        synced: false,
        provider: 'xbox_connected_storage',
        mode,
        reason: 'no_cloud_saves_configured',
        backupPath: null,
      };
    }

    if (mode === 'pre_launch') {
      let backupPath = null;
      if (typeof options.userDataDir === 'string' && options.userDataDir.trim()) {
        const rawId = String(
          payload.gameId || payload.platformGameId || locs.packageFamilyName || 'xbox_game'
        ).replace(/[^A-Za-z0-9._-]/g, '_');
        const backupRes = await createCloudSaveRollingBackupAsync(
          hostWgsRootDir,
          path.join(toHostFilesystemPath(options.userDataDir), 'cloud_save_backups', 'xbox', rawId),
          effectiveMaxBackupBytes,
          xboxBackupQuotaOpts
        );
        if (backupRes?.backedUp) backupPath = backupRes.backupPath;
      }
      return {
        synced: true,
        provider: 'xbox_connected_storage',
        mode,
        reason: 'windows_gamingservices_managed',
        backupPath,
      };
    }

    const flushRes = await waitForXboxCloudSaveFlush({
      ...options,
      wgsRootDir: hostWgsRootDir,
      packageFamilyName: locs.packageFamilyName,
      gameId: payload.gameId || payload.platformGameId || locs.packageFamilyName,
    });
    return {
      synced: Boolean(flushRes.completed),
      provider: 'xbox_connected_storage',
      mode,
      reason: flushRes.timedOut ? 'timeout' : 'windows_gamingservices_flushed',
      waitedMs: flushRes.waitedMs,
      backupPath: flushRes.backupPath || null,
    };
  }

  // 2. Direct Title Storage REST Sync (macOS Bottle / Compat Layer OR Windows Clientless `xbox-msixvc-win`)
  const directSyncCompatLayer = Boolean(
    winePrefix || options.useCompatLayer || payload.useCompatLayer
  );
  const baseLocs = resolveXboxSaveLocations(payload, {
    ...options,
    platform: effectivePlatform,
    useCompatLayer: directSyncCompatLayer,
    winePrefix,
  });
  if (!baseLocs || !baseLocs.packageFamilyName || !baseLocs.scid) {
    return {
      synced: false,
      provider: 'xbox_connected_storage',
      mode,
      reason: 'missing_scid_or_pfn',
      backupPath: null,
    };
  }

  let authProvider = options.xboxAuthProvider || null;
  if (!authProvider && !options.xboxSession) {
    try {
      const storeSync = require('../storeSync.cjs');
      if (typeof storeSync.getXboxAuthProvider === 'function') {
        authProvider = storeSync.getXboxAuthProvider({ userDataDir: options.userDataDir });
      }
    } catch {}
  }

  let session = options.xboxSession || null;
  if (!session && authProvider && typeof authProvider.getValidXboxSession === 'function') {
    try {
      session = await authProvider.getValidXboxSession();
    } catch (authErr) {
      const msg = String(authErr?.message || '');
      if (/offline|network|enotfound|econnrefused|etimedout/i.test(msg)) {
        return {
          synced: false,
          provider: 'xbox_connected_storage',
          mode,
          reason: 'offline_skipped',
          backupPath: null,
        };
      }
    }
  }

  if (!session || !session.xuid || !session.authorizationHeader) {
    return {
      synced: false,
      provider: 'xbox_connected_storage',
      mode,
      reason: 'missing_xbox_auth',
      backupPath: null,
    };
  }

  const locs = resolveXboxSaveLocations(
    {
      ...payload,
      packageFamilyName: baseLocs.packageFamilyName,
      scid: baseLocs.scid,
      fallbackScid: baseLocs.fallbackScid || payload.fallbackScid || options.fallbackScid,
      msaAppId: baseLocs.msaAppId || payload.msaAppId,
      xboxTitleId: baseLocs.titleId || payload.xboxTitleId || payload.titleId,
      xuid: session.xuid,
    },
    {
      ...options,
      platform: effectivePlatform,
      useCompatLayer: directSyncCompatLayer,
      winePrefix,
    }
  );
  if (!locs || !locs.wgsUserDir) {
    return {
      synced: false,
      provider: 'xbox_connected_storage',
      mode,
      reason: 'no_cloud_saves_configured',
      backupPath: null,
    };
  }

  const hostWgsUserDir = toHostFilesystemPath(locs.wgsUserDir);
  const hostXgsUserDir = locs.xgsUserDir ? toHostFilesystemPath(locs.xgsUserDir) : null;
  const rawBackupId = String(
    payload.gameId || payload.platformGameId || locs.packageFamilyName || 'xbox_game'
  ).replace(/[^A-Za-z0-9._-]/g, '_');
  const backupBaseDir =
    typeof options.userDataDir === 'string' && options.userDataDir.trim()
      ? path.join(toHostFilesystemPath(options.userDataDir), 'cloud_save_backups', 'xbox', rawBackupId)
      : '';

  let backupPath = null;
  if (mode === 'pre_launch' && backupBaseDir && fs.existsSync(hostWgsUserDir)) {
    const preBackup = await createCloudSaveRollingBackupAsync(
      hostWgsUserDir,
      backupBaseDir,
      effectiveMaxBackupBytes,
      xboxBackupQuotaOpts
    );
    if (preBackup?.backedUp) backupPath = preBackup.backupPath;
  }

  try {
    const syncTitleStorageFn =
      options.syncXboxTitleStorageFn || options.xboxSyncFn || syncXboxTitleStorage;
    const syncRes = await syncTitleStorageFn({
      mode,
      wgsUserDir: hostWgsUserDir,
      xgsUserDir: hostXgsUserDir,
      xuid: session.xuid,
      scid: locs.scid,
      fallbackScid: locs.fallbackScid || payload.fallbackScid || options.fallbackScid || '',
      msaAppId: locs.msaAppId || payload.msaAppId || '',
      titleId: locs.titleId || payload.xboxTitleId || payload.titleId || '',
      xboxProductId: payload.xboxProductId || '',
      packageFamilyName: locs.packageFamilyName,
      storePkgAumid: payload.appUserModelId || `${locs.packageFamilyName}!App`,
      authProvider,
      authorizationHeader: session.authorizationHeader,
      titleStorageOrigin: options.titleStorageOrigin || payload.titleStorageOrigin,
      fetchImpl: options.fetchImpl,
      signal: options.signal,
    });

    const resolvedScid = String(syncRes?.resolvedScid || locs.scid || '').trim().toLowerCase();
    const effectiveWgsUserDir = toHostFilesystemPath(
      String(syncRes?.resolvedWgsUserDir || hostWgsUserDir || '')
    );

    if (syncRes?.skipped && syncRes?.unsupportedForTitle) {
      return {
        synced: false,
        provider: 'xbox_connected_storage',
        mode,
        reason: 'title_storage_not_provisioned',
        resolvedScid,
        backupPath,
      };
    }

    if (mode === 'post_exit' && backupBaseDir && effectiveWgsUserDir && fs.existsSync(effectiveWgsUserDir)) {
      const postBackup = await createCloudSaveRollingBackupAsync(
        effectiveWgsUserDir,
        backupBaseDir,
        effectiveMaxBackupBytes,
        xboxBackupQuotaOpts
      );
      if (postBackup?.backedUp) backupPath = postBackup.backupPath;
    }

    const filesSynced =
      Number(syncRes?.downloadedContainers || 0) + Number(syncRes?.uploadedContainers || 0);
    return {
      synced: Boolean(syncRes?.synced),
      provider: 'xbox_connected_storage',
      mode,
      resolvedScid,
      filesSynced,
      downloadedContainers: Number(syncRes?.downloadedContainers || 0),
      uploadedContainers: Number(syncRes?.uploadedContainers || 0),
      deletedRemoteContainers: Number(syncRes?.deletedRemoteContainers || 0),
      backupPath,
      ...(syncRes?.lockHeld ? { reason: 'xbox_cloud_lock_conflict' } : {}),
    };
  } catch (err) {
    if (mode === 'post_exit' && !backupPath && backupBaseDir && fs.existsSync(hostWgsUserDir)) {
      const fallbackBackup = await createCloudSaveRollingBackupAsync(
        hostWgsUserDir,
        backupBaseDir,
        effectiveMaxBackupBytes,
        xboxBackupQuotaOpts
      ).catch(() => null);
      if (fallbackBackup?.backedUp) backupPath = fallbackBackup.backupPath;
    }
    diagLog.warn('cloudSave.syncXboxTitleStorageFailed', err, {
      mode,
      packageFamilyName: locs.packageFamilyName,
      scid: locs.scid,
    });
    const msg = String(err?.message || '');
    const isOffline =
      err?.code === 'ENOTFOUND' ||
      err?.code === 'ECONNREFUSED' ||
      /offline|network|enotfound|fetch failed/i.test(msg);
    return {
      synced: false,
      provider: 'xbox_connected_storage',
      mode,
      reason: isOffline ? 'offline_skipped' : msg || 'xbox_title_storage_sync_failed',
      backupPath,
    };
  }
}

module.exports = {
  GOG_GALAXY_LAUNCHER_CLIENT_ID,
  MAX_GOG_CLOUD_CONFIG_CACHE_ENTRIES,
  BENIGN_CLOUD_SYNC_SKIP_REASONS,
  DEFAULT_CLOUD_SAVE_MAX_BACKUP_BYTES,
  DEFAULT_GLOBAL_CLOUD_SAVE_BACKUP_QUOTA_BYTES,
  MIN_RETAINED_BACKUPS_PER_GAME,
  FILE_ATTRIBUTE_OFFLINE,
  FILE_ATTRIBUTE_RECALL_ON_OPEN,
  FILE_ATTRIBUTE_RECALL_ON_DATA_ACCESS,
  hasWin32CloudPlaceholderAttributes,
  isOneDrivePath,
  isBroadOneDriveKnownFolderRoot,
  inspectOneDrivePlaceholderStateAsync,
  openFileBoundedNoRecallAsync,
  withCloudManifestFileLock,
  normalizePosixUtf8Locale,
  purgeOsMetadataAndCountRealFilesSync,
  createCloudSaveRollingBackup,
  createCloudSaveRollingBackupAsync,
  enforceCloudSaveBackupQuotaSync,
  enforceCloudSaveBackupQuotaAsync,
  cleanupGameBackups,
  resolveGogCloudSaveLocations,
  resolveEpicSavePathTemplate,
  resolveXboxSaveLocations,
  isClientlessWindowsXboxGdkInstall,
  waitForXboxCloudSaveFlush,
  syncXboxCloudSaves,
  isSafeEpicSaveTemplateSyntax,
  pruneGogCloudConfigsMap,
  pruneCloudSaveStateForGame,
  pruneCloudSaveStateForGameAsync,
  buildCloudSyncTelemetryPayload,
  createCloudSaveRunner,
};
