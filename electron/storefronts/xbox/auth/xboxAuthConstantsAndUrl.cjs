// @ts-check
'use strict';

/**
 * Xbox Auth Constants, OAuth2 CSRF State/Callback Validation, `XErr` Mapping & Shared Utilities
 * (`xboxAuthConstantsAndUrl.cjs`).
 */

const crypto = require('node:crypto');
const { resolveDefaultXboxLocale } = require('../xboxConfigAndIds.cjs');

const XBOX_LIVESDK_CLIENT_ID = '00000000402b5328';
const XBOX_TOKEN_BROKER_CLIENT_ID = '000000004424da1f';
const XBOX_OAUTH_REDIRECT_URI = 'https://login.live.com/oauth20_desktop.srf';
const MSA_OAUTH_AUTHORIZE_URL = 'https://login.live.com/oauth20_authorize.srf';
const MSA_OAUTH_TOKEN_URL = 'https://login.live.com/oauth20_token.srf';
const MSA_INLINE_LOGIN_URL = 'https://login.live.com/ppsecure/InlineLogin.srf';

const SCOPE_XBL_MBI_SSL = 'service::user.auth.xboxlive.com::MBI_SSL';
const SCOPE_MSSTORE_MBI_SSL = 'service::www.microsoft.com::MBI_SSL';
const SCOPE_DCAT_MBI_SSL = 'service::dcat.update.microsoft.com::MBI_SSL';
const XBOX_TOKEN_BROKER_SCOPE = 'scope=service::user.auth.xboxlive.com::MBI_SSL&api-version=2.0';

const CXH_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; MSAppHost/3.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/70.0.3538.102 Safari/537.36 Edge/18.26100';

const TRUSTED_XBOX_AUTH_HOSTS = Object.freeze([
  'login.live.com',
  'account.live.com',
  'login.microsoftonline.com',
  'login.microsoft.com',
  'account.microsoft.com',
  'sisu.xboxlive.com',
]);

const TRUSTED_XBOX_REDIRECT_SUFFIXES = Object.freeze([
  'xbox.com',
  'xboxlive.com',
  'microsoft.com',
  'live.com',
]);

const XBL_USER_AUTH_URL = 'https://user.auth.xboxlive.com/user/authenticate';
const XBL_DEVICE_AUTH_URL = 'https://device.auth.xboxlive.com/device/authenticate';
const XBL_TITLE_AUTH_URL = 'https://title.auth.xboxlive.com/title/authenticate';
const XBL_XSTS_AUTHORIZE_URL = 'https://xsts.auth.xboxlive.com/xsts/authorize';
const XBL_SISU_AUTHORIZE_URL = 'https://sisu.xboxlive.com/authorize';
const XBL_PROFILE_SETTINGS_URL =
  'https://profile.xboxlive.com/users/me/profile/settings?settings=Gamertag,ModernGamertag,UniqueModernGamertag,GameDisplayPicRaw,PublicGamerpic,TenureLevel,Gamerscore';
const XBL_TITLE_ENDPOINTS_CURRENT_URL =
  'https://title.mgt.xboxlive.com/titles/current/endpoints';
const XBL_TITLE_ENDPOINTS_DEFAULT_URL =
  'https://title.mgt.xboxlive.com/titles/default/endpoints?type=1';

const MC_LOGIN_WITH_XBOX_URL = 'https://api.minecraftservices.com/authentication/login_with_xbox';
const MC_ENTITLEMENTS_URL = 'https://api.minecraftservices.com/entitlements/mcstore';
const MC_PROFILE_URL = 'https://api.minecraftservices.com/minecraft/profile';

const MINECRAFT_ENTITLEMENT_CACHE_TTL_MS = 30 * 60_000; // 30 minutes

// Windows FILETIME epoch delta: milliseconds between 1601-01-01T00:00:00Z and 1970-01-01T00:00:00Z
const WINDOWS_EPOCH_OFFSET_MS = 11644473600000n;

// Standard Relying Party URIs (exact casing & trailing slash matter to XSTS!)
const XSTS_RELYING_PARTIES = Object.freeze({
  XBOX_LIVE: 'http://xboxlive.com',
  MS_STORE: 'http://mp.microsoft.com/',
  LICENSING_MP: 'http://licensing.mp.microsoft.com/',
  LICENSING_XBL: 'http://licensing.xboxlive.com',
  UPDATE_XBL: 'http://update.xboxlive.com',
  MINECRAFT: 'rp://api.minecraftservices.com/',
  PLAYFAB: 'https://playfabapi.com/',
});

/** @type {Readonly<Record<number, { code: string, retryable: boolean, defaultRedirect?: string, message: string }>>} */
const XERR_DESCRIPTIONS = Object.freeze({
  2148916227: {
    code: 'XBOX_ACCOUNT_BANNED',
    retryable: false,
    message:
      'This Microsoft account has an active Xbox Enforcement suspension (XErr 2148916227) and cannot sign in to Xbox Live.',
  },
  2148916233: {
    code: 'XBOX_PROFILE_MISSING',
    retryable: true,
    defaultRedirect: 'https://sisu.xboxlive.com/connect/XboxLive/?state=signup',
    message:
      'This Microsoft account does not have an Xbox Profile / Gamertag yet (XErr 2148916233). Create a free Gamertag at xbox.com and reconnect.',
  },
  2148916235: {
    code: 'XBOX_REGION_UNAVAILABLE',
    retryable: false,
    message:
      'Xbox Live services are not available in the country or region registered on this Microsoft account (XErr 2148916235).',
  },
  2148916236: {
    code: 'XBOX_AGE_VERIFICATION_REQUIRED',
    retryable: true,
    defaultRedirect: 'https://start.ui.xboxlive.com/VerifyAge',
    message:
      'Adult age verification is required on this Microsoft account before signing in to Xbox Live (XErr 2148916236).',
  },
  2148916237: {
    code: 'XBOX_AGE_VERIFICATION_REQUIRED',
    retryable: true,
    defaultRedirect: 'https://start.ui.xboxlive.com/VerifyAge',
    message:
      'Statutory age verification is required on this Microsoft account before signing in to Xbox Live (XErr 2148916237).',
  },
  2148916238: {
    code: 'XBOX_CHILD_FAMILY_CONSENT_REQUIRED',
    retryable: false,
    defaultRedirect: 'https://account.xbox.com/settings',
    message:
      'This Microsoft account belongs to a minor (XErr 2148916238). An adult organizer must add the account at family.microsoft.com and allow apps to access Xbox Live data at account.xbox.com/settings.',
  },
  2148916262: {
    code: 'XBOX_PARENTAL_CONTROL_BLOCK',
    retryable: false,
    defaultRedirect: 'https://account.xbox.com/settings',
    message:
      'Parental control settings on this Microsoft account block third-party Xbox Live access (XErr 2148916262).',
  },
});

/**
 * @param {unknown} reason
 * @returns {Error}
 */
function createAbortError(reason) {
  if (reason instanceof Error) return reason;
  const err = new Error(
    typeof reason === 'string' && reason ? reason : 'The operation was aborted'
  );
  err.name = 'AbortError';
  return err;
}

/**
 * Isolates a shared single-flight network promise from an individual caller's `AbortSignal`
 * so one impatient caller aborting its `AbortController` rejects only that caller without
 * poisoning sibling callers awaiting the same in-flight refresh (Finding #13).
 *
 * @template T
 * @param {Promise<T>} sharedPromise
 * @param {AbortSignal} [callerSignal]
 * @returns {Promise<T>}
 */
function racePromiseWithCallerSignal(sharedPromise, callerSignal) {
  if (!callerSignal) return sharedPromise;
  if (callerSignal.aborted) {
    return Promise.reject(createAbortError(callerSignal.reason));
  }
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      reject(createAbortError(callerSignal.reason));
    };
    callerSignal.addEventListener('abort', onAbort, { once: true });
    sharedPromise.then(
      (val) => {
        callerSignal.removeEventListener('abort', onAbort);
        resolve(val);
      },
      (err) => {
        callerSignal.removeEventListener('abort', onAbort);
        reject(err);
      }
    );
  });
}

/**
 * Inserts/updates an entry in a bounded LRU `Map`, evicting the oldest key when `maxEntries` is reached.
 *
 * @template K, V
 * @param {Map<K, V>} map
 * @param {K} key
 * @param {V} value
 * @param {number} maxEntries
 */
function setBoundedMapEntry(map, key, value, maxEntries) {
  if (map.has(key)) {
    map.delete(key);
  } else if (map.size >= maxEntries) {
    const oldest = map.keys().next().value;
    if (oldest !== undefined) map.delete(oldest);
  }
  map.set(key, value);
}

/**
 * @param {string} [explicitLocale]
 * @returns {string}
 */
function resolveDefaultAuthLocale(explicitLocale) {
  return resolveDefaultXboxLocale(explicitLocale);
}

/**
 * Centralized Relying Party XSTS cache key builder (`${relyingParty}|${sandboxId}|${subjectType}`).
 * Prevents key-format divergence across write, lookup, and invalidation paths (`T3-F14`).
 *
 * @param {string} relyingParty
 * @param {string} [sandboxId]
 * @param {string} [subjectType]
 * @returns {string}
 */
function buildRpXstsCacheKey(relyingParty, sandboxId = 'RETAIL', subjectType = 'user') {
  const rp = String(relyingParty || XSTS_RELYING_PARTIES.XBOX_LIVE).trim();
  const sb = String(sandboxId || 'RETAIL').trim() || 'RETAIL';
  const subj = String(subjectType || 'user').trim() || 'user';
  return `${rp}|${sb}|${subj}`;
}

/**
 * @param {string | number | null | undefined} rawTitleId
 * @param {{ preferHex?: boolean }} [options]
 * @returns {string}
 */
function normalizeDecimalTitleId(rawTitleId, { preferHex = false } = {}) {
  const s = String(rawTitleId || '').trim();
  if (!s) return '';
  if (/^0x[0-9a-f]{1,8}$/i.test(s)) {
    return String(parseInt(s.slice(2), 16) >>> 0);
  }
  if (/^[0-9a-f]{1,8}$/i.test(s) && (preferHex || /[a-f]/i.test(s))) {
    return String(parseInt(s, 16) >>> 0);
  }
  if (/^\d+$/.test(s)) {
    return String(Number(s));
  }
  return '';
}

/**
 * @param {string | null | undefined} isoStr
 * @param {number} [bufferMs]
 * @returns {boolean}
 */
function isFutureIsoTimestamp(isoStr, bufferMs = 10 * 60_000) {
  if (!isoStr || typeof isoStr !== 'string') return false;
  const ts = Date.parse(isoStr);
  if (Number.isNaN(ts)) return false;
  return ts - Date.now() > bufferMs;
}

/**
 * @param {string | null | undefined} candidate
 * @returns {string | undefined}
 */
function sanitizeTrustedXboxRedirectUrl(candidate) {
  if (!candidate || typeof candidate !== 'string') return undefined;
  try {
    const parsed = new URL(candidate.trim());
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.port) {
      return undefined;
    }
    const host = parsed.hostname.toLowerCase();
    const trusted = TRUSTED_XBOX_REDIRECT_SUFFIXES.some(
      (domain) => host === domain || host.endsWith(`.${domain}`)
    );
    return trusted ? parsed.toString() : undefined;
  } catch {
    return undefined;
  }
}

/**
 * @param {Record<string, any> | null | undefined} payload
 * @param {number} [httpStatus]
 * @param {string} [msCv]
 */
function mapXboxXstsError(payload, httpStatus = 401, msCv = 'none') {
  const xerrNum = Number(payload?.XErr ?? payload?.xerr ?? 0) || 0;
  const known = XERR_DESCRIPTIONS[xerrNum];
  const hex = xerrNum > 0 ? `0x${(xerrNum >>> 0).toString(16).toUpperCase()}` : undefined;
  const redirectUrl = sanitizeTrustedXboxRedirectUrl(payload?.Redirect) || known?.defaultRedirect;

  const userMessage =
    known?.message ||
    (xerrNum
      ? `Xbox Live authorization failed (${hex} / XErr ${xerrNum}, HTTP ${httpStatus}, MS-CV=${msCv})`
      : `Xbox Live authorization failed (HTTP ${httpStatus}, MS-CV=${msCv})`);

  return Object.assign(new Error(userMessage), {
    name: 'XboxXstsError',
    status: httpStatus,
    msCv,
    xerr: xerrNum || undefined,
    xerrHex: hex,
    code: known?.code || 'XBOX_XSTS_UNAUTHORIZED',
    retryable: known ? known.retryable : httpStatus >= 500,
    redirectUrl,
  });
}

/**
 * Generates a 32-byte (64-hex-char) CSPRNG OAuth2 CSRF `state` token.
 *
 * @returns {string}
 */
function generateXboxOAuthState() {
  return crypto.randomBytes(32).toString('hex');
}

/**
 * Constant-time OAuth `state` verification using `crypto.timingSafeEqual`.
 *
 * @param {string | null | undefined} actualState
 * @param {string | null | undefined} expectedState
 * @returns {boolean}
 */
function verifyXboxOAuthState(actualState, expectedState) {
  if (typeof actualState !== 'string' || typeof expectedState !== 'string') {
    return false;
  }
  const cleanActual = actualState.trim();
  const cleanExpected = expectedState.trim();
  if (!cleanActual || !cleanExpected) {
    return false;
  }
  const aBuf = Buffer.from(cleanActual, 'utf8');
  const bBuf = Buffer.from(cleanExpected, 'utf8');
  if (aBuf.length !== bBuf.length) {
    return false;
  }
  return crypto.timingSafeEqual(aBuf, bBuf);
}

/**
 * Strictly parses and validates an Xbox OAuth desktop callback URL (`https://login.live.com/oauth20_desktop.srf?...`)
 * using `new URL(...)` (`https:` + exact hostname validation, zero `url.includes` substring checks).
 *
 * @param {string} rawInput
 * @param {string} [expectedRedirectUri]
 * @returns {URL | null}
 */
function parseTrustedXboxOAuthCallbackUrl(rawInput, expectedRedirectUri = XBOX_OAUTH_REDIRECT_URI) {
  const trimmed = String(rawInput || '').trim();
  if (!trimmed) return null;

  let expectedParsed;
  try {
    expectedParsed = new URL(expectedRedirectUri || XBOX_OAUTH_REDIRECT_URI);
  } catch {
    expectedParsed = new URL(XBOX_OAUTH_REDIRECT_URI);
  }

  const looksLikeUrlOrQuery =
    /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ||
    trimmed.startsWith('?') ||
    trimmed.startsWith('#') ||
    trimmed.startsWith('/');
  if (!looksLikeUrlOrQuery) {
    return null;
  }

  let parsed;
  try {
    parsed =
      trimmed.startsWith('?') || trimmed.startsWith('#') || trimmed.startsWith('/')
        ? new URL(trimmed, expectedParsed.toString())
        : new URL(trimmed);
  } catch {
    throw new Error('Malformed Microsoft OAuth callback URL');
  }

  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.port) {
    throw new Error('Untrusted Microsoft OAuth callback protocol or authority');
  }

  const actualHost = parsed.hostname.toLowerCase();
  const expectedHost = expectedParsed.hostname.toLowerCase();
  if (actualHost !== expectedHost && !TRUSTED_XBOX_AUTH_HOSTS.includes(actualHost)) {
    throw new Error(`Untrusted Microsoft OAuth callback host (${actualHost})`);
  }

  return parsed;
}

/**
 * Extracts a parameter value from a parsed OAuth URL, searching both query searchParams and URL hash fragment.
 *
 * @param {URL | null | undefined} parsedUrl
 * @param {string} name
 * @returns {string | null}
 */
function getXboxOAuthUrlParam(parsedUrl, name) {
  if (!parsedUrl) return null;
  const qVal = parsedUrl.searchParams?.get(name);
  if (qVal !== null && qVal !== undefined && qVal !== '') return qVal;
  try {
    const hashStr = (parsedUrl.hash || '').replace(/^#\/?/, '');
    if (hashStr) {
      const hashParams = new URLSearchParams(hashStr);
      const hVal = hashParams.get(name);
      if (hVal !== null && hVal !== undefined && hVal !== '') return hVal;
    }
  } catch {}
  return null;
}

/**
 * Extracts a candidate `state` value from an OAuth callback payload or trusted URL without throwing.
 *
 * @param {string | Record<string, any>} codeOrUrl
 * @param {string} [redirectUri]
 * @returns {string | null}
 */
function extractOAuthCallbackStateCandidate(codeOrUrl, redirectUri) {
  if (codeOrUrl && typeof codeOrUrl === 'object') {
    if (typeof codeOrUrl.state === 'string' && codeOrUrl.state.trim()) {
      return codeOrUrl.state.trim();
    }
    const rawTarget = codeOrUrl.url || codeOrUrl.callbackUrl || '';
    if (rawTarget) {
      try {
        const parsed = parseTrustedXboxOAuthCallbackUrl(rawTarget, redirectUri);
        return getXboxOAuthUrlParam(parsed, 'state');
      } catch {
        return null;
      }
    }
    return null;
  }
  const raw = String(codeOrUrl || '').trim();
  if (!raw) return null;
  try {
    const parsed = parseTrustedXboxOAuthCallbackUrl(raw, redirectUri);
    return getXboxOAuthUrlParam(parsed, 'state');
  } catch {
    return null;
  }
}

/**
 * Extracts and validates an OAuth2 authorization code from a callback URL or structured payload,
 * enforcing `crypto.timingSafeEqual` CSRF `state` verification whenever `expectedState` is provided
 * (or when `requireState: true` is set).
 *
 * @param {string | { url?: string, callbackUrl?: string, code?: string, state?: string, expectedState?: string, error?: string, error_code?: string }} codeOrUrl
 * @param {string | { expectedState?: string, redirectUri?: string, requireState?: boolean }} [options]
 * @returns {string}
 */
function extractAuthCodeFromInput(codeOrUrl, options = {}) {
  const opts =
    typeof options === 'string'
      ? { expectedState: options }
      : options && typeof options === 'object'
        ? options
        : {};

  if (codeOrUrl && typeof codeOrUrl === 'object') {
    const effectiveExpected =
      opts.expectedState !== undefined ? opts.expectedState : codeOrUrl.expectedState;

    const oauthError = codeOrUrl.error || codeOrUrl.error_code;
    if (oauthError) {
      const safeErr = String(oauthError).replace(/[^\w.-]/g, '').slice(0, 64) || 'access_denied';
      throw new Error(`Microsoft sign-in cancelled or denied (${safeErr})`);
    }

    const rawTarget = codeOrUrl.url || codeOrUrl.callbackUrl || '';
    let parsedUrlFromTarget = null;
    if (rawTarget) {
      try {
        parsedUrlFromTarget = parseTrustedXboxOAuthCallbackUrl(rawTarget, opts.redirectUri);
      } catch {}
    }

    let resolvedState = codeOrUrl.state;
    if (
      (resolvedState === undefined || resolvedState === null || resolvedState === '') &&
      parsedUrlFromTarget
    ) {
      resolvedState = getXboxOAuthUrlParam(parsedUrlFromTarget, 'state');
    }

    const directCode = String(codeOrUrl.code || '').trim();
    if (directCode) {
      if (effectiveExpected !== undefined || opts.requireState) {
        if (!verifyXboxOAuthState(resolvedState, effectiveExpected)) {
          throw new Error('Microsoft OAuth callback rejected: missing or mismatched CSRF state');
        }
      }
      return directCode;
    }

    if (rawTarget) {
      return extractAuthCodeFromInput(rawTarget, {
        ...opts,
        expectedState: effectiveExpected,
      });
    }

    throw new Error('Missing Microsoft OAuth authorization code');
  }

  const raw = String(codeOrUrl || '').trim();
  if (!raw) {
    throw new Error('Missing Microsoft OAuth authorization code');
  }

  const parsedUrl = parseTrustedXboxOAuthCallbackUrl(raw, opts.redirectUri);
  if (parsedUrl) {
    const oauthError = getXboxOAuthUrlParam(parsedUrl, 'error');
    if (oauthError) {
      const safeErr = String(oauthError).replace(/[^\w.-]/g, '').slice(0, 64) || 'access_denied';
      throw new Error(`Microsoft sign-in cancelled or denied (${safeErr})`);
    }

    const callbackState = getXboxOAuthUrlParam(parsedUrl, 'state');
    if (opts.expectedState !== undefined || opts.requireState) {
      if (!verifyXboxOAuthState(callbackState, opts.expectedState)) {
        throw new Error('Microsoft OAuth callback rejected: missing or mismatched CSRF state');
      }
    }

    const code = getXboxOAuthUrlParam(parsedUrl, 'code');
    if (!code || !code.trim()) {
      throw new Error('Missing Microsoft OAuth authorization code');
    }
    return code.trim();
  }

  if (opts.expectedState !== undefined || opts.requireState) {
    throw new Error('Microsoft OAuth callback rejected: missing CSRF state parameter');
  }

  return raw;
}

/**
 * @param {{ state?: string, clientId?: string, approvalPrompt?: string, redirectUri?: string }} [options]
 */
function buildXboxAuthorizationUrl(options = {}) {
  const state =
    typeof options.state === 'string' && options.state.trim()
      ? options.state.trim()
      : generateXboxOAuthState();
  const params = new URLSearchParams({
    client_id: options.clientId || XBOX_LIVESDK_CLIENT_ID,
    response_type: 'code',
    approval_prompt: options.approvalPrompt || 'auto',
    scope: SCOPE_XBL_MBI_SSL,
    redirect_uri: options.redirectUri || XBOX_OAUTH_REDIRECT_URI,
    state,
  });
  return {
    url: `${MSA_OAUTH_AUTHORIZE_URL}?${params.toString()}`,
    state,
  };
}

/**
 * @param {string} candidateUrl
 * @returns {boolean}
 */
function isTrustedXboxAuthUrl(candidateUrl) {
  try {
    const parsed = new URL(String(candidateUrl || ''));
    return (
      parsed.protocol === 'https:' &&
      !parsed.username &&
      !parsed.password &&
      !parsed.port &&
      TRUSTED_XBOX_AUTH_HOSTS.includes(parsed.hostname.toLowerCase())
    );
  } catch {
    return false;
  }
}

/**
 * @param {string} rawScopeAddress
 * @returns {boolean}
 */
function isXboxLiveUserAuthScope(rawScopeAddress) {
  const raw = String(rawScopeAddress || '').trim();
  if (!raw) return false;
  const lower = raw.toLowerCase();
  if (lower === 'user.auth.xboxlive.com' || lower === SCOPE_XBL_MBI_SSL.toLowerCase()) {
    return true;
  }
  if (/^https?:\/\//i.test(raw)) {
    try {
      const parsed = new URL(raw);
      return parsed.hostname.toLowerCase() === 'user.auth.xboxlive.com';
    } catch {
      return false;
    }
  }
  if (lower.startsWith('scope=')) {
    try {
      const sp = new URLSearchParams(raw);
      return String(sp.get('scope') || '').toLowerCase() === SCOPE_XBL_MBI_SSL.toLowerCase();
    } catch {
      return false;
    }
  }
  return false;
}

/**
 * Builds the `CloudExperienceHost` `TokenBroker` (`InlineLogin.srf`) request URL, `MSAppHost/3.0`
 * User-Agent, and fresh per-leg `cxh-*` headers (fresh UUIDv4 `cxh-correlationid` on every call).
 *
 * @param {{ clientId?: string, market?: string, urlOverride?: string }} [options]
 */
function buildInlineLoginRequest(options = {}) {
  const clientId = String(options.clientId || XBOX_TOKEN_BROKER_CLIENT_ID).trim();
  const market = String(options.market || resolveDefaultAuthLocale()).trim();
  const correlationId = crypto.randomUUID();
  const url = options.urlOverride
    ? String(options.urlOverride)
    : `${MSA_INLINE_LOGIN_URL}?id=80604&scid=3&mkt=${encodeURIComponent(market)}&Platform=Windows10&clientid=${encodeURIComponent(clientId)}&hosted=1`;

  const headers = {
    'cxh-capabilities':
      '{"PrivatePropertyBag":1,"PasswordlessConnect":1,"PreferAssociate":1,"ChromelessUI":0}',
    'cxh-correlationid': correlationId,
    'cxh-msabinaryversion': '55',
    'cxh-identityclientbinaryversion': '3',
    'cxh-osversioninfo':
      '{"platformId":2,"majorVersion":10,"minorVersion":0,"buildNumber":26100}',
    'cxh-platform': 'CloudExperienceHost.Platform.DESKTOP',
    'cxh-protocol': 'TokenBroker',
    'cxh-source': 'TokenBroker',
    hostapp: 'CloudExperienceHost',
  };

  const extraHeadersString = `${Object.entries(headers)
    .map(([k, v]) => `${k}: ${v}`)
    .join('\r\n')}\r\n`;

  return {
    url,
    userAgent: CXH_USER_AGENT,
    headers,
    extraHeadersString,
    correlationId,
  };
}

module.exports = {
  XBOX_LIVESDK_CLIENT_ID,
  XBOX_TOKEN_BROKER_CLIENT_ID,
  XBOX_OAUTH_REDIRECT_URI,
  MSA_OAUTH_AUTHORIZE_URL,
  MSA_OAUTH_TOKEN_URL,
  MSA_INLINE_LOGIN_URL,
  SCOPE_XBL_MBI_SSL,
  SCOPE_MSSTORE_MBI_SSL,
  SCOPE_DCAT_MBI_SSL,
  XBOX_TOKEN_BROKER_SCOPE,
  CXH_USER_AGENT,
  TRUSTED_XBOX_AUTH_HOSTS,
  TRUSTED_XBOX_REDIRECT_SUFFIXES,
  XBL_USER_AUTH_URL,
  XBL_DEVICE_AUTH_URL,
  XBL_TITLE_AUTH_URL,
  XBL_XSTS_AUTHORIZE_URL,
  XBL_SISU_AUTHORIZE_URL,
  XBL_PROFILE_SETTINGS_URL,
  XBL_TITLE_ENDPOINTS_CURRENT_URL,
  XBL_TITLE_ENDPOINTS_DEFAULT_URL,
  MC_LOGIN_WITH_XBOX_URL,
  MC_ENTITLEMENTS_URL,
  MC_PROFILE_URL,
  MINECRAFT_ENTITLEMENT_CACHE_TTL_MS,
  WINDOWS_EPOCH_OFFSET_MS,
  XSTS_RELYING_PARTIES,
  XERR_DESCRIPTIONS,
  createAbortError,
  racePromiseWithCallerSignal,
  setBoundedMapEntry,
  resolveDefaultAuthLocale,
  buildRpXstsCacheKey,
  normalizeDecimalTitleId,
  isFutureIsoTimestamp,
  sanitizeTrustedXboxRedirectUrl,
  mapXboxXstsError,
  generateXboxOAuthState,
  verifyXboxOAuthState,
  parseTrustedXboxOAuthCallbackUrl,
  getXboxOAuthUrlParam,
  extractOAuthCallbackStateCandidate,
  extractAuthCodeFromInput,
  buildXboxAuthorizationUrl,
  isTrustedXboxAuthUrl,
  isXboxLiveUserAuthScope,
  buildInlineLoginRequest,
};
