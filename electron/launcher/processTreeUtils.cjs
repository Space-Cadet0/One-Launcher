// @ts-check
'use strict';

const { spawn, execFile } = require('node:child_process');
const { StringDecoder } = require('node:string_decoder');
const { diagLog } = require('../utils/diagnosticLogger.cjs');

/**
 * Single source of truth for non-destructive process liveness checks.
 *
 * @param {number} pid
 * @param {((pid: number, signal?: string | number) => void) | null} [killImpl]
 * @returns {boolean}
 */
function isProcessAlive(pid, killImpl = null) {
  if (!pid || typeof pid !== 'number' || pid <= 0) return false;
  const killer = typeof killImpl === 'function' ? killImpl : process.kill.bind(process);
  try {
    killer(pid, 0);
    return true;
  } catch (err) {
    return Boolean(err && /** @type {any} */ (err).code === 'EPERM');
  }
}

/**
 * Wait deterministically for a child process / PID to exit, cleaning up all poll & timeout
 * timers and child event listeners immediately on exit or timeout.
 *
 * @param {any} child
 * @param {number} pid
 * @param {number} [timeoutMs=400]
 * @param {((pid: number, signal?: string | number) => void) | null} [killImpl]
 * @returns {Promise<boolean>}
 */
async function waitForProcessExit(child, pid, timeoutMs = 400, killImpl = null) {
  if (!pid || !isProcessAlive(pid, killImpl)) return true;
  const boundedTimeoutMs = Math.max(10, Number(timeoutMs) || 400);
  return new Promise((resolve) => {
    let done = false;
    /** @type {ReturnType<typeof setInterval> | null} */
    let pollTimer = null;
    /** @type {ReturnType<typeof setTimeout> | null} */
    let timeoutTimer = null;

    /**
     * @param {boolean} exited
     */
    const finish = (exited) => {
      if (done) return;
      done = true;
      if (pollTimer) {
        clearInterval(pollTimer);
        pollTimer = null;
      }
      if (timeoutTimer) {
        clearTimeout(timeoutTimer);
        timeoutTimer = null;
      }
      if (child && typeof child.removeListener === 'function') {
        child.removeListener('exit', onExit);
        child.removeListener('close', onExit);
      }
      resolve(exited);
    };

    const onExit = () => finish(true);
    if (child && typeof child.once === 'function') {
      child.once('exit', onExit);
      child.once('close', onExit);
    }

    pollTimer = setInterval(() => {
      if (!isProcessAlive(pid, killImpl)) {
        finish(true);
      }
    }, 25);
    if (typeof pollTimer.unref === 'function') pollTimer.unref();

    timeoutTimer = setTimeout(() => {
      finish(!isProcessAlive(pid, killImpl));
    }, boundedTimeoutMs);
    if (typeof timeoutTimer.unref === 'function') timeoutTimer.unref();
  });
}

/**
 * @param {string} value
 * @returns {string}
 */
function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Build boundary-anchored regex matchers for POSIX process command lines so short hints
 * (e.g. `jk`, `run`, `app`) match executable basenames, `.app` bundles, or path segments
 * without false-matching unrelated substrings (`openjdk`, `runner`, `appleeventsd`).
 *
 * @param {string[]} hints
 * @returns {RegExp[]}
 */
function buildPosixHintMatchers(hints) {
  /** @type {RegExp[]} */
  const matchers = [];
  for (const hint of hints) {
    if (!hint) continue;
    const escapedHint = escapeRegExp(hint);
    if (hint.includes('/') || hint.includes('\\') || /\.(?:exe|app)$/i.test(hint)) {
      matchers.push(new RegExp(`(?:^|[\\s"'/\\\\:])${escapedHint}(?=$|[\\s"'/\\\\])`, 'i'));
    } else {
      matchers.push(
        new RegExp(`(?:^|[\\s"'/\\\\:])${escapedHint}(?:\\.exe|\\.app)?(?=$|[\\s"'/\\\\])`, 'i')
      );
    }
  }
  return matchers;
}

/**
 * Parse `ps -ax -o pid=,command=` (or `ps -ax -o pid=,ppid=,command=`) on macOS/Linux,
 * or `tasklist.exe /FO CSV /NH` on Windows, and return the numeric PID of the first
 * running process matching `exeHints`, or `0`.
 *
 * @param {string} stdout
 * @param {string | string[]} [exeHints]
 * @param {string} [platform]
 * @returns {number}
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
      // Anchored tabular tasklist fallback: <imageName> <PID> ...
      const tableMatch = line.match(/^"?([^\s"]+)"?\s+(\d+)\b/);
      if (tableMatch) {
        const firstToken = tableMatch[1].toLowerCase();
        const firstBase = firstToken.replace(/\.exe$/i, '');
        const pid = Number(tableMatch[2]);
        if (
          pid > 0 &&
          hintsWithAndWithoutExe.some((h) => firstToken === h || firstBase === h)
        ) {
          return pid;
        }
      }
    }
    return 0;
  }

  const hintMatchers = buildPosixHintMatchers(hints);
  for (const rawLine of lines) {
    // Support both `ps -o pid=,ppid=,command=` and `ps -o pid=,command=` with anchored PID columns
    const pidPpidCmdMatch = rawLine.match(/^\s*(\d+)\s+(\d+)\s+(.+)$/);
    const pidCmdMatch = pidPpidCmdMatch ? null : rawLine.match(/^\s*(\d+)\s+(.+)$/);
    const match = pidPpidCmdMatch || pidCmdMatch;
    if (!match) continue;
    const pid = Number(match[1]);
    const cmd = (pidPpidCmdMatch ? match[3] : match[2]).trim();
    if (!pid || pid <= 0 || !cmd) continue;
    if (/^(?:\/bin\/|\/usr\/bin\/)?ps(?:\s|$)/i.test(cmd)) continue;
    if (hintMatchers.some((re) => re.test(cmd))) {
      return pid;
    }
  }
  return 0;
}

/**
 * Parse anchored `ps -ax -o pid=,ppid=` output and collect all descendant PIDs of `rootPid`.
 *
 * @param {string} psOutput
 * @param {number} rootPid
 * @returns {number[]}
 */
function collectPosixDescendantPids(psOutput, rootPid) {
  if (!psOutput || !rootPid || rootPid <= 0) return [];
  /** @type {Map<number, number[]>} */
  const childrenByPpid = new Map();
  for (const rawLine of psOutput.split(/\r?\n/)) {
    const m = rawLine.match(/^\s*(\d+)\s+(\d+)\s*$/);
    if (!m) continue;
    const childPid = Number(m[1]);
    const ppid = Number(m[2]);
    if (childPid <= 0 || ppid <= 0 || childPid === ppid) continue;
    let list = childrenByPpid.get(ppid);
    if (!list) {
      list = [];
      childrenByPpid.set(ppid, list);
    }
    list.push(childPid);
  }

  /** @type {number[]} */
  const descendants = [];
  /** @type {Set<number>} */
  const visited = new Set([rootPid]);
  /** @type {number[]} */
  const queue = [rootPid];
  while (queue.length > 0) {
    const curr = /** @type {number} */ (queue.shift());
    const kids = childrenByPpid.get(curr);
    if (!kids) continue;
    for (const k of kids) {
      if (visited.has(k)) continue;
      visited.add(k);
      descendants.push(k);
      queue.push(k);
    }
  }
  return descendants;
}

/**
 * Signal an entire subprocess tree across macOS/Linux process groups (`-pid` when spawned
 * with `detached: true`, or descendant PID walk via anchored `ps -ax -o pid=,ppid=` when
 * `detached: false`) and Windows process trees (`taskkill /PID <pid> /T /F`), ensuring
 * two-process PyInstaller helpers (`legendary`, `gogdl`) never leave orphan worker children.
 *
 * @param {number | any} proc
 * @param {string} [signal='SIGTERM']
 * @param {Record<string, any>} [options]
 * @returns {Promise<{ signaled: boolean, method: string, pid: number, signal?: string }>}
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
        /** @param {boolean} ok */
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
            (/** @type {any} */ err) => {
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

  // POSIX (darwin / linux)
  const isExplicitlyNonDetached =
    options.detached === false ||
    (proc && typeof proc === 'object' && proc.detached === false);

  if (pid > 0 && isExplicitlyNonDetached) {
    return new Promise((resolve) => {
      const signalTargets = (/** @type {number[]} */ descendants) => {
        let anySignaled = false;
        // Signal deepest descendants first, then root PID
        for (let i = descendants.length - 1; i >= 0; i -= 1) {
          try {
            killImpl(descendants[i], signal);
            anySignaled = true;
          } catch {}
        }
        try {
          killImpl(pid, signal);
          anySignaled = true;
        } catch (pidErr) {
          diagLog.debug('processTree.nonDetachedPidKill', pidErr, { pid, signal });
        }
        resolve({
          signaled: anySignaled,
          method: descendants.length > 0 ? 'descendant_walk' : 'pid',
          pid,
          signal,
        });
      };

      try {
        execFileImpl(
          'ps',
          ['-ax', '-o', 'pid=,ppid='],
          { encoding: 'utf8', timeout: 1500 },
          (/** @type {any} */ err, /** @type {string | Buffer} */ stdout) => {
            const descendants = !err && stdout ? collectPosixDescendantPids(String(stdout), pid) : [];
            signalTargets(descendants);
          }
        );
      } catch {
        signalTargets([]);
      }
    });
  }

  // POSIX detached process group: signal negative PGID first, falling back to single PID
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
 * if the command hangs or times out. Uses `StringDecoder('utf8')` with exact `maxBuffer`
 * byte slicing so multi-byte UTF-8 paths never corrupt at chunk boundaries, and cleans up
 * all kill/poll timers deterministically.
 *
 * @param {string} bin
 * @param {string[]} [args]
 * @param {Record<string, any>} [execOpts]
 * @param {Record<string, any>} [options]
 * @returns {Promise<{ err: any, stdout: string, stderr: string, timedOut: boolean }>}
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
      /** @type {any} */
      let childHandle = null;
      /** @type {ReturnType<typeof setTimeout> | null} */
      let timer = null;

      /**
       * @param {{ err: any, stdout: string, stderr: string, timedOut: boolean }} payload
       */
      const resolveOnce = (payload) => {
        if (timer) {
          clearTimeout(timer);
          timer = null;
        }
        resolve(payload);
      };

      timer = setTimeout(async () => {
        if (finished) return;
        // Mark finished synchronously BEFORE awaiting tree kill to prevent double-resolve race
        finished = true;
        timer = null;
        if (childHandle && childHandle.pid) {
          try {
            await signalSubprocessTree(childHandle, 'SIGKILL', options);
          } catch {}
        }
        const timeoutErr = Object.assign(
          new Error(`Command timed out after ${timeoutMs}ms: ${bin}`),
          { code: 'ETIMEDOUT', killed: true, timedOut: true }
        );
        resolveOnce({ err: timeoutErr, stdout: '', stderr: '', timedOut: true });
      }, timeoutMs);
      if (typeof timer.unref === 'function') timer.unref();

      try {
        childHandle = customExecFile(
          bin,
          args,
          { ...execOpts, timeout: timeoutMs },
          async (/** @type {any} */ err, /** @type {any} */ stdout = '', /** @type {any} */ stderr = '') => {
            if (finished) return;
            finished = true;
            if (timer) {
              clearTimeout(timer);
              timer = null;
            }
            const isTimeout = Boolean(
              err &&
                (err.killed ||
                  err.code === 'ETIMEDOUT' ||
                  /timed?\s*out/i.test(String(err.message || '')))
            );
            if (isTimeout && childHandle && childHandle.pid) {
              try {
                await signalSubprocessTree(childHandle, 'SIGKILL', options);
              } catch {}
            }
            resolveOnce({
              err: err || null,
              stdout: Buffer.isBuffer(stdout) ? stdout.toString('utf8') : String(stdout || ''),
              stderr: Buffer.isBuffer(stderr) ? stderr.toString('utf8') : String(stderr || ''),
              timedOut: isTimeout,
            });
          }
        );
      } catch (syncErr) {
        if (finished) return;
        finished = true;
        resolveOnce({ err: syncErr, stdout: '', stderr: '', timedOut: false });
      }
    });
  }

  const spawnImpl = typeof options.spawnFn === 'function' ? options.spawnFn : spawn;

  return new Promise((resolve) => {
    let finished = false;
    let timedOut = false;
    const stdoutDecoder = new StringDecoder('utf8');
    const stderrDecoder = new StringDecoder('utf8');
    let stdout = '';
    let stderr = '';
    let stdoutBytes = 0;
    let stderrBytes = 0;
    /** @type {any} */
    let child = null;
    /** @type {ReturnType<typeof setTimeout> | null} */
    let timer = null;

    /**
     * @param {{ err: any, stdout: string, stderr: string, timedOut: boolean }} payload
     */
    const finish = (payload) => {
      if (finished) return;
      finished = true;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      resolve(payload);
    };

    const flushDecoders = () => {
      const tailOut = stdoutDecoder.end();
      if (tailOut) stdout += tailOut;
      const tailErr = stderrDecoder.end();
      if (tailErr) stderr += tailErr;
    };

    /**
     * @param {Buffer | string | Uint8Array} chunk
     * @param {boolean} isStderr
     */
    const appendDecodedChunk = (chunk, isStderr) => {
      const currentBytes = isStderr ? stderrBytes : stdoutBytes;
      if (currentBytes >= maxBuffer) return;
      const buf = Buffer.isBuffer(chunk)
        ? chunk
        : typeof chunk === 'string'
          ? Buffer.from(chunk, 'utf8')
          : Buffer.from(chunk);
      const remaining = maxBuffer - currentBytes;
      const slice = buf.length > remaining ? buf.subarray(0, remaining) : buf;
      if (isStderr) {
        stderrBytes += slice.length;
        stderr += stderrDecoder.write(slice);
      } else {
        stdoutBytes += slice.length;
        stdout += stdoutDecoder.write(slice);
      }
    };

    timer = setTimeout(async () => {
      if (finished) return;
      timedOut = true;
      timer = null;
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
          const exitedEarly = await waitForProcessExit(
            child,
            child.pid,
            graceMs,
            options.killImpl || null
          );
          if (!exitedEarly && child.pid && isProcessAlive(child.pid, options.killImpl || null)) {
            await signalSubprocessTree(child, 'SIGKILL', options);
          }
        }
      }
      flushDecoders();
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
      child.stdout.on('data', (/** @type {Buffer | string} */ chunk) => {
        appendDecodedChunk(chunk, false);
      });
    }
    if (child.stderr && typeof child.stderr.on === 'function') {
      child.stderr.on('data', (/** @type {Buffer | string} */ chunk) => {
        appendDecodedChunk(chunk, true);
      });
    }

    child.on('error', (/** @type {any} */ err) => {
      if (timedOut || finished) return;
      flushDecoders();
      finish({ err, stdout, stderr, timedOut: false });
    });

    child.on('close', (/** @type {number | null} */ code, /** @type {string | null} */ sig) => {
      if (timedOut || finished) return;
      flushDecoders();
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
  collectPosixDescendantPids,
  signalSubprocessTree,
  execCliWithTreeTimeout,
};
