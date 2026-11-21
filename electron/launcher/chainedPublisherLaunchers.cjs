// @ts-check
'use strict';

const publisherCatalogData = require('./publishers/publisherCatalogData.cjs');
const wineRegistryParserAndMutator = require('./publishers/wineRegistryParserAndMutator.cjs');
const publisherClientDiscoveryAndProbes = require('./publishers/publisherClientDiscoveryAndProbes.cjs');
const publisherGameScanner = require('./publishers/publisherGameScanner.cjs');
const chainedLaunchSpecBuilder = require('./publishers/chainedLaunchSpecBuilder.cjs');

/**
 * Facade module preserving 100% of `chainedPublisherLaunchers.cjs` exports plus non-blocking
 * async discovery/probe counterparts, backed by 5 cohesive sub-modules under
 * `electron/launcher/publishers/`:
 * 1. `publisherCatalogData.cjs` — descriptors, Battle.net TACT table, strict ID sanitizers
 * 2. `wineRegistryParserAndMutator.cjs` — Wine `.reg` parsing (`hex(2):`/`hex(7):`), reparse xattrs, atomic mutations
 * 3. `publisherClientDiscoveryAndProbes.cjs` — sync & async host/bottle discovery and local session probes
 * 4. `publisherGameScanner.cjs` — unified bottle/host publisher game scanning & staging dir resolution
 * 5. `chainedLaunchSpecBuilder.cjs` — strictly validated `buildChainedLauncherLaunchSpec`
 */
module.exports = {
  // Catalog data, bottle naming & strict external ID sanitization
  CHAINED_PUBLISHER_ECOSYSTEMS: publisherCatalogData.CHAINED_PUBLISHER_ECOSYSTEMS,
  PUBLISHER_LAUNCHER_SPECS: publisherCatalogData.PUBLISHER_LAUNCHER_SPECS,
  normalizeChainedHandoffId: publisherCatalogData.normalizeChainedHandoffId,
  resolveDefaultChainedBottleName: publisherCatalogData.resolveDefaultChainedBottleName,
  normalizeBattleNetLaunchProductCode: publisherCatalogData.normalizeBattleNetLaunchProductCode,
  isExcludedPublisherOrRedistExe: publisherCatalogData.isExcludedPublisherOrRedistExe,
  sanitizeExternalLaunchId: publisherCatalogData.sanitizeExternalLaunchId,
  isValidExternalLaunchId: publisherCatalogData.isValidExternalLaunchId,

  // Wine registry parsing (`hex(2):`/`hex(7):`), reparse resolution & atomic mutations
  parseWineRegistrySections: wineRegistryParserAndMutator.parseWineRegistrySections,
  decodeWineRegUtf16LeHex: wineRegistryParserAndMutator.decodeWineRegUtf16LeHex,
  resolveWineReparseTargetReadOnly: wineRegistryParserAndMutator.resolveWineReparseTargetReadOnly,
  resolveWineReparseTargetReadOnlyAsync:
    wineRegistryParserAndMutator.resolveWineReparseTargetReadOnlyAsync,
  listBottleUserDirectories: wineRegistryParserAndMutator.listBottleUserDirectories,
  listBottleUserDirectoriesAsync: wineRegistryParserAndMutator.listBottleUserDirectoriesAsync,
  sanitizeChainedPublisherAutostartInBottleRegs:
    wineRegistryParserAndMutator.sanitizeChainedPublisherAutostartInBottleRegs,
  sanitizeEaBottleAutostartInUserReg:
    wineRegistryParserAndMutator.sanitizeEaBottleAutostartInUserReg,
  stripPublisherUninstallKeysFromSystemReg:
    wineRegistryParserAndMutator.stripPublisherUninstallKeysFromSystemReg,

  // Client discovery & non-secret local session probes (sync + async)
  hasUbisoftLocalSessionInDir: publisherClientDiscoveryAndProbes.hasUbisoftLocalSessionInDir,
  hasEaLocalSessionInDir: publisherClientDiscoveryAndProbes.hasEaLocalSessionInDir,
  hasBattleNetLocalSessionInConfigFile:
    publisherClientDiscoveryAndProbes.hasBattleNetLocalSessionInConfigFile,
  hasRockstarLocalSessionInDir: publisherClientDiscoveryAndProbes.hasRockstarLocalSessionInDir,
  hasRockstarLocalSessionInDirs: publisherClientDiscoveryAndProbes.hasRockstarLocalSessionInDirs,
  hasRiotLocalSessionInFile: publisherClientDiscoveryAndProbes.hasRiotLocalSessionInFile,
  detectMacNativePublisherBundle: publisherClientDiscoveryAndProbes.detectMacNativePublisherBundle,
  detectMacNativePublisherBundleAsync:
    publisherClientDiscoveryAndProbes.detectMacNativePublisherBundleAsync,
  discoverBottlePublisherLauncher:
    publisherClientDiscoveryAndProbes.discoverBottlePublisherLauncher,
  discoverBottlePublisherLauncherAsync:
    publisherClientDiscoveryAndProbes.discoverBottlePublisherLauncherAsync,
  discoverHostPublisherLauncher: publisherClientDiscoveryAndProbes.discoverHostPublisherLauncher,
  discoverHostPublisherLauncherAsync:
    publisherClientDiscoveryAndProbes.discoverHostPublisherLauncherAsync,

  // Publisher game scanning, manifest parsers & staging roots
  parseBattleNetProductDbBuffer: publisherGameScanner.parseBattleNetProductDbBuffer,
  extractBattleNetProductId: publisherGameScanner.extractBattleNetProductId,
  parseEaInstallerDataXml: publisherGameScanner.parseEaInstallerDataXml,
  readEaConfiguredLibraryRoots: publisherGameScanner.readEaConfiguredLibraryRoots,
  resolvePublisherStagingDirs: publisherGameScanner.resolvePublisherStagingDirs,
  scanBottlePublisherInstalledGames: publisherGameScanner.scanBottlePublisherInstalledGames,
  scanHostPublisherInstalledGames: publisherGameScanner.scanHostPublisherInstalledGames,

  // Strictly validated chained launcher launch spec builder
  buildChainedLauncherLaunchSpec: chainedLaunchSpecBuilder.buildChainedLauncherLaunchSpec,
};
