// @ts-check
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { exec, execFile, execFileSync } = require('node:child_process');
const {
  atomicWriteFileSync,
  buildSafeChildEnvironment,
  computeLaunchCommandFingerprint,
  isLaunchCommandApproved,
  isContainedWithinRoot,
} = require('../securityAndPathUtils.cjs');
const chainedPublisherLaunchers = /** @type {any} */ (require('../chainedPublisherLaunchers.cjs'));
const {
  diagLog,
  isTestEnvironment,
  resolveIsolatedHomedirAndUserData,
  inFlightPostSessionPromises,
  toLocalFsPath,
  hasManagedInstallSentinel,
  loadManagedInstalledGames,
  getLastProductionScanCache,
  isSafeToDeleteInstallPath,
} = require('../engineStateRegistry.cjs');
const { inspectWindowsExecutableHeader } = require('../binaryAndManifestInspectors.cjs');
const { isWindowsAppsProtectedPath } = require('../windowsXboxAppxAndMsixvcOrchestrator.cjs');
const { getDefaultInstallDir } = require('../diskAndVolumeInspector.cjs');
const {
  terminateDisplayWatcherTree,
  cleanupSessionDisplayFiles,
} = require('./bottleDisplayAndEnvController.cjs');

/**
 * Create a guarded, unref'd `setInterval` session poller with a `pollBusy` re-entrancy guard
 * (preventing overlapping `ps`/`tasklist` subprocess pileups) and an optional hard startup-latch
 * deadline (`SUP-02`).
 *
 * @param {{
 *   intervalMs: number,
 *   startupTimeoutMs?: number,
 *   startedMs?: number,
 *   isDone: () => boolean,
 *   onTick: (ctx: { elapsedMs: number, timedOutStartup: boolean }) => void | Promise<void>,
 *   onStop?: () => void
 * }} config
 * @returns {NodeJS.Timeout}
 */
function createGuardedSessionPoller(config) {
  const intervalMs = Math.max(20, Number(config.intervalMs) || 1000);
  const startupTimeoutMs = Math.max(0, Number(config.startupTimeoutMs) || 0);
  const startedMs = typeof config.startedMs === 'number' ? config.startedMs : Date.now();
  let pollBusy = false;

  const timer = setInterval(() => {
    if (config.isDone()) {
      clearInterval(timer);
      if (typeof config.onStop === 'function') {
        try {
          config.onStop();
        } catch {}
      }
      return;
    }
    if (pollBusy) return;
    pollBusy = true;
    const elapsedMs = Math.max(0, Date.now() - startedMs);
    const timedOutStartup = startupTimeoutMs > 0 && elapsedMs >= startupTimeoutMs;
    try {
      const maybePromise = config.onTick({ elapsedMs, timedOutStartup });
      if (maybePromise && typeof /** @type {any} */ (maybePromise).then === 'function') {
        Promise.resolve(maybePromise)
          .catch(() => {})
          .finally(() => {
            pollBusy = false;
          });
      } else {
        pollBusy = false;
      }
    } catch {
      pollBusy = false;
    }
  }, intervalMs);

  if (typeof timer.unref === 'function') {
    timer.unref();
  }
  return timer;
}

/**
 * Execute an approved `preLaunchCommand` or `postExitCommand` strictly gated on
 * `isLaunchCommandApproved(gameId, computeLaunchCommandFingerprint(field, cmd), options)`,
 * with sanitized child environment and validated `cwd` (`SUP-01`).
 *
 * @param {'preLaunchCommand' | 'postExitCommand'} field
 * @param {string | null | undefined} command
 * @param {{
 *   gameId: string,
 *   env?: Record<string, any>,
 *   cwd?: string,
 *   launchConfig?: Record<string, any>,
 *   options?: Record<string, any>,
 *   logTag?: string
 * }} ctx
 * @returns {Promise<{ executed: boolean, blocked?: boolean }>}
 */
async function runApprovedLaunchHookCommand(field, command, ctx) {
  const trimmed = typeof command === 'string' ? command.trim() : '';
  if (!trimmed || trimmed.includes('\0')) {
    return { executed: false };
  }
  const gameId = String(ctx?.gameId || '').trim();
  const options = ctx?.options || {};
  const fingerprint = computeLaunchCommandFingerprint(field, trimmed);
  const approved = gameId ? isLaunchCommandApproved(gameId, fingerprint, options) : false;
  if (!approved) {
    diagLog.warn(ctx?.logTag || `supervisor.${field}BlockedUnapproved`, 'Blocked unapproved shell hook command', {
      gameId,
      field,
    });
    return { executed: false, blocked: true };
  }

  const safeEnv =
    ctx?.env && typeof ctx.env === 'object'
      ? ctx.env
      : buildSafeChildEnvironment(
          process.env,
          ctx?.launchConfig?.environmentVariables,
          {},
          { gameId, options }
        );
  const safeCwd =
    typeof ctx?.cwd === 'string' && ctx.cwd.trim() && fs.existsSync(ctx.cwd.trim())
      ? ctx.cwd.trim()
      : process.cwd();
  const execImpl = typeof options.execFn === 'function' ? options.execFn : exec;

  await new Promise((resolve) => {
    try {
      execImpl(
        trimmed,
        { env: safeEnv, cwd: safeCwd, timeout: 5000, windowsHide: true },
        (/** @type {any} */ cmdErr) => {
          if (cmdErr) {
            diagLog.warn(ctx?.logTag || `supervisor.${field}Error`, cmdErr, { gameId });
          }
          resolve(undefined);
        }
      );
    } catch (syncErr) {
      diagLog.warn(ctx?.logTag || `supervisor.${field}SpawnError`, syncErr, { gameId });
      resolve(undefined);
    }
  });
  return { executed: true };
}

/**
 * Verify that `localInstallDir` is a safe, authoritative game install directory before running
 * directory-mutating helpers (`flattenGogNestedInstallDir`, `ensureMacExecutablePermissions`)
 * during launch (`SUP-01`).
 *
 * @param {string} localInstallDir
 * @param {Record<string, any>} [options]
 * @returns {boolean}
 */
function isAuthoritativeInstallDirForMutation(localInstallDir, options = {}) {
  if (!localInstallDir || typeof localInstallDir !== 'string' || !fs.existsSync(localInstallDir)) {
    return false;
  }
  const resolvedTarget = path.resolve(localInstallDir);
  if (!isSafeToDeleteInstallPath(resolvedTarget, options)) {
    return false;
  }
  if (hasManagedInstallSentinel(resolvedTarget)) {
    return true;
  }

  const targetPlatform = options.platform || process.platform;
  try {
    const { userDataDir } = resolveIsolatedHomedirAndUserData(options);
    const managedRecords = loadManagedInstalledGames(userDataDir);
    if (Array.isArray(managedRecords)) {
      for (const rec of managedRecords) {
        if (!rec || typeof rec.installPath !== 'string' || !rec.installPath.trim()) continue;
        const recPath = toLocalFsPath(rec.installPath);
        if (recPath && isContainedWithinRoot(recPath, resolvedTarget, targetPlatform)) {
          return true;
        }
      }
    }
  } catch {}

  const verifiedList = Array.isArray(options.verifiedInstalledGames)
    ? options.verifiedInstalledGames
    : [];
  const lastScan = getLastProductionScanCache();
  const lastScanResult = /** @type {any} */ (lastScan?.result);
  const scanGames = Array.isArray(lastScanResult)
    ? lastScanResult
    : Array.isArray(lastScanResult?.games)
      ? lastScanResult.games
      : [];
  for (const rec of [...verifiedList, ...scanGames]) {
    if (!rec || typeof rec !== 'object') continue;
    if (rec.source === 'custom_config' || rec.isCustomOverride === true) continue;
    if (typeof rec.installPath !== 'string' || !rec.installPath.trim()) continue;
    const recPath = toLocalFsPath(rec.installPath);
    if (recPath && isContainedWithinRoot(recPath, resolvedTarget, targetPlatform)) {
      return true;
    }
  }

  try {
    const defaultStorefrontDir = getDefaultInstallDir('gog', options);
    const defaultInstallRoot = defaultStorefrontDir ? path.dirname(defaultStorefrontDir) : '';
    if (defaultInstallRoot) {
      const resolvedDefaultRoot = path.resolve(defaultInstallRoot);
      if (
        resolvedTarget !== resolvedDefaultRoot &&
        isContainedWithinRoot(resolvedDefaultRoot, resolvedTarget, targetPlatform)
      ) {
        return true;
      }
    }
  } catch {}

  return false;
}

/**
 * Centralized disposal of per-session timers, detached `displayWatcherChild` trees,
 * `xboxLoopbackServer` TCP listeners, and temp Display Scaler INI/status files (`SUP-03`, `SUP-04`).
 *
 * @param {Record<string, any> | null | undefined} resourceBag
 * @param {{ closeXboxLoopback?: boolean, options?: Record<string, any> }} [params]
 */
function disposeSessionResources(resourceBag, params = {}) {
  if (!resourceBag || typeof resourceBag !== 'object') return;
  const opts = params.options || resourceBag.launchOptions || {};

  if (resourceBag.pollTimer) {
    try {
      clearInterval(resourceBag.pollTimer);
    } catch {}
    resourceBag.pollTimer = null;
  }
  if (resourceBag.displayStatusTimer) {
    try {
      clearInterval(resourceBag.displayStatusTimer);
    } catch {}
    resourceBag.displayStatusTimer = null;
  }
  if (resourceBag.displayWatcherChild) {
    terminateDisplayWatcherTree(resourceBag.displayWatcherChild, opts);
    resourceBag.displayWatcherChild = null;
  }
  cleanupSessionDisplayFiles([
    resourceBag.displayControlFilePosix,
    resourceBag.displayStatusFilePosix,
  ]);
  if (
    params.closeXboxLoopback !== false &&
    resourceBag.xboxLoopbackServer &&
    typeof resourceBag.xboxLoopbackServer.close === 'function'
  ) {
    const srv = resourceBag.xboxLoopbackServer;
    resourceBag.xboxLoopbackServer = null;
    try {
      Promise.resolve(srv.close()).catch(() => {});
    } catch {}
  }
}

function sanitizeEaBottleAutostartFallback(bottlePath, options = {}) {
  if (!bottlePath || typeof bottlePath !== 'string') return false;
  let mutated = false;
  if (typeof chainedPublisherLaunchers.sanitizeEaBottleAutostartInUserReg === 'function') {
    try {
      if (chainedPublisherLaunchers.sanitizeEaBottleAutostartInUserReg(bottlePath, options)) {
        mutated = true;
      }
    } catch {}
  }

  try {
    const userRegPath = path.join(bottlePath, 'user.reg');
    if (fs.existsSync(userRegPath)) {
      const original = fs.readFileSync(userRegPath, 'utf8');
      const lines = original.split(/\r?\n/);
      /** @type {string[]} */
      const out = [];
      let inCurrentVersionRun = false;
      let changedReg = false;
      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed.startsWith('[') && trimmed.includes(']')) {
          const headerInner = trimmed
            .slice(1, trimmed.indexOf(']'))
            .replace(/\\\\+/g, '\\')
            .toLowerCase();
          inCurrentVersionRun =
            headerInner === 'software\\microsoft\\windows\\currentversion\\run' ||
            headerInner === 'software\\wow6432node\\microsoft\\windows\\currentversion\\run';
          out.push(line);
          continue;
        }
        if (inCurrentVersionRun && /^"(?:eadm|origin)"\s*=/i.test(trimmed)) {
          changedReg = true;
          continue;
        }
        if (/^"startOnBootFlag"\s*=\s*dword:0*1\s*$/i.test(trimmed)) {
          out.push(line.replace(/dword:0*1/i, 'dword:00000000'));
          changedReg = true;
          continue;
        }
        out.push(line);
      }
      if (changedReg) {
        atomicWriteFileSync(userRegPath, out.join('\n'));
        mutated = true;
      }
    }
  } catch {}

  return mutated;
}

/**
 * Parse a shell-like launch arguments string into an argv array.
 *
 * @param {string} argString
 * @returns {string[]}
 */
function parseLaunchArguments(argString) {
  if (!argString || typeof argString !== 'string') return [];
  /** @type {string[]} */
  const args = [];
  let current = '';
  let hasTokenChars = false;
  let inSingle = false;
  let inDouble = false;

  for (let i = 0; i < argString.length; i++) {
    const ch = argString[i];

    if (inSingle) {
      if (ch === "'") {
        inSingle = false;
      } else {
        current += ch;
      }
      continue;
    }

    if (inDouble) {
      if (ch === '"') {
        inDouble = false;
      } else if (ch === '\\' && i + 1 < argString.length) {
        const next = argString[i + 1];
        if (next === '"' || next === '\\') {
          current += next;
          i++;
        } else {
          current += ch;
        }
      } else {
        current += ch;
      }
      continue;
    }

    if (/\s/.test(ch)) {
      if (hasTokenChars) {
        args.push(current);
        current = '';
        hasTokenChars = false;
      }
      continue;
    }

    if (ch === '"') {
      inDouble = true;
      hasTokenChars = true;
      continue;
    }

    if (ch === "'") {
      inSingle = true;
      hasTokenChars = true;
      continue;
    }

    if (ch === '\\' && i + 1 < argString.length) {
      const next = argString[i + 1];
      if (next === '"' || next === "'") {
        current += next;
        hasTokenChars = true;
        i++;
        continue;
      }
    }

    current += ch;
    hasTokenChars = true;
  }

  if (hasTokenChars) {
    args.push(current);
  }

  return args;
}

/**
 * Build Storefront URI for protocol-based launching
 */
function buildStorefrontLaunchUri(/** @type {any} */ payload = {}) {
  const platformId = payload.platformId || 'steam';
  const gameId = payload.platformGameId || payload.steamAppId || payload.gameId;
  if (platformId === 'steam') {
    const appId = payload.steamAppId || payload.platformGameId;
    return appId ? `steam://rungameid/${appId}` : null;
  }
  if (platformId === 'gog') {
    const cleanGogId = String(gameId || '')
      .trim()
      .replace(/^gog[-_]/i, '');
    return cleanGogId ? `goggalaxy://launchGame/gog_${cleanGogId}` : null;
  }
  if (platformId === 'epic') {
    return gameId
      ? `com.epicgames.launcher://apps/${encodeURIComponent(String(gameId))}?action=launch&silent=true`
      : null;
  }
  if (platformId === 'xbox') {
    const cleanXboxId = String(payload.xboxProductId || gameId || '')
      .trim()
      .replace(/^xbox[-_]/i, '');
    return cleanXboxId ? `msxbox://game/?productId=${encodeURIComponent(cleanXboxId)}` : null;
  }
  return null;
}

function trackPostSessionPromise(/** @type {any} */ promise) {
  if (!promise || typeof promise.finally !== 'function') {
    return Promise.resolve(promise);
  }
  inFlightPostSessionPromises.add(promise);
  promise.finally(() => {
    inFlightPostSessionPromises.delete(promise);
  });
  return promise;
}

const PROTECTED_PUBLISHER_EXE_RE =
  /^(?:steam|galaxyclient|epicgameslauncher|upc|ubisoftconnect|ubisoftgamelauncher|eadesktop|ealauncher|battle\.net|riotclientservices|gdkstubgame)\.exe$/i;

/**
 * Verify via `ps eww -p <pid>` whether a candidate Wine process belongs to `normScopePrefix`.
 * Returns `false` if the process explicitly carries a `WINEPREFIX=` pointing to a DIFFERENT bottle.
 *
 * @param {number} pid
 * @param {string} normScopePrefix
 * @returns {Promise<boolean>}
 */
function doesPosixProcessMatchWinePrefix(pid, normScopePrefix) {
  if (!normScopePrefix) return Promise.resolve(true);
  return new Promise((resolve) => {
    try {
      execFile('ps', ['eww', '-p', String(pid)], { timeout: 800 }, (err, stdout) => {
        if (err || !stdout) return resolve(true);
        const text = String(stdout).replace(/\\/g, '/');
        const m = /(?:^|\s)WINEPREFIX=(?:"([^"]+)"|'([^']+)'|(\S+))/i.exec(text);
        if (!m) {
          return resolve(true);
        }
        const rawPrefix = (m[1] || m[2] || m[3] || '').trim().replace(/\/+$/, '').toLowerCase();
        if (!rawPrefix) return resolve(true);
        resolve(rawPrefix === normScopePrefix || rawPrefix.startsWith(`${normScopePrefix}/`));
      });
    } catch {
      resolve(true);
    }
  });
}

/**
 * Batched POSIX process matcher that captures a single `ps -axo pid=,pgid=,ppid=,command=`
 * snapshot for an entire list of target Windows `.exe` names and verifies `WINEPREFIX` ownership
 * before sending `signal`.
 *
 * @param {string[]} exePathsOrNames
 * @param {NodeJS.Signals} [signal='SIGTERM']
 * @param {string} [scopeHint='']
 * @returns {Promise<void>}
 */
function killPosixProcessesMatchingWinExes(
  exePathsOrNames,
  signal = 'SIGTERM',
  scopeHint = ''
) {
  return new Promise((resolve) => {
    if (process.platform === 'win32' || !Array.isArray(exePathsOrNames)) {
      return resolve(undefined);
    }
    /** @type {RegExp[]} */
    const tokenRegexes = [];
    const seenBases = new Set();
    for (const rawExe of exePathsOrNames) {
      if (!rawExe || typeof rawExe !== 'string') continue;
      const exeBase = path.basename(rawExe).trim();
      const baseLower = exeBase.toLowerCase();
      if (
        !exeBase ||
        exeBase.length <= 3 ||
        seenBases.has(baseLower) ||
        PROTECTED_PUBLISHER_EXE_RE.test(exeBase)
      ) {
        continue;
      }
      seenBases.add(baseLower);
      const escapedBase = exeBase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      tokenRegexes.push(new RegExp(`(?:^|[\\\\/\\s"'])${escapedBase}(?:\\s|["']|$)`, 'i'));
    }
    if (tokenRegexes.length === 0) return resolve(undefined);

    const normScope = scopeHint
      ? path.resolve(String(scopeHint)).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
      : '';
    try {
      execFile(
        'ps',
        ['-axo', 'pid=,pgid=,ppid=,command='],
        { timeout: 1500 },
        async (err, stdout) => {
          if (err || !stdout) return resolve(undefined);
          /** @type {Array<{ pid: number, cmdMatchedScope: boolean }>} */
          const candidates = [];
          for (const rawLine of String(stdout).split(/\r?\n/)) {
            const m = rawLine.trim().match(/^(\d+)\s+\d+\s+\d+\s+(.+)$/);
            if (!m) continue;
            const candidatePid = Number.parseInt(m[1], 10);
            const cmd = m[2].trim();
            if (!candidatePid || candidatePid <= 1 || candidatePid === process.pid) continue;
            if (
              /^(?:\/bin\/|\/usr\/bin\/)?(?:ps|pkill|pgrep|grep|rg|vim|nvim|nano|less|tail|cat)\b/i.test(
                cmd
              )
            ) {
              continue;
            }
            if (!tokenRegexes.some((re) => re.test(cmd))) continue;
            const lowerCmd = cmd.replace(/\\/g, '/').toLowerCase();
            const cmdMatchedScope = Boolean(normScope && lowerCmd.includes(normScope));
            const hasWineOrPathContext =
              cmdMatchedScope ||
              /(?:wine|crossover|gameportingtoolkit|drive_c|[a-z]:\/)/i.test(lowerCmd);
            if (!hasWineOrPathContext) continue;
            candidates.push({ pid: candidatePid, cmdMatchedScope });
          }

          for (const cand of candidates) {
            if (normScope && !cand.cmdMatchedScope) {
              const matchesPrefix = await doesPosixProcessMatchWinePrefix(cand.pid, normScope);
              if (!matchesPrefix) continue;
            }
            try {
              process.kill(cand.pid, signal);
            } catch {}
          }
          resolve(undefined);
        }
      );
    } catch {
      resolve(undefined);
    }
  });
}

function killPosixProcessesMatchingWinExe(
  /** @type {string} */ exePath,
  /** @type {NodeJS.Signals} */ signal = 'SIGTERM',
  scopeHint = ''
) {
  if (!exePath) return Promise.resolve(undefined);
  return killPosixProcessesMatchingWinExes([exePath], signal, scopeHint);
}

function isMacSipProtectedExecutableOrScript(/** @type {string} */ binPath) {
  if (!binPath || typeof binPath !== 'string') return false;
  const resolved = path.resolve(binPath);
  const isSipPath = (/** @type {string} */ p) =>
    p.startsWith('/usr/bin/') ||
    p.startsWith('/bin/') ||
    p.startsWith('/sbin/') ||
    p.startsWith('/System/');
  if (isSipPath(resolved)) return true;
  /** @type {number | null} */
  let fd = null;
  try {
    if (!fs.existsSync(resolved)) return false;
    fd = fs.openSync(resolved, 'r');
    const head = Buffer.alloc(128);
    const bytesRead = fs.readSync(fd, head, 0, 128, 0);
    if (bytesRead >= 2 && head[0] === 0x23 && head[1] === 0x21) {
      const firstLine = head.subarray(2, bytesRead).toString('utf8').split(/\r?\n/)[0].trim();
      const interp = firstLine.split(/\s+/)[0] || '';
      if (isSipPath(interp)) return true;
    }
  } catch {
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {}
    }
  }
  return false;
}

/**
 * Determine whether a Windows spawn error genuinely requires UAC elevation (`ERROR_ELEVATION_REQUIRED` / 740).
 * Never triggers `-Verb RunAs` on generic libuv `UV_UNKNOWN` (-4094) or `WindowsApps` ACL errors for
 * real PE binaries unless the executable's PE `RT_MANIFEST` (or `.manifest` sidecar) requests elevation.
 */
function isWindowsElevationRequiredError(
  /** @type {any} */ err,
  exePath = '',
  /** @type {any} */ _options = {}
) {
  if (!err || typeof err !== 'object') return false;
  const msg = String(err.message || '');
  if (err.errno === 740 || /\b740\b|elevation/i.test(msg)) {
    return true;
  }
  if (exePath && isWindowsAppsProtectedPath(exePath)) {
    return false;
  }
  if (exePath && fs.existsSync(exePath)) {
    const peInfo = inspectWindowsExecutableHeader(exePath, { inspectElevationManifest: true });
    if (peInfo && peInfo.exists && peInfo.isValidPe && !peInfo.isSyntheticStub) {
      if (!('requiresElevation' in peInfo && peInfo.requiresElevation)) {
        return false;
      }
      return (
        err.code === 'EACCES' ||
        err.code === 'UNKNOWN' ||
        err.errno === -4094 ||
        err.errno === -4092 ||
        /eacces/i.test(msg)
      );
    }
  }
  return err.code === 'EACCES' || err.errno === -4094 || /eacces/i.test(msg);
}

function spawnWindowsViaPowerShellStartProcess(
  /** @type {any} */ gameSpawnImpl,
  /** @type {string} */ spawnCmd,
  /** @type {string[]} */ spawnArgs,
  /** @type {string} */ effectiveCwd,
  /** @type {Record<string, any>} */ baseEnv,
  requireRunAs = false
) {
  const psEnv = {
    ...baseEnv,
    ONE_LAUNCHER_PS_EXE: String(spawnCmd),
    ONE_LAUNCHER_PS_CWD: String(effectiveCwd),
    ONE_LAUNCHER_PS_ARGS_JSON: JSON.stringify(
      Array.isArray(spawnArgs) ? spawnArgs.map(String) : []
    ),
  };
  const verbClause = requireRunAs ? ' -Verb RunAs' : '';
  const psScript = [
    '$exe = $env:ONE_LAUNCHER_PS_EXE',
    '$wd = $env:ONE_LAUNCHER_PS_CWD',
    '$rawArgs = $env:ONE_LAUNCHER_PS_ARGS_JSON',
    '$argList = @()',
    'if ($rawArgs) { $parsed = ConvertFrom-Json -InputObject $rawArgs; if ($parsed -is [array]) { $argList = [string[]]$parsed } elseif ($null -ne $parsed) { $argList = @([string]$parsed) } }',
    `if ($argList.Count -gt 0) { $p = Start-Process -FilePath $exe -WorkingDirectory $wd -ArgumentList $argList${verbClause} -PassThru } else { $p = Start-Process -FilePath $exe -WorkingDirectory $wd${verbClause} -PassThru }`,
    "if ($null -ne $p) { [Console]::Out.WriteLine('OL_ELEVATED_PID=' + $p.Id); [Console]::Out.Flush(); try { $p.WaitForExit() } catch { Wait-Process -Id $p.Id -ErrorAction SilentlyContinue }; try { if ($null -ne $p.ExitCode) { exit $p.ExitCode } } catch {} }",
    'exit 0',
  ].join('; ');
  const child = gameSpawnImpl(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', psScript],
    {
      cwd: effectiveCwd,
      env: psEnv,
      detached: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    }
  );
  if (child && typeof child === 'object') {
    child._isPowerShellStartProcessWrapper = true;
    child._requireRunAs = Boolean(requireRunAs);
  }
  return child;
}

module.exports = {
  createGuardedSessionPoller,
  runApprovedLaunchHookCommand,
  isAuthoritativeInstallDirForMutation,
  disposeSessionResources,
  sanitizeEaBottleAutostartFallback,
  parseLaunchArguments,
  buildStorefrontLaunchUri,
  trackPostSessionPromise,
  PROTECTED_PUBLISHER_EXE_RE,
  doesPosixProcessMatchWinePrefix,
  killPosixProcessesMatchingWinExes,
  killPosixProcessesMatchingWinExe,
  isMacSipProtectedExecutableOrScript,
  isWindowsElevationRequiredError,
  spawnWindowsViaPowerShellStartProcess,
};
