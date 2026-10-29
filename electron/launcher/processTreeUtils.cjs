'use strict';

const { spawn, execFile } = require('node:child_process');
const { diagLog } = require('../utils/diagnosticLogger.cjs');

/**
 * Single source of truth for non-destructive process liveness checks.
 */
function isProcessAlive(pid, killImpl = null) {
  if (!pid || typeof pid !== 'number' || pid <= 0) return false;
  const killer = typeof killImpl === 'function' ? killImpl : process.kill.bind(process);
  try {
    killer(pid, 0);
    return true;
  } catch (err) {
    return Boolean(err && err.code === 'EPERM');
  }
}

async function waitForProcessExit(child, pid, timeoutMs = 400, killImpl = null) {
  if (!pid || !isProcessAlive(pid, killImpl)) return true;
  return new Promise((resolve) => {
    let done = false;
    let pollTimer = null;
    let timeoutTimer = null;
    const finish = (exited) => {
      if (done) return;
      done = true;
      if (pollTimer) clearInterval(pollTimer);
      if (timeoutTimer) clearTimeout(timeoutTimer);
      if (child && typeof child.removeListener === 'function') {
        child.removeListener('exit', onExit);
      }
      resolve(exited);
    };
    const onExit = () => finish(true);
    if (child && typeof child.once === 'function') {
      child.once('exit', onExit);
    }
    pollTimer = setInterval(() => {
      if (!isProcessAlive(pid, killImpl)) {
        finish(true);
      }
    }, 25);
    if (typeof pollTimer.unref === 'function') pollTimer.unref();
    timeoutTimer = setTimeout(() => {
      finish(!isProcessAlive(pid, killImpl));
    }, timeoutMs);
    if (typeof timeoutTimer.unref === 'function') timeoutTimer.unref();
  });
}

/**
 * Parse `ps -ax -o pid=,command=` (macOS/Linux) or `tasklist.exe /FO CSV /NH` (Windows)
 * output and return the numeric PID of the first running process matching `exeHints`, or `0`.
 */
function extractMatchedPidFromProcessOutput(stdout, exeHints = [], platform = process.platform) {
  if (!stdout || typeof stdout !== 'string') return 0;
  const rawHints = Array.isArray(exeHints) ? exeHints : [exeHints];
  const hints = Array.from(
    new Set(
      rawHints
        .map((h) => String(h || '').trim().toLowerCase())
        .filter(Boolean)
    )
  );
  if (hints.length === 0) return 0;

  const lines = stdout.split(/\r?\n/);
  if (platform === 'win32') {
    const hintsWithAndWithoutExe = Array.from(
      new Set(
        hints.flatMap((h) => {
          const stripped = h.replace(/\.exe$/i, '');
          return stripped ? [h, stripped, `${stripped}.exe`] : [h];
        })
      )
    );
    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line) continue;
      const csvMatch = line.match(/^"([^"]+)"\s*,\s*"(\d+)"/);
      if (csvMatch) {
        const imgName = csvMatch[1].trim().toLowerCase();
        const imgBase = imgName.replace(/\.exe$/i, '');
        const pid = Number(csvMatch[2]);
        if (
          pid > 0 &&
          hintsWithAndWithoutExe.some((h) => imgName === h || imgBase === h)
        ) {
          return pid;
        }
        continue;
      }
      const tokens = line
        .toLowerCase()
        .split(/\s+/)
        .map((t) => t.replace(/^"+|"+$/g, ''));
      const firstToken = tokens[0] || '';
      const firstBase = firstToken.replace(/\.exe$/i, '');
      if (
        firstToken &&
        hintsWithAndWithoutExe.some((h) => firstToken === h || firstBase === h)
      ) {
        const numMatch = line.match(/\b(\d{2,10})\b/);
        if (numMatch && Number(numMatch[1]) > 0) {
          return Number(numMatch[1]);
        }
      }
    }
    return 0;
  }

  for (const rawLine of lines) {
    const match = rawLine.match(/^\s*(\d+)\s+(.+)$/);
    if (!match) continue;
    const pid = Number(match[1]);
    const cmd = match[2].trim();
    if (!pid || pid <= 0 || !cmd) continue;
    if (/^(?:\/bin\/|\/usr\/bin\/)?ps(?:\s|$)/i.test(cmd)) continue;
    const cmdLower = cmd.toLowerCase();
    if (hints.some((h) => cmdLower.includes(h))) {
      return pid;
    }
  }
  return 0;
}

/**
 * Signal an entire subprocess tree across macOS/Linux process groups (`-pid` when spawned
 * with `detached: true`) and Windows process trees (`taskkill /PID <pid> /T /F`), ensuring
 * two-process PyInstaller helpers (`legendary`, `gogdl`) never leave orphan worker children.
 */
function signalSubprocessTree(proc, signal = 'SIGTERM', options = {}) {
  const targetPlatform = options.platform || process.platform;
  const pid =
    typeof proc === 'number'
      ? proc
      : proc && typeof proc === 'object' && typeof proc.pid === 'number'
        ? proc.pid
        : 0;
  const execFileImpl =
    typeof options.execFileImpl === 'function'
      ? options.execFileImpl
      : typeof options.execFileFn === 'function'
        ? options.execFileFn
        : execFile;
  const killImpl =
    typeof options.killImpl === 'function' ? options.killImpl : process.kill.bind(process);

  if (targetPlatform === 'win32') {
    if (signal === 'SIGCONT') {
      return Promise.resolve({ signaled: false, method: 'win32_noop_sigcont', pid });
    }
    if (pid > 0) {
      return new Promise((resolve) => {
        let settled = false;
        const done = (ok) => {
          if (settled) return;
          settled = true;
          resolve({ signaled: ok, method: 'taskkill_tree', pid, signal });
        };
        try {
          execFileImpl(
            'taskkill',
            ['/PID', String(pid), '/T', '/F'],
            { timeout: 2500, windowsHide: true },
            (err) => {
              if (err) {
                diagLog.debug('processTree.taskkill', err, { pid, signal });
              }
              if (err && proc && typeof proc.kill === 'function') {
                try {
                  proc.kill();
                } catch (killErr) {
                  diagLog.debug('processTree.procKillFallback', killErr, { pid });
                }
              }
              done(!err);
            }
          );
        } catch (err) {
          diagLog.warn('processTree.taskkillInvoke', err, { pid, signal });
          if (proc && typeof proc.kill === 'function') {
            try {
              proc.kill();
            } catch (killErr) {
              diagLog.debug('processTree.procKillFallback', killErr, { pid });
            }
          }
          done(false);
        }
      });
    }
    if (proc && typeof proc.kill === 'function') {
      try {
        proc.kill();
        return Promise.resolve({ signaled: true, method: 'child_kill', pid: 0, signal });
      } catch (err) {
        diagLog.debug('processTree.childKill', err);
      }
    }
    return Promise.resolve({ signaled: false, method: 'none', pid: 0, signal });
  }

  // POSIX (darwin / linux): signal negative PGID first, falling back to single PID
  if (pid > 0) {
    try {
      killImpl(-pid, signal);
      return Promise.resolve({ signaled: true, method: 'process_group', pid, signal });
    } catch (pgErr) {
      diagLog.debug('processTree.pgidFallback', pgErr, { pid, signal });
      try {
        killImpl(pid, signal);
        return Promise.resolve({ signaled: true, method: 'pid', pid, signal });
      } catch (pidErr) {
        diagLog.debug('processTree.pidKill', pidErr, { pid, signal });
        return Promise.resolve({ signaled: false, method: 'failed', pid, signal });
      }
    }
  }

  if (proc && typeof proc.kill === 'function') {
    try {
      proc.kill(signal);
      return Promise.resolve({ signaled: true, method: 'child_kill', pid: 0, signal });
    } catch (err) {
      diagLog.debug('processTree.childKillPosix', err);
    }
  }

  return Promise.resolve({ signaled: false, method: 'none', pid: 0, signal });
}

/**
 * Execute a CLI helper (`gogdl`, `legendary`, etc.) with a strict wall-clock timeout
 * that kills the ENTIRE subprocess tree (`-pid` on POSIX, `taskkill /T /F` on Windows)
 * if the command hangs or times out. Seamlessly supports `options.execFileImpl` / `options.execFileFn`
 * mocks in unit tests.
 */
async function execCliWithTreeTimeout(bin, args = [], execOpts = {}, options = {}) {
  const targetPlatform = options.platform || process.platform;
  const timeoutMs = Math.max(10, Number(execOpts?.timeout ?? options?.timeoutMs ?? 60000));
  const maxBuffer = Number(execOpts?.maxBuffer || 4 * 1024 * 1024);

  const customExecFile =
    typeof options.execFileImpl === 'function'
      ? options.execFileImpl
      : typeof options.execFileFn === 'function'
        ? options.execFileFn
        : null;

  if (customExecFile && options.useSpawnForCliTimeout !== true) {
    return new Promise((resolve) => {
      let finished = false;
      let childHandle = null;
      let timer = null;

      const finish = (payload) => {
        if (finished) return;
        finished = true;
        if (timer) clearTimeout(timer);
        resolve(payload);
      };

      timer = setTimeout(async () => {
        if (finished) return;
        if (childHandle && childHandle.pid) {
          await signalSubprocessTree(childHandle, 'SIGKILL', options);
        }
        const timeoutErr = Object.assign(
          new Error(`Command timed out after ${timeoutMs}ms: ${bin}`),
          { code: 'ETIMEDOUT', killed: true, timedOut: true }
        );
        finish({ err: timeoutErr, stdout: '', stderr: '', timedOut: true });
      }, timeoutMs);
      if (typeof timer.unref === 'function') timer.unref();

      try {
        childHandle = customExecFile(
          bin,
          args,
          { ...execOpts, timeout: timeoutMs },
          async (err, stdout = '', stderr = '') => {
            if (finished) return;
            const isTimeout = Boolean(
              err &&
                (err.killed ||
                  err.code === 'ETIMEDOUT' ||
                  /timed?\s*out/i.test(String(err.message || '')))
            );
            if (isTimeout && childHandle && childHandle.pid) {
              await signalSubprocessTree(childHandle, 'SIGKILL', options);
            }
            finish({
              err: err || null,
              stdout: String(stdout || ''),
              stderr: String(stderr || ''),
              timedOut: isTimeout,
            });
          }
        );
      } catch (syncErr) {
        finish({ err: syncErr, stdout: '', stderr: '', timedOut: false });
      }
    });
  }

  const spawnImpl = typeof options.spawnFn === 'function' ? options.spawnFn : spawn;

  return new Promise((resolve) => {
    let finished = false;
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let child = null;

    const finish = (payload) => {
      if (finished) return;
      finished = true;
      if (timer) clearTimeout(timer);
      resolve(payload);
    };

    const timer = setTimeout(async () => {
      if (finished) return;
      timedOut = true;
      diagLog.warn('processTree.cliTimeout', `CLI helper timed out after ${timeoutMs}ms`, {
        bin,
        args,
      });
      if (child) {
        if (targetPlatform === 'win32') {
          await signalSubprocessTree(child, 'SIGKILL', options);
        } else {
          await signalSubprocessTree(child, 'SIGTERM', options);
          const graceMs = Math.max(25, Number(options.killGraceMs ?? 500));
          await new Promise((r) => {
            const gt = setTimeout(r, graceMs);
            if (typeof gt.unref === 'function') gt.unref();
          });
          if (child.pid && isProcessAlive(child.pid, options.killImpl)) {
            await signalSubprocessTree(child, 'SIGKILL', options);
          }
        }
      }
      const timeoutErr = Object.assign(
        new Error(`Command timed out after ${timeoutMs}ms`),
        { code: 'ETIMEDOUT', killed: true, timedOut: true }
      );
      finish({ err: timeoutErr, stdout, stderr, timedOut: true });
    }, timeoutMs);
    if (typeof timer.unref === 'function') timer.unref();

    try {
      child = spawnImpl(bin, args, {
        cwd: execOpts?.cwd,
        env: execOpts?.env || process.env,
        detached: targetPlatform !== 'win32',
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (spawnErr) {
      finish({ err: spawnErr, stdout: '', stderr: '', timedOut: false });
      return;
    }

    if (child.stdout && typeof child.stdout.on === 'function') {
      child.stdout.on('data', (chunk) => {
        if (stdout.length < maxBuffer) {
          stdout += String(chunk);
        }
      });
    }
    if (child.stderr && typeof child.stderr.on === 'function') {
      child.stderr.on('data', (chunk) => {
        if (stderr.length < maxBuffer) {
          stderr += String(chunk);
        }
      });
    }

    child.on('error', (err) => {
      finish({ err, stdout, stderr, timedOut });
    });

    child.on('close', (code, sig) => {
      if (timedOut) return;
      if (code === 0) {
        finish({ err: null, stdout, stderr, timedOut: false });
      } else {
        const exitErr = Object.assign(
          new Error(
            sig
              ? `Command terminated by signal ${sig}`
              : `Command exited with code ${code}`
          ),
          { code, signal: sig }
        );
        finish({ err: exitErr, stdout, stderr, timedOut: false });
      }
    });
  });
}

module.exports = {
  isProcessAlive,
  waitForProcessExit,
  extractMatchedPidFromProcessOutput,
  signalSubprocessTree,
  execCliWithTreeTimeout,
};
