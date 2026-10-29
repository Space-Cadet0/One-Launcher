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

/**
 * Determine whether caller options represent a synthetic test harness rather than a real host launch.
 * Explicitly passing `os.homedir()` in production must NOT be misclassified as a test override.
 *
 * @param {Record<string, any>} [params]
 * @param {Record<string, any>} [opts]
 * @returns {boolean}
 */
function isSyntheticTestBarrierEnv(params = {}, opts = {}) {
  if (process.env.VITEST || process.env.NODE_ENV === 'test') return true;
  if (opts.userDataDir || params.userDataDir) return true;
  const realHome = os.homedir();
  if (opts.homedir && opts.homedir !== realHome) return true;
  if (params.homedir && params.homedir !== realHome) return true;
  return false;
}

/**
 * Sleep helper supporting optional AbortSignal.
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

  const escapedExe = cleanExe.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const exeRegex = new RegExp(`(?:^|[\\\\/\\s"'])${escapedExe}(?:\\s|["']|$)`, 'i');
  const normTargetPrefix = bottlePath
    ? path.resolve(bottlePath).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
    : '';

  /**
   * @param {string} outStr
   * @returns {boolean}
   */
  const matchesBottleProcess = (outStr) => {
    const lines = String(outStr || '').split(/\r?\n/);
    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line || !exeRegex.test(line)) continue;
      if (/^(?:\/bin\/|\/usr\/bin\/)?ps(?:\s|$)/i.test(line)) continue;

      if (normTargetPrefix) {
        const lowerLine = line.replace(/\\/g, '/').toLowerCase();
        const envMatch = lowerLine.match(/wineprefix=(?:"([^"]+)"|'([^']+)'|(\S+))/i);
        if (envMatch) {
          const linePrefix = (envMatch[1] || envMatch[2] || envMatch[3] || '').replace(/\/+$/, '');
          if (linePrefix && linePrefix !== normTargetPrefix) {
            continue;
          }
        }
        const bottleMatch = lowerLine.match(/((?:[a-z]:)?\/[^\s"']*\/bottles\/[^/\s"']+)/i);
        if (bottleMatch && bottleMatch[1]) {
          const lineBottle = bottleMatch[1].replace(/\/+$/, '');
          if (
            !normTargetPrefix.startsWith(lineBottle) &&
            !lineBottle.startsWith(normTargetPrefix)
          ) {
            continue;
          }
        }
      }
      return true;
    }
    return false;
  };

  if (typeof options.mockProcessListOutput === 'string') {
    return matchesBottleProcess(options.mockProcessListOutput);
  }
  if (typeof options.getProcessListOutput === 'function') {
    try {
      return matchesBottleProcess(String((await options.getProcessListOutput()) || ''));
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

  const targetPlatform = options.platform || process.platform;
  const execFn = customExec || execFile;
  const psArgs =
    targetPlatform === 'darwin' && !customExec
      ? ['eww', '-ax', '-o', 'command=']
      : ['-ax', '-o', 'command='];

  return new Promise((resolve) => {
    try {
      execFn('ps', psArgs, { timeout: 1500 }, (/** @type {any} */ err, /** @type {any} */ stdout) => {
        resolve(!err && matchesBottleProcess(String(stdout || '')));
      });
    } catch {
      resolve(false);
    }
  });
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
 * Inspect `CommunicationService.log` content to confirm an active authenticated GOG session
 * that has not subsequently shut down.
 *
 * @param {string} logContent
 * @param {number} [startOffset]
 * @returns {boolean}
 */
function hasActiveGogAuthSessionInLog(logContent, startOffset = 0) {
  if (!logContent || typeof logContent !== 'string') return false;

  let slice = logContent;
  if (startOffset > 0) {
    if (startOffset >= logContent.length) return false;
    slice = logContent.slice(startOffset);
  } else if (logContent.length > 32768) {
    slice = logContent.slice(-32768);
  }

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
 * @returns {Promise<{ ready: boolean, waitedMs: number, timedOut?: boolean, aborted?: boolean, reason?: string }>}
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
  while (Date.now() - startedAt < timeoutMs) {
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
  }

  return {
    ready: false,
    timedOut: true,
    waitedMs: Date.now() - startedAt,
    reason: 'timeout',
  };
}

/**
 * Post-exit flush barrier ensuring `GalaxyCommunication` flushes final `StoreStatsAndAchievements`
 * packets before `/command=shutdown` is issued.
 *
 * @param {Record<string, any>} [params]
 * @returns {Promise<{ flushed: boolean, waitedMs: number, reason: string }>}
 */
async function waitForGogPostExitFlush(params = {}) {
  const opts = params.options && typeof params.options === 'object' ? params.options : params;
  const isTestEnv = isSyntheticTestBarrierEnv(params, opts);
  if (
    isTestEnv &&
    opts.enableGogReadinessBarrier !== true &&
    opts.enableStorefrontReadinessBarrier !== true &&
    params.enableGogReadinessBarrier !== true &&
    params.enableStorefrontReadinessBarrier !== true &&
    opts.gogPostExitFlushMs === undefined &&
    params.maxFlushWaitMs === undefined
  ) {
    return { flushed: true, waitedMs: 0, reason: 'skipped_in_test' };
  }

  const maxFlushWaitMs = Math.max(
    0,
    Number(opts.gogPostExitFlushMs ?? params.maxFlushWaitMs ?? 2500)
  );
  const settleMs = Math.max(0, Number(params.settleMs ?? opts.gogPostExitSettleMs ?? 600));
  const baselineGraceMs = Math.max(
    0,
    Number(params.baselineGraceMs ?? Math.min(1200, maxFlushWaitMs))
  );
  const pollIntervalMs = Math.max(15, Number(params.pollIntervalMs ?? opts.pollIntervalMs ?? 150));
  const signal = params.signal || opts.signal;

  const commLogPath = resolveGogCommunicationLogPath({
    platform: params.platform || opts.platform,
    bottlePath: params.bottlePath,
    homedir: params.homedir || opts.homedir,
    options: opts,
  });

  const startedAt = Date.now();
  if (!commLogPath || !fs.existsSync(commLogPath)) {
    await sleepUnref(baselineGraceMs, signal);
    return { flushed: true, waitedMs: Date.now() - startedAt, reason: 'baseline_grace' };
  }

  let baseOffset = 0;
  if (typeof params.preExitOffset === 'number' && params.preExitOffset >= 0) {
    baseOffset = params.preExitOffset;
  } else {
    try {
      const st = fs.statSync(commLogPath);
      baseOffset = Math.max(0, st.size - 8192);
    } catch {
      baseOffset = 0;
    }
  }

  const peerClosedRegex = /\[GameplayLogicManager\]\s+destructor|Socket has been closed by peer/i;

  while (Date.now() - startedAt < maxFlushWaitMs) {
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
  }

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
 * @returns {Promise<{ ready: boolean, waitedMs: number, timedOut?: boolean, reason: string }>}
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

  const bottlePath = String(params.bottlePath || '');
  const timeoutMs = Math.max(0, Number(params.timeoutMs ?? opts.epicReadinessTimeoutMs ?? 18000));
  const settleMs = Math.max(0, Number(params.settleMs ?? opts.epicSettleMs ?? 6000));
  const pollIntervalMs = Math.max(20, Number(params.pollIntervalMs ?? opts.pollIntervalMs ?? 250));
  const signal = params.signal || opts.signal;

  /**
   * @returns {string[]}
   */
  const discoverBottleEpicLogCandidates = () => {
    if (opts.epicBottleLogPath && typeof opts.epicBottleLogPath === 'string') {
      return [opts.epicBottleLogPath];
    }
    if (!bottlePath || !fs.existsSync(bottlePath)) return [];
    const driveC = path.join(bottlePath, 'drive_c');
    const usersDir = resolveDriveCPathCaseInsensitive(driveC, ['users']);
    if (!fs.existsSync(usersDir)) return [];
    /** @type {string[]} */
    const out = [];
    try {
      const users = fs
        .readdirSync(usersDir, { withFileTypes: true })
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
  };

  /** @type {Map<string, number>} */
  const preOffsets = new Map();
  if (typeof params.preBootOffset === 'number' && params.preBootOffset >= 0) {
    for (const c of discoverBottleEpicLogCandidates()) {
      preOffsets.set(c, params.preBootOffset);
    }
  } else {
    for (const c of discoverBottleEpicLogCandidates()) {
      try {
        if (fs.existsSync(c)) {
          preOffsets.set(c, fs.statSync(c).size);
        }
      } catch {}
    }
  }

  const portalReadyRegex = /FCommunityPortalManagerImpl|EOSOverlay|Portal.*Ready/i;
  const startedAt = Date.now();
  let firstLogUpdateAt = 0;

  while (Date.now() - startedAt < timeoutMs) {
    if (signal?.aborted) {
      return { ready: false, waitedMs: Date.now() - startedAt, reason: 'aborted' };
    }

    const logCandidates = discoverBottleEpicLogCandidates();
    for (const logPath of logCandidates) {
      if (!fs.existsSync(logPath)) continue;
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
  }

  return {
    ready: false,
    timedOut: true,
    waitedMs: Date.now() - startedAt,
    reason: 'timeout',
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
  isBottleWinExeRunning,
  probeLocalTcpPort,
  resolveGogCommunicationLogPath,
  hasActiveGogAuthSessionInLog,
  waitForGogCommunicationServiceReady,
  waitForGogPostExitFlush,
  waitForBottleEpicPortalReady,
  extractTrackedPidFromSteamGameProcessLog,
};
