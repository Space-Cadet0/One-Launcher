// @ts-check
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const childProcess = require('node:child_process');
const { execFile } = childProcess;

const { getMainWindow } = require('../engineStateRegistry.cjs');
const { getDiskSpace } = require('../diskAndVolumeInspector.cjs');
const { CLIENT_LOGIN_TARGET_IDS } = require('../policy/environmentCatalog.cjs');

/**
 * @typedef {import('../environmentHealthProber.cjs').EnvironmentComponentId} EnvironmentComponentId
 * @typedef {import('../environmentHealthProber.cjs').ClientLoginTargetId} ClientLoginTargetId
 * @typedef {import('../environmentHealthProber.cjs').NonNativeRunnerType} NonNativeRunnerType
 * @typedef {EnvironmentComponentId | 'runner_crossover_preview_arm64'} ProvisionerComponentId
 * @typedef {NonNativeRunnerType | 'crossover_preview_arm64'} ProvisionerRunnerType
 * @typedef {import('../environmentHealthProber.cjs').StorefrontId} StorefrontId
 * @typedef {import('../environmentHealthProber.cjs').ClientAuthProbeState} ClientAuthProbeState
 * @typedef {import('../environmentHealthProber.cjs').EnvironmentHealthSnapshot} EnvironmentHealthSnapshot
 * @typedef {'queued' | 'probing' | 'downloading' | 'verifying_signature' | 'extracting' | 'installing' | 'configuring_bottle' | 'completed' | 'skipped' | 'failed' | 'cancelled' | 'guided_login_waiting' | 'guided_login_detected'} EnvironmentSetupPhase
 * @typedef {'install_rosetta2' | 'install_win_vcredist' | 'install_runner' | 'ensure_bottle' | 'install_client' | 'sync_first_party_manifests'} EnvironmentSetupAction
 */

/**
 * @typedef {object} EnvironmentSetupTaskRequest
 * @property {EnvironmentSetupAction} action
 * @property {ProvisionerComponentId} componentId
 * @property {ProvisionerRunnerType} [runnerType]
 * @property {'reuse_existing' | 'create_dedicated'} [bottleMode]
 * @property {string} [bottleName]
 * @property {string} [dmgPath]
 * @property {string} [archivePath]
 * @property {boolean} [forceUpdate]
 * @property {string} [downloadUrl]
 */

/**
 * @typedef {'probing' | 'downloading' | 'verifying_signature' | 'extracting' | 'installing' | 'completed' | 'failed' | 'cancelled'} CompatibilityRunnerOperationPhase
 */

/**
 * @typedef {object} CompatibilityRunnerProgressEvent
 * @property {ProvisionerRunnerType} runnerType
 * @property {'install' | 'update'} operation
 * @property {CompatibilityRunnerOperationPhase} phase
 * @property {number | null} progressPercent
 * @property {number} [bytesDownloaded]
 * @property {number} [totalBytes]
 * @property {string} message
 * @property {string} [error]
 * @property {string} [updatedAt]
 */

/**
 * @typedef {object} EnvironmentSetupProgressEvent
 * @property {string} runId
 * @property {ProvisionerComponentId | ClientLoginTargetId} componentId
 * @property {EnvironmentSetupAction} [action]
 * @property {number} stepIndex
 * @property {number} totalSteps
 * @property {EnvironmentSetupPhase} phase
 * @property {number} [progressPercent]
 * @property {number} [bytesDownloaded]
 * @property {number} [totalBytes]
 * @property {string} message
 * @property {string} [error]
 * @property {string} [openedExternalUrl]
 */

/**
 * Pinned HTTPS vendor hosts allowed for automated installer discovery and downloads.
 */
const ALLOWED_INSTALLER_HOSTS = [
  'codeweavers.com',
  'www.codeweavers.com',
  'media.codeweavers.com',
  'cdn.fastly.steamstatic.com',
  'cdn.akamai.steamstatic.com',
  'steamcdn-a.akamaihd.net',
  'www.gog.com',
  'content-system.gog.com',
  'cdn.gog.com',
  'gog-cdn-fastly.gog.com',
  'gog-cdn-lumen.secure2.footprint.net',
  'cdn-hw.gog.com',
  'remote-config.gog.com',
  'api.gog.com',
  'webinstallers.gog-statics.com',
  'launcher-public-service-prod06.ol.epicgames.com',
  'epicgames-download1.akamaized.net',
  'fastly-download.epicgames.com',
  'github.com',
  'objects.githubusercontent.com',
  'release-assets.githubusercontent.com',
  'api.github.com',
  'raw.githubusercontent.com',
  'formulae.brew.sh',
  'dl.winehq.org',
  'aka.ms',
  'download.visualstudio.microsoft.com',
  'ubi.li',
  'static3.cdn.ubi.com',
  'ubistatic3-a.akamaihd.net',
  'origin-a.akamaihd.net',
  'eaassets-a.akamaihd.net',
  'download.dm.origin.com',
  'downloader.battle.net',
  'download.battle.net',
  'us.battle.net',
  'eu.battle.net',
  'kr.battle.net',
  'gamedownloads.rockstargames.com',
  'lol.secure.dyn.riotcdn.net',
  'valorant.secure.dyn.riotcdn.net',
  'riotcdn.net',
];

const ALLOWED_INSTALLER_HOSTS_SET = new Set(ALLOWED_INSTALLER_HOSTS);

/**
 * Strict path-prefix pins for multi-tenant download/API hosts so arbitrary third-party
 * GitHub repos or `aka.ms` shortlinks cannot bypass `validateInstallerUrl`.
 *
 * @type {Readonly<Record<string, readonly string[]>>}
 */
const MULTI_TENANT_HOST_PATH_PREFIXES = Object.freeze({
  'github.com': Object.freeze([
    '/gcenx/macos_wine_builds/',
    '/gcenx/game-porting-toolkit/',
    '/gcenx/homebrew-wine/',
  ]),
  'api.github.com': Object.freeze([
    '/repos/gcenx/macos_wine_builds/',
    '/repos/gcenx/game-porting-toolkit/',
    '/repos/gcenx/homebrew-wine/',
  ]),
  'raw.githubusercontent.com': Object.freeze(['/gcenx/homebrew-wine/']),
  'objects.githubusercontent.com': Object.freeze(['/github-production-release-asset-']),
  'release-assets.githubusercontent.com': Object.freeze(['/github-production-release-asset-']),
  'aka.ms': Object.freeze(['/vs/17/release/']),
});

const MAX_INSTALLER_DOWNLOAD_BYTES = 2 * 1024 * 1024 * 1024; // 2 GiB ceiling
const DOWNLOAD_PROGRESS_THROTTLE_MS = 150;
const DEFAULT_CONNECT_TIMEOUT_MS = 30000;
const DEFAULT_STALL_TIMEOUT_MS = 60000;

/**
 * Pinned CodeWeavers CrossOver Sparkle Ed25519 `SUPublicEDKey` (base64 raw 32-byte public key).
 */
const CODEWEAVERS_SPARKLE_PUBLIC_ED_KEY = 'HtsRMTX0R0Oqe+aWIftCC6Q4Zck7L7n9DpXkbrp7tww=';

/** @type {Record<EnvironmentSetupAction, number>} */
const ACTION_EXECUTION_ORDER = {
  install_rosetta2: 0,
  install_win_vcredist: 0,
  install_runner: 1,
  ensure_bottle: 2,
  install_client: 3,
  sync_first_party_manifests: 4,
};

/** @type {Set<string>} */
const VALID_CLIENT_LOGIN_TARGETS = new Set(CLIENT_LOGIN_TARGET_IDS);

/** @type {Set<(event: EnvironmentSetupProgressEvent) => void>} */
const progressListeners = new Set();

/** @type {Map<string, number>} */
const lastDownloadEmitAtByKey = new Map();

/**
 * Forward `homedir` into helper/detector/client-resolver options ONLY when the caller
 * explicitly provided a non-empty `options.homedir` string. Downstream functions
 * (`detectCompatibilityLayers`, `resolve*ClientBinaryPath`) treat `Boolean(options.homedir)`
 * as the unit-test sandbox isolation flag!
 *
 * @param {Record<string, any>} [options]
 * @returns {{ homedir?: string }}
 */
function explicitHomedirOpt(options = {}) {
  const raw = typeof options?.homedir === 'string' ? options.homedir.trim() : '';
  return raw ? { homedir: raw } : {};
}

/**
 * Subscribe to real-time environment setup & guided login progress events.
 *
 * @param {(event: EnvironmentSetupProgressEvent) => void} listener
 * @returns {() => boolean}
 */
function onEnvironmentSetupProgress(listener) {
  if (typeof listener === 'function') {
    progressListeners.add(listener);
  }
  return () => progressListeners.delete(listener);
}

/**
 * Normalize a requested runner type / compatibility layer string (`'runner_*'` IDs -> canonical
 * runner type; `''`, `'auto'`, `'native'` -> `''` auto-select).
 *
 * @param {unknown} rawRunnerType
 * @returns {string}
 */
function normalizeRequestedRunnerType(rawRunnerType) {
  const s = String(rawRunnerType || '')
    .trim()
    .toLowerCase();
  if (!s || s === 'auto' || s === 'native') return '';
  if (s === 'runner_crossover_preview_arm64' || s === 'crossover_preview_arm64') {
    return 'crossover_preview_arm64';
  }
  if (s === 'runner_crossover_preview' || s === 'crossover_preview') {
    return 'crossover_preview';
  }
  if (s === 'runner_crossover' || s === 'crossover') {
    return 'crossover';
  }
  if (s === 'runner_wine' || s === 'wine') {
    return 'wine';
  }
  if (s === 'runner_gptk' || s === 'gptk') {
    return 'gptk';
  }
  return s.startsWith('runner_') ? s.slice('runner_'.length) : s;
}

/**
 * Resolve canonical CodeWeavers runner bundle metadata (target `.app` name, display label,
 * component ID, and preview branch) so Standard and Arm64 Preview never overwrite each other.
 *
 * @param {string} rawRunnerType
 * @returns {{ runnerType: 'crossover' | 'crossover_preview' | 'crossover_preview_arm64', canonicalAppName: string, displayLabel: string, componentId: ProvisionerComponentId, previewBranch: 'standard' | 'arm64' | null } | null}
 */
function resolveCodeWeaversRunnerSpec(rawRunnerType) {
  switch (normalizeRequestedRunnerType(rawRunnerType)) {
    case 'crossover':
      return {
        runnerType: 'crossover',
        canonicalAppName: 'CrossOver.app',
        displayLabel: 'CrossOver',
        componentId: 'runner_crossover',
        previewBranch: null,
      };
    case 'crossover_preview':
      return {
        runnerType: 'crossover_preview',
        canonicalAppName: 'CrossOver Preview.app',
        displayLabel: 'CrossOver Preview',
        componentId: 'runner_crossover_preview',
        previewBranch: 'standard',
      };
    case 'crossover_preview_arm64':
      return {
        runnerType: 'crossover_preview_arm64',
        canonicalAppName: 'CrossOver Preview arm64.app',
        displayLabel: 'CrossOver Preview (Arm64)',
        componentId: 'runner_crossover_preview_arm64',
        previewBranch: 'arm64',
      };
    default:
      return null;
  }
}

/**
 * Map a `ProvisionerComponentId` to a `ProvisionerRunnerType` when applicable.
 *
 * @param {string} componentId
 * @returns {ProvisionerRunnerType | null}
 */
function componentIdToRunnerType(componentId) {
  switch (String(componentId || '').trim().toLowerCase()) {
    case 'runner_crossover':
      return 'crossover';
    case 'runner_crossover_preview':
      return 'crossover_preview';
    case 'runner_crossover_preview_arm64':
      return 'crossover_preview_arm64';
    case 'runner_wine':
      return 'wine';
    case 'runner_gptk':
      return 'gptk';
    default:
      return null;
  }
}

/**
 * Resolve human-readable runner label for user-facing busy/status messages.
 *
 * @param {string} runnerType
 * @param {any} [existingLayer]
 * @returns {string}
 */
function formatRunnerDisplayLabel(runnerType, existingLayer = null) {
  if (existingLayer && typeof existingLayer.name === 'string' && existingLayer.name.trim()) {
    return existingLayer.name.trim();
  }
  switch (normalizeRequestedRunnerType(runnerType)) {
    case 'crossover':
      return 'CrossOver';
    case 'crossover_preview':
      return 'CrossOver Preview';
    case 'crossover_preview_arm64':
      return 'CrossOver Preview (Arm64)';
    case 'gptk':
      return 'Apple Game Porting Toolkit';
    case 'wine':
      return 'Wine';
    default:
      return 'Compatibility Runner';
  }
}

/**
 * Resolve XNU Darwin kernel major version (`23` = macOS 14 Sonoma, `24` = macOS 15 Sequoia, `25` = macOS 26 Tahoe)
 * with dependency-injected test overrides (`options.darwinKernelMajor`, `options.osRelease`).
 *
 * @param {Record<string, any>} [options]
 * @returns {number}
 */
function resolveDarwinKernelMajor(options = {}) {
  if (
    typeof options.darwinKernelMajor === 'number' &&
    Number.isFinite(options.darwinKernelMajor)
  ) {
    return options.darwinKernelMajor;
  }
  if (typeof options.osRelease === 'string' && options.osRelease.trim()) {
    return Number.parseInt(options.osRelease.trim().split('.')[0] || '0', 10) || 0;
  }
  if (process.platform === 'darwin') {
    return Number.parseInt(String(os.release() || '').split('.')[0] || '0', 10) || 0;
  }
  return 24;
}

/**
 * Emit an environment setup progress event to Node listeners and the active Electron renderer
 * (`'launcher:environment-setup-progress'`), throttling `'downloading'` byte ticks to <= 1 per 150ms.
 * Also forwards normalized `CompatibilityRunnerProgressEvent` payloads to `options.onRunnerProgress`.
 *
 * @param {EnvironmentSetupProgressEvent} event
 * @param {Record<string, any>} [options]
 */
function emitEnvironmentSetupProgress(event, options = {}) {
  if (!event || typeof event !== 'object') return;

  const throttleKey = `${event.runId}:${event.componentId}`;
  if (event.phase === 'downloading' && options.disableProgressThrottle !== true) {
    const isFinalChunk =
      typeof event.bytesDownloaded === 'number' &&
      typeof event.totalBytes === 'number' &&
      event.totalBytes > 0 &&
      event.bytesDownloaded >= event.totalBytes;
    const now = Date.now();
    const prev = lastDownloadEmitAtByKey.get(throttleKey) || 0;
    if (!isFinalChunk && now - prev < DOWNLOAD_PROGRESS_THROTTLE_MS) {
      return;
    }
    lastDownloadEmitAtByKey.set(throttleKey, now);
  } else if (
    event.phase === 'completed' ||
    event.phase === 'failed' ||
    event.phase === 'cancelled' ||
    event.phase === 'skipped'
  ) {
    lastDownloadEmitAtByKey.delete(throttleKey);
  }

  for (const listener of progressListeners) {
    try {
      listener(event);
    } catch {}
  }

  if (typeof options.onRunnerProgress === 'function') {
    const runnerType =
      normalizeRequestedRunnerType(
        options._runnerProgressMeta && options._runnerProgressMeta.runnerType
      ) || componentIdToRunnerType(String(event.componentId || ''));
    const validRunnerPhases = new Set([
      'probing',
      'downloading',
      'verifying_signature',
      'extracting',
      'installing',
      'completed',
      'failed',
      'cancelled',
    ]);
    const mappedPhase = event.phase === 'skipped' ? 'completed' : event.phase;
    if (runnerType && validRunnerPhases.has(mappedPhase)) {
      /** @type {CompatibilityRunnerProgressEvent} */
      const runnerEvent = {
        runnerType: /** @type {ProvisionerRunnerType} */ (runnerType),
        operation:
          options._runnerProgressMeta && options._runnerProgressMeta.operation === 'update'
            ? 'update'
            : 'install',
        phase: /** @type {CompatibilityRunnerOperationPhase} */ (mappedPhase),
        progressPercent:
          typeof event.progressPercent === 'number' ? event.progressPercent : null,
        ...(typeof event.bytesDownloaded === 'number'
          ? { bytesDownloaded: event.bytesDownloaded }
          : {}),
        ...(typeof event.totalBytes === 'number' ? { totalBytes: event.totalBytes } : {}),
        message: String(event.message || ''),
        ...(event.error ? { error: String(event.error) } : {}),
        updatedAt: new Date().toISOString(),
      };
      try {
        options.onRunnerProgress(runnerEvent);
      } catch {}
    }
  }

  if (options._suppressWizardProgressBroadcast === true) {
    return;
  }

  try {
    const win = getMainWindow();
    if (
      win &&
      typeof win.isDestroyed === 'function' &&
      !win.isDestroyed() &&
      win.webContents &&
      (typeof win.webContents.isDestroyed !== 'function' || !win.webContents.isDestroyed())
    ) {
      win.webContents.send('launcher:environment-setup-progress', event);
    }
  } catch {}
}

/**
 * Check whether a hostname is a private, link-local, or unspecified IP literal.
 *
 * @param {string} host
 * @returns {boolean}
 */
function isPrivateOrLinkLocalIp(host) {
  const ipv4Match = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ipv4Match) {
    const [a, b] = [Number(ipv4Match[1]), Number(ipv4Match[2])];
    if (a === 0 || a === 10 || a === 127) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a >= 224) return true;
    return true;
  }
  if (host.includes(':')) {
    return true;
  }
  return false;
}

/**
 * Throw an allowlist / SSRF security error tagged with `INSTALLER_URL_BLOCKED` so multi-tier
 * installer resolvers rethrow immediately instead of falling back on security violations.
 *
 * @param {string} message
 * @returns {never}
 */
function throwBlockedUrlError(message) {
  const err = /** @type {Error & { code?: string }} */ (new Error(message));
  err.code = 'INSTALLER_URL_BLOCKED';
  throw err;
}

/**
 * Determine whether an error represents an intentional abort, SSRF/allowlist violation, or
 * local disk/size guardrail that must rethrow immediately without multi-tier fallback retries.
 *
 * @param {any} err
 * @param {AbortSignal} [signal]
 * @returns {boolean}
 */
function isFatalSecurityOrAbortError(err, signal = undefined) {
  if (signal && signal.aborted) return true;
  if (err && typeof err === 'object') {
    if (err.name === 'AbortError' || err.code === 'INSTALLER_URL_BLOCKED') {
      return true;
    }
  }
  const msg = String(err?.message || err || '');
  return /SSRF policy|Untrusted installer host|Untrusted installer path|Non-HTTPS installer URL blocked|Credentials in installer URL|Insufficient disk space|exceeds maximum allowed size|exceeded maximum allowed size/i.test(
    msg
  );
}

/**
 * Validate an installer or feed URL against strict HTTPS + pinned vendor host allowlisting
 * AND host + path-prefix pinning on multi-tenant hosts (`github.com`, `api.github.com`,
 * `raw.githubusercontent.com`, `objects.githubusercontent.com`, `release-assets.githubusercontent.com`,
 * `aka.ms`).
 * Loopback (`127.0.0.1` / `localhost` / `::1`) is allowed ONLY when `options.allowLoopbackInstallerUrls === true`.
 *
 * @param {string} rawUrl
 * @param {Record<string, any>} [options]
 * @returns {string}
 */
function validateInstallerUrl(rawUrl, options = {}) {
  if (typeof rawUrl !== 'string' || !rawUrl.trim()) {
    throwBlockedUrlError('Installer URL must be a non-empty string.');
  }
  /** @type {URL} */
  let parsed;
  try {
    parsed = new URL(rawUrl.trim());
  } catch {
    throwBlockedUrlError(`Invalid installer URL: ${rawUrl}`);
  }

  if (parsed.username || parsed.password) {
    throwBlockedUrlError(`Credentials in installer URL are forbidden: ${rawUrl}`);
  }

  const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  const isLoopback = host === '127.0.0.1' || host === 'localhost' || host === '::1';

  if (isLoopback) {
    if (
      options.allowLoopbackInstallerUrls === true &&
      (parsed.protocol === 'http:' || parsed.protocol === 'https:')
    ) {
      return parsed.toString();
    }
    throwBlockedUrlError(`Loopback installer URL blocked by SSRF policy: ${rawUrl}`);
  }

  if (isPrivateOrLinkLocalIp(host)) {
    throwBlockedUrlError(`Private or raw IP installer URL blocked by SSRF policy: ${rawUrl}`);
  }

  if (parsed.protocol !== 'https:') {
    throwBlockedUrlError(`Non-HTTPS installer URL blocked (${parsed.protocol}): ${rawUrl}`);
  }

  if (!ALLOWED_INSTALLER_HOSTS_SET.has(host)) {
    throwBlockedUrlError(`Untrusted installer host "${host}" is not on the vendor allowlist.`);
  }

  const allowedPathPrefixes = MULTI_TENANT_HOST_PATH_PREFIXES[host];
  if (Array.isArray(allowedPathPrefixes) && allowedPathPrefixes.length > 0) {
    let decodedPathname = parsed.pathname || '/';
    try {
      decodedPathname = decodeURIComponent(decodedPathname);
    } catch {
      throwBlockedUrlError(`Malformed percent-encoding in installer URL path for host "${host}".`);
    }
    if (decodedPathname.includes('\0') || decodedPathname.includes('\\')) {
      throwBlockedUrlError(`Untrusted installer path on "${host}": invalid path characters.`);
    }
    const rawSegments = decodedPathname.split('/');
    if (rawSegments.some((seg) => seg === '..')) {
      throwBlockedUrlError(`Untrusted installer path on "${host}": path traversal segments are forbidden.`);
    }
    const normalizedPath = path.posix.normalize(decodedPathname).toLowerCase();
    const matchesPrefix = allowedPathPrefixes.some((prefix) => normalizedPath.startsWith(prefix));
    if (!matchesPrefix) {
      throwBlockedUrlError(
        `Untrusted installer path "${parsed.pathname}" on multi-tenant host "${host}" is not pinned to an allowlisted vendor prefix.`
      );
    }
  }

  return parsed.toString();
}

/**
 * Cancellable sleep helper that ALWAYS detaches its `'abort'` listener and calls `.unref()`
 * so tight polling loops never accumulate listeners on long-lived `AbortSignal` instances.
 *
 * @param {number} delayMs
 * @param {AbortSignal} [signal]
 * @returns {Promise<void>}
 */
function cancellableSleep(delayMs, signal = undefined) {
  const safeDelay = Math.max(0, Number(delayMs) || 0);
  if (signal?.aborted) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    let done = false;
    /** @type {ReturnType<typeof setTimeout> | null} */
    let timer = null;
    const finish = () => {
      if (done) return;
      done = true;
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      if (signal && typeof signal.removeEventListener === 'function') {
        try {
          signal.removeEventListener('abort', onAbort);
        } catch {}
      }
      resolve();
    };
    const onAbort = () => {
      finish();
    };
    timer = setTimeout(finish, safeDelay);
    if (timer && typeof timer.unref === 'function') {
      timer.unref();
    }
    if (signal && typeof signal.addEventListener === 'function') {
      if (signal.aborted) {
        finish();
      } else {
        signal.addEventListener('abort', onAbort, { once: true });
      }
    }
  });
}

/**
 * Create a bounded per-operation `AbortController` combining an optional parent `AbortSignal`
 * with a `.unref()`-guarded timeout, returning a `cleanup()` function to detach listeners/timers.
 *
 * @param {AbortSignal | undefined} parentSignal
 * @param {number} timeoutMs
 * @param {string} timeoutMessage
 * @returns {{ signal: AbortSignal, isTimedOut: () => boolean, cleanup: () => void }}
 */
function createBoundedTimeoutSignal(parentSignal, timeoutMs, timeoutMessage) {
  const ctrl = new AbortController();
  let timedOut = false;
  /** @type {ReturnType<typeof setTimeout> | null} */
  let timer = null;

  const onParentAbort = () => {
    if (!ctrl.signal.aborted) {
      const abortErr = new Error('Operation cancelled.');
      abortErr.name = 'AbortError';
      ctrl.abort(abortErr);
    }
  };

  if (parentSignal) {
    if (parentSignal.aborted) {
      onParentAbort();
    } else if (typeof parentSignal.addEventListener === 'function') {
      parentSignal.addEventListener('abort', onParentAbort, { once: true });
    }
  }

  if (Number.isFinite(timeoutMs) && timeoutMs > 0 && !ctrl.signal.aborted) {
    timer = setTimeout(() => {
      timedOut = true;
      const timeoutErr = /** @type {Error & { code?: string }} */ (new Error(timeoutMessage));
      timeoutErr.name = 'TimeoutError';
      timeoutErr.code = 'ETIMEDOUT';
      ctrl.abort(timeoutErr);
    }, timeoutMs);
    if (timer && typeof timer.unref === 'function') {
      timer.unref();
    }
  }

  const cleanup = () => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    if (parentSignal && typeof parentSignal.removeEventListener === 'function') {
      try {
        parentSignal.removeEventListener('abort', onParentAbort);
      } catch {}
    }
  };

  return {
    signal: ctrl.signal,
    isTimedOut: () => timedOut,
    cleanup,
  };
}

/**
 * Perform an allowlist-validated HTTP GET following at most 6 redirects manually so every
 * intermediate `Location` hop is validated against `validateInstallerUrl` BEFORE connecting,
 * with a per-hop connect timeout watchdog.
 *
 * @param {string} initialUrl
 * @param {Record<string, any>} [options]
 * @param {AbortSignal} [signal]
 * @returns {Promise<any>}
 */
async function fetchValidatedResponse(initialUrl, options = {}, signal = undefined) {
  if (options.skipNetwork === true && typeof options.fetchFn !== 'function') {
    throw new Error('Network requests are disabled (skipNetwork: true).');
  }
  const fetchImpl =
    typeof options.fetchFn === 'function' ? options.fetchFn : globalThis.fetch;
  if (typeof fetchImpl !== 'function') {
    throw new Error('Global fetch implementation is unavailable.');
  }

  let currentUrl = validateInstallerUrl(initialUrl, options);
  const maxRedirects = 6;
  const connectTimeoutMs =
    typeof options.connectTimeoutMs === 'number' && Number.isFinite(options.connectTimeoutMs)
      ? Math.max(0, options.connectTimeoutMs)
      : DEFAULT_CONNECT_TIMEOUT_MS;

  for (let hop = 0; hop <= maxRedirects; hop++) {
    if (signal?.aborted) {
      const abortErr = new Error('Operation cancelled.');
      abortErr.name = 'AbortError';
      throw abortErr;
    }

    const callerHeaders =
      options.headers && typeof options.headers === 'object' ? { ...options.headers } : {};
    const callerExplicitUa = callerHeaders['User-Agent'] || callerHeaders['user-agent'];
    const requestHeaders = { ...callerHeaders };
    if (!callerExplicitUa && options.preserveSessionUserAgent !== true) {
      requestHeaders['User-Agent'] = 'OneGameLauncher/1.0';
    }

    const useConnectGuard = connectTimeoutMs > 0 && typeof options.fetchFn !== 'function';
    const hopGuard = useConnectGuard
      ? createBoundedTimeoutSignal(
          signal,
          connectTimeoutMs,
          `Connection timed out after ${connectTimeoutMs}ms fetching ${currentUrl}`
        )
      : null;

    /** @type {any} */
    let res;
    try {
      res = await fetchImpl(currentUrl, {
        redirect: 'manual',
        signal: hopGuard ? hopGuard.signal : signal,
        ...(Object.keys(requestHeaders).length > 0 ? { headers: requestHeaders } : {}),
      });
    } catch (fetchErr) {
      if (hopGuard?.isTimedOut()) {
        const timeoutErr = /** @type {Error & { code?: string }} */ (
          new Error(`Connection timed out after ${connectTimeoutMs}ms fetching ${currentUrl}`)
        );
        timeoutErr.name = 'TimeoutError';
        timeoutErr.code = 'ETIMEDOUT';
        throw timeoutErr;
      }
      throw fetchErr;
    } finally {
      hopGuard?.cleanup();
    }

    if (!res) {
      throw new Error(`Empty response from ${currentUrl}`);
    }

    const status = Number(res.status || (res.ok ? 200 : 0));
    if (status >= 300 && status < 400) {
      if (hop === maxRedirects) {
        throw new Error(`Too many redirects fetching ${initialUrl}`);
      }
      const locHeader =
        typeof res.headers?.get === 'function'
          ? res.headers.get('location')
          : res.headers?.location || res.headers?.Location;
      if (!locHeader) {
        throw new Error(`Redirect (HTTP ${status}) missing Location header from ${currentUrl}`);
      }
      const nextUrl = new URL(String(locHeader), currentUrl).toString();
      currentUrl = validateInstallerUrl(nextUrl, options);
      continue;
    }

    if (typeof res.url === 'string' && res.url.trim()) {
      validateInstallerUrl(res.url.trim(), options);
    }

    if (!res.ok) {
      try {
        await res.body?.cancel?.();
      } catch {}
      throw new Error(`HTTP ${status || 'error'} downloading ${currentUrl}`);
    }

    return res;
  }

  throw new Error(`Redirect loop detected for ${initialUrl}`);
}

/**
 * Fetch UTF-8 text from an allowlisted vendor metadata feed (`cxmac.xml`, `wine-stable.json`, GOG config)
 * with bounded `maxTextBytes` buffering and a per-request metadata timeout.
 *
 * @param {string} url
 * @param {Record<string, any>} [options]
 * @param {AbortSignal} [signal]
 * @returns {Promise<string>}
 */
async function fetchValidatedText(url, options = {}, signal = undefined) {
  const maxTextBytes = Math.max(1024, Number(options.maxTextBytes || 4 * 1024 * 1024));
  const textTimeoutMs = Math.max(1000, Number(options.textFetchTimeoutMs || 15000));
  /** @type {AbortSignal | undefined} */
  let effectiveSignal = signal;
  if (typeof AbortSignal?.timeout === 'function') {
    const timeoutSignal = AbortSignal.timeout(textTimeoutMs);
    effectiveSignal =
      signal && typeof AbortSignal.any === 'function'
        ? AbortSignal.any([signal, timeoutSignal])
        : signal || timeoutSignal;
  }

  const res = await fetchValidatedResponse(url, options, effectiveSignal);
  const rawLen =
    typeof res.headers?.get === 'function'
      ? res.headers.get('content-length')
      : res.headers?.['content-length'] || res.headers?.['Content-Length'];
  const contentLength = rawLen ? Number(rawLen) : NaN;
  if (Number.isFinite(contentLength) && contentLength > maxTextBytes) {
    try {
      await res.body?.cancel?.();
    } catch {}
    throw new Error(`Metadata response from ${url} exceeds ${maxTextBytes} byte text cap.`);
  }

  if (res.body && typeof res.body.getReader === 'function') {
    const reader = res.body.getReader();
    /** @type {Buffer[]} */
    const chunks = [];
    let totalBytes = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) {
          const buf = Buffer.from(value);
          totalBytes += buf.length;
          if (totalBytes > maxTextBytes) {
            try {
              await reader.cancel();
            } catch {}
            throw new Error(
              `Metadata response from ${url} exceeds ${maxTextBytes} byte text cap.`
            );
          }
          chunks.push(buf);
        }
      }
    } finally {
      try {
        reader.releaseLock();
      } catch {}
    }
    return Buffer.concat(chunks, totalBytes).toString('utf8');
  }

  if (typeof res.text === 'function') {
    const text = await res.text();
    if (Buffer.byteLength(text, 'utf8') > maxTextBytes) {
      throw new Error(`Metadata response from ${url} exceeds ${maxTextBytes} byte text cap.`);
    }
    return text;
  }
  if (typeof res.arrayBuffer === 'function') {
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > maxTextBytes) {
      throw new Error(`Metadata response from ${url} exceeds ${maxTextBytes} byte text cap.`);
    }
    return buf.toString('utf8');
  }
  throw new Error(`Unable to read text body from ${url}`);
}

/**
 * Race a single stream chunk read against a per-chunk stall timeout watchdog.
 *
 * @template T
 * @param {Promise<T>} readPromise
 * @param {number} stallTimeoutMs
 * @param {() => void} onStallCancel
 * @param {string} label
 * @returns {Promise<T>}
 */
function readChunkWithStallTimeout(readPromise, stallTimeoutMs, onStallCancel, label) {
  if (!Number.isFinite(stallTimeoutMs) || stallTimeoutMs <= 0) {
    return readPromise;
  }
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        onStallCancel();
      } catch {}
      const stallErr = /** @type {Error & { code?: string }} */ (
        new Error(`Download stalled for ${stallTimeoutMs}ms while downloading ${label}.`)
      );
      stallErr.name = 'TimeoutError';
      stallErr.code = 'ETIMEDOUT';
      reject(stallErr);
    }, stallTimeoutMs);
    if (timer && typeof timer.unref === 'function') {
      timer.unref();
    }

    Promise.resolve(readPromise).then(
      (val) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(val);
      },
      (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(err);
      }
    );
  });
}

/**
 * Stream a verified vendor URL to disk inside an ephemeral directory with disk-space precheck,
 * connect + per-chunk stall timeouts, `AbortController` support, and throttled progress reporting.
 *
 * @param {string} url
 * @param {string} destFilePath
 * @param {{ runId: string, componentId: ProvisionerComponentId, action?: EnvironmentSetupAction, stepIndex: number, totalSteps: number, label: string, minFreeBytes?: number }} ctx
 * @param {Record<string, any>} [options]
 * @param {AbortSignal} [signal]
 * @returns {Promise<{ filePath: string, bytesDownloaded: number }>}
 */
async function streamVerifiedDownloadToFile(
  url,
  destFilePath,
  ctx,
  options = {},
  signal = undefined
) {
  await fs.promises.mkdir(path.dirname(destFilePath), { recursive: true });

  const minFreeBytes = Number(ctx.minFreeBytes || 150 * 1024 * 1024);
  const diskInfo = await getDiskSpace(path.dirname(destFilePath), options);
  if (
    typeof diskInfo.availableBytes === 'number' &&
    Number.isFinite(diskInfo.availableBytes) &&
    diskInfo.availableBytes >= 0 &&
    diskInfo.availableBytes < minFreeBytes
  ) {
    throw new Error(
      `Insufficient disk space (${Math.round(diskInfo.availableBytes / (1024 * 1024))} MB free, need at least ${Math.round(minFreeBytes / (1024 * 1024))} MB).`
    );
  }

  emitEnvironmentSetupProgress(
    {
      runId: ctx.runId,
      componentId: ctx.componentId,
      ...(ctx.action ? { action: ctx.action } : {}),
      stepIndex: ctx.stepIndex,
      totalSteps: ctx.totalSteps,
      phase: 'downloading',
      progressPercent: 0,
      bytesDownloaded: 0,
      message: `Downloading ${ctx.label}...`,
    },
    options
  );

  const res = await fetchValidatedResponse(url, options, signal);
  if (options.rejectHtmlPayload === true) {
    const contentType = String(
      (typeof res.headers?.get === 'function'
        ? res.headers.get('content-type')
        : res.headers?.['content-type'] || res.headers?.['Content-Type']) || ''
    ).toLowerCase();
    if (/text\/html|application\/xhtml\+xml/i.test(contentType)) {
      try {
        await res.body?.cancel?.();
      } catch {}
      const htmlErr = /** @type {Error & { code?: string }} */ (
        new Error('Received HTML response instead of installer archive.')
      );
      htmlErr.code = 'HTML_PAYLOAD_DETECTED';
      throw htmlErr;
    }
  }
  const rawLen =
    typeof res.headers?.get === 'function'
      ? res.headers.get('content-length')
      : res.headers?.['content-length'] || res.headers?.['Content-Length'];
  const totalBytes = rawLen && Number(rawLen) > 0 ? Number(rawLen) : undefined;

  if (totalBytes && totalBytes > MAX_INSTALLER_DOWNLOAD_BYTES) {
    try {
      await res.body?.cancel?.();
    } catch {}
    throw new Error(`Installer exceeds maximum allowed size (${totalBytes} bytes).`);
  }

  const stallTimeoutMs =
    typeof options.stallTimeoutMs === 'number' && Number.isFinite(options.stallTimeoutMs)
      ? Math.max(0, options.stallTimeoutMs)
      : DEFAULT_STALL_TIMEOUT_MS;

  /** @type {fs.promises.FileHandle | null} */
  let fh = null;
  let bytesDownloaded = 0;

  try {
    fh = await fs.promises.open(destFilePath, 'w', 0o600);

    const writeChunk = async (/** @type {Uint8Array | Buffer} */ chunk) => {
      if (signal?.aborted) {
        const abortErr = new Error('Download cancelled.');
        abortErr.name = 'AbortError';
        throw abortErr;
      }
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      if (
        options.rejectHtmlPayload === true &&
        bytesDownloaded === 0 &&
        buf.length > 0 &&
        /^\s*(?:<!doctype\s+html|<html\b|<head\b)/i.test(buf.subarray(0, 512).toString('utf8'))
      ) {
        const htmlErr = /** @type {Error & { code?: string }} */ (
          new Error('Received HTML login/challenge payload instead of installer archive.')
        );
        htmlErr.code = 'HTML_PAYLOAD_DETECTED';
        throw htmlErr;
      }
      bytesDownloaded += buf.length;
      if (bytesDownloaded > MAX_INSTALLER_DOWNLOAD_BYTES) {
        throw new Error('Downloaded payload exceeded maximum allowed size.');
      }
      await /** @type {fs.promises.FileHandle} */ (fh).write(buf);
      const progressPercent =
        totalBytes && totalBytes > 0
          ? Math.min(100, Math.round((bytesDownloaded / totalBytes) * 100))
          : undefined;
      emitEnvironmentSetupProgress(
        {
          runId: ctx.runId,
          componentId: ctx.componentId,
          ...(ctx.action ? { action: ctx.action } : {}),
          stepIndex: ctx.stepIndex,
          totalSteps: ctx.totalSteps,
          phase: 'downloading',
          ...(progressPercent !== undefined ? { progressPercent } : {}),
          bytesDownloaded,
          ...(totalBytes ? { totalBytes } : {}),
          message: `Downloading ${ctx.label}...`,
        },
        options
      );
    };

    if (res.body && typeof res.body.getReader === 'function') {
      const reader = res.body.getReader();
      const cancelReader = () => {
        try {
          if (typeof reader.cancel === 'function') {
            Promise.resolve(reader.cancel()).catch(() => {});
          }
        } catch {}
      };
      if (signal && typeof signal.addEventListener === 'function') {
        if (signal.aborted) {
          cancelReader();
        } else {
          signal.addEventListener('abort', cancelReader, { once: true });
        }
      }
      try {
        while (true) {
          if (signal?.aborted) {
            const abortErr = new Error('Download cancelled.');
            abortErr.name = 'AbortError';
            throw abortErr;
          }
          const { done, value } = await readChunkWithStallTimeout(
            reader.read(),
            stallTimeoutMs,
            cancelReader,
            ctx.label || 'installer'
          );
          if (done) break;
          if (value && value.byteLength > 0) {
            await writeChunk(value);
          }
        }
      } finally {
        if (signal && typeof signal.removeEventListener === 'function') {
          try {
            signal.removeEventListener('abort', cancelReader);
          } catch {}
        }
        try {
          reader.releaseLock();
        } catch {}
      }
    } else if (res.body && Symbol.asyncIterator in Object(res.body)) {
      const iter = res.body[Symbol.asyncIterator]();
      const cancelIter = () => {
        try {
          if (typeof iter.return === 'function') {
            Promise.resolve(iter.return()).catch(() => {});
          }
          if (typeof res.body?.destroy === 'function') {
            res.body.destroy();
          }
        } catch {}
      };
      while (true) {
        if (signal?.aborted) {
          cancelIter();
          const abortErr = new Error('Download cancelled.');
          abortErr.name = 'AbortError';
          throw abortErr;
        }
        const { done, value: chunk } = await readChunkWithStallTimeout(
          iter.next(),
          stallTimeoutMs,
          cancelIter,
          ctx.label || 'installer'
        );
        if (done) break;
        if (chunk) {
          await writeChunk(chunk);
        }
      }
    } else if (typeof res.arrayBuffer === 'function') {
      const ab = await readChunkWithStallTimeout(
        res.arrayBuffer(),
        stallTimeoutMs,
        () => {},
        ctx.label || 'installer'
      );
      await writeChunk(Buffer.from(ab));
    } else {
      throw new Error('Response body is not readable.');
    }

    await fh.close();
    fh = null;
    return { filePath: destFilePath, bytesDownloaded };
  } catch (err) {
    if (fh) {
      try {
        await fh.close();
      } catch {}
      fh = null;
    }
    try {
      await fs.promises.rm(destFilePath, { force: true });
    } catch {}
    throw err;
  }
}

/**
 * Resolve injectable `execFile` implementation.
 *
 * @param {Record<string, any>} options
 * @returns {Function}
 */
function getExecFileFn(options = {}) {
  if (typeof options.execFileImpl === 'function') return options.execFileImpl;
  if (typeof options.execFileFn === 'function') return options.execFileFn;
  return execFile;
}

/**
 * Promisified `execFile` helper with timeout and optional `AbortSignal`.
 *
 * @param {Function} execFileFn
 * @param {string} cmd
 * @param {string[]} args
 * @param {{ timeout?: number, env?: Record<string, any>, windowsHide?: boolean, signal?: AbortSignal }} [execOpts]
 * @returns {Promise<{ stdout: string, stderr: string }>}
 */
function runExecFileAsync(execFileFn, cmd, args, execOpts = {}) {
  return new Promise((resolve, reject) => {
    /** @type {(() => void) | null} */
    let onAbort = null;
    const detachAbortListener = () => {
      if (execOpts.signal && onAbort && typeof execOpts.signal.removeEventListener === 'function') {
        try {
          execOpts.signal.removeEventListener('abort', onAbort);
        } catch {}
      }
      onAbort = null;
    };
    try {
      const child = execFileFn(
        cmd,
        args,
        {
          timeout: execOpts.timeout ?? 120000,
          ...(execOpts.env ? { env: execOpts.env } : {}),
          ...(execOpts.windowsHide !== undefined ? { windowsHide: execOpts.windowsHide } : {}),
          ...(execOpts.signal ? { signal: execOpts.signal } : {}),
        },
        (/** @type {any} */ err, /** @type {any} */ stdout, /** @type {any} */ stderr) => {
          detachAbortListener();
          if (err) {
            err.stdout = String(stdout || '');
            err.stderr = String(stderr || '');
            reject(err);
          } else {
            resolve({
              stdout: String(stdout || ''),
              stderr: String(stderr || ''),
            });
          }
        }
      );
      if (execOpts.signal && child && typeof child.kill === 'function') {
        onAbort = () => {
          try {
            child.kill('SIGTERM');
          } catch {}
        };
        if (execOpts.signal.aborted) onAbort();
        else execOpts.signal.addEventListener('abort', onAbort, { once: true });
      }
    } catch (err) {
      detachAbortListener();
      reject(err);
    }
  });
}

module.exports = {
  ALLOWED_INSTALLER_HOSTS,
  ALLOWED_INSTALLER_HOSTS_SET,
  MULTI_TENANT_HOST_PATH_PREFIXES,
  MAX_INSTALLER_DOWNLOAD_BYTES,
  DOWNLOAD_PROGRESS_THROTTLE_MS,
  DEFAULT_CONNECT_TIMEOUT_MS,
  DEFAULT_STALL_TIMEOUT_MS,
  CODEWEAVERS_SPARKLE_PUBLIC_ED_KEY,
  ACTION_EXECUTION_ORDER,
  VALID_CLIENT_LOGIN_TARGETS,
  explicitHomedirOpt,
  onEnvironmentSetupProgress,
  emitEnvironmentSetupProgress,
  normalizeRequestedRunnerType,
  resolveCodeWeaversRunnerSpec,
  componentIdToRunnerType,
  formatRunnerDisplayLabel,
  resolveDarwinKernelMajor,
  isPrivateOrLinkLocalIp,
  throwBlockedUrlError,
  isFatalSecurityOrAbortError,
  validateInstallerUrl,
  cancellableSleep,
  createBoundedTimeoutSignal,
  fetchValidatedResponse,
  fetchValidatedText,
  streamVerifiedDownloadToFile,
  getExecFileFn,
  runExecFileAsync,
};
