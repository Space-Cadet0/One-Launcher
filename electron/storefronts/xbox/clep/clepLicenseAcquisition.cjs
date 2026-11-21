// @ts-check
'use strict';

/**
 * CLEP Virtual Device Provisioning, TitleBroker Tickets & Content CIK Acquisition (`clepLicenseAcquisition.cjs`):
 * - Uses async vault I/O (`loadSavedTokensAsync`/`saveTokensAsync` + `getMachineIdentityKeyMaterialAsync`),
 *   falling back to sync vault methods ONLY when a custom test mock lacks `*Async`
 * - Unified `forceRefresh` single-flight coalescing with identity-safe `.finally()` cleanup
 * - Acquires `v7.0/licenses/content` CIKs (with Game Pass `satisfyingEntitlementKeys` retry & optional
 *   XML-DSig SPKI pinning / `0x00cc` verification forwarding) and `v8.0/licenseToken` JWTs
 */

const crypto = require('node:crypto');
const { makeCorrelationVector } = require('../xboxConfigAndIds.cjs');
const {
  HOSTING_APP_DEFAULT_IDCRL,
  HOSTING_APP_MS_STORE,
  HOSTING_APP_TOKEN_BROKER,
  LOCAL_USER_SID,
  unwrapContentCik,
  unwrapClepHmacStateSecret,
} = require('./clepCryptoPrimitives.cjs');
const {
  escapeXmlText,
  buildClepChallengeBuffers,
  generateNumericDeviceMembername,
  generateDevicePassword,
  buildDeviceAddCredentialXml,
} = require('./clepChallengeBuilder.cjs');
const {
  extractSpLicenseBase64,
  parseSpLicenseBase64,
} = require('./spLicenseParser.cjs');
const {
  MSA_DEVICE_ADD_URL,
  MSA_RST2_URL,
  MSA_WINDOWS_USER_AGENT,
  createClepFetchSignal,
  raceClepPromiseWithCallerSignal,
  scrubPiiFromErrorText,
  extractXmlTagText,
  extractSafeSoapFaultSuffix,
  buildSignedRst2SoapEnvelope,
  decryptRst2SoapEnvelope,
  extractCompactBinarySecurityToken,
  parseRst2TokenResponses,
} = require('./rst2SoapClient.cjs');

const MS_LICENSING_DEVICE_URL = 'https://licensing.mp.microsoft.com/v7.0/licenses/device';
const MS_LICENSING_CONTENT_URL = 'https://licensing.mp.microsoft.com/v7.0/licenses/content';
const MS_LICENSING_STORE_TOKEN_URL = 'https://licensing.mp.microsoft.com/v8.0/licenseToken';

const XBOX_LM_USER_AGENT =
  'XboxLm-PC/Microsoft.GamingServices_32.107.4002.0_x64__8wekyb3d8bbwe';

const MKMS_CONTENT_CLIENT_CHALLENGE =
  'PD94bWwgdmVyc2lvbj0iMS4wIiBlbmNvZGluZz0idXRmLTgiID8+PENsaWVudENoYWxsZW5nZSB4bWxuczp4c2k9Imh0dHA6Ly93d3cudzMub3JnLzIwMDEvWE1MU2NoZW1hLWluc3RhbmNlIiB4bWxuczp4c2Q9Imh0dHA6Ly93d3cudzMub3JnLzIwMDEvWE1MU2NoZW1hIiB4bWxucz0iaHR0cDovL3NjaGVtYXMubWljcm9zb2Z0LmNvbS9vbmVzdG9yZS9zZWN1cml0eS9ta21zL0xpY1JlcS92MSIgVmVyc2lvbj0iMiI+PExpY2Vuc2VQcm90b2NvbFZlcnNpb24+NTwvTGljZW5zZVByb3RvY29sVmVyc2lvbj48U2lnbmluZ0tleVZlcnNpb24+MTwvU2lnbmluZ0tleVZlcnNpb24+PENsaWVudFZlcnNpb24+MjwvQ2xpZW50VmVyc2lvbj48L0NsaWVudENoYWxsZW5nZT4=';

/** @type {Record<string, any> | null} */
let boundFacade = null;

/**
 * @param {Record<string, any>} facade
 */
function bindFacade(facade) {
  boundFacade = facade;
}

/**
 * @param {string} rawTicket
 * @returns {string}
 */
function normalizeLicensingMsaTicket(rawTicket) {
  const trimmed = String(rawTicket || '').trim();
  if (!trimmed) return '';
  const bare = trimmed.replace(/^[td]=/i, '');
  const parts = bare.split('.');
  if (parts.length === 5 && parts[0] && parts[2] && parts[3] && parts[4]) {
    try {
      const allBase64Url = parts.every(
        (part) => part.length % 4 !== 1 && /^[A-Za-z0-9_-]*$/.test(part)
      );
      if (allBase64Url && parts[0].length <= 8192) {
        const hdr = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
        if (hdr && typeof hdr.alg === 'string' && hdr.alg && typeof hdr.enc === 'string' && hdr.enc) {
          return bare;
        }
      }
    } catch {}
  }
  if (/^d=/i.test(trimmed)) return `t=${bare}`;
  if (/^t=/i.test(trimmed)) return trimmed;
  return `t=${bare}`;
}

/**
 * @param {Array<string | { productId: string, skuId?: string }>} keys
 */
function normalizeSatisfyingEntitlementKeys(keys) {
  if (!Array.isArray(keys)) return [];
  const normalized = [];
  for (const item of keys) {
    if (!item) continue;
    if (typeof item === 'string') {
      const trimmed = item.trim();
      if (!trimmed) continue;
      if (trimmed.includes(':')) {
        const parts = trimmed.split(':');
        if (parts.length === 3 && parts[0].toLowerCase() === 'big') {
          normalized.push({
            productId: parts[1].trim(),
            skuId: (parts[2] || '0010').trim() || '0010',
          });
        } else {
          normalized.push({
            productId: parts[0].trim(),
            skuId: (parts[1] || '0010').trim() || '0010',
          });
        }
      } else {
        normalized.push({ productId: trimmed, skuId: '0010' });
      }
    } else if (typeof item === 'object' && item.productId) {
      normalized.push({
        productId: String(item.productId).trim(),
        skuId: String(item.skuId || '0010').trim() || '0010',
      });
    }
  }
  return normalized;
}

/**
 * @param {{ deviceMsToken?: string, deviceDat?: string, deviceToken?: string } | null | undefined} deviceContext
 * @param {string} fallbackUserTicket
 * @returns {string}
 */
function formatDeviceAuthHeaderForLicensing(deviceContext, fallbackUserTicket) {
  const raw = String(
    deviceContext?.deviceMsToken || deviceContext?.deviceDat || deviceContext?.deviceToken || ''
  ).trim();
  if (!raw) return fallbackUserTicket;
  if (raw.startsWith('d=')) return `t=${raw.slice(2)}`;
  return raw;
}

/** @type {Map<string, { promise: Promise<any>, forceRefresh: boolean }>} */
const inFlightDeviceContextByScope = new Map();

/**
 * Reads the `xbox` section of `tokenVault` asynchronously when `loadSavedTokensAsync` is available,
 * falling back to synchronous `loadSavedTokens` only for custom test mocks lacking `*Async`.
 *
 * @param {any} vault
 * @param {Record<string, any>} vaultOpts
 * @returns {Promise<Record<string, any>>}
 */
async function readSavedXboxAsync(vault, vaultOpts) {
  const all =
    typeof vault.loadSavedTokensAsync === 'function'
      ? (await vault.loadSavedTokensAsync(vaultOpts)) || {}
      : typeof vault.loadSavedTokens === 'function'
        ? vault.loadSavedTokens(vaultOpts) || {}
        : {};
  return all.xbox && typeof all.xbox === 'object' ? { ...all.xbox } : {};
}

/**
 * Persists `xbox.deviceContext` asynchronously via `saveTokensAsync`, falling back to sync
 * `saveTokens` only when a custom test mock lacks `saveTokensAsync`.
 *
 * @param {any} vault
 * @param {Record<string, any>} vaultOpts
 * @param {Record<string, any>} nextDeviceCtx
 */
async function persistDeviceCtxAsync(vault, vaultOpts, nextDeviceCtx) {
  const existingXbox = await readSavedXboxAsync(vault, vaultOpts);
  const nextXboxRecord = {
    ...existingXbox,
    deviceContext: {
      ...(existingXbox.deviceContext || {}),
      ...nextDeviceCtx,
      updatedAt: new Date().toISOString(),
    },
  };
  if (typeof vault.saveTokensAsync === 'function') {
    await vault.saveTokensAsync('xbox', nextXboxRecord, vaultOpts);
  } else if (typeof vault.saveTokens === 'function') {
    vault.saveTokens('xbox', nextXboxRecord, vaultOpts);
  }
}

/**
 * Resolves hardware fingerprint asynchronously when supported by `tokenVault.cjs`, preserving
 * custom test mock overrides of `getHardwareFingerprint`.
 *
 * @param {any} vault
 */
async function resolveHardwareSeedAsync(vault) {
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
  return undefined;
}

/**
 * Provisions or refreshes a virtual Windows device (`deviceaddcredential.srf` -> `RST2.srf` ->
 * `<SPLicenseBlock>` `DeviceKey` + `ClepSignState` RSA-2048 key + `DeviceDAT` tokens) and persists
 * all state inside `tokenVault.cjs` (`xbox.deviceContext`) with zero macOS Keychain prompts.
 *
 * @param {{
 *   tokenVault?: any,
 *   userDataDir?: string,
 *   fetchImpl?: typeof fetch,
 *   forceRefresh?: boolean,
 *   requireLegacyToken?: boolean,
 *   msaStoreToken?: string,
 *   signal?: AbortSignal,
 * }} [options]
 */
async function ensureDeviceLicenseContext(options = {}) {
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  if (typeof fetchImpl !== 'function') {
    throw new Error('ensureDeviceLicenseContext requires a fetch implementation');
  }

  const vault = options.tokenVault || require('../../tokenVault.cjs');
  const userDataDir = options.userDataDir;
  const vaultOpts = userDataDir ? { userDataDir } : {};
  const forceRefresh = Boolean(options.forceRefresh);

  const existing = (await readSavedXboxAsync(vault, vaultOpts)).deviceContext;
  const now = Date.now();
  const hasCachedLegacy =
    !options.requireLegacyToken ||
    (typeof existing?.deviceLegacyTokenXml === 'string' &&
      existing.deviceLegacyTokenXml.length > 0 &&
      typeof existing?.deviceBinarySecretB64 === 'string' &&
      existing.deviceBinarySecretB64.length > 0 &&
      (!existing.deviceLegacyExpiresAt ||
        Date.parse(existing.deviceLegacyExpiresAt) - now > 5 * 60_000));

  if (
    !forceRefresh &&
    hasCachedLegacy &&
    existing &&
    typeof existing.deviceKeyHex === 'string' &&
    existing.deviceKeyHex.length === 32 &&
    typeof existing.clepRsaKeyPem === 'string' &&
    existing.clepRsaKeyPem.includes('PRIVATE KEY') &&
    existing.deviceDat &&
    (!existing.deviceDatExpiresAt || Date.parse(existing.deviceDatExpiresAt) - now > 5 * 60_000)
  ) {
    const clepHmacSecret = existing.deviceBinarySecretB64
      ? unwrapClepHmacStateSecret(existing.deviceBinarySecretB64)
      : null;
    const normalizedCachedDeviceToken = existing.deviceToken
      ? existing.deviceToken.startsWith('d=')
        ? `t=${existing.deviceToken.slice(2)}`
        : existing.deviceToken
      : existing.deviceDat;
    return {
      deviceMembername: existing.deviceMembername,
      devicePassword: existing.devicePassword,
      devicePuid: existing.devicePuid || '',
      hwDeviceId: existing.hwDeviceId || '',
      deviceToken: normalizedCachedDeviceToken,
      deviceDat: existing.deviceDat,
      deviceMsToken: existing.deviceMsToken || existing.deviceDat,
      deviceDatExpiresAt: existing.deviceDatExpiresAt,
      deviceLegacyTokenXml: existing.deviceLegacyTokenXml || '',
      deviceBinarySecretB64: existing.deviceBinarySecretB64 || '',
      clepHmacSecret,
      deviceKeyBuffer: Buffer.from(existing.deviceKeyHex, 'hex'),
      clepRsaKeyPem: existing.clepRsaKeyPem,
    };
  }

  const scopeKey = String(userDataDir || 'default');
  const existingFlight = inFlightDeviceContextByScope.get(scopeKey);
  if (existingFlight && (!forceRefresh || existingFlight.forceRefresh)) {
    return raceClepPromiseWithCallerSignal(existingFlight.promise, options.signal);
  }
  if (options.signal?.aborted) {
    const err =
      options.signal.reason instanceof Error
        ? options.signal.reason
        : Object.assign(new Error('The operation was aborted'), { name: 'AbortError' });
    throw err;
  }

  const buildChallengeFn = boundFacade?.buildClepChallengeBuffers || buildClepChallengeBuffers;
  const parseSpFn = boundFacade?.parseSpLicenseBase64 || parseSpLicenseBase64;
  const buildSoapFn = boundFacade?.buildSignedRst2SoapEnvelope || buildSignedRst2SoapEnvelope;

  const run = (async () => {
    const hardwareSeed = await resolveHardwareSeedAsync(vault);
    const challenge = buildChallengeFn({ hardwareSeed });

    let deviceMembername = existing?.deviceMembername || '';
    let devicePassword = existing?.devicePassword || '';
    let devicePuid = existing?.devicePuid || '';
    let hwDeviceId = existing?.hwDeviceId || '';
    let deviceKeyBuffer =
      existing?.deviceKeyHex?.length === 32 ? Buffer.from(existing.deviceKeyHex, 'hex') : null;
    let clepRsaKeyPem = existing?.clepRsaKeyPem || '';

    // Step 1: Provision virtual Windows device credentials + SPLicenseBlock if not yet provisioned
    if (!deviceMembername || !devicePassword || !deviceKeyBuffer || !clepRsaKeyPem) {
      deviceMembername = generateNumericDeviceMembername();
      devicePassword = generateDevicePassword();

      const addXml = buildDeviceAddCredentialXml({
        membername: deviceMembername,
        password: devicePassword,
        clepV2B64: challenge.clepV2B64,
        clepV4B64: challenge.clepV4B64,
      });

      const addRes = await fetchImpl(MSA_DEVICE_ADD_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/soap+xml',
          'User-Agent': MSA_WINDOWS_USER_AGENT,
        },
        body: addXml,
        signal: createClepFetchSignal(undefined),
      });

      const addBody = await addRes.text();
      if (!addRes.ok) {
        throw new Error(
          `Device credential provisioning failed (${addRes.status}${extractSafeSoapFaultSuffix(addBody)})`
        );
      }

      devicePuid = extractXmlTagText(addBody, 'puid') || devicePuid;
      hwDeviceId = extractXmlTagText(addBody, 'HWDeviceID') || hwDeviceId;

      let spLicenseB64 = extractSpLicenseBase64(addBody);

      // Fallback to POST https://licensing.mp.microsoft.com/v7.0/licenses/device if SPLicenseBlock was omitted
      if (!spLicenseB64 && options.msaStoreToken) {
        const normTicket = normalizeLicensingMsaTicket(options.msaStoreToken);
        const devLicRes = await fetchImpl(MS_LICENSING_DEVICE_URL, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json',
            from: 'XboxLicenseManager',
            Authorization: normTicket,
            'User-Agent': XBOX_LM_USER_AGENT,
            'MS-CV': makeCorrelationVector(),
          },
          body: JSON.stringify({
            clientChallenge: challenge.clientChallenge,
            licenseVersion: 4,
            deviceContext: {
              hardwareManufacturer: 'Public',
              hardwareType: 'Public',
              mobileOperator: 'Public',
            },
          }),
          signal: createClepFetchSignal(undefined),
        });
        if (devLicRes.ok) {
          const devLicJson = await devLicRes.json();
          spLicenseB64 = extractSpLicenseBase64(
            devLicJson?.license?.licenseBlob ||
              devLicJson?.licenseBlob ||
              devLicJson?.licenses?.[0]?.licenseBlob ||
              ''
          );
        }
      }

      if (!spLicenseB64) {
        throw new Error('Device provisioning response did not include an SPLicenseBlock');
      }

      const parsedSp = parseSpFn(spLicenseB64);
      if (!parsedSp.deviceKeyBuffer || parsedSp.deviceKeyBuffer.length !== 16) {
        throw new Error('SPLicenseBlock missing 16-byte EncryptedDeviceKey (0x0001)');
      }
      if (!parsedSp.clepRsaKeyPem) {
        throw new Error('SPLicenseBlock missing ClepSignState RSA-2048 key (0x012d)');
      }

      deviceKeyBuffer = parsedSp.deviceKeyBuffer;
      clepRsaKeyPem = parsedSp.clepRsaKeyPem;
    }

    // Step 2: Authenticate device on RST2.srf using RSA-2048 (`ClepSignState`) -> LegacyToken + ClepHmacState
    // IMPORTANT: `wsse:UsernameToken` MUST omit `<wsse:Password>` so RST2.srf issues a hardware-trusted STS token!
    const usernameTokenXml =
      `<wsse:UsernameToken wsu:Id="devicesoftware">` +
      `<wsse:Username>${escapeXmlText(deviceMembername)}</wsse:Username>` +
      `</wsse:UsernameToken>`;

    const rstAuthXml = buildSoapFn({
      authBlockXml: usernameTokenXml,
      hostingApp: HOSTING_APP_DEFAULT_IDCRL,
      ssoFlags: '',
      inlineUx: 'TokenBroker',
      licenseSignatureKeyVersion: '2',
      scopeAddress: 'http://Passport.NET/tb',
      policy: '',
      signingMode: 'rsa',
      rsaPrivateKeyPem: clepRsaKeyPem,
    });

    const rstAuthRes = await fetchImpl(MSA_RST2_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/soap+xml',
        'User-Agent': MSA_WINDOWS_USER_AGENT,
      },
      body: rstAuthXml,
      signal: createClepFetchSignal(undefined),
    });

    const rstAuthBody = await rstAuthRes.text();
    if (!rstAuthRes.ok) {
      throw new Error(
        `RST2.srf device authentication failed (${rstAuthRes.status}${extractSafeSoapFaultSuffix(rstAuthBody)})`
      );
    }

    const parsedAuthTokens = parseRst2TokenResponses(rstAuthBody);
    const firstLegacy = parsedAuthTokens[0] || null;
    const legacyTokenXml =
      firstLegacy?.legacyTokenXml ||
      rstAuthBody.match(/<(?:[\w-]+:)?EncryptedData\b[^>]*>[\s\S]*?<\/(?:[\w-]+:)?EncryptedData>/i)?.[0] ||
      '';
    const binarySecretB64 = firstLegacy?.binarySecretB64 || extractXmlTagText(rstAuthBody, 'BinarySecret');
    if (!legacyTokenXml || !binarySecretB64) {
      throw new Error('RST2.srf device auth response missing EncryptedData or BinarySecret');
    }

    const deviceLegacyExpiresAt =
      firstLegacy?.expires && !Number.isNaN(Date.parse(firstLegacy.expires))
        ? new Date(Date.parse(firstLegacy.expires)).toISOString()
        : new Date(Date.now() + 14 * 24 * 3600_000).toISOString();

    const clepHmacSecret = unwrapClepHmacStateSecret(binarySecretB64);

    // Step 3A: Exchange LegacyToken + SP800-108 HMAC for Microsoft Store Device ticket (`www.microsoft.com` / `mbi_ssl`)
    const exchangeForScope = async (
      /** @type {string} */ hostingApp,
      /** @type {string} */ scopeAddress,
      /** @type {string} */ policy
    ) => {
      const exXml = buildSoapFn({
        authBlockXml: legacyTokenXml,
        hostingApp,
        ssoFlags: 'SsoRestr',
        inlineUx: 'TokenBroker',
        licenseSignatureKeyVersion: '2',
        scopeAddress,
        policy,
        signingMode: 'hmac',
        clepHmacSecret,
        derivedKeyRefUri: '',
      });

      const exRes = await fetchImpl(MSA_RST2_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/soap+xml',
          'User-Agent': MSA_WINDOWS_USER_AGENT,
        },
        body: exXml,
        signal: createClepFetchSignal(undefined),
      });

      const exBody = await exRes.text();
      if (!exRes.ok) {
        throw new Error(
          `RST2.srf device token exchange failed (${exRes.status}${extractSafeSoapFaultSuffix(exBody)})`
        );
      }

      const { decryptedBodyXml, rawBodyXml } = decryptRst2SoapEnvelope(exBody, clepHmacSecret);
      const effectiveRstr = decryptedBodyXml || rawBodyXml;
      const parsed = parseRst2TokenResponses(effectiveRstr);
      const item = parsed[0];
      const compactToken = item?.compactToken || extractCompactBinarySecurityToken(effectiveRstr);
      const expiresStr = item?.expires || extractXmlTagText(effectiveRstr, 'Expires');
      if (!compactToken) {
        throw new Error(`RST2.srf exchange for ${scopeAddress} returned empty BinarySecurityToken`);
      }
      return { compactToken, expiresStr };
    };

    const msStoreEx = await exchangeForScope(HOSTING_APP_MS_STORE, 'www.microsoft.com', 'mbi_ssl');
    // `licensing.mp.microsoft.com` expects the compact device ticket (`t=...`) directly in `Authorization`!
    const deviceMsToken = msStoreEx.compactToken.startsWith('d=')
      ? `t=${msStoreEx.compactToken.slice(2)}`
      : msStoreEx.compactToken;

    // Step 3B: Best-effort Xbox Device RPS ticket (`user.auth.xboxlive.com` / `TOKEN_BROKER`) for `device.auth.xboxlive.com`
    let deviceXboxRpsTicket = '';
    try {
      const xblDevEx = await exchangeForScope(
        HOSTING_APP_TOKEN_BROKER,
        'scope=service::user.auth.xboxlive.com::MBI_SSL&api-version=2.0',
        'TOKEN_BROKER'
      );
      if (xblDevEx.compactToken) {
        const c = xblDevEx.compactToken.trim();
        deviceXboxRpsTicket = c.startsWith('t=')
          ? c
          : c.startsWith('d=')
            ? `t=${c.slice(2)}`
            : `t=${c}`;
      }
    } catch {
      // Non-fatal: `licensing.mp.microsoft.com` only requires `deviceMsToken`
    }

    const deviceDatExpiresAt =
      msStoreEx.expiresStr && !Number.isNaN(Date.parse(msStoreEx.expiresStr))
        ? new Date(Date.parse(msStoreEx.expiresStr)).toISOString()
        : new Date(Date.now() + 7 * 3600_000).toISOString();

    const persisted = {
      deviceMembername,
      devicePassword,
      devicePuid,
      hwDeviceId,
      deviceToken: deviceXboxRpsTicket || deviceMsToken,
      deviceDat: deviceMsToken,
      deviceMsToken,
      deviceDatExpiresAt,
      deviceLegacyTokenXml: legacyTokenXml,
      deviceBinarySecretB64: binarySecretB64,
      deviceLegacyExpiresAt,
      deviceKeyHex: deviceKeyBuffer.toString('hex'),
      clepRsaKeyPem,
    };
    await persistDeviceCtxAsync(vault, vaultOpts, persisted);

    return {
      deviceMembername,
      devicePassword,
      devicePuid,
      hwDeviceId,
      deviceToken: persisted.deviceToken,
      deviceDat: deviceMsToken,
      deviceMsToken,
      deviceDatExpiresAt,
      deviceLegacyTokenXml: legacyTokenXml,
      deviceBinarySecretB64: binarySecretB64,
      clepHmacSecret,
      deviceKeyBuffer,
      clepRsaKeyPem,
    };
  })().finally(() => {
    if (inFlightDeviceContextByScope.get(scopeKey)?.promise === run) {
      inFlightDeviceContextByScope.delete(scopeKey);
    }
  });

  inFlightDeviceContextByScope.set(scopeKey, { promise: run, forceRefresh });
  run.catch(() => {});
  return raceClepPromiseWithCallerSignal(run, options.signal);
}

/**
 * Acquires a hardware-bound `TOKEN_BROKER` delegation RPS ticket (`d=...`) for a specific game's
 * `<MSAAppId>` via `https://login.live.com/RST2.srf` signed with the virtual Windows device
 * `LegacyToken` + `ClepHmacState`.
 *
 * @param {{
 *   msaAppId?: string,
 *   tokenVault?: any,
 *   userDataDir?: string,
 *   fetchImpl?: typeof fetch,
 *   forceRefresh?: boolean,
 *   signal?: AbortSignal,
 * }} [options]
 */
async function acquireTitleBrokerTicket(options = {}) {
  const cleanAppId = String(options.msaAppId || '').trim();
  if (!cleanAppId) return null;

  const fetchImpl = options.fetchImpl || globalThis.fetch;
  if (typeof fetchImpl !== 'function') {
    throw new Error('Global fetch is unavailable for acquireTitleBrokerTicket');
  }

  const ensureDevCtxFn = boundFacade?.ensureDeviceLicenseContext || ensureDeviceLicenseContext;
  const buildSoapFn = boundFacade?.buildSignedRst2SoapEnvelope || buildSignedRst2SoapEnvelope;

  const devCtx = await ensureDevCtxFn({
    tokenVault: options.tokenVault,
    userDataDir: options.userDataDir,
    fetchImpl,
    forceRefresh: Boolean(options.forceRefresh),
    requireLegacyToken: true,
  });

  if (!devCtx?.deviceLegacyTokenXml || !devCtx?.clepHmacSecret) {
    throw new Error('Device LegacyToken or ClepHmacState unavailable for TOKEN_BROKER exchange');
  }

  const scopeAddress = `scope=service::user.auth.xboxlive.com::MBI_SSL&clientid=${cleanAppId}&api-version=2.0`;
  const exXml = buildSoapFn({
    authBlockXml: devCtx.deviceLegacyTokenXml,
    hostingApp: HOSTING_APP_TOKEN_BROKER,
    ssoFlags: 'SsoRestr',
    inlineUx: 'TokenBroker',
    licenseSignatureKeyVersion: '2',
    scopeAddress,
    policy: 'TOKEN_BROKER',
    signingMode: 'hmac',
    clepHmacSecret: devCtx.clepHmacSecret,
    derivedKeyRefUri: '',
  });

  const exRes = await fetchImpl(MSA_RST2_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/soap+xml',
      'User-Agent': MSA_WINDOWS_USER_AGENT,
    },
    body: exXml,
    signal: createClepFetchSignal(options.signal),
  });

  const exBody = await exRes.text();
  if (!exRes.ok) {
    throw new Error(
      `RST2.srf title TOKEN_BROKER exchange failed for ${cleanAppId} (${exRes.status}${extractSafeSoapFaultSuffix(exBody)})`
    );
  }

  const { decryptedBodyXml, rawBodyXml } = decryptRst2SoapEnvelope(exBody, devCtx.clepHmacSecret);
  const effectiveRstr = decryptedBodyXml || rawBodyXml;
  const parsed = parseRst2TokenResponses(effectiveRstr);
  const item = parsed[0];
  const compactToken = (
    item?.compactToken ||
    extractCompactBinarySecurityToken(effectiveRstr) ||
    ''
  ).trim();
  if (!compactToken) {
    throw new Error(`RST2.srf title TOKEN_BROKER exchange for ${cleanAppId} returned empty ticket`);
  }

  const rpsTicket =
    compactToken.startsWith('d=') || compactToken.startsWith('t=')
      ? compactToken
      : `d=${compactToken}`;
  const rawExpires = item?.expires || extractXmlTagText(effectiveRstr, 'Expires');
  const expiresAt =
    rawExpires && !Number.isNaN(Date.parse(rawExpires))
      ? new Date(Date.parse(rawExpires)).toISOString()
      : new Date(Date.now() + 4 * 3600_000).toISOString();

  return {
    rpsTicket,
    expiresAt,
    msaAppId: cleanAppId,
  };
}

/**
 * Acquires a game/DLC content license from `POST https://licensing.mp.microsoft.com/v7.0/licenses/content`,
 * automatically retrying with `satisfyingEntitlementKeys` for bundle/Game Pass titles, parses Tag `0x00ca`,
 * and unwraps the 32-byte raw XVD `CIK` via RFC 3394 AES-128 Key Unwrap.
 *
 * @param {{
 *   contentId: string,
 *   packageFullNames?: string[],
 *   satisfyingEntitlementKeys?: Array<string | { productId: string, skuId?: string }>,
 *   msaStoreToken: string,
 *   localTicketReference?: string,
 *   deviceContext: { deviceMsToken?: string, deviceDat?: string, deviceToken?: string, deviceKeyBuffer: Buffer },
 *   market?: string,
 *   hardwareSeed?: string,
 *   clientChallengeOverride?: string,
 *   pinnedSpkiSha256Set?: Set<string> | string[],
 *   verifyServerSignatureWithKey?: string | Buffer | crypto.KeyObject | Record<string, any> | null,
 *   serverSignaturePublicKey?: string | Buffer | crypto.KeyObject | Record<string, any> | null,
 *   requireServerSignatureVerification?: boolean,
 *   signal?: AbortSignal,
 *   fetchImpl?: typeof fetch,
 * }} [params]
 */
async function acquireContentCik(params = /** @type {any} */ ({})) {
  const {
    contentId,
    packageFullNames = [],
    satisfyingEntitlementKeys = [],
    msaStoreToken,
    localTicketReference,
    deviceContext,
    market = 'US',
    pinnedSpkiSha256Set,
    verifyServerSignatureWithKey,
    serverSignaturePublicKey,
    requireServerSignatureVerification,
  } = params;
  const fetchImpl = params.fetchImpl || globalThis.fetch;

  if (!contentId || typeof contentId !== 'string') {
    throw new Error('acquireContentCik requires a non-empty contentId');
  }
  if (!msaStoreToken || typeof msaStoreToken !== 'string') {
    throw new Error('acquireContentCik requires msaStoreToken');
  }
  if (
    !deviceContext ||
    !Buffer.isBuffer(deviceContext.deviceKeyBuffer) ||
    deviceContext.deviceKeyBuffer.length !== 16
  ) {
    throw new Error('acquireContentCik requires deviceContext.deviceKeyBuffer (16 bytes)');
  }
  if (typeof fetchImpl !== 'function') {
    throw new Error('acquireContentCik requires a fetch implementation');
  }

  const parseSpFn = boundFacade?.parseSpLicenseBase64 || parseSpLicenseBase64;
  const unwrapCikFn = boundFacade?.unwrapContentCik || unwrapContentCik;

  const licensingUserTicket = normalizeLicensingMsaTicket(msaStoreToken);
  const ticketRef = String(localTicketReference || '').trim() || `ticket-${crypto.randomUUID()}`;
  const clientChallenge = params.clientChallengeOverride || MKMS_CONTENT_CLIENT_CHALLENGE;
  const authHeader = formatDeviceAuthHeaderForLicensing(deviceContext, licensingUserTicket);

  const normalizedEntitlementKeys = normalizeSatisfyingEntitlementKeys(satisfyingEntitlementKeys);
  const cleanPfns = Array.isArray(packageFullNames)
    ? packageFullNames.map((p) => String(p || '').trim()).filter(Boolean)
    : [];

  const attemptRequest = async (
    /** @type {Array<any> | null} */ entitlementKeysToSend,
    includePfns = false
  ) => {
    const body = {
      contentId: contentId.trim(),
      market: String(market || 'US').toUpperCase(),
      clientChallenge,
      concurrencyMode: 'Rude',
      licenseVersion: 4,
      needKey: true,
      keyOnly: true,
      ...(includePfns && cleanPfns.length > 0 ? { packageFullNames: cleanPfns } : {}),
      ...(entitlementKeysToSend && entitlementKeysToSend.length > 0
        ? { satisfyingEntitlementKeys: entitlementKeysToSend }
        : {}),
      deviceContext: {
        hardwareManufacturer: 'Public',
        hardwareType: 'Public',
        mobileOperator: 'Public',
      },
      users: {
        [LOCAL_USER_SID]: [
          {
            identityType: 'Msa',
            identityValue: licensingUserTicket,
            localTicketReference: ticketRef,
          },
        ],
      },
    };

    const res = await fetchImpl(MS_LICENSING_CONTENT_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        from: 'XboxLicenseManager',
        Authorization: authHeader,
        'User-Agent': XBOX_LM_USER_AGENT,
        'MS-CV': makeCorrelationVector(),
      },
      body: JSON.stringify(body),
      signal: createClepFetchSignal(params.signal),
    });

    const text = await res.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {}
    return { ok: res.ok, status: res.status, text, json };
  };

  // Attempt 1: bare ContentId (fastest & matches direct digital ownership)
  let response = await attemptRequest(null);

  const extractBlobsFromResponse = (/** @type {any} */ json) => {
    if (!json || typeof json !== 'object') return [];
    /** @type {string[]} */
    const blobs = [];
    if (Array.isArray(json?.license?.keys)) {
      for (const k of json.license.keys) {
        if (k?.value) blobs.push(k.value);
      }
    }
    if (typeof json?.license?.licenseBlob === 'string' && json.license.licenseBlob) {
      blobs.push(json.license.licenseBlob);
    }
    if (Array.isArray(json?.licenses)) {
      for (const lic of json.licenses) {
        if (Array.isArray(lic?.keys)) {
          for (const k of lic.keys) {
            if (k?.value) blobs.push(k.value);
          }
        }
        if (typeof lic?.licenseBlob === 'string' && lic.licenseBlob) {
          blobs.push(lic.licenseBlob);
        }
      }
    }
    return blobs;
  };

  const tryUnwrapCandidateBlobs = (/** @type {string[]} */ blobs) => {
    const unwrappedKeys = [];
    let resolvedLicenseId = null;
    let resolvedPackageFullName = null;
    /** @type {unknown} */
    let lastParseErr = null;

    for (const blob of blobs) {
      let parsed;
      try {
        parsed = parseSpFn(blob, {
          verifyCmacWithKey: deviceContext.deviceKeyBuffer,
          ...(pinnedSpkiSha256Set ? { pinnedSpkiSha256Set } : {}),
          ...(verifyServerSignatureWithKey ? { verifyServerSignatureWithKey } : {}),
          ...(serverSignaturePublicKey ? { serverSignaturePublicKey } : {}),
          ...(requireServerSignatureVerification !== undefined
            ? { requireServerSignatureVerification }
            : {}),
        });
      } catch (err) {
        const errCode = /** @type {any} */ (err)?.code;
        if (errCode === 'SPLICENSE_CMAC_TAMPERED' || errCode === 'SPLICENSE_SIGNATURE_TAMPERED') {
          throw err;
        }
        const errMsg = err instanceof Error ? err.message : String(err || '');
        if (errMsg !== 'Empty SPLicense payload') {
          lastParseErr = err;
        }
        continue;
      }

      if (!resolvedLicenseId && parsed.licenseId) resolvedLicenseId = parsed.licenseId;
      if (!resolvedPackageFullName && parsed.packageFullName) {
        resolvedPackageFullName = parsed.packageFullName;
      }
      for (const entry of parsed.packedContentKeys) {
        const cikBuffer = unwrapCikFn(entry.wrappedCik, deviceContext.deviceKeyBuffer);
        unwrappedKeys.push({
          keyId: entry.keyId,
          keyIdRaw: entry.keyIdRaw,
          wrappedCik: entry.wrappedCik,
          cikBuffer,
          cikHex: cikBuffer.toString('hex'),
        });
      }
    }

    return {
      unwrappedKeys,
      resolvedLicenseId,
      resolvedPackageFullName,
      lastParseErr,
    };
  };

  let candidateBlobs = response.ok ? extractBlobsFromResponse(response.json) : [];
  let unwrapResult =
    response.ok && candidateBlobs.length > 0
      ? tryUnwrapCandidateBlobs(candidateBlobs)
      : { unwrappedKeys: [], resolvedLicenseId: null, resolvedPackageFullName: null, lastParseErr: null };

  // Attempt 2: Retry with `satisfyingEntitlementKeys` (Game Pass subscription / Bundle SKU satisfaction)
  if (
    (!response.ok || candidateBlobs.length === 0 || unwrapResult.unwrappedKeys.length === 0) &&
    normalizedEntitlementKeys.length > 0
  ) {
    response = await attemptRequest(normalizedEntitlementKeys);
    candidateBlobs = response.ok ? extractBlobsFromResponse(response.json) : [];
    unwrapResult =
      response.ok && candidateBlobs.length > 0
        ? tryUnwrapCandidateBlobs(candidateBlobs)
        : { unwrappedKeys: [], resolvedLicenseId: null, resolvedPackageFullName: null, lastParseErr: null };

    // Attempt 2B: Some Microsoft Store clusters accept string `"ProductId:SkuId"` entries
    if (!response.ok && response.status === 400) {
      const stringKeys = normalizedEntitlementKeys.map((k) => `${k.productId}:${k.skuId}`);
      const fallbackRes = await attemptRequest(stringKeys);
      if (fallbackRes.ok) {
        response = fallbackRes;
        candidateBlobs = extractBlobsFromResponse(fallbackRes.json);
        unwrapResult =
          candidateBlobs.length > 0
            ? tryUnwrapCandidateBlobs(candidateBlobs)
            : { unwrappedKeys: [], resolvedLicenseId: null, resolvedPackageFullName: null, lastParseErr: null };
      }
    }
  }

  if (!response.ok || candidateBlobs.length === 0) {
    if (response.json?.satisfactionFailure) {
      const sf = response.json.satisfactionFailure;
      const safeDesc =
        scrubPiiFromErrorText(sf.description) ||
        'Account lacks an active entitlement or Game Pass tier for this game.';
      const err = Object.assign(
        new Error(
          `Not entitled to this content (${sf.code ?? 'SATISFACTION_FAILURE'}): ${safeDesc}`
        ),
        { status: response.status, code: 'NOT_ENTITLED' }
      );
      throw err;
    }
    const errCode = String(
      response.json?.innererror?.code || response.json?.code || `HTTP_${response.status}`
    )
      .replace(/[^A-Za-z0-9_.:-]/g, '')
      .slice(0, 64);
    const structuredMsg = scrubPiiFromErrorText(
      response.json?.innererror?.message || response.json?.message || ''
    );
    const errMsg = structuredMsg || 'Failed to acquire SPLicense content key';
    const err = Object.assign(
      new Error(`Content license acquisition failed (${errCode}): ${errMsg}`),
      { status: response.status, code: errCode }
    );
    throw err;
  }

  const { unwrappedKeys, resolvedLicenseId, resolvedPackageFullName, lastParseErr } = unwrapResult;

  if (unwrappedKeys.length === 0) {
    if (lastParseErr) {
      throw lastParseErr;
    }
    throw new Error(
      `SPLicense for contentId=${contentId} did not contain any PackedContentKeys (0x00ca)`
    );
  }

  const primary = unwrappedKeys[0];
  return {
    contentId: contentId.trim(),
    keyId: primary.keyId,
    cikBuffer: primary.cikBuffer,
    cikHex: primary.cikHex,
    keys: unwrappedKeys,
    licenseId: resolvedLicenseId,
    packageFullName: resolvedPackageFullName,
    rawResponse: response.json,
  };
}

/**
 * Acquires a `v8.0/licenseToken` JWT used by bottled GDK games calling `XStoreQueryLicenseTokenAsync`.
 *
 * @param {Record<string, any>} [params]
 */
async function acquireStoreLicenseToken(params = {}) {
  const {
    parentProductId,
    productIds = [],
    customDeveloperString = '',
    msaStoreToken,
    localTicketReference,
    deviceContext,
  } = params;
  const fetchImpl = params.fetchImpl || globalThis.fetch;
  if (typeof fetchImpl !== 'function') {
    throw new Error('acquireStoreLicenseToken requires a fetch implementation');
  }

  const licensingUserTicket = normalizeLicensingMsaTicket(msaStoreToken);
  const ticketRef = String(localTicketReference || '').trim() || `ticket-${crypto.randomUUID()}`;
  const authHeader = formatDeviceAuthHeaderForLicensing(deviceContext, licensingUserTicket);
  const resolvedParent = String(parentProductId || productIds[0] || '').split('/')[0].trim();
  const relatedIds = productIds.length > 0 ? productIds : resolvedParent ? [resolvedParent] : [];

  const res = await fetchImpl(MS_LICENSING_STORE_TOKEN_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      from: 'XboxLicenseManager',
      Authorization: authHeader,
      'User-Agent': XBOX_LM_USER_AGENT,
      'MS-CV': makeCorrelationVector(),
    },
    body: JSON.stringify({
      parentProductId: resolvedParent,
      enforceSellableBy: true,
      relatedProductIds: relatedIds,
      customDeveloperString: String(customDeveloperString || ''),
      beneficiaries: [
        {
          identityType: 'Msa',
          identityValue: licensingUserTicket,
          localTicketReference: ticketRef,
        },
      ],
    }),
    signal: createClepFetchSignal(params.signal),
  });

  if (!res.ok) {
    const body = await res.text();
    let safeSuffix = '';
    try {
      const parsedErr = body ? JSON.parse(body) : null;
      const code = parsedErr?.innererror?.code || parsedErr?.code || '';
      const cleanCode = String(code).replace(/[^A-Za-z0-9_.:-]/g, '').slice(0, 64);
      if (cleanCode) safeSuffix = ` (${cleanCode})`;
    } catch {}
    throw new Error(`Store licenseToken failed (HTTP ${res.status})${safeSuffix}`);
  }
  return res.json();
}

module.exports = {
  MKMS_CONTENT_CLIENT_CHALLENGE,
  bindFacade,
  normalizeLicensingMsaTicket,
  ensureDeviceLicenseContext,
  acquireTitleBrokerTicket,
  acquireContentCik,
  acquireStoreLicenseToken,
};
