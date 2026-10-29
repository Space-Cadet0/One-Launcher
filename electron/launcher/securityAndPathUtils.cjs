'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const net = require('node:net');
const dns = require('node:dns');
const crypto = require('node:crypto');
const childProcess = require('node:child_process');
const { execFile } = childProcess;
const { diagLog } = require('../utils/diagnosticLogger.cjs');
const {
  normalizeWin32DevicePrefix,
  isSafeBottleSlug,
  isSafeNumericAppId,
} = require('./uninstallSafety.cjs');

let electron = {};
try {
  const reqElectron = require('electron');
  if (reqElectron && typeof reqElectron === 'object') {
    electron = reqElectron;
  }
} catch {
  // Non-Electron test or CLI context
}

let userDataDirResolver = null;
let cachedWindowsUserSid = null;
let inFlightWindowsSidLookup = null;

/**
 * Asynchronously resolve and cache the current Windows user SID (`S-1-...`) without blocking
 * the Electron main-process event loop.
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
        (err, stdout) => {
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
 * (or cached async SID), eliminating synchronous `whoami.exe` blocking on hot paths (`D3.1`).
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
 * - On Windows (`process.platform === 'win32'`), returns `targetPath` unchanged.
 * - On POSIX (`darwin` / `linux`):
 *   1. If `targetPath` starts with a single backslash + POSIX root segment
 *      (`\var\...`, `\tmp\...`, `\private\...`, `\Users\...`, `\Volumes\...`, `\home\...`,
 *      `\opt\...`, `\etc\...` — including if prepended with `process.cwd()` via `path.resolve`),
 *      converts backslashes back to `/` so files stay inside the real host temp/test directory
 *      rather than creating literal backslash folders in `process.cwd()`.
 *   2. If `targetPath` is a Windows drive-letter path (`C:\Users\PortableTester`, `D:\XboxGames`,
 *      `\\?\D:\XboxGames` — including if prepended with `process.cwd()` via `path.resolve`),
 *      maps `X:\rest\of\path` into a deterministic temp directory under
 *      `path.posix.join(os.tmpdir(), 'one-launcher-win32-vfs', driveLetter.toLowerCase(), restNormalized)`
 *      so hermetic `win32` tests on macOS/Linux receive real writable directories without
 *      polluting `process.cwd()` with literal `C:\...` or `D:\...` directory trees.
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

function setSecurityUserDataDirResolver(fn) {
  if (typeof fn === 'function' || fn === null) {
    userDataDirResolver = fn;
  }
}

function resolveEffectiveUserDataDir(options = {}) {
  if (options && typeof options.userDataDir === 'string' && options.userDataDir.trim()) {
    return toHostFilesystemPath(options.userDataDir.trim());
  }
  if (typeof userDataDirResolver === 'function') {
    try {
      const dir = userDataDirResolver(options?.userDataDir);
      if (dir) return toHostFilesystemPath(dir);
    } catch {
      // Fallback below
    }
  }
  if (options && typeof options.homedir === 'string' && options.homedir.trim()) {
    return toHostFilesystemPath(path.join(options.homedir.trim(), '.one-launcher'));
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

/**
 * Atomically write non-secret JSON/config file content via temporary file + rename.
 */
function atomicWriteFileSync(filePath, content) {
  const hostFilePath = toHostFilesystemPath(filePath);
  const dir = path.dirname(hostFilePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const tmpPath = `${hostFilePath}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 6)}.tmp`;
  try {
    fs.writeFileSync(tmpPath, content, 'utf8');
    fs.renameSync(tmpPath, hostFilePath);
  } catch (err) {
    diagLog.warn('fs.atomicWriteFallback', err, { filePath: hostFilePath });
    try {
      if (fs.existsSync(tmpPath)) {
        fs.unlinkSync(tmpPath);
      }
    } catch {
      // Ignore temp cleanup failure
    }
    fs.writeFileSync(hostFilePath, content, 'utf8');
  }
}

/**
 * Apply owner-only Windows ACL asynchronously via `icacls`.
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
        (aclErr) => {
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
 * with strict owner-only directory (`0o700`) and file (`0o600`) permissions on POSIX, plus
 * non-blocking `icacls` inheritance-stripped owner ACL hardening on Windows (`win32`).
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

  const tmpPath = `${hostFilePath}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 6)}.tmp`;
  try {
    fs.writeFileSync(tmpPath, content, { encoding: 'utf8', mode: 0o600 });
    if (process.platform !== 'win32') {
      try {
        fs.chmodSync(tmpPath, 0o600);
      } catch (chmodTmpErr) {
        diagLog.debug('security.chmodTmp', chmodTmpErr, { tmpPath });
      }
    }
    fs.renameSync(tmpPath, hostFilePath);
  } catch (err) {
    diagLog.warn('security.atomicWriteFallback', err, { filePath: hostFilePath });
    try {
      if (fs.existsSync(tmpPath)) {
        fs.unlinkSync(tmpPath);
      }
    } catch {
      // Ignore temp cleanup error
    }
    fs.writeFileSync(hostFilePath, content, { encoding: 'utf8', mode: 0o600 });
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
  }
}

/**
 * Verify that `resolvedPath` is strictly inside or equal to `anchorRoot` with zero `..` escapes,
 * Win32 extended-length prefix tricks, drive-letter switches, UNC switches, or NUL-byte injections.
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
    if (rel.startsWith('..') || path.win32.isAbsolute(rel)) {
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
  if (rel.startsWith('..') || path.posix.isAbsolute(rel)) {
    return false;
  }
  return true;
}

// ============================================================================
// Origin Host Validation & SSRF / DNS-Rebinding Guard (`D8.6`)
// ============================================================================

/**
 * Validate that `urlStr` is a strict `https:` URL whose parsed hostname equals or is a
 * dot-separated subdomain of an entry in `allowedHosts` (never substring `url.includes`).
 *
 * @param {unknown} urlStr
 * @param {Iterable<string>} allowedHosts
 * @returns {boolean}
 */
function isAllowedHttpsHost(urlStr, allowedHosts) {
  if (typeof urlStr !== 'string' || !urlStr.trim() || /[\x00-\x1f\x7f]/.test(urlStr)) {
    return false;
  }
  if (!allowedHosts || typeof allowedHosts[Symbol.iterator] !== 'function') {
    return false;
  }
  let parsed;
  try {
    parsed = new URL(urlStr.trim());
  } catch {
    return false;
  }
  if (parsed.protocol !== 'https:') {
    return false;
  }
  if (parsed.username || parsed.password) {
    return false;
  }
  const host = String(parsed.hostname || '')
    .toLowerCase()
    .replace(/\.$/, '');
  if (!host) {
    return false;
  }

  for (const rawAllowed of allowedHosts) {
    if (typeof rawAllowed !== 'string') continue;
    const allowed = rawAllowed
      .trim()
      .toLowerCase()
      .replace(/^\*\./, '')
      .replace(/\.$/, '');
    if (!allowed) continue;
    if (host === allowed || host.endsWith(`.${allowed}`)) {
      return true;
    }
  }
  return false;
}

/**
 * Expand a valid IPv6 address into eight 16-bit unsigned integer groups.
 * @param {string} ipv6
 * @returns {number[] | null}
 */
function parseIpv6Groups(ipv6) {
  let addr = ipv6.toLowerCase();
  // Convert trailing dotted-quad IPv4 (`::ffff:127.0.0.1`) into two 16-bit hex groups
  const lastColon = addr.lastIndexOf(':');
  if (lastColon !== -1 && addr.slice(lastColon + 1).includes('.')) {
    const v4Part = addr.slice(lastColon + 1);
    if (net.isIP(v4Part) !== 4) return null;
    const octets = v4Part.split('.').map((n) => Number(n));
    const hi = ((octets[0] << 8) | octets[1]).toString(16);
    const lo = ((octets[2] << 8) | octets[3]).toString(16);
    addr = `${addr.slice(0, lastColon + 1)}${hi}:${lo}`;
  }

  const dblParts = addr.split('::');
  if (dblParts.length > 2) return null;

  const left = dblParts[0] ? dblParts[0].split(':') : [];
  const right = dblParts.length === 2 && dblParts[1] ? dblParts[1].split(':') : [];
  const missing = 8 - (left.length + right.length);
  if ((dblParts.length === 1 && missing !== 0) || (dblParts.length === 2 && missing < 1)) {
    return null;
  }

  const full = [...left, ...Array(Math.max(0, missing)).fill('0'), ...right];
  if (full.length !== 8) return null;

  const groups = [];
  for (const part of full) {
    if (!/^[0-9a-f]{1,4}$/.test(part)) return null;
    groups.push(parseInt(part, 16));
  }
  return groups;
}

/**
 * Check whether an IPv4 or IPv6 literal falls in loopback, private, link-local, unspecified,
 * CGNAT, multicast, documentation, or IPv4-mapped private/loopback space.
 *
 * Blocks `127.0.0.0/8`, `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`, `169.254.0.0/16`,
 * `0.0.0.0/8`, `100.64.0.0/10`, `::1`, `::`, `fc00::/7`, `fe80::/10`, `::ffff:<private>`.
 *
 * @param {unknown} ip
 * @returns {boolean}
 */
function isPrivateOrLoopbackIp(ip) {
  if (typeof ip !== 'string' || !ip.trim()) return false;
  const clean = ip
    .trim()
    .replace(/^\[|\]$/g, '')
    .split('%')[0]
    .trim();
  if (!clean) return false;

  // Handle dotted IPv4-mapped IPv6 even if Node's net.isIP varies by formatting
  const mappedDottedMatch = clean.match(/^(?:::ffff:|0{1,4}(?::0{1,4}){4}:ffff:)(\d+\.\d+\.\d+\.\d+)$/i);
  if (mappedDottedMatch && mappedDottedMatch[1] && net.isIP(mappedDottedMatch[1]) === 4) {
    return isPrivateOrLoopbackIp(mappedDottedMatch[1]);
  }

  const family = net.isIP(clean);
  if (family === 4) {
    const [a, b, c] = clean.split('.').map((x) => Number(x));
    if (a === 0) return true; // 0.0.0.0/8 unspecified / "this" network
    if (a === 10) return true; // 10.0.0.0/8 RFC1918
    if (a === 127) return true; // 127.0.0.0/8 loopback
    if (a === 169 && b === 254) return true; // 169.254.0.0/16 link-local / cloud metadata
    if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12 RFC1918
    if (a === 192 && b === 168) return true; // 192.168.0.0/16 RFC1918
    if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 CGNAT
    if (a === 192 && b === 0 && (c === 0 || c === 2)) return true; // 192.0.0.0/24, 192.0.2.0/24
    if (a === 198 && (b === 18 || b === 19)) return true; // 198.18.0.0/15 benchmark
    if (a === 198 && b === 51 && c === 100) return true; // 198.51.100.0/24 TEST-NET-2
    if (a === 203 && b === 0 && c === 113) return true; // 203.0.113.0/24 TEST-NET-3
    if (a >= 224) return true; // 224.0.0.0/4 multicast + 240.0.0.0/4 reserved/broadcast
    return false;
  }

  if (family === 6) {
    const g = parseIpv6Groups(clean);
    if (!g) return true;
    const allZeroPrefix5 = g[0] === 0 && g[1] === 0 && g[2] === 0 && g[3] === 0 && g[4] === 0;
    // :: unspecified or ::1 loopback
    if (allZeroPrefix5 && g[5] === 0 && g[6] === 0 && (g[7] === 0 || g[7] === 1)) {
      return true;
    }
    // ::ffff:0:0/96 IPv4-mapped IPv6 (`::ffff:127.0.0.1` or `::ffff:7f00:1`)
    if (allZeroPrefix5 && g[5] === 0xffff) {
      const embeddedV4 = `${(g[6] >> 8) & 0xff}.${g[6] & 0xff}.${(g[7] >> 8) & 0xff}.${g[7] & 0xff}`;
      return isPrivateOrLoopbackIp(embeddedV4);
    }
    // ::/96 deprecated IPv4-compatible IPv6
    if (allZeroPrefix5 && g[5] === 0) {
      const embeddedV4 = `${(g[6] >> 8) & 0xff}.${g[6] & 0xff}.${(g[7] >> 8) & 0xff}.${g[7] & 0xff}`;
      return isPrivateOrLoopbackIp(embeddedV4);
    }
    // NAT64 64:ff9b::/96
    if (g[0] === 0x0064 && g[1] === 0xff9b && g[2] === 0 && g[3] === 0 && g[4] === 0 && g[5] === 0) {
      const embeddedV4 = `${(g[6] >> 8) & 0xff}.${g[6] & 0xff}.${(g[7] >> 8) & 0xff}.${g[7] & 0xff}`;
      return isPrivateOrLoopbackIp(embeddedV4);
    }
    // fc00::/7 Unique Local (fc00:: - fdff::)
    if ((g[0] & 0xfe00) === 0xfc00) return true;
    // fe80::/10 Link-Local
    if ((g[0] & 0xffc0) === 0xfe80) return true;
    // fec0::/10 Site-Local (deprecated)
    if ((g[0] & 0xffc0) === 0xfec0) return true;
    // ff00::/8 Multicast
    if ((g[0] & 0xff00) === 0xff00) return true;
    // 2001:db8::/32 Documentation
    if (g[0] === 0x2001 && g[1] === 0x0db8) return true;
    return false;
  }

  return false;
}

/**
 * Create a structured SSRF rejection Error.
 * @param {string} message
 * @param {{ isDnsUnavailable?: boolean }} [flags]
 */
function createUnsafeUrlError(message, flags = {}) {
  const err = /** @type {Error & { code?: string, isSsrfBlocked?: boolean, isDnsUnavailable?: boolean }} */ (
    new Error(message)
  );
  err.code = flags.isDnsUnavailable ? 'ERR_DNS_UNAVAILABLE' : 'ERR_SSRF_BLOCKED';
  err.isSsrfBlocked = !flags.isDnsUnavailable;
  err.isDnsUnavailable = Boolean(flags.isDnsUnavailable);
  return err;
}

/**
 * Validate that `urlStr` is a public `https:` URL whose literal IP or `dns.promises.lookup(..., { all: true })`
 * resolution contains ZERO private, loopback, link-local, or unspecified addresses.
 *
 * @param {unknown} urlStr
 * @param {{ dnsLookup?: (hostname: string, opts: { all: true }) => Promise<Array<{ address: string }>> }} [options]
 * @returns {Promise<{ url: string, hostname: string, addresses: string[] }>}
 */
async function assertSafePublicHttpsUrl(urlStr, options = {}) {
  if (typeof urlStr !== 'string' || !urlStr.trim() || /[\x00-\x1f\x7f]/.test(urlStr)) {
    throw createUnsafeUrlError('Blocked empty or malformed URL');
  }
  let parsed;
  try {
    parsed = new URL(urlStr.trim());
  } catch {
    throw createUnsafeUrlError('Blocked unparseable URL');
  }

  if (parsed.protocol !== 'https:') {
    throw createUnsafeUrlError(`Blocked non-HTTPS protocol: ${parsed.protocol}`);
  }
  if (parsed.username || parsed.password) {
    throw createUnsafeUrlError('Blocked URL containing embedded credentials');
  }

  const host = String(parsed.hostname || '')
    .replace(/^\[|\]$/g, '')
    .toLowerCase()
    .replace(/\.$/, '');
  if (
    !host ||
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host.endsWith('.local') ||
    host.endsWith('.internal') ||
    host.endsWith('.home.arpa') ||
    (net.isIP(host) === 0 && !host.includes('.'))
  ) {
    throw createUnsafeUrlError(`Blocked local hostname: ${host || '<empty>'}`);
  }

  if (net.isIP(host) !== 0) {
    if (isPrivateOrLoopbackIp(host)) {
      throw createUnsafeUrlError(`Blocked private or loopback IP literal: ${host}`);
    }
    return { url: parsed.toString(), hostname: host, addresses: [host] };
  }

  const lookupFn =
    typeof options.dnsLookup === 'function' ? options.dnsLookup : dns.promises.lookup;

  let records;
  try {
    records = await lookupFn(host, { all: true });
  } catch (dnsErr) {
    const code = String(/** @type {any} */ (dnsErr)?.code || '').toUpperCase();
    const isOfflineDnsCode =
      code === 'ENOTFOUND' ||
      code === 'EAI_AGAIN' ||
      code === 'EAI_NONAME' ||
      code === 'ENODATA' ||
      code === 'ETIMEDOUT' ||
      code === 'ECONNREFUSED' ||
      code === 'ESERVFAIL';
    throw createUnsafeUrlError(`DNS lookup failed for ${host}`, {
      isDnsUnavailable: isOfflineDnsCode,
    });
  }

  const recordList = Array.isArray(records) ? records : records ? [records] : [];
  if (recordList.length === 0) {
    throw createUnsafeUrlError(`DNS lookup returned no addresses for ${host}`, {
      isDnsUnavailable: true,
    });
  }

  /** @type {string[]} */
  const addresses = [];
  for (const entry of recordList) {
    const addr = typeof entry === 'string' ? entry : String(entry?.address || '').trim();
    if (!addr || net.isIP(addr.replace(/^\[|\]$/g, '').split('%')[0]) === 0) {
      throw createUnsafeUrlError(`Invalid DNS address record for ${host}`);
    }
    if (isPrivateOrLoopbackIp(addr)) {
      throw createUnsafeUrlError(`Blocked DNS resolution to private/loopback IP for ${host}`);
    }
    addresses.push(addr);
  }

  return { url: parsed.toString(), hostname: host, addresses };
}

// ============================================================================
// Recursive Launch Config Validator, Env Sanitizer & Settings Schema (`D8.2`)
// ============================================================================

const DANGEROUS_LAUNCH_ENV_KEYS = new Set([
  'LD_PRELOAD',
  'LD_LIBRARY_PATH',
  'LD_AUDIT',
  'DYLD_INSERT_LIBRARIES',
  'DYLD_LIBRARY_PATH',
  'DYLD_FRAMEWORK_PATH',
  'DYLD_FALLBACK_LIBRARY_PATH',
  'NODE_OPTIONS',
  'ELECTRON_RUN_AS_NODE',
]);

const LAUNCH_SHELL_OR_EXEC_FIELDS = [
  'preLaunchCommand',
  'postExitCommand',
  'wrapperCommand',
  'customExecutable',
  'customExecutablePath',
  'executablePath',
];

const LAUNCH_ENV_MAP_FIELDS = new Set(['env', 'envVars', 'environment', 'customEnv']);

const FORBIDDEN_RENDERER_IPC_KEYS = new Set([
  'execFileSync',
  'execFileSyncFn',
  'execFile',
  'execFileImpl',
  'execFileFn',
  'spawnFn',
  'gameSpawnFn',
  'bottleClientSpawnFn',
  'execFn',
  'fsImpl',
  'killImpl',
  'fetchImpl',
  'openExternalFn',
  'recoverEpicAuthFn',
  'refreshGogTokenFn',
  'bottleSteamProcessListFn',
  'getProcessListOutput',
  'mockProcessListOutput',
  'userDataDir',
  'homedir',
  'appPath',
  'resourcesPath',
  'brewBinaryPath',
  'legendaryBinaryPath',
  'gogdlBinaryPath',
  'wineBinaryPath',
  'crossoverPath',
  'whiskyPath',
  'gptkPath',
  'tokensFilePath',
  'filePath',
  'settingsFilePath',
  'configFilePath',
  'gogGalaxyDbPath',
  'gogGalaxyConfigPath',
  'gogGalaxyStorageDir',
  'eglManifestsDir',
  'allowExternalTokenRefresh',
  'allowCodesignInTest',
  'allowRegistryDiscoveryInTest',
  'enforceWindowsAclInTest',
  'machineIdOverride',
  'vaultSecretOverride',
  'windowsRegistryOutput',
  'windowsKnownFolders',
]);

/**
 * Strict allowlist of user-facing keys accepted by `launcher:save-settings` /
 * `launcher:save-performance-settings` (`T1-F03`).
 */
const ALLOWED_LAUNCHER_SETTINGS_KEYS = new Set([
  'inGameLauncherBehavior',
  'postGameLauncherBehavior',
  'pauseDownloadsInGame',
  'pauseDownloadsWhilePlaying',
  'throttleDownloadsInGame',
  'pauseHydrationInGame',
  'pauseBackgroundSyncInGame',
  'pauseAnimationsInBackground',
  'hibernateRendererInGame',
  'muteAudioInBackground',
  'hardwareAcceleration',
  'disableHardwareAcceleration',
  'backgroundThrottling',
  'lowMemoryMode',
  'lowPowerIdleMode',
  'memorySaverMode',
  'aggressiveMemoryTrim',
  'autoTrimMemory',
  'trimMemoryOnLaunch',
  'trimMemoryInGame',
  'maxConcurrentDownloads',
  'downloadConcurrency',
  'downloadSpeedLimitKbps',
  'downloadBandwidthLimit',
  'maxDownloadSpeedMbps',
  'downloadLimitMbps',
  'defaultInstallDir',
  'defaultInstallPath',
  'defaultInstallDirectory',
  'installDirectory',
  'libraryDirectories',
  'extraLibraryPaths',
  'additionalLibraryPaths',
  'libraryPaths',
  'defaultCompatLayer',
  'preferredCompatLayer',
  'preferredMacCompatLayer',
  'defaultBottleName',
  'autoUpdateCompatLayers',
  'enableCloudSaves',
  'enableCloudSaveSync',
  'cloudSaveSync',
  'cloudSaveSyncEnabled',
  'autoCloudSync',
  'autoSyncCloudSaves',
  'enableEsync',
  'enableFsync',
  'enableMsync',
  'enableMetalHud',
  'enableDxvk',
  'enableD3dMetal',
  'enableGameMode',
  'enableMangoHud',
  'minimizeToTray',
  'minimizeToTrayOnClose',
  'closeToTray',
  'startMinimized',
  'launchAtLogin',
  'launchOnStartup',
  'autoLaunch',
  'autoCheckUpdates',
  'autoCheckForUpdates',
  'checkForUpdatesOnStartup',
  'closeStorefrontClientAfterExit',
  'closeStorefrontClientsAfterExit',
  'autoCloseStorefrontClients',
  'closeHelperClientsPostSession',
  'suppressStorefrontClientPopups',
  'offlineVaultTier',
  'xboxSyncMode',
  'reduceMotion',
  'language',
  'locale',
  'theme',
  'telemetryEnabled',
  'diagnosticsEnabled',
  'debugLogging',
]);

/**
 * Strip dangerous dynamic-linker and Node/Electron runtime injection environment keys
 * (`LD_PRELOAD`, `LD_LIBRARY_PATH`, `DYLD_INSERT_LIBRARIES`, `DYLD_LIBRARY_PATH`,
 * `DYLD_FRAMEWORK_PATH`, `NODE_OPTIONS`, `ELECTRON_RUN_AS_NODE`) from an `env` map or string.
 */
function sanitizeLaunchEnvironmentMap(rawEnv) {
  if (typeof rawEnv === 'string') {
    return rawEnv
      .replace(
        /(?:^|\s+)(?:LD_PRELOAD|LD_LIBRARY_PATH|LD_AUDIT|DYLD_INSERT_LIBRARIES|DYLD_LIBRARY_PATH|DYLD_FRAMEWORK_PATH|DYLD_FALLBACK_LIBRARY_PATH|NODE_OPTIONS|ELECTRON_RUN_AS_NODE)\s*=\s*(?:"[^"]*"|'[^']*'|[^\s]*)/gi,
        ''
      )
      .replace(/\0/g, '')
      .trim();
  }
  if (!rawEnv || typeof rawEnv !== 'object' || Array.isArray(rawEnv)) {
    return {};
  }
  const cleanEnv = {};
  for (const [rawKey, rawVal] of Object.entries(rawEnv)) {
    if (rawKey === '__proto__' || rawKey === 'constructor' || rawKey === 'prototype') continue;
    const trimmedKey = String(rawKey || '').trim();
    if (!trimmedKey || trimmedKey.includes('\0') || trimmedKey.includes('=')) continue;
    if (DANGEROUS_LAUNCH_ENV_KEYS.has(trimmedKey.toUpperCase())) continue;
    if (rawVal === undefined || rawVal === null || typeof rawVal === 'function' || typeof rawVal === 'object') {
      continue;
    }
    const strVal = String(rawVal);
    if (strVal.includes('\0')) continue;
    cleanEnv[trimmedKey] = strVal;
  }
  return cleanEnv;
}

/**
 * Recursively sanitize renderer launch configs / launch payloads at ALL nesting depths
 * (top-level, `launchConfig`, `platformConfigs.*`, `storefrontConfigs.*`), stripping
 * forbidden DI keys, prototype pollution keys, and dangerous dynamic-linker env variables.
 */
function sanitizeLaunchConfigRecursive(rawValue, depth = 0) {
  if (depth > 10) return undefined;
  if (rawValue === null || rawValue === undefined) return rawValue;
  if (typeof rawValue === 'function') return undefined;
  if (Array.isArray(rawValue)) {
    return rawValue
      .map((item) => sanitizeLaunchConfigRecursive(item, depth + 1))
      .filter((item) => item !== undefined);
  }
  if (typeof rawValue !== 'object') {
    return typeof rawValue === 'string' ? rawValue.replace(/\0/g, '') : rawValue;
  }

  const clean = {};
  for (const [key, value] of Object.entries(rawValue)) {
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue;
    if (FORBIDDEN_RENDERER_IPC_KEYS.has(key)) continue;
    if (typeof value === 'function') continue;

    if (LAUNCH_ENV_MAP_FIELDS.has(key)) {
      clean[key] = sanitizeLaunchEnvironmentMap(value);
      continue;
    }

    const sanitizedChild = sanitizeLaunchConfigRecursive(value, depth + 1);
    if (sanitizedChild !== undefined) {
      clean[key] = sanitizedChild;
    }
  }
  return clean;
}

/**
 * Strict allowlist validator for `launcher:save-settings` / `launcher:save-performance-settings`.
 */
function sanitizeLauncherSettingsPayload(rawSettings) {
  if (!rawSettings || typeof rawSettings !== 'object' || Array.isArray(rawSettings)) {
    return {};
  }
  const clean = {};
  for (const [key, value] of Object.entries(rawSettings)) {
    if (!Object.prototype.hasOwnProperty.call(rawSettings, key)) continue;
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue;
    if (!ALLOWED_LAUNCHER_SETTINGS_KEYS.has(key)) continue;

    if (typeof value === 'boolean') {
      clean[key] = value;
    } else if (typeof value === 'number' && Number.isFinite(value)) {
      clean[key] = value;
    } else if (typeof value === 'string' && !value.includes('\0') && value.length <= 2048) {
      clean[key] = value;
    } else if (Array.isArray(value)) {
      clean[key] = value
        .filter((v) => typeof v === 'string' && !v.includes('\0') && v.length <= 2048)
        .slice(0, 64);
    }
  }
  return clean;
}

/**
 * Compute deterministic SHA-256 fingerprint for a `{ field, command }` launch override.
 */
function computeLaunchCommandFingerprint(field, rawCommand) {
  const normField = String(field || '').trim();
  const normCmd = String(rawCommand || '').trim();
  return crypto.createHash('sha256').update(`${normField}:${normCmd}`, 'utf8').digest('hex');
}

/**
 * Recursively collect every non-empty shell/executable field (`preLaunchCommand`, `postExitCommand`,
 * `wrapperCommand`, `customExecutable`, `executablePath`) across ALL nesting depths (including
 * `platformConfigs.*`, `storefrontConfigs.*`, and `launchConfig`).
 *
 * @param {unknown} cfg
 * @param {string} [scopePrefix]
 * @param {number} [depth]
 * @returns {Array<{ scopePath: string, field: string, value: string, fingerprint: string }>}
 */
function collectLaunchCommandsRecursive(cfg, scopePrefix = '', depth = 0) {
  /** @type {Array<{ scopePath: string, field: string, value: string, fingerprint: string }>} */
  const collected = [];
  if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg) || depth > 10) {
    return collected;
  }

  for (const [key, value] of Object.entries(cfg)) {
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue;
    if (LAUNCH_ENV_MAP_FIELDS.has(key)) continue;

    if (LAUNCH_SHELL_OR_EXEC_FIELDS.includes(key)) {
      if (typeof value === 'string' && value.trim()) {
        const trimmed = value.trim();
        const scopePath = scopePrefix ? `${scopePrefix}.${key}` : key;
        collected.push({
          scopePath,
          field: key,
          value: trimmed,
          fingerprint: computeLaunchCommandFingerprint(key, trimmed),
        });
      }
      continue;
    }

    if (value && typeof value === 'object' && !Array.isArray(value)) {
      const nextPrefix = scopePrefix ? `${scopePrefix}.${key}` : key;
      const nested = collectLaunchCommandsRecursive(value, nextPrefix, depth + 1);
      for (const item of nested) {
        collected.push(item);
      }
    }
  }

  return collected;
}

// ============================================================================
// Main-Process Approved Launch Commands Store (`userData/approved_launch_commands.json`)
// ============================================================================

const approvedCommandsCacheByFile = new Map();

function getApprovedLaunchCommandsFilePath(options = {}) {
  const userDataDir = resolveEffectiveUserDataDir(options);
  return path.join(userDataDir, 'approved_launch_commands.json');
}

function readApprovedLaunchCommandsObject(options = {}) {
  const filePath = getApprovedLaunchCommandsFilePath(options);
  try {
    if (!fs.existsSync(filePath)) {
      approvedCommandsCacheByFile.delete(filePath);
      return { games: {} };
    }
    const st = fs.statSync(filePath);
    const cached = approvedCommandsCacheByFile.get(filePath);
    if (cached && cached.mtimeMs === st.mtimeMs && cached.size === st.size) {
      return cached.data;
    }
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    const normalized =
      parsed && typeof parsed === 'object' && parsed.games && typeof parsed.games === 'object'
        ? parsed
        : { games: {} };
    approvedCommandsCacheByFile.set(filePath, {
      mtimeMs: st.mtimeMs,
      size: st.size,
      data: normalized,
    });
    return normalized;
  } catch (err) {
    diagLog.warn('security.readApprovedLaunchCommands', err, { filePath });
    return { games: {} };
  }
}

function isLaunchCommandApproved(gameId, fingerprint, options = {}) {
  const cleanGameId = String(gameId || '').trim();
  const cleanFp = String(fingerprint || '').trim();
  if (!cleanGameId || !cleanFp) return false;
  const store = readApprovedLaunchCommandsObject(options);
  const gameApprovals = store?.games?.[cleanGameId];
  if (!gameApprovals || typeof gameApprovals !== 'object') return false;
  return Boolean(gameApprovals[cleanFp]?.approved === true);
}

function approveLaunchCommands(gameId, entries, options = {}) {
  const cleanGameId = String(gameId || '').trim();
  if (!cleanGameId || !Array.isArray(entries) || entries.length === 0) return false;
  const filePath = getApprovedLaunchCommandsFilePath(options);
  const current = readApprovedLaunchCommandsObject(options);
  const prevForGame =
    current?.games?.[cleanGameId] && typeof current.games[cleanGameId] === 'object'
      ? { ...current.games[cleanGameId] }
      : {};
  const nowIso = new Date().toISOString();

  for (const entry of entries) {
    if (!entry || !entry.fingerprint) continue;
    prevForGame[entry.fingerprint] = {
      approved: true,
      field: String(entry.field || ''),
      scopePath: String(entry.scopePath || entry.field || ''),
      approvedAt: nowIso,
    };
  }

  const nextPayload = {
    games: {
      ...(current?.games || {}),
      [cleanGameId]: prevForGame,
    },
    updatedAt: nowIso,
  };

  try {
    atomicWriteSecureFileSync(filePath, JSON.stringify(nextPayload, null, 2), options);
    approvedCommandsCacheByFile.delete(filePath);
    return true;
  } catch (err) {
    diagLog.warn('security.writeApprovedLaunchCommands', err, { filePath, gameId: cleanGameId });
    return false;
  }
}

function revokeApprovedLaunchCommands(gameId, options = {}) {
  const cleanGameId = String(gameId || '').trim();
  if (!cleanGameId) return false;
  const filePath = getApprovedLaunchCommandsFilePath(options);
  const current = readApprovedLaunchCommandsObject(options);
  if (!current?.games || !Object.prototype.hasOwnProperty.call(current.games, cleanGameId)) {
    return true;
  }
  const nextGames = { ...current.games };
  delete nextGames[cleanGameId];
  const nextPayload = { games: nextGames, updatedAt: new Date().toISOString() };
  try {
    atomicWriteSecureFileSync(filePath, JSON.stringify(nextPayload, null, 2), options);
    approvedCommandsCacheByFile.delete(filePath);
    return true;
  } catch (err) {
    diagLog.warn('security.revokeApprovedLaunchCommands', err, { filePath, gameId: cleanGameId });
    return false;
  }
}

/**
 * Enforce interactive `dialog.showMessageBox` user confirmation for any unapproved shell/executable
 * field (`preLaunchCommand`, `postExitCommand`, `wrapperCommand`, `customExecutable`, `executablePath`)
 * at ANY nesting depth (including `platformConfigs.*` and `storefrontConfigs.*`), persisting confirmed
 * `{ gameId, commandFingerprint }` entries in `userData/approved_launch_commands.json`.
 */
async function confirmAndApproveLaunchCommands({
  gameId,
  configOrPayload,
  dialog,
  parentWindow,
  options = {},
}) {
  const allEntries = collectLaunchCommandsRecursive(configOrPayload);
  if (allEntries.length === 0) {
    return { approved: true, unapprovedEntries: [] };
  }

  const cleanGameId = String(gameId || '').trim();
  if (!cleanGameId) {
    return {
      approved: false,
      error: 'Custom shell commands and executables require a valid gameId.',
    };
  }

  // Deduplicate by fingerprint while preserving human-readable scope descriptions
  const unapprovedByFp = new Map();
  for (const entry of allEntries) {
    if (!isLaunchCommandApproved(cleanGameId, entry.fingerprint, options)) {
      if (!unapprovedByFp.has(entry.fingerprint)) {
        unapprovedByFp.set(entry.fingerprint, entry);
      }
    }
  }

  const unapprovedEntries = [...unapprovedByFp.values()];
  if (unapprovedEntries.length === 0) {
    return { approved: true, unapprovedEntries: [] };
  }

  if (!dialog || typeof dialog.showMessageBox !== 'function') {
    return {
      approved: false,
      error: 'Custom shell commands require native OS confirmation.',
    };
  }

  const formattedCommands = unapprovedEntries
    .map((entry) => `${entry.scopePath}: ${entry.value}`)
    .join('\n');

  const boxOptions = {
    type: 'warning',
    buttons: ['Allow Shell Command', 'Cancel'],
    defaultId: 1,
    cancelId: 1,
    noLink: true,
    title: 'Confirm Custom Launch Command or Executable',
    message: 'Allow custom launch command or executable for this game?',
    detail:
      'Custom pre-launch, post-exit, wrapper commands, and custom executables run directly with your user permissions:\n\n' +
      formattedCommands,
  };

  const result =
    parentWindow && !parentWindow.isDestroyed?.()
      ? await dialog.showMessageBox(parentWindow, boxOptions)
      : await dialog.showMessageBox(boxOptions);

  if (!result || result.response !== 0) {
    return {
      approved: false,
      cancelled: true,
      error: 'Custom shell command cancelled by user.',
    };
  }

  approveLaunchCommands(cleanGameId, unapprovedEntries, options);
  return { approved: true, unapprovedEntries };
}

// ============================================================================
// Account Logout Tombstones (`one_launcher_disconnected_stores.json`)
// ============================================================================

const tombstoneCacheByFile = new Map();

function normalizeStoreKey(store) {
  return String(store || '')
    .trim()
    .toLowerCase();
}

function getDisconnectedStoresFilePath(options = {}) {
  const userDataDir = resolveEffectiveUserDataDir(options);
  return path.join(userDataDir, 'one_launcher_disconnected_stores.json');
}

function readDisconnectedStoresObject(options = {}) {
  const filePath = getDisconnectedStoresFilePath(options);
  try {
    if (!fs.existsSync(filePath)) {
      tombstoneCacheByFile.delete(filePath);
      return { stores: {} };
    }
    const st = fs.statSync(filePath);
    const cached = tombstoneCacheByFile.get(filePath);
    if (cached && cached.mtimeMs === st.mtimeMs && cached.size === st.size) {
      return cached.data;
    }
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    const normalized =
      parsed && typeof parsed === 'object' && parsed.stores && typeof parsed.stores === 'object'
        ? parsed
        : { stores: {} };
    tombstoneCacheByFile.set(filePath, {
      mtimeMs: st.mtimeMs,
      size: st.size,
      data: normalized,
    });
    return normalized;
  } catch (err) {
    diagLog.warn('security.readDisconnectedStores', err, { filePath });
    return { stores: {} };
  }
}

function isStoreDisconnectedTombstoned(store, options = {}) {
  const normStore = normalizeStoreKey(store);
  if (!normStore) return false;
  const parsed = readDisconnectedStoresObject(options);
  return Boolean(parsed?.stores?.[normStore]?.disconnected === true);
}

function clearStoreDisconnectedTombstone(store, options = {}) {
  const normStore = normalizeStoreKey(store);
  if (!normStore) return { success: false };
  const filePath = getDisconnectedStoresFilePath(options);
  const current = readDisconnectedStoresObject(options);
  if (current?.stores && Object.prototype.hasOwnProperty.call(current.stores, normStore)) {
    const nextStores = { ...current.stores };
    delete nextStores[normStore];
    const nextPayload = { stores: nextStores, updatedAt: new Date().toISOString() };
    try {
      atomicWriteSecureFileSync(filePath, JSON.stringify(nextPayload, null, 2), options);
      tombstoneCacheByFile.delete(filePath);
    } catch (err) {
      diagLog.warn('security.clearTombstone', err, { store: normStore, filePath });
    }
  }
  return { success: true, store: normStore, tombstoned: false };
}

/**
 * Purge One Launcher's helper CLI credential files (`legendaryConfig/legendary/user.json`,
 * `gog_store/auth.json`) AND persist a logout tombstone so external Heroic/Legendary files
 * never silently resurrect a disconnected account on next startup or launch.
 */
function purgeStoreHelperCredentials(store, options = {}) {
  const normStore = normalizeStoreKey(store);
  if (!normStore) return { success: false, error: 'Missing store identifier' };

  const userDataDir = resolveEffectiveUserDataDir(options);
  const filePath = getDisconnectedStoresFilePath(options);
  const current = readDisconnectedStoresObject(options);
  const nextPayload = {
    stores: {
      ...(current?.stores || {}),
      [normStore]: {
        disconnected: true,
        disconnectedAt: new Date().toISOString(),
      },
    },
    updatedAt: new Date().toISOString(),
  };

  try {
    atomicWriteSecureFileSync(filePath, JSON.stringify(nextPayload, null, 2), options);
    tombstoneCacheByFile.delete(filePath);
  } catch (err) {
    diagLog.warn('security.writeTombstone', err, { store: normStore, filePath });
  }

  const unlinkedPaths = [];
  const candidateFiles = [];
  if (normStore === 'epic') {
    candidateFiles.push(path.join(userDataDir, 'legendaryConfig', 'legendary', 'user.json'));
    if (options.legendaryConfigDir) {
      candidateFiles.push(path.join(options.legendaryConfigDir, 'user.json'));
    }
    if (options.legendaryConfigPath) {
      candidateFiles.push(path.join(options.legendaryConfigPath, 'user.json'));
    }
  } else if (normStore === 'gog') {
    candidateFiles.push(
      path.join(userDataDir, 'gog_store', 'auth.json'),
      path.join(userDataDir, 'gogdlConfig', 'auth.json')
    );
    if (options.gogAuthPath) {
      candidateFiles.push(options.gogAuthPath);
    }
  }

  for (const credFile of candidateFiles) {
    if (!credFile) continue;
    try {
      if (fs.existsSync(credFile)) {
        fs.unlinkSync(credFile);
        unlinkedPaths.push(credFile);
      }
    } catch (err) {
      diagLog.warn('security.purgeHelperCredFile', err, { store: normStore, credFile });
    }
  }

  return {
    success: true,
    store: normStore,
    tombstoned: true,
    unlinkedPaths,
  };
}

// ============================================================================
// Official Epic Games Launcher Import Registry (`one_launcher_epic_imports.json`)
// ============================================================================

function getEpicImportsFilePath(options = {}) {
  const userDataDir = resolveEffectiveUserDataDir(options);
  return path.join(userDataDir, 'one_launcher_epic_imports.json');
}

function getImportedEpicInstalls(options = {}) {
  const filePath = getEpicImportsFilePath(options);
  try {
    if (!fs.existsSync(filePath)) return { imports: {} };
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    if (parsed && typeof parsed === 'object' && parsed.imports && typeof parsed.imports === 'object') {
      return parsed;
    }
  } catch (err) {
    diagLog.warn('security.readEpicImports', err, { filePath });
  }
  return { imports: {} };
}

function recordImportedEpicInstall(appNameOrEntry, installPathOrOptions, maybeOptions = {}) {
  let rawApp = '';
  let rawPath = '';
  let rawSource = '';
  let options = maybeOptions || {};

  if (appNameOrEntry && typeof appNameOrEntry === 'object') {
    rawApp = appNameOrEntry.appName || appNameOrEntry.app_name || '';
    rawPath = appNameOrEntry.installPath || appNameOrEntry.install_path || '';
    rawSource = appNameOrEntry.source || '';
    options =
      installPathOrOptions && typeof installPathOrOptions === 'object' ? installPathOrOptions : {};
  } else {
    rawApp = appNameOrEntry;
    rawPath = installPathOrOptions;
  }

  const cleanApp = String(rawApp || '').trim();
  const cleanPath = String(rawPath || '').trim();
  if (!cleanApp && !cleanPath) return false;
  const recordKey = cleanApp || cleanPath;
  const filePath = getEpicImportsFilePath(options);
  try {
    const existing = getImportedEpicInstalls(options);
    const prev = existing.imports ? existing.imports[recordKey] : null;
    if (
      prev &&
      prev.appName === cleanApp &&
      prev.installPath === cleanPath &&
      (!rawSource || prev.source === rawSource)
    ) {
      return true;
    }
    const next = {
      imports: {
        ...(existing.imports || {}),
        [recordKey]: {
          appName: cleanApp,
          installPath: cleanPath,
          ...(rawSource ? { source: String(rawSource) } : {}),
          importedAt: prev?.importedAt || new Date().toISOString(),
        },
      },
      updatedAt: new Date().toISOString(),
    };
    atomicWriteFileSync(filePath, JSON.stringify(next, null, 2));
    return true;
  } catch (err) {
    diagLog.warn('security.recordEpicImport', err, { appName: cleanApp, installPath: cleanPath });
    return false;
  }
}

// ============================================================================
// Windows Known Folder Redirection (Async Cached — Zero Sync PowerShell/Reg)
// ============================================================================

let cachedLiveWinKnownFolders = null;
let cachedLiveWinKnownFoldersAt = 0;
let inFlightWinKnownFoldersRefresh = null;
const WIN_KNOWN_FOLDERS_TTL_MS = 5 * 60 * 1000;

function clearCachedWindowsKnownFolders() {
  cachedLiveWinKnownFolders = null;
  cachedLiveWinKnownFoldersAt = 0;
}

function buildKnownFolderEnvHelpers(options = {}) {
  const rawOsHome = os.homedir();
  const rawEnvForHome =
    options.env && typeof options.env === 'object' ? options.env : process.env;
  const envUserProfile = String(
    rawEnvForHome.USERPROFILE || rawEnvForHome.userprofile || ''
  ).trim();
  const homedir =
    options.homedir ||
    options.userProfile ||
    (process.platform === 'win32' &&
    envUserProfile &&
    !envUserProfile.includes('\uFFFD') &&
    (!rawOsHome || rawOsHome.startsWith('/'))
      ? envUserProfile
      : rawOsHome && !rawOsHome.includes('\uFFFD')
        ? rawOsHome
        : envUserProfile || rawOsHome);
  const hasWinDriveInOverrides = Boolean(
    /^[A-Za-z]:[\\/]/.test(String(homedir)) ||
      String(homedir).startsWith('\\\\') ||
      /[A-Za-z]:[\\/]/.test(String(options.windowsRegistryOutput || '')) ||
      (options.windowsKnownFolders &&
        Object.values(options.windowsKnownFolders).some(
          (v) => typeof v === 'string' && (/^[A-Za-z]:[\\/]/.test(v) || v.startsWith('\\\\'))
        )) ||
      (options.env &&
        Object.values(options.env).some(
          (v) => typeof v === 'string' && (/^[A-Za-z]:[\\/]/.test(v) || v.startsWith('\\\\'))
        ))
  );
  const useWinSep =
    process.platform === 'win32' || options.platform === 'win32' || hasWinDriveInOverrides;
  const pathImpl = useWinSep ? path.win32 : path.posix;
  const normalizeWinOrHost = (p) => {
    if (!p || typeof p !== 'string') return '';
    if (
      process.platform === 'win32' ||
      options.platform === 'win32' ||
      /^[A-Za-z]:[\\/]/.test(p) ||
      p.startsWith('\\\\')
    ) {
      return path.win32.normalize(p.replace(/\//g, '\\'));
    }
    return path.posix.normalize(p.replace(/\\/g, '/'));
  };

  const rawEnv =
    options.env && typeof options.env === 'object'
      ? options.env
      : !options.homedir
        ? process.env
        : {};

  const envLookup = new Map();
  for (const [k, v] of Object.entries(rawEnv)) {
    if (typeof v === 'string' && v.trim() && !v.includes('\uFFFD')) {
      envLookup.set(k.toUpperCase(), v.trim());
    }
  }
  if (!envLookup.has('USERPROFILE')) {
    envLookup.set('USERPROFILE', homedir);
  }
  if (!envLookup.has('HOMEPATH')) {
    envLookup.set('HOMEPATH', homedir);
  }
  const oneDriveBase =
    envLookup.get('ONEDRIVECONSUMER') ||
    envLookup.get('ONEDRIVE') ||
    envLookup.get('ONEDRIVECOMMERCIAL') ||
    '';
  if (oneDriveBase) {
    if (!envLookup.has('ONEDRIVE')) envLookup.set('ONEDRIVE', oneDriveBase);
    if (!envLookup.has('ONEDRIVECONSUMER')) envLookup.set('ONEDRIVECONSUMER', oneDriveBase);
    if (!envLookup.has('ONEDRIVECOMMERCIAL')) envLookup.set('ONEDRIVECOMMERCIAL', oneDriveBase);
  }
  if (!envLookup.has('LOCALAPPDATA')) {
    envLookup.set('LOCALAPPDATA', pathImpl.join(homedir, 'AppData', 'Local'));
  }
  if (!envLookup.has('APPDATA')) {
    envLookup.set('APPDATA', pathImpl.join(homedir, 'AppData', 'Roaming'));
  }

  const expandWinEnvString = (val) => {
    if (!val || typeof val !== 'string') return '';
    if (val.includes('\uFFFD') || val.includes('\0')) return '';
    let unresolved = false;
    const expanded = val.trim().replace(/%([^%]+)%/g, (full, varName) => {
      const found = envLookup.get(String(varName || '').toUpperCase());
      if (found && !found.includes('\uFFFD')) return found;
      unresolved = true;
      return full;
    });
    if (unresolved || /%[^%]+%/.test(expanded) || expanded.includes('\uFFFD')) return '';
    return normalizeWinOrHost(expanded);
  };

  return { homedir, pathImpl, normalizeWinOrHost, envLookup, expandWinEnvString };
}

function applyRegistryOutputToKnownFolders(regOutput, current, expandWinEnvString) {
  if (!regOutput || typeof regOutput !== 'string') return current;
  const next = { ...current };
  const lines = regOutput.split(/\r?\n/);
  for (const rawLine of lines) {
    const m = rawLine.match(/^\s*(.+?)\s+REG_(?:EXPAND_)?SZ\s+(.+)$/i);
    if (!m) continue;
    const keyName = m[1].trim().toLowerCase();
    const expandedVal = expandWinEnvString(m[2].trim());
    if (!expandedVal) continue;

    if (keyName === 'personal' || keyName === '{f42ee2d3-909f-4907-8871-4c22fc0bf756}') {
      next.documents = expandedVal;
    } else if (
      keyName === '{4c5c32ff-bb9d-43b0-b5b4-2d72e54eaaa4}' ||
      keyName === 'saved games'
    ) {
      next.savedGames = expandedVal;
    } else if (keyName === 'local appdata') {
      next.localAppData = expandedVal;
    } else if (keyName === 'appdata') {
      next.roamingAppData = expandedVal;
    } else if (
      keyName === '{a520a1a4-1780-4ff6-bd18-167343c5af16}' ||
      keyName === 'locallow'
    ) {
      next.localLowAppData = expandedVal;
    }
  }
  return next;
}

function applyParsedKnownFoldersJson(parsedJson, current, expandWinEnvString, normalizeWinOrHost) {
  if (!parsedJson || typeof parsedJson !== 'object' || Array.isArray(parsedJson)) {
    return current;
  }
  const sanitizeCandidate = (rawVal) => {
    if (typeof rawVal !== 'string') return '';
    const trimmed = rawVal.trim();
    if (!trimmed || trimmed.includes('\uFFFD') || trimmed.includes('\0')) {
      return '';
    }
    if (/%[^%]+%/.test(trimmed)) {
      return expandWinEnvString(trimmed);
    }
    return normalizeWinOrHost(trimmed);
  };

  const next = { ...current };
  const docs = sanitizeCandidate(
    parsedJson.Personal ?? parsedJson.Documents ?? parsedJson.documents
  );
  if (docs) next.documents = docs;

  const saved = sanitizeCandidate(
    parsedJson.SavedGames ??
      parsedJson.savedGames ??
      parsedJson['Saved Games'] ??
      parsedJson['{4C5C32FF-BB9D-43B0-B5B4-2D72E54EAAA4}']
  );
  if (saved) next.savedGames = saved;

  const local = sanitizeCandidate(
    parsedJson.LocalAppData ?? parsedJson.localAppData ?? parsedJson['Local AppData']
  );
  if (local) next.localAppData = local;

  const roaming = sanitizeCandidate(
    parsedJson.AppData ?? parsedJson.RoamingAppData ?? parsedJson.roamingAppData
  );
  if (roaming) next.roamingAppData = roaming;

  const localLow = sanitizeCandidate(
    parsedJson.LocalLow ??
      parsedJson.LocalLowAppData ??
      parsedJson.localLowAppData ??
      parsedJson['{A520A1A4-1780-4FF6-BD18-167343C5AF16}']
  );
  if (localLow) next.localLowAppData = localLow;

  return next;
}

/**
 * Asynchronously refresh Windows Known Folders via non-blocking `reg.exe` (`execFile`),
 * with zero mutual recursion with `resolveHostWindowsKnownFolders`.
 */
function refreshHostWindowsKnownFoldersAsync(options = {}) {
  if (process.platform !== 'win32') {
    return Promise.resolve(resolveHostWindowsKnownFolders(options));
  }
  if (inFlightWinKnownFoldersRefresh) {
    return inFlightWinKnownFoldersRefresh;
  }
  const isVitest = Boolean(process.env.VITEST || process.env.NODE_ENV === 'test');
  if (isVitest && !options.allowRegistryDiscoveryInTest) {
    return Promise.resolve(
      cachedLiveWinKnownFolders
        ? { ...cachedLiveWinKnownFolders }
        : resolveHostWindowsKnownFolders(options)
    );
  }

  inFlightWinKnownFoldersRefresh = new Promise((resolve) => {
    try {
      execFile(
        'reg.exe',
        [
          'query',
          'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\User Shell Folders',
        ],
        { encoding: 'utf8', timeout: 2000, windowsHide: true },
        (err, stdout) => {
          if (!err && stdout) {
            const { homedir, pathImpl, normalizeWinOrHost, envLookup, expandWinEnvString } =
              buildKnownFolderEnvHelpers();
            let base = {
              homedir: normalizeWinOrHost(homedir),
              documents: normalizeWinOrHost(pathImpl.join(homedir, 'Documents')),
              savedGames: normalizeWinOrHost(pathImpl.join(homedir, 'Saved Games')),
              localAppData:
                expandWinEnvString(envLookup.get('LOCALAPPDATA') || '') ||
                normalizeWinOrHost(pathImpl.join(homedir, 'AppData', 'Local')),
              roamingAppData:
                expandWinEnvString(envLookup.get('APPDATA') || '') ||
                normalizeWinOrHost(pathImpl.join(homedir, 'AppData', 'Roaming')),
              localLowAppData: normalizeWinOrHost(pathImpl.join(homedir, 'AppData', 'LocalLow')),
            };
            try {
              const electronDocs = electron.app?.getPath?.('documents');
              if (typeof electronDocs === 'string' && electronDocs.trim() && !electronDocs.includes('\uFFFD')) {
                base.documents = normalizeWinOrHost(electronDocs.trim());
              }
              const electronAppData = electron.app?.getPath?.('appData');
              if (typeof electronAppData === 'string' && electronAppData.trim() && !electronAppData.includes('\uFFFD')) {
                base.roamingAppData = normalizeWinOrHost(electronAppData.trim());
              }
            } catch {}
            base = applyRegistryOutputToKnownFolders(String(stdout), base, expandWinEnvString);
            cachedLiveWinKnownFolders = base;
            cachedLiveWinKnownFoldersAt = Date.now();
            resolve({ ...base });
            return;
          }
          resolve(cachedLiveWinKnownFolders ? { ...cachedLiveWinKnownFolders } : null);
        }
      );
    } catch {
      resolve(cachedLiveWinKnownFolders ? { ...cachedLiveWinKnownFolders } : null);
    }
  }).finally(() => {
    inFlightWinKnownFoldersRefresh = null;
  });

  return inFlightWinKnownFoldersRefresh;
}

/**
 * Resolve Windows Known Folders (`Documents`, `Saved Games`, `AppData\Local`, `AppData\Roaming`,
 * `AppData\LocalLow`) with an in-memory cache so hot paths never spawn subprocesses repeatedly.
 * On cold start on `win32`, runs a single UTF-8 PowerShell Known Folders query via
 * `childProcess.execFileSync`, rejecting any `\uFFFD` OEM mojibake paths with clean `userProfile`
 * fallbacks, while honoring test overrides (`options.windowsKnownFolders`, `options.windowsRegistryOutput`).
 */
function resolveHostWindowsKnownFolders(options = {}) {
  const hasExplicitSandboxHomedir = Boolean(
    options.homedir && options.homedir !== os.homedir()
  );
  const hasCustomContext = Boolean(
    hasExplicitSandboxHomedir ||
      options.userProfile ||
      options.windowsKnownFolders ||
      options.windowsRegistryOutput !== undefined ||
      options.env ||
      typeof options.execFileSyncFn === 'function'
  );

  if (
    !hasCustomContext &&
    process.platform === 'win32' &&
    cachedLiveWinKnownFolders &&
    Date.now() - cachedLiveWinKnownFoldersAt < WIN_KNOWN_FOLDERS_TTL_MS
  ) {
    return { ...cachedLiveWinKnownFolders };
  }

  const { homedir, pathImpl, normalizeWinOrHost, envLookup, expandWinEnvString } =
    buildKnownFolderEnvHelpers(options);

  let current = {
    homedir: normalizeWinOrHost(homedir),
    documents: normalizeWinOrHost(pathImpl.join(homedir, 'Documents')),
    savedGames: normalizeWinOrHost(pathImpl.join(homedir, 'Saved Games')),
    localAppData:
      expandWinEnvString(envLookup.get('LOCALAPPDATA') || '') ||
      normalizeWinOrHost(pathImpl.join(homedir, 'AppData', 'Local')),
    roamingAppData:
      expandWinEnvString(envLookup.get('APPDATA') || '') ||
      normalizeWinOrHost(pathImpl.join(homedir, 'AppData', 'Roaming')),
    localLowAppData: normalizeWinOrHost(pathImpl.join(homedir, 'AppData', 'LocalLow')),
  };

  // 1. Live Windows Known Folders resolution (Electron UTF-16 SHGetKnownFolderPath + single cached UTF-8 PowerShell query)
  if (
    (process.platform === 'win32' || typeof options.execFileSyncFn === 'function') &&
    !hasExplicitSandboxHomedir &&
    options.windowsRegistryOutput === undefined &&
    !options.windowsKnownFolders
  ) {
    try {
      const electronDocs = electron.app?.getPath?.('documents');
      if (typeof electronDocs === 'string' && electronDocs.trim() && !electronDocs.includes('\uFFFD')) {
        current.documents = normalizeWinOrHost(electronDocs.trim());
      }
      const electronAppData = electron.app?.getPath?.('appData');
      if (typeof electronAppData === 'string' && electronAppData.trim() && !electronAppData.includes('\uFFFD')) {
        current.roamingAppData = normalizeWinOrHost(electronAppData.trim());
      }
    } catch {
      // Fallback below
    }

    const execSyncImpl =
      typeof options.execFileSyncFn === 'function'
        ? options.execFileSyncFn
        : childProcess.execFileSync;
    const psKnownFoldersScript = [
      '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8',
      '$sh = New-Object -ComObject Shell.Application',
      '$sg = try { $n = $sh.Namespace("shell:SavedGames"); if ($n) { $n.Self.Path } else { "" } } catch { "" }',
      '$ll = try { $n = $sh.Namespace("shell:LocalAppDataLow"); if ($n) { $n.Self.Path } else { "" } } catch { "" }',
      '@{',
      "  Personal = [Environment]::GetFolderPath('Personal')",
      '  SavedGames = $sg',
      "  LocalAppData = [Environment]::GetFolderPath('LocalApplicationData')",
      "  AppData = [Environment]::GetFolderPath('ApplicationData')",
      '  LocalLow = $ll',
      '} | ConvertTo-Json -Compress',
    ].join('; ');

    try {
      const rawPsOut = execSyncImpl(
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-ExecutionPolicy',
          'Bypass',
          '-Command',
          psKnownFoldersScript,
        ],
        {
          encoding: 'utf8',
          timeout: 3000,
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'ignore'],
        }
      );
      const stdoutStr = (
        typeof rawPsOut === 'string'
          ? rawPsOut
          : Buffer.isBuffer(rawPsOut)
            ? rawPsOut.toString('utf8')
            : String(rawPsOut ?? '')
      )
        .replace(/^\uFEFF/, '')
        .trim();

      if (stdoutStr.startsWith('{')) {
        const parsedJson = JSON.parse(stdoutStr);
        current = applyParsedKnownFoldersJson(
          parsedJson,
          current,
          expandWinEnvString,
          normalizeWinOrHost
        );
      } else if (/REG_(?:EXPAND_)?SZ/i.test(stdoutStr)) {
        current = applyRegistryOutputToKnownFolders(stdoutStr, current, expandWinEnvString);
      }
    } catch {
      // Fallback cleanly to `current` defaults when PowerShell is unavailable or fails
    }
  }

  // 2. Parse caller-supplied HKCU User Shell Folders registry output (deterministic unit tests)
  if (typeof options.windowsRegistryOutput === 'string' && options.windowsRegistryOutput) {
    current = applyRegistryOutputToKnownFolders(
      options.windowsRegistryOutput,
      current,
      expandWinEnvString
    );
  }

  // 3. Explicit caller overrides (`options.windowsKnownFolders`)
  if (options.windowsKnownFolders && typeof options.windowsKnownFolders === 'object') {
    const kf = options.windowsKnownFolders;
    if (kf.documents) {
      current.documents = expandWinEnvString(kf.documents) || normalizeWinOrHost(kf.documents);
    }
    if (kf.savedGames) {
      current.savedGames = expandWinEnvString(kf.savedGames) || normalizeWinOrHost(kf.savedGames);
    }
    if (kf.localAppData) {
      current.localAppData =
        expandWinEnvString(kf.localAppData) || normalizeWinOrHost(kf.localAppData);
    }
    if (kf.roamingAppData) {
      current.roamingAppData =
        expandWinEnvString(kf.roamingAppData) || normalizeWinOrHost(kf.roamingAppData);
    }
    if (kf.localLowAppData) {
      current.localLowAppData =
        expandWinEnvString(kf.localLowAppData) || normalizeWinOrHost(kf.localLowAppData);
    }
  }

  if (!hasCustomContext && process.platform === 'win32') {
    cachedLiveWinKnownFolders = current;
    cachedLiveWinKnownFoldersAt = Date.now();
  }

  return { ...current };
}

module.exports = {
  toHostFilesystemPath,
  setSecurityUserDataDirResolver,
  resolveEffectiveUserDataDir,
  warmWindowsUserSidAsync,
  resolveCurrentWindowsPrincipalSpec,
  applyWindowsOwnerAclAsync,
  atomicWriteFileSync,
  atomicWriteSecureFileSync,
  isContainedWithinRoot,
  isAllowedHttpsHost,
  isPrivateOrLoopbackIp,
  assertSafePublicHttpsUrl,
  DANGEROUS_LAUNCH_ENV_KEYS,
  LAUNCH_SHELL_OR_EXEC_FIELDS,
  FORBIDDEN_RENDERER_IPC_KEYS,
  ALLOWED_LAUNCHER_SETTINGS_KEYS,
  sanitizeLaunchEnvironmentMap,
  sanitizeLaunchConfigRecursive,
  sanitizeLauncherSettingsPayload,
  computeLaunchCommandFingerprint,
  collectLaunchCommandsRecursive,
  getApprovedLaunchCommandsFilePath,
  isLaunchCommandApproved,
  approveLaunchCommands,
  revokeApprovedLaunchCommands,
  confirmAndApproveLaunchCommands,
  getDisconnectedStoresFilePath,
  isStoreDisconnectedTombstoned,
  clearStoreDisconnectedTombstone,
  purgeStoreHelperCredentials,
  getImportedEpicInstalls,
  recordImportedEpicInstall,
  resolveHostWindowsKnownFolders,
  refreshHostWindowsKnownFoldersAsync,
  clearCachedWindowsKnownFolders,
  isSafeBottleSlug,
  isSafeNumericAppId,
};
