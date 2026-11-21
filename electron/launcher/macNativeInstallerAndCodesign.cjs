// @ts-check
'use strict';

/**
 * Facade module preserving 100% of `macNativeInstallerAndCodesign.cjs` exports, backed by
 * 7 cohesive domain sub-modules under `electron/launcher/mac/`.
 */

const executableAndCodesign = require('./mac/executableAndCodesignManager.cjs');
const compatLayerRegistry = require('./mac/compatLayerRegistryAndDetection.cjs');
const steamAppInfo = require('./mac/steamAppInfoAndShortcuts.cjs');
const compatLayerUpdater = require('./mac/compatLayerUpdaterAndInstaller.cjs');
const wineRuntimeHud = require('./mac/wineRuntimeEnvAndHud.cjs');
const bottleDisplayConfig = require('./mac/bottleDisplayConfigAndMetrics.cjs');
const crossoverTuner = require('./mac/crossoverBackendAndBottleTuner.cjs');

/**
 * Host platform flag (`darwin` gating invariant `F13-01`).
 */
const IS_DARWIN_HOST = process.platform === 'darwin';

// Configure external community Wine manager discovery specs strictly inside this allowlisted
// facade (`tests/highballAuditAndWin32BottlePerf.test.tsx:703-712`).
compatLayerRegistry.configureExternalWineManagerSpecs({
  engineDirSpecs: [
    ['Library/Application Support/Sikarugir/Engines', 'Open-Source Wine (Sikarugir)', 340],
    ['Library/Application Support/Kegworks/Engines', 'Open-Source Wine (Kegworks)', 330],
  ],
  managerMatchers: [
    {
      managerName: 'Sikarugir',
      tokens: [
        'Library/Application Support/Kegworks/Engines',
        'Open-Source Wine (Kegworks)',
      ],
    },
  ],
});

module.exports = {
  IS_DARWIN_HOST,

  // 1. Executable discovery, scoring, GOG flattening & macOS codesign
  EXCLUDED_EXECUTABLE_PATTERNS: executableAndCodesign.EXCLUDED_EXECUTABLE_PATTERNS,
  isExcludedExecutable: executableAndCodesign.isExcludedExecutable,
  hasShebangHeader: executableAndCodesign.hasShebangHeader,
  scoreExecutableCandidate: executableAndCodesign.scoreExecutableCandidate,
  ensureMacExecutablePermissions: executableAndCodesign.ensureMacExecutablePermissions,
  resolveTargetMacAppBundlePath: executableAndCodesign.resolveTargetMacAppBundlePath,
  readMacBundleIdFromInfoPlist: executableAndCodesign.readMacBundleIdFromInfoPlist,
  ensureMacAppCodeSignatureValid: executableAndCodesign.ensureMacAppCodeSignatureValid,
  ensureMacAppCodeSignatureValidAsync: executableAndCodesign.ensureMacAppCodeSignatureValidAsync,
  doesGogInstallUseGalaxySdk: executableAndCodesign.doesGogInstallUseGalaxySdk,
  resolveMacAppBundleBinary: executableAndCodesign.resolveMacAppBundleBinary,
  flattenGogNestedInstallDir: executableAndCodesign.flattenGogNestedInstallDir,
  findPrimaryExecutable: executableAndCodesign.findPrimaryExecutable,
  resolveDefaultEngineLaunchArguments: executableAndCodesign.resolveDefaultEngineLaunchArguments,
  extractSiblingLauncherStem: executableAndCodesign.extractSiblingLauncherStem,
  resolveSiblingLauncherStub: executableAndCodesign.resolveSiblingLauncherStub,

  // 2. Steam binary appinfo.vdf & CrossOver shortcuts
  getIndexedSteamAppInfoVdf: steamAppInfo.getIndexedSteamAppInfoVdf,
  getIndexedSteamAppInfoVdfAsync: steamAppInfo.getIndexedSteamAppInfoVdfAsync,
  parseSteamBinaryVdfSlice: steamAppInfo.parseSteamBinaryVdfSlice,
  readSteamAppInfoParsedEntry: steamAppInfo.readSteamAppInfoParsedEntry,
  findEnclosingSteamAppInfoVdf: steamAppInfo.findEnclosingSteamAppInfoVdf,
  resolveSteamAppInfoLaunchSpec: steamAppInfo.resolveSteamAppInfoLaunchSpec,
  discoverSteamLocations: steamAppInfo.discoverSteamLocations,
  normalizeComparableTitle: steamAppInfo.normalizeComparableTitle,
  removeSteamAppFromLibraryFoldersVdf: steamAppInfo.removeSteamAppFromLibraryFoldersVdf,
  cleanupCrossOverSteamShortcuts: steamAppInfo.cleanupCrossOverSteamShortcuts,

  // 3. Bottle metadata, arch guards, runner receipts & compatibility layer detection
  extractBottleRootFromPath: compatLayerRegistry.extractBottleRootFromPath,
  extractRunnerPreviewDate: compatLayerRegistry.extractRunnerPreviewDate,
  resolveBottleGogGalaxyExe: compatLayerRegistry.resolveBottleGogGalaxyExe,
  resolveBottleEpicLauncherExe: compatLayerRegistry.resolveBottleEpicLauncherExe,
  isValidBottleDirectory: compatLayerRegistry.isValidBottleDirectory,
  inspectBottleConfMetadata: compatLayerRegistry.inspectBottleConfMetadata,
  assertRunnerBottleArchCompatible: compatLayerRegistry.assertRunnerBottleArchCompatible,
  hasValidInitializedBottles: compatLayerRegistry.hasValidInitializedBottles,
  listBottleSubdirectories: compatLayerRegistry.listBottleSubdirectories,
  listAllInitializedBottlePaths: compatLayerRegistry.listAllInitializedBottlePaths,
  resolveTargetBottleForFirstPartySync: compatLayerRegistry.resolveTargetBottleForFirstPartySync,
  extractRunnerVersionInfo: compatLayerRegistry.extractRunnerVersionInfo,
  readRunnerInstallReceipts: compatLayerRegistry.readRunnerInstallReceipts,
  recordRunnerInstallReceipt: compatLayerRegistry.recordRunnerInstallReceipt,
  parsePlistStringValues: compatLayerRegistry.parsePlistStringValues,
  inspectCrossOverBundleMarkers: compatLayerRegistry.inspectCrossOverBundleMarkers,
  detectBundledD3DMetalVersions: compatLayerRegistry.detectBundledD3DMetalVersions,
  compareRunnerVersions: compatLayerRegistry.compareRunnerVersions,
  detectCompatibilityLayers: compatLayerRegistry.detectCompatibilityLayers,
  invalidateCompatLayersCache: compatLayerRegistry.invalidateCompatLayersCache,

  // 4. Compatibility layer updater, Sparkle/preview portal & DMG installer
  extractCandidateLinksFromText: compatLayerUpdater.extractCandidateLinksFromText,
  checkCompatibilityLayerUpdates: compatLayerUpdater.checkCompatibilityLayerUpdates,
  updateCompatibilityLayer: compatLayerUpdater.updateCompatibilityLayer,
  cancelCompatibilityLayerOperation: compatLayerUpdater.cancelCompatibilityLayerOperation,
  selectRunnerArchiveDialog: compatLayerUpdater.selectRunnerArchiveDialog,
  onCompatibilityRunnerProgress: compatLayerUpdater.onCompatibilityRunnerProgress,
  mountAndExtractDmgSafe: compatLayerUpdater.mountAndExtractDmgSafe,
  installCompatibilityLayer: compatLayerUpdater.installCompatibilityLayer,
  isPreviewSparkleFeedUrl: compatLayerUpdater.isPreviewSparkleFeedUrl,
  isPreviewSparkleEnclosureValid: compatLayerUpdater.isPreviewSparkleEnclosureValid,
  setCachedAuthenticatedPreviewUrl: compatLayerUpdater.setCachedAuthenticatedPreviewUrl,
  clearCachedAuthenticatedPreviewUrl: compatLayerUpdater.clearCachedAuthenticatedPreviewUrl,
  getCachedAuthenticatedPreviewUrl: compatLayerUpdater.getCachedAuthenticatedPreviewUrl,
  cacheAuthenticatedPreviewUrl: compatLayerUpdater.cacheAuthenticatedPreviewUrl,

  // 5. Wine/SIP runtime env, unified Performance HUD & wineserver control
  splitDyldInsertLibraries: wineRuntimeHud.splitDyldInsertLibraries,
  resolveWineLayerMoltenVkPath: wineRuntimeHud.resolveWineLayerMoltenVkPath,
  doesWineLayerHaveMoltenVkHudDeadlock: wineRuntimeHud.doesWineLayerHaveMoltenVkHudDeadlock,
  ensureWineMetalPreloadDylib: wineRuntimeHud.ensureWineMetalPreloadDylib,
  stripKeysFromCxEnv: wineRuntimeHud.stripKeysFromCxEnv,
  applyUnifiedPerformanceHudEnv: wineRuntimeHud.applyUnifiedPerformanceHudEnv,
  mergeCxEnvVariables: wineRuntimeHud.mergeCxEnvVariables,
  deriveCrossOverRootFromBinaryPath: wineRuntimeHud.deriveCrossOverRootFromBinaryPath,
  alignWineMsyncWithLiveBottle: wineRuntimeHud.alignWineMsyncWithLiveBottle,
  doesWineLoaderAllowDyldInsert: wineRuntimeHud.doesWineLoaderAllowDyldInsert,
  resolveSipSafeWineBinaryAndPreloadEnv: wineRuntimeHud.resolveSipSafeWineBinaryAndPreloadEnv,
  prepareCrossOverWineSpawnEnv: wineRuntimeHud.prepareCrossOverWineSpawnEnv,
  prepareAlignedBottleWineCommand: wineRuntimeHud.prepareAlignedBottleWineCommand,
  prepareAlignedAuxBottleWineCommand: wineRuntimeHud.prepareAlignedAuxBottleWineCommand,
  resolveWineserverBinary: wineRuntimeHud.resolveWineserverBinary,
  shutdownWinePrefix: wineRuntimeHud.shutdownWinePrefix,

  // 6. Display metrics, DOSBox normalization & Wine prefix display config sanitization
  buildDisplaySanitizeCacheKey: bottleDisplayConfig.buildDisplaySanitizeCacheKey,
  getHostMaxDisplayResolution: bottleDisplayConfig.getHostMaxDisplayResolution,
  disposeHostDisplayMetricsListener: bottleDisplayConfig.disposeHostDisplayMetricsListener,
  normalizeDosboxDisplayConfigs: bottleDisplayConfig.normalizeDosboxDisplayConfigs,
  sanitizeWinePrefixDisplayConfigs: bottleDisplayConfig.sanitizeWinePrefixDisplayConfigs,

  // 7. CrossOver backend routing, per-game bottle tuning & compatibility layer provisioning
  removeWineRegNamedValue: crossoverTuner.removeWineRegNamedValue,
  mergeSemicolonConfigClauses: crossoverTuner.mergeSemicolonConfigClauses,
  detectCrossOverBackendLayerSupport: crossoverTuner.detectCrossOverBackendLayerSupport,
  resolveEffectiveCrossOverGraphicsBackend: crossoverTuner.resolveEffectiveCrossOverGraphicsBackend,
  cleanNonApfsAppleDoubleTwins: crossoverTuner.cleanNonApfsAppleDoubleTwins,
  applyCrossOverPerGameSettings: crossoverTuner.applyCrossOverPerGameSettings,
  provisionCrossOverBottleViaCxbottle: crossoverTuner.provisionCrossOverBottleViaCxbottle,
  predictTargetBottlePrefix: crossoverTuner.predictTargetBottlePrefix,
  ensureCompatibilityLayerReady: crossoverTuner.ensureCompatibilityLayerReady,
};
