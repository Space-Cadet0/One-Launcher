// @ts-check
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { execFile } = require('node:child_process');
const { diagLog } = require('../utils/diagnosticLogger.cjs');
const { isProcessAlive } = require('./processTreeUtils.cjs');
const { resolveDriveCPathCaseInsensitive } = require('./wineAndCrossOverManager.cjs');
const {
  isNetworkOnlineForLaunch,
  isTestEnvironment,
  getUserDataDir,
} = require('./engineStateRegistry.cjs');

/**
 * Determine whether caller options represent a synthetic test harness rather than a real host launch.
 * Explicitly passing `os.homedir()` or the configured production `userDataDir` must NOT be
 * misclassified as a test override; delegates to `isTestEnvironment`.
 *
 * @param {Record<string, any>} [params]
 * @param {Record<string, any>} [opts]
 * @returns {boolean}
 */
function isSyntheticTestBarrierEnv(params = {}, opts = {}) {
  const realHome = path.resolve(os.homedir());
  let prodUserDataDir = '';
  try {
    const resolvedProd = getUserDataDir();
    if (resolvedProd && typeof resolvedProd === 'string') {
      prodUserDataDir = path.resolve(resolvedProd);
    }
  } catch {}

  const rawHome = opts.homedir || params.homedir;
  const effectiveHomedir =
    typeof rawHome === 'string' && rawHome.trim() && path.resolve(rawHome) !== realHome
      ? rawHome
      : undefined;

  const rawUserData = opts.userDataDir || params.userDataDir;
  const effectiveUserDataDir =
    typeof rawUserData === 'string' &&
    rawUserData.trim() &&
    (!prodUserDataDir || path.resolve(rawUserData) !== prodUserDataDir)
      ? rawUserData
      : undefined;

  return isTestEnvironment({
    homedir: effectiveHomedir,
    userDataDir: effectiveUserDataDir,
  });
}

/**
 * Sleep helper supporting optional AbortSignal (unref'd so pending barriers never pin shutdown).
 * @param {number} ms
 * @param {AbortSignal | null | undefined} [signal]
 * @returns {Promise<void>}
 */
function sleepUnref(ms, signal) {
  if (ms <= 0 || signal?.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (signal && typeof signal.removeEventListener === 'function') {
        signal.removeEventListener('abort', finish);
      }
      resolve();
    };
    const timer = setTimeout(finish, ms);
    if (typeof timer.unref === 'function') {
      timer.unref();
    }
    if (signal && typeof signal.addEventListener === 'function') {
      signal.addEventListener('abort', finish, { once: true });
    }
  });
}

/**
 * Pure line-by-line matcher for native host GOG Galaxy main client process.
 * Strictly excludes Overlay, Helper, Updater, Service, and standalone CommunicationService daemons.
 *
 * @param {string} stdout
 * @param {string} [platform]
 * @returns {boolean}
 */
function doesProcessListHaveHostGogGalaxy(stdout, platform = process.platform) {
  if (!stdout || typeof stdout !== 'string') return false;
  const lines = stdout.split(/\r?\n/);

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;
    if (/^(?:\/bin\/|\/usr\/bin\/)?ps(?:\s|$)/i.test(line)) continue;
    if (/--type=/i.test(line)) continue;

    // Never match overlays, helpers, services, updaters, or standalone GalaxyCommunication daemons
    if (
      /GOG Galaxy Overlay|GalaxyOverlay|GalaxyClientService|GalaxyUpdater|GOG Galaxy Helper|GalaxyClient Helper|GalaxyCommunication/i.test(
        line
      )
    ) {
      continue;
    }

    if (platform === 'win32') {
      const csvMatch = line.match(/^"([^"]+)"\s*,/);
      if (csvMatch) {
        if (csvMatch[1].trim().toLowerCase() === 'galaxyclient.exe') {
          return true;
        }
        continue;
      }
      if (/(?:^|[\\/\s"'])GalaxyClient\.exe(?:\s|["']|$)/i.test(line)) {
        return true;
      }
      continue;
    }

    // macOS / POSIX: ignore Wine/CrossOver .exe binaries running inside bottles
    if (/\.exe(?:\s|["']|$)/i.test(line)) continue;

    // Strip optional leading PID column if caller passed `ps -ax -o pid=,command=`
    const cmdOnly = line.replace(/^\d+\s+/, '').trim();
    if (/--command=shutdown\b/i.test(cmdOnly)) continue;
    const normCmd = cmdOnly.replace(/\\/g, '/');
    if (
      /^(?:["']?(?:(?:[a-z]:)?\/[^"'\n]*)?\/)?GOG Galaxy\.app\/Contents\/MacOS\/GOG Galaxy(?:["']?)(?:\s|$)/i.test(
        normCmd
      )
    ) {
      return true;
    }
    if (/^(?:["']?(?:(?:[a-z]:)?\/[^"']*)?\/)?GOG Galaxy(?:["']?)(?:\s|$)/i.test(normCmd)) {
      return true;
    }
  }

  return false;
}

/**
 * Determine whether the native host GOG Galaxy main client (`GOG Galaxy.app` on macOS,
 * `GalaxyClient.exe` on Windows) is currently running.
 *
 * @param {Record<string, any>} [options]
 * @returns {Promise<boolean>}
 */
async function isHostGogGalaxyRunning(options = {}) {
  const targetPlatform = options.platform || process.platform;

  if (typeof options.mockProcessListOutput === 'string') {
    return doesProcessListHaveHostGogGalaxy(options.mockProcessListOutput, targetPlatform);
  }
  if (typeof options.getProcessListOutput === 'function') {
    try {
      const out = await options.getProcessListOutput();
      return doesProcessListHaveHostGogGalaxy(String(out || ''), targetPlatform);
    } catch {
      return false;
    }
  }

  const customExec =
    typeof options.execFileImpl === 'function'
      ? options.execFileImpl
      : typeof options.execFileFn === 'function'
        ? options.execFileFn
        : null;

  if (options.homedir && !options.allowProcessCheckInTest && !customExec) {
    return false;
  }

  const execFn = customExec || execFile;
  const cmd = targetPlatform === 'win32' ? 'tasklist.exe' : 'ps';
  const cmdArgs = targetPlatform === 'win32' ? ['/FO', 'CSV', '/NH'] : ['-ax', '-o', 'command='];

  return new Promise((resolve) => {
    try {
      execFn(cmd, cmdArgs, { timeout: 1500, windowsHide: true }, (/** @type {any} */ err, /** @type {any} */ stdout) => {
        if (err || !stdout) {
          resolve(false);
          return;
        }
        resolve(doesProcessListHaveHostGogGalaxy(String(stdout), targetPlatform));
      });
    } catch {
      resolve(false);
    }
  });
}

/**
 * Reap orphaned `GOG Galaxy Overlay` / `GalaxyOverlay.exe` processes whose `--attached-pid=<pid>`
 * game process has already exited.
 *
 * @param {Record<string, any>} [options]
 * @returns {Promise<{ reapedPids: number[], skipped?: boolean }>}
 */
async function reapOrphanedGogOverlayProcesses(options = {}) {
  const targetPlatform = options.platform || process.platform;
  const customExec =
    typeof options.execFileImpl === 'function'
      ? options.execFileImpl
      : typeof options.execFileFn === 'function'
        ? options.execFileFn
        : null;

  const isTestEnv = isSyntheticTestBarrierEnv(options, options);
  if (
    isTestEnv &&
    !options.allowOverlayReaperInTest &&
    !customExec &&
    typeof options.mockOverlayProcessList !== 'string'
  ) {
    return { reapedPids: [], skipped: true };
  }

  let rawOutput = '';
  if (typeof options.mockOverlayProcessList === 'string') {
    rawOutput = options.mockOverlayProcessList;
  } else {
    const execFn = customExec || execFile;
    rawOutput = await new Promise((resolve) => {
      try {
        if (targetPlatform === 'win32') {
          execFn(
            'powershell.exe',
            [
              '-NoProfile',
              '-NonInteractive',
              '-WindowStyle',
              'Hidden',
              '-Command',
              'Get-CimInstance Win32_Process -Filter "Name LIKE \'%GalaxyOverlay%\'" | Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress',
            ],
            { timeout: 2500, windowsHide: true },
            (/** @type {any} */ err, /** @type {any} */ stdout) => resolve(err ? '' : String(stdout || ''))
          );
        } else {
          execFn(
            'ps',
            ['-ax', '-o', 'pid=,command='],
            { timeout: 2000 },
            (/** @type {any} */ err, /** @type {any} */ stdout) => resolve(err ? '' : String(stdout || ''))
          );
        }
      } catch {
        resolve('');
      }
    });
  }

  /** @type {number[]} */
  const reapedPids = [];
  if (!rawOutput) return { reapedPids };

  const isPidAliveFn =
    typeof options.isPidAliveFn === 'function'
      ? options.isPidAliveFn
      : (/** @type {number} */ pid) => isProcessAlive(pid);
  const killPidFn =
    typeof options.killPidFn === 'function'
      ? options.killPidFn
      : (/** @type {number} */ pid, /** @type {NodeJS.Signals} */ sig) => process.kill(pid, sig);

  /** @type {string[]} */
  let candidateLines = [];
  const trimmedOutput = rawOutput.trim();
  if (trimmedOutput.startsWith('[') || trimmedOutput.startsWith('{')) {
    try {
      const parsedJson = JSON.parse(trimmedOutput);
      const items = Array.isArray(parsedJson) ? parsedJson : [parsedJson];
      for (const item of items) {
        if (item && typeof item === 'object') {
          const pid = Number(item.ProcessId || item.processId || 0);
          const cmdLine = String(item.CommandLine || item.commandLine || '');
          if (pid > 0 && cmdLine) {
            candidateLines.push(`${pid} ${cmdLine}`);
          }
        }
      }
    } catch {
      candidateLines = rawOutput.split(/\r?\n/);
    }
  } else {
    candidateLines = rawOutput.split(/\r?\n/);
  }

  for (const rawLine of candidateLines) {
    const line = rawLine.trim();
    if (!line) continue;
    if (!/GOG Galaxy Overlay|GalaxyOverlay/i.test(line)) continue;

    const attachedMatch = line.match(/--attached-pid=(\d+)/i);
    if (!attachedMatch) continue;
    const attachedPid = Number(attachedMatch[1]);
    if (!attachedPid || attachedPid <= 0) continue;

    let overlayPid = 0;
    const leadingPidMatch = line.match(/^(\d+)\s+/);
    if (leadingPidMatch) {
      overlayPid = Number(leadingPidMatch[1]);
    } else {
      // CSV fallback (`Node,CommandLine,ProcessId`)
      const trailingCsvPid = line.match(/,(\d+)\s*$/);
      if (trailingCsvPid) {
        overlayPid = Number(trailingCsvPid[1]);
      }
    }

    if (!overlayPid || overlayPid <= 0 || overlayPid === process.pid) continue;

    let attachedAlive = false;
    try {
      attachedAlive = Boolean(isPidAliveFn(attachedPid));
    } catch {
      attachedAlive = false;
    }

    if (!attachedAlive) {
      try {
        killPidFn(overlayPid, 'SIGTERM');
        reapedPids.push(overlayPid);
      } catch (err) {
        diagLog.debug('gogOverlayReaper.killFailed', err, { overlayPid, attachedPid });
      }
    }
  }

  return { reapedPids };
}

/**
 * Normalize a bottle prefix path into lowercase POSIX forward-slash form (raw resolved + realpath).
 *
 * @param {string | null | undefined} bottlePath
 * @returns {{ normTargetPrefix: string, normRealTargetPrefix: string }}
 */
function normalizeBottlePrefixMatchPair(bottlePath) {
  const trimmedBottlePath = String(bottlePath || '').trim();
  if (!trimmedBottlePath) {
    return { normTargetPrefix: '', normRealTargetPrefix: '' };
  }
  const normTargetPrefix = (
    trimmedBottlePath.startsWith('/')
      ? path.posix.resolve(trimmedBottlePath)
      : path.resolve(trimmedBottlePath)
  )
    .replace(/\\/g, '/')
    .replace(/\/+$/, '')
    .toLowerCase();
  let normRealTargetPrefix = normTargetPrefix;
  try {
    if (fs.existsSync(trimmedBottlePath)) {
      normRealTargetPrefix = fs
        .realpathSync(trimmedBottlePath)
        .replace(/\\/g, '/')
        .replace(/\/+$/, '')
        .toLowerCase();
    }
  } catch {}
  return { normTargetPrefix, normRealTargetPrefix };
}

/**
 * Determine whether a `ps` / `ps eww` process line belongs to the target Wine/CrossOver bottle.
 *
 * Uses space-safe `WINEPREFIX=` matching (supporting unquoted macOS paths like
 * `WINEPREFIX=<homedir>/Library/Application Support/CrossOver/Bottles/OneLauncher`, quoted values, and
 * `realpath` aliases) without cross-matching prefix substrings (`OneLauncher-arm64`), while
 * preserving the fallback for synthetic `mockProcessListOutput` lines that omit `WINEPREFIX=`
 * and `/Bottles/...`.
 *
 * @param {string} rawLine
 * @param {string | null | undefined} normTargetPrefix
 * @param {string | null | undefined} [normRealTargetPrefix]
 * @returns {boolean}
 */
function lineMatchesBottlePrefix(rawLine, normTargetPrefix, normRealTargetPrefix = '') {
  if (!rawLine || typeof rawLine !== 'string') return false;
  const candidatePrefixes = Array.from(
    new Set(
      [normTargetPrefix, normRealTargetPrefix]
        .map((p) =>
          String(p || '')
            .trim()
            .replace(/\\/g, '/')
            .replace(/\/+$/, '')
            .toLowerCase()
        )
        .filter(Boolean)
    )
  );
  if (candidatePrefixes.length === 0) {
    return true;
  }

  const lowerLine = rawLine.replace(/\\/g, '/').toLowerCase();
  const hasWinePrefixEnv = /\bwineprefix=/i.test(lowerLine);

  if (hasWinePrefixEnv) {
    for (const pfx of candidatePrefixes) {
      const escapedPfx = pfx.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const exactWinePrefixEnvRegex = new RegExp(
        `\\bwineprefix=(?:["']${escapedPfx}\\/?["']|${escapedPfx}\\/?(?=\\s+[a-z_][a-z0-9_]*=|\\s+["'/]|["'](?:\\s|$)|$))`,
        'i'
      );
      if (exactWinePrefixEnvRegex.test(lowerLine)) {
        return true;
      }
    }
    return false;
  }

  for (const pfx of candidatePrefixes) {
    const escapedPfx = pfx.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const boundedTargetPathRegex = new RegExp(
      `(?:^|[\\s"'=])${escapedPfx}(?:\\/|["']|$)`,
      'i'
    );
    if (boundedTargetPathRegex.test(lowerLine)) {
      return true;
    }
  }

  if (/\/bottles\/[^/\r\n"']+/i.test(lowerLine)) {
    return false;
  }

  return true;
}

/**
 * Acquire raw process-list output for Wine/CrossOver bottle process inspection.
 *
 * @param {Record<string, any>} [options]
 * @returns {Promise<string | null>}
 */
async function readBottleProcessListOutputAsync(options = {}) {
  if (typeof options.mockProcessListOutput === 'string') {
    return options.mockProcessListOutput;
  }
  if (typeof options.getProcessListOutput === 'function') {
    try {
      return String((await options.getProcessListOutput()) || '');
    } catch {
      return null;
    }
  }

  const customExec =
    typeof options.execFileImpl === 'function'
      ? options.execFileImpl
      : typeof options.execFileFn === 'function'
        ? options.execFileFn
        : null;

  if (options.homedir && !options.allowProcessCheckInTest && !customExec) {
    return null;
  }

  const targetPlatform = options.platform || process.platform;
  const execFn = customExec || execFile;
  const psArgs =
    targetPlatform === 'darwin' && !customExec
      ? ['eww', '-ax', '-o', 'command=']
      : ['-ax', '-o', 'command='];

  return new Promise((resolve) => {
    try {
      execFn('ps', psArgs, { timeout: 1500 }, (/** @type {any} */ err, /** @type {any} */ stdout) => {
        resolve(err ? null : String(stdout || ''));
      });
    } catch {
      resolve(null);
    }
  });
}

/**
 * Check whether a Windows `.exe` is currently running inside a specific Wine/CrossOver bottle
 * (`WINEPREFIX`-scoped when environment info is exposed via `ps eww`, falling back cleanly when
 * synthetic `mockProcessListOutput` or custom `execFileImpl` mocks are supplied).
 *
 * @param {string} exeName
 * @param {string} [bottlePath]
 * @param {Record<string, any>} [options]
 * @returns {Promise<boolean>}
 */
async function isBottleWinExeRunning(exeName, bottlePath = '', options = {}) {
  const cleanExe = String(exeName || '').trim();
  if (!cleanExe) return false;

  const outStr = await readBottleProcessListOutputAsync(options);
  if (outStr === null) return false;

  const escapedExe = cleanExe.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const exeRegex = new RegExp(`(?:^|[\\\\/\\s"'])${escapedExe}(?:\\s|["']|$)`, 'i');
  const { normTargetPrefix, normRealTargetPrefix } = normalizeBottlePrefixMatchPair(bottlePath);

  const lines = String(outStr || '').split(/\r?\n/);
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || !exeRegex.test(line)) continue;
    if (/^(?:\/bin\/|\/usr\/bin\/)?ps(?:\s|$)/i.test(line)) continue;
    if (!lineMatchesBottlePrefix(line, normTargetPrefix, normRealTargetPrefix)) continue;
    return true;
  }
  return false;
}

/**
 * Inspect whether Windows `steam.exe` is currently running inside `bottlePath`, returning
 * `{ running, observedBackend, launchedSilent }` using space-safe `WINEPREFIX` matching.
 *
 * @param {string} [bottlePath]
 * @param {Record<string, any>} [options]
 * @returns {Promise<{ running: boolean, observedBackend: string, launchedSilent: boolean }>}
 */
async function inspectRunningBottleSteam(bottlePath = '', options = {}) {
  const outStr = await readBottleProcessListOutputAsync(options);
  if (outStr === null) {
    return { running: false, observedBackend: '', launchedSilent: false };
  }

  const steamExeRegex = /(?:^|[\\/\s"'])steam\.exe(?:\s|["']|$)/i;
  const { normTargetPrefix, normRealTargetPrefix } = normalizeBottlePrefixMatchPair(bottlePath);
  const lines = String(outStr || '').split(/\r?\n/);

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || !steamExeRegex.test(line)) continue;
    if (/^(?:\/bin\/|\/usr\/bin\/)?ps(?:\s|$)/i.test(line)) continue;
    if (!lineMatchesBottlePrefix(line, normTargetPrefix, normRealTargetPrefix)) continue;

    let observedBackend = '';
    const backendMatch = line.match(
      /\bCX_GRAPHICS_BACKEND=(?:"([^"]+)"|'([^']+)'|([^\s"']+))/i
    );
    if (backendMatch) {
      observedBackend = String(backendMatch[1] || backendMatch[2] || backendMatch[3] || '')
        .trim()
        .toLowerCase();
    }
    const launchedSilent = /\s-silent(?:\s|["']|$)/i.test(line);
    return {
      running: true,
      observedBackend,
      launchedSilent,
    };
  }

  return { running: false, observedBackend: '', launchedSilent: false };
}

/**
 * Non-destructive local TCP port connect probe (defaults to GOG Galaxy SDK port `127.0.0.1:9977`).
 *
 * @param {number} [port]
 * @param {string} [host]
 * @param {number} [timeoutMs]
 * @param {Record<string, any>} [options]
 * @returns {Promise<boolean>}
 */
async function probeLocalTcpPort(port = 9977, host = '127.0.0.1', timeoutMs = 350, options = {}) {
  if (typeof options.probeTcpPortFn === 'function') {
    try {
      return Boolean(await options.probeTcpPortFn(port, host, timeoutMs));
    } catch {
      return false;
    }
  }

  return new Promise((resolve) => {
    let settled = false;
    const socket = new net.Socket();
    const finish = (/** @type {boolean} */ ok) => {
      if (settled) return;
      settled = true;
      try {
        socket.destroy();
      } catch {}
      resolve(ok);
    };

    socket.setTimeout(Math.max(25, Number(timeoutMs) || 350));
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));

    try {
      socket.connect(port, host);
    } catch {
      finish(false);
    }
  });
}

/**
 * Resolve `CommunicationService.log` path across native macOS, native Windows, and Wine/CrossOver bottles.
 *
 * @param {{ platform?: string, bottlePath?: string, homedir?: string, gogCommunicationLogPath?: string, options?: Record<string, any> }} [params]
 * @returns {string}
 */
function resolveGogCommunicationLogPath(params = {}) {
  const opts = params.options || {};
  const explicitLogPath = params.gogCommunicationLogPath || opts.gogCommunicationLogPath;
  if (explicitLogPath && typeof explicitLogPath === 'string') {
    return explicitLogPath;
  }

  if (params.bottlePath && typeof params.bottlePath === 'string') {
    const driveC = path.join(params.bottlePath, 'drive_c');
    const resolvedLower = resolveDriveCPathCaseInsensitive(driveC, [
      'ProgramData',
      'GOG.com',
      'Galaxy',
      'logs',
      'CommunicationService.log',
    ]);
    if (fs.existsSync(resolvedLower)) return resolvedLower;
    const resolvedUpper = resolveDriveCPathCaseInsensitive(driveC, [
      'ProgramData',
      'GOG.com',
      'Galaxy',
      'Logs',
      'CommunicationService.log',
    ]);
    if (fs.existsSync(resolvedUpper)) return resolvedUpper;
    return resolvedLower;
  }

  const targetPlatform = params.platform || opts.platform || process.platform;
  if (targetPlatform === 'win32') {
    const progData = String(opts.programDataDir || process.env.PROGRAMDATA || 'C:\\ProgramData');
    if (progData.startsWith('/')) {
      return path.join(progData, 'GOG.com', 'Galaxy', 'logs', 'CommunicationService.log');
    }
    return path.win32.join(progData, 'GOG.com', 'Galaxy', 'logs', 'CommunicationService.log');
  }

  return '/Users/Shared/GOG.com/Galaxy/Logs/CommunicationService.log';
}

/**
 * Resolve `GalaxyClient.log` path across native macOS, native Windows, and Wine/CrossOver bottles.
 *
 * @param {{ platform?: string, bottlePath?: string, homedir?: string, gogClientLogPath?: string, gogCommunicationLogPath?: string, options?: Record<string, any> }} [params]
 * @returns {string}
 */
function resolveGogClientLogPath(params = {}) {
  const opts = params.options || {};
  const explicitClientLogPath = params.gogClientLogPath || opts.gogClientLogPath;
  if (explicitClientLogPath && typeof explicitClientLogPath === 'string') {
    return explicitClientLogPath;
  }

  const explicitCommLogPath = params.gogCommunicationLogPath || opts.gogCommunicationLogPath;
  if (explicitCommLogPath && typeof explicitCommLogPath === 'string') {
    return path.join(path.dirname(explicitCommLogPath), 'GalaxyClient.log');
  }

  if (params.bottlePath && typeof params.bottlePath === 'string') {
    const driveC = path.join(params.bottlePath, 'drive_c');
    const resolvedLower = resolveDriveCPathCaseInsensitive(driveC, [
      'ProgramData',
      'GOG.com',
      'Galaxy',
      'logs',
      'GalaxyClient.log',
    ]);
    if (fs.existsSync(resolvedLower)) return resolvedLower;
    const resolvedUpper = resolveDriveCPathCaseInsensitive(driveC, [
      'ProgramData',
      'GOG.com',
      'Galaxy',
      'Logs',
      'GalaxyClient.log',
    ]);
    if (fs.existsSync(resolvedUpper)) return resolvedUpper;
    return resolvedLower;
  }

  const targetPlatform = params.platform || opts.platform || process.platform;
  if (targetPlatform === 'win32') {
    const progData = String(opts.programDataDir || process.env.PROGRAMDATA || 'C:\\ProgramData');
    if (progData.startsWith('/')) {
      return path.join(progData, 'GOG.com', 'Galaxy', 'logs', 'GalaxyClient.log');
    }
    return path.win32.join(progData, 'GOG.com', 'Galaxy', 'logs', 'GalaxyClient.log');
  }

  return '/Users/Shared/GOG.com/Galaxy/Logs/GalaxyClient.log';
}

/**
 * Inspect `CommunicationService.log` content (string or raw Buffer) to confirm an active
 * authenticated GOG session that has not subsequently shut down.
 * Byte offsets are sliced on raw UTF-8 `Buffer` bytes BEFORE UTF-8 decoding.
 *
 * @param {string | Buffer} logContent
 * @param {number} [startOffset]
 * @returns {boolean}
 */
function hasActiveGogAuthSessionInLog(logContent, startOffset = 0) {
  if (!logContent || (typeof logContent !== 'string' && !Buffer.isBuffer(logContent))) {
    return false;
  }

  const rawBuf = Buffer.isBuffer(logContent) ? logContent : Buffer.from(logContent, 'utf8');
  let sliceBuf = rawBuf;
  if (startOffset > 0) {
    if (startOffset >= rawBuf.length) return false;
    sliceBuf = rawBuf.subarray(startOffset);
  } else if (rawBuf.length > 32768) {
    sliceBuf = rawBuf.subarray(rawBuf.length - 32768);
  }
  const slice = sliceBuf.toString('utf8');

  let activeBlock = slice;
  const startRegex = /Communication service starting|Application started/gi;
  let lastStartMatch = null;
  let m;
  while ((m = startRegex.exec(slice)) !== null) {
    lastStartMatch = m;
  }
  if (lastStartMatch) {
    activeBlock = slice.slice(lastStartMatch.index);
  }

  const authRegex =
    /\[AuthManager(?:\(\d+\))?::AuthListener\]\s+Succeeded to sign in|SelfManagingGogPbConnection::ConnectorListener[^\r\n]*Connection established/gi;
  let lastAuthMatch = null;
  while ((m = authRegex.exec(activeBlock)) !== null) {
    lastAuthMatch = m;
  }
  if (!lastAuthMatch) return false;

  const afterAuth = activeBlock.slice(lastAuthMatch.index + lastAuthMatch[0].length);
  if (/Communication service stopping|Shutting down communication service/i.test(afterAuth)) {
    return false;
  }

  return true;
}

/**
 * Read appended UTF-8 log slice safely using async file handle.
 *
 * @param {string} filePath
 * @param {number} startByteOffset
 * @param {number} [maxBytes]
 * @returns {Promise<{ text: string, size: number } | null>}
 */
async function readLogTailBytesAsync(filePath, startByteOffset = 0, maxBytes = 131072) {
  if (!filePath || !fs.existsSync(filePath)) return null;
  let fh = null;
  try {
    fh = await fs.promises.open(filePath, 'r');
    const st = await fh.stat();
    const effectiveOffset =
      startByteOffset > 0
        ? st.size < startByteOffset
          ? 0
          : startByteOffset
        : Math.max(0, st.size - maxBytes);
    const available = Math.max(0, st.size - effectiveOffset);
    if (available === 0) {
      return { text: '', size: st.size };
    }
    const readLen = Math.min(available, maxBytes);
    const readPos = st.size - readLen;
    const buf = Buffer.alloc(readLen);
    const { bytesRead } = await fh.read(buf, 0, readLen, readPos);
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
}

/**
 * Readiness barrier for GOG Galaxy `GalaxyCommunication` daemon (`127.0.0.1:9977` + active OAuth session).
 *
 * @param {Record<string, any>} [params]
 * @returns {Promise<{ ready: boolean, waitedMs: number, timedOut?: boolean, aborted?: boolean, offlineSkipped?: boolean, reason?: string }>}
 */
async function waitForGogCommunicationServiceReady(params = {}) {
  const opts = params.options && typeof params.options === 'object' ? params.options : params;
  const isTestEnv = isSyntheticTestBarrierEnv(params, opts);
  if (
    isTestEnv &&
    opts.enableGogReadinessBarrier !== true &&
    opts.enableStorefrontReadinessBarrier !== true &&
    params.enableGogReadinessBarrier !== true &&
    params.enableStorefrontReadinessBarrier !== true
  ) {
    return { ready: true, waitedMs: 0, reason: 'skipped_in_test' };
  }

  if (!isNetworkOnlineForLaunch(opts) || !isNetworkOnlineForLaunch(params)) {
    return { ready: true, waitedMs: 0, offlineSkipped: true, reason: 'offline_skipped' };
  }

  const port = Number(params.port ?? opts.gogSdkPort ?? 9977);
  const alreadyRunning = Boolean(params.alreadyRunning);
  const defaultTimeout = params.bottlePath ? 35000 : 15000;
  const timeoutMs = Math.max(
    0,
    Number(params.timeoutMs ?? opts.gogReadinessTimeoutMs ?? defaultTimeout)
  );
  const pollIntervalMs = Math.max(15, Number(params.pollIntervalMs ?? opts.pollIntervalMs ?? 200));
  const signal = params.signal || opts.signal;

  const commLogPath = resolveGogCommunicationLogPath({
    platform: params.platform || opts.platform,
    bottlePath: params.bottlePath,
    homedir: params.homedir || opts.homedir,
    options: opts,
  });

  const startOffset =
    alreadyRunning && params.preBootLogOffset === undefined
      ? 0
      : Math.max(0, Number(params.preBootLogOffset || 0));

  const startedAt = Date.now();
  do {
    if (signal?.aborted) {
      return { ready: false, aborted: true, waitedMs: Date.now() - startedAt, reason: 'aborted' };
    }

    const tcpOpen = await probeLocalTcpPort(
      port,
      '127.0.0.1',
      Math.min(350, pollIntervalMs * 2),
      opts
    );

    if (tcpOpen) {
      if (commLogPath && fs.existsSync(commLogPath)) {
        const logRead = await readLogTailBytesAsync(
          commLogPath,
          startOffset,
          alreadyRunning && startOffset === 0 ? 32768 : 131072
        );
        if (logRead && hasActiveGogAuthSessionInLog(logRead.text, 0)) {
          return {
            ready: true,
            waitedMs: Date.now() - startedAt,
            reason: 'tcp_and_auth_ready',
          };
        }
      } else if (alreadyRunning && Date.now() - startedAt >= Math.min(4000, timeoutMs)) {
        return {
          ready: true,
          waitedMs: Date.now() - startedAt,
          reason: 'tcp_open_already_running',
        };
      }
    }

    const remaining = timeoutMs - (Date.now() - startedAt);
    if (remaining <= 0) break;
    await sleepUnref(Math.min(pollIntervalMs, remaining), signal);
  } while (Date.now() - startedAt < timeoutMs);

  return {
    ready: false,
    timedOut: true,
    waitedMs: Date.now() - startedAt,
    reason: 'timeout',
  };
}

/**
 * Inspect appended GOG Galaxy log text line-by-line for active vs completed cloud-sync uploads.
 *
 * @param {string} text
 * @returns {{ activitySeen: boolean, inFlight: boolean, completedObserved: boolean }}
 */
function inspectGogCloudSyncLogState(text) {
  let activitySeen = false;
  let inFlight = false;
  let completedObserved = false;
  if (!text) return { activitySeen, inFlight, completedObserved };

  const doneRegex =
    /(?:Upload\s+finished|Synchronization\s+finished|Sync\s+finished|CloudStorage[^\r\n]*(?:finished|completed|up\s+to\s+date|no\s+changes))/i;
  const activeRegex = /(?:CloudStorage|Syncing\s+saves|Uploading)/i;

  for (const line of text.split(/\r?\n/)) {
    if (!line) continue;
    if (doneRegex.test(line)) {
      activitySeen = true;
      inFlight = false;
      completedObserved = true;
    } else if (activeRegex.test(line)) {
      activitySeen = true;
      inFlight = true;
    }
  }
  return { activitySeen, inFlight, completedObserved };
}

/**
 * Post-exit flush barrier ensuring `GalaxyCommunication` flushes final `StoreStatsAndAchievements`
 * packets before `/command=shutdown` is issued. When `isStorefrontUri` is true, also inspects
 * `GalaxyClient.log` and `CommunicationService.log` for Galaxy cloud-sync upload completion up
 * to `15000 ms` (`0 ms` in tests unless `enableUriCloudFlushWaitInTest` or explicit `maxFlushWaitMs`
 * / `gogPostExitFlushMs` is provided).
 *
 * @param {Record<string, any>} [params]
 * @returns {Promise<{ flushed: boolean, waitedMs: number, reason: string }>}
 */
async function waitForGogPostExitFlush(params = {}) {
  const opts = params.options && typeof params.options === 'object' ? params.options : params;
  const isTestEnv = isSyntheticTestBarrierEnv(params, opts);
  const isStorefrontUri = Boolean(params.isStorefrontUri || opts.isStorefrontUri);
  const hasExplicitFlushWait =
    opts.gogPostExitFlushMs !== undefined || params.maxFlushWaitMs !== undefined;

  if (isStorefrontUri) {
    if (
      isTestEnv &&
      opts.enableUriCloudFlushWaitInTest !== true &&
      params.enableUriCloudFlushWaitInTest !== true &&
      !hasExplicitFlushWait
    ) {
      return { flushed: true, waitedMs: 0, reason: 'skipped_in_test' };
    }
  } else if (
    isTestEnv &&
    opts.enableGogReadinessBarrier !== true &&
    opts.enableStorefrontReadinessBarrier !== true &&
    params.enableGogReadinessBarrier !== true &&
    params.enableStorefrontReadinessBarrier !== true &&
    !hasExplicitFlushWait
  ) {
    return { flushed: true, waitedMs: 0, reason: 'skipped_in_test' };
  }

  const defaultMaxFlushWaitMs = isStorefrontUri ? 15000 : 2500;
  const maxFlushWaitMs = Math.max(
    0,
    Number(opts.gogPostExitFlushMs ?? params.maxFlushWaitMs ?? defaultMaxFlushWaitMs)
  );
  if (maxFlushWaitMs === 0) {
    return { flushed: true, waitedMs: 0, reason: 'zero_wait' };
  }

  const settleMs = Math.max(0, Number(params.settleMs ?? opts.gogPostExitSettleMs ?? 600));
  const quietSettleMs = Math.max(
    0,
    Number(params.quietSettleMs ?? opts.gogUriQuietSettleMs ?? 4000)
  );
  const baselineGraceMs = Math.max(
    0,
    Number(params.baselineGraceMs ?? Math.min(isStorefrontUri ? quietSettleMs : 1200, maxFlushWaitMs))
  );
  const pollIntervalMs = Math.max(15, Number(params.pollIntervalMs ?? opts.pollIntervalMs ?? 150));
  const signal = params.signal || opts.signal;

  const commLogPath = resolveGogCommunicationLogPath({
    platform: params.platform || opts.platform,
    bottlePath: params.bottlePath,
    homedir: params.homedir || opts.homedir,
    gogCommunicationLogPath: params.gogCommunicationLogPath,
    options: opts,
  });

  const startedAt = Date.now();
  const peerClosedRegex = /\[GameplayLogicManager\]\s+destructor|Socket has been closed by peer/i;

  if (!isStorefrontUri) {
    if (!commLogPath || !fs.existsSync(commLogPath)) {
      await sleepUnref(baselineGraceMs, signal);
      return { flushed: true, waitedMs: Date.now() - startedAt, reason: 'baseline_grace' };
    }

    let baseOffset = 0;
    if (typeof params.preExitOffset === 'number' && params.preExitOffset >= 0) {
      baseOffset = params.preExitOffset;
    } else {
      try {
        const st = await fs.promises.stat(commLogPath);
        baseOffset = Math.max(0, st.size);
      } catch {
        baseOffset = 0;
      }
    }

    do {
      if (signal?.aborted) break;
      const logRead = await readLogTailBytesAsync(commLogPath, baseOffset, 65536);
      if (logRead && logRead.text && peerClosedRegex.test(logRead.text)) {
        if (settleMs > 0) {
          await sleepUnref(settleMs, signal);
        }
        return {
          flushed: true,
          waitedMs: Date.now() - startedAt,
          reason: 'destructor_settled',
        };
      }
      const remaining = maxFlushWaitMs - (Date.now() - startedAt);
      if (remaining <= 0) break;
      await sleepUnref(Math.min(pollIntervalMs, remaining), signal);
    } while (Date.now() - startedAt < maxFlushWaitMs);

    return {
      flushed: true,
      waitedMs: Date.now() - startedAt,
      reason: 'baseline_grace',
    };
  }

  // `isStorefrontUri === true`: monitor both `CommunicationService.log` and `GalaxyClient.log`
  const clientLogPath = resolveGogClientLogPath({
    platform: params.platform || opts.platform,
    bottlePath: params.bottlePath,
    homedir: params.homedir || opts.homedir,
    gogClientLogPath: params.gogClientLogPath,
    gogCommunicationLogPath: params.gogCommunicationLogPath,
    options: opts,
  });

  const commExistsInitially = Boolean(commLogPath && fs.existsSync(commLogPath));
  const clientExistsInitially = Boolean(clientLogPath && fs.existsSync(clientLogPath));
  if (!commExistsInitially && !clientExistsInitially) {
    await sleepUnref(baselineGraceMs, signal);
    return { flushed: true, waitedMs: Date.now() - startedAt, reason: 'baseline_grace' };
  }

  let commBaseOffset = 0;
  if (typeof params.preExitOffset === 'number' && params.preExitOffset >= 0) {
    commBaseOffset = params.preExitOffset;
  } else if (commExistsInitially) {
    try {
      const st = await fs.promises.stat(commLogPath);
      commBaseOffset = Math.max(0, st.size);
    } catch {
      commBaseOffset = 0;
    }
  }

  let clientBaseOffset = 0;
  if (typeof params.preExitClientOffset === 'number' && params.preExitClientOffset >= 0) {
    clientBaseOffset = params.preExitClientOffset;
  } else if (clientExistsInitially) {
    try {
      const st = await fs.promises.stat(clientLogPath);
      clientBaseOffset = Math.max(0, st.size);
    } catch {
      clientBaseOffset = 0;
    }
  }

  let destructorSeenAt = 0;
  let lastLogActivityAt = startedAt;
  let lastCommSize = -1;
  let lastClientSize = -1;

  do {
    if (signal?.aborted) {
      return { flushed: false, waitedMs: Date.now() - startedAt, reason: 'aborted' };
    }

    const [commRead, clientRead] = await Promise.all([
      commLogPath ? readLogTailBytesAsync(commLogPath, commBaseOffset, 65536) : Promise.resolve(null),
      clientLogPath
        ? readLogTailBytesAsync(clientLogPath, clientBaseOffset, 65536)
        : Promise.resolve(null),
    ]);

    const now = Date.now();
    if (commRead && commRead.size !== lastCommSize) {
      if (lastCommSize !== -1) {
        lastLogActivityAt = now;
      }
      lastCommSize = commRead.size;
    }
    if (clientRead && clientRead.size !== lastClientSize) {
      if (lastClientSize !== -1) {
        lastLogActivityAt = now;
      }
      lastClientSize = clientRead.size;
    }

    const commText = commRead?.text || '';
    const clientText = clientRead?.text || '';

    if (!destructorSeenAt && commText && peerClosedRegex.test(commText)) {
      destructorSeenAt = now;
    }

    const commSync = inspectGogCloudSyncLogState(commText);
    const clientSync = inspectGogCloudSyncLogState(clientText);
    const anyInFlight = commSync.inFlight || clientSync.inFlight;
    const anyCompleted = commSync.completedObserved || clientSync.completedObserved;
    const anyActivity = commSync.activitySeen || clientSync.activitySeen;

    if (anyCompleted && !anyInFlight) {
      if (settleMs > 0) {
        await sleepUnref(Math.min(settleMs, 250), signal);
      }
      return {
        flushed: true,
        waitedMs: Date.now() - startedAt,
        reason: 'cloud_sync_completed',
      };
    }

    if (
      destructorSeenAt > 0 &&
      !anyInFlight &&
      now - Math.max(destructorSeenAt, lastLogActivityAt) >= quietSettleMs
    ) {
      return {
        flushed: true,
        waitedMs: Date.now() - startedAt,
        reason: 'destructor_quiet_settled',
      };
    }

    if (!anyInFlight && !anyActivity && now - lastLogActivityAt >= quietSettleMs) {
      return {
        flushed: true,
        waitedMs: Date.now() - startedAt,
        reason: 'quiet_settled',
      };
    }

    const remaining = maxFlushWaitMs - (Date.now() - startedAt);
    if (remaining <= 0) break;
    await sleepUnref(Math.min(pollIntervalMs, remaining), signal);
  } while (Date.now() - startedAt < maxFlushWaitMs);

  return {
    flushed: true,
    waitedMs: Date.now() - startedAt,
    reason: 'baseline_grace',
  };
}

/**
 * Readiness barrier for cold-started `EpicGamesLauncher.exe -silent` inside a Wine/CrossOver bottle.
 *
 * @param {Record<string, any>} [params]
 * @returns {Promise<{ ready: boolean, waitedMs: number, timedOut?: boolean, offlineSkipped?: boolean, reason: string }>}
 */
async function waitForBottleEpicPortalReady(params = {}) {
  const opts = params.options && typeof params.options === 'object' ? params.options : params;
  const isTestEnv = isSyntheticTestBarrierEnv(params, opts);
  if (
    isTestEnv &&
    opts.enableStorefrontReadinessBarrier !== true &&
    opts.enableEpicReadinessBarrier !== true &&
    params.enableStorefrontReadinessBarrier !== true &&
    params.enableEpicReadinessBarrier !== true
  ) {
    return { ready: true, waitedMs: 0, reason: 'skipped_in_test' };
  }

  if (!isNetworkOnlineForLaunch(opts) || !isNetworkOnlineForLaunch(params)) {
    return { ready: true, waitedMs: 0, offlineSkipped: true, reason: 'offline_skipped' };
  }

  const bottlePath = String(params.bottlePath || '');
  const timeoutMs = Math.max(0, Number(params.timeoutMs ?? opts.epicReadinessTimeoutMs ?? 18000));
  const settleMs = Math.max(0, Number(params.settleMs ?? opts.epicSettleMs ?? 6000));
  const pollIntervalMs = Math.max(20, Number(params.pollIntervalMs ?? opts.pollIntervalMs ?? 250));
  const signal = params.signal || opts.signal;

  /** @type {string[] | null} */
  let cachedEpicLogCandidates = null;
  let cachedEpicLogCandidatesAt = 0;

  /**
   * Async cached discovery of bottle Epic Games Launcher log candidates so 250ms poll ticks
   * never block Electron's main thread with repeated synchronous `readdirSync`/`existsSync`.
   * @param {boolean} [forceRefresh]
   * @returns {Promise<string[]>}
   */
  const discoverBottleEpicLogCandidatesAsync = async (forceRefresh = false) => {
    if (opts.epicBottleLogPath && typeof opts.epicBottleLogPath === 'string') {
      return [opts.epicBottleLogPath];
    }
    const now = Date.now();
    if (
      !forceRefresh &&
      cachedEpicLogCandidates &&
      cachedEpicLogCandidates.length > 0 &&
      now - cachedEpicLogCandidatesAt < 2000
    ) {
      return cachedEpicLogCandidates;
    }
    if (!bottlePath) return [];
    try {
      await fs.promises.access(bottlePath);
    } catch {
      return [];
    }
    const driveC = path.join(bottlePath, 'drive_c');
    const usersDir = resolveDriveCPathCaseInsensitive(driveC, ['users']);
    /** @type {string[]} */
    const out = [];
    try {
      const dirents = await fs.promises.readdir(usersDir, { withFileTypes: true });
      const users = dirents
        .filter((d) => d.isDirectory() && !d.name.startsWith('.') && d.name.toLowerCase() !== 'public')
        .map((d) => d.name);
      for (const u of users) {
        out.push(
          resolveDriveCPathCaseInsensitive(driveC, [
            'users',
            u,
            'Local Settings',
            'Application Data',
            'EpicGamesLauncher',
            'Saved',
            'Logs',
            'EpicGamesLauncher.log',
          ]),
          resolveDriveCPathCaseInsensitive(driveC, [
            'users',
            u,
            'AppData',
            'Local',
            'EpicGamesLauncher',
            'Saved',
            'Logs',
            'EpicGamesLauncher.log',
          ])
        );
      }
    } catch {}
    cachedEpicLogCandidates = Array.from(new Set(out));
    cachedEpicLogCandidatesAt = now;
    return cachedEpicLogCandidates;
  };

  /** @type {Map<string, number>} */
  const preOffsets = new Map();
  const explicitPreBootOffset =
    typeof params.preBootOffset === 'number' && params.preBootOffset >= 0
      ? params.preBootOffset
      : typeof params.preBootLogOffset === 'number' && params.preBootLogOffset >= 0
        ? params.preBootLogOffset
        : undefined;
  const initialCandidates = await discoverBottleEpicLogCandidatesAsync(true);
  if (typeof explicitPreBootOffset === 'number') {
    for (const c of initialCandidates) {
      preOffsets.set(c, explicitPreBootOffset);
    }
  } else {
    for (const c of initialCandidates) {
      try {
        const st = await fs.promises.stat(c);
        preOffsets.set(c, st.size);
      } catch {}
    }
  }

  const portalReadyRegex = /FCommunityPortalManagerImpl|EOSOverlay|Portal.*Ready/i;
  const startedAt = Date.now();
  let firstLogUpdateAt = 0;

  do {
    if (signal?.aborted) {
      return { ready: false, waitedMs: Date.now() - startedAt, reason: 'aborted' };
    }

    const logCandidates = await discoverBottleEpicLogCandidatesAsync(false);
    for (const logPath of logCandidates) {
      const baseOff = preOffsets.has(logPath) ? Number(preOffsets.get(logPath) || 0) : 0;
      const logRead = await readLogTailBytesAsync(logPath, baseOff, 131072);
      if (logRead && logRead.text) {
        if (!firstLogUpdateAt) {
          firstLogUpdateAt = Date.now();
        }
        if (portalReadyRegex.test(logRead.text)) {
          return {
            ready: true,
            waitedMs: Date.now() - startedAt,
            reason: 'portal_ready',
          };
        }
      }
    }

    if (firstLogUpdateAt > 0 && Date.now() - firstLogUpdateAt >= settleMs) {
      return {
        ready: true,
        waitedMs: Date.now() - startedAt,
        reason: 'log_active_settled',
      };
    }

    const remaining = timeoutMs - (Date.now() - startedAt);
    if (remaining <= 0) break;
    await sleepUnref(Math.min(pollIntervalMs, remaining), signal);
  } while (Date.now() - startedAt < timeoutMs);

  return {
    ready: false,
    timedOut: true,
    waitedMs: Date.now() - startedAt,
    reason: 'timeout',
  };
}

/**
 * Inspect appended `EpicGamesLauncher.log` text line-by-line for `CloudSync` / `SaveSync`
 * upload activity and completion markers.
 *
 * @param {string} text
 * @returns {{ activitySeen: boolean, inFlight: boolean, completedObserved: boolean }}
 */
function inspectEpicCloudSyncLogState(text) {
  let activitySeen = false;
  let inFlight = false;
  let completedObserved = false;
  if (!text) return { activitySeen, inFlight, completedObserved };

  const doneRegex =
    /(?:CloudSync|SaveSync|FCloudSave|CloudSave)[^\r\n]*(?:Complete|Completed|Finished|Succeeded|Done|UpToDate|Up\s+to\s+date|NoChanges|Skipped)/i;
  const activeRegex = /(?:CloudSync|SaveSync|FCloudSave|CloudSave)/i;

  for (const line of text.split(/\r?\n/)) {
    if (!line) continue;
    if (doneRegex.test(line)) {
      activitySeen = true;
      inFlight = false;
      completedObserved = true;
    } else if (activeRegex.test(line)) {
      activitySeen = true;
      inFlight = true;
    }
  }
  return { activitySeen, inFlight, completedObserved };
}

/**
 * Discover candidate host or bottle `EpicGamesLauncher.log` paths asynchronously.
 *
 * @param {Record<string, any>} params
 * @param {Record<string, any>} opts
 * @returns {Promise<string[]>}
 */
async function resolveEpicLauncherLogCandidatesAsync(params, opts) {
  const explicitRaw =
    params.epicLogPath ||
    opts.epicLogPath ||
    params.epicBottleLogPath ||
    opts.epicBottleLogPath;
  if (typeof explicitRaw === 'string' && explicitRaw.trim()) {
    return [explicitRaw.trim()];
  }
  if (Array.isArray(explicitRaw) && explicitRaw.length > 0) {
    return explicitRaw.map((p) => String(p || '').trim()).filter(Boolean);
  }

  /** @type {string[]} */
  const out = [];
  const bottlePath = String(params.bottlePath || opts.bottlePath || '').trim();
  if (bottlePath) {
    try {
      await fs.promises.access(bottlePath);
      const driveC = path.join(bottlePath, 'drive_c');
      const usersDir = resolveDriveCPathCaseInsensitive(driveC, ['users']);
      const dirents = await fs.promises.readdir(usersDir, { withFileTypes: true });
      const users = dirents
        .filter((d) => d.isDirectory() && !d.name.startsWith('.') && d.name.toLowerCase() !== 'public')
        .map((d) => d.name);
      for (const u of users) {
        out.push(
          resolveDriveCPathCaseInsensitive(driveC, [
            'users',
            u,
            'Local Settings',
            'Application Data',
            'EpicGamesLauncher',
            'Saved',
            'Logs',
            'EpicGamesLauncher.log',
          ]),
          resolveDriveCPathCaseInsensitive(driveC, [
            'users',
            u,
            'AppData',
            'Local',
            'EpicGamesLauncher',
            'Saved',
            'Logs',
            'EpicGamesLauncher.log',
          ])
        );
      }
    } catch {}
    return Array.from(new Set(out));
  }

  const targetPlatform = params.platform || opts.platform || process.platform;
  const homedir = String(params.homedir || opts.homedir || os.homedir());
  if (targetPlatform === 'win32') {
    const localAppData = String(
      params.localAppDataDir ||
        opts.localAppDataDir ||
        process.env.LOCALAPPDATA ||
        path.join(homedir, 'AppData', 'Local')
    );
    if (localAppData.startsWith('/')) {
      out.push(
        path.join(localAppData, 'EpicGamesLauncher', 'Saved', 'Logs', 'EpicGamesLauncher.log')
      );
    } else {
      out.push(
        path.win32.join(localAppData, 'EpicGamesLauncher', 'Saved', 'Logs', 'EpicGamesLauncher.log')
      );
    }
    return out;
  }

  out.push(
    path.join(homedir, 'Library', 'Logs', 'Unreal Engine', 'EpicGamesLauncher', 'EpicGamesLauncher.log'),
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
  return out;
}

/**
 * Post-exit cloud-sync barrier for Epic Games Launcher (`storefront_uri` exits) watching host or
 * bottle `EpicGamesLauncher.log` up to `15000 ms` (`0 ms` in tests unless explicitly configured)
 * for `CloudSync`/`SaveSync` completion or a `4000 ms` quiet settle.
 *
 * @param {Record<string, any>} [options]
 * @returns {Promise<{ completed: boolean, waitedMs: number, timedOut?: boolean, aborted?: boolean, offlineSkipped?: boolean, reason: string }>}
 */
async function waitForEpicLauncherCloudSyncCompletion(options = {}) {
  const params = options && typeof options === 'object' ? options : {};
  const opts = params.options && typeof params.options === 'object' ? params.options : params;
  const isTestEnv = isSyntheticTestBarrierEnv(params, opts);
  const hasExplicitWait =
    opts.epicCloudSyncWaitMs !== undefined ||
    params.maxWaitMs !== undefined ||
    opts.maxWaitMs !== undefined;

  if (
    isTestEnv &&
    opts.enableEpicCloudSyncWaitInTest !== true &&
    params.enableEpicCloudSyncWaitInTest !== true &&
    opts.enableUriCloudFlushWaitInTest !== true &&
    params.enableUriCloudFlushWaitInTest !== true &&
    opts.enableStorefrontReadinessBarrier !== true &&
    params.enableStorefrontReadinessBarrier !== true &&
    !hasExplicitWait
  ) {
    return { completed: true, waitedMs: 0, reason: 'skipped_in_test' };
  }

  if (!isNetworkOnlineForLaunch(opts) || !isNetworkOnlineForLaunch(params)) {
    return { completed: true, waitedMs: 0, offlineSkipped: true, reason: 'offline_skipped' };
  }

  const maxWaitMs = Math.max(
    0,
    Number(params.maxWaitMs ?? opts.maxWaitMs ?? opts.epicCloudSyncWaitMs ?? 15000)
  );
  if (maxWaitMs === 0) {
    return { completed: true, waitedMs: 0, reason: 'zero_wait' };
  }

  const quietSettleMs = Math.max(
    0,
    Number(params.quietSettleMs ?? opts.epicCloudSyncQuietSettleMs ?? 4000)
  );
  const pollIntervalMs = Math.max(15, Number(params.pollIntervalMs ?? opts.pollIntervalMs ?? 200));
  const signal = params.signal || opts.signal;

  const logCandidates = await resolveEpicLauncherLogCandidatesAsync(params, opts);
  /** @type {Map<string, number>} */
  const preOffsets = new Map();
  /** @type {Map<string, number>} */
  const lastSizes = new Map();

  const explicitPreOffset =
    typeof params.preExitOffset === 'number' && params.preExitOffset >= 0
      ? params.preExitOffset
      : typeof params.preExitLogOffset === 'number' && params.preExitLogOffset >= 0
        ? params.preExitLogOffset
        : undefined;

  let anyLogExists = false;
  for (const logPath of logCandidates) {
    try {
      const st = await fs.promises.stat(logPath);
      if (st.isFile()) {
        anyLogExists = true;
        preOffsets.set(logPath, typeof explicitPreOffset === 'number' ? explicitPreOffset : st.size);
        lastSizes.set(logPath, st.size);
      }
    } catch {
      if (typeof explicitPreOffset === 'number') {
        preOffsets.set(logPath, explicitPreOffset);
      }
    }
  }

  const startedAt = Date.now();
  let lastActivityAt = startedAt;

  if (!anyLogExists && logCandidates.length === 0) {
    await sleepUnref(Math.min(quietSettleMs, maxWaitMs), signal);
    return {
      completed: true,
      waitedMs: Date.now() - startedAt,
      reason: 'no_log_quiet_settled',
    };
  }

  let anyInFlight = false;
  do {
    if (signal?.aborted) {
      return {
        completed: false,
        aborted: true,
        waitedMs: Date.now() - startedAt,
        reason: 'aborted',
      };
    }

    const now = Date.now();
    anyInFlight = false;
    let anyCompleted = false;

    for (const logPath of logCandidates) {
      const baseOff = preOffsets.has(logPath) ? Number(preOffsets.get(logPath) || 0) : 0;
      const logRead = await readLogTailBytesAsync(logPath, baseOff, 131072);
      if (!logRead) continue;

      const prevSize = lastSizes.get(logPath);
      if (prevSize === undefined || logRead.size !== prevSize) {
        if (prevSize !== undefined) {
          lastActivityAt = now;
        }
        lastSizes.set(logPath, logRead.size);
      }

      if (logRead.text) {
        const state = inspectEpicCloudSyncLogState(logRead.text);
        if (state.inFlight) {
          anyInFlight = true;
        }
        if (state.completedObserved) {
          anyCompleted = true;
        }
      }
    }

    if (anyCompleted && !anyInFlight) {
      return {
        completed: true,
        waitedMs: Date.now() - startedAt,
        reason: 'cloud_sync_completed',
      };
    }

    if (!anyInFlight && now - lastActivityAt >= quietSettleMs) {
      return {
        completed: true,
        waitedMs: Date.now() - startedAt,
        reason: 'quiet_settled',
      };
    }

    const remaining = maxWaitMs - (Date.now() - startedAt);
    if (remaining <= 0) break;
    await sleepUnref(Math.min(pollIntervalMs, remaining), signal);
  } while (Date.now() - startedAt < maxWaitMs);

  return {
    completed: !anyInFlight,
    timedOut: true,
    waitedMs: Date.now() - startedAt,
    reason: anyInFlight ? 'timeout_in_flight' : 'timeout_settled',
  };
}

/**
 * Parse `<steamRoot>/logs/gameprocess_log.txt` (from `minFileOffset`) to locate the active
 * tracked PID for `AppID <appId>` that has not been marked `no longer tracking PID <pid>` and is alive.
 *
 * @param {string} steamRoot
 * @param {string | number} appId
 * @param {number} [minFileOffset]
 * @param {Record<string, any>} [options]
 * @returns {number}
 */
function extractTrackedPidFromSteamGameProcessLog(
  steamRoot,
  appId,
  minFileOffset = 0,
  options = {}
) {
  const cleanAppId = String(appId || '')
    .replace(/^steam[-_]/i, '')
    .trim();
  if (!steamRoot || !cleanAppId) return 0;

  let logPath = path.join(steamRoot, 'logs', 'gameprocess_log.txt');
  if (!fs.existsSync(logPath)) {
    const altLogPath = path.join(steamRoot, 'logs', 'GameProcess_log.txt');
    if (fs.existsSync(altLogPath)) {
      logPath = altLogPath;
    } else {
      return 0;
    }
  }

  let text = '';
  let fd = null;
  try {
    const st = fs.statSync(logPath);
    const effectiveOffset =
      minFileOffset > 0 && st.size >= minFileOffset
        ? minFileOffset
        : Math.max(0, st.size - 131072);
    const readLen = Math.min(131072, Math.max(0, st.size - effectiveOffset));
    if (readLen <= 0) return 0;
    fd = fs.openSync(logPath, 'r');
    const buf = Buffer.alloc(readLen);
    const bytesRead = fs.readSync(fd, buf, 0, readLen, st.size - readLen);
    text = buf.subarray(0, bytesRead).toString('utf8');
  } catch {
    return 0;
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {}
    }
  }

  const escapedAppId = cleanAppId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const addRegex = new RegExp(
    `\\bAppID\\s+${escapedAppId}\\s+adding\\s+PID\\s+(\\d+)\\s+as\\s+a\\s+tracked\\s+process`,
    'i'
  );
  const removeRegex = new RegExp(
    `\\bAppID\\s+${escapedAppId}\\s+no\\s+longer\\s+tracking\\s+PID\\s+(\\d+)`,
    'i'
  );

  /** @type {Set<number>} */
  const trackedSet = new Set();
  for (const line of text.split(/\r?\n/)) {
    if (!line) continue;
    const addMatch = line.match(addRegex);
    if (addMatch) {
      const pid = Number(addMatch[1]);
      if (pid > 0) {
        trackedSet.delete(pid);
        trackedSet.add(pid);
      }
      continue;
    }
    const remMatch = line.match(removeRegex);
    if (remMatch) {
      const pid = Number(remMatch[1]);
      if (pid > 0) {
        trackedSet.delete(pid);
      }
    }
  }

  const isPidAliveFn =
    typeof options.isPidAliveFn === 'function'
      ? options.isPidAliveFn
      : (/** @type {number} */ pid) => isProcessAlive(pid);

  const candidatesNewestFirst = Array.from(trackedSet).reverse();
  for (const candidatePid of candidatesNewestFirst) {
    try {
      if (isPidAliveFn(candidatePid)) {
        return candidatePid;
      }
    } catch {}
  }

  return 0;
}

module.exports = {
  doesProcessListHaveHostGogGalaxy,
  isHostGogGalaxyRunning,
  reapOrphanedGogOverlayProcesses,
  lineMatchesBottlePrefix,
  isBottleWinExeRunning,
  inspectRunningBottleSteam,
  probeLocalTcpPort,
  resolveGogCommunicationLogPath,
  resolveGogClientLogPath,
  hasActiveGogAuthSessionInLog,
  waitForGogCommunicationServiceReady,
  waitForGogPostExitFlush,
  waitForBottleEpicPortalReady,
  waitForEpicLauncherCloudSyncCompletion,
  extractTrackedPidFromSteamGameProcessLog,
};
