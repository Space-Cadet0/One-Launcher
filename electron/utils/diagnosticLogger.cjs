'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

let electronApp = null;
try {
  const reqElectron = require('electron');
  if (reqElectron && typeof reqElectron === 'object' && reqElectron.app) {
    electronApp = reqElectron.app;
  }
} catch {
  // Running in pure Node / test context without Electron runtime
}

const MAX_LOG_FILE_BYTES = 5 * 1024 * 1024; // 5 MB x 2 (.log + .log.1)
const FLUSH_DEBOUNCE_MS = 120;

let customUserDataGetter = null;
let pendingLines = [];
let flushTimer = null;
let activeFlushPromise = null;

function setDiagnosticUserDataGetter(fn) {
  if (typeof fn === 'function' || fn === null) {
    customUserDataGetter = fn;
  }
}

/**
 * Scrub OAuth tokens, passwords, exchange codes, and session cookies from any diagnostic text.
 */
function redactSensitiveDiagnosticText(input) {
  if (input === null || input === undefined) return '';
  let text = '';
  if (typeof input === 'string') {
    text = input;
  } else if (input instanceof Error) {
    text = input.stack || input.message || String(input);
  } else {
    try {
      text = JSON.stringify(input);
    } catch {
      text = String(input);
    }
  }

  return text
    .replace(/\b(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi, '$1[REDACTED]')
    .replace(/(-AUTH_PASSWORD\s*=\s*)(?:"[^"]*"|'[^']*'|[^\s"']+)/gi, '$1[REDACTED]')
    .replace(
      /("(?:access_token|refresh_token|id_token|client_secret|exchangecode|exchange_code)"\s*:\s*")[^"]*(")/gi,
      '$1[REDACTED]$2'
    )
    .replace(
      /\b((?:access_token|refresh_token|id_token|client_secret|exchangecode|exchange_code)\s*[=:]\s*)(?:"[^"]*"|'[^']*'|[^\s&"',}\]]+)/gi,
      '$1[REDACTED]'
    )
    .replace(/\b(Cookie\s*:\s*)[^\r\n]+/gi, '$1[REDACTED]')
    .replace(/\b(Set-Cookie\s*:\s*)[^\r\n]+/gi, '$1[REDACTED]');
}

function resolveBaseUserDataDir(explicitUserDataDir) {
  if (typeof explicitUserDataDir === 'string' && explicitUserDataDir.trim()) {
    return explicitUserDataDir.trim();
  }
  if (typeof customUserDataGetter === 'function') {
    try {
      const resolved = customUserDataGetter();
      if (typeof resolved === 'string' && resolved.trim()) {
        return resolved.trim();
      }
    } catch {
      // Fallback below
    }
  }
  if (process.env.VITEST || process.env.NODE_ENV === 'test') {
    return path.join(os.tmpdir(), `one-launcher-test-logs-${process.pid}`);
  }
  try {
    if (electronApp && typeof electronApp.getPath === 'function') {
      const p = electronApp.getPath('userData');
      if (p) return p;
    }
  } catch {
    // Fallback when Electron app path is not yet initialized
  }
  return path.join(os.homedir(), '.one-launcher');
}

function getDiagnosticLogPath(explicitUserDataDir) {
  const baseDir = resolveBaseUserDataDir(explicitUserDataDir);
  return path.join(baseDir, 'logs', 'one-launcher.log');
}

function isQuietTestEnv(options = {}) {
  if (options && options.forceWrite === true) return false;
  if (process.env.ONE_LAUNCHER_DEBUG === '1') return false;
  return Boolean(process.env.VITEST || process.env.NODE_ENV === 'test');
}

async function flushBufferToDisk(explicitUserDataDir) {
  if (pendingLines.length === 0) return;
  const batch = pendingLines.splice(0, pendingLines.length).join('');
  if (!batch) return;

  const logPath = getDiagnosticLogPath(explicitUserDataDir);
  const logDir = path.dirname(logPath);

  try {
    await fs.promises.mkdir(logDir, { recursive: true, mode: 0o700 });
    if (process.platform !== 'win32') {
      await fs.promises.chmod(logDir, 0o700).catch(() => {});
    }

    try {
      const st = await fs.promises.stat(logPath);
      if (st && st.size + Buffer.byteLength(batch, 'utf8') > MAX_LOG_FILE_BYTES) {
        const rotatedPath = `${logPath}.1`;
        await fs.promises.rm(rotatedPath, { force: true }).catch(() => {});
        await fs.promises.rename(logPath, rotatedPath).catch(() => {});
        if (process.platform !== 'win32') {
          await fs.promises.chmod(rotatedPath, 0o600).catch(() => {});
        }
      }
    } catch {
      // Log file does not exist yet
    }

    let fh = null;
    try {
      fh = await fs.promises.open(logPath, 'a', 0o600);
      await fh.writeFile(batch, 'utf8');
    } finally {
      if (fh) {
        await fh.close().catch(() => {});
      }
    }

    if (process.platform !== 'win32') {
      await fs.promises.chmod(logPath, 0o600).catch(() => {});
    }
  } catch {
    // Diagnostic logger must never crash host process on unwritable disk
  }
}

function scheduleFlush(explicitUserDataDir) {
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    const prev = activeFlushPromise || Promise.resolve();
    activeFlushPromise = prev
      .then(() => flushBufferToDisk(explicitUserDataDir))
      .finally(() => {
        if (pendingLines.length > 0) {
          scheduleFlush(explicitUserDataDir);
        }
      });
  }, FLUSH_DEBOUNCE_MS);
  if (typeof flushTimer.unref === 'function') {
    flushTimer.unref();
  }
}

function extractBenignCode(errOrMsg) {
  if (errOrMsg && typeof errOrMsg === 'object' && typeof errOrMsg.code === 'string') {
    return errOrMsg.code.toUpperCase();
  }
  return '';
}

function writeEntry(level, scope, errOrMsg, meta, options = {}) {
  const errCode = extractBenignCode(errOrMsg);
  const effectiveLevel =
    (level === 'WARN' || level === 'ERROR') && (errCode === 'ENOENT' || errCode === 'ESRCH')
      ? 'DEBUG'
      : level;

  if (effectiveLevel === 'DEBUG' && process.env.ONE_LAUNCHER_DEBUG !== '1' && !options?.forceWrite) {
    return;
  }
  if (isQuietTestEnv(options)) {
    return;
  }

  const ts = new Date().toISOString();
  const safeScope = redactSensitiveDiagnosticText(scope || 'engine');
  const safeMsg = redactSensitiveDiagnosticText(errOrMsg);
  const safeMeta =
    meta !== undefined ? ` | ${redactSensitiveDiagnosticText(meta)}` : '';
  const line = `[${ts}] [${effectiveLevel}] [${safeScope}] ${safeMsg}${safeMeta}\n`;

  pendingLines.push(line);
  if (pendingLines.length > 500) {
    pendingLines.splice(0, pendingLines.length - 500);
  }
  scheduleFlush(options?.userDataDir);
}

const diagLog = {
  debug(scope, errOrMsg, meta, options) {
    writeEntry('DEBUG', scope, errOrMsg, meta, options);
  },
  info(scope, errOrMsg, meta, options) {
    writeEntry('INFO', scope, errOrMsg, meta, options);
  },
  warn(scope, errOrMsg, meta, options) {
    writeEntry('WARN', scope, errOrMsg, meta, options);
  },
  error(scope, errOrMsg, meta, options) {
    writeEntry('ERROR', scope, errOrMsg, meta, options);
  },
  async flush(explicitUserDataDir) {
    if (flushTimer) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
    const prev = activeFlushPromise || Promise.resolve();
    activeFlushPromise = prev.then(() => flushBufferToDisk(explicitUserDataDir));
    await activeFlushPromise;
  },
};

module.exports = {
  diagLog,
  redactSensitiveDiagnosticText,
  getDiagnosticLogPath,
  setDiagnosticUserDataGetter,
};
