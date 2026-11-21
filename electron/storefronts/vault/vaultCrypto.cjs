// @ts-check
'use strict';

const crypto = require('node:crypto');
const {
  LEGACY_AES256GCM_TOKEN_PREFIX,
  getMachineIdentityKeyMaterial,
  getMachineIdentityKeyMaterialAsync,
  getOrCreateVaultSecret,
  getOrCreateVaultSecretAsync,
  deriveVaultKeySync,
  deriveVaultKeyAsync,
  normalizeSaltBuffer,
} = require('./vaultKeyMaterial.cjs');

/** NIST SP 800-38D standard 96-bit GCM IV length */
const AES_GCM_IV_BYTES = 12;
/** Full 128-bit GCM authentication tag length (reject truncated tags fail-closed, P0-05) */
const AES_GCM_AUTH_TAG_BYTES = 16;
/** Minimum scrypt salt length in bytes */
const MIN_VAULT_SALT_BYTES = 16;

/**
 * @param {string} jsonStr
 * @param {Buffer} key
 * @param {Buffer} salt
 * @returns {Record<string, any>}
 */
function sealAesGcmVaultEnvelope(jsonStr, key, salt) {
  if (!Buffer.isBuffer(key) || key.length !== 32) {
    throw new Error('Invalid AES-256-GCM key length');
  }
  if (!Buffer.isBuffer(salt) || salt.length < MIN_VAULT_SALT_BYTES) {
    throw new Error('Invalid vault KDF salt length');
  }
  const iv = crypto.randomBytes(AES_GCM_IV_BYTES);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv, {
    authTagLength: AES_GCM_AUTH_TAG_BYTES,
  });
  const encrypted = Buffer.concat([cipher.update(jsonStr, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  if (tag.length !== AES_GCM_AUTH_TAG_BYTES) {
    throw new Error('Unexpected AES-256-GCM authentication tag length');
  }
  return {
    _encrypted_v2: true,
    _encrypted_v3: true,
    alg: 'aes-256-gcm',
    salt: salt.toString('base64'),
    iv: iv.toString('base64'),
    tag: tag.toString('base64'),
    data: encrypted.toString('base64'),
  };
}

/**
 * Encrypt JSON string with AES-256-GCM bound to both hardware identity and per-user `vault.key`.
 *
 * @param {string} jsonStr
 * @param {Record<string, any>} [options]
 * @returns {Record<string, any>}
 */
function encryptTokensPayload(jsonStr, options = {}) {
  const salt = normalizeSaltBuffer(options?.salt) || crypto.randomBytes(MIN_VAULT_SALT_BYTES);
  const vaultSecret = getOrCreateVaultSecret(options, true);
  if (!vaultSecret) {
    throw new Error('Unable to initialize per-user vault secret');
  }
  const keyMaterial = `${getMachineIdentityKeyMaterial(options)}:${vaultSecret}`;
  const key = deriveVaultKeySync(keyMaterial, salt);
  return sealAesGcmVaultEnvelope(jsonStr, key, salt);
}

/**
 * Non-blocking async AES-256-GCM payload encryption using `util.promisify(crypto.scrypt)`.
 *
 * @param {string} jsonStr
 * @param {Record<string, any>} [options]
 * @returns {Promise<Record<string, any>>}
 */
async function encryptTokensPayloadAsync(jsonStr, options = {}) {
  const salt = normalizeSaltBuffer(options?.salt) || crypto.randomBytes(MIN_VAULT_SALT_BYTES);
  const [hwIdentity, vaultSecret] = await Promise.all([
    getMachineIdentityKeyMaterialAsync(options),
    getOrCreateVaultSecretAsync(options, true),
  ]);
  if (!vaultSecret) {
    throw new Error('Unable to initialize per-user vault secret');
  }
  const keyMaterial = `${hwIdentity}:${vaultSecret}`;
  const key = await deriveVaultKeyAsync(keyMaterial, salt);
  return sealAesGcmVaultEnvelope(jsonStr, key, salt);
}

/**
 * Decode and strictly validate encrypted vault envelope parameters (P0-05):
 * enforces `salt.length >= 16`, NIST SP 800-38D `iv.length === 12`, and `tag.length === 16`.
 *
 * @param {Record<string, any>} payload
 * @returns {{ salt: Buffer, iv: Buffer, tag: Buffer, data: Buffer }}
 */
function parseEncryptedEnvelopeBuffers(payload) {
  if (
    !payload ||
    payload._encrypted_v2 !== true ||
    typeof payload.salt !== 'string' ||
    typeof payload.iv !== 'string' ||
    typeof payload.tag !== 'string' ||
    typeof payload.data !== 'string'
  ) {
    throw new Error('Invalid encrypted token payload');
  }
  if (payload.alg !== undefined && String(payload.alg).toLowerCase() !== 'aes-256-gcm') {
    throw new Error(`Unsupported vault encryption algorithm: ${String(payload.alg)}`);
  }

  const salt = Buffer.from(payload.salt, 'base64');
  const iv = Buffer.from(payload.iv, 'base64');
  const tag = Buffer.from(payload.tag, 'base64');
  const data = Buffer.from(payload.data, 'base64');

  if (salt.length < MIN_VAULT_SALT_BYTES) {
    throw new Error(`Invalid vault KDF salt length: ${salt.length}`);
  }
  if (iv.length !== AES_GCM_IV_BYTES) {
    throw new Error(
      `Invalid AES-256-GCM IV length: expected ${AES_GCM_IV_BYTES} bytes, got ${iv.length}`
    );
  }
  if (tag.length !== AES_GCM_AUTH_TAG_BYTES) {
    throw new Error(
      `Invalid AES-256-GCM auth tag length: expected ${AES_GCM_AUTH_TAG_BYTES} bytes, got ${tag.length}`
    );
  }

  return { salt, iv, tag, data };
}

/**
 * Authenticate and decrypt an AES-256-GCM vault envelope with explicit 12-byte IV and
 * `{ authTagLength: 16 }` enforcement (CWE-347 / P0-05 fail-closed).
 *
 * @param {Buffer} key
 * @param {{ iv: Buffer, tag: Buffer, data: Buffer }} parts
 * @returns {Record<string, any>}
 */
function openAesGcmVaultEnvelope(key, parts) {
  if (!Buffer.isBuffer(key) || key.length !== 32) {
    throw new Error('Invalid AES-256-GCM decryption key length');
  }
  if (!parts || !Buffer.isBuffer(parts.iv) || parts.iv.length !== AES_GCM_IV_BYTES) {
    throw new Error(
      `Invalid AES-256-GCM IV length: expected ${AES_GCM_IV_BYTES} bytes, got ${parts?.iv?.length ?? 0}`
    );
  }
  if (!Buffer.isBuffer(parts.tag) || parts.tag.length !== AES_GCM_AUTH_TAG_BYTES) {
    throw new Error(
      `Invalid AES-256-GCM auth tag length: expected ${AES_GCM_AUTH_TAG_BYTES} bytes, got ${parts?.tag?.length ?? 0}`
    );
  }
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, parts.iv, {
    authTagLength: AES_GCM_AUTH_TAG_BYTES,
  });
  decipher.setAuthTag(parts.tag);
  const decrypted = Buffer.concat([decipher.update(parts.data), decipher.final()]).toString('utf8');
  return JSON.parse(decrypted);
}

/**
 * Decrypt AES-256-GCM vault payload (`_encrypted_v3` with `vault.key`, or legacy `_encrypted_v2`).
 *
 * @param {Record<string, any>} payload
 * @param {Record<string, any>} [options]
 * @returns {Record<string, any>}
 */
function decryptTokensPayload(payload, options = {}) {
  const parts = parseEncryptedEnvelopeBuffers(payload);
  let keyMaterial = getMachineIdentityKeyMaterial(options);
  if (payload._encrypted_v3 === true) {
    const vaultSecret = getOrCreateVaultSecret(options, false);
    if (!vaultSecret) {
      throw new Error('Missing vault.key required to decrypt v3 token vault');
    }
    keyMaterial = `${keyMaterial}:${vaultSecret}`;
  }

  const key = deriveVaultKeySync(keyMaterial, parts.salt);
  return openAesGcmVaultEnvelope(key, parts);
}

/**
 * Non-blocking async AES-256-GCM payload decryption using `util.promisify(crypto.scrypt)`.
 *
 * @param {Record<string, any>} payload
 * @param {Record<string, any>} [options]
 * @returns {Promise<Record<string, any>>}
 */
async function decryptTokensPayloadAsync(payload, options = {}) {
  const parts = parseEncryptedEnvelopeBuffers(payload);
  let keyMaterial = await getMachineIdentityKeyMaterialAsync(options);
  if (payload._encrypted_v3 === true) {
    const vaultSecret = await getOrCreateVaultSecretAsync(options, false);
    if (!vaultSecret) {
      throw new Error('Missing vault.key required to decrypt v3 token vault');
    }
    keyMaterial = `${keyMaterial}:${vaultSecret}`;
  }

  const key = await deriveVaultKeyAsync(keyMaterial, parts.salt);
  return openAesGcmVaultEnvelope(key, parts);
}

/**
 * @param {string} str
 * @returns {Buffer}
 */
function decodeHexOrBase64Part(str) {
  const trimmed = String(str || '').trim();
  if (/^[0-9a-f]+$/i.test(trimmed) && (trimmed.length === 24 || trimmed.length === 32)) {
    return Buffer.from(trimmed, 'hex');
  }
  return Buffer.from(trimmed, 'base64');
}

/**
 * Parses and decrypts legacy `v1:aes256gcm:<salt>:<iv>:<tag>:<ciphertext>` string token payloads
 * with strict 12-byte IV + 16-byte authTag validation.
 *
 * @param {string} legacyStr
 * @param {Record<string, any>} [options]
 * @returns {any}
 */
function decryptLegacyV1StringSync(legacyStr, options = {}) {
  const body = legacyStr.slice(LEGACY_AES256GCM_TOKEN_PREFIX.length);
  const segs = body.split(':');
  if (segs.length !== 4) {
    throw new Error('Malformed legacy v1:aes256gcm payload');
  }
  const salt = decodeHexOrBase64Part(segs[0]);
  const iv = decodeHexOrBase64Part(segs[1]);
  const tag = decodeHexOrBase64Part(segs[2]);
  const data = Buffer.from(segs[3], 'base64');
  if (salt.length < MIN_VAULT_SALT_BYTES || iv.length !== AES_GCM_IV_BYTES || tag.length !== AES_GCM_AUTH_TAG_BYTES) {
    throw new Error('Invalid legacy v1:aes256gcm envelope lengths');
  }

  const hwIdentity = getMachineIdentityKeyMaterial(options);
  const vaultSecret = getOrCreateVaultSecret(options, false);
  const candidates = vaultSecret ? [`${hwIdentity}:${vaultSecret}`, hwIdentity] : [hwIdentity];
  let lastErr = null;
  for (const km of candidates) {
    try {
      const key = deriveVaultKeySync(km, salt);
      return openAesGcmVaultEnvelope(key, { iv, tag, data });
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr || new Error('Failed to decrypt legacy v1:aes256gcm payload');
}

/**
 * Async counterpart to `decryptLegacyV1StringSync`.
 *
 * @param {string} legacyStr
 * @param {Record<string, any>} [options]
 * @returns {Promise<any>}
 */
async function decryptLegacyV1StringAsync(legacyStr, options = {}) {
  const body = legacyStr.slice(LEGACY_AES256GCM_TOKEN_PREFIX.length);
  const segs = body.split(':');
  if (segs.length !== 4) {
    throw new Error('Malformed legacy v1:aes256gcm payload');
  }
  const salt = decodeHexOrBase64Part(segs[0]);
  const iv = decodeHexOrBase64Part(segs[1]);
  const tag = decodeHexOrBase64Part(segs[2]);
  const data = Buffer.from(segs[3], 'base64');
  if (salt.length < MIN_VAULT_SALT_BYTES || iv.length !== AES_GCM_IV_BYTES || tag.length !== AES_GCM_AUTH_TAG_BYTES) {
    throw new Error('Invalid legacy v1:aes256gcm envelope lengths');
  }

  const [hwIdentity, vaultSecret] = await Promise.all([
    getMachineIdentityKeyMaterialAsync(options),
    getOrCreateVaultSecretAsync(options, false),
  ]);
  const candidates = vaultSecret ? [`${hwIdentity}:${vaultSecret}`, hwIdentity] : [hwIdentity];
  let lastErr = null;
  for (const km of candidates) {
    try {
      const key = await deriveVaultKeyAsync(km, salt);
      return openAesGcmVaultEnvelope(key, { iv, tag, data });
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr || new Error('Failed to decrypt legacy v1:aes256gcm payload');
}

/**
 * Generic structural check for corrupted or placeholder-serialized token strings.
 *
 * @param {unknown} tokenStr
 * @returns {boolean}
 */
function isMockOrCorruptedToken(tokenStr) {
  if (tokenStr === null || tokenStr === undefined) return false;
  if (typeof tokenStr !== 'string') return false;
  const trimmed = tokenStr.trim();
  if (!trimmed) return true;
  if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(trimmed)) return true;
  if (/^(?:undefined|null|nan|\[object\s+object\])$/i.test(trimmed)) return true;
  if (/^(?:mock|fake|dummy|test)[-_]/i.test(trimmed)) return true;
  if (/^(?:epic|gog|xbox|steam)-rotated(?:-|$)/i.test(trimmed)) return true;
  if (/-(?:rotated)-(?:access|refresh)-token$/i.test(trimmed)) return true;
  if (/^freshly-renewed-(?:access-|refresh-)?token$/i.test(trimmed)) return true;
  return false;
}

/**
 * Generic structural sanitization of persisted storefront credential objects.
 *
 * @param {Record<string, any>} tokensObj
 * @param {Record<string, any>} [options]
 * @returns {{ cleaned: Record<string, any>, modified: boolean }}
 */
function sanitizeStorefrontTokensObject(tokensObj, options = {}) {
  if (!tokensObj || typeof tokensObj !== 'object') {
    return { cleaned: {}, modified: false };
  }
  const shouldSanitize =
    options?.sanitizeMockTokens === true ||
    !(process.env.VITEST || process.env.NODE_ENV === 'test');
  if (!shouldSanitize) {
    return { cleaned: tokensObj, modified: false };
  }

  let modified = false;
  /** @type {Record<string, any>} */
  const cleaned = { ...tokensObj };

  for (const [storeKey, storeVal] of Object.entries(cleaned)) {
    if (!storeVal || typeof storeVal !== 'object') continue;
    const copy = { ...storeVal };
    let entryModified = false;

    if (copy.access_token !== undefined && isMockOrCorruptedToken(copy.access_token)) {
      delete copy.access_token;
      entryModified = true;
    }
    if (copy.refresh_token !== undefined && isMockOrCorruptedToken(copy.refresh_token)) {
      delete copy.refresh_token;
      entryModified = true;
    }
    if (
      storeKey === 'epic' &&
      copy.account_id !== undefined &&
      !/^[0-9a-f]{32}$/i.test(String(copy.account_id).trim()) &&
      typeof copy.in_app_id === 'string' &&
      /^[0-9a-f]{32}$/i.test(copy.in_app_id.trim())
    ) {
      copy.account_id = copy.in_app_id.trim();
      entryModified = true;
    }
    if (
      storeKey === 'gog' &&
      copy.user_id !== undefined &&
      !/^\d+$/.test(String(copy.user_id).trim())
    ) {
      delete copy.user_id;
      entryModified = true;
    }
    if (storeKey === 'xbox') {
      for (const secretField of [
        'xblAccessToken',
        'msaRefreshToken',
        'userStsLegacyTokenXml',
        'storeTicket',
        'xblUserToken',
        'xstsXboxLiveToken',
        'xstsMpToken',
      ]) {
        if (copy[secretField] !== undefined && isMockOrCorruptedToken(copy[secretField])) {
          delete copy[secretField];
          entryModified = true;
        }
      }
    }

    if (entryModified) {
      cleaned[storeKey] = copy;
      modified = true;
    }
  }

  return { cleaned, modified };
}

/**
 * Produces a safe, redacted Xbox account & subscription summary for renderer IPC
 * without leaking raw MSA, XSTS, ProofKey, or Clep `DeviceKey` secrets.
 *
 * @param {Record<string, any> | null | undefined} xboxEntry
 * @returns {Record<string, any> | undefined}
 */
function projectRedactedXboxSummary(xboxEntry) {
  if (!xboxEntry || typeof xboxEntry !== 'object') return undefined;
  const connected = Boolean(
    xboxEntry.msaRefreshToken ||
      xboxEntry.userStsLegacyTokenXml ||
      xboxEntry.msa?.refreshToken ||
      xboxEntry.refresh_token ||
      xboxEntry.xstsXboxLiveToken ||
      xboxEntry.xblAccessToken ||
      xboxEntry.access_token
  );
  if (!connected) return undefined;

  const gamertag =
    xboxEntry.gamertag || xboxEntry.modernGamertag || xboxEntry.accountName || 'Xbox Player';
  return {
    connected: true,
    accountName: gamertag,
    gamertag,
    modernGamertag: xboxEntry.modernGamertag || gamertag,
    xuid: xboxEntry.xuid || undefined,
    avatarUrl: xboxEntry.gamerpicUrl || xboxEntry.avatarUrl || undefined,
    gamerpicUrl: xboxEntry.gamerpicUrl || xboxEntry.avatarUrl || undefined,
    gamerscore: Number(xboxEntry.gamerscore || 0) || 0,
    subscription: xboxEntry.subscription || undefined,
    syncMode: xboxEntry.syncMode || 'owned_and_played',
    hasDeviceContext: Boolean(xboxEntry.deviceContext?.deviceKeyHex),
    xboxProfileMissing: Boolean(xboxEntry.xboxProfileMissing),
    updatedAt: xboxEntry.updatedAt || undefined,
  };
}

module.exports = {
  AES_GCM_IV_BYTES,
  AES_GCM_AUTH_TAG_BYTES,
  MIN_VAULT_SALT_BYTES,
  sealAesGcmVaultEnvelope,
  parseEncryptedEnvelopeBuffers,
  openAesGcmVaultEnvelope,
  encryptTokensPayload,
  encryptTokensPayloadAsync,
  decryptTokensPayload,
  decryptTokensPayloadAsync,
  decryptLegacyV1StringSync,
  decryptLegacyV1StringAsync,
  isMockOrCorruptedToken,
  sanitizeStorefrontTokensObject,
  projectRedactedXboxSummary,
};
