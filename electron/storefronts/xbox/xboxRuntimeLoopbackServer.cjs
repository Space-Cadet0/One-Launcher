'use strict';

const net = require('node:net');
const path = require('node:path');
const crypto = require('node:crypto');

const {
  formatWgsUserScidFolderName,
  loadWgsSyncSidecar,
  saveWgsSyncSidecar,
  syncXboxTitleStorage,
} = require('./xboxTitleStorageSync.cjs');

const MAX_RPC_FRAME_BYTES = 16 * 1024 * 1024; // 16 MiB (authenticated sockets)
const MAX_UNAUTH_RPC_FRAME_BYTES = 4096; // 4 KiB strict limit until sessionToken/key verified (D8.7)
const MAX_CONCURRENT_SOCKETS = 16;
const DEFAULT_SOCKET_IDLE_TIMEOUT_MS = 60_000;
const MINIMAL_1X1_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

function verifySessionKeyConstantTime(candidateKey, expectedKeyBuf) {
  if (typeof candidateKey !== 'string' || candidateKey.length !== 64) {
    return false;
  }
  const candBuf = Buffer.from(candidateKey, 'utf8');
  if (candBuf.length !== expectedKeyBuf.length) {
    return false;
  }
  return crypto.timingSafeEqual(candBuf, expectedKeyBuf);
}

function encodeRpcFrame(payloadObj) {
  const jsonBuf = Buffer.from(JSON.stringify(payloadObj), 'utf8');
  const frame = Buffer.allocUnsafe(4 + jsonBuf.length);
  frame.writeUInt32LE(jsonBuf.length, 0);
  jsonBuf.copy(frame, 4);
  return frame;
}

/**
 * Idempotently resolves `{ wgsUserDir, xgsUserDir }` from either a `SystemAppData`
 * directory OR an already-appended `.../SystemAppData/wgs` directory (preventing `wgs/wgs`).
 */
function resolveTitleSaveDirs(baseSaveDirInput, hexXuidScidInput) {
  let baseSaveDir = baseSaveDirInput;
  let hexXuidScid = hexXuidScidInput;
  if (baseSaveDirInput && typeof baseSaveDirInput === 'object') {
    baseSaveDir =
      baseSaveDirInput.baseSaveDir ||
      baseSaveDirInput.saveRootDir ||
      baseSaveDirInput.wgsRootDir ||
      '';
    hexXuidScid =
      baseSaveDirInput.hexXuidScid ||
      (baseSaveDirInput.xuid && baseSaveDirInput.scid
        ? formatWgsUserScidFolderName(baseSaveDirInput.xuid, baseSaveDirInput.scid)
        : '');
  }
  if (!baseSaveDir || !hexXuidScid) return null;
  const cleanBase = path.resolve(String(baseSaveDir));
  const leaf = path.basename(cleanBase).toLowerCase();
  if (leaf === 'wgs') {
    return {
      wgsUserDir: path.join(cleanBase, hexXuidScid),
      xgsUserDir: path.join(path.dirname(cleanBase), 'xgs', hexXuidScid),
    };
  }
  if (leaf === 'xgs') {
    return {
      wgsUserDir: path.join(path.dirname(cleanBase), 'wgs', hexXuidScid),
      xgsUserDir: path.join(cleanBase, hexXuidScid),
    };
  }
  return {
    wgsUserDir: path.join(cleanBase, 'wgs', hexXuidScid),
    xgsUserDir: path.join(cleanBase, 'xgs', hexXuidScid),
  };
}

function resolveTitleSaveRootDir(baseSaveDir, hexXuidScid) {
  const dirs = resolveTitleSaveDirs(baseSaveDir, hexXuidScid);
  return dirs ? dirs.wgsUserDir : null;
}

/**
 * Starts One Launcher's per-session authenticated `127.0.0.1` loopback RPC server
 * for `one_xgameruntime_bridge.dll` running inside a CrossOver / GPTK / Wine bottle.
 */
function normalizeLoopbackDecimalTitleId(rawTitleId, { preferHex = false } = {}) {
  const s = String(rawTitleId || '').trim();
  if (!s) return '';
  if (/^0x[0-9a-f]{1,8}$/i.test(s)) {
    return String(parseInt(s.slice(2), 16));
  }
  if (/^[0-9a-f]{1,8}$/i.test(s) && (preferHex || /[a-f]/i.test(s))) {
    return String(parseInt(s, 16));
  }
  if (/^\d+$/.test(s)) {
    return String(Number(s));
  }
  return '';
}

async function startXboxRuntimeLoopbackServer(options = {}) {
  const {
    authProvider = null,
    storeProvider = null,
    userProfile = {},
    gameMetadata = {},
    saveRootDir = null, // Host path to bottle's `%LOCALAPPDATA%\Packages\<PFN>\SystemAppData` (or `.../SystemAppData/wgs`)
    wgsRootDir = null, // Optional alias for `.../SystemAppData/wgs`
    bottleUsersDir = null, // Optional host path `<Bottle>/drive_c/users/<wineuser>/AppData/Local`
    enableCloudSaveSync = Boolean(authProvider?.getTokenAndSignatureForUrl),
    titleStorageOrigin,
    fetchImpl,
    onTelemetry,
  } = options;

  const maxConcurrentSockets = Math.max(
    1,
    Math.min(
      MAX_CONCURRENT_SOCKETS,
      Number.isInteger(options.maxConcurrentSockets)
        ? options.maxConcurrentSockets
        : MAX_CONCURRENT_SOCKETS
    )
  );
  const socketIdleTimeoutMs =
    Number(options.socketIdleTimeoutMs) > 0
      ? Number(options.socketIdleTimeoutMs)
      : DEFAULT_SOCKET_IDLE_TIMEOUT_MS;

  const sessionKey = crypto.randomBytes(32).toString('hex'); // 64 hex chars
  const expectedKeyBuf = Buffer.from(sessionKey, 'utf8');
  const activeSockets = new Set();
  const inFlightSaveInits = new Map();
  const VALID_SCID_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  /** @type {Set<string>} */
  const activeScids = new Set();

  const initialRawTitleId = String(gameMetadata.titleId || options.titleId || '');
  const state = {
    titleId: initialRawTitleId,
    titleIdDecimal: String(
      gameMetadata.titleIdDecimal ||
        options.titleIdDecimal ||
        normalizeLoopbackDecimalTitleId(initialRawTitleId)
    ),
    scid: String(gameMetadata.scid || options.scid || '').trim().toLowerCase(),
    fallbackScid: String(gameMetadata.fallbackScid || options.fallbackScid || '')
      .trim()
      .toLowerCase(),
    msaAppId: String(gameMetadata.msaAppId || options.msaAppId || ''),
    storeId: String(gameMetadata.storeId || options.storeId || ''),
    packageFamilyName: String(
      gameMetadata.packageFamilyName || options.packageFamilyName || options.pfn || ''
    ),
    fullTrust: gameMetadata.fullTrust !== false,
    initializedSaves: new Set(),
    saveQuotas: new Map(),
    /** @type {Promise<any>} */
    pendingSaveChain: Promise.resolve(),
  };

  function resolveSystemAppDataHostDir(pfnOverride) {
    const explicitSaveRoot = saveRootDir || wgsRootDir;
    if (explicitSaveRoot) return explicitSaveRoot;
    const pfn = pfnOverride || state.packageFamilyName;
    if (bottleUsersDir && pfn) {
      return path.join(bottleUsersDir, 'Packages', pfn, 'SystemAppData');
    }
    return null;
  }

  async function resolveActiveUserProfile() {
    const fromProvider =
      typeof authProvider?.getUserProfile === 'function'
        ? await authProvider.getUserProfile()
        : null;
    const merged = { ...userProfile, ...(fromProvider || {}) };
    const xuid = String(merged.xuid || '2533274790395904');
    const gamertag = String(merged.gamertag || 'PlayerOne').slice(0, 15);
    const modernGamertag = String(merged.modernGamertag || gamertag).slice(0, 96);
    const modernGamertagSuffix = String(merged.modernGamertagSuffix || '');
    const uniqueModernGamertag = String(
      merged.uniqueModernGamertag ||
        (modernGamertagSuffix ? `${modernGamertag}#${modernGamertagSuffix}` : modernGamertag)
    ).slice(0, 100);

    return {
      xuid,
      gamertag,
      modernGamertag,
      modernGamertagSuffix,
      uniqueModernGamertag,
      ageGroup: Number(merged.ageGroup || 3), // XUserAgeGroup_Adult = 3
    };
  }

  async function dispatchRpcMethod(method, params = {}) {
    if (typeof onTelemetry === 'function') {
      try {
        onTelemetry({ event: 'rpc_call', method });
      } catch {
        // Ignore telemetry listener errors
      }
    }

    switch (method) {
      case 'auth':
      case 'session.auth': {
        return { authenticated: true };
      }

      case 'session.init': {
        if (params.titleId) {
          const rawTid = String(params.titleId).trim();
          state.titleId = rawTid;
          const decTid = normalizeLoopbackDecimalTitleId(rawTid, {
            preferHex: /^[0-9A-Fa-f]{8}$/.test(rawTid),
          });
          if (decTid) state.titleIdDecimal = decTid;
        }
        if (params.scid) state.scid = String(params.scid).toLowerCase();
        if (params.msaAppId) state.msaAppId = String(params.msaAppId);
        if (params.storeId) state.storeId = String(params.storeId).toUpperCase();
        if (params.packageFamilyName) state.packageFamilyName = String(params.packageFamilyName);
        if (typeof params.fullTrust === 'boolean') state.fullTrust = params.fullTrust;

        const profile = await resolveActiveUserProfile();
        return {
          ...profile,
          titleId: state.titleId,
          titleIdDecimal: state.titleIdDecimal || undefined,
          scid: state.scid,
          msaAppId: state.msaAppId,
          storeId: state.storeId,
          packageFamilyName: state.packageFamilyName,
          sandbox: 'RETAIL',
        };
      }

      case 'xuser.getTokenAndSignature': {
        const httpMethod = String(params.method || 'GET').toUpperCase();
        const url = String(params.url || '');
        if (!url) {
          throw new Error('xuser.getTokenAndSignature requires a non-empty url');
        }
        const headers = params.headers && typeof params.headers === 'object' ? params.headers : {};
        const bodyBuffer = params.bodyBase64
          ? Buffer.from(String(params.bodyBase64), 'base64')
          : Buffer.alloc(0);

        if (authProvider && typeof authProvider.getTokenAndSignatureForUrl === 'function') {
          const res = await authProvider.getTokenAndSignatureForUrl({
            method: httpMethod,
            url,
            headers,
            body: bodyBuffer,
            bodyBuffer,
            forceRefresh: Boolean(params.forceRefresh),
            options: Number(params.options || 0),
            titleId: state.titleIdDecimal || state.titleId,
            scid: state.scid,
            msaAppId: state.msaAppId,
          });
          return {
            token: String(res?.token || res?.authorization || ''),
            signature: String(res?.signature || ''),
          };
        }

        const profile = await resolveActiveUserProfile();
        return {
          token: `XBL3.0 x=${profile.xuid};offline_session_token`,
          signature: '',
        };
      }

      case 'xuser.getGamerPicture': {
        if (authProvider && typeof authProvider.getGamerPicture === 'function') {
          const pic = await authProvider.getGamerPicture({ size: params.size || 1 });
          if (pic) {
            const b64 = Buffer.isBuffer(pic) ? pic.toString('base64') : String(pic);
            return { pngBase64: b64 };
          }
        }
        return { pngBase64: MINIMAL_1X1_PNG_BASE64 };
      }

      case 'xstore.getGameLicense': {
        if (storeProvider && typeof storeProvider.getGameLicense === 'function') {
          const lic = await storeProvider.getGameLicense({
            storeId: state.storeId,
            packageFamilyName: state.packageFamilyName,
          });
          if (lic) return lic;
        }
        return {
          skuStoreId: state.storeId ? `${state.storeId}/0010` : '9N0000000000/0010',
          isActive: true,
          isTrialOwnedByThisUser: false,
          isDiscLicense: false,
          isTrial: false,
          trialTimeRemainingInSeconds: 0,
          trialUniqueId: '',
          expirationDate: Math.floor(Date.now() / 1000) + 30 * 86400,
        };
      }

      case 'xstore.acquirePackageLicense': {
        const packageIdentifier = String(params.packageIdentifier || '');
        if (storeProvider && typeof storeProvider.acquirePackageLicense === 'function') {
          const res = await storeProvider.acquirePackageLicense({ packageIdentifier });
          if (res) return res;
        }
        return {
          packageIdentifier,
          licensable: true,
        };
      }

      case 'xstore.queryEntitledProducts':
      case 'xstore.queryAssociatedProducts':
      case 'xstore.queryProducts': {
        if (storeProvider && typeof storeProvider.queryProducts === 'function') {
          const res = await storeProvider.queryProducts({
            mode: method,
            productKinds: Number(params.productKinds || 0x1f),
            storeIds: Array.isArray(params.storeIds) ? params.storeIds : [],
            maxItems: Number(params.maxItems || 25),
          });
          if (res) return res;
        }
        const defaultProducts = [];
        if (state.storeId && method !== 'xstore.queryProducts') {
          defaultProducts.push({
            storeId: state.storeId,
            title: gameMetadata.displayName || 'Xbox Game',
            description: '',
            language: 'en-US',
            inAppOfferToken: '',
            linkUri: '',
            productKind: 0x04, // XStoreProductKind_Game
            hasDigitalDownload: true,
            isInUserCollection: true,
            skuId: '0010',
          });
        }
        return { products: defaultProducts };
      }

      case 'xstore.queryAddOnLicenses': {
        if (storeProvider && typeof storeProvider.queryAddOnLicenses === 'function') {
          const res = await storeProvider.queryAddOnLicenses({ storeId: state.storeId });
          if (res) return res;
        }
        return { licenses: [] };
      }

      case 'xstore.getCollectionsId': {
        if (storeProvider && typeof storeProvider.getCollectionsId === 'function') {
          const token = await storeProvider.getCollectionsId({
            serviceTicket: String(params.serviceTicket || ''),
            publisherUserId: String(params.publisherUserId || ''),
          });
          return { token: String(token || '') };
        }
        if (authProvider && typeof authProvider.getCollectionsId === 'function') {
          const token = await authProvider.getCollectionsId({
            serviceTicket: String(params.serviceTicket || ''),
            publisherUserId: String(params.publisherUserId || ''),
          });
          return { token: String(token || '') };
        }
        return { token: '' };
      }

      case 'xstore.getPurchaseId': {
        if (storeProvider && typeof storeProvider.getPurchaseId === 'function') {
          const token = await storeProvider.getPurchaseId({
            serviceTicket: String(params.serviceTicket || ''),
            publisherUserId: String(params.publisherUserId || ''),
          });
          return { token: String(token || '') };
        }
        if (authProvider && typeof authProvider.getPurchaseId === 'function') {
          const token = await authProvider.getPurchaseId({
            serviceTicket: String(params.serviceTicket || ''),
            publisherUserId: String(params.publisherUserId || ''),
          });
          return { token: String(token || '') };
        }
        return { token: '' };
      }

      case 'xgamesave.init': {
        const profile = await resolveActiveUserProfile();
        const xuid = String(params.xuid || profile.xuid);
        const scid = String(params.scid || state.scid).trim().toLowerCase();
        if (VALID_SCID_UUID_RE.test(scid)) {
          activeScids.add(scid);
        }
        const pfn = String(params.packageFamilyName || state.packageFamilyName);
        const hexXuidScid = formatWgsUserScidFolderName(xuid, scid);
        const sysAppDataDir = resolveSystemAppDataHostDir(pfn);

        let quotaBytes = 256 * 1024 * 1024;
        let synced = false;

        if (sysAppDataDir && scid && enableCloudSaveSync) {
          const saveDirs = resolveTitleSaveDirs(sysAppDataDir, hexXuidScid);
          const { wgsUserDir, xgsUserDir } = saveDirs;
          const syncKey = `${xuid}:${scid}`;
          if (state.initializedSaves.has(syncKey)) {
            synced = true;
            quotaBytes = state.saveQuotas.get(syncKey) || quotaBytes;
          } else {
            let initPromise = inFlightSaveInits.get(syncKey);
            if (!initPromise) {
              const executeInit = async () => {
                const res = await syncXboxTitleStorage({
                  mode: 'pre_launch',
                  wgsUserDir,
                  xgsUserDir,
                  xuid,
                  scid,
                  fallbackScid: state.fallbackScid || state.scid,
                  preserveLocalWgsDirOnFallback: true,
                  packageFamilyName: pfn,
                  msaAppId: state.msaAppId,
                  titleId: state.titleId,
                  authProvider,
                  titleStorageOrigin,
                  fetchImpl,
                });
                const resolvedQuota = res?.quotaBytes || 256 * 1024 * 1024;
                const resolvedSynced = Boolean(res?.synced);
                state.saveQuotas.set(syncKey, resolvedQuota);
                state.initializedSaves.add(syncKey);
                return { quotaBytes: resolvedQuota, synced: resolvedSynced };
              };
              const chained = state.pendingSaveChain.then(executeInit, executeInit);
              state.pendingSaveChain = chained.catch(() => {});
              initPromise = chained.finally(() => {
                inFlightSaveInits.delete(syncKey);
              });
              inFlightSaveInits.set(syncKey, initPromise);
            }
            const initRes = await initPromise;
            quotaBytes = initRes.quotaBytes;
            synced = initRes.synced;
          }
        }

        return {
          synced,
          quotaBytes,
          hexXuidScid,
          scid,
          packageFamilyName: pfn,
        };
      }

      case 'xgamesave.commit': {
        try {
          const profile = await resolveActiveUserProfile();
          const xuid = String(params.xuid || profile.xuid);
          const scid = String(params.scid || state.scid).trim().toLowerCase();
          if (VALID_SCID_UUID_RE.test(scid)) {
            activeScids.add(scid);
          }
          const pfn = String(params.packageFamilyName || state.packageFamilyName);
          const containerName = String(params.containerName || '');
          const deleted = Boolean(params.deleted);
          const hexXuidScid = formatWgsUserScidFolderName(xuid, scid);
          const sysAppDataDir = resolveSystemAppDataHostDir(pfn);

          if (sysAppDataDir && scid) {
            const { wgsUserDir, xgsUserDir } = resolveTitleSaveDirs(sysAppDataDir, hexXuidScid);

            const enqueueCommit = async () => {
              try {
                if (deleted && containerName) {
                  const sidecar = await loadWgsSyncSidecar(wgsUserDir);
                  if (!sidecar.deletedContainers.includes(containerName)) {
                    sidecar.deletedContainers.push(containerName);
                    await saveWgsSyncSidecar(wgsUserDir, sidecar);
                  }
                }
                if (enableCloudSaveSync) {
                  await syncXboxTitleStorage({
                    mode: 'in_session',
                    wgsUserDir,
                    xgsUserDir,
                    xuid,
                    scid,
                    fallbackScid: state.fallbackScid || state.scid,
                    preserveLocalWgsDirOnFallback: true,
                    packageFamilyName: pfn,
                    msaAppId: state.msaAppId,
                    titleId: state.titleId,
                    authProvider,
                    titleStorageOrigin,
                    fetchImpl,
                  });
                }
              } catch (commitErr) {
                if (typeof onTelemetry === 'function') {
                  try {
                    onTelemetry({
                      event: 'rpc_commit_error',
                      error: commitErr?.message || String(commitErr),
                    });
                  } catch {
                    // Ignore telemetry listener errors
                  }
                }
                throw commitErr;
              }
            };

            const commitPromise = state.pendingSaveChain.then(enqueueCommit, enqueueCommit);
            state.pendingSaveChain = commitPromise.catch(() => {});
            if (params.waitForCloud === true) {
              await commitPromise;
            }
          }

          return {
            committed: true,
            remainingQuota: 256 * 1024 * 1024,
          };
        } catch (err) {
          throw Object.assign(
            err instanceof Error ? err : new Error(String(err)),
            {
              hr: Number.isInteger(err?.hr) ? err.hr : -2147467259, // E_FAIL (0x80004005)
            }
          );
        }
      }

      default:
        throw Object.assign(new Error(`Unsupported XGR RPC method: ${method}`), {
          hr: -2147467263, // E_NOTIMPL (0x80004001)
        });
    }
  }

  const server = net.createServer((socket) => {
    if (activeSockets.size >= maxConcurrentSockets) {
      socket.destroy();
      return;
    }

    activeSockets.add(socket);
    socket.setNoDelay(true);
    socket.setTimeout(socketIdleTimeoutMs);
    socket.on('timeout', () => {
      socket.destroy();
    });

    // Two-stage O(1) frame reader: 4-byte length header -> single Buffer.allocUnsafe(bodyLen) + cursor copy
    const headerBuf = Buffer.allocUnsafe(4);
    let headerFilled = 0;
    let bodyLen = 0;
    let frameBuf = null;
    let frameFilled = 0;
    let socketAuthenticated = false;
    const parsedReqQueue = [];

    const drainParsedReqQueue = async () => {
      while (parsedReqQueue.length > 0 && !socket.destroyed) {
        const req = parsedReqQueue.shift();
        const reqId = req.id ?? 0;
        try {
          const result = await dispatchRpcMethod(String(req.method || ''), req.params || {});
          if (!socket.destroyed) {
            socket.write(encodeRpcFrame({ id: reqId, ok: true, hr: 0, result }));
          }
        } catch (err) {
          const hr = Number.isInteger(err?.hr) ? err.hr : -2147467259; // E_FAIL (0x80004005)
          if (!socket.destroyed) {
            socket.write(
              encodeRpcFrame({
                id: reqId,
                ok: false,
                hr,
                error: err?.message || String(err),
              })
            );
          }
        }
      }
    };

    let processingChain = Promise.resolve();

    socket.on('data', (chunk) => {
      let offset = 0;
      while (offset < chunk.length && !socket.destroyed) {
        if (headerFilled < 4) {
          const needHeader = 4 - headerFilled;
          const takeHeader = Math.min(needHeader, chunk.length - offset);
          chunk.copy(headerBuf, headerFilled, offset, offset + takeHeader);
          headerFilled += takeHeader;
          offset += takeHeader;
          if (headerFilled < 4) {
            break;
          }

          bodyLen = headerBuf.readUInt32LE(0);
          const maxAllowed = socketAuthenticated
            ? MAX_RPC_FRAME_BYTES
            : MAX_UNAUTH_RPC_FRAME_BYTES;
          if (bodyLen === 0 || bodyLen > maxAllowed) {
            socket.destroy();
            return;
          }
          frameBuf = Buffer.allocUnsafe(bodyLen);
          frameFilled = 0;
        }

        const needBody = bodyLen - frameFilled;
        const takeBody = Math.min(needBody, chunk.length - offset);
        chunk.copy(frameBuf, frameFilled, offset, offset + takeBody);
        frameFilled += takeBody;
        offset += takeBody;

        if (frameFilled === bodyLen) {
          const completedBuf = frameBuf;
          frameBuf = null;
          frameFilled = 0;
          headerFilled = 0;
          bodyLen = 0;

          let req;
          try {
            req = JSON.parse(completedBuf.toString('utf8'));
          } catch {
            socket.destroy();
            return;
          }

          const candidateToken = req && typeof req === 'object' ? (req.key ?? req.sessionToken) : '';
          if (!req || !verifySessionKeyConstantTime(candidateToken, expectedKeyBuf)) {
            socket.destroy();
            return;
          }

          socketAuthenticated = true;
          parsedReqQueue.push(req);
        }
      }

      if (parsedReqQueue.length > 0 && !socket.destroyed) {
        processingChain = processingChain.then(drainParsedReqQueue, drainParsedReqQueue);
      }
    });

    socket.on('error', () => {
      socket.destroy();
    });

    socket.on('close', () => {
      activeSockets.delete(socket);
    });
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject);
      resolve();
    });
  });

  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;

  return {
    host: '127.0.0.1',
    port,
    sessionKey,
    env: {
      ONE_XGR_PORT: String(port),
      ONE_XGR_KEY: sessionKey,
    },
    getState() {
      return {
        titleId: state.titleId,
        scid: state.scid,
        fallbackScid: state.fallbackScid,
        msaAppId: state.msaAppId,
        storeId: state.storeId,
        packageFamilyName: state.packageFamilyName,
      };
    },
    getActiveScids() {
      return Array.from(activeScids);
    },
    async flushPendingSaves() {
      await state.pendingSaveChain.catch(() => {});
    },
    async close() {
      await state.pendingSaveChain.catch(() => {});
      for (const sock of activeSockets) {
        sock.destroy();
      }
      activeSockets.clear();
      await new Promise((resolve) => server.close(() => resolve()));
    },
  };
}

module.exports = {
  MAX_RPC_FRAME_BYTES,
  MAX_UNAUTH_RPC_FRAME_BYTES,
  MAX_CONCURRENT_SOCKETS,
  DEFAULT_SOCKET_IDLE_TIMEOUT_MS,
  verifySessionKeyConstantTime,
  encodeRpcFrame,
  resolveTitleSaveDirs,
  resolveTitleSaveRootDir,
  startXboxRuntimeLoopbackServer,
};
