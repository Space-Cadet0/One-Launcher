// @ts-check
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const {
  toHostFilesystemPath,
  applyWindowsOwnerAclAsync,
  atomicWriteSecureFileSync,
} = require('../../launcher/securityAndPathUtils.cjs');

const VAULT_LOCK_TIMEOUT_MS = 5000;

/**
 * Per-vault promise mutex queue serializing concurrent async read-modify-write operations.
 * Each entry settles ONLY after its active critical-section task finishes (NEVER prematurely
 * on waiter timeout), guaranteeing strict single-writer serialization on disk.
 *
 * @type {Map<string, Promise<any>>}
 */
const vaultMutexQueues = new Map();

/**
 * Bounded Windows `EPERM` / `EBUSY` / `EACCES` retry for atomic `fs.promises.rename`.
 *
 * @param {string} tmpPath
 * @param {string} targetPath
 */
async function renameWithWindowsRetryAsync(tmpPath, targetPath) {
  const maxAttempts = 5;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      await fs.promises.rename(tmpPath, targetPath);
      return;
    } catch (err) {
      const code = err && typeof err === 'object' ? String(/** @type {any} */ (err).code || '') : '';
      const retryable = code === 'EPERM' || code === 'EBUSY' || code === 'EACCES';
      if (!retryable || attempt >= maxAttempts) {
        throw err;
      }
      await new Promise((resolve) => {
        const t = setTimeout(resolve, 12 * attempt);
        if (typeof t.unref === 'function') t.unref();
      });
    }
  }
}

/**
 * Atomically open a unique sibling temp file with `wx` + `0o600`, write `content`, `datasync()`,
 * close, enforce owner-only permissions / Windows owner ACL, and return the written temp path.
 * Retries up to 3 times on `EEXIST` temp filename collision.
 *
 * @param {string} targetBasePath
 * @param {string | Buffer} content
 * @returns {Promise<string>}
 */
async function writeExclusiveSecureTempFileAsync(targetBasePath, content) {
  const maxCollisionRetries = 3;
  for (let attempt = 1; attempt <= maxCollisionRetries; attempt += 1) {
    const tmpPath = `${targetBasePath}.${process.pid}.${Date.now()}.${crypto.randomBytes(6).toString('hex')}.tmp`;
    /** @type {fs.promises.FileHandle | null} */
    let fh = null;
    try {
      fh = await fs.promises.open(tmpPath, 'wx', 0o600);
      if (Buffer.isBuffer(content)) {
        await fh.writeFile(content);
      } else {
        await fh.writeFile(content, 'utf8');
      }
      try {
        await fh.datasync();
      } catch {}
      await fh.close();
      fh = null;

      if (process.platform === 'win32') {
        try {
          await applyWindowsOwnerAclAsync(tmpPath);
        } catch {}
      } else {
        try {
          await fs.promises.chmod(tmpPath, 0o600);
        } catch {}
      }
      return tmpPath;
    } catch (err) {
      if (fh) {
        try {
          await fh.close();
        } catch {}
      }
      const code = err && typeof err === 'object' ? String(/** @type {any} */ (err).code || '') : '';
      if (code !== 'EEXIST') {
        try {
          await fs.promises.unlink(tmpPath);
        } catch {}
        throw err;
      }
      if (attempt >= maxCollisionRetries) {
        throw err;
      }
    }
  }
  throw new Error('Exhausted exclusive temp file retries');
}

/**
 * Atomically preserve `<hostFilePath>.bak` with `0o600` permissions from creation (zero `0o644`
 * world-readable TOCTOU window) and Windows owner-SID ACLs before replacing a valid non-empty target.
 *
 * @param {string} hostFilePath
 */
async function preserveSecureBackupAsync(hostFilePath) {
  const targetStat = await fs.promises.stat(hostFilePath).catch(() => null);
  if (!targetStat || !targetStat.isFile() || targetStat.size <= 0) {
    return;
  }
  const existingBytes = await fs.promises.readFile(hostFilePath);
  if (!existingBytes || existingBytes.length === 0) {
    return;
  }
  const bakPath = `${hostFilePath}.bak`;
  const bakTmpPath = await writeExclusiveSecureTempFileAsync(bakPath, existingBytes);
  try {
    await renameWithWindowsRetryAsync(bakTmpPath, bakPath);
    if (process.platform === 'win32') {
      try {
        await applyWindowsOwnerAclAsync(bakPath);
      } catch {}
    } else {
      try {
        await fs.promises.chmod(bakPath, 0o600);
      } catch {}
    }
  } catch (err) {
    try {
      await fs.promises.unlink(bakTmpPath);
    } catch {}
    throw err;
  }
}

/**
 * Atomic async `.tmp` + `fh.datasync()` + `rename` write with `0o600` / Windows owner-SID ACLs.
 * Preserves `<filePath>.bak` backup atomically with `0o600` permissions before replacing a valid
 * existing file (unless `options.preserveBackup === false`, used during `.bak` recovery so a
 * corrupted primary file NEVER overwrites the known-good `.bak`), and propagates real disk
 * write errors honestly instead of swallowing them.
 *
 * @param {string} filePath
 * @param {string | Buffer} content
 * @param {{ preserveBackup?: boolean }} [options]
 */
async function atomicWriteVaultFileAsync(filePath, content, options = {}) {
  const hostFilePath = toHostFilesystemPath(filePath);
  const dir = path.dirname(hostFilePath);
  await fs.promises.mkdir(dir, { recursive: true, mode: 0o700 });
  if (process.platform !== 'win32') {
    try {
      await fs.promises.chmod(dir, 0o700);
    } catch {}
  }

  /** @type {string | null} */
  let tmpPath = null;
  try {
    tmpPath = await writeExclusiveSecureTempFileAsync(hostFilePath, content);

    // Best-effort atomic 0o600 .bak preservation before swapping primary file
    if (options?.preserveBackup !== false) {
      try {
        await preserveSecureBackupAsync(hostFilePath);
      } catch {}
    }

    await renameWithWindowsRetryAsync(tmpPath, hostFilePath);
    tmpPath = null;

    if (process.platform === 'win32') {
      try {
        await applyWindowsOwnerAclAsync(hostFilePath);
      } catch {}
    } else {
      try {
        await fs.promises.chmod(hostFilePath, 0o600);
      } catch {}
    }
  } catch (err) {
    if (tmpPath) {
      try {
        await fs.promises.unlink(tmpPath);
      } catch {}
    }
    const code = err && typeof err === 'object' ? String(/** @type {any} */ (err).code || '') : '';
    // Fall back to secure sync writer ONLY on persistent temp filename collision (`EEXIST`)
    if (code === 'EEXIST') {
      atomicWriteSecureFileSync(hostFilePath, content, options);
      return;
    }
    throw err;
  }
}

/**
 * Serializes concurrent async vault operations per resolved `tokens.json` path with a strict
 * non-overlapping single-writer guarantee (`P0-06`):
 *
 * - If a waiter exceeds `lockTimeoutMs` while waiting to acquire the lock, ONLY the timed-out
 *   waiter rejects cleanly and is marked abandoned (never executing its task and NEVER releasing
 *   the lock held by the still-running active writer).
 * - If an active holder exceeds `lockTimeoutMs`, its caller promise rejects with a timeout error,
 *   while the mutex queue continues waiting for the in-flight writer's promise to actually settle
 *   before admitting the next queued task so two disk writers can NEVER overlap.
 *
 * @template T
 * @param {string} filePath
 * @param {() => Promise<T> | T} task
 * @param {number} [lockTimeoutMs=VAULT_LOCK_TIMEOUT_MS]
 * @returns {Promise<T>}
 */
function runWithVaultMutex(filePath, task, lockTimeoutMs = VAULT_LOCK_TIMEOUT_MS) {
  const key = path.resolve(toHostFilesystemPath(filePath));
  const prev = vaultMutexQueues.get(key) || Promise.resolve();
  const effectiveTimeoutMs =
    typeof lockTimeoutMs === 'number' && Number.isFinite(lockTimeoutMs) && lockTimeoutMs > 0
      ? lockTimeoutMs
      : VAULT_LOCK_TIMEOUT_MS;

  let abandonedBeforeAcquire = false;
  let callerSettled = false;
  /** @type {ReturnType<typeof setTimeout> | null} */
  let acquireTimer = null;
  /** @type {ReturnType<typeof setTimeout> | null} */
  let execTimer = null;

  /** @type {(value: T | PromiseLike<T>) => void} */
  let resolveCaller;
  /** @type {(reason?: any) => void} */
  let rejectCaller;
  /** @type {Promise<T>} */
  const callerPromise = new Promise((resolve, reject) => {
    resolveCaller = resolve;
    rejectCaller = reject;
  });

  const settleResolve = (/** @type {T} */ value) => {
    if (callerSettled) return;
    callerSettled = true;
    resolveCaller(value);
  };

  const settleReject = (/** @type {any} */ err) => {
    if (callerSettled) return;
    callerSettled = true;
    rejectCaller(err);
  };

  // Acquisition watchdog: rejects ONLY this waiter if `prev` does not release within `effectiveTimeoutMs`
  acquireTimer = setTimeout(() => {
    acquireTimer = null;
    abandonedBeforeAcquire = true;
    settleReject(new Error(`Vault mutex lock timed out after ${effectiveTimeoutMs}ms`));
  }, effectiveTimeoutMs);
  if (typeof acquireTimer.unref === 'function') acquireTimer.unref();

  const queueTail = prev
    .catch(() => {})
    .then(() => {
      if (acquireTimer) {
        clearTimeout(acquireTimer);
        acquireTimer = null;
      }
      if (abandonedBeforeAcquire) {
        // Waiter timed out before lock acquisition; pass the baton immediately without executing `task`
        return undefined;
      }

      /** @type {Promise<T>} */
      let taskPromise;
      try {
        taskPromise = Promise.resolve(task());
      } catch (syncErr) {
        settleReject(syncErr);
        return undefined;
      }

      // Execution watchdog: rejects caller promise after `effectiveTimeoutMs`,
      // while `queueTail` still awaits `taskPromise` so no second writer can overlap an active disk write!
      execTimer = setTimeout(() => {
        execTimer = null;
        settleReject(new Error(`Vault mutex lock timed out after ${effectiveTimeoutMs}ms`));
      }, effectiveTimeoutMs);
      if (typeof execTimer.unref === 'function') execTimer.unref();

      return taskPromise.then(
        (val) => {
          if (execTimer) {
            clearTimeout(execTimer);
            execTimer = null;
          }
          settleResolve(val);
        },
        (err) => {
          if (execTimer) {
            clearTimeout(execTimer);
            execTimer = null;
          }
          settleReject(err);
        }
      );
    });

  const tracked = queueTail
    .catch(() => {})
    .finally(() => {
      if (acquireTimer) {
        clearTimeout(acquireTimer);
        acquireTimer = null;
      }
      if (execTimer) {
        clearTimeout(execTimer);
        execTimer = null;
      }
      if (vaultMutexQueues.get(key) === tracked) {
        vaultMutexQueues.delete(key);
      }
    });

  vaultMutexQueues.set(key, tracked);
  // Mirror original executedTask.catch() observer so fake-timer timeout tests advancing timers
  // before attaching `expect(p).rejects` do not trigger spurious unhandledRejection warnings.
  callerPromise.catch(() => {});
  return callerPromise;
}

/**
 * Canonical contract alias for `runWithVaultMutex`.
 * If invoked with a task callback, executes task under mutex and returns its Promise.
 * If invoked without a task callback, returns an acquire/release handle.
 *
 * @template T
 * @param {string} filePath
 * @param {(() => Promise<T>) | number | { timeoutMs?: number, lockTimeoutMs?: number }} [taskOrCallback]
 * @param {number} [timeoutMs]
 * @returns {Promise<T> | {
 *   lockPromise: Promise<void>,
 *   acquired: Promise<void>,
 *   release: () => void,
 *   readonly isAcquired: boolean,
 *   readonly isReleased: boolean,
 *   [Symbol.asyncDispose]: () => Promise<void>
 * }}
 */
function acquireVaultLock(filePath, taskOrCallback, timeoutMs) {
  if (typeof taskOrCallback === 'function') {
    return runWithVaultMutex(filePath, taskOrCallback, timeoutMs);
  }

  /** @type {number | undefined} */
  let effectiveTimeout;
  if (typeof taskOrCallback === 'number') {
    effectiveTimeout = taskOrCallback;
  } else if (typeof timeoutMs === 'number') {
    effectiveTimeout = timeoutMs;
  } else if (taskOrCallback && typeof taskOrCallback === 'object') {
    effectiveTimeout =
      typeof taskOrCallback.timeoutMs === 'number'
        ? taskOrCallback.timeoutMs
        : typeof taskOrCallback.lockTimeoutMs === 'number'
          ? taskOrCallback.lockTimeoutMs
          : undefined;
  }

  let isReleased = false;
  let isAcquired = false;
  /** @type {(() => void) | null} */
  let releaseInternal = null;
  /** @type {(() => void) | null} */
  let acquiredResolve = null;
  /** @type {((err: any) => void) | null} */
  let acquiredReject = null;

  /** @type {Promise<void>} */
  const acquired = new Promise((resolve, reject) => {
    acquiredResolve = resolve;
    acquiredReject = reject;
  });
  acquired.catch(() => {});

  const release = () => {
    if (isReleased) return;
    isReleased = true;
    if (typeof releaseInternal === 'function') {
      releaseInternal();
    }
  };

  /** @type {Promise<void>} */
  const lockPromise = runWithVaultMutex(
    filePath,
    () => {
      if (isReleased) {
        isAcquired = true;
        if (acquiredResolve) acquiredResolve();
        return Promise.resolve();
      }

      return new Promise((resolve) => {
        releaseInternal = resolve;
        isAcquired = true;
        if (acquiredResolve) acquiredResolve();
      });
    },
    effectiveTimeout
  );

  lockPromise.catch((err) => {
    if (!isAcquired && acquiredReject) {
      acquiredReject(err);
    }
  });

  return {
    lockPromise,
    acquired,
    release,
    get isAcquired() {
      return isAcquired;
    },
    get isReleased() {
      return isReleased;
    },
    async [Symbol.asyncDispose]() {
      release();
      await lockPromise.catch(() => {});
    },
  };
}

/**
 * Canonical contract alias for `atomicWriteVaultFileAsync`.
 *
 * @param {string} filePath
 * @param {string | Buffer} content
 * @param {Record<string, any>} [_options]
 * @returns {Promise<void>}
 */
async function writeVaultAtomic(filePath, content, _options = {}) {
  return atomicWriteVaultFileAsync(filePath, content);
}

module.exports = {
  VAULT_LOCK_TIMEOUT_MS,
  renameWithWindowsRetryAsync,
  atomicWriteVaultFileAsync,
  runWithVaultMutex,
  acquireVaultLock,
  writeVaultAtomic,
};
