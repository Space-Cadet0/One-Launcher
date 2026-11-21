// @ts-check
'use strict';

const {
  sanitizeLauncherSettingsPayload,
  collectLaunchCommandsRecursive,
  confirmAndApproveLaunchCommands,
  revokeApprovedLaunchCommands,
} = require('../../launcher/securityAndPathUtils.cjs');
const {
  sanitizeRendererIpcOptions,
  stripUnconfirmedInlineShellCommands,
} = require('./launchApprovalIpc.cjs');

/**
 * Validate an optional dialog `defaultPath` from the renderer, rejecting null bytes and
 * paths exceeding 1024 characters.
 *
 * @param {unknown} rawDefaultPath
 * @returns {string | undefined}
 */
function sanitizeDialogDefaultPath(rawDefaultPath) {
  if (typeof rawDefaultPath !== 'string') return undefined;
  if (rawDefaultPath.includes('\0')) return undefined;
  const trimmed = rawDefaultPath.trim();
  if (!trimmed || trimmed.length > 1024) return undefined;
  return trimmed;
}

/**
 * Register game scanning, install/download management, launch/stop, file browser dialogs,
 * per-game launch configs, performance settings, and pending-session drain IPC handlers.
 *
 * @param {{
 *   ipcMain: any,
 *   launcherEngine: any,
 *   dialog?: any,
 *   getMainWindow?: () => any,
 *   handlerOptions?: Record<string, any>,
 * }} deps
 */
function registerGameConfigAndDialogsIpcHandlers({
  ipcMain,
  launcherEngine,
  dialog,
  getMainWindow,
  handlerOptions = {},
}) {
  /** @type {any[]} */
  let verifiedInstalledGamesRegistry = [];

  /**
   * Record authoritative installed-game scan results returned by main-process disk scanners
   * so `launcher:launch-game` can validate `executablePath` containment without trusting
   * renderer-supplied `installPath` values.
   *
   * @param {any} scanResult
   */
  const recordVerifiedScanResult = (scanResult) => {
    const games = Array.isArray(scanResult?.installedGames)
      ? scanResult.installedGames
      : Array.isArray(scanResult)
        ? scanResult
        : null;
    if (!games) return;
    verifiedInstalledGamesRegistry = games.filter(
      (g) => g && typeof g === 'object' && g.source !== 'custom_config' && g.isCustomOverride !== true
    );
  };

  const runInstalledScan = async (/** @type {unknown} */ options) => {
    const safeOpts = sanitizeRendererIpcOptions(options);
    const res =
      typeof launcherEngine.scanAllInstalledGamesAsync === 'function'
        ? await launcherEngine.scanAllInstalledGamesAsync(safeOpts)
        : await launcherEngine.scanAllInstalledGames(safeOpts);
    recordVerifiedScanResult(res);
    return res;
  };

  ipcMain.handle(
    'scan:steam-installed',
    async (/** @type {any} */ _event, /** @type {unknown} */ options) => runInstalledScan(options)
  );

  ipcMain.handle(
    'launcher:scan-installed',
    async (/** @type {any} */ _event, /** @type {unknown} */ options) => runInstalledScan(options)
  );

  ipcMain.handle(
    'launcher:detect-storefront-clients',
    async (/** @type {any} */ _event, /** @type {unknown} */ options) => {
      return launcherEngine.detectInstalledStorefrontClients(sanitizeRendererIpcOptions(options));
    }
  );

  ipcMain.handle(
    'launcher:get-disk-space',
    async (/** @type {any} */ _event, /** @type {unknown} */ targetPath) => {
      return launcherEngine.getDiskSpace(typeof targetPath === 'string' ? targetPath : '');
    }
  );

  ipcMain.handle(
    'launcher:get-install-info',
    async (
      /** @type {any} */ _event,
      /** @type {unknown} */ payload,
      /** @type {unknown} */ rawOpts
    ) => {
      const cleanPayload = sanitizeRendererIpcOptions(payload);
      if (rawOpts !== undefined) {
        return await launcherEngine.getGameInstallInfo(
          cleanPayload,
          sanitizeRendererIpcOptions(rawOpts)
        );
      }
      return await launcherEngine.getGameInstallInfo(cleanPayload);
    }
  );

  ipcMain.handle(
    'launcher:launch-game',
    async (/** @type {any} */ _event, /** @type {unknown} */ payload) => {
      const sanitizedPayload = stripUnconfirmedInlineShellCommands(
        /** @type {Record<string, any>} */ (payload),
        launcherEngine,
        {
          ...handlerOptions,
          verifiedInstalledGames: verifiedInstalledGamesRegistry,
        }
      );
      return await launcherEngine.launchGame(sanitizedPayload);
    }
  );

  ipcMain.handle(
    'launcher:stop-game',
    async (/** @type {any} */ _event, /** @type {unknown} */ payload) => {
      const arg = typeof payload === 'string' ? payload : sanitizeRendererIpcOptions(payload);
      return await launcherEngine.stopGame(arg);
    }
  );

  ipcMain.handle('launcher:get-running-games', async () => {
    return launcherEngine.getRunningGames();
  });

  ipcMain.handle(
    'launcher:install-game',
    async (/** @type {any} */ _event, /** @type {unknown} */ payload) => {
      return await launcherEngine.installGame(sanitizeRendererIpcOptions(payload));
    }
  );

  ipcMain.handle(
    'launcher:pause-download',
    async (/** @type {any} */ _event, /** @type {unknown} */ taskId) => {
      return launcherEngine.pauseDownload(
        typeof taskId === 'string' ? taskId : String(taskId || '')
      );
    }
  );

  ipcMain.handle(
    'launcher:resume-download',
    async (/** @type {any} */ _event, /** @type {unknown} */ taskId) => {
      return launcherEngine.resumeDownload(
        typeof taskId === 'string' ? taskId : String(taskId || '')
      );
    }
  );

  ipcMain.handle(
    'launcher:cancel-download',
    async (/** @type {any} */ _event, /** @type {unknown} */ taskId) => {
      return launcherEngine.cancelDownload(
        typeof taskId === 'string' ? taskId : String(taskId || '')
      );
    }
  );

  ipcMain.handle('launcher:get-download-queue', async () => {
    return launcherEngine.getDownloadQueue();
  });

  ipcMain.handle(
    'launcher:uninstall-game',
    async (/** @type {any} */ _event, /** @type {unknown} */ payload) => {
      return await launcherEngine.uninstallGame(sanitizeRendererIpcOptions(payload));
    }
  );

  ipcMain.handle(
    'launcher:verify-game',
    async (/** @type {any} */ _event, /** @type {unknown} */ payload) => {
      return await launcherEngine.verifyGameFiles(sanitizeRendererIpcOptions(payload));
    }
  );

  ipcMain.handle(
    'launcher:browse-files',
    async (/** @type {any} */ _event, /** @type {unknown} */ targetPath) => {
      return await launcherEngine.browseLocalFiles(
        typeof targetPath === 'string' ? targetPath : ''
      );
    }
  );

  ipcMain.handle(
    'launcher:select-executable',
    async (/** @type {any} */ _event, /** @type {unknown} */ defaultPath) => {
      return await launcherEngine.selectExecutableDialog(sanitizeDialogDefaultPath(defaultPath));
    }
  );

  ipcMain.handle(
    'launcher:select-folder',
    async (/** @type {any} */ _event, /** @type {unknown} */ defaultPath) => {
      return await launcherEngine.selectFolderDialog(sanitizeDialogDefaultPath(defaultPath));
    }
  );

  ipcMain.handle(
    'launcher:save-launch-config',
    async (
      /** @type {any} */ _event,
      /** @type {unknown} */ config,
      /** @type {unknown} */ rawOpts
    ) => {
      const cleanConfig = sanitizeRendererIpcOptions(config);
      const cleanOpts = rawOpts !== undefined ? sanitizeRendererIpcOptions(rawOpts) : undefined;
      if (cleanConfig.reset && cleanConfig.gameId) {
        revokeApprovedLaunchCommands(cleanConfig.gameId, handlerOptions);
        return cleanOpts !== undefined
          ? launcherEngine.saveGameLaunchConfig(cleanConfig, cleanOpts)
          : launcherEngine.saveGameLaunchConfig(cleanConfig);
      }

      const incomingEntries = collectLaunchCommandsRecursive(cleanConfig);
      if (incomingEntries.length > 0) {
        const parentWin = typeof getMainWindow === 'function' ? getMainWindow() : null;
        const approval = await confirmAndApproveLaunchCommands({
          gameId: cleanConfig.gameId,
          configOrPayload: cleanConfig,
          dialog,
          parentWindow: parentWin,
          options: handlerOptions,
        });
        if (!approval.approved) {
          return {
            success: false,
            error: approval.error || 'Custom shell command cancelled by user.',
          };
        }
      }

      return cleanOpts !== undefined
        ? launcherEngine.saveGameLaunchConfig(cleanConfig, cleanOpts)
        : launcherEngine.saveGameLaunchConfig(cleanConfig);
    }
  );

  ipcMain.handle(
    'launcher:get-launch-configs',
    async (/** @type {any} */ _event, /** @type {unknown} */ rawOpts) => {
      return rawOpts !== undefined
        ? launcherEngine.getGameLaunchConfigs(sanitizeRendererIpcOptions(rawOpts))
        : launcherEngine.getGameLaunchConfigs();
    }
  );

  ipcMain.handle(
    'launcher:get-launch-config',
    async (
      /** @type {any} */ _event,
      /** @type {unknown} */ gameId,
      /** @type {unknown} */ rawOpts
    ) => {
      const allConfigs =
        (rawOpts !== undefined
          ? launcherEngine.getGameLaunchConfigs(sanitizeRendererIpcOptions(rawOpts))
          : launcherEngine.getGameLaunchConfigs()) || {};
      if (typeof gameId === 'string' && gameId.trim()) {
        const trimmedId = gameId.trim();
        return Object.hasOwn(allConfigs, trimmedId) ? allConfigs[trimmedId] || null : null;
      }
      return allConfigs;
    }
  );

  ipcMain.handle(
    'launcher:delete-launch-config',
    async (
      /** @type {any} */ _event,
      /** @type {unknown} */ rawArg,
      /** @type {unknown} */ rawOpts
    ) => {
      const gameId =
        typeof rawArg === 'string'
          ? rawArg.trim()
          : rawArg &&
              typeof rawArg === 'object' &&
              typeof (/** @type {any} */ (rawArg).gameId) === 'string'
            ? /** @type {any} */ (rawArg).gameId.trim()
            : '';
      if (!gameId) {
        return { success: false, error: 'Missing gameId for launch config deletion.' };
      }
      const cleanOpts = rawOpts !== undefined ? sanitizeRendererIpcOptions(rawOpts) : undefined;
      revokeApprovedLaunchCommands(gameId, handlerOptions);
      return cleanOpts !== undefined
        ? launcherEngine.saveGameLaunchConfig({ gameId, reset: true }, cleanOpts)
        : launcherEngine.saveGameLaunchConfig({ gameId, reset: true });
    }
  );

  ipcMain.handle(
    'launcher:get-performance-settings',
    async (/** @type {any} */ _event, /** @type {unknown} */ rawOpts) => {
      return launcherEngine.getLauncherPerformanceSettings(sanitizeRendererIpcOptions(rawOpts));
    }
  );

  ipcMain.handle(
    'launcher:save-performance-settings',
    async (
      /** @type {any} */ _event,
      /** @type {unknown} */ settings,
      /** @type {unknown} */ rawOpts
    ) => {
      const cleanSettings = sanitizeLauncherSettingsPayload(settings);
      return launcherEngine.saveLauncherPerformanceSettings(
        cleanSettings,
        sanitizeRendererIpcOptions(rawOpts)
      );
    }
  );

  ipcMain.handle(
    'launcher:drain-pending-sessions',
    async (/** @type {any} */ _event, /** @type {unknown} */ rawOpts) => {
      return launcherEngine.drainPendingCompletedSessions(sanitizeRendererIpcOptions(rawOpts));
    }
  );
}

module.exports = {
  sanitizeDialogDefaultPath,
  registerGameConfigAndDialogsIpcHandlers,
};
