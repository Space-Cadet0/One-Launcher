// @ts-check
'use strict';

/**
 * One Launcher — Universal Dual-OS Launcher Engine Facade
 *
 * Backward-compatible public API lazily delegating to cohesive domain subsystems under
 * `electron/launcher/*.cjs` across macOS (`darwin` Native + CrossOver/Preview/GPTK/Wine)
 * and Windows (`win32` Native + GamingServices AUMID + Clientless MSIXVC).
 *
 * All exports use configurable, enumerable getter/setter descriptors so:
 * - Subsystems load lazily on first property access (fast startup & isolated test loads).
 * - `vi.spyOn(launcherEngine, '<method>')` and `mockRestore()` work seamlessly.
 * - Re-requiring `launcherEngine.cjs` after evicting `require.cache` resolves freshly loaded
 *   subsystems cleanly under `Module._load` test hooks.
 */

const LOADED_FACADE_PLATFORM = process.platform;

/** @type {Map<string, Record<string, any>>} */
const subsystemCache = new Map();

/** @type {Map<string, any>} */
const propertyOverrides = new Map();

/**
 * Lazily require and memoize a domain subsystem for this facade instance.
 *
 * @param {string} modulePath
 * @returns {Record<string, any>}
 */
function loadSubsystem(modulePath) {
  let mod = subsystemCache.get(modulePath);
  if (!mod) {
    mod = /** @type {Record<string, any>} */ (require(modulePath));
    subsystemCache.set(modulePath, mod);
  }
  return mod;
}

/**
 * Bind lazy getter/setter delegates for all named exports of a subsystem.
 *
 * @param {Record<string, any>} target
 * @param {string} modulePath
 * @param {readonly string[]} exportNames
 */
function bindLazySubsystemExports(target, modulePath, exportNames) {
  for (const key of exportNames) {
    Object.defineProperty(target, key, {
      enumerable: true,
      configurable: true,
      get() {
        if (propertyOverrides.has(key)) {
          return propertyOverrides.get(key);
        }
        return loadSubsystem(modulePath)[key];
      },
      set(value) {
        propertyOverrides.set(key, value);
      },
    });
  }
}

/**
 * Bind a custom facade wrapper function with configurable/writable descriptor semantics.
 *
 * @param {Record<string, any>} target
 * @param {string} key
 * @param {(...args: any[]) => any} fn
 */
function bindCustomExport(target, key, fn) {
  Object.defineProperty(target, key, {
    enumerable: true,
    configurable: true,
    writable: true,
    value: fn,
  });
}

/** @type {Record<string, any>} */
const facade = {};

/** @type {ReadonlyArray<readonly [string, readonly string[]]>} */
const SUBSYSTEM_EXPORT_MANIFEST = [
  [
    './launcher/launchPolicyResolver.cjs',
    ['sanitizeLaunchMethod', 'resolveEffectiveLifecyclePolicy', 'resolveEffectiveLaunchPolicy'],
  ],
  [
    './launcher/processTreeUtils.cjs',
    [
      'isProcessAlive',
      'waitForProcessExit',
      'extractMatchedPidFromProcessOutput',
      'signalSubprocessTree',
      'execCliWithTreeTimeout',
    ],
  ],
  [
    './launcher/securityAndPathUtils.cjs',
    [
      'toHostFilesystemPath',
      'atomicWriteFileSync',
      'atomicWriteSecureFileSync',
      'isContainedWithinRoot',
      'isStoreDisconnectedTombstoned',
      'clearStoreDisconnectedTombstone',
      'purgeStoreHelperCredentials',
      'getImportedEpicInstalls',
      'recordImportedEpicInstall',
      'resolveHostWindowsKnownFolders',
      'clearCachedWindowsKnownFolders',
    ],
  ],
  [
    './launcher/wineAndCrossOverManager.cjs',
    [
      'readWinePrefixShellFolders',
      'resolveBottleSteamExe',
      'sandboxWinePrefixUserFolders',
      'sandboxWinePrefixUserFoldersAsync',
      'resolveXboxBridgeDllPath',
      'resolveBundledGameInputBridgeDllPath',
      'readVerifiedBridgeDllBuffer',
      'upsertWineUserRegKey',
      'applyStrictRosettaAvxEnv',
      'mergeWineDllOverrides',
      'prepareXboxBottleEnvironment',
    ],
  ],
  [
    './launcher/storefrontReadinessBarrier.cjs',
    [
      'doesProcessListHaveHostGogGalaxy',
      'isHostGogGalaxyRunning',
      'reapOrphanedGogOverlayProcesses',
      'isBottleWinExeRunning',
      'probeLocalTcpPort',
      'resolveGogCommunicationLogPath',
      'hasActiveGogAuthSessionInLog',
      'waitForGogCommunicationServiceReady',
      'waitForGogPostExitFlush',
      'waitForBottleEpicPortalReady',
      'extractTrackedPidFromSteamGameProcessLog',
    ],
  ],
  [
    './launcher/firstPartyRegistration.cjs',
    [
      'toWineWindowsPath',
      'fromWineWindowsPath',
      'escapeWineRegString',
      'upsertWineSystemRegKey',
      'deleteWineSystemRegKey',
      'computeDotNetUtcTicksBigInt',
      'syncEpicEoshInstalledItem',
      'removeEpicEoshInstalledItem',
    ],
  ],
  [
    './launcher/binaryAndManifestInspectors.cjs',
    [
      'MAX_PLAUSIBLE_GAME_INSTALL_BYTES',
      'sanitizeGameInstallSizeBytes',
      'decodeEpicJsonBlobInt',
      'parseByteCountOrFormattedSize',
      'inspectWindowsExecutableHeader',
      'resolveEffectiveGameExecutableCapabilities',
      'inspectMacMachOHeader',
      'parseSteamLibraryFoldersVdf',
      'parseSteamAcf',
      'parseSteamContentLogForApp',
      'parseStorageRequirementBytes',
      'parseEpicManifestBuffer',
      'parseGamingRootFile',
      'computeAppxPublisherId',
      'computePackageFamilyName',
      'deriveDefaultScidFromTitleId',
      'inspectMicrosoftGameConfig',
      'inspectAppxManifest',
    ],
  ],
  [
    './launcher/cloudSaveEngine.cjs',
    [
      'GOG_GALAXY_LAUNCHER_CLIENT_ID',
      'normalizePosixUtf8Locale',
      'purgeOsMetadataAndCountRealFilesSync',
      'resolveGogCloudSaveLocations',
      'resolveEpicSavePathTemplate',
      'resolveXboxSaveLocations',
      'waitForXboxCloudSaveFlush',
      'syncXboxCloudSaves',
      'pruneGogCloudConfigsMap',
      'pruneCloudSaveStateForGame',
      'buildCloudSyncTelemetryPayload',
    ],
  ],
  [
    './launcher/engineStateRegistry.cjs',
    [
      'diagLog',
      'getDiagnosticLogPath',
      'setMainWindowGetter',
      'setSessionLifecycleHook',
      'setEpicAuthRecoveryHook',
      'setXboxStoreLicenseRecoveryHook',
      'setOfflineVaultLifecycleHooks',
      'setUserDataDir',
      'getUserDataDir',
      'isTestEnvironment',
      'onSessionUpdated',
      'onDownloadUpdated',
      'queuePendingCompletedSession',
      'drainPendingCompletedSessions',
      'openedExternalUris',
      'steamAppInfoCache',
      'evictExecutableDiscoveryCacheForPath',
      'trimLauncherEngineMemory',
      'invalidateScanCaches',
      'toLocalFsPath',
      'openExternalUri',
      'findLegendaryBinary',
      'findGogdlBinary',
      'loadManagedInstalledGames',
      'saveManagedInstalledGames',
      'upsertManagedInstallRecord',
      'resolvePlatformLaunchConfig',
      'getGameLaunchConfigs',
      'getGameLaunchConfig',
      'saveGameLaunchConfig',
      'DEFAULT_LAUNCHER_PERFORMANCE_SETTINGS',
      'getLauncherPerformanceSettings',
      'saveLauncherPerformanceSettings',
      'resolveEffectivePerformancePolicy',
      'isSafeToDeleteInstallPath',
      'browseLocalFiles',
      'selectExecutableDialog',
      'selectFolderDialog',
    ],
  ],
  [
    './launcher/diskAndVolumeInspector.cjs',
    ['getDefaultInstallDir', 'getDiskSpace', 'getDirectorySizeFast'],
  ],
  [
    './launcher/windowsXboxAppxAndMsixvcOrchestrator.cjs',
    [
      'parseGamingServicesRegistryRoots',
      'collectXboxLibraryRoots',
      'collectXboxScanDirectories',
      'inspectInstalledXboxGameDir',
      'isWindowsXboxAppRunning',
      'activateWindowsXboxApplication',
      'resolveXboxClientBinaryPath',
    ],
  ],
  [
    './launcher/macNativeInstallerAndCodesign.cjs',
    [
      'scoreExecutableCandidate',
      'ensureMacExecutablePermissions',
      'ensureMacAppCodeSignatureValid',
      'ensureMacAppCodeSignatureValidAsync',
      'doesGogInstallUseGalaxySdk',
      'resolveMacAppBundleBinary',
      'flattenGogNestedInstallDir',
      'findPrimaryExecutable',
      'getIndexedSteamAppInfoVdf',
      'getIndexedSteamAppInfoVdfAsync',
      'parseSteamBinaryVdfSlice',
      'readSteamAppInfoParsedEntry',
      'resolveSteamAppInfoLaunchSpec',
      'resolveDefaultEngineLaunchArguments',
      'discoverSteamLocations',
      'removeSteamAppFromLibraryFoldersVdf',
      'cleanupCrossOverSteamShortcuts',
      'isValidBottleDirectory',
      'hasValidInitializedBottles',
      'listAllInitializedBottlePaths',
      'resolveTargetBottleForFirstPartySync',
      'extractRunnerVersionInfo',
      'detectBundledD3DMetalVersions',
      'compareRunnerVersions',
      'detectCompatibilityLayers',
      'extractRunnerPreviewDate',
      'extractCandidateLinksFromText',
      'checkCompatibilityLayerUpdates',
      'updateCompatibilityLayer',
      'cancelCompatibilityLayerOperation',
      'selectRunnerArchiveDialog',
      'onCompatibilityRunnerProgress',
      'mountAndExtractDmgSafe',
      'installCompatibilityLayer',
      'splitDyldInsertLibraries',
      'resolveWineLayerMoltenVkPath',
      'doesWineLayerHaveMoltenVkHudDeadlock',
      'ensureWineMetalPreloadDylib',
      'resolveWineserverBinary',
      'shutdownWinePrefix',
      'resolveBottleGogGalaxyExe',
      'resolveBottleEpicLauncherExe',
      'applyCrossOverPerGameSettings',
      'getHostMaxDisplayResolution',
      'disposeHostDisplayMetricsListener',
      'normalizeDosboxDisplayConfigs',
      'sanitizeWinePrefixDisplayConfigs',
      'ensureCompatibilityLayerReady',
    ],
  ],
  [
    './launcher/epicLegendaryAndEosCoordinator.cjs',
    [
      'syncEpicFirstPartyLauncher',
      'unregisterEpicFirstPartyLauncher',
      'isMockOrCorruptedToken',
      'isPoisonedStorefrontToken',
      'getLegendaryConfigDir',
      'ensureLegendaryConfigAndAuth',
      'collectLocalEpicMetadataAndSupport',
      'resolveEpicAppAndPlatforms',
      'resolveEpicLaunchAuthArguments',
      'resolveEpicClientBinaryPath',
    ],
  ],
  [
    './launcher/gogRegistryAndDirectInstaller.cjs',
    [
      'syncGogFirstPartyLauncher',
      'syncGogGameToGalaxy',
      'unregisterGogFirstPartyLauncher',
      'ensureGogdlAuthConfig',
      'ensureGogGalaxyBackgroundService',
      'resolveGogGalaxyClientBinaryPath',
      'resolveGogdlManifestDir',
      'clearStaleGogdlManifestCache',
      'formatGogV2EndpointChunkUrl',
      'resolveGogDepotSizesDirectHttp',
      'downloadGogV1Depot',
      'downloadGogV2Depot',
    ],
  ],
  ['./launcher/installedGameScanner.cjs', ['scanAllInstalledGames', 'scanAllInstalledGamesAsync']],
  [
    './launcher/downloadQueueCoordinator.cjs',
    [
      'computeSmoothedDownloadSpeed',
      'getDownloadQueue',
      'updateDownloadTask',
      'startSteamInstallMonitor',
      'startXboxInstallMonitor',
      'ensureWindowsSteamInBottle',
      'getGameInstallInfo',
      'installGame',
      'pauseDownload',
      'resumeDownload',
      'cancelDownload',
      'clearDownloadQueue',
      'getPausedByInGameTaskIds',
      'pauseActiveDownloadsForInGame',
      'resumeDownloadsPausedByInGame',
      'gracefulShutdownDownloads',
    ],
  ],
  [
    './launcher/sessionAndProcessSupervisor.cjs',
    [
      'createGuardedSessionPoller',
      'runApprovedLaunchHookCommand',
      'disposeSessionResources',
      'restoreHostDisplayConfiguration',
      'parseLaunchArguments',
      'buildStorefrontLaunchUri',
      'hasActivePostSessionWork',
      'waitForActivePostSessionWork',
      'syncGogCloudSaves',
      'syncEpicCloudSaves',
      'waitForSteamColdStartupCloudReady',
      'waitForSteamCloudSyncCompletion',
      'launchGame',
      'stopGame',
      'getRunningGames',
      'toggleSessionFullscreen',
      'stageBottleDisplayScalerBinaries',
      'computeMacPrimaryDisplaySafeInsetTop',
      'shouldWrapBottleSessionWithDisplayLauncher',
      'resolveSteamClientBinaryPath',
      'detectInstalledStorefrontClients',
      'resolveSteamClientLaunchCommand',
      'shutdownEphemeralStorefrontClient',
      'syncSessionPlaytimeToStorefront',
      'verifyGameFiles',
      'uninstallGame',
      'shutdownLauncherEngine',
    ],
  ],
  [
    './launcher/environmentHealthProber.cjs',
    [
      'getSetupWizardState',
      'saveSetupWizardState',
      'probeClientLoginStates',
      'probeEnvironmentHealth',
      'invalidateProberRunnerUpdatesCache',
      'parseSteamLoginUsersVdfDetails',
      'parseEpicGameUserSettingsIni',
    ],
  ],
  [
    './launcher/environmentProvisioner.cjs',
    [
      'ALLOWED_INSTALLER_HOSTS',
      'CODEWEAVERS_SPARKLE_PUBLIC_ED_KEY',
      'validateInstallerUrl',
      'hasEmbeddedPeAuthenticodeCertificate',
      'verifyFileSha256Async',
      'verifySparkleEd25519SignatureAsync',
      'verifyAppleSignedFramework',
      'verifyMacAppDeveloperSignature',
      'verifyMacPkgSignature',
      'verifyWindowsInstallerSignature',
      'assertRunnerSafeToReplace',
      'atomicReplaceMacAppBundle',
      'onEnvironmentSetupProgress',
      'emitEnvironmentSetupProgress',
      'ensureRosetta2InBackground',
      'installRunnerDirect',
      'runEnvironmentSetupTasks',
      'cancelEnvironmentSetup',
      'startGuidedClientLogin',
      'cancelGuidedClientLogin',
    ],
  ],
];

for (const [modulePath, exportNames] of SUBSYSTEM_EXPORT_MANIFEST) {
  bindLazySubsystemExports(facade, modulePath, exportNames);
}

/**
 * Facade wrapper binding `_boundPlatform` to the platform at facade load time.
 *
 * @param {string} sourceDir
 * @param {string} backupBaseDir
 * @param {number | Record<string, any> | undefined} maxBytes
 * @param {Record<string, any>} [quotaOptions]
 */
function createCloudSaveRollingBackup(sourceDir, backupBaseDir, maxBytes, quotaOptions = {}) {
  const rawCreateCloudSaveRollingBackup =
    loadSubsystem('./launcher/cloudSaveEngine.cjs').createCloudSaveRollingBackup;
  if (maxBytes && typeof maxBytes === 'object') {
    return rawCreateCloudSaveRollingBackup(sourceDir, backupBaseDir, undefined, {
      _boundPlatform: LOADED_FACADE_PLATFORM,
      ...maxBytes,
    });
  }
  return rawCreateCloudSaveRollingBackup(sourceDir, backupBaseDir, maxBytes, {
    _boundPlatform: LOADED_FACADE_PLATFORM,
    ...(quotaOptions && typeof quotaOptions === 'object' ? quotaOptions : {}),
  });
}

/**
 * Async facade wrapper binding `_boundPlatform` to the platform at facade load time.
 *
 * @param {string} sourceDir
 * @param {string} backupBaseDir
 * @param {number | Record<string, any> | undefined} maxBytes
 * @param {Record<string, any>} [quotaOptions]
 */
function createCloudSaveRollingBackupAsync(sourceDir, backupBaseDir, maxBytes, quotaOptions = {}) {
  const rawCreateCloudSaveRollingBackupAsync =
    loadSubsystem('./launcher/cloudSaveEngine.cjs').createCloudSaveRollingBackupAsync;
  if (maxBytes && typeof maxBytes === 'object') {
    return rawCreateCloudSaveRollingBackupAsync(sourceDir, backupBaseDir, undefined, {
      _boundPlatform: LOADED_FACADE_PLATFORM,
      ...maxBytes,
    });
  }
  return rawCreateCloudSaveRollingBackupAsync(sourceDir, backupBaseDir, maxBytes, {
    _boundPlatform: LOADED_FACADE_PLATFORM,
    ...(quotaOptions && typeof quotaOptions === 'object' ? quotaOptions : {}),
  });
}

bindCustomExport(facade, 'createCloudSaveRollingBackup', createCloudSaveRollingBackup);
bindCustomExport(facade, 'createCloudSaveRollingBackupAsync', createCloudSaveRollingBackupAsync);

module.exports = facade;
