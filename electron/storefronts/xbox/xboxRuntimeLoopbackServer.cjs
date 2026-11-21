// @ts-check
'use strict';

const net = require('node:net');
const path = require('node:path');
const crypto = require('node:crypto');

const { isContainedWithinRoot } = require('../../launcher/securityAndPathUtils.cjs');
const {
  formatWgsUserScidFolderName,
  loadWgsSyncSidecar,
  saveWgsSyncSidecar,
  syncXboxTitleStorage,
  acquireXboxTitleStorageSessionLock,
  releaseXboxTitleStorageSessionLock,
} = require('./xboxTitleStorageSync.cjs');
const {
  buildXboxFetchSignal,
  resolveDefaultXboxLocale,
} = require('./xboxConfigAndIds.cjs');
const {
  postXboxTitlePresenceHeartbeat,
} = require('./xboxAchievementsAndStats.cjs');

const loopbackValidationAndPaths = require('./loopback/loopbackValidationAndPaths.cjs');
const dlcDiscovery = require('./loopback/dlcDiscovery.cjs');
const storeRuntimeProvider = require('./loopback/storeRuntimeProvider.cjs');
const loopbackConnectionHandler = require('./loopback/loopbackConnectionHandler.cjs');

const {
  MAX_RPC_FRAME_BYTES,
  MAX_UNAUTH_RPC_FRAME_BYTES,
  MAX_HTTP_HEADER_BYTES,
  DEFAULT_UNAUTH_HANDSHAKE_TIMEOUT_MS,
  MAX_CONCURRENT_SOCKETS,
  DEFAULT_SOCKET_IDLE_TIMEOUT_MS,
  DEFAULT_PRESENCE_HEARTBEAT_INTERVAL_MS,
  MAX_PARSED_REQ_QUEUE,
  MAX_BOUNDED_STATE_ENTRIES,
  VALID_SCID_UUID_RE,
  MINIMAL_1X1_PNG_BASE64,
  createInvalidArgError,
  verifySessionKeyConstantTime,
  validateSafePackageFamilyName,
  validateSafeScid,
  validateSafeXuid,
  normalizeLoopbackDecimalTitleId,
  hostPathToWindowsPath,
  encodeRpcFrame,
  resolveTitleSaveDirs,
  resolveTitleSaveRootDir,
  setBoundedMapEntry,
  addBoundedSetEntry,
} = loopbackValidationAndPaths;

const {
  discoverInstalledDlcPackages,
  discoverInstalledDlcPackagesAsync,
} = dlcDiscovery;

const { createXboxStoreRuntimeProvider } = storeRuntimeProvider;
const { createLoopbackConnectionHandler } = loopbackConnectionHandler;

/**
 * Starts One Launcher's per-session authenticated `127.0.0.1` loopback RPC server
 * for `one_xgameruntime_bridge.dll` running inside a CrossOver / GPTK / Wine bottle
 * or Windows clientless injector.
 *
 * @param {Record<string, any>} [options]
 */
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
    initialPreLaunchSync = null,
    titleStorageOrigin,
    fetchImpl,
    onTelemetry,
  } = options;

  const INITIAL_PRE_LAUNCH_SYNC_TTL_MS = 30_000;

  /**
   * Returns true if `initialPreLaunchSync` already completed a fresh pre-launch pull for
   * `targetScid` (matching `resolvedScid` or `scid`) within the last `30_000 ms`.
   *
   * @param {string} targetScid
   * @returns {boolean}
   */
  function matchesInitialPreLaunchSync(targetScid) {
    if (!initialPreLaunchSync || typeof initialPreLaunchSync !== 'object') return false;
    if (initialPreLaunchSync.synced !== true) return false;
    const syncedAtMs = Number(
      initialPreLaunchSync.syncedAtMs ??
        initialPreLaunchSync.timestampMs ??
        initialPreLaunchSync.atMs ??
        0
    );
    if (!Number.isFinite(syncedAtMs) || syncedAtMs <= 0) return false;
    const ageMs = Date.now() - syncedAtMs;
    if (ageMs < -5_000 || ageMs > INITIAL_PRE_LAUNCH_SYNC_TTL_MS) return false;

    const reqLower = String(targetScid || '').trim().toLowerCase();
    if (!reqLower) return false;
    const preResolved = String(initialPreLaunchSync.resolvedScid || '').trim().toLowerCase();
    const preScid = String(initialPreLaunchSync.scid || '').trim().toLowerCase();
    return (
      (Boolean(preResolved) && preResolved === reqLower) ||
      (Boolean(preScid) && preScid === reqLower)
    );
  }

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
  const unauthHandshakeTimeoutMs =
    Number(options.unauthTimeoutMs) > 0
      ? Number(options.unauthTimeoutMs)
      : DEFAULT_UNAUTH_HANDSHAKE_TIMEOUT_MS;
  const maxParsedReqQueue = Number.isInteger(options.maxQueuedRequests)
    ? options.maxQueuedRequests
    : MAX_PARSED_REQ_QUEUE;

  const sessionKey = crypto.randomBytes(32).toString('hex'); // 64 hex chars
  const expectedKeyBuf = Buffer.from(sessionKey, 'utf8');
  /** @type {Set<import('node:net').Socket>} */
  const activeSockets = new Set();
  /** @type {Set<import('node:net').Socket>} */
  const unauthSockets = new Set();
  /** @type {Map<string, Promise<any>>} */
  const inFlightSaveInits = new Map();
  /** @type {Set<string>} */
  const activeScids = new Set();

  const initialRawTitleId = String(gameMetadata.titleId || options.titleId || '');
  const resolvedLocale = resolveDefaultXboxLocale(options.locale || gameMetadata.locale);
  const initialInviteUri = String(options.inviteUri || gameMetadata.inviteUri || '').trim();
  const gameRootDir = String(options.gameRootDir || gameMetadata.gameRootDir || '').trim();
  const discoveredDlcs = Array.isArray(options.dlcPackages)
    ? options.dlcPackages
    : gameRootDir
      ? await discoverInstalledDlcPackagesAsync(gameRootDir)
      : [];

  const initialScid = validateSafeScid(gameMetadata.scid || options.scid || '', {
    allowEmpty: true,
  });
  const initialFallbackScid = validateSafeScid(
    gameMetadata.fallbackScid || options.fallbackScid || '',
    { allowEmpty: true }
  );

  const state = {
    titleId: initialRawTitleId,
    titleIdDecimal: String(
      gameMetadata.titleIdDecimal ||
        options.titleIdDecimal ||
        normalizeLoopbackDecimalTitleId(initialRawTitleId)
    ),
    scid: initialScid,
    fallbackScid: initialFallbackScid,
    msaAppId: String(gameMetadata.msaAppId || options.msaAppId || ''),
    storeId: String(gameMetadata.storeId || options.storeId || '').trim().toUpperCase(),
    packageFamilyName: validateSafePackageFamilyName(
      gameMetadata.packageFamilyName || options.packageFamilyName || options.pfn || ''
    ),
    locale: resolvedLocale,
    inviteUri: initialInviteUri,
    dlcPackages: discoveredDlcs,
    lastXuid: validateSafeXuid(userProfile?.xuid || '', { allowEmpty: true }),
    fullTrust: gameMetadata.fullTrust !== false,
    /** @type {Set<string>} */
    initializedSaves: new Set(),
    /** @type {Map<string, number>} */
    saveQuotas: new Map(),
    /** @type {Map<string, number>} */
    remainingSaveQuotas: new Map(),
    /** @type {Map<string, any>} */
    heldCloudLocks: new Map(),
    /** @type {Promise<any>} */
    pendingSaveChain: Promise.resolve(),
  };

  const effectiveStoreProvider =
    storeProvider ||
    (authProvider
      ? createXboxStoreRuntimeProvider({
          authProvider,
          userProfile,
          gameMetadata: {
            ...gameMetadata,
            storeId: state.storeId,
            locale: state.locale,
          },
          fetchImpl,
          tokenVault: options.tokenVault,
          userDataDir: options.userDataDir,
          cacheStore: options.cacheStore,
          locale: state.locale,
          market: options.market || gameMetadata.market,
          dlcPackages: state.dlcPackages,
        })
      : null);

  const canSendPresence =
    options.enablePresenceHeartbeat === true ||
    (options.enablePresenceHeartbeat !== false &&
      Boolean(authProvider && typeof authProvider.getXstsToken === 'function'));
  const presenceIntervalMs =
    Number(options.presenceHeartbeatIntervalMs) > 0
      ? Number(options.presenceHeartbeatIntervalMs)
      : DEFAULT_PRESENCE_HEARTBEAT_INTERVAL_MS;
  /** @type {ReturnType<typeof setInterval> | null} */
  let presenceTimer = null;
  let presenceActivated = false;
  let isClosing = false;

  /** @param {string} presenceState */
  async function sendPresenceUpdate(presenceState) {
    if (!canSendPresence) return;
    if (presenceState !== 'inactive' && isClosing) return;
    const tidDec = state.titleIdDecimal;
    if (presenceState !== 'inactive' && (!/^\d+$/.test(tidDec) || Number(tidDec) <= 0)) {
      return;
    }
    if (presenceState === 'active') {
      presenceActivated = true;
    }
    await postXboxTitlePresenceHeartbeat({
      authProvider,
      xuid: state.lastXuid || userProfile?.xuid,
      titleIdDecimal: tidDec,
      state: presenceState,
      fetchImpl,
    });
  }

  /** @param {unknown} pfnOverride */
  function resolveSystemAppDataHostDir(pfnOverride) {
    const safeOverride =
      pfnOverride !== undefined && pfnOverride !== null && String(pfnOverride).trim() !== ''
        ? validateSafePackageFamilyName(pfnOverride)
        : '';
    const explicitSaveRoot = saveRootDir || wgsRootDir;
    if (explicitSaveRoot) return explicitSaveRoot;
    const pfn = safeOverride || validateSafePackageFamilyName(state.packageFamilyName);
    if (bottleUsersDir && pfn) {
      const packagesRoot = path.resolve(bottleUsersDir, 'Packages');
      const resolvedDir = path.resolve(packagesRoot, pfn, 'SystemAppData');
      if (resolvedDir === packagesRoot || !isContainedWithinRoot(packagesRoot, resolvedDir)) {
        throw createInvalidArgError('Rejected path traversal in packageFamilyName');
      }
      return resolvedDir;
    }
    return null;
  }

  async function resolveActiveUserProfile() {
    const fromProvider =
      typeof authProvider?.getUserProfile === 'function'
        ? await authProvider.getUserProfile()
        : null;
    const merged = { ...userProfile, ...(fromProvider || {}) };
    const xuid = validateSafeXuid(merged.xuid || '2533274790395904');
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

  /**
   * @param {string} method
   * @param {Record<string, any>} [params]
   */
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
        if (params.scid !== undefined && params.scid !== null && String(params.scid).trim() !== '') {
          state.scid = validateSafeScid(params.scid);
        }
        if (params.msaAppId) state.msaAppId = String(params.msaAppId);
        if (params.storeId) state.storeId = String(params.storeId).toUpperCase();
        const incomingPfn = params.packageFamilyName ?? params.pfn;
        if (incomingPfn !== undefined && incomingPfn !== null && String(incomingPfn).trim() !== '') {
          state.packageFamilyName = validateSafePackageFamilyName(incomingPfn);
        }
        if (typeof params.fullTrust === 'boolean') state.fullTrust = params.fullTrust;

        const profile = await resolveActiveUserProfile();
        if (profile.xuid) state.lastXuid = profile.xuid;
        void sendPresenceUpdate('active');

        return {
          ...profile,
          titleId: state.titleId,
          titleIdDecimal: state.titleIdDecimal || undefined,
          scid: state.scid,
          msaAppId: state.msaAppId,
          storeId: state.storeId,
          packageFamilyName: state.packageFamilyName,
          locale: state.locale,
          offline: !authProvider,
          dlcPackages: state.dlcPackages,
          ...(state.inviteUri ? { inviteUri: state.inviteUri } : {}),
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
        if (effectiveStoreProvider && typeof effectiveStoreProvider.getGameLicense === 'function') {
          const lic = await effectiveStoreProvider.getGameLicense({
            storeId: state.storeId,
            packageFamilyName: state.packageFamilyName,
          });
          if (lic) return lic;
        }
        const hasOfflineBaseGame = Boolean(state.storeId || !authProvider);
        return {
          skuStoreId: state.storeId ? `${state.storeId}/0010` : '9N0000000000/0010',
          isActive: hasOfflineBaseGame,
          isTrialOwnedByThisUser: false,
          isDiscLicense: false,
          isTrial: false,
          trialTimeRemainingInSeconds: 0,
          trialUniqueId: '',
          expirationDate: hasOfflineBaseGame
            ? Math.floor(Date.now() / 1000) + 30 * 86400
            : 0,
        };
      }

      case 'xstore.acquirePackageLicense': {
        const packageIdentifier = String(params.packageIdentifier || '');
        if (
          effectiveStoreProvider &&
          typeof effectiveStoreProvider.acquirePackageLicense === 'function'
        ) {
          const res = await effectiveStoreProvider.acquirePackageLicense({ packageIdentifier });
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
        if (effectiveStoreProvider && typeof effectiveStoreProvider.queryProducts === 'function') {
          const res = await effectiveStoreProvider.queryProducts({
            mode: method,
            productKinds: Number(params.productKinds || 0x1f),
            storeIds: Array.isArray(params.storeIds)
              ? params.storeIds
              : Array.isArray(params.productIds)
                ? params.productIds
                : [],
            maxItems: Number(params.maxItems || 25),
            baseStoreId: state.storeId,
            dlcPackages: state.dlcPackages,
          });
          if (res) return res;
        }
        const defaultProducts = [];
        if (state.storeId && method !== 'xstore.queryProducts') {
          defaultProducts.push({
            storeId: state.storeId,
            title: gameMetadata.displayName || 'Xbox Game',
            description: '',
            language: state.locale || 'en-US',
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
        if (
          effectiveStoreProvider &&
          typeof effectiveStoreProvider.queryAddOnLicenses === 'function'
        ) {
          const res = await effectiveStoreProvider.queryAddOnLicenses({
            storeId: state.storeId,
            dlcPackages: state.dlcPackages,
          });
          if (res) return res;
        }
        return { licenses: [] };
      }

      case 'xstore.queryLicenseToken': {
        const productIds = Array.isArray(params.productIds)
          ? params.productIds.map((p) => String(p || '').trim()).filter(Boolean)
          : [];
        const customDeveloperString = String(params.customDeveloperString || '');
        if (
          effectiveStoreProvider &&
          typeof effectiveStoreProvider.queryLicenseToken === 'function'
        ) {
          const token = await effectiveStoreProvider.queryLicenseToken({
            productIds,
            customDeveloperString,
            parentProductId: state.storeId,
          });
          return { token: String(token || '') };
        }
        return { token: '' };
      }

      case 'xstore.getCollectionsId': {
        if (
          effectiveStoreProvider &&
          typeof effectiveStoreProvider.getCollectionsId === 'function'
        ) {
          const token = await effectiveStoreProvider.getCollectionsId({
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
        if (effectiveStoreProvider && typeof effectiveStoreProvider.getPurchaseId === 'function') {
          const token = await effectiveStoreProvider.getPurchaseId({
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
        const xuid = validateSafeXuid(params.xuid || profile.xuid);
        const scid = validateSafeScid(params.scid || state.scid);
        addBoundedSetEntry(activeScids, scid, MAX_BOUNDED_STATE_ENTRIES);
        const pfn = validateSafePackageFamilyName(
          params.packageFamilyName || params.pfn || state.packageFamilyName
        );
        const hexXuidScid = formatWgsUserScidFolderName(xuid, scid);
        const sysAppDataDir = resolveSystemAppDataHostDir(pfn);

        let quotaBytes = 256 * 1024 * 1024;
        let remainingQuotaBytes = quotaBytes;
        let synced = false;

        if (sysAppDataDir && scid && enableCloudSaveSync) {
          const saveDirs = resolveTitleSaveDirs(sysAppDataDir, hexXuidScid);
          if (!saveDirs) {
            throw createInvalidArgError('Unable to resolve TitleSave directories');
          }
          const { wgsUserDir, xgsUserDir } = saveDirs;
          const syncKey = `${xuid}:${scid}`;
          if (state.initializedSaves.has(syncKey)) {
            synced = true;
            quotaBytes = state.saveQuotas.get(syncKey) || quotaBytes;
            remainingQuotaBytes = state.remainingSaveQuotas.get(syncKey) ?? quotaBytes;
          } else {
            let initPromise = inFlightSaveInits.get(syncKey);
            if (!initPromise) {
              const executeInit = async () => {
                if (matchesInitialPreLaunchSync(scid)) {
                  const effectiveLockScid = validateSafeScid(
                    initialPreLaunchSync?.resolvedScid || scid
                  );
                  const seedQuota =
                    Number(initialPreLaunchSync?.quotaBytes) > 0
                      ? Number(initialPreLaunchSync.quotaBytes)
                      : 256 * 1024 * 1024;
                  const seedRemaining = Number.isFinite(initialPreLaunchSync?.remainingQuotaBytes)
                    ? Number(initialPreLaunchSync.remainingQuotaBytes)
                    : seedQuota;

                  const lockRes = await acquireXboxTitleStorageSessionLock({
                    xuid,
                    scid: effectiveLockScid,
                    fallbackScid: state.fallbackScid || state.scid,
                    packageFamilyName: pfn,
                    msaAppId: state.msaAppId,
                    titleId: state.titleId,
                    authProvider,
                    titleStorageOrigin,
                    fetchImpl,
                    quotaBytes: seedQuota,
                  });
                  const resolvedQuota =
                    Number(lockRes?.quotaBytes) > 0 ? Number(lockRes.quotaBytes) : seedQuota;
                  const resolvedRemaining = Math.min(resolvedQuota, Math.max(0, seedRemaining));
                  const resolvedScid = validateSafeScid(
                    lockRes?.resolvedScid || effectiveLockScid
                  );
                  setBoundedMapEntry(
                    state.saveQuotas,
                    syncKey,
                    resolvedQuota,
                    MAX_BOUNDED_STATE_ENTRIES
                  );
                  setBoundedMapEntry(
                    state.remainingSaveQuotas,
                    syncKey,
                    resolvedRemaining,
                    MAX_BOUNDED_STATE_ENTRIES
                  );
                  addBoundedSetEntry(state.initializedSaves, syncKey, MAX_BOUNDED_STATE_ENTRIES);
                  if (lockRes?.locked) {
                    setBoundedMapEntry(
                      state.heldCloudLocks,
                      syncKey,
                      {
                        xuid,
                        scid,
                        resolvedScid,
                        pfn,
                        lockHeld: true,
                        hadWrites: false,
                      },
                      MAX_BOUNDED_STATE_ENTRIES
                    );
                  }
                  return {
                    quotaBytes: resolvedQuota,
                    remainingQuotaBytes: resolvedRemaining,
                    synced: true,
                  };
                }

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
                  keepLockHeld: true,
                });
                const resolvedQuota = res?.quotaBytes || 256 * 1024 * 1024;
                const resolvedRemaining = Number.isFinite(res?.remainingQuotaBytes)
                  ? Number(res.remainingQuotaBytes)
                  : resolvedQuota;
                const resolvedSynced = Boolean(res?.synced);
                const resolvedScid = validateSafeScid(res?.resolvedScid || scid);
                setBoundedMapEntry(
                  state.saveQuotas,
                  syncKey,
                  resolvedQuota,
                  MAX_BOUNDED_STATE_ENTRIES
                );
                setBoundedMapEntry(
                  state.remainingSaveQuotas,
                  syncKey,
                  resolvedRemaining,
                  MAX_BOUNDED_STATE_ENTRIES
                );
                addBoundedSetEntry(state.initializedSaves, syncKey, MAX_BOUNDED_STATE_ENTRIES);
                if (res?.lockHeld) {
                  setBoundedMapEntry(
                    state.heldCloudLocks,
                    syncKey,
                    {
                      xuid,
                      scid,
                      resolvedScid,
                      pfn,
                      lockHeld: true,
                      hadWrites:
                        (res?.uploadedContainers || 0) > 0 ||
                        (res?.deletedRemoteContainers || 0) > 0,
                    },
                    MAX_BOUNDED_STATE_ENTRIES
                  );
                }
                return {
                  quotaBytes: resolvedQuota,
                  remainingQuotaBytes: resolvedRemaining,
                  synced: resolvedSynced,
                };
              };
              const chained = state.pendingSaveChain.then(executeInit, executeInit);
              state.pendingSaveChain = chained.catch(() => {});
              initPromise = chained.finally(() => {
                inFlightSaveInits.delete(syncKey);
              });
              setBoundedMapEntry(
                inFlightSaveInits,
                syncKey,
                initPromise,
                MAX_BOUNDED_STATE_ENTRIES
              );
            }
            const initRes = await initPromise;
            quotaBytes = initRes.quotaBytes;
            remainingQuotaBytes = initRes.remainingQuotaBytes;
            synced = initRes.synced;
          }
        }

        return {
          synced,
          quotaBytes,
          remainingQuota: remainingQuotaBytes,
          remainingQuotaBytes,
          hexXuidScid,
          scid,
          packageFamilyName: pfn,
        };
      }

      case 'xgamesave.remaining_quota':
      case 'xgamesave.getRemainingQuota': {
        const profile = await resolveActiveUserProfile();
        const xuid = validateSafeXuid(params.xuid || profile.xuid);
        const scid = validateSafeScid(params.scid || state.scid, { allowEmpty: true });
        const syncKey = `${xuid}:${scid}`;
        const quotaBytes = state.saveQuotas.get(syncKey) || 256 * 1024 * 1024;
        const remainingQuotaBytes = state.remainingSaveQuotas.get(syncKey) ?? quotaBytes;
        return {
          quotaBytes,
          remainingQuota: remainingQuotaBytes,
          remainingQuotaBytes,
        };
      }

      case 'xgamesave.submit_update':
      case 'xgamesave.commit': {
        try {
          const profile = await resolveActiveUserProfile();
          const xuid = validateSafeXuid(params.xuid || profile.xuid);
          const scid = validateSafeScid(params.scid || state.scid);
          addBoundedSetEntry(activeScids, scid, MAX_BOUNDED_STATE_ENTRIES);
          const pfn = validateSafePackageFamilyName(
            params.packageFamilyName || params.pfn || state.packageFamilyName
          );
          const containerName = String(params.containerName || '');
          const deleted = Boolean(params.deleted);
          const hexXuidScid = formatWgsUserScidFolderName(xuid, scid);
          const sysAppDataDir = resolveSystemAppDataHostDir(pfn);
          const syncKey = `${xuid}:${scid}`;

          if (sysAppDataDir && scid) {
            const saveDirs = resolveTitleSaveDirs(sysAppDataDir, hexXuidScid);
            if (!saveDirs) {
              throw createInvalidArgError('Unable to resolve TitleSave directories');
            }
            const { wgsUserDir, xgsUserDir } = saveDirs;

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
                  const priorLock = state.heldCloudLocks.get(syncKey);
                  const knownQuota = state.saveQuotas.get(syncKey) || 256 * 1024 * 1024;
                  const syncRes = await syncXboxTitleStorage({
                    mode: 'in_session',
                    wgsUserDir,
                    xgsUserDir,
                    xuid,
                    scid: priorLock?.resolvedScid || scid,
                    fallbackScid: state.fallbackScid || state.scid,
                    preserveLocalWgsDirOnFallback: true,
                    packageFamilyName: pfn,
                    msaAppId: state.msaAppId,
                    titleId: state.titleId,
                    authProvider,
                    titleStorageOrigin,
                    fetchImpl,
                    alreadyLocked: Boolean(priorLock?.lockHeld),
                    keepLockHeld: true,
                    quotaBytes: knownQuota,
                  });
                  if (Number(syncRes?.quotaBytes) > 0) {
                    setBoundedMapEntry(
                      state.saveQuotas,
                      syncKey,
                      Number(syncRes.quotaBytes),
                      MAX_BOUNDED_STATE_ENTRIES
                    );
                  }
                  if (Number.isFinite(syncRes?.remainingQuotaBytes)) {
                    setBoundedMapEntry(
                      state.remainingSaveQuotas,
                      syncKey,
                      Number(syncRes.remainingQuotaBytes),
                      MAX_BOUNDED_STATE_ENTRIES
                    );
                  }
                  const wroteAny =
                    Boolean(priorLock?.hadWrites) ||
                    (syncRes?.uploadedContainers || 0) > 0 ||
                    (syncRes?.deletedRemoteContainers || 0) > 0;
                  setBoundedMapEntry(
                    state.heldCloudLocks,
                    syncKey,
                    {
                      xuid,
                      scid,
                      resolvedScid: validateSafeScid(
                        syncRes?.resolvedScid || priorLock?.resolvedScid || scid
                      ),
                      pfn,
                      lockHeld: Boolean(syncRes?.lockHeld),
                      hadWrites: wroteAny,
                    },
                    MAX_BOUNDED_STATE_ENTRIES
                  );
                }
              } catch (/** @type {any} */ commitErr) {
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
            state.pendingSaveChain = commitPromise.catch((bgErr) => {
              if (params.waitForCloud !== true) {
                console.warn(
                  '[XboxLoopbackServer] Background cloud save commit warning:',
                  bgErr?.message || bgErr
                );
              }
            });
            if (params.waitForCloud === true) {
              await commitPromise;
            }
          }

          const remainingQuotaBytes =
            state.remainingSaveQuotas.get(syncKey) ??
            state.saveQuotas.get(syncKey) ??
            256 * 1024 * 1024;
          return {
            committed: true,
            remainingQuota: remainingQuotaBytes,
            remainingQuotaBytes,
          };
        } catch (/** @type {any} */ err) {
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

  const server = net.createServer(
    createLoopbackConnectionHandler({
      expectedKeyBuf,
      activeSockets,
      unauthSockets,
      maxConcurrentSockets,
      socketIdleTimeoutMs,
      unauthHandshakeTimeoutMs,
      maxParsedReqQueue,
      dispatchRpcMethod,
    })
  );

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject);
      resolve(undefined);
    });
  });

  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;

  if (canSendPresence) {
    if (/^\d+$/.test(state.titleIdDecimal) && Number(state.titleIdDecimal) > 0) {
      void sendPresenceUpdate('active');
    }
    presenceTimer = setInterval(() => {
      void sendPresenceUpdate('active');
    }, presenceIntervalMs);
    if (typeof presenceTimer.unref === 'function') {
      presenceTimer.unref();
    }
  }

  const initialSaveRootHost = resolveSystemAppDataHostDir(state.packageFamilyName);
  const initialSaveRootWin = initialSaveRootHost ? hostPathToWindowsPath(initialSaveRootHost) : '';

  /** @type {Promise<void> | null} */
  let closePromise = null;
  async function closeServer() {
    if (closePromise) return closePromise;
    isClosing = true;
    if (presenceTimer) {
      clearInterval(presenceTimer);
      presenceTimer = null;
    }
    closePromise = (async () => {
      await state.pendingSaveChain.catch(() => {});
      if (enableCloudSaveSync && state.heldCloudLocks.size > 0) {
        for (const lockEntry of state.heldCloudLocks.values()) {
          if (!lockEntry?.lockHeld) continue;
          try {
            await releaseXboxTitleStorageSessionLock({
              xuid: lockEntry.xuid,
              scid: lockEntry.resolvedScid,
              packageFamilyName: lockEntry.pfn,
              msaAppId: state.msaAppId,
              titleId: state.titleId,
              authProvider,
              titleStorageOrigin,
              fetchImpl,
              hadWrites: Boolean(lockEntry.hadWrites),
              signal: buildXboxFetchSignal(undefined, 5_000),
            });
          } catch (/** @type {any} */ releaseErr) {
            console.warn(
              '[XboxLoopbackServer] Failed to release TitleStorage session lock on close:',
              releaseErr?.message || releaseErr
            );
          }
        }
        state.heldCloudLocks.clear();
      }
      if (presenceActivated) {
        await sendPresenceUpdate('inactive');
      }
      for (const sock of activeSockets) {
        sock.destroy();
      }
      unauthSockets.clear();
      activeSockets.clear();
      await new Promise((resolve) => server.close(() => resolve(undefined)));
    })();
    return closePromise;
  }

  return {
    host: '127.0.0.1',
    port,
    sessionKey,
    storeProvider: effectiveStoreProvider,
    env: {
      ONE_XGR_PORT: String(port),
      ONE_XGR_KEY: sessionKey,
      ONE_XGR_LOCALE: state.locale,
      ...(initialSaveRootWin ? { ONE_XGR_SAVE_ROOT: initialSaveRootWin } : {}),
      ...(state.inviteUri ? { ONE_XGR_INVITE_URI: state.inviteUri } : {}),
    },
    getState() {
      return {
        titleId: state.titleId,
        titleIdDecimal: state.titleIdDecimal || undefined,
        scid: state.scid,
        fallbackScid: state.fallbackScid,
        msaAppId: state.msaAppId,
        storeId: state.storeId,
        packageFamilyName: state.packageFamilyName,
        locale: state.locale,
        dlcPackages: state.dlcPackages,
      };
    },
    getActiveScids() {
      return Array.from(activeScids);
    },
    /**
     * Atomically pops the matching held Title Storage session lock for `scid`
     * (case-insensitive against `scid` or `resolvedScid`) so post-exit sync can
     * reuse it and issue a single authoritative `DELETE /lock?newSavesUploaded=<hadWrites>`.
     *
     * @param {string} [scid]
     */
    consumeHeldLock(scid) {
      const needle = String(scid || '').trim().toLowerCase();
      if (!needle) return null;
      for (const [key, entry] of state.heldCloudLocks.entries()) {
        const entryScid = String(entry?.scid || '').trim().toLowerCase();
        const entryResolvedScid = String(entry?.resolvedScid || '').trim().toLowerCase();
        const keyScid = String(key || '').includes(':')
          ? String(key)
              .slice(String(key).indexOf(':') + 1)
              .trim()
              .toLowerCase()
          : '';
        if (entryScid === needle || entryResolvedScid === needle || keyScid === needle) {
          state.heldCloudLocks.delete(key);
          return {
            lockHeld: Boolean(entry?.lockHeld),
            hadWrites: Boolean(entry?.hadWrites),
            xuid: String(entry?.xuid || ''),
            resolvedScid: String(entry?.resolvedScid || entry?.scid || scid || ''),
            pfn: String(entry?.pfn || ''),
          };
        }
      }
      return null;
    },
    async flushPendingSaves() {
      await state.pendingSaveChain.catch(() => {});
    },
    close: closeServer,
    stop: closeServer,
  };
}

module.exports = {
  MAX_RPC_FRAME_BYTES,
  MAX_UNAUTH_RPC_FRAME_BYTES,
  MAX_HTTP_HEADER_BYTES,
  DEFAULT_UNAUTH_HANDSHAKE_TIMEOUT_MS,
  MAX_CONCURRENT_SOCKETS,
  DEFAULT_SOCKET_IDLE_TIMEOUT_MS,
  DEFAULT_PRESENCE_HEARTBEAT_INTERVAL_MS,
  MAX_PARSED_REQ_QUEUE,
  VALID_SCID_UUID_RE,
  verifySessionKeyConstantTime,
  validateSafePackageFamilyName,
  validateSafeScid,
  validateSafeXuid,
  encodeRpcFrame,
  resolveTitleSaveDirs,
  resolveTitleSaveRootDir,
  hostPathToWindowsPath,
  discoverInstalledDlcPackages,
  discoverInstalledDlcPackagesAsync,
  createXboxStoreRuntimeProvider,
  startXboxRuntimeLoopbackServer,
};
