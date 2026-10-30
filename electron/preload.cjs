const { contextBridge, ipcRenderer, webFrame } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  isElectron: true,
  platform: process.platform,
  loginStore: (storefrontId) => ipcRenderer.invoke('auth:storefront', storefrontId),
  syncStore: (storefrontId, credentials) =>
    ipcRenderer.invoke('store:sync', storefrontId, credentials),
  exchangeCode: (storefrontId, code) =>
    ipcRenderer.invoke('store:exchange-code', { storefrontId, code }),
  getSavedTokens: () => ipcRenderer.invoke('store:get-tokens'),
  clearTokens: (storefrontId) => ipcRenderer.invoke('store:clear-tokens', storefrontId),
  disconnectStore: (storefrontId) => ipcRenderer.invoke('store:disconnect', storefrontId),
  scanLocalGames: () => ipcRenderer.invoke('scan:steam-installed'),
  scanSteamAchievements: () => ipcRenderer.invoke('scan:steam-achievements'),
  openExternal: (url) => ipcRenderer.invoke('shell:open-external', url),
  openExternalUrl: (url) => ipcRenderer.invoke('shell:open-external', url),
  searchHltb: (title) => ipcRenderer.invoke('hltb:search', title),
  fetchEpicAchievements: (accountIdOrPayload, accessToken) =>
    ipcRenderer.invoke(
      'epic:fetch-achievements',
      accountIdOrPayload && typeof accountIdOrPayload === 'object'
        ? accountIdOrPayload
        : { accountId: accountIdOrPayload, accessToken }
    ),
  fetchGogAchievements: (usernameOrPayload, accessToken, userId) =>
    ipcRenderer.invoke(
      'gog:fetch-achievements',
      usernameOrPayload && typeof usernameOrPayload === 'object'
        ? usernameOrPayload
        : { username: usernameOrPayload, accessToken, userId }
    ),
  fetchXboxAchievements: (payload) => ipcRenderer.invoke('xbox:fetch-achievements', payload),
  fetchSteamBatchAchievements: (appIds) =>
    ipcRenderer.invoke('steam:fetch-achievements', { appIds }),
  fetchIgdbCover: (title) => ipcRenderer.invoke('igdb:fetch-cover', title),
  fetchEpicProductMetadata: (payload) => ipcRenderer.invoke('store:fetch-epic-metadata', payload),
  fetchEpicGameSchema: (payload) => ipcRenderer.invoke('epic:fetch-game-schema', payload),
  fetchXboxProductMetadata: (payload) => ipcRenderer.invoke('store:fetch-xbox-metadata', payload),
  fetchXboxGameSchema: (payload) => ipcRenderer.invoke('xbox:fetch-game-schema', payload),
  getStoreAchievements: (payload) => ipcRenderer.invoke('store:get-achievements', payload),
  getXboxStatus: (payload) => ipcRenderer.invoke('store:xbox-get-status', payload),
  setXboxSyncMode: (syncMode) => ipcRenderer.invoke('store:xbox-set-sync-mode', syncMode),

  // Universal Game Launcher & Install Manager IPC
  scanAllInstalledGames: (opts) => ipcRenderer.invoke('launcher:scan-installed', opts),
  detectCompatibilityLayers: (opts) => ipcRenderer.invoke('launcher:detect-compat-layers', opts),
  detectInstalledStorefrontClients: (opts) =>
    ipcRenderer.invoke('launcher:detect-storefront-clients', opts),
  installCompatibilityLayer: (payload) =>
    ipcRenderer.invoke('launcher:install-compat-layer', payload),
  checkCompatibilityLayerUpdates: (opts) =>
    ipcRenderer.invoke('launcher:check-compat-updates', opts),
  updateCompatibilityLayer: (payload) =>
    ipcRenderer.invoke('launcher:update-compat-layer', payload),
  getDiskSpace: (targetPath) => ipcRenderer.invoke('launcher:get-disk-space', targetPath),
  getGameInstallInfo: (payload) => ipcRenderer.invoke('launcher:get-install-info', payload),
  getInstallInfo: (payload) => ipcRenderer.invoke('launcher:get-install-info', payload),
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
  selectExecutableDialog: (defaultPath) =>
    ipcRenderer.invoke('launcher:select-executable', defaultPath),
  selectFolderDialog: (defaultPath) => ipcRenderer.invoke('launcher:select-folder', defaultPath),
  saveGameLaunchConfig: (config) => ipcRenderer.invoke('launcher:save-launch-config', config),
  saveLaunchConfig: (config) => ipcRenderer.invoke('launcher:save-launch-config', config),
  getGameLaunchConfigs: () => ipcRenderer.invoke('launcher:get-launch-configs'),
  getLaunchConfig: (gameId) => ipcRenderer.invoke('launcher:get-launch-config', gameId),
  deleteLaunchConfig: (gameId) => ipcRenderer.invoke('launcher:delete-launch-config', gameId),
  getLauncherPerformanceSettings: (opts) =>
    ipcRenderer.invoke('launcher:get-performance-settings', opts),
  saveLauncherPerformanceSettings: (settings) =>
    ipcRenderer.invoke('launcher:save-performance-settings', settings),
  drainPendingSessions: (opts) => ipcRenderer.invoke('launcher:drain-pending-sessions', opts),
  probeEnvironmentHealth: (options) =>
    ipcRenderer.invoke('launcher:probe-environment-health', options),
  runEnvironmentSetupTasks: (payload) =>
    ipcRenderer.invoke('launcher:run-environment-setup-tasks', payload),
  cancelEnvironmentSetup: (runId) =>
    ipcRenderer.invoke('launcher:cancel-environment-setup', runId),
  startGuidedClientLogin: (payload) =>
    ipcRenderer.invoke('launcher:start-guided-client-login', payload),
  cancelGuidedClientLogin: (targetId) =>
    ipcRenderer.invoke('launcher:cancel-guided-client-login', targetId),
  getSetupWizardState: () => ipcRenderer.invoke('launcher:get-setup-wizard-state'),
  saveSetupWizardState: (patch) =>
    ipcRenderer.invoke('launcher:save-setup-wizard-state', patch),
  onEnvironmentSetupProgress: (cb) => {
    const handler = (_e, data) => cb(data);
    ipcRenderer.on('launcher:environment-setup-progress', handler);
    return () => ipcRenderer.removeListener('launcher:environment-setup-progress', handler);
  },
  clearRendererImageCache: () => {
    try {
      webFrame?.clearCache?.();
    } catch {}
    return ipcRenderer.invoke('perf:trim-memory');
  },
  onHibernateStateChanged: (cb) => {
    const handler = (_e, data) => cb(data);
    ipcRenderer.on('launcher:hibernate-state', handler);
    return () => ipcRenderer.removeListener('launcher:hibernate-state', handler);
  },
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
  isWindowFullscreen: () => ipcRenderer.invoke('window:is-fullscreen'),
  toggleWindowFullscreen: () => ipcRenderer.invoke('window:toggle-fullscreen'),
  toggleFullScreen: () => ipcRenderer.invoke('window:toggle-fullscreen'),
  minimizeWindow: () => ipcRenderer.invoke('window:minimize'),
  toggleMaximizeWindow: () => ipcRenderer.invoke('window:maximize-toggle'),
  maximizeWindow: () => ipcRenderer.invoke('window:maximize-toggle'),
  isWindowMaximized: () => ipcRenderer.invoke('window:is-maximized'),
  closeWindow: () => ipcRenderer.invoke('window:close'),
  performMenuAction: (action) => ipcRenderer.invoke('window:perform-menu-action', action),
  toggleDevTools: () => ipcRenderer.invoke('window:perform-menu-action', 'toggle-devtools'),
  reloadWindow: () => ipcRenderer.invoke('window:perform-menu-action', 'reload'),
  zoomWindow: (direction) =>
    ipcRenderer.invoke(
      'window:perform-menu-action',
      direction === 'in' ? 'zoom-in' : direction === 'out' ? 'zoom-out' : 'reset-zoom'
    ),
  onMaximizedChanged: (callback) => {
    const handler = (_event, isMaximized) => callback(Boolean(isMaximized));
    ipcRenderer.on('window:maximized-changed', handler);
    return () => ipcRenderer.removeListener('window:maximized-changed', handler);
  },
  onWindowMaximizedChanged: (callback) => {
    const handler = (_event, isMaximized) => callback(Boolean(isMaximized));
    ipcRenderer.on('window:maximized-changed', handler);
    return () => ipcRenderer.removeListener('window:maximized-changed', handler);
  },
  trimMemory: (options) => {
    const isPassive = Boolean(options && options.passive);
    if (!isPassive) {
      try {
        if (typeof globalThis.gc === 'function') {
          globalThis.gc();
        }
      } catch {}
      try {
        if (options?.clearImageCache !== false) {
          webFrame?.clearCache?.();
        }
      } catch {}
    }
    return ipcRenderer.invoke('perf:trim-memory', options);
  },
  getAppVersion: () => ipcRenderer.invoke('app:get-version'),
  getAppInfo: () => ipcRenderer.invoke('app:get-info'),
  checkForAppUpdates: () => ipcRenderer.invoke('app:check-for-updates'),
  getUserOverrides: () => ipcRenderer.invoke('offlineVault:get-user-overrides'),
  saveUserOverride: (arg1, arg2) => ipcRenderer.invoke('offlineVault:save-user-override', arg1, arg2),
  removeUserOverride: (gameId) => ipcRenderer.invoke('offlineVault:remove-user-override', gameId),

  // Offline Metadata & Media Vault (SQLite WAL + ol-media:// + First-Party Cache Federation)
  offlineVault: {
    getStats: () => ipcRenderer.invoke('offlineVault:get-stats'),
    setTier: (tier) => ipcRenderer.invoke('offlineVault:set-tier', tier),
    clear: (options) => ipcRenderer.invoke('offlineVault:clear', options),
    getCatalogSnapshot: () => ipcRenderer.invoke('offlineVault:get-catalog-snapshot'),
    upsertGames: (games) => ipcRenderer.invoke('offlineVault:upsert-games', games),
    deleteGames: (gameIds) => ipcRenderer.invoke('offlineVault:delete-games', gameIds),
    setModalBusy: (isBusy) => ipcRenderer.invoke('offlineVault:set-modal-busy', isBusy),
    getGameDetail: (gameId) => ipcRenderer.invoke('offlineVault:get-game-detail', gameId),
    saveGameDetail: (payload) => ipcRenderer.invoke('offlineVault:save-game-detail', payload),
    resolveLocalMetadata: (payload) =>
      ipcRenderer.invoke('offlineVault:resolve-local-metadata', payload),
    queueHydration: (payload) => ipcRenderer.invoke('offlineVault:queue-hydration', payload),
    checkUrlStatus: (url) => ipcRenderer.invoke('offlineVault:check-url-status', url),
    getUserOverrides: () => ipcRenderer.invoke('offlineVault:get-user-overrides'),
    saveUserOverride: (arg1, arg2) =>
      ipcRenderer.invoke('offlineVault:save-user-override', arg1, arg2),
    removeUserOverride: (gameId) =>
      ipcRenderer.invoke('offlineVault:remove-user-override', gameId),
    onHealthChanged: (cb) => {
      const handler = (_e, data) => cb(data);
      ipcRenderer.on('offlineVault:health-changed', handler);
      return () => ipcRenderer.removeListener('offlineVault:health-changed', handler);
    },
    onGameHydrated: (cb) => {
      const handler = (_e, data) => cb(data);
      ipcRenderer.on('offlineVault:game-hydrated', handler);
      return () => ipcRenderer.removeListener('offlineVault:game-hydrated', handler);
    },
    onHydrationProgress: (cb) => {
      const handler = (_e, data) => cb(data);
      ipcRenderer.on('offlineVault:hydration-progress', handler);
      return () => ipcRenderer.removeListener('offlineVault:hydration-progress', handler);
    },
  },
});
