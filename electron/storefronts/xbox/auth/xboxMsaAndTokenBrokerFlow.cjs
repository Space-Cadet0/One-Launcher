// @ts-check
'use strict';

/**
 * Xbox MSA OAuth, XASU, XSTS, Device/SISU/Title Auth, NSAL HTTP & Minecraft Entitlement Flows
 * (`xboxMsaAndTokenBrokerFlow.cjs`).
 */

const crypto = require('node:crypto');
const {
  buildXboxFetchSignal,
  extractSafeCorrelationId,
} = require('../xboxConfigAndIds.cjs');
const {
  MSA_OAUTH_TOKEN_URL,
  XBL_USER_AUTH_URL,
  XBL_DEVICE_AUTH_URL,
  XBL_TITLE_AUTH_URL,
  XBL_XSTS_AUTHORIZE_URL,
  XBL_SISU_AUTHORIZE_URL,
  XBL_PROFILE_SETTINGS_URL,
  MC_LOGIN_WITH_XBOX_URL,
  MC_ENTITLEMENTS_URL,
  MC_PROFILE_URL,
  MINECRAFT_ENTITLEMENT_CACHE_TTL_MS,
  resolveDefaultAuthLocale,
  mapXboxXstsError,
  setBoundedMapEntry,
} = require('./xboxAuthConstantsAndUrl.cjs');
const { normalizeXblRpsTicket } = require('./xboxTicketAndNsalRouter.cjs');

const MAX_MINECRAFT_ENTITLEMENT_CACHE_ENTRIES = 128;

/**
 * Shared 30-minute Minecraft Java entitlement cache keyed by SHA-256(scope + account + token),
 * tagged with `scopeKey` so logout / `provider.dispose()` clears entries deterministically.
 *
 * @type {Map<string, { scopeKey: string, cachedAt: number, result: Record<string, any> }>}
 */
const globalMinecraftEntitlementCache = new Map();

/**
 * Clears cached Minecraft Java entitlement entries for a specific provider scope (or all scopes if omitted).
 *
 * @param {string} [scopeKey]
 */
function clearMinecraftEntitlementCacheForScope(scopeKey) {
  if (!scopeKey) {
    globalMinecraftEntitlementCache.clear();
    return;
  }
  for (const [k, entry] of globalMinecraftEntitlementCache.entries()) {
    if (entry.scopeKey === scopeKey) {
      globalMinecraftEntitlementCache.delete(k);
    }
  }
}

/**
 * @param {typeof fetch} fetchImpl
 * @param {Record<string, string>} formParams
 * @param {AbortSignal | undefined} signal
 */
async function postOAuthForm(fetchImpl, formParams, signal) {
  const body = new URLSearchParams(formParams);
  const res = await fetchImpl(MSA_OAUTH_TOKEN_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    },
    body: body.toString(),
    signal: buildXboxFetchSignal(signal),
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {}
  if (!res.ok || !json?.access_token) {
    const safeOAuthCode =
      typeof json?.error === 'string' && /^[a-z0-9_.-]{1,64}$/i.test(json.error)
        ? json.error
        : undefined;
    const msCv = extractSafeCorrelationId(res);
    throw Object.assign(
      new Error(
        `Microsoft OAuth token request failed (HTTP ${res.status}${safeOAuthCode ? `, error=${safeOAuthCode}` : ''}, MS-CV=${msCv})`
      ),
      {
        status: res.status,
        msCv,
        oauthError: safeOAuthCode,
      }
    );
  }
  return json;
}

/**
 * @param {typeof fetch} fetchImpl
 * @param {string} rawXblAccessToken
 * @param {{ privateKeyPem: string, privateKeyObj?: crypto.KeyObject, proofKeyJwk: Record<string, any> }} proof
 * @param {AbortSignal | undefined} signal
 * @param {(params: Record<string, any>) => string} signFn
 */
async function authenticateXblUser(fetchImpl, rawXblAccessToken, proof, signal, signFn) {
  const postXasuAttempt = async (/** @type {string} */ rpsTicketCandidate) => {
    const bodyObj = {
      RelyingParty: 'http://auth.xboxlive.com',
      TokenType: 'JWT',
      Properties: {
        AuthMethod: 'RPS',
        SiteName: 'user.auth.xboxlive.com',
        RpsTicket: rpsTicketCandidate,
        ProofKey: proof.proofKeyJwk,
      },
    };
    const bodyStr = JSON.stringify(bodyObj);
    const sig = signFn({
      method: 'POST',
      url: XBL_USER_AUTH_URL,
      authorizationHeader: '',
      bodyBuffer: Buffer.from(bodyStr, 'utf8'),
      ecPrivateKey: proof.privateKeyObj || proof.privateKeyPem,
    });

    const res = await fetchImpl(XBL_USER_AUTH_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'x-xbl-contract-version': '1',
        Signature: sig,
      },
      body: bodyStr,
      signal: buildXboxFetchSignal(signal),
    });

    const text = await res.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {}
    return { res, json };
  };

  const primaryTicket = normalizeXblRpsTicket(rawXblAccessToken, { defaultPrefix: 't=' });
  let { res, json } = await postXasuAttempt(primaryTicket);

  // Deterministic single-retry prefix fallback (`t=` <-> `d=`) if XASU rejects an opaque RPS ticket with HTTP 400
  if (res.status === 400 && (!res.ok || !json?.Token)) {
    const bare = String(rawXblAccessToken || '').trim().replace(/^[td]=/i, '').trim();
    if (bare) {
      const altPrefix = primaryTicket.startsWith('t=') ? 'd=' : 't=';
      const retryOutcome = await postXasuAttempt(`${altPrefix}${bare}`);
      if (retryOutcome.res.ok && retryOutcome.json?.Token) {
        res = retryOutcome.res;
        json = retryOutcome.json;
      }
    }
  }

  if (!res.ok || !json?.Token) {
    const msCv = extractSafeCorrelationId(res);
    throw Object.assign(
      new Error(`Xbox Live user authentication failed (HTTP ${res.status}, MS-CV=${msCv})`),
      { status: res.status, msCv }
    );
  }
  return {
    token: json.Token,
    notAfter: json.NotAfter,
    uhs: json?.DisplayClaims?.xui?.[0]?.uhs || '',
  };
}

/**
 * @param {typeof fetch} fetchImpl
 * @param {{
 *   relyingParty: string,
 *   xblUserToken: string,
 *   deviceToken?: string,
 *   titleToken?: string,
 *   sandboxId?: string,
 *   proof?: any,
 *   signal?: AbortSignal,
 * }} params
 * @param {(params: Record<string, any>) => string} signFn
 */
async function authorizeXstsInternal(
  fetchImpl,
  {
    relyingParty,
    xblUserToken,
    deviceToken,
    titleToken,
    sandboxId = 'RETAIL',
    proof,
    signal,
  },
  signFn
) {
  const bodyObj = {
    RelyingParty: relyingParty,
    TokenType: 'JWT',
    Properties: {
      SandboxId: sandboxId,
      UserTokens: [xblUserToken],
      ...(deviceToken ? { DeviceToken: deviceToken } : {}),
      ...(titleToken ? { TitleToken: titleToken } : {}),
      ...(proof?.proofKeyJwk ? { ProofKey: proof.proofKeyJwk } : {}),
    },
  };
  const bodyStr = JSON.stringify(bodyObj);
  /** @type {Record<string, string>} */
  const headers = {
    'Content-Type': 'application/json',
    Accept: 'application/json',
    'x-xbl-contract-version': '1',
  };
  if (proof?.privateKeyObj || proof?.privateKeyPem) {
    headers.Signature = signFn({
      method: 'POST',
      url: XBL_XSTS_AUTHORIZE_URL,
      authorizationHeader: '',
      bodyBuffer: Buffer.from(bodyStr, 'utf8'),
      ecPrivateKey: proof.privateKeyObj || proof.privateKeyPem,
    });
  }

  const res = await fetchImpl(XBL_XSTS_AUTHORIZE_URL, {
    method: 'POST',
    headers,
    body: bodyStr,
    signal: buildXboxFetchSignal(signal),
  });

  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {}

  if (!res.ok || !json?.Token) {
    const msCv = extractSafeCorrelationId(res);
    throw mapXboxXstsError(json || {}, res.status, msCv);
  }

  const xui = json?.DisplayClaims?.xui?.[0] || {};
  const uhs = xui.uhs || '';
  const resolvedNotAfter =
    json.NotAfter || new Date(Date.now() + 16 * 3600_000).toISOString();
  return {
    token: json.Token,
    notAfter: resolvedNotAfter,
    issueInstant: json.IssueInstant,
    uhs,
    xuid: xui.xid || '',
    gamertag: xui.gtg || xui.mgt || '',
    modernGamertag: xui.mgt || xui.gtg || '',
    uniqueModernGamertag: xui.umg || xui.mgt || xui.gtg || '',
    ageGroup: xui.agg || '',
    authorizationHeader: `XBL3.0 x=${uhs};${json.Token}`,
  };
}

/**
 * @param {typeof fetch} fetchImpl
 * @param {string} xstsAuthHeader
 * @param {AbortSignal | undefined} signal
 */
async function fetchProfileSettings(fetchImpl, xstsAuthHeader, signal) {
  try {
    const res = await fetchImpl(XBL_PROFILE_SETTINGS_URL, {
      method: 'GET',
      headers: {
        Authorization: xstsAuthHeader,
        'x-xbl-contract-version': '2',
        Accept: 'application/json',
        'Accept-Language': resolveDefaultAuthLocale(),
      },
      signal: buildXboxFetchSignal(signal),
    });
    if (!res.ok) return null;
    const json = await res.json();
    const user = json?.profileUsers?.[0];
    if (!user) return null;
    /** @type {Record<string, any>} */
    const settingsMap = {};
    for (const s of user.settings || []) {
      if (s?.id && s.value !== undefined) {
        settingsMap[s.id] = s.value;
      }
    }
    return {
      xuid: user.id || '',
      gamertag: settingsMap.Gamertag || '',
      modernGamertag: settingsMap.ModernGamertag || '',
      uniqueModernGamertag: settingsMap.UniqueModernGamertag || '',
      gamerpicUrl: settingsMap.GameDisplayPicRaw || settingsMap.PublicGamerpic || '',
      gamerscore: Number(settingsMap.Gamerscore || 0) || 0,
    };
  } catch {
    return null;
  }
}

/**
 * @param {typeof fetch} fetchImpl
 * @param {Record<string, any>} properties
 * @param {{ privateKeyPem: string, privateKeyObj?: crypto.KeyObject }} proof
 * @param {(params: Record<string, any>) => string} signFn
 */
async function postDeviceAuthenticate(fetchImpl, properties, proof, signFn) {
  const devAuthBody = JSON.stringify({
    RelyingParty: 'http://auth.xboxlive.com',
    TokenType: 'JWT',
    Properties: properties,
  });
  const devAuthSig = signFn({
    method: 'POST',
    url: XBL_DEVICE_AUTH_URL,
    authorizationHeader: '',
    bodyBuffer: Buffer.from(devAuthBody, 'utf8'),
    ecPrivateKey: proof.privateKeyObj || proof.privateKeyPem,
  });
  const devAuthRes = await fetchImpl(XBL_DEVICE_AUTH_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'x-xbl-contract-version': '1',
      Signature: devAuthSig,
    },
    body: devAuthBody,
    signal: buildXboxFetchSignal(undefined),
  });
  const text = await devAuthRes.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {}
  return {
    ok: devAuthRes.ok,
    status: devAuthRes.status,
    msCv: extractSafeCorrelationId(devAuthRes),
    json,
  };
}

/**
 * @param {typeof fetch} fetchImpl
 * @param {{
 *   userRpsTicket: string,
 *   cleanAppId: string,
 *   xblDeviceToken: string,
 *   proof: { privateKeyPem: string, privateKeyObj?: crypto.KeyObject, proofKeyJwk: Record<string, any> },
 * }} params
 * @param {(params: Record<string, any>) => string} signFn
 */
async function attemptSisuAuthorize(
  fetchImpl,
  { userRpsTicket, cleanAppId, xblDeviceToken, proof },
  signFn
) {
  const sisuBody = JSON.stringify({
    AccessToken: userRpsTicket,
    AppId: cleanAppId,
    DeviceToken: xblDeviceToken,
    Sandbox: 'RETAIL',
    SiteName: 'user.auth.xboxlive.com',
    RelyingParty: 'http://xboxlive.com',
    UseModernGamertag: true,
    ProofKey: proof.proofKeyJwk,
  });

  const sisuSig = signFn({
    method: 'POST',
    url: XBL_SISU_AUTHORIZE_URL,
    authorizationHeader: '',
    bodyBuffer: Buffer.from(sisuBody, 'utf8'),
    ecPrivateKey: proof.privateKeyObj || proof.privateKeyPem,
  });

  const sisuRes = await fetchImpl(XBL_SISU_AUTHORIZE_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'x-xbl-contract-version': '1',
      Signature: sisuSig,
    },
    body: sisuBody,
    signal: buildXboxFetchSignal(undefined),
  });

  const text = await sisuRes.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {}
  return {
    ok: sisuRes.ok,
    status: sisuRes.status,
    msCv: extractSafeCorrelationId(sisuRes),
    json,
    deviceToken: xblDeviceToken,
  };
}

/**
 * @param {typeof fetch} fetchImpl
 * @param {{
 *   cleanAppId: string,
 *   rpsDeviceToken: string,
 *   rpsTicket: string,
 *   proof: { privateKeyPem: string, privateKeyObj?: crypto.KeyObject, proofKeyJwk: Record<string, any> },
 * }} params
 * @param {(params: Record<string, any>) => string} signFn
 */
async function authenticateXblTitle(
  fetchImpl,
  { cleanAppId, rpsDeviceToken, rpsTicket, proof },
  signFn
) {
  const titleAuthBody = JSON.stringify({
    RelyingParty: 'http://auth.xboxlive.com',
    TokenType: 'JWT',
    Properties: {
      AuthMethod: 'RPS',
      DeviceToken: rpsDeviceToken,
      RpsTicket: rpsTicket,
      SiteName: 'user.auth.xboxlive.com',
      ProofKey: proof.proofKeyJwk,
    },
  });

  const titleAuthSig = signFn({
    method: 'POST',
    url: XBL_TITLE_AUTH_URL,
    authorizationHeader: '',
    bodyBuffer: Buffer.from(titleAuthBody, 'utf8'),
    ecPrivateKey: proof.privateKeyObj || proof.privateKeyPem,
  });

  const titleRes = await fetchImpl(XBL_TITLE_AUTH_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'x-xbl-contract-version': '1',
      Signature: titleAuthSig,
    },
    body: titleAuthBody,
    signal: buildXboxFetchSignal(undefined),
  });

  const titleText = await titleRes.text();
  let titleJson = null;
  try {
    titleJson = titleText ? JSON.parse(titleText) : null;
  } catch {}

  if (!titleRes.ok || !titleJson?.Token) {
    const msCv = extractSafeCorrelationId(titleRes);
    throw Object.assign(
      new Error(
        `Xbox title.auth.xboxlive.com failed for ${cleanAppId} (HTTP ${titleRes.status}, MS-CV=${msCv})`
      ),
      { status: titleRes.status, msCv }
    );
  }
  return titleJson;
}

/**
 * Queries `title.mgt.xboxlive.com` with IEEE P1363 `Signature` header; NEVER caches failed responses.
 *
 * @param {typeof fetch} fetchImpl
 * @param {string} endpointUrl
 * @param {string} authHeader
 * @param {{ privateKeyPem: string, privateKeyObj?: crypto.KeyObject }} activeProof
 * @param {(params: Record<string, any>) => string} signFn
 */
async function fetchSignedNsalEndpoints(fetchImpl, endpointUrl, authHeader, activeProof, signFn) {
  if (!authHeader) return { ok: false, endPoints: [] };
  const sig = signFn({
    method: 'GET',
    url: endpointUrl,
    authorizationHeader: authHeader,
    bodyBuffer: Buffer.alloc(0),
    ecPrivateKey: activeProof.privateKeyObj || activeProof.privateKeyPem,
  });
  const res = await fetchImpl(endpointUrl, {
    method: 'GET',
    headers: {
      Authorization: authHeader,
      'x-xbl-contract-version': '1',
      Accept: 'application/json',
      Signature: sig,
    },
    signal: buildXboxFetchSignal(undefined),
  });
  if (!res.ok) return { ok: false, endPoints: [] };
  const json = await res.json();
  return {
    ok: true,
    endPoints: Array.isArray(json?.EndPoints) ? json.EndPoints : [],
  };
}

/**
 * Executes the Minecraft Services `login_with_xbox` -> `entitlements/mcstore` -> `minecraft/profile`
 * entitlement verification with bounded 30-minute SHA-256 keyed caching.
 *
 * @param {{
 *   fetchImpl: typeof fetch,
 *   lockScopeKey: string,
 *   savedXuid: string,
 *   mcXsts: { token: string, uhs: string, xuid?: string },
 *   forceRefresh: boolean,
 *   signal?: AbortSignal,
 * }} params
 */
async function checkMinecraftJavaEntitlementFlow({
  fetchImpl,
  lockScopeKey,
  savedXuid,
  mcXsts,
  forceRefresh,
  signal,
}) {
  const identityMaterial = `${lockScopeKey}:${savedXuid || mcXsts.xuid || ''}:${mcXsts.uhs || ''}:${mcXsts.token || ''}`;
  const sha256Key = crypto.createHash('sha256').update(identityMaterial).digest('hex');

  if (!forceRefresh) {
    const cached = globalMinecraftEntitlementCache.get(sha256Key);
    if (cached && Date.now() - cached.cachedAt < MINECRAFT_ENTITLEMENT_CACHE_TTL_MS) {
      globalMinecraftEntitlementCache.delete(sha256Key);
      globalMinecraftEntitlementCache.set(sha256Key, cached);
      return cached.result;
    }
  }

  const loginRes = await fetchImpl(MC_LOGIN_WITH_XBOX_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify({
      identityToken: `XBL3.0 x=${mcXsts.uhs};${mcXsts.token}`,
    }),
    signal: buildXboxFetchSignal(signal),
  });

  if (!loginRes.ok) {
    return { owned: false, reason: `login_with_xbox_${loginRes.status}` };
  }

  const loginJson = await loginRes.json();
  const mcAccessToken = loginJson?.access_token;
  if (!mcAccessToken) {
    return { owned: false, reason: 'missing_mc_access_token' };
  }

  const entRes = await fetchImpl(MC_ENTITLEMENTS_URL, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${mcAccessToken}`,
      Accept: 'application/json',
    },
    signal: buildXboxFetchSignal(signal),
  });

  if (!entRes.ok) {
    return { owned: false, reason: `mcstore_${entRes.status}` };
  }

  const entJson = await entRes.json();
  const items = Array.isArray(entJson?.items) ? entJson.items : [];
  const owned = items.some((/** @type {any} */ item) => {
    const name = String(item?.name || '').toLowerCase();
    return name === 'product_minecraft' || name === 'game_minecraft';
  });

  let profile = null;
  if (owned) {
    try {
      const profRes = await fetchImpl(MC_PROFILE_URL, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${mcAccessToken}`,
          Accept: 'application/json',
        },
        signal: buildXboxFetchSignal(signal),
      });
      if (profRes.ok) {
        const profJson = await profRes.json();
        if (profJson?.id && profJson?.name) {
          profile = { id: profJson.id, name: profJson.name };
        }
      }
    } catch {}
  }

  const result = {
    owned,
    mcAccessToken,
    profile,
    items,
  };

  setBoundedMapEntry(
    globalMinecraftEntitlementCache,
    sha256Key,
    {
      scopeKey: lockScopeKey,
      cachedAt: Date.now(),
      result,
    },
    MAX_MINECRAFT_ENTITLEMENT_CACHE_ENTRIES
  );

  return result;
}

module.exports = {
  globalMinecraftEntitlementCache,
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
};
