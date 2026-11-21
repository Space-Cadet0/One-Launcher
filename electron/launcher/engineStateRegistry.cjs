// @ts-check
'use strict';

/**
 * Facade module preserving 100% of `engineStateRegistry.cjs` exports and direct
 * mutable singleton references, backed by 5 cohesive sub-modules under
 * `electron/launcher/state/`.
 *
 * CRITICAL TEST CONTRACT (`tests/nineDimensionAuditRegression.test.ts:1359-1409`):
 * `node:fs`, `node:child_process`, and `process.platform` MUST be captured directly
 * in this facade at module load-time and injected into every sub-module factory so
 * tests that patch `Module._load` and evict ONLY `engineStateRegistry.cjs` &
 * `launcherEngine.cjs` from `require.cache` work identically.
 */

const fs = require('node:fs');
const childProcess = require('node:child_process');
const loadTimePlatform = process.platform;

const {
  diagLog,
  getDiagnosticLogPath,
  setDiagnosticUserDataGetter,
} = require('../utils/diagnosticLogger.cjs');
const {
  toHostFilesystemPath,
  setSecurityUserDataDirResolver,
  atomicWriteFileSync,
  atomicWriteSecureFileSync,
  readJsonFileWithBackupSync,
  approveLaunchCommands,
  computeLaunchEnvApprovalFingerprint,
} = require('./securityAndPathUtils.cjs');
const uninstallSafety = require('./uninstallSafety.cjs');
const {
  invalidateWindowsRegistryDiscoveryCache,
} = require('../utils/windowsRegistryDiscovery.cjs');
const {
  parseByteCountOrFormattedSize,
} = require('./binaryAndManifestInspectors.cjs');

const { createStateJsonStore } = require('./state/stateJsonStore.cjs');
const { createRuntimeCachesAndLocks } = require('./state/runtimeCachesAndLocks.cjs');
const { createLifecycleHooksAndEvents } = require('./state/lifecycleHooksAndEvents.cjs');
const { createHostEnvAndCliResolver } = require('./state/hostEnvAndCliResolver.cjs');
const { createInstallAndLaunchConfigStore } = require('./state/installAndLaunchConfigStore.cjs');

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
let storeSyncLoaded = false;

/**
 * Lazy-load `../storeSync.cjs` on first access instead of paying its cold-boot parse cost
 * during `engineStateRegistry.cjs` initialization.
 */
function getStoreSync() {
  if (!storeSyncLoaded) {
    storeSyncLoaded = true;
    try {
      storeSync = require('../storeSync.cjs');
    } catch {
      storeSync = null;
    }
  }
  return storeSync;
}

function getElectron() {
  return electron;
}

// 1. Bounded JSON state store with `.bak` recovery on missing primary (`ENOENT`) & `0o600` secure writes
const stateJsonStore = createStateJsonStore({
  fs,
  toHostFilesystemPath,
  atomicWriteFileSync,
  atomicWriteSecureFileSync,
  readJsonFileWithBackupSync,
});

// Forward-wired callbacks so factories stay cleanly decoupled with zero circular requires
/** @type {() => { trimMemory: Function | null, shutdown: Function | null }} */
let getOfflineVaultHooksRef = () => ({ trimMemory: null, shutdown: null });
/** @type {() => void} */
let clearHostEnvCachesRef = () => {};
/** @type {(rawPath: string, customRoots?: string[]) => string} */
let toLocalFsPathRef = (rawPath) => String(rawPath || '');
/** @type {() => any} */
let getMainWindowRef = () => null;

// 2. Shared mutable singletons, bounded runtime caches & active-download guards
const runtimeCaches = createRuntimeCachesAndLocks({
  invalidateWindowsRegistryDiscoveryCache,
  clearStateJsonCache: stateJsonStore.clearStateJsonCache,
  clearHostEnvCaches: () => clearHostEnvCachesRef(),
  getOfflineVaultLifecycleHooks: () => getOfflineVaultHooksRef(),
  getToLocalFsPath: (rawPath, customRoots) => toLocalFsPathRef(rawPath, customRoots),
});

// 3. Host environment, path/URI/locale/quarantine helpers, CLI binary discovery & dialogs
const hostEnv = createHostEnvAndCliResolver({
  fs,
  childProcess,
  platform: loadTimePlatform,
  launcherDir: __dirname,
  getElectron,
  getMainWindow: () => getMainWindowRef(),
  toHostFilesystemPath,
  uninstallSafety,
  openedExternalUris: runtimeCaches.openedExternalUris,
  quarantineClearedBinaries: runtimeCaches.quarantineClearedBinaries,
  addBoundedSetEntry: runtimeCaches.addBoundedSetEntry,
  MAX_BOUNDED_URI_AND_QUARANTINE_ENTRIES: runtimeCaches.MAX_BOUNDED_URI_AND_QUARANTINE_ENTRIES,
});

clearHostEnvCachesRef = hostEnv.clearHostEnvCaches;
toLocalFsPathRef = hostEnv.toLocalFsPath;

setDiagnosticUserDataGetter(() => hostEnv.getUserDataDir());
setSecurityUserDataDirResolver((/** @type {any} */ customDir) => hostEnv.getUserDataDir(customDir));

// 4. Lifecycle hooks, event emitters & `0o600` pending completed-session queue
const lifecycleEvents = createLifecycleHooksAndEvents({
  fs,
  getUserDataDir: hostEnv.getUserDataDir,
  atomicWriteSecureFileSync,
  readJsonFileWithBackupSync,
  sessionListeners: runtimeCaches.sessionListeners,
  downloadListeners: runtimeCaches.downloadListeners,
});

getMainWindowRef = lifecycleEvents.getMainWindow;
getOfflineVaultHooksRef = lifecycleEvents.getOfflineVaultLifecycleHooks;

// 5. Managed installs, `0o600` launch configs (gated DYLD approval) & performance settings
const configStore = createInstallAndLaunchConfigStore({
  fs,
  getUserDataDir: hostEnv.getUserDataDir,
  toLocalFsPath: hostEnv.toLocalFsPath,
  readCachedStateJsonSync: stateJsonStore.readCachedStateJsonSync,
  writeCachedStateJsonSync: stateJsonStore.writeCachedStateJsonSync,
  atomicWriteFileSync,
  invalidateScanCaches: runtimeCaches.invalidateScanCaches,
  parseByteCountOrFormattedSize,
  approveLaunchCommands,
  computeLaunchEnvApprovalFingerprint,
  diagLog,
});

module.exports = {
  // Lazy module getters
  getElectron,
  getStoreSync,
  getXboxStorefrontModules,
  diagLog,
  getDiagnosticLogPath,

  // Hooks & configuration
  setMainWindowGetter: lifecycleEvents.setMainWindowGetter,
  getMainWindow: lifecycleEvents.getMainWindow,
  setSessionLifecycleHook: lifecycleEvents.setSessionLifecycleHook,
  getSessionLifecycleHook: lifecycleEvents.getSessionLifecycleHook,
  setEpicAuthRecoveryHook: lifecycleEvents.setEpicAuthRecoveryHook,
  getEpicAuthRecoveryHook: lifecycleEvents.getEpicAuthRecoveryHook,
  setXboxStoreLicenseRecoveryHook: lifecycleEvents.setXboxStoreLicenseRecoveryHook,
  getXboxStoreLicenseRecoveryHook: lifecycleEvents.getXboxStoreLicenseRecoveryHook,
  setOfflineVaultLifecycleHooks: lifecycleEvents.setOfflineVaultLifecycleHooks,
  getOfflineVaultLifecycleHooks: lifecycleEvents.getOfflineVaultLifecycleHooks,
  setUserDataDir: hostEnv.setUserDataDir,
  getConfiguredUserDataDir: hostEnv.getConfiguredUserDataDir,
  getUserDataDir: hostEnv.getUserDataDir,
  isTestEnvironment: hostEnv.isTestEnvironment,
  resolveIsolatedHomedirAndUserData: hostEnv.resolveIsolatedHomedirAndUserData,

  // Event emitters & pending sessions
  onSessionUpdated: lifecycleEvents.onSessionUpdated,
  onDownloadUpdated: lifecycleEvents.onDownloadUpdated,
  queuePendingCompletedSession: lifecycleEvents.queuePendingCompletedSession,
  drainPendingCompletedSessions: lifecycleEvents.drainPendingCompletedSessions,
  emitSessionUpdated: lifecycleEvents.emitSessionUpdated,
  emitDownloadUpdated: lifecycleEvents.emitDownloadUpdated,

  // Shared mutable maps & sets (direct singleton references preserved!)
  MAX_DISCOVERY_CACHE_ENTRIES: runtimeCaches.MAX_DISCOVERY_CACHE_ENTRIES,
  MAX_LEGENDARY_CACHE_DIRS: runtimeCaches.MAX_LEGENDARY_CACHE_DIRS,
  MAX_STEAM_LAUNCH_SPEC_CACHE_ENTRIES: runtimeCaches.MAX_STEAM_LAUNCH_SPEC_CACHE_ENTRIES,
  MAX_BOUNDED_URI_AND_QUARANTINE_ENTRIES: runtimeCaches.MAX_BOUNDED_URI_AND_QUARANTINE_ENTRIES,
  STEAM_APPINFO_BUF_IDLE_TTL_MS: runtimeCaches.STEAM_APPINFO_BUF_IDLE_TTL_MS,
  activeSessions: runtimeCaches.activeSessions,
  inFlightLaunchesByGameId: runtimeCaches.inFlightLaunchesByGameId,
  inFlightLaunchAbortControllers: runtimeCaches.inFlightLaunchAbortControllers,
  inFlightPostSessionByGame: runtimeCaches.inFlightPostSessionByGame,
  pendingBottleLaunches: runtimeCaches.pendingBottleLaunches,
  inFlightPostSessionByBottle: runtimeCaches.inFlightPostSessionByBottle,
  pendingEphemeralShutdowns: runtimeCaches.pendingEphemeralShutdowns,
  pendingStorefrontLaunches: runtimeCaches.pendingStorefrontLaunches,
  downloadQueueMap: runtimeCaches.downloadQueueMap,
  downloadControllers: runtimeCaches.downloadControllers,
  downloadSpeedTrackers: runtimeCaches.downloadSpeedTrackers,
  pausedByInGameTaskIds: runtimeCaches.pausedByInGameTaskIds,
  inFlightPostSessionPromises: runtimeCaches.inFlightPostSessionPromises,
  sessionListeners: runtimeCaches.sessionListeners,
  downloadListeners: runtimeCaches.downloadListeners,
  openedExternalUris: runtimeCaches.openedExternalUris,
  quarantineClearedBinaries: runtimeCaches.quarantineClearedBinaries,
  macCodesignValidCache: runtimeCaches.macCodesignValidCache,
  gogFirstPartySyncSignatureCache: runtimeCaches.gogFirstPartySyncSignatureCache,
  recentDisplaySanitizeCache: runtimeCaches.recentDisplaySanitizeCache,
  pendingWineRegSyncByPrefix: runtimeCaches.pendingWineRegSyncByPrefix,
  executableDiscoveryCache: runtimeCaches.executableDiscoveryCache,
  steamAppInfoCache: runtimeCaches.steamAppInfoCache,
  steamResolvedLaunchSpecCache: runtimeCaches.steamResolvedLaunchSpecCache,
  legendaryMetadataDirCache: runtimeCaches.legendaryMetadataDirCache,
  legendaryAssetsFileCache: runtimeCaches.legendaryAssetsFileCache,
  legendaryAliasesFileCache: runtimeCaches.legendaryAliasesFileCache,
  moltenVkHudDeadlockCache: runtimeCaches.moltenVkHudDeadlockCache,
  installInfoSizeCache: runtimeCaches.installInfoSizeCache,
  steamPlatformSupportCache: runtimeCaches.steamPlatformSupportCache,
  xboxCompatibilityProbeCache: runtimeCaches.xboxCompatibilityProbeCache,

  // Scan fingerprint state & cache management
  registerExternalCacheInvalidator: runtimeCaches.registerExternalCacheInvalidator,
  getLastProductionScanCache: runtimeCaches.getLastProductionScanCache,
  setLastProductionScanCache: runtimeCaches.setLastProductionScanCache,
  getLastSyncedEpicFingerprint: runtimeCaches.getLastSyncedEpicFingerprint,
  setLastSyncedEpicFingerprint: runtimeCaches.setLastSyncedEpicFingerprint,
  getLastSyncedGogFingerprint: runtimeCaches.getLastSyncedGogFingerprint,
  setLastSyncedGogFingerprint: runtimeCaches.setLastSyncedGogFingerprint,
  setBoundedMapEntry: runtimeCaches.setBoundedMapEntry,
  addBoundedSetEntry: runtimeCaches.addBoundedSetEntry,
  evictExecutableDiscoveryCacheForPath: runtimeCaches.evictExecutableDiscoveryCacheForPath,
  trimLauncherEngineMemory: runtimeCaches.trimLauncherEngineMemory,
  invalidateScanCaches: runtimeCaches.invalidateScanCaches,

  // Path, URI, Locale, Quarantine & CLI resolution
  toLocalFsPath: hostEnv.toLocalFsPath,
  resolveWindowsNodeShebangSpawn: hostEnv.resolveWindowsNodeShebangSpawn,
  openExternalUri: hostEnv.openExternalUri,
  resolveHostLocaleInfo: hostEnv.resolveHostLocaleInfo,
  isNetworkOnlineForLaunch: hostEnv.isNetworkOnlineForLaunch,
  clearMacQuarantineAsync: hostEnv.clearMacQuarantineAsync,
  findBundledOrSystemCliBinary: hostEnv.findBundledOrSystemCliBinary,
  findLegendaryBinary: hostEnv.findLegendaryBinary,
  findGogdlBinary: hostEnv.findGogdlBinary,

  // Managed install sentinel & persistence
  ONE_LAUNCHER_MANAGED_SENTINEL: configStore.ONE_LAUNCHER_MANAGED_SENTINEL,
  writeManagedInstallSentinel: configStore.writeManagedInstallSentinel,
  readManagedInstallSentinel: configStore.readManagedInstallSentinel,
  hasManagedInstallSentinel: configStore.hasManagedInstallSentinel,
  loadManagedInstalledGames: configStore.loadManagedInstalledGames,
  saveManagedInstalledGames: configStore.saveManagedInstalledGames,
  upsertManagedInstallRecord: configStore.upsertManagedInstallRecord,

  // Launch configs & performance settings
  LAUNCH_PROFILE_KEYS: configStore.LAUNCH_PROFILE_KEYS,
  migrateLegacyHudConfig: configStore.migrateLegacyHudConfig,
  resolveEffectivePerformanceHud: configStore.resolveEffectivePerformanceHud,
  normalizeStorefrontClientLifecycle: configStore.normalizeStorefrontClientLifecycle,
  resolvePlatformLaunchConfig: configStore.resolvePlatformLaunchConfig,
  getGameLaunchConfigs: configStore.getGameLaunchConfigs,
  getGameLaunchConfig: configStore.getGameLaunchConfig,
  saveGameLaunchConfig: configStore.saveGameLaunchConfig,
  DEFAULT_LAUNCHER_PERFORMANCE_SETTINGS: configStore.DEFAULT_LAUNCHER_PERFORMANCE_SETTINGS,
  getLauncherPerformanceSettings: configStore.getLauncherPerformanceSettings,
  saveLauncherPerformanceSettings: configStore.saveLauncherPerformanceSettings,
  resolveEffectivePerformancePolicy: configStore.resolveEffectivePerformancePolicy,

  // Uninstall safety & dialogs
  isSafeToDeleteInstallPath: hostEnv.isSafeToDeleteInstallPath,
  safeRemoveInstallDirectoryAsync: hostEnv.safeRemoveInstallDirectoryAsync,
  safeIsBottleSlug: hostEnv.safeIsBottleSlug,
  safeIsNumericAppId: hostEnv.safeIsNumericAppId,
  browseLocalFiles: hostEnv.browseLocalFiles,
  selectExecutableDialog: hostEnv.selectExecutableDialog,
  selectFolderDialog: hostEnv.selectFolderDialog,
  isPathUnderActiveDownload: runtimeCaches.isPathUnderActiveDownload,
  isPathOrGameUnderIncompleteDownload: runtimeCaches.isPathOrGameUnderIncompleteDownload,
};
