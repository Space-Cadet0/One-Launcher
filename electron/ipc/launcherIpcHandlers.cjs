// @ts-check
'use strict';

const {
  FORBIDDEN_RENDERER_IPC_KEYS,
  ALLOWED_LAUNCHER_SETTINGS_KEYS,
  sanitizeLauncherSettingsPayload,
  wrapIpcMainWithSenderCheck,
} = require('../launcher/securityAndPathUtils.cjs');
const {
  sanitizeRendererIpcOptions,
  collectShellCommandsFromConfig,
  stripUnconfirmedInlineShellCommands,
} = require('./launcher/launchApprovalIpc.cjs');
const {
  ALLOWED_SETUP_WIZARD_STATE_PATCH_KEYS,
  sanitizeSafeBottleNameSlug,
  validateOptionalDmgPath,
  validateOptionalRunnerArchivePath,
  sanitizeCompatLayerPayload,
  sanitizeCompatQueryOptions,
  sanitizeEnvironmentSetupTasksPayload,
  sanitizeGuidedClientLoginPayload,
  sanitizeSetupWizardStatePatch,
  registerCompatRunnerAndSetupIpcHandlers,
} = require('./launcher/compatRunnerIpc.cjs');
const { registerGameConfigAndDialogsIpcHandlers } = require('./launcher/gameConfigAndDialogsIpc.cjs');

/**
 * Universal Game Launcher, Compatibility Layer & Download Manager IPC Handlers.
 * Thin facade over `electron/ipc/launcher/{launchApprovalIpc,compatRunnerIpc,gameConfigAndDialogsIpc}.cjs`.
 *
 * @param {{ ipcMain: any, launcherEngine: any, dialog?: any, getMainWindow?: () => any, options?: Record<string, any> }} deps
 */
function registerLauncherIpcHandlers({
  ipcMain: rawIpcMain,
  launcherEngine,
  dialog,
  getMainWindow,
  options: handlerOptions = {},
}) {
  if (!rawIpcMain || !launcherEngine) return;
  const ipcMain = wrapIpcMainWithSenderCheck(rawIpcMain, {
    getMainWindow,
    isPackaged: Boolean(handlerOptions.isPackaged),
    allowedDevOrigin: handlerOptions.allowedDevOrigin || null,
    expectedFileHref: handlerOptions.expectedFileHref || null,
  });

  registerGameConfigAndDialogsIpcHandlers({
    ipcMain,
    launcherEngine,
    dialog,
    getMainWindow,
    handlerOptions,
  });

  registerCompatRunnerAndSetupIpcHandlers({
    ipcMain,
    launcherEngine,
    dialog,
    getMainWindow,
  });
}

module.exports = {
  registerLauncherIpcHandlers,
  sanitizeRendererIpcOptions,
  sanitizeLauncherSettingsPayload,
  sanitizeSafeBottleNameSlug,
  validateOptionalDmgPath,
  validateOptionalRunnerArchivePath,
  sanitizeCompatLayerPayload,
  sanitizeCompatQueryOptions,
  sanitizeEnvironmentSetupTasksPayload,
  sanitizeGuidedClientLoginPayload,
  sanitizeSetupWizardStatePatch,
  collectShellCommandsFromConfig,
  stripUnconfirmedInlineShellCommands,
  FORBIDDEN_RENDERER_IPC_KEYS,
  ALLOWED_LAUNCHER_SETTINGS_KEYS,
  ALLOWED_SETUP_WIZARD_STATE_PATCH_KEYS,
};
