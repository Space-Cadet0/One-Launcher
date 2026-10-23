'use strict';

/**
 * Universal Game Launcher, Compatibility Layer & Download Manager IPC Handlers
 * Extracted from electron/main.cjs for clean modular boundary separation.
 */
function registerLauncherIpcHandlers({ ipcMain, launcherEngine }) {
  if (!ipcMain || !launcherEngine) return;

  ipcMain.handle('scan:steam-installed', async (_event, options) => {
    return launcherEngine.scanAllInstalledGames(options || {});
  });

  ipcMain.handle('launcher:scan-installed', async (_event, options) => {
    return launcherEngine.scanAllInstalledGames(options || {});
  });

  ipcMain.handle('launcher:detect-compat-layers', async (_event, options) => {
    return launcherEngine.detectCompatibilityLayers(options || {});
  });

  ipcMain.handle('launcher:install-compat-layer', async (_event, payload) => {
    return await launcherEngine.installCompatibilityLayer(payload || {});
  });

  ipcMain.handle('launcher:check-compat-updates', async (_event, options) => {
    return await launcherEngine.checkCompatibilityLayerUpdates(options || {});
  });

  ipcMain.handle('launcher:update-compat-layer', async (_event, payload) => {
    return await launcherEngine.updateCompatibilityLayer(payload || {});
  });

  ipcMain.handle('launcher:get-disk-space', async (_event, targetPath) => {
    return launcherEngine.getDiskSpace(targetPath);
  });

  ipcMain.handle('launcher:get-install-info', async (_event, payload) => {
    return await launcherEngine.getGameInstallInfo(payload || {});
  });

  ipcMain.handle('launcher:launch-game', async (_event, payload) => {
    return await launcherEngine.launchGame(payload || {});
  });

  ipcMain.handle('launcher:stop-game', async (_event, payload) => {
    return await launcherEngine.stopGame(payload || {});
  });

  ipcMain.handle('launcher:get-running-games', async () => {
    return launcherEngine.getRunningGames();
  });

  ipcMain.handle('launcher:install-game', async (_event, payload) => {
    return await launcherEngine.installGame(payload || {});
  });

  ipcMain.handle('launcher:pause-download', async (_event, taskId) => {
    return launcherEngine.pauseDownload(taskId);
  });

  ipcMain.handle('launcher:resume-download', async (_event, taskId) => {
    return launcherEngine.resumeDownload(taskId);
  });

  ipcMain.handle('launcher:cancel-download', async (_event, taskId) => {
    return launcherEngine.cancelDownload(taskId);
  });

  ipcMain.handle('launcher:get-download-queue', async () => {
    return launcherEngine.getDownloadQueue();
  });

  ipcMain.handle('launcher:uninstall-game', async (_event, payload) => {
    return await launcherEngine.uninstallGame(payload || {});
  });

  ipcMain.handle('launcher:verify-game', async (_event, payload) => {
    return await launcherEngine.verifyGameFiles(payload || {});
  });

  ipcMain.handle('launcher:browse-files', async (_event, targetPath) => {
    return await launcherEngine.browseLocalFiles(targetPath);
  });

  ipcMain.handle('launcher:select-executable', async (_event, defaultPath) => {
    return await launcherEngine.selectExecutableDialog(defaultPath);
  });

  ipcMain.handle('launcher:select-folder', async (_event, defaultPath) => {
    return await launcherEngine.selectFolderDialog(defaultPath);
  });

  ipcMain.handle('launcher:save-launch-config', async (_event, config) => {
    return launcherEngine.saveGameLaunchConfig(config);
  });

  ipcMain.handle('launcher:get-launch-configs', async () => {
    return launcherEngine.getGameLaunchConfigs();
  });

  ipcMain.handle('launcher:get-performance-settings', async (_event, options) => {
    return launcherEngine.getLauncherPerformanceSettings(options || {});
  });

  ipcMain.handle('launcher:save-performance-settings', async (_event, settings, options) => {
    return launcherEngine.saveLauncherPerformanceSettings(settings || {}, options || {});
  });

  ipcMain.handle('launcher:drain-pending-sessions', async (_event, options) => {
    return launcherEngine.drainPendingCompletedSessions(options || {});
  });
}

module.exports = {
  registerLauncherIpcHandlers,
};
