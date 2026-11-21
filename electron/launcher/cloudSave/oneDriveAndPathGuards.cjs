// @ts-check
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');
const { diagLog } = require('../../utils/diagnosticLogger.cjs');
const {
  toHostFilesystemPath,
  isContainedWithinRoot,
} = require('../securityAndPathUtils.cjs');

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

const PROTECTED_PLATFORM_BUCKET_DIRS = new Set(['gog', 'epic', 'xbox', 'steam']);

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

const FILE_ATTRIBUTE_OFFLINE = 0x1000;
const FILE_ATTRIBUTE_RECALL_ON_OPEN = 0x00040000;
const FILE_ATTRIBUTE_RECALL_ON_DATA_ACCESS = 0x00400000;
const ONEDRIVE_CLOUD_PLACEHOLDER_MASK =
  FILE_ATTRIBUTE_OFFLINE | FILE_ATTRIBUTE_RECALL_ON_OPEN | FILE_ATTRIBUTE_RECALL_ON_DATA_ACCESS;

const RENAME_RETRYABLE_CODES = new Set(['EPERM', 'EACCES', 'EBUSY']);
const RENAME_RETRY_DELAYS_MS = [6, 14, 28, 50];

/** @type {Map<string, Promise<any>>} */
const cloudManifestLocksByPath = new Map();

/** @type {Map<string, Promise<any>>} */
const perGameCloudSyncLocks = new Map();

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

/**
 * Build a normalized per-game cloud-sync mutex key (`<platform>:<cleanId>`) so pre-launch,
 * post-exit, and pending-upload replay operations for the same title always serialize cleanly.
 *
 * @param {string} platformId
 * @param {string} rawId
 * @returns {string}
 */
function buildPerGameCloudSyncLockKey(platformId, rawId) {
  const plat = String(platformId || '').trim().toLowerCase();
  const trimmed = String(rawId || '').trim();
  if (!plat || !trimmed) return '';
  const stripped = trimmed.replace(new RegExp(`^${plat}[-_:]`, 'i'), '').trim();
  const effectiveId = (stripped || trimmed).toLowerCase();
  return `${plat}:${effectiveId}`;
}

/**
 * Serializes overlapping pre-launch, post-session, and pending-upload replay cloud syncs
 * for the same game key through an in-process async mutex.
 *
 * @template T
 * @param {string} lockKey
 * @param {() => Promise<T> | T} taskFn
 * @returns {Promise<T>}
 */
function withPerGameCloudSyncLock(lockKey, taskFn) {
  const key = String(lockKey || '').trim().toLowerCase();
  if (!key) {
    return Promise.resolve().then(() => taskFn());
  }
  const prev = perGameCloudSyncLocks.get(key) || Promise.resolve();
  /** @type {(value?: any) => void} */
  let releaseNext = () => {};
  const gate = new Promise((resolve) => {
    releaseNext = resolve;
  });
  const chained = prev.then(() => gate, () => gate);
  perGameCloudSyncLocks.set(key, chained);

  return prev
    .catch(() => {})
    .then(() => taskFn())
    .finally(() => {
      releaseNext();
      if (perGameCloudSyncLocks.get(key) === chained) {
        perGameCloudSyncLocks.delete(key);
      }
    });
}

/**
 * Non-blocking unref'd sleep that immediately resolves if `signal` aborts,
 * cleaning up timers and event listeners without leaks.
 *
 * @param {number} delayMs
 * @param {AbortSignal | null | undefined} [signal]
 * @returns {Promise<void>}
 */
function sleepUnrefWithAbortAsync(delayMs, signal = null) {
  const ms = Math.max(0, Number(delayMs) || 0);
  if (ms <= 0 || signal?.aborted) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    let settled = false;
    /** @type {ReturnType<typeof setTimeout> | null} */
    let timer = null;
    const finish = () => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (signal && typeof signal.removeEventListener === 'function') {
        try {
          signal.removeEventListener('abort', finish);
        } catch {}
      }
      resolve(undefined);
    };
    timer = setTimeout(finish, ms);
    if (timer && typeof timer.unref === 'function') {
      timer.unref();
    }
    if (signal && typeof signal.addEventListener === 'function') {
      signal.addEventListener('abort', finish, { once: true });
    }
  });
}

/**
 * Asynchronous existence check (`fs.promises.access`) without blocking the event loop.
 *
 * @param {string} targetPath
 * @returns {Promise<boolean>}
 */
async function pathExistsAsync(targetPath) {
  if (!targetPath || typeof targetPath !== 'string') return false;
  try {
    await fs.promises.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Asynchronous atomic file writer via fsync'd temp file + `.bak` preservation +
 * bounded Windows `EPERM`/`EACCES`/`EBUSY` rename retries with unref'd timers.
 *
 * @param {string} filePath
 * @param {string | Buffer} content
 * @returns {Promise<void>}
 */
async function atomicWriteFileAsync(filePath, content) {
  const hostFilePath = toHostFilesystemPath(filePath);
  const dir = path.dirname(hostFilePath);
  await fs.promises.mkdir(dir, { recursive: true });

  const bakPath = `${hostFilePath}.bak`;
  try {
    const existingStat = await fs.promises.stat(hostFilePath);
    if (existingStat.isFile() && existingStat.size > 0) {
      await fs.promises.copyFile(hostFilePath, bakPath);
    }
  } catch {
    // Missing primary or transient backup error must not block write
  }

  const tmpPath = `${hostFilePath}.${process.pid}.${Date.now()}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  const buf = Buffer.isBuffer(content) ? content : Buffer.from(String(content ?? ''), 'utf8');

  try {
    const fh = await fs.promises.open(tmpPath, 'w');
    try {
      let offset = 0;
      while (offset < buf.length) {
        const { bytesWritten } = await fh.write(buf, offset, buf.length - offset);
        if (bytesWritten <= 0) break;
        offset += bytesWritten;
      }
      try {
        await fh.sync();
      } catch {
        // Virtual/tmpfs filesystems in tests may not support fsync
      }
    } finally {
      await fh.close().catch(() => {});
    }

    /** @type {any} */
    let lastRenameErr = null;
    let renamed = false;
    for (let attempt = 0; attempt <= RENAME_RETRY_DELAYS_MS.length; attempt += 1) {
      try {
        await fs.promises.rename(tmpPath, hostFilePath);
        renamed = true;
        break;
      } catch (renameErr) {
        lastRenameErr = renameErr;
        const code = String(/** @type {any} */ (renameErr)?.code || '').toUpperCase();
        if (!RENAME_RETRYABLE_CODES.has(code) || attempt >= RENAME_RETRY_DELAYS_MS.length) {
          break;
        }
        await sleepUnrefWithAbortAsync(RENAME_RETRY_DELAYS_MS[attempt]);
      }
    }
    if (!renamed && lastRenameErr) {
      throw lastRenameErr;
    }
  } catch (err) {
    diagLog.warn('cloudSave.atomicWriteAsyncFallback', err, { filePath: hostFilePath });
    try {
      if (await pathExistsAsync(tmpPath)) {
        await fs.promises.copyFile(tmpPath, hostFilePath);
      } else {
        await fs.promises.writeFile(hostFilePath, buf);
      }
    } finally {
      await fs.promises.unlink(tmpPath).catch(() => {});
    }
  }
}

/**
 * @param {Record<string, any>} [opts]
 * @returns {string}
 */
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
 *
 * @param {any} rawId
 * @param {boolean} [allowLauncherId=false]
 * @returns {string}
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
 * Guard CLI positional/option values against leading-`-` / `--` flag injection,
 * NUL bytes, control characters, and optional path traversal characters.
 *
 * @param {any} rawValue
 * @param {{ allowSpaces?: boolean, allowPathSeparators?: boolean, maxLength?: number }} [opts]
 * @returns {boolean}
 */
function isSafeCliArgumentValue(rawValue, opts = {}) {
  if (typeof rawValue !== 'string') return false;
  const trimmed = rawValue.trim();
  if (!trimmed) return false;
  const maxLength = typeof opts.maxLength === 'number' && opts.maxLength > 0 ? opts.maxLength : 256;
  if (trimmed.length > maxLength) return false;
  if (trimmed.startsWith('-') || trimmed === '--') return false;
  if (/[\x00-\x1f\x7f]/.test(trimmed)) return false;
  if (!opts.allowSpaces && /\s/.test(trimmed)) return false;
  if (!opts.allowPathSeparators) {
    if (trimmed === '.' || trimmed === '..' || trimmed.includes('..') || /[\\/]/.test(trimmed)) {
      return false;
    }
  }
  return true;
}

/**
 * Validate a GOG cloud-save location name (`loc.name`) against CLI flag injection (`--` / leading `-`)
 * and path/control-character abuse.
 *
 * @param {any} name
 * @returns {boolean}
 */
function isSafeGogLocationName(name) {
  return isSafeCliArgumentValue(name, {
    allowSpaces: true,
    allowPathSeparators: false,
    maxLength: 256,
  });
}

/**
 * Validate a GOG game/product ID before passing to `gogdl` or filesystem lookups.
 *
 * @param {any} gameId
 * @returns {boolean}
 */
function isSafeGogGameId(gameId) {
  return isSafeCliArgumentValue(gameId, {
    allowSpaces: false,
    allowPathSeparators: false,
    maxLength: 128,
  });
}

/**
 * Validate an Epic/Legendary `appName` against CLI flag injection (`--` / leading `-`)
 * and metadata filename path traversal (`../`, `/`, `\`).
 *
 * @param {any} appName
 * @returns {boolean}
 */
function isSafeEpicAppName(appName) {
  return isSafeCliArgumentValue(appName, {
    allowSpaces: false,
    allowPathSeparators: false,
    maxLength: 256,
  });
}

/**
 * Normalize POSIX/macOS locale strings so PyInstaller Python's `locale.getlocale()` always
 * receives a valid `xx_YY.UTF-8` country-qualified locale instead of `C.UTF-8`, `UTF-8`, `C`, or `POSIX`.
 *
 * @param {any} val
 * @returns {string}
 */
function normalizePosixUtf8Locale(val) {
  return typeof val === 'string' && /^[a-z]{2,3}_[A-Z]{2}\./.test(val.trim())
    ? val.trim()
    : 'en_US.UTF-8';
}

/**
 * @param {any} err
 * @returns {string}
 */
function getFsErrCode(err) {
  return String(err?.code || '').toUpperCase();
}

/**
 * Enforce `lstat` + `realpath` symlink/junction containment synchronously on a lexically-contained
 * save path relative to its placeholder `anchorRoot`. Walks existing path segments beneath
 * `anchorRoot` so intermediate or leaf symlinks/NTFS junctions (including dangling symlinks)
 * can NEVER escape `realpath(anchorRoot)`.
 *
 * @param {string} anchorRoot
 * @param {string} resolvedPath
 * @param {string} [containmentPlatform]
 * @returns {{ ok: boolean, reason?: string, existed?: boolean }}
 */
function verifySavePathRealContainmentSync(
  anchorRoot,
  resolvedPath,
  containmentPlatform = process.platform
) {
  if (!isContainedWithinRoot(anchorRoot, resolvedPath, containmentPlatform)) {
    return { ok: false, reason: 'lexical_escape' };
  }

  const hostAnchor = toHostFilesystemPath(anchorRoot);
  const hostTarget = toHostFilesystemPath(resolvedPath);
  if (!hostAnchor || !hostTarget) {
    return { ok: false, reason: 'invalid_host_path' };
  }

  try {
    fs.lstatSync(hostAnchor);
  } catch (err) {
    const code = getFsErrCode(err);
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      return { ok: true, existed: false };
    }
    return { ok: false, reason: 'anchor_lstat_error' };
  }

  let realAnchor = '';
  try {
    realAnchor = fs.realpathSync(hostAnchor);
  } catch {
    return { ok: false, reason: 'dangling_anchor_symlink' };
  }

  const rel = path.relative(hostAnchor, hostTarget);
  if (rel === '') {
    return { ok: true, existed: true };
  }
  if (rel === '..' || rel.startsWith('../') || rel.startsWith('..\\') || path.isAbsolute(rel)) {
    return { ok: false, reason: 'host_relative_escape' };
  }

  const segments = rel.split(/[\\/]+/).filter(Boolean);
  let cursor = hostAnchor;
  let deepestExisting = hostAnchor;
  let targetExisted = true;

  for (const seg of segments) {
    cursor = path.join(cursor, seg);
    let st;
    try {
      st = fs.lstatSync(cursor);
    } catch (err) {
      const code = getFsErrCode(err);
      if (code === 'ENOENT' || code === 'ENOTDIR') {
        targetExisted = false;
        break;
      }
      return { ok: false, reason: 'segment_lstat_error' };
    }

    if (st.isSymbolicLink()) {
      let realSeg = '';
      try {
        realSeg = fs.realpathSync(cursor);
      } catch {
        return { ok: false, reason: 'symlink_escape_or_dangling' };
      }
      if (!isContainedWithinRoot(realAnchor, realSeg, process.platform)) {
        return { ok: false, reason: 'symlink_escapes_anchor_root' };
      }
    }
    deepestExisting = cursor;
  }

  if (deepestExisting !== hostAnchor) {
    let realDeepest = '';
    try {
      realDeepest = fs.realpathSync(deepestExisting);
    } catch {
      return { ok: false, reason: 'realpath_verification_failed' };
    }
    if (!isContainedWithinRoot(realAnchor, realDeepest, process.platform)) {
      return { ok: false, reason: 'symlink_escapes_anchor_root' };
    }
  }

  return { ok: true, existed: targetExisted };
}

/**
 * Asynchronous counterpart to `verifySavePathRealContainmentSync` using `fs.promises.lstat`
 * and `fs.promises.realpath` immediately prior to save-directory operations (closing TOCTOU races).
 *
 * @param {string} anchorRoot
 * @param {string} resolvedPath
 * @param {string} [containmentPlatform]
 * @returns {Promise<{ ok: boolean, reason?: string, existed?: boolean }>}
 */
async function verifySavePathRealContainmentAsync(
  anchorRoot,
  resolvedPath,
  containmentPlatform = process.platform
) {
  if (!isContainedWithinRoot(anchorRoot, resolvedPath, containmentPlatform)) {
    return { ok: false, reason: 'lexical_escape' };
  }

  const hostAnchor = toHostFilesystemPath(anchorRoot);
  const hostTarget = toHostFilesystemPath(resolvedPath);
  if (!hostAnchor || !hostTarget) {
    return { ok: false, reason: 'invalid_host_path' };
  }

  try {
    await fs.promises.lstat(hostAnchor);
  } catch (err) {
    const code = getFsErrCode(err);
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      return { ok: true, existed: false };
    }
    return { ok: false, reason: 'anchor_lstat_error' };
  }

  let realAnchor = '';
  try {
    realAnchor = await fs.promises.realpath(hostAnchor);
  } catch {
    return { ok: false, reason: 'dangling_anchor_symlink' };
  }

  const rel = path.relative(hostAnchor, hostTarget);
  if (rel === '') {
    return { ok: true, existed: true };
  }
  if (rel === '..' || rel.startsWith('../') || rel.startsWith('..\\') || path.isAbsolute(rel)) {
    return { ok: false, reason: 'host_relative_escape' };
  }

  const segments = rel.split(/[\\/]+/).filter(Boolean);
  let cursor = hostAnchor;
  let deepestExisting = hostAnchor;
  let targetExisted = true;

  for (const seg of segments) {
    cursor = path.join(cursor, seg);
    let st;
    try {
      st = await fs.promises.lstat(cursor);
    } catch (err) {
      const code = getFsErrCode(err);
      if (code === 'ENOENT' || code === 'ENOTDIR') {
        targetExisted = false;
        break;
      }
      return { ok: false, reason: 'segment_lstat_error' };
    }

    if (st.isSymbolicLink()) {
      let realSeg = '';
      try {
        realSeg = await fs.promises.realpath(cursor);
      } catch {
        return { ok: false, reason: 'symlink_escape_or_dangling' };
      }
      if (!isContainedWithinRoot(realAnchor, realSeg, process.platform)) {
        return { ok: false, reason: 'symlink_escapes_anchor_root' };
      }
    }
    deepestExisting = cursor;
  }

  if (deepestExisting !== hostAnchor) {
    let realDeepest = '';
    try {
      realDeepest = await fs.promises.realpath(deepestExisting);
    } catch {
      return { ok: false, reason: 'realpath_verification_failed' };
    }
    if (!isContainedWithinRoot(realAnchor, realDeepest, process.platform)) {
      return { ok: false, reason: 'symlink_escapes_anchor_root' };
    }
  }

  return { ok: true, existed: targetExisted };
}

/**
 * @param {any} attrMask
 * @returns {boolean}
 */
function hasWin32CloudPlaceholderAttributes(attrMask) {
  const num = Number(attrMask);
  if (!Number.isFinite(num) || num <= 0) return false;
  return (num & ONEDRIVE_CLOUD_PLACEHOLDER_MASK) !== 0;
}

/**
 * @param {any} targetPath
 * @returns {boolean}
 */
function isOneDrivePath(targetPath) {
  if (!targetPath || typeof targetPath !== 'string') return false;
  return /(?:^|[\\/])onedrive(?:[^\\/]*)(?:[\\/]|$)/i.test(targetPath);
}

/**
 * @param {any} targetDir
 * @returns {boolean}
 */
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
 * @param {any} targetDir
 * @returns {boolean}
 */
function isBroadOneDriveKnownFolderRoot(targetDir) {
  if (!targetDir || typeof targetDir !== 'string') return false;
  return isOneDrivePath(targetDir) && isWindowsKnownFolderRootPath(targetDir);
}

/**
 * @param {any} st
 * @param {boolean} [checkSparseBlocks=false]
 * @returns {boolean}
 */
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
 * freeze One Launcher indefinitely. Safely closes late-resolving handles and suppresses late
 * rejections so losing `Promise.race` can NEVER leak an FD or trigger an unhandled rejection.
 *
 * @param {string} filePath
 * @param {string | number} [flags='r']
 * @param {number} [timeoutMs=2500]
 * @returns {Promise<fs.promises.FileHandle>}
 */
async function openFileBoundedNoRecallAsync(filePath, flags = 'r', timeoutMs = 2500) {
  let timedOut = false;
  let closedLateHandle = false;
  /** @type {ReturnType<typeof setTimeout> | null} */
  let timer = null;

  /**
   * @param {fs.promises.FileHandle | null | undefined} fh
   */
  const closeLateHandleOnce = (fh) => {
    if (closedLateHandle) return undefined;
    if (fh && typeof fh.close === 'function') {
      closedLateHandle = true;
      return fh.close().catch(() => {});
    }
    return undefined;
  };

  const rawOpenPromise = fs.promises.open(filePath, flags);
  const openPromise = rawOpenPromise.then((fh) => {
    if (timedOut) {
      closeLateHandleOnce(fh);
      return null;
    }
    return fh;
  });

  const timeoutPromise = new Promise((_, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      rawOpenPromise.then(
        (fh) => closeLateHandleOnce(fh),
        () => {}
      );
      openPromise.catch(() => {});
      const err = Object.assign(
        new Error(`File open timed out (${timeoutMs}ms): ${filePath}`),
        { code: 'ETIMEDOUT' }
      );
      reject(err);
    }, Math.max(50, Number(timeoutMs) || 2500));
    if (timer && typeof timer.unref === 'function') timer.unref();
  });

  try {
    const fh = await Promise.race([openPromise, timeoutPromise]);
    if (!fh) {
      const err = Object.assign(
        new Error(`File open timed out (${timeoutMs}ms): ${filePath}`),
        { code: 'ETIMEDOUT' }
      );
      throw err;
    }
    return fh;
  } catch (err) {
    if (timedOut) {
      rawOpenPromise.then(
        (fh) => closeLateHandleOnce(fh),
        () => {}
      );
      openPromise.catch(() => {});
    }
    throw err;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Inspects a specific resolved game save subfolder for Windows OneDrive Files On-Demand cloud-only
 * placeholders (`FILE_ATTRIBUTE_OFFLINE = 0x1000`, `FILE_ATTRIBUTE_RECALL_ON_DATA_ACCESS = 0x00400000`)
 * via lightweight `fs.lstat` + bounded MFT attribute inspection without opening or hydrating cloud streams.
 * Explicitly refuses to scan broad parent `OneDrive\Documents` / `OneDrive\Saved Games` roots.
 *
 * Security (P0-07): Passes `targetDir` exclusively via `env.OL_ONEDRIVE_TARGET` and references
 * `$env:OL_ONEDRIVE_TARGET` inside PowerShell with ZERO string interpolation of user/game paths.
 *
 * @param {string} targetDir
 * @param {Record<string, any>} [options]
 * @returns {Promise<{ hasPlaceholders: boolean, blockedBroadRoot: boolean, placeholderFiles: string[] }>}
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

  /** @type {fs.Stats | null} */
  let rootStat = null;
  try {
    rootStat = await fs.promises.lstat(targetDir);
  } catch {
    return { hasPlaceholders: false, blockedBroadRoot: false, placeholderFiles: [] };
  }
  if (rootStat.isSymbolicLink()) {
    return { hasPlaceholders: false, blockedBroadRoot: false, placeholderFiles: [] };
  }

  /** @type {string[]} */
  const placeholderFiles = [];
  /**
   * @param {string} filePath
   * @param {fs.Stats} st
   */
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
    /** @type {Array<{ dir: string, depth: number }>} */
    const stack = [{ dir: targetDir, depth: 0 }];
    let scannedEntries = 0;
    while (stack.length > 0 && scannedEntries < 2000 && placeholderFiles.length < 25) {
      const next = stack.pop();
      if (!next) continue;
      const { dir, depth } = next;
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
    // ZERO path string interpolation — pass `targetDir` strictly through `env.OL_ONEDRIVE_TARGET`
    const psCmd = `Get-ChildItem -LiteralPath $env:OL_ONEDRIVE_TARGET -Recurse -Force -File -ErrorAction SilentlyContinue | Where-Object { ([int]$_.Attributes -band ${ONEDRIVE_CLOUD_PLACEHOLDER_MASK}) -ne 0 } | Select-Object -First 10 -ExpandProperty FullName`;
    const isRootDir = rootStat.isDirectory();
    /** @type {string[]} */
    const psDetected = await new Promise((resolve) => {
      try {
        execFn(
          'powershell.exe',
          ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', psCmd],
          {
            timeout: 2500,
            windowsHide: true,
            maxBuffer: 64 * 1024,
            env: { ...process.env, OL_ONEDRIVE_TARGET: targetDir },
          },
          (/** @type {any} */ err, /** @type {any} */ stdout) => {
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
                [isRootDir ? path.win32.join(targetDir, '*') : targetDir, '/S'],
                { timeout: 2000, windowsHide: true, maxBuffer: 128 * 1024 },
                (/** @type {any} */ attrErr, /** @type {any} */ attrOut) => {
                  if (attrErr || typeof attrOut !== 'string') {
                    resolve([]);
                    return;
                  }
                  /** @type {string[]} */
                  const found = [];
                  for (const ln of attrOut.split(/\r?\n/)) {
                    const flagsPart = ln.slice(0, 22);
                    const pathPart = ln.slice(21).trim();
                    if (
                      pathPart &&
                      (flagsPart.includes('O') ||
                        (flagsPart.includes('U') && flagsPart.includes('M')))
                    ) {
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

/**
 * Recursively purge OS metadata junk files (`.DS_Store`, `._*`, `Thumbs.db`, `desktop.ini`)
 * from a save directory without traversing symlinks, and count remaining real save files.
 * Preserves `desktop.ini` on top-level Windows Known Folder roots (`Documents`, `Saved Games`,
 * `OneDrive\Documents`, `AppData\LocalLow`, etc.) without counting it as a save file, and avoids
 * recursing into broad parent `OneDrive\Documents` / `OneDrive\Saved Games` trees on `win32`.
 * When `options.fileFilter` is provided, only files matching `fileFilter(relPosixPath)` are
 * counted and OS metadata junk outside matching paths is never deleted.
 *
 * @param {string} dirPath
 * @param {{ fileFilter?: ((relPosixPath: string) => boolean) | null }} [options]
 * @returns {{ exists: boolean, purgedCount: number, realFileCount: number }}
 */
function purgeOsMetadataAndCountRealFilesSync(dirPath, options = {}) {
  const summary = { exists: false, purgedCount: 0, realFileCount: 0 };
  if (!dirPath || typeof dirPath !== 'string') return summary;
  const fileFilter = typeof options?.fileFilter === 'function' ? options.fileFilter : null;
  try {
    if (!fs.existsSync(dirPath)) return summary;
    const rootStat = fs.lstatSync(dirPath);
    if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
      return summary;
    }
    summary.exists = true;

    const isBroadOneDriveRoot = isBroadOneDriveKnownFolderRoot(dirPath);
    const stack = [{ dir: dirPath, relPrefix: '' }];
    while (stack.length > 0) {
      const current = stack.pop();
      if (!current) continue;
      const { dir: currentDir, relPrefix } = current;
      const preserveRootDesktopIni = isWindowsKnownFolderRootPath(currentDir);
      let entries;
      try {
        entries = fs.readdirSync(currentDir);
      } catch {
        continue;
      }
      for (const name of entries) {
        const fullPath = path.join(currentDir, name);
        const relPosixPath = relPrefix ? `${relPrefix}/${name}` : name;
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
          stack.push({ dir: fullPath, relPrefix: relPosixPath });
          continue;
        }
        if (!entryStat.isFile()) {
          continue;
        }
        if (isSparseOrOfflineStat(entryStat, isOneDrivePath(fullPath))) {
          continue;
        }
        if (fileFilter && !fileFilter(relPosixPath)) {
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

/**
 * Asynchronous counterpart to `purgeOsMetadataAndCountRealFilesSync` using `fs.promises.opendir`
 * and `fs.promises.lstat` so save-folder scanning never blocks the Electron main thread.
 * When `options.fileFilter` is provided, only files matching `fileFilter(relPosixPath)` are
 * counted and OS metadata junk outside matching paths is never deleted.
 *
 * @param {string} dirPath
 * @param {{ fileFilter?: ((relPosixPath: string) => boolean) | null }} [options]
 * @returns {Promise<{ exists: boolean, purgedCount: number, realFileCount: number }>}
 */
async function purgeOsMetadataAndCountRealFilesAsync(dirPath, options = {}) {
  const summary = { exists: false, purgedCount: 0, realFileCount: 0 };
  if (!dirPath || typeof dirPath !== 'string') return summary;
  const fileFilter = typeof options?.fileFilter === 'function' ? options.fileFilter : null;
  try {
    /** @type {fs.Stats | null} */
    let rootStat = null;
    try {
      rootStat = await fs.promises.lstat(dirPath);
    } catch {
      return summary;
    }
    if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
      return summary;
    }
    summary.exists = true;

    const isBroadOneDriveRoot = isBroadOneDriveKnownFolderRoot(dirPath);
    const stack = [{ dir: dirPath, relPrefix: '' }];
    while (stack.length > 0) {
      const current = stack.pop();
      if (!current) continue;
      const { dir: currentDir, relPrefix } = current;
      const preserveRootDesktopIni = isWindowsKnownFolderRootPath(currentDir);
      let dirHandle = null;
      try {
        dirHandle = await fs.promises.opendir(currentDir);
      } catch {
        continue;
      }
      try {
        for await (const dirent of dirHandle) {
          const name = dirent.name;
          const fullPath = path.join(currentDir, name);
          const relPosixPath = relPrefix ? `${relPrefix}/${name}` : name;
          let entryStat;
          try {
            entryStat = await fs.promises.lstat(fullPath);
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
            stack.push({ dir: fullPath, relPrefix: relPosixPath });
            continue;
          }
          if (!entryStat.isFile()) {
            continue;
          }
          if (isSparseOrOfflineStat(entryStat, isOneDrivePath(fullPath))) {
            continue;
          }
          if (fileFilter && !fileFilter(relPosixPath)) {
            continue;
          }
          if (OS_METADATA_JUNK_REGEX.test(name)) {
            if (preserveRootDesktopIni && name.toLowerCase() === 'desktop.ini') {
              continue;
            }
            try {
              await fs.promises.unlink(fullPath);
              summary.purgedCount += 1;
            } catch {
              // Ignore locked OS metadata files without counting them as real game saves
            }
          } else {
            summary.realFileCount += 1;
          }
        }
      } catch {}
    }
  } catch (err) {
    diagLog.warn('cloudSave.purgeOsMetadataAsyncFailed', err, { dirPath });
  }
  return summary;
}

module.exports = {
  MAX_GOG_CLOUD_CONFIG_CACHE_ENTRIES,
  MAX_GOG_PRODUCT_CLIENT_ID_CACHE_ENTRIES,
  GOG_GALAXY_LAUNCHER_CLIENT_ID,
  OS_METADATA_JUNK_REGEX,
  PROTECTED_PLATFORM_BUCKET_DIRS,
  BENIGN_CLOUD_SYNC_SKIP_REASONS,
  FILE_ATTRIBUTE_OFFLINE,
  FILE_ATTRIBUTE_RECALL_ON_OPEN,
  FILE_ATTRIBUTE_RECALL_ON_DATA_ACCESS,
  ONEDRIVE_CLOUD_PLACEHOLDER_MASK,
  withCloudManifestFileLock,
  buildPerGameCloudSyncLockKey,
  withPerGameCloudSyncLock,
  sleepUnrefWithAbortAsync,
  pathExistsAsync,
  atomicWriteFileAsync,
  resolveIsolatedDefaultHomedir,
  sanitizeGogGameClientId,
  isSafeCliArgumentValue,
  isSafeGogLocationName,
  isSafeGogGameId,
  isSafeEpicAppName,
  normalizePosixUtf8Locale,
  verifySavePathRealContainmentSync,
  verifySavePathRealContainmentAsync,
  hasWin32CloudPlaceholderAttributes,
  isOneDrivePath,
  isWindowsKnownFolderRootPath,
  isBroadOneDriveKnownFolderRoot,
  isSparseOrOfflineStat,
  openFileBoundedNoRecallAsync,
  inspectOneDrivePlaceholderStateAsync,
  purgeOsMetadataAndCountRealFilesSync,
  purgeOsMetadataAndCountRealFilesAsync,
};
