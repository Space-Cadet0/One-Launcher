// @ts-check
'use strict';

const { wrapIpcMainWithSenderCheck } = require('../launcher/securityAndPathUtils.cjs');
const { createOlMediaProtocolHandler } = require('./vault/olMediaProtocolHandler.cjs');
const {
  trimUserOverridesCache,
  readUserOverridesFromDisk,
  readUserOverridesAsync,
  writeUserOverridesToDiskAsync,
  readUserTagOverridesFromDisk,
  readUserTagOverridesAsync,
  writeUserTagOverridesToDiskAsync,
  sanitizeUserTagOverrideRecord,
  registerUserOverridesIpcHandlers,
} = require('./vault/userOverridesStoreIpc.cjs');
const {
  registerVaultQueryAndHydrationIpcHandlers,
} = require('./vault/vaultQueryAndHydrationIpc.cjs');

/**
 * Registers all `offlineVault:*` and user-override IPC channels, forwarding background health
 * and hydration events to the active BrowserWindow renderer (or daemon event buffer).
 * Thin facade over `electron/ipc/vault/{olMediaProtocolHandler,userOverridesStoreIpc,vaultQueryAndHydrationIpc}.cjs`.
 *
 * @param {{
 *   ipcMain: any,
 *   offlineVaultService: any,
 *   mediaHydrationEngine: any,
 *   federator?: any,
 *   getMainWindow?: () => any,
 *   sendRendererEvent?: (channel: string, payload: any) => void,
 *   userDataDir?: string,
 *   dnsLookup?: any,
 *   options?: Record<string, any>,
 * }} deps
 */
function registerOfflineVaultIpcHandlers({
  ipcMain: rawIpcMain,
  offlineVaultService,
  mediaHydrationEngine,
  federator,
  getMainWindow,
  sendRendererEvent,
  userDataDir,
  dnsLookup,
  options: handlerOptions = {},
}) {
  if (!rawIpcMain || !offlineVaultService) {
    return { dispose: () => {} };
  }
  const ipcMain = wrapIpcMainWithSenderCheck(rawIpcMain, {
    getMainWindow,
    isPackaged: Boolean(handlerOptions.isPackaged),
    allowedDevOrigin: handlerOptions.allowedDevOrigin || null,
    expectedFileHref: handlerOptions.expectedFileHref || null,
  });

  const { dispose } = registerVaultQueryAndHydrationIpcHandlers({
    ipcMain,
    offlineVaultService,
    mediaHydrationEngine,
    federator,
    getMainWindow,
    sendRendererEvent,
    dnsLookup,
  });

  registerUserOverridesIpcHandlers({
    ipcMain,
    offlineVaultService,
    userDataDir,
  });

  return {
    dispose,
  };
}

module.exports = {
  registerOfflineVaultIpcHandlers,
  createOlMediaProtocolHandler,
  trimUserOverridesCache,
  readUserOverridesFromDisk,
  readUserOverridesAsync,
  writeUserOverridesToDiskAsync,
  readUserTagOverridesFromDisk,
  readUserTagOverridesAsync,
  writeUserTagOverridesToDiskAsync,
  sanitizeUserTagOverrideRecord,
};
