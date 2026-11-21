// @ts-check
'use strict';

const path = require('node:path');
const { diagLog } = require('../../utils/diagnosticLogger.cjs');

/**
 * Resolve and validate `process.env.ELECTRON_START_URL` strictly for unpackaged development mode.
 * Returns `null` unconditionally when `isPackaged === true` so production builds can NEVER
 * load a local TCP dev server (`http://localhost:3000`).
 *
 * @param {unknown} rawEnvUrl
 * @param {boolean} [isPackaged]
 * @returns {string | null}
 */
function resolveTrustedDevStartUrl(rawEnvUrl, isPackaged = false) {
  if (isPackaged) return null;
  if (typeof rawEnvUrl !== 'string') return null;
  const trimmed = rawEnvUrl.trim();
  if (!trimmed || trimmed === '0' || trimmed.toLowerCase() === 'false') return null;
  if (trimmed === '1' || trimmed.toLowerCase() === 'true') {
    return 'http://localhost:3000';
  }
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    if (parsed.username || parsed.password) return null;
    const host = String(parsed.hostname || '')
      .replace(/^\[|\]$/g, '')
      .toLowerCase();
    if (host === 'localhost' || host === '127.0.0.1' || host === '::1') {
      return parsed.toString();
    }
  } catch {
    return null;
  }
  return null;
}

/**
 * Decode a `file://` URL pathname iteratively (catching single- and double-encoded `%2e%2e` /
 * `%252e%252e` traversal and `%5c` Windows backslash traversal), normalize via `path.posix.normalize`,
 * and canonicalize Windows drive letters fail-closed.
 *
 * @param {string} rawPathname
 * @returns {string | null}
 */
function decodeAndNormalizeFileUrlPathname(rawPathname) {
  if (typeof rawPathname !== 'string' || !rawPathname) return null;
  if (/[\x00-\x1f\x7f]/.test(rawPathname) || /%00/i.test(rawPathname)) {
    return null;
  }

  let decoded = rawPathname;
  for (let pass = 0; pass < 3; pass += 1) {
    let next;
    try {
      next = decodeURIComponent(decoded);
    } catch {
      return null;
    }
    if (/[\x00-\x1f\x7f]/.test(next)) {
      return null;
    }
    if (next === decoded) {
      break;
    }
    decoded = next;
    if (pass === 2) {
      try {
        if (decodeURIComponent(decoded) !== decoded) {
          // Reject excessively nested multi-encoding smuggling (4+ layers)
          return null;
        }
      } catch {
        return null;
      }
    }
  }

  let posixPath = decoded.replace(/\\/g, '/');
  if (/^[A-Za-z]:\//.test(posixPath)) {
    posixPath = `/${posixPath}`;
  }
  if (!posixPath.startsWith('/')) {
    return null;
  }
  // Reject ANY traversal segment (`..`) present after decoding BEFORE `path.posix.normalize` collapses it
  // (catches `%2e%2e`, `%252e%252e`, `%5c..`, etc. even when called without `expectedFileHref`)
  if (/(?:^|\/)\.\.(?:\/|$)/.test(posixPath)) {
    return null;
  }

  const normalized = path.posix.normalize(posixPath);
  if (!normalized.startsWith('/') || /(?:^|\/)\.\.(?:\/|$)/.test(normalized)) {
    return null;
  }

  return normalized.toLowerCase();
}

/**
 * Determine whether `rawUrl` is a trusted One Launcher top-level renderer URL (`file://` app bundle
 * or validated loopback dev server when unpackaged).
 *
 * @param {unknown} rawUrl
 * @param {{ isPackaged?: boolean, allowedDevOrigin?: string | null, expectedFileHref?: string | null }} [options]
 * @returns {boolean}
 */
function isTrustedAppRendererUrl(rawUrl, options = {}) {
  if (typeof rawUrl !== 'string' || !rawUrl.trim()) return false;
  const trimmed = rawUrl.trim();
  if (/[\x00-\x1f\x7f]/.test(trimmed)) return false;

  let parsed;
  try {
    parsed = new URL(trimmed);
  } catch {
    return false;
  }

  if (parsed.protocol === 'file:') {
    const fileHost = String(parsed.hostname || '').toLowerCase();
    if (fileHost && fileHost !== 'localhost') {
      return false;
    }
    const normActual = decodeAndNormalizeFileUrlPathname(parsed.pathname);
    if (!normActual) {
      return false;
    }
    if (typeof options.expectedFileHref === 'string' && options.expectedFileHref.trim()) {
      try {
        const expected = new URL(options.expectedFileHref.trim());
        if (expected.protocol !== 'file:') {
          return false;
        }
        const normExpected = decodeAndNormalizeFileUrlPathname(expected.pathname);
        if (!normExpected) {
          return false;
        }
        const expectedDir = path.posix.dirname(normExpected);
        const dirPrefix = expectedDir === '/' ? '/' : `${expectedDir}/`;
        return normActual === normExpected || normActual.startsWith(dirPrefix);
      } catch {
        return false;
      }
    }
    return true;
  }

  const isPackaged = Boolean(options.isPackaged);
  if (isPackaged) {
    return false;
  }

  if (typeof options.allowedDevOrigin === 'string' && options.allowedDevOrigin.trim()) {
    try {
      const allowedOrigin = new URL(options.allowedDevOrigin.trim()).origin;
      return parsed.origin === allowedOrigin;
    } catch {
      return false;
    }
  }

  if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
    const host = String(parsed.hostname || '')
      .replace(/^\[|\]$/g, '')
      .toLowerCase();
    if (host === 'localhost' || host === '127.0.0.1' || host === '::1') {
      return true;
    }
  }

  return false;
}

/**
 * Verify that an Electron `IpcMainInvokeEvent` / `IpcMainEvent` originates from the trusted
 * top-level app frame (`event.senderFrame === event.sender.mainFrame` + trusted app URL).
 *
 * Fails CLOSED when `event.senderFrame === null` (detached/destroyed Electron subframe) AND
 * fails CLOSED whenever `senderFrame` is missing outside unit-test (`VITEST` / `NODE_ENV=test`)
 * runtimes. Lightweight unit-test mock events (`{}` or `{ sender: mockWc }` with `senderFrame === undefined`)
 * remain supported strictly inside test runtimes unless `options.strictSenderFrame === true`.
 *
 * @param {any} event
 * @param {{
 *   isPackaged?: boolean,
 *   allowedDevOrigin?: string | null,
 *   expectedFileHref?: string | null,
 *   getMainWindow?: (() => any) | null,
 *   strictSenderFrame?: boolean,
 * }} [options]
 * @returns {boolean}
 */
function isTrustedIpcSenderEvent(event, options = {}) {
  const isTestRuntime = Boolean(process.env.VITEST || process.env.NODE_ENV === 'test');

  if (!event || event.senderFrame === undefined || event.senderFrame === null) {
    // Explicit `senderFrame === null` (Electron's value for detached/destroyed frames) MUST ALWAYS fail closed!
    if (event && event.senderFrame === null) {
      return false;
    }
    // Outside test runtimes (packaged or unpackaged production Electron), missing senderFrame MUST fail closed!
    if (!isTestRuntime || options.strictSenderFrame === true) {
      return false;
    }
    // Inside Vitest/test runtimes only, allow lightweight mock events (`{}` or `{ sender }`) where `senderFrame` is omitted
    return true;
  }

  const senderFrame = event.senderFrame;
  const sender = event.sender;

  // Reject any non-top-level subframe (`<iframe>` such as embedded video players)
  if (sender && sender.mainFrame && senderFrame !== sender.mainFrame) {
    return false;
  }
  if (typeof senderFrame.parent === 'object' && senderFrame.parent !== null) {
    return false;
  }
  if (typeof senderFrame.routingId === 'number' && sender?.mainFrame?.routingId !== undefined) {
    if (senderFrame.routingId !== sender.mainFrame.routingId) {
      return false;
    }
  }

  // If `getMainWindow` is provided and alive, reject unrelated BrowserWindows
  if (typeof options.getMainWindow === 'function') {
    try {
      const mw = options.getMainWindow();
      if (
        mw &&
        typeof mw.isDestroyed === 'function' &&
        !mw.isDestroyed() &&
        mw.webContents &&
        sender &&
        typeof sender.id === 'number' &&
        typeof mw.webContents.id === 'number' &&
        sender.id !== mw.webContents.id
      ) {
        return false;
      }
    } catch {
      return false;
    }
  }

  const frameUrl = typeof senderFrame.url === 'string' ? senderFrame.url : '';
  return isTrustedAppRendererUrl(frameUrl, options);
}

/**
 * Throw a structured `ERR_UNTRUSTED_IPC_SENDER` error if `event` originates from an untrusted
 * frame, subframe, or origin.
 *
 * @param {any} event
 * @param {{
 *   isPackaged?: boolean,
 *   allowedDevOrigin?: string | null,
 *   expectedFileHref?: string | null,
 *   getMainWindow?: (() => any) | null,
 *   strictSenderFrame?: boolean,
 *   channel?: string,
 * }} [options]
 */
function assertTrustedIpcSender(event, options = {}) {
  if (!isTrustedIpcSenderEvent(event, options)) {
    const frameUrl =
      event?.senderFrame && typeof event.senderFrame.url === 'string'
        ? event.senderFrame.url
        : '<unknown>';
    diagLog.warn('security.untrustedIpcSender', null, {
      channel: options.channel || '<unspecified>',
      frameUrl,
    });
    const err = /** @type {Error & { code?: string }} */ (
      new Error(`Blocked IPC invocation from untrusted sender frame (${options.channel || 'ipc'})`)
    );
    err.code = 'ERR_UNTRUSTED_IPC_SENDER';
    throw err;
  }
}

/**
 * Wrap an `ipcMain` instance so every `handle(channel, listener)` registration enforces
 * `assertTrustedIpcSender(event)` before invoking `listener`, while preserving all other
 * `ipcMain` methods (`on`, `removeListener`, `removeHandler`) with intact `this` binding.
 *
 * @param {any} ipcMain
 * @param {{
 *   isPackaged?: boolean,
 *   allowedDevOrigin?: string | null,
 *   expectedFileHref?: string | null,
 *   getMainWindow?: (() => any) | null,
 *   strictSenderFrame?: boolean,
 * }} [options]
 */
function wrapIpcMainWithSenderCheck(ipcMain, options = {}) {
  if (!ipcMain || typeof ipcMain.handle !== 'function') return ipcMain;
  if (ipcMain.__isIpcSenderCheckWrapped) return ipcMain;
  return new Proxy(ipcMain, {
    get(target, prop, receiver) {
      if (prop === '__isIpcSenderCheckWrapped') return true;
      if (prop === 'handle' || prop === 'handleOnce') {
        return (/** @type {string} */ channel, /** @type {Function} */ listener) => {
          if (typeof target[prop] !== 'function') {
            return undefined;
          }
          return target[prop](channel, (/** @type {any} */ event, ...args) => {
            assertTrustedIpcSender(event, { ...options, channel });
            return listener(event, ...args);
          });
        };
      }
      const value = Reflect.get(target, prop, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

module.exports = {
  resolveTrustedDevStartUrl,
  isTrustedAppRendererUrl,
  isTrustedIpcSenderEvent,
  assertTrustedIpcSender,
  wrapIpcMainWithSenderCheck,
};
