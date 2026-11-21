// @ts-check
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const {
  atomicWriteFileSync,
  isContainedWithinRoot,
  isAllowedHttpsHost,
  assertSafePublicHttpsUrlSyntax,
  isSafeNumericAppId,
} = require('../securityAndPathUtils.cjs');
const {
  sanitizeGameInstallSizeBytes,
} = require('../binaryAndManifestInspectors.cjs');
const {
  diagLog,
  getConfiguredUserDataDir,
  getUserDataDir,
  isTestEnvironment,
  emitDownloadUpdated,
  downloadQueueMap,
  downloadControllers,
  downloadSpeedTrackers,
  registerExternalCacheInvalidator,
  invalidateScanCaches,
  upsertManagedInstallRecord,
} = require('../engineStateRegistry.cjs');
const {
  setGogDownloadTaskHooks,
  sanitizeDirectoryName,
} = require('../gogRegistryAndDirectInstaller.cjs');
const chainedPublisherLaunchers = /** @type {any} */ (require('../chainedPublisherLaunchers.cjs'));
const { normalizeChainedHandoffId } = chainedPublisherLaunchers;
const { normalizeVaultChainedHandoffId } = require('../offlineVaultService.cjs');

const DOWNLOAD_QUEUE_PERSIST_FILENAME = 'download_queue_v1.json';
const DEFAULT_PROGRESS_BROADCAST_THROTTLE_MS = 120;
const MAX_TERMINAL_DOWNLOAD_HISTORY = 50;

const TERMINAL_DOWNLOAD_STATUSES = Object.freeze(new Set(['completed', 'failed', 'cancelled']));
const ACTIVE_DOWNLOAD_STATUSES = Object.freeze(
  new Set(['queued', 'downloading', 'extracting', 'verifying'])
);

/** @type {Set<string>} */
const rehydratedQueueDirs = new Set();

/** @type {Set<string>} */
const inFlightInstallKeys = new Set();

/** @type {Map<string, { timer: NodeJS.Timeout | null, lastBroadcastAt: number, lastEmittedPercent: number, pendingPayload: any }>} */
const broadcastThrottleByTask = new Map();

const TRUSTED_EXTERNAL_LAUNCHER_DOMAINS = Object.freeze([
  'ea.com',
  'ubisoftconnect.com',
  'ubisoft.com',
  'riotgames.com',
  'rockstargames.com',
  'battle.net',
  'blizzard.com',
  'minecraft.net',
  'xbox.com',
  'microsoft.com',
]);

const ALLOWED_EPIC_MANIFEST_CDN_HOSTS = Object.freeze([
  'epicgames.com',
  'epicgames.dev',
  'epicgames-download1.akamaized.net',
  'download.epicgames.com',
  'download2.epicgames.com',
  'download3.epicgames.com',
  'download4.epicgames.com',
  'fastly-download.epicgames.com',
  'cloudflare.epicgamescdn.com',
  'akamaized.net',
  'cloudfront.net',
  'fastly.net',
]);

/**
 * Normalize publisher handoff identifiers across both `chainedPublisherLaunchers`
 * and `offlineVaultService`.
 *
 * @param {any} raw
 * @returns {string}
 */
function resolveAnyChainedHandoffId(raw) {
  return normalizeChainedHandoffId(raw) || normalizeVaultChainedHandoffId(raw);
}

/**
 * Extract the trailing leaf name of an Epic partner registry path.
 *
 * @param {any} regPath
 * @returns {string}
 */
function extractEpicRegistryLeaf(regPath) {
  if (!regPath || typeof regPath !== 'string') return '';
  const parts = regPath
    .split(/[\\/]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  return parts.length > 0 ? parts[parts.length - 1] : '';
}

/**
 * Normalize compatibility layer / runner component IDs (e.g. `'runner_crossover_preview_arm64'`)
 * into canonical `CompatibilityLayerType` values, treating `'auto'` and `'native'` as empty.
 *
 * @param {unknown} rawLayer
 * @returns {string}
 */
function normalizeRequestedCompatibilityLayerType(rawLayer) {
  const s = String(rawLayer || '')
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
 * Invalidate local scan caches after an install completes.
 * (Dead `'launcher:installed-games-updated'` / `'installed-games-updated'` broadcasts removed.)
 */
function notifyInstalledGamesUpdated() {
  invalidateScanCaches();
}

/**
 * Strictly validate an external launcher/storefront handoff URL against an official
 * publisher/storefront HTTPS domain allowlist (rejects control chars, credentials,
 * non-HTTPS schemes, non-standard ports, and untrusted hosts).
 *
 * @param {any} rawUrl
 * @returns {string}
 */
function validateTrustedExternalLauncherUrl(rawUrl) {
  if (typeof rawUrl !== 'string') return '';
  const trimmed = rawUrl.trim();
  if (!trimmed || /[\x00-\x1f\x7f]/.test(trimmed)) return '';
  /** @type {URL} */
  let parsed;
  try {
    parsed = new URL(trimmed);
  } catch {
    return '';
  }
  if (parsed.protocol !== 'https:') return '';
  if (parsed.username || parsed.password) return '';
  if (parsed.port && parsed.port !== '443') return '';

  const hostname = parsed.hostname.toLowerCase().replace(/\.$/, '');
  if (!hostname) return '';

  const isAllowedDomain = TRUSTED_EXTERNAL_LAUNCHER_DOMAINS.some(
    (domain) => hostname === domain || hostname.endsWith(`.${domain}`)
  );
  if (!isAllowedDomain) return '';

  return parsed.toString();
}

/**
 * Strictly validate a Steam AppID for `steam://install/<appId>` URIs.
 *
 * @param {unknown} rawAppId
 * @returns {string}
 */
function validateSafeSteamAppId(rawAppId) {
  const clean = String(rawAppId ?? '')
    .trim()
    .replace(/^steam-/i, '');
  return isSafeNumericAppId(clean) ? clean : '';
}

/**
 * Strictly validate a GOG product ID for `goggalaxy://openGameView/<id>` URIs and CLI args.
 *
 * @param {unknown} rawId
 * @returns {string}
 */
function validateSafeGogProductId(rawId) {
  const clean = String(rawId ?? '')
    .trim()
    .replace(/^gog[-_]/i, '');
  if (!clean || clean.length > 64) return '';
  if (clean.startsWith('-') || /[\x00-\x1f\x7f/\\]/.test(clean) || clean.includes('..')) {
    return '';
  }
  return /^[A-Za-z0-9._-]+$/.test(clean) ? clean : '';
}

/**
 * Strictly validate a positional CLI identifier (e.g. Legendary appName) against
 * leading-dash flag injection, control characters, NUL bytes, and path traversal.
 *
 * @param {unknown} rawId
 * @returns {string}
 */
function validateSafeCliIdentifier(rawId) {
  const clean = String(rawId ?? '').trim();
  if (!clean || clean.length > 160) return '';
  if (
    clean.startsWith('-') ||
    /[\x00-\x1f\x7f/\\]/.test(clean) ||
    clean === '.' ||
    clean === '..' ||
    clean.includes('..')
  ) {
    return '';
  }
  return clean;
}

/**
 * Strictly validate a filesystem path argument passed to CLI tools (`legendary`, `gogdl`)
 * against NUL/control characters and leading-dash option injection.
 *
 * @param {unknown} rawPath
 * @returns {string}
 */
function validateSafeCliPathArg(rawPath) {
  if (typeof rawPath !== 'string') return '';
  const trimmed = rawPath.trim();
  if (!trimmed || /[\x00-\x1f\x7f]/.test(trimmed)) return '';
  if (trimmed.startsWith('-')) return '';
  return trimmed;
}

/**
 * Resolve a manifest-declared executable path and enforce strict containment inside `rootDir`
 * via `isContainedWithinRoot` (blocking absolute-path and `..` traversal escapes).
 *
 * @param {string} rootDir
 * @param {unknown} rawExecutable
 * @returns {string}
 */
function resolveContainedExecutablePath(rootDir, rawExecutable) {
  if (!rootDir || typeof rootDir !== 'string' || typeof rawExecutable !== 'string') {
    return '';
  }
  const trimmed = rawExecutable.trim();
  if (!trimmed || /[\x00-\x1f\x7f]/.test(trimmed)) return '';
  const normalizedSep = trimmed.replace(/\\/g, path.sep);
  const candidate = path.isAbsolute(normalizedSep)
    ? path.resolve(normalizedSep)
    : path.resolve(rootDir, normalizedSep);
  if (!isContainedWithinRoot(rootDir, candidate)) {
    return '';
  }
  return candidate;
}

/**
 * Validate an Epic CDN manifest entry (`uri` + optional `queryParams`) against HTTPS,
 * public-URL SSRF syntax checks, allowlisted Epic/CDN hosts, and safe `URLSearchParams`
 * assembly (preventing raw query string injection).
 *
 * @param {any} manifestEntry
 * @returns {string}
 */
function buildValidatedEpicManifestUrl(manifestEntry) {
  if (!manifestEntry || typeof manifestEntry.uri !== 'string') return '';
  const rawUri = manifestEntry.uri.trim();
  if (!rawUri || /[\x00-\x1f\x7f]/.test(rawUri)) return '';

  /** @type {URL} */
  let parsed;
  try {
    const syntax = assertSafePublicHttpsUrlSyntax(rawUri);
    if (!isAllowedHttpsHost(syntax.url, ALLOWED_EPIC_MANIFEST_CDN_HOSTS)) {
      return '';
    }
    parsed = new URL(syntax.url);
  } catch {
    return '';
  }

  if (Array.isArray(manifestEntry.queryParams) && manifestEntry.queryParams.length > 0) {
    for (const q of manifestEntry.queryParams) {
      if (!q || typeof q.name !== 'string') continue;
      const name = q.name.trim();
      const val = q.value === undefined || q.value === null ? '' : String(q.value);
      if (
        !name ||
        name.length > 128 ||
        val.length > 2048 ||
        /[\x00-\x1f\x7f]/.test(name) ||
        /[\x00-\x1f\x7f]/.test(val)
      ) {
        return '';
      }
      parsed.searchParams.set(name, val);
    }
  }

  return parsed.toString();
}

/**
 * Build a normalized deduplication key for `(platformId, platformGameId, hostPlatform)`.
 *
 * @param {string} platformId
 * @param {string} platformGameId
 * @param {string} hostPlatform
 * @returns {string}
 */
function buildActiveDownloadDedupKey(platformId, platformGameId, hostPlatform) {
  const normPlat = String(platformId || '')
    .trim()
    .toLowerCase();
  let normGame = String(platformGameId || '')
    .trim()
    .toLowerCase();
  if (normPlat === 'steam') normGame = normGame.replace(/^steam[-_:]/i, '');
  else if (normPlat === 'gog') normGame = normGame.replace(/^gog[-_:]/i, '');
  else if (normPlat === 'epic') normGame = normGame.replace(/^epic[-_:]/i, '');
  else if (normPlat === 'xbox') normGame = normGame.replace(/^xbox[-_:]/i, '');
  const normHost = String(hostPlatform || process.platform)
    .trim()
    .toLowerCase();
  if (!normPlat || !normGame) return '';
  return `${normHost}:${normPlat}:${normGame}`;
}

/**
 * Locate an existing active download task matching `(platformId, platformGameId)` on the same host
 * platform (excluding completed/failed/cancelled/paused/manual tasks).
 *
 * @param {string} platformId
 * @param {string} platformGameId
 * @param {string} hostPlatform
 * @param {string} [excludeTaskId]
 * @returns {any | null}
 */
function findActiveDuplicateDownloadTask(platformId, platformGameId, hostPlatform, excludeTaskId) {
  const targetKey = buildActiveDownloadDedupKey(platformId, platformGameId, hostPlatform);
  if (!targetKey) return null;
  for (const [existingId, existingTask] of downloadQueueMap.entries()) {
    if (!existingTask || existingId === excludeTaskId) continue;
    if (existingTask.isSimulatedOrManual || existingTask.manualControl) continue;
    if (!ACTIVE_DOWNLOAD_STATUSES.has(existingTask.status)) continue;
    const existingHost = existingTask._hostPlatform || hostPlatform;
    const existingKey = buildActiveDownloadDedupKey(
      existingTask.platformId,
      existingTask.platformGameId || existingTask.steamAppId || existingTask.xboxProductId,
      existingHost
    );
    if (existingKey === targetKey) {
      return existingTask;
    }
  }
  return null;
}

/**
 * Strip internal private bookkeeping fields before exposing a task over IPC or return values.
 *
 * @param {any} task
 * @returns {Record<string, any>}
 */
function toPublicDownloadTask(task) {
  if (!task || typeof task !== 'object') return {};
  const { _persistedUserDataDir, _hostPlatform, ...publicTask } = task;
  return { ...publicTask };
}

/**
 * Check whether a task has been cancelled or paused (used after async `await` boundaries
 * before spawning child processes or starting extractors).
 *
 * @param {string} taskId
 * @param {any} [ctrl]
 * @returns {boolean}
 */
function isTaskCancelledOrPaused(taskId, ctrl) {
  if (ctrl && (ctrl.cancelRequested || ctrl.pausedByUser)) {
    return true;
  }
  const task = downloadQueueMap.get(taskId);
  if (!task) return true;
  return (
    task.status === 'cancelled' ||
    task.status === 'paused' ||
    task.status === 'completed' ||
    task.status === 'failed'
  );
}

registerExternalCacheInvalidator(() => {
  rehydratedQueueDirs.clear();
});

function clearRehydratedQueueDirs() {
  rehydratedQueueDirs.clear();
}

function clearPendingBroadcastTimers() {
  for (const [, entry] of broadcastThrottleByTask.entries()) {
    if (entry && entry.timer) {
      try {
        clearTimeout(entry.timer);
      } catch {}
    }
  }
  broadcastThrottleByTask.clear();
}

/**
 * Enforce a bounded cap on completed/failed/cancelled entries in `downloadQueueMap`
 * so long-lived desktop sessions never accumulate unbounded task history.
 */
function pruneTerminalDownloadHistory() {
  let terminalCount = 0;
  for (const [, t] of downloadQueueMap.entries()) {
    if (t && TERMINAL_DOWNLOAD_STATUSES.has(t.status)) {
      terminalCount += 1;
    }
  }
  if (terminalCount <= MAX_TERMINAL_DOWNLOAD_HISTORY) return;

  let toRemove = terminalCount - MAX_TERMINAL_DOWNLOAD_HISTORY;
  for (const [id, t] of downloadQueueMap.entries()) {
    if (toRemove <= 0) break;
    if (t && TERMINAL_DOWNLOAD_STATUSES.has(t.status)) {
      downloadQueueMap.delete(id);
      downloadSpeedTrackers.delete(id);
      const bEntry = broadcastThrottleByTask.get(id);
      if (bEntry?.timer) {
        try {
          clearTimeout(bEntry.timer);
        } catch {}
      }
      broadcastThrottleByTask.delete(id);
      toRemove -= 1;
    }
  }
}

/**
 * Resolve the persistent queue JSON path for a given userDataDir (if persistence is appropriate).
 *
 * @param {string} [explicitUserDataDir]
 * @returns {string | null}
 */
function resolveDownloadQueuePersistPath(explicitUserDataDir) {
  const configured = explicitUserDataDir || getConfiguredUserDataDir();
  if (!configured && isTestEnvironment()) {
    return null;
  }
  const resolvedDir = getUserDataDir(configured);
  if (!resolvedDir) return null;
  return path.join(resolvedDir, DOWNLOAD_QUEUE_PERSIST_FILENAME);
}

/**
 * Serialize resumable / active non-ephemeral tasks to `download_queue_v1.json` atomically.
 *
 * @param {string} [explicitUserDataDir]
 */
function persistDownloadQueueToDisk(explicitUserDataDir) {
  try {
    const queueFilePath = resolveDownloadQueuePersistPath(explicitUserDataDir);
    if (!queueFilePath) return;

    const persistableTasks = [];
    for (const [, t] of downloadQueueMap.entries()) {
      if (!t || t.isSimulatedOrManual || t.manualControl) continue;
      if (!['queued', 'paused', 'downloading', 'extracting', 'verifying'].includes(t.status)) {
        continue;
      }
      const cleanTask = toPublicDownloadTask(t);
      persistableTasks.push({
        ...cleanTask,
        speedBytesPerSec: 0,
        etaSeconds: undefined,
      });
    }

    if (persistableTasks.length === 0 && !fs.existsSync(queueFilePath)) {
      return;
    }

    atomicWriteFileSync(
      queueFilePath,
      JSON.stringify(
        {
          schemaVersion: 1,
          updatedAt: new Date().toISOString(),
          tasks: persistableTasks,
        },
        null,
        2
      )
    );
  } catch (err) {
    diagLog.debug('persistDownloadQueueToDisk.error', err);
  }
}

/**
 * Rehydrate persisted tasks from `download_queue_v1.json` once per `userDataDir`.
 * Interrupted active tasks (`downloading`, `extracting`, `verifying`) are safely coerced to `'paused'`
 * so the user can resume them deterministically after an app restart.
 *
 * @param {any} [options]
 */
function ensureDownloadQueueRehydrated(options = {}) {
  try {
    const explicitUserDataDir =
      options && typeof options === 'object' ? options.userDataDir : undefined;
    const queueFilePath = resolveDownloadQueuePersistPath(explicitUserDataDir);
    if (!queueFilePath) return;
    const dirKey = path.dirname(queueFilePath);
    if (rehydratedQueueDirs.has(dirKey)) return;
    rehydratedQueueDirs.add(dirKey);

    if (!fs.existsSync(queueFilePath)) return;
    const raw = JSON.parse(fs.readFileSync(queueFilePath, 'utf8'));
    const tasks = Array.isArray(raw?.tasks) ? raw.tasks : Array.isArray(raw) ? raw : [];
    let mutatedOnRehydrate = false;

    for (const entry of tasks) {
      if (!entry || typeof entry !== 'object' || !entry.taskId) continue;
      if (downloadQueueMap.has(entry.taskId)) continue;
      const wasActive = ['downloading', 'extracting', 'verifying'].includes(entry.status);
      const coercedStatus = wasActive ? 'paused' : entry.status === 'queued' ? 'queued' : 'paused';
      if (wasActive) {
        mutatedOnRehydrate = true;
      }
      downloadQueueMap.set(entry.taskId, {
        ...entry,
        status: coercedStatus,
        speedBytesPerSec: 0,
        etaSeconds: undefined,
        statusMessage:
          coercedStatus === 'paused' && wasActive
            ? 'Paused (resume after restart)'
            : entry.statusMessage || 'Download paused',
        _persistedUserDataDir: explicitUserDataDir || getConfiguredUserDataDir() || undefined,
      });
    }

    if (mutatedOnRehydrate) {
      persistDownloadQueueToDisk(explicitUserDataDir);
    }
  } catch (err) {
    diagLog.debug('ensureDownloadQueueRehydrated.error', err);
  }
}

/**
 * Rolling Window + Exponential Moving Average (EMA) Download Speed Stabilizer.
 *
 * @param {string} taskId
 * @param {any} [sample]
 * @returns {number}
 */
function computeSmoothedDownloadSpeed(taskId, sample = {}) {
  const safeSample = sample && typeof sample === 'object' ? sample : {};
  if (!taskId) return Math.max(0, Math.round(Number(safeSample.rawSpeedBytesPerSec || 0)));
  const now = typeof safeSample.nowMs === 'number' ? safeSample.nowMs : Date.now();
  const bytes =
    safeSample.bytesDownloaded !== undefined && safeSample.bytesDownloaded !== null
      ? Number(safeSample.bytesDownloaded)
      : undefined;
  const rawSpeed = Math.max(0, Math.round(Number(safeSample.rawSpeedBytesPerSec || 0)));
  const decompressedSpeed = Math.max(
    0,
    Math.round(Number(safeSample.decompressedSpeedBytesPerSec || 0))
  );

  let tracker = downloadSpeedTrackers.get(taskId);
  if (!tracker) {
    tracker = {
      emaSpeed: 0,
      samples: [],
      lastNonZeroTs: 0,
    };
    downloadSpeedTrackers.set(taskId, tracker);
  }

  tracker.samples.push({
    ts: now,
    bytes: bytes !== undefined && Number.isFinite(bytes) ? bytes : -1,
    rawSpeed,
  });

  while (tracker.samples.length > 2 && now - tracker.samples[0].ts > 6000) {
    tracker.samples.shift();
  }

  let rollingByteSpeed = 0;
  if (bytes !== undefined && bytes > 0) {
    for (let i = 0; i < tracker.samples.length - 1; i++) {
      const s = tracker.samples[i];
      const dtMs = now - s.ts;
      if (s.bytes >= 0 && bytes > s.bytes && dtMs >= 800 && dtMs <= 8000) {
        rollingByteSpeed = Math.round(((bytes - s.bytes) * 1000) / dtMs);
        break;
      }
    }
  }

  const recentRawSamples = tracker.samples
    .filter((/** @type {any} */ s) => now - s.ts <= 5000 && s.rawSpeed > 0)
    .map((/** @type {any} */ s) => s.rawSpeed);

  let rollingRawSpeed = 0;
  if (recentRawSamples.length >= 2) {
    const maxRecent = Math.max(...recentRawSamples);
    const filtered =
      maxRecent > 3 * 1024 * 1024
        ? recentRawSamples.filter(
            (/** @type {number} */ v) => v >= maxRecent * 0.25 || recentRawSamples.length <= 2
          )
        : recentRawSamples;
    const pool = filtered.length > 0 ? filtered : recentRawSamples;
    rollingRawSpeed = Math.round(
      pool.reduce((/** @type {number} */ a, /** @type {number} */ b) => a + b, 0) / pool.length
    );
  } else if (recentRawSamples.length === 1) {
    rollingRawSpeed = recentRawSamples[0];
  }

  let targetSpeed = rawSpeed;
  if (rawSpeed > 0 && rollingByteSpeed > 0) {
    if (tracker.emaSpeed > 2 * 1024 * 1024 && rawSpeed < tracker.emaSpeed * 0.35) {
      targetSpeed = Math.max(rollingByteSpeed, rollingRawSpeed);
    } else if (tracker.emaSpeed > 2 * 1024 * 1024 && rawSpeed > tracker.emaSpeed * 1.45) {
      targetSpeed = Math.round(rollingByteSpeed * 0.65 + rawSpeed * 0.35);
    } else {
      targetSpeed = Math.round(rawSpeed * 0.5 + rollingByteSpeed * 0.5);
    }
  } else if (rawSpeed <= 0 && rollingByteSpeed > 0) {
    targetSpeed = rollingByteSpeed;
  } else if (rawSpeed > 0 && rollingRawSpeed > 0 && recentRawSamples.length >= 2) {
    targetSpeed = Math.round(rawSpeed * 0.45 + rollingRawSpeed * 0.55);
  }

  if (tracker.emaSpeed <= 0) {
    if (targetSpeed > 0) {
      tracker.emaSpeed = targetSpeed;
      tracker.lastNonZeroTs = now;
    }
    return tracker.emaSpeed;
  }

  if (targetSpeed > 0) {
    tracker.lastNonZeroTs = now;
    const ratio = targetSpeed / tracker.emaSpeed;
    if (ratio < 0.35) {
      const alpha = decompressedSpeed > 1024 * 1024 ? 0.05 : 0.1;
      const damped = Math.round(tracker.emaSpeed * (1 - alpha) + targetSpeed * alpha);
      tracker.emaSpeed = Math.max(damped, Math.round(tracker.emaSpeed * 0.88));
    } else if (ratio > 1.45) {
      const alpha = 0.22;
      tracker.emaSpeed = Math.round(tracker.emaSpeed * (1 - alpha) + targetSpeed * alpha);
    } else {
      const alpha = 0.28;
      tracker.emaSpeed = Math.round(tracker.emaSpeed * (1 - alpha) + targetSpeed * alpha);
    }
  } else if (now - tracker.lastNonZeroTs < 4000) {
    tracker.emaSpeed = Math.round(tracker.emaSpeed * 0.9);
  } else {
    tracker.emaSpeed = 0;
  }

  return tracker.emaSpeed;
}

/**
 * Snapshot all current tasks in the download queue (stripping internal bookkeeping fields).
 *
 * @param {any} [options]
 * @returns {Record<string, any>[]}
 */
function getDownloadQueue(options = {}) {
  ensureDownloadQueueRehydrated(options);
  return Array.from(downloadQueueMap.values()).map((t) => toPublicDownloadTask(t));
}

/**
 * Broadcast a download update with leading + trailing edge throttling for high-frequency
 * active progress updates, while immediately emitting status changes and terminal states.
 *
 * @param {string} taskId
 * @param {Record<string, any>} publicTask
 * @param {boolean} forceImmediate
 * @param {any} options
 */
function emitThrottledDownloadUpdate(taskId, publicTask, forceImmediate, options = {}) {
  const throttleMs = Math.max(
    0,
    Number(
      options && options.broadcastThrottleMs !== undefined
        ? options.broadcastThrottleMs
        : DEFAULT_PROGRESS_BROADCAST_THROTTLE_MS
    )
  );
  const now = Date.now();
  let state = broadcastThrottleByTask.get(taskId);
  if (!state) {
    state = {
      timer: null,
      lastBroadcastAt: 0,
      lastEmittedPercent: -1,
      pendingPayload: null,
    };
    broadcastThrottleByTask.set(taskId, state);
  }

  if (forceImmediate || throttleMs === 0) {
    if (state.timer) {
      try {
        clearTimeout(state.timer);
      } catch {}
      state.timer = null;
    }
    const pendingTask = state.pendingPayload?.task;
    state.pendingPayload = null;
    // Flush distinct intermediate integer progress milestone before emitting a status transition
    if (
      pendingTask &&
      pendingTask.status !== publicTask.status &&
      typeof pendingTask.progressPercent === 'number' &&
      pendingTask.progressPercent !== state.lastEmittedPercent &&
      pendingTask.progressPercent !== publicTask.progressPercent
    ) {
      state.lastEmittedPercent = pendingTask.progressPercent;
      emitDownloadUpdated({
        task: pendingTask,
        queue: getDownloadQueue(options),
      });
    }
    state.lastBroadcastAt = now;
    state.lastEmittedPercent = Number(publicTask.progressPercent ?? -1);
    emitDownloadUpdated({
      task: { ...publicTask },
      queue: getDownloadQueue(options),
    });
    if (TERMINAL_DOWNLOAD_STATUSES.has(publicTask.status)) {
      broadcastThrottleByTask.delete(taskId);
    }
    return;
  }

  const elapsed = now - state.lastBroadcastAt;
  const percentChanged =
    typeof publicTask.progressPercent === 'number' &&
    publicTask.progressPercent !== state.lastEmittedPercent;
  const allowPercentMilestoneEmit =
    percentChanged &&
    options?.broadcastThrottleMs === undefined &&
    (isTestEnvironment(options) || elapsed >= 32);

  if ((elapsed >= throttleMs && !state.timer) || allowPercentMilestoneEmit) {
    if (state.timer) {
      try {
        clearTimeout(state.timer);
      } catch {}
      state.timer = null;
    }
    state.lastBroadcastAt = now;
    state.lastEmittedPercent = Number(publicTask.progressPercent ?? -1);
    state.pendingPayload = null;
    emitDownloadUpdated({
      task: { ...publicTask },
      queue: getDownloadQueue(options),
    });
    return;
  }

  state.pendingPayload = { task: { ...publicTask }, options };
  if (!state.timer) {
    const delay = Math.max(10, throttleMs - elapsed);
    const t = setTimeout(() => {
      const currentState = broadcastThrottleByTask.get(taskId);
      if (!currentState) return;
      currentState.timer = null;
      const pending = currentState.pendingPayload;
      currentState.pendingPayload = null;
      if (!pending) return;
      const latestTask = downloadQueueMap.get(taskId);
      const taskSnapshot = latestTask ? toPublicDownloadTask(latestTask) : pending.task;
      currentState.lastBroadcastAt = Date.now();
      currentState.lastEmittedPercent = Number(taskSnapshot.progressPercent ?? -1);
      emitDownloadUpdated({
        task: taskSnapshot,
        queue: getDownloadQueue(pending.options),
      });
    }, delay);
    if (typeof t.unref === 'function') t.unref();
    state.timer = t;
  }
}

/**
 * Update a download task state and notify all listeners (with throttled IPC broadcasts
 * for high-frequency progress updates and bounded terminal task history).
 *
 * @param {string} taskId
 * @param {any} [partial]
 * @param {any} [options]
 */
function updateDownloadTask(taskId, partial = {}, options = {}) {
  const task = downloadQueueMap.get(taskId);
  if (!task) {
    return { success: false, error: `Download task ${taskId} not found.` };
  }

  const prevProgress = Number(task.progressPercent || 0);
  const prevBytes = Number(task.bytesDownloaded || 0);
  const prevStatus = task.status;
  const prevStatusMessage = String(task.statusMessage || '');

  Object.assign(task, partial);

  if (
    task.totalBytes > 0 &&
    partial.bytesDownloaded !== undefined &&
    partial.progressPercent === undefined &&
    !task.hasExplicitCliProgress
  ) {
    task.progressPercent = Math.min(100, Math.round((task.bytesDownloaded / task.totalBytes) * 100));
  }

  if (
    ['downloading', 'extracting', 'verifying'].includes(task.status) &&
    prevStatus !== 'queued'
  ) {
    if (task.progressPercent < prevProgress && task.status !== 'completed') {
      task.progressPercent = prevProgress;
    }
    if (task.bytesDownloaded < prevBytes && task.status !== 'completed') {
      task.bytesDownloaded = prevBytes;
    }
    if (
      task.totalBytes > 0 &&
      task.bytesDownloaded > task.totalBytes &&
      task.status !== 'completed'
    ) {
      task.totalBytes = task.bytesDownloaded;
    }
  }

  if (
    task.status === 'completed' ||
    task.status === 'failed' ||
    task.status === 'cancelled' ||
    task.status === 'paused'
  ) {
    downloadSpeedTrackers.delete(taskId);
  }

  if (task.status === 'completed') {
    task.progressPercent = 100;
    task.speedBytesPerSec = 0;
    task.etaSeconds = 0;
    task.completedAt = task.completedAt || new Date().toISOString();
    task.finalInstallPath =
      task.finalInstallPath || path.join(task.installDir, sanitizeDirectoryName(task.title));

    upsertManagedInstallRecord(
      {
        platformId: task.platformId,
        platformGameId: task.platformGameId,
        appId: task.platformId === 'steam' ? task.steamAppId : undefined,
        ...(task.xboxProductId ? { xboxProductId: task.xboxProductId } : {}),
        ...(task.packageFamilyName ? { packageFamilyName: task.packageFamilyName } : {}),
        ...(task.appUserModelId ? { appUserModelId: task.appUserModelId } : {}),
        ...(task.xboxTitleId ? { xboxTitleId: task.xboxTitleId } : {}),
        ...(task.scid ? { scid: task.scid } : {}),
        ...(task.msaAppId ? { msaAppId: task.msaAppId } : {}),
        ...(task.version ? { version: task.version } : {}),
        ...(task.isClientlessXboxInstall ? { isClientlessXboxInstall: true } : {}),
        title: task.title,
        installPath: task.finalInstallPath,
        executablePath: task.executablePath,
        installSize:
          sanitizeGameInstallSizeBytes(task.installSize || task.diskSizeBytes) || task.totalBytes,
        runner: task.runner || 'one_launcher',
        isWindowsBinaryOnMac: task.isWindowsBinaryOnMac,
      },
      options.userDataDir
    );
  }

  const statusChanged = prevStatus !== task.status;
  const statusMessageChanged =
    partial.statusMessage !== undefined &&
    String(task.statusMessage || '') !== prevStatusMessage;
  if (!task.isSimulatedOrManual && !task.manualControl && statusChanged) {
    persistDownloadQueueToDisk(options.userDataDir || task._persistedUserDataDir);
  }

  if (TERMINAL_DOWNLOAD_STATUSES.has(task.status)) {
    pruneTerminalDownloadHistory();
  }

  const publicTask = toPublicDownloadTask(task);
  const forceImmediate =
    statusChanged ||
    statusMessageChanged ||
    TERMINAL_DOWNLOAD_STATUSES.has(task.status) ||
    task.status === 'paused' ||
    Boolean(task.manualControl);

  emitThrottledDownloadUpdate(taskId, publicTask, forceImmediate, options);

  return {
    success: true,
    task: { ...publicTask },
  };
}

setGogDownloadTaskHooks({
  updateDownloadTask,
  computeSmoothedDownloadSpeed,
});

module.exports = {
  DOWNLOAD_QUEUE_PERSIST_FILENAME,
  DEFAULT_PROGRESS_BROADCAST_THROTTLE_MS,
  MAX_TERMINAL_DOWNLOAD_HISTORY,
  TRUSTED_EXTERNAL_LAUNCHER_DOMAINS,
  ALLOWED_EPIC_MANIFEST_CDN_HOSTS,
  inFlightInstallKeys,
  resolveAnyChainedHandoffId,
  extractEpicRegistryLeaf,
  normalizeRequestedCompatibilityLayerType,
  notifyInstalledGamesUpdated,
  validateTrustedExternalLauncherUrl,
  validateSafeSteamAppId,
  validateSafeGogProductId,
  validateSafeCliIdentifier,
  validateSafeCliPathArg,
  resolveContainedExecutablePath,
  buildValidatedEpicManifestUrl,
  buildActiveDownloadDedupKey,
  findActiveDuplicateDownloadTask,
  toPublicDownloadTask,
  isTaskCancelledOrPaused,
  clearRehydratedQueueDirs,
  clearPendingBroadcastTimers,
  resolveDownloadQueuePersistPath,
  persistDownloadQueueToDisk,
  ensureDownloadQueueRehydrated,
  computeSmoothedDownloadSpeed,
  getDownloadQueue,
  updateDownloadTask,
};
