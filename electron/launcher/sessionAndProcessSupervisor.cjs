// @ts-check
'use strict';

/**
 * Facade module preserving 100% of `sessionAndProcessSupervisor.cjs` exports, backed by
 * 7 cohesive domain sub-modules under `electron/launcher/supervisor/`.
 */

const bottleDisplayAndEnv = require('./supervisor/bottleDisplayAndEnvController.cjs');
const processWatchAndElev = require('./supervisor/processWatchAndElevation.cjs');
const storefrontAndCloud = require('./supervisor/storefrontLifecycleAndCloudSync.cjs');
const sessionFinalizer = require('./supervisor/sessionFinalizerAndControl.cjs');
const chainedPublisher = require('./supervisor/chainedPublisherLauncher.cjs');
const gameVerifyUninstall = require('./supervisor/gameVerifyAndUninstall.cjs');
const gameLaunchOrchestrator = require('./supervisor/gameLaunchOrchestrator.cjs');

/**
 * Host platform flag (`darwin` gating invariant `F13-02`).
 */
const IS_DARWIN_SUPERVISOR_HOST = process.platform === 'darwin';

module.exports = {
  IS_DARWIN_SUPERVISOR_HOST,

  // 1. Bottle graphics contract, Display Scaler v3, env sanitization & host display restore
  normalizeWineArgumentBackslashes: bottleDisplayAndEnv.normalizeWineArgumentBackslashes,
  doesCrossOverBinarySupportWaitChildren: bottleDisplayAndEnv.doesCrossOverBinarySupportWaitChildren,
  discoverValidatedAppLocalProxyDllOverrides:
    bottleDisplayAndEnv.discoverValidatedAppLocalProxyDllOverrides,
  computeBottleGraphicsEnvContract: bottleDisplayAndEnv.computeBottleGraphicsEnvContract,
  getLiveBottleDaemonEnvContract: bottleDisplayAndEnv.getLiveBottleDaemonEnvContract,
  resetSupervisorStateForTests: bottleDisplayAndEnv.resetSupervisorStateForTests,
  sanitizeBottleBackgroundClientWakeEnv: bottleDisplayAndEnv.sanitizeBottleBackgroundClientWakeEnv,
  applyMoltenVkMetalHudDeadlockGuard: bottleDisplayAndEnv.applyMoltenVkMetalHudDeadlockGuard,
  writeActiveDisplaySessionManifestIni: bottleDisplayAndEnv.writeActiveDisplaySessionManifestIni,
  stageBottleDisplayScalerBinaries: bottleDisplayAndEnv.stageBottleDisplayScalerBinaries,
  computeMacPrimaryDisplaySafeInsetTop: bottleDisplayAndEnv.computeMacPrimaryDisplaySafeInsetTop,
  shouldWrapBottleSessionWithDisplayLauncher:
    bottleDisplayAndEnv.shouldWrapBottleSessionWithDisplayLauncher,
  toggleSessionFullscreen: bottleDisplayAndEnv.toggleSessionFullscreen,
  restoreHostDisplayConfiguration: bottleDisplayAndEnv.restoreHostDisplayConfiguration,
  terminateDisplayWatcherTree: bottleDisplayAndEnv.terminateDisplayWatcherTree,

  // 2. Process watching, launch hook approval, URI builders & Windows elevation
  createGuardedSessionPoller: processWatchAndElev.createGuardedSessionPoller,
  runApprovedLaunchHookCommand: processWatchAndElev.runApprovedLaunchHookCommand,
  isAuthoritativeInstallDirForMutation: processWatchAndElev.isAuthoritativeInstallDirForMutation,
  disposeSessionResources: processWatchAndElev.disposeSessionResources,
  parseLaunchArguments: processWatchAndElev.parseLaunchArguments,
  buildStorefrontLaunchUri: processWatchAndElev.buildStorefrontLaunchUri,
  trackPostSessionPromise: processWatchAndElev.trackPostSessionPromise,
  killPosixProcessesMatchingWinExe: processWatchAndElev.killPosixProcessesMatchingWinExe,
  killPosixProcessesMatchingWinExes: processWatchAndElev.killPosixProcessesMatchingWinExes,
  isMacSipProtectedExecutableOrScript: processWatchAndElev.isMacSipProtectedExecutableOrScript,
  isWindowsElevationRequiredError: processWatchAndElev.isWindowsElevationRequiredError,
  spawnWindowsViaPowerShellStartProcess: processWatchAndElev.spawnWindowsViaPowerShellStartProcess,

  // 3. Storefront client lifecycle, playtime sync & cloud save barriers
  hasActivePostSessionWork: storefrontAndCloud.hasActivePostSessionWork,
  waitForActivePostSessionWork: storefrontAndCloud.waitForActivePostSessionWork,
  syncGogCloudSaves: storefrontAndCloud.syncGogCloudSaves,
  syncEpicCloudSaves: storefrontAndCloud.syncEpicCloudSaves,
  replayPendingCloudUploads: storefrontAndCloud.replayPendingCloudUploadsForSupervisor,
  waitForSteamColdStartupCloudReady: storefrontAndCloud.waitForSteamColdStartupCloudReady,
  waitForSteamCloudSyncCompletion: storefrontAndCloud.waitForSteamCloudSyncCompletion,
  resolveSteamClientBinaryPath: storefrontAndCloud.resolveSteamClientBinaryPath,
  detectInstalledStorefrontClients: storefrontAndCloud.detectInstalledStorefrontClients,
  resolveSteamClientLaunchCommand: storefrontAndCloud.resolveSteamClientLaunchCommand,
  shutdownEphemeralStorefrontClient: storefrontAndCloud.shutdownEphemeralStorefrontClient,
  syncSessionPlaytimeToStorefront: storefrontAndCloud.syncSessionPlaytimeToStorefront,

  // 4. Session finalization, active session control & engine shutdown
  finalizeGameSession: sessionFinalizer.finalizeGameSession,
  stopGame: sessionFinalizer.stopGame,
  getRunningGames: sessionFinalizer.getRunningGames,
  shutdownLauncherEngine: sessionFinalizer.shutdownLauncherEngine,

  // 5. Chained publisher helpers
  findLiveBottleGameChildPid: chainedPublisher.findLiveBottleGameChildPid,
  isSafeBottleChainedGameDirToDelete: chainedPublisher.isSafeBottleChainedGameDirToDelete,
  collectChainedGameCandidateExeNames: chainedPublisher.collectChainedGameCandidateExeNames,

  // 6. Core launch orchestration
  launchGame: gameLaunchOrchestrator.launchGame,

  // 7. Game verification & uninstallation
  verifyGameFiles: gameVerifyUninstall.verifyGameFiles,
  uninstallGame: gameVerifyUninstall.uninstallGame,
};
