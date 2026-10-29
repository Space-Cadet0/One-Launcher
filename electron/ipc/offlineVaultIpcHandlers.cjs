// @ts-check
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { Readable } = require('node:stream');
const { sanitizeRendererIpcOptions } = require('./launcherIpcHandlers.cjs');
const {
  assertSafePublicHttpsUrl,
  atomicWriteFileSync,
  resolveEffectiveUserDataDir,
} = require('../launcher/securityAndPathUtils.cjs');

/**
 * Creates the `ol-media://` custom streaming protocol handler backed by `OfflineVaultService`.
 * Enforces `assertSafePublicHttpsUrl` SSRF/DNS-rebinding protection on remote fallback URLs
 * and omits `Access-Control-Allow-Origin: *` so cross-origin embedded frames cannot read vault media.
 *
 * @param {{ offlineVaultService: any, dnsLookup?: any }} deps
 */
function createOlMediaProtocolHandler({ offlineVaultService, dnsLookup }) {
  return async function handleOlMediaRequest(/** @type {any} */ request) {
    try {
      const rawReqUrl = String(request?.url || '');
      if (!rawReqUrl.startsWith('ol-media://')) {
        return new Response(null, {
          status: 400,
          headers: { 'Cache-Control': 'no-store' },
        });
      }

      const parsed = new URL(rawReqUrl);
      const sp = parsed.searchParams;
      const params = {
        gameId: sp.get('gameId') || '',
        role: sp.get('role') || 'cover',
        ordinal: Number(sp.get('ord') || 0),
        url: sp.get('url') || '',
        steamAppId: sp.get('steamAppId') || '',
        gogId: sp.get('gogId') || '',
        epicAppName: sp.get('epicApp') || sp.get('epicAppName') || '',
      };

      if (params.url) {
        try {
          await assertSafePublicHttpsUrl(
            params.url,
            typeof dnsLookup === 'function' ? { dnsLookup } : undefined
          );
        } catch (urlErr) {
          const anyErr = /** @type {any} */ (urlErr);
          if (!anyErr?.isDnsUnavailable || typeof dnsLookup === 'function') {
            return new Response(null, {
              status: 403,
              headers: { 'Cache-Control': 'no-store' },
            });
          }
          // OS DNS is offline or domain is unresolvable (and already verified as `https:` with a
          // public multi-label hostname and zero private IP literals): delegate to `offlineVaultService`
          // so local SQLite/disk blobs and injected offline/test fetch handlers work seamlessly.
        }
      }

      const resolved = await offlineVaultService.resolveMediaRequest(params, {
        signal: request?.signal,
      });

      if (!resolved || resolved.kind === 'error') {
        const status =
          typeof resolved?.status === 'number' && resolved.status >= 400 && resolved.status <= 599
            ? resolved.status
            : 404;
        return new Response(null, {
          status,
          headers: {
            'Cache-Control': 'no-store',
          },
        });
      }

      if (resolved.kind === 'buffer' && Buffer.isBuffer(resolved.buffer)) {
        return new Response(/** @type {any} */ (resolved.buffer), {
          status: 200,
          headers: {
            'Content-Type': resolved.mimeType || 'image/jpeg',
            'Content-Length': String(resolved.buffer.length),
            'Cache-Control': resolved.cacheControl || 'public, max-age=31536000, immutable',
          },
        });
      }

      if (resolved.kind === 'file' && typeof resolved.filePath === 'string') {
        const nodeStream = fs.createReadStream(resolved.filePath);
        nodeStream.on('error', () => {
          try {
            nodeStream.destroy();
          } catch {}
        });
        if (request?.signal) {
          if (request.signal.aborted) {
            nodeStream.destroy();
            return new Response(null, { status: 499 });
          }
          request.signal.addEventListener(
            'abort',
            () => {
              try {
                nodeStream.destroy();
              } catch {}
            },
            { once: true }
          );
        }

        const webStream = Readable.toWeb(nodeStream);
        /** @type {Record<string, string>} */
        const headers = {
          'Content-Type': resolved.mimeType || 'image/jpeg',
          'Cache-Control': resolved.cacheControl || 'public, max-age=31536000, immutable',
        };
        if (typeof resolved.sizeBytes === 'number' && resolved.sizeBytes > 0) {
          headers['Content-Length'] = String(resolved.sizeBytes);
        }
        return new Response(/** @type {any} */ (webStream), {
          status: 200,
          headers,
        });
      }

      return new Response(null, {
        status: 404,
        headers: { 'Cache-Control': 'no-store' },
      });
    } catch {
      return new Response(null, {
        status: 500,
        headers: { 'Cache-Control': 'no-store' },
      });
    }
  };
}

/**
 * Resolve the atomic persistence path for `user_overrides.json`.
 * @param {any} offlineVaultService
 * @param {string | undefined} explicitUserDataDir
 * @returns {string}
 */
function resolveUserOverridesFilePath(offlineVaultService, explicitUserDataDir) {
  if (typeof explicitUserDataDir === 'string' && explicitUserDataDir.trim()) {
    return path.join(explicitUserDataDir.trim(), 'user_overrides.json');
  }
  if (typeof offlineVaultService?.userDataDir === 'string' && offlineVaultService.userDataDir.trim()) {
    return path.join(offlineVaultService.userDataDir.trim(), 'user_overrides.json');
  }
  if (typeof offlineVaultService?.vaultDir === 'string' && offlineVaultService.vaultDir.trim()) {
    return path.join(path.dirname(offlineVaultService.vaultDir.trim()), 'user_overrides.json');
  }
  return path.join(resolveEffectiveUserDataDir(), 'user_overrides.json');
}

/**
 * Read durable user metadata/artwork overrides map from `userData/user_overrides.json`.
 * @param {string} filePath
 * @returns {Record<string, Record<string, any>>}
 */
function readUserOverridesFromDisk(filePath) {
  try {
    if (!fs.existsSync(filePath)) return {};
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    const rawMap =
      parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? parsed.overrides && typeof parsed.overrides === 'object' && !Array.isArray(parsed.overrides)
          ? parsed.overrides
          : parsed
        : {};
    /** @type {Record<string, Record<string, any>>} */
    const cleanMap = {};
    for (const [k, v] of Object.entries(rawMap)) {
      if (k === '__proto__' || k === 'constructor' || k === 'prototype') continue;
      if (v && typeof v === 'object' && !Array.isArray(v)) {
        cleanMap[k] = sanitizeRendererIpcOptions(v);
      }
    }
    return cleanMap;
  } catch {
    return {};
  }
}

/**
 * Validate a `gameId` key for user override storage.
 * @param {unknown} rawGameId
 * @returns {string}
 */
function normalizeSafeOverrideGameId(rawGameId) {
  if (typeof rawGameId !== 'string') return '';
  const trimmed = rawGameId.trim();
  if (
    !trimmed ||
    trimmed.length > 256 ||
    trimmed.includes('\0') ||
    trimmed === '__proto__' ||
    trimmed === 'constructor' ||
    trimmed === 'prototype'
  ) {
    return '';
  }
  return trimmed;
}

/**
 * Registers all `offlineVault:*` and user-override IPC channels, forwarding background health
 * and hydration events to the active BrowserWindow renderer (or daemon event buffer).
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
 * }} deps
 */
function registerOfflineVaultIpcHandlers({
  ipcMain,
  offlineVaultService,
  mediaHydrationEngine,
  federator,
  getMainWindow,
  sendRendererEvent,
  userDataDir,
  dnsLookup,
}) {
  if (!ipcMain || !offlineVaultService) {
    return { dispose: () => {} };
  }

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
            steamAppId:
              typeof cleanPayload.steamAppId === 'number' ? cleanPayload.steamAppId : null,
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
    }
    return await offlineVaultService.checkUrlStatus(urlStr);
  };

  ipcMain.handle('offlineVault:check-url-status', handleCheckUrlStatus);
  ipcMain.handle('vault:check-url-status', handleCheckUrlStatus);

  // Durable User Metadata & Artwork Overrides (`userData/user_overrides.json`)
  const handleGetUserOverrides = async () => {
    const filePath = resolveUserOverridesFilePath(offlineVaultService, userDataDir);
    return readUserOverridesFromDisk(filePath);
  };

  const handleSaveUserOverride = async (
    /** @type {any} */ _event,
    /** @type {unknown} */ arg1,
    /** @type {unknown} */ arg2
  ) => {
    let gameId = '';
    /** @type {Record<string, any>} */
    let patch = {};

    if (typeof arg1 === 'string') {
      gameId = normalizeSafeOverrideGameId(arg1);
      patch = sanitizeRendererIpcOptions(arg2);
    } else if (arg1 && typeof arg1 === 'object' && !Array.isArray(arg1)) {
      const cleanObj = sanitizeRendererIpcOptions(arg1);
      gameId = normalizeSafeOverrideGameId(cleanObj.gameId || cleanObj.id);
      if (cleanObj.override && typeof cleanObj.override === 'object' && !Array.isArray(cleanObj.override)) {
        patch = sanitizeRendererIpcOptions(cleanObj.override);
      } else {
        patch = { ...cleanObj };
        delete patch.id;
      }
    }

    if (!gameId) {
      return { success: false, error: 'Invalid or missing gameId for user override.' };
    }

    const filePath = resolveUserOverridesFilePath(offlineVaultService, userDataDir);
    const current = readUserOverridesFromDisk(filePath);
    const updatedRecord = {
      ...(current[gameId] || {}),
      ...patch,
      gameId,
      updatedAt: new Date().toISOString(),
    };
    const nextOverrides = {
      ...current,
      [gameId]: updatedRecord,
    };

    atomicWriteFileSync(
      filePath,
      JSON.stringify({ overrides: nextOverrides, updatedAt: updatedRecord.updatedAt }, null, 2)
    );

    if (typeof offlineVaultService.saveUserOverride === 'function') {
      try {
        offlineVaultService.saveUserOverride(gameId, updatedRecord);
      } catch {}
    }

    return {
      success: true,
      gameId,
      override: updatedRecord,
      overrides: nextOverrides,
    };
  };

  const handleRemoveUserOverride = async (
    /** @type {any} */ _event,
    /** @type {unknown} */ rawArg
  ) => {
    const rawId =
      typeof rawArg === 'string'
        ? rawArg
        : rawArg && typeof rawArg === 'object'
          ? /** @type {any} */ (rawArg).gameId || /** @type {any} */ (rawArg).id
          : '';
    const gameId = normalizeSafeOverrideGameId(rawId);
    if (!gameId) {
      return { success: false, error: 'Invalid or missing gameId for user override removal.' };
    }

    const filePath = resolveUserOverridesFilePath(offlineVaultService, userDataDir);
    const current = readUserOverridesFromDisk(filePath);
    const nextOverrides = { ...current };
    delete nextOverrides[gameId];

    atomicWriteFileSync(
      filePath,
      JSON.stringify({ overrides: nextOverrides, updatedAt: new Date().toISOString() }, null, 2)
    );

    if (typeof offlineVaultService.removeUserOverride === 'function') {
      try {
        offlineVaultService.removeUserOverride(gameId);
      } catch {}
    }

    return {
      success: true,
      gameId,
      overrides: nextOverrides,
    };
  };

  ipcMain.handle('offlineVault:get-user-overrides', handleGetUserOverrides);
  ipcMain.handle('offlineVault:save-user-override', handleSaveUserOverride);
  ipcMain.handle('offlineVault:remove-user-override', handleRemoveUserOverride);
  ipcMain.handle('vault:get-user-overrides', handleGetUserOverrides);
  ipcMain.handle('vault:save-user-override', handleSaveUserOverride);
  ipcMain.handle('vault:remove-user-override', handleRemoveUserOverride);

  return {
    dispose: () => {
      unsubHealth();
      unsubHydrated();
      unsubProgress();
    },
  };
}

module.exports = {
  registerOfflineVaultIpcHandlers,
  createOlMediaProtocolHandler,
};
