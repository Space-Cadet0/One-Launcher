const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const childProcess = require('node:child_process');
const { execFile } = childProcess;

const {
  diagLog,
  getDiagnosticLogPath,
  setDiagnosticUserDataGetter,
} = require('../utils/diagnosticLogger.cjs');
const {
  sanitizeLaunchMethod,
  resolveEffectiveLifecyclePolicy,
} = require('./launchPolicyResolver.cjs');
const {
  toHostFilesystemPath,
  setSecurityUserDataDirResolver,
  atomicWriteFileSync,
} = require('./securityAndPathUtils.cjs');
const uninstallSafety = require('./uninstallSafety.cjs');
const {
  invalidateWindowsRegistryDiscoveryCache,
} = require('../utils/windowsRegistryDiscovery.cjs');
const {
  parseByteCountOrFormattedSize,
} = require('./binaryAndManifestInspectors.cjs');

/** @type {any} */
let xboxStorefrontModules = null;
function getXboxStorefrontModules() {
  if (!xboxStorefrontModules) {
    try {
      xboxStorefrontModules = require('../storefronts/xbox/index.cjs');
    } catch {
      xboxStorefrontModules = null;
    }
  }
  return xboxStorefrontModules;
}

/** @type {any} */
let electron = {};
try {
  const reqElectron = require('electron');
  if (reqElectron && typeof reqElectron === 'object') {
    electron = reqElectron;
  }
} catch {}

/** @type {any} */
let storeSync = null;
try {
  storeSync = require('../storeSync.cjs');
} catch {}

function getElectron() {
  return electron;
}

function getStoreSync() {
  return storeSync;
}

let mainWindowGetter = () => null;
/** @type {string | null} */
let configuredUserDataDir = null;

setDiagnosticUserDataGetter(() => getUserDataDir());
setSecurityUserDataDirResolver((/** @type {any} */ customDir) => getUserDataDir(customDir));

// Active game sessions keyed by gameId
const activeSessions = new Map();

// Concurrency & post-session race barriers
const inFlightPostSessionByGame = new Map();
const pendingBottleLaunches = new Map();
const inFlightPostSessionByBottle = new Map();
const pendingEphemeralShutdowns = new Map();
const pendingStorefrontLaunches = new Map();

// Download queue keyed by taskId
const downloadQueueMap = new Map();
const downloadControllers = new Map();
const downloadSpeedTrackers = new Map();

// In-game download pause & post-session promises
const pausedByInGameTaskIds = new Set();
const inFlightPostSessionPromises = new Set();

// Local event listeners for testing and internal hooks
const sessionListeners = new Set();
const downloadListeners = new Set();
/** @type {Function | null} */
let sessionLifecycleHook = null;
/** @type {Function | null} */
let epicAuthRecoveryHook = null;
/** @type {Function | null} */
let xboxStoreLicenseRecoveryHook = null;
/** @type {{ trimMemory: Function | null, shutdown: Function | null }} */
let offlineVaultLifecycleHooks = { trimMemory: null, shutdown: null };

// Bounded runtime & discovery caches
const MAX_DISCOVERY_CACHE_ENTRIES = 500;
const MAX_LEGENDARY_CACHE_DIRS = 16;
const MAX_STEAM_LAUNCH_SPEC_CACHE_ENTRIES = 2000;
const MAX_BOUNDED_URI_AND_QUARANTINE_ENTRIES = 1000;
const STEAM_APPINFO_BUF_IDLE_TTL_MS = 5000;

const macCodesignValidCache = new Map();
const gogFirstPartySyncSignatureCache = new Map();
const recentDisplaySanitizeCache = new Map();
const pendingWineRegSyncByPrefix = new Map();
const executableDiscoveryCache = new Map();
const steamAppInfoCache = new Map();
const steamResolvedLaunchSpecCache = new Map();
const legendaryMetadataDirCache = new Map();
const legendaryAssetsFileCache = new Map();
const legendaryAliasesFileCache = new Map();
const moltenVkHudDeadlockCache = new Map();
const installInfoSizeCache = new Map();
const steamPlatformSupportCache = new Map();
const xboxCompatibilityProbeCache = new Map();
const quarantineClearedBinaries = new Set();

/** @type {string[]} */
const openedExternalUris = [];

/** @type {{ timestamp: number, result: any }} */
let lastProductionScanCache = { timestamp: 0, result: null };
let lastSyncedEpicFingerprint = '';
let lastSyncedGogFingerprint = '';

/** @type {Set<Function>} */
const externalCacheInvalidators = new Set();

function registerExternalCacheInvalidator(fn) {
  if (typeof fn === 'function') {
    externalCacheInvalidators.add(fn);
  }
}

function getLastProductionScanCache() {
  return lastProductionScanCache;
}

function setLastProductionScanCache(nextVal) {
  lastProductionScanCache = nextVal || { timestamp: 0, result: null };
}

function getLastSyncedEpicFingerprint() {
  return lastSyncedEpicFingerprint;
}

function setLastSyncedEpicFingerprint(fp) {
  lastSyncedEpicFingerprint = String(fp || '');
}

function getLastSyncedGogFingerprint() {
  return lastSyncedGogFingerprint;
}

function setLastSyncedGogFingerprint(fp) {
  lastSyncedGogFingerprint = String(fp || '');
}

function setBoundedMapEntry(map, key, value, maxEntries = MAX_DISCOVERY_CACHE_ENTRIES) {
  if (!map.has(key) && map.size >= maxEntries) {
    const oldestKey = map.keys().next().value;
    if (oldestKey !== undefined) {
      map.delete(oldestKey);
    }
  }
  map.set(key, value);
}

function addBoundedSetEntry(setObj, value, maxEntries = MAX_BOUNDED_URI_AND_QUARANTINE_ENTRIES) {
  if (!setObj.has(value) && setObj.size >= maxEntries) {
    const oldestVal = setObj.values().next().value;
    if (oldestVal !== undefined) {
      setObj.delete(oldestVal);
    }
  }
  setObj.add(value);
}

function trimMapToMaxSize(mapObj, maxEntries) {
  while (mapObj.size > maxEntries) {
    const oldestKey = mapObj.keys().next().value;
    if (oldestKey === undefined) break;
    mapObj.delete(oldestKey);
  }
}

function trimSetToMaxSize(setObj, maxEntries) {
  while (setObj.size > maxEntries) {
    const oldestVal = setObj.values().next().value;
    if (oldestVal === undefined) break;
    setObj.delete(oldestVal);
  }
}

function evictExecutableDiscoveryCacheForPath(targetPath) {
  if (!targetPath) return;
  const rawStr = String(targetPath);
  const resolvedStr = path.resolve(rawStr);
  executableDiscoveryCache.delete(rawStr);
  executableDiscoveryCache.delete(resolvedStr);
  const prefixes = [`${rawStr}|`, `${rawStr}:`, `${resolvedStr}|`, `${resolvedStr}:`];
  for (const key of Array.from(executableDiscoveryCache.keys())) {
    if (prefixes.some((prefix) => String(key).startsWith(prefix))) {
      executableDiscoveryCache.delete(key);
    }
  }
}

function trimLauncherEngineMemory() {
  for (const [, entry] of steamAppInfoCache.entries()) {
    if (entry) {
      if (entry.evictTimer) {
        try {
          clearTimeout(entry.evictTimer);
        } catch {}
        entry.evictTimer = null;
      }
      entry.buf = null;
    }
  }
  trimMapToMaxSize(steamAppInfoCache, 64);
  trimMapToMaxSize(executableDiscoveryCache, MAX_DISCOVERY_CACHE_ENTRIES);
  trimMapToMaxSize(steamResolvedLaunchSpecCache, 1000);
  trimMapToMaxSize(steamPlatformSupportCache, 2000);
  trimMapToMaxSize(xboxCompatibilityProbeCache, 500);
  trimMapToMaxSize(legendaryMetadataDirCache, MAX_LEGENDARY_CACHE_DIRS);
  trimMapToMaxSize(legendaryAssetsFileCache, MAX_LEGENDARY_CACHE_DIRS);
  trimMapToMaxSize(legendaryAliasesFileCache, MAX_LEGENDARY_CACHE_DIRS);
  trimMapToMaxSize(moltenVkHudDeadlockCache, 128);
  trimMapToMaxSize(installInfoSizeCache, 250);
  trimSetToMaxSize(quarantineClearedBinaries, MAX_BOUNDED_URI_AND_QUARANTINE_ENTRIES);

  if (openedExternalUris.length > MAX_BOUNDED_URI_AND_QUARANTINE_ENTRIES) {
    openedExternalUris.splice(
      0,
      openedExternalUris.length - MAX_BOUNDED_URI_AND_QUARANTINE_ENTRIES
    );
  }

  for (const key of Array.from(downloadSpeedTrackers.keys())) {
    if (!downloadQueueMap.has(key)) {
      downloadSpeedTrackers.delete(key);
    }
  }

  macCodesignValidCache.clear();
  gogFirstPartySyncSignatureCache.clear();
  recentDisplaySanitizeCache.clear();
  invalidateWindowsRegistryDiscoveryCache();
  for (const inv of externalCacheInvalidators) {
    try {
      inv();
    } catch {}
  }
  lastProductionScanCache = { timestamp: 0, result: null };
  if (typeof offlineVaultLifecycleHooks.trimMemory === 'function') {
    try {
      offlineVaultLifecycleHooks.trimMemory();
    } catch {}
  }
  if (typeof global.gc === 'function') {
    try {
      global.gc();
    } catch {}
  }
  return { success: true };
}

function invalidateScanCaches() {
  executableDiscoveryCache.clear();
  for (const [, entry] of steamAppInfoCache.entries()) {
    if (entry && entry.evictTimer) {
      try {
        clearTimeout(entry.evictTimer);
      } catch {}
      entry.evictTimer = null;
    }
  }
  steamAppInfoCache.clear();
  steamResolvedLaunchSpecCache.clear();
  steamPlatformSupportCache.clear();
  xboxCompatibilityProbeCache.clear();
  legendaryMetadataDirCache.clear();
  legendaryAssetsFileCache.clear();
  legendaryAliasesFileCache.clear();
  moltenVkHudDeadlockCache.clear();
  installInfoSizeCache.clear();
  macCodesignValidCache.clear();
  gogFirstPartySyncSignatureCache.clear();
  recentDisplaySanitizeCache.clear();
  invalidateWindowsRegistryDiscoveryCache();
  for (const inv of externalCacheInvalidators) {
    try {
      inv();
    } catch {}
  }
  lastProductionScanCache = { timestamp: 0, result: null };
  lastSyncedEpicFingerprint = '';
  lastSyncedGogFingerprint = '';
}

/**
 * Configure launcher engine with Electron mainWindow getter and optional overrides
 */
function setMainWindowGetter(fn) {
  if (typeof fn === 'function') {
    mainWindowGetter = fn;
  }
}

function getMainWindow() {
  try {
    return mainWindowGetter ? mainWindowGetter() : null;
  } catch {
    return null;
  }
}

function setSessionLifecycleHook(fn) {
  sessionLifecycleHook = typeof fn === 'function' ? fn : null;
}

function getSessionLifecycleHook() {
  return sessionLifecycleHook;
}

function setEpicAuthRecoveryHook(fn) {
  epicAuthRecoveryHook = typeof fn === 'function' ? fn : null;
}

function getEpicAuthRecoveryHook() {
  return epicAuthRecoveryHook;
}

function setXboxStoreLicenseRecoveryHook(fn) {
  xboxStoreLicenseRecoveryHook = typeof fn === 'function' ? fn : null;
}

function getXboxStoreLicenseRecoveryHook() {
  return xboxStoreLicenseRecoveryHook;
}

function setOfflineVaultLifecycleHooks(/** @type {any} */ hooks = {}) {
  offlineVaultLifecycleHooks = {
    trimMemory: typeof hooks?.trimMemory === 'function' ? hooks.trimMemory : null,
    shutdown: typeof hooks?.shutdown === 'function' ? hooks.shutdown : null,
  };
}

function getOfflineVaultLifecycleHooks() {
  return offlineVaultLifecycleHooks;
}

function setUserDataDir(dirPath) {
  configuredUserDataDir = dirPath;
}

function getConfiguredUserDataDir() {
  return configuredUserDataDir;
}

function onSessionUpdated(listener) {
  sessionListeners.add(listener);
  return () => sessionListeners.delete(listener);
}

function onDownloadUpdated(listener) {
  downloadListeners.add(listener);
  return () => downloadListeners.delete(listener);
}

function getPendingSessionsFilePath(/** @type {any} */ options = {}) {
  const customDir =
    options && typeof options === 'object'
      ? options.userDataDir || options.baseDir
      : typeof options === 'string'
        ? options
        : undefined;
  return path.join(getUserDataDir(customDir), 'one_launcher_pending_sessions.json');
}

function queuePendingCompletedSession(/** @type {any} */ eventPayload, /** @type {any} */ options = {}) {
  if (!eventPayload || typeof eventPayload !== 'object') return [];
  const filePath = getPendingSessionsFilePath(options);
  /** @type {any[]} */
  let queue = [];
  try {
    if (fs.existsSync(filePath)) {
      const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      if (Array.isArray(parsed)) {
        queue = parsed;
      }
    }
  } catch {}

  const sessionObj = eventPayload.session || eventPayload;
  const gameId = String(sessionObj.gameId || eventPayload.gameId || '').trim();
  const sessionId = String(sessionObj.sessionId || eventPayload.sessionId || '').trim();
  if (!gameId) return queue;

  const entryRecord = {
    sessionId: sessionId || `session-${Date.now()}`,
    gameId,
    title: String(sessionObj.title || eventPayload.title || gameId),
    platformId: sessionObj.platformId || eventPayload.platformId || 'custom',
    platformGameId: String(sessionObj.platformGameId || eventPayload.platformGameId || gameId),
    sessionMinutesPlayed: Number(eventPayload.sessionMinutesPlayed ?? 0),
    durationSeconds: Number(eventPayload.durationSeconds ?? 0),
    lastPlayed: eventPayload.lastPlayed || new Date().toISOString(),
    ...(typeof eventPayload.storefrontTotalPlaytimeMinutes === 'number' &&
    eventPayload.storefrontTotalPlaytimeMinutes > 0
      ? { storefrontTotalPlaytimeMinutes: eventPayload.storefrontTotalPlaytimeMinutes }
      : {}),
    ...(eventPayload.error ? { error: String(eventPayload.error) } : {}),
  };

  const existingIdx = queue.findIndex(
    (item) =>
      item &&
      ((sessionId && item.sessionId === sessionId) ||
        (!sessionId && item.gameId === gameId && item.lastPlayed === entryRecord.lastPlayed))
  );

  if (existingIdx >= 0) {
    queue[existingIdx] = {
      ...queue[existingIdx],
      ...entryRecord,
      sessionMinutesPlayed:
        entryRecord.sessionMinutesPlayed > 0
          ? entryRecord.sessionMinutesPlayed
          : queue[existingIdx].sessionMinutesPlayed,
    };
  } else {
    queue.push(entryRecord);
    if (queue.length > 100) {
      queue = queue.slice(-100);
    }
  }

  try {
    atomicWriteFileSync(filePath, JSON.stringify(queue, null, 2));
  } catch {}

  return queue;
}

function drainPendingCompletedSessions(/** @type {any} */ options = {}) {
  const filePath = getPendingSessionsFilePath(options);
  /** @type {any[]} */
  let queue = [];
  try {
    if (fs.existsSync(filePath)) {
      const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      if (Array.isArray(parsed)) {
        queue = parsed;
      }
      atomicWriteFileSync(filePath, JSON.stringify([], null, 2));
    }
  } catch {}
  return queue;
}

function emitSessionUpdated(/** @type {any} */ payload, /** @type {any} */ options = {}) {
  for (const listener of sessionListeners) {
    try {
      listener(payload);
    } catch {}
  }

  if (typeof sessionLifecycleHook === 'function' && payload) {
    try {
      const sess = payload.session || payload;
      const lifecycleStatus =
        payload.event === 'stopped'
          ? 'stopped'
          : payload.event === 'started'
            ? 'running'
            : payload.event === 'stopping'
              ? 'stopping'
              : sess.status;
      sessionLifecycleHook(sess.gameId, {
        ...sess,
        ...payload,
        status: lifecycleStatus,
      });
    } catch {}
  }

  let sentToRenderer = false;
  try {
    const win = getMainWindow();
    if (
      win &&
      typeof win.isDestroyed === 'function' &&
      !win.isDestroyed() &&
      win.webContents &&
      (typeof win.webContents.isDestroyed !== 'function' || !win.webContents.isDestroyed())
    ) {
      const isRendererLoading = Boolean(
        win.webContents.isLoadingMainFrame?.() || win.webContents.isLoading?.()
      );
      if (!isRendererLoading) {
        win.webContents.send('launcher:session-updated', payload);
        sentToRenderer = true;
      }
    }
  } catch {}

  if (
    (!sentToRenderer || options?.forceQueuePendingSession === true) &&
    payload &&
    (payload.event === 'stopped' ||
      payload.event === 'playtime_synced' ||
      payload.status === 'stopped' ||
      payload.session?.status === 'stopped')
  ) {
    try {
      queuePendingCompletedSession(payload, options);
    } catch {}
  }
}

function emitDownloadUpdated(/** @type {any} */ payload) {
  for (const listener of downloadListeners) {
    try {
      listener(payload);
    } catch {}
  }
  try {
    const win = getMainWindow();
    if (win && typeof win.isDestroyed === 'function' && !win.isDestroyed() && win.webContents) {
      win.webContents.send('launcher:download-updated', payload);
    }
  } catch {}
}

/**
 * Resolve Electron userData directory with fallback for headless/test environments
 */
function getUserDataDir(customDir) {
  if (customDir && typeof customDir === 'string') {
    const hostCustomDir = toHostFilesystemPath(customDir);
    try {
      if (!fs.existsSync(hostCustomDir)) {
        fs.mkdirSync(hostCustomDir, { recursive: true });
      }
    } catch {}
    return hostCustomDir;
  }
  if (configuredUserDataDir) {
    const hostConfiguredDir = toHostFilesystemPath(configuredUserDataDir);
    try {
      if (!fs.existsSync(hostConfiguredDir)) {
        fs.mkdirSync(hostConfiguredDir, { recursive: true });
      }
    } catch {}
    return hostConfiguredDir;
  }
  try {
    if (electron.app && typeof electron.app.getPath === 'function') {
      const p = electron.app.getPath('userData');
      if (p) {
        const hostPath = toHostFilesystemPath(p);
        if (!fs.existsSync(hostPath)) {
          fs.mkdirSync(hostPath, { recursive: true });
        }
        return hostPath;
      }
    }
  } catch {}

  const fallback = path.join(os.homedir(), '.one-launcher');
  try {
    if (!fs.existsSync(fallback)) {
      fs.mkdirSync(fallback, { recursive: true });
    }
  } catch {}
  return fallback;
}

function isTestEnvironment(/** @type {any} */ options = {}) {
  return Boolean(
    options?.homedir ||
      options?.userDataDir ||
      process.env.VITEST ||
      process.env.NODE_ENV === 'test'
  );
}

function resolveIsolatedHomedirAndUserData(/** @type {any} */ options = {}) {
  const isVitest = Boolean(process.env.VITEST || process.env.NODE_ENV === 'test');
  const defaultHome = isVitest
    ? path.join(os.tmpdir(), `one-launcher-test-home-${process.pid}`)
    : os.homedir();

  if (options?.homedir || options?.userDataDir || configuredUserDataDir) {
    const homedir = options.homedir || defaultHome;
    const fallbackUserData =
      options.userDataDir ||
      (options.homedir ? path.join(options.homedir, '.one-launcher') : undefined);
    const userDataDir = getUserDataDir(fallbackUserData);
    return { homedir, userDataDir };
  }
  if (isVitest) {
    const isolatedUserData = path.join(defaultHome, '.one-launcher');
    try {
      if (!fs.existsSync(isolatedUserData)) {
        fs.mkdirSync(isolatedUserData, { recursive: true });
      }
    } catch {}
    return { homedir: defaultHome, userDataDir: isolatedUserData };
  }
  return {
    homedir: os.homedir(),
    userDataDir: getUserDataDir(options?.userDataDir),
  };
}

/**
 * Normalize paths across macOS/POSIX and Windows (including escaped backslashes in manifests)
 */
function toLocalFsPath(rawPath, customRoots = []) {
  if (!rawPath || typeof rawPath !== 'string') return '';
  const trimmed = rawPath.trim();
  if (!trimmed) return '';

  try {
    if (fs.existsSync(trimmed)) return trimmed;
  } catch {}

  if (path.sep === '\\') {
    const unescapedWin = trimmed.replace(/\\\\/g, '\\');
    try {
      if (unescapedWin !== trimmed && fs.existsSync(unescapedWin)) return unescapedWin;
    } catch {}

    const posixNorm = unescapedWin.replace(/\\/g, '/');
    if (/^[Zz]:\//.test(posixNorm)) {
      const zStripped = posixNorm.replace(/^[Zz]:\/+/, '');
      for (const root of customRoots) {
        if (!root) continue;
        const candidateInRoot = path.join(root, zStripped);
        try {
          if (fs.existsSync(candidateInRoot)) return candidateInRoot;
        } catch {}
      }
      const sysDrive = process.env.SystemDrive || 'C:';
      const sysDriveMapped = path.join(`${sysDrive}\\`, zStripped);
      try {
        if (fs.existsSync(sysDriveMapped)) return sysDriveMapped;
      } catch {}
    }

    if (/^[A-Za-z]:\//.test(posixNorm) && Array.isArray(customRoots) && customRoots.length > 0) {
      const driveStripped = posixNorm.replace(/^[A-Za-z]:\/+/, '');
      for (const root of customRoots) {
        if (!root) continue;
        const candidateInRoot = path.join(root, driveStripped);
        try {
          if (fs.existsSync(candidateInRoot)) return candidateInRoot;
        } catch {}
      }
    }
    return unescapedWin;
  }

  // Convert Windows backslashes or drive-letter paths to POSIX forward slashes when running on non-Windows host
  if (path.sep === '/' && (trimmed.includes('\\') || /^[A-Za-z]:[\\/]/.test(trimmed))) {
    const posixCandidate = trimmed.replace(/\\\\/g, '/').replace(/\\/g, '/');
    try {
      if (fs.existsSync(posixCandidate)) return posixCandidate;
    } catch {}

    // Wine maps Z:/ directly to the host POSIX root filesystem (/)
    if (/^[Zz]:\//.test(posixCandidate)) {
      const zRootMapped = '/' + posixCandidate.replace(/^[Zz]:\/+/, '');
      try {
        if (fs.existsSync(zRootMapped)) return zRootMapped;
      } catch {}
      const zStripped = posixCandidate.replace(/^[Zz]:\/+/, '');
      for (const root of customRoots) {
        if (!root) continue;
        const candidateInRoot = path.join(root, zStripped);
        try {
          if (fs.existsSync(candidateInRoot)) return candidateInRoot;
        } catch {}
      }
      return zRootMapped;
    }

    // If it starts with a drive letter like C:/... check if a customRoot maps to it
    const driveStripped = posixCandidate.replace(/^[A-Za-z]:\//, '');
    for (const root of customRoots) {
      if (!root) continue;
      const candidateInRoot = path.join(root, driveStripped);
      try {
        if (fs.existsSync(candidateInRoot)) return candidateInRoot;
      } catch {}
    }
    return posixCandidate;
  }

  return trimmed;
}

/**
 * When running Node child_process.spawn directly on Windows against a POSIX `#!/usr/bin/env node`
 * script (e.g., cross-OS automated test fixtures), invoke `process.execPath` directly.
 */
function resolveWindowsNodeShebangSpawn(cmd, args) {
  if (process.platform !== 'win32' || !cmd || /\.(exe|cmd|bat|com)$/i.test(cmd)) {
    return { cmd, args };
  }
  try {
    if (fs.existsSync(cmd) && fs.statSync(cmd).isFile()) {
      const fd = fs.openSync(cmd, 'r');
      const buf = Buffer.alloc(64);
      const n = fs.readSync(fd, buf, 0, 64, 0);
      fs.closeSync(fd);
      const head = buf.subarray(0, n).toString('utf8');
      if (/^#!.*\bnode\b/i.test(head)) {
        return { cmd: process.execPath, args: [cmd, ...(Array.isArray(args) ? args : [])] };
      }
    }
  } catch {}
  return { cmd, args };
}

const ALLOWED_EXTERNAL_URI_SCHEME_RE =
  /^(?:https?:\/\/|steam:\/\/|goggalaxy:\/\/|com\.epicgames\.launcher:\/\/|heroic:\/\/|msxbox:(?:\/\/|\S)|ms-windows-store:(?:\/\/|\S)|xbox:(?:\/\/|\S)|ms-xbl-[a-z0-9-]+:(?:\/\/|\S))/i;

/**
 * Open an external URI via Electron shell (or record for headless tests).
 * Bounded to MAX_BOUNDED_URI_AND_QUARANTINE_ENTRIES (1000).
 */
async function openExternalUri(uri, /** @type {any} */ options = {}) {
  if (typeof uri !== 'string' || !uri.trim()) {
    return false;
  }
  const cleanUri = uri.trim();
  if (/[\x00-\x1f\x7f]/.test(cleanUri) || !ALLOWED_EXTERNAL_URI_SCHEME_RE.test(cleanUri)) {
    return false;
  }
  while (openedExternalUris.length >= MAX_BOUNDED_URI_AND_QUARANTINE_ENTRIES) {
    openedExternalUris.shift();
  }
  openedExternalUris.push(cleanUri);
  if (typeof options.onOpenExternal === 'function') {
    await options.onOpenExternal(cleanUri);
    return true;
  }
  if (typeof options.openExternalFn === 'function') {
    await options.openExternalFn(cleanUri);
    return true;
  }
  try {
    if (electron.shell && typeof electron.shell.openExternal === 'function') {
      if (options.activate === false) {
        await electron.shell.openExternal(cleanUri, { activate: false });
      } else {
        await electron.shell.openExternal(cleanUri);
      }
      return true;
    }
  } catch {}
  return true;
}

/** @type {Record<string, string>} */
const STEAM_LANGUAGE_BY_CODE = {
  ar: 'arabic',
  bg: 'bulgarian',
  cs: 'czech',
  da: 'danish',
  de: 'german',
  el: 'greek',
  en: 'english',
  es: 'spanish',
  'es-419': 'latam',
  fi: 'finnish',
  fr: 'french',
  hu: 'hungarian',
  id: 'indonesian',
  it: 'italian',
  ja: 'japanese',
  ko: 'koreana',
  nl: 'dutch',
  no: 'norwegian',
  nb: 'norwegian',
  nn: 'norwegian',
  pl: 'polish',
  pt: 'portuguese',
  'pt-br': 'brazilian',
  ro: 'romanian',
  ru: 'russian',
  sv: 'swedish',
  th: 'thai',
  tr: 'turkish',
  uk: 'ukrainian',
  vi: 'vietnamese',
  'zh-cn': 'schinese',
  'zh-hans': 'schinese',
  'zh-sg': 'schinese',
  'zh-tw': 'tchinese',
  'zh-hant': 'tchinese',
  'zh-hk': 'tchinese',
};

/** @type {Record<string, string>} */
const DEFAULT_REGION_BY_LANG = {
  de: 'DE',
  en: 'US',
  es: 'ES',
  fr: 'FR',
  it: 'IT',
  ja: 'JP',
  ko: 'KR',
  nl: 'NL',
  pl: 'PL',
  pt: 'PT',
  ru: 'RU',
  sv: 'SE',
  tr: 'TR',
  uk: 'UA',
  zh: 'CN',
};

/**
 * Dynamically derive storefront locale identifiers from OS / Electron / env locale.
 */
function resolveHostLocaleInfo(/** @type {any} */ options = {}) {
  let raw = '';
  if (typeof options?.locale === 'string' && options.locale.trim()) {
    raw = options.locale.trim();
  } else {
    try {
      if (electron.app && typeof electron.app.getLocale === 'function') {
        raw = String(electron.app.getLocale() || '').trim();
      }
    } catch {}
    if (!raw) {
      const envLoc =
        options?.env?.LC_ALL ||
        options?.env?.LC_MESSAGES ||
        options?.env?.LANG ||
        process.env.LC_ALL ||
        process.env.LC_MESSAGES ||
        process.env.LANG ||
        '';
      const cleanedEnv = String(envLoc)
        .split('.')[0]
        .split('@')[0]
        .trim();
      if (cleanedEnv && !/^(c|posix)$/i.test(cleanedEnv)) {
        raw = cleanedEnv;
      }
    }
    if (!raw) {
      try {
        raw = Intl.DateTimeFormat().resolvedOptions().locale || '';
      } catch {}
    }
  }

  const normalized = (raw || 'en-US').replace(/_/g, '-').trim();
  const parts = normalized.split('-').filter(Boolean);
  const lang = (parts[0] || 'en').toLowerCase();
  let scriptOrRegion = parts[1] || '';
  let region = '';

  if (/^[a-zA-Z]{4}$/.test(scriptOrRegion)) {
    const script =
      scriptOrRegion.charAt(0).toUpperCase() + scriptOrRegion.slice(1).toLowerCase();
    scriptOrRegion = script;
    region = (parts[2] || '').toUpperCase();
  } else if (/^[a-zA-Z]{2}$|^\d{3}$/.test(scriptOrRegion)) {
    region = scriptOrRegion.toUpperCase();
    scriptOrRegion = '';
  }

  if (!region && DEFAULT_REGION_BY_LANG[lang]) {
    region = DEFAULT_REGION_BY_LANG[lang];
  }

  const bcp47 = scriptOrRegion
    ? `${lang}-${scriptOrRegion}${region ? `-${region}` : ''}`
    : region
      ? `${lang}-${region}`
      : lang;
  const gogLocale = region ? `${lang}-${region}` : `${lang}-${lang.toUpperCase()}`;
  const lowerFull = bcp47.toLowerCase();
  const lowerLangRegion = region ? `${lang}-${region.toLowerCase()}` : lang;
  const steamLanguage =
    STEAM_LANGUAGE_BY_CODE[lowerFull] ||
    STEAM_LANGUAGE_BY_CODE[lowerLangRegion] ||
    STEAM_LANGUAGE_BY_CODE[lang] ||
    'english';
  const epicLocale =
    lang === 'zh'
      ? lowerFull.includes('tw') || lowerFull.includes('hk') || lowerFull.includes('hant')
        ? 'zh-Hant'
        : 'zh-Hans'
      : lang === 'pt' && region === 'BR'
        ? 'pt-BR'
        : lang === 'es' && (region === 'MX' || region === '419')
          ? 'es-MX'
          : lang;

  return {
    bcp47,
    langCode: lang,
    gogLocale,
    steamLanguage,
    epicLocale,
  };
}

/**
 * Awaited macOS quarantine removal helper with bounded tracking set (max 1000).
 */
async function clearMacQuarantineAsync(targetPath, /** @type {any} */ options = {}) {
  const platform = options.platform || process.platform;
  if (platform !== 'darwin' || !targetPath || typeof targetPath !== 'string') {
    return false;
  }
  const resolved = path.resolve(targetPath);
  if (quarantineClearedBinaries.has(resolved) && options.force !== true) {
    return true;
  }
  const execFileFn =
    typeof options.execFileFn === 'function'
      ? options.execFileFn
      : typeof options.execFileImpl === 'function'
        ? options.execFileImpl
        : execFile;

  return new Promise((resolve) => {
    try {
      execFileFn(
        '/usr/bin/xattr',
        ['-dr', 'com.apple.quarantine', targetPath],
        { timeout: 10000 },
        (err) => {
          if (!err) {
            addBoundedSetEntry(quarantineClearedBinaries, resolved);
          } else {
            // Fallback to PATH lookup if mocked execFile expects 'xattr'
            if (execFileFn !== execFile) {
              try {
                execFileFn(
                  'xattr',
                  ['-dr', 'com.apple.quarantine', targetPath],
                  { timeout: 10000 },
                  () => {
                    addBoundedSetEntry(quarantineClearedBinaries, resolved);
                    resolve(true);
                  }
                );
                return;
              } catch {}
            }
            addBoundedSetEntry(quarantineClearedBinaries, resolved);
          }
          resolve(true);
        }
      );
    } catch {
      resolve(false);
    }
  });
}

function isTrustedHelperBinaryStats(filePath, isUserWritableFallback = false) {
  try {
    const st = fs.statSync(filePath);
    if (!st.isFile()) return false;
    if (process.platform !== 'win32' && typeof process.getuid === 'function') {
      // Reject world-writable binaries everywhere; reject group-writable on ~/.local/bin fallback
      if ((st.mode & 0o002) !== 0) return false;
      if (isUserWritableFallback && (st.mode & 0o022) !== 0) return false;
      const currentUid = process.getuid();
      if (currentUid >= 0 && st.uid !== 0 && st.uid !== currentUid) {
        return false;
      }
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolve helper CLIs (`legendary`, `gogdl`) preferring bundled and root/system-installed
 * paths BEFORE user-writable directories (`~/.local/bin`).
 */
function findBundledOrSystemCliBinary(baseName, /** @type {any} */ options = {}) {
  const homedir = options.homedir || os.homedir();
  const testCandidates = options.homedir
    ? [
        path.join(options.homedir, `Library/Application Support/heroic/tools/bin/${baseName}`),
        path.join(options.homedir, `.local/bin/${baseName}`),
        path.join(options.homedir, `bin/${baseName}`),
      ]
    : [];

  if (options.homedir && options.allowSystemBinariesInTest !== true) {
    return testCandidates.find((p) => fs.existsSync(p)) || null;
  }

  let found =
    testCandidates.find((p) => fs.existsSync(p) && isTrustedHelperBinaryStats(p, false)) || null;

  if (!found) {
    const binName = process.platform === 'win32' ? `${baseName}.exe` : baseName;
    const electronRoot = path.resolve(__dirname, '..');
    const unpackedElectronRoot = electronRoot.replace('app.asar', 'app.asar.unpacked');
    const unpackedLauncherDir = __dirname.replace('app.asar', 'app.asar.unpacked');

    const trustedCandidates = [
      path.join(unpackedElectronRoot, 'bin', process.arch, process.platform, binName),
      path.join(electronRoot, 'bin', process.arch, process.platform, binName),
      path.join(unpackedLauncherDir, 'bin', process.arch, process.platform, binName),
      path.join(__dirname, 'bin', process.arch, process.platform, binName),
      `/usr/local/bin/${baseName}`,
      `/opt/homebrew/bin/${baseName}`,
      `/Applications/Heroic.app/Contents/Resources/app.asar.unpacked/build/bin/arm64/darwin/${baseName}`,
      `/Applications/Heroic.app/Contents/Resources/app.asar.unpacked/build/bin/x64/darwin/${baseName}`,
      `/Applications/Heroic.app/Contents/Resources/app.asar.unpacked/build/bin/darwin/arm64/${baseName}`,
      `/Applications/Heroic.app/Contents/Resources/app.asar.unpacked/build/bin/darwin/x64/${baseName}`,
      path.join(
        process.env.ProgramFiles || 'C:\\Program Files',
        `Heroic/resources/app.asar.unpacked/build/bin/x64/win32/${baseName}.exe`
      ),
      path.join(homedir, `Library/Application Support/heroic/tools/bin/${baseName}`),
      path.join(
        process.env.LOCALAPPDATA || path.join(homedir, 'AppData/Local'),
        `Programs/heroic/resources/app.asar.unpacked/build/bin/x64/win32/${baseName}.exe`
      ),
    ];

    found =
      trustedCandidates.find((p) => fs.existsSync(p) && isTrustedHelperBinaryStats(p, false)) ||
      null;
  }

  if (!found) {
    const localBinFallback = path.join(homedir, `.local/bin/${baseName}`);
    if (fs.existsSync(localBinFallback) && isTrustedHelperBinaryStats(localBinFallback, true)) {
      found = localBinFallback;
    }
  }

  if (found && process.platform !== 'win32') {
    try {
      const st = fs.statSync(found);
      if (st.isFile() && (st.mode & 0o111) === 0) {
        fs.chmodSync(found, 0o755);
      }
    } catch {}
    const resolvedFound = path.resolve(found);
    if (process.platform === 'darwin' && !quarantineClearedBinaries.has(resolvedFound)) {
      addBoundedSetEntry(quarantineClearedBinaries, resolvedFound);
      try {
        if (typeof options.execFileSyncFn === 'function') {
          options.execFileSyncFn('xattr', ['-dr', 'com.apple.quarantine', found], {
            stdio: 'ignore',
            timeout: 1500,
          });
        } else if (typeof options.execFileFn === 'function') {
          options.execFileFn(
            'xattr',
            ['-dr', 'com.apple.quarantine', found],
            { timeout: 3000 },
            () => {}
          );
        } else if (isTestEnvironment(options)) {
          require('node:child_process').execFileSync(
            'xattr',
            ['-dr', 'com.apple.quarantine', found],
            {
              stdio: 'ignore',
              timeout: 1500,
            }
          );
        } else {
          childProcess.execFile(
            '/usr/bin/xattr',
            ['-dr', 'com.apple.quarantine', found],
            { timeout: 3000 },
            () => {}
          );
        }
      } catch {}
    }
  }
  return found;
}

function findLegendaryBinary(/** @type {any} */ options = {}) {
  if (typeof options?.legendaryBinaryPath === 'string' && options.legendaryBinaryPath.trim()) {
    return options.legendaryBinaryPath.trim();
  }
  return findBundledOrSystemCliBinary('legendary', options);
}

function findGogdlBinary(/** @type {any} */ options = {}) {
  if (typeof options?.gogdlBinaryPath === 'string' && options.gogdlBinaryPath.trim()) {
    return options.gogdlBinaryPath.trim();
  }
  return findBundledOrSystemCliBinary('gogdl', options);
}

const ONE_LAUNCHER_MANAGED_SENTINEL = '.one_launcher_managed';

/**
 * Write `.one_launcher_managed` JSON sentinel inside directories created directly by One Launcher.
 */
function writeManagedInstallSentinel(installDir, /** @type {any} */ metadata = {}) {
  if (!installDir || typeof installDir !== 'string') return false;
  try {
    if (!fs.existsSync(installDir) || !fs.statSync(installDir).isDirectory()) {
      return false;
    }
    const sentinelPath = path.join(installDir, ONE_LAUNCHER_MANAGED_SENTINEL);
    const payload = {
      schemaVersion: 1,
      store: String(metadata.store || metadata.platformId || 'custom'),
      gameId: String(metadata.gameId || metadata.platformGameId || ''),
      installKind: String(metadata.installKind || 'managed'),
      createdAt: metadata.createdAt || new Date().toISOString(),
    };
    atomicWriteFileSync(sentinelPath, JSON.stringify(payload, null, 2));
    return true;
  } catch {
    return false;
  }
}

function readManagedInstallSentinel(installDir) {
  if (!installDir || typeof installDir !== 'string') return null;
  try {
    const sentinelPath = path.join(installDir, ONE_LAUNCHER_MANAGED_SENTINEL);
    if (!fs.existsSync(sentinelPath)) return null;
    const parsed = JSON.parse(fs.readFileSync(sentinelPath, 'utf8'));
    if (parsed && typeof parsed === 'object' && Number(parsed.schemaVersion) >= 1) {
      return parsed;
    }
  } catch {}
  return null;
}

function hasManagedInstallSentinel(installDir, expectedStore) {
  const parsed = readManagedInstallSentinel(installDir);
  if (!parsed) return false;
  if (expectedStore && String(parsed.store || '').toLowerCase() !== String(expectedStore).toLowerCase()) {
    return false;
  }
  return true;
}

/**
 * Load & save One Launcher managed installations (`one_launcher_installed.json`)
 */
function getManagedInstalledFilePath(userDataDir) {
  return path.join(getUserDataDir(userDataDir), 'one_launcher_installed.json');
}

function loadManagedInstalledGames(userDataDir) {
  const filePath = getManagedInstalledFilePath(userDataDir);
  try {
    if (!fs.existsSync(filePath)) return [];
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    /** @type {any[]} */
    let records = [];
    if (Array.isArray(parsed)) {
      records = parsed;
    } else if (parsed && typeof parsed === 'object') {
      records = Array.isArray(parsed.installedGames) ? parsed.installedGames : Object.values(parsed);
    }
    let modified = false;
    for (const r of records) {
      if (!r || typeof r !== 'object') continue;
      if (r.platformId && r.platformId !== 'steam' && r.appId !== undefined) {
        delete r.appId;
        modified = true;
      }
      if (r.installSize !== undefined) {
        const sanitizedSize = parseByteCountOrFormattedSize(r.installSize);
        if (sanitizedSize !== r.installSize) {
          if (sanitizedSize) {
            r.installSize = sanitizedSize;
          } else {
            delete r.installSize;
          }
          modified = true;
        }
      }
    }
    if (modified) {
      saveManagedInstalledGames(records, userDataDir);
    }
    return records;
  } catch {}
  return [];
}

function saveManagedInstalledGames(records, userDataDir) {
  const filePath = getManagedInstalledFilePath(userDataDir);
  try {
    atomicWriteFileSync(filePath, JSON.stringify(records, null, 2));
    invalidateScanCaches();
    return true;
  } catch {
    return false;
  }
}

function upsertManagedInstallRecord(/** @type {any} */ record, userDataDir) {
  const cleanRecord = { ...record };
  if (cleanRecord.platformId !== 'steam') {
    delete cleanRecord.appId;
  }
  if (cleanRecord.installSize !== undefined) {
    const validInstallSize = parseByteCountOrFormattedSize(cleanRecord.installSize);
    if (validInstallSize) {
      cleanRecord.installSize = validInstallSize;
    } else {
      delete cleanRecord.installSize;
    }
  }
  const existing = loadManagedInstalledGames(userDataDir);
  const idx = existing.findIndex(
    (r) =>
      r.platformId === cleanRecord.platformId &&
      String(r.platformGameId) === String(cleanRecord.platformGameId)
  );
  if (idx >= 0) {
    const merged = { ...existing[idx], ...cleanRecord };
    if (merged.platformId !== 'steam') {
      delete merged.appId;
    }
    existing[idx] = merged;
  } else {
    existing.push(cleanRecord);
  }
  saveManagedInstalledGames(existing, userDataDir);
  invalidateScanCaches();
  return existing;
}

/**
 * Load & save per-game launch configurations (`one_launcher_configs.json`)
 */
const LAUNCH_PROFILE_KEYS = [
  'launchMethod',
  'customExecutablePath',
  'workingDirectory',
  'launchArguments',
  'environmentVariables',
  'compatibilityLayer',
  'wineBottleName',
  'winePrefixPath',
  'crossoverGraphicsBackend',
  'crossoverD3DMetalVersion',
  'crossoverHighResolutionMode',
  'crossoverDlss',
  'wineMsync',
  'wineEsync',
  'metalHud',
  'dxvkHud',
  'wineDebug',
  'inGameLauncherBehavior',
  'storefrontClientLifecycle',
  'preLaunchCommand',
  'postExitCommand',
];

function resolvePlatformLaunchConfig(/** @type {any} */ rawConfig, platformId) {
  if (!rawConfig || typeof rawConfig !== 'object') return {};
  const platMap =
    rawConfig.platformConfigs && typeof rawConfig.platformConfigs === 'object'
      ? rawConfig.platformConfigs
      : rawConfig.storefrontConfigs && typeof rawConfig.storefrontConfigs === 'object'
        ? rawConfig.storefrontConfigs
        : null;

  /** @type {any} */
  let resolved;
  if (platformId && platMap && platMap[platformId]) {
    resolved = {
      gameId: rawConfig.gameId,
      preferredPlatformId: platformId,
      launchMethod: 'auto',
      ...platMap[platformId],
    };
  } else if (
    platformId &&
    platMap &&
    Object.keys(platMap).length > 0 &&
    rawConfig.preferredPlatformId &&
    rawConfig.preferredPlatformId !== platformId
  ) {
    resolved = {
      gameId: rawConfig.gameId,
      preferredPlatformId: platformId,
      launchMethod: 'auto',
    };
  } else {
    resolved = { ...rawConfig };
  }
  if (resolved.compatibilityLayer === 'whisky') {
    resolved.compatibilityLayer = 'crossover';
  }
  if (resolved.launchMethod === 'custom') {
    resolved.launchMethod = 'auto';
  }
  return resolved;
}

function getLaunchConfigsFilePath(userDataDir) {
  return path.join(getUserDataDir(userDataDir), 'one_launcher_configs.json');
}

function getGameLaunchConfigs(/** @type {any} */ options = {}) {
  const filePath = getLaunchConfigsFilePath(options.userDataDir);
  try {
    if (!fs.existsSync(filePath)) return {};
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const shouldValidateFs = !options.userDataDir || options.pruneMissingExecutables === true;
      let modified = false;
      const archiveAssetRe =
        /\.(kpf|pak|wad|pk3|pk4|vpk|bsa|ba2|upk|uasset|umap|pck|bundle|assets|ress|resource|zip|7z|rar)$/i;
      for (const cfg of Object.values(parsed)) {
        if (!cfg || typeof cfg !== 'object') continue;
        if (cfg.compatibilityLayer === 'whisky') {
          cfg.compatibilityLayer = 'crossover';
          modified = true;
        }
        if (cfg.launchMethod === 'custom') {
          cfg.launchMethod = 'auto';
          modified = true;
        }
        if (shouldValidateFs && cfg.customExecutablePath) {
          const localExe = toLocalFsPath(cfg.customExecutablePath, options.customRoots);
          const isArchiveAsset = archiveAssetRe.test(String(localExe || ''));
          if (!localExe || isArchiveAsset || !fs.existsSync(localExe)) {
            delete cfg.customExecutablePath;
            modified = true;
          }
        }
        if (shouldValidateFs && cfg.workingDirectory) {
          const localDir = toLocalFsPath(cfg.workingDirectory, options.customRoots);
          if (!localDir || !fs.existsSync(localDir)) {
            delete cfg.workingDirectory;
            modified = true;
          }
        }
        if (cfg.platformConfigs && typeof cfg.platformConfigs === 'object') {
          for (const [, prof] of Object.entries(cfg.platformConfigs)) {
            if (!prof || typeof prof !== 'object') continue;
            if (prof.compatibilityLayer === 'whisky') {
              prof.compatibilityLayer = 'crossover';
              modified = true;
            }
            if (prof.launchMethod === 'custom') {
              prof.launchMethod = 'auto';
              modified = true;
            }
            if (shouldValidateFs && prof.customExecutablePath) {
              const localExe = toLocalFsPath(prof.customExecutablePath, options.customRoots);
              const isArchiveAsset = archiveAssetRe.test(String(localExe || ''));
              if (!localExe || isArchiveAsset || !fs.existsSync(localExe)) {
                delete prof.customExecutablePath;
                modified = true;
              }
            }
            if (shouldValidateFs && prof.workingDirectory) {
              const localDir = toLocalFsPath(prof.workingDirectory, options.customRoots);
              if (!localDir || !fs.existsSync(localDir)) {
                delete prof.workingDirectory;
                modified = true;
              }
            }
          }
        }
      }
      if (
        modified &&
        (options.pruneMissingExecutables === true || options.persistPrunedConfigs === true)
      ) {
        try {
          atomicWriteFileSync(filePath, JSON.stringify(parsed, null, 2));
        } catch {}
      }
      return parsed;
    }
  } catch {}
  return {};
}

function getGameLaunchConfig(gameId, /** @type {any} */ options = {}) {
  if (!gameId) return null;
  const all = getGameLaunchConfigs(options);
  return all[gameId] || null;
}

function saveGameLaunchConfig(/** @type {any} */ config, /** @type {any} */ options = {}) {
  if (!config || !config.gameId) {
    return { success: false, error: 'Invalid launch config: missing gameId' };
  }
  const filePath = getLaunchConfigsFilePath(options.userDataDir);
  const existing = getGameLaunchConfigs(options);
  if (config.reset === true) {
    delete existing[config.gameId];
    try {
      atomicWriteFileSync(filePath, JSON.stringify(existing, null, 2));
      invalidateScanCaches();
      return { success: true, config: { gameId: config.gameId } };
    } catch (/** @type {any} */ err) {
      return { success: false, error: err.message };
    }
  }

  /** @type {Record<string, any>} */
  const cleanProfile = {
    launchMethod: sanitizeLaunchMethod(config.launchMethod),
  };
  for (const key of LAUNCH_PROFILE_KEYS) {
    if (config[key] !== undefined && config[key] !== null) {
      cleanProfile[key] =
        key === 'compatibilityLayer' && config[key] === 'whisky'
          ? 'crossover'
          : key === 'launchMethod'
            ? sanitizeLaunchMethod(config[key])
            : config[key];
    }
  }

  const prevConfig = existing[config.gameId] || {};
  /** @type {Record<string, any>} */
  const mergedPlatformConfigs = {
    ...(prevConfig.platformConfigs && typeof prevConfig.platformConfigs === 'object'
      ? prevConfig.platformConfigs
      : {}),
  };

  if (config.platformConfigs && typeof config.platformConfigs === 'object') {
    for (const [platId, p] of Object.entries(config.platformConfigs)) {
      if (p && typeof p === 'object') {
        /** @type {Record<string, any>} */
        const cleanPlatProfile = { launchMethod: sanitizeLaunchMethod(p.launchMethod) };
        for (const key of LAUNCH_PROFILE_KEYS) {
          if (p[key] !== undefined && p[key] !== null) {
            cleanPlatProfile[key] =
              key === 'compatibilityLayer' && p[key] === 'whisky'
                ? 'crossover'
                : key === 'launchMethod'
                  ? sanitizeLaunchMethod(p[key])
                  : p[key];
          }
        }
        mergedPlatformConfigs[platId] = cleanPlatProfile;
      }
    }
  }

  if (config.resetPlatformId) {
    delete mergedPlatformConfigs[config.resetPlatformId];
  } else if (config.preferredPlatformId) {
    mergedPlatformConfigs[config.preferredPlatformId] = { ...cleanProfile };
  }

  const preferredPlatformId = config.preferredPlatformId || prevConfig.preferredPlatformId;
  /** @type {Record<string, any>} */
  const updated = {
    gameId: config.gameId,
    ...(preferredPlatformId ? { preferredPlatformId } : {}),
    ...cleanProfile,
  };

  for (const [k, v] of Object.entries(config)) {
    if (
      k === 'gameId' ||
      k === 'preferredPlatformId' ||
      k === 'reset' ||
      k === 'resetPlatformId' ||
      k === 'platformConfigs' ||
      LAUNCH_PROFILE_KEYS.includes(k)
    ) {
      continue;
    }
    if (v !== undefined && v !== null) {
      updated[k] = v;
    }
  }

  if (Object.keys(mergedPlatformConfigs).length > 0) {
    updated.platformConfigs = mergedPlatformConfigs;
  }

  existing[config.gameId] = updated;
  try {
    atomicWriteFileSync(filePath, JSON.stringify(existing, null, 2));
    invalidateScanCaches();
    return { success: true, config: updated };
  } catch (/** @type {any} */ err) {
    return { success: false, error: err.message };
  }
}

/**
 * In-Game Footprint Minimization & Performance Settings Persistence
 */
const DEFAULT_LAUNCHER_PERFORMANCE_SETTINGS = {
  inGameLauncherBehavior: 'hide_tray_hibernate',
  postGameLauncherBehavior: 'restore_window',
  pauseBackgroundSyncInGame: true,
  pauseDownloadsInGame: true,
  storefrontClientLifecycle: 'minimal_and_close_if_started',
  autoShutdownWinePrefixOnExit: true,
  suppressWineDebugLogging: true,
};

const VALID_IN_GAME_BEHAVIORS = new Set([
  'keep_open',
  'minimize_taskbar',
  'hide_tray_hibernate',
  'zero_renderer_daemon',
]);

const VALID_POST_GAME_BEHAVIORS = new Set([
  'restore_window',
  'stay_minimized',
  'exit_launcher',
]);

const VALID_STOREFRONT_LIFECYCLES = new Set([
  'default_client',
  'minimal_keep_running',
  'minimal_and_close_if_started',
  'fast_direct_bypass',
]);

function normalizeStorefrontClientLifecycle(val) {
  if (val === 'shutdown_if_woken') return 'minimal_and_close_if_started';
  if (val === 'keep_running') return 'minimal_keep_running';
  return VALID_STOREFRONT_LIFECYCLES.has(val) ? val : null;
}

function getPerformanceSettingsFilePath(/** @type {any} */ options = {}) {
  const customDir =
    options && typeof options === 'object'
      ? options.userDataDir || options.baseDir
      : typeof options === 'string'
        ? options
        : undefined;
  return path.join(getUserDataDir(customDir), 'one_launcher_performance_settings.json');
}

function sanitizeLauncherPerformanceSettings(/** @type {any} */ raw = {}) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const normStorefront = normalizeStorefrontClientLifecycle(src.storefrontClientLifecycle);
  return {
    inGameLauncherBehavior: VALID_IN_GAME_BEHAVIORS.has(src.inGameLauncherBehavior)
      ? src.inGameLauncherBehavior
      : DEFAULT_LAUNCHER_PERFORMANCE_SETTINGS.inGameLauncherBehavior,
    postGameLauncherBehavior: VALID_POST_GAME_BEHAVIORS.has(src.postGameLauncherBehavior)
      ? src.postGameLauncherBehavior
      : DEFAULT_LAUNCHER_PERFORMANCE_SETTINGS.postGameLauncherBehavior,
    pauseBackgroundSyncInGame:
      typeof src.pauseBackgroundSyncInGame === 'boolean'
        ? src.pauseBackgroundSyncInGame
        : DEFAULT_LAUNCHER_PERFORMANCE_SETTINGS.pauseBackgroundSyncInGame,
    pauseDownloadsInGame:
      typeof src.pauseDownloadsInGame === 'boolean'
        ? src.pauseDownloadsInGame
        : DEFAULT_LAUNCHER_PERFORMANCE_SETTINGS.pauseDownloadsInGame,
    storefrontClientLifecycle:
      normStorefront || DEFAULT_LAUNCHER_PERFORMANCE_SETTINGS.storefrontClientLifecycle,
    autoShutdownWinePrefixOnExit:
      typeof src.autoShutdownWinePrefixOnExit === 'boolean'
        ? src.autoShutdownWinePrefixOnExit
        : DEFAULT_LAUNCHER_PERFORMANCE_SETTINGS.autoShutdownWinePrefixOnExit,
    suppressWineDebugLogging:
      typeof src.suppressWineDebugLogging === 'boolean'
        ? src.suppressWineDebugLogging
        : DEFAULT_LAUNCHER_PERFORMANCE_SETTINGS.suppressWineDebugLogging,
  };
}

function getLauncherPerformanceSettings(/** @type {any} */ options = {}) {
  const filePath = getPerformanceSettingsFilePath(options);
  try {
    if (fs.existsSync(filePath)) {
      const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      return sanitizeLauncherPerformanceSettings(parsed);
    }
  } catch {}
  return { ...DEFAULT_LAUNCHER_PERFORMANCE_SETTINGS };
}

function saveLauncherPerformanceSettings(/** @type {any} */ settings = {}, /** @type {any} */ options = {}) {
  const filePath = getPerformanceSettingsFilePath(options);
  const current = getLauncherPerformanceSettings(options);
  const merged =
    settings && settings.reset === true
      ? { ...DEFAULT_LAUNCHER_PERFORMANCE_SETTINGS }
      : sanitizeLauncherPerformanceSettings({ ...current, ...(settings || {}) });
  try {
    atomicWriteFileSync(filePath, JSON.stringify(merged, null, 2));
  } catch {}
  const result = { ...merged };
  Object.defineProperties(result, {
    success: { value: true, enumerable: false },
    settings: { value: merged, enumerable: false },
  });
  return result;
}

function resolveEffectivePerformancePolicy(/** @type {any} */ launchConfig = {}, /** @type {any} */ options = {}) {
  const base = getLauncherPerformanceSettings(options);
  const cfg = launchConfig && typeof launchConfig === 'object' ? launchConfig : {};

  const inGameOverride =
    cfg.inGameLauncherBehavior &&
    cfg.inGameLauncherBehavior !== 'default' &&
    VALID_IN_GAME_BEHAVIORS.has(cfg.inGameLauncherBehavior)
      ? cfg.inGameLauncherBehavior
      : base.inGameLauncherBehavior;

  const normCfgStorefront =
    cfg.storefrontClientLifecycle && cfg.storefrontClientLifecycle !== 'default'
      ? normalizeStorefrontClientLifecycle(cfg.storefrontClientLifecycle)
      : 'default';

  const storefrontOverride = resolveEffectiveLifecyclePolicy(
    normCfgStorefront || 'default',
    base.storefrontClientLifecycle
  );

  return {
    ...base,
    inGameLauncherBehavior: inGameOverride,
    storefrontClientLifecycle: storefrontOverride,
  };
}

function isSafeToDeleteInstallPath(targetPath, /** @type {any} */ options = {}) {
  if (!targetPath || typeof targetPath !== 'string') {
    return false;
  }
  const mappedPath = options.customRoots
    ? toLocalFsPath(targetPath, options.customRoots)
    : targetPath;
  return uninstallSafety.isSafeToDeleteInstallPath(mappedPath, options);
}

function safeIsBottleSlug(slug) {
  const fn = /** @type {any} */ (uninstallSafety).isSafeBottleSlug;
  if (typeof fn === 'function') {
    return Boolean(fn(slug));
  }
  if (typeof slug !== 'string') return false;
  const trimmed = slug.trim();
  if (!trimmed || trimmed === '.' || trimmed === '..') return false;
  return !/[\\/\x00]/.test(trimmed) && !trimmed.includes('..');
}

function safeIsNumericAppId(appId) {
  const fn = /** @type {any} */ (uninstallSafety).isSafeNumericAppId;
  if (typeof fn === 'function') {
    return Boolean(fn(appId));
  }
  const clean = String(appId ?? '').trim();
  return /^\d{1,20}$/.test(clean);
}

async function browseLocalFiles(targetPath) {
  if (!targetPath || typeof targetPath !== 'string') {
    return { success: false, error: 'No target path provided.' };
  }
  const resolved = toLocalFsPath(targetPath);
  if (!fs.existsSync(resolved)) {
    return { success: false, error: `Path does not exist: ${targetPath}` };
  }

  try {
    const stat = fs.statSync(resolved);
    if (electron.shell) {
      if (stat.isFile() || resolved.endsWith('.app')) {
        electron.shell.showItemInFolder(resolved);
      } else {
        await electron.shell.openPath(resolved);
      }
    }
    return { success: true, path: resolved };
  } catch (/** @type {any} */ err) {
    return { success: false, error: err.message };
  }
}

async function selectExecutableDialog(defaultPath) {
  try {
    if (electron.dialog && typeof electron.dialog.showOpenDialog === 'function') {
      const win = getMainWindow();
      const res = await electron.dialog.showOpenDialog(win || undefined, {
        title: 'Select Game Executable',
        defaultPath: defaultPath || os.homedir(),
        properties: ['openFile', 'treatPackageAsDirectory'],
      });
      if (!res.canceled && Array.isArray(res.filePaths) && res.filePaths.length > 0) {
        return res.filePaths[0];
      }
    }
  } catch {}
  return null;
}

async function selectFolderDialog(defaultPath) {
  try {
    if (electron.dialog && typeof electron.dialog.showOpenDialog === 'function') {
      const win = getMainWindow();
      const res = await electron.dialog.showOpenDialog(win || undefined, {
        title: 'Select Installation Folder',
        defaultPath: defaultPath || os.homedir(),
        properties: ['openDirectory', 'createDirectory'],
      });
      if (!res.canceled && Array.isArray(res.filePaths) && res.filePaths.length > 0) {
        return res.filePaths[0];
      }
    }
  } catch {}
  return null;
}

module.exports = {
  // Lazy module getters
  getElectron,
  getStoreSync,
  getXboxStorefrontModules,
  diagLog,
  getDiagnosticLogPath,

  // Hooks & configuration
  setMainWindowGetter,
  getMainWindow,
  setSessionLifecycleHook,
  getSessionLifecycleHook,
  setEpicAuthRecoveryHook,
  getEpicAuthRecoveryHook,
  setXboxStoreLicenseRecoveryHook,
  getXboxStoreLicenseRecoveryHook,
  setOfflineVaultLifecycleHooks,
  getOfflineVaultLifecycleHooks,
  setUserDataDir,
  getConfiguredUserDataDir,
  getUserDataDir,
  isTestEnvironment,
  resolveIsolatedHomedirAndUserData,

  // Event emitters & pending sessions
  onSessionUpdated,
  onDownloadUpdated,
  queuePendingCompletedSession,
  drainPendingCompletedSessions,
  emitSessionUpdated,
  emitDownloadUpdated,

  // Shared maps & sets
  MAX_DISCOVERY_CACHE_ENTRIES,
  MAX_LEGENDARY_CACHE_DIRS,
  MAX_STEAM_LAUNCH_SPEC_CACHE_ENTRIES,
  MAX_BOUNDED_URI_AND_QUARANTINE_ENTRIES,
  STEAM_APPINFO_BUF_IDLE_TTL_MS,
  activeSessions,
  inFlightPostSessionByGame,
  pendingBottleLaunches,
  inFlightPostSessionByBottle,
  pendingEphemeralShutdowns,
  pendingStorefrontLaunches,
  downloadQueueMap,
  downloadControllers,
  downloadSpeedTrackers,
  pausedByInGameTaskIds,
  inFlightPostSessionPromises,
  sessionListeners,
  downloadListeners,
  openedExternalUris,
  quarantineClearedBinaries,
  macCodesignValidCache,
  gogFirstPartySyncSignatureCache,
  recentDisplaySanitizeCache,
  pendingWineRegSyncByPrefix,
  executableDiscoveryCache,
  steamAppInfoCache,
  steamResolvedLaunchSpecCache,
  legendaryMetadataDirCache,
  legendaryAssetsFileCache,
  legendaryAliasesFileCache,
  moltenVkHudDeadlockCache,
  installInfoSizeCache,
  steamPlatformSupportCache,
  xboxCompatibilityProbeCache,

  // Scan fingerprint state & cache management
  registerExternalCacheInvalidator,
  getLastProductionScanCache,
  setLastProductionScanCache,
  getLastSyncedEpicFingerprint,
  setLastSyncedEpicFingerprint,
  getLastSyncedGogFingerprint,
  setLastSyncedGogFingerprint,
  setBoundedMapEntry,
  addBoundedSetEntry,
  evictExecutableDiscoveryCacheForPath,
  trimLauncherEngineMemory,
  invalidateScanCaches,

  // Path, URI, Locale, Quarantine & CLI resolution
  toLocalFsPath,
  resolveWindowsNodeShebangSpawn,
  openExternalUri,
  resolveHostLocaleInfo,
  clearMacQuarantineAsync,
  findBundledOrSystemCliBinary,
  findLegendaryBinary,
  findGogdlBinary,

  // Managed install sentinel & persistence
  ONE_LAUNCHER_MANAGED_SENTINEL,
  writeManagedInstallSentinel,
  readManagedInstallSentinel,
  hasManagedInstallSentinel,
  loadManagedInstalledGames,
  saveManagedInstalledGames,
  upsertManagedInstallRecord,

  // Launch configs & performance settings
  LAUNCH_PROFILE_KEYS,
  normalizeStorefrontClientLifecycle,
  resolvePlatformLaunchConfig,
  getGameLaunchConfigs,
  getGameLaunchConfig,
  saveGameLaunchConfig,
  DEFAULT_LAUNCHER_PERFORMANCE_SETTINGS,
  getLauncherPerformanceSettings,
  saveLauncherPerformanceSettings,
  resolveEffectivePerformancePolicy,

  // Uninstall safety & dialogs
  isSafeToDeleteInstallPath,
  safeIsBottleSlug,
  safeIsNumericAppId,
  browseLocalFiles,
  selectExecutableDialog,
  selectFolderDialog,
};
