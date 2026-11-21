// @ts-check
'use strict';

/**
 * Facade re-exporting all PE/Mach-O binary header, Steam/Epic manifest, Xbox GDK/Appx,
 * kernel anti-cheat, and executable capability inspectors from cohesive sub-modules
 * under `electron/launcher/inspectors/`.
 *
 * Preserves 100% of existing `module.exports`.
 */

const {
  derivePeGraphicsCapabilities,
  inspectWindowsExecutableHeader,
  inspectPeCapabilities,
  inspectPeExportForwarders,
  hasMalformedBackslashExportForwarder,
  isCompatibleX86OrX64PeHeader,
  inspectMacMachOHeader,
} = require('./inspectors/peAndMachOInspector.cjs');

const {
  MAX_PLAUSIBLE_GAME_INSTALL_BYTES,
  sanitizeGameInstallSizeBytes,
  decodeEpicJsonBlobInt,
  parseByteCountOrFormattedSize,
  parseStorageRequirementBytes,
  parseSteamLibraryFoldersVdf,
  parseSteamAcf,
  integrateSteamRateSamples,
  parseSteamContentLogForApp,
  parseEpicManifestBuffer,
} = require('./inspectors/manifestParsers.cjs');

const {
  resolveCaseInsensitiveRelFile,
  parseGamingRootFile,
  parseLauncherSettingsCfg,
  resolveParadoxLauncherSettings,
  detectKernelAntiCheatMarkersInDir,
  computeAppxPublisherId,
  computePackageFamilyName,
  deriveDefaultScidFromTitleId,
  inspectMicrosoftGameConfig,
  inspectAppxManifest,
  isXboxNonGameUtilityIdentity,
} = require('./inspectors/xboxAndAntiCheatInspectors.cjs');

const {
  detectUe5IoStoreContainer,
  resolveEffectiveGameExecutableCapabilities,
  selectPreferredGogPlayTask,
} = require('./inspectors/executableCapabilities.cjs');

module.exports = {
  MAX_PLAUSIBLE_GAME_INSTALL_BYTES,
  sanitizeGameInstallSizeBytes,
  decodeEpicJsonBlobInt,
  parseByteCountOrFormattedSize,
  inspectWindowsExecutableHeader,
  inspectPeCapabilities,
  inspectPeExportForwarders,
  hasMalformedBackslashExportForwarder,
  parseLauncherSettingsCfg,
  detectKernelAntiCheatMarkersInDir,
  resolveParadoxLauncherSettings,
  detectUe5IoStoreContainer,
  derivePeGraphicsCapabilities,
  resolveEffectiveGameExecutableCapabilities,
  selectPreferredGogPlayTask,
  isCompatibleX86OrX64PeHeader,
  resolveCaseInsensitiveRelFile,
  inspectMacMachOHeader,
  parseSteamLibraryFoldersVdf,
  parseSteamAcf,
  integrateSteamRateSamples,
  parseSteamContentLogForApp,
  parseStorageRequirementBytes,
  parseEpicManifestBuffer,
  parseGamingRootFile,
  computeAppxPublisherId,
  computePackageFamilyName,
  deriveDefaultScidFromTitleId,
  inspectMicrosoftGameConfig,
  inspectAppxManifest,
  isXboxNonGameUtilityIdentity,
};
