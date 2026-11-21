// @ts-check
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');
const { diagLog } = require('../../utils/diagnosticLogger.cjs');
const { normalizeWin32DevicePrefix } = require('../uninstallSafety.cjs');

/** @type {{ app?: { getPath?: (name: string) => string } }} */
let electron = {};
try {
  const reqElectron = require('electron');
  if (reqElectron && typeof reqElectron === 'object') {
    electron = reqElectron;
  }
} catch {
  // Non-Electron test or CLI context
}

/** @type {((explicitDir?: string) => string) | null} */
let userDataDirResolver = null;
/** @type {string | null} */
let cachedWindowsUserSid = null;
/** @type {Promise<string> | null} */
let inFlightWindowsSidLookup = null;

/**
 * Asynchronously resolve and cache the current Windows user SID (`S-1-...`) without blocking
 * the Electron main-process event loop.
 *
 * @param {Record<string, any>} [options]
 * @returns {Promise<string>}
 */
function warmWindowsUserSidAsync(options = {}) {
  if (typeof options.userSid === 'string' && /^S-1-\d+(?:-\d+)+$/i.test(options.userSid.trim())) {
    cachedWindowsUserSid = options.userSid.trim();
    return Promise.resolve(cachedWindowsUserSid);
  }
  if (process.platform !== 'win32') {
    return Promise.resolve('');
  }
  if (cachedWindowsUserSid !== null && cachedWindowsUserSid !== '') {
    return Promise.resolve(cachedWindowsUserSid);
  }
  if (inFlightWindowsSidLookup) {
    return inFlightWindowsSidLookup;
  }
  const isVitest = Boolean(process.env.VITEST || process.env.NODE_ENV === 'test');
  if (isVitest && !options.allowWhoamiInTest) {
    return Promise.resolve('');
  }
  const execFileImpl =
    typeof options.execFileImpl === 'function'
      ? options.execFileImpl
      : typeof options.execFileFn === 'function'
        ? options.execFileFn
        : execFile;

  inFlightWindowsSidLookup = new Promise((resolve) => {
    try {
      execFileImpl(
        'whoami.exe',
        ['/user', '/fo', 'csv', '/nh'],
        { encoding: 'utf8', timeout: 2000, windowsHide: true },
        (/** @type {any} */ err, /** @type {any} */ stdout) => {
          if (!err && stdout) {
            const sidMatch = String(stdout).trim().match(/"(S-1-\d+(?:-\d+)+)"/i);
            cachedWindowsUserSid = sidMatch && sidMatch[1] ? sidMatch[1] : '';
          } else if (cachedWindowsUserSid === null) {
            cachedWindowsUserSid = '';
          }
          resolve(cachedWindowsUserSid || '');
        }
      );
    } catch {
      if (cachedWindowsUserSid === null) cachedWindowsUserSid = '';
      resolve('');
    }
  }).finally(() => {
    inFlightWindowsSidLookup = null;
  });

  return inFlightWindowsSidLookup;
}

/**
 * Resolve the Windows `icacls` principal spec immediately in memory using `os.userInfo().username`
 * (or cached async SID), eliminating synchronous `whoami.exe` blocking on hot paths.
 *
 * @param {Record<string, any>} [options]
 * @returns {string}
 */
function resolveCurrentWindowsPrincipalSpec(options = {}) {
  if (typeof options.userSid === 'string' && /^S-1-\d+(?:-\d+)+$/i.test(options.userSid.trim())) {
    return `*${options.userSid.trim()}`;
  }
  if (typeof options.username === 'string' && options.username.trim()) {
    return options.username.trim();
  }
  if (process.platform === 'win32') {
    if (cachedWindowsUserSid) {
      return `*${cachedWindowsUserSid}`;
    }
    if (cachedWindowsUserSid === null) {
      void warmWindowsUserSidAsync(options);
    }
  }
  let username = '';
  try {
    username = String(os.userInfo().username || '').trim();
  } catch {
    username = '';
  }
  if (!username) {
    username = String(process.env.USERNAME || '').trim();
  }
  if (!username) return '';
  const userDomain = String(process.env.USERDOMAIN || '').trim();
  if (userDomain && !username.includes('\\') && !username.includes('@')) {
    return `${userDomain}\\${username}`;
  }
  return username;
}

/**
 * Translate a cross-OS or `win32`-simulated path into a safe host-OS filesystem path
 * before invoking real host `fs.*` / `fs.promises.*` operations (`mkdir`, `writeFile`, etc.).
 *
 * @param {string} targetPath
 * @returns {string}
 */
function toHostFilesystemPath(targetPath) {
  if (typeof targetPath !== 'string' || !targetPath) {
    return targetPath;
  }
  if (process.platform === 'win32') {
    return targetPath;
  }

  let candidate = normalizeWin32DevicePrefix(targetPath.trim());
  if (!candidate) {
    return targetPath;
  }

  // Unwrap accidental `path.resolve('D:\\XboxGames')` -> `<cwd>/D:\XboxGames` or `<cwd>/\var\...` on POSIX
  try {
    const cwdPrefix = `${process.cwd().replace(/\/+$/, '')}/`;
    if (candidate.startsWith(cwdPrefix)) {
      const afterCwd = normalizeWin32DevicePrefix(candidate.slice(cwdPrefix.length));
      if (
        /^[A-Za-z]:(?:[\\/]|$)/.test(afterCwd) ||
        /^\\(?:var|tmp|private|Users|Volumes|home|opt|etc)(?:[\\/]|$)/.test(afterCwd)
      ) {
        candidate = afterCwd;
      }
    }
  } catch {
    // Ignore process.cwd() lookup errors
  }

  // 1. POSIX absolute path whose slashes were converted to backslashes by win32 path simulation
  if (/^\\(?:var|tmp|private|Users|Volumes|home|opt|etc)(?:[\\/]|$)/.test(candidate)) {
    return path.posix.normalize(candidate.replace(/\\/g, '/'));
  }

  // 2. Windows drive-letter path (`C:\Users\PortableTester`, `D:\XboxGames`) on a POSIX host
  const driveMatch = candidate.match(/^([A-Za-z]):(?:[\\/](.*))?$/);
  if (driveMatch) {
    const driveLetter = driveMatch[1].toLowerCase();
    const rawRest = (driveMatch[2] || '').replace(/\\/g, '/');
    const restNormalized = path.posix.normalize(`/${rawRest}`).replace(/^\/+/, '');
    const tmpBase = os.tmpdir().replace(/\\/g, '/');
    return restNormalized
      ? path.posix.join(tmpBase, 'one-launcher-win32-vfs', driveLetter, restNormalized)
      : path.posix.join(tmpBase, 'one-launcher-win32-vfs', driveLetter);
  }

  return targetPath;
}

/**
 * @param {((explicitDir?: string) => string) | null} fn
 */
function setSecurityUserDataDirResolver(fn) {
  if (typeof fn === 'function' || fn === null) {
    userDataDirResolver = fn;
  }
}

/**
 * @param {Record<string, any> | string} [options]
 * @returns {string}
 */
function resolveEffectiveUserDataDir(options = {}) {
  if (typeof options === 'string' && options.trim()) {
    return toHostFilesystemPath(options.trim());
  }
  const opts = options && typeof options === 'object' ? options : {};
  if (typeof opts.userDataDir === 'string' && opts.userDataDir.trim()) {
    return toHostFilesystemPath(opts.userDataDir.trim());
  }
  if (typeof userDataDirResolver === 'function') {
    try {
      const dir = userDataDirResolver(opts.userDataDir);
      if (dir) return toHostFilesystemPath(dir);
    } catch {
      // Fallback below
    }
  }
  if (typeof opts.homedir === 'string' && opts.homedir.trim()) {
    return toHostFilesystemPath(path.join(opts.homedir.trim(), '.one-launcher'));
  }
  if (process.env.VITEST || process.env.NODE_ENV === 'test') {
    return path.join(os.tmpdir(), `one-launcher-test-home-${process.pid}`, '.one-launcher');
  }
  try {
    if (electron.app && typeof electron.app.getPath === 'function') {
      const p = electron.app.getPath('userData');
      if (p) return toHostFilesystemPath(p);
    }
  } catch {
    // Fallback below
  }
  return path.join(os.homedir(), '.one-launcher');
}

const RENAME_RETRYABLE_CODES = new Set(['EPERM', 'EACCES', 'EBUSY']);
const RENAME_RETRY_DELAYS_MS = [6, 14, 28, 50];
/** @type {Int32Array | null} */
let sharedSyncSleepArray = null;

/**
 * @param {number} ms
 */
function sleepSyncBrief(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return;
  try {
    if (!sharedSyncSleepArray && typeof SharedArrayBuffer === 'function') {
      sharedSyncSleepArray = new Int32Array(new SharedArrayBuffer(4));
    }
    if (sharedSyncSleepArray && typeof Atomics?.wait === 'function') {
      Atomics.wait(sharedSyncSleepArray, 0, 0, Math.min(100, Math.max(1, Math.floor(ms))));
    }
  } catch {
    // Ignore when SharedArrayBuffer is unavailable in restricted contexts
  }
}

/**
 * @param {string} tmpPath
 * @param {string | Buffer} content
 * @param {number | undefined} fileMode
 */
function writeAndFsyncTempFileSync(tmpPath, content, fileMode) {
  const buf = Buffer.isBuffer(content) ? content : Buffer.from(String(content ?? ''), 'utf8');
  const fd =
    typeof fileMode === 'number'
      ? fs.openSync(tmpPath, 'w', fileMode)
      : fs.openSync(tmpPath, 'w');
  try {
    let offset = 0;
    while (offset < buf.length) {
      const written = fs.writeSync(fd, buf, offset, buf.length - offset);
      if (written <= 0) break;
      offset += written;
    }
    try {
      fs.fsyncSync(fd);
    } catch {
      // Virtual/tmpfs filesystems in tests may not support fsync
    }
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * @param {string} tmpPath
 * @param {string} hostFilePath
 */
function renameTempWithRetrySync(tmpPath, hostFilePath) {
  let lastErr = null;
  for (let attempt = 0; attempt <= RENAME_RETRY_DELAYS_MS.length; attempt++) {
    try {
      fs.renameSync(tmpPath, hostFilePath);
      return;
    } catch (err) {
      lastErr = err;
      const code = String(/** @type {any} */ (err)?.code || '').toUpperCase();
      if (!RENAME_RETRYABLE_CODES.has(code) || attempt >= RENAME_RETRY_DELAYS_MS.length) {
        break;
      }
      sleepSyncBrief(RENAME_RETRY_DELAYS_MS[attempt]);
    }
  }
  throw lastErr;
}

/**
 * Atomically preserve `<hostFilePath>.bak` before replacing an existing non-empty file.
 * In `secureMode`, creates the backup via a `0o600` temp file + atomic rename so `.bak`
 * NEVER has a world-readable `0o644` TOCTOU window on POSIX.
 *
 * @param {string} hostFilePath
 * @param {boolean} [secureMode=false]
 * @returns {boolean} true if a backup file was written/updated
 */
function preserveBackupCopyBeforeWriteSync(hostFilePath, secureMode = false) {
  const bakPath = `${hostFilePath}.bak`;
  try {
    if (!fs.existsSync(hostFilePath)) return false;
    const st = fs.statSync(hostFilePath);
    if (!st.isFile() || st.size <= 0) return false;
    if (secureMode) {
      const rawBytes = fs.readFileSync(hostFilePath);
      const bakTmpPath = `${bakPath}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
      try {
        writeAndFsyncTempFileSync(bakTmpPath, rawBytes, 0o600);
        if (process.platform !== 'win32') {
          try {
            fs.chmodSync(bakTmpPath, 0o600);
          } catch {}
        }
        renameTempWithRetrySync(bakTmpPath, bakPath);
        if (process.platform !== 'win32') {
          try {
            fs.chmodSync(bakPath, 0o600);
          } catch {}
        }
        return true;
      } catch {
        try {
          if (fs.existsSync(bakTmpPath)) fs.unlinkSync(bakTmpPath);
        } catch {}
        return false;
      }
    }
    fs.copyFileSync(hostFilePath, bakPath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Read and parse a JSON file with automatic fallback to `<filePath>.bak` if the primary
 * file is corrupted, truncated (0-byte), or unreadable mid-write.
 *
 * @param {string} filePath
 * @param {any} [fallbackValue=null]
 * @param {{ recoverMissingFromBackup?: boolean }} [options]
 * @returns {any}
 */
function readJsonFileWithBackupSync(filePath, fallbackValue = null, options = {}) {
  const hostFilePath = toHostFilesystemPath(filePath);
  const bakPath = `${hostFilePath}.bak`;
  let primaryExists = false;

  try {
    const primaryStat = fs.statSync(hostFilePath);
    primaryExists = primaryStat.isFile();
  } catch (statErr) {
    if (/** @type {any} */ (statErr)?.code !== 'ENOENT') {
      diagLog.debug('fs.readJsonStat', statErr, { filePath: hostFilePath });
    }
  }

  if (primaryExists) {
    try {
      const raw = fs.readFileSync(hostFilePath, 'utf8');
      if (raw.trim().length > 0) {
        return JSON.parse(raw);
      }
    } catch (parseErr) {
      diagLog.warn('fs.jsonPrimaryCorrupt', parseErr, { filePath: hostFilePath });
    }
  }

  if (primaryExists || options.recoverMissingFromBackup === true) {
    try {
      if (fs.existsSync(bakPath)) {
        const bakRaw = fs.readFileSync(bakPath, 'utf8');
        if (bakRaw.trim().length > 0) {
          const parsedBak = JSON.parse(bakRaw);
          try {
            fs.copyFileSync(bakPath, hostFilePath);
          } catch {
            // Keep parsed backup in memory even if disk restore fails
          }
          diagLog.warn('fs.jsonRecoveredFromBackup', null, { filePath: hostFilePath });
          return parsedBak;
        }
      }
    } catch (bakErr) {
      diagLog.warn('fs.jsonBackupCorrupt', bakErr, { filePath: bakPath });
    }
  }

  return fallbackValue;
}

/**
 * Atomically write non-secret JSON/config file content via fsync'd temporary file +
 * `.bak` preservation + bounded Windows EPERM/EBUSY rename retries.
 *
 * @param {string} filePath
 * @param {string | Buffer} content
 */
function atomicWriteFileSync(filePath, content) {
  const hostFilePath = toHostFilesystemPath(filePath);
  const dir = path.dirname(hostFilePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const tmpPath = `${hostFilePath}.${process.pid}.${Date.now()}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  preserveBackupCopyBeforeWriteSync(hostFilePath, false);
  try {
    writeAndFsyncTempFileSync(tmpPath, content, undefined);
    renameTempWithRetrySync(tmpPath, hostFilePath);
  } catch (err) {
    diagLog.warn('fs.atomicWriteFallback', err, { filePath: hostFilePath });
    try {
      if (fs.existsSync(tmpPath)) {
        fs.copyFileSync(tmpPath, hostFilePath);
      } else {
        fs.writeFileSync(hostFilePath, content, 'utf8');
      }
    } finally {
      try {
        if (fs.existsSync(tmpPath)) {
          fs.unlinkSync(tmpPath);
        }
      } catch {
        // Ignore temp cleanup failure
      }
    }
  }
}

/**
 * Apply owner-only Windows ACL asynchronously via `icacls`.
 *
 * @param {string} filePath
 * @param {Record<string, any>} [options]
 * @returns {Promise<boolean>}
 */
function applyWindowsOwnerAclAsync(filePath, options = {}) {
  const principalSpec = resolveCurrentWindowsPrincipalSpec(options);
  if (!principalSpec) return Promise.resolve(false);
  const execFileImpl =
    typeof options.execFileImpl === 'function'
      ? options.execFileImpl
      : typeof options.execFileFn === 'function'
        ? options.execFileFn
        : execFile;

  return new Promise((resolve) => {
    try {
      execFileImpl(
        'icacls',
        [filePath, '/inheritance:r', '/grant:r', `${principalSpec}:(F)`],
        { timeout: 3000, windowsHide: true },
        (/** @type {any} */ aclErr) => {
          if (aclErr) {
            diagLog.debug('security.icacls', aclErr, { filePath });
            resolve(false);
            return;
          }
          resolve(true);
        }
      );
    } catch (aclInvokeErr) {
      diagLog.debug('security.icaclsInvoke', aclInvokeErr, { filePath });
      resolve(false);
    }
  });
}

/**
 * Atomically write sensitive credential/session files (`user.json`, `auth.json`, tombstones, approved commands)
 * with strict owner-only directory (`0o700`) and file (`0o600`) permissions on POSIX (including `.bak`
 * with zero `0o644` TOCTOU window), fsync + `.bak` recovery, bounded Windows `EPERM`/`EBUSY` rename retries,
 * and non-blocking `icacls` owner ACL hardening on BOTH the primary file and `.bak` on Windows.
 *
 * @param {string} filePath
 * @param {string | Buffer} content
 * @param {Record<string, any>} [options]
 */
function atomicWriteSecureFileSync(filePath, content, options = {}) {
  const targetPlatform = options.platform || process.platform;
  const hostFilePath = toHostFilesystemPath(filePath);
  const dir = path.dirname(hostFilePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  if (targetPlatform !== 'win32' && process.platform !== 'win32') {
    try {
      fs.chmodSync(dir, 0o700);
    } catch (chmodDirErr) {
      diagLog.debug('security.chmodDir', chmodDirErr, { dir });
    }
  }

  const tmpPath = `${hostFilePath}.${process.pid}.${Date.now()}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  const wroteBak =
    options?.preserveBackup !== false ? preserveBackupCopyBeforeWriteSync(hostFilePath, true) : false;
  try {
    writeAndFsyncTempFileSync(tmpPath, content, 0o600);
    if (process.platform !== 'win32') {
      try {
        fs.chmodSync(tmpPath, 0o600);
      } catch (chmodTmpErr) {
        diagLog.debug('security.chmodTmp', chmodTmpErr, { tmpPath });
      }
    }
    renameTempWithRetrySync(tmpPath, hostFilePath);
  } catch (err) {
    diagLog.warn('security.atomicWriteFallback', err, { filePath: hostFilePath });
    try {
      if (fs.existsSync(tmpPath)) {
        fs.copyFileSync(tmpPath, hostFilePath);
      } else {
        fs.writeFileSync(hostFilePath, content, { encoding: 'utf8', mode: 0o600 });
      }
    } finally {
      try {
        if (fs.existsSync(tmpPath)) {
          fs.unlinkSync(tmpPath);
        }
      } catch {
        // Ignore temp cleanup error
      }
    }
  }

  if (process.platform !== 'win32') {
    try {
      fs.chmodSync(hostFilePath, 0o600);
    } catch (chmodFileErr) {
      diagLog.debug('security.chmodFile', chmodFileErr, { filePath: hostFilePath });
    }
  }

  const isVitest = Boolean(process.env.VITEST || process.env.NODE_ENV === 'test');
  if (targetPlatform === 'win32' && (!isVitest || options.enforceWindowsAclInTest === true)) {
    void applyWindowsOwnerAclAsync(filePath, options);
    if (wroteBak || fs.existsSync(`${hostFilePath}.bak`)) {
      void applyWindowsOwnerAclAsync(`${filePath}.bak`, options);
    }
  }
}

/**
 * Check whether a `path.relative` result actually traverses upward (`..`, `../...`, `..\...`)
 * without falsely rejecting legitimate filenames beginning with `..` (e.g. `..config`).
 *
 * @param {string} rel
 * @returns {boolean}
 */
function isRelativeTraversalEscape(rel) {
  return rel === '..' || rel.startsWith('../') || rel.startsWith('..\\');
}

/**
 * Verify that `resolvedPath` is strictly inside or equal to `anchorRoot` with zero `..` escapes,
 * Win32 extended-length prefix tricks, drive-letter switches, UNC switches, or NUL-byte injections.
 * Uses strict path-segment boundary checking so files named `..config` inside `anchorRoot` are allowed.
 *
 * @param {string} anchorRoot
 * @param {string} resolvedPath
 * @param {string} [platform]
 * @returns {boolean}
 */
function isContainedWithinRoot(anchorRoot, resolvedPath, platform = process.platform) {
  if (
    !anchorRoot ||
    !resolvedPath ||
    typeof anchorRoot !== 'string' ||
    typeof resolvedPath !== 'string'
  ) {
    return false;
  }
  if (anchorRoot.includes('\0') || resolvedPath.includes('\0')) {
    return false;
  }

  const trimmedAnchor = normalizeWin32DevicePrefix(anchorRoot.trim());
  const trimmedTarget = normalizeWin32DevicePrefix(resolvedPath.trim());
  if (!trimmedAnchor || !trimmedTarget) {
    return false;
  }

  const useWinSemantics =
    platform === 'win32' ||
    /^[A-Za-z]:[\\/]/.test(trimmedAnchor) ||
    /^[A-Za-z]:[\\/]/.test(trimmedTarget) ||
    trimmedAnchor.startsWith('\\\\') ||
    trimmedTarget.startsWith('\\\\');

  if (useWinSemantics) {
    const winAnchor = path.win32.normalize(trimmedAnchor.replace(/\//g, '\\'));
    const winTarget = path.win32.normalize(trimmedTarget.replace(/\//g, '\\'));
    if (!path.win32.isAbsolute(winAnchor) || !path.win32.isAbsolute(winTarget)) {
      return false;
    }
    const rel = path.win32.relative(winAnchor.toLowerCase(), winTarget.toLowerCase());
    if (rel === '') return true;
    if (isRelativeTraversalEscape(rel) || path.win32.isAbsolute(rel)) {
      return false;
    }
    return true;
  }

  const posixAnchor = path.posix.normalize(trimmedAnchor.replace(/\\/g, '/'));
  const posixTarget = path.posix.normalize(trimmedTarget.replace(/\\/g, '/'));
  if (!posixAnchor.startsWith('/') || !posixTarget.startsWith('/')) {
    return false;
  }
  const rel = path.posix.relative(posixAnchor, posixTarget);
  if (rel === '') return true;
  if (isRelativeTraversalEscape(rel) || path.posix.isAbsolute(rel)) {
    return false;
  }
  return true;
}

module.exports = {
  warmWindowsUserSidAsync,
  resolveCurrentWindowsPrincipalSpec,
  toHostFilesystemPath,
  setSecurityUserDataDirResolver,
  resolveEffectiveUserDataDir,
  readJsonFileWithBackupSync,
  atomicWriteFileSync,
  applyWindowsOwnerAclAsync,
  atomicWriteSecureFileSync,
  isContainedWithinRoot,
};
