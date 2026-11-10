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
  getElectron,
  getMainWindow,
  isTestEnvironment,
  resolveIsolatedHomedirAndUserData,
  invalidateScanCaches,
  openExternalUri,
  clearMacQuarantineAsync,
  safeIsBottleSlug,
  activeSessions,
  pendingBottleLaunches,
  macCodesignValidCache,
  evictExecutableDiscoveryCacheForPath,
} = require('./engineStateRegistry.cjs');
const {
  resolveBottleSteamExe,
  sandboxWinePrefixUserFoldersAsync,
  isCrossOverPerlWineWrapperOptions,
  upsertWineUserRegKey,
  resolveDriveCPathCaseInsensitive,
  applyCrossOverEnvironmentHygiene,
  sanitizeProvisionedBottleGraphicsBackend,
} = require('./wineAndCrossOverManager.cjs');
const macNativeInstallerAndCodesign = /** @type {any} */ (
  require('./macNativeInstallerAndCodesign.cjs')
);
const {
  ensureMacExecutablePermissions,
  resolveTargetMacAppBundlePath,
  isValidBottleDirectory,
  detectCompatibilityLayers,
  shutdownWinePrefix,
  resolveBottleGogGalaxyExe,
  resolveBottleEpicLauncherExe,
  ensureCompatibilityLayerReady,
  alignWineMsyncWithLiveBottle,
  resolveSipSafeWineBinaryAndPreloadEnv,
  prepareCrossOverWineSpawnEnv,
  prepareAlignedAuxBottleWineCommand,
  parsePlistStringValues,
  compareRunnerVersions,
  recordRunnerInstallReceipt,
} = macNativeInstallerAndCodesign;
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
const {
  CHAINED_PUBLISHER_ECOSYSTEMS,
  normalizeChainedHandoffId,
  resolveDefaultChainedBottleName,
  discoverBottlePublisherLauncher,
  discoverHostPublisherLauncher,
  sanitizeEaBottleAutostartInUserReg,
  sanitizeChainedPublisherAutostartInBottleRegs,
} = require('./chainedPublisherLaunchers.cjs');

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
 * @property {string} [archivePath]
 * @property {boolean} [forceUpdate]
 */

/**
 * @typedef {'probing' | 'downloading' | 'verifying_signature' | 'extracting' | 'installing' | 'completed' | 'failed' | 'cancelled'} CompatibilityRunnerOperationPhase
 */

/**
 * @typedef {object} CompatibilityRunnerProgressEvent
 * @property {NonNativeRunnerType} runnerType
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
 * @typedef {object} RunEnvironmentSetupRequest
 * @property {string} [runId]
 * @property {EnvironmentSetupTaskRequest[]} tasks
 * @property {StorefrontId[]} [connectedStorefronts]
 */

/**
 * @typedef {object} EnvironmentSetupProgressEvent
 * @property {string} runId
 * @property {EnvironmentComponentId | ClientLoginTargetId} componentId
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
const DOWNLOAD_PROGRESS_THROTTLE_MS = 150;

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
const VALID_CLIENT_LOGIN_TARGETS = new Set([
  'host_steam',
  'bottle_steam',
  'host_gog',
  'bottle_gog',
  'host_epic',
  'bottle_epic',
  'host_ubisoft',
  'bottle_ubisoft',
  'host_ea',
  'bottle_ea',
  'host_bnet',
  'bottle_bnet',
  'host_rockstar',
  'bottle_rockstar',
  'host_riot',
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
 * Map an `EnvironmentComponentId` to a `NonNativeRunnerType` when applicable.
 *
 * @param {string} componentId
 * @returns {NonNativeRunnerType | null}
 */
function componentIdToRunnerType(componentId) {
  switch (componentId) {
    case 'runner_crossover':
      return 'crossover';
    case 'runner_crossover_preview':
      return 'crossover_preview';
    case 'runner_wine':
      return 'wine';
    case 'runner_gptk':
      return 'gptk';
    default:
      return null;
  }
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
      (options._runnerProgressMeta && options._runnerProgressMeta.runnerType) ||
      componentIdToRunnerType(String(event.componentId || ''));
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
        runnerType,
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
 * @param {{ runId: string, componentId: EnvironmentComponentId, action?: EnvironmentSetupAction, stepIndex: number, totalSteps: number, label: string, minFreeBytes?: number }} ctx
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
 * Verify a Sparkle `sparkle:edSignature` Ed25519 signature over `filePath` using a raw 32-byte
 * base64 `SUPublicEDKey` (wrapped in RFC 8410 SubjectPublicKeyInfo DER `302a300506032b6570032100`).
 * Immediately unlinks `filePath` and throws on mismatch or malformed signature/key.
 *
 * @param {string} filePath
 * @param {string} signatureBase64
 * @param {string} [publicKeyBase64]
 * @returns {Promise<void>}
 */
async function verifySparkleEd25519SignatureAsync(
  filePath,
  signatureBase64,
  publicKeyBase64 = CODEWEAVERS_SPARKLE_PUBLIC_ED_KEY
) {
  const purgeFile = async () => {
    try {
      await fs.promises.rm(filePath, { force: true });
    } catch {}
  };

  try {
    const cleanSigB64 = String(signatureBase64 || '').trim();
    const cleanPubB64 = String(publicKeyBase64 || '').trim();
    if (!cleanSigB64 || !cleanPubB64) {
      throw new Error('Missing Sparkle Ed25519 signature or public key.');
    }

    const pubKeyRaw = Buffer.from(cleanPubB64, 'base64');
    const sigBuf = Buffer.from(cleanSigB64, 'base64');
    if (pubKeyRaw.length !== 32) {
      throw new Error(`Invalid Sparkle Ed25519 public key length (${pubKeyRaw.length} bytes).`);
    }
    if (sigBuf.length !== 64) {
      throw new Error(`Invalid Sparkle Ed25519 signature length (${sigBuf.length} bytes).`);
    }

    const spkiDer = Buffer.concat([
      Buffer.from('302a300506032b6570032100', 'hex'),
      pubKeyRaw,
    ]);
    const keyObj = crypto.createPublicKey({
      key: spkiDer,
      format: 'der',
      type: 'spki',
    });
    const payloadBuf = await fs.promises.readFile(filePath);
    const verified = crypto.verify(null, payloadBuf, keyObj, sigBuf);
    if (!verified) {
      throw new Error('Ed25519 signature did not match CodeWeavers Sparkle public key.');
    }
  } catch (err) {
    await purgeFile();
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(
      `Sparkle Ed25519 verification failed for ${path.basename(filePath)}: ${msg}`
    );
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
 * Locate embedded `D3DMetal.framework` inside a staged Apple Game Porting Toolkit `.app` bundle.
 *
 * @param {string} appBundlePath
 * @returns {string | null}
 */
function findEmbeddedD3DMetalFramework(appBundlePath) {
  if (!appBundlePath || typeof appBundlePath !== 'string') return null;
  const candidates = [
    path.join(appBundlePath, 'Contents/Frameworks/D3DMetal.framework'),
    path.join(appBundlePath, 'Contents/Resources/D3DMetal.framework'),
    path.join(appBundlePath, 'Contents/Resources/wine/lib/external/D3DMetal.framework'),
    path.join(appBundlePath, 'lib/external/D3DMetal.framework'),
  ];
  for (const cand of candidates) {
    if (fs.existsSync(cand)) {
      return cand;
    }
  }
  return null;
}

/**
 * Verify that an embedded Apple framework (e.g. `D3DMetal.framework` inside Game Porting Toolkit)
 * carries a genuine Apple code signature BEFORE running ad-hoc `--deep --force` bundle signing.
 *
 * @param {string} frameworkPath
 * @param {Record<string, any>} [options]
 * @returns {Promise<{ verified: boolean }>}
 */
async function verifyAppleSignedFramework(frameworkPath, options = {}) {
  const purgeOnFail = async () => {
    const purgeTarget =
      typeof options.purgeDirOnFailure === 'string' && options.purgeDirOnFailure
        ? options.purgeDirOnFailure
        : '';
    if (!purgeTarget) return;
    try {
      await fs.promises.rm(purgeTarget, { recursive: true, force: true });
    } catch {}
  };

  if (typeof options.verifySignatureFn === 'function') {
    try {
      const customRes = await options.verifySignatureFn(
        {
          artifactPath: frameworkPath,
          kind: 'framework',
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
            `Apple framework signature verification failed for ${path.basename(frameworkPath)}.`
        );
      }
      return { verified: true };
    } catch (err) {
      await purgeOnFail();
      throw err;
    }
  }

  const execFileFn = getExecFileFn(options);
  try {
    await runExecFileAsync(
      execFileFn,
      '/usr/bin/codesign',
      ['--verify', '--strict', frameworkPath],
      { timeout: 45000 }
    );
    const dvRes = await runExecFileAsync(
      execFileFn,
      '/usr/bin/codesign',
      ['-dv', '--verbose=4', frameworkPath],
      { timeout: 30000 }
    );
    const combined = `${dvRes.stdout}\n${dvRes.stderr}`;
    if (/code object is not signed/i.test(combined) || /\bSignature=adhoc\b/i.test(combined)) {
      throw new Error(
        `Rejected unsigned or ad-hoc signed Apple framework: ${path.basename(frameworkPath)}`
      );
    }
    const authorities = Array.from(combined.matchAll(/^Authority=([^\r\n]+)$/gm)).map((m) =>
      m[1].trim()
    );
    const hasAppleAuthority = authorities.some((auth) =>
      /^(?:Software Signing|macOS Software Signing|Apple Code Signing|Apple Root CA|Developer ID Application:\s*Apple)\b/i.test(
        auth
      )
    );
    if (!hasAppleAuthority) {
      throw new Error(
        `Rejected framework without Apple certificate authority: ${path.basename(frameworkPath)}`
      );
    }
    return { verified: true };
  } catch (err) {
    await purgeOnFail();
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(
      `Apple framework signature verification failed for ${path.basename(frameworkPath)}: ${msg}`
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
  switch (String(runnerType || '').trim().toLowerCase()) {
    case 'crossover':
      return 'CrossOver';
    case 'crossover_preview':
      return 'CrossOver Preview';
    case 'gptk':
      return 'Apple Game Porting Toolkit';
    case 'wine':
      return 'Wine';
    default:
      return 'Compatibility Runner';
  }
}

/**
 * Inspect `activeSessions`, `pendingBottleLaunches`, and live OS processes executing from inside
 * `targetAppPath` BEFORE replacing a compatibility runner `.app` bundle.
 *
 * - Blocks with `RUNNER_BUSY_ACTIVE_SESSION` if any non-finalized bottled game session is active on
 *   `darwin` or uses `runnerType`.
 * - Blocks with `RUNNER_BUSY_EXTERNAL_PROCESS` if the runner's GUI app or an external non-daemon
 *   Windows `.exe` is actively executing from inside `targetAppPath`.
 * - If ONLY idle `wineserver` / Wine prefix system daemons remain with zero active game session,
 *   cleanly shuts down known Wine prefixes (`shutdownWinePrefix` / `wineserver -k`) and re-verifies.
 *
 * @param {string} runnerType
 * @param {string | null | undefined} targetAppPath
 * @param {any} [existingLayer]
 * @param {Record<string, any>} [options]
 * @returns {Promise<{ ok: boolean, busyCode?: 'RUNNER_BUSY_ACTIVE_SESSION' | 'RUNNER_BUSY_EXTERNAL_PROCESS', error?: string }>}
 */
async function assertRunnerSafeToReplace(
  runnerType,
  targetAppPath,
  existingLayer = null,
  options = {}
) {
  const cleanRunnerType = String(runnerType || 'crossover')
    .trim()
    .toLowerCase();
  const runnerLabel = formatRunnerDisplayLabel(cleanRunnerType, existingLayer);
  const hostPlatform = String(options.platform || process.platform);
  const externalExistingMgr =
    detectExternalRunnerManagerName(existingLayer?.appPath) ||
    detectExternalRunnerManagerName(existingLayer?.binaryPath);
  const effectiveAppPath = String(
    targetAppPath || (!externalExistingMgr ? existingLayer?.appPath : '') || ''
  )
    .trim()
    .replace(/\/+$/, '');
  const appPrefix = effectiveAppPath ? `${effectiveAppPath}/` : '';

  // 1. Check active One Launcher bottled sessions
  for (const [gameId, entry] of activeSessions.entries()) {
    if (!entry || entry.finalized === true) continue;
    const sessLayer = String(
      entry.session?.compatibilityLayer || entry.compatibilityLayer || ''
    )
      .trim()
      .toLowerCase();
    const wineBin = String(entry.wineBinary || '').trim();
    const winePrefix = String(entry.winePrefix || '').trim();
    const isBottledSession = Boolean(
      wineBin ||
        winePrefix ||
        entry.launchedViaBottleSteam ||
        (sessLayer && sessLayer !== 'native')
    );
    const matchesTargetRunner =
      (hostPlatform === 'darwin' && isBottledSession) ||
      sessLayer === cleanRunnerType ||
      Boolean(appPrefix && wineBin.startsWith(appPrefix));

    if (matchesTargetRunner) {
      const gameTitle = String(
        entry.session?.title || entry.title || entry.session?.gameTitle || gameId || 'a game'
      ).trim();
      return {
        ok: false,
        busyCode: 'RUNNER_BUSY_ACTIVE_SESSION',
        error: `Cannot update ${runnerLabel} while "${gameTitle}" is running. Close the game and try again.`,
      };
    }
  }

  // 2. Check pending bottle launches in flight
  for (const [prefixPath, pendingCount] of pendingBottleLaunches.entries()) {
    if (Number(pendingCount) > 0 && hostPlatform === 'darwin') {
      const bottleLabel = path.basename(String(prefixPath || 'bottle')) || 'a game';
      return {
        ok: false,
        busyCode: 'RUNNER_BUSY_ACTIVE_SESSION',
        error: `Cannot update ${runnerLabel} while "${bottleLabel}" is running. Close the game and try again.`,
      };
    }
  }

  // 3. Inspect live OS processes executing from inside the target `.app` bundle
  if (!appPrefix || options.skipProcessCheck === true) {
    return { ok: true };
  }

  const readProcessListOutput = async () => {
    if (typeof options.getProcessListOutput === 'function') {
      return String((await options.getProcessListOutput()) || '');
    }
    if (typeof options.mockProcessListOutput === 'string') {
      return options.mockProcessListOutput;
    }
    if (hostPlatform !== 'darwin' || !fs.existsSync(effectiveAppPath)) {
      return '';
    }
    try {
      const execFileFn = getExecFileFn(options);
      const psRes = await runExecFileAsync(
        execFileFn,
        '/bin/ps',
        ['-ax', '-o', 'pid=,command='],
        { timeout: 5000 }
      );
      return psRes.stdout || '';
    } catch {
      return '';
    }
  };

  /**
   * @param {string} rawPsOutput
   */
  const classifyMatchingProcesses = (rawPsOutput) => {
    /** @type {Array<{ pid: number, command: string }>} */
    const matched = [];
    for (const rawLine of String(rawPsOutput || '').split(/\r?\n/)) {
      const m = rawLine.match(/^\s*(\d+)\s+(.+)$/);
      if (!m) continue;
      const pid = Number.parseInt(m[1], 10);
      const command = m[2].trim();
      if (!pid || pid === process.pid) continue;
      if (command.includes(appPrefix)) {
        matched.push({ pid, command });
      }
    }

    let hasGuiOrExternalApp = false;
    let hasIdleWineserverOrDaemon = false;
    const idleDaemonRe =
      /(?:^|[\\/ ])(?:wineserver|services\.exe|plugplay\.exe|svchost\.exe|rpcss\.exe|winedevice\.exe|explorer\.exe|conhost\.exe|tabtip\.exe)(?:\s|$|")/i;

    for (const proc of matched) {
      const cmdAfterApp = proc.command.slice(proc.command.indexOf(appPrefix) + appPrefix.length);
      const macOsBinMatch = cmdAfterApp.match(/^Contents\/MacOS\/([^\s"]+)/i);
      if (macOsBinMatch) {
        const macBinName = macOsBinMatch[1];
        if (!/^wine(?:64)?(?:-preloader|server)?$/i.test(macBinName)) {
          hasGuiOrExternalApp = true;
          continue;
        }
      }
      if (idleDaemonRe.test(proc.command)) {
        hasIdleWineserverOrDaemon = true;
      } else {
        hasGuiOrExternalApp = true;
      }
    }

    return { matched, hasGuiOrExternalApp, hasIdleWineserverOrDaemon };
  };

  const initialPs = classifyMatchingProcesses(await readProcessListOutput());
  if (initialPs.matched.length === 0) {
    return { ok: true };
  }

  if (initialPs.hasGuiOrExternalApp) {
    return {
      ok: false,
      busyCode: 'RUNNER_BUSY_EXTERNAL_PROCESS',
      error: `Please quit ${runnerLabel} before installing the update.`,
    };
  }

  // Only idle wineserver / prefix system daemons remain with zero active game session:
  // cleanly shut down known Wine prefixes and wineserver, then re-verify.
  if (initialPs.hasIdleWineserverOrDaemon) {
    const { homedir } = resolveIsolatedHomedirAndUserData(options);
    /** @type {string[]} */
    const candidatePrefixes = [];
    if (existingLayer?.bottlesDir && Array.isArray(existingLayer?.availableBottles)) {
      for (const bName of existingLayer.availableBottles) {
        candidatePrefixes.push(path.join(existingLayer.bottlesDir, bName));
      }
    }
    const olPrefixesRoot = path.join(homedir, 'Games/OneLauncher/Prefixes');
    if (fs.existsSync(olPrefixesRoot)) {
      try {
        for (const ent of fs.readdirSync(olPrefixesRoot, { withFileTypes: true })) {
          if (ent.isDirectory()) {
            candidatePrefixes.push(path.join(olPrefixesRoot, ent.name));
          }
        }
      } catch {}
    }

    for (const prefixDir of candidatePrefixes) {
      try {
        shutdownWinePrefix(prefixDir, existingLayer?.wineserverBinary || null, {
          waitSeconds: 2,
        });
      } catch {}
    }
    if (existingLayer?.wineserverBinary && fs.existsSync(existingLayer.wineserverBinary)) {
      try {
        const execFileFn = getExecFileFn(options);
        await runExecFileAsync(execFileFn, existingLayer.wineserverBinary, ['-k'], {
          timeout: 4000,
        });
      } catch {}
    }

    if (typeof options.getProcessListOutput === 'function' || (!options.mockProcessListOutput && hostPlatform === 'darwin')) {
      const settleMs = isTestEnvironment(options) ? 15 : 150;
      await new Promise((r) => setTimeout(r, settleMs));
      const recheckPs = classifyMatchingProcesses(await readProcessListOutput());
      if (recheckPs.matched.length > 0) {
        return {
          ok: false,
          busyCode: 'RUNNER_BUSY_EXTERNAL_PROCESS',
          error: `Please quit ${runnerLabel} before installing the update.`,
        };
      }
    }
  }

  return { ok: true };
}

/**
 * Evict cached codesign and executable discovery entries for a replaced macOS `.app` bundle.
 *
 * @param {string} targetAppPath
 */
function evictMacAppCachesForPath(targetAppPath) {
  if (!targetAppPath) return;
  const normalized = path.resolve(targetAppPath);
  const slashPrefix = `${normalized}/`;
  for (const key of Array.from(macCodesignValidCache.keys())) {
    const kStr = String(key);
    if (kStr === normalized || kStr === targetAppPath || kStr.startsWith(slashPrefix)) {
      macCodesignValidCache.delete(key);
    }
  }
  evictExecutableDiscoveryCacheForPath(targetAppPath);
}

/**
 * Atomically stage, quarantine-strip, codesign-verify, and swap a macOS `.app` bundle into
 * `targetDestAppPath` on the destination volume (`O(1)` POSIX `rename(2)` with `.ol-backup` rollback).
 * Never runs `rm -rf` on a live `.app` BEFORE replacement is verified on the destination volume.
 *
 * @param {string} stagedAppPath
 * @param {string} targetDestAppPath
 * @param {Record<string, any>} [options]
 * @returns {Promise<string>}
 */
async function atomicReplaceMacAppBundle(stagedAppPath, targetDestAppPath, options = {}) {
  const parentDir = path.dirname(targetDestAppPath);
  const appName = path.basename(targetDestAppPath);
  await fs.promises.mkdir(parentDir, { recursive: true });

  const suffix = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const siblingStagingPath = path.join(parentDir, `.${appName}.ol-staging-${suffix}`);
  const backupPath = path.join(parentDir, `.${appName}.ol-backup-${suffix}`);
  const execFileFn = getExecFileFn(options);
  const signal = /** @type {AbortSignal | undefined} */ (options.signal);
  let movedExistingToBackup = false;

  try {
    if (typeof options.onExecDitto === 'function') {
      await options.onExecDitto(stagedAppPath, siblingStagingPath);
      if (fs.existsSync(stagedAppPath) && !fs.existsSync(siblingStagingPath)) {
        await fs.promises.cp(stagedAppPath, siblingStagingPath, {
          recursive: true,
          force: true,
          verbatimSymlinks: true,
        });
      }
    } else {
      const canUseDitto =
        process.platform === 'darwin' ||
        typeof options.execFileFn === 'function' ||
        typeof options.execFileImpl === 'function';
      if (canUseDitto) {
        await runExecFileAsync(
          execFileFn,
          '/usr/bin/ditto',
          [stagedAppPath, siblingStagingPath],
          { timeout: 300000, signal }
        );
      }
      if (fs.existsSync(stagedAppPath) && !fs.existsSync(siblingStagingPath)) {
        await fs.promises.cp(stagedAppPath, siblingStagingPath, {
          recursive: true,
          force: true,
          verbatimSymlinks: true,
        });
      }
    }

    ensureMacExecutablePermissions(siblingStagingPath);
    await clearMacQuarantineAsync(siblingStagingPath, { ...options, force: true });

    const shouldVerifyStagingCodesign =
      options.skipStagingCodesignVerify !== true &&
      typeof options.verifySignatureFn !== 'function' &&
      fs.existsSync(siblingStagingPath) &&
      (process.platform === 'darwin' ||
        typeof options.execFileFn === 'function' ||
        typeof options.execFileImpl === 'function');

    if (shouldVerifyStagingCodesign) {
      if (options.prepareUnsignedWineBundle === true) {
        try {
          await runExecFileAsync(
            execFileFn,
            '/usr/bin/codesign',
            ['--verify', '--deep', '--strict', siblingStagingPath],
            { timeout: 60000, signal }
          );
        } catch (verifyErr) {
          const errDetail = `${String(verifyErr?.stderr || '')} ${String(verifyErr?.message || '')}`;
          if (/not signed at all/i.test(errDetail)) {
            await runExecFileAsync(
              execFileFn,
              '/usr/bin/codesign',
              ['--force', '--deep', '-s', '-', siblingStagingPath],
              { timeout: 180000, signal }
            );
          } else {
            throw verifyErr;
          }
        }
      }
      await runExecFileAsync(
        execFileFn,
        '/usr/bin/codesign',
        ['--verify', '--deep', '--strict', siblingStagingPath],
        { timeout: 60000, signal }
      );
    }

    let destinationExists = false;
    try {
      await fs.promises.lstat(targetDestAppPath);
      destinationExists = true;
    } catch {}

    if (destinationExists) {
      await fs.promises.rename(targetDestAppPath, backupPath);
      movedExistingToBackup = true;
    }

    try {
      await fs.promises.rename(siblingStagingPath, targetDestAppPath);
    } catch (swapErr) {
      if (movedExistingToBackup) {
        try {
          if (fs.existsSync(backupPath) && !fs.existsSync(targetDestAppPath)) {
            await fs.promises.rename(backupPath, targetDestAppPath);
            movedExistingToBackup = false;
          }
        } catch {}
      }
      throw swapErr;
    }

    evictMacAppCachesForPath(targetDestAppPath);

    if (movedExistingToBackup) {
      try {
        await fs.promises.rm(backupPath, { recursive: true, force: true });
      } catch {}
    }

    return targetDestAppPath;
  } finally {
    try {
      if (fs.existsSync(siblingStagingPath)) {
        await fs.promises.rm(siblingStagingPath, { recursive: true, force: true });
      }
    } catch {}
  }
}

/**
 * Copy a verified `.app` bundle into `targetDestDir` preserving `.framework` symlinks via `/usr/bin/ditto`
 * (with `fs.promises.cp` fallback in hermetic test mocks), clear macOS quarantine attributes, and
 * perform an atomic same-volume `rename(2)` swap.
 *
 * @param {string} srcApp
 * @param {string} targetDestDir
 * @param {Record<string, any>} [options]
 * @returns {Promise<string>}
 */
async function copyVerifiedMacAppToApplicationsDir(srcApp, targetDestDir, options = {}) {
  const destApp =
    typeof options.targetAppBundlePath === 'string' && options.targetAppBundlePath.trim()
      ? options.targetAppBundlePath.trim()
      : path.join(targetDestDir, path.basename(srcApp));
  return atomicReplaceMacAppBundle(srcApp, destApp, options);
}

/**
 * Mount a `.dmg` read-only, verify the contained `.app` Developer ID signature BEFORE copying
 * anything to `targetDestDir`, atomically stage & swap via `ditto`, clear quarantine, and ALWAYS detach in `finally`.
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
        Boolean(findEmbeddedD3DMetalFramework(mountedAppPath));
      if (!matchesGptkName && !hasGptkLayout) {
        throw new Error(
          `Rejected ${path.basename(dmgPath)}: "${appEntry}" is not an Apple Game Porting Toolkit bundle.`
        );
      }
      const embeddedD3d = findEmbeddedD3DMetalFramework(mountedAppPath);
      if (embeddedD3d) {
        await verifyAppleSignedFramework(embeddedD3d, {
          ...options,
          keepOnFailure: true,
        });
      }
    }

    if (options.prepareUnsignedWineBundle === true && expectedTeamIds.length === 0) {
      try {
        await verifyMacAppDeveloperSignature(mountedAppPath, expectedTeamIds, {
          ...options,
          keepOnFailure: true,
          allowAdhocSignature: true,
          ...(expectedVendorAuthorityPattern ? { expectedVendorAuthorityPattern } : {}),
        });
      } catch (verifyErr) {
        const errDetail = `${String(verifyErr?.stderr || '')} ${String(verifyErr?.message || '')}`;
        if (!/not signed at all/i.test(errDetail)) {
          throw verifyErr;
        }
      }
    } else {
      await verifyMacAppDeveloperSignature(mountedAppPath, expectedTeamIds, {
        ...options,
        keepOnFailure: true,
        ...(options.requireGptkBundle === true ? { allowAdhocSignature: true } : {}),
        ...(expectedVendorAuthorityPattern
          ? { expectedVendorAuthorityPattern }
          : {}),
      });
    }

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
 * Validate whether a navigation/SSO URL is permitted inside the sandboxed CodeWeavers Preview
 * sign-in `BrowserWindow`.
 *
 * @param {string} rawUrl
 * @param {Record<string, any>} [options]
 * @returns {boolean}
 */
function isAllowedCodeWeaversAuthNavigationUrl(rawUrl, options = {}) {
  try {
    const parsed = new URL(String(rawUrl || '').trim());
    const host = parsed.hostname.toLowerCase();
    if (
      options.allowLoopbackInstallerUrls === true &&
      (host === '127.0.0.1' || host === 'localhost')
    ) {
      return parsed.protocol === 'http:' || parsed.protocol === 'https:';
    }
    if (parsed.protocol !== 'https:') return false;
    return (
      host === 'codeweavers.com' ||
      host.endsWith('.codeweavers.com') ||
      host === 'google.com' ||
      host.endsWith('.google.com') ||
      host === 'appleid.apple.com' ||
      host === 'challenges.cloudflare.com'
    );
  } catch {
    return false;
  }
}

/**
 * Validate whether every redirect hop of a `will-download` item originates from an official
 * CodeWeavers download host (`codeweavers.com` or `*.codeweavers.com` over HTTPS).
 *
 * @param {string} rawUrl
 * @param {Record<string, any>} [options]
 * @returns {boolean}
 */
function isAllowedCodeWeaversDownloadUrl(rawUrl, options = {}) {
  try {
    const parsed = new URL(String(rawUrl || '').trim());
    const host = parsed.hostname.toLowerCase();
    if (
      options.allowLoopbackInstallerUrls === true &&
      (host === '127.0.0.1' || host === 'localhost')
    ) {
      return parsed.protocol === 'http:' || parsed.protocol === 'https:';
    }
    if (parsed.protocol !== 'https:') return false;
    return host === 'codeweavers.com' || host.endsWith('.codeweavers.com');
  } catch {
    return false;
  }
}

/**
 * Extract an optional version or preview build date hint from a CodeWeavers Preview filename.
 *
 * @param {string} filename
 * @returns {string | null}
 */
function extractPreviewFilenameVersionHint(filename) {
  const base = path.basename(String(filename || '').trim()).replace(/\.(?:zip|dmg)$/i, '');
  if (!base) return null;
  const semverMatch = base.match(/(\d+\.\d+(?:\.\d+)?)/);
  if (semverMatch) return semverMatch[1];
  const dateMatch = base.match(/(?:^|[-_.])(20\d{6})(?:$|[-_.])/);
  if (dateMatch) return dateMatch[1];
  return null;
}

/**
 * Detect experimental ARM64-only CrossOver Preview builds (`crossover-preview-arm64-YYYYMMDD.zip`,
 * `*-aarch64*`, etc.), which must be excluded in favor of the standard macOS CrossOver Preview
 * build (`crossover-preview-YYYYMMDD.zip`).
 *
 * @param {string} rawTarget
 * @returns {boolean}
 */
function isExperimentalArm64CrossOverPreviewTarget(rawTarget) {
  const raw = String(rawTarget || '').trim();
  if (!raw) return false;
  let candidate = raw;
  try {
    const parsed = new URL(raw, 'https://www.codeweavers.com/preview/download');
    candidate = decodeURIComponent(parsed.pathname || raw);
  } catch {
    try {
      candidate = decodeURIComponent(raw);
    } catch {}
  }
  const base = path.basename(candidate).toLowerCase();
  return /(?:^|[-_.])(arm64|aarch64|apple[-_.]?silicon)(?:[-_.]|\.(?:zip|dmg)$|$)/i.test(base);
}

/**
 * Deterministically select the newest standard (non-ARM64) macOS CrossOver Preview `.zip` / `.dmg`
 * download URL from links discovered on the CodeWeavers Preview portal page.
 *
 * Explicitly excludes experimental `arm64` / `aarch64` builds (e.g.
 * `crossover-preview-arm64-20261015.zip`), Linux installers (`.deb`, `.rpm`, `.bin`), source
 * tarballs, and generic non-Preview trial links.
 *
 * @param {unknown[]} candidateUrls
 * @param {string} [baseUrl]
 * @param {Record<string, any>} [options]
 * @returns {string | null}
 */
function selectPreferredCrossOverPreviewDownloadUrl(
  candidateUrls,
  baseUrl = 'https://www.codeweavers.com/preview/download',
  options = {}
) {
  if (!Array.isArray(candidateUrls) || candidateUrls.length === 0) {
    return null;
  }

  /**
   * @type {Array<{
   *   url: string,
   *   hasExplicitPreviewName: boolean,
   *   buildDateNum: number,
   *   versionHint: string | null,
   *   isZip: boolean,
   * }>}
   */
  const ranked = [];
  const seen = new Set();

  for (const rawItem of candidateUrls) {
    const rawHref = String(rawItem || '').trim();
    if (
      !rawHref ||
      rawHref.startsWith('#') ||
      /^javascript:/i.test(rawHref) ||
      /^mailto:/i.test(rawHref)
    ) {
      continue;
    }

    let resolvedUrl = '';
    /** @type {URL | null} */
    let parsed = null;
    try {
      parsed = new URL(rawHref, baseUrl);
      resolvedUrl = parsed.toString();
    } catch {
      continue;
    }

    if (seen.has(resolvedUrl)) continue;
    seen.add(resolvedUrl);

    if (!isAllowedCodeWeaversDownloadUrl(resolvedUrl, options)) {
      continue;
    }

    let decodedPath = parsed.pathname || '';
    try {
      decodedPath = decodeURIComponent(decodedPath);
    } catch {}
    const filename = path.basename(decodedPath);
    if (!filename || !/\.(?:zip|dmg)$/i.test(filename)) {
      continue;
    }

    if (!/crossover/i.test(filename)) {
      continue;
    }
    if (
      /(?:^|[-_.])(source|src|linux|debian|ubuntu|rpm)(?:[-_.]|\.(?:zip|dmg)$)/i.test(filename)
    ) {
      continue;
    }

    const hasExplicitPreviewName = /crossover[-_.]?preview/i.test(filename);
    const isUnderPreviewDownloadPath = /\/preview\/download\/[^/?#]+\.(?:zip|dmg)$/i.test(
      decodedPath
    );
    if (!hasExplicitPreviewName && !isUnderPreviewDownloadPath) {
      continue;
    }

    if (
      options.allowExperimentalArm64Preview !== true &&
      (isExperimentalArm64CrossOverPreviewTarget(filename) ||
        isExperimentalArm64CrossOverPreviewTarget(resolvedUrl))
    ) {
      continue;
    }

    const dateMatch = filename.match(/(?:^|[-_.])(20\d{6})(?:[-_.]|\.(?:zip|dmg)$)/i);
    const buildDateNum = dateMatch ? Number(dateMatch[1]) : 0;
    const versionHint = extractPreviewFilenameVersionHint(filename);
    const isZip = /\.zip$/i.test(filename);

    ranked.push({
      url: resolvedUrl,
      hasExplicitPreviewName,
      buildDateNum,
      versionHint,
      isZip,
    });
  }

  if (ranked.length === 0) {
    return null;
  }

  ranked.sort((a, b) => {
    if (a.hasExplicitPreviewName !== b.hasExplicitPreviewName) {
      return a.hasExplicitPreviewName ? -1 : 1;
    }
    if (a.buildDateNum !== b.buildDateNum) {
      return b.buildDateNum - a.buildDateNum;
    }
    if (a.versionHint && b.versionHint && a.versionHint !== b.versionHint) {
      const cmp =
        typeof compareRunnerVersions === 'function'
          ? compareRunnerVersions(a.versionHint, b.versionHint)
          : a.versionHint.localeCompare(b.versionHint, undefined, { numeric: true });
      if (cmp !== 0) return -cmp;
    } else if (a.versionHint && !b.versionHint) {
      return -1;
    } else if (!a.versionHint && b.versionHint) {
      return 1;
    }
    if (a.isZip !== b.isZip) {
      return a.isZip ? -1 : 1;
    }
    return 0;
  });

  return ranked[0].url;
}

/**
 * Resolve canonical semver from a CrossOver Preview `.app` bundle `Info.plist` when the filename
 * hint was absent or only carried an 8-digit preview date (`YYYYMMDD`).
 *
 * @param {string} appBundlePath
 * @param {string | null} hintVersion
 * @returns {string | null}
 */
function resolvePreviewBundleVersion(appBundlePath, hintVersion) {
  try {
    const plistPath = path.join(appBundlePath, 'Contents/Info.plist');
    if (fs.existsSync(plistPath) && typeof parsePlistStringValues === 'function') {
      const plistDict = parsePlistStringValues(plistPath);
      const bundleVer = String(plistDict.CFBundleVersion || '').trim();
      const shortVer = String(plistDict.CFBundleShortVersionString || '').trim();
      const semverMatch = bundleVer.match(/^(\d+\.\d+\.\d+)(?:\.\d+)?$/);
      if (semverMatch) {
        return semverMatch[1];
      }
      if (!hintVersion && (shortVer || bundleVer)) {
        return shortVer || bundleVer;
      }
    }
  } catch {}
  return hintVersion || null;
}

/**
 * Open a sandboxed in-app CodeWeavers sign-in `BrowserWindow` using persistent partition
 * `'persist:codeweavers-preview'`, auto-redirect to `/preview/download` after login, intercept
 * the official `.zip`/`.dmg` download into `destDir` with zero Save-As prompt, immediately close
 * the sign-in window once capture starts, and stream live byte progress to One Launcher.
 *
 * @param {string} destDir
 * @param {{ runId: string, componentId: EnvironmentComponentId, action?: EnvironmentSetupAction, stepIndex: number, totalSteps: number }} progressCtx
 * @param {Record<string, any>} [options]
 * @param {AbortSignal} [signal]
 * @returns {Promise<{ archivePath: string, resolvedVersion: string | null }>}
 */
async function captureCodeWeaversPreviewDownload(
  destDir,
  progressCtx,
  options = {},
  signal = undefined
) {
  if (signal?.aborted) {
    const abortErr = new Error('CodeWeavers Preview sign-in cancelled.');
    abortErr.name = 'AbortError';
    throw abortErr;
  }

  await fs.promises.mkdir(destDir, { recursive: true });

  const minFreeBytes = Number(options.minFreeBytes || 1200 * 1024 * 1024);
  const diskInfo = await getDiskSpace(destDir, options);
  if (
    typeof diskInfo.availableBytes === 'number' &&
    diskInfo.availableBytes > 0 &&
    diskInfo.availableBytes < minFreeBytes
  ) {
    throw new Error(
      `Insufficient disk space (${Math.round(diskInfo.availableBytes / (1024 * 1024))} MB free, need at least ${Math.round(minFreeBytes / (1024 * 1024))} MB).`
    );
  }

  if (typeof options.capturePreviewDownloadFn === 'function') {
    emitEnvironmentSetupProgress(
      {
        ...progressCtx,
        phase: 'probing',
        message: 'Sign in to CodeWeavers Preview to start automatic download...',
      },
      options
    );
    const hookRes = await options.capturePreviewDownloadFn({
      destDir,
      progressCtx,
      options,
      signal,
    });
    if (signal?.aborted) {
      const abortErr = new Error('CodeWeavers Preview sign-in cancelled.');
      abortErr.name = 'AbortError';
      throw abortErr;
    }
    const hookArchivePath =
      typeof hookRes === 'string'
        ? hookRes.trim()
        : hookRes && typeof hookRes.archivePath === 'string'
          ? hookRes.archivePath.trim()
          : '';
    if (!hookArchivePath || !fs.existsSync(hookArchivePath)) {
      throw new Error('Captured CrossOver Preview installer archive was not found on disk.');
    }
    const hookVersion =
      hookRes &&
      typeof hookRes === 'object' &&
      typeof hookRes.version === 'string' &&
      hookRes.version.trim()
        ? hookRes.version.trim()
        : hookRes &&
            typeof hookRes === 'object' &&
            typeof hookRes.resolvedVersion === 'string' &&
            hookRes.resolvedVersion.trim()
          ? hookRes.resolvedVersion.trim()
          : extractPreviewFilenameVersionHint(hookArchivePath);
    return {
      archivePath: hookArchivePath,
      resolvedVersion: hookVersion || null,
    };
  }

  const electronMod = (options && options.electronMod) || getElectron();
  const BrowserWindow = electronMod?.BrowserWindow;
  const sessionMod = electronMod?.session;
  if (
    typeof BrowserWindow !== 'function' ||
    !sessionMod ||
    typeof sessionMod.fromPartition !== 'function'
  ) {
    throw new Error(
      'In-app CodeWeavers Preview sign-in requires an interactive Electron window session.'
    );
  }

  const previewDownloadUrl = String(
    options.previewPortalUrl || 'https://www.codeweavers.com/preview/download'
  ).trim();
  if (!isAllowedCodeWeaversAuthNavigationUrl(previewDownloadUrl, options)) {
    const urlErr = /** @type {Error & { code?: string }} */ (
      new Error(`Untrusted CodeWeavers Preview portal URL: ${previewDownloadUrl}`)
    );
    urlErr.code = 'INSTALLER_URL_BLOCKED';
    throw urlErr;
  }

  const previewSession = sessionMod.fromPartition('persist:codeweavers-preview');
  const mainWin = typeof getMainWindow === 'function' ? getMainWindow() : null;

  emitEnvironmentSetupProgress(
    {
      ...progressCtx,
      phase: 'probing',
      message: 'Sign in to CodeWeavers Preview to start automatic download...',
    },
    options
  );

  return new Promise((resolve, reject) => {
    let settled = false;
    let downloadCaptured = false;
    let closingForCapture = false;
    let sawLoginPage = false;
    let autoTriggeredDownloadAfterLogin = false;
    let autoTriggeredArchiveDownload = false;
    /** @type {string | null} */
    let lastDiscoveredStandardArchiveUrl = null;
    /** @type {any} */
    let activeDownloadItem = null;
    /** @type {any} */
    let authWindow = null;
    /** @type {ReturnType<typeof setTimeout>[]} */
    const pendingTimers = [];

    /** @type {(event: any, item: any) => void} */
    let onWillDownload;
    /** @type {() => void} */
    let onAbort;
    /** @type {(currentUrlHint?: string, retryAttempt?: number) => Promise<void>} */
    let inspectPortalAndTriggerDownload = async () => {};

    const clearPendingTimers = () => {
      while (pendingTimers.length > 0) {
        const t = pendingTimers.pop();
        if (t) clearTimeout(t);
      }
    };

    const scheduleBoundedTimer = (/** @type {() => void} */ fn, /** @type {number} */ delayMs) => {
      const handle = setTimeout(() => {
        const idx = pendingTimers.indexOf(handle);
        if (idx >= 0) pendingTimers.splice(idx, 1);
        fn();
      }, delayMs);
      if (handle && typeof handle.unref === 'function') {
        handle.unref();
      }
      pendingTimers.push(handle);
      return handle;
    };

    const revealAuthWindow = () => {
      if (settled || downloadCaptured || closingForCapture) return;
      try {
        if (authWindow && !authWindow.isDestroyed()) {
          if (typeof authWindow.show === 'function') {
            authWindow.show();
          }
          if (typeof authWindow.focus === 'function') {
            authWindow.focus();
          }
        }
      } catch {}
    };

    const forceCloseAuthWindow = () => {
      closingForCapture = true;
      clearPendingTimers();
      try {
        if (authWindow && !authWindow.isDestroyed()) {
          if (typeof authWindow.hide === 'function') {
            authWindow.hide();
          }
          if (typeof authWindow.destroy === 'function') {
            const winRef = authWindow;
            setImmediate(() => {
              try {
                if (!winRef.isDestroyed()) {
                  winRef.close();
                  if (!winRef.isDestroyed()) {
                    winRef.destroy();
                  }
                }
              } catch {}
            });
          } else {
            authWindow.close();
          }
        }
      } catch {}
    };

    const triggerArchiveDownloadUrl = (/** @type {string} */ targetUrl) => {
      if (
        !targetUrl ||
        settled ||
        downloadCaptured ||
        closingForCapture ||
        autoTriggeredArchiveDownload
      ) {
        return false;
      }
      autoTriggeredArchiveDownload = true;
      lastDiscoveredStandardArchiveUrl = targetUrl;
      emitEnvironmentSetupProgress(
        {
          ...progressCtx,
          phase: 'probing',
          message: 'Authenticated with CodeWeavers — starting CrossOver Preview download...',
        },
        options
      );
      try {
        const wcRef = authWindow && !authWindow.isDestroyed() ? authWindow.webContents : null;
        if (wcRef && typeof wcRef.downloadURL === 'function') {
          wcRef.downloadURL(targetUrl);
          scheduleBoundedTimer(() => {
            if (!settled && !downloadCaptured && !closingForCapture) {
              autoTriggeredArchiveDownload = false;
              revealAuthWindow();
            }
          }, 4000);
          return true;
        }
        if (authWindow && !authWindow.isDestroyed()) {
          Promise.resolve(authWindow.loadURL(targetUrl)).catch(() => {});
          scheduleBoundedTimer(() => {
            if (!settled && !downloadCaptured && !closingForCapture) {
              autoTriggeredArchiveDownload = false;
              revealAuthWindow();
            }
          }, 4000);
          return true;
        }
      } catch {
        autoTriggeredArchiveDownload = false;
      }
      return false;
    };

    const cleanup = () => {
      clearPendingTimers();
      try {
        if (previewSession && onWillDownload) {
          if (typeof previewSession.removeListener === 'function') {
            previewSession.removeListener('will-download', onWillDownload);
          } else if (typeof previewSession.off === 'function') {
            previewSession.off('will-download', onWillDownload);
          }
        }
      } catch {}
      try {
        if (signal && onAbort && typeof signal.removeEventListener === 'function') {
          signal.removeEventListener('abort', onAbort);
        }
      } catch {}
    };

    const settleResolve = (/** @type {{ archivePath: string, resolvedVersion: string | null }} */ val) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(val);
    };

    const settleReject = (/** @type {any} */ err) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(err);
    };

    onWillDownload = (_event, item) => {
      if (settled || downloadCaptured) {
        try {
          if (item && typeof item.cancel === 'function') item.cancel();
        } catch {}
        return;
      }

      const rawChain =
        item && typeof item.getURLChain === 'function' ? item.getURLChain() : [];
      const itemUrl =
        item && typeof item.getURL === 'function' ? String(item.getURL() || '').trim() : '';
      const filename =
        item && typeof item.getFilename === 'function'
          ? String(item.getFilename() || '').trim()
          : '';
      const urlsToCheck = Array.from(
        new Set(
          [...(Array.isArray(rawChain) ? rawChain : []), itemUrl]
            .map((u) => String(u || '').trim())
            .filter(Boolean)
        )
      );

      const allUrlsTrusted =
        urlsToCheck.length > 0 &&
        urlsToCheck.every((u) => isAllowedCodeWeaversDownloadUrl(u, options));
      const hasValidArchiveExt =
        /\.(?:zip|dmg)$/i.test(filename) || /\.(?:zip|dmg)(?:\?|$)/i.test(itemUrl);

      if (!allUrlsTrusted || !hasValidArchiveExt) {
        try {
          if (item && typeof item.cancel === 'function') item.cancel();
        } catch {}
        forceCloseAuthWindow();
        const secErr = /** @type {Error & { code?: string }} */ (
          new Error(
            `Blocked CrossOver Preview download from untrusted host or unsupported file type (${filename || itemUrl || 'unknown'}).`
          )
        );
        secErr.code = 'INSTALLER_URL_BLOCKED';
        settleReject(secErr);
        return;
      }

      if (
        options.allowExperimentalArm64Preview !== true &&
        (isExperimentalArm64CrossOverPreviewTarget(filename) ||
          urlsToCheck.some((u) => isExperimentalArm64CrossOverPreviewTarget(u)))
      ) {
        try {
          if (item && typeof item.cancel === 'function') item.cancel();
        } catch {}
        if (lastDiscoveredStandardArchiveUrl && !autoTriggeredArchiveDownload) {
          triggerArchiveDownloadUrl(lastDiscoveredStandardArchiveUrl);
          return;
        }
        if (!autoTriggeredArchiveDownload) {
          void inspectPortalAndTriggerDownload('', 0);
          return;
        }
        forceCloseAuthWindow();
        const armErr = /** @type {Error & { code?: string }} */ (
          new Error(
            `Skipped experimental ARM64 CrossOver Preview build (${filename || itemUrl}); standard macOS CrossOver Preview build is required.`
          )
        );
        armErr.code = 'EXPERIMENTAL_ARM64_PREVIEW_EXCLUDED';
        settleReject(armErr);
        return;
      }

      downloadCaptured = true;
      activeDownloadItem = item;

      const resolvedVersion =
        extractPreviewFilenameVersionHint(filename) ||
        extractPreviewFilenameVersionHint(itemUrl);
      const isDmgDownload =
        /\.dmg$/i.test(filename) ||
        (!/\.(?:zip|dmg)$/i.test(filename) && /\.dmg(?:\?|$)/i.test(itemUrl));
      const destArchivePath = path.join(
        destDir,
        isDmgDownload ? 'CrossOverPreview.dmg' : 'CrossOverPreview.zip'
      );

      if (typeof item.setSavePath === 'function') {
        item.setSavePath(destArchivePath);
      }

      forceCloseAuthWindow();

      const initialTotal =
        typeof item.getTotalBytes === 'function' ? Number(item.getTotalBytes() || 0) : 0;
      emitEnvironmentSetupProgress(
        {
          ...progressCtx,
          phase: 'downloading',
          bytesDownloaded: 0,
          ...(initialTotal > 0 ? { totalBytes: initialTotal, progressPercent: 0 } : {}),
          message: 'Downloading CrossOver Preview...',
        },
        options
      );

      if (typeof item.on === 'function') {
        item.on('updated', (/** @type {any} */ _uEvt, /** @type {string} */ state) => {
          if (settled || state === 'interrupted') return;
          const received =
            typeof item.getReceivedBytes === 'function'
              ? Number(item.getReceivedBytes() || 0)
              : 0;
          const total =
            typeof item.getTotalBytes === 'function' ? Number(item.getTotalBytes() || 0) : 0;
          if (
            received > MAX_INSTALLER_DOWNLOAD_BYTES ||
            total > MAX_INSTALLER_DOWNLOAD_BYTES
          ) {
            try {
              if (typeof item.cancel === 'function') item.cancel();
            } catch {}
            settleReject(
              new Error('CrossOver Preview download exceeded maximum allowed size.')
            );
            return;
          }
          const progressPercent =
            total > 0 ? Math.min(100, Math.round((received / total) * 100)) : undefined;
          emitEnvironmentSetupProgress(
            {
              ...progressCtx,
              phase: 'downloading',
              bytesDownloaded: received,
              ...(total > 0 ? { totalBytes: total } : {}),
              ...(progressPercent !== undefined ? { progressPercent } : {}),
              message: 'Downloading CrossOver Preview...',
            },
            options
          );
        });
      }

      const onDownloadDone = (/** @type {any} */ _dEvt, /** @type {string} */ state) => {
        if (settled) return;
        if (state === 'completed') {
          settleResolve({
            archivePath: destArchivePath,
            resolvedVersion,
          });
          return;
        }
        if (state === 'cancelled' || signal?.aborted) {
          const abortErr = new Error('CrossOver Preview download cancelled.');
          abortErr.name = 'AbortError';
          settleReject(abortErr);
          return;
        }
        settleReject(
          new Error(`CrossOver Preview download failed (${state || 'unknown'}).`)
        );
      };

      if (typeof item.once === 'function') {
        item.once('done', onDownloadDone);
      } else if (typeof item.on === 'function') {
        item.on('done', onDownloadDone);
      }
    };

    onAbort = () => {
      if (settled) return;
      try {
        if (activeDownloadItem && typeof activeDownloadItem.cancel === 'function') {
          activeDownloadItem.cancel();
        }
      } catch {}
      forceCloseAuthWindow();
      const abortErr = new Error('CodeWeavers Preview sign-in cancelled.');
      abortErr.name = 'AbortError';
      settleReject(abortErr);
    };

    if (signal && typeof signal.addEventListener === 'function') {
      signal.addEventListener('abort', onAbort, { once: true });
    }

    try {
      previewSession.on('will-download', onWillDownload);

      authWindow = new BrowserWindow({
        width: 560,
        height: 700,
        ...(mainWin && typeof mainWin.isDestroyed === 'function' && !mainWin.isDestroyed()
          ? { parent: mainWin }
          : {}),
        modal: false,
        show: options.showAuthWindowImmediately === true,
        closable: true,
        resizable: true,
        autoHideMenuBar: true,
        title: 'Sign In to CodeWeavers — CrossOver Preview',
        webPreferences: {
          nodeIntegration: false,
          contextIsolation: true,
          sandbox: true,
          partition: 'persist:codeweavers-preview',
        },
      });

      scheduleBoundedTimer(() => {
        if (!settled && !downloadCaptured && !closingForCapture && !autoTriggeredArchiveDownload) {
          revealAuthWindow();
        }
      }, 1500);

      const wc = authWindow.webContents;

      inspectPortalAndTriggerDownload = async (currentUrlHint = '', retryAttempt = 0) => {
        if (
          settled ||
          downloadCaptured ||
          closingForCapture ||
          autoTriggeredArchiveDownload ||
          !authWindow ||
          authWindow.isDestroyed()
        ) {
          return;
        }

        const currentUrl = String(
          (wc && typeof wc.getURL === 'function' ? wc.getURL() : '') ||
            currentUrlHint ||
            previewDownloadUrl
        ).trim();

        /** @type {URL | null} */
        let parsed = null;
        try {
          parsed = new URL(currentUrl);
        } catch {
          if (retryAttempt > 0) revealAuthWindow();
          return;
        }

        const host = parsed.hostname.toLowerCase();
        const pathname = parsed.pathname.toLowerCase();
        const isCodeWeaversOrigin =
          host === 'codeweavers.com' ||
          host.endsWith('.codeweavers.com') ||
          (options.allowLoopbackInstallerUrls === true &&
            (host === '127.0.0.1' || host === 'localhost'));

        if (!isCodeWeaversOrigin) {
          sawLoginPage = true;
          revealAuthWindow();
          return;
        }

        const isLoginRoute =
          pathname.startsWith('/login') ||
          pathname.startsWith('/signin') ||
          pathname.includes('/login/') ||
          pathname.endsWith('/login');
        if (isLoginRoute) {
          sawLoginPage = true;
          autoTriggeredDownloadAfterLogin = false;
          revealAuthWindow();
          return;
        }

        /** @type {string[]} */
        let scrapedHrefs = [];
        let hasPasswordInput = false;
        if (wc && typeof wc.executeJavaScript === 'function') {
          try {
            const pageProbe = await wc.executeJavaScript(
              `(() => {
                const hrefs = [];
                for (const el of document.querySelectorAll('a[href], area[href], [data-download-url]')) {
                  const val = el.getAttribute('href') || el.getAttribute('data-download-url') || el.href || '';
                  if (val) hrefs.push(String(val));
                }
                const hasPasswordInput = Boolean(document.querySelector('input[type="password"]'));
                return { hrefs, hasPasswordInput };
              })()`,
              true
            );
            if (Array.isArray(pageProbe)) {
              scrapedHrefs = pageProbe.map((u) => String(u || ''));
            } else if (pageProbe && typeof pageProbe === 'object') {
              if (Array.isArray(pageProbe.hrefs)) {
                scrapedHrefs = pageProbe.hrefs.map((/** @type {any} */ u) => String(u || ''));
              }
              hasPasswordInput = Boolean(pageProbe.hasPasswordInput);
            }
          } catch {}
        }

        if (
          settled ||
          downloadCaptured ||
          closingForCapture ||
          autoTriggeredArchiveDownload ||
          !authWindow ||
          authWindow.isDestroyed()
        ) {
          return;
        }

        const bestArchiveUrl = selectPreferredCrossOverPreviewDownloadUrl(
          scrapedHrefs,
          currentUrl,
          options
        );
        if (bestArchiveUrl) {
          lastDiscoveredStandardArchiveUrl = bestArchiveUrl;
          triggerArchiveDownloadUrl(bestArchiveUrl);
          return;
        }

        if (hasPasswordInput) {
          sawLoginPage = true;
          autoTriggeredDownloadAfterLogin = false;
          revealAuthWindow();
          return;
        }

        if (!pathname.startsWith('/preview/download') && !autoTriggeredDownloadAfterLogin) {
          autoTriggeredDownloadAfterLogin = true;
          if (authWindow && !authWindow.isDestroyed()) {
            Promise.resolve(authWindow.loadURL(previewDownloadUrl)).catch(() => {});
          }
          return;
        }

        if (retryAttempt === 0) {
          scheduleBoundedTimer(() => {
            void inspectPortalAndTriggerDownload(currentUrl, 1);
          }, 350);
          return;
        }

        revealAuthWindow();
        if (retryAttempt === 1) {
          scheduleBoundedTimer(() => {
            void inspectPortalAndTriggerDownload(currentUrl, 2);
          }, 900);
        }
      };

      if (wc) {
        if (typeof wc.setWindowOpenHandler === 'function') {
          wc.setWindowOpenHandler((/** @type {any} */ details) => {
            const popupUrl = String(details?.url || '').trim();
            if (
              popupUrl &&
              isAllowedCodeWeaversAuthNavigationUrl(popupUrl, options) &&
              authWindow &&
              !authWindow.isDestroyed()
            ) {
              Promise.resolve(authWindow.loadURL(popupUrl)).catch(() => {});
            }
            return { action: 'deny' };
          });
        }

        if (typeof wc.on === 'function') {
          wc.on('will-navigate', (/** @type {any} */ event, /** @type {string} */ navUrl) => {
            if (!isAllowedCodeWeaversAuthNavigationUrl(navUrl, options)) {
              if (event && typeof event.preventDefault === 'function') {
                event.preventDefault();
              }
            }
          });

          wc.on('will-redirect', (/** @type {any} */ event, /** @type {string} */ navUrl) => {
            if (!isAllowedCodeWeaversAuthNavigationUrl(navUrl, options)) {
              if (event && typeof event.preventDefault === 'function') {
                event.preventDefault();
              }
              return;
            }
            try {
              const parsed = new URL(String(navUrl || '').trim());
              const pathname = parsed.pathname.toLowerCase();
              const host = parsed.hostname.toLowerCase();
              if (
                pathname.startsWith('/login') ||
                pathname.startsWith('/signin') ||
                host === 'challenges.cloudflare.com' ||
                host === 'google.com' ||
                host.endsWith('.google.com') ||
                host === 'appleid.apple.com'
              ) {
                sawLoginPage = true;
                autoTriggeredDownloadAfterLogin = false;
                revealAuthWindow();
              }
            } catch {}
          });

          wc.on('did-navigate', (/** @type {any} */ _event, /** @type {string} */ navUrl) => {
            if (settled || downloadCaptured || closingForCapture) return;
            try {
              const parsed = new URL(String(navUrl || '').trim());
              const host = parsed.hostname.toLowerCase();
              const isCodeWeaversOrigin =
                host === 'codeweavers.com' ||
                host.endsWith('.codeweavers.com') ||
                (options.allowLoopbackInstallerUrls === true &&
                  (host === '127.0.0.1' || host === 'localhost'));
              if (!isCodeWeaversOrigin) {
                sawLoginPage = true;
                revealAuthWindow();
                return;
              }
              const pathname = parsed.pathname.toLowerCase();
              if (
                pathname.startsWith('/login') ||
                pathname.startsWith('/signin') ||
                pathname.includes('/login/') ||
                pathname.endsWith('/login')
              ) {
                sawLoginPage = true;
                autoTriggeredDownloadAfterLogin = false;
                revealAuthWindow();
                return;
              }
              if (
                sawLoginPage &&
                !autoTriggeredDownloadAfterLogin &&
                !downloadCaptured &&
                !pathname.startsWith('/preview/download')
              ) {
                autoTriggeredDownloadAfterLogin = true;
                if (authWindow && !authWindow.isDestroyed()) {
                  Promise.resolve(authWindow.loadURL(previewDownloadUrl)).catch(() => {});
                }
              }
            } catch {}
          });

          wc.on(
            'did-navigate-in-page',
            (/** @type {any} */ _event, /** @type {string} */ navUrl) => {
              if (settled || downloadCaptured || closingForCapture) return;
              void inspectPortalAndTriggerDownload(navUrl, 0);
            }
          );

          wc.on('did-finish-load', () => {
            if (settled || downloadCaptured || closingForCapture) return;
            void inspectPortalAndTriggerDownload('', 0);
          });
        }
      }

      if (typeof authWindow.on === 'function') {
        authWindow.on('closed', () => {
          if (!settled && !downloadCaptured && !closingForCapture) {
            const abortErr = new Error('CodeWeavers Preview sign-in cancelled.');
            abortErr.name = 'AbortError';
            settleReject(abortErr);
          }
        });
      }

      Promise.resolve(authWindow.loadURL(previewDownloadUrl)).catch((/** @type {any} */ loadErr) => {
        if (settled || downloadCaptured || closingForCapture) return;
        const msg = String(loadErr?.message || '');
        const isAttachmentAbort =
          loadErr?.errno === -3 ||
          loadErr?.code === 'ERR_ABORTED' ||
          /ERR_ABORTED/i.test(msg);
        if (isAttachmentAbort) return;
        if (options.failOnLoadError === true) {
          forceCloseAuthWindow();
          settleReject(
            loadErr instanceof Error
              ? loadErr
              : new Error(`Failed to load CodeWeavers Preview sign-in page: ${msg}`)
          );
        }
      });
    } catch (initErr) {
      forceCloseAuthWindow();
      settleReject(initErr);
    }
  });
}

/**
 * Throw a structured runner-busy Error preserving `busyCode`.
 *
 * @param {{ ok: boolean, busyCode?: string, error?: string }} safeRes
 */
function throwIfRunnerBusy(safeRes) {
  if (safeRes && safeRes.ok === false) {
    const err = /** @type {Error & { busyCode?: string }} */ (
      new Error(safeRes.error || 'Compatibility runner is currently busy.')
    );
    if (safeRes.busyCode) {
      err.busyCode = safeRes.busyCode;
    }
    throw err;
  }
}

/**
 * Check whether an installed runner `.app` path belongs to a third-party external launcher manager.
 *
 * @param {string | null | undefined} appPath
 * @returns {string | null}
 */
function detectExternalRunnerManagerName(appPath) {
  const norm = String(appPath || '').replace(/\\/g, '/');
  if (!norm) return null;
  if (/\/heroic\/tools\//i.test(norm)) return 'Heroic Games Launcher';
  if (
    /\/Library\/Application Support\/(?:com\.isaacmarovitz\.)?Whisky\//i.test(norm) ||
    /\/Whisky\.app\//i.test(norm)
  ) {
    return 'Whisky';
  }
  if (norm.includes('Library/Application Support/Kegworks/Engines')) return 'Kegworks';
  if (/\/Sikarugir\//i.test(norm)) return 'Sikarugir';
  if (/\/Library\/Application Support\/Mythic\//i.test(norm)) return 'Mythic';
  return null;
}

/**
 * Direct vendor installation & in-place atomic update for macOS compatibility runners
 * (`crossover`, `wine`, `gptk`, `crossover_preview`) without requiring Homebrew.
 * Always uses ephemeral `os.tmpdir()` staging, verifies cryptographic digests/Ed25519/Developer ID
 * signatures BEFORE atomic `rename(2)` swap into `Applications`, and cleans up temp artifacts in `finally`.
 *
 * @param {string} rawRunnerType
 * @param {Record<string, any>} [options]
 * @returns {Promise<{ success: boolean, installed?: boolean, openedExternal?: boolean, openedExternalUrl?: string, switchedToStableCrossOver?: boolean, installedPath?: string, version?: string | null, message: string }>}
 */
async function installRunnerDirect(rawRunnerType, options = {}) {
  const requestedRunnerType = String(rawRunnerType || 'crossover')
    .trim()
    .toLowerCase();
  const effectiveRunnerType =
    requestedRunnerType === 'crossover_preview' && options.switchToStableCrossOver === true
      ? 'crossover'
      : requestedRunnerType;

  const { homedir } = resolveIsolatedHomedirAndUserData(options);
  let targetAppsDir = await resolveTargetMacApplicationsDir(homedir, options);
  const signal = /** @type {AbortSignal | undefined} */ (options.signal);

  /** @type {EnvironmentComponentId} */
  const componentId =
    effectiveRunnerType === 'crossover_preview'
      ? 'runner_crossover_preview'
      : effectiveRunnerType === 'wine'
        ? 'runner_wine'
        : effectiveRunnerType === 'gptk'
          ? 'runner_gptk'
          : 'runner_crossover';

  const progressCtx = options._progressCtx || {
    runId: String(options.runId || `runner-install-${Date.now()}`),
    componentId,
    stepIndex: 0,
    totalSteps: 1,
  };

  const detectedBefore = detectCompatibilityLayers({
    ...options,
    ...explicitHomedirOpt(options),
  });
  const existingLayer =
    options.existingLayer ||
    detectedBefore.find((/** @type {any} */ l) => l.type === effectiveRunnerType) ||
    null;

  const rawLocalArchive =
    typeof options.archivePath === 'string' && options.archivePath.trim()
      ? options.archivePath.trim()
      : '';
  const rawLocalDmg =
    typeof options.dmgPath === 'string' && options.dmgPath.trim()
      ? options.dmgPath.trim()
      : '';
  const explicitLocalInstallerPath = rawLocalArchive || rawLocalDmg;

  const externalMgr =
    detectExternalRunnerManagerName(existingLayer?.appPath) ||
    detectExternalRunnerManagerName(existingLayer?.binaryPath) ||
    (/\(Heroic|Whisky|Sikarugir|Kegworks|Mythic\)/i.test(String(existingLayer?.name || ''))
      ? 'External Manager'
      : null);

  /** @type {string | null} */
  let existingTargetAppPath = null;
  if (
    existingLayer &&
    typeof existingLayer.appPath === 'string' &&
    existingLayer.appPath.toLowerCase().endsWith('.app') &&
    !externalMgr &&
    typeof options.customApplicationsDir !== 'string'
  ) {
    const existingParent = path.dirname(existingLayer.appPath);
    try {
      if (options.homedir) {
        targetAppsDir = existingParent;
        existingTargetAppPath = existingLayer.appPath;
      } else {
        await fs.promises.access(existingParent, fs.constants.W_OK);
        targetAppsDir = existingParent;
        existingTargetAppPath = existingLayer.appPath;
      }
    } catch {}
  }

  // Pre-flight active-session & external OS process safety check before downloading or extracting
  const preflightSafe = await assertRunnerSafeToReplace(
    effectiveRunnerType,
    existingTargetAppPath,
    existingLayer,
    options
  );
  throwIfRunnerBusy(preflightSafe);

  if (typeof options.mockDirectDownload === 'function') {
    return await options.mockDirectDownload(effectiveRunnerType, {
      ...options,
      requestedRunnerType,
      targetAppsDir,
      existingLayer,
      existingTargetAppPath,
    });
  }

  /**
   * Finalize GPTK bundle staging: verify embedded Apple `D3DMetal.framework` signature BEFORE
   * stripping quarantine and running deep ad-hoc signing (`codesign --force --deep -s -`).
   *
   * @param {string} stagedApp
   */
  const verifyAndPrepareStagedGptkApp = async (stagedApp) => {
    const appBase = path.basename(stagedApp);
    const matchesGptkName = /^Game Porting Toolkit.*\.app$/i.test(appBase);
    const embeddedD3d = findEmbeddedD3DMetalFramework(stagedApp);
    const hasGptkLayout =
      fs.existsSync(path.join(stagedApp, 'Contents/Resources/wine')) || Boolean(embeddedD3d);
    if (!matchesGptkName && !hasGptkLayout) {
      await fs.promises.rm(stagedApp, { recursive: true, force: true }).catch(() => {});
      throw new Error(`"${appBase}" is not a valid Apple Game Porting Toolkit bundle.`);
    }

    if (embeddedD3d || options.requireD3DMetalSignatureCheck === true) {
      if (!embeddedD3d) {
        await fs.promises.rm(stagedApp, { recursive: true, force: true }).catch(() => {});
        throw new Error(
          `Embedded D3DMetal.framework was not found inside ${appBase}.`
        );
      }
      await verifyAppleSignedFramework(embeddedD3d, {
        ...options,
        _componentId: componentId,
        purgeDirOnFailure: stagedApp,
      });
    }

    await clearMacQuarantineAsync(stagedApp, { ...options, force: true });

    if (typeof options.verifySignatureFn === 'function') {
      await verifyMacAppDeveloperSignature(stagedApp, [], {
        ...options,
        _componentId: componentId,
        allowAdhocSignature: true,
      });
      return;
    }

    const execFn = getExecFileFn(options);
    const canExecCodesign =
      process.platform === 'darwin' ||
      typeof options.execFileFn === 'function' ||
      typeof options.execFileImpl === 'function';
    if (canExecCodesign) {
      await runExecFileAsync(
        execFn,
        '/usr/bin/codesign',
        ['--force', '--deep', '-s', '-', stagedApp],
        { timeout: 120000, signal }
      );
      await runExecFileAsync(
        execFn,
        '/usr/bin/codesign',
        ['--verify', '--deep', '--strict', stagedApp],
        { timeout: 60000, signal }
      );
    }
  };

  /**
   * Finalize Open-Source Wine bundle staging after SHA-256 archive verification:
   * upstream Gcenx `Wine Stable.app` / `Wine Staging.app` / `Wine Devel.app` tarballs ship an
   * unsigned outer `.app` wrapper around ad-hoc-signed inner `x86_64` binaries (`code object is not signed at all`).
   * Preserve any existing valid signature; if the outer bundle is unsigned, strip quarantine and apply
   * local ad-hoc signing (`codesign --force --deep -s -`) before strict verification, while still failing
   * closed if an existing signature was tampered or corrupted.
   *
   * @param {string} stagedApp
   */
  const verifyAndPrepareStagedWineApp = async (stagedApp) => {
    const appBase = path.basename(stagedApp);
    const hasWineLayout =
      /wine/i.test(appBase) ||
      fs.existsSync(path.join(stagedApp, 'Contents/Resources/wine')) ||
      fs.existsSync(path.join(stagedApp, 'Contents/SharedSupport/wine')) ||
      fs.existsSync(path.join(stagedApp, 'Contents/MacOS/wine'));
    if (!hasWineLayout) {
      await fs.promises.rm(stagedApp, { recursive: true, force: true }).catch(() => {});
      throw new Error(`"${appBase}" is not a valid macOS Wine bundle.`);
    }

    await clearMacQuarantineAsync(stagedApp, { ...options, force: true });

    if (typeof options.verifySignatureFn === 'function') {
      await verifyMacAppDeveloperSignature(stagedApp, [], {
        ...options,
        _componentId: componentId,
        allowAdhocSignature: true,
      });
      return;
    }

    const execFn = getExecFileFn(options);
    const canExecCodesign =
      process.platform === 'darwin' ||
      typeof options.execFileFn === 'function' ||
      typeof options.execFileImpl === 'function';

    if (canExecCodesign) {
      try {
        await runExecFileAsync(
          execFn,
          '/usr/bin/codesign',
          ['--verify', '--deep', '--strict', stagedApp],
          { timeout: 60000, signal }
        );
      } catch (verifyErr) {
        const errDetail = `${String(verifyErr?.stderr || '')} ${String(verifyErr?.message || '')}`;
        if (/not signed at all/i.test(errDetail)) {
          await runExecFileAsync(
            execFn,
            '/usr/bin/codesign',
            ['--force', '--deep', '-s', '-', stagedApp],
            { timeout: 180000, signal }
          );
        } else {
          await fs.promises.rm(stagedApp, { recursive: true, force: true }).catch(() => {});
          throw new Error(
            `Code signature verification failed for ${appBase}: ${String(verifyErr?.stderr || verifyErr?.message || verifyErr)}`
          );
        }
      }
    }

    await verifyMacAppDeveloperSignature(stagedApp, [], {
      ...options,
      _componentId: componentId,
      allowAdhocSignature: true,
    });
  };

  /**
   * Perform pre-swap safety guard and atomic `.app` installation.
   *
   * @param {string} stagedApp
   * @param {string} displayLabel
   * @param {string | null} [resolvedVersion]
   */
  const atomicSwapVerifiedApp = async (stagedApp, displayLabel, resolvedVersion = null) => {
    const destAppPath =
      existingTargetAppPath &&
      path.basename(existingTargetAppPath).toLowerCase() ===
        path.basename(stagedApp).toLowerCase()
        ? existingTargetAppPath
        : path.join(targetAppsDir, path.basename(stagedApp));

    const preSwapSafe = await assertRunnerSafeToReplace(
      effectiveRunnerType,
      destAppPath,
      existingLayer,
      options
    );
    throwIfRunnerBusy(preSwapSafe);

    emitEnvironmentSetupProgress(
      {
        ...progressCtx,
        phase: 'installing',
        message: `Installing ${path.basename(destAppPath)} to ${path.dirname(destAppPath)}...`,
      },
      options
    );

    const installedPath = await copyVerifiedMacAppToApplicationsDir(stagedApp, targetAppsDir, {
      ...options,
      targetAppBundlePath: destAppPath,
    });
    if (resolvedVersion && typeof recordRunnerInstallReceipt === 'function') {
      recordRunnerInstallReceipt(installedPath, effectiveRunnerType, resolvedVersion, {
        ...options,
        homedir,
      });
    }
    invalidateScanCaches();
    return {
      success: true,
      installed: true,
      installedPath,
      ...(resolvedVersion ? { version: resolvedVersion } : {}),
      message: `Installed ${displayLabel} to ${installedPath}.`,
    };
  };

  // -------------------------------------------------------------------------
  // Local Archive / Disk Image Path (`.dmg`, `.zip`, `.tar.xz`, `.txz`)
  // -------------------------------------------------------------------------
  if (explicitLocalInstallerPath) {
    if (
      explicitLocalInstallerPath.includes('\0') ||
      !path.isAbsolute(explicitLocalInstallerPath) ||
      path.basename(explicitLocalInstallerPath).startsWith('-')
    ) {
      throw new Error(
        `Rejected unsafe or non-absolute runner archive path: ${explicitLocalInstallerPath}`
      );
    }
    if (!fs.existsSync(explicitLocalInstallerPath)) {
      if (rawLocalArchive) {
        throw new Error(
          `Selected runner archive was not found on disk: ${path.basename(explicitLocalInstallerPath)}`
        );
      }
    } else {
      const lowerLocal = explicitLocalInstallerPath.toLowerCase();
      const isCodeWeaversRunner =
        effectiveRunnerType === 'crossover' || effectiveRunnerType === 'crossover_preview';

      if (lowerLocal.endsWith('.dmg')) {
        emitEnvironmentSetupProgress(
          {
            ...progressCtx,
            phase: 'verifying_signature',
            message: `Mounting and verifying ${path.basename(explicitLocalInstallerPath)}...`,
          },
          options
        );
        const preSwapSafe = await assertRunnerSafeToReplace(
          effectiveRunnerType,
          existingTargetAppPath,
          existingLayer,
          options
        );
        throwIfRunnerBusy(preSwapSafe);

        const installedPath = await mountVerifyAndInstallDmgApp(
          explicitLocalInstallerPath,
          targetAppsDir,
          isCodeWeaversRunner ? ['2C75U774H4'] : [],
          isCodeWeaversRunner ? /Developer ID Application:\s*CodeWeavers/i : null,
          {
            ...options,
            _componentId: componentId,
            ...(existingTargetAppPath ? { targetAppBundlePath: existingTargetAppPath } : {}),
            ...(effectiveRunnerType === 'gptk' ? { requireGptkBundle: true } : {}),
            ...(effectiveRunnerType === 'wine'
              ? { allowAdhocSignature: true, prepareUnsignedWineBundle: true }
              : {}),
          }
        );
        invalidateScanCaches();
        return {
          success: true,
          installed: true,
          installedPath,
          message: `Installed ${path.basename(installedPath)} to ${path.dirname(installedPath)}.`,
        };
      }

      if (/\.(?:zip|tar\.xz|txz)$/i.test(lowerLocal)) {
        const localTempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ol-runner-local-'));
        const execFn = getExecFileFn(options);
        try {
          const stagingDir = path.join(localTempDir, 'staging');
          await fs.promises.mkdir(stagingDir, { recursive: true });
          emitEnvironmentSetupProgress(
            {
              ...progressCtx,
              phase: 'extracting',
              message: `Extracting ${path.basename(explicitLocalInstallerPath)}...`,
            },
            options
          );
          if (typeof options.onExtractArchive === 'function') {
            await options.onExtractArchive(explicitLocalInstallerPath, stagingDir);
          } else if (lowerLocal.endsWith('.zip')) {
            await runExecFileAsync(
              execFn,
              '/usr/bin/ditto',
              ['-x', '-k', explicitLocalInstallerPath, stagingDir],
              { timeout: 300000, signal }
            );
          } else {
            await runExecFileAsync(
              execFn,
              '/usr/bin/tar',
              ['-xf', explicitLocalInstallerPath, '-C', stagingDir],
              { timeout: 300000, signal }
            );
          }

          const stagedApp = await findStagedAppBundle(stagingDir);
          if (!stagedApp) {
            throw new Error(
              `No macOS .app bundle found inside ${path.basename(explicitLocalInstallerPath)}.`
            );
          }

          emitEnvironmentSetupProgress(
            {
              ...progressCtx,
              phase: 'verifying_signature',
              message: `Verifying ${path.basename(stagedApp)} signature...`,
            },
            options
          );

          if (effectiveRunnerType === 'gptk') {
            await verifyAndPrepareStagedGptkApp(stagedApp);
          } else if (isCodeWeaversRunner) {
            await verifyMacAppDeveloperSignature(stagedApp, ['2C75U774H4'], {
              ...options,
              _componentId: componentId,
              expectedVendorAuthorityPattern: /Developer ID Application:\s*CodeWeavers/i,
            });
          } else if (effectiveRunnerType === 'wine') {
            await verifyAndPrepareStagedWineApp(stagedApp);
          } else {
            await verifyMacAppDeveloperSignature(stagedApp, [], {
              ...options,
              _componentId: componentId,
              allowAdhocSignature: true,
            });
          }

          return await atomicSwapVerifiedApp(
            stagedApp,
            formatRunnerDisplayLabel(effectiveRunnerType, existingLayer)
          );
        } finally {
          try {
            await fs.promises.rm(localTempDir, { recursive: true, force: true });
          } catch {}
        }
      }

      throw new Error(
        `Unsupported runner archive format (${path.basename(explicitLocalInstallerPath)}). Expected .zip, .dmg, .tar.xz, or .txz.`
      );
    }
  }

  // -------------------------------------------------------------------------
  // CrossOver Preview:
  // 1) Explicit local `dmgPath` / `archivePath` (handled above).
  // 2) Installed `CrossOver Preview.app` Sparkle `SUFeedURL` on an allowed CodeWeavers host.
  // 3) Installed `existingLayer` where public `cxmac.xml` Stable has strictly surpassed Preview.
  // 4) Sandboxed in-app CodeWeavers sign-in (`persist:codeweavers-preview`) + auto-captured install.
  // 5) Headless / `skipNetwork` fallback to official CodeWeavers Preview portal.
  // -------------------------------------------------------------------------
  /** @type {{ xml: string, feedUrl: string, sparklePublicEdKey: string } | null} */
  let resolvedPreviewSparkleFeed = null;
  if (effectiveRunnerType === 'crossover_preview') {
    const portalUrl = 'https://www.codeweavers.com/preview/download';
    if (options.skipNetwork === true) {
      await openExternalUri(portalUrl, options);
      return {
        success: true,
        installed: false,
        openedExternal: true,
        openedExternalUrl: portalUrl,
        message: 'Opened official CodeWeavers Preview download portal in your browser.',
      };
    }

    if (existingLayer?.appPath && typeof parsePlistStringValues === 'function') {
      const plistDict = parsePlistStringValues(
        path.join(existingLayer.appPath, 'Contents/Info.plist')
      );
      const rawSuFeedUrl = String(options.previewFeedUrl || plistDict.SUFeedURL || '').trim();
      const rawSuPubKey = String(
        options.sparklePublicEdKey ||
          plistDict.SUPublicEDKey ||
          CODEWEAVERS_SPARKLE_PUBLIC_ED_KEY
      ).trim();
      if (rawSuFeedUrl) {
        try {
          const parsedFeedHost = new URL(rawSuFeedUrl).hostname.toLowerCase();
          const isAllowedPreviewFeedHost =
            parsedFeedHost === 'codeweavers.com' ||
            parsedFeedHost === 'www.codeweavers.com' ||
            parsedFeedHost === 'media.codeweavers.com' ||
            (options.allowLoopbackInstallerUrls === true &&
              (parsedFeedHost === '127.0.0.1' || parsedFeedHost === 'localhost'));
          if (isAllowedPreviewFeedHost) {
            const safeFeedUrl = validateInstallerUrl(rawSuFeedUrl, options);
            emitEnvironmentSetupProgress(
              {
                ...progressCtx,
                phase: 'probing',
                message: 'Resolving latest CrossOver Preview release from CodeWeavers Sparkle feed...',
              },
              options
            );
            const previewXml = await fetchValidatedText(safeFeedUrl, options, signal);
            const encCheck = previewXml.match(/<enclosure\b([^>]*)>/i);
            const urlAttrCheck = encCheck ? encCheck[1].match(/\burl=["']([^"']+)["']/i) : null;
            if (urlAttrCheck && urlAttrCheck[1].trim()) {
              validateInstallerUrl(urlAttrCheck[1].trim(), options);
              resolvedPreviewSparkleFeed = {
                xml: previewXml,
                feedUrl: safeFeedUrl,
                sparklePublicEdKey: rawSuPubKey,
              };
            }
          }
        } catch (err) {
          if (isFatalSecurityOrAbortError(err, signal)) {
            throw err;
          }
        }
      }
    }

    if (!resolvedPreviewSparkleFeed) {
      if (existingLayer?.version) {
        try {
          const stableXml = await fetchValidatedText(
            'https://www.codeweavers.com/xml/versions/cxmac.xml',
            options,
            signal
          );
          const encMatch = stableXml.match(/<enclosure\b([^>]*)>/i);
          const encAttrs = encMatch ? encMatch[1] : '';
          const verMatch = encAttrs.match(/\bsparkle:version=["']([^"']+)["']/i);
          const shortMatch = encAttrs.match(/\bsparkle:shortVersionString=["']([^"']+)["']/i);
          const rawBundleVer = verMatch ? verMatch[1].trim() : '';
          const rawShortVer = shortMatch ? shortMatch[1].trim() : '';
          const semverMatch = rawBundleVer.match(/^(\d+\.\d+\.\d+)(?:\.(\d+))?$/);
          const stableLatestVer = semverMatch ? semverMatch[1] : rawShortVer || rawBundleVer;
          if (
            stableLatestVer &&
            typeof compareRunnerVersions === 'function' &&
            compareRunnerVersions(existingLayer.version, stableLatestVer) < 0
          ) {
            const existingStableLayer =
              detectedBefore.find((/** @type {any} */ l) => l.type === 'crossover') || null;
            const stableRes = await installRunnerDirect('crossover', {
              ...options,
              switchToStableCrossOver: true,
              existingLayer: existingStableLayer,
              _prefetchedCxMacXml: stableXml,
            });
            return {
              ...stableRes,
              switchedToStableCrossOver: true,
            };
          }
        } catch (err) {
          if (isFatalSecurityOrAbortError(err, signal)) {
            throw err;
          }
        }
      }

      const electronModForCapture = (options && options.electronMod) || getElectron();
      const canCapturePreviewInApp =
        typeof options.capturePreviewDownloadFn === 'function' ||
        (Boolean(electronModForCapture?.BrowserWindow) &&
          Boolean(electronModForCapture?.session) &&
          (!isTestEnvironment(options) || options.allowInteractivePreviewCapture === true));

      if (canCapturePreviewInApp) {
        const previewTempDir = await fs.promises.mkdtemp(
          path.join(os.tmpdir(), 'ol-cx-preview-')
        );
        const execFn = getExecFileFn(options);
        try {
          const captured = await captureCodeWeaversPreviewDownload(
            previewTempDir,
            progressCtx,
            options,
            signal
          );
          const capturedArchivePath = captured.archivePath;
          let resolvedVersion = captured.resolvedVersion || null;

          if (
            typeof options.expectedSha256 === 'string' &&
            /^[a-f0-9]{64}$/i.test(options.expectedSha256.trim())
          ) {
            emitEnvironmentSetupProgress(
              {
                ...progressCtx,
                phase: 'verifying_signature',
                message: 'Verifying CrossOver Preview archive SHA-256 checksum...',
              },
              options
            );
            await verifyFileSha256Async(
              capturedArchivePath,
              options.expectedSha256.trim().toLowerCase()
            );
          }

          if (/\.dmg$/i.test(capturedArchivePath)) {
            emitEnvironmentSetupProgress(
              {
                ...progressCtx,
                phase: 'verifying_signature',
                message: 'Verifying CodeWeavers Developer ID signature...',
              },
              options
            );
            const preSwapSafe = await assertRunnerSafeToReplace(
              effectiveRunnerType,
              existingTargetAppPath,
              existingLayer,
              options
            );
            throwIfRunnerBusy(preSwapSafe);

            const installedPath = await mountVerifyAndInstallDmgApp(
              capturedArchivePath,
              targetAppsDir,
              ['2C75U774H4'],
              /Developer ID Application:\s*CodeWeavers/i,
              {
                ...options,
                _componentId: componentId,
                ...(existingTargetAppPath ? { targetAppBundlePath: existingTargetAppPath } : {}),
              }
            );
            resolvedVersion = resolvePreviewBundleVersion(installedPath, resolvedVersion);
            if (
              resolvedVersion &&
              !/^\d{8}$/.test(resolvedVersion) &&
              typeof recordRunnerInstallReceipt === 'function'
            ) {
              recordRunnerInstallReceipt(installedPath, effectiveRunnerType, resolvedVersion, {
                ...options,
                homedir,
              });
            }
            invalidateScanCaches();
            return {
              success: true,
              installed: true,
              installedPath,
              ...(resolvedVersion ? { version: resolvedVersion } : {}),
              message: `Installed CrossOver Preview to ${installedPath}.`,
            };
          }

          const stagingDir = path.join(previewTempDir, 'staging');
          await fs.promises.mkdir(stagingDir, { recursive: true });
          emitEnvironmentSetupProgress(
            {
              ...progressCtx,
              phase: 'extracting',
              message: 'Extracting CrossOver Preview archive...',
            },
            options
          );

          if (typeof options.onExtractArchive === 'function') {
            await options.onExtractArchive(capturedArchivePath, stagingDir);
          } else {
            await runExecFileAsync(
              execFn,
              '/usr/bin/ditto',
              ['-x', '-k', capturedArchivePath, stagingDir],
              { timeout: 300000, signal }
            );
          }

          const stagedApp = await findStagedAppBundle(stagingDir);
          if (!stagedApp) {
            throw new Error(
              'CrossOver Preview.app was not found inside the downloaded archive.'
            );
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

          resolvedVersion = resolvePreviewBundleVersion(stagedApp, resolvedVersion);
          return await atomicSwapVerifiedApp(
            stagedApp,
            'CrossOver Preview',
            resolvedVersion && !/^\d{8}$/.test(resolvedVersion) ? resolvedVersion : null
          );
        } finally {
          try {
            await fs.promises.rm(previewTempDir, { recursive: true, force: true });
          } catch {}
        }
      }

      await openExternalUri(portalUrl, options);
      return {
        success: true,
        installed: false,
        openedExternal: true,
        openedExternalUrl: portalUrl,
        message: 'Opened official CodeWeavers Preview download portal in your browser.',
      };
    }
  }

  // -------------------------------------------------------------------------
  // Apple Game Porting Toolkit (`gptk`): Automated GitHub `.tar.xz` on Apple Silicon macOS 14+
  // -------------------------------------------------------------------------
  if (effectiveRunnerType === 'gptk') {
    const hostArch = String(options.arch || process.arch);
    const darwinKernelMajor = resolveDarwinKernelMajor(options);
    if (hostArch !== 'arm64' || darwinKernelMajor < 23) {
      const portalUrl = 'https://developer.apple.com/games/game-porting-toolkit/';
      await openExternalUri(portalUrl, options);
      return {
        success: true,
        installed: false,
        openedExternal: true,
        openedExternalUrl: portalUrl,
        message:
          'Apple Game Porting Toolkit automated install requires Apple Silicon on macOS 14 Sonoma or newer; opened Apple Developer portal.',
      };
    }
  }

  const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ol-env-setup-'));
  const execFileFn = getExecFileFn(options);

  try {
    // -----------------------------------------------------------------------
    // 1. CrossOver Stable (`crossover`) & Sparkle-Enabled CrossOver Preview (`crossover_preview`)
    // -----------------------------------------------------------------------
    if (effectiveRunnerType === 'crossover' || effectiveRunnerType === 'crossover_preview') {
      const isPreviewSparkle =
        effectiveRunnerType === 'crossover_preview' && Boolean(resolvedPreviewSparkleFeed);
      const cwLabel = isPreviewSparkle ? 'CrossOver Preview' : 'CrossOver';
      if (!isPreviewSparkle && !options._prefetchedCxMacXml) {
        emitEnvironmentSetupProgress(
          {
            ...progressCtx,
            phase: 'probing',
            message: 'Resolving latest CrossOver release from CodeWeavers Sparkle feed...',
          },
          options
        );
      }
      const xml = isPreviewSparkle
        ? String(resolvedPreviewSparkleFeed?.xml || '')
        : typeof options._prefetchedCxMacXml === 'string' && options._prefetchedCxMacXml
          ? options._prefetchedCxMacXml
          : await fetchValidatedText(
              'https://www.codeweavers.com/xml/versions/cxmac.xml',
              options,
              signal
            );
      const encMatch = xml.match(/<enclosure\b([^>]*)>/i);
      const encAttrs = encMatch ? encMatch[1] : '';
      const urlMatch = encAttrs.match(/\burl=["']([^"']+)["']/i);
      const archiveUrl = urlMatch ? validateInstallerUrl(urlMatch[1].trim(), options) : '';
      if (!archiveUrl) {
        throw new Error(`Could not find ${cwLabel} download URL in CodeWeavers Sparkle feed.`);
      }

      const lenMatch = encAttrs.match(/\blength=["'](\d+)["']/i);
      const expectedByteLength =
        typeof options.expectedByteLength === 'number' && options.expectedByteLength > 0
          ? options.expectedByteLength
          : lenMatch
            ? Number.parseInt(lenMatch[1], 10)
            : 0;
      const edSigMatch = encAttrs.match(/\bsparkle:edSignature=["']([^"']+)["']/i);
      const sparkleEdSignature = String(
        options.expectedEdSignature || (edSigMatch ? edSigMatch[1] : '') || ''
      ).trim();
      const shortVerMatch =
        encAttrs.match(/\bsparkle:shortVersionString=["']([^"']+)["']/i) ||
        xml.match(/<sparkle:shortVersionString>([^<]+)<\/sparkle:shortVersionString>/i);
      const sparkleVerMatch =
        encAttrs.match(/\bsparkle:version=["']([^"']+)["']/i) ||
        xml.match(/<sparkle:version>([^<]+)<\/sparkle:version>/i);
      const rawShortVer = String(shortVerMatch?.[1] || '').trim();
      const rawSparkleVer = String(sparkleVerMatch?.[1] || '').trim();
      const sparkleSemverMatch = rawSparkleVer.match(/^(\d+\.\d+\.\d+)(?:\.\d+)?$/);
      const resolvedVersion =
        (/^\d{8}$/.test(rawShortVer) && sparkleSemverMatch
          ? sparkleSemverMatch[1]
          : rawShortVer || rawSparkleVer) || null;

      let caskSha256 =
        typeof options.expectedSha256 === 'string' &&
        /^[a-f0-9]{64}$/i.test(options.expectedSha256.trim())
          ? options.expectedSha256.trim().toLowerCase()
          : '';
      if (!caskSha256 && !isPreviewSparkle) {
        try {
          const caskTxt = await fetchValidatedText(
            'https://formulae.brew.sh/api/cask/crossover.json',
            options,
            signal
          );
          const caskJson = JSON.parse(caskTxt);
          const caskUrl = typeof caskJson?.url === 'string' ? caskJson.url.trim() : '';
          const caskVer = String(caskJson?.version || '')
            .split(',')[0]
            .trim();
          const rawCaskSha = String(caskJson?.sha256 || '')
            .trim()
            .toLowerCase();
          const matchesRelease =
            (caskUrl && caskUrl === archiveUrl) ||
            (resolvedVersion && caskVer && resolvedVersion.startsWith(caskVer));
          if (matchesRelease && /^[a-f0-9]{64}$/.test(rawCaskSha)) {
            caskSha256 = rawCaskSha;
          }
        } catch (err) {
          if (isFatalSecurityOrAbortError(err, signal)) {
            throw err;
          }
        }
      }

      const isDmg = /\.dmg(?:\?|$)/i.test(archiveUrl);
      const archiveBaseStem = isPreviewSparkle ? 'CrossOverPreview' : 'CrossOver';
      const archivePath = path.join(tempDir, isDmg ? `${archiveBaseStem}.dmg` : `${archiveBaseStem}.zip`);
      await streamVerifiedDownloadToFile(
        archiveUrl,
        archivePath,
        {
          ...progressCtx,
          label: cwLabel,
          minFreeBytes: 1200 * 1024 * 1024,
        },
        options,
        signal
      );

      if (expectedByteLength > 0) {
        const archiveStat = await fs.promises.stat(archivePath);
        if (archiveStat.size !== expectedByteLength) {
          await fs.promises.rm(archivePath, { force: true }).catch(() => {});
          throw new Error(
            `${cwLabel} download size mismatch: expected ${expectedByteLength} bytes, got ${archiveStat.size} bytes.`
          );
        }
      }

      if (caskSha256) {
        emitEnvironmentSetupProgress(
          {
            ...progressCtx,
            phase: 'verifying_signature',
            message: `Verifying ${cwLabel} archive SHA-256 checksum...`,
          },
          options
        );
        await verifyFileSha256Async(archivePath, caskSha256);
      }

      if (sparkleEdSignature) {
        emitEnvironmentSetupProgress(
          {
            ...progressCtx,
            phase: 'verifying_signature',
            message: 'Verifying CodeWeavers Sparkle Ed25519 signature...',
          },
          options
        );
        const pubKey = String(
          options.sparklePublicEdKey ||
            resolvedPreviewSparkleFeed?.sparklePublicEdKey ||
            CODEWEAVERS_SPARKLE_PUBLIC_ED_KEY
        ).trim();
        await verifySparkleEd25519SignatureAsync(archivePath, sparkleEdSignature, pubKey);
      } else if (
        (options.requireSparkleEdSignature === true ||
          (isPreviewSparkle && !isTestEnvironment(options))) &&
        !caskSha256
      ) {
        await fs.promises.rm(archivePath, { force: true }).catch(() => {});
        throw new Error(
          `${cwLabel} Sparkle feed is missing required sparkle:edSignature attribute.`
        );
      }

      if (isDmg) {
        emitEnvironmentSetupProgress(
          {
            ...progressCtx,
            phase: 'verifying_signature',
            message: 'Verifying CodeWeavers Developer ID signature...',
          },
          options
        );
        const preSwapSafe = await assertRunnerSafeToReplace(
          effectiveRunnerType,
          existingTargetAppPath,
          existingLayer,
          options
        );
        throwIfRunnerBusy(preSwapSafe);

        const installedPath = await mountVerifyAndInstallDmgApp(
          archivePath,
          targetAppsDir,
          ['2C75U774H4'],
          /Developer ID Application:\s*CodeWeavers/i,
          {
            ...options,
            _componentId: componentId,
            ...(existingTargetAppPath ? { targetAppBundlePath: existingTargetAppPath } : {}),
          }
        );
        if (resolvedVersion && typeof recordRunnerInstallReceipt === 'function') {
          recordRunnerInstallReceipt(installedPath, effectiveRunnerType, resolvedVersion, {
            ...options,
            homedir,
          });
        }
        invalidateScanCaches();
        return {
          success: true,
          installed: true,
          installedPath,
          ...(resolvedVersion ? { version: resolvedVersion } : {}),
          message: `Installed ${cwLabel} to ${installedPath}.`,
        };
      }

      const stagingDir = path.join(tempDir, 'staging');
      await fs.promises.mkdir(stagingDir, { recursive: true });
      emitEnvironmentSetupProgress(
        {
          ...progressCtx,
          phase: 'extracting',
          message: `Extracting ${cwLabel} archive...`,
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
        throw new Error(`${cwLabel}.app was not found inside the downloaded archive.`);
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

      return await atomicSwapVerifiedApp(stagedApp, cwLabel, resolvedVersion);
    }

    // -----------------------------------------------------------------------
    // 2. Open-Source Wine (`wine`: `stable` | `staging` | `devel`)
    // -----------------------------------------------------------------------
    if (effectiveRunnerType === 'wine') {
      const existingCombined = `${existingLayer?.name || ''} ${existingLayer?.appPath || ''} ${existingLayer?.binaryPath || ''}`;
      if (
        options._runnerOperation === 'update' &&
        !options.wineChannel &&
        /wine[-_\s]*crossover/i.test(existingCombined)
      ) {
        throw new Error(
          'Wine Crossover is a retired distribution and cannot be updated in place. Install Wine Stable or CrossOver instead.'
        );
      }

      const wineChannel = (() => {
        const rawChan = String(options.wineChannel || '')
          .trim()
          .toLowerCase();
        if (rawChan === 'staging' || rawChan === 'devel' || rawChan === 'stable') {
          return rawChan;
        }
        if (/wine[-_\s]*staging/i.test(existingCombined)) return 'staging';
        if (/wine[-_\s]*devel/i.test(existingCombined)) return 'devel';
        return 'stable';
      })();

      const wineLabel =
        wineChannel === 'staging'
          ? 'Wine Staging'
          : wineChannel === 'devel'
            ? 'Wine Devel'
            : 'Wine Stable';
      const caskApiUrl =
        wineChannel === 'staging'
          ? 'https://formulae.brew.sh/api/cask/wine@staging.json'
          : wineChannel === 'devel'
            ? 'https://formulae.brew.sh/api/cask/wine@devel.json'
            : 'https://formulae.brew.sh/api/cask/wine-stable.json';
      const assetNameRe =
        wineChannel === 'staging'
          ? /wine[-_]?staging.*\.(?:tar\.xz|txz|dmg)$/i
          : wineChannel === 'devel'
            ? /wine[-_]?devel.*\.(?:tar\.xz|txz|dmg)$/i
            : /wine[-_]?stable.*\.(?:tar\.xz|txz|dmg)$/i;

      emitEnvironmentSetupProgress(
        {
          ...progressCtx,
          phase: 'probing',
          message: `Resolving latest Open-Source ${wineLabel} release...`,
        },
        options
      );

      let assetUrl = '';
      let resolvedVersion = /** @type {string | null} */ (null);
      let expectedSha256 =
        typeof options.expectedSha256 === 'string' &&
        /^[a-f0-9]{64}$/i.test(options.expectedSha256.trim())
          ? options.expectedSha256.trim().toLowerCase()
          : '';

      const tryResolveWineFromCaskApi = async (allowDisabled = false) => {
        try {
          const caskTxt = await fetchValidatedText(caskApiUrl, options, signal);
          const caskJson = JSON.parse(caskTxt);
          if (
            caskJson &&
            (allowDisabled || caskJson.disabled !== true) &&
            typeof caskJson.url === 'string' &&
            caskJson.url.trim()
          ) {
            assetUrl = validateInstallerUrl(caskJson.url.trim(), options);
            if (typeof caskJson.version === 'string' && caskJson.version.trim()) {
              resolvedVersion = caskJson.version.split(',')[0].trim();
            }
            if (
              !expectedSha256 &&
              typeof caskJson.sha256 === 'string' &&
              /^[a-f0-9]{64}$/i.test(caskJson.sha256.trim())
            ) {
              expectedSha256 = caskJson.sha256.trim().toLowerCase();
            }
          }
        } catch (err) {
          if (isFatalSecurityOrAbortError(err, signal)) {
            throw err;
          }
        }
      };

      const extractWineAssetFromReleaseObj = (/** @type {any} */ relObj) => {
        const assets = Array.isArray(relObj?.assets) ? relObj.assets : [];
        const matchedAsset = assets.find((/** @type {any} */ a) =>
          assetNameRe.test(String(a?.name || ''))
        );
        if (!matchedAsset?.browser_download_url) return false;
        assetUrl = validateInstallerUrl(
          String(matchedAsset.browser_download_url).trim(),
          options
        );
        const rawTag = String(relObj?.tag_name || relObj?.name || matchedAsset?.name || '')
          .replace(/^v/i, '')
          .trim();
        const tagVerMatch = rawTag.match(/(\d+\.\d+(?:\.\d+)?(?:[-_][0-9A-Za-z.]+)?)/);
        if (tagVerMatch) resolvedVersion = tagVerMatch[1];
        else if (rawTag) resolvedVersion = rawTag;
        const rawDigest = String(matchedAsset?.digest || '').trim();
        if (!expectedSha256 && /^sha256:[a-f0-9]{64}$/i.test(rawDigest)) {
          expectedSha256 = rawDigest.slice(7).toLowerCase();
        }
        return true;
      };

      const tryResolveWineFromGitHubReleases = async () => {
        try {
          const ghListTxt = await fetchValidatedText(
            'https://api.github.com/repos/Gcenx/macOS_Wine_builds/releases?per_page=20',
            options,
            signal
          );
          const ghList = JSON.parse(ghListTxt);
          if (Array.isArray(ghList)) {
            for (const rel of ghList) {
              if (rel && !rel.draft && extractWineAssetFromReleaseObj(rel)) {
                break;
              }
            }
          } else if (ghList && typeof ghList === 'object') {
            extractWineAssetFromReleaseObj(ghList);
          }
        } catch (err) {
          if (isFatalSecurityOrAbortError(err, signal)) {
            throw err;
          }
        }

        if (!assetUrl) {
          try {
            const ghLatestTxt = await fetchValidatedText(
              'https://api.github.com/repos/Gcenx/macOS_Wine_builds/releases/latest',
              options,
              signal
            );
            extractWineAssetFromReleaseObj(JSON.parse(ghLatestTxt));
          } catch (err) {
            if (isFatalSecurityOrAbortError(err, signal)) {
              throw err;
            }
          }
        }

        if (assetUrl && !expectedSha256) {
          try {
            const caskRb = await fetchValidatedText(
              `https://raw.githubusercontent.com/Gcenx/homebrew-wine/master/Casks/wine-${wineChannel}.rb`,
              options,
              signal
            );
            const shaMatch = caskRb.match(/\bsha256\s+["']([a-f0-9]{64})["']/i);
            const verMatch = caskRb.match(/\bversion\s+["']([^"']+)["']/i);
            const caskSha = shaMatch ? shaMatch[1].toLowerCase() : '';
            const caskVer = verMatch ? verMatch[1].trim() : '';
            if (
              caskSha &&
              (!caskVer ||
                !resolvedVersion ||
                resolvedVersion === caskVer ||
                assetUrl.includes(caskVer))
            ) {
              expectedSha256 = caskSha;
            }
          } catch (err) {
            if (isFatalSecurityOrAbortError(err, signal)) {
              throw err;
            }
          }
        }
      };

      if (wineChannel === 'stable') {
        await tryResolveWineFromCaskApi(false);
        if (!assetUrl) {
          await tryResolveWineFromGitHubReleases();
        }
      } else {
        await tryResolveWineFromGitHubReleases();
        if (!assetUrl) {
          await tryResolveWineFromCaskApi(true);
        }
      }

      if (!assetUrl) {
        throw new Error(`Could not resolve Open-Source ${wineLabel} download asset URL.`);
      }

      const isDmg = /\.dmg(?:\?|$)/i.test(assetUrl);
      const safeFileStem = wineLabel.replace(/\s+/g, '');
      const archivePath = path.join(
        tempDir,
        isDmg ? `${safeFileStem}.dmg` : `${safeFileStem}.tar.xz`
      );
      await streamVerifiedDownloadToFile(
        assetUrl,
        archivePath,
        {
          ...progressCtx,
          label: wineLabel,
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
            message: `Verifying ${wineLabel} archive SHA-256 checksum...`,
          },
          options
        );
        await verifyFileSha256Async(archivePath, expectedSha256);
      } else if (!isTestEnvironment(options) && options.allowUnverifiedArchiveDigest !== true) {
        await fs.promises.rm(archivePath, { force: true }).catch(() => {});
        throw new Error(
          `Refusing to extract ${wineLabel} archive without a cryptographic SHA-256 digest.`
        );
      }

      if (isDmg) {
        emitEnvironmentSetupProgress(
          {
            ...progressCtx,
            phase: 'verifying_signature',
            message: `Verifying ${wineLabel} code signature integrity...`,
          },
          options
        );
        const preSwapSafe = await assertRunnerSafeToReplace(
          effectiveRunnerType,
          existingTargetAppPath,
          existingLayer,
          options
        );
        throwIfRunnerBusy(preSwapSafe);

        const installedPath = await mountVerifyAndInstallDmgApp(
          archivePath,
          targetAppsDir,
          [],
          null,
          {
            ...options,
            _componentId: componentId,
            allowAdhocSignature: true,
            prepareUnsignedWineBundle: true,
            ...(existingTargetAppPath ? { targetAppBundlePath: existingTargetAppPath } : {}),
          }
        );
        if (resolvedVersion && typeof recordRunnerInstallReceipt === 'function') {
          recordRunnerInstallReceipt(installedPath, effectiveRunnerType, resolvedVersion, {
            ...options,
            homedir,
          });
        }
        invalidateScanCaches();
        return {
          success: true,
          installed: true,
          installedPath,
          ...(resolvedVersion ? { version: resolvedVersion } : {}),
          message: `Installed ${wineLabel} to ${installedPath}.`,
        };
      }

      const stagingDir = path.join(tempDir, 'staging');
      await fs.promises.mkdir(stagingDir, { recursive: true });
      emitEnvironmentSetupProgress(
        {
          ...progressCtx,
          phase: 'extracting',
          message: `Extracting ${wineLabel} archive...`,
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
        throw new Error(`${wineLabel}.app was not found inside the downloaded archive.`);
      }

      emitEnvironmentSetupProgress(
        {
          ...progressCtx,
          phase: 'verifying_signature',
          message: `Verifying ${wineLabel} code signature integrity...`,
        },
        options
      );
      await verifyAndPrepareStagedWineApp(stagedApp);

      return await atomicSwapVerifiedApp(stagedApp, wineLabel, resolvedVersion);
    }

    // -----------------------------------------------------------------------
    // 3. Apple Game Porting Toolkit (`gptk`: Apple Silicon macOS 14+)
    // -----------------------------------------------------------------------
    if (effectiveRunnerType === 'gptk') {
      emitEnvironmentSetupProgress(
        {
          ...progressCtx,
          phase: 'probing',
          message: 'Resolving latest Apple Game Porting Toolkit release...',
        },
        options
      );

      let assetUrl = '';
      let resolvedVersion = /** @type {string | null} */ (null);
      let expectedSha256 =
        typeof options.expectedSha256 === 'string' &&
        /^[a-f0-9]{64}$/i.test(options.expectedSha256.trim())
          ? options.expectedSha256.trim().toLowerCase()
          : '';

      const ghTxt = await fetchValidatedText(
        'https://api.github.com/repos/Gcenx/game-porting-toolkit/releases/latest',
        options,
        signal
      );
      const ghJson = JSON.parse(ghTxt);
      const rawTag = String(ghJson?.tag_name || ghJson?.name || '')
        .replace(/^game-porting-toolkit[-_]?v?/i, '')
        .replace(/^v/i, '')
        .trim();
      if (rawTag) {
        const tagVerMatch = rawTag.match(/(\d+\.\d+(?:\.\d+)?(?:[-_][0-9A-Za-z.]+)?)/);
        resolvedVersion = tagVerMatch ? tagVerMatch[1] : rawTag;
      }
      const assets = Array.isArray(ghJson?.assets) ? ghJson.assets : [];
      const matchedAsset =
        assets.find((/** @type {any} */ a) =>
          /\.(?:tar\.xz|txz)$/i.test(String(a?.name || ''))
        ) ||
        assets.find((/** @type {any} */ a) => /\.dmg$/i.test(String(a?.name || '')));
      if (matchedAsset?.browser_download_url) {
        assetUrl = validateInstallerUrl(
          String(matchedAsset.browser_download_url).trim(),
          options
        );
        const rawDigest = String(matchedAsset?.digest || '').trim();
        if (!expectedSha256 && /^sha256:[a-f0-9]{64}$/i.test(rawDigest)) {
          expectedSha256 = rawDigest.slice(7).toLowerCase();
        }
      }

      if (!assetUrl) {
        throw new Error(
          'Could not resolve Apple Game Porting Toolkit download asset from GitHub release feed.'
        );
      }

      // Cross-check SHA-256 against Gcenx homebrew-wine cask when available
      try {
        const caskRb = await fetchValidatedText(
          'https://raw.githubusercontent.com/Gcenx/homebrew-wine/master/Casks/game-porting-toolkit.rb',
          options,
          signal
        );
        const shaMatch = caskRb.match(/\bsha256\s+["']([a-f0-9]{64})["']/i);
        const verMatch = caskRb.match(/\bversion\s+["']([^"']+)["']/i);
        const caskSha = shaMatch ? shaMatch[1].toLowerCase() : '';
        const caskVer = verMatch ? verMatch[1].trim() : '';
        if (caskSha) {
          const sameRelease =
            !caskVer ||
            !resolvedVersion ||
            resolvedVersion === caskVer ||
            assetUrl.includes(caskVer);
          if (sameRelease) {
            if (expectedSha256 && expectedSha256 !== caskSha) {
              throw new Error(
                `Game Porting Toolkit SHA-256 mismatch between GitHub release (${expectedSha256}) and cask (${caskSha}).`
              );
            }
            if (!expectedSha256) {
              expectedSha256 = caskSha;
            }
          }
        }
      } catch (err) {
        if (
          isFatalSecurityOrAbortError(err, signal) ||
          /SHA-256 mismatch between GitHub release/i.test(String(err?.message || ''))
        ) {
          throw err;
        }
      }

      const isDmg = /\.dmg(?:\?|$)/i.test(assetUrl);
      const archivePath = path.join(
        tempDir,
        isDmg ? 'GamePortingToolkit.dmg' : 'GamePortingToolkit.tar.xz'
      );
      await streamVerifiedDownloadToFile(
        assetUrl,
        archivePath,
        {
          ...progressCtx,
          label: 'Apple Game Porting Toolkit',
          minFreeBytes: 900 * 1024 * 1024,
        },
        options,
        signal
      );

      if (expectedSha256) {
        emitEnvironmentSetupProgress(
          {
            ...progressCtx,
            phase: 'verifying_signature',
            message: 'Verifying Game Porting Toolkit archive SHA-256 checksum...',
          },
          options
        );
        await verifyFileSha256Async(archivePath, expectedSha256);
      } else if (!isTestEnvironment(options) && options.allowUnverifiedArchiveDigest !== true) {
        await fs.promises.rm(archivePath, { force: true }).catch(() => {});
        throw new Error(
          'Refusing to extract Game Porting Toolkit archive without a cryptographic SHA-256 digest.'
        );
      }

      if (isDmg) {
        emitEnvironmentSetupProgress(
          {
            ...progressCtx,
            phase: 'verifying_signature',
            message: 'Verifying Apple Game Porting Toolkit bundle...',
          },
          options
        );
        const preSwapSafe = await assertRunnerSafeToReplace(
          effectiveRunnerType,
          existingTargetAppPath,
          existingLayer,
          options
        );
        throwIfRunnerBusy(preSwapSafe);

        const installedPath = await mountVerifyAndInstallDmgApp(
          archivePath,
          targetAppsDir,
          [],
          null,
          {
            ...options,
            _componentId: componentId,
            requireGptkBundle: true,
            ...(existingTargetAppPath ? { targetAppBundlePath: existingTargetAppPath } : {}),
          }
        );
        if (resolvedVersion && typeof recordRunnerInstallReceipt === 'function') {
          recordRunnerInstallReceipt(installedPath, effectiveRunnerType, resolvedVersion, {
            ...options,
            homedir,
          });
        }
        invalidateScanCaches();
        return {
          success: true,
          installed: true,
          installedPath,
          ...(resolvedVersion ? { version: resolvedVersion } : {}),
          message: `Installed Apple Game Porting Toolkit to ${installedPath}.`,
        };
      }

      const stagingDir = path.join(tempDir, 'staging');
      await fs.promises.mkdir(stagingDir, { recursive: true });
      emitEnvironmentSetupProgress(
        {
          ...progressCtx,
          phase: 'extracting',
          message: 'Extracting Apple Game Porting Toolkit archive...',
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
        throw new Error(
          'Game Porting Toolkit.app was not found inside the downloaded archive.'
        );
      }

      emitEnvironmentSetupProgress(
        {
          ...progressCtx,
          phase: 'verifying_signature',
          message: 'Verifying Apple D3DMetal framework signature and preparing bundle...',
        },
        options
      );
      await verifyAndPrepareStagedGptkApp(stagedApp);

      return await atomicSwapVerifiedApp(
        stagedApp,
        'Apple Game Porting Toolkit',
        resolvedVersion
      );
    }

    throw new Error(`Unsupported compatibility runner type: ${effectiveRunnerType}`);
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
 * @param {{ runnerType?: string, bottleName?: string, gameConfigBottleName?: string }} [prefs]
 * @param {Record<string, any>} [options]
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
    const requestedName = resolveDefaultChainedBottleName({
      explicitBottleName: prefs.bottleName,
      gameConfigBottleName: prefs.gameConfigBottleName,
      wizardPreferredBottleName: wizardState.preferredBottleName,
      discoveredBottleNames: available,
      runnerType: layer.type,
    });
    return {
      layer,
      bottleName: requestedName,
      bottlePath: path.join(bottlesDir, requestedName),
    };
  }

  const prefixSlug =
    prefs.bottleName && safeIsBottleSlug(prefs.bottleName)
      ? prefs.bottleName.trim()
      : wizardState.preferredRunnerType === layer.type &&
          wizardState.preferredBottleName &&
          safeIsBottleSlug(wizardState.preferredBottleName)
        ? wizardState.preferredBottleName
        : 'default';
  return {
    layer,
    bottleName: prefixSlug,
    bottlePath: path.join(homedir, 'Games/OneLauncher/Prefixes', prefixSlug),
  };
}

/**
 * Resolve Battle.net's background `Agent.exe` inside a Wine/CrossOver bottle (`ProgramData/Battle.net/Agent/Agent.exe`).
 *
 * @param {string} bottlePath
 * @param {number} [minBytes=1]
 * @returns {string | null}
 */
function resolveBottleBattleNetAgentExe(bottlePath, minBytes = 1) {
  if (!bottlePath || typeof bottlePath !== 'string') return null;
  const candidate = resolveDriveCPathCaseInsensitive(path.join(bottlePath, 'drive_c'), [
    'ProgramData',
    'Battle.net',
    'Agent',
    'Agent.exe',
  ]);
  if (!candidate) return null;
  try {
    const st = fs.statSync(candidate);
    if (st.isFile() && st.size >= Math.max(1, minBytes)) {
      return candidate;
    }
  } catch {}
  return null;
}

/**
 * Determine whether a Windows or Wine/CrossOver installer exit code indicates a benign success
 * condition (`0`, `3010` reboot required, `1641` reboot initiated, `1638` newer version already
 * present) — including POSIX 8-bit `waitpid` truncation (`exitCode & 0xFF`: `194`, `105`, `102`)
 * when executed inside Wine/CrossOver on macOS/Linux.
 *
 * @param {unknown} exitCode
 * @param {boolean} [isWinePosix=false]
 * @returns {boolean}
 */
function isBenignWindowsInstallerExitCode(exitCode, isWinePosix = false) {
  if (exitCode === null || exitCode === undefined || exitCode === '') return false;
  if (typeof exitCode === 'boolean') return false;
  const code = Number(exitCode);
  if (!Number.isFinite(code)) return false;
  if (code === 0 || code === 3010 || code === 1641 || code === 1638) {
    return true;
  }
  if (isWinePosix && (code === 194 || code === 105 || code === 102)) {
    return true;
  }
  return false;
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
  const minBinaryBytes = Math.max(
    1,
    Number(options.minBinaryBytes ?? (isTestEnvironment(options) ? 1 : 4096))
  );
  const minBinaryStableMs = Math.max(0, Number(options.minBinaryStableMs || 0));
  const companionFilesFn =
    typeof options.companionFilesFn === 'function' ? options.companionFilesFn : null;
  const spawnImpl = typeof options.spawnFn === 'function' ? options.spawnFn : spawn;

  const customEnvOverrides =
    options.wineEnvOverrides && typeof options.wineEnvOverrides === 'object'
      ? options.wineEnvOverrides
      : {};
  const installerDefaultDisablePrefix = options.preserveMscoree ? 'mshtml=d' : 'mscoree,mshtml=d';
  const mergedWineDllOverrides = customEnvOverrides.WINEDLLOVERRIDES
    ? `${installerDefaultDisablePrefix};${customEnvOverrides.WINEDLLOVERRIDES}`
    : `${installerDefaultDisablePrefix};winemenubuilder.exe=d`;

  /** @type {Record<string, any>} */
  const env = {
    ...process.env,
    WINEPREFIX: bottlePath,
    ...customEnvOverrides,
    WINEDLLOVERRIDES: mergedWineDllOverrides,
    ...(layer.type === 'crossover' || layer.type === 'crossover_preview'
      ? { CX_BOTTLE: bottleName }
      : {}),
  };
  alignWineMsyncWithLiveBottle(bottlePath, env);
  prepareCrossOverWineSpawnEnv(layer.binaryPath, env);
  applyCrossOverEnvironmentHygiene(env, {
    wineBinaryPath: layer.binaryPath,
    compatLayer: layer,
    layerType: layer.type,
    homedir: options.homedir,
    platform: 'darwin',
  });

  const isCxPerlWrapper = isCrossOverPerlWineWrapperOptions({
    binaryPath: layer.binaryPath,
    layerType: layer.type,
  });
  const trimmedDllOverrides = String(mergedWineDllOverrides || '').trim();
  const spawnWineArgs =
    isCxPerlWrapper && trimmedDllOverrides && !wineArgs.includes('--dll')
      ? ['--dll', trimmedDllOverrides, ...wineArgs]
      : wineArgs;

  const inspectCandidateStability = () => {
    const found = checkInstalledFn();
    if (!found) return null;
    /** @type {fs.Stats | null} */
    let st = null;
    try {
      st = fs.statSync(found);
    } catch {
      st = null;
    }
    if (!st || !st.isFile() || st.size < minBinaryBytes) return null;
    const parts = [`${found}:${st.size}`];
    if (companionFilesFn) {
      const companions = companionFilesFn();
      if (!Array.isArray(companions)) return null;
      for (const compPath of companions) {
        if (!compPath || typeof compPath !== 'string') return null;
        /** @type {fs.Stats | null} */
        let compStat = null;
        try {
          compStat = fs.statSync(compPath);
        } catch {
          compStat = null;
        }
        if (!compStat || !compStat.isFile() || compStat.size < minBinaryBytes) {
          return null;
        }
        parts.push(`${compPath}:${compStat.size}`);
      }
    }
    return {
      found,
      signature: parts.join('|'),
    };
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
    let stableSignature = '';
    let stableSinceMs = 0;
    let stableCandidateHits = 0;
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
      if (hasRealChildPid && !childExited) {
        if (options.resolveOnBinaryAppear !== true) {
          return;
        }
        const snap = inspectCandidateStability();
        if (!snap) {
          stableSignature = '';
          stableSinceMs = 0;
          stableCandidateHits = 0;
          return;
        }
        const now = Date.now();
        if (snap.signature === stableSignature) {
          stableCandidateHits += 1;
        } else {
          stableSignature = snap.signature;
          stableSinceMs = now;
          stableCandidateHits = 1;
        }
        const elapsedStableMs = stableSinceMs > 0 ? now - stableSinceMs : 0;
        if (stableCandidateHits >= 2 && elapsedStableMs >= minBinaryStableMs) {
          if (child && typeof child.unref === 'function') {
            try {
              child.unref();
            } catch {}
          }
          finishOk(snap.found);
        }
        return;
      }
      const snap = companionFilesFn ? inspectCandidateStability() : null;
      const found = companionFilesFn ? snap?.found || null : checkInstalledFn();
      if (found) {
        finishOk(found);
      }
    }, pollMs);

    const timeoutTimer = setTimeout(() => {
      const snap = companionFilesFn ? inspectCandidateStability() : null;
      const found = companionFilesFn ? snap?.found || null : checkInstalledFn();
      if (found) finishOk(found);
      else finishErr(new Error('Timed out waiting for bottled client installer to complete.'));
    }, timeoutMs);

    try {
      child = spawnImpl(layer.binaryPath, spawnWineArgs, {
        env,
        stdio: 'ignore',
      });
      hasRealChildPid = Boolean(child && typeof child.pid === 'number');
      if (!hasRealChildPid || childExited) {
        const snap = companionFilesFn ? inspectCandidateStability() : null;
        const syncFound = companionFilesFn ? snap?.found || null : checkInstalledFn();
        if (syncFound) {
          finishOk(syncFound);
          return;
        }
      } else if (options.resolveOnBinaryAppear === true) {
        const snap = inspectCandidateStability();
        if (snap) {
          stableSignature = snap.signature;
          stableSinceMs = Date.now();
          stableCandidateHits = 1;
        }
      }
      if (child && typeof child.on === 'function') {
        child.on('error', (/** @type {any} */ err) => {
          childExited = true;
          const snap = companionFilesFn ? inspectCandidateStability() : null;
          const found = companionFilesFn ? snap?.found || null : checkInstalledFn();
          if (found) finishOk(found);
          else finishErr(err instanceof Error ? err : new Error(String(err)));
        });
        child.on('exit', (/** @type {number | null} */ code) => {
          childExited = true;
          const snap = companionFilesFn ? inspectCandidateStability() : null;
          const found = companionFilesFn ? snap?.found || null : checkInstalledFn();
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
            const afterSnap = companionFilesFn ? inspectCandidateStability() : null;
            const afterFlush = companionFilesFn ? afterSnap?.found || null : checkInstalledFn();
            if (afterFlush) {
              finishOk(afterFlush);
            } else if (code !== null && !isBenignWindowsInstallerExitCode(code, true)) {
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
 * Ensure a macOS CrossOver / Wine / GPTK bottle directory is initialized and sandboxed
 * before installing a bottled storefront or publisher client.
 *
 * @param {any} layer
 * @param {string} bottleName
 * @param {string} bottlePath
 * @param {Record<string, any>} [options]
 * @param {AbortSignal} [signal]
 * @returns {Promise<void>}
 */
async function ensureBottleInitializedInternal(
  layer,
  bottleName,
  bottlePath,
  options = {},
  signal = undefined
) {
  const execFileFn = getExecFileFn(options);
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
        const cxbottleEnv = applyCrossOverEnvironmentHygiene(
          { ...process.env },
          {
            wineBinaryPath: layer.binaryPath || cxbottleBin,
            compatLayer: layer,
            layerType: layer.type,
            homedir: options.homedir,
            platform: 'darwin',
          }
        );
        try {
          await runExecFileAsync(
            execFileFn,
            cxbottleBin,
            ['--bottle', bottleName, '--create', '--template', 'win10_64'],
            { timeout: 60000, env: cxbottleEnv, signal }
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
    sanitizeProvisionedBottleGraphicsBackend(bottlePath);
    await sandboxWinePrefixUserFoldersAsync(bottlePath, options);
    return;
  }

  await fs.promises.mkdir(bottlePath, { recursive: true });
  const sysRegPath = path.join(bottlePath, 'system.reg');
  const sys32Dir = path.join(bottlePath, 'drive_c/windows/system32');

  if (!fs.existsSync(sysRegPath)) {
    const bootEnv = {
      ...process.env,
      WINEPREFIX: bottlePath,
      WINEDLLOVERRIDES: 'mscoree,mshtml=d;winemenubuilder.exe=d',
    };
    const alignedBoot = prepareAlignedAuxBottleWineCommand({
      wineBinary: layer.binaryPath,
      bottlePath,
      env: bootEnv,
      suppressGuiDialogs: true,
      layerType: layer.type,
    });
    try {
      await runExecFileAsync(execFileFn, alignedBoot.binaryPath, ['wineboot', '-u'], {
        timeout: 45000,
        env: alignedBoot.env,
        signal,
      });
    } catch {}

    const initTimeoutMs = Number(
      options.bottleInitTimeoutMs ?? (isTestEnvironment(options) ? 200 : 30000)
    );
    const pollStepMs = isTestEnvironment(options) ? 25 : 250;
    const deadline = Date.now() + initTimeoutMs;
    while (Date.now() < deadline) {
      if (signal?.aborted) break;
      if (fs.existsSync(sysRegPath) && fs.existsSync(sys32Dir)) break;
      await new Promise((r) => setTimeout(r, pollStepMs));
    }
  }
  await sandboxWinePrefixUserFoldersAsync(bottlePath, options);
}

/**
 * Download, Authenticode/PKCS#7-verify, silently install, and post-verify a chained publisher
 * launcher (`ubisoft`, `ea`, `bnet`, `rockstar`, `riot`) on Windows host or inside a macOS bottle.
 *
 * @param {{
 *   handoffId: 'ubisoft' | 'ea' | 'bnet' | 'rockstar' | 'riot',
 *   scope: 'host' | 'bottle',
 *   componentId: EnvironmentComponentId,
 *   progressBase: { runId: string, componentId: EnvironmentComponentId, stepIndex: number, totalSteps: number },
 *   tempDir: string,
 *   layer?: any,
 *   bottleName?: string,
 *   bottlePath?: string,
 *   signal?: AbortSignal,
 * }} ctx
 * @param {Record<string, any>} [options]
 * @returns {Promise<{ binaryPath: string, installDir: string }>}
 */
async function provisionVerifiedChainedPublisherClient(ctx, options = {}) {
  const {
    handoffId,
    scope,
    componentId,
    progressBase,
    tempDir,
    layer,
    bottleName = 'OneLauncher',
    bottlePath = '',
    signal,
  } = ctx;

  const ecosystem = CHAINED_PUBLISHER_ECOSYSTEMS[handoffId];
  if (!ecosystem || !ecosystem.installerUrl || !ecosystem.installerFileName) {
    throw new Error(`No verified installer descriptor configured for publisher "${handoffId}".`);
  }

  const stagedExe = path.join(tempDir, ecosystem.installerFileName);
  const minFreeBytes = Math.max(350, (ecosystem.estimatedDownloadMB || 200) * 2) * 1024 * 1024;

  await streamVerifiedDownloadToFile(
    ecosystem.installerUrl,
    stagedExe,
    {
      ...progressBase,
      label: `${ecosystem.displayName} Installer`,
      minFreeBytes,
    },
    options,
    signal
  );

  emitEnvironmentSetupProgress(
    {
      ...progressBase,
      phase: 'verifying_signature',
      message: `Verifying ${ecosystem.displayName} Authenticode signature...`,
    },
    options
  );
  await verifyWindowsInstallerSignature(stagedExe, {
    ...options,
    platform: scope === 'bottle' ? 'darwin' : 'win32',
    kind: 'exe',
    _componentId: componentId,
  });

  if (scope === 'host') {
    const execFileFn = getExecFileFn(options);
    emitEnvironmentSetupProgress(
      {
        ...progressBase,
        phase: 'installing',
        message: `Installing ${ecosystem.displayName} silently...`,
      },
      options
    );
    try {
      await runExecFileAsync(execFileFn, stagedExe, [...(ecosystem.silentArgs || [])], {
        timeout: 300000,
        windowsHide: true,
        signal,
      });
    } catch (/** @type {any} */ execErr) {
      if (!isBenignWindowsInstallerExitCode(execErr?.code, false)) {
        throw execErr;
      }
    }

    const hostProbeOpts = {
      ...options,
      ...explicitHomedirOpt(options),
      platform: 'win32',
    };
    let afterHost = discoverHostPublisherLauncher(handoffId, hostProbeOpts);
    if (!afterHost.installed || !afterHost.binaryPath) {
      const waitMs = Number(
        options.hostPostInstallWaitMs ?? (isTestEnvironment(options) ? 80 : 12000)
      );
      const stepMs = isTestEnvironment(options) ? 20 : 400;
      const deadline = Date.now() + Math.max(0, waitMs);
      while (Date.now() < deadline && (!afterHost.installed || !afterHost.binaryPath)) {
        if (signal?.aborted) break;
        await new Promise((r) => setTimeout(r, stepMs));
        afterHost = discoverHostPublisherLauncher(handoffId, hostProbeOpts);
      }
    }
    if (!afterHost.installed || !afterHost.binaryPath) {
      throw new Error(
        `${ecosystem.displayName} installer finished, but the launcher executable could not be verified on disk.`
      );
    }
    return {
      binaryPath: afterHost.binaryPath,
      installDir: afterHost.installDir || path.dirname(afterHost.binaryPath),
    };
  }

  if (handoffId === 'bnet' && bottlePath) {
    try {
      upsertWineUserRegKey(
        bottlePath,
        'Software\\Wine\\DllOverrides',
        { 'systemsurvey.exe': '' },
        { skipLiveWineRegSync: true }
      );
    } catch {}
  }

  const bottleTempDir = path.join(bottlePath, 'drive_c/windows/temp');
  await fs.promises.mkdir(bottleTempDir, { recursive: true });
  const bottleSetupExe = path.join(bottleTempDir, ecosystem.installerFileName);
  await fs.promises.copyFile(stagedExe, bottleSetupExe);

  emitEnvironmentSetupProgress(
    {
      ...progressBase,
      phase: 'installing',
      message: `Installing ${ecosystem.displayName} inside bottle "${bottleName}"...`,
    },
    options
  );

  const defaultPublisherStableMs =
    handoffId === 'bnet'
      ? 4000
      : handoffId === 'ubisoft' || handoffId === 'rockstar'
        ? 8000
        : 0;
  const effectiveMinStableMs = Number(
    options.minBinaryStableMs ?? options.bottleBinaryStableMs ?? defaultPublisherStableMs
  );
  const minBytesForCheck = Math.max(
    1,
    Number(options.minBinaryBytes ?? (isTestEnvironment(options) ? 1 : 4096))
  );

  try {
    const installedExe = await runBottleInstallerAndWait(
      layer,
      bottleName,
      bottlePath,
      [`C:\\windows\\temp\\${ecosystem.installerFileName}`, ...(ecosystem.silentArgs || [])],
      () => {
        const probed = discoverBottlePublisherLauncher(bottlePath, handoffId);
        if (!probed.installed || !probed.binaryPath) return null;
        if (handoffId === 'bnet' && !resolveBottleBattleNetAgentExe(bottlePath, minBytesForCheck)) {
          return null;
        }
        return probed.binaryPath;
      },
      {
        ...options,
        resolveOnBinaryAppear: true,
        minBinaryStableMs: effectiveMinStableMs,
        ...(handoffId === 'bnet'
          ? {
              companionFilesFn: () => [
                resolveBottleBattleNetAgentExe(bottlePath, minBytesForCheck),
              ],
            }
          : {}),
        preserveMscoree: Boolean(
          ecosystem.requiresDotNetMscoreeForInstall || options.preserveMscoree
        ),
        wineEnvOverrides: ecosystem.wineEnvOverrides || {},
      },
      signal
    );

    if (bottlePath) {
      sanitizeChainedPublisherAutostartInBottleRegs(bottlePath);
    }

    const afterBottle = discoverBottlePublisherLauncher(bottlePath, handoffId);
    const verifiedBin = (afterBottle.installed && afterBottle.binaryPath) || installedExe;
    if (!verifiedBin || !fs.existsSync(verifiedBin)) {
      throw new Error(
        `${ecosystem.displayName} installer finished, but the launcher executable could not be verified inside bottle "${bottleName}".`
      );
    }
    return {
      binaryPath: verifiedBin,
      installDir: afterBottle.installDir || path.dirname(verifiedBin),
    };
  } finally {
    try {
      await fs.promises.rm(bottleSetupExe, { force: true });
    } catch {}
  }
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
        action: task.action,
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
                if (!isBenignWindowsInstallerExitCode(execErr?.code, false)) {
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
          if (
            alreadyLayer &&
            !options.forceReinstall &&
            !task.forceUpdate &&
            !task.dmgPath &&
            !task.archivePath
          ) {
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
            archivePath: task.archivePath || options.archivePath,
            existingLayer: alreadyLayer || null,
            _runnerOperation: alreadyLayer ? 'update' : 'install',
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
            const currentWizardState = getSetupWizardState(options);
            const nextPreferredRunnerType = res.switchedToStableCrossOver
              ? 'crossover'
              : runnerType;
            const shouldSavePreferredRunner =
              !task.forceUpdate ||
              !currentWizardState?.preferredRunnerType ||
              (res.switchedToStableCrossOver &&
                currentWizardState.preferredRunnerType === 'crossover_preview');
            if (shouldSavePreferredRunner) {
              saveSetupWizardState(
                {
                  preferredRunnerType: nextPreferredRunnerType,
                },
                options
              );
            }
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
                const cxbottleEnv = applyCrossOverEnvironmentHygiene(
                  { ...process.env },
                  {
                    wineBinaryPath: layer.binaryPath || cxbottleBin,
                    compatLayer: layer,
                    layerType: layer.type,
                    homedir: options.homedir,
                    platform: 'darwin',
                  }
                );
                try {
                  await runExecFileAsync(
                    execFileFn,
                    cxbottleBin,
                    ['--bottle', bottleName, '--create', '--template', 'win10_64'],
                    { timeout: 60000, env: cxbottleEnv, signal: controller.signal }
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
            sanitizeProvisionedBottleGraphicsBackend(bottlePath);
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
              const alignedBoot = prepareAlignedAuxBottleWineCommand({
                wineBinary: layer.binaryPath,
                bottlePath,
                env: bootEnv,
                suppressGuiDialogs: true,
                layerType: layer.type,
              });
              try {
                await runExecFileAsync(execFileFn, alignedBoot.binaryPath, ['wineboot', '-u'], {
                  timeout: 45000,
                  env: alignedBoot.env,
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
                try {
                  await runExecFileAsync(execFileFn, exePath, ['/S'], {
                    timeout: 180000,
                    windowsHide: true,
                    signal: controller.signal,
                  });
                } catch (/** @type {any} */ execErr) {
                  if (!isBenignWindowsInstallerExitCode(execErr?.code, false)) {
                    throw execErr;
                  }
                }
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
                try {
                  await runExecFileAsync(
                    execFileFn,
                    exePath,
                    ['/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART'],
                    { timeout: 300000, windowsHide: true, signal: controller.signal }
                  );
                } catch (/** @type {any} */ execErr) {
                  if (!isBenignWindowsInstallerExitCode(execErr?.code, false)) {
                    throw execErr;
                  }
                }
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
                try {
                  await runExecFileAsync(
                    execFileFn,
                    'msiexec.exe',
                    ['/i', msiPath, '/qn', '/norestart'],
                    { timeout: 300000, windowsHide: true, signal: controller.signal }
                  );
                } catch (/** @type {any} */ execErr) {
                  if (!isBenignWindowsInstallerExitCode(execErr?.code, false)) {
                    throw execErr;
                  }
                }
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

            // G) Chained Publisher Launchers (Ubisoft Connect, EA App, Battle.net, Rockstar, Riot)
            if (
              componentId === 'host_ubisoft' ||
              componentId === 'bottle_ubisoft' ||
              componentId === 'host_ea' ||
              componentId === 'bottle_ea' ||
              componentId === 'host_bnet' ||
              componentId === 'bottle_bnet' ||
              componentId === 'host_rockstar' ||
              componentId === 'bottle_rockstar' ||
              componentId === 'host_riot'
            ) {
              const pubHandoffId = /** @type {'ubisoft' | 'ea' | 'bnet' | 'rockstar' | 'riot'} */ (
                normalizeChainedHandoffId(componentId)
              );
              const pubEcosystem = CHAINED_PUBLISHER_ECOSYSTEMS[pubHandoffId];
              const isBottleScope = componentId.startsWith('bottle_');

              if (isBottleScope) {
                if (hostPlatform !== 'darwin') {
                  emitEnvironmentSetupProgress(
                    {
                      ...progressBase,
                      phase: 'skipped',
                      message: `${pubEcosystem.displayName} bottle installation is only applicable on macOS.`,
                    },
                    options
                  );
                  outcomes.push({
                    componentId,
                    action: task.action,
                    status: 'skipped',
                    message: `${pubEcosystem.displayName} bottle installation is only applicable on macOS.`,
                  });
                  continue;
                }

                const { layer, bottleName, bottlePath } = resolveRunnerAndBottleTarget(
                  homedir,
                  { runnerType: task.runnerType, bottleName: task.bottleName },
                  options
                );
                await ensureBottleInitializedInternal(
                  layer,
                  bottleName,
                  bottlePath,
                  options,
                  controller.signal
                );

                const existingBottlePub = discoverBottlePublisherLauncher(bottlePath, pubHandoffId);
                if (existingBottlePub.installed && existingBottlePub.binaryPath && !options.forceReinstall) {
                  succeededComponents.push(componentId);
                  emitEnvironmentSetupProgress(
                    {
                      ...progressBase,
                      phase: 'skipped',
                      message: `${pubEcosystem.displayName} is already installed in "${bottleName}".`,
                    },
                    options
                  );
                  outcomes.push({
                    componentId,
                    action: task.action,
                    status: 'skipped',
                    installedPath: existingBottlePub.binaryPath,
                    message: `${pubEcosystem.displayName} is already installed in "${bottleName}".`,
                  });
                  continue;
                }

                const provisionedBottle = await provisionVerifiedChainedPublisherClient(
                  {
                    handoffId: pubHandoffId,
                    scope: 'bottle',
                    componentId,
                    progressBase,
                    tempDir,
                    layer,
                    bottleName,
                    bottlePath,
                    signal: controller.signal,
                  },
                  options
                );

                succeededComponents.push(componentId);
                emitEnvironmentSetupProgress(
                  {
                    ...progressBase,
                    phase: 'completed',
                    progressPercent: 100,
                    message: `Installed ${pubEcosystem.displayName} in bottle "${bottleName}".`,
                  },
                  options
                );
                outcomes.push({
                  componentId,
                  action: task.action,
                  status: 'completed',
                  installedPath: provisionedBottle.binaryPath,
                  message: `Installed ${pubEcosystem.displayName} in bottle "${bottleName}".`,
                });
                continue;
              }

              // Host scope
              const existingHostPub = discoverHostPublisherLauncher(pubHandoffId, {
                ...options,
                ...explicitHomedirOpt(options),
                platform: hostPlatform,
              });
              if (existingHostPub.installed && existingHostPub.binaryPath && !options.forceReinstall) {
                succeededComponents.push(componentId);
                emitEnvironmentSetupProgress(
                  {
                    ...progressBase,
                    phase: 'skipped',
                    message: `${pubEcosystem.displayName} is already installed.`,
                  },
                  options
                );
                outcomes.push({
                  componentId,
                  action: task.action,
                  status: 'skipped',
                  installedPath: existingHostPub.binaryPath,
                  message: `${pubEcosystem.displayName} is already installed.`,
                });
                continue;
              }

              if (hostPlatform === 'darwin' && componentId === 'host_bnet') {
                const extUrl = 'https://download.battle.net/?product=bnetdesk';
                await openExternalUri(extUrl, options);
                emitEnvironmentSetupProgress(
                  {
                    ...progressBase,
                    phase: 'completed',
                    openedExternalUrl: extUrl,
                    message: 'Opened Battle.net for macOS download page.',
                  },
                  options
                );
                outcomes.push({
                  componentId,
                  action: task.action,
                  status: 'opened_external',
                  openedExternalUrl: extUrl,
                  message: 'Opened Battle.net for macOS download page.',
                });
                continue;
              }

              if (hostPlatform !== 'win32') {
                emitEnvironmentSetupProgress(
                  {
                    ...progressBase,
                    phase: 'skipped',
                    message: `${pubEcosystem.displayName} native host client is only applicable on Windows.`,
                  },
                  options
                );
                outcomes.push({
                  componentId,
                  action: task.action,
                  status: 'skipped',
                  message: `${pubEcosystem.displayName} native host client is only applicable on Windows.`,
                });
                continue;
              }

              const provisionedHost = await provisionVerifiedChainedPublisherClient(
                {
                  handoffId: pubHandoffId,
                  scope: 'host',
                  componentId,
                  progressBase,
                  tempDir,
                  signal: controller.signal,
                },
                options
              );

              succeededComponents.push(componentId);
              emitEnvironmentSetupProgress(
                {
                  ...progressBase,
                  phase: 'completed',
                  progressPercent: 100,
                  message: `Installed ${pubEcosystem.displayName}.`,
                },
                options
              );
              outcomes.push({
                componentId,
                action: task.action,
                status: 'completed',
                installedPath: provisionedHost.binaryPath,
                message: `Installed ${pubEcosystem.displayName}.`,
              });
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
    forceRefreshRunnerUpdates: true,
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
      /** @type {Record<string, any>} */
      const bottleEnv = {
        ...process.env,
        WINEPREFIX: probeState.bottlePath,
        ...(probeState.bottleName ? { CX_BOTTLE: probeState.bottleName } : {}),
      };
      applyCrossOverEnvironmentHygiene(bottleEnv, {
        wineBinaryPath: bottleLayer.binaryPath,
        compatLayer: bottleLayer,
        layerType: bottleLayer.type,
        homedir: options.homedir,
        platform: 'darwin',
      });
      const alignedClose = prepareAlignedAuxBottleWineCommand({
        wineBinary: bottleLayer.binaryPath,
        bottlePath: probeState.bottlePath,
        env: bottleEnv,
        suppressGuiDialogs: true,
        layerType: bottleLayer.type,
      });
      const closeWineBin = alignedClose.binaryPath;
      const closeBottleEnv = alignedClose.env;
      if (targetId === 'bottle_steam' && probeState.binaryPath) {
        await runExecFileAsync(
          execFileFn,
          closeWineBin,
          [probeState.binaryPath, '-shutdown'],
          { timeout: 15000, env: closeBottleEnv }
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
            closeWineBin,
            [probeState.binaryPath, '/command=shutdown'],
            { timeout: 8000, env: closeBottleEnv }
          ).catch(() => {});
          const settleMs = isTestEnvironment(options) ? 10 : 1200;
          await new Promise((r) => setTimeout(r, settleMs));
        }
        for (const gogExe of ['GalaxyClient.exe', 'GalaxyCommunication.exe']) {
          await runExecFileAsync(
            execFileFn,
            closeWineBin,
            ['taskkill', '/F', '/T', '/IM', gogExe],
            { timeout: 6000, env: closeBottleEnv }
          ).catch(() => {});
        }
        await shutdownWinePrefix(bottleLayer.binaryPath, probeState.bottlePath, 5000, {
          bottleName: probeState.bottleName,
          execFileFn,
        }).catch(() => {});
        return true;
      }
      /** @type {string[]} */
      const bottleKillImages =
        targetId === 'bottle_ubisoft'
          ? ['upc.exe', 'UbisoftConnect.exe', 'UplayWebCore.exe']
          : targetId === 'bottle_ea'
            ? [
                'EADesktop.exe',
                'EALauncher.exe',
                'EACefSubProcess.exe',
                'EALocalHostSvc.exe',
                'Link2EA.exe',
                'EABackgroundService.exe',
              ]
            : targetId === 'bottle_bnet'
              ? ['Battle.net.exe', 'Agent.exe']
              : targetId === 'bottle_rockstar'
                ? ['Launcher.exe', 'LauncherPatcher.exe', 'SocialClubHelper.exe']
                : ['EpicGamesLauncher.exe'];

      for (const img of bottleKillImages) {
        await runExecFileAsync(
          execFileFn,
          closeWineBin,
          ['taskkill', '/IM', img],
          { timeout: 5000, env: closeBottleEnv }
        ).catch(() => {});
        await runExecFileAsync(
          execFileFn,
          closeWineBin,
          ['taskkill', '/F', '/T', '/IM', img],
          { timeout: 6000, env: closeBottleEnv }
        ).catch(() => {});
      }
      await shutdownWinePrefix(bottleLayer.binaryPath, probeState.bottlePath, 5000, {
        bottleName: probeState.bottleName,
        execFileFn,
      }).catch(() => {});
      if (
        probeState.bottlePath &&
        (targetId === 'bottle_ubisoft' ||
          targetId === 'bottle_ea' ||
          targetId === 'bottle_bnet' ||
          targetId === 'bottle_rockstar')
      ) {
        sanitizeChainedPublisherAutostartInBottleRegs(probeState.bottlePath);
      }
      return true;
    }

    if (hostPlatform === 'darwin') {
      const macAppName =
        targetId === 'host_steam'
          ? 'Steam'
          : targetId === 'host_gog'
            ? 'GOG Galaxy'
            : targetId === 'host_ea'
              ? 'EA app'
              : targetId === 'host_bnet'
                ? 'Battle.net'
                : targetId === 'host_riot'
                  ? 'Riot Client'
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

      /** @type {string[]} */
      const winKillImages =
        targetId === 'host_ubisoft'
          ? ['upc.exe', 'UbisoftConnect.exe', 'UplayWebCore.exe']
          : targetId === 'host_ea'
            ? [
                'EADesktop.exe',
                'EALauncher.exe',
                'EACefSubProcess.exe',
                'EALocalHostSvc.exe',
                'Link2EA.exe',
                'EABackgroundService.exe',
              ]
            : targetId === 'host_bnet'
              ? ['Battle.net.exe']
              : targetId === 'host_rockstar'
                ? ['Launcher.exe', 'LauncherPatcher.exe']
                : targetId === 'host_riot'
                  ? ['RiotClientServices.exe', 'RiotClientUx.exe', 'RiotClientCrashHandler.exe']
                  : ['EpicGamesLauncher.exe'];

      for (const img of winKillImages) {
        await runExecFileAsync(execFileFn, 'taskkill.exe', ['/IM', img], {
          timeout: 5000,
          windowsHide: true,
        }).catch(() => {});
        await runExecFileAsync(
          execFileFn,
          'taskkill.exe',
          ['/F', '/T', '/IM', img],
          {
            timeout: 6000,
            windowsHide: true,
          }
        ).catch(() => {});
      }
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
      const pubHandoffId = normalizeChainedHandoffId(targetId);
      const pubDescriptor = pubHandoffId ? CHAINED_PUBLISHER_ECOSYSTEMS[pubHandoffId] : null;
      const extraClientArgs = pubDescriptor?.wineClientArgs ? [...pubDescriptor.wineClientArgs] : [];
      const extraEnvOverrides = pubDescriptor?.wineEnvOverrides
        ? { ...pubDescriptor.wineEnvOverrides }
        : {};
      /** @type {Record<string, any>} */
      const guidedBottleEnv = {
        ...process.env,
        ...(initialState.bottlePath ? { WINEPREFIX: initialState.bottlePath } : {}),
        ...(initialState.bottleName ? { CX_BOTTLE: initialState.bottleName } : {}),
        ...extraEnvOverrides,
      };
      if (initialState.bottlePath) {
        alignWineMsyncWithLiveBottle(initialState.bottlePath, guidedBottleEnv);
      }
      prepareCrossOverWineSpawnEnv(bottleLayer.binaryPath, guidedBottleEnv);
      applyCrossOverEnvironmentHygiene(guidedBottleEnv, {
        wineBinaryPath: bottleLayer.binaryPath,
        compatLayer: bottleLayer,
        layerType: bottleLayer.type,
        homedir,
        platform: 'darwin',
      });
      const guidedDllOverrides = String(guidedBottleEnv.WINEDLLOVERRIDES || '').trim();
      const guidedWineArgs =
        guidedDllOverrides &&
        isCrossOverPerlWineWrapperOptions({
          binaryPath: bottleLayer.binaryPath,
          layerType: bottleLayer.type,
        })
          ? ['--dll', guidedDllOverrides, initialState.binaryPath, ...extraClientArgs]
          : [initialState.binaryPath, ...extraClientArgs];
      const child = spawnImpl(
        bottleLayer.binaryPath,
        guidedWineArgs,
        {
          detached: true,
          stdio: 'ignore',
          env: guidedBottleEnv,
        }
      );
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

        if (
          latestState.bottlePath &&
          (targetId === 'bottle_ubisoft' ||
            targetId === 'bottle_ea' ||
            targetId === 'bottle_bnet' ||
            targetId === 'bottle_rockstar')
        ) {
          sanitizeChainedPublisherAutostartInBottleRegs(latestState.bottlePath);
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

/**
 * Reusable on-demand provisioner for chained publisher launchers (`ubisoft`, `ea`, `bnet`, `rockstar`, `riot`).
 * - Returns `{ installed: true, provisionedNow: false, binaryPath, installDir }` immediately (`0` network calls)
 *   when already installed in `bottlePath` (on `darwin`) or on host (on `win32`).
 * - Otherwise initializes the target bottle (if needed on `darwin`), streams the allowlisted vendor installer,
 *   verifies its Authenticode / PKCS#7 signature, runs silent installation with `wineEnvOverrides`, forwards
 *   `{ percent, downloadedBytes, totalBytes, speedBytesPerSec: number, message }` to `onProgress`, and returns
 *   `{ installed: true, provisionedNow: true, binaryPath, installDir }`.
 *
 * @param {{
 *   handoffId: string,
 *   platform?: string,
 *   runnerLayer?: any,
 *   bottleName?: string,
 *   bottlePath?: string,
 *   onProgress?: (progress: { percent: number, downloadedBytes: number, totalBytes: number, speedBytesPerSec: number, message: string }) => void,
 *   signal?: AbortSignal,
 * }} params
 * @param {Record<string, any>} [options]
 * @returns {Promise<{ installed: boolean, provisionedNow: boolean, binaryPath: string, installDir: string }>}
 */
async function ensureChainedPublisherLauncherInstalled(params, options = {}) {
  const {
    handoffId,
    platform,
    runnerLayer,
    bottleName,
    bottlePath,
    onProgress,
    signal,
  } = params || {};

  const canonical = normalizeChainedHandoffId(handoffId);
  if (!canonical) {
    throw new Error(`Unsupported chained publisher handoffId: "${String(handoffId || '')}"`);
  }

  const rawPlatform = String(platform || options.platform || process.platform).toLowerCase();
  /** @type {'darwin' | 'win32' | 'linux'} */
  const targetPlatform =
    rawPlatform === 'win32' ? 'win32' : rawPlatform === 'linux' ? 'linux' : 'darwin';

  if (canonical === 'riot' && targetPlatform !== 'win32') {
    if (targetPlatform === 'darwin') {
      throw new Error(
        CHAINED_PUBLISHER_ECOSYSTEMS.riot.unsupportedBottleReason ||
          'Riot Client cannot run inside macOS Wine/CrossOver bottles.'
      );
    }
    throw new Error(
      `Automatic provisioning of ${CHAINED_PUBLISHER_ECOSYSTEMS.riot.displayName} is not supported on platform "${targetPlatform}".`
    );
  }

  const provisionableId = /** @type {'ubisoft' | 'ea' | 'bnet' | 'rockstar' | 'riot'} */ (canonical);
  const ecosystem = CHAINED_PUBLISHER_ECOSYSTEMS[provisionableId];
  const { homedir } = resolveIsolatedHomedirAndUserData(options);

  const resolveExplicitOrWizardBottlePath = () => {
    if (typeof bottlePath === 'string' && bottlePath.trim()) {
      const cleanPath = bottlePath.trim();
      const cleanName =
        typeof bottleName === 'string' && bottleName.trim()
          ? bottleName.trim()
          : path.basename(cleanPath);
      return { bottleName: cleanName, bottlePath: cleanPath };
    }
    const explicitRunnerBin = String(runnerLayer?.binaryPath || runnerLayer?.path || '').trim();
    if (runnerLayer && explicitRunnerBin) {
      const wizardState = getSetupWizardState(options);
      if (runnerLayer.type === 'crossover' || runnerLayer.type === 'crossover_preview') {
        const bottlesDir =
          runnerLayer.bottlesDir ||
          path.join(homedir, 'Library/Application Support/CrossOver/Bottles');
        let discoveredBottles = Array.isArray(runnerLayer.availableBottles)
          ? runnerLayer.availableBottles
          : [];
        if (discoveredBottles.length === 0 && fs.existsSync(bottlesDir)) {
          try {
            discoveredBottles = fs
              .readdirSync(bottlesDir, { withFileTypes: true })
              .filter((d) => d.isDirectory() && safeIsBottleSlug(d.name))
              .map((d) => d.name);
          } catch {}
        }
        const resolvedName = resolveDefaultChainedBottleName({
          explicitBottleName: bottleName,
          wizardPreferredBottleName: wizardState.preferredBottleName,
          discoveredBottleNames: discoveredBottles,
          runnerType: runnerLayer.type,
        });
        return {
          bottleName: resolvedName,
          bottlePath: path.join(bottlesDir, resolvedName),
        };
      }
      const prefixSlug =
        bottleName && safeIsBottleSlug(bottleName)
          ? bottleName.trim()
          : wizardState.preferredRunnerType === runnerLayer.type &&
              wizardState.preferredBottleName &&
              safeIsBottleSlug(wizardState.preferredBottleName)
            ? wizardState.preferredBottleName
            : 'default';
      return {
        bottleName: prefixSlug,
        bottlePath: path.join(homedir, 'Games/OneLauncher/Prefixes', prefixSlug),
      };
    }
    const resolvedTarget = resolveRunnerAndBottleTarget(
      homedir,
      { runnerType: runnerLayer?.type, bottleName },
      options
    );
    return {
      bottleName: resolvedTarget.bottleName,
      bottlePath: resolvedTarget.bottlePath,
    };
  };

  // Fast read-only precheck (0 network calls if already installed)
  if (!options.forceReinstall) {
    if (targetPlatform === 'darwin') {
      let checkBottlePath = '';
      try {
        checkBottlePath = resolveExplicitOrWizardBottlePath().bottlePath;
      } catch {}
      if (checkBottlePath) {
        const existingBottle = discoverBottlePublisherLauncher(checkBottlePath, provisionableId);
        if (existingBottle.installed && existingBottle.binaryPath) {
          return {
            installed: true,
            provisionedNow: false,
            binaryPath: existingBottle.binaryPath,
            installDir: existingBottle.installDir || path.dirname(existingBottle.binaryPath),
          };
        }
      }
    } else if (targetPlatform === 'win32') {
      const existingHost = discoverHostPublisherLauncher(provisionableId, {
        ...options,
        ...explicitHomedirOpt(options),
        platform: 'win32',
      });
      if (existingHost.installed && existingHost.binaryPath) {
        return {
          installed: true,
          provisionedNow: false,
          binaryPath: existingHost.binaryPath,
          installDir: existingHost.installDir || path.dirname(existingHost.binaryPath),
        };
      }
    }
  }

  if (signal?.aborted) {
    const abortErr = new Error('Publisher launcher installation cancelled.');
    abortErr.name = 'AbortError';
    throw abortErr;
  }

  // Offline / hermetic test override hook
  if (typeof options.provisionChainedLauncherFn === 'function') {
    const injectedRes = await options.provisionChainedLauncherFn(
      {
        handoffId: provisionableId,
        platform: targetPlatform,
        runnerLayer,
        bottleName,
        bottlePath,
        onProgress,
        signal,
      },
      options
    );
    const bin = String(injectedRes?.binaryPath || '').trim();
    const dir = String(injectedRes?.installDir || (bin ? path.dirname(bin) : '')).trim();
    return {
      installed: injectedRes?.installed !== false,
      provisionedNow: injectedRes?.provisionedNow !== false,
      binaryPath: bin,
      installDir: dir,
    };
  }

  if (options.skipNetwork === true && typeof options.fetchFn !== 'function') {
    throw new Error(
      `${ecosystem.displayName} is not installed and network provisioning is disabled (skipNetwork: true).`
    );
  }

  if (targetPlatform !== 'darwin' && targetPlatform !== 'win32') {
    throw new Error(
      `Automatic provisioning of ${ecosystem.displayName} is not supported on platform "${targetPlatform}".`
    );
  }

  const scope = targetPlatform === 'darwin' ? 'bottle' : 'host';
  const componentId = /** @type {EnvironmentComponentId} */ (
    scope === 'bottle' ? ecosystem.bottleComponentId : ecosystem.hostComponentId
  );
  const runId = `chained-pub-${provisionableId}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

  let prevBytes = 0;
  let prevTickAt = Date.now();
  let lastSpeedBytesPerSec = 0;

  const emitProgressCallback = (
    /** @type {{ percent: number, downloadedBytes: number, totalBytes: number, speedBytesPerSec: number, message: string }} */ info
  ) => {
    if (typeof onProgress === 'function') {
      try {
        onProgress(info);
      } catch {}
    }
  };

  const unsubscribeProgress = onEnvironmentSetupProgress((ev) => {
    if (ev.runId !== runId) return;
    const now = Date.now();
    const dlBytes = typeof ev.bytesDownloaded === 'number' ? ev.bytesDownloaded : prevBytes;
    const totBytes = typeof ev.totalBytes === 'number' ? ev.totalBytes : 0;
    const dtSec = (now - prevTickAt) / 1000;
    if (ev.phase === 'downloading' && dlBytes > prevBytes && dtSec > 0.02) {
      const instantSpeed = Math.round((dlBytes - prevBytes) / dtSec);
      lastSpeedBytesPerSec =
        lastSpeedBytesPerSec > 0
          ? Math.round(lastSpeedBytesPerSec * 0.65 + instantSpeed * 0.35)
          : instantSpeed;
      prevBytes = dlBytes;
      prevTickAt = now;
    }

    let pct = typeof ev.progressPercent === 'number' ? ev.progressPercent : 0;
    if (ev.phase === 'downloading') {
      pct =
        typeof ev.progressPercent === 'number'
          ? Math.min(78, Math.max(5, Math.round(5 + ev.progressPercent * 0.73)))
          : 25;
    } else if (ev.phase === 'verifying_signature') {
      pct = 82;
      lastSpeedBytesPerSec = 0;
    } else if (ev.phase === 'installing') {
      pct = 90;
      lastSpeedBytesPerSec = 0;
    } else if (ev.phase === 'completed') {
      pct = 100;
      lastSpeedBytesPerSec = 0;
    }

    emitProgressCallback({
      percent: pct,
      downloadedBytes: dlBytes,
      totalBytes: totBytes,
      speedBytesPerSec: ev.phase === 'downloading' ? lastSpeedBytesPerSec : 0,
      message: ev.message,
    });
  });

  const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ol-chained-pub-'));
  try {
    /** @type {any} */
    let effectiveLayer = null;
    let effectiveBottleName = '';
    let effectiveBottlePath = '';

    if (targetPlatform === 'darwin') {
      if ((options.arch || process.arch) === 'arm64') {
        await ensureRosetta2InBackground({ ...options, signal });
      }

      const explicitRunnerBin = String(runnerLayer?.binaryPath || runnerLayer?.path || '').trim();
      if (runnerLayer && explicitRunnerBin) {
        effectiveLayer = {
          ...runnerLayer,
          binaryPath: explicitRunnerBin,
        };
        const resolvedBottle = resolveExplicitOrWizardBottlePath();
        effectiveBottleName = resolvedBottle.bottleName;
        effectiveBottlePath = resolvedBottle.bottlePath;
      } else {
        const resolved = resolveRunnerAndBottleTarget(
          homedir,
          { runnerType: runnerLayer?.type, bottleName },
          options
        );
        effectiveLayer = resolved.layer;
        effectiveBottleName =
          typeof bottleName === 'string' && safeIsBottleSlug(bottleName)
            ? bottleName.trim()
            : resolved.bottleName;
        effectiveBottlePath =
          typeof bottlePath === 'string' && bottlePath.trim()
            ? bottlePath.trim()
            : resolved.bottlePath;
      }

      const isMockHomedir = Boolean(options.homedir || options.customApplicationsDir);
      if (!isValidBottleDirectory(effectiveBottlePath, isMockHomedir)) {
        emitProgressCallback({
          percent: 3,
          downloadedBytes: 0,
          totalBytes: 0,
          speedBytesPerSec: 0,
          message: `Initializing Windows bottle "${effectiveBottleName}"...`,
        });
      }
      await ensureBottleInitializedInternal(
        effectiveLayer,
        effectiveBottleName,
        effectiveBottlePath,
        options,
        signal
      );

      if (!options.forceReinstall) {
        const postInitProbe = discoverBottlePublisherLauncher(effectiveBottlePath, provisionableId);
        if (postInitProbe.installed && postInitProbe.binaryPath) {
          return {
            installed: true,
            provisionedNow: false,
            binaryPath: postInitProbe.binaryPath,
            installDir: postInitProbe.installDir || path.dirname(postInitProbe.binaryPath),
          };
        }
      }
    }

    const provisioned = await provisionVerifiedChainedPublisherClient(
      {
        handoffId: provisionableId,
        scope,
        componentId,
        progressBase: {
          runId,
          componentId,
          stepIndex: 0,
          totalSteps: 1,
        },
        tempDir,
        layer: effectiveLayer,
        bottleName: effectiveBottleName,
        bottlePath: effectiveBottlePath,
        signal,
      },
      options
    );

    try {
      saveSetupWizardState(
        {
          addConfiguredComponents: [componentId],
          lastHealthCheckAt: new Date().toISOString(),
        },
        options
      );
    } catch {}
    invalidateScanCaches();

    emitProgressCallback({
      percent: 100,
      downloadedBytes: prevBytes,
      totalBytes: prevBytes,
      speedBytesPerSec: 0,
      message: `${ecosystem.displayName} is installed and ready.`,
    });

    return {
      installed: true,
      provisionedNow: true,
      binaryPath: provisioned.binaryPath,
      installDir: provisioned.installDir,
    };
  } finally {
    unsubscribeProgress();
    try {
      await fs.promises.rm(tempDir, { recursive: true, force: true });
    } catch {}
  }
}

module.exports = {
  ALLOWED_INSTALLER_HOSTS,
  CODEWEAVERS_SPARKLE_PUBLIC_ED_KEY,
  validateInstallerUrl,
  isBenignWindowsInstallerExitCode,
  resolveGogGalaxyInstallerCandidates,
  resolveGogGalaxyInstallerUrl,
  downloadGogGalaxyInstallerToFile,
  hasEmbeddedPeAuthenticodeCertificate,
  verifyFileSha256Async,
  verifySparkleEd25519SignatureAsync,
  verifyAppleSignedFramework,
  verifyMacAppDeveloperSignature,
  verifyMacPkgSignature,
  verifyWindowsInstallerSignature,
  assertRunnerSafeToReplace,
  atomicReplaceMacAppBundle,
  onEnvironmentSetupProgress,
  emitEnvironmentSetupProgress,
  ensureRosetta2InBackground,
  isExperimentalArm64CrossOverPreviewTarget,
  selectPreferredCrossOverPreviewDownloadUrl,
  captureCodeWeaversPreviewDownload,
  installRunnerDirect,
  runEnvironmentSetupTasks,
  cancelEnvironmentSetup,
  startGuidedClientLogin,
  cancelGuidedClientLogin,
  ensureChainedPublisherLauncherInstalled,
};
