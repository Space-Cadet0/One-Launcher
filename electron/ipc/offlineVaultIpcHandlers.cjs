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
  toHostFilesystemPath,
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
        ordinal: Number(sp.get('ord') || sp.get('ordinal') || 0),
        url: sp.get('url') || '',
        ov: sp.get('ov') || '',
        steamAppId: sp.get('steamAppId') || '',
        gogId: sp.get('gogId') || '',
        epicAppName: sp.get('epicApp') || sp.get('epicAppName') || '',
        xboxProductId: sp.get('xboxProductId') || sp.get('xid') || '',
        packageFamilyName: sp.get('pfn') || sp.get('packageFamilyName') || '',
        pfn: sp.get('pfn') || sp.get('packageFamilyName') || '',
        xboxTitleId: sp.get('xboxTitleId') || sp.get('xtid') || '',
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

/** @type {Map<string, { mtimeMs: number, overrides: Record<string, Record<string, any>> }>} */
const userOverridesMemoryCache = new Map();
/** @type {Map<string, Promise<any>>} */
const userOverridesWriteQueues = new Map();
let userOverridesTmpSeq = 0;

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
 * Normalizes a `(platformId, platformGameId)` pair for cross-key override deduplication.
 * @param {unknown} rawPlatformId
 * @param {unknown} rawPlatformGameId
 * @returns {{ platformId: string, platformGameId: string } | null}
 */
function normalizeEntitlementPair(rawPlatformId, rawPlatformGameId) {
  const platformId = typeof rawPlatformId === 'string' ? rawPlatformId.trim().toLowerCase() : '';
  const rawPid =
    typeof rawPlatformGameId === 'string' || typeof rawPlatformGameId === 'number'
      ? String(rawPlatformGameId).trim()
      : '';
  if (!platformId || !rawPid) return null;
  const platformGameId =
    platformId === 'xbox' && /^[A-Z0-9]{12}$/i.test(rawPid) ? rawPid.toUpperCase() : rawPid;
  return { platformId, platformGameId };
}

/**
 * Extracts the underlying storefront `(platformId, platformGameId)` entitlement identity from
 * an override map key and record across modern (`platformId` + `platformGameId`) and legacy
 * (`<store>-<id>` / `matchedStore` + `matchedId`) override schemas.
 *
 * @param {string} key
 * @param {Record<string, any> | null | undefined} ov
 * @returns {{ platformId: string, platformGameId: string } | null}
 */
function extractOverrideEntitlementPair(key, ov) {
  if (ov && typeof ov === 'object') {
    const explicit = normalizeEntitlementPair(ov.platformId, ov.platformGameId);
    if (explicit) return explicit;
  }

  const candidateIds = [key, typeof ov?.gameId === 'string' ? ov.gameId : ''];
  for (const cid of candidateIds) {
    if (!cid) continue;
    const nonSteamPrefix = cid.match(/^(gog|epic|xbox|ea|ubisoft|local)[:_-](.+)$/i);
    if (nonSteamPrefix) {
      const pair = normalizeEntitlementPair(nonSteamPrefix[1], nonSteamPrefix[2]);
      if (pair) return pair;
    }
  }

  if (ov && typeof ov === 'object') {
    const mStore = typeof ov.matchedStore === 'string' ? ov.matchedStore.trim().toLowerCase() : '';
    if (mStore && mStore !== 'steam' && ov.matchedId != null) {
      const legacyMatched = normalizeEntitlementPair(mStore, ov.matchedId);
      if (legacyMatched) return legacyMatched;
    }
  }

  for (const cid of candidateIds) {
    if (!cid) continue;
    const steamPrefix = cid.match(/^steam[:_-](\d+)$/i);
    if (steamPrefix) {
      return normalizeEntitlementPair('steam', steamPrefix[1]);
    }
  }

  return null;
}

/**
 * Adds a safe override key and its `:`, `-`, and `_` storefront separator variants to `targetSet`.
 * @param {Set<string>} targetSet
 * @param {unknown} rawKey
 */
function addOverrideKeyVariants(targetSet, rawKey) {
  const safe = normalizeSafeOverrideGameId(rawKey);
  if (!safe) return;
  targetSet.add(safe);
  const match = safe.match(/^(steam|gog|epic|xbox|ea|ubisoft|local)[:_-](.+)$/i);
  if (match) {
    const prefix = match[1].toLowerCase();
    const rest = match[2].trim();
    if (rest) {
      targetSet.add(`${prefix}:${rest}`);
      targetSet.add(`${prefix}-${rest}`);
      targetSet.add(`${prefix}_${rest}`);
      if (prefix === 'xbox' && /^[A-Z0-9]{12}$/i.test(rest)) {
        const up = rest.toUpperCase();
        const lo = rest.toLowerCase();
        targetSet.add(`xbox:${up}`);
        targetSet.add(`xbox:${lo}`);
        targetSet.add(`xbox-${up}`);
        targetSet.add(`xbox-${lo}`);
        targetSet.add(`xbox_${up}`);
        targetSet.add(`xbox_${lo}`);
      }
    }
  }
}

/**
 * Extracts positive numeric Steam App IDs referenced by an override key or record.
 * @param {string} key
 * @param {Record<string, any> | null | undefined} ov
 * @returns {number[]}
 */
function extractLinkedSteamAppIds(key, ov) {
  /** @type {Set<number>} */
  const ids = new Set();
  const addCandidate = (/** @type {unknown} */ val) => {
    if (typeof val === 'number' && Number.isInteger(val) && val > 0) {
      ids.add(val);
    } else if (typeof val === 'string' && /^\d+$/.test(val.trim())) {
      const parsed = parseInt(val.trim(), 10);
      if (parsed > 0) ids.add(parsed);
    }
  };

  const keyMatch = String(key || '').match(/^steam[:_-](\d+)$/i);
  if (keyMatch) addCandidate(keyMatch[1]);

  if (ov && typeof ov === 'object') {
    const gidMatch = String(ov.gameId || '').match(/^steam[:_-](\d+)$/i);
    if (gidMatch) addCandidate(gidMatch[1]);
    addCandidate(ov.steamAppId);
    if (String(ov.matchedStore || '').trim().toLowerCase() === 'steam') {
      addCandidate(ov.matchedId);
    }
  }

  return Array.from(ids);
}

/**
 * Parse and sanitize raw JSON text from `user_overrides.json`.
 * @param {string} rawText
 * @returns {Record<string, Record<string, any>>}
 */
function parseSanitizedUserOverridesJson(rawText) {
  const parsed = JSON.parse(rawText);
  const rawMap =
    parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed.overrides && typeof parsed.overrides === 'object' && !Array.isArray(parsed.overrides)
        ? parsed.overrides
        : parsed
      : {};
  /** @type {Record<string, Record<string, any>>} */
  const cleanMap = {};
  for (const [k, v] of Object.entries(rawMap)) {
    const safeKey = normalizeSafeOverrideGameId(k);
    if (!safeKey) continue;
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      cleanMap[safeKey] = sanitizeRendererIpcOptions(v);
    }
  }
  return cleanMap;
}

/**
 * Read durable user metadata/artwork overrides map synchronously from `userData/user_overrides.json`.
 * @param {string} filePath
 * @returns {Record<string, Record<string, any>>}
 */
function readUserOverridesFromDisk(filePath) {
  const hostFilePath = toHostFilesystemPath(filePath);
  try {
    if (!fs.existsSync(hostFilePath)) {
      userOverridesMemoryCache.delete(hostFilePath);
      return {};
    }
    const stat = fs.statSync(hostFilePath);
    const cached = userOverridesMemoryCache.get(hostFilePath);
    if (cached && cached.mtimeMs === stat.mtimeMs) {
      return { ...cached.overrides };
    }
    const cleanMap = parseSanitizedUserOverridesJson(fs.readFileSync(hostFilePath, 'utf8'));
    userOverridesMemoryCache.set(hostFilePath, {
      mtimeMs: stat.mtimeMs,
      overrides: cleanMap,
    });
    return { ...cleanMap };
  } catch {
    return {};
  }
}

/**
 * Read durable user metadata/artwork overrides map asynchronously with `mtimeMs`-validated in-memory caching.
 * @param {string} filePath
 * @returns {Promise<Record<string, Record<string, any>>>}
 */
async function readUserOverridesAsync(filePath) {
  const hostFilePath = toHostFilesystemPath(filePath);
  try {
    let stat = null;
    try {
      stat = await fs.promises.stat(hostFilePath);
    } catch {
      stat = null;
    }
    if (!stat || !stat.isFile()) {
      userOverridesMemoryCache.delete(hostFilePath);
      return {};
    }
    const cached = userOverridesMemoryCache.get(hostFilePath);
    if (cached && cached.mtimeMs === stat.mtimeMs) {
      return { ...cached.overrides };
    }
    const rawText = await fs.promises.readFile(hostFilePath, 'utf8');
    const cleanMap = parseSanitizedUserOverridesJson(rawText);
    userOverridesMemoryCache.set(hostFilePath, {
      mtimeMs: stat.mtimeMs,
      overrides: cleanMap,
    });
    return { ...cleanMap };
  } catch {
    return {};
  }
}

/**
 * Enqueue a serialized async read/write task per resolved `user_overrides.json` path so concurrent
 * IPC mutations never race on `.tmp` files or clobber sibling keys.
 *
 * @template T
 * @param {string} filePath
 * @param {(hostFilePath: string) => Promise<T>} taskFn
 * @returns {Promise<T>}
 */
function enqueueUserOverridesTask(filePath, taskFn) {
  const hostFilePath = toHostFilesystemPath(filePath);
  const prev = userOverridesWriteQueues.get(hostFilePath) || Promise.resolve();
  const next = prev.catch(() => {}).then(() => taskFn(hostFilePath));
  const tracked = next.finally(() => {
    if (userOverridesWriteQueues.get(hostFilePath) === tracked) {
      userOverridesWriteQueues.delete(hostFilePath);
    }
  });
  userOverridesWriteQueues.set(hostFilePath, tracked);
  return next;
}

/**
 * Internal atomic async writer for `user_overrides.json` with bounded Windows `EPERM`/`EACCES`/`EBUSY`
 * rename retry backoff (`15ms -> 40ms -> 80ms`) and temp-file cleanup.
 *
 * @param {string} hostFilePath
 * @param {Record<string, Record<string, any>>} nextOverrides
 * @param {string} [updatedAt]
 * @returns {Promise<void>}
 */
async function performAtomicUserOverridesWriteAsync(hostFilePath, nextOverrides, updatedAt) {
  const effectiveUpdatedAt = updatedAt || new Date().toISOString();
  const serialized = JSON.stringify(
    { overrides: nextOverrides, updatedAt: effectiveUpdatedAt },
    null,
    2
  );
  const dir = path.dirname(hostFilePath);
  await fs.promises.mkdir(dir, { recursive: true });
  const tmpPath = `${hostFilePath}.${process.pid}.${++userOverridesTmpSeq}.tmp`;
  const retryDelaysMs = [15, 40, 80];

  try {
    await fs.promises.writeFile(tmpPath, serialized, 'utf8');
    let renamed = false;
    let lastRenameErr = null;
    for (let attempt = 0; attempt <= retryDelaysMs.length; attempt++) {
      try {
        await fs.promises.rename(tmpPath, hostFilePath);
        renamed = true;
        break;
      } catch (renErr) {
        lastRenameErr = renErr;
        const code = String(/** @type {any} */ (renErr)?.code || '').toUpperCase();
        const isRetryableLock = code === 'EPERM' || code === 'EACCES' || code === 'EBUSY';
        if (!isRetryableLock || attempt >= retryDelaysMs.length) {
          break;
        }
        const delayMs = retryDelaysMs[attempt];
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }
    if (!renamed) {
      throw lastRenameErr || new Error('Failed to rename user_overrides temporary file');
    }
  } catch {
    try {
      await fs.promises.unlink(tmpPath);
    } catch {}
    atomicWriteFileSync(hostFilePath, serialized);
  }

  try {
    const postStat = await fs.promises.stat(hostFilePath);
    userOverridesMemoryCache.set(hostFilePath, {
      mtimeMs: postStat.mtimeMs,
      overrides: { ...nextOverrides },
    });
  } catch {
    userOverridesMemoryCache.set(hostFilePath, {
      mtimeMs: -1,
      overrides: { ...nextOverrides },
    });
  }
}

/**
 * Serialized async atomic writer for `user_overrides.json`.
 *
 * @param {string} filePath
 * @param {Record<string, Record<string, any>>} nextOverrides
 * @param {string} [updatedAt]
 * @returns {Promise<void>}
 */
function writeUserOverridesToDiskAsync(filePath, nextOverrides, updatedAt) {
  return enqueueUserOverridesTask(filePath, (hostFilePath) =>
    performAtomicUserOverridesWriteAsync(hostFilePath, nextOverrides, updatedAt)
  );
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
    const hostFilePath = toHostFilesystemPath(filePath);
    const pendingWrite = userOverridesWriteQueues.get(hostFilePath);
    if (pendingWrite) {
      try {
        await pendingWrite;
      } catch {}
    }
    return await readUserOverridesAsync(filePath);
  };

  const handleSaveUserOverride = async (
    /** @type {any} */ _event,
    /** @type {unknown} */ arg1,
    /** @type {unknown} */ arg2
  ) => {
    if (
      arg1 &&
      typeof arg1 === 'object' &&
      !Array.isArray(arg1) &&
      /** @type {any} */ (arg1).batchOverrides &&
      typeof /** @type {any} */ (arg1).batchOverrides === 'object' &&
      !Array.isArray(/** @type {any} */ (arg1).batchOverrides)
    ) {
      const cleanBatch = sanitizeRendererIpcOptions(/** @type {any} */ (arg1).batchOverrides);
      const filePath = resolveUserOverridesFilePath(offlineVaultService, userDataDir);

      const batchResult = await enqueueUserOverridesTask(filePath, async (hostFilePath) => {
        const current = await readUserOverridesAsync(hostFilePath);
        /** @type {Record<string, Record<string, any>>} */
        const nextOverrides = { ...current };
        /** @type {Array<[string, Record<string, any>, string[]]>} */
        const mergedRecords = [];
        const nowIso = new Date().toISOString();

        for (const [rawKey, rawPatch] of Object.entries(cleanBatch)) {
          const batchGameId = normalizeSafeOverrideGameId(rawKey);
          if (!batchGameId || !rawPatch || typeof rawPatch !== 'object' || Array.isArray(rawPatch)) {
            continue;
          }
          const cleanPatch = sanitizeRendererIpcOptions(rawPatch);
          /** @type {string[]} */
          const batchPurgeKeys = Array.isArray(cleanPatch.purgeKeys)
            ? cleanPatch.purgeKeys
                .map((/** @type {unknown} */ k) => normalizeSafeOverrideGameId(k))
                .filter((/** @type {string} */ k) => Boolean(k) && k !== batchGameId)
            : [];
          delete cleanPatch.id;
          delete cleanPatch.purgeKeys;

          const existing = nextOverrides[batchGameId];
          const existingMs = Date.parse(String(existing?.updatedAt || ''));
          const rawPatchUpdatedStr =
            typeof cleanPatch.updatedAt === 'string' ? cleanPatch.updatedAt.trim() : '';
          const patchMs = Date.parse(rawPatchUpdatedStr);

          if (Number.isFinite(existingMs) && Number.isFinite(patchMs) && existingMs > patchMs) {
            continue;
          }

          const validPatchUpdatedAtIso = Number.isFinite(patchMs) ? rawPatchUpdatedStr : '';
          const mergedRecord = {
            ...(existing || {}),
            ...cleanPatch,
            gameId: batchGameId,
            updatedAt: validPatchUpdatedAtIso || nowIso,
          };
          delete /** @type {any} */ (mergedRecord).purgeKeys;

          /** @type {Set<string>} */
          const purgedForEntry = new Set(batchPurgeKeys);
          for (const pk of batchPurgeKeys) {
            delete nextOverrides[pk];
          }

          const targetPair = extractOverrideEntitlementPair(batchGameId, mergedRecord);
          if (targetPair) {
            for (const [otherKey, otherOv] of Object.entries(nextOverrides)) {
              if (otherKey === batchGameId) continue;
              const otherPair = extractOverrideEntitlementPair(otherKey, otherOv);
              if (
                otherPair &&
                otherPair.platformId === targetPair.platformId &&
                otherPair.platformGameId === targetPair.platformGameId &&
                otherOv?.gameId !== batchGameId
              ) {
                delete nextOverrides[otherKey];
                purgedForEntry.add(otherKey);
              }
            }
          }

          nextOverrides[batchGameId] = mergedRecord;
          mergedRecords.push([batchGameId, mergedRecord, Array.from(purgedForEntry)]);
        }

        await performAtomicUserOverridesWriteAsync(hostFilePath, nextOverrides, nowIso);
        return {
          mergedRecords,
          nextOverrides,
        };
      });

      if (typeof offlineVaultService.saveUserOverride === 'function') {
        for (const [id, rec, purgedKeys] of batchResult.mergedRecords) {
          try {
            offlineVaultService.saveUserOverride(id, rec, purgedKeys);
          } catch {}
        }
      }

      return {
        success: true,
        count: batchResult.mergedRecords.length,
        overrides: batchResult.nextOverrides,
      };
    }

    let gameId = '';
    /** @type {Record<string, any>} */
    let patch = {};
    /** @type {Set<string>} */
    const explicitPurgeKeys = new Set();

    if (typeof arg1 === 'string') {
      gameId = normalizeSafeOverrideGameId(arg1);
      patch = sanitizeRendererIpcOptions(arg2);
    } else if (arg1 && typeof arg1 === 'object' && !Array.isArray(arg1)) {
      const cleanObj = sanitizeRendererIpcOptions(arg1);
      gameId = normalizeSafeOverrideGameId(cleanObj.gameId || cleanObj.id);
      if (Array.isArray(cleanObj.purgeKeys)) {
        for (const rawPk of cleanObj.purgeKeys) {
          addOverrideKeyVariants(explicitPurgeKeys, rawPk);
        }
      }
      if (cleanObj.override && typeof cleanObj.override === 'object' && !Array.isArray(cleanObj.override)) {
        patch = sanitizeRendererIpcOptions(cleanObj.override);
      } else {
        patch = { ...cleanObj };
        delete patch.id;
      }
    }

    if (Array.isArray(patch.purgeKeys)) {
      for (const rawPk of patch.purgeKeys) {
        addOverrideKeyVariants(explicitPurgeKeys, rawPk);
      }
    }
    delete patch.id;
    delete patch.purgeKeys;

    if (!gameId) {
      return { success: false, error: 'Invalid or missing gameId for user override.' };
    }
    explicitPurgeKeys.delete(gameId);

    const filePath = resolveUserOverridesFilePath(offlineVaultService, userDataDir);
    const { updatedRecord, nextOverrides, purgedKeys } = await enqueueUserOverridesTask(
      filePath,
      async (hostFilePath) => {
        const current = await readUserOverridesAsync(hostFilePath);
        const existing = current[gameId];
        const existingMs = Date.parse(String(existing?.updatedAt || ''));
        const rawPatchUpdatedStr =
          typeof patch.updatedAt === 'string' ? patch.updatedAt.trim() : '';
        const patchMs = Date.parse(rawPatchUpdatedStr);
        const nowIso = new Date().toISOString();

        if (Number.isFinite(existingMs) && Number.isFinite(patchMs) && existingMs > patchMs) {
          return {
            updatedRecord: existing,
            nextOverrides: current,
            purgedKeys: [],
          };
        }

        const effectiveUpdatedAt = Number.isFinite(patchMs) ? rawPatchUpdatedStr : nowIso;
        const rec = {
          ...(existing || {}),
          ...patch,
          gameId,
          updatedAt: effectiveUpdatedAt,
        };
        delete /** @type {any} */ (rec).purgeKeys;
        delete /** @type {any} */ (rec).id;

        /** @type {Record<string, Record<string, any>>} */
        const updatedMap = { ...current };
        /** @type {Set<string>} */
        const purgedSet = new Set();

        for (const pk of explicitPurgeKeys) {
          if (pk !== gameId) {
            if (Object.prototype.hasOwnProperty.call(updatedMap, pk)) {
              delete updatedMap[pk];
            }
            purgedSet.add(pk);
          }
        }

        const targetPair = extractOverrideEntitlementPair(gameId, rec);
        if (targetPair) {
          for (const [k, ov] of Object.entries(current)) {
            if (k === gameId) continue;
            const ovPair = extractOverrideEntitlementPair(k, ov);
            if (
              ovPair &&
              ovPair.platformId === targetPair.platformId &&
              ovPair.platformGameId === targetPair.platformGameId &&
              ov?.gameId !== gameId
            ) {
              delete updatedMap[k];
              purgedSet.add(k);
            }
          }
        }

        updatedMap[gameId] = rec;
        await performAtomicUserOverridesWriteAsync(hostFilePath, updatedMap, rec.updatedAt);
        return {
          updatedRecord: rec,
          nextOverrides: updatedMap,
          purgedKeys: Array.from(purgedSet),
        };
      }
    );

    if (typeof offlineVaultService.saveUserOverride === 'function') {
      try {
        offlineVaultService.saveUserOverride(gameId, updatedRecord, purgedKeys);
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
    const cleanObj =
      rawArg && typeof rawArg === 'object' && !Array.isArray(rawArg)
        ? sanitizeRendererIpcOptions(rawArg)
        : null;
    const rawId = typeof rawArg === 'string' ? rawArg : cleanObj ? cleanObj.gameId || cleanObj.id : '';
    const gameId = normalizeSafeOverrideGameId(rawId);
    if (!gameId) {
      return { success: false, error: 'Invalid or missing gameId for user override removal.' };
    }

    /** @type {Set<string>} */
    const keysToDelete = new Set();
    addOverrideKeyVariants(keysToDelete, gameId);

    /** @type {Array<{ platformId: string, platformGameId: string }>} */
    const targetPairs = [];
    const pushTargetPair = (/** @type {unknown} */ pid, /** @type {unknown} */ pgid) => {
      const norm = normalizeEntitlementPair(pid, pgid);
      if (!norm) return;
      if (
        !targetPairs.some(
          (p) => p.platformId === norm.platformId && p.platformGameId === norm.platformGameId
        )
      ) {
        targetPairs.push(norm);
      }
      addOverrideKeyVariants(keysToDelete, `${norm.platformId}:${norm.platformGameId}`);
    };

    const inferredFromGameId = extractOverrideEntitlementPair(gameId, null);
    if (inferredFromGameId && inferredFromGameId.platformId !== 'steam') {
      pushTargetPair(inferredFromGameId.platformId, inferredFromGameId.platformGameId);
    }

    /** @type {string[]} */
    const safeOrphanVaultGameIds = [];
    if (cleanObj) {
      const rawAliases = [
        ...(Array.isArray(cleanObj.aliasKeys) ? cleanObj.aliasKeys : []),
        ...(Array.isArray(cleanObj.aliases) ? cleanObj.aliases : []),
      ];
      for (const alias of rawAliases) {
        addOverrideKeyVariants(keysToDelete, alias);
      }
      if (cleanObj.platformId && cleanObj.platformGameId) {
        pushTargetPair(cleanObj.platformId, cleanObj.platformGameId);
      }
      if (Array.isArray(cleanObj.platforms)) {
        for (const p of cleanObj.platforms) {
          if (p && typeof p === 'object') {
            pushTargetPair(p.platformId, p.platformGameId);
          }
        }
      }
      if (Array.isArray(cleanObj.orphanVaultGameIds)) {
        const seenOrphans = new Set();
        for (const rawOrphan of cleanObj.orphanVaultGameIds) {
          const safeOrphan = normalizeSafeOverrideGameId(rawOrphan);
          if (safeOrphan && !seenOrphans.has(safeOrphan)) {
            seenOrphans.add(safeOrphan);
            safeOrphanVaultGameIds.push(safeOrphan);
          }
        }
      }
    }

    const matchesAnyTargetPair = (
      /** @type {{ platformId: string, platformGameId: string } | null} */ pair
    ) => {
      if (!pair) return false;
      return targetPairs.some(
        (tp) => tp.platformId === pair.platformId && tp.platformGameId === pair.platformGameId
      );
    };

    const filePath = resolveUserOverridesFilePath(offlineVaultService, userDataDir);
    const { nextOverrides, removedKeys } = await enqueueUserOverridesTask(
      filePath,
      async (hostFilePath) => {
        const current = await readUserOverridesAsync(hostFilePath);
        const updatedMap = { ...current };

        // Pass 1: discover every matching key, linked Steam App ID, and underlying entitlement pair
        for (const [k, ov] of Object.entries(current)) {
          const ovGameId = typeof ov?.gameId === 'string' ? ov.gameId.trim() : '';
          const entryPair = extractOverrideEntitlementPair(k, ov);
          if (
            keysToDelete.has(k) ||
            (ovGameId && keysToDelete.has(ovGameId)) ||
            matchesAnyTargetPair(entryPair)
          ) {
            addOverrideKeyVariants(keysToDelete, k);
            if (ovGameId) addOverrideKeyVariants(keysToDelete, ovGameId);
            if (entryPair) {
              pushTargetPair(entryPair.platformId, entryPair.platformGameId);
            }
            for (const appId of extractLinkedSteamAppIds(k, ov)) {
              const steamKey = `steam-${appId}`;
              const existingSteamOv = current[steamKey];
              const existingSteamPair = existingSteamOv
                ? extractOverrideEntitlementPair(steamKey, existingSteamOv)
                : null;
              const belongsToUnrelatedEntitlement = Boolean(
                existingSteamPair && targetPairs.length > 0 && !matchesAnyTargetPair(existingSteamPair)
              );
              if (!belongsToUnrelatedEntitlement) {
                addOverrideKeyVariants(keysToDelete, steamKey);
              }
            }
          }
        }

        // Pass 2: delete all discovered keys, linked `steam-<appId>` entries, and matching platform pairs
        /** @type {Set<string>} */
        const removedSet = new Set(keysToDelete);
        for (const [k, ov] of Object.entries(current)) {
          const ovGameId = typeof ov?.gameId === 'string' ? ov.gameId.trim() : '';
          const entryPair = extractOverrideEntitlementPair(k, ov);
          if (
            keysToDelete.has(k) ||
            (ovGameId && keysToDelete.has(ovGameId)) ||
            matchesAnyTargetPair(entryPair)
          ) {
            delete updatedMap[k];
            removedSet.add(k);
            if (ovGameId) removedSet.add(ovGameId);
          }
        }

        await performAtomicUserOverridesWriteAsync(
          hostFilePath,
          updatedMap,
          new Date().toISOString()
        );
        return {
          nextOverrides: updatedMap,
          removedKeys: Array.from(removedSet),
        };
      }
    );

    if (typeof offlineVaultService.removeUserOverride === 'function') {
      try {
        offlineVaultService.removeUserOverride(gameId, removedKeys);
      } catch {}
    }

    if (
      safeOrphanVaultGameIds.length > 0 &&
      typeof offlineVaultService.deleteGames === 'function'
    ) {
      try {
        offlineVaultService.deleteGames(safeOrphanVaultGameIds);
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
  readUserOverridesFromDisk,
  readUserOverridesAsync,
  writeUserOverridesToDiskAsync,
};
