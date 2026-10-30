// @ts-check
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const childProcess = require('node:child_process');
const { execFile, spawn } = childProcess;

const { diagLog } = require('../utils/diagnosticLogger.cjs');
const {
  getMainWindow,
  isTestEnvironment,
  resolveIsolatedHomedirAndUserData,
  invalidateScanCaches,
  openExternalUri,
  clearMacQuarantineAsync,
  safeIsBottleSlug,
} = require('./engineStateRegistry.cjs');
const {
  resolveBottleSteamExe,
  sandboxWinePrefixUserFoldersAsync,
} = require('./wineAndCrossOverManager.cjs');
const {
  ensureMacExecutablePermissions,
  resolveTargetMacAppBundlePath,
  isValidBottleDirectory,
  detectCompatibilityLayers,
  shutdownWinePrefix,
  resolveBottleGogGalaxyExe,
  resolveBottleEpicLauncherExe,
  ensureCompatibilityLayerReady,
} = require('./macNativeInstallerAndCodesign.cjs');
const {
  inspectWindowsExecutableHeader,
} = require('./binaryAndManifestInspectors.cjs');
const {
  getDiskSpace,
} = require('./diskAndVolumeInspector.cjs');
const {
  syncGogFirstPartyLauncher,
  resolveGogGalaxyClientBinaryPath,
} = require('./gogRegistryAndDirectInstaller.cjs');
const {
  syncEpicFirstPartyLauncher,
  resolveEpicClientBinaryPath,
} = require('./epicLegendaryAndEosCoordinator.cjs');
const {
  resolveSteamClientBinaryPath,
} = require('./sessionAndProcessSupervisor.cjs');
const {
  getSetupWizardState,
  saveSetupWizardState,
  probeClientLoginStates,
  probeEnvironmentHealth,
} = require('./environmentHealthProber.cjs');

/**
 * @typedef {import('./environmentHealthProber.cjs').EnvironmentComponentId} EnvironmentComponentId
 * @typedef {import('./environmentHealthProber.cjs').ClientLoginTargetId} ClientLoginTargetId
 * @typedef {import('./environmentHealthProber.cjs').NonNativeRunnerType} NonNativeRunnerType
 * @typedef {import('./environmentHealthProber.cjs').StorefrontId} StorefrontId
 * @typedef {import('./environmentHealthProber.cjs').ClientAuthProbeState} ClientAuthProbeState
 * @typedef {import('./environmentHealthProber.cjs').EnvironmentHealthSnapshot} EnvironmentHealthSnapshot
 * @typedef {'queued' | 'probing' | 'downloading' | 'verifying_signature' | 'extracting' | 'installing' | 'configuring_bottle' | 'completed' | 'skipped' | 'failed' | 'cancelled' | 'guided_login_waiting' | 'guided_login_detected'} EnvironmentSetupPhase
 * @typedef {'install_rosetta2' | 'install_win_vcredist' | 'install_runner' | 'ensure_bottle' | 'install_client' | 'sync_first_party_manifests'} EnvironmentSetupAction
 */

/**
 * @typedef {object} EnvironmentSetupTaskRequest
 * @property {EnvironmentSetupAction} action
 * @property {EnvironmentComponentId} componentId
 * @property {NonNativeRunnerType} [runnerType]
 * @property {'reuse_existing' | 'create_dedicated'} [bottleMode]
 * @property {string} [bottleName]
 * @property {string} [dmgPath]
 */

/**
 * @typedef {object} RunEnvironmentSetupRequest
 * @property {string} [runId]
 * @property {EnvironmentSetupTaskRequest[]} tasks
 * @property {StorefrontId[]} [connectedStorefronts]
 */

/**
 * @typedef {object} EnvironmentSetupProgressEvent
 * @property {string} runId
 * @property {EnvironmentComponentId | ClientLoginTargetId} componentId
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
 * @typedef {object} EnvironmentSetupTaskOutcome
 * @property {EnvironmentComponentId} componentId
 * @property {EnvironmentSetupAction} action
 * @property {'completed' | 'skipped' | 'failed' | 'cancelled' | 'opened_external'} status
 * @property {string} message
 * @property {string} [error]
 * @property {string} [installedPath]
 * @property {string} [openedExternalUrl]
 */

/**
 * @typedef {object} RunEnvironmentSetupResult
 * @property {boolean} success
 * @property {string} runId
 * @property {boolean} [cancelled]
 * @property {EnvironmentSetupTaskOutcome[]} outcomes
 * @property {EnvironmentHealthSnapshot} snapshot
 * @property {string} [error]
 */

/**
 * @typedef {object} StartGuidedClientLoginRequest
 * @property {ClientLoginTargetId} targetId
 * @property {NonNativeRunnerType} [runnerType]
 * @property {string} [bottleName]
 * @property {boolean} [autoCloseOnSuccess]
 * @property {boolean} [forceInteractiveLogin]
 * @property {number} [timeoutMs]
 */

/**
 * @typedef {object} GuidedClientLoginResult
 * @property {boolean} success
 * @property {ClientLoginTargetId} targetId
 * @property {boolean} authenticated
 * @property {boolean} [cancelled]
 * @property {boolean} [timedOut]
 * @property {boolean} [autoClosedClient]
 * @property {ClientAuthProbeState} probeState
 * @property {string} message
 * @property {string} [error]
 */

/**
 * Pinned HTTPS vendor hosts allowed for automated installer discovery and downloads.
 */
const ALLOWED_INSTALLER_HOSTS = [
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
  'formulae.brew.sh',
  'dl.winehq.org',
  'aka.ms',
  'download.visualstudio.microsoft.com',
];

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

const ALLOWED_INSTALLER_HOSTS_SET = new Set(ALLOWED_INSTALLER_HOSTS);

const MAX_INSTALLER_DOWNLOAD_BYTES = 2 * 1024 * 1024 * 1024; // 2 GiB ceiling
const DOWNLOAD_PROGRESS_THROTTLE_MS = 200;

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
const VALID_CLIENT_LOGIN_TARGETS = new Set([
  'host_steam',
  'bottle_steam',
  'host_gog',
  'bottle_gog',
  'host_epic',
  'bottle_epic',
]);

/** @type {Set<(event: EnvironmentSetupProgressEvent) => void>} */
const progressListeners = new Set();

/** @type {Map<string, number>} */
const lastDownloadEmitAtByKey = new Map();

/** @type {Map<string, AbortController>} */
const activeSetupRuns = new Map();

/** @type {Map<string, { abortController: AbortController, runId: string }>} */
const activeGuidedLogins = new Map();

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
 * Emit an environment setup progress event to Node listeners and the active Electron renderer
 * (`'launcher:environment-setup-progress'`), throttling `'downloading'` byte ticks to <= 1 per 200ms.
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
    return true; // Reject raw IPv4 literals unless loopback test override handled earlier
  }
  if (host.includes(':')) {
    return true; // Reject raw IPv6 literals unless loopback test override handled earlier
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
  return /SSRF policy|Untrusted installer host|Non-HTTPS installer URL blocked|Credentials in installer URL|Insufficient disk space|exceeds maximum allowed size|exceeded maximum allowed size/i.test(
    msg
  );
}

/**
 * Validate an installer or feed URL against strict HTTPS + pinned vendor host allowlisting.
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

  return parsed.toString();
}

/**
 * Perform an allowlist-validated HTTP GET following at most 6 redirects manually so every
 * intermediate `Location` hop is validated against `validateInstallerUrl` BEFORE connecting.
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

  for (let hop = 0; hop <= maxRedirects; hop++) {
    if (signal?.aborted) {
      const abortErr = new Error('Operation cancelled.');
      abortErr.name = 'AbortError';
      throw abortErr;
    }

    const res = await fetchImpl(currentUrl, {
      redirect: 'manual',
      signal,
      headers: {
        'User-Agent': 'OneGameLauncher/1.0',
      },
    });

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
 * Stream a verified vendor URL to disk inside an ephemeral directory with disk-space precheck,
 * `AbortController` support, and throttled progress reporting.
 *
 * @param {string} url
 * @param {string} destFilePath
 * @param {{ runId: string, componentId: EnvironmentComponentId, stepIndex: number, totalSteps: number, label: string, minFreeBytes?: number }} ctx
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
    diskInfo.availableBytes > 0 &&
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
  const rawLen =
    typeof res.headers?.get === 'function'
      ? res.headers.get('content-length')
      : res.headers?.['content-length'] || res.headers?.['Content-Length'];
  const totalBytes = rawLen && Number(rawLen) > 0 ? Number(rawLen) : undefined;

  if (totalBytes && totalBytes > MAX_INSTALLER_DOWNLOAD_BYTES) {
    throw new Error(`Installer exceeds maximum allowed size (${totalBytes} bytes).`);
  }

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
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (value && value.byteLength > 0) {
            await writeChunk(value);
          }
        }
      } finally {
        try {
          reader.releaseLock();
        } catch {}
      }
    } else if (res.body && Symbol.asyncIterator in Object(res.body)) {
      for await (const chunk of res.body) {
        if (chunk) {
          await writeChunk(chunk);
        }
      }
    } else if (typeof res.arrayBuffer === 'function') {
      const ab = await res.arrayBuffer();
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
 * Pure Node Buffer inspection of PE32 / PE32+ `OptionalHeader.DataDirectory[4]`
 * (`IMAGE_DIRECTORY_ENTRY_SECURITY`) verifying an embedded Authenticode `WIN_CERTIFICATE`
 * PKCS#7 SignedData block exists inside a Windows `.exe` installer.
 *
 * @param {string} filePath
 * @returns {boolean}
 */
function hasEmbeddedPeAuthenticodeCertificate(filePath) {
  /** @type {number | null} */
  let fd = null;
  try {
    fd = fs.openSync(filePath, 'r');
    const st = fs.fstatSync(fd);
    if (!st.isFile() || st.size < 256) return false;

    const dosBuf = Buffer.alloc(64);
    if (fs.readSync(fd, dosBuf, 0, 64, 0) < 64) return false;
    if (dosBuf[0] !== 0x4d || dosBuf[1] !== 0x5a) return false; // 'MZ'

    const peOffset = dosBuf.readUInt32LE(0x3c);
    if (peOffset < 0x40 || peOffset + 200 > st.size) return false;

    const hdrReadLen = Math.min(320, st.size - peOffset);
    const peBuf = Buffer.alloc(hdrReadLen);
    if (fs.readSync(fd, peBuf, 0, hdrReadLen, peOffset) < 160) return false;

    // 'PE\0\0'
    if (
      peBuf[0] !== 0x50 ||
      peBuf[1] !== 0x45 ||
      peBuf[2] !== 0x00 ||
      peBuf[3] !== 0x00
    ) {
      return false;
    }

    const sizeOfOptionalHeader = peBuf.readUInt16LE(20);
    if (sizeOfOptionalHeader < 128) return false;

    const optOffset = 24;
    const magic = peBuf.readUInt16LE(optOffset);
    let numRvaOffset = 0;
    let secDirOffset = 0;

    if (magic === 0x010b) {
      // PE32 (32-bit)
      numRvaOffset = optOffset + 92;
      secDirOffset = optOffset + 96 + 4 * 8; // DataDirectory[4] = optOffset + 128
    } else if (magic === 0x020b) {
      // PE32+ (64-bit)
      numRvaOffset = optOffset + 108;
      secDirOffset = optOffset + 112 + 4 * 8; // DataDirectory[4] = optOffset + 144
    } else {
      return false;
    }

    if (secDirOffset + 8 > peBuf.length) return false;
    const numberOfRvaAndSizes = peBuf.readUInt32LE(numRvaOffset);
    if (numberOfRvaAndSizes < 5) return false;

    const certFileOffset = peBuf.readUInt32LE(secDirOffset);
    const certTableSize = peBuf.readUInt32LE(secDirOffset + 4);
    if (
      certFileOffset === 0 ||
      certTableSize < 8 ||
      certFileOffset + certTableSize > st.size
    ) {
      return false;
    }

    // Verify WIN_CERTIFICATE header at certFileOffset
    const winCertHdr = Buffer.alloc(8);
    if (fs.readSync(fd, winCertHdr, 0, 8, certFileOffset) < 8) return false;
    const dwLength = winCertHdr.readUInt32LE(0);
    const wRevision = winCertHdr.readUInt16LE(4);
    const wCertificateType = winCertHdr.readUInt16LE(6);

    if (dwLength < 8 || dwLength > certTableSize) return false;
    if (wRevision !== 0x0100 && wRevision !== 0x0200) return false;
    if (wCertificateType !== 0x0002) return false; // WIN_CERT_TYPE_PKCS_SIGNED_DATA

    return true;
  } catch {
    return false;
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {}
    }
  }
}

const MSI_DIGITAL_SIGNATURE_UTF16LE = Buffer.from('\x05DigitalSignature', 'utf16le');

/**
 * Check whether an `.msi` file starts with the 8-byte OLE2 Compound File Binary magic header
 * (`D0 CF 11 E0 A1 B1 1A E1`).
 *
 * @param {string} filePath
 * @returns {boolean}
 */
function hasValidMsiCompoundHeader(filePath) {
  /** @type {number | null} */
  let fd = null;
  try {
    fd = fs.openSync(filePath, 'r');
    const magic = Buffer.alloc(8);
    if (fs.readSync(fd, magic, 0, 8, 0) < 8) return false;
    return (
      magic[0] === 0xd0 &&
      magic[1] === 0xcf &&
      magic[2] === 0x11 &&
      magic[3] === 0xe0 &&
      magic[4] === 0xa1 &&
      magic[5] === 0xb1 &&
      magic[6] === 0x1a &&
      magic[7] === 0xe1
    );
  } catch {
    return false;
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {}
    }
  }
}

/**
 * Check whether an OLE2 `.msi` file contains an embedded UTF-16LE `\x05DigitalSignature`
 * Authenticode directory entry stream (`Buffer.from('\x05DigitalSignature', 'utf16le')`).
 * Uses bounded 1 MiB chunk reads with a 64-byte overlap window.
 *
 * @param {string} filePath
 * @returns {boolean}
 */
function hasMsiDigitalSignatureStream(filePath) {
  /** @type {number | null} */
  let fd = null;
  try {
    fd = fs.openSync(filePath, 'r');
    const st = fs.fstatSync(fd);
    if (!st.isFile() || st.size < MSI_DIGITAL_SIGNATURE_UTF16LE.length) return false;

    const chunkSize = 1024 * 1024;
    const overlapLen = 64;
    const readBuf = Buffer.allocUnsafe(chunkSize);
    /** @type {Buffer} */
    let tail = Buffer.alloc(0);
    let offset = 0;

    while (offset < st.size) {
      const toRead = Math.min(chunkSize, st.size - offset);
      const bytesRead = fs.readSync(fd, readBuf, 0, toRead, offset);
      if (bytesRead <= 0) break;

      const slice = readBuf.subarray(0, bytesRead);
      const windowBuf = tail.length > 0 ? Buffer.concat([tail, slice]) : slice;
      if (windowBuf.indexOf(MSI_DIGITAL_SIGNATURE_UTF16LE) !== -1) {
        return true;
      }

      tail =
        windowBuf.length > overlapLen
          ? Buffer.from(windowBuf.subarray(windowBuf.length - overlapLen))
          : Buffer.from(windowBuf);
      offset += bytesRead;
    }
    return false;
  } catch {
    return false;
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {}
    }
  }
}

/**
 * Stream-verify a downloaded file's cryptographic SHA-256 digest against `expectedSha256`.
 * Immediately unlinks `filePath` and throws on mismatch.
 *
 * @param {string} filePath
 * @param {string} expectedSha256
 * @returns {Promise<void>}
 */
async function verifyFileSha256Async(filePath, expectedSha256) {
  const cleanExpected = String(expectedSha256 || '')
    .trim()
    .toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(cleanExpected)) {
    throw new Error(`Invalid expected SHA-256 digest format: "${expectedSha256}"`);
  }

  const actualHex = await new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const rs = fs.createReadStream(filePath);
    rs.on('error', reject);
    rs.on('data', (chunk) => hash.update(chunk));
    rs.on('end', () => resolve(hash.digest('hex').toLowerCase()));
  });

  if (actualHex !== cleanExpected) {
    try {
      await fs.promises.rm(filePath, { force: true });
    } catch {}
    throw new Error(
      `SHA-256 digest mismatch for ${path.basename(filePath)}: expected ${cleanExpected}, got ${actualHex}.`
    );
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
        const onAbort = () => {
          try {
            child.kill('SIGTERM');
          } catch {}
        };
        if (execOpts.signal.aborted) onAbort();
        else execOpts.signal.addEventListener('abort', onAbort, { once: true });
      }
    } catch (err) {
      reject(err);
    }
  });
}

/**
 * Verify a macOS `.app` bundle's Apple Developer ID signature (`codesign --verify --deep --strict`
 * + `codesign -dv --verbose=4` `TeamIdentifier` / `Authority` check).
 * Immediately deletes `stagedAppPath` (unless `options.keepOnFailure === true`, e.g., read-only DMG mount) and throws on failure.
 *
 * @param {string} appPath
 * @param {string[]} [expectedTeamIds]
 * @param {Record<string, any>} [options]
 * @returns {Promise<{ verified: boolean, teamIdentifier: string | null }>}
 */
async function verifyMacAppDeveloperSignature(
  appPath,
  expectedTeamIds = [],
  options = {}
) {
  const purgeIfStaged = async () => {
    if (options.keepOnFailure === true) return;
    try {
      await fs.promises.rm(appPath, { recursive: true, force: true });
    } catch {}
  };

  if (typeof options.verifySignatureFn === 'function') {
    try {
      const customRes = await options.verifySignatureFn(
        {
          artifactPath: appPath,
          kind: 'app',
          expectedTeamIds,
          componentId: options._componentId,
        },
        options
      );
      if (
        customRes === false ||
        (customRes && typeof customRes === 'object' && customRes.valid === false)
      ) {
        throw new Error(
          (customRes && typeof customRes === 'object' && customRes.error) ||
            `Developer ID signature verification failed for ${path.basename(appPath)}.`
        );
      }
      return {
        verified: true,
        teamIdentifier:
          (customRes && typeof customRes === 'object' && customRes.teamIdentifier) || null,
      };
    } catch (err) {
      await purgeIfStaged();
      throw err;
    }
  }

  const execFileFn = getExecFileFn(options);
  try {
    await runExecFileAsync(
      execFileFn,
      '/usr/bin/codesign',
      ['--verify', '--deep', '--strict', appPath],
      { timeout: 60000 }
    );
    const dvRes = await runExecFileAsync(
      execFileFn,
      '/usr/bin/codesign',
      ['-dv', '--verbose=4', appPath],
      { timeout: 30000 }
    );
    const combined = `${dvRes.stdout}\n${dvRes.stderr}`;

    if (/code object is not signed/i.test(combined)) {
      throw new Error(`Rejected unsigned bundle: ${path.basename(appPath)}`);
    }

    const isAdhocSigned = /\bSignature=adhoc\b/i.test(combined);
    const allowAdhocForOpenSource =
      options.allowAdhocSignature === true &&
      (!Array.isArray(expectedTeamIds) || expectedTeamIds.length === 0);

    if (isAdhocSigned) {
      if (allowAdhocForOpenSource) {
        return { verified: true, teamIdentifier: null };
      }
      throw new Error(`Rejected unsigned or ad-hoc signed bundle: ${path.basename(appPath)}`);
    }

    const authorities = Array.from(combined.matchAll(/^Authority=([^\r\n]+)$/gm)).map((m) =>
      m[1].trim()
    );
    const isAppleSystemSigned = authorities.some((auth) =>
      /^(?:Software Signing|macOS Software Signing)\b/i.test(auth)
    );
    const hasDeveloperAuthority =
      isAppleSystemSigned ||
      authorities.some((auth) =>
        /^(?:Developer ID Application|Apple Distribution)\b/i.test(auth)
      );
    if (!hasDeveloperAuthority) {
      throw new Error(
        `Rejected bundle without Apple Developer ID certificate authority: ${path.basename(appPath)}`
      );
    }

    const teamMatch = combined.match(/^TeamIdentifier=([^\r\n]+)$/m);
    const teamId = teamMatch ? teamMatch[1].trim() : '';
    const hasValidTeamId = Boolean(
      teamId && teamId.toLowerCase() !== 'not set' && /^[A-Z0-9]{10}$/.test(teamId)
    );
    if (!hasValidTeamId && !isAppleSystemSigned) {
      throw new Error(
        `Rejected bundle missing valid Apple Developer TeamIdentifier (${teamId || 'none'}): ${path.basename(appPath)}`
      );
    }

    if (Array.isArray(expectedTeamIds) && expectedTeamIds.length > 0) {
      const teamMatched = hasValidTeamId && expectedTeamIds.includes(teamId);
      const vendorAuthMatched =
        options.expectedVendorAuthorityPattern instanceof RegExp &&
        authorities.some((auth) => options.expectedVendorAuthorityPattern.test(auth));
      if (!teamMatched && !vendorAuthMatched) {
        throw new Error(
          `TeamIdentifier mismatch on ${path.basename(appPath)}: got ${teamId || 'not set'}, expected ${expectedTeamIds.join(' or ')}.`
        );
      }
    }

    return { verified: true, teamIdentifier: hasValidTeamId ? teamId : null };
  } catch (err) {
    await purgeIfStaged();
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Code signature verification failed for ${path.basename(appPath)}: ${msg}`);
  }
}

/**
 * Verify a macOS `.pkg` installer signature via `/usr/sbin/pkgutil --check-signature`.
 * Immediately unlinks `pkgPath` on failure.
 *
 * @param {string} pkgPath
 * @param {Record<string, any>} [options]
 * @returns {Promise<{ verified: boolean }>}
 */
async function verifyMacPkgSignature(pkgPath, options = {}) {
  const purgePkg = async () => {
    try {
      await fs.promises.rm(pkgPath, { force: true });
    } catch {}
  };

  if (typeof options.verifySignatureFn === 'function') {
    try {
      const customRes = await options.verifySignatureFn(
        {
          artifactPath: pkgPath,
          kind: 'pkg',
          expectedTeamIds: [],
          componentId: options._componentId,
        },
        options
      );
      if (
        customRes === false ||
        (customRes && typeof customRes === 'object' && customRes.valid === false)
      ) {
        throw new Error(
          (customRes && typeof customRes === 'object' && customRes.error) ||
            `Package signature verification failed for ${path.basename(pkgPath)}.`
        );
      }
      return { verified: true };
    } catch (err) {
      await purgePkg();
      throw err;
    }
  }

  const execFileFn = getExecFileFn(options);
  try {
    const res = await runExecFileAsync(
      execFileFn,
      '/usr/sbin/pkgutil',
      ['--check-signature', pkgPath],
      { timeout: 30000 }
    );
    const combined = `${res.stdout}\n${res.stderr}`;
    const validPkgStatus =
      /Status:\s*signed by a (?:developer )?certificate issued by Apple for distribution/i.test(
        combined
      );
    if (!validPkgStatus) {
      throw new Error(`pkgutil reported untrusted signature status for ${path.basename(pkgPath)}`);
    }
    return { verified: true };
  } catch (err) {
    await purgePkg();
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Package signature verification failed for ${path.basename(pkgPath)}: ${msg}`);
  }
}

/**
 * Verify a Windows `.exe` or `.msi` installer BEFORE execution:
 * - On `win32` host: runs PowerShell `Get-AuthenticodeSignature -LiteralPath $env:OL_VERIFY_PATH` requiring `'Valid'`.
 * - On `darwin` (for bottle installation): verifies plausible file size (`> 500 KB`), valid PE header +
 *   embedded Authenticode `WIN_CERTIFICATE` PKCS#7 Security Directory (`DataDirectory[4]`) for `.exe`,
 *   or OLE2 Compound Document magic (`D0 CF 11 E0`) for `.msi`.
 * Immediately unlinks `filePath` on failure.
 *
 * @param {string} filePath
 * @param {Record<string, any>} [options]
 * @returns {Promise<{ verified: boolean }>}
 */
async function verifyWindowsInstallerSignature(filePath, options = {}) {
  const purgeFile = async () => {
    try {
      await fs.promises.rm(filePath, { force: true });
    } catch {}
  };

  const kind = String(options.kind || path.extname(filePath))
    .toLowerCase()
    .replace(/^\./, '');

  if (typeof options.verifySignatureFn === 'function') {
    try {
      const customRes = await options.verifySignatureFn(
        {
          artifactPath: filePath,
          kind: kind || 'exe',
          expectedTeamIds: [],
          componentId: options._componentId,
        },
        options
      );
      if (
        customRes === false ||
        (customRes && typeof customRes === 'object' && customRes.valid === false)
      ) {
        throw new Error(
          (customRes && typeof customRes === 'object' && customRes.error) ||
            `Authenticode verification failed for ${path.basename(filePath)}.`
        );
      }
      return { verified: true };
    } catch (err) {
      await purgeFile();
      throw err;
    }
  }

  try {
    const st = await fs.promises.stat(filePath);
    const minBytes =
      typeof options.minInstallerBytes === 'number' ? options.minInstallerBytes : 500 * 1024;
    if (!st.isFile() || st.size < minBytes) {
      throw new Error(
        `Installer size (${st.size} bytes) is below minimum required threshold (${minBytes} bytes).`
      );
    }

    const hostPlatform = String(options.platform || process.platform).toLowerCase();
    if (hostPlatform === 'win32') {
      const execFileFn = getExecFileFn(options);
      const psRes = await runExecFileAsync(
        execFileFn,
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          '(Get-AuthenticodeSignature -LiteralPath $env:OL_VERIFY_PATH).Status',
        ],
        {
          timeout: 30000,
          windowsHide: true,
          env: {
            ...process.env,
            OL_VERIFY_PATH: filePath,
          },
        }
      );
      const statusText = psRes.stdout.trim();
      if (statusText !== 'Valid') {
        throw new Error(
          `Authenticode signature status is "${statusText || 'Unknown'}" (expected "Valid").`
        );
      }
      return { verified: true };
    }

    if (kind === 'msi') {
      if (!hasValidMsiCompoundHeader(filePath)) {
        throw new Error('Invalid MSI Compound Document header magic.');
      }
      if (!hasMsiDigitalSignatureStream(filePath)) {
        throw new Error(
          'MSI package is missing an embedded Authenticode DigitalSignature stream.'
        );
      }
      return { verified: true };
    }

    const peHeader = inspectWindowsExecutableHeader(filePath, { strictPe: true });
    if (!peHeader.isValidPe) {
      throw new Error('File does not have a valid Windows PE executable header.');
    }
    if (!hasEmbeddedPeAuthenticodeCertificate(filePath)) {
      throw new Error('PE executable is missing an embedded Authenticode WIN_CERTIFICATE signature.');
    }
    return { verified: true };
  } catch (err) {
    await purgeFile();
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(
      `Windows installer verification failed for ${path.basename(filePath)}: ${msg}`
    );
  }
}

/**
 * Resolve writable target macOS Applications directory (`'/Applications'` when writable,
 * else `'~/Applications'`, or `options.customApplicationsDir`).
 *
 * @param {string} homedir
 * @param {Record<string, any>} options
 * @returns {Promise<string>}
 */
async function resolveTargetMacApplicationsDir(homedir, options = {}) {
  if (typeof options.customApplicationsDir === 'string' && options.customApplicationsDir.trim()) {
    return options.customApplicationsDir.trim();
  }
  if (typeof options.hasWriteAccessToSystemApplications === 'boolean') {
    return options.hasWriteAccessToSystemApplications
      ? '/Applications'
      : path.join(homedir, 'Applications');
  }
  if (options.homedir) {
    return path.join(homedir, 'Applications');
  }
  try {
    await fs.promises.access('/Applications', fs.constants.W_OK);
    return '/Applications';
  } catch {
    return path.join(homedir, 'Applications');
  }
}

/**
 * Copy a verified `.app` bundle into `targetDestDir` preserving `.framework` symlinks via `/usr/bin/ditto`
 * (with `fs.promises.cp` fallback in hermetic test mocks) and clear macOS quarantine attributes.
 *
 * @param {string} srcApp
 * @param {string} targetDestDir
 * @param {Record<string, any>} [options]
 * @returns {Promise<string>}
 */
async function copyVerifiedMacAppToApplicationsDir(srcApp, targetDestDir, options = {}) {
  await fs.promises.mkdir(targetDestDir, { recursive: true });
  const appName = path.basename(srcApp);
  const destApp = path.join(targetDestDir, appName);

  if (typeof options.onExecDitto === 'function') {
    await options.onExecDitto(srcApp, destApp);
  } else {
    const execFileFn = getExecFileFn(options);
    const canUseDitto =
      process.platform === 'darwin' ||
      typeof options.execFileFn === 'function' ||
      typeof options.execFileImpl === 'function';
    if (canUseDitto) {
      await runExecFileAsync(execFileFn, '/usr/bin/ditto', [srcApp, destApp], {
        timeout: 300000,
      });
    }
    if (fs.existsSync(srcApp) && !fs.existsSync(destApp)) {
      await fs.promises.cp(srcApp, destApp, {
        recursive: true,
        force: true,
        verbatimSymlinks: true,
      });
    }
  }

  ensureMacExecutablePermissions(destApp);
  await clearMacQuarantineAsync(destApp, { ...options, force: true });
  return destApp;
}

/**
 * Mount a `.dmg` read-only, verify the contained `.app` Developer ID signature BEFORE copying
 * anything to `targetDestDir`, copy via `ditto`, clear quarantine, and ALWAYS detach in `finally`.
 *
 * @param {string} dmgPath
 * @param {string} targetDestDir
 * @param {string[]} expectedTeamIds
 * @param {RegExp | null} expectedVendorAuthorityPattern
 * @param {Record<string, any>} [options]
 * @returns {Promise<string>}
 */
async function mountVerifyAndInstallDmgApp(
  dmgPath,
  targetDestDir,
  expectedTeamIds = [],
  expectedVendorAuthorityPattern = null,
  options = {}
) {
  if (
    typeof dmgPath !== 'string' ||
    !dmgPath.trim() ||
    !path.isAbsolute(dmgPath) ||
    path.basename(dmgPath).startsWith('-')
  ) {
    throw new Error(`Rejected unsafe or non-absolute disk image path: ${String(dmgPath)}`);
  }

  const mountPoint = path.join(
    os.tmpdir(),
    `ol-env-dmg-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
  );
  const execFileFn = getExecFileFn(options);
  const execHdiutil =
    typeof options.onExecHdiutil === 'function'
      ? options.onExecHdiutil
      : (/** @type {string[]} */ args) =>
          runExecFileAsync(execFileFn, 'hdiutil', args, { timeout: 120000 });

  let attached = false;
  try {
    await execHdiutil([
      'attach',
      '-mountpoint',
      mountPoint,
      '-nobrowse',
      '-readonly',
      '-quiet',
      '--',
      dmgPath,
    ]);
    attached = true;

    if (!fs.existsSync(mountPoint)) {
      throw new Error(`Failed to mount disk image: ${path.basename(dmgPath)}`);
    }

    const entries = await fs.promises.readdir(mountPoint);
    const appEntries = entries.filter((e) => e.toLowerCase().endsWith('.app'));
    const appEntry =
      options.requireGptkBundle === true
        ? appEntries.find((e) => /^Game Porting Toolkit.*\.app$/i.test(e)) || appEntries[0]
        : appEntries[0];
    if (!appEntry) {
      throw new Error(`No .app bundle found inside ${path.basename(dmgPath)}`);
    }

    const mountedAppPath = path.join(mountPoint, appEntry);
    if (options.requireGptkBundle === true) {
      const matchesGptkName = /^Game Porting Toolkit.*\.app$/i.test(appEntry);
      const hasGptkLayout =
        fs.existsSync(path.join(mountedAppPath, 'Contents/Resources/wine')) ||
        fs.existsSync(path.join(mountedAppPath, 'Contents/Frameworks/D3DMetal.framework')) ||
        fs.existsSync(path.join(mountedAppPath, 'Contents/Resources/D3DMetal.framework')) ||
        fs.existsSync(path.join(mountedAppPath, 'lib/external/D3DMetal.framework'));
      if (!matchesGptkName && !hasGptkLayout) {
        throw new Error(
          `Rejected ${path.basename(dmgPath)}: "${appEntry}" is not an Apple Game Porting Toolkit bundle.`
        );
      }
    }

    await verifyMacAppDeveloperSignature(mountedAppPath, expectedTeamIds, {
      ...options,
      keepOnFailure: true,
      ...(expectedVendorAuthorityPattern
        ? { expectedVendorAuthorityPattern }
        : {}),
    });

    return await copyVerifiedMacAppToApplicationsDir(mountedAppPath, targetDestDir, options);
  } finally {
    if (attached || typeof options.onExecHdiutil === 'function') {
      try {
        await execHdiutil(['detach', mountPoint, '-force', '-quiet']);
      } catch {}
    }
  }
}

/**
 * Recursively find a `.app` bundle inside an archive extraction staging directory (up to depth 3).
 *
 * @param {string} rootDir
 * @param {number} [depth]
 * @returns {Promise<string | null>}
 */
async function findStagedAppBundle(rootDir, depth = 0) {
  if (depth > 3 || !fs.existsSync(rootDir)) return null;
  const entries = await fs.promises.readdir(rootDir, { withFileTypes: true });
  for (const ent of entries) {
    if (ent.name.startsWith('.') || ent.name === '__MACOSX') continue;
    if (ent.isDirectory() && ent.name.toLowerCase().endsWith('.app')) {
      return path.join(rootDir, ent.name);
    }
  }
  for (const ent of entries) {
    if (ent.name.startsWith('.') || ent.name === '__MACOSX') continue;
    if (ent.isDirectory()) {
      const nested = await findStagedAppBundle(path.join(rootDir, ent.name), depth + 1);
      if (nested) return nested;
    }
  }
  return null;
}

/**
 * Tier 1: Query GOG's official remote-config webinstaller JSON API (`component_version=2.0.0`).
 *
 * @param {'osx' | 'windows'} targetOs
 * @param {Record<string, any>} [options]
 * @param {AbortSignal} [signal]
 * @returns {Promise<Array<{ url: string, isStubWebInstaller?: boolean }>>}
 */
async function resolveGogTier1Candidates(targetOs, options = {}, signal = undefined) {
  try {
    const rawJson = await fetchValidatedText(
      'https://remote-config.gog.com/components/webinstaller?component_version=2.0.0',
      { ...options, maxTextBytes: Number(options.maxTextBytes || 256 * 1024) },
      signal
    );
    const parsed = JSON.parse(rawJson);
    const osNode = parsed?.content?.[targetOs] || parsed?.[targetOs] || null;
    const candidate = String(
      osNode?.downloadLink ||
        osNode?.full_installer_url ||
        osNode?.installer_url ||
        osNode?.url ||
        ''
    ).trim();
    if (candidate) {
      return [{ url: validateInstallerUrl(candidate, options) }];
    }
  } catch (err) {
    if (isFatalSecurityOrAbortError(err, signal)) {
      throw err;
    }
  }
  return [];
}

/**
 * Tier 2: Extract live GOG Galaxy `.pkg` / `.exe` CDN download links from `https://www.gog.com/en/galaxy`.
 *
 * @param {'osx' | 'windows'} targetOs
 * @param {Record<string, any>} [options]
 * @param {AbortSignal} [signal]
 * @returns {Promise<Array<{ url: string, isStubWebInstaller?: boolean }>>}
 */
async function resolveGogTier2WebpageCandidates(targetOs, options = {}, signal = undefined) {
  /** @type {Array<{ url: string, isStubWebInstaller?: boolean }>} */
  const out = [];
  const seen = new Set();
  const pushValid = (/** @type {string} */ rawUrl) => {
    const validated = validateInstallerUrl(rawUrl, options);
    if (!seen.has(validated)) {
      seen.add(validated);
      out.push({ url: validated });
    }
  };

  for (const pageUrl of ['https://www.gog.com/en/galaxy', 'https://www.gog.com/galaxy']) {
    try {
      const rawHtml = await fetchValidatedText(
        pageUrl,
        { ...options, maxTextBytes: Number(options.maxTextBytes || 4 * 1024 * 1024) },
        signal
      );
      const normalizedHtml = String(rawHtml || '')
        .replace(/\\\//g, '/')
        .replace(/&amp;/gi, '&');

      const directLinks =
        normalizedHtml.match(
          /https:\/\/content-system\.gog\.com\/open_link\/download\?path=\/open\/galaxy\/client\/[^"'\s<>\\]+/gi
        ) || [];
      const pkgVerMatches = [
        ...normalizedHtml.matchAll(/galaxy_client_([0-9]+(?:\.[0-9]+)+)\.pkg/gi),
      ];

      if (targetOs === 'osx') {
        for (const link of directLinks) {
          if (/\.pkg(?:$|[?#])/i.test(link)) {
            pushValid(link);
          }
        }
        for (const pm of pkgVerMatches) {
          const ver = pm[1];
          if (ver) {
            pushValid(
              `https://content-system.gog.com/open_link/download?path=/open/galaxy/client/galaxy_client_${ver}.pkg`
            );
          }
        }
      } else {
        for (const link of directLinks) {
          if (/\.exe(?:$|[?#])/i.test(link)) {
            pushValid(link);
          }
        }
        for (const pm of pkgVerMatches) {
          const ver = pm[1];
          if (ver) {
            pushValid(
              `https://content-system.gog.com/open_link/download?path=/open/galaxy/client/setup_galaxy_${ver}.exe`
            );
          }
        }
      }
      if (out.length > 0) {
        break;
      }
    } catch (err) {
      if (isFatalSecurityOrAbortError(err, signal)) {
        throw err;
      }
    }
  }
  return out;
}

/**
 * Resolve ordered, zero-hardcoded-version GOG Galaxy installer candidates across:
 *   - Tier 1: `https://remote-config.gog.com/components/webinstaller?component_version=2.0.0` (`downloadLink`)
 *   - Tier 2: Live link extraction from `https://www.gog.com/en/galaxy` (queried if Tier 1 yields no URL)
 *   - Tier 3: Evergreen versionless Windows stub `https://webinstallers.gog-statics.com/download/GOG_Galaxy_2.0.exe`
 *
 * @param {'osx' | 'windows'} targetOs
 * @param {Record<string, any>} [options]
 * @param {AbortSignal} [signal]
 * @returns {Promise<Array<{ url: string, isStubWebInstaller?: boolean }>>}
 */
async function resolveGogGalaxyInstallerCandidates(targetOs, options = {}, signal = undefined) {
  const osKey = targetOs === 'osx' ? 'osx' : 'windows';
  /** @type {Array<{ url: string, isStubWebInstaller?: boolean }>} */
  const candidates = [];
  const seen = new Set();
  const addCandidate = (/** @type {{ url: string, isStubWebInstaller?: boolean }} */ item) => {
    if (item && item.url && !seen.has(item.url)) {
      seen.add(item.url);
      candidates.push(item);
    }
  };

  const tier1 = await resolveGogTier1Candidates(osKey, options, signal);
  tier1.forEach(addCandidate);

  if (candidates.length === 0 || options.includeAllGogTiers === true) {
    const tier2 = await resolveGogTier2WebpageCandidates(osKey, options, signal);
    tier2.forEach(addCandidate);
  }

  if (osKey === 'windows') {
    addCandidate({
      url: validateInstallerUrl(
        'https://webinstallers.gog-statics.com/download/GOG_Galaxy_2.0.exe',
        options
      ),
      isStubWebInstaller: true,
    });
  }

  return candidates;
}

/**
 * Resolve the primary GOG Galaxy macOS `.pkg` or Windows `.exe` installer URL with zero hardcoded
 * version numbers.
 *
 * @param {'osx' | 'windows'} targetOs
 * @param {Record<string, any>} [options]
 * @param {AbortSignal} [signal]
 * @returns {Promise<string>}
 */
async function resolveGogGalaxyInstallerUrl(targetOs, options = {}, signal = undefined) {
  const candidates = await resolveGogGalaxyInstallerCandidates(targetOs, options, signal);
  if (candidates.length > 0) {
    return candidates[0].url;
  }
  throw new Error(
    targetOs === 'osx'
      ? 'Could not resolve current GOG Galaxy macOS installer URL from GOG servers.'
      : 'Could not resolve current GOG Galaxy Windows installer URL from GOG servers.'
  );
}

/**
 * Download the GOG Galaxy installer to `destFilePath` with multi-tier fallback resilience:
 * attempts Tier 1 (`remote-config.gog.com`) first, and if unavailable or failing with an HTTP
 * `404`/`5xx`/transient network error, resolves Tier 2 (`www.gog.com/en/galaxy`) and Tier 3
 * (`webinstallers.gog-statics.com` on Windows), deduplicating tried URLs. Immediately rethrows
 * `AbortError` and SSRF/allowlist violations without fallback.
 *
 * @param {'osx' | 'windows'} targetOs
 * @param {string} destFilePath
 * @param {{ runId: string, componentId: EnvironmentComponentId, stepIndex?: number, totalSteps?: number, label: string, minFreeBytes?: number }} progressCtx
 * @param {Record<string, any>} [options]
 * @param {AbortSignal} [signal]
 * @returns {Promise<{ url: string, isStubWebInstaller: boolean }>}
 */
async function downloadGogGalaxyInstallerToFile(
  targetOs,
  destFilePath,
  progressCtx,
  options = {},
  signal = undefined
) {
  const osKey = targetOs === 'osx' ? 'osx' : 'windows';
  const normalizedProgressCtx = {
    stepIndex: 1,
    totalSteps: 1,
    ...progressCtx,
  };
  /** @type {Set<string>} */
  const triedUrls = new Set();
  /** @type {any} */
  let lastDownloadError = null;

  const tryCandidateList = async (
    /** @type {Array<{ url: string, isStubWebInstaller?: boolean }>} */ list
  ) => {
    for (const cand of list) {
      if (!cand?.url || triedUrls.has(cand.url)) continue;
      triedUrls.add(cand.url);
      try {
        await streamVerifiedDownloadToFile(
          cand.url,
          destFilePath,
          normalizedProgressCtx,
          options,
          signal
        );
        return { url: cand.url, isStubWebInstaller: Boolean(cand.isStubWebInstaller) };
      } catch (err) {
        try {
          await fs.promises.rm(destFilePath, { force: true });
        } catch {}
        if (isFatalSecurityOrAbortError(err, signal)) {
          throw err;
        }
        lastDownloadError = err;
      }
    }
    return null;
  };

  const tier1 = await resolveGogTier1Candidates(osKey, options, signal);
  const tier1Result = await tryCandidateList(tier1);
  if (tier1Result) return tier1Result;

  /** @type {Array<{ url: string, isStubWebInstaller?: boolean }>} */
  const fallbackCandidates = [];
  const tier2 = await resolveGogTier2WebpageCandidates(osKey, options, signal);
  fallbackCandidates.push(...tier2);
  if (osKey === 'windows') {
    fallbackCandidates.push({
      url: validateInstallerUrl(
        'https://webinstallers.gog-statics.com/download/GOG_Galaxy_2.0.exe',
        options
      ),
      isStubWebInstaller: true,
    });
  }

  const fallbackResult = await tryCandidateList(fallbackCandidates);
  if (fallbackResult) return fallbackResult;

  if (lastDownloadError) {
    throw lastDownloadError instanceof Error
      ? lastDownloadError
      : new Error(String(lastDownloadError));
  }
  throw new Error(
    osKey === 'osx'
      ? 'Could not resolve current GOG Galaxy macOS installer URL from GOG servers.'
      : 'Could not resolve current GOG Galaxy Windows installer URL from GOG servers.'
  );
}

/**
 * Direct vendor installation for macOS compatibility runners (`crossover`, `wine`, `gptk`, `crossover_preview`)
 * without requiring Homebrew. Always uses ephemeral `os.tmpdir()` staging, verifies Developer ID
 * signatures BEFORE copying to `Applications`, and cleans up temp artifacts in `finally`.
 *
 * @param {string} rawRunnerType
 * @param {Record<string, any>} [options]
 * @returns {Promise<{ success: boolean, installed?: boolean, openedExternal?: boolean, openedExternalUrl?: string, installedPath?: string, message: string }>}
 */
async function installRunnerDirect(rawRunnerType, options = {}) {
  const runnerType = String(rawRunnerType || 'crossover')
    .trim()
    .toLowerCase();
  const { homedir } = resolveIsolatedHomedirAndUserData(options);
  const targetAppsDir = await resolveTargetMacApplicationsDir(homedir, options);
  const signal = /** @type {AbortSignal | undefined} */ (options.signal);

  /** @type {EnvironmentComponentId} */
  const componentId =
    runnerType === 'crossover_preview'
      ? 'runner_crossover_preview'
      : runnerType === 'wine'
        ? 'runner_wine'
        : runnerType === 'gptk'
          ? 'runner_gptk'
          : 'runner_crossover';

  const progressCtx = options._progressCtx || {
    runId: String(options.runId || `runner-install-${Date.now()}`),
    componentId,
    stepIndex: 0,
    totalSteps: 1,
  };

  // GPTK & CrossOver Preview require authenticated portal download unless a local DMG is supplied
  if (runnerType === 'gptk' || runnerType === 'crossover_preview') {
    const localDmg = typeof options.dmgPath === 'string' ? options.dmgPath.trim() : '';
    if (localDmg && fs.existsSync(localDmg)) {
      emitEnvironmentSetupProgress(
        {
          ...progressCtx,
          phase: 'verifying_signature',
          message: `Mounting and verifying ${path.basename(localDmg)}...`,
        },
        options
      );
      const teamIds = runnerType === 'crossover_preview' ? ['2C75U774H4'] : [];
      const installedPath = await mountVerifyAndInstallDmgApp(
        localDmg,
        targetAppsDir,
        teamIds,
        runnerType === 'crossover_preview'
          ? /Developer ID Application:\s*CodeWeavers/i
          : null,
        {
          ...options,
          _componentId: componentId,
          ...(runnerType === 'gptk' ? { requireGptkBundle: true } : {}),
        }
      );
      invalidateScanCaches();
      return {
        success: true,
        installed: true,
        installedPath,
        message: `Installed ${path.basename(installedPath)} to ${targetAppsDir}.`,
      };
    }

    const portalUrl =
      runnerType === 'crossover_preview'
        ? 'https://www.codeweavers.com/preview/download'
        : 'https://developer.apple.com/games/game-porting-toolkit/';
    await openExternalUri(portalUrl, options);
    return {
      success: true,
      installed: false,
      openedExternal: true,
      openedExternalUrl: portalUrl,
      message: `Opened official ${runnerType === 'gptk' ? 'Apple Developer' : 'CodeWeavers Preview'} download portal in your browser.`,
    };
  }

  const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ol-env-setup-'));
  const execFileFn = getExecFileFn(options);

  try {
    if (runnerType === 'crossover') {
      emitEnvironmentSetupProgress(
        {
          ...progressCtx,
          phase: 'probing',
          message: 'Resolving latest CrossOver release from CodeWeavers Sparkle feed...',
        },
        options
      );
      const xml = await fetchValidatedText(
        'https://www.codeweavers.com/xml/versions/cxmac.xml',
        options,
        signal
      );
      const encMatch = xml.match(/<enclosure\s+([^>]+)>/i);
      const urlMatch = encMatch ? encMatch[1].match(/url="([^"]+)"/i) : null;
      const archiveUrl = urlMatch ? validateInstallerUrl(urlMatch[1].trim(), options) : '';
      if (!archiveUrl) {
        throw new Error('Could not find CrossOver download URL in CodeWeavers Sparkle feed.');
      }

      const isDmg = /\.dmg(?:\?|$)/i.test(archiveUrl);
      const archivePath = path.join(tempDir, isDmg ? 'CrossOver.dmg' : 'CrossOver.zip');
      await streamVerifiedDownloadToFile(
        archiveUrl,
        archivePath,
        {
          ...progressCtx,
          label: 'CrossOver',
          minFreeBytes: 1200 * 1024 * 1024,
        },
        options,
        signal
      );

      if (isDmg) {
        emitEnvironmentSetupProgress(
          {
            ...progressCtx,
            phase: 'verifying_signature',
            message: 'Verifying CodeWeavers Developer ID signature...',
          },
          options
        );
        const installedPath = await mountVerifyAndInstallDmgApp(
          archivePath,
          targetAppsDir,
          ['2C75U774H4'],
          /Developer ID Application:\s*CodeWeavers/i,
          { ...options, _componentId: componentId }
        );
        invalidateScanCaches();
        return {
          success: true,
          installed: true,
          installedPath,
          message: `Installed CrossOver to ${installedPath}.`,
        };
      }

      const stagingDir = path.join(tempDir, 'staging');
      await fs.promises.mkdir(stagingDir, { recursive: true });
      emitEnvironmentSetupProgress(
        {
          ...progressCtx,
          phase: 'extracting',
          message: 'Extracting CrossOver archive...',
        },
        options
      );

      if (typeof options.onExtractArchive === 'function') {
        await options.onExtractArchive(archivePath, stagingDir);
      } else {
        await runExecFileAsync(
          execFileFn,
          '/usr/bin/ditto',
          ['-x', '-k', archivePath, stagingDir],
          { timeout: 300000, signal }
        );
      }

      const stagedApp = await findStagedAppBundle(stagingDir);
      if (!stagedApp) {
        throw new Error('CrossOver.app was not found inside the downloaded archive.');
      }

      emitEnvironmentSetupProgress(
        {
          ...progressCtx,
          phase: 'verifying_signature',
          message: 'Verifying CodeWeavers Developer ID signature...',
        },
        options
      );
      await verifyMacAppDeveloperSignature(stagedApp, ['2C75U774H4'], {
        ...options,
        _componentId: componentId,
        expectedVendorAuthorityPattern: /Developer ID Application:\s*CodeWeavers/i,
      });

      emitEnvironmentSetupProgress(
        {
          ...progressCtx,
          phase: 'installing',
          message: `Installing CrossOver.app to ${targetAppsDir}...`,
        },
        options
      );
      const installedPath = await copyVerifiedMacAppToApplicationsDir(
        stagedApp,
        targetAppsDir,
        options
      );
      invalidateScanCaches();
      return {
        success: true,
        installed: true,
        installedPath,
        message: `Installed CrossOver to ${installedPath}.`,
      };
    }

    if (runnerType === 'wine') {
      emitEnvironmentSetupProgress(
        {
          ...progressCtx,
          phase: 'probing',
          message: 'Resolving latest Open-Source Wine Stable release...',
        },
        options
      );

      let assetUrl = '';
      let expectedSha256 =
        typeof options.expectedSha256 === 'string' &&
        /^[a-f0-9]{64}$/i.test(options.expectedSha256.trim())
          ? options.expectedSha256.trim().toLowerCase()
          : '';
      try {
        const caskTxt = await fetchValidatedText(
          'https://formulae.brew.sh/api/cask/wine-stable.json',
          options,
          signal
        );
        const caskJson = JSON.parse(caskTxt);
        if (caskJson && typeof caskJson.url === 'string' && caskJson.url.trim()) {
          assetUrl = validateInstallerUrl(caskJson.url.trim(), options);
          if (
            !expectedSha256 &&
            typeof caskJson.sha256 === 'string' &&
            /^[a-f0-9]{64}$/i.test(caskJson.sha256.trim())
          ) {
            expectedSha256 = caskJson.sha256.trim().toLowerCase();
          }
        }
      } catch {}

      if (!assetUrl) {
        const ghTxt = await fetchValidatedText(
          'https://api.github.com/repos/Gcenx/macOS_Wine_builds/releases/latest',
          options,
          signal
        );
        const ghJson = JSON.parse(ghTxt);
        const assets = Array.isArray(ghJson?.assets) ? ghJson.assets : [];
        const matchedAsset = assets.find((/** @type {any} */ a) =>
          /wine[-_]?stable.*\.(?:tar\.xz|dmg)$/i.test(String(a?.name || ''))
        );
        if (matchedAsset?.browser_download_url) {
          assetUrl = validateInstallerUrl(String(matchedAsset.browser_download_url).trim(), options);
          const rawDigest = String(matchedAsset?.digest || '').trim();
          if (!expectedSha256 && /^sha256:[a-f0-9]{64}$/i.test(rawDigest)) {
            expectedSha256 = rawDigest.slice(7).toLowerCase();
          }
        }
      }

      if (!assetUrl) {
        throw new Error('Could not resolve Open-Source Wine Stable download asset URL.');
      }

      const isDmg = /\.dmg(?:\?|$)/i.test(assetUrl);
      const archivePath = path.join(tempDir, isDmg ? 'WineStable.dmg' : 'WineStable.tar.xz');
      await streamVerifiedDownloadToFile(
        assetUrl,
        archivePath,
        {
          ...progressCtx,
          label: 'Wine Stable',
          minFreeBytes: 800 * 1024 * 1024,
        },
        options,
        signal
      );

      if (expectedSha256) {
        emitEnvironmentSetupProgress(
          {
            ...progressCtx,
            phase: 'verifying_signature',
            message: 'Verifying Wine Stable archive SHA-256 checksum...',
          },
          options
        );
        await verifyFileSha256Async(archivePath, expectedSha256);
      }

      if (isDmg) {
        emitEnvironmentSetupProgress(
          {
            ...progressCtx,
            phase: 'verifying_signature',
            message: 'Verifying Wine Stable code signature integrity...',
          },
          options
        );
        const installedPath = await mountVerifyAndInstallDmgApp(
          archivePath,
          targetAppsDir,
          [],
          null,
          { ...options, _componentId: componentId, allowAdhocSignature: true }
        );
        invalidateScanCaches();
        return {
          success: true,
          installed: true,
          installedPath,
          message: `Installed Wine Stable to ${installedPath}.`,
        };
      }

      const stagingDir = path.join(tempDir, 'staging');
      await fs.promises.mkdir(stagingDir, { recursive: true });
      emitEnvironmentSetupProgress(
        {
          ...progressCtx,
          phase: 'extracting',
          message: 'Extracting Wine Stable archive...',
        },
        options
      );

      if (typeof options.onExtractArchive === 'function') {
        await options.onExtractArchive(archivePath, stagingDir);
      } else {
        await runExecFileAsync(
          execFileFn,
          '/usr/bin/tar',
          ['-xf', archivePath, '-C', stagingDir],
          { timeout: 300000, signal }
        );
      }

      const stagedApp = await findStagedAppBundle(stagingDir);
      if (!stagedApp) {
        throw new Error('Wine Stable.app was not found inside the downloaded archive.');
      }

      emitEnvironmentSetupProgress(
        {
          ...progressCtx,
          phase: 'verifying_signature',
          message: 'Verifying Wine Stable code signature integrity...',
        },
        options
      );
      await verifyMacAppDeveloperSignature(stagedApp, [], {
        ...options,
        _componentId: componentId,
        allowAdhocSignature: true,
      });

      emitEnvironmentSetupProgress(
        {
          ...progressCtx,
          phase: 'installing',
          message: `Installing ${path.basename(stagedApp)} to ${targetAppsDir}...`,
        },
        options
      );
      const installedPath = await copyVerifiedMacAppToApplicationsDir(
        stagedApp,
        targetAppsDir,
        options
      );
      invalidateScanCaches();
      return {
        success: true,
        installed: true,
        installedPath,
        message: `Installed Wine Stable to ${installedPath}.`,
      };
    }

    throw new Error(`Unsupported compatibility runner type: ${runnerType}`);
  } finally {
    try {
      await fs.promises.rm(tempDir, { recursive: true, force: true });
    } catch {}
  }
}

/**
 * Resolve active runner and bottle path/name for bottle operations on macOS.
 *
 * @param {string} homedir
 * @param {{ runnerType?: string, bottleName?: string }} prefs
 * @param {Record<string, any>} options
 * @returns {{ layer: any, bottleName: string, bottlePath: string }}
 */
function resolveRunnerAndBottleTarget(homedir, prefs = {}, options = {}) {
  const wizardState = getSetupWizardState(options);
  const runners = detectCompatibilityLayers({ ...options, ...explicitHomedirOpt(options) });
  if (runners.length === 0) {
    throw new Error(
      'No macOS compatibility runner (CrossOver or Wine) is installed yet. Install a runner first.'
    );
  }

  const desiredRunner =
    prefs.runnerType ||
    (wizardState.preferredRunnerType !== 'skip' ? wizardState.preferredRunnerType : '');
  const layer =
    (desiredRunner && runners.find((r) => r.type === desiredRunner)) || runners[0];

  if (layer.type === 'crossover' || layer.type === 'crossover_preview') {
    const bottlesDir =
      layer.bottlesDir ||
      path.join(homedir, 'Library/Application Support/CrossOver/Bottles');
    const available = Array.isArray(layer.availableBottles) ? layer.availableBottles : [];
    const requestedName =
      prefs.bottleName && safeIsBottleSlug(prefs.bottleName)
        ? prefs.bottleName.trim()
        : wizardState.preferredBottleName && safeIsBottleSlug(wizardState.preferredBottleName)
          ? wizardState.preferredBottleName
          : available.includes('OneLauncher')
            ? 'OneLauncher'
            : available[0] || 'OneLauncher';
    return {
      layer,
      bottleName: requestedName,
      bottlePath: path.join(bottlesDir, requestedName),
    };
  }

  const prefixSlug =
    prefs.bottleName && safeIsBottleSlug(prefs.bottleName)
      ? prefs.bottleName.trim()
      : 'default';
  return {
    layer,
    bottleName: prefixSlug,
    bottlePath: path.join(homedir, 'Games/OneLauncher/Prefixes', prefixSlug),
  };
}

/**
 * Spawn an installer inside a CrossOver/Wine bottle and poll until `checkInstalledFn()` resolves
 * to a binary path or `timeoutMs` expires.
 *
 * @param {any} layer
 * @param {string} bottleName
 * @param {string} bottlePath
 * @param {string[]} wineArgs
 * @param {() => string | null} checkInstalledFn
 * @param {Record<string, any>} options
 * @param {AbortSignal} [signal]
 * @returns {Promise<string>}
 */
async function runBottleInstallerAndWait(
  layer,
  bottleName,
  bottlePath,
  wineArgs,
  checkInstalledFn,
  options = {},
  signal = undefined
) {
  const timeoutMs = Number(options.clientInstallTimeoutMs || 300000);
  const pollMs = Number(options.bottlePollIntervalMs || (isTestEnvironment(options) ? 40 : 600));
  const spawnImpl = typeof options.spawnFn === 'function' ? options.spawnFn : spawn;

  const env = {
    ...process.env,
    WINEPREFIX: bottlePath,
    WINEDLLOVERRIDES: 'mscoree,mshtml=d;winemenubuilder.exe=d',
    ...(layer.type === 'crossover' || layer.type === 'crossover_preview'
      ? { CX_BOTTLE: bottleName }
      : {}),
  };

  if (typeof options.execBottleInstallerFn === 'function') {
    await options.execBottleInstallerFn({
      binaryPath: layer.binaryPath,
      args: wineArgs,
      env,
      bottleName,
      bottlePath,
    });
    const postHookBin = checkInstalledFn();
    if (postHookBin) return postHookBin;
  }

  return await new Promise((resolve, reject) => {
    let settled = false;
    let hasRealChildPid = false;
    let childExited = false;
    /** @type {ReturnType<typeof setTimeout> | null} */
    let postExitTimer = null;
    /** @type {any} */
    let child = null;

    const cleanup = () => {
      clearInterval(pollTimer);
      clearTimeout(timeoutTimer);
      if (postExitTimer !== null) {
        clearTimeout(postExitTimer);
        postExitTimer = null;
      }
      if (signal) {
        signal.removeEventListener('abort', onAbort);
      }
    };

    const finishOk = (/** @type {string} */ foundPath) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(foundPath);
    };

    const finishErr = (/** @type {Error} */ err) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (child && typeof child.kill === 'function') {
        try {
          child.kill('SIGTERM');
        } catch {}
      }
      reject(err);
    };

    const onAbort = () => {
      const abortErr = new Error('Bottle client installation cancelled.');
      abortErr.name = 'AbortError';
      finishErr(abortErr);
    };

    if (signal) {
      if (signal.aborted) {
        onAbort();
        return;
      }
      signal.addEventListener('abort', onAbort, { once: true });
    }

    const pollTimer = setInterval(() => {
      if (hasRealChildPid && !childExited && options.resolveOnBinaryAppear !== true) {
        return;
      }
      const found = checkInstalledFn();
      if (found) {
        finishOk(found);
      }
    }, pollMs);

    const timeoutTimer = setTimeout(() => {
      const found = checkInstalledFn();
      if (found) finishOk(found);
      else finishErr(new Error('Timed out waiting for bottled client installer to complete.'));
    }, timeoutMs);

    try {
      child = spawnImpl(layer.binaryPath, wineArgs, {
        env,
        stdio: 'ignore',
      });
      hasRealChildPid = Boolean(child && typeof child.pid === 'number');
      if (child && typeof child.on === 'function') {
        child.on('error', (/** @type {any} */ err) => {
          childExited = true;
          const found = checkInstalledFn();
          if (found) finishOk(found);
          else finishErr(err instanceof Error ? err : new Error(String(err)));
        });
        child.on('exit', (/** @type {number | null} */ code) => {
          childExited = true;
          const found = checkInstalledFn();
          if (found) {
            finishOk(found);
            return;
          }
          const flushGraceMs = Number(
            options.postExitFlushGraceMs ??
              (isTestEnvironment(options) ? Math.max(80, pollMs * 2) : 3000)
          );
          if (postExitTimer !== null) {
            clearTimeout(postExitTimer);
          }
          postExitTimer = setTimeout(() => {
            postExitTimer = null;
            const afterFlush = checkInstalledFn();
            if (afterFlush) {
              finishOk(afterFlush);
            } else if (code !== 0 && code !== null) {
              finishErr(
                new Error(
                  `Installer exited with code ${code} before client binary was created.`
                )
              );
            }
          }, flushGraceMs);
        });
      }
    } catch (err) {
      finishErr(err instanceof Error ? err : new Error(String(err)));
    }
  });
}

/**
 * Cancel an in-flight `runEnvironmentSetupTasks` run by `runId` (or all active runs if omitted).
 *
 * @param {string} [runId]
 * @param {Record<string, any>} [_options]
 * @returns {{ success: boolean, runId?: string, cancelled: boolean }}
 */
function cancelEnvironmentSetup(runId, _options = {}) {
  if (typeof runId === 'string' && runId.trim()) {
    const cleanId = runId.trim();
    const ctrl = activeSetupRuns.get(cleanId);
    if (!ctrl) {
      return { success: false, runId: cleanId, cancelled: false };
    }
    ctrl.abort();
    return { success: true, runId: cleanId, cancelled: true };
  }

  let cancelledAny = false;
  for (const [, ctrl] of activeSetupRuns.entries()) {
    ctrl.abort();
    cancelledAny = true;
  }
  return { success: cancelledAny, cancelled: cancelledAny };
}

/**
 * Execute requested environment setup tasks sequentially in dependency order:
 * `os_prerequisite` -> `install_runner` -> `ensure_bottle` -> `install_client` -> `sync_first_party_manifests`.
 *
 * @param {RunEnvironmentSetupRequest} payload
 * @param {Record<string, any>} [options]
 * @returns {Promise<RunEnvironmentSetupResult>}
 */
async function runEnvironmentSetupTasks(payload, options = {}) {
  const runId = String(
    payload?.runId || `env-setup-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  );
  const rawTasks = Array.isArray(payload?.tasks) ? payload.tasks : [];

  // Stable sort by dependency order
  const sortedTasks = rawTasks
    .map((task, idx) => ({ task, idx }))
    .sort((a, b) => {
      const prioA = ACTION_EXECUTION_ORDER[a.task.action] ?? 99;
      const prioB = ACTION_EXECUTION_ORDER[b.task.action] ?? 99;
      return prioA !== prioB ? prioA - prioB : a.idx - b.idx;
    })
    .map((entry) => entry.task);

  const controller = new AbortController();
  activeSetupRuns.set(runId, controller);

  const rawPlatform = String(options.platform || process.platform).toLowerCase();
  /** @type {'darwin' | 'win32' | 'linux'} */
  const hostPlatform =
    rawPlatform === 'win32' ? 'win32' : rawPlatform === 'linux' ? 'linux' : 'darwin';
  const hostArch = String(options.arch || process.arch || 'arm64');
  const { homedir } = resolveIsolatedHomedirAndUserData(options);
  const execFileFn = getExecFileFn(options);

  /** @type {EnvironmentSetupTaskOutcome[]} */
  const outcomes = [];
  /** @type {EnvironmentComponentId[]} */
  const succeededComponents = [];
  let wasCancelled = false;

  try {
    const hasExplicitRosettaTask = sortedTasks.some((t) => t.action === 'install_rosetta2');
    const needsWindowsTranslationOnMac =
      hostPlatform === 'darwin' &&
      hostArch === 'arm64' &&
      !hasExplicitRosettaTask &&
      sortedTasks.some(
        (t) =>
          t.action === 'install_runner' ||
          t.action === 'ensure_bottle' ||
          (t.action === 'install_client' && String(t.componentId || '').startsWith('bottle_'))
      );

    if (needsWindowsTranslationOnMac) {
      await ensureRosetta2InBackground({
        ...options,
        signal: controller.signal,
      });
    }

    const totalSteps = sortedTasks.length;

    for (let stepIndex = 0; stepIndex < totalSteps; stepIndex++) {
      const task = sortedTasks[stepIndex];
      const componentId = task.componentId;
      const progressBase = {
        runId,
        componentId,
        stepIndex,
        totalSteps,
      };

      if (controller.signal.aborted) {
        wasCancelled = true;
        emitEnvironmentSetupProgress(
          {
            ...progressBase,
            phase: 'cancelled',
            message: 'Cancelled.',
          },
          options
        );
        outcomes.push({
          componentId,
          action: task.action,
          status: 'cancelled',
          message: 'Cancelled by user.',
        });
        continue;
      }

      try {
        // -------------------------------------------------------------------
        // 1. Apple Rosetta 2
        // -------------------------------------------------------------------
        if (task.action === 'install_rosetta2') {
          if (hostPlatform !== 'darwin' || hostArch !== 'arm64') {
            emitEnvironmentSetupProgress(
              {
                ...progressBase,
                phase: 'skipped',
                message: 'Rosetta 2 is only applicable on Apple Silicon Macs.',
              },
              options
            );
            outcomes.push({
              componentId,
              action: task.action,
              status: 'skipped',
              message: 'Rosetta 2 is only applicable on Apple Silicon Macs.',
            });
            continue;
          }

          const snap = await probeEnvironmentHealth(options);
          if (snap.components.rosetta2.status === 'ready' && !options.forceReinstall) {
            emitEnvironmentSetupProgress(
              {
                ...progressBase,
                phase: 'skipped',
                message: 'Rosetta 2 is already installed.',
              },
              options
            );
            outcomes.push({
              componentId,
              action: task.action,
              status: 'skipped',
              message: 'Rosetta 2 is already installed.',
            });
            succeededComponents.push('rosetta2');
            continue;
          }

          emitEnvironmentSetupProgress(
            {
              ...progressBase,
              phase: 'installing',
              message: 'Installing Apple Rosetta 2 via softwareupdate...',
            },
            options
          );
          await runExecFileAsync(
            execFileFn,
            '/usr/sbin/softwareupdate',
            ['--install-rosetta', '--agree-to-license'],
            { timeout: 300000, signal: controller.signal }
          );

          succeededComponents.push('rosetta2');
          emitEnvironmentSetupProgress(
            {
              ...progressBase,
              phase: 'completed',
              progressPercent: 100,
              message: 'Installed Apple Rosetta 2.',
            },
            options
          );
          outcomes.push({
            componentId,
            action: task.action,
            status: 'completed',
            message: 'Installed Apple Rosetta 2.',
          });
          continue;
        }

        // -------------------------------------------------------------------
        // 2. Windows VC++ 2015-2022 Redistributable
        // -------------------------------------------------------------------
        if (task.action === 'install_win_vcredist') {
          if (hostPlatform !== 'win32') {
            emitEnvironmentSetupProgress(
              {
                ...progressBase,
                phase: 'skipped',
                message: 'VC++ Redistributable is only applicable on Windows.',
              },
              options
            );
            outcomes.push({
              componentId,
              action: task.action,
              status: 'skipped',
              message: 'VC++ Redistributable is only applicable on Windows.',
            });
            continue;
          }

          const snap = await probeEnvironmentHealth(options);
          if (snap.components.win_vcredist.status === 'ready' && !options.forceReinstall) {
            emitEnvironmentSetupProgress(
              {
                ...progressBase,
                phase: 'skipped',
                message: 'VC++ Redistributable is already installed.',
              },
              options
            );
            outcomes.push({
              componentId,
              action: task.action,
              status: 'skipped',
              message: 'VC++ Redistributable is already installed.',
            });
            succeededComponents.push('win_vcredist');
            continue;
          }

          const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ol-env-setup-'));
          try {
            const vcUrls =
              options.x64Only === true
                ? [{ archLabel: 'x64', url: 'https://aka.ms/vs/17/release/vc_redist.x64.exe' }]
                : [
                    { archLabel: 'x64', url: 'https://aka.ms/vs/17/release/vc_redist.x64.exe' },
                    { archLabel: 'x86', url: 'https://aka.ms/vs/17/release/vc_redist.x86.exe' },
                  ];

            for (const item of vcUrls) {
              const exePath = path.join(tempDir, `vc_redist.${item.archLabel}.exe`);
              await streamVerifiedDownloadToFile(
                item.url,
                exePath,
                {
                  ...progressBase,
                  label: `VC++ Redistributable (${item.archLabel})`,
                  minFreeBytes: 100 * 1024 * 1024,
                },
                options,
                controller.signal
              );
              emitEnvironmentSetupProgress(
                {
                  ...progressBase,
                  phase: 'verifying_signature',
                  message: `Verifying Microsoft Authenticode signature (${item.archLabel})...`,
                },
                options
              );
              await verifyWindowsInstallerSignature(exePath, {
                ...options,
                platform: 'win32',
                kind: 'exe',
                _componentId: componentId,
              });

              emitEnvironmentSetupProgress(
                {
                  ...progressBase,
                  phase: 'installing',
                  message: `Installing VC++ Redistributable (${item.archLabel})...`,
                },
                options
              );
              try {
                await runExecFileAsync(
                  execFileFn,
                  exePath,
                  ['/install', '/quiet', '/norestart'],
                  { timeout: 180000, windowsHide: true, signal: controller.signal }
                );
              } catch (/** @type {any} */ execErr) {
                const code = Number(execErr?.code);
                // 3010 = ERROR_SUCCESS_REBOOT_REQUIRED, 1638 = newer version already installed
                if (code !== 3010 && code !== 1638) {
                  throw execErr;
                }
              }
            }
          } finally {
            try {
              await fs.promises.rm(tempDir, { recursive: true, force: true });
            } catch {}
          }

          succeededComponents.push('win_vcredist');
          emitEnvironmentSetupProgress(
            {
              ...progressBase,
              phase: 'completed',
              progressPercent: 100,
              message: 'Installed Microsoft Visual C++ 2015–2022 Redistributable.',
            },
            options
          );
          outcomes.push({
            componentId,
            action: task.action,
            status: 'completed',
            message: 'Installed Microsoft Visual C++ 2015–2022 Redistributable.',
          });
          continue;
        }

        // -------------------------------------------------------------------
        // 3. Compatibility Runner (CrossOver, Wine Stable, GPTK, Preview)
        // -------------------------------------------------------------------
        if (task.action === 'install_runner') {
          if (hostPlatform !== 'darwin') {
            outcomes.push({
              componentId,
              action: task.action,
              status: 'skipped',
              message: 'Compatibility runners are only applicable on macOS.',
            });
            continue;
          }

          const runnerType =
            task.runnerType ||
            (componentId === 'runner_crossover_preview'
              ? 'crossover_preview'
              : componentId === 'runner_wine'
                ? 'wine'
                : componentId === 'runner_gptk'
                  ? 'gptk'
                  : 'crossover');

          const existingLayers = detectCompatibilityLayers({
            ...options,
            ...explicitHomedirOpt(options),
          });
          const alreadyLayer = existingLayers.find((l) => l.type === runnerType);
          if (alreadyLayer && !options.forceReinstall && !task.dmgPath) {
            saveSetupWizardState({ preferredRunnerType: runnerType }, options);
            succeededComponents.push(componentId);
            emitEnvironmentSetupProgress(
              {
                ...progressBase,
                phase: 'skipped',
                message: `${alreadyLayer.name} is already installed.`,
              },
              options
            );
            outcomes.push({
              componentId,
              action: task.action,
              status: 'skipped',
              installedPath: alreadyLayer.appPath || alreadyLayer.binaryPath,
              message: `${alreadyLayer.name} is already installed.`,
            });
            continue;
          }

          const res = await installRunnerDirect(runnerType, {
            ...options,
            dmgPath: task.dmgPath || options.dmgPath,
            signal: controller.signal,
            _progressCtx: progressBase,
          });

          if (res.openedExternal) {
            emitEnvironmentSetupProgress(
              {
                ...progressBase,
                phase: 'completed',
                openedExternalUrl: res.openedExternalUrl,
                message: res.message,
              },
              options
            );
            outcomes.push({
              componentId,
              action: task.action,
              status: 'opened_external',
              openedExternalUrl: res.openedExternalUrl,
              message: res.message,
            });
          } else {
            saveSetupWizardState({ preferredRunnerType: runnerType }, options);
            succeededComponents.push(componentId);
            emitEnvironmentSetupProgress(
              {
                ...progressBase,
                phase: 'completed',
                progressPercent: 100,
                message: res.message,
              },
              options
            );
            outcomes.push({
              componentId,
              action: task.action,
              status: 'completed',
              ...(res.installedPath ? { installedPath: res.installedPath } : {}),
              message: res.message,
            });
          }
          continue;
        }

        // -------------------------------------------------------------------
        // 4. Bottle Creation / Reuse & User Folder Sandboxing
        // -------------------------------------------------------------------
        if (task.action === 'ensure_bottle') {
          if (hostPlatform !== 'darwin') {
            outcomes.push({
              componentId,
              action: task.action,
              status: 'skipped',
              message: 'Windows bottles are only applicable on macOS.',
            });
            continue;
          }

          const { layer, bottleName, bottlePath } = resolveRunnerAndBottleTarget(
            homedir,
            { runnerType: task.runnerType, bottleName: task.bottleName },
            options
          );

          emitEnvironmentSetupProgress(
            {
              ...progressBase,
              phase: 'configuring_bottle',
              message: `Configuring Windows 10 64-bit bottle "${bottleName}"...`,
            },
            options
          );

          const isMockHomedir = Boolean(options.homedir || options.customApplicationsDir);
          if (layer.type === 'crossover' || layer.type === 'crossover_preview') {
            if (!isValidBottleDirectory(bottlePath, isMockHomedir)) {
              const cxbottleCandidates = [
                layer.binaryPath ? path.join(path.dirname(layer.binaryPath), 'cxbottle') : '',
                '/Applications/CrossOver.app/Contents/SharedSupport/CrossOver/bin/cxbottle',
                '/Applications/CrossOver Preview.app/Contents/SharedSupport/CrossOver/bin/cxbottle',
              ].filter(Boolean);
              const cxbottleBin =
                cxbottleCandidates.find((p) => fs.existsSync(p)) ||
                (typeof options.execFileFn === 'function' ? cxbottleCandidates[0] : '');

              await fs.promises.mkdir(path.dirname(bottlePath), { recursive: true });
              if (cxbottleBin) {
                try {
                  await runExecFileAsync(
                    execFileFn,
                    cxbottleBin,
                    ['--bottle', bottleName, '--create', '--template', 'win10_64', '--default'],
                    { timeout: 60000, signal: controller.signal }
                  );
                } catch {}
              }
            }
            await ensureCompatibilityLayerReady(
              layer,
              { wineBottleName: bottleName },
              {},
              options
            );
            await sandboxWinePrefixUserFoldersAsync(bottlePath, options);
          } else {
            await fs.promises.mkdir(bottlePath, { recursive: true });
            const sysRegPath = path.join(bottlePath, 'system.reg');
            const sys32Dir = path.join(bottlePath, 'drive_c/windows/system32');

            if (!fs.existsSync(sysRegPath)) {
              const bootEnv = {
                ...process.env,
                WINEPREFIX: bottlePath,
                WINEDLLOVERRIDES: 'mscoree,mshtml=d;winemenubuilder.exe=d',
              };
              try {
                await runExecFileAsync(execFileFn, layer.binaryPath, ['wineboot', '-u'], {
                  timeout: 45000,
                  env: bootEnv,
                  signal: controller.signal,
                });
              } catch {}

              const initTimeoutMs = Number(
                options.bottleInitTimeoutMs ?? (isTestEnvironment(options) ? 200 : 30000)
              );
              const pollStepMs = isTestEnvironment(options) ? 25 : 250;
              const deadline = Date.now() + initTimeoutMs;
              while (Date.now() < deadline) {
                if (controller.signal.aborted) break;
                if (fs.existsSync(sysRegPath) && fs.existsSync(sys32Dir)) break;
                await new Promise((r) => setTimeout(r, pollStepMs));
              }
            }
            await sandboxWinePrefixUserFoldersAsync(bottlePath, options);
          }

          saveSetupWizardState(
            {
              preferredRunnerType: layer.type,
              preferredBottleName: bottleName,
            },
            options
          );
          succeededComponents.push('bottle_default');
          invalidateScanCaches();

          emitEnvironmentSetupProgress(
            {
              ...progressBase,
              phase: 'completed',
              progressPercent: 100,
              message: `Bottle "${bottleName}" is ready and sandboxed.`,
            },
            options
          );
          outcomes.push({
            componentId,
            action: task.action,
            status: 'completed',
            installedPath: bottlePath,
            message: `Bottle "${bottleName}" is ready and sandboxed.`,
          });
          continue;
        }

        // -------------------------------------------------------------------
        // 5. Host & Bottled Storefront Clients
        // -------------------------------------------------------------------
        if (task.action === 'install_client') {
          const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ol-env-setup-'));
          try {
            // A) Host Steam
            if (componentId === 'host_steam') {
              const existing = resolveSteamClientBinaryPath({
                ...options,
                ...explicitHomedirOpt(options),
                platform: hostPlatform,
              });
              if (existing && !options.forceReinstall) {
                succeededComponents.push('host_steam');
                emitEnvironmentSetupProgress(
                  { ...progressBase, phase: 'skipped', message: 'Steam is already installed.' },
                  options
                );
                outcomes.push({
                  componentId,
                  action: task.action,
                  status: 'skipped',
                  installedPath: existing,
                  message: 'Steam is already installed.',
                });
                continue;
              }

              if (hostPlatform === 'darwin') {
                const dmgPath = path.join(tempDir, 'steam.dmg');
                await streamVerifiedDownloadToFile(
                  'https://cdn.fastly.steamstatic.com/client/installer/steam.dmg',
                  dmgPath,
                  { ...progressBase, label: 'Steam for macOS', minFreeBytes: 400 * 1024 * 1024 },
                  options,
                  controller.signal
                );
                emitEnvironmentSetupProgress(
                  {
                    ...progressBase,
                    phase: 'verifying_signature',
                    message: 'Verifying Valve Developer ID signature...',
                  },
                  options
                );
                const targetAppsDir = await resolveTargetMacApplicationsDir(homedir, options);
                const installedPath = await mountVerifyAndInstallDmgApp(
                  dmgPath,
                  targetAppsDir,
                  ['MXGJJ98X76'],
                  /Developer ID Application:\s*Valve/i,
                  { ...options, _componentId: componentId }
                );
                succeededComponents.push('host_steam');
                emitEnvironmentSetupProgress(
                  {
                    ...progressBase,
                    phase: 'completed',
                    progressPercent: 100,
                    message: `Installed Steam to ${installedPath}.`,
                  },
                  options
                );
                outcomes.push({
                  componentId,
                  action: task.action,
                  status: 'completed',
                  installedPath,
                  message: `Installed Steam to ${installedPath}.`,
                });
                continue;
              }

              if (hostPlatform === 'win32') {
                const exePath = path.join(tempDir, 'SteamSetup.exe');
                await streamVerifiedDownloadToFile(
                  'https://cdn.fastly.steamstatic.com/client/installer/SteamSetup.exe',
                  exePath,
                  { ...progressBase, label: 'Steam Installer', minFreeBytes: 500 * 1024 * 1024 },
                  options,
                  controller.signal
                );
                emitEnvironmentSetupProgress(
                  {
                    ...progressBase,
                    phase: 'verifying_signature',
                    message: 'Verifying Valve Authenticode signature...',
                  },
                  options
                );
                await verifyWindowsInstallerSignature(exePath, {
                  ...options,
                  platform: 'win32',
                  kind: 'exe',
                  _componentId: componentId,
                });
                emitEnvironmentSetupProgress(
                  { ...progressBase, phase: 'installing', message: 'Installing Steam silently...' },
                  options
                );
                await runExecFileAsync(execFileFn, exePath, ['/S'], {
                  timeout: 180000,
                  windowsHide: true,
                  signal: controller.signal,
                });
                const installedBin =
                  resolveSteamClientBinaryPath({
                    ...options,
                    ...explicitHomedirOpt(options),
                    platform: 'win32',
                  }) || '';
                succeededComponents.push('host_steam');
                emitEnvironmentSetupProgress(
                  {
                    ...progressBase,
                    phase: 'completed',
                    progressPercent: 100,
                    message: 'Installed Steam Desktop Client.',
                  },
                  options
                );
                outcomes.push({
                  componentId,
                  action: task.action,
                  status: 'completed',
                  ...(installedBin ? { installedPath: installedBin } : {}),
                  message: 'Installed Steam Desktop Client.',
                });
                continue;
              }
            }

            // B) Bottled Windows Steam (macOS)
            if (componentId === 'bottle_steam') {
              const { layer, bottleName, bottlePath } = resolveRunnerAndBottleTarget(
                homedir,
                { runnerType: task.runnerType, bottleName: task.bottleName },
                options
              );
              const existingSteam = resolveBottleSteamExe(bottlePath);
              if (existingSteam && !options.forceReinstall) {
                succeededComponents.push('bottle_steam');
                emitEnvironmentSetupProgress(
                  {
                    ...progressBase,
                    phase: 'skipped',
                    message: `Windows Steam is already installed in "${bottleName}".`,
                  },
                  options
                );
                outcomes.push({
                  componentId,
                  action: task.action,
                  status: 'skipped',
                  installedPath: existingSteam,
                  message: `Windows Steam is already installed in "${bottleName}".`,
                });
                continue;
              }

              const stagedExe = path.join(tempDir, 'SteamSetup.exe');
              await streamVerifiedDownloadToFile(
                'https://cdn.fastly.steamstatic.com/client/installer/SteamSetup.exe',
                stagedExe,
                {
                  ...progressBase,
                  label: 'Windows Steam Installer',
                  minFreeBytes: 600 * 1024 * 1024,
                },
                options,
                controller.signal
              );

              emitEnvironmentSetupProgress(
                {
                  ...progressBase,
                  phase: 'verifying_signature',
                  message: 'Verifying Windows Steam PE & Authenticode signature...',
                },
                options
              );
              await verifyWindowsInstallerSignature(stagedExe, {
                ...options,
                platform: 'darwin',
                kind: 'exe',
                _componentId: componentId,
              });

              const bottleTempDir = path.join(bottlePath, 'drive_c/windows/temp');
              await fs.promises.mkdir(bottleTempDir, { recursive: true });
              const bottleSetupExe = path.join(bottleTempDir, 'SteamSetup.exe');
              await fs.promises.copyFile(stagedExe, bottleSetupExe);

              emitEnvironmentSetupProgress(
                {
                  ...progressBase,
                  phase: 'installing',
                  message: `Installing Windows Steam inside bottle "${bottleName}"...`,
                },
                options
              );
              try {
                const installedSteamExe = await runBottleInstallerAndWait(
                  layer,
                  bottleName,
                  bottlePath,
                  [bottleSetupExe, '/S'],
                  () => resolveBottleSteamExe(bottlePath),
                  options,
                  controller.signal
                );
                succeededComponents.push('bottle_steam');
                emitEnvironmentSetupProgress(
                  {
                    ...progressBase,
                    phase: 'completed',
                    progressPercent: 100,
                    message: `Installed Windows Steam in bottle "${bottleName}".`,
                  },
                  options
                );
                outcomes.push({
                  componentId,
                  action: task.action,
                  status: 'completed',
                  installedPath: installedSteamExe,
                  message: `Installed Windows Steam in bottle "${bottleName}".`,
                });
              } finally {
                try {
                  await fs.promises.rm(bottleSetupExe, { force: true });
                } catch {}
              }
              continue;
            }

            // C) Host GOG Galaxy
            if (componentId === 'host_gog') {
              const existingGog = resolveGogGalaxyClientBinaryPath({
                ...options,
                ...explicitHomedirOpt(options),
                platform: hostPlatform,
              });
              if (existingGog && !options.forceReinstall) {
                succeededComponents.push('host_gog');
                emitEnvironmentSetupProgress(
                  {
                    ...progressBase,
                    phase: 'skipped',
                    message: 'GOG Galaxy is already installed.',
                  },
                  options
                );
                outcomes.push({
                  componentId,
                  action: task.action,
                  status: 'skipped',
                  installedPath: existingGog,
                  message: 'GOG Galaxy is already installed.',
                });
                continue;
              }

              if (hostPlatform === 'darwin') {
                const pkgPath = path.join(tempDir, 'GOG_Galaxy_2.0.pkg');
                await downloadGogGalaxyInstallerToFile(
                  'osx',
                  pkgPath,
                  { ...progressBase, label: 'GOG Galaxy for macOS', minFreeBytes: 600 * 1024 * 1024 },
                  options,
                  controller.signal
                );
                emitEnvironmentSetupProgress(
                  {
                    ...progressBase,
                    phase: 'verifying_signature',
                    message: 'Verifying GOG Apple Installer package signature...',
                  },
                  options
                );
                await verifyMacPkgSignature(pkgPath, {
                  ...options,
                  _componentId: componentId,
                });

                emitEnvironmentSetupProgress(
                  {
                    ...progressBase,
                    phase: 'installing',
                    message: 'Opening macOS Installer for GOG Galaxy (complete prompt to finish)...',
                  },
                  options
                );
                await runExecFileAsync(execFileFn, '/usr/bin/open', ['-W', pkgPath], {
                  timeout: 600000,
                  signal: controller.signal,
                });

                const postBin = resolveGogGalaxyClientBinaryPath({
                  ...options,
                  ...explicitHomedirOpt(options),
                  platform: 'darwin',
                });
                if (!postBin && !isTestEnvironment(options)) {
                  throw new Error(
                    'macOS Installer closed before GOG Galaxy.app was installed.'
                  );
                }
                try {
                  syncGogFirstPartyLauncher(options);
                } catch {}
                succeededComponents.push('host_gog');
                emitEnvironmentSetupProgress(
                  {
                    ...progressBase,
                    phase: 'completed',
                    progressPercent: 100,
                    message: 'Installed GOG Galaxy for macOS.',
                  },
                  options
                );
                outcomes.push({
                  componentId,
                  action: task.action,
                  status: 'completed',
                  ...(postBin ? { installedPath: postBin } : {}),
                  message: 'Installed GOG Galaxy for macOS.',
                });
                continue;
              }

              if (hostPlatform === 'win32') {
                const exePath = path.join(tempDir, 'GOG_Galaxy_Setup.exe');
                const dlRes = await downloadGogGalaxyInstallerToFile(
                  'windows',
                  exePath,
                  { ...progressBase, label: 'GOG Galaxy', minFreeBytes: 600 * 1024 * 1024 },
                  options,
                  controller.signal
                );
                emitEnvironmentSetupProgress(
                  {
                    ...progressBase,
                    phase: 'verifying_signature',
                    message: 'Verifying GOG Authenticode signature...',
                  },
                  options
                );
                await verifyWindowsInstallerSignature(exePath, {
                  ...options,
                  ...(dlRes.isStubWebInstaller && options.minInstallerBytes === undefined
                    ? { minInstallerBytes: 128 * 1024 }
                    : {}),
                  platform: 'win32',
                  kind: 'exe',
                  _componentId: componentId,
                });
                emitEnvironmentSetupProgress(
                  {
                    ...progressBase,
                    phase: 'installing',
                    message: 'Installing GOG Galaxy silently...',
                  },
                  options
                );
                await runExecFileAsync(
                  execFileFn,
                  exePath,
                  ['/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART'],
                  { timeout: 300000, windowsHide: true, signal: controller.signal }
                );
                try {
                  syncGogFirstPartyLauncher(options);
                } catch {}
                const installedGog =
                  resolveGogGalaxyClientBinaryPath({
                    ...options,
                    ...explicitHomedirOpt(options),
                    platform: 'win32',
                  }) || '';
                succeededComponents.push('host_gog');
                emitEnvironmentSetupProgress(
                  {
                    ...progressBase,
                    phase: 'completed',
                    progressPercent: 100,
                    message: 'Installed GOG Galaxy.',
                  },
                  options
                );
                outcomes.push({
                  componentId,
                  action: task.action,
                  status: 'completed',
                  ...(installedGog ? { installedPath: installedGog } : {}),
                  message: 'Installed GOG Galaxy.',
                });
                continue;
              }
            }

            // D) Bottled GOG Galaxy (macOS)
            if (componentId === 'bottle_gog') {
              const { layer, bottleName, bottlePath } = resolveRunnerAndBottleTarget(
                homedir,
                { runnerType: task.runnerType, bottleName: task.bottleName },
                options
              );
              const existingGog = resolveBottleGogGalaxyExe(bottlePath);
              if (existingGog && !options.forceReinstall) {
                succeededComponents.push('bottle_gog');
                emitEnvironmentSetupProgress(
                  {
                    ...progressBase,
                    phase: 'skipped',
                    message: `GOG Galaxy is already installed in "${bottleName}".`,
                  },
                  options
                );
                outcomes.push({
                  componentId,
                  action: task.action,
                  status: 'skipped',
                  installedPath: existingGog,
                  message: `GOG Galaxy is already installed in "${bottleName}".`,
                });
                continue;
              }

              const stagedExe = path.join(tempDir, 'GOG_Galaxy_Setup.exe');
              const dlRes = await downloadGogGalaxyInstallerToFile(
                'windows',
                stagedExe,
                {
                  ...progressBase,
                  label: 'Windows GOG Galaxy Installer',
                  minFreeBytes: 650 * 1024 * 1024,
                },
                options,
                controller.signal
              );

              emitEnvironmentSetupProgress(
                {
                  ...progressBase,
                  phase: 'verifying_signature',
                  message: 'Verifying GOG Galaxy PE & Authenticode signature...',
                },
                options
              );
              await verifyWindowsInstallerSignature(stagedExe, {
                ...options,
                ...(dlRes.isStubWebInstaller && options.minInstallerBytes === undefined
                  ? { minInstallerBytes: 128 * 1024 }
                  : {}),
                platform: 'darwin',
                kind: 'exe',
                _componentId: componentId,
              });

              const bottleTempDir = path.join(bottlePath, 'drive_c/windows/temp');
              await fs.promises.mkdir(bottleTempDir, { recursive: true });
              const bottleSetupExe = path.join(bottleTempDir, 'GOG_Galaxy_Setup.exe');
              await fs.promises.copyFile(stagedExe, bottleSetupExe);

              emitEnvironmentSetupProgress(
                {
                  ...progressBase,
                  phase: 'installing',
                  message: `Installing GOG Galaxy inside bottle "${bottleName}"...`,
                },
                options
              );
              try {
                const installedGogExe = await runBottleInstallerAndWait(
                  layer,
                  bottleName,
                  bottlePath,
                  [
                    'C:\\windows\\temp\\GOG_Galaxy_Setup.exe',
                    '/VERYSILENT',
                    '/SUPPRESSMSGBOXES',
                    '/NORESTART',
                  ],
                  () => resolveBottleGogGalaxyExe(bottlePath),
                  options,
                  controller.signal
                );
                try {
                  syncGogFirstPartyLauncher(options);
                } catch {}
                succeededComponents.push('bottle_gog');
                emitEnvironmentSetupProgress(
                  {
                    ...progressBase,
                    phase: 'completed',
                    progressPercent: 100,
                    message: `Installed Windows GOG Galaxy in bottle "${bottleName}".`,
                  },
                  options
                );
                outcomes.push({
                  componentId,
                  action: task.action,
                  status: 'completed',
                  installedPath: installedGogExe,
                  message: `Installed Windows GOG Galaxy in bottle "${bottleName}".`,
                });
              } finally {
                try {
                  await fs.promises.rm(bottleSetupExe, { force: true });
                } catch {}
              }
              continue;
            }

            // E) Host Epic Games Launcher
            if (componentId === 'host_epic') {
              const existingEpic = resolveEpicClientBinaryPath({
                ...options,
                ...explicitHomedirOpt(options),
                platform: hostPlatform,
              });
              if (existingEpic && !options.forceReinstall) {
                succeededComponents.push('host_epic');
                emitEnvironmentSetupProgress(
                  {
                    ...progressBase,
                    phase: 'skipped',
                    message: 'Epic Games Launcher is already installed.',
                  },
                  options
                );
                outcomes.push({
                  componentId,
                  action: task.action,
                  status: 'skipped',
                  installedPath: existingEpic,
                  message: 'Epic Games Launcher is already installed.',
                });
                continue;
              }

              if (hostPlatform === 'darwin') {
                const dmgPath = path.join(tempDir, 'EpicGamesLauncher.dmg');
                await streamVerifiedDownloadToFile(
                  'https://launcher-public-service-prod06.ol.epicgames.com/launcher/api/installer/download/EpicGamesLauncher.dmg',
                  dmgPath,
                  {
                    ...progressBase,
                    label: 'Epic Games Launcher for macOS',
                    minFreeBytes: 1200 * 1024 * 1024,
                  },
                  options,
                  controller.signal
                );
                emitEnvironmentSetupProgress(
                  {
                    ...progressBase,
                    phase: 'verifying_signature',
                    message: 'Verifying Epic Games Developer ID signature...',
                  },
                  options
                );
                const targetAppsDir = await resolveTargetMacApplicationsDir(homedir, options);
                const installedPath = await mountVerifyAndInstallDmgApp(
                  dmgPath,
                  targetAppsDir,
                  ['96DBZ92D3Y'],
                  /Developer ID Application:\s*Epic Games/i,
                  { ...options, _componentId: componentId }
                );
                try {
                  syncEpicFirstPartyLauncher(options);
                } catch {}
                succeededComponents.push('host_epic');
                emitEnvironmentSetupProgress(
                  {
                    ...progressBase,
                    phase: 'completed',
                    progressPercent: 100,
                    message: `Installed Epic Games Launcher to ${installedPath}.`,
                  },
                  options
                );
                outcomes.push({
                  componentId,
                  action: task.action,
                  status: 'completed',
                  installedPath,
                  message: `Installed Epic Games Launcher to ${installedPath}.`,
                });
                continue;
              }

              if (hostPlatform === 'win32') {
                const msiPath = path.join(tempDir, 'EpicGamesLauncherInstaller.msi');
                await streamVerifiedDownloadToFile(
                  'https://launcher-public-service-prod06.ol.epicgames.com/launcher/api/installer/download/EpicGamesLauncherInstaller.msi',
                  msiPath,
                  {
                    ...progressBase,
                    label: 'Epic Games Launcher Installer',
                    minFreeBytes: 1200 * 1024 * 1024,
                  },
                  options,
                  controller.signal
                );
                emitEnvironmentSetupProgress(
                  {
                    ...progressBase,
                    phase: 'verifying_signature',
                    message: 'Verifying Epic Games Authenticode signature...',
                  },
                  options
                );
                await verifyWindowsInstallerSignature(msiPath, {
                  ...options,
                  platform: 'win32',
                  kind: 'msi',
                  _componentId: componentId,
                });
                emitEnvironmentSetupProgress(
                  {
                    ...progressBase,
                    phase: 'installing',
                    message: 'Installing Epic Games Launcher silently...',
                  },
                  options
                );
                await runExecFileAsync(
                  execFileFn,
                  'msiexec.exe',
                  ['/i', msiPath, '/qn', '/norestart'],
                  { timeout: 300000, windowsHide: true, signal: controller.signal }
                );
                try {
                  syncEpicFirstPartyLauncher(options);
                } catch {}
                const installedEpic =
                  resolveEpicClientBinaryPath({
                    ...options,
                    ...explicitHomedirOpt(options),
                    platform: 'win32',
                  }) || '';
                succeededComponents.push('host_epic');
                emitEnvironmentSetupProgress(
                  {
                    ...progressBase,
                    phase: 'completed',
                    progressPercent: 100,
                    message: 'Installed Epic Games Launcher.',
                  },
                  options
                );
                outcomes.push({
                  componentId,
                  action: task.action,
                  status: 'completed',
                  ...(installedEpic ? { installedPath: installedEpic } : {}),
                  message: 'Installed Epic Games Launcher.',
                });
                continue;
              }
            }

            // F) Bottled Epic Games Launcher (macOS)
            if (componentId === 'bottle_epic') {
              const { layer, bottleName, bottlePath } = resolveRunnerAndBottleTarget(
                homedir,
                { runnerType: task.runnerType, bottleName: task.bottleName },
                options
              );
              const existingEpic = resolveBottleEpicLauncherExe(bottlePath);
              if (existingEpic && !options.forceReinstall) {
                succeededComponents.push('bottle_epic');
                emitEnvironmentSetupProgress(
                  {
                    ...progressBase,
                    phase: 'skipped',
                    message: `Epic Games Launcher is already installed in "${bottleName}".`,
                  },
                  options
                );
                outcomes.push({
                  componentId,
                  action: task.action,
                  status: 'skipped',
                  installedPath: existingEpic,
                  message: `Epic Games Launcher is already installed in "${bottleName}".`,
                });
                continue;
              }

              const stagedMsi = path.join(tempDir, 'EpicGamesLauncherInstaller.msi');
              await streamVerifiedDownloadToFile(
                'https://launcher-public-service-prod06.ol.epicgames.com/launcher/api/installer/download/EpicGamesLauncherInstaller.msi',
                stagedMsi,
                {
                  ...progressBase,
                  label: 'Windows Epic Games Launcher MSI',
                  minFreeBytes: 1200 * 1024 * 1024,
                },
                options,
                controller.signal
              );

              emitEnvironmentSetupProgress(
                {
                  ...progressBase,
                  phase: 'verifying_signature',
                  message: 'Verifying Epic Games MSI package header...',
                },
                options
              );
              await verifyWindowsInstallerSignature(stagedMsi, {
                ...options,
                platform: 'darwin',
                kind: 'msi',
                _componentId: componentId,
              });

              const bottleTempDir = path.join(bottlePath, 'drive_c/windows/temp');
              await fs.promises.mkdir(bottleTempDir, { recursive: true });
              const bottleMsiPath = path.join(bottleTempDir, 'EpicGamesLauncherInstaller.msi');
              await fs.promises.copyFile(stagedMsi, bottleMsiPath);

              emitEnvironmentSetupProgress(
                {
                  ...progressBase,
                  phase: 'installing',
                  message: `Installing Epic Games Launcher inside bottle "${bottleName}"...`,
                },
                options
              );
              try {
                const installedEpicExe = await runBottleInstallerAndWait(
                  layer,
                  bottleName,
                  bottlePath,
                  [
                    'msiexec',
                    '/i',
                    'C:\\windows\\temp\\EpicGamesLauncherInstaller.msi',
                    '/qn',
                    '/norestart',
                  ],
                  () => resolveBottleEpicLauncherExe(bottlePath),
                  options,
                  controller.signal
                );
                try {
                  syncEpicFirstPartyLauncher(options);
                } catch {}
                succeededComponents.push('bottle_epic');
                emitEnvironmentSetupProgress(
                  {
                    ...progressBase,
                    phase: 'completed',
                    progressPercent: 100,
                    message: `Installed Windows Epic Games Launcher in bottle "${bottleName}".`,
                  },
                  options
                );
                outcomes.push({
                  componentId,
                  action: task.action,
                  status: 'completed',
                  installedPath: installedEpicExe,
                  message: `Installed Windows Epic Games Launcher in bottle "${bottleName}".`,
                });
              } finally {
                try {
                  await fs.promises.rm(bottleMsiPath, { force: true });
                } catch {}
              }
              continue;
            }

            throw new Error(`Unsupported client componentId: ${componentId}`);
          } finally {
            try {
              await fs.promises.rm(tempDir, { recursive: true, force: true });
            } catch {}
          }
        }

        // -------------------------------------------------------------------
        // 6. Sync First-Party Manifests
        // -------------------------------------------------------------------
        if (task.action === 'sync_first_party_manifests') {
          emitEnvironmentSetupProgress(
            {
              ...progressBase,
              phase: 'installing',
              message: 'Synchronizing installed game manifests with storefront clients...',
            },
            options
          );
          try {
            syncGogFirstPartyLauncher(options);
          } catch {}
          try {
            syncEpicFirstPartyLauncher(options);
          } catch {}
          invalidateScanCaches();

          emitEnvironmentSetupProgress(
            {
              ...progressBase,
              phase: 'completed',
              progressPercent: 100,
              message: 'Synchronized first-party launcher manifests.',
            },
            options
          );
          outcomes.push({
            componentId,
            action: task.action,
            status: 'completed',
            message: 'Synchronized first-party launcher manifests.',
          });
          continue;
        }

        throw new Error(`Unknown setup task action: ${task.action}`);
      } catch (/** @type {any} */ taskErr) {
        const isAbort =
          taskErr?.name === 'AbortError' || controller.signal.aborted;
        const errMsg = taskErr instanceof Error ? taskErr.message : String(taskErr);

        if (isAbort) {
          wasCancelled = true;
          emitEnvironmentSetupProgress(
            {
              ...progressBase,
              phase: 'cancelled',
              message: 'Task cancelled.',
            },
            options
          );
          outcomes.push({
            componentId,
            action: task.action,
            status: 'cancelled',
            message: 'Cancelled by user.',
          });
        } else {
          diagLog.warn('environmentProvisioner.taskFailed', taskErr, {
            runId,
            componentId,
            action: task.action,
          });
          emitEnvironmentSetupProgress(
            {
              ...progressBase,
              phase: 'failed',
              message: errMsg,
              error: errMsg,
            },
            options
          );
          outcomes.push({
            componentId,
            action: task.action,
            status: 'failed',
            message: errMsg,
            error: errMsg,
          });
        }
      }
    }
  } finally {
    activeSetupRuns.delete(runId);
  }

  if (succeededComponents.length > 0) {
    try {
      saveSetupWizardState(
        {
          addConfiguredComponents: succeededComponents,
          lastHealthCheckAt: new Date().toISOString(),
        },
        options
      );
    } catch {}
  }

  invalidateScanCaches();
  const snapshot = await probeEnvironmentHealth({
    ...options,
    ...(Array.isArray(payload?.connectedStorefronts)
      ? { connectedStorefronts: payload.connectedStorefronts }
      : {}),
  });

  const hasFailures = outcomes.some((o) => o.status === 'failed');
  return {
    success: !hasFailures && !wasCancelled,
    runId,
    ...(wasCancelled ? { cancelled: true } : {}),
    outcomes,
    snapshot,
    ...(hasFailures
      ? {
          error: outcomes
            .filter((o) => o.status === 'failed')
            .map((o) => o.error || o.message)
            .join('; '),
        }
      : {}),
  };
}

/**
 * Cancel an active guided client login watcher by `targetId` (or all active watchers if omitted).
 *
 * @param {ClientLoginTargetId | string} [targetId]
 * @param {Record<string, any>} [_options]
 * @returns {{ success: boolean, targetId?: string, cancelled: boolean }}
 */
function cancelGuidedClientLogin(targetId, _options = {}) {
  if (typeof targetId === 'string' && targetId.trim()) {
    const clean = targetId.trim();
    const entry = activeGuidedLogins.get(clean);
    if (!entry) {
      return { success: false, targetId: clean, cancelled: false };
    }
    entry.abortController.abort();
    return { success: true, targetId: clean, cancelled: true };
  }

  let any = false;
  for (const [, entry] of activeGuidedLogins.entries()) {
    entry.abortController.abort();
    any = true;
  }
  return { success: any, cancelled: any };
}

/**
 * Gracefully shut down a foreground storefront client after guided login succeeds so 0 MB
 * background RAM remains while preserving its newly written login session on disk.
 *
 * @param {ClientLoginTargetId} targetId
 * @param {ClientAuthProbeState} probeState
 * @param {'darwin' | 'win32' | 'linux'} hostPlatform
 * @param {any} bottleLayer
 * @param {Record<string, any>} options
 * @returns {Promise<boolean>}
 */
async function closeForegroundClientGracefully(
  targetId,
  probeState,
  hostPlatform,
  bottleLayer,
  options = {}
) {
  if (typeof options.closeClientFn === 'function') {
    await options.closeClientFn({ targetId, probeState, hostPlatform, bottleLayer });
    return true;
  }

  const execFileFn = getExecFileFn(options);
  try {
    if (probeState.scope === 'bottle' && probeState.bottlePath && bottleLayer?.binaryPath) {
      const bottleEnv = {
        ...process.env,
        WINEPREFIX: probeState.bottlePath,
        ...(probeState.bottleName ? { CX_BOTTLE: probeState.bottleName } : {}),
      };
      if (targetId === 'bottle_steam' && probeState.binaryPath) {
        await runExecFileAsync(
          execFileFn,
          bottleLayer.binaryPath,
          [probeState.binaryPath, '-shutdown'],
          { timeout: 15000, env: bottleEnv }
        ).catch(() => {});
        await shutdownWinePrefix(bottleLayer.binaryPath, probeState.bottlePath, 5000, {
          bottleName: probeState.bottleName,
          execFileFn,
        }).catch(() => {});
        return true;
      }
      if (targetId === 'bottle_gog') {
        if (probeState.binaryPath) {
          await runExecFileAsync(
            execFileFn,
            bottleLayer.binaryPath,
            [probeState.binaryPath, '/command=shutdown'],
            { timeout: 8000, env: bottleEnv }
          ).catch(() => {});
          const settleMs = isTestEnvironment(options) ? 10 : 1200;
          await new Promise((r) => setTimeout(r, settleMs));
        }
        for (const gogExe of ['GalaxyClient.exe', 'GalaxyCommunication.exe']) {
          await runExecFileAsync(
            execFileFn,
            bottleLayer.binaryPath,
            ['taskkill', '/F', '/T', '/IM', gogExe],
            { timeout: 6000, env: bottleEnv }
          ).catch(() => {});
        }
        await shutdownWinePrefix(bottleLayer.binaryPath, probeState.bottlePath, 5000, {
          bottleName: probeState.bottleName,
          execFileFn,
        }).catch(() => {});
        return true;
      }
      await runExecFileAsync(
        execFileFn,
        bottleLayer.binaryPath,
        ['taskkill', '/IM', 'EpicGamesLauncher.exe'],
        { timeout: 5000, env: bottleEnv }
      ).catch(() => {});
      await runExecFileAsync(
        execFileFn,
        bottleLayer.binaryPath,
        ['taskkill', '/F', '/T', '/IM', 'EpicGamesLauncher.exe'],
        { timeout: 6000, env: bottleEnv }
      ).catch(() => {});
      await shutdownWinePrefix(bottleLayer.binaryPath, probeState.bottlePath, 5000, {
        bottleName: probeState.bottleName,
        execFileFn,
      }).catch(() => {});
      return true;
    }

    if (hostPlatform === 'darwin') {
      const macAppName =
        targetId === 'host_steam'
          ? 'Steam'
          : targetId === 'host_gog'
            ? 'GOG Galaxy'
            : 'Epic Games Launcher';
      await runExecFileAsync(
        execFileFn,
        '/usr/bin/osascript',
        ['-e', `quit app "${macAppName}"`],
        { timeout: 10000 }
      ).catch(() => {});
      return true;
    }

    if (hostPlatform === 'win32') {
      if (targetId === 'host_steam' && probeState.binaryPath) {
        await runExecFileAsync(execFileFn, probeState.binaryPath, ['-shutdown'], {
          timeout: 12000,
          windowsHide: true,
        }).catch(() => {});
        return true;
      }
      if (targetId === 'host_gog') {
        if (probeState.binaryPath) {
          await runExecFileAsync(execFileFn, probeState.binaryPath, ['/command=shutdown'], {
            timeout: 8000,
            windowsHide: true,
          }).catch(() => {});
          const settleMs = isTestEnvironment(options) ? 10 : 1200;
          await new Promise((r) => setTimeout(r, settleMs));
        }
        for (const winGogExe of ['GalaxyClient.exe', 'GalaxyCommunication.exe']) {
          await runExecFileAsync(execFileFn, 'taskkill.exe', ['/F', '/T', '/IM', winGogExe], {
            timeout: 6000,
            windowsHide: true,
          }).catch(() => {});
        }
        return true;
      }
      await runExecFileAsync(execFileFn, 'taskkill.exe', ['/IM', 'EpicGamesLauncher.exe'], {
        timeout: 5000,
        windowsHide: true,
      }).catch(() => {});
      await runExecFileAsync(
        execFileFn,
        'taskkill.exe',
        ['/F', '/T', '/IM', 'EpicGamesLauncher.exe'],
        {
          timeout: 6000,
          windowsHide: true,
        }
      ).catch(() => {});
      return true;
    }
  } catch {}
  return false;
}

/**
 * Launch a storefront client in foreground interactive sign-in mode (WITHOUT `-silent`),
 * watch its local session files until sign-in completes, sync first-party manifests, and
 * optionally close the foreground client window cleanly afterward.
 *
 * @param {StartGuidedClientLoginRequest} payload
 * @param {Record<string, any>} [options]
 * @returns {Promise<GuidedClientLoginResult>}
 */
async function startGuidedClientLogin(payload, options = {}) {
  const targetId = /** @type {ClientLoginTargetId} */ (String(payload?.targetId || '').trim());
  if (!VALID_CLIENT_LOGIN_TARGETS.has(targetId)) {
    throw new Error(`Invalid guided login targetId: "${targetId}"`);
  }

  const rawPlatform = String(options.platform || process.platform).toLowerCase();
  /** @type {'darwin' | 'win32' | 'linux'} */
  const hostPlatform =
    rawPlatform === 'win32' ? 'win32' : rawPlatform === 'linux' ? 'linux' : 'darwin';
  const { homedir } = resolveIsolatedHomedirAndUserData(options);

  const probeOpts = {
    ...options,
    ...explicitHomedirOpt(options),
    platform: hostPlatform,
    ...(payload?.runnerType ? { preferredRunnerType: payload.runnerType } : {}),
    ...(payload?.bottleName ? { preferredBottleName: payload.bottleName } : {}),
  };

  const initialStates = await probeClientLoginStates(probeOpts);
  const initialState = initialStates[targetId];
  const forceInteractive =
    payload?.forceInteractiveLogin === true || options.forceInteractiveLogin === true;

  if (
    initialState.authenticated &&
    initialState.accountMatchesOneLauncher !== false &&
    !forceInteractive
  ) {
    return {
      success: true,
      targetId,
      authenticated: true,
      autoClosedClient: false,
      probeState: initialState,
      message: 'Already signed in.',
    };
  }

  if (!initialState.installed || !initialState.binaryPath) {
    return {
      success: false,
      targetId,
      authenticated: false,
      probeState: initialState,
      message: `${initialState.label} is not installed yet.`,
      error: 'Client not installed.',
    };
  }

  // Cancel any existing guided login session for this target
  cancelGuidedClientLogin(targetId);

  const abortController = new AbortController();
  const runId = `guided-login-${targetId}-${Date.now()}`;
  activeGuidedLogins.set(targetId, { abortController, runId });

  /** @type {any} */
  let bottleLayer = null;
  if (initialState.scope === 'bottle') {
    const runners = detectCompatibilityLayers({
      ...options,
      ...explicitHomedirOpt(options),
    });
    bottleLayer =
      (payload?.runnerType && runners.find((r) => r.type === payload.runnerType)) ||
      runners[0] ||
      null;
    if (!bottleLayer?.binaryPath) {
      activeGuidedLogins.delete(targetId);
      return {
        success: false,
        targetId,
        authenticated: false,
        probeState: initialState,
        message: 'No compatibility runner available to launch bottled client.',
        error: 'Compatibility runner missing.',
      };
    }
  }

  try {
    // Launch client in interactive foreground login mode (WITHOUT -silent)
    if (typeof options.spawnClientFn === 'function') {
      await options.spawnClientFn({
        targetId,
        probeState: initialState,
        hostPlatform,
        bottleLayer,
      });
    } else if (initialState.scope === 'bottle' && bottleLayer?.binaryPath) {
      const spawnImpl = typeof options.spawnFn === 'function' ? options.spawnFn : spawn;
      const child = spawnImpl(bottleLayer.binaryPath, [initialState.binaryPath], {
        detached: true,
        stdio: 'ignore',
        env: {
          ...process.env,
          ...(initialState.bottlePath ? { WINEPREFIX: initialState.bottlePath } : {}),
          ...(initialState.bottleName ? { CX_BOTTLE: initialState.bottleName } : {}),
        },
      });
      if (child && typeof child.unref === 'function') child.unref();
    } else if (hostPlatform === 'darwin') {
      const execFileFn = getExecFileFn(options);
      const appBundle = resolveTargetMacAppBundlePath(initialState.binaryPath);
      await runExecFileAsync(
        execFileFn,
        '/usr/bin/open',
        appBundle ? ['-a', appBundle] : [initialState.binaryPath],
        { timeout: 15000 }
      );
    } else {
      const spawnImpl = typeof options.spawnFn === 'function' ? options.spawnFn : spawn;
      const child = spawnImpl(initialState.binaryPath, [], {
        detached: true,
        stdio: 'ignore',
        windowsHide: false,
      });
      if (child && typeof child.unref === 'function') child.unref();
    }

    if (
      forceInteractive &&
      initialState.authenticated &&
      initialState.accountMatchesOneLauncher !== false
    ) {
      return {
        success: true,
        targetId,
        authenticated: true,
        autoClosedClient: false,
        probeState: initialState,
        message: `Opened ${initialState.label} in foreground to verify or switch accounts.`,
      };
    }

    emitEnvironmentSetupProgress(
      {
        runId,
        componentId: targetId,
        stepIndex: 0,
        totalSteps: 1,
        phase: 'guided_login_waiting',
        message: `Waiting for sign-in to ${initialState.label}...`,
      },
      options
    );

    const pollIntervalMs = Number(options.pollIntervalMs || 1200);
    const timeoutMs = Number(payload?.timeoutMs || options.timeoutMs || 600000);
    const deadline = Date.now() + timeoutMs;
    let latestState = initialState;

    while (Date.now() < deadline) {
      if (abortController.signal.aborted) {
        return {
          success: false,
          targetId,
          authenticated: false,
          cancelled: true,
          probeState: latestState,
          message: `Cancelled sign-in watcher for ${initialState.label}.`,
        };
      }

      await new Promise((resolve) => {
        const timer = setTimeout(resolve, pollIntervalMs);
        abortController.signal.addEventListener(
          'abort',
          () => {
            clearTimeout(timer);
            resolve(undefined);
          },
          { once: true }
        );
      });

      if (abortController.signal.aborted) {
        return {
          success: false,
          targetId,
          authenticated: false,
          cancelled: true,
          probeState: latestState,
          message: `Cancelled sign-in watcher for ${initialState.label}.`,
        };
      }

      const states = await probeClientLoginStates(probeOpts);
      latestState = states[targetId];

      if (latestState.authenticated && latestState.accountMatchesOneLauncher !== false) {
        emitEnvironmentSetupProgress(
          {
            runId,
            componentId: targetId,
            stepIndex: 0,
            totalSteps: 1,
            phase: 'guided_login_detected',
            progressPercent: 100,
            message: `Sign-in detected for ${latestState.label}!`,
          },
          options
        );

        try {
          if (latestState.storefrontId === 'gog') {
            syncGogFirstPartyLauncher(options);
          } else if (latestState.storefrontId === 'epic') {
            syncEpicFirstPartyLauncher(options);
          }
        } catch {}
        invalidateScanCaches();

        let autoClosedClient = false;
        if (payload?.autoCloseOnSuccess !== false) {
          const defaultFlushMs = isTestEnvironment(options)
            ? 20
            : latestState.scope === 'bottle'
              ? 4500
              : 2500;
          const flushMs = Number(options.postLoginFlushDelayMs ?? defaultFlushMs);
          if (flushMs > 0) {
            await new Promise((resolve) => {
              if (abortController.signal.aborted) {
                resolve(undefined);
                return;
              }
              const onAbort = () => {
                clearTimeout(timer);
                resolve(undefined);
              };
              const timer = setTimeout(() => {
                abortController.signal.removeEventListener('abort', onAbort);
                resolve(undefined);
              }, flushMs);
              abortController.signal.addEventListener('abort', onAbort, { once: true });
            });
          }
          if (abortController.signal.aborted) {
            emitEnvironmentSetupProgress(
              {
                runId,
                componentId: targetId,
                stepIndex: 0,
                totalSteps: 1,
                phase: 'cancelled',
                message: `Cancelled sign-in watcher for ${initialState.label}.`,
              },
              options
            );
            return {
              success: false,
              targetId,
              authenticated: false,
              cancelled: true,
              probeState: latestState,
              message: `Cancelled sign-in watcher for ${initialState.label}.`,
            };
          }
          autoClosedClient = await closeForegroundClientGracefully(
            targetId,
            latestState,
            hostPlatform,
            bottleLayer,
            options
          );
        }

        return {
          success: true,
          targetId,
          authenticated: true,
          autoClosedClient,
          probeState: latestState,
          message: `Signed into ${latestState.label}${latestState.detectedAccountLabel ? ` as ${latestState.detectedAccountLabel}` : ''}.`,
        };
      }
    }

    return {
      success: false,
      targetId,
      authenticated: false,
      timedOut: true,
      probeState: latestState,
      message: `Timed out waiting for sign-in to ${initialState.label}.`,
      error: 'Guided login timed out.',
    };
  } finally {
    const active = activeGuidedLogins.get(targetId);
    if (active && active.runId === runId) {
      activeGuidedLogins.delete(targetId);
    }
  }
}

/** @type {Promise<{ installed: boolean, alreadyReady: boolean, error?: string }> | null} */
let inFlightBackgroundRosettaPromise = null;

/**
 * Fast non-mutating check for Apple Silicon Rosetta 2 runtime binaries.
 *
 * @param {Record<string, any>} [options]
 * @returns {Promise<boolean>}
 */
async function isRosetta2InstalledFast(options = {}) {
  const rawPlatform = String(options.platform || process.platform).toLowerCase();
  const hostArch = String(options.arch || process.arch || 'arm64');
  if (rawPlatform !== 'darwin' || hostArch !== 'arm64') {
    return true;
  }
  if (typeof options.rosettaInstalled === 'boolean') {
    return options.rosettaInstalled;
  }
  const { homedir } = resolveIsolatedHomedirAndUserData(options);
  const rosettaPaths =
    options.homedir && options.allowSystemRosettaInTest !== true
      ? [
          path.join(homedir, 'Library/Apple/usr/libexec/oah/libRosettaRuntime'),
          path.join(homedir, 'Library/Apple/usr/share/rosetta/rosetta'),
        ]
      : [
          '/Library/Apple/usr/libexec/oah/libRosettaRuntime',
          '/Library/Apple/usr/share/rosetta/rosetta',
        ];
  for (const candidate of rosettaPaths) {
    try {
      await fs.promises.access(candidate, fs.constants.F_OK);
      return true;
    } catch {}
  }
  return false;
}

/**
 * Automatically check for and silently install Apple Rosetta 2 in the background on Apple Silicon
 * Macs (`darwin` `arm64`) if missing. Single-flight deduplicated for live system invocations so
 * startup, health probes, and provisioning never spawn duplicate `softwareupdate` processes.
 *
 * @param {Record<string, any>} [options]
 * @returns {Promise<{ installed: boolean, alreadyReady: boolean, error?: string }>}
 */
async function ensureRosetta2InBackground(options = {}) {
  const rawPlatform = String(options.platform || process.platform).toLowerCase();
  const hostArch = String(options.arch || process.arch || 'arm64');
  if (rawPlatform !== 'darwin' || hostArch !== 'arm64') {
    return { installed: false, alreadyReady: true };
  }

  const hasInjectedExec =
    typeof options.execFileImpl === 'function' || typeof options.execFileFn === 'function';
  if (
    isTestEnvironment() &&
    !hasInjectedExec &&
    options.allowBackgroundRosettaInTest !== true
  ) {
    return { installed: false, alreadyReady: true };
  }

  const alreadyReady = await isRosetta2InstalledFast(options);
  if (alreadyReady && !options.forceReinstall) {
    return { installed: true, alreadyReady: true };
  }

  const isSystemSingletonCall = !hasInjectedExec && !options.homedir && !options.signal;
  if (isSystemSingletonCall && inFlightBackgroundRosettaPromise) {
    return inFlightBackgroundRosettaPromise;
  }

  const runInstall = async () => {
    try {
      const execFileFn = getExecFileFn(options);
      diagLog.info(
        'environmentProvisioner',
        'Installing Apple Rosetta 2 in background via softwareupdate',
        {},
        options
      );
      await runExecFileAsync(
        execFileFn,
        '/usr/sbin/softwareupdate',
        ['--install-rosetta', '--agree-to-license'],
        {
          timeout: 300000,
          ...(options.signal ? { signal: options.signal } : {}),
        }
      );
      try {
        const { homedir, userDataDir } = resolveIsolatedHomedirAndUserData(options);
        saveSetupWizardState(
          { addConfiguredComponents: ['rosetta2'] },
          {
            ...options,
            ...(options.homedir ? { homedir } : {}),
            ...(userDataDir ? { userDataDir } : {}),
          }
        );
      } catch {}
      invalidateScanCaches();
      diagLog.info(
        'environmentProvisioner',
        'Apple Rosetta 2 background installation succeeded',
        {},
        options
      );
      return { installed: true, alreadyReady: false };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      diagLog.warn('environmentProvisioner', err, { phase: 'rosetta2-background-install' }, options);
      return { installed: false, alreadyReady: false, error: msg };
    }
  };

  if (!isSystemSingletonCall) {
    return runInstall();
  }

  const tracked = runInstall().finally(() => {
    if (inFlightBackgroundRosettaPromise === tracked) {
      inFlightBackgroundRosettaPromise = null;
    }
  });
  inFlightBackgroundRosettaPromise = tracked;
  return tracked;
}

module.exports = {
  ALLOWED_INSTALLER_HOSTS,
  validateInstallerUrl,
  resolveGogGalaxyInstallerCandidates,
  resolveGogGalaxyInstallerUrl,
  downloadGogGalaxyInstallerToFile,
  hasEmbeddedPeAuthenticodeCertificate,
  verifyMacAppDeveloperSignature,
  verifyMacPkgSignature,
  verifyWindowsInstallerSignature,
  onEnvironmentSetupProgress,
  emitEnvironmentSetupProgress,
  ensureRosetta2InBackground,
  installRunnerDirect,
  runEnvironmentSetupTasks,
  cancelEnvironmentSetup,
  startGuidedClientLogin,
  cancelGuidedClientLogin,
};
