// @ts-check
'use strict';

/**
 * Xbox Dual-Plane Authentication Provider (`xboxAuthProvider.cjs`):
 * - P0-01 Fail-closed NSAL URL->RP routing (rejects non-`https:`, non-default ports, credentials,
 *   and ANY unrecognized host — NEVER falls back to `http://xboxlive.com` XSTS + ECDSA signing!)
 * - Full async vault I/O (`loadSavedTokensAsync`/`saveTokensAsync` with sync fallback only for mocks)
 * - Idempotent `provider.dispose()` unsubscribing `vault.onVaultChange` and clearing all session
 *   caches + `globalMinecraftEntitlementCache` on logout/dispose
 * - Unified single-flight coalescing Maps across ALL `forceRefresh: true` branches
 * - Bounded per-provider caches & bounded TTL `pendingOAuthStates` Map for concurrent OAuth flows
 */

const crypto = require('node:crypto');
const xboxDeviceClep = require('../xboxDeviceClep.cjs');
const {
  XBOX_LIVESDK_CLIENT_ID,
  XBOX_TOKEN_BROKER_CLIENT_ID,
  XBOX_OAUTH_REDIRECT_URI,
  SCOPE_XBL_MBI_SSL,
  XBOX_TOKEN_BROKER_SCOPE,
  XBL_TITLE_ENDPOINTS_CURRENT_URL,
  XBL_TITLE_ENDPOINTS_DEFAULT_URL,
  XSTS_RELYING_PARTIES,
  createAbortError,
  racePromiseWithCallerSignal,
  setBoundedMapEntry,
  buildRpXstsCacheKey,
  normalizeDecimalTitleId,
  isFutureIsoTimestamp,
  verifyXboxOAuthState,
  extractOAuthCallbackStateCandidate,
  extractAuthCodeFromInput,
  buildXboxAuthorizationUrl,
  isTrustedXboxAuthUrl,
  isXboxLiveUserAuthScope,
} = require('./xboxAuthConstantsAndUrl.cjs');
const {
  cacheEcPrivateKeyObject,
  evictCachedEcPrivateKey,
  getCachedEcPrivateKeyObject,
  generateXboxProofKeyPair,
  deriveDashedUuidFromSeed,
  signXboxRequest,
} = require('./xboxProofKeyAndSigning.cjs');
const {
  normalizeStoreMsaTicket,
  normalizeXblRpsTicket,
  formatStoreAuthTickets,
  parseStrictNsalHttpsUrl,
  isTitleStorageHostname,
  resolvePreNsalBuiltInRelyingPartyForUrl,
  resolvePostNsalFallbackRelyingPartyForUrl,
  matchDynamicTitleEndpointRelyingParty,
} = require('./xboxTicketAndNsalRouter.cjs');
const {
  clearMinecraftEntitlementCacheForScope,
  postOAuthForm,
  authenticateXblUser,
  authorizeXstsInternal,
  fetchProfileSettings,
  postDeviceAuthenticate,
  attemptSisuAuthorize,
  authenticateXblTitle,
  fetchSignedNsalEndpoints,
  checkMinecraftJavaEntitlementFlow,
} = require('./xboxMsaAndTokenBrokerFlow.cjs');

/** @type {Record<string, any> | null} */
let boundFacade = null;

/**
 * @param {Record<string, any>} facade
 */
function bindFacade(facade) {
  boundFacade = facade;
}

const MAX_RP_XSTS_CACHE_ENTRIES = 64;
const MAX_DEVICE_TOKEN_CACHE_ENTRIES = 8;
const MAX_TITLE_SESSION_CACHE_ENTRIES = 64;
const MAX_PER_TITLE_ENDPOINTS_CACHE_ENTRIES = 64;
const MAX_PENDING_OAUTH_STATES = 16;
const PENDING_OAUTH_STATE_TTL_MS = 15 * 60_000;

// Shared per-vault single-flight locks so multiple provider instances never race refresh_token rotation
/** @type {Map<string, Promise<any>>} */
const globalInFlightMsaRenewals = new Map();
/** @type {Map<string, { promise: Promise<any>, forceRefresh: boolean }>} */
const globalInFlightXblUserTokens = new Map();
/** @type {Map<string, { promise: Promise<any>, forceRefresh: boolean }>} */
const globalInFlightXblSessionRenewals = new Map();

/**
 * Unified single-flight coalescing helper supporting BOTH normal and `forceRefresh: true` requests:
 * - Concurrent normal requests coalesce onto any active flight (normal or forced).
 * - Concurrent `forceRefresh: true` requests coalesce onto an active forced flight.
 * - A `forceRefresh: true` arriving during a non-force flight supersedes the map slot safely,
 *   and `.finally()` checks entry identity so the older flight never deletes the newer forced flight.
 *
 * @template T
 * @param {Map<string, { promise: Promise<T>, forceRefresh: boolean }>} flightMap
 * @param {string} key
 * @param {boolean} forceRefresh
 * @param {AbortSignal | undefined} signal
 * @param {() => Promise<T>} runFn
 * @returns {Promise<T>}
 */
function coalesceSingleFlight(flightMap, key, forceRefresh, signal, runFn) {
  const existing = flightMap.get(key);
  if (existing && (!forceRefresh || existing.forceRefresh)) {
    return racePromiseWithCallerSignal(existing.promise, signal);
  }
  if (signal?.aborted) {
    return Promise.reject(createAbortError(signal.reason));
  }

  /** @type {Promise<T>} */
  const flight = (async () => runFn())().finally(() => {
    if (flightMap.get(key)?.promise === flight) {
      flightMap.delete(key);
    }
  });

  flightMap.set(key, { promise: flight, forceRefresh });
  flight.catch(() => {});
  return racePromiseWithCallerSignal(flight, signal);
}

/**
 * Creates a full-featured Xbox Live & Microsoft Store Auth Provider backed by `tokenVault.cjs`.
 *
 * @param {{
 *   userDataDir?: string,
 *   tokenVault?: any,
 *   fetchImpl?: typeof fetch,
 *   customFetch?: typeof fetch,
 *   clientId?: string,
 * }} [config]
 */
function createXboxAuthProvider(config = {}) {
  const userDataDir = config.userDataDir;
  const vault = config.tokenVault || require('../../tokenVault.cjs');
  const fetchImpl = config.customFetch || config.fetchImpl || globalThis.fetch;
  const clientId = config.clientId || XBOX_LIVESDK_CLIENT_ID;
  const lockScopeKey = String(userDataDir || 'default');

  const getSignFn = () => boundFacade?.signXboxRequest || signXboxRequest;
  const getGenProofFn = () => boundFacade?.generateXboxProofKeyPair || generateXboxProofKeyPair;

  // Bounded ephemeral per-provider session caches
  /** @type {Map<string, any>} */
  const rpXstsCache = new Map();
  /** @type {Map<string, { promise: Promise<any>, forceRefresh: boolean }>} */
  const inFlightRpXsts = new Map();
  /** @type {Map<string, { token: string, notAfter: string }>} */
  const xblDeviceTokenCache = new Map();
  /** @type {Map<string, { promise: Promise<string>, forceRefresh: boolean }>} */
  const inFlightDeviceTokens = new Map();
  /** @type {Map<string, any>} */
  const sisuSessionCache = new Map();
  /** @type {Map<string, { promise: Promise<any>, forceRefresh: boolean }>} */
  const inFlightSisuSessions = new Map();
  /** @type {Map<string, any>} */
  const titleAuthSessionCache = new Map();
  /** @type {Map<string, { promise: Promise<any>, forceRefresh: boolean }>} */
  const inFlightTitleAuthSessions = new Map();
  /** @type {Array<Record<string, any>> | null} */
  let cachedDefaultTitleEndpoints = null;
  /** @type {Promise<{ ok: boolean, endPoints: Array<Record<string, any>> }> | null} */
  let inFlightDefaultTitleEndpoints = null;
  /** @type {Map<string, Array<Record<string, any>>>} */
  const cachedPerTitleEndpoints = new Map();
  /** @type {Map<string, Promise<{ ok: boolean, endPoints: Array<Record<string, any>> }>>} */
  const inFlightPerTitleEndpoints = new Map();
  /** @type {{ privateKeyPem: string, privateKeyObj: crypto.KeyObject, publicKeyPem: string, proofKeyJwk: Record<string, any> } | null} */
  let cachedProofRecord = null;
  /** @type {Promise<{ privateKeyPem: string, privateKeyObj: crypto.KeyObject, publicKeyPem: string, proofKeyJwk: Record<string, any> }> | null} */
  let inFlightProofKeyRecord = null;
  /** @type {Map<string, number>} */
  const pendingOAuthStates = new Map();

  let disposed = false;
  /** @type {(() => void) | null} */
  let unsubscribeVaultChange = null;

  const vaultOpts = userDataDir ? { userDataDir } : {};

  /**
   * @param {{ clearLogoutState?: boolean }} [opts]
   */
  const clearProviderSessionCaches = (opts = {}) => {
    rpXstsCache.clear();
    xblDeviceTokenCache.clear();
    sisuSessionCache.clear();
    titleAuthSessionCache.clear();
    cachedPerTitleEndpoints.clear();
    cachedDefaultTitleEndpoints = null;
    if (opts.clearLogoutState) {
      if (cachedProofRecord?.privateKeyPem) {
        evictCachedEcPrivateKey(cachedProofRecord.privateKeyPem);
      }
      pendingOAuthStates.clear();
      clearMinecraftEntitlementCacheForScope(lockScopeKey);
    }
    cachedProofRecord = null;
  };

  /**
   * @param {{ storefrontId?: string, action?: string } | undefined} evt
   */
  const handleVaultChange = (evt) => {
    if (disposed) return;
    const storefrontId = evt?.storefrontId;
    const action = evt?.action;
    if (!storefrontId || storefrontId === 'xbox') {
      const isLogoutOrReset = action !== 'save';
      clearProviderSessionCaches({ clearLogoutState: isLogoutOrReset });
    }
  };

  if (typeof vault.onVaultChange === 'function') {
    const maybeUnsub = vault.onVaultChange(handleVaultChange);
    if (typeof maybeUnsub === 'function') {
      unsubscribeVaultChange = maybeUnsub;
    }
  }

  /**
   * Idempotently unsubscribes from `vault.onVaultChange` and clears all session maps,
   * pending OAuth states, cached proof key material, and scoped Minecraft entitlement cache entries.
   */
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    if (typeof unsubscribeVaultChange === 'function') {
      try {
        unsubscribeVaultChange();
      } catch {}
      unsubscribeVaultChange = null;
    }
    if (typeof vault.offVaultChange === 'function') {
      try {
        vault.offVaultChange(handleVaultChange);
      } catch {}
    }
    clearProviderSessionCaches({ clearLogoutState: true });
    inFlightRpXsts.clear();
    inFlightDeviceTokens.clear();
    inFlightSisuSessions.clear();
    inFlightTitleAuthSessions.clear();
    inFlightPerTitleEndpoints.clear();
    inFlightDefaultTitleEndpoints = null;
    inFlightProofKeyRecord = null;
  };

  /**
   * Reads `xbox` tokens asynchronously via `vault.loadSavedTokensAsync`, falling back to sync
   * `vault.loadSavedTokens` ONLY when a custom test mock lacks `loadSavedTokensAsync`.
   *
   * @returns {Promise<Record<string, any>>}
   */
  const loadXboxVaultRecordAsync = async () => {
    const all =
      typeof vault.loadSavedTokensAsync === 'function'
        ? (await vault.loadSavedTokensAsync(vaultOpts)) || {}
        : typeof vault.loadSavedTokens === 'function'
          ? vault.loadSavedTokens(vaultOpts) || {}
          : {};
    return all.xbox && typeof all.xbox === 'object' ? { ...all.xbox } : {};
  };

  /**
   * Saves a merged `xbox` token patch asynchronously via `vault.saveTokensAsync`, falling back
   * to sync `vault.saveTokens` ONLY when a custom test mock lacks `saveTokensAsync`.
   *
   * @param {Record<string, any>} patch
   * @returns {Promise<Record<string, any>>}
   */
  const saveXboxVaultRecordAsync = async (patch) => {
    const current = await loadXboxVaultRecordAsync();
    const merged = {
      ...current,
      ...patch,
      updatedAt: new Date().toISOString(),
    };
    if (typeof vault.saveTokensAsync === 'function') {
      await vault.saveTokensAsync('xbox', merged, vaultOpts);
    } else if (typeof vault.saveTokens === 'function') {
      vault.saveTokens('xbox', merged, vaultOpts);
    }
    return merged;
  };

  /**
   * Resolves hardware fingerprint asynchronously on real `tokenVault.cjs` while preserving custom
   * test mock `getHardwareFingerprint` overrides.
   */
  const resolveHardwareSeedAsync = async () => {
    if (typeof vault.getHardwareFingerprintAsync === 'function') {
      return vault.getHardwareFingerprintAsync();
    }
    if (
      typeof vault.getMachineIdentityKeyMaterialAsync === 'function' &&
      vault.getHardwareFingerprint === vault.getMachineIdentityKeyMaterial
    ) {
      return vault.getMachineIdentityKeyMaterialAsync();
    }
    if (typeof vault.getHardwareFingerprint === 'function') {
      return vault.getHardwareFingerprint();
    }
    return '';
  };

  /**
   * @param {string} [relyingParty]
   * @param {string} [sandboxId]
   * @param {string} [subjectType]
   */
  const invalidateRpXstsCache = (relyingParty, sandboxId = 'RETAIL', subjectType = 'user') => {
    if (!relyingParty) {
      rpXstsCache.clear();
      return;
    }
    rpXstsCache.delete(buildRpXstsCacheKey(relyingParty, sandboxId, subjectType));
  };

  /**
   * Loads or generates the ECDSA P-256 ProofKey asynchronously with single-flight coalescing.
   *
   * @param {Record<string, any> | null} [optionalLoadedSaved]
   */
  const ensureProofKeyRecordAsync = async (optionalLoadedSaved) => {
    const provided =
      optionalLoadedSaved && typeof optionalLoadedSaved === 'object' ? optionalLoadedSaved : null;

    if (
      cachedProofRecord &&
      (!provided ||
        !provided.proofPrivateKeyPem ||
        provided.proofPrivateKeyPem === cachedProofRecord.privateKeyPem)
    ) {
      return cachedProofRecord;
    }

    if (inFlightProofKeyRecord) {
      return inFlightProofKeyRecord;
    }

    const flight = (async () => {
      const effectiveCurrent = provided || (await loadXboxVaultRecordAsync());
      if (
        cachedProofRecord &&
        (!effectiveCurrent.proofPrivateKeyPem ||
          effectiveCurrent.proofPrivateKeyPem === cachedProofRecord.privateKeyPem)
      ) {
        return cachedProofRecord;
      }

      if (
        effectiveCurrent.proofPrivateKeyPem &&
        effectiveCurrent.proofPublicKeyPem &&
        effectiveCurrent.proofKeyJwk &&
        effectiveCurrent.proofKeyJwk.x &&
        effectiveCurrent.proofKeyJwk.y
      ) {
        const privateKeyObj = getCachedEcPrivateKeyObject(effectiveCurrent.proofPrivateKeyPem);
        cachedProofRecord = {
          privateKeyPem: effectiveCurrent.proofPrivateKeyPem,
          privateKeyObj,
          publicKeyPem: effectiveCurrent.proofPublicKeyPem,
          proofKeyJwk: effectiveCurrent.proofKeyJwk,
        };
        return cachedProofRecord;
      }

      const generated = getGenProofFn()();
      await saveXboxVaultRecordAsync({
        proofPrivateKeyPem: generated.privateKeyPem,
        proofPublicKeyPem: generated.publicKeyPem,
        proofKeyJwk: generated.proofKeyJwk,
      });
      cacheEcPrivateKeyObject(generated.privateKeyPem, generated.privateKey);
      cachedProofRecord = {
        privateKeyPem: generated.privateKeyPem,
        privateKeyObj: generated.privateKey,
        publicKeyPem: generated.publicKeyPem,
        proofKeyJwk: generated.proofKeyJwk,
      };
      return cachedProofRecord;
    })().finally(() => {
      if (inFlightProofKeyRecord === flight) {
        inFlightProofKeyRecord = null;
      }
    });

    inFlightProofKeyRecord = flight;
    flight.catch(() => {});
    return flight;
  };

  const prunePendingOAuthStates = () => {
    const now = Date.now();
    for (const [st, expiresAt] of pendingOAuthStates.entries()) {
      if (expiresAt <= now) {
        pendingOAuthStates.delete(st);
      }
    }
  };

  /**
   * @param {Record<string, any>} [options]
   */
  const beginOAuthAuthorization = (options = {}) => {
    prunePendingOAuthStates();
    const authReq = buildXboxAuthorizationUrl({
      clientId,
      ...options,
    });
    setBoundedMapEntry(
      pendingOAuthStates,
      authReq.state,
      Date.now() + PENDING_OAUTH_STATE_TTL_MS,
      MAX_PENDING_OAUTH_STATES
    );
    return authReq;
  };

  /**
   * Clears a specific pending OAuth state (for concurrent flows) or all pending states when
   * invoked without arguments (preserving single-flow API behavior).
   *
   * @param {string} [specificState]
   */
  const clearPendingOAuthState = (specificState) => {
    if (typeof specificState === 'string' && specificState.trim()) {
      pendingOAuthStates.delete(specificState.trim());
      return;
    }
    pendingOAuthStates.clear();
  };

  /**
   * Single-flight MSA renewal for Plane 1 (`user.auth.xboxlive.com`) or Plane 2 (`www.microsoft.com`).
   *
   * @param {'xbl' | 'store' | 'collections'} plane
   * @param {AbortSignal | undefined} signal
   */
  const refreshMsaPlane = async (plane, signal) => {
    const lockKey = `${lockScopeKey}:${plane}`;
    const existingFlight = globalInFlightMsaRenewals.get(lockKey);
    if (existingFlight) {
      return racePromiseWithCallerSignal(existingFlight, signal);
    }
    if (signal?.aborted) {
      throw createAbortError(signal.reason);
    }

    const promise = (async () => {
      const saved = await loadXboxVaultRecordAsync();

      if (plane === 'collections') {
        if (saved.userStsLegacyTokenXml) {
          try {
            const devCtx = await xboxDeviceClep.ensureDeviceLicenseContext({
              tokenVault: vault,
              userDataDir,
              fetchImpl,
              requireLegacyToken: true,
            });
            if (devCtx?.deviceLegacyTokenXml && devCtx?.clepHmacSecret) {
              const ex = await xboxDeviceClep.exchangeUserTokenOnRst2({
                userLegacyTokenXml: saved.userStsLegacyTokenXml,
                username: saved.msaUsername || saved.accountName || 'user@example.com',
                deviceLegacyTokenXml: devCtx.deviceLegacyTokenXml,
                clepHmacSecret: devCtx.clepHmacSecret,
                inlineUx: 'Silent',
                hostingApp: xboxDeviceClep.HOSTING_APP_MS_STORE,
                scopes: [{ scopeAddress: 'dcat.update.microsoft.com', policy: 'mbi_ssl' }],
                fetchImpl,
              });
              const colTok = !ex.fault ? ex.tokens?.[0]?.compactToken : '';
              if (colTok) {
                const rawExp = ex.tokens?.[0]?.expires;
                const expiresAtIso =
                  rawExp && !Number.isNaN(Date.parse(rawExp))
                    ? new Date(Date.parse(rawExp)).toISOString()
                    : new Date(Date.now() + 8 * 3600_000).toISOString();
                return saveXboxVaultRecordAsync({
                  collectionsTicket: colTok,
                  collectionsTicketExpiresAt: expiresAtIso,
                });
              }
            }
          } catch {
            // Fall through to `www.microsoft.com` (`store`) plane renewal below
          }
          return refreshMsaPlane('store', undefined);
        }
        return saved;
      }

      if (plane === 'store') {
        if (saved.userStsLegacyTokenXml) {
          try {
            const devCtx = await xboxDeviceClep.ensureDeviceLicenseContext({
              tokenVault: vault,
              userDataDir,
              fetchImpl,
              requireLegacyToken: true,
            });
            if (devCtx?.deviceLegacyTokenXml && devCtx?.clepHmacSecret) {
              const ex = await xboxDeviceClep.exchangeUserTokenOnRst2({
                userLegacyTokenXml: saved.userStsLegacyTokenXml,
                username: saved.msaUsername || saved.accountName || 'user@example.com',
                deviceLegacyTokenXml: devCtx.deviceLegacyTokenXml,
                clepHmacSecret: devCtx.clepHmacSecret,
                inlineUx: 'Silent',
                hostingApp: xboxDeviceClep.HOSTING_APP_MS_STORE,
                scopes: [{ scopeAddress: 'www.microsoft.com', policy: 'mbi_ssl' }],
                fetchImpl,
              });
              const storeTok = !ex.fault ? ex.tokens?.[0]?.compactToken : '';
              if (storeTok) {
                const rawExp = ex.tokens?.[0]?.expires;
                const expiresAtIso =
                  rawExp && !Number.isNaN(Date.parse(rawExp))
                    ? new Date(Date.parse(rawExp)).toISOString()
                    : new Date(Date.now() + 8 * 3600_000).toISOString();
                return saveXboxVaultRecordAsync({
                  storeTicket: storeTok,
                  storeTicketExpiresAt: expiresAtIso,
                });
              }
            }
          } catch {
            // Non-fatal: `getStoreMsaToken` falls back cleanly to `http://mp.microsoft.com/` XSTS for PCGAFD
          }
        }
        return saved;
      }

      const refreshToken = saved.msaRefreshToken || saved.refresh_token;
      if (refreshToken) {
        const tokenData = await postOAuthForm(
          fetchImpl,
          {
            client_id: clientId,
            grant_type: 'refresh_token',
            refresh_token: refreshToken,
            scope: SCOPE_XBL_MBI_SSL,
          },
          undefined
        );

        const expiresInSec = Number(tokenData.expires_in || 86400) || 86400;
        const expiresAtIso = new Date(Date.now() + expiresInSec * 1000).toISOString();
        const nextRefresh = tokenData.refresh_token || refreshToken;

        return saveXboxVaultRecordAsync({
          msaRefreshToken: nextRefresh,
          refresh_token: nextRefresh,
          xblAccessToken: tokenData.access_token,
          access_token: tokenData.access_token,
          msaExpiresAt: expiresAtIso,
          msaUserId: tokenData.user_id || saved.msaUserId,
        });
      }

      if (saved.userStsLegacyTokenXml) {
        const devCtx = await xboxDeviceClep.ensureDeviceLicenseContext({
          tokenVault: vault,
          userDataDir,
          fetchImpl,
          requireLegacyToken: true,
        });
        const ex = await xboxDeviceClep.exchangeUserTokenOnRst2({
          userLegacyTokenXml: saved.userStsLegacyTokenXml,
          username: saved.msaUsername || saved.accountName || 'user@example.com',
          deviceLegacyTokenXml: devCtx.deviceLegacyTokenXml,
          clepHmacSecret: devCtx.clepHmacSecret,
          inlineUx: 'Silent',
          hostingApp: xboxDeviceClep.HOSTING_APP_MS_STORE,
          scopes: [{ scopeAddress: 'user.auth.xboxlive.com', policy: 'mbi_ssl' }],
          fetchImpl,
        });
        const xblCompact = !ex.fault ? ex.tokens?.[0]?.compactToken : '';
        if (xblCompact) {
          const rawExp = ex.tokens?.[0]?.expires;
          const expiresAtIso =
            rawExp && !Number.isNaN(Date.parse(rawExp))
              ? new Date(Date.parse(rawExp)).toISOString()
              : new Date(Date.now() + 8 * 3600_000).toISOString();
          return saveXboxVaultRecordAsync({
            xblAccessToken: xblCompact,
            access_token: xblCompact,
            msaExpiresAt: expiresAtIso,
          });
        }
      }

      throw new Error(
        'Xbox session expired: no Microsoft refresh_token saved. Please reconnect Xbox.'
      );
    })().finally(() => {
      if (globalInFlightMsaRenewals.get(lockKey) === promise) {
        globalInFlightMsaRenewals.delete(lockKey);
      }
    });

    globalInFlightMsaRenewals.set(lockKey, promise);
    promise.catch(() => {});
    return racePromiseWithCallerSignal(promise, signal);
  };

  /**
   * @param {boolean} [forceRefresh]
   * @param {AbortSignal} [signal]
   */
  const ensureValidXblUserToken = async (forceRefresh = false, signal) => {
    const saved = await loadXboxVaultRecordAsync();
    const proof = await ensureProofKeyRecordAsync(saved);
    if (
      !forceRefresh &&
      saved.xblUserToken &&
      isFutureIsoTimestamp(saved.xblUserNotAfter, 15 * 60_000)
    ) {
      return {
        xblUserToken: saved.xblUserToken,
        xblUserNotAfter: saved.xblUserNotAfter,
        uhs: saved.uhs || '',
        proof,
      };
    }

    return coalesceSingleFlight(
      globalInFlightXblUserTokens,
      lockScopeKey,
      forceRefresh,
      signal,
      async () => {
        const latestSaved = await loadXboxVaultRecordAsync();
        const activeProof = await ensureProofKeyRecordAsync(latestSaved);
        if (
          !forceRefresh &&
          latestSaved.xblUserToken &&
          isFutureIsoTimestamp(latestSaved.xblUserNotAfter, 15 * 60_000)
        ) {
          return {
            xblUserToken: latestSaved.xblUserToken,
            xblUserNotAfter: latestSaved.xblUserNotAfter,
            uhs: latestSaved.uhs || '',
            proof: activeProof,
          };
        }

        let xblAccessToken = latestSaved.xblAccessToken || latestSaved.access_token;
        if (
          forceRefresh ||
          !xblAccessToken ||
          !isFutureIsoTimestamp(latestSaved.msaExpiresAt, 10 * 60_000)
        ) {
          const refreshed = await refreshMsaPlane('xbl', undefined);
          xblAccessToken = refreshed.xblAccessToken;
        }

        let xasu;
        try {
          xasu = await authenticateXblUser(
            fetchImpl,
            xblAccessToken,
            activeProof,
            undefined,
            getSignFn()
          );
        } catch (err) {
          if (!forceRefresh) {
            const refreshed = await refreshMsaPlane('xbl', undefined);
            xasu = await authenticateXblUser(
              fetchImpl,
              refreshed.xblAccessToken,
              activeProof,
              undefined,
              getSignFn()
            );
          } else {
            throw err;
          }
        }

        await saveXboxVaultRecordAsync({
          xblUserToken: xasu.token,
          xblUserNotAfter: xasu.notAfter,
          uhs: xasu.uhs || latestSaved.uhs,
        });

        return {
          xblUserToken: xasu.token,
          xblUserNotAfter: xasu.notAfter,
          uhs: xasu.uhs,
          proof: activeProof,
        };
      }
    );
  };

  /**
   * @param {{
   *   rawXblAccessToken: string,
   *   proof: any,
   *   initialStoreTicket?: string,
   *   signal?: AbortSignal,
   * }} params
   */
  const finalizeXboxUserSession = async ({
    rawXblAccessToken,
    proof,
    initialStoreTicket = '',
    signal,
  }) => {
    const signFn = getSignFn();
    const xasu = await authenticateXblUser(fetchImpl, rawXblAccessToken, proof, signal, signFn);
    await saveXboxVaultRecordAsync({
      xblUserToken: xasu.token,
      xblUserNotAfter: xasu.notAfter,
      uhs: xasu.uhs,
    });

    let xsts;
    try {
      xsts = await authorizeXstsInternal(
        fetchImpl,
        {
          relyingParty: XSTS_RELYING_PARTIES.XBOX_LIVE,
          xblUserToken: xasu.token,
          sandboxId: 'RETAIL',
          proof,
          signal,
        },
        signFn
      );
    } catch (err) {
      if (err && /** @type {any} */ (err).xerr === 2148916233) {
        await saveXboxVaultRecordAsync({
          xboxProfileMissing: true,
          gamertag: 'Microsoft Store User',
        });
      }
      throw err;
    }

    let mpAuthHeader = '';
    try {
      const mpXsts = await authorizeXstsInternal(
        fetchImpl,
        {
          relyingParty: XSTS_RELYING_PARTIES.MS_STORE,
          xblUserToken: xasu.token,
          sandboxId: 'RETAIL',
          proof,
          signal,
        },
        signFn
      );
      mpAuthHeader = mpXsts.authorizationHeader || '';
      await saveXboxVaultRecordAsync({
        xstsMpToken: mpXsts.token,
        xstsMpUhs: mpXsts.uhs,
        xstsMpNotAfter: mpXsts.notAfter,
      });
      setBoundedMapEntry(
        rpXstsCache,
        buildRpXstsCacheKey(XSTS_RELYING_PARTIES.MS_STORE, 'RETAIL', 'user'),
        mpXsts,
        MAX_RP_XSTS_CACHE_ENTRIES
      );
    } catch {}

    const profile = await fetchProfileSettings(fetchImpl, xsts.authorizationHeader, signal);
    const gamertag =
      profile?.uniqueModernGamertag ||
      profile?.gamertag ||
      xsts.uniqueModernGamertag ||
      xsts.gamertag ||
      'Xbox Player';
    const modernGamertag =
      profile?.modernGamertag || xsts.modernGamertag || xsts.gamertag || gamertag;
    const gamerpicUrl = profile?.gamerpicUrl || '';
    const xuid = profile?.xuid || xsts.xuid || '';

    const savedRecord = await saveXboxVaultRecordAsync({
      xboxProfileMissing: false,
      xuid,
      gamertag,
      modernGamertag,
      accountName: gamertag,
      avatarUrl: gamerpicUrl || undefined,
      gamerpicUrl: gamerpicUrl || undefined,
      gamerscore: profile?.gamerscore ?? 0,
      uhs: xsts.uhs,
      xstsXboxLiveToken: xsts.token,
      xstsXboxLiveNotAfter: xsts.notAfter,
    });

    setBoundedMapEntry(
      rpXstsCache,
      buildRpXstsCacheKey(XSTS_RELYING_PARTIES.XBOX_LIVE, 'RETAIL', 'user'),
      {
        ...xsts,
        xuid,
        gamertag,
        modernGamertag,
      },
      MAX_RP_XSTS_CACHE_ENTRIES
    );

    const effectiveStoreTicket = initialStoreTicket
      ? normalizeStoreMsaTicket(initialStoreTicket, { target: 'pcgafd' })
      : mpAuthHeader;

    return {
      xuid,
      gamertag,
      modernGamertag,
      gamerpicUrl: savedRecord.gamerpicUrl || '',
      gamerscore: savedRecord.gamerscore || 0,
      uhs: xsts.uhs,
      xstsToken: xsts.token,
      authorizationHeader: xsts.authorizationHeader,
      storeTicket: effectiveStoreTicket,
    };
  };

  /**
   * @param {string | Record<string, any>} codeOrUrl
   * @param {string | Record<string, any>} [options]
   */
  const exchangeAuthCode = async (codeOrUrl, options = {}) => {
    /** @type {Record<string, any>} */
    const opts =
      typeof options === 'string'
        ? { expectedState: options }
        : options && typeof options === 'object'
          ? options
          : {};

    prunePendingOAuthStates();

    const explicitExpectedState =
      opts.expectedState !== undefined
        ? opts.expectedState
        : codeOrUrl && typeof codeOrUrl === 'object' && codeOrUrl.expectedState !== undefined
          ? codeOrUrl.expectedState
          : undefined;

    /** @type {string | undefined} */
    let effectiveExpectedState = explicitExpectedState;
    /** @type {string | null} */
    let matchedPendingState = null;

    if (explicitExpectedState === undefined && pendingOAuthStates.size > 0) {
      const candidateState = extractOAuthCallbackStateCandidate(codeOrUrl, opts.redirectUri);
      if (candidateState) {
        for (const storedState of pendingOAuthStates.keys()) {
          if (verifyXboxOAuthState(candidateState, storedState)) {
            matchedPendingState = storedState;
          }
        }
      }
      effectiveExpectedState =
        matchedPendingState !== null
          ? matchedPendingState
          : pendingOAuthStates.keys().next().value;
    }

    const code = extractAuthCodeFromInput(codeOrUrl, {
      expectedState: effectiveExpectedState,
      redirectUri: opts.redirectUri,
      requireState: Boolean(opts.requireState || (explicitExpectedState === undefined && pendingOAuthStates.size > 0)),
    });

    if (matchedPendingState !== null) {
      pendingOAuthStates.delete(matchedPendingState);
    } else if (typeof explicitExpectedState === 'string' && pendingOAuthStates.has(explicitExpectedState)) {
      pendingOAuthStates.delete(explicitExpectedState);
    }

    const priorVault = await loadXboxVaultRecordAsync();
    const proof = await ensureProofKeyRecordAsync(priorVault);

    const xblOauth = await postOAuthForm(
      fetchImpl,
      {
        client_id: clientId,
        grant_type: 'authorization_code',
        code,
        redirect_uri: opts.redirectUri || XBOX_OAUTH_REDIRECT_URI,
        scope: SCOPE_XBL_MBI_SSL,
      },
      opts.signal
    );

    const msaExpiresAt = new Date(
      Date.now() + (Number(xblOauth.expires_in || 86400) || 86400) * 1000
    ).toISOString();
    const latestRefreshToken = xblOauth.refresh_token || '';

    const savedAfterOauth = await saveXboxVaultRecordAsync({
      access_token: xblOauth.access_token,
      xblAccessToken: xblOauth.access_token,
      msaExpiresAt,
      msaRefreshToken: latestRefreshToken,
      refresh_token: latestRefreshToken,
      msaUserId: xblOauth.user_id || '',
      syncMode: priorVault.syncMode || 'owned_and_played',
    });

    return finalizeXboxUserSession({
      rawXblAccessToken: xblOauth.access_token,
      proof,
      initialStoreTicket: savedAfterOauth.storeTicket || '',
      signal: opts.signal,
    });
  };

  /**
   * @param {Record<string, any>} daProperty
   * @param {Record<string, any>} [options]
   */
  const exchangeTokenBrokerDaProperty = async (daProperty, options = {}) => {
    if (!daProperty || typeof daProperty !== 'object' || !daProperty.sDAToken) {
      throw new Error('Missing Microsoft TokenBroker DAProperty payload');
    }

    const isSecondLeg = Boolean(options.isSecondLeg);
    const brokerClientId = String(options.clientId || XBOX_TOKEN_BROKER_CLIENT_ID).trim();
    const username = String(daProperty.sSigninName || 'user@example.com').trim();
    const puid = String(daProperty.K || '').trim();
    const inlineFt = String(daProperty.sSTSInlineFlowToken || '').trim();
    const userDaTokenXml = String(daProperty.sDAToken || '').trim();

    const devCtx = await xboxDeviceClep.ensureDeviceLicenseContext({
      tokenVault: vault,
      userDataDir,
      fetchImpl,
      requireLegacyToken: true,
    });

    const scopes = [{ scopeAddress: XBOX_TOKEN_BROKER_SCOPE, policy: 'TOKEN_BROKER' }];
    if (isSecondLeg) {
      scopes.push({ scopeAddress: 'http://Passport.NET/tb', policy: '' });
    }

    const ex = await xboxDeviceClep.exchangeUserTokenOnRst2({
      userLegacyTokenXml: userDaTokenXml,
      username,
      deviceLegacyTokenXml: devCtx.deviceLegacyTokenXml,
      clepHmacSecret: devCtx.clepHmacSecret,
      inlineFt,
      inlineUx: 'TokenBroker',
      hostingApp: brokerClientId,
      scopes,
      fetchImpl,
    });

    if (ex.fault) {
      if (!isSecondLeg && ex.inlineAuthUrl && isTrustedXboxAuthUrl(ex.inlineAuthUrl)) {
        return {
          completed: false,
          requiresInlineConsent: true,
          inlineAuthUrl: ex.inlineAuthUrl,
        };
      }
      throw new Error(
        ex.faultReason || `Microsoft TokenBroker exchange failed (reqStatus=${ex.reqStatus || 'unknown'})`
      );
    }

    const xblTokEntry =
      ex.tokens.find((t) => isXboxLiveUserAuthScope(t.scopeAddress)) ||
      ex.tokens.find((t) => Boolean(t.compactToken));
    if (!xblTokEntry?.compactToken) {
      throw new Error('Microsoft TokenBroker exchange did not return an Xbox Live ticket');
    }

    let stsLegacyXml = ex.tokens.find((t) => Boolean(t.legacyTokenXml))?.legacyTokenXml || '';

    if (!stsLegacyXml) {
      try {
        const tbEx = await xboxDeviceClep.exchangeUserTokenOnRst2({
          userLegacyTokenXml: userDaTokenXml,
          username,
          deviceLegacyTokenXml: devCtx.deviceLegacyTokenXml,
          clepHmacSecret: devCtx.clepHmacSecret,
          inlineFt,
          inlineUx: 'Silent',
          hostingApp: brokerClientId,
          scopes: [{ scopeAddress: 'http://Passport.NET/tb', policy: '' }],
          fetchImpl,
        });
        if (!tbEx.fault) {
          stsLegacyXml = tbEx.tokens.find((t) => Boolean(t.legacyTokenXml))?.legacyTokenXml || '';
        }
      } catch {}
      if (!stsLegacyXml && /<\s*(?:[\w-]+:)?EncryptedData\b/i.test(userDaTokenXml)) {
        stsLegacyXml = userDaTokenXml;
      }
    }

    let storeTicket = '';
    let storeTicketExpiresAt = '';
    if (stsLegacyXml) {
      try {
        const storeEx = await xboxDeviceClep.exchangeUserTokenOnRst2({
          userLegacyTokenXml: stsLegacyXml,
          username,
          deviceLegacyTokenXml: devCtx.deviceLegacyTokenXml,
          clepHmacSecret: devCtx.clepHmacSecret,
          inlineUx: 'Silent',
          hostingApp: xboxDeviceClep.HOSTING_APP_MS_STORE,
          scopes: [{ scopeAddress: 'www.microsoft.com', policy: 'mbi_ssl' }],
          fetchImpl,
        });
        if (!storeEx.fault && storeEx.tokens?.[0]?.compactToken) {
          storeTicket = storeEx.tokens[0].compactToken;
          const rawExp = storeEx.tokens[0].expires;
          storeTicketExpiresAt =
            rawExp && !Number.isNaN(Date.parse(rawExp))
              ? new Date(Date.parse(rawExp)).toISOString()
              : new Date(Date.now() + 8 * 3600_000).toISOString();
        }
      } catch {}
    }

    const msaExpiresAt =
      xblTokEntry.expires && !Number.isNaN(Date.parse(xblTokEntry.expires))
        ? new Date(Date.parse(xblTokEntry.expires)).toISOString()
        : new Date(Date.now() + 8 * 3600_000).toISOString();

    const priorVault = await loadXboxVaultRecordAsync();
    const savedRecord = await saveXboxVaultRecordAsync({
      access_token: xblTokEntry.compactToken,
      xblAccessToken: xblTokEntry.compactToken,
      msaExpiresAt,
      msaUsername: username,
      msaPuid: puid || priorVault.msaPuid || '',
      userStsLegacyTokenXml: stsLegacyXml || priorVault.userStsLegacyTokenXml || '',
      storeTicket: storeTicket || priorVault.storeTicket || '',
      storeTicketExpiresAt: storeTicketExpiresAt || priorVault.storeTicketExpiresAt || '',
      syncMode: priorVault.syncMode || 'owned_and_played',
    });

    const proof = await ensureProofKeyRecordAsync(savedRecord);
    const sessionSummary = await finalizeXboxUserSession({
      rawXblAccessToken: xblTokEntry.compactToken,
      proof,
      initialStoreTicket: storeTicket,
      signal: options.signal,
    });

    return {
      completed: true,
      requiresInlineConsent: false,
      ...sessionSummary,
    };
  };

  /**
   * @param {Record<string, any>} [options]
   */
  const getValidXboxSession = async (options = {}) => {
    const forceRefresh = Boolean(options.forceRefresh);
    const saved =
      options._savedSnapshot && typeof options._savedSnapshot === 'object'
        ? options._savedSnapshot
        : await loadXboxVaultRecordAsync();
    const xblLiveCacheKey = buildRpXstsCacheKey(XSTS_RELYING_PARTIES.XBOX_LIVE, 'RETAIL', 'user');

    if (forceRefresh) {
      rpXstsCache.delete(xblLiveCacheKey);
    }

    if (
      !forceRefresh &&
      saved.xstsXboxLiveToken &&
      saved.uhs &&
      isFutureIsoTimestamp(saved.xstsXboxLiveNotAfter, 10 * 60_000)
    ) {
      return {
        xuid: saved.xuid || '',
        gamertag: saved.gamertag || saved.accountName || 'Xbox Player',
        modernGamertag: saved.modernGamertag || saved.gamertag || 'Xbox Player',
        gamerpicUrl: saved.gamerpicUrl || saved.avatarUrl || '',
        gamerscore: saved.gamerscore || 0,
        uhs: saved.uhs,
        xstsToken: saved.xstsXboxLiveToken,
        notAfter: saved.xstsXboxLiveNotAfter,
        authorizationHeader: `XBL3.0 x=${saved.uhs};${saved.xstsXboxLiveToken}`,
      };
    }

    return coalesceSingleFlight(
      globalInFlightXblSessionRenewals,
      lockScopeKey,
      forceRefresh,
      options.signal,
      async () => {
        const { xblUserToken, proof } = await ensureValidXblUserToken(forceRefresh, undefined);
        const xsts = await authorizeXstsInternal(
          fetchImpl,
          {
            relyingParty: XSTS_RELYING_PARTIES.XBOX_LIVE,
            xblUserToken,
            sandboxId: 'RETAIL',
            proof,
            signal: undefined,
          },
          getSignFn()
        );

        const current = await loadXboxVaultRecordAsync();
        let gamerpicUrl = current.gamerpicUrl || current.avatarUrl || '';
        let gamerscore = current.gamerscore || 0;
        let resolvedXuid = xsts.xuid || current.xuid || '';
        let resolvedGamertag =
          xsts.uniqueModernGamertag || xsts.gamertag || current.gamertag || 'Xbox Player';
        let resolvedModernGt = xsts.modernGamertag || current.modernGamertag || resolvedGamertag;

        if (!gamerpicUrl || options.refreshProfile) {
          const profile = await fetchProfileSettings(fetchImpl, xsts.authorizationHeader, undefined);
          if (profile) {
            gamerpicUrl = profile.gamerpicUrl || gamerpicUrl;
            gamerscore = profile.gamerscore || gamerscore;
            resolvedXuid = profile.xuid || resolvedXuid;
            resolvedGamertag =
              profile.uniqueModernGamertag || profile.gamertag || resolvedGamertag;
            resolvedModernGt = profile.modernGamertag || resolvedModernGt;
          }
        }

        const staleMpTokenPatch =
          current.xstsMpNotAfter && !isFutureIsoTimestamp(current.xstsMpNotAfter, 0)
            ? { xstsMpToken: '', xstsMpNotAfter: '' }
            : {};

        await saveXboxVaultRecordAsync({
          ...staleMpTokenPatch,
          xuid: resolvedXuid,
          gamertag: resolvedGamertag,
          modernGamertag: resolvedModernGt,
          accountName: resolvedGamertag,
          avatarUrl: gamerpicUrl || undefined,
          gamerpicUrl: gamerpicUrl || undefined,
          gamerscore,
          uhs: xsts.uhs,
          xstsXboxLiveToken: xsts.token,
          xstsXboxLiveNotAfter: xsts.notAfter,
        });

        setBoundedMapEntry(
          rpXstsCache,
          xblLiveCacheKey,
          {
            ...xsts,
            xuid: resolvedXuid,
            gamertag: resolvedGamertag,
            modernGamertag: resolvedModernGt,
          },
          MAX_RP_XSTS_CACHE_ENTRIES
        );

        return {
          xuid: resolvedXuid,
          gamertag: resolvedGamertag,
          modernGamertag: resolvedModernGt,
          gamerpicUrl,
          gamerscore,
          uhs: xsts.uhs,
          xstsToken: xsts.token,
          notAfter: xsts.notAfter,
          authorizationHeader: xsts.authorizationHeader,
        };
      }
    );
  };

  /**
   * @param {string | Record<string, any>} [rawOptions]
   */
  const getStoreMsaToken = async (rawOptions = {}) => {
    /** @type {Record<string, any>} */
    const options = typeof rawOptions === 'string' ? { target: rawOptions } : rawOptions || {};
    const forceRefresh = Boolean(options.forceRefresh);
    const target = options.forLicensing ? 'licensing' : options.target || 'pcgafd';
    let saved = await loadXboxVaultRecordAsync();

    if (target === 'collections' || target === 'collections_bare') {
      const hasValidSavedCollectionsTicket =
        !forceRefresh &&
        Boolean(saved.collectionsTicket) &&
        (!saved.collectionsTicketExpiresAt ||
          isFutureIsoTimestamp(saved.collectionsTicketExpiresAt, 5 * 60_000));
      const hasValidSavedStoreTicketForCol =
        !forceRefresh &&
        Boolean(saved.storeTicket) &&
        (!saved.storeTicketExpiresAt ||
          isFutureIsoTimestamp(saved.storeTicketExpiresAt, 5 * 60_000));

      if (
        !hasValidSavedCollectionsTicket &&
        !hasValidSavedStoreTicketForCol &&
        saved.userStsLegacyTokenXml
      ) {
        saved = await refreshMsaPlane('collections', options.signal);
      }

      const usableCollectionsTicket =
        saved.collectionsTicket &&
        (!saved.collectionsTicketExpiresAt ||
          isFutureIsoTimestamp(saved.collectionsTicketExpiresAt, 60_000))
          ? saved.collectionsTicket
          : saved.storeTicket &&
              (!saved.storeTicketExpiresAt ||
                isFutureIsoTimestamp(saved.storeTicketExpiresAt, 60_000))
            ? saved.storeTicket
            : '';

      if (usableCollectionsTicket) {
        if (options.returnBundle) {
          const formatted = formatStoreAuthTickets(usableCollectionsTicket);
          return {
            rawTicket: usableCollectionsTicket,
            pcgafdTicket: formatted.pcgafdTicket,
            licensingTicket: formatted.licensingTicket,
            collectionsTicket: formatted.collectionsTicket,
            collectionsBareTicket: formatted.collectionsBareTicket,
            expiresAt: saved.collectionsTicketExpiresAt || saved.storeTicketExpiresAt || '',
          };
        }
        return normalizeStoreMsaTicket(usableCollectionsTicket, { target });
      }

      if (options.returnBundle) {
        return {
          rawTicket: '',
          pcgafdTicket: '',
          licensingTicket: '',
          collectionsTicket: '',
          collectionsBareTicket: '',
          expiresAt: '',
        };
      }
      return '';
    }

    const hasValidSavedStoreTicket =
      !forceRefresh &&
      Boolean(saved.storeTicket) &&
      (!saved.storeTicketExpiresAt || isFutureIsoTimestamp(saved.storeTicketExpiresAt, 5 * 60_000));

    if (!hasValidSavedStoreTicket && saved.userStsLegacyTokenXml) {
      saved = await refreshMsaPlane('store', options.signal);
    }

    const usableStoreTicket =
      saved.storeTicket &&
      (!saved.storeTicketExpiresAt || isFutureIsoTimestamp(saved.storeTicketExpiresAt, 60_000))
        ? saved.storeTicket
        : '';

    if (usableStoreTicket) {
      if (options.returnBundle) {
        const formatted = formatStoreAuthTickets(usableStoreTicket);
        return {
          rawTicket: usableStoreTicket,
          pcgafdTicket: formatted.pcgafdTicket,
          licensingTicket: formatted.licensingTicket,
          collectionsTicket: formatted.collectionsTicket,
          collectionsBareTicket: formatted.collectionsBareTicket,
          expiresAt: saved.storeTicketExpiresAt,
        };
      }
      return normalizeStoreMsaTicket(usableStoreTicket, { target });
    }

    if ((target === 'pcgafd' || target === 'store') && !options.strictMsaOnly) {
      const mpXsts = await getXstsToken(XSTS_RELYING_PARTIES.MS_STORE, {
        forceRefresh,
        signal: options.signal,
      });
      if (options.returnBundle) {
        return {
          rawTicket: mpXsts.authorizationHeader,
          pcgafdTicket: mpXsts.authorizationHeader,
          licensingTicket: '',
          collectionsTicket: '',
          collectionsBareTicket: '',
          expiresAt: mpXsts.notAfter,
        };
      }
      return mpXsts.authorizationHeader;
    }

    if (options.returnBundle) {
      return {
        rawTicket: '',
        pcgafdTicket: '',
        licensingTicket: '',
        collectionsTicket: '',
        collectionsBareTicket: '',
        expiresAt: '',
      };
    }
    return '';
  };

  /**
   * @param {string | Record<string, any>} [targetOrOptions]
   */
  const getValidStoreToken = (targetOrOptions = 'pcgafd') =>
    getStoreMsaToken(
      typeof targetOrOptions === 'string' ? { target: targetOrOptions } : targetOrOptions
    );

  /**
   * @param {string} [relyingParty]
   * @param {Record<string, any>} [options]
   */
  const getXstsToken = async (relyingParty = XSTS_RELYING_PARTIES.XBOX_LIVE, options = {}) => {
    const rp = String(relyingParty || XSTS_RELYING_PARTIES.XBOX_LIVE);
    const sandboxId = String(options.sandboxId || 'RETAIL').trim() || 'RETAIL';
    const forceRefresh = Boolean(options.forceRefresh);

    if (
      rp === XSTS_RELYING_PARTIES.XBOX_LIVE &&
      sandboxId === 'RETAIL' &&
      !options.deviceToken &&
      !options.titleToken &&
      !options.userTokenOverride
    ) {
      const session = await getValidXboxSession({ forceRefresh, signal: options.signal });
      return {
        token: session.xstsToken,
        uhs: session.uhs,
        xuid: session.xuid,
        gamertag: session.gamertag,
        modernGamertag: session.modernGamertag,
        notAfter: session.notAfter,
        authorizationHeader: session.authorizationHeader,
      };
    }

    const subjectParts = [
      options.userTokenOverride
        ? `usr:${crypto.createHash('sha256').update(String(options.userTokenOverride)).digest('hex').slice(0, 12)}`
        : 'user',
    ];
    if (options.deviceToken) {
      subjectParts.push(
        `dev:${crypto.createHash('sha256').update(String(options.deviceToken)).digest('hex').slice(0, 12)}`
      );
    }
    if (options.titleToken) {
      subjectParts.push(
        `tit:${crypto.createHash('sha256').update(String(options.titleToken)).digest('hex').slice(0, 12)}`
      );
    }
    const subjectType = subjectParts.join('+');
    const cacheKey = buildRpXstsCacheKey(rp, sandboxId, subjectType);

    const isVaultPersistableMpXsts =
      rp === XSTS_RELYING_PARTIES.MS_STORE &&
      sandboxId === 'RETAIL' &&
      !options.titleToken &&
      !options.userTokenOverride;

    if (forceRefresh) {
      rpXstsCache.delete(cacheKey);
    } else {
      const cached = rpXstsCache.get(cacheKey);
      if (cached && isFutureIsoTimestamp(cached.notAfter, 10 * 60_000)) {
        if (isVaultPersistableMpXsts && cached.token && cached.uhs && cached.notAfter) {
          const curSaved = await loadXboxVaultRecordAsync();
          if (curSaved.xstsMpNotAfter !== cached.notAfter) {
            await saveXboxVaultRecordAsync({
              xstsMpToken: cached.token,
              xstsMpUhs: cached.uhs,
              xstsMpNotAfter: cached.notAfter,
            }).catch(() => {});
          }
        }
        return cached;
      }
    }

    const saved =
      options._savedSnapshot && typeof options._savedSnapshot === 'object'
        ? options._savedSnapshot
        : await loadXboxVaultRecordAsync();
    if (
      !forceRefresh &&
      isVaultPersistableMpXsts &&
      subjectType === 'user' &&
      saved.xstsMpToken &&
      saved.xstsMpUhs &&
      isFutureIsoTimestamp(saved.xstsMpNotAfter, 10 * 60_000)
    ) {
      const hit = {
        token: saved.xstsMpToken,
        uhs: saved.xstsMpUhs,
        xuid: saved.xuid || '',
        gamertag: saved.gamertag || '',
        notAfter: saved.xstsMpNotAfter,
        authorizationHeader: `XBL3.0 x=${saved.xstsMpUhs};${saved.xstsMpToken}`,
      };
      setBoundedMapEntry(rpXstsCache, cacheKey, hit, MAX_RP_XSTS_CACHE_ENTRIES);
      return hit;
    }

    return coalesceSingleFlight(inFlightRpXsts, cacheKey, forceRefresh, options.signal, async () => {
      const { xblUserToken, proof } = await ensureValidXblUserToken(forceRefresh, undefined);
      const minted = await authorizeXstsInternal(
        fetchImpl,
        {
          relyingParty: rp,
          xblUserToken: options.userTokenOverride || xblUserToken,
          deviceToken: options.deviceToken,
          titleToken: options.titleToken,
          sandboxId,
          proof,
          signal: undefined,
        },
        getSignFn()
      );

      if (isVaultPersistableMpXsts && minted.token && minted.uhs) {
        await saveXboxVaultRecordAsync({
          xstsMpToken: minted.token,
          xstsMpUhs: minted.uhs,
          xstsMpNotAfter: minted.notAfter,
        }).catch(() => {});
      }

      setBoundedMapEntry(rpXstsCache, cacheKey, minted, MAX_RP_XSTS_CACHE_ENTRIES);
      return minted;
    });
  };

  /**
   * @param {{ mode?: 'rps' | 'pop', forceRefresh?: boolean, signal?: AbortSignal }} [options]
   * @returns {Promise<string>}
   */
  const getXblDeviceToken = async ({ mode = 'rps', forceRefresh = false, signal } = {}) => {
    const normMode = String(mode || 'rps').toLowerCase() === 'pop' ? 'pop' : 'rps';
    const cached = xblDeviceTokenCache.get(normMode);
    if (!forceRefresh && cached?.token && isFutureIsoTimestamp(cached.notAfter, 10 * 60_000)) {
      return cached.token;
    }

    return coalesceSingleFlight(
      inFlightDeviceTokens,
      normMode,
      forceRefresh,
      signal,
      async () => {
        const proof = await ensureProofKeyRecordAsync();
        const signFn = getSignFn();

        if (normMode === 'pop') {
          const savedDevCtx = (await loadXboxVaultRecordAsync())?.deviceContext || {};
          const hwSeed = await resolveHardwareSeedAsync();
          const seedBase =
            savedDevCtx.hwDeviceId || savedDevCtx.deviceMembername || hwSeed || lockScopeKey;
          const idUuid = deriveDashedUuidFromSeed(String(seedBase), 'xbl-pop-device-id');
          const serialUuid = deriveDashedUuidFromSeed(
            String(savedDevCtx.deviceMembername || seedBase),
            'xbl-pop-device-serial'
          );

          const popRes = await postDeviceAuthenticate(
            fetchImpl,
            {
              AuthMethod: 'ProofOfPossession',
              Id: `{${idUuid}}`,
              DeviceType: 'Win32',
              SerialNumber: `{${serialUuid}}`,
              Version: '10.0.22631',
              ProofKey: proof.proofKeyJwk,
            },
            proof,
            signFn
          );

          if (!popRes.ok || !popRes.json?.Token) {
            throw Object.assign(
              new Error(
                `Xbox device.auth.xboxlive.com (PoP) failed (HTTP ${popRes.status}, MS-CV=${popRes.msCv})`
              ),
              { status: popRes.status, msCv: popRes.msCv }
            );
          }

          const notAfter =
            popRes.json.NotAfter || new Date(Date.now() + 4 * 3600_000).toISOString();
          setBoundedMapEntry(
            xblDeviceTokenCache,
            'pop',
            { token: popRes.json.Token, notAfter },
            MAX_DEVICE_TOKEN_CACHE_ENTRIES
          );
          return popRes.json.Token;
        }

        // `normMode === 'rps'`: Hardware-trusted Win32 RPS DeviceToken
        const devCtx = await ensureDeviceContext({ forceRefresh });
        const rawTicket = String(devCtx?.deviceToken || '')
          .replace(/^WLID1\.0="/i, '')
          .replace(/^"+|"+$/g, '')
          .trim()
          .replace(/^[td]=/i, '');
        if (!rawTicket) {
          throw new Error('Xbox RPS DeviceToken requires a provisioned device ticket');
        }

        const hwSeed = await resolveHardwareSeedAsync();
        const seedBase = devCtx?.hwDeviceId || devCtx?.deviceMembername || hwSeed || lockScopeKey;
        const idUuid = deriveDashedUuidFromSeed(String(seedBase), 'xbl-device-id');
        const serialUuid = deriveDashedUuidFromSeed(
          String(devCtx?.deviceMembername || seedBase),
          'xbl-device-serial'
        );

        const buildRpsProps = (/** @type {string} */ prefix) => ({
          AuthMethod: 'RPS',
          SiteName: 'user.auth.xboxlive.com',
          RpsTicket: `${prefix}${rawTicket}`,
          Id: `{${idUuid}}`,
          DeviceType: 'Win32',
          SerialNumber: `{${serialUuid}}`,
          Version: '10.0.22631',
          ProofKey: proof.proofKeyJwk,
        });

        let rpsRes = await postDeviceAuthenticate(fetchImpl, buildRpsProps('t='), proof, signFn);
        if (!rpsRes.ok || !rpsRes.json?.Token) {
          const dFallbackRes = await postDeviceAuthenticate(
            fetchImpl,
            buildRpsProps('d='),
            proof,
            signFn
          );
          if (dFallbackRes.ok && dFallbackRes.json?.Token) {
            rpsRes = dFallbackRes;
          }
        }

        if (!rpsRes.ok || !rpsRes.json?.Token) {
          throw Object.assign(
            new Error(
              `Xbox device.auth.xboxlive.com (RPS) failed (HTTP ${rpsRes.status}, MS-CV=${rpsRes.msCv})`
            ),
            { status: rpsRes.status, msCv: rpsRes.msCv }
          );
        }

        const notAfter =
          rpsRes.json.NotAfter || new Date(Date.now() + 4 * 3600_000).toISOString();
        setBoundedMapEntry(
          xblDeviceTokenCache,
          'rps',
          { token: rpsRes.json.Token, notAfter },
          MAX_DEVICE_TOKEN_CACHE_ENTRIES
        );
        return rpsRes.json.Token;
      }
    );
  };

  /**
   * @param {string} msaAppId
   * @param {boolean} [forceRefresh]
   * @param {AbortSignal} [signal]
   */
  const getSisuTitleSession = async (msaAppId, forceRefresh = false, signal) => {
    const cleanAppId = String(msaAppId || '').trim();
    if (!cleanAppId) return null;

    const cached = sisuSessionCache.get(cleanAppId);
    if (!forceRefresh && cached && isFutureIsoTimestamp(cached.notAfter, 10 * 60_000)) {
      return cached;
    }

    return coalesceSingleFlight(
      inFlightSisuSessions,
      cleanAppId,
      forceRefresh,
      signal,
      async () => {
        const proof = await ensureProofKeyRecordAsync();
        let saved = await loadXboxVaultRecordAsync();
        if (!saved.xblAccessToken || !isFutureIsoTimestamp(saved.msaExpiresAt, 10 * 60_000)) {
          saved = await refreshMsaPlane('xbl', undefined);
        }
        const userRpsTicket = normalizeXblRpsTicket(saved.xblAccessToken, { defaultPrefix: 't=' });
        const signFn = getSignFn();

        let sisuAttempt = null;
        try {
          const popDeviceToken = await getXblDeviceToken({
            mode: 'pop',
            forceRefresh,
            signal: undefined,
          });
          sisuAttempt = await attemptSisuAuthorize(
            fetchImpl,
            { userRpsTicket, cleanAppId, xblDeviceToken: popDeviceToken, proof },
            signFn
          );
        } catch {}

        if (!sisuAttempt || !sisuAttempt.ok) {
          try {
            const rpsDeviceToken = await getXblDeviceToken({
              mode: 'rps',
              forceRefresh,
              signal: undefined,
            });
            const rpsAttempt = await attemptSisuAuthorize(
              fetchImpl,
              { userRpsTicket, cleanAppId, xblDeviceToken: rpsDeviceToken, proof },
              signFn
            );
            if (rpsAttempt.ok || !sisuAttempt) {
              sisuAttempt = rpsAttempt;
            }
          } catch (rpsErr) {
            if (!sisuAttempt) throw rpsErr;
          }
        }

        if (!sisuAttempt || !sisuAttempt.ok) {
          throw Object.assign(
            new Error(
              `SISU authorize failed for AppId=${cleanAppId} (HTTP ${sisuAttempt?.status ?? 'ERR'}, MS-CV=${sisuAttempt?.msCv || 'none'})`
            ),
            { status: sisuAttempt?.status, msCv: sisuAttempt?.msCv || 'none' }
          );
        }

        const sisuJson = sisuAttempt.json || {};
        const authTokenObj = sisuJson?.AuthorizationToken || {};
        const xui = authTokenObj?.DisplayClaims?.xui?.[0] || {};
        const sisuTitleId = String(sisuJson?.TitleToken?.DisplayClaims?.xti?.tid || '');
        const entry = {
          msaAppId: cleanAppId,
          titleId: sisuTitleId,
          deviceToken: sisuJson?.DeviceToken || sisuAttempt.deviceToken,
          titleToken: sisuJson?.TitleToken?.Token || '',
          userToken: sisuJson?.UserToken?.Token || '',
          xstsToken: authTokenObj?.Token || '',
          uhs: xui.uhs || '',
          xuid: xui.xid || '',
          gamertag: xui.gtg || xui.mgt || '',
          notAfter: authTokenObj?.NotAfter || sisuJson?.TitleToken?.NotAfter || '',
        };
        setBoundedMapEntry(sisuSessionCache, cleanAppId, entry, MAX_TITLE_SESSION_CACHE_ENTRIES);
        return entry;
      }
    );
  };

  /**
   * @param {{ msaAppId?: string, titleId?: string | number, forceRefresh?: boolean, signal?: AbortSignal }} [params]
   */
  const getTitleAuthSession = async ({ msaAppId, titleId, forceRefresh = false, signal } = {}) => {
    const cleanAppId = String(msaAppId || '').trim();
    if (!cleanAppId) return null;

    const cached = titleAuthSessionCache.get(cleanAppId);
    if (!forceRefresh && cached && isFutureIsoTimestamp(cached.notAfter, 10 * 60_000)) {
      return cached;
    }

    const expectedDecimalTitleId = normalizeDecimalTitleId(titleId);

    return coalesceSingleFlight(
      inFlightTitleAuthSessions,
      cleanAppId,
      forceRefresh,
      signal,
      async () => {
        const proof = await ensureProofKeyRecordAsync();
        /** @type {unknown} */
        let primaryErr = null;

        try {
          const rpsDeviceToken = await getXblDeviceToken({
            mode: 'rps',
            forceRefresh,
            signal: undefined,
          });
          const broker = await xboxDeviceClep.acquireTitleBrokerTicket({
            msaAppId: cleanAppId,
            tokenVault: vault,
            userDataDir,
            fetchImpl,
            forceRefresh,
          });

          if (rpsDeviceToken && broker?.rpsTicket) {
            const titleJson = await authenticateXblTitle(
              fetchImpl,
              {
                cleanAppId,
                rpsDeviceToken,
                rpsTicket: broker.rpsTicket,
                proof,
              },
              getSignFn()
            );

            const mintedTitleId = String(
              titleJson?.DisplayClaims?.xti?.tid || expectedDecimalTitleId || ''
            );
            const xblTitleXsts = await getXstsToken(XSTS_RELYING_PARTIES.XBOX_LIVE, {
              forceRefresh,
              deviceToken: rpsDeviceToken,
              titleToken: titleJson.Token,
              signal: undefined,
            });

            const sessionEntry = {
              msaAppId: cleanAppId,
              titleId: mintedTitleId,
              deviceToken: rpsDeviceToken,
              titleToken: titleJson.Token,
              userToken: '',
              xblTitleXsts,
              notAfter: titleJson.NotAfter || xblTitleXsts?.notAfter || '',
            };
            setBoundedMapEntry(
              titleAuthSessionCache,
              cleanAppId,
              sessionEntry,
              MAX_TITLE_SESSION_CACHE_ENTRIES
            );
            return sessionEntry;
          }
        } catch (err) {
          primaryErr = err;
        }

        // Guarded SISU fallback: ONLY accept if its TitleToken matches the expected game TitleId
        try {
          const sisu = await getSisuTitleSession(cleanAppId, forceRefresh, undefined);
          if (
            sisu?.titleToken &&
            (!expectedDecimalTitleId || !sisu.titleId || sisu.titleId === expectedDecimalTitleId)
          ) {
            const xblTitleXsts =
              sisu.xstsToken && sisu.uhs
                ? {
                    token: sisu.xstsToken,
                    uhs: sisu.uhs,
                    xuid: sisu.xuid,
                    gamertag: sisu.gamertag,
                    notAfter: sisu.notAfter,
                    authorizationHeader: `XBL3.0 x=${sisu.uhs};${sisu.xstsToken}`,
                  }
                : await getXstsToken(XSTS_RELYING_PARTIES.XBOX_LIVE, {
                    forceRefresh,
                    userTokenOverride: sisu.userToken || undefined,
                    deviceToken: sisu.deviceToken || undefined,
                    titleToken: sisu.titleToken,
                    signal: undefined,
                  });

            const fallbackEntry = {
              msaAppId: cleanAppId,
              titleId: sisu.titleId || expectedDecimalTitleId || '',
              deviceToken: sisu.deviceToken || '',
              titleToken: sisu.titleToken,
              userToken: sisu.userToken || '',
              xblTitleXsts,
              notAfter: sisu.notAfter || xblTitleXsts?.notAfter || '',
            };
            setBoundedMapEntry(
              titleAuthSessionCache,
              cleanAppId,
              fallbackEntry,
              MAX_TITLE_SESSION_CACHE_ENTRIES
            );
            return fallbackEntry;
          }
        } catch {}

        if (primaryErr) throw primaryErr;
        return null;
      }
    );
  };

  /**
   * Fail-closed NSAL URL -> Relying Party resolver (P0-01):
   * 1. Rejects non-`https:`, non-default port, credentialed, or malformed URLs immediately (`null`).
   * 2. Matches exact Pre-NSAL Xbox/Microsoft infrastructure hosts.
   * 3. Queries signed Per-Title NSAL (`titles/current/endpoints` / `titles/{tid}/endpoints`).
   * 4. Queries signed System Default NSAL (`titles/default/endpoints?type=1`).
   * 5. Matches explicit Post-NSAL Xbox/Microsoft/PlayFab/Minecraft/TitleStorage hosts.
   * 6. Returns `null` (NEVER falls back to `http://xboxlive.com`) for any unrecognized host!
   *
   * @param {string} targetUrl
   * @param {string | Record<string, any>} [options]
   * @param {string} [legacyBaseXblAuthHeader]
   * @returns {Promise<string | null>}
   */
  const resolveRelyingPartyForTargetUrl = async (
    targetUrl,
    options = {},
    legacyBaseXblAuthHeader = ''
  ) => {
    if (!parseStrictNsalHttpsUrl(targetUrl)) {
      return null;
    }

    const preBuiltIn = resolvePreNsalBuiltInRelyingPartyForUrl(targetUrl);
    if (preBuiltIn) return preBuiltIn;

    /** @type {Record<string, any>} */
    const opts =
      typeof options === 'string'
        ? {
            decimalTitleId: normalizeDecimalTitleId(options),
            baseXblAuthHeader: legacyBaseXblAuthHeader || '',
          }
        : options || {};
    const decimalTitleId = String(opts.decimalTitleId || '').trim();
    const cacheKeyId = String(opts.cacheKeyId || decimalTitleId || '').trim();
    const xblTitleAuthHeader = String(opts.xblTitleAuthHeader || '').trim();
    const baseXblAuthHeader = String(opts.baseXblAuthHeader || '').trim();
    const activeProof = opts.proof || (await ensureProofKeyRecordAsync());
    const signFn = getSignFn();

    try {
      // 1. Per-Title NSAL (`titles/current/endpoints` with title-bound XSTS, or `titles/{decimalTid}/endpoints`)
      if (cacheKeyId && (xblTitleAuthHeader || decimalTitleId)) {
        if (!cachedPerTitleEndpoints.has(cacheKeyId)) {
          let flight = inFlightPerTitleEndpoints.get(cacheKeyId);
          if (!flight) {
            flight = (async () => {
              let fetched = { ok: false, endPoints: [] };
              if (xblTitleAuthHeader) {
                fetched = await fetchSignedNsalEndpoints(
                  fetchImpl,
                  XBL_TITLE_ENDPOINTS_CURRENT_URL,
                  xblTitleAuthHeader,
                  activeProof,
                  signFn
                );
              }
              if (!fetched.ok && decimalTitleId && (xblTitleAuthHeader || baseXblAuthHeader)) {
                fetched = await fetchSignedNsalEndpoints(
                  fetchImpl,
                  `https://title.mgt.xboxlive.com/titles/${encodeURIComponent(decimalTitleId)}/endpoints`,
                  xblTitleAuthHeader || baseXblAuthHeader,
                  activeProof,
                  signFn
                );
              }
              if (fetched.ok) {
                setBoundedMapEntry(
                  cachedPerTitleEndpoints,
                  cacheKeyId,
                  fetched.endPoints,
                  MAX_PER_TITLE_ENDPOINTS_CACHE_ENTRIES
                );
              }
              return fetched;
            })().finally(() => {
              if (inFlightPerTitleEndpoints.get(cacheKeyId) === flight) {
                inFlightPerTitleEndpoints.delete(cacheKeyId);
              }
            });
            inFlightPerTitleEndpoints.set(cacheKeyId, flight);
            flight.catch(() => {});
          }
          await racePromiseWithCallerSignal(flight, opts.signal);
        }
        const perTitleEps = cachedPerTitleEndpoints.get(cacheKeyId);
        if (perTitleEps) {
          const matchedTitleRp = matchDynamicTitleEndpointRelyingParty(targetUrl, perTitleEps);
          if (matchedTitleRp) return matchedTitleRp;
        }
      }

      // 2. System Default NSAL (`titles/default/endpoints?type=1`)
      const defaultAuth = xblTitleAuthHeader || baseXblAuthHeader;
      if (!cachedDefaultTitleEndpoints && defaultAuth) {
        if (!inFlightDefaultTitleEndpoints) {
          const defFlight = (async () => {
            const defaultFetched = await fetchSignedNsalEndpoints(
              fetchImpl,
              XBL_TITLE_ENDPOINTS_DEFAULT_URL,
              defaultAuth,
              activeProof,
              signFn
            );
            if (defaultFetched.ok) {
              cachedDefaultTitleEndpoints = defaultFetched.endPoints;
            }
            return defaultFetched;
          })().finally(() => {
            if (inFlightDefaultTitleEndpoints === defFlight) {
              inFlightDefaultTitleEndpoints = null;
            }
          });
          inFlightDefaultTitleEndpoints = defFlight;
          defFlight.catch(() => {});
        }
        await racePromiseWithCallerSignal(inFlightDefaultTitleEndpoints, opts.signal);
      }
      if (cachedDefaultTitleEndpoints) {
        const matchedDefaultRp = matchDynamicTitleEndpointRelyingParty(
          targetUrl,
          cachedDefaultTitleEndpoints
        );
        if (matchedDefaultRp) return matchedDefaultRp;
      }
    } catch (nsalErr) {
      if (/** @type {any} */ (nsalErr)?.name === 'AbortError' && opts.signal?.aborted) {
        throw nsalErr;
      }
    }

    // P0-01 FAIL-CLOSED: return null (NEVER default to `http://xboxlive.com`!) when host is unrecognized
    return resolvePostNsalFallbackRelyingPartyForUrl(targetUrl);
  };

  /**
   * Mints the matching Relying Party `XBL3.0 x=<uhs>;<jwt>` token AND computes the 76-byte
   * IEEE P1363 `Signature` header for a verified `https:` outbound request.
   * Fails closed on non-`https:` URLs, non-default ports, and unrecognized hosts (P0-01).
   *
   * @param {Record<string, any>} [params]
   */
  const getTokenAndSignatureForUrl = async (params = {}) => {
    const {
      url,
      method = 'GET',
      bodyBuffer,
      msaAppId,
      titleId,
      relyingPartyOverride,
      forceRefresh = false,
      signal,
    } = params;

    if (!url || typeof url !== 'string') {
      throw Object.assign(new Error('getTokenAndSignatureForUrl requires a valid target url'), {
        code: 'XBOX_NSAL_UNTRUSTED_TARGET_URL',
      });
    }

    // P0-01 FAIL-CLOSED URL GATE: enforce strict `https:` + default port 443 + valid DNS host upfront
    const parsedTargetUrl = parseStrictNsalHttpsUrl(url);
    if (!parsedTargetUrl) {
      throw Object.assign(
        new Error(
          'Rejected untrusted target URL for Xbox token/signature: requires https: on default port 443 with a valid hostname'
        ),
        { code: 'XBOX_NSAL_UNTRUSTED_TARGET_URL' }
      );
    }

    const effectiveBody = bodyBuffer !== undefined ? bodyBuffer : params.body;
    const savedSnapshot = await loadXboxVaultRecordAsync();
    const proof = await ensureProofKeyRecordAsync(savedSnapshot);
    const baseSession = await getValidXboxSession({
      forceRefresh,
      signal,
      _savedSnapshot: savedSnapshot,
    });

    const isTitleStorageHost = isTitleStorageHostname(parsedTargetUrl);

    /** @type {string | null} */
    let targetRp = null;
    let xstsResult;

    if (isTitleStorageHost) {
      targetRp = relyingPartyOverride || XSTS_RELYING_PARTIES.XBOX_LIVE;
      const rpsDeviceToken = await getXblDeviceToken({ mode: 'rps', forceRefresh, signal }).catch(
        () => null
      );
      xstsResult = await getXstsToken(targetRp, {
        forceRefresh,
        deviceToken: rpsDeviceToken || undefined,
        signal,
        _savedSnapshot: savedSnapshot,
      });
    } else {
      let titleSession = null;
      if (msaAppId) {
        try {
          titleSession = await getTitleAuthSession({ msaAppId, titleId, forceRefresh, signal });
        } catch {}
      }

      const decimalTitleId = titleSession?.titleId || normalizeDecimalTitleId(titleId);

      // Step 2: Fail-closed Relying Party resolution (Pre-NSAL -> Per-Title NSAL -> Default NSAL -> Post-NSAL allowlist)
      targetRp =
        relyingPartyOverride ||
        (await resolveRelyingPartyForTargetUrl(url, {
          decimalTitleId,
          cacheKeyId: decimalTitleId || String(msaAppId || '').trim(),
          xblTitleAuthHeader: titleSession?.xblTitleXsts?.authorizationHeader || '',
          baseXblAuthHeader: baseSession.authorizationHeader,
          proof,
          signal,
        }));

      if (!targetRp) {
        throw Object.assign(
          new Error(
            `Rejected Xbox token/signature request for unrecognized host (${parsedTargetUrl.hostname}): no matching NSAL or Xbox/Microsoft/PlayFab relying-party rule`
          ),
          { code: 'XBOX_NSAL_UNRECOGNIZED_HOST' }
        );
      }

      // Step 3: Mint XSTS token for `targetRp`
      if (titleSession?.xblTitleXsts && targetRp === XSTS_RELYING_PARTIES.XBOX_LIVE) {
        xstsResult = titleSession.xblTitleXsts;
      } else if (titleSession?.titleToken) {
        try {
          xstsResult = await getXstsToken(targetRp, {
            forceRefresh,
            userTokenOverride: titleSession.userToken || undefined,
            deviceToken: titleSession.deviceToken || undefined,
            titleToken: titleSession.titleToken,
            signal,
            _savedSnapshot: savedSnapshot,
          });
        } catch {
          try {
            xstsResult = await getXstsToken(targetRp, {
              forceRefresh,
              deviceToken: titleSession.deviceToken || undefined,
              signal,
              _savedSnapshot: savedSnapshot,
            });
          } catch {
            xstsResult = await getXstsToken(targetRp, {
              forceRefresh,
              signal,
              _savedSnapshot: savedSnapshot,
            });
          }
        }
      } else {
        let rpsDeviceToken = null;
        if (targetRp === XSTS_RELYING_PARTIES.XBOX_LIVE) {
          if (
            xblDeviceTokenCache.has('rps') ||
            savedSnapshot?.deviceContext?.deviceToken ||
            savedSnapshot?.deviceContext?.deviceMembername ||
            savedSnapshot?.userStsLegacyTokenXml
          ) {
            rpsDeviceToken = await getXblDeviceToken({ mode: 'rps', forceRefresh, signal }).catch(
              () => null
            );
          }
        }
        xstsResult = await getXstsToken(targetRp, {
          forceRefresh,
          deviceToken: rpsDeviceToken || undefined,
          signal,
          _savedSnapshot: savedSnapshot,
        });
      }
    }

    const authorizationHeader = xstsResult.authorizationHeader;
    const signature = getSignFn()({
      method,
      url,
      authorizationHeader,
      bodyBuffer: effectiveBody,
      ecPrivateKey: proof.privateKeyObj || proof.privateKeyPem,
    });

    return {
      token: authorizationHeader,
      authorizationHeader,
      rawJwt: xstsResult.token,
      signature,
      signatureHeader: signature,
      relyingParty: targetRp,
      uhs: xstsResult.uhs,
      xuid: xstsResult.xuid || baseSession.xuid,
      gamertag: xstsResult.gamertag || baseSession.gamertag,
      expiresAt: xstsResult.notAfter || baseSession.notAfter,
    };
  };

  /**
   * @param {Record<string, any>} [options]
   */
  const checkMinecraftJavaEntitlement = async (options = {}) => {
    try {
      const forceRefresh = Boolean(options.forceRefresh);
      const mcXsts = await getXstsToken(XSTS_RELYING_PARTIES.MINECRAFT, {
        forceRefresh,
        signal: options.signal,
      });
      const saved = await loadXboxVaultRecordAsync();
      return await checkMinecraftJavaEntitlementFlow({
        fetchImpl,
        lockScopeKey,
        savedXuid: saved.xuid || '',
        mcXsts,
        forceRefresh,
        signal: options.signal,
      });
    } catch (err) {
      return {
        owned: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  };

  /**
   * @param {Record<string, any>} [options]
   */
  const ensureDeviceContext = async (options = {}) => {
    let storeTicket = '';
    try {
      storeTicket = await getStoreMsaToken({ forLicensing: true, signal: options.signal });
    } catch {}
    return xboxDeviceClep.ensureDeviceLicenseContext({
      tokenVault: vault,
      userDataDir,
      fetchImpl,
      msaStoreToken: storeTicket || undefined,
      ...options,
    });
  };

  return {
    beginOAuthAuthorization,
    clearPendingOAuthState,
    buildRpXstsCacheKey,
    invalidateRpXstsCache,
    exchangeAuthCode,
    exchangeTokenBrokerDaProperty,
    getValidXboxSession,
    getStoreMsaToken,
    getValidStoreToken,
    getXstsToken,
    getXblDeviceToken,
    getSisuTitleSession,
    getTitleAuthSession,
    getTokenAndSignatureForUrl,
    checkMinecraftJavaEntitlement,
    ensureDeviceContext,
    dispose,
  };
}

module.exports = {
  bindFacade,
  createXboxAuthProvider,
};
