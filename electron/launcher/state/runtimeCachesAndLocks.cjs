// @ts-check
'use strict';

const path = require('node:path');

const MAX_DISCOVERY_CACHE_ENTRIES = 500;
const MAX_LEGENDARY_CACHE_DIRS = 16;
const MAX_STEAM_LAUNCH_SPEC_CACHE_ENTRIES = 2000;
const MAX_BOUNDED_URI_AND_QUARANTINE_ENTRIES = 1000;
const MAX_AUX_RUNTIME_CACHE_ENTRIES = 500;
const STEAM_APPINFO_BUF_IDLE_TTL_MS = 5000;

/**
 * Create a native `Map` instance whose `.set()` method enforces an upper bound
 * while preserving `instanceof Map === true` and all native `Map` semantics.
 *
 * @template K, V
 * @param {number} maxEntries
 * @returns {Map<K, V>}
 */
function createBoundedMap(maxEntries) {
  /** @type {Map<K, V>} */
  const map = new Map();
  const origSet = map.set.bind(map);
  map.set = (key, value) => {
    if (!map.has(key) && map.size >= maxEntries) {
      const oldestKey = map.keys().next().value;
      if (oldestKey !== undefined) {
        map.delete(oldestKey);
      }
    }
    return origSet(key, value);
  };
  return map;
}

/**
 * @template K, V
 * @param {Map<K, V>} map
 * @param {K} key
 * @param {V} value
 * @param {number} [maxEntries]
 */
function setBoundedMapEntry(map, key, value, maxEntries = MAX_DISCOVERY_CACHE_ENTRIES) {
  if (!map.has(key) && map.size >= maxEntries) {
    const oldestKey = map.keys().next().value;
    if (oldestKey !== undefined) {
      map.delete(oldestKey);
    }
  }
  map.set(key, value);
}

/**
 * @template T
 * @param {Set<T>} setObj
 * @param {T} value
 * @param {number} [maxEntries]
 */
function addBoundedSetEntry(setObj, value, maxEntries = MAX_BOUNDED_URI_AND_QUARANTINE_ENTRIES) {
  if (!setObj.has(value) && setObj.size >= maxEntries) {
    const oldestVal = setObj.values().next().value;
    if (oldestVal !== undefined) {
      setObj.delete(oldestVal);
    }
  }
  setObj.add(value);
}

/**
 * @template K, V
 * @param {Map<K, V>} mapObj
 * @param {number} maxEntries
 */
function trimMapToMaxSize(mapObj, maxEntries) {
  while (mapObj.size > maxEntries) {
    const oldestKey = mapObj.keys().next().value;
    if (oldestKey === undefined) break;
    mapObj.delete(oldestKey);
  }
}

/**
 * @template T
 * @param {Set<T>} setObj
 * @param {number} maxEntries
 */
function trimSetToMaxSize(setObj, maxEntries) {
  while (setObj.size > maxEntries) {
    const oldestVal = setObj.values().next().value;
    if (oldestVal === undefined) break;
    setObj.delete(oldestVal);
  }
}

/**
 * @typedef {Object} RuntimeCachesDeps
 * @property {() => void} invalidateWindowsRegistryDiscoveryCache
 * @property {() => void} clearStateJsonCache
 * @property {() => void} clearHostEnvCaches
 * @property {() => { trimMemory: Function | null, shutdown: Function | null }} getOfflineVaultLifecycleHooks
 * @property {(rawPath: string, customRoots?: string[]) => string} getToLocalFsPath
 */

/**
 * @param {RuntimeCachesDeps} deps
 */
function createRuntimeCachesAndLocks(deps) {
  const {
    invalidateWindowsRegistryDiscoveryCache,
    clearStateJsonCache,
    clearHostEnvCaches,
    getOfflineVaultLifecycleHooks,
    getToLocalFsPath,
  } = deps;

  // Active game sessions keyed by gameId
  const activeSessions = new Map();

  // Concurrency & post-session race barriers
  const inFlightLaunchesByGameId = new Map();
  const inFlightLaunchAbortControllers = new Map();
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

  // Bounded runtime & discovery caches (direct mutable Map/Set references preserved)
  const macCodesignValidCache = createBoundedMap(MAX_AUX_RUNTIME_CACHE_ENTRIES);
  const gogFirstPartySyncSignatureCache = createBoundedMap(MAX_AUX_RUNTIME_CACHE_ENTRIES);
  const recentDisplaySanitizeCache = createBoundedMap(MAX_AUX_RUNTIME_CACHE_ENTRIES);
  const pendingWineRegSyncByPrefix = new Map();
  const executableDiscoveryCache = createBoundedMap(MAX_DISCOVERY_CACHE_ENTRIES);
  const steamAppInfoCache = createBoundedMap(64);
  const steamResolvedLaunchSpecCache = createBoundedMap(MAX_STEAM_LAUNCH_SPEC_CACHE_ENTRIES);
  const legendaryMetadataDirCache = createBoundedMap(MAX_LEGENDARY_CACHE_DIRS);
  const legendaryAssetsFileCache = createBoundedMap(MAX_LEGENDARY_CACHE_DIRS);
  const legendaryAliasesFileCache = createBoundedMap(MAX_LEGENDARY_CACHE_DIRS);
  const moltenVkHudDeadlockCache = createBoundedMap(128);
  const installInfoSizeCache = createBoundedMap(MAX_DISCOVERY_CACHE_ENTRIES);
  const steamPlatformSupportCache = createBoundedMap(MAX_STEAM_LAUNCH_SPEC_CACHE_ENTRIES);
  const xboxCompatibilityProbeCache = createBoundedMap(MAX_DISCOVERY_CACHE_ENTRIES);
  const quarantineClearedBinaries = new Set();

  /** @type {string[]} */
  const openedExternalUris = [];

  /** @type {{ timestamp: number, result: any }} */
  let lastProductionScanCache = { timestamp: 0, result: null };
  let lastSyncedEpicFingerprint = '';
  let lastSyncedGogFingerprint = '';

  /** @type {Set<Function>} */
  const externalCacheInvalidators = new Set();

  /**
   * @param {Function} fn
   */
  function registerExternalCacheInvalidator(fn) {
    if (typeof fn === 'function') {
      externalCacheInvalidators.add(fn);
    }
  }

  function getLastProductionScanCache() {
    return lastProductionScanCache;
  }

  /**
   * @param {{ timestamp: number, result: any } | null | undefined} nextVal
   */
  function setLastProductionScanCache(nextVal) {
    lastProductionScanCache = nextVal || { timestamp: 0, result: null };
  }

  function getLastSyncedEpicFingerprint() {
    return lastSyncedEpicFingerprint;
  }

  /**
   * @param {unknown} fp
   */
  function setLastSyncedEpicFingerprint(fp) {
    lastSyncedEpicFingerprint = String(fp || '');
  }

  function getLastSyncedGogFingerprint() {
    return lastSyncedGogFingerprint;
  }

  /**
   * @param {unknown} fp
   */
  function setLastSyncedGogFingerprint(fp) {
    lastSyncedGogFingerprint = String(fp || '');
  }

  /**
   * @param {string} targetPath
   */
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
    clearStateJsonCache();
    clearHostEnvCaches();
    invalidateWindowsRegistryDiscoveryCache();
    for (const inv of externalCacheInvalidators) {
      try {
        inv();
      } catch {}
    }
    lastProductionScanCache = { timestamp: 0, result: null };
    const vaultHooks = getOfflineVaultLifecycleHooks();
    if (vaultHooks && typeof vaultHooks.trimMemory === 'function') {
      try {
        vaultHooks.trimMemory();
      } catch {}
    }
    if (typeof global.gc === 'function') {
      try {
        global.gc();
      } catch {}
    }
    return { success: true };
  }

  /**
   * @param {Record<string, any>} [options]
   */
  function invalidateScanCaches(options = {}) {
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
    clearStateJsonCache();
    clearHostEnvCaches();
    invalidateWindowsRegistryDiscoveryCache();
    for (const inv of externalCacheInvalidators) {
      try {
        inv(options);
      } catch {}
    }
    lastProductionScanCache = { timestamp: 0, result: null };
    lastSyncedEpicFingerprint = '';
    lastSyncedGogFingerprint = '';
  }

  /**
   * Normalize a local or Wine filesystem path for case-insensitive prefix matching.
   * @param {string} rawPath
   * @returns {string}
   */
  function normalizeComparableInstallPath(rawPath) {
    if (!rawPath || typeof rawPath !== 'string') return '';
    const local = getToLocalFsPath(rawPath) || rawPath;
    const trimmed = String(local).trim();
    if (!trimmed) return '';
    const resolved = path.resolve(trimmed).replace(/\\/g, '/').replace(/\/+$/, '');
    return resolved.toLowerCase();
  }

  /**
   * Returns true if `candidatePath` is equal to or nested inside any task's `finalInstallPath`
   * that is actively writing to disk (`downloading`, `extracting`, `verifying`).
   *
   * @param {string} candidatePath
   * @returns {boolean}
   */
  function isPathUnderActiveDownload(candidatePath) {
    if (downloadQueueMap.size === 0) return false;
    const normCand = normalizeComparableInstallPath(candidatePath);
    if (!normCand) return false;

    for (const [, task] of downloadQueueMap.entries()) {
      if (!task || task.isSimulatedOrManual) continue;
      if (
        task.status !== 'downloading' &&
        task.status !== 'extracting' &&
        task.status !== 'verifying'
      ) {
        continue;
      }
      const normTarget = normalizeComparableInstallPath(task.finalInstallPath);
      if (!normTarget) continue;
      if (normCand === normTarget || normCand.startsWith(`${normTarget}/`)) {
        return true;
      }
    }
    return false;
  }

  /**
   * Returns true if `candidatePath` or `(platformId, platformGameId)` belongs to an in-flight
   * or paused download (`queued`, `downloading`, `extracting`, `verifying`, `paused`).
   *
   * @param {string} [candidatePath]
   * @param {string} [platformId]
   * @param {string} [platformGameId]
   * @returns {boolean}
   */
  function isPathOrGameUnderIncompleteDownload(candidatePath, platformId, platformGameId) {
    if (downloadQueueMap.size === 0) return false;
    const normCand = candidatePath ? normalizeComparableInstallPath(candidatePath) : '';
    const normPlat = platformId ? String(platformId).trim().toLowerCase() : '';
    const normGameId = platformGameId
      ? String(platformGameId)
          .trim()
          .replace(/^(gog|steam|epic|xbox)-/i, '')
          .toLowerCase()
      : '';

    for (const [, task] of downloadQueueMap.entries()) {
      if (!task || task.isSimulatedOrManual) continue;
      if (
        task.status !== 'queued' &&
        task.status !== 'downloading' &&
        task.status !== 'extracting' &&
        task.status !== 'verifying' &&
        task.status !== 'paused'
      ) {
        continue;
      }
      if (normCand) {
        const normTarget = normalizeComparableInstallPath(task.finalInstallPath);
        if (normTarget && (normCand === normTarget || normCand.startsWith(`${normTarget}/`))) {
          return true;
        }
      }
      if (normPlat && normGameId && String(task.platformId || '').toLowerCase() === normPlat) {
        const taskCleanId = String(task.platformGameId || '')
          .trim()
          .replace(/^(gog|steam|epic|xbox)-/i, '')
          .toLowerCase();
        if (taskCleanId && taskCleanId === normGameId) {
          return true;
        }
      }
    }
    return false;
  }

  return {
    MAX_DISCOVERY_CACHE_ENTRIES,
    MAX_LEGENDARY_CACHE_DIRS,
    MAX_STEAM_LAUNCH_SPEC_CACHE_ENTRIES,
    MAX_BOUNDED_URI_AND_QUARANTINE_ENTRIES,
    STEAM_APPINFO_BUF_IDLE_TTL_MS,
    activeSessions,
    inFlightLaunchesByGameId,
    inFlightLaunchAbortControllers,
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
    registerExternalCacheInvalidator,
    getLastProductionScanCache,
    setLastProductionScanCache,
    getLastSyncedEpicFingerprint,
    setLastSyncedEpicFingerprint,
    getLastSyncedGogFingerprint,
    setLastSyncedGogFingerprint,
    setBoundedMapEntry,
    addBoundedSetEntry,
    trimMapToMaxSize,
    trimSetToMaxSize,
    evictExecutableDiscoveryCacheForPath,
    trimLauncherEngineMemory,
    invalidateScanCaches,
    normalizeComparableInstallPath,
    isPathUnderActiveDownload,
    isPathOrGameUnderIncompleteDownload,
  };
}

module.exports = {
  MAX_DISCOVERY_CACHE_ENTRIES,
  MAX_LEGENDARY_CACHE_DIRS,
  MAX_STEAM_LAUNCH_SPEC_CACHE_ENTRIES,
  MAX_BOUNDED_URI_AND_QUARANTINE_ENTRIES,
  STEAM_APPINFO_BUF_IDLE_TTL_MS,
  setBoundedMapEntry,
  addBoundedSetEntry,
  trimMapToMaxSize,
  trimSetToMaxSize,
  createRuntimeCachesAndLocks,
};
