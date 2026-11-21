// @ts-check
'use strict';

const { isSafeBottleSlug, isSafeNumericAppId } = require('./uninstallSafety.cjs');
const pathContainmentAndFs = require('./security/pathContainmentAndFs.cjs');
const urlAndSsrfGuards = require('./security/urlAndSsrfGuards.cjs');
const ipcSenderAndOriginGuards = require('./security/ipcSenderAndOriginGuards.cjs');
const launchCommandApprovalLedger = require('./security/launchCommandApprovalLedger.cjs');
const windowsHostDiscovery = require('./security/windowsHostDiscovery.cjs');

/**
 * Facade module preserving 100% of existing `securityAndPathUtils.cjs` exports
 * backed by 5 cohesive sub-modules under `electron/launcher/security/`.
 */
module.exports = {
  // Path containment, atomic secure I/O & Windows owner ACLs
  toHostFilesystemPath: pathContainmentAndFs.toHostFilesystemPath,
  setSecurityUserDataDirResolver: pathContainmentAndFs.setSecurityUserDataDirResolver,
  resolveEffectiveUserDataDir: pathContainmentAndFs.resolveEffectiveUserDataDir,
  warmWindowsUserSidAsync: pathContainmentAndFs.warmWindowsUserSidAsync,
  resolveCurrentWindowsPrincipalSpec: pathContainmentAndFs.resolveCurrentWindowsPrincipalSpec,
  applyWindowsOwnerAclAsync: pathContainmentAndFs.applyWindowsOwnerAclAsync,
  atomicWriteFileSync: pathContainmentAndFs.atomicWriteFileSync,
  atomicWriteSecureFileSync: pathContainmentAndFs.atomicWriteSecureFileSync,
  readJsonFileWithBackupSync: pathContainmentAndFs.readJsonFileWithBackupSync,
  isContainedWithinRoot: pathContainmentAndFs.isContainedWithinRoot,

  // URL host/port allowlist, SSRF/DNS-rebinding guards, safe response streaming & canonical UA
  getCanonicalChromeUserAgent: urlAndSsrfGuards.getCanonicalChromeUserAgent,
  isAllowedHttpsHost: urlAndSsrfGuards.isAllowedHttpsHost,
  isPrivateOrLoopbackIp: urlAndSsrfGuards.isPrivateOrLoopbackIp,
  assertSafePublicHttpsUrlSyntax: urlAndSsrfGuards.assertSafePublicHttpsUrlSyntax,
  assertSafePublicHttpsUrl: urlAndSsrfGuards.assertSafePublicHttpsUrl,
  clearPublicDnsSafetyCache: urlAndSsrfGuards.clearPublicDnsSafetyCache,
  readSafeResponseBuffer: urlAndSsrfGuards.readSafeResponseBuffer,
  safePublicHttpsFetch: urlAndSsrfGuards.safePublicHttpsFetch,

  // Renderer origin, file:// normalization & IPC sender frame enforcement
  resolveTrustedDevStartUrl: ipcSenderAndOriginGuards.resolveTrustedDevStartUrl,
  isTrustedAppRendererUrl: ipcSenderAndOriginGuards.isTrustedAppRendererUrl,
  isTrustedIpcSenderEvent: ipcSenderAndOriginGuards.isTrustedIpcSenderEvent,
  assertTrustedIpcSender: ipcSenderAndOriginGuards.assertTrustedIpcSender,
  wrapIpcMainWithSenderCheck: ipcSenderAndOriginGuards.wrapIpcMainWithSenderCheck,

  // Launch env sanitization, approval ledger, logout tombstones & Epic imports
  DANGEROUS_LAUNCH_ENV_KEYS: launchCommandApprovalLedger.DANGEROUS_LAUNCH_ENV_KEYS,
  LAUNCH_ENV_MAP_FIELDS: launchCommandApprovalLedger.LAUNCH_ENV_MAP_FIELDS,
  LAUNCH_SHELL_OR_EXEC_FIELDS: launchCommandApprovalLedger.LAUNCH_SHELL_OR_EXEC_FIELDS,
  FORBIDDEN_RENDERER_IPC_KEYS: launchCommandApprovalLedger.FORBIDDEN_RENDERER_IPC_KEYS,
  ALLOWED_LAUNCHER_SETTINGS_KEYS: launchCommandApprovalLedger.ALLOWED_LAUNCHER_SETTINGS_KEYS,
  sanitizeLaunchEnvironmentMap: launchCommandApprovalLedger.sanitizeLaunchEnvironmentMap,
  sanitizeSpawnEnvironmentMap: launchCommandApprovalLedger.sanitizeSpawnEnvironmentMap,
  computeLaunchEnvApprovalFingerprint:
    launchCommandApprovalLedger.computeLaunchEnvApprovalFingerprint,
  buildSafeChildEnvironment: launchCommandApprovalLedger.buildSafeChildEnvironment,
  sanitizeLaunchConfigRecursive: launchCommandApprovalLedger.sanitizeLaunchConfigRecursive,
  sanitizeLauncherSettingsPayload: launchCommandApprovalLedger.sanitizeLauncherSettingsPayload,
  computeLaunchCommandFingerprint: launchCommandApprovalLedger.computeLaunchCommandFingerprint,
  collectLaunchCommandsRecursive: launchCommandApprovalLedger.collectLaunchCommandsRecursive,
  getApprovedLaunchCommandsFilePath:
    launchCommandApprovalLedger.getApprovedLaunchCommandsFilePath,
  isLaunchCommandApproved: launchCommandApprovalLedger.isLaunchCommandApproved,
  approveLaunchCommands: launchCommandApprovalLedger.approveLaunchCommands,
  revokeApprovedLaunchCommands: launchCommandApprovalLedger.revokeApprovedLaunchCommands,
  confirmAndApproveLaunchCommands: launchCommandApprovalLedger.confirmAndApproveLaunchCommands,
  getDisconnectedStoresFilePath: launchCommandApprovalLedger.getDisconnectedStoresFilePath,
  isStoreDisconnectedTombstoned: launchCommandApprovalLedger.isStoreDisconnectedTombstoned,
  clearStoreDisconnectedTombstone: launchCommandApprovalLedger.clearStoreDisconnectedTombstone,
  purgeStoreHelperCredentials: launchCommandApprovalLedger.purgeStoreHelperCredentials,
  getImportedEpicInstalls: launchCommandApprovalLedger.getImportedEpicInstalls,
  recordImportedEpicInstall: launchCommandApprovalLedger.recordImportedEpicInstall,

  // Windows local drives & Known Folders discovery
  discoverWindowsLocalDrivesAsync: windowsHostDiscovery.discoverWindowsLocalDrivesAsync,
  getCachedWindowsLocalDrives: windowsHostDiscovery.getCachedWindowsLocalDrives,
  getKnownWindowsLocalDrivesSync: windowsHostDiscovery.getKnownWindowsLocalDrivesSync,
  clearCachedWindowsLocalDrives: windowsHostDiscovery.clearCachedWindowsLocalDrives,
  resolveHostWindowsKnownFolders: windowsHostDiscovery.resolveHostWindowsKnownFolders,
  refreshHostWindowsKnownFoldersAsync: windowsHostDiscovery.refreshHostWindowsKnownFoldersAsync,
  clearCachedWindowsKnownFolders: windowsHostDiscovery.clearCachedWindowsKnownFolders,

  // Re-exported uninstall safety identifier validators
  isSafeBottleSlug,
  isSafeNumericAppId,
};
