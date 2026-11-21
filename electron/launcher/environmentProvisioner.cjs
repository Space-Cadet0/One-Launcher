// @ts-check
'use strict';

const {
  ALLOWED_INSTALLER_HOSTS,
  CODEWEAVERS_SPARKLE_PUBLIC_ED_KEY,
  validateInstallerUrl,
  resolveCodeWeaversRunnerSpec,
  onEnvironmentSetupProgress,
  emitEnvironmentSetupProgress,
} = require('./provisioner/installerNetworkAndGuardrails.cjs');
const {
  hasEmbeddedPeAuthenticodeCertificate,
  verifyFileSha256Async,
  verifySparkleEd25519SignatureAsync,
  verifyAppleSignedFramework,
  verifyMacAppDeveloperSignature,
  verifyMacPkgSignature,
  verifyWindowsInstallerSignature,
} = require('./provisioner/artifactSignatureVerifier.cjs');
const {
  registerExternalRunnerManagerDetector,
  assertRunnerSafeToReplace,
  atomicReplaceMacAppBundle,
} = require('./provisioner/macAppBundleInstaller.cjs');
const {
  resolveGogGalaxyInstallerCandidates,
  resolveGogGalaxyInstallerUrl,
  downloadGogGalaxyInstallerToFile,
  isAllowedCodeWeaversAuthNavigationUrl,
  isAllowedCodeWeaversDownloadUrl,
  parseNumericPreviewDate,
  extractPreviewFilenameVersionHint,
  classifyCrossOverPreviewArchiveBranch,
  discoverCrossOverPreviewBranchUrls,
  resolvePreviewBundleVersion,
  selectPreferredCrossOverPreviewDownloadUrl,
  captureCodeWeaversPreviewDownload,
} = require('./provisioner/gogAndPreviewResolvers.cjs');
const {
  registerExternalRunnerDetectors,
  isBenignWindowsInstallerExitCode,
  ensureRosetta2InBackground,
  installRunnerDirect,
  ensureChainedPublisherLauncherInstalled,
} = require('./provisioner/runnerAndBottleProvisioner.cjs');
const {
  runEnvironmentSetupTasks,
  cancelEnvironmentSetup,
  closeForegroundClientGracefully,
  startGuidedClientLogin,
  cancelGuidedClientLogin,
} = require('./provisioner/setupOrchestratorAndGuidedLogin.cjs');

/**
 * Check whether an installed runner `.app` path belongs to a third-party external launcher manager.
 * Kept directly inside `electron/launcher/environmentProvisioner.cjs` to preserve the strict
 * GPL clean-room discovery allowlist invariant.
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
 * Check whether an existing compatibility layer descriptor belongs to an external runner manager.
 *
 * @param {any} existingLayer
 * @returns {string | null}
 */
function isExternalRunnerLayer(existingLayer) {
  return (
    detectExternalRunnerManagerName(existingLayer?.appPath) ||
    detectExternalRunnerManagerName(existingLayer?.binaryPath) ||
    (/\(Heroic|Whisky|Sikarugir|Kegworks|Mythic\)/i.test(String(existingLayer?.name || ''))
      ? 'External Manager'
      : null)
  );
}

registerExternalRunnerManagerDetector(detectExternalRunnerManagerName);
registerExternalRunnerDetectors({
  detectExternalRunnerManagerName,
  isExternalRunnerLayer,
});

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
  resolveCodeWeaversRunnerSpec,
  parseNumericPreviewDate,
  classifyCrossOverPreviewArchiveBranch,
  discoverCrossOverPreviewBranchUrls,
  isAllowedCodeWeaversAuthNavigationUrl,
  isAllowedCodeWeaversDownloadUrl,
  extractPreviewFilenameVersionHint,
  resolvePreviewBundleVersion,
  selectPreferredCrossOverPreviewDownloadUrl,
  captureCodeWeaversPreviewDownload,
  installRunnerDirect,
  runEnvironmentSetupTasks,
  cancelEnvironmentSetup,
  closeForegroundClientGracefully,
  startGuidedClientLogin,
  cancelGuidedClientLogin,
  ensureChainedPublisherLauncherInstalled,
};
