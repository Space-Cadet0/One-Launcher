// @ts-check
'use strict';

/**
 * Xbox Ephemeral ECDSA P-256 ProofKey & IEEE P1363 76-Byte Request Signer (`xboxProofKeyAndSigning.cjs`):
 * - SHA-256 keyed bounded LRU EC private key object cache (zero plaintext PEM strings stored as Map keys)
 * - Ephemeral `prime256v1` ProofKey generation & JWK export
 * - Deterministic RFC 4122 v4 UUID derivation from hardware/device seed
 * - Xbox Live 14-byte prefix + 76-byte IEEE P1363 `Signature` generation and verification
 */

const crypto = require('node:crypto');

const MAX_PARSED_EC_PRIVATE_KEYS = 32;
/** @type {Map<string, crypto.KeyObject>} */
const parsedEcPrivateKeyCache = new Map();

/**
 * Computes a SHA-256 hex digest of a PEM string/Buffer so plaintext private key material is never
 * retained as a Map key.
 *
 * @param {string | Buffer} pemOrBuf
 * @returns {string}
 */
function hashEcPrivateKeyPem(pemOrBuf) {
  const hash = crypto.createHash('sha256');
  if (Buffer.isBuffer(pemOrBuf)) {
    hash.update(pemOrBuf);
  } else {
    hash.update(String(pemOrBuf), 'utf8');
  }
  return hash.digest('hex');
}

/**
 * @param {string | Buffer} pemOrBuf
 * @param {crypto.KeyObject} keyObj
 */
function cacheEcPrivateKeyObject(pemOrBuf, keyObj) {
  const cacheKey = hashEcPrivateKeyPem(pemOrBuf);
  if (parsedEcPrivateKeyCache.has(cacheKey)) {
    parsedEcPrivateKeyCache.delete(cacheKey);
  } else if (parsedEcPrivateKeyCache.size >= MAX_PARSED_EC_PRIVATE_KEYS) {
    const oldest = parsedEcPrivateKeyCache.keys().next().value;
    if (oldest !== undefined) parsedEcPrivateKeyCache.delete(oldest);
  }
  parsedEcPrivateKeyCache.set(cacheKey, keyObj);
}

/**
 * Evicts a specific private key PEM from the parsed key cache (e.g., on logout or provider dispose).
 *
 * @param {string | Buffer | null | undefined} pemOrBuf
 */
function evictCachedEcPrivateKey(pemOrBuf) {
  if (!pemOrBuf) return;
  parsedEcPrivateKeyCache.delete(hashEcPrivateKeyPem(pemOrBuf));
}

/**
 * @param {string | Buffer | crypto.KeyObject} ecPrivateKey
 * @returns {crypto.KeyObject}
 */
function getCachedEcPrivateKeyObject(ecPrivateKey) {
  if (!ecPrivateKey) {
    throw new Error('signXboxRequest requires ecPrivateKey');
  }
  if (typeof ecPrivateKey === 'object' && !Buffer.isBuffer(ecPrivateKey)) {
    return ecPrivateKey;
  }
  const cacheKey = hashEcPrivateKeyPem(ecPrivateKey);
  const hit = parsedEcPrivateKeyCache.get(cacheKey);
  if (hit) {
    parsedEcPrivateKeyCache.delete(cacheKey);
    parsedEcPrivateKeyCache.set(cacheKey, hit);
    return hit;
  }
  const parsed = crypto.createPrivateKey(ecPrivateKey);
  cacheEcPrivateKeyObject(ecPrivateKey, parsed);
  return parsed;
}

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

/**
 * @param {string | Buffer | crypto.KeyObject} ecPrivateKey
 */
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

/**
 * @param {string | undefined} pathAndQuery
 * @param {string | undefined} url
 * @returns {string}
 */
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

  const keyObj = getCachedEcPrivateKeyObject(ecPrivateKey);

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
 *
 * @param {Record<string, any>} params
 * @returns {boolean}
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

module.exports = {
  MAX_PARSED_EC_PRIVATE_KEYS,
  parsedEcPrivateKeyCache,
  hashEcPrivateKeyPem,
  cacheEcPrivateKeyObject,
  evictCachedEcPrivateKey,
  getCachedEcPrivateKeyObject,
  generateXboxProofKeyPair,
  exportProofKeyJwkFromPrivateKey,
  resolvePathAndQuery,
  deriveDashedUuidFromSeed,
  buildXboxSignaturePayload,
  signXboxRequest,
  verifyXboxRequestSignature,
};
