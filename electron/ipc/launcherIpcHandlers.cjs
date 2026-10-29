// @ts-check
'use strict';

const {
  FORBIDDEN_RENDERER_IPC_KEYS,
  LAUNCH_SHELL_OR_EXEC_FIELDS,
  ALLOWED_LAUNCHER_SETTINGS_KEYS,
  isContainedWithinRoot,
  sanitizeLaunchConfigRecursive,
  sanitizeLauncherSettingsPayload,
  collectLaunchCommandsRecursive,
  computeLaunchCommandFingerprint,
  isLaunchCommandApproved,
  confirmAndApproveLaunchCommands,
  revokeApprovedLaunchCommands,
} = require('../launcher/securityAndPathUtils.cjs');

/**
 * Recursively strip internal dependency-injection keys, prototype-pollution keys, and
 * dangerous dynamic-linker/runtime env keys (`LD_PRELOAD`, `DYLD_INSERT_LIBRARIES`,
 * `NODE_OPTIONS`, `ELECTRON_RUN_AS_NODE`, etc.) from untrusted renderer IPC payloads.
 *
 * @param {unknown} rawOptions
 * @returns {Record<string, any>}
 */
function sanitizeRendererIpcOptions(rawOptions) {
  if (!rawOptions || typeof rawOptions !== 'object' || Array.isArray(rawOptions)) {
    return {};
  }
  const sanitized = sanitizeLaunchConfigRecursive(rawOptions);
  return sanitized && typeof sanitized === 'object' && !Array.isArray(sanitized) ? sanitized : {};
}

/**
 * Collect all non-empty shell/executable strings (`preLaunchCommand`, `postExitCommand`,
 * `wrapperCommand`, `customExecutable`, `executablePath`) across ALL nesting depths
 * (`top-level`, `launchConfig`, `platformConfigs.*`, `storefrontConfigs.*`).
 *
 * @param {Record<string, any> | null | undefined} cfg
 * @returns {Set<string>}
 */
function collectShellCommandsFromConfig(cfg) {
  /** @type {Set<string>} */
  const commands = new Set();
  const entries = collectLaunchCommandsRecursive(cfg);
  for (const entry of entries) {
    commands.add(`${entry.field}:${entry.value}`);
  }
  return commands;
}

/**
 * Recursively strip unapproved shell/executable fields (`preLaunchCommand`, `postExitCommand`,
 * `wrapperCommand`, `customExecutable`, `executablePath`) from a renderer launch payload at
 * ALL nesting depths (`top-level`, `launchConfig`, `platformConfigs.*`, `storefrontConfigs.*`)
 * unless confirmed in `approved_launch_commands.json` (or matching an already-approved config).
 *
 * @param {Record<string, any>} rawPayload
 * @param {any} launcherEngine
 * @param {Record<string, any>} [options]
 * @returns {Record<string, any>}
 */
function stripUnconfirmedInlineShellCommands(rawPayload, launcherEngine, options = {}) {
  if (!rawPayload || typeof rawPayload !== 'object' || Array.isArray(rawPayload)) {
    return rawPayload;
  }
  const cleanPayload = sanitizeRendererIpcOptions(rawPayload);
  const gameId = typeof cleanPayload.gameId === 'string' ? cleanPayload.gameId.trim() : '';

  const storedConfigCommands = collectShellCommandsFromConfig(
    typeof launcherEngine?.getGameLaunchConfigs === 'function' && gameId
      ? launcherEngine.getGameLaunchConfigs()?.[gameId]
      : null
  );

  /**
   * @param {any} node
   * @param {number} depth
   * @returns {any}
   */
  const stripNode = (node, depth = 0) => {
    if (!node || typeof node !== 'object' || Array.isArray(node) || depth > 10) {
      return node;
    }
    /** @type {Record<string, any>} */
    const out = {};
    for (const [key, val] of Object.entries(node)) {
      if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue;
      if (LAUNCH_SHELL_OR_EXEC_FIELDS.includes(key)) {
        if (typeof val === 'string' && val.trim()) {
          const trimmed = val.trim();
          if (
            depth === 0 &&
            key === 'executablePath' &&
            typeof cleanPayload.installPath === 'string' &&
            cleanPayload.installPath.trim() &&
            isContainedWithinRoot(cleanPayload.installPath, trimmed)
          ) {
            out[key] = trimmed;
            continue;
          }
          const fp = computeLaunchCommandFingerprint(key, trimmed);
          const approvedInVault = gameId ? isLaunchCommandApproved(gameId, fp, options) : false;
          const approvedInSavedCfg = storedConfigCommands.has(`${key}:${trimmed}`);
          if (approvedInVault || approvedInSavedCfg) {
            out[key] = trimmed;
          }
        }
        continue;
      }
      if (val && typeof val === 'object' && !Array.isArray(val)) {
        out[key] = stripNode(val, depth + 1);
      } else {
        out[key] = val;
      }
    }
    return out;
  };

  return stripNode(cleanPayload, 0);
}

/**
 * Universal Game Launcher, Compatibility Layer & Download Manager IPC Handlers
 * Extracted from electron/main.cjs for clean modular boundary separation.
 *
 * @param {{ ipcMain: any, launcherEngine: any, dialog?: any, getMainWindow?: () => any, options?: Record<string, any> }} deps
 */
function registerLauncherIpcHandlers({ ipcMain, launcherEngine, dialog, getMainWindow, options: handlerOptions = {} }) {
  if (!ipcMain || !launcherEngine) return;

  ipcMain.handle('scan:steam-installed', async (/** @type {any} */ _event, /** @type {unknown} */ options) => {
    return launcherEngine.scanAllInstalledGames(sanitizeRendererIpcOptions(options));
  });

  ipcMain.handle('launcher:scan-installed', async (/** @type {any} */ _event, /** @type {unknown} */ options) => {
    return launcherEngine.scanAllInstalledGames(sanitizeRendererIpcOptions(options));
  });

  ipcMain.handle('launcher:detect-storefront-clients', async (/** @type {any} */ _event, /** @type {unknown} */ options) => {
    return launcherEngine.detectInstalledStorefrontClients(sanitizeRendererIpcOptions(options));
  });

  ipcMain.handle('launcher:detect-compat-layers', async (/** @type {any} */ _event, /** @type {unknown} */ options) => {
    return launcherEngine.detectCompatibilityLayers(sanitizeRendererIpcOptions(options));
  });

  ipcMain.handle('launcher:install-compat-layer', async (/** @type {any} */ _event, /** @type {unknown} */ payload) => {
    return await launcherEngine.installCompatibilityLayer(sanitizeRendererIpcOptions(payload));
  });

  ipcMain.handle('launcher:check-compat-updates', async (/** @type {any} */ _event, /** @type {unknown} */ options) => {
    return await launcherEngine.checkCompatibilityLayerUpdates(sanitizeRendererIpcOptions(options));
  });

  ipcMain.handle('launcher:update-compat-layer', async (/** @type {any} */ _event, /** @type {unknown} */ payload) => {
    return await launcherEngine.updateCompatibilityLayer(sanitizeRendererIpcOptions(payload));
  });

  ipcMain.handle('launcher:get-disk-space', async (/** @type {any} */ _event, /** @type {unknown} */ targetPath) => {
    return launcherEngine.getDiskSpace(typeof targetPath === 'string' ? targetPath : '');
  });

  ipcMain.handle('launcher:get-install-info', async (/** @type {any} */ _event, /** @type {unknown} */ payload) => {
    return await launcherEngine.getGameInstallInfo(sanitizeRendererIpcOptions(payload));
  });

  ipcMain.handle('launcher:launch-game', async (/** @type {any} */ _event, /** @type {unknown} */ payload) => {
    const sanitizedPayload = stripUnconfirmedInlineShellCommands(
      /** @type {Record<string, any>} */ (payload),
      launcherEngine,
      handlerOptions
    );
    return await launcherEngine.launchGame(sanitizedPayload);
  });

  ipcMain.handle('launcher:stop-game', async (/** @type {any} */ _event, /** @type {unknown} */ payload) => {
    const arg =
      typeof payload === 'string' ? payload : sanitizeRendererIpcOptions(payload);
    return await launcherEngine.stopGame(arg);
  });

  ipcMain.handle('launcher:get-running-games', async () => {
    return launcherEngine.getRunningGames();
  });

  ipcMain.handle('launcher:install-game', async (/** @type {any} */ _event, /** @type {unknown} */ payload) => {
    return await launcherEngine.installGame(sanitizeRendererIpcOptions(payload));
  });

  ipcMain.handle('launcher:pause-download', async (/** @type {any} */ _event, /** @type {unknown} */ taskId) => {
    return launcherEngine.pauseDownload(typeof taskId === 'string' ? taskId : String(taskId || ''));
  });

  ipcMain.handle('launcher:resume-download', async (/** @type {any} */ _event, /** @type {unknown} */ taskId) => {
    return launcherEngine.resumeDownload(typeof taskId === 'string' ? taskId : String(taskId || ''));
  });

  ipcMain.handle('launcher:cancel-download', async (/** @type {any} */ _event, /** @type {unknown} */ taskId) => {
    return launcherEngine.cancelDownload(typeof taskId === 'string' ? taskId : String(taskId || ''));
  });

  ipcMain.handle('launcher:get-download-queue', async () => {
    return launcherEngine.getDownloadQueue();
  });

  ipcMain.handle('launcher:uninstall-game', async (/** @type {any} */ _event, /** @type {unknown} */ payload) => {
    return await launcherEngine.uninstallGame(sanitizeRendererIpcOptions(payload));
  });

  ipcMain.handle('launcher:verify-game', async (/** @type {any} */ _event, /** @type {unknown} */ payload) => {
    return await launcherEngine.verifyGameFiles(sanitizeRendererIpcOptions(payload));
  });

  ipcMain.handle('launcher:browse-files', async (/** @type {any} */ _event, /** @type {unknown} */ targetPath) => {
    return await launcherEngine.browseLocalFiles(typeof targetPath === 'string' ? targetPath : '');
  });

  ipcMain.handle('launcher:select-executable', async (/** @type {any} */ _event, /** @type {unknown} */ defaultPath) => {
    return await launcherEngine.selectExecutableDialog(
      typeof defaultPath === 'string' ? defaultPath : undefined
    );
  });

  ipcMain.handle('launcher:select-folder', async (/** @type {any} */ _event, /** @type {unknown} */ defaultPath) => {
    return await launcherEngine.selectFolderDialog(
      typeof defaultPath === 'string' ? defaultPath : undefined
    );
  });

  ipcMain.handle('launcher:save-launch-config', async (/** @type {any} */ _event, /** @type {unknown} */ config) => {
    const cleanConfig = sanitizeRendererIpcOptions(config);
    if (cleanConfig.reset && cleanConfig.gameId) {
      revokeApprovedLaunchCommands(cleanConfig.gameId, handlerOptions);
      return launcherEngine.saveGameLaunchConfig(cleanConfig);
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

    return launcherEngine.saveGameLaunchConfig(cleanConfig);
  });

  ipcMain.handle('launcher:get-launch-configs', async () => {
    return launcherEngine.getGameLaunchConfigs();
  });

  ipcMain.handle('launcher:get-launch-config', async (/** @type {any} */ _event, /** @type {unknown} */ gameId) => {
    const allConfigs = launcherEngine.getGameLaunchConfigs() || {};
    if (typeof gameId === 'string' && gameId.trim()) {
      return allConfigs[gameId.trim()] || null;
    }
    return allConfigs;
  });

  ipcMain.handle('launcher:delete-launch-config', async (/** @type {any} */ _event, /** @type {unknown} */ rawArg) => {
    const gameId =
      typeof rawArg === 'string'
        ? rawArg.trim()
        : rawArg && typeof rawArg === 'object' && typeof (/** @type {any} */ (rawArg).gameId) === 'string'
          ? /** @type {any} */ (rawArg).gameId.trim()
          : '';
    if (!gameId) {
      return { success: false, error: 'Missing gameId for launch config deletion.' };
    }
    revokeApprovedLaunchCommands(gameId, handlerOptions);
    return launcherEngine.saveGameLaunchConfig({ gameId, reset: true });
  });

  ipcMain.handle('launcher:get-performance-settings', async () => {
    return launcherEngine.getLauncherPerformanceSettings({});
  });

  const handleSaveStrictSettings = async (/** @type {any} */ _event, /** @type {unknown} */ settings) => {
    const cleanSettings = sanitizeLauncherSettingsPayload(settings);
    return launcherEngine.saveLauncherPerformanceSettings(cleanSettings, {});
  };

  ipcMain.handle('launcher:save-performance-settings', handleSaveStrictSettings);
  ipcMain.handle('launcher:save-settings', handleSaveStrictSettings);

  ipcMain.handle('launcher:drain-pending-sessions', async () => {
    return launcherEngine.drainPendingCompletedSessions({});
  });
}

module.exports = {
  registerLauncherIpcHandlers,
  sanitizeRendererIpcOptions,
  sanitizeLauncherSettingsPayload,
  collectShellCommandsFromConfig,
  stripUnconfirmedInlineShellCommands,
  FORBIDDEN_RENDERER_IPC_KEYS,
  ALLOWED_LAUNCHER_SETTINGS_KEYS,
};
