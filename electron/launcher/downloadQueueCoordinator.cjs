// @ts-check
'use strict';

/**
 * One Launcher — Download Queue Coordinator Facade
 *
 * Backward-compatible facade preserving 100% of existing `downloadQueueCoordinator.cjs`
 * exports backed by 6 cohesive sub-modules under `electron/launcher/downloads/`:
 * - `downloadQueueStore.cjs`: queue persistence, EMA speed smoothing, throttled IPC, dedup & URL/CLI guards
 * - `cliProgressParser.cjs`: line-buffered stdout/stderr progress parsing for `legendary` and `gogdl`
 * - `steamDownloadMonitor.cjs`: incremental Steam `content_log.txt` monitor & Authenticode-verified `SteamSetup.exe` bootstrap
 * - `xboxAndChainedDownloaders.cjs`: async-sized Xbox GamingServices & chained publisher monitors/orchestrators
 * - `installInfoResolver.cjs`: multi-storefront install info, disk space & manifest telemetry resolution
 * - `downloadLifecycleController.cjs`: install/pause/resume/cancel/graceful-shutdown lifecycle & symlink-safe cleanup
 */

const { MAX_PLAUSIBLE_GAME_INSTALL_BYTES } = require('./binaryAndManifestInspectors.cjs');
const downloadQueueStore = require('./downloads/downloadQueueStore.cjs');
const steamDownloadMonitor = require('./downloads/steamDownloadMonitor.cjs');
const xboxAndChainedDownloaders = require('./downloads/xboxAndChainedDownloaders.cjs');
const installInfoResolver = require('./downloads/installInfoResolver.cjs');
const downloadLifecycleController = require('./downloads/downloadLifecycleController.cjs');

module.exports = {
  MAX_PLAUSIBLE_GAME_INSTALL_BYTES,
  TRUSTED_EXTERNAL_LAUNCHER_DOMAINS: downloadQueueStore.TRUSTED_EXTERNAL_LAUNCHER_DOMAINS,
  validateTrustedExternalLauncherUrl: downloadQueueStore.validateTrustedExternalLauncherUrl,
  ensureDownloadQueueRehydrated: downloadQueueStore.ensureDownloadQueueRehydrated,
  persistDownloadQueueToDisk: downloadQueueStore.persistDownloadQueueToDisk,
  computeSmoothedDownloadSpeed: downloadQueueStore.computeSmoothedDownloadSpeed,
  getDownloadQueue: downloadQueueStore.getDownloadQueue,
  updateDownloadTask: downloadQueueStore.updateDownloadTask,
  hasAuthenticatedSteamSessionInVdfCandidates:
    steamDownloadMonitor.hasAuthenticatedSteamSessionInVdfCandidates,
  measurePublisherStagingBytes: xboxAndChainedDownloaders.measurePublisherStagingBytes,
  startSteamInstallMonitor: steamDownloadMonitor.startSteamInstallMonitor,
  startXboxInstallMonitor: xboxAndChainedDownloaders.startXboxInstallMonitor,
  startChainedLauncherInstallMonitor:
    xboxAndChainedDownloaders.startChainedLauncherInstallMonitor,
  checkBottlePublisherLauncherAliveAsync:
    xboxAndChainedDownloaders.checkBottlePublisherLauncherAliveAsync,
  checkHostWinPublisherLauncherAliveAsync:
    xboxAndChainedDownloaders.checkHostWinPublisherLauncherAliveAsync,
  ensureWindowsSteamInBottle: steamDownloadMonitor.ensureWindowsSteamInBottle,
  sweepStaleGogTempBinsAsync: downloadLifecycleController.sweepStaleGogTempBinsAsync,
  getGameInstallInfo: installInfoResolver.getGameInstallInfo,
  installGame: downloadLifecycleController.installGame,
  pauseDownload: downloadLifecycleController.pauseDownload,
  resumeDownload: downloadLifecycleController.resumeDownload,
  terminateDownloadController: downloadLifecycleController.terminateDownloadController,
  cancelDownload: downloadLifecycleController.cancelDownload,
  clearDownloadQueue: downloadLifecycleController.clearDownloadQueue,
  shutdownDownloadEngine: downloadLifecycleController.shutdownDownloadEngine,
  gracefulShutdownDownloads: downloadLifecycleController.gracefulShutdownDownloads,
  getPausedByInGameTaskIds: downloadLifecycleController.getPausedByInGameTaskIds,
  pauseActiveDownloadsForInGame: downloadLifecycleController.pauseActiveDownloadsForInGame,
  resumeDownloadsPausedByInGame: downloadLifecycleController.resumeDownloadsPausedByInGame,
};
