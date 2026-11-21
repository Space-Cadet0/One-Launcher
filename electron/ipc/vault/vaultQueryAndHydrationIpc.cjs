// @ts-check
'use strict';

const { sanitizeRendererIpcOptions } = require('../launcher/launchApprovalIpc.cjs');
const { assertSafePublicHttpsUrl } = require('../../launcher/securityAndPathUtils.cjs');
const { normalizeSafeOverrideGameId } = require('./userOverridesStoreIpc.cjs');

/**
 * Normalize an optional `steamAppId` accepting both positive integer numbers and numeric strings.
 *
 * @param {unknown} rawSteamAppId
 * @returns {number | null}
 */
function parseOptionalSteamAppId(rawSteamAppId) {
  if (
    typeof rawSteamAppId === 'number' &&
    Number.isSafeInteger(rawSteamAppId) &&
    rawSteamAppId > 0
  ) {
    return rawSteamAppId;
  }
  if (typeof rawSteamAppId === 'string' && /^\d+$/.test(rawSteamAppId.trim())) {
    const parsed = Number.parseInt(rawSteamAppId.trim(), 10);
    if (Number.isSafeInteger(parsed) && parsed > 0) {
      return parsed;
    }
  }
  return null;
}

/**
 * Register core `offlineVault:*` catalog query, detail persistence, hydration, and
 * SSRF-guarded URL probe IPC handlers + lifecycle event forwarders.
 *
 * @param {{
 *   ipcMain: any,
 *   offlineVaultService: any,
 *   mediaHydrationEngine: any,
 *   federator?: any,
 *   getMainWindow?: () => any,
 *   sendRendererEvent?: (channel: string, payload: any) => void,
 *   dnsLookup?: any,
 * }} deps
 */
function registerVaultQueryAndHydrationIpcHandlers({
  ipcMain,
  offlineVaultService,
  mediaHydrationEngine,
  federator,
  getMainWindow,
  sendRendererEvent,
  dnsLookup,
}) {
  const sendToRenderer = (/** @type {string} */ channel, /** @type {any} */ payload) => {
    if (typeof sendRendererEvent === 'function') {
      sendRendererEvent(channel, payload);
      return;
    }
    try {
      const win = typeof getMainWindow === 'function' ? getMainWindow() : null;
      if (win && !win.isDestroyed?.() && win.webContents) {
        win.webContents.send(channel, payload);
      }
    } catch {}
  };

  const unsubHealth =
    typeof offlineVaultService.onHealthChanged === 'function'
      ? offlineVaultService.onHealthChanged((/** @type {any} */ snapshot) => {
          sendToRenderer('offlineVault:health-changed', snapshot);
        })
      : () => {};

  const unsubHydrated =
    mediaHydrationEngine && typeof mediaHydrationEngine.onGameHydrated === 'function'
      ? mediaHydrationEngine.onGameHydrated((/** @type {any} */ payload) => {
          sendToRenderer('offlineVault:game-hydrated', payload);
        })
      : () => {};

  const unsubProgress =
    mediaHydrationEngine && typeof mediaHydrationEngine.onHydrationProgress === 'function'
      ? mediaHydrationEngine.onHydrationProgress((/** @type {any} */ payload) => {
          sendToRenderer('offlineVault:hydration-progress', payload);
        })
      : () => {};

  ipcMain.handle('offlineVault:get-stats', async () => {
    return offlineVaultService.getStats();
  });

  ipcMain.handle(
    'offlineVault:set-tier',
    async (/** @type {any} */ _event, /** @type {unknown} */ tier) => {
      return offlineVaultService.setTier(typeof tier === 'string' ? tier : '');
    }
  );

  ipcMain.handle(
    'offlineVault:clear',
    async (/** @type {any} */ _event, /** @type {unknown} */ options) => {
      return offlineVaultService.clear(sanitizeRendererIpcOptions(options));
    }
  );

  ipcMain.handle('offlineVault:get-catalog-snapshot', async () => {
    return offlineVaultService.getCatalogSnapshot();
  });

  ipcMain.handle(
    'offlineVault:upsert-games',
    async (/** @type {any} */ _event, /** @type {unknown} */ games) => {
      if (!Array.isArray(games)) {
        return { success: false, error: 'Expected array of games' };
      }
      const cleanGames = games
        .filter((g) => g && typeof g === 'object')
        .map((g) => sanitizeRendererIpcOptions(g));
      return offlineVaultService.upsertGames(cleanGames);
    }
  );

  ipcMain.handle(
    'offlineVault:delete-games',
    async (/** @type {any} */ _event, /** @type {unknown} */ rawGameIds) => {
      if (typeof offlineVaultService.deleteGames !== 'function') {
        return { success: false, deleted: 0, error: 'deleteGames unsupported' };
      }
      const list = Array.isArray(rawGameIds)
        ? rawGameIds
        : rawGameIds &&
            typeof rawGameIds === 'object' &&
            Array.isArray(/** @type {any} */ (rawGameIds).gameIds)
          ? /** @type {any} */ (rawGameIds).gameIds
          : typeof rawGameIds === 'string'
            ? [rawGameIds]
            : [];
      const safeIds = list
        .map((item) => normalizeSafeOverrideGameId(item))
        .filter((id) => Boolean(id));
      return offlineVaultService.deleteGames(safeIds);
    }
  );

  ipcMain.handle(
    'offlineVault:set-modal-busy',
    async (/** @type {any} */ _event, /** @type {unknown} */ rawBusy) => {
      const isBusy =
        typeof rawBusy === 'boolean'
          ? rawBusy
          : rawBusy && typeof rawBusy === 'object'
            ? Boolean(
                /** @type {any} */ (rawBusy).isBusy ?? /** @type {any} */ (rawBusy).busy ?? false
              )
            : Boolean(rawBusy);
      if (mediaHydrationEngine && typeof mediaHydrationEngine.setModalBusy === 'function') {
        return mediaHydrationEngine.setModalBusy(isBusy);
      }
      return { success: true, isPausedForModal: isBusy };
    }
  );

  ipcMain.handle(
    'offlineVault:get-game-detail',
    async (/** @type {any} */ _event, /** @type {unknown} */ gameId) => {
      return offlineVaultService.getGameDetail(typeof gameId === 'string' ? gameId : '');
    }
  );

  ipcMain.handle(
    'offlineVault:save-game-detail',
    async (/** @type {any} */ _event, /** @type {unknown} */ payload) => {
      return offlineVaultService.saveGameDetail(sanitizeRendererIpcOptions(payload));
    }
  );

  ipcMain.handle(
    'offlineVault:resolve-local-metadata',
    async (/** @type {any} */ _event, /** @type {unknown} */ payload) => {
      const cleanPayload = sanitizeRendererIpcOptions(payload);
      const activeFederator = federator || offlineVaultService.federator;
      const metadata =
        activeFederator && typeof activeFederator.resolveLocalMetadata === 'function'
          ? activeFederator.resolveLocalMetadata(cleanPayload)
          : null;

      if (metadata && cleanPayload.gameId) {
        try {
          offlineVaultService.saveGameDetail({
            gameId: String(cleanPayload.gameId),
            canonicalTitle: cleanPayload.title || metadata.name || '',
            steamAppId: parseOptionalSteamAppId(cleanPayload.steamAppId),
            enrichedMetadata: metadata,
            metadataQuality: 'local_federated',
          });
        } catch {}
      }

      return {
        success: Boolean(metadata),
        metadata: metadata || null,
      };
    }
  );

  ipcMain.handle(
    'offlineVault:queue-hydration',
    async (/** @type {any} */ _event, /** @type {unknown} */ payload) => {
      if (!mediaHydrationEngine) {
        return { success: false, queued: 0 };
      }
      const cleanPayload = sanitizeRendererIpcOptions(payload);
      const rawGames = Array.isArray(cleanPayload.games) ? cleanPayload.games : [];
      const sanitizedGames = rawGames
        .filter((g) => g && typeof g === 'object')
        .map((g) => sanitizeRendererIpcOptions(g));
      return mediaHydrationEngine.queueHydration({ games: sanitizedGames });
    }
  );

  const handleCheckUrlStatus = async (/** @type {any} */ _event, /** @type {unknown} */ rawUrl) => {
    const urlStr = typeof rawUrl === 'string' ? rawUrl.trim() : '';
    try {
      await assertSafePublicHttpsUrl(
        urlStr,
        typeof dnsLookup === 'function' ? { dnsLookup } : undefined
      );
    } catch (urlErr) {
      const anyErr = /** @type {any} */ (urlErr);
      if (!anyErr?.isDnsUnavailable || typeof dnsLookup === 'function') {
        return {
          online: false,
          status: null,
          isDefinitive404: false,
          isWafOrRateLimited: false,
          blocked: true,
          error: anyErr?.message || 'Blocked unsafe URL',
        };
      }
      if (!offlineVaultService?.hasCustomFetchImpl) {
        return {
          online: false,
          status: null,
          isDefinitive404: false,
          isWafOrRateLimited: false,
          error: anyErr?.message || 'DNS unavailable',
        };
      }
    }
    return await offlineVaultService.checkUrlStatus(urlStr);
  };

  ipcMain.handle('offlineVault:check-url-status', handleCheckUrlStatus);

  return {
    dispose: () => {
      unsubHealth();
      unsubHydrated();
      unsubProgress();
    },
  };
}

module.exports = {
  parseOptionalSteamAppId,
  registerVaultQueryAndHydrationIpcHandlers,
};
