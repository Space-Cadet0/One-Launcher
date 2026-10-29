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
 * Scrub OAuth/XBL tokens, passwords, exchange codes, SAS/API query secrets, session cookies,
 * 16-digit XUIDs / 17-digit SteamID64s, and OS home directory usernames from any diagnostic text.
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

  return (
    text
      // Xbox Live XBL3.0 x=<uhs>;<jwt> authorization headers/values
      .replace(/\b(XBL3\.0\s+x=)[^\s"',}\]]+/gi, '$1[REDACTED]')
      // Bearer and Basic authorization tokens
      .replace(/\b((?:Bearer|Basic)\s+)[A-Za-z0-9._~+/=-]+/gi, '$1[REDACTED]')
      // CLI password arguments
      .replace(/(-AUTH_PASSWORD\s*=\s*)(?:"[^"]*"|'[^']*'|[^\s"']+)/gi, '$1[REDACTED]')
      // JSON secret properties
      .replace(
        /("(?:access_token|refresh_token|id_token|client_secret|exchangecode|exchange_code|api_key|apikey|webapi_token|sDAToken|xstsToken|xblAccessToken|msaRefreshToken|userStsLegacyTokenXml|storeTicket|password|token|code|sig)"\s*:\s*")[^"]*(")/gi,
        '$1[REDACTED]$2'
      )
      // URL query parameters (including Azure/Store SAS & OAuth & Steam Web API secrets)
      .replace(
        /((?:[?&]|%3[fF]|%26)(?:sig|sv|se|sp|code|token|access_token|refresh_token|client_secret|api_key|apikey|webapi_token|key)(?:=|%3[dD]))(?:(?!&|%26)[^#\s"',}\]])+/gi,
        '$1[REDACTED]'
      )
      // Key=value / header secret assignments
      .replace(
        /\b((?:access_token|refresh_token|id_token|client_secret|exchangecode|exchange_code|api_key|apikey|webapi_token)\s*[=:]\s*)(?:"[^"]*"|'[^']*'|[^\s&"',}\]]+)/gi,
        '$1[REDACTED]'
      )
      // Cookies
      .replace(/\b(Cookie\s*:\s*)[^\r\n]+/gi, '$1[REDACTED]')
      .replace(/\b(Set-Cookie\s*:\s*)[^\r\n]+/gi, '$1[REDACTED]')
      // Explicit XUID / SteamID64 wrappers & fields, plus 16-digit XUID / 17-digit SteamID64 identifiers in URLs/headers
      .replace(/\b(xuid\(\s*)\d{12,20}(\s*\))/gi, '$1[REDACTED]$2')
      .replace(/("(?:xuid|steamId|steamid|steam_id)"\s*:\s*")\d{12,20}(")/gi, '$1[REDACTED]$2')
      .replace(/\b((?:xuid|steamid|steamids|steam_id|x-xbl-xuid)\s*[=:]\s*"?)\d{12,20}("?)/gi, '$1[REDACTED]$2')
      .replace(/(?<!\d)\d{16,17}(?!\d)/g, '[REDACTED]')
      // OS home directory usernames (macOS /Users/<name>/, Linux /home/<name>/, Windows C:\Users\<name>\ & JSON-escaped C:\\Users\\<name>\\ & C:/Users/<name>/)
      .replace(
        /(\/(?:Users|home)\/)(?!\[REDACTED\])([^\s/\\\r\n"':;|<>?*]+(?: [A-Za-z0-9._-]+)?)(\/)/g,
        '$1[REDACTED]$3'
      )
      .replace(
        /(\/(?:Users|home)\/)(?!\[REDACTED\])([^\s/\\\r\n"':;|<>?*]+)(?=$|["'\s,}\]])/g,
        '$1[REDACTED]'
      )
      .replace(
        /([A-Za-z]:\\{1,2}Users\\{1,2})(?!\[REDACTED\])([^\s/\\\r\n"':;|<>?*]+(?: [A-Za-z0-9._-]+)?)(\\{1,2})/gi,
        '$1[REDACTED]$3'
      )
      .replace(
        /([A-Za-z]:\\{1,2}Users\\{1,2})(?!\[REDACTED\])([^\s/\\\r\n"':;|<>?*]+)(?=$|["'\s,}\]])/gi,
        '$1[REDACTED]'
      )
      .replace(
        /([A-Za-z]:\/Users\/)(?!\[REDACTED\])([^\s/\\\r\n"':;|<>?*]+(?: [A-Za-z0-9._-]+)?)(\/)/gi,
        '$1[REDACTED]$3'
      )
      .replace(
        /([A-Za-z]:\/Users\/)(?!\[REDACTED\])([^\s/\\\r\n"':;|<>?*]+)(?=$|["'\s,}\]])/gi,
        '$1[REDACTED]'
      )
  );
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

/**
 * Synchronously write all buffered diagnostic log lines to disk (safe for `will-quit`,
 * `uncaughtException`, and `unhandledRejection` crash/exit handlers).
 */
function flushSync(explicitUserDataDir) {
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  if (pendingLines.length === 0) return false;
  const batch = pendingLines.splice(0, pendingLines.length).join('');
  if (!batch) return false;

  const logPath = getDiagnosticLogPath(explicitUserDataDir);
  const logDir = path.dirname(logPath);

  try {
    fs.mkdirSync(logDir, { recursive: true, mode: 0o700 });
    if (process.platform !== 'win32') {
      try {
        fs.chmodSync(logDir, 0o700);
      } catch {}
    }

    try {
      const st = fs.statSync(logPath);
      if (st && st.size + Buffer.byteLength(batch, 'utf8') > MAX_LOG_FILE_BYTES) {
        const rotatedPath = `${logPath}.1`;
        try {
          fs.rmSync(rotatedPath, { force: true });
        } catch {}
        try {
          fs.renameSync(logPath, rotatedPath);
        } catch {}
        if (process.platform !== 'win32') {
          try {
            fs.chmodSync(rotatedPath, 0o600);
          } catch {}
        }
      }
    } catch {
      // Log file does not exist yet
    }

    fs.appendFileSync(logPath, batch, { encoding: 'utf8', mode: 0o600 });
    if (process.platform !== 'win32') {
      try {
        fs.chmodSync(logPath, 0o600);
      } catch {}
    }
    return true;
  } catch {
    return false;
  }
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
  flushSync,
};

module.exports = {
  diagLog,
  flushSync,
  redactSensitiveDiagnosticText,
  getDiagnosticLogPath,
  setDiagnosticUserDataGetter,
};
