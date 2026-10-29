'use strict';

/**
 * Xbox Live & Microsoft Store Dual-Plane Authentication Manager (`xboxAuthManager.cjs`).
 *
 * Implements:
 * - First-party LiveSDK Desktop OAuth2 (`00000000402b5328` -> `oauth20_token.srf`)
 *   with mandatory 32-byte CSPRNG `state` verification (`crypto.timingSafeEqual`)
 *   across Plane 1 (`service::user.auth.xboxlive.com::MBI_SSL`) & Plane 2 (`service::www.microsoft.com::MBI_SSL`)
 * - Single-flight `refresh_token` renewal locks (prevents concurrent rotation races)
 * - Compact JWE vs Compact/Delegation Ticket normalization (`normalizeStoreMsaTicket`)
 * - Ephemeral ECDSA P-256 (`prime256v1`) ProofKey + IEEE P1363 76-byte `Signature` header (`signXboxRequest`)
 * - Multi-Relying-Party XSTS token minting + `device.auth.xboxlive.com` / `sisu.xboxlive.com` title-bound tokens
 * - Dynamic Relying Party endpoint resolution via `title.mgt.xboxlive.com` for Wave 1B's loopback XGR bridge
 * - Actionable `XErr` error code mapping & *Minecraft: Java Edition* (`rp://api.minecraftservices.com/`) 30m cached check
 */

const crypto = require('node:crypto');
const xboxDeviceClep = require('./xboxDeviceClep.cjs');

const XBOX_LIVESDK_CLIENT_ID = '00000000402b5328';
const XBOX_TOKEN_BROKER_CLIENT_ID = '000000004424da1f';
const XBOX_OAUTH_REDIRECT_URI = 'https://login.live.com/oauth20_desktop.srf';
const MSA_OAUTH_AUTHORIZE_URL = 'https://login.live.com/oauth20_authorize.srf';
const MSA_OAUTH_TOKEN_URL = 'https://login.live.com/oauth20_token.srf';
const MSA_INLINE_LOGIN_URL = 'https://login.live.com/ppsecure/InlineLogin.srf';

const SCOPE_XBL_MBI_SSL = 'service::user.auth.xboxlive.com::MBI_SSL';
const SCOPE_MSSTORE_MBI_SSL = 'service::www.microsoft.com::MBI_SSL';
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

const XBOX_HTTP_TIMEOUT_MS = 20_000;
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

/**
 * Composes `AbortSignal.timeout(20_000)` with an optional caller `AbortSignal`.
 *
 * @param {AbortSignal} [callerSignal]
 * @param {number} [timeoutMs]
 * @returns {AbortSignal}
 */
function buildXboxFetchSignal(callerSignal, timeoutMs = XBOX_HTTP_TIMEOUT_MS) {
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  if (callerSignal && typeof AbortSignal.any === 'function') {
    return AbortSignal.any([callerSignal, timeoutSignal]);
  }
  return callerSignal || timeoutSignal;
}

/**
 * Extracts only the `MS-CV` / correlation vector header from an HTTP response for safe diagnostics
 * without ever logging or rethrowing raw HTTP error bodies.
 *
 * @param {any} res
 * @returns {string}
 */
function extractSafeCorrelationId(res) {
  if (!res || !res.headers) return 'none';
  if (typeof res.headers.get === 'function') {
    const val =
      res.headers.get('ms-cv') ||
      res.headers.get('MS-CV') ||
      res.headers.get('x-correlation-id') ||
      '';
    return val ? String(val).slice(0, 96) : 'none';
  }
  const objVal = res.headers['ms-cv'] || res.headers['MS-CV'] || '';
  return objVal ? String(objVal).slice(0, 96) : 'none';
}

function resolveDefaultAuthLocale(explicitLocale) {
  if (typeof explicitLocale === 'string' && explicitLocale.trim()) {
    return explicitLocale.trim();
  }
  try {
    const reqElectron = require('electron');
    const loc = reqElectron?.app?.getLocale?.();
    if (typeof loc === 'string' && loc.trim()) {
      const trimmed = loc.trim();
      if (trimmed.includes('-')) return trimmed;
      const country = String(reqElectron?.app?.getLocaleCountryCode?.() || '').trim().toUpperCase();
      if (/^[a-z]{2}$/i.test(trimmed) && /^[A-Z]{2}$/.test(country)) {
        return `${trimmed.toLowerCase()}-${country}`;
      }
    }
  } catch {}
  return 'en-US';
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

// ============================================================================
// 1. Ticket Normalization (`d=` / `t=` / 5-Segment Compact JWE)
// ============================================================================

function isValidBase64UrlSegment(seg) {
  if (typeof seg !== 'string' || seg.length % 4 === 1) return false;
  return /^[A-Za-z0-9_-]*$/.test(seg);
}

/**
 * Empirically verified 5-segment Compact JWE detector (`header.encryptedKey.iv.ciphertext.tag`).
 * Matches `is_compact_jwe` in `xodus-licensing-jwe.patch`.
 *
 * @param {string} candidate
 * @returns {boolean}
 */
function isCompactJwe(candidate) {
  if (typeof candidate !== 'string' || !candidate) return false;
  const parts = candidate.split('.');
  if (parts.length !== 5) return false;
  const [headerB64, encKeyB64, ivB64, cipherB64, tagB64] = parts;
  if (!headerB64 || headerB64.length > 8192 || !ivB64 || !cipherB64 || !tagB64) {
    return false;
  }
  if (
    !isValidBase64UrlSegment(headerB64) ||
    !isValidBase64UrlSegment(encKeyB64) ||
    !isValidBase64UrlSegment(ivB64) ||
    !isValidBase64UrlSegment(cipherB64) ||
    !isValidBase64UrlSegment(tagB64)
  ) {
    return false;
  }
  try {
    const decoded = JSON.parse(Buffer.from(headerB64, 'base64url').toString('utf8'));
    return Boolean(
      decoded &&
        typeof decoded === 'object' &&
        !Array.isArray(decoded) &&
        typeof decoded.alg === 'string' &&
        decoded.alg.length > 0 &&
        typeof decoded.enc === 'string' &&
        decoded.enc.length > 0
    );
  } catch {
    return false;
  }
}

/**
 * Normalizes a Microsoft Store MSA ticket across `licensing.mp.microsoft.com` and `PCGAFD`:
 * - Default (`target = 'licensing'`):
 *   - 5-dot Compact JWE (`d=eyJ...` or `t=eyJ...` or bare `eyJ...`) -> strips prefix, returns bare JWE
 *   - Non-JWE delegation/compact ticket (`d=opaque` or bare `opaque`) -> returns `t=opaque`
 * - When `options.target === 'pcgafd'` / `'store'`:
 *   - Always returns `t=<unprefixed>` (rewriting `d=` -> `t=`, keeping `t=`)
 *
 * @param {string} rawTicket
 * @param {{ target?: 'licensing' | 'pcgafd' | 'store' }} [options]
 * @returns {string}
 */
function normalizeStoreMsaTicket(rawTicket, options = {}) {
  const trimmed = String(rawTicket || '').trim();
  if (!trimmed) return '';
  const target = options.target || 'licensing';

  // Preserve `XBL3.0 x=<uhs>;<jwt>` verbatim for PCGAFD/Store queries, and never forward XBL3.0 to Msa-only licensing
  if (/^xbl3\.0\s+/i.test(trimmed)) {
    return target === 'pcgafd' || target === 'store' ? trimmed : '';
  }

  const bare = trimmed.replace(/^[td]=/i, '');

  if (target === 'pcgafd' || target === 'store') {
    return `t=${bare}`;
  }

  if (isCompactJwe(bare)) {
    return bare;
  }
  return `t=${bare}`;
}

/**
 * Normalizes an Xbox Live RPS ticket for `POST https://user.auth.xboxlive.com/user/authenticate`.
 * Preserves existing `t=` or `d=` prefix verbatim (never produces `d=t=...`), defaulting bare MBI_SSL
 * compact tickets to `t=<ticket>`.
 *
 * @param {string} rawTicket
 * @param {{ defaultPrefix?: 't=' | 'd=' }} [options]
 * @returns {string}
 */
function normalizeXblRpsTicket(rawTicket, options = {}) {
  const trimmed = String(rawTicket || '').trim();
  if (!trimmed) return '';
  if (/^[td]=/i.test(trimmed)) {
    return trimmed[0].toLowerCase() + '=' + trimmed.slice(2);
  }
  const prefix = options.defaultPrefix || 't=';
  return `${prefix}${trimmed}`;
}

function formatStoreAuthTickets(rawTicket) {
  return {
    pcgafdTicket: normalizeStoreMsaTicket(rawTicket, { target: 'pcgafd' }),
    licensingTicket: normalizeStoreMsaTicket(rawTicket, { target: 'licensing' }),
  };
}

// ============================================================================
// 2. Ephemeral ECDSA P-256 ProofKey & IEEE P1363 76-Byte Request Signer
// ============================================================================

/**
 * Generates an ECDSA P-256 (`prime256v1`) keypair and exports the `ProofKey` JWK required by
 * `user.auth.xboxlive.com`, `device.auth.xboxlive.com`, `sisu.xboxlive.com`, and `xsts.auth.xboxlive.com`.
 */
function generateXboxProofKeyPair() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', {
    namedCurve: 'prime256v1',
  });
  const pubJwk = publicKey.export({ format: 'jwk' });
  const privateKeyPem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();

  return {
    privateKey,
    publicKey,
    privateKeyPem,
    publicKeyPem,
    proofKeyJwk: {
      kty: 'EC',
      crv: 'P-256',
      alg: 'ES256',
      use: 'sig',
      x: pubJwk.x,
      y: pubJwk.y,
    },
  };
}

function exportProofKeyJwkFromPrivateKey(ecPrivateKey) {
  const privObj =
    typeof ecPrivateKey === 'string' || Buffer.isBuffer(ecPrivateKey)
      ? crypto.createPrivateKey(ecPrivateKey)
      : ecPrivateKey;
  const pubObj = crypto.createPublicKey(privObj);
  const pubJwk = pubObj.export({ format: 'jwk' });
  return {
    kty: 'EC',
    crv: 'P-256',
    alg: 'ES256',
    use: 'sig',
    x: pubJwk.x,
    y: pubJwk.y,
  };
}

function resolvePathAndQuery(pathAndQuery, url) {
  if (typeof pathAndQuery === 'string' && pathAndQuery.trim()) {
    const p = pathAndQuery.trim();
    return p.startsWith('/') ? p : `/${p}`;
  }
  if (typeof url === 'string' && url.trim()) {
    const parsed = new URL(url.trim());
    return `${parsed.pathname || '/'}${parsed.search || ''}`;
  }
  return '/';
}

/**
 * Derives a deterministic dashed RFC 4122 v4 UUID (`xxxxxxxx-xxxx-4xxx-8xxx-xxxxxxxxxxxx`)
 * from an arbitrary hardware/device seed string and namespace tag.
 *
 * @param {string} seedStr
 * @param {string} [namespaceTag]
 * @returns {string}
 */
function deriveDashedUuidFromSeed(seedStr, namespaceTag = 'device') {
  const b = Buffer.from(
    crypto
      .createHash('sha256')
      .update(`${String(namespaceTag || 'device')}:${String(seedStr || 'ol-default')}`)
      .digest()
      .subarray(0, 16)
  );
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x0f) | 0x80;
  const hex = b.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

/**
 * @param {Record<string, any>} params
 */
function buildXboxSignaturePayload({
  method = 'POST',
  pathAndQuery,
  url,
  authorizationHeader = '',
  bodyBuffer,
  body,
  windowsTicks,
}) {
  // Xbox Live ECDSA P-256 request signing hashes a 14-byte binary prefix:
  //   bytes 0..3  : PolicyVersion = 1 (0x00000001 BE)
  //   byte  4     : 0x00 NUL separator
  //   bytes 5..12 : windowsTicks (uint64 BE)
  //   byte  13    : 0x00 NUL separator
  // Whereas the wire `Signature` header remains 76 bytes: [versionBE32(4B), windowsTicksBE64(8B), rawRS64(64B)].
  const prefix14 = Buffer.alloc(14, 0);
  prefix14.writeUInt32BE(1, 0);
  prefix14[4] = 0x00;
  prefix14.writeBigUInt64BE(windowsTicks, 5);
  prefix14[13] = 0x00;

  const upperMethod = String(method || 'GET').trim().toUpperCase();
  const resolvedPath = resolvePathAndQuery(pathAndQuery, url);
  const authStr = String(authorizationHeader || '');
  const rawBody = bodyBuffer !== undefined ? bodyBuffer : body;
  const bodyBytes = Buffer.isBuffer(rawBody)
    ? rawBody
    : typeof rawBody === 'string'
      ? Buffer.from(rawBody, 'utf8')
      : rawBody instanceof Uint8Array
        ? Buffer.from(rawBody)
        : Buffer.alloc(0);

  const nul = Buffer.from([0x00]);
  const toSign = Buffer.concat([
    prefix14,
    Buffer.from(upperMethod, 'ascii'),
    nul,
    Buffer.from(resolvedPath, 'utf8'),
    nul,
    Buffer.from(authStr, 'utf8'),
    nul,
    bodyBytes,
    nul,
  ]);

  return { prefix14, toSign };
}

/**
 * Signs an Xbox Live / SISU / XGR request using ECDSA P-256 SHA-256 in **IEEE P1363** (`r || s`, 64 bytes)
 * format over the 14-byte prefixed payload, producing the exact 76-byte
 * `[0, 0, 0, 1, windowsTicksBE64, rawRS64]` Base64 `Signature` header.
 *
 * @param {{
 *   method: string,
 *   pathAndQuery?: string,
 *   url?: string,
 *   authorizationHeader?: string,
 *   bodyBuffer?: Buffer | string | Uint8Array | null,
 *   body?: Buffer | string | Uint8Array | null,
 *   ecPrivateKey: string | Buffer | crypto.KeyObject,
 *   timestampMs?: number,
 * }} [params]
 * @returns {string} Base64-encoded 76-byte Signature header
 */
function signXboxRequest(params = /** @type {any} */ ({})) {
  const {
    method = 'POST',
    pathAndQuery,
    url,
    authorizationHeader = '',
    bodyBuffer,
    body,
    ecPrivateKey,
    timestampMs,
  } = params;

  if (!ecPrivateKey) {
    throw new Error('signXboxRequest requires ecPrivateKey');
  }

  const effectiveBody = bodyBuffer !== undefined ? bodyBuffer : body;
  const nowSec = BigInt(Math.floor(Number(timestampMs ?? Date.now()) / 1000));
  const windowsTicks = (nowSec + 11644473600n) * 10000000n;

  const { toSign } = buildXboxSignaturePayload({
    method,
    pathAndQuery,
    url,
    authorizationHeader,
    bodyBuffer: effectiveBody,
    windowsTicks,
  });

  const keyObj =
    typeof ecPrivateKey === 'string' || Buffer.isBuffer(ecPrivateKey)
      ? crypto.createPrivateKey(ecPrivateKey)
      : ecPrivateKey;

  const rawRS64 = crypto.sign('sha256', toSign, {
    key: keyObj,
    dsaEncoding: 'ieee-p1363',
  });

  if (rawRS64.length !== 64) {
    throw new Error(`Expected 64-byte IEEE P1363 ECDSA signature, got ${rawRS64.length}`);
  }

  const wireHeader12 = Buffer.alloc(12, 0);
  wireHeader12.writeUInt32BE(1, 0);
  wireHeader12.writeBigUInt64BE(windowsTicks, 4);

  const out76 = Buffer.concat([wireHeader12, rawRS64]);
  return out76.toString('base64');
}

/**
 * Verifies a 76-byte Base64 Xbox `Signature` header against an ECDSA P-256 public key.
 */
function verifyXboxRequestSignature({
  signatureBase64,
  method = 'POST',
  pathAndQuery,
  url,
  authorizationHeader = '',
  bodyBuffer,
  body,
  ecPublicKey,
  ecPublicKeyOrJwk,
}) {
  const raw = Buffer.from(String(signatureBase64 || ''), 'base64');
  if (raw.length !== 76) return false;
  if (raw.readUInt32BE(0) !== 1) return false;

  const windowsTicks = raw.readBigUInt64BE(4);
  const rawRS64 = raw.subarray(12, 76);
  const effectiveBody = bodyBuffer !== undefined ? bodyBuffer : body;

  const { toSign } = buildXboxSignaturePayload({
    method,
    pathAndQuery,
    url,
    authorizationHeader,
    bodyBuffer: effectiveBody,
    windowsTicks,
  });

  const rawPub = ecPublicKey || ecPublicKeyOrJwk;
  let pubKeyObj = rawPub;
  if (typeof rawPub === 'string' || Buffer.isBuffer(rawPub)) {
    pubKeyObj = crypto.createPublicKey(rawPub);
  } else if (rawPub && typeof rawPub === 'object' && rawPub.kty === 'EC') {
    pubKeyObj = crypto.createPublicKey({ key: rawPub, format: 'jwk' });
  }

  return crypto.verify(
    'sha256',
    toSign,
    { key: pubKeyObj, dsaEncoding: 'ieee-p1363' },
    rawRS64
  );
}

// ============================================================================
// 3. `XErr` Error Code Mapping
// ============================================================================

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

  const err = Object.assign(new Error(userMessage), {
    name: 'XboxXstsError',
    status: httpStatus,
    msCv,
    xerr: xerrNum || undefined,
    xerrHex: hex,
    code: known?.code || 'XBOX_XSTS_UNAUTHORIZED',
    retryable: known ? known.retryable : httpStatus >= 500,
    redirectUrl,
  });
  return err;
}

// ============================================================================
// 4. Relying Party URL Matcher (`title.mgt.xboxlive.com` + Built-In Rules)
// ============================================================================

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

function matchWildcardHost(patternHost, actualHost) {
  const p = String(patternHost || '').toLowerCase().trim();
  const h = String(actualHost || '').toLowerCase().trim();
  if (!p || !h) return false;
  if (p === '*' || p === h) return true;
  if (p.startsWith('*.')) {
    const suffix = p.slice(1); // `.xboxlive.com` / `.bethesda.net`
    return h.endsWith(suffix) && h.length > suffix.length;
  }
  return false;
}

/**
 * Exact first-party Xbox infrastructure hosts whose Relying Party never varies by title NSAL.
 * Note: Generic `*.xboxlive.com` / `*.xboxservices.com` MUST NOT short-circuit here because
 * `titles/default/endpoints?type=1` maps hosts like `inventory.xboxlive.com` -> `http://licensing.xboxlive.com`
 * and `*.xboxservices.com` -> `http://mp.microsoft.com/`.
 */
function resolvePreNsalBuiltInRelyingPartyForUrl(targetUrl) {
  const trimmed = String(targetUrl || '').trim();
  if (/^rp:\/\//i.test(trimmed)) return trimmed;
  let parsed;
  try {
    parsed = new URL(trimmed);
  } catch {
    return XSTS_RELYING_PARTIES.XBOX_LIVE;
  }

  const host = parsed.hostname.toLowerCase();
  if (host === 'packagespc.xboxlive.com' || host === 'update.xboxlive.com') {
    return XSTS_RELYING_PARTIES.UPDATE_XBL;
  }
  if (host === 'licensing.xboxlive.com') {
    return XSTS_RELYING_PARTIES.LICENSING_XBL;
  }
  if (host === 'licensing.mp.microsoft.com') {
    return XSTS_RELYING_PARTIES.LICENSING_MP;
  }
  if (
    host === 'titlestorage.xboxlive.com' ||
    host.endsWith('.titlestorage.xboxlive.com')
  ) {
    return XSTS_RELYING_PARTIES.XBOX_LIVE;
  }
  return null;
}

/**
 * Post-NSAL built-in SDK Relying Party rules (applied when neither per-title NSAL nor
 * system default NSAL matched a specific Relying Party).
 */
function resolvePostNsalFallbackRelyingPartyForUrl(targetUrl) {
  const trimmed = String(targetUrl || '').trim();
  if (/^rp:\/\//i.test(trimmed)) return trimmed;
  let parsed;
  try {
    parsed = new URL(trimmed);
  } catch {
    return XSTS_RELYING_PARTIES.XBOX_LIVE;
  }

  const host = parsed.hostname.toLowerCase();
  if (host === 'playfabapi.com' || host.endsWith('.playfabapi.com')) {
    return XSTS_RELYING_PARTIES.PLAYFAB;
  }
  if (host === 'api.minecraftservices.com' || host.endsWith('.minecraftservices.com')) {
    return XSTS_RELYING_PARTIES.MINECRAFT;
  }
  if (host.endsWith('.mp.microsoft.com')) {
    return XSTS_RELYING_PARTIES.MS_STORE;
  }
  if (
    host === 'xboxlive.com' ||
    host.endsWith('.xboxlive.com') ||
    host.endsWith('.xboxservices.com')
  ) {
    return XSTS_RELYING_PARTIES.XBOX_LIVE;
  }
  return null;
}

function resolveBuiltInRelyingPartyForUrl(targetUrl) {
  return (
    resolvePreNsalBuiltInRelyingPartyForUrl(targetUrl) ||
    resolvePostNsalFallbackRelyingPartyForUrl(targetUrl)
  );
}

function matchDynamicTitleEndpointRelyingParty(targetUrl, endPoints = []) {
  if (!Array.isArray(endPoints) || endPoints.length === 0) return null;
  let parsed;
  try {
    parsed = new URL(targetUrl);
  } catch {
    return null;
  }
  const proto = parsed.protocol.replace(/:$/, '').toLowerCase();
  const host = parsed.hostname.toLowerCase();
  const effectivePort = parsed.port
    ? Number(parsed.port)
    : proto === 'https'
      ? 443
      : proto === 'http'
        ? 80
        : 0;
  const pathStr = parsed.pathname || '/';

  for (const ep of endPoints) {
    if (!ep || !ep.RelyingParty) continue;
    if (ep.Protocol && String(ep.Protocol).toLowerCase() !== proto) continue;
    if (ep.Port !== undefined && ep.Port !== null && Number(ep.Port) > 0 && effectivePort > 0) {
      if (Number(ep.Port) !== effectivePort) continue;
    }
    if (!matchWildcardHost(ep.Host, host)) continue;
    if (ep.Path && !pathStr.toLowerCase().startsWith(String(ep.Path).toLowerCase())) {
      continue;
    }
    return String(ep.RelyingParty);
  }
  return null;
}

// ============================================================================
// 5. OAuth CSPRNG `state` Verification & Dual-Plane Provider Implementation
// ============================================================================

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
    /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) || trimmed.startsWith('?');
  if (!looksLikeUrlOrQuery) {
    return null;
  }

  let parsed;
  try {
    parsed = trimmed.startsWith('?')
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
 * Extracts and validates an OAuth2 authorization code from a callback URL or structured payload,
 * enforcing `crypto.timingSafeEqual` CSRF `state` verification whenever `expectedState` is provided
 * (or when `requireState: true` is set).
 *
 * @param {string | { url?: string, callbackUrl?: string, code?: string, state?: string, expectedState?: string }} codeOrUrl
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
    const rawTarget = codeOrUrl.url || codeOrUrl.callbackUrl || '';
    if (rawTarget) {
      return extractAuthCodeFromInput(rawTarget, {
        ...opts,
        expectedState: effectiveExpected,
      });
    }
    if (effectiveExpected !== undefined || opts.requireState) {
      if (!verifyXboxOAuthState(codeOrUrl.state, effectiveExpected)) {
        throw new Error('Microsoft OAuth callback rejected: missing or mismatched CSRF state');
      }
    }
    const directCode = String(codeOrUrl.code || '').trim();
    if (!directCode) {
      throw new Error('Missing Microsoft OAuth authorization code');
    }
    return directCode;
  }

  const raw = String(codeOrUrl || '').trim();
  if (!raw) {
    throw new Error('Missing Microsoft OAuth authorization code');
  }

  const parsedUrl = parseTrustedXboxOAuthCallbackUrl(raw, opts.redirectUri);
  if (parsedUrl) {
    const oauthError = parsedUrl.searchParams.get('error');
    if (oauthError) {
      const safeErr = String(oauthError).replace(/[^\w.-]/g, '').slice(0, 64) || 'access_denied';
      throw new Error(`Microsoft sign-in cancelled or denied (${safeErr})`);
    }

    const callbackState = parsedUrl.searchParams.get('state');
    if (opts.expectedState !== undefined || opts.requireState) {
      if (!verifyXboxOAuthState(callbackState, opts.expectedState)) {
        throw new Error('Microsoft OAuth callback rejected: missing or mismatched CSRF state');
      }
    }

    const code = parsedUrl.searchParams.get('code');
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

function isFutureIsoTimestamp(isoStr, bufferMs = 10 * 60_000) {
  if (!isoStr || typeof isoStr !== 'string') return false;
  const ts = Date.parse(isoStr);
  if (Number.isNaN(ts)) return false;
  return ts - Date.now() > bufferMs;
}

// Shared per-vault single-flight locks so multiple provider instances never race refresh_token rotation
const globalInFlightMsaRenewals = new Map();
const globalInFlightXblSessionRenewals = new Map();

// Shared 30-minute Minecraft Java entitlement cache keyed by SHA-256(account/token)
const globalMinecraftEntitlementCache = new Map();

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
  const vault = config.tokenVault || require('../tokenVault.cjs');
  const fetchImpl = config.customFetch || config.fetchImpl || globalThis.fetch;
  const clientId = config.clientId || XBOX_LIVESDK_CLIENT_ID;
  const lockScopeKey = String(userDataDir || 'default');

  // Ephemeral session cache for secondary Relying Party XSTS tokens, device tokens, SISU title tokens, and endpoints
  const rpXstsCache = new Map();
  const xblDeviceTokenCache = new Map();
  const sisuSessionCache = new Map();
  const titleAuthSessionCache = new Map();
  const inFlightTitleAuthSessions = new Map();
  let cachedDefaultTitleEndpoints = null;
  const cachedPerTitleEndpoints = new Map();
  let pendingOAuthState = null;

  const vaultOpts = userDataDir ? { userDataDir } : {};

  const loadXboxVaultRecord = () => {
    const all = vault.loadSavedTokens(vaultOpts) || {};
    return all.xbox && typeof all.xbox === 'object' ? { ...all.xbox } : {};
  };

  const saveXboxVaultRecord = (patch) => {
    const current = loadXboxVaultRecord();
    const merged = {
      ...current,
      ...patch,
      updatedAt: new Date().toISOString(),
    };
    vault.saveTokens('xbox', merged, vaultOpts);
    return merged;
  };

  const saveXboxVaultRecordAsync = async (patch) => {
    if (typeof vault.saveTokensAsync === 'function' && typeof vault.loadSavedTokensAsync === 'function') {
      const all = (await vault.loadSavedTokensAsync(vaultOpts)) || {};
      const current = all.xbox && typeof all.xbox === 'object' ? { ...all.xbox } : {};
      const merged = {
        ...current,
        ...patch,
        updatedAt: new Date().toISOString(),
      };
      await vault.saveTokensAsync('xbox', merged, vaultOpts);
      return merged;
    }
    return saveXboxVaultRecord(patch);
  };

  const invalidateRpXstsCache = (relyingParty, sandboxId = 'RETAIL', subjectType = 'user') => {
    if (!relyingParty) {
      rpXstsCache.clear();
      return;
    }
    rpXstsCache.delete(buildRpXstsCacheKey(relyingParty, sandboxId, subjectType));
  };

  const ensureProofKeyRecord = () => {
    const current = loadXboxVaultRecord();
    if (
      current.proofPrivateKeyPem &&
      current.proofPublicKeyPem &&
      current.proofKeyJwk &&
      current.proofKeyJwk.x &&
      current.proofKeyJwk.y
    ) {
      return {
        privateKeyPem: current.proofPrivateKeyPem,
        publicKeyPem: current.proofPublicKeyPem,
        proofKeyJwk: current.proofKeyJwk,
      };
    }
    const generated = generateXboxProofKeyPair();
    saveXboxVaultRecord({
      proofPrivateKeyPem: generated.privateKeyPem,
      proofPublicKeyPem: generated.publicKeyPem,
      proofKeyJwk: generated.proofKeyJwk,
    });
    return {
      privateKeyPem: generated.privateKeyPem,
      publicKeyPem: generated.publicKeyPem,
      proofKeyJwk: generated.proofKeyJwk,
    };
  };

  const beginOAuthAuthorization = (options = {}) => {
    const authReq = buildXboxAuthorizationUrl({
      clientId,
      ...options,
    });
    pendingOAuthState = authReq.state;
    return authReq;
  };

  const postOAuthForm = async (formParams, signal) => {
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
      const err = Object.assign(
        new Error(
          `Microsoft OAuth token request failed (HTTP ${res.status}${safeOAuthCode ? `, error=${safeOAuthCode}` : ''}, MS-CV=${msCv})`
        ),
        {
          status: res.status,
          msCv,
          oauthError: safeOAuthCode,
        }
      );
      throw err;
    }
    return json;
  };

  /**
   * Single-flight MSA renewal for Plane 1 (`user.auth.xboxlive.com`) or Plane 2 (`www.microsoft.com`).
   * Never posts `service::www.microsoft.com::MBI_SSL` to `oauth20_token.srf` (which rejects public
   * clients with HTTP 400); instead renews Plane 2 silently via `RST2.srf` when `userStsLegacyTokenXml`
   * is provisioned, while `PCGAFD` falls back seamlessly to `XSTS` (`http://mp.microsoft.com/`).
   */
  const refreshMsaPlane = async (plane, signal) => {
    const lockKey = `${lockScopeKey}:${plane}`;
    if (globalInFlightMsaRenewals.has(lockKey)) {
      return globalInFlightMsaRenewals.get(lockKey);
    }

    const promise = (async () => {
      const saved = loadXboxVaultRecord();

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
          {
            client_id: clientId,
            grant_type: 'refresh_token',
            refresh_token: refreshToken,
            scope: SCOPE_XBL_MBI_SSL,
          },
          signal
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

      throw new Error('Xbox session expired: no Microsoft refresh_token saved. Please reconnect Xbox.');
    })().finally(() => {
      globalInFlightMsaRenewals.delete(lockKey);
    });

    globalInFlightMsaRenewals.set(lockKey, promise);
    return promise;
  };

  const authenticateXblUser = async (rawXblAccessToken, proof, signal) => {
    const rpsTicket = normalizeXblRpsTicket(rawXblAccessToken, { defaultPrefix: 't=' });
    const bodyObj = {
      RelyingParty: 'http://auth.xboxlive.com',
      TokenType: 'JWT',
      Properties: {
        AuthMethod: 'RPS',
        SiteName: 'user.auth.xboxlive.com',
        RpsTicket: rpsTicket,
        ProofKey: proof.proofKeyJwk,
      },
    };
    const bodyStr = JSON.stringify(bodyObj);
    const sig = signXboxRequest({
      method: 'POST',
      url: XBL_USER_AUTH_URL,
      authorizationHeader: '',
      bodyBuffer: Buffer.from(bodyStr, 'utf8'),
      ecPrivateKey: proof.privateKeyPem,
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
    if (!res.ok || !json?.Token) {
      const msCv = extractSafeCorrelationId(res);
      const err = Object.assign(
        new Error(`Xbox Live user authentication failed (HTTP ${res.status}, MS-CV=${msCv})`),
        { status: res.status, msCv }
      );
      throw err;
    }
    return {
      token: json.Token,
      notAfter: json.NotAfter,
      uhs: json?.DisplayClaims?.xui?.[0]?.uhs || '',
    };
  };

  /**
   * @param {{
   *   relyingParty: string,
   *   xblUserToken: string,
   *   deviceToken?: string,
   *   titleToken?: string,
   *   sandboxId?: string,
   *   proof?: any,
   *   signal?: AbortSignal,
   * }} params
   */
  const authorizeXstsInternal = async ({
    relyingParty,
    xblUserToken,
    deviceToken,
    titleToken,
    sandboxId = 'RETAIL',
    proof,
    signal,
  }) => {
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
    const headers = {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'x-xbl-contract-version': '1',
    };
    if (proof?.privateKeyPem) {
      headers.Signature = signXboxRequest({
        method: 'POST',
        url: XBL_XSTS_AUTHORIZE_URL,
        authorizationHeader: '',
        bodyBuffer: Buffer.from(bodyStr, 'utf8'),
        ecPrivateKey: proof.privateKeyPem,
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
    return {
      token: json.Token,
      notAfter: json.NotAfter,
      issueInstant: json.IssueInstant,
      uhs,
      xuid: xui.xid || '',
      gamertag: xui.gtg || xui.mgt || '',
      modernGamertag: xui.mgt || xui.gtg || '',
      uniqueModernGamertag: xui.umg || xui.mgt || xui.gtg || '',
      ageGroup: xui.agg || '',
      authorizationHeader: `XBL3.0 x=${uhs};${json.Token}`,
    };
  };

  const fetchProfileSettings = async (xstsAuthHeader, signal) => {
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
  };

  const ensureValidXblUserToken = async (forceRefresh = false, signal) => {
    const saved = loadXboxVaultRecord();
    const proof = ensureProofKeyRecord();
    if (!forceRefresh && saved.xblUserToken && isFutureIsoTimestamp(saved.xblUserNotAfter, 15 * 60_000)) {
      return {
        xblUserToken: saved.xblUserToken,
        xblUserNotAfter: saved.xblUserNotAfter,
        uhs: saved.uhs || '',
        proof,
      };
    }

    let xblAccessToken = saved.xblAccessToken || saved.access_token;
    if (forceRefresh || !xblAccessToken || !isFutureIsoTimestamp(saved.msaExpiresAt, 10 * 60_000)) {
      const refreshed = await refreshMsaPlane('xbl', signal);
      xblAccessToken = refreshed.xblAccessToken;
    }

    let xasu;
    try {
      xasu = await authenticateXblUser(xblAccessToken, proof, signal);
    } catch (err) {
      if (!forceRefresh) {
        const refreshed = await refreshMsaPlane('xbl', signal);
        xasu = await authenticateXblUser(refreshed.xblAccessToken, proof, signal);
      } else {
        throw err;
      }
    }

    await saveXboxVaultRecordAsync({
      xblUserToken: xasu.token,
      xblUserNotAfter: xasu.notAfter,
      uhs: xasu.uhs || saved.uhs,
    });

    return {
      xblUserToken: xasu.token,
      xblUserNotAfter: xasu.notAfter,
      uhs: xasu.uhs,
      proof,
    };
  };

  const finalizeXboxUserSession = async ({
    rawXblAccessToken,
    proof,
    initialStoreTicket = '',
    signal,
  }) => {
    // Step 2: XASU -> XBL User Token
    const xasu = await authenticateXblUser(rawXblAccessToken, proof, signal);
    await saveXboxVaultRecordAsync({
      xblUserToken: xasu.token,
      xblUserNotAfter: xasu.notAfter,
      uhs: xasu.uhs,
    });

    // Step 3: XSTS (`http://xboxlive.com`) + Profile Gamerpic
    let xsts;
    try {
      xsts = await authorizeXstsInternal({
        relyingParty: XSTS_RELYING_PARTIES.XBOX_LIVE,
        xblUserToken: xasu.token,
        sandboxId: 'RETAIL',
        proof,
        signal,
      });
    } catch (err) {
      if (err && err.xerr === 2148916233) {
        await saveXboxVaultRecordAsync({
          xboxProfileMissing: true,
          gamertag: 'Microsoft Store User',
        });
      }
      throw err;
    }

    // Best-effort pre-mint `http://mp.microsoft.com/` XSTS for PCGAFD entitlements & subscriptions
    let mpAuthHeader = '';
    try {
      const mpXsts = await authorizeXstsInternal({
        relyingParty: XSTS_RELYING_PARTIES.MS_STORE,
        xblUserToken: xasu.token,
        sandboxId: 'RETAIL',
        proof,
        signal,
      });
      mpAuthHeader = mpXsts.authorizationHeader || '';
      await saveXboxVaultRecordAsync({
        xstsMpToken: mpXsts.token,
        xstsMpUhs: mpXsts.uhs,
        xstsMpNotAfter: mpXsts.notAfter,
      });
      rpXstsCache.set(
        buildRpXstsCacheKey(XSTS_RELYING_PARTIES.MS_STORE, 'RETAIL', 'user'),
        mpXsts
      );
    } catch {}

    const profile = await fetchProfileSettings(xsts.authorizationHeader, signal);
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

    rpXstsCache.set(
      buildRpXstsCacheKey(XSTS_RELYING_PARTIES.XBOX_LIVE, 'RETAIL', 'user'),
      {
        ...xsts,
        xuid,
        gamertag,
        modernGamertag,
      }
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
   * Exchanges an interactive OAuth2 authorization code (or full redirect URL) on
   * `service::user.auth.xboxlive.com::MBI_SSL`, enforcing CSPRNG `state` verification when
   * `expectedState` (or a pending `beginOAuthAuthorization()` flow) is active.
   * Never returns raw authorization `code` strings to callers.
   */
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
    const effectiveExpectedState =
      opts.expectedState !== undefined
        ? opts.expectedState
        : pendingOAuthState !== null
          ? pendingOAuthState
          : undefined;

    const code = extractAuthCodeFromInput(codeOrUrl, {
      expectedState: effectiveExpectedState,
      redirectUri: opts.redirectUri,
      requireState: Boolean(opts.requireState),
    });
    if (pendingOAuthState !== null) {
      pendingOAuthState = null;
    }

    const proof = ensureProofKeyRecord();

    const xblOauth = await postOAuthForm(
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

    // Persist MSA tokens immediately before XSTS so `XErr 2148916233` (missing Gamertag) still keeps session state
    await saveXboxVaultRecordAsync({
      access_token: xblOauth.access_token,
      xblAccessToken: xblOauth.access_token,
      msaExpiresAt,
      msaRefreshToken: latestRefreshToken,
      refresh_token: latestRefreshToken,
      msaUserId: xblOauth.user_id || '',
      syncMode: loadXboxVaultRecord().syncMode || 'owned_and_played',
    });

    return finalizeXboxUserSession({
      rawXblAccessToken: xblOauth.access_token,
      proof,
      initialStoreTicket: loadXboxVaultRecord().storeTicket || '',
      signal: opts.signal,
    });
  };

  /**
   * Exchanges a `CloudExperienceHost` `TokenBroker` `DAProperty` payload from `InlineLogin.srf`
   * against `RST2.srf`, supporting both 1-leg SSO and 2-leg `inlineauthurl` consent flows, and
   * provisioning `userStsLegacyTokenXml` (`http://Passport.NET/STS`) + `storeTicket` (`www.microsoft.com`)
   * so macOS bottle `MSIXVC` `CIK` licensing works natively alongside Xbox Live & Game Pass sync!
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

    let stsLegacyXml =
      ex.tokens.find((t) => Boolean(t.legacyTokenXml))?.legacyTokenXml || '';

    // If 1-leg SSO succeeded without needing Leg 2, acquire `http://Passport.NET/tb` silently (or retain `sDAToken`)
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

    // Mint `www.microsoft.com` (`mbi_ssl`) user store ticket for `licensing.mp.microsoft.com` + `PCGAFD`
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

    const priorVault = loadXboxVaultRecord();
    await saveXboxVaultRecordAsync({
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

    const proof = ensureProofKeyRecord();
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
   * Returns a valid Xbox Live session (`http://xboxlive.com` XSTS + `xuid` + `gamertag` + `gamerpicUrl`),
   * refreshing hierarchically (XSTS-only fast path if `xblUserToken` is still valid, otherwise MSA refresh).
   */
  const getValidXboxSession = async (options = {}) => {
    const forceRefresh = Boolean(options.forceRefresh);
    const saved = loadXboxVaultRecord();
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

    if (globalInFlightXblSessionRenewals.has(lockScopeKey) && !forceRefresh) {
      return globalInFlightXblSessionRenewals.get(lockScopeKey);
    }

    const renewalPromise = (async () => {
      const { xblUserToken, proof } = await ensureValidXblUserToken(forceRefresh, options.signal);
      const xsts = await authorizeXstsInternal({
        relyingParty: XSTS_RELYING_PARTIES.XBOX_LIVE,
        xblUserToken,
        sandboxId: 'RETAIL',
        proof,
        signal: options.signal,
      });

      const current = loadXboxVaultRecord();
      let gamerpicUrl = current.gamerpicUrl || current.avatarUrl || '';
      let gamerscore = current.gamerscore || 0;
      let resolvedXuid = xsts.xuid || current.xuid || '';
      let resolvedGamertag =
        xsts.uniqueModernGamertag || xsts.gamertag || current.gamertag || 'Xbox Player';
      let resolvedModernGt = xsts.modernGamertag || current.modernGamertag || resolvedGamertag;

      if (!gamerpicUrl || options.refreshProfile) {
        const profile = await fetchProfileSettings(xsts.authorizationHeader, options.signal);
        if (profile) {
          gamerpicUrl = profile.gamerpicUrl || gamerpicUrl;
          gamerscore = profile.gamerscore || gamerscore;
          resolvedXuid = profile.xuid || resolvedXuid;
          resolvedGamertag =
            profile.uniqueModernGamertag || profile.gamertag || resolvedGamertag;
          resolvedModernGt = profile.modernGamertag || resolvedModernGt;
        }
      }

      await saveXboxVaultRecordAsync({
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

      rpXstsCache.set(xblLiveCacheKey, {
        ...xsts,
        xuid: resolvedXuid,
        gamertag: resolvedGamertag,
        modernGamertag: resolvedModernGt,
      });

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
    })().finally(() => {
      globalInFlightXblSessionRenewals.delete(lockScopeKey);
    });

    globalInFlightXblSessionRenewals.set(lockScopeKey, renewalPromise);
    return renewalPromise;
  };

  /**
   * Returns a valid Microsoft Store authorization token:
   * - When `storeTicket` (`www.microsoft.com` `mbi_ssl`) is available (or silently refreshed via
   *   `userStsLegacyTokenXml`), returns the normalized MSA ticket for `'pcgafd'` or `'licensing'`.
   * - When `storeTicket` is absent (e.g., OAuth2-only sessions) and `target` is `'pcgafd'`/`'store'`,
   *   transparently returns `XBL3.0 x=<uhs>;<mpXsts>` (`http://mp.microsoft.com/`), which `PCGAFD`
   *   accepts natively for owned entitlements and subscription tier queries!
   */
  const getStoreMsaToken = async (options = {}) => {
    const forceRefresh = Boolean(options.forceRefresh);
    const target = options.forLicensing ? 'licensing' : options.target || 'pcgafd';
    let saved = loadXboxVaultRecord();

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
        expiresAt: '',
      };
    }
    return '';
  };

  /**
   * Mints or returns a cached XSTS token for any Relying Party URI (`http://xboxlive.com`,
   * `http://mp.microsoft.com/`, `http://update.xboxlive.com`, `rp://api.minecraftservices.com/`, etc.).
   *
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

    if (forceRefresh) {
      rpXstsCache.delete(cacheKey);
    } else {
      const cached = rpXstsCache.get(cacheKey);
      if (cached && isFutureIsoTimestamp(cached.notAfter, 10 * 60_000)) {
        return cached;
      }
    }

    // Check persistent `xstsMpToken` shortcut for `http://mp.microsoft.com/`
    const saved = loadXboxVaultRecord();
    if (
      !forceRefresh &&
      rp === XSTS_RELYING_PARTIES.MS_STORE &&
      sandboxId === 'RETAIL' &&
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
      rpXstsCache.set(cacheKey, hit);
      return hit;
    }

    const { xblUserToken, proof } = await ensureValidXblUserToken(forceRefresh, options.signal);
    const minted = await authorizeXstsInternal({
      relyingParty: rp,
      xblUserToken: options.userTokenOverride || xblUserToken,
      deviceToken: options.deviceToken,
      titleToken: options.titleToken,
      sandboxId,
      proof,
      signal: options.signal,
    });

    if (rp === XSTS_RELYING_PARTIES.MS_STORE && sandboxId === 'RETAIL' && subjectType === 'user') {
      await saveXboxVaultRecordAsync({
        xstsMpToken: minted.token,
        xstsMpUhs: minted.uhs,
        xstsMpNotAfter: minted.notAfter,
      });
    }

    rpXstsCache.set(cacheKey, minted);
    return minted;
  };

  /**
   * Mints and caches an Xbox Live `DeviceToken` JWT from `POST https://device.auth.xboxlive.com/device/authenticate`
   * in either `'rps'` mode (hardware-trusted CLEP/TokenBroker ticket — required for `TitleStorage` ConnectedStorage
   * locks and XSTS `xdi` claims) or `'pop'` mode (`AuthMethod: "ProofOfPossession"` — accepted by `sisu.xboxlive.com`).
   *
   * @param {{ mode?: 'rps' | 'pop', forceRefresh?: boolean, signal?: AbortSignal }} [options]
   * @returns {Promise<string>}
   */
  const getXblDeviceToken = async ({ mode = 'rps', forceRefresh = false, signal } = {}) => {
    const normMode = String(mode || 'rps').toLowerCase() === 'pop' ? 'pop' : 'rps';
    const cached = xblDeviceTokenCache.get(normMode);
    if (!forceRefresh && cached?.token && isFutureIsoTimestamp(cached.notAfter, 10 * 60_000)) {
      return cached.token;
    }

    const proof = ensureProofKeyRecord();
    const postDeviceAuthenticate = async (properties) => {
      const devAuthBody = JSON.stringify({
        RelyingParty: 'http://auth.xboxlive.com',
        TokenType: 'JWT',
        Properties: properties,
      });
      const devAuthSig = signXboxRequest({
        method: 'POST',
        url: XBL_DEVICE_AUTH_URL,
        authorizationHeader: '',
        bodyBuffer: Buffer.from(devAuthBody, 'utf8'),
        ecPrivateKey: proof.privateKeyPem,
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
        signal: buildXboxFetchSignal(signal),
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
    };

    if (normMode === 'pop') {
      const savedDevCtx = loadXboxVaultRecord()?.deviceContext || {};
      const seedBase =
        savedDevCtx.hwDeviceId ||
        savedDevCtx.deviceMembername ||
        (typeof vault.getHardwareFingerprint === 'function' ? vault.getHardwareFingerprint() : '') ||
        lockScopeKey;
      const idUuid = deriveDashedUuidFromSeed(seedBase, 'xbl-pop-device-id');
      const serialUuid = deriveDashedUuidFromSeed(
        savedDevCtx.deviceMembername || seedBase,
        'xbl-pop-device-serial'
      );

      const popRes = await postDeviceAuthenticate({
        AuthMethod: 'ProofOfPossession',
        Id: `{${idUuid}}`,
        DeviceType: 'Win32',
        SerialNumber: `{${serialUuid}}`,
        Version: '10.0.22631',
        ProofKey: proof.proofKeyJwk,
      });

      if (!popRes.ok || !popRes.json?.Token) {
        const err = Object.assign(
          new Error(
            `Xbox device.auth.xboxlive.com (PoP) failed (HTTP ${popRes.status}, MS-CV=${popRes.msCv})`
          ),
          { status: popRes.status, msCv: popRes.msCv }
        );
        throw err;
      }

      const notAfter =
        popRes.json.NotAfter || new Date(Date.now() + 4 * 3600_000).toISOString();
      xblDeviceTokenCache.set('pop', { token: popRes.json.Token, notAfter });
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

    const seedBase =
      devCtx?.hwDeviceId ||
      devCtx?.deviceMembername ||
      (typeof vault.getHardwareFingerprint === 'function' ? vault.getHardwareFingerprint() : '') ||
      lockScopeKey;
    const idUuid = deriveDashedUuidFromSeed(seedBase, 'xbl-device-id');
    const serialUuid = deriveDashedUuidFromSeed(
      devCtx?.deviceMembername || seedBase,
      'xbl-device-serial'
    );

    const buildRpsProps = (prefix) => ({
      AuthMethod: 'RPS',
      SiteName: 'user.auth.xboxlive.com',
      RpsTicket: `${prefix}${rawTicket}`,
      Id: `{${idUuid}}`,
      DeviceType: 'Win32',
      SerialNumber: `{${serialUuid}}`,
      Version: '10.0.22631',
      ProofKey: proof.proofKeyJwk,
    });

    let rpsRes = await postDeviceAuthenticate(buildRpsProps('t='));
    if (!rpsRes.ok || !rpsRes.json?.Token) {
      const dFallbackRes = await postDeviceAuthenticate(buildRpsProps('d='));
      if (dFallbackRes.ok && dFallbackRes.json?.Token) {
        rpsRes = dFallbackRes;
      }
    }

    if (!rpsRes.ok || !rpsRes.json?.Token) {
      const err = Object.assign(
        new Error(
          `Xbox device.auth.xboxlive.com (RPS) failed (HTTP ${rpsRes.status}, MS-CV=${rpsRes.msCv})`
        ),
        { status: rpsRes.status, msCv: rpsRes.msCv }
      );
      throw err;
    }

    const notAfter =
      rpsRes.json.NotAfter || new Date(Date.now() + 4 * 3600_000).toISOString();
    xblDeviceTokenCache.set('rps', { token: rpsRes.json.Token, notAfter });
    return rpsRes.json.Token;
  };

  /**
   * Authenticates a virtual Xbox `DeviceToken` (`device.auth.xboxlive.com/device/authenticate`)
   * and executes `sisu.xboxlive.com/authorize` to obtain a title-bound `TitleToken` for a bottled
   * GDK game specifying an `msaAppId`.
   */
  const getSisuTitleSession = async (msaAppId, forceRefresh = false, signal) => {
    const cleanAppId = String(msaAppId || '').trim();
    if (!cleanAppId) return null;

    const cached = sisuSessionCache.get(cleanAppId);
    if (!forceRefresh && cached && isFutureIsoTimestamp(cached.notAfter, 10 * 60_000)) {
      return cached;
    }

    const proof = ensureProofKeyRecord();
    let saved = loadXboxVaultRecord();
    if (!saved.xblAccessToken || !isFutureIsoTimestamp(saved.msaExpiresAt, 10 * 60_000)) {
      saved = await refreshMsaPlane('xbl', signal);
    }
    const userRpsTicket = normalizeXblRpsTicket(saved.xblAccessToken, { defaultPrefix: 't=' });

    const attemptSisuAuthorize = async (xblDeviceToken) => {
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

      const sisuSig = signXboxRequest({
        method: 'POST',
        url: XBL_SISU_AUTHORIZE_URL,
        authorizationHeader: '',
        bodyBuffer: Buffer.from(sisuBody, 'utf8'),
        ecPrivateKey: proof.privateKeyPem,
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
        signal: buildXboxFetchSignal(signal),
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
    };

    // Prefer fast ProofOfPossession DeviceToken for SISU, falling back to RPS DeviceToken if needed
    let sisuAttempt = null;
    try {
      const popDeviceToken = await getXblDeviceToken({ mode: 'pop', forceRefresh, signal });
      sisuAttempt = await attemptSisuAuthorize(popDeviceToken);
    } catch {}

    if (!sisuAttempt || !sisuAttempt.ok) {
      try {
        const rpsDeviceToken = await getXblDeviceToken({ mode: 'rps', forceRefresh, signal });
        const rpsAttempt = await attemptSisuAuthorize(rpsDeviceToken);
        if (rpsAttempt.ok || !sisuAttempt) {
          sisuAttempt = rpsAttempt;
        }
      } catch (rpsErr) {
        if (!sisuAttempt) throw rpsErr;
      }
    }

    if (!sisuAttempt || !sisuAttempt.ok) {
      const err = Object.assign(
        new Error(
          `SISU authorize failed for AppId=${cleanAppId} (HTTP ${sisuAttempt?.status ?? 'ERR'}, MS-CV=${sisuAttempt?.msCv || 'none'})`
        ),
        { status: sisuAttempt?.status, msCv: sisuAttempt?.msCv || 'none' }
      );
      throw err;
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
    sisuSessionCache.set(cleanAppId, entry);
    return entry;
  };

  /**
   * Acquires a hardware-bound `TitleToken` for a GDK game's `<MSAAppId>` (supports both 16-hex
   * LiveSDK AppIds and modern UUIDs) via `RST2.srf` `TOKEN_BROKER` (`clientid=<msaAppId>`) ->
   * `POST https://title.auth.xboxlive.com/title/authenticate`, then pre-mints the title-bound
   * `http://xboxlive.com` XSTS token required to query `title.mgt.xboxlive.com/titles/current/endpoints`.
   *
   * @param {{ msaAppId?: string, titleId?: string | number, forceRefresh?: boolean, signal?: AbortSignal }} [params]
   */
  const getTitleAuthSession = async ({ msaAppId, titleId, forceRefresh = false, signal } = {}) => {
    const cleanAppId = String(msaAppId || '').trim();
    if (!cleanAppId) return null;

    const cached = titleAuthSessionCache.get(cleanAppId);
    if (!forceRefresh && cached && isFutureIsoTimestamp(cached.notAfter, 10 * 60_000)) {
      return cached;
    }

    if (!forceRefresh && inFlightTitleAuthSessions.has(cleanAppId)) {
      return inFlightTitleAuthSessions.get(cleanAppId);
    }

    const expectedDecimalTitleId = normalizeDecimalTitleId(titleId);

    const run = (async () => {
      const proof = ensureProofKeyRecord();
      let primaryErr = null;

      // Primary universal GDK path: Device TOKEN_BROKER -> title.auth.xboxlive.com/title/authenticate
      try {
        const rpsDeviceToken = await getXblDeviceToken({ mode: 'rps', forceRefresh, signal });
        const broker = await xboxDeviceClep.acquireTitleBrokerTicket({
          msaAppId: cleanAppId,
          tokenVault: vault,
          userDataDir,
          fetchImpl,
          forceRefresh,
        });

        if (rpsDeviceToken && broker?.rpsTicket) {
          const titleAuthBody = JSON.stringify({
            RelyingParty: 'http://auth.xboxlive.com',
            TokenType: 'JWT',
            Properties: {
              AuthMethod: 'RPS',
              DeviceToken: rpsDeviceToken,
              RpsTicket: broker.rpsTicket,
              SiteName: 'user.auth.xboxlive.com',
              ProofKey: proof.proofKeyJwk,
            },
          });

          const titleAuthSig = signXboxRequest({
            method: 'POST',
            url: XBL_TITLE_AUTH_URL,
            authorizationHeader: '',
            bodyBuffer: Buffer.from(titleAuthBody, 'utf8'),
            ecPrivateKey: proof.privateKeyPem,
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
            signal: buildXboxFetchSignal(signal),
          });

          const titleText = await titleRes.text();
          let titleJson = null;
          try {
            titleJson = titleText ? JSON.parse(titleText) : null;
          } catch {}

          if (!titleRes.ok || !titleJson?.Token) {
            const msCv = extractSafeCorrelationId(titleRes);
            const err = Object.assign(
              new Error(
                `Xbox title.auth.xboxlive.com failed for ${cleanAppId} (HTTP ${titleRes.status}, MS-CV=${msCv})`
              ),
              { status: titleRes.status, msCv }
            );
            throw err;
          }

          const mintedTitleId = String(
            titleJson?.DisplayClaims?.xti?.tid || expectedDecimalTitleId || ''
          );
          const xblTitleXsts = await getXstsToken(XSTS_RELYING_PARTIES.XBOX_LIVE, {
            forceRefresh,
            deviceToken: rpsDeviceToken,
            titleToken: titleJson.Token,
            signal,
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
          titleAuthSessionCache.set(cleanAppId, sessionEntry);
          return sessionEntry;
        }
      } catch (err) {
        primaryErr = err;
      }

      // Guarded SISU fallback: ONLY accept if its TitleToken matches the expected game TitleId
      // (prevents accepting LiveSDK's `1794566092` TitleToken when AccessToken belongs to LiveSDK).
      try {
        const sisu = await getSisuTitleSession(cleanAppId, forceRefresh, signal);
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
                  signal,
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
          titleAuthSessionCache.set(cleanAppId, fallbackEntry);
          return fallbackEntry;
        }
      } catch {}

      if (primaryErr) throw primaryErr;
      return null;
    })().finally(() => {
      inFlightTitleAuthSessions.delete(cleanAppId);
    });

    inFlightTitleAuthSessions.set(cleanAppId, run);
    return run;
  };

  const resolveRelyingPartyForTargetUrl = async (
    targetUrl,
    options = {},
    legacyBaseXblAuthHeader = ''
  ) => {
    const preBuiltIn = resolvePreNsalBuiltInRelyingPartyForUrl(targetUrl);
    if (preBuiltIn) return preBuiltIn;

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
    const activeProof = opts.proof || ensureProofKeyRecord();

    // Query `title.mgt.xboxlive.com` with IEEE P1363 `Signature` header; NEVER cache failed responses!
    const fetchSignedEndpoints = async (endpointUrl, authHeader) => {
      if (!authHeader) return { ok: false, endPoints: [] };
      const sig = signXboxRequest({
        method: 'GET',
        url: endpointUrl,
        authorizationHeader: authHeader,
        bodyBuffer: Buffer.alloc(0),
        ecPrivateKey: activeProof.privateKeyPem,
      });
      const res = await fetchImpl(endpointUrl, {
        method: 'GET',
        headers: {
          Authorization: authHeader,
          'x-xbl-contract-version': '1',
          Accept: 'application/json',
          Signature: sig,
        },
        signal: buildXboxFetchSignal(opts.signal),
      });
      if (!res.ok) return { ok: false, endPoints: [] };
      const json = await res.json();
      return {
        ok: true,
        endPoints: Array.isArray(json?.EndPoints) ? json.EndPoints : [],
      };
    };

    try {
      // 1. Per-Title NSAL (`titles/current/endpoints` with title-bound XSTS, or `titles/{decimalTid}/endpoints`)
      if (cacheKeyId && (xblTitleAuthHeader || decimalTitleId)) {
        if (!cachedPerTitleEndpoints.has(cacheKeyId)) {
          let fetched = { ok: false, endPoints: [] };
          if (xblTitleAuthHeader) {
            fetched = await fetchSignedEndpoints(
              XBL_TITLE_ENDPOINTS_CURRENT_URL,
              xblTitleAuthHeader
            );
          }
          if (!fetched.ok && decimalTitleId && (xblTitleAuthHeader || baseXblAuthHeader)) {
            fetched = await fetchSignedEndpoints(
              `https://title.mgt.xboxlive.com/titles/${encodeURIComponent(decimalTitleId)}/endpoints`,
              xblTitleAuthHeader || baseXblAuthHeader
            );
          }
          if (fetched.ok) {
            cachedPerTitleEndpoints.set(cacheKeyId, fetched.endPoints);
          }
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
        const defaultFetched = await fetchSignedEndpoints(
          XBL_TITLE_ENDPOINTS_DEFAULT_URL,
          defaultAuth
        );
        if (defaultFetched.ok) {
          cachedDefaultTitleEndpoints = defaultFetched.endPoints;
        }
      }
      if (cachedDefaultTitleEndpoints) {
        const matchedDefaultRp = matchDynamicTitleEndpointRelyingParty(
          targetUrl,
          cachedDefaultTitleEndpoints
        );
        if (matchedDefaultRp) return matchedDefaultRp;
      }
    } catch {
      // Fall through cleanly to post-NSAL built-in SDK mappings
    }

    return resolvePostNsalFallbackRelyingPartyForUrl(targetUrl) || XSTS_RELYING_PARTIES.XBOX_LIVE;
  };

  /**
   * Mints the matching Relying Party `XBL3.0 x=<uhs>;<jwt>` token AND computes the 76-byte
   * IEEE P1363 `Signature` header for an arbitrary outbound HTTP request.
   * Used directly by `xboxRuntimeLoopbackServer.cjs` (`XUserGetTokenAndSignatureUtf16Async`).
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
      throw new Error('getTokenAndSignatureForUrl requires a valid target url');
    }

    const effectiveBody = bodyBuffer !== undefined ? bodyBuffer : params.body;
    const proof = ensureProofKeyRecord();
    const baseSession = await getValidXboxSession({ forceRefresh, signal });

    let isTitleStorageHost = false;
    try {
      const parsedHost = new URL(url).hostname.toLowerCase();
      isTitleStorageHost =
        parsedHost === 'titlestorage.xboxlive.com' ||
        parsedHost.endsWith('.titlestorage.xboxlive.com');
    } catch {}

    let targetRp;
    let xstsResult;

    if (isTitleStorageHost) {
      // `titlestorage.xboxlive.com` ConnectedStorage lock/write requires XSTS with `UserTokens`
      // + hardware-trusted Win32 `RPS` `DeviceToken` + `ProofKey` (and NO PoP `TitleToken`)!
      targetRp = relyingPartyOverride || XSTS_RELYING_PARTIES.XBOX_LIVE;
      const rpsDeviceToken = await getXblDeviceToken({ mode: 'rps', forceRefresh, signal }).catch(
        () => null
      );
      xstsResult = await getXstsToken(targetRp, {
        forceRefresh,
        deviceToken: rpsDeviceToken || undefined,
        signal,
      });
    } else {
      // Step 1: Acquire hardware-bound `TitleToken` FIRST so Per-Title NSAL (`titles/current/endpoints`)
      // and 3rd-party Relying Party XSTS tokens carry the authentic game `tid` claim!
      let titleSession = null;
      if (msaAppId) {
        try {
          titleSession = await getTitleAuthSession({ msaAppId, titleId, forceRefresh, signal });
        } catch {
          // Fallback cleanly to user/device XSTS if title does not require or have TitleToken
        }
      }

      const decimalTitleId = titleSession?.titleId || normalizeDecimalTitleId(titleId);

      // Step 2: Resolve Relying Party via signed Per-Title NSAL -> Default NSAL -> SDK fallbacks
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

      // Step 3: Mint XSTS token for `targetRp`
      if (
        titleSession?.xblTitleXsts &&
        targetRp === XSTS_RELYING_PARTIES.XBOX_LIVE
      ) {
        xstsResult = titleSession.xblTitleXsts;
      } else if (titleSession?.titleToken) {
        try {
          xstsResult = await getXstsToken(targetRp, {
            forceRefresh,
            userTokenOverride: titleSession.userToken || undefined,
            deviceToken: titleSession.deviceToken || undefined,
            titleToken: titleSession.titleToken,
            signal,
          });
        } catch {
          // Graceful fallback if a specific 3rd-party Relying Party rejects TitleToken or DeviceToken
          try {
            xstsResult = await getXstsToken(targetRp, {
              forceRefresh,
              deviceToken: titleSession.deviceToken || undefined,
              signal,
            });
          } catch {
            xstsResult = await getXstsToken(targetRp, { forceRefresh, signal });
          }
        }
      } else {
        let rpsDeviceToken = null;
        if (targetRp === XSTS_RELYING_PARTIES.XBOX_LIVE) {
          const savedVault = loadXboxVaultRecord();
          if (
            xblDeviceTokenCache.has('rps') ||
            savedVault?.deviceContext?.deviceToken ||
            savedVault?.deviceContext?.deviceMembername ||
            savedVault?.userStsLegacyTokenXml
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
        });
      }
    }

    const authorizationHeader = xstsResult.authorizationHeader;
    const signature = signXboxRequest({
      method,
      url,
      authorizationHeader,
      bodyBuffer: effectiveBody,
      ecPrivateKey: proof.privateKeyPem,
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
   * Verifies *Minecraft: Java Edition* ownership via `rp://api.minecraftservices.com/` ->
   * `login_with_xbox` -> `entitlements/mcstore`, caching responses for 30 minutes keyed by
   * SHA-256 of the account/token identity.
   */
  const checkMinecraftJavaEntitlement = async (options = {}) => {
    try {
      const forceRefresh = Boolean(options.forceRefresh);
      const mcXsts = await getXstsToken(XSTS_RELYING_PARTIES.MINECRAFT, {
        forceRefresh,
        signal: options.signal,
      });

      const saved = loadXboxVaultRecord();
      const identityMaterial = `${lockScopeKey}:${saved.xuid || mcXsts.xuid || ''}:${mcXsts.uhs || ''}:${mcXsts.token || ''}`;
      const sha256Key = crypto.createHash('sha256').update(identityMaterial).digest('hex');

      if (!forceRefresh) {
        const cached = globalMinecraftEntitlementCache.get(sha256Key);
        if (cached && Date.now() - cached.cachedAt < MINECRAFT_ENTITLEMENT_CACHE_TTL_MS) {
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
        signal: buildXboxFetchSignal(options.signal),
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
        signal: buildXboxFetchSignal(options.signal),
      });

      if (!entRes.ok) {
        return { owned: false, reason: `mcstore_${entRes.status}` };
      }

      const entJson = await entRes.json();
      const items = Array.isArray(entJson?.items) ? entJson.items : [];
      const owned = items.some((item) => {
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
            signal: buildXboxFetchSignal(options.signal),
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

      if (globalMinecraftEntitlementCache.size >= 128) {
        const oldest = globalMinecraftEntitlementCache.keys().next().value;
        if (oldest !== undefined) globalMinecraftEntitlementCache.delete(oldest);
      }
      globalMinecraftEntitlementCache.set(sha256Key, {
        cachedAt: Date.now(),
        result,
      });

      return result;
    } catch (err) {
      return {
        owned: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  };

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
    buildRpXstsCacheKey,
    invalidateRpXstsCache,
    exchangeAuthCode,
    exchangeTokenBrokerDaProperty,
    getValidXboxSession,
    getStoreMsaToken,
    getXstsToken,
    getXblDeviceToken,
    getSisuTitleSession,
    getTitleAuthSession,
    getTokenAndSignatureForUrl,
    checkMinecraftJavaEntitlement,
    ensureDeviceContext,
  };
}

module.exports = {
  XBOX_LIVESDK_CLIENT_ID,
  XBOX_TOKEN_BROKER_CLIENT_ID,
  XBOX_TOKEN_BROKER_SCOPE,
  XBOX_OAUTH_REDIRECT_URI,
  MSA_INLINE_LOGIN_URL,
  CXH_USER_AGENT,
  TRUSTED_XBOX_AUTH_HOSTS,
  SCOPE_XBL_MBI_SSL,
  SCOPE_MSSTORE_MBI_SSL,
  XSTS_RELYING_PARTIES,
  MINECRAFT_ENTITLEMENT_CACHE_TTL_MS,
  buildRpXstsCacheKey,
  generateXboxOAuthState,
  verifyXboxOAuthState,
  isCompactJwe,
  normalizeDecimalTitleId,
  normalizeStoreMsaTicket,
  normalizeXblRpsTicket,
  formatStoreAuthTickets,
  generateXboxProofKeyPair,
  exportProofKeyJwkFromPrivateKey,
  deriveDashedUuidFromSeed,
  buildXboxSignaturePayload,
  signXboxRequest,
  verifyXboxRequestSignature,
  mapXboxXstsError,
  resolvePreNsalBuiltInRelyingPartyForUrl,
  resolvePostNsalFallbackRelyingPartyForUrl,
  resolveBuiltInRelyingPartyForUrl,
  matchDynamicTitleEndpointRelyingParty,
  extractAuthCodeFromInput,
  buildXboxAuthorizationUrl,
  isTrustedXboxAuthUrl,
  buildInlineLoginRequest,
  createXboxAuthProvider,
};
