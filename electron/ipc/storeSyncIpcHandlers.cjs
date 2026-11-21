// @ts-check
'use strict';

const { wrapIpcMainWithSenderCheck } = require('../launcher/securityAndPathUtils.cjs');
const { trimSteamLocalScannerMemory } = require('../storefronts/steamLocalScanner.cjs');
const {
  STORE_OAUTH_URLS,
  createEpicAuthRecovery,
} = require('../storefronts/epicAuthRecovery.cjs');
const {
  STOREFRONT_OAUTH_PARTITIONS,
  readSyncResultMeta,
  resolveStorefrontOAuthPartition,
  sanitizeStoreTokenEntryForRenderer,
  registerOAuthPopupHandlers,
} = require('./storeSync/oauthPopupWindows.cjs');
const { registerStorefrontCatalogIpcHandlers } = require('./storeSync/storefrontCatalogIpc.cjs');
const {
  buildHltbSearchTermPasses,
  registerHltbSearchIpcHandler,
} = require('./storeSync/hltbSearchIpc.cjs');

/**
 * Register all Storefront OAuth, Catalog Sync, Achievement, HLTB & IGDB IPC handlers.
 * Thin facade over `electron/ipc/storeSync/{oauthPopupWindows,storefrontCatalogIpc,hltbSearchIpc}.cjs`.
 *
 * @param {{
 *   ipcMain: any,
 *   BrowserWindow: any,
 *   session: any,
 *   getMainWindow: () => any,
 *   storeSync: any,
 *   launcherEngine: any,
 *   options?: Record<string, any>
 * }} deps
 */
function registerStoreSyncIpcHandlers({
  ipcMain: rawIpcMain,
  BrowserWindow,
  session,
  getMainWindow,
  storeSync,
  launcherEngine,
  options: handlerOptions = {},
}) {
  if (!rawIpcMain) return { trimStoreSyncIpcMemory: trimSteamLocalScannerMemory };
  const ipcMain = wrapIpcMainWithSenderCheck(rawIpcMain, {
    getMainWindow,
    isPackaged: Boolean(handlerOptions.isPackaged),
    allowedDevOrigin: handlerOptions.allowedDevOrigin || null,
    expectedFileHref: handlerOptions.expectedFileHref || null,
  });
  trimSteamLocalScannerMemory();

  const recoverEpicAuthSession = createEpicAuthRecovery({
    BrowserWindow,
    getMainWindow,
    storeSync,
    launcherEngine,
  });

  if (typeof launcherEngine?.setEpicAuthRecoveryHook === 'function') {
    launcherEngine.setEpicAuthRecoveryHook(recoverEpicAuthSession);
  }

  /**
   * Process OAuth / TokenBroker exchange and full library entitlement synchronization.
   *
   * @param {string} storefrontId
   * @param {any} codeOrPayload
   */
  async function processStoreAuth(storefrontId, codeOrPayload) {
    let accountName = 'Verified User';
    let avatarUrl;
    /** @type {any[]} */
    let games = [];
    let tokenData = null;
    let authoritativeComplete = false;
    const codeLabel =
      storefrontId === 'xbox'
        ? 'xbox_token_broker'
        : typeof codeOrPayload === 'string'
          ? codeOrPayload
          : typeof codeOrPayload?.code === 'string'
            ? codeOrPayload.code
            : 'xbox_token_broker';

    try {
      launcherEngine?.clearStoreDisconnectedTombstone?.(storefrontId);
      if (storefrontId === 'gog') {
        tokenData = await storeSync.exchangeGogCode(codeLabel);
        const account = await storeSync.fetchGogAccount(tokenData.access_token);
        accountName = account.username || 'GOG User';
        avatarUrl = account.avatarUrl;
        games = await storeSync.fetchGogOwnedGames(
          tokenData.access_token,
          accountName,
          account.userId
        );
        authoritativeComplete = readSyncResultMeta(
          games,
          storeSync.fetchGogOwnedGames
        ).authoritativeComplete;
      } else if (storefrontId === 'epic') {
        tokenData = await storeSync.exchangeEpicCode(codeLabel);
        accountName = tokenData.displayName || tokenData.account_id || 'Epic Games User';
        games = await storeSync.fetchEpicOwnedGames(tokenData.access_token, tokenData.account_id);
        authoritativeComplete = readSyncResultMeta(
          games,
          storeSync.fetchEpicOwnedGames
        ).authoritativeComplete;
      } else if (storefrontId === 'xbox') {
        const xboxRes = await storeSync.loginXbox(codeOrPayload);
        if (xboxRes && xboxRes.requiresInlineConsent) {
          return xboxRes;
        }
        accountName = xboxRes.accountName || xboxRes.gamertag || 'Xbox Player';
        avatarUrl = xboxRes.avatarUrl;
        games = xboxRes.games || [];
        const savedXboxRaw = storeSync.loadSavedTokens()?.xbox || {
          connected: true,
          accountName,
          gamertag: xboxRes.gamertag || accountName,
          xuid: xboxRes.xuid,
          avatarUrl,
          subscription: xboxRes.subscription,
          syncMode: xboxRes.syncMode,
        };
        tokenData = sanitizeStoreTokenEntryForRenderer('xbox', savedXboxRaw, storeSync);
        return {
          success: true,
          code: codeLabel,
          storefrontId,
          accountName,
          accountId: xboxRes.xuid,
          xuid: xboxRes.xuid,
          avatarUrl,
          gamerscore: xboxRes.gamerscore || 0,
          subscription: xboxRes.subscription,
          syncMode: xboxRes.syncMode,
          authoritativeComplete: Boolean(xboxRes.authoritativeComplete),
          subscriptionChanged: Boolean(xboxRes.subscriptionChanged),
          transientOffline: games.length === 0 && !xboxRes.authoritativeComplete,
          games,
          achievements: xboxRes.achievements || {},
          suppressedItems: xboxRes.suppressedItems || [],
          tokenData,
        };
      }

      return {
        success: true,
        code: codeLabel,
        storefrontId,
        accountName,
        avatarUrl,
        games,
        authoritativeComplete,
        tokenData: sanitizeStoreTokenEntryForRenderer(storefrontId, tokenData, storeSync),
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (storefrontId === 'xbox' && !tokenData) {
        const anyErr = /** @type {any} */ (err);
        return {
          success: false,
          storefrontId,
          error: msg,
          errorCode: anyErr?.code,
          xerr: anyErr?.xerr,
          redirectUrl: anyErr?.redirectUrl,
        };
      }
      console.warn(`Post-login sync warning for ${storefrontId}:`, msg);
      return {
        success: true,
        code: codeLabel,
        storefrontId,
        accountName,
        avatarUrl,
        games: [],
        syncError: msg,
        tokenData: sanitizeStoreTokenEntryForRenderer(storefrontId, tokenData, storeSync),
      };
    }
  }

  const { recoverXboxStoreLicenseSession } = registerOAuthPopupHandlers({
    ipcMain,
    BrowserWindow,
    session,
    getMainWindow,
    storeSync,
    launcherEngine,
    processStoreAuth,
    handlerOptions,
  });

  if (typeof launcherEngine?.setXboxStoreLicenseRecoveryHook === 'function') {
    launcherEngine.setXboxStoreLicenseRecoveryHook(recoverXboxStoreLicenseSession);
  }

  registerStorefrontCatalogIpcHandlers({
    ipcMain,
    BrowserWindow,
    session,
    storeSync,
    launcherEngine,
    processStoreAuth,
    handlerOptions,
  });

  registerHltbSearchIpcHandler({
    ipcMain,
    session,
  });

  return {
    trimStoreSyncIpcMemory: trimSteamLocalScannerMemory,
  };
}

module.exports = {
  registerStoreSyncIpcHandlers,
  STORE_OAUTH_URLS,
  STOREFRONT_OAUTH_PARTITIONS,
  resolveStorefrontOAuthPartition,
  sanitizeStoreTokenEntryForRenderer,
  buildHltbSearchTermPasses,
};
