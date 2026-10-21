const { contextBridge, ipcRenderer, webFrame } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  isElectron: true,
  platform: process.platform,
  loginStore: (storefrontId) => ipcRenderer.invoke('auth:storefront', storefrontId),
  syncStore: (storefrontId, credentials) => ipcRenderer.invoke('store:sync', storefrontId, credentials),
  exchangeCode: (storefrontId, code) => ipcRenderer.invoke('store:exchange-code', { storefrontId, code }),
  getSavedTokens: () => ipcRenderer.invoke('store:get-tokens'),
  clearTokens: (storefrontId) => ipcRenderer.invoke('store:clear-tokens', storefrontId),
  scanLocalGames: () => ipcRenderer.invoke('scan:steam-installed'),
  scanSteamAchievements: () => ipcRenderer.invoke('scan:steam-achievements'),
  openExternal: (url) => ipcRenderer.invoke('shell:open-external', url),
  searchHltb: (title) => ipcRenderer.invoke('hltb:search', title),
  fetchEpicAchievements: (accountId, accessToken) =>
    ipcRenderer.invoke('epic:fetch-achievements', { accountId, accessToken }),
  fetchGogAchievements: (username, accessToken, userId) =>
    ipcRenderer.invoke('gog:fetch-achievements', { username, accessToken, userId }),
  fetchSteamBatchAchievements: (appIds) =>
    ipcRenderer.invoke('steam:fetch-achievements', { appIds }),
  fetchIgdbCover: (title) => ipcRenderer.invoke('igdb:fetch-cover', title),
  fetchEpicProductMetadata: (payload) => ipcRenderer.invoke('store:fetch-epic-metadata', payload),

  // Universal Game Launcher & Install Manager IPC
  scanAllInstalledGames: () => ipcRenderer.invoke('launcher:scan-installed'),
  detectCompatibilityLayers: () => ipcRenderer.invoke('launcher:detect-compat-layers'),
  installCompatibilityLayer: (payload) => ipcRenderer.invoke('launcher:install-compat-layer', payload),
  checkCompatibilityLayerUpdates: () => ipcRenderer.invoke('launcher:check-compat-updates'),
  updateCompatibilityLayer: (payload) => ipcRenderer.invoke('launcher:update-compat-layer', payload),
  getDiskSpace: (targetPath) => ipcRenderer.invoke('launcher:get-disk-space', targetPath),
  getGameInstallInfo: (payload) => ipcRenderer.invoke('launcher:get-install-info', payload),
  launchGame: (payload) => ipcRenderer.invoke('launcher:launch-game', payload),
  stopGame: (payload) => ipcRenderer.invoke('launcher:stop-game', payload),
  getRunningGames: () => ipcRenderer.invoke('launcher:get-running-games'),
  installGame: (payload) => ipcRenderer.invoke('launcher:install-game', payload),
  pauseDownload: (taskId) => ipcRenderer.invoke('launcher:pause-download', taskId),
  resumeDownload: (taskId) => ipcRenderer.invoke('launcher:resume-download', taskId),
  cancelDownload: (taskId) => ipcRenderer.invoke('launcher:cancel-download', taskId),
  getDownloadQueue: () => ipcRenderer.invoke('launcher:get-download-queue'),
  uninstallGame: (payload) => ipcRenderer.invoke('launcher:uninstall-game', payload),
  verifyGameFiles: (payload) => ipcRenderer.invoke('launcher:verify-game', payload),
  browseLocalFiles: (targetPath) => ipcRenderer.invoke('launcher:browse-files', targetPath),
  selectExecutableDialog: (defaultPath) => ipcRenderer.invoke('launcher:select-executable', defaultPath),
  selectFolderDialog: (defaultPath) => ipcRenderer.invoke('launcher:select-folder', defaultPath),
  saveGameLaunchConfig: (config) => ipcRenderer.invoke('launcher:save-launch-config', config),
  getGameLaunchConfigs: () => ipcRenderer.invoke('launcher:get-launch-configs'),
  onDownloadUpdated: (cb) => {
    const handler = (_e, data) => cb(data);
    ipcRenderer.on('launcher:download-updated', handler);
    return () => ipcRenderer.removeListener('launcher:download-updated', handler);
  },
  onSessionUpdated: (cb) => {
    const handler = (_e, data) => cb(data);
    ipcRenderer.on('launcher:session-updated', handler);
    return () => ipcRenderer.removeListener('launcher:session-updated', handler);
  },
  onFullscreenChanged: (cb) => {
    const handler = (_e, isFullScreen) => cb(Boolean(isFullScreen));
    ipcRenderer.on('window:fullscreen-changed', handler);
    return () => ipcRenderer.removeListener('window:fullscreen-changed', handler);
  },
  minimizeWindow: () => ipcRenderer.invoke('window:minimize'),
  toggleMaximizeWindow: () => ipcRenderer.invoke('window:maximize-toggle'),
  isWindowMaximized: () => ipcRenderer.invoke('window:is-maximized'),
  closeWindow: () => ipcRenderer.invoke('window:close'),
  performMenuAction: (action) => ipcRenderer.invoke('window:perform-menu-action', action),
  onMaximizedChanged: (callback) => {
    const handler = (_event, isMaximized) => callback(Boolean(isMaximized));
    ipcRenderer.on('window:maximized-changed', handler);
    return () => ipcRenderer.removeListener('window:maximized-changed', handler);
  },
  // trimMemory: () => ipcRenderer.invoke('perf:trim-memory')
  trimMemory: (options) => {
    try {
      if (typeof globalThis.gc === 'function') {
        globalThis.gc();
      }
    } catch {}
    try {
      webFrame?.clearCache?.();
    } catch {}
    return ipcRenderer.invoke('perf:trim-memory', options);
  },
  getAppVersion: () => ipcRenderer.invoke('app:get-version'),
  getAppInfo: () => ipcRenderer.invoke('app:get-info'),
  checkForAppUpdates: () => ipcRenderer.invoke('app:check-for-updates'),
});
