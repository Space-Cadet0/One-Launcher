// @ts-check
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

/** @type {{ getPath?: (name: string) => string } | null} */
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
const MAX_PENDING_ENTRIES = 500;
const MAX_REDACT_INPUT_CHARS = 32 * 1024;
const MAX_SERIALIZE_DEPTH = 6;
const MAX_SERIALIZE_KEYS = 96;
const MAX_SERIALIZE_ARRAY_ITEMS = 64;
const MAX_INITIALIZED_DIRS_CACHE = 32;

const SECRET_FIELD_NAMES_PATTERN = [
  'access_token',
  'accessToken',
  'refresh_token',
  'refreshToken',
  'id_token',
  'idToken',
  'client_secret',
  'clientSecret',
  'exchangecode',
  'exchange_code',
  'exchangeCode',
  'api_key',
  'apikey',
  'apiKey',
  'webapi_token',
  'webApiToken',
  'web_token',
  'webToken',
  'sDAToken',
  'xsts_token',
  'xstsToken',
  'xbl_access_token',
  'xblAccessToken',
  'xbl_user_token',
  'xblUserToken',
  'xsts_xbox_live_token',
  'xstsXboxLiveToken',
  'xsts_mp_token',
  'xstsMpToken',
  'msa_refresh_token',
  'msaRefreshToken',
  'userStsLegacyTokenXml',
  'store_ticket',
  'storeTicket',
  'rps_ticket',
  'rpsTicket',
  'device_key_hex',
  'deviceKeyHex',
  'proof_key',
  'proofKey',
  'uhs',
  'password',
  'passwd',
  'secret',
  'token',
  'code',
  'sig',
].join('|');

const SECRET_KV_NAMES_PATTERN = [
  'access_token',
  'accessToken',
  'refresh_token',
  'refreshToken',
  'id_token',
  'idToken',
  'client_secret',
  'clientSecret',
  'exchangecode',
  'exchange_code',
  'exchangeCode',
  'api_key',
  'apikey',
  'apiKey',
  'webapi_token',
  'webApiToken',
  'web_token',
  'webToken',
  'sDAToken',
  'xsts_token',
  'xstsToken',
  'xbl_access_token',
  'xblAccessToken',
  'msa_refresh_token',
  'msaRefreshToken',
  'store_ticket',
  'storeTicket',
  'rps_ticket',
  'rpsTicket',
  'uhs',
  'password',
  'passwd',
].join('|');

const SECRET_QUERY_PARAMS_PATTERN = [
  'sig',
  'sv',
  'se',
  'sp',
  'code',
  'token',
  'access_token',
  'accessToken',
  'refresh_token',
  'refreshToken',
  'id_token',
  'idToken',
  'client_secret',
  'clientSecret',
  'api_key',
  'apikey',
  'apiKey',
  'webapi_token',
  'webApiToken',
  'web_token',
  'webToken',
  'xsts_token',
  'xstsToken',
  'rps_ticket',
  'rpsTicket',
  'uhs',
  'key',
].join('|');

// Precompiled O(n) redaction regexes (supporting unescaped JSON, escaped JSON \"...\", doubly-escaped \\\"...\\\", and URL-encoded forms)
const RE_XBL_AUTH = /\b(XBL3\.0\s+x=)[^\s"',}\]]+/gi;
const RE_WLID_AUTH = /\b(WLID1\.0\s*=\s*)[^\s"',}\]]+/gi;
const RE_RPS_AUTH = /\b(RPS\s+(?:[dt]=)?)[A-Za-z0-9._~+/%=-]{10,}/gi;
const RE_BEARER_BASIC = /\b((?:Bearer|Basic)\s+)[A-Za-z0-9._~+/=-]+/gi;
const RE_AUTH_PASSWORD_CLI = /(-AUTH_PASSWORD\s*=\s*)(?:"[^"]*"|'[^']*'|[^\s"']+)/gi;
const RE_JSON_SECRET_PROP = new RegExp(
  `((?:\\\\*")(?:${SECRET_FIELD_NAMES_PATTERN})(?:\\\\*")\\s*:\\s*(?:\\\\*"))([^"\\\\]*(?:\\\\(?![\\\\"]*")[^"\\\\]*)*)((?:\\\\*"))`,
  'gi'
);
const RE_URLENCODED_JSON_SECRET_PROP = new RegExp(
  `(%22(?:${SECRET_FIELD_NAMES_PATTERN})%22%3[aA]%22)[^"'\\s&]+(%22)`,
  'gi'
);
const RE_URL_QUERY_SECRET = new RegExp(
  `((?:[?&]|%3[fF]|%26)(?:${SECRET_QUERY_PARAMS_PATTERN})(?:=|%3[dD]))(?:(?!&|%26)[^#\\s"',}\\]])+`,
  'gi'
);
const RE_KV_SECRET = new RegExp(
  `\\b((?:${SECRET_KV_NAMES_PATTERN})\\s*[=:]\\s*)(?:\\\\*"[^"\\\\]*(?:\\\\(?![\\\\"]*")[^"\\\\]*)*\\\\*"|'[^']*'|[^\\s&"',}\\]\\\\]+)`,
  'gi'
);
const RE_COOKIE_HEADER = /\b(Cookie\s*:\s*)[^\r\n]+/gi;
const RE_SET_COOKIE_HEADER = /\b(Set-Cookie\s*:\s*)[^\r\n]+/gi;
const RE_RAW_JWT = /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\b/g;
const RE_EMAIL = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;
const RE_XUID_WRAPPER = /\b(xuid\(\s*)\d{12,20}(\s*\))/gi;
const RE_JSON_ID_PROP =
  /((?:\\*")(?:xuid|steamId|steamid|steam_id)(?:\\*")\s*:\s*(?:\\*"))\d{12,20}((?:\\*"))/gi;
const RE_KV_ID_FIELD =
  /\b((?:xuid|steamid|steamids|steam_id|x-xbl-xuid)\s*[=:]\s*"?)\d{12,20}("?)/gi;
// Scoped bare platform numeric IDs: 17-digit SteamID64 (`7656119...`) and 16-digit Xbox XUID (`253...`)
const RE_BARE_STEAMID64 = /(?<!\d)7656119\d{10}(?!\d)/g;
const RE_BARE_XBOX_XUID = /(?<!\d)253\d{13}(?!\d)/g;
const RE_POSIX_HOME_DIR_MID =
  /(\/(?:Users|home)\/)(?!\[REDACTED\])([^\s/\\\r\n"':;|<>?*]+(?: [A-Za-z0-9._-]+){0,3})(\/)/g;
const RE_POSIX_HOME_DIR_END =
  /(\/(?:Users|home)\/)(?!\[REDACTED\])([^\s/\\\r\n"':;|<>?*]+(?: [A-Za-z0-9._-]+){0,3})(?=$|["'\s,}\]])/g;
const RE_WIN_BS_HOME_DIR_MID =
  /([A-Za-z]:\\{1,2}Users\\{1,2})(?!\[REDACTED\])([^\s/\\\r\n"':;|<>?*]+(?: [A-Za-z0-9._-]+){0,3})(\\{1,2})/gi;
const RE_WIN_BS_HOME_DIR_END =
  /([A-Za-z]:\\{1,2}Users\\{1,2})(?!\[REDACTED\])([^\s/\\\r\n"':;|<>?*]+(?: [A-Za-z0-9._-]+){0,3})(?=$|["'\s,}\]])/gi;
const RE_WIN_FS_HOME_DIR_MID =
  /([A-Za-z]:\/Users\/)(?!\[REDACTED\])([^\s/\\\r\n"':;|<>?*]+(?: [A-Za-z0-9._-]+){0,3})(\/)/gi;
const RE_WIN_FS_HOME_DIR_END =
  /([A-Za-z]:\/Users\/)(?!\[REDACTED\])([^\s/\\\r\n"':;|<>?*]+(?: [A-Za-z0-9._-]+){0,3})(?=$|["'\s,}\]])/gi;

/** @type {(() => string) | null} */
let customUserDataGetter = null;
/** @type {Array<{ line: string, explicitUserDataDir?: string }>} */
let pendingEntries = [];
/** @type {ReturnType<typeof setTimeout> | null} */
let flushTimer = null;
/** @type {Promise<void> | null} */
let activeFlushPromise = null;
/** @type {Set<string>} */
const initializedLogDirs = new Set();

/**
 * @param {(() => string) | null} fn
 */
function setDiagnosticUserDataGetter(fn) {
  if (typeof fn === 'function' || fn === null) {
    customUserDataGetter = fn;
  }
}

/**
 * Bounded, cycle-safe JSON preparation so huge nested metadata objects or binary buffers
 * cannot stall the event loop or blow out log storage prior to redaction.
 *
 * @param {unknown} value
 * @param {number} depth
 * @param {WeakSet<object>} seen
 * @returns {unknown}
 */
function cloneForBoundedLog(value, depth, seen) {
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') {
    return value.length > MAX_REDACT_INPUT_CHARS
      ? `${value.slice(0, MAX_REDACT_INPUT_CHARS)}...[truncated]`
      : value;
  }
  const t = typeof value;
  if (t === 'number' || t === 'boolean') return value;
  if (t === 'bigint') return value.toString();
  if (t === 'symbol' || t === 'function') return `[${t}]`;
  if (Buffer.isBuffer(value)) {
    return `[Buffer length=${value.length}]`;
  }
  if (value instanceof Error) {
    return {
      name: value.name,
      message: value.message,
      code: /** @type {any} */ (value).code,
      stack: value.stack
        ? value.stack.slice(0, 4096)
        : undefined,
    };
  }
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? '[Invalid Date]' : value.toISOString();
  }
  if (depth >= MAX_SERIALIZE_DEPTH) {
    return '[MaxDepth]';
  }
  if (typeof value === 'object') {
    if (seen.has(value)) return '[Circular]';
    seen.add(value);
    try {
      if (Array.isArray(value)) {
        const sliced = value
          .slice(0, MAX_SERIALIZE_ARRAY_ITEMS)
          .map((item) => cloneForBoundedLog(item, depth + 1, seen));
        if (value.length > MAX_SERIALIZE_ARRAY_ITEMS) {
          sliced.push(`...[${value.length - MAX_SERIALIZE_ARRAY_ITEMS} more items]`);
        }
        return sliced;
      }
      /** @type {Record<string, unknown>} */
      const out = {};
      const keys = Object.keys(value);
      const limit = Math.min(keys.length, MAX_SERIALIZE_KEYS);
      for (let i = 0; i < limit; i += 1) {
        const k = keys[i];
        out[k] = cloneForBoundedLog(/** @type {Record<string, unknown>} */ (value)[k], depth + 1, seen);
      }
      if (keys.length > MAX_SERIALIZE_KEYS) {
        out.__truncatedKeys = keys.length - MAX_SERIALIZE_KEYS;
      }
      return out;
    } finally {
      seen.delete(value);
    }
  }
  return String(value);
}

/**
 * @param {unknown} input
 * @returns {string}
 */
function serializeDiagnosticInputBounded(input) {
  if (input === null || input === undefined) return '';
  let text = '';
  if (typeof input === 'string') {
    text = input;
  } else if (input instanceof Error) {
    text = input.stack || input.message || String(input);
  } else {
    try {
      const prepared = cloneForBoundedLog(input, 0, new WeakSet());
      text = JSON.stringify(prepared) ?? String(input);
    } catch {
      text = String(input);
    }
  }
  if (text.length > MAX_REDACT_INPUT_CHARS) {
    return `${text.slice(0, MAX_REDACT_INPUT_CHARS)}...[truncated]`;
  }
  return text;
}

/**
 * Scrub OAuth/XBL/WLID/RPS/JWT tokens, escaped & unescaped JSON secrets, passwords,
 * exchange codes, SAS/API/Steam query secrets, session cookies, emails,
 * SteamID64s / Xbox XUIDs, and OS home directory usernames from any diagnostic text.
 *
 * @param {unknown} input
 * @returns {string}
 */
function redactSensitiveDiagnosticText(input) {
  const text = serializeDiagnosticInputBounded(input);
  if (!text) return '';

  return text
    .replace(RE_XBL_AUTH, '$1[REDACTED]')
    .replace(RE_WLID_AUTH, '$1[REDACTED]')
    .replace(RE_RPS_AUTH, '$1[REDACTED]')
    .replace(RE_BEARER_BASIC, '$1[REDACTED]')
    .replace(RE_AUTH_PASSWORD_CLI, '$1[REDACTED]')
    .replace(RE_JSON_SECRET_PROP, '$1[REDACTED]$3')
    .replace(RE_URLENCODED_JSON_SECRET_PROP, '$1[REDACTED]$2')
    .replace(RE_URL_QUERY_SECRET, '$1[REDACTED]')
    .replace(RE_KV_SECRET, '$1[REDACTED]')
    .replace(RE_COOKIE_HEADER, '$1[REDACTED]')
    .replace(RE_SET_COOKIE_HEADER, '$1[REDACTED]')
    .replace(RE_RAW_JWT, '[REDACTED]')
    .replace(RE_EMAIL, '[REDACTED]')
    .replace(RE_XUID_WRAPPER, '$1[REDACTED]$2')
    .replace(RE_JSON_ID_PROP, '$1[REDACTED]$2')
    .replace(RE_KV_ID_FIELD, '$1[REDACTED]$2')
    .replace(RE_BARE_STEAMID64, '[REDACTED]')
    .replace(RE_BARE_XBOX_XUID, '[REDACTED]')
    .replace(RE_POSIX_HOME_DIR_MID, '$1[REDACTED]$3')
    .replace(RE_POSIX_HOME_DIR_END, '$1[REDACTED]')
    .replace(RE_WIN_BS_HOME_DIR_MID, '$1[REDACTED]$3')
    .replace(RE_WIN_BS_HOME_DIR_END, '$1[REDACTED]')
    .replace(RE_WIN_FS_HOME_DIR_MID, '$1[REDACTED]$3')
    .replace(RE_WIN_FS_HOME_DIR_END, '$1[REDACTED]');
}

/**
 * @param {string} [explicitUserDataDir]
 * @returns {string}
 */
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

/**
 * @param {string} [explicitUserDataDir]
 * @returns {string}
 */
function getDiagnosticLogPath(explicitUserDataDir) {
  const baseDir = resolveBaseUserDataDir(explicitUserDataDir);
  return path.join(baseDir, 'logs', 'one-launcher.log');
}

/**
 * @param {Record<string, any>} [options]
 * @returns {boolean}
 */
function isQuietTestEnv(options = {}) {
  if (options && options.forceWrite === true) return false;
  if (process.env.ONE_LAUNCHER_DEBUG === '1') return false;
  return Boolean(process.env.VITEST || process.env.NODE_ENV === 'test');
}

/**
 * @param {string} logDir
 */
function rememberInitializedLogDir(logDir) {
  if (initializedLogDirs.size >= MAX_INITIALIZED_DIRS_CACHE && !initializedLogDirs.has(logDir)) {
    const oldest = initializedLogDirs.values().next().value;
    if (oldest !== undefined) initializedLogDirs.delete(oldest);
  }
  initializedLogDirs.add(logDir);
}

/**
 * Group entries by resolved log file path so concurrent callers with distinct `explicitUserDataDir`
 * values never overwrite or lose each other's log destination.
 *
 * @param {Array<{ line: string, explicitUserDataDir?: string }>} entries
 * @param {string} [fallbackUserDataDir]
 * @returns {Map<string, string>}
 */
function groupBatchesByLogPath(entries, fallbackUserDataDir) {
  /** @type {Map<string, string[]>} */
  const grouped = new Map();
  for (const item of entries) {
    const targetPath = getDiagnosticLogPath(item.explicitUserDataDir || fallbackUserDataDir);
    let list = grouped.get(targetPath);
    if (!list) {
      list = [];
      grouped.set(targetPath, list);
    }
    list.push(item.line);
  }
  /** @type {Map<string, string>} */
  const merged = new Map();
  for (const [logPath, lines] of grouped.entries()) {
    const batch = lines.join('');
    if (batch) merged.set(logPath, batch);
  }
  return merged;
}

/**
 * @param {string} [explicitUserDataDir]
 */
async function flushBufferToDisk(explicitUserDataDir) {
  if (pendingEntries.length === 0) return;
  const taken = pendingEntries.splice(0, pendingEntries.length);
  const batchesByPath = groupBatchesByLogPath(taken, explicitUserDataDir);

  for (const [logPath, batch] of batchesByPath.entries()) {
    const logDir = path.dirname(logPath);
    try {
      if (!initializedLogDirs.has(logDir)) {
        await fs.promises.mkdir(logDir, { recursive: true, mode: 0o700 });
        if (process.platform !== 'win32') {
          await fs.promises.chmod(logDir, 0o700).catch(() => {});
        }
        rememberInitializedLogDir(logDir);
      }

      let fileExisted = false;
      try {
        const st = await fs.promises.stat(logPath);
        fileExisted = true;
        if (st && st.size + Buffer.byteLength(batch, 'utf8') > MAX_LOG_FILE_BYTES) {
          const rotatedPath = `${logPath}.1`;
          await fs.promises.rm(rotatedPath, { force: true }).catch(() => {});
          await fs.promises.rename(logPath, rotatedPath).catch(() => {});
          if (process.platform !== 'win32') {
            await fs.promises.chmod(rotatedPath, 0o600).catch(() => {});
          }
          fileExisted = false;
        }
      } catch {
        // Log file does not exist yet
      }

      /** @type {fs.promises.FileHandle | null} */
      let fh = null;
      try {
        try {
          fh = await fs.promises.open(logPath, 'a', 0o600);
        } catch (openErr) {
          if (/** @type {any} */ (openErr)?.code === 'ENOENT') {
            await fs.promises.mkdir(logDir, { recursive: true, mode: 0o700 });
            rememberInitializedLogDir(logDir);
            fh = await fs.promises.open(logPath, 'a', 0o600);
          } else {
            throw openErr;
          }
        }
        await fh.writeFile(batch, 'utf8');
      } finally {
        if (fh) {
          await fh.close().catch(() => {});
        }
      }

      if (!fileExisted && process.platform !== 'win32') {
        await fs.promises.chmod(logPath, 0o600).catch(() => {});
      }
    } catch {
      // Diagnostic logger must never crash host process on unwritable disk
    }
  }
}

/**
 * @param {string} [explicitUserDataDir]
 */
function scheduleFlush(explicitUserDataDir) {
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    const prev = activeFlushPromise || Promise.resolve();
    activeFlushPromise = prev
      .then(() => flushBufferToDisk(explicitUserDataDir))
      .finally(() => {
        if (pendingEntries.length > 0) {
          scheduleFlush(undefined);
        }
      });
  }, FLUSH_DEBOUNCE_MS);
  if (typeof flushTimer.unref === 'function') {
    flushTimer.unref();
  }
}

/**
 * @param {unknown} errOrMsg
 * @returns {string}
 */
function extractBenignCode(errOrMsg) {
  if (
    errOrMsg &&
    typeof errOrMsg === 'object' &&
    typeof /** @type {any} */ (errOrMsg).code === 'string'
  ) {
    return /** @type {any} */ (errOrMsg).code.toUpperCase();
  }
  return '';
}

/**
 * @param {'DEBUG' | 'INFO' | 'WARN' | 'ERROR'} level
 * @param {string} scope
 * @param {unknown} errOrMsg
 * @param {unknown} [meta]
 * @param {Record<string, any>} [options]
 */
function writeEntry(level, scope, errOrMsg, meta, options = {}) {
  const errCode = extractBenignCode(errOrMsg);
  const effectiveLevel =
    (level === 'WARN' || level === 'ERROR') && (errCode === 'ENOENT' || errCode === 'ESRCH')
      ? 'DEBUG'
      : level;

  if (
    effectiveLevel === 'DEBUG' &&
    process.env.ONE_LAUNCHER_DEBUG !== '1' &&
    !options?.forceWrite
  ) {
    return;
  }
  if (isQuietTestEnv(options)) {
    return;
  }

  const ts = new Date().toISOString();
  const safeScope = redactSensitiveDiagnosticText(scope || 'engine');
  const safeMsg = redactSensitiveDiagnosticText(errOrMsg);
  const safeMeta = meta !== undefined ? ` | ${redactSensitiveDiagnosticText(meta)}` : '';
  const line = `[${ts}] [${effectiveLevel}] [${safeScope}] ${safeMsg}${safeMeta}\n`;

  const explicitUserDataDir =
    typeof options?.userDataDir === 'string' && options.userDataDir.trim()
      ? options.userDataDir.trim()
      : undefined;

  pendingEntries.push({ line, explicitUserDataDir });
  if (pendingEntries.length > MAX_PENDING_ENTRIES) {
    pendingEntries.splice(0, pendingEntries.length - MAX_PENDING_ENTRIES);
  }
  scheduleFlush(explicitUserDataDir);
}

/**
 * Synchronously write all buffered diagnostic log lines to disk (safe for `will-quit`,
 * `uncaughtException`, and `unhandledRejection` crash/exit handlers).
 *
 * @param {string} [explicitUserDataDir]
 * @returns {boolean}
 */
function flushSync(explicitUserDataDir) {
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  if (pendingEntries.length === 0) return false;
  const taken = pendingEntries.splice(0, pendingEntries.length);
  const batchesByPath = groupBatchesByLogPath(taken, explicitUserDataDir);
  if (batchesByPath.size === 0) return false;

  let wroteAny = false;
  for (const [logPath, batch] of batchesByPath.entries()) {
    const logDir = path.dirname(logPath);
    try {
      fs.mkdirSync(logDir, { recursive: true, mode: 0o700 });
      if (process.platform !== 'win32') {
        try {
          fs.chmodSync(logDir, 0o700);
        } catch {}
      }
      rememberInitializedLogDir(logDir);

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
      wroteAny = true;
    } catch {
      // Diagnostic logger must never throw in crash/exit handlers
    }
  }
  return wroteAny;
}

const diagLog = {
  /**
   * @param {string} scope
   * @param {unknown} errOrMsg
   * @param {unknown} [meta]
   * @param {Record<string, any>} [options]
   */
  debug(scope, errOrMsg, meta, options) {
    writeEntry('DEBUG', scope, errOrMsg, meta, options);
  },
  /**
   * @param {string} scope
   * @param {unknown} errOrMsg
   * @param {unknown} [meta]
   * @param {Record<string, any>} [options]
   */
  info(scope, errOrMsg, meta, options) {
    writeEntry('INFO', scope, errOrMsg, meta, options);
  },
  /**
   * @param {string} scope
   * @param {unknown} errOrMsg
   * @param {unknown} [meta]
   * @param {Record<string, any>} [options]
   */
  warn(scope, errOrMsg, meta, options) {
    writeEntry('WARN', scope, errOrMsg, meta, options);
  },
  /**
   * @param {string} scope
   * @param {unknown} errOrMsg
   * @param {unknown} [meta]
   * @param {Record<string, any>} [options]
   */
  error(scope, errOrMsg, meta, options) {
    writeEntry('ERROR', scope, errOrMsg, meta, options);
  },
  /**
   * @param {string} [explicitUserDataDir]
   * @returns {Promise<void>}
   */
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
