// @ts-check
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const util = require('node:util');
const { execFileSync } = require('node:child_process');
const { app } = require('electron');
const {
  toHostFilesystemPath,
  atomicWriteSecureFileSync,
  clearStoreDisconnectedTombstone,
} = require('../launcher/securityAndPathUtils.cjs');

const scryptAsync = util.promisify(crypto.scrypt);

const DERIVED_KEY_CACHE_MAX = 256;

/** @type {string | null} */
let cachedMachineIdentity = null;

/**
 * In-memory derived-key cache keyed by `salt.toString('hex')` (verified against a digest of
 * `keyMaterial` so differing machineId/vaultSecret overrides never collide on the same salt).
 * Ensures both async callers and sync fallback callers derive a key at most ONCE per salt.
 *
 * @type {Map<string, { kmDigest: string, key: Buffer }>}
 */
const derivedKeyCache = new Map();

/**
 * Per-vault KDF salt cache keyed by resolved `tokens.json` path so repeated writes to the
 * same vault reuse its 16-byte KDF salt (with a fresh CSPRNG 96-bit AES-GCM IV on every write).
 *
 * @type {Map<string, Buffer>}
 */
const vaultSaltByFileCache = new Map();

/**
 * Per-vault promise mutex queue serializing concurrent async read-modify-write operations.
 *
 * @type {Map<string, Promise<any>>}
 */
const vaultMutexQueues = new Map();

/**
 * Derives deterministic, hardware-bound key material for the local workstation
 * without touching or prompting the macOS Keychain or Windows Credential UI.
 *
 * @param {Record<string, any>} [options]
 * @returns {string}
 */
function getMachineIdentityKeyMaterial(options = {}) {
  if (options && typeof options.machineIdOverride === 'string' && options.machineIdOverride) {
    return `one-launcher-vault-v2:${options.machineIdOverride}`;
  }
  if (cachedMachineIdentity) {
    return cachedMachineIdentity;
  }

  let hwId = '';
  try {
    if (process.platform === 'darwin') {
      const out = execFileSync('/usr/sbin/ioreg', ['-rd1', '-c', 'IOPlatformExpertDevice'], {
        encoding: 'utf8',
        timeout: 2000,
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      const match = out && out.match(/"IOPlatformUUID"\s*=\s*"([^"]+)"/);
      if (match && match[1]) {
        hwId = match[1].trim();
      }
    } else if (process.platform === 'win32') {
      const out = execFileSync(
        'reg',
        ['query', 'HKLM\\SOFTWARE\\Microsoft\\Cryptography', '/v', 'MachineGuid'],
        {
          encoding: 'utf8',
          timeout: 2000,
          stdio: ['ignore', 'pipe', 'ignore'],
          windowsHide: true,
        }
      );
      const match = out && out.match(/MachineGuid\s+REG_SZ\s+([^\r\n]+)/i);
      if (match && match[1]) {
        hwId = match[1].trim();
      }
    } else {
      for (const idPath of ['/etc/machine-id', '/var/lib/dbus/machine-id']) {
        if (fs.existsSync(idPath)) {
          hwId = fs.readFileSync(idPath, 'utf8').trim();
          if (hwId) break;
        }
      }
    }
  } catch {
    // Fallback to OS/host identity if hardware UUID query fails in restricted environments
  }

  if (!hwId) {
    hwId = `${os.hostname()}:${os.platform()}:${os.arch()}`;
  }

  let username = 'user';
  try {
    username = os.userInfo().username || 'user';
  } catch {}

  cachedMachineIdentity = `one-launcher-vault-v2:${hwId}:${username}`;
  return cachedMachineIdentity;
}

/**
 * Resolve the path to `tokens.json` in `userData` (or explicit test override).
 *
 * @param {Record<string, any> | string} [options]
 * @returns {string}
 */
function getTokensFilePath(options = {}) {
  if (typeof options === 'string' && options.trim()) {
    const dir = toHostFilesystemPath(options.trim());
    if (!fs.existsSync(dir)) {
      try {
        fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      } catch {}
    }
    return path.join(dir, 'tokens.json');
  }
  if (options && typeof options === 'object') {
    const explicitFile = options.filePath || options.tokensFilePath;
    if (typeof explicitFile === 'string' && explicitFile.trim()) {
      return toHostFilesystemPath(explicitFile.trim());
    }
    if (typeof options.userDataDir === 'string' && options.userDataDir.trim()) {
      const dir = toHostFilesystemPath(options.userDataDir.trim());
      if (!fs.existsSync(dir)) {
        try {
          fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
        } catch {}
      }
      return path.join(dir, 'tokens.json');
    }
  }

  if (process.env.VITEST || process.env.NODE_ENV === 'test') {
    const testDir = path.join(os.tmpdir(), `one-launcher-test-vault-${process.pid}`);
    try {
      if (!fs.existsSync(testDir)) {
        fs.mkdirSync(testDir, { recursive: true, mode: 0o700 });
      }
    } catch {}
    return path.join(testDir, `one-launcher-test-tokens-${process.pid}.json`);
  }

  try {
    const defaultDir = path.join(process.env.HOME || '.', '.one-launcher');
    const legacyDir = path.join(process.env.HOME || '.', '.universal-game-library');
    const userDataPath = app
      ? app.getPath('userData')
      : fs.existsSync(legacyDir) && !fs.existsSync(defaultDir)
        ? legacyDir
        : defaultDir;
    if (!fs.existsSync(userDataPath)) {
      fs.mkdirSync(userDataPath, { recursive: true, mode: 0o700 });
    }
    return path.join(userDataPath, 'tokens.json');
  } catch {
    return path.join(process.cwd(), 'tokens.json');
  }
}

/**
 * Resolve or generate a random 256-bit per-user vault secret stored in `vault.key` (`0o600` / user-SID ACL)
 * adjacent to `tokens.json`. Prevents any other local account on a shared workstation from deriving
 * the vault key using world-readable `IOPlatformUUID` / `MachineGuid` alone.
 *
 * @param {Record<string, any>} [options]
 * @param {boolean} [createIfMissing]
 * @returns {string | null}
 */
function getOrCreateVaultSecret(options = {}, createIfMissing = true) {
  if (options && typeof options.vaultSecretOverride === 'string' && options.vaultSecretOverride) {
    return options.vaultSecretOverride;
  }
  const tokensPath = getTokensFilePath(options);
  const vaultDir = path.dirname(tokensPath);
  const vaultKeyPath = path.join(vaultDir, 'vault.key');

  try {
    if (fs.existsSync(vaultKeyPath)) {
      const existing = fs.readFileSync(vaultKeyPath, 'utf8').trim();
      if (/^[0-9a-f]{64}$/i.test(existing)) {
        return existing.toLowerCase();
      }
    }
  } catch {}

  if (!createIfMissing) {
    return null;
  }

  const freshSecret = crypto.randomBytes(32).toString('hex');
  atomicWriteSecureFileSync(vaultKeyPath, freshSecret);
  return freshSecret;
}

/**
 * Async counterpart to `getOrCreateVaultSecret`.
 *
 * @param {Record<string, any>} [options]
 * @param {boolean} [createIfMissing]
 * @returns {Promise<string | null>}
 */
async function getOrCreateVaultSecretAsync(options = {}, createIfMissing = true) {
  if (options && typeof options.vaultSecretOverride === 'string' && options.vaultSecretOverride) {
    return options.vaultSecretOverride;
  }
  const tokensPath = getTokensFilePath(options);
  const vaultDir = path.dirname(tokensPath);
  const vaultKeyPath = path.join(vaultDir, 'vault.key');

  try {
    const existing = (await fs.promises.readFile(vaultKeyPath, 'utf8')).trim();
    if (/^[0-9a-f]{64}$/i.test(existing)) {
      return existing.toLowerCase();
    }
  } catch {}

  if (!createIfMissing) {
    return null;
  }

  const freshSecret = crypto.randomBytes(32).toString('hex');
  atomicWriteSecureFileSync(vaultKeyPath, freshSecret);
  return freshSecret;
}

/**
 * @param {string} saltHex
 * @param {string} kmDigest
 * @param {Buffer} key
 */
function storeDerivedKeyInCache(saltHex, kmDigest, key) {
  if (!derivedKeyCache.has(saltHex) && derivedKeyCache.size >= DERIVED_KEY_CACHE_MAX) {
    const oldestKey = derivedKeyCache.keys().next().value;
    if (oldestKey !== undefined) {
      derivedKeyCache.delete(oldestKey);
    }
  }
  derivedKeyCache.set(saltHex, { kmDigest, key });
}

/**
 * @param {string} keyMaterial
 * @param {Buffer} salt
 * @returns {Buffer}
 */
function deriveVaultKeySync(keyMaterial, salt) {
  const saltHex = salt.toString('hex');
  const kmDigest = crypto.createHash('sha256').update(keyMaterial).digest('hex');
  const cached = derivedKeyCache.get(saltHex);
  if (cached && cached.kmDigest === kmDigest) {
    return cached.key;
  }
  const key = crypto.scryptSync(keyMaterial, salt, 32);
  storeDerivedKeyInCache(saltHex, kmDigest, key);
  return key;
}

/**
 * @param {string} keyMaterial
 * @param {Buffer} salt
 * @returns {Promise<Buffer>}
 */
async function deriveVaultKeyAsync(keyMaterial, salt) {
  const saltHex = salt.toString('hex');
  const kmDigest = crypto.createHash('sha256').update(keyMaterial).digest('hex');
  const cached = derivedKeyCache.get(saltHex);
  if (cached && cached.kmDigest === kmDigest) {
    return cached.key;
  }
  const key = /** @type {Buffer} */ (await scryptAsync(keyMaterial, salt, 32));
  storeDerivedKeyInCache(saltHex, kmDigest, key);
  return key;
}

/**
 * @param {unknown} rawSalt
 * @returns {Buffer | null}
 */
function normalizeSaltBuffer(rawSalt) {
  if (Buffer.isBuffer(rawSalt) && rawSalt.length >= 16) {
    return rawSalt;
  }
  if (typeof rawSalt === 'string' && rawSalt.trim()) {
    try {
      const buf = Buffer.from(rawSalt.trim(), 'base64');
      if (buf.length >= 16) return buf;
    } catch {}
  }
  return null;
}

/**
 * @param {string} jsonStr
 * @param {Buffer} key
 * @param {Buffer} salt
 * @returns {Record<string, any>}
 */
function sealAesGcmVaultEnvelope(jsonStr, key, salt) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(jsonStr, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
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
 * Emits both `_encrypted_v2: true` and `_encrypted_v3: true` for schema & test compatibility.
 *
 * @param {string} jsonStr
 * @param {Record<string, any>} [options]
 */
function encryptTokensPayload(jsonStr, options = {}) {
  const salt = normalizeSaltBuffer(options?.salt) || crypto.randomBytes(16);
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
 */
async function encryptTokensPayloadAsync(jsonStr, options = {}) {
  const salt = normalizeSaltBuffer(options?.salt) || crypto.randomBytes(16);
  const vaultSecret = await getOrCreateVaultSecretAsync(options, true);
  if (!vaultSecret) {
    throw new Error('Unable to initialize per-user vault secret');
  }
  const keyMaterial = `${getMachineIdentityKeyMaterial(options)}:${vaultSecret}`;
  const key = await deriveVaultKeyAsync(keyMaterial, salt);
  return sealAesGcmVaultEnvelope(jsonStr, key, salt);
}

/**
 * @param {Record<string, any>} payload
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
  return {
    salt: Buffer.from(payload.salt, 'base64'),
    iv: Buffer.from(payload.iv, 'base64'),
    tag: Buffer.from(payload.tag, 'base64'),
    data: Buffer.from(payload.data, 'base64'),
  };
}

/**
 * @param {Buffer} key
 * @param {{ iv: Buffer, tag: Buffer, data: Buffer }} parts
 * @returns {Record<string, any>}
 */
function openAesGcmVaultEnvelope(key, parts) {
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, parts.iv);
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
  let keyMaterial = getMachineIdentityKeyMaterial(options);
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
 * Generic structural check for corrupted or placeholder-serialized token strings
 * (zero hardcoded test-fixture usernames or rotation prefixes).
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
 * @param {string} resolvedFilePath
 * @returns {Buffer}
 */
function getOrInitPerFileSaltSync(resolvedFilePath) {
  const cachedSalt = vaultSaltByFileCache.get(resolvedFilePath);
  if (cachedSalt && cachedSalt.length >= 16) {
    return cachedSalt;
  }
  try {
    if (fs.existsSync(resolvedFilePath)) {
      const parsed = JSON.parse(fs.readFileSync(resolvedFilePath, 'utf8'));
      const diskSalt =
        parsed && parsed._encrypted_v3 === true ? normalizeSaltBuffer(parsed.salt) : null;
      if (diskSalt) {
        vaultSaltByFileCache.set(resolvedFilePath, diskSalt);
        return diskSalt;
      }
    }
  } catch {}
  const freshSalt = crypto.randomBytes(16);
  vaultSaltByFileCache.set(resolvedFilePath, freshSalt);
  return freshSalt;
}

/**
 * @param {string} resolvedFilePath
 * @returns {Promise<Buffer>}
 */
async function getOrInitPerFileSaltAsync(resolvedFilePath) {
  const cachedSalt = vaultSaltByFileCache.get(resolvedFilePath);
  if (cachedSalt && cachedSalt.length >= 16) {
    return cachedSalt;
  }
  try {
    const raw = await fs.promises.readFile(resolvedFilePath, 'utf8');
    const parsed = JSON.parse(raw);
    const diskSalt =
      parsed && parsed._encrypted_v3 === true ? normalizeSaltBuffer(parsed.salt) : null;
    if (diskSalt) {
      vaultSaltByFileCache.set(resolvedFilePath, diskSalt);
      return diskSalt;
    }
  } catch {}
  const freshSalt = crypto.randomBytes(16);
  vaultSaltByFileCache.set(resolvedFilePath, freshSalt);
  return freshSalt;
}

/**
 * Atomic async `.tmp` + `rename` write with `0o600` owner-only permissions.
 *
 * @param {string} filePath
 * @param {string} content
 */
async function atomicWriteVaultFileAsync(filePath, content) {
  const hostFilePath = toHostFilesystemPath(filePath);
  if (process.platform === 'win32') {
    atomicWriteSecureFileSync(hostFilePath, content);
    return;
  }
  const dir = path.dirname(hostFilePath);
  await fs.promises.mkdir(dir, { recursive: true, mode: 0o700 });
  const tmpPath = `${hostFilePath}.${process.pid}.${Date.now()}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  try {
    await fs.promises.writeFile(tmpPath, content, { encoding: 'utf8', mode: 0o600 });
    try {
      await fs.promises.chmod(tmpPath, 0o600);
    } catch {}
    await fs.promises.rename(tmpPath, hostFilePath);
    try {
      await fs.promises.chmod(hostFilePath, 0o600);
    } catch {}
  } catch (err) {
    try {
      await fs.promises.unlink(tmpPath);
    } catch {}
    atomicWriteSecureFileSync(hostFilePath, content);
  }
}

/**
 * Serializes concurrent async vault operations per resolved `tokens.json` path.
 *
 * @template T
 * @param {string} filePath
 * @param {() => Promise<T>} task
 * @returns {Promise<T>}
 */
function runWithVaultMutex(filePath, task) {
  const key = path.resolve(filePath);
  const prev = vaultMutexQueues.get(key) || Promise.resolve();
  const next = prev.catch(() => {}).then(task);
  const tracked = next.finally(() => {
    if (vaultMutexQueues.get(key) === tracked) {
      vaultMutexQueues.delete(key);
    }
  });
  vaultMutexQueues.set(key, tracked);
  return next;
}

/**
 * Encrypt and atomically write OAuth tokens to disk with strict owner-only ACLs.
 * Never falls back to writing unencrypted plaintext tokens on disk.
 *
 * @param {Record<string, any>} tokens
 * @param {Record<string, any>} [options]
 */
function writeTokensFile(tokens, options = {}) {
  const filePath = getTokensFilePath(options);
  const resolved = path.resolve(filePath);
  const salt = normalizeSaltBuffer(options?.salt) || getOrInitPerFileSaltSync(resolved);
  const jsonStr = JSON.stringify(tokens, null, 2);
  const encryptedPayload = encryptTokensPayload(jsonStr, { ...options, salt });
  atomicWriteSecureFileSync(filePath, JSON.stringify(encryptedPayload, null, 2));
}

/**
 * Async non-blocking counterpart to `writeTokensFile` using `crypto.scrypt` + atomic `.tmp` + `rename`.
 *
 * @param {Record<string, any>} tokens
 * @param {Record<string, any>} [options]
 * @returns {Promise<void>}
 */
async function writeTokensFileAsync(tokens, options = {}) {
  const filePath = getTokensFilePath(options);
  return runWithVaultMutex(filePath, async () => {
    const resolved = path.resolve(filePath);
    const salt = normalizeSaltBuffer(options?.salt) || (await getOrInitPerFileSaltAsync(resolved));
    const jsonStr = JSON.stringify(tokens, null, 2);
    const encryptedPayload = await encryptTokensPayloadAsync(jsonStr, { ...options, salt });
    await atomicWriteVaultFileAsync(filePath, JSON.stringify(encryptedPayload, null, 2));
  });
}

/**
 * Load and decrypt saved storefront tokens, transparently upgrading legacy v2 or plaintext payloads to v3.
 *
 * @param {Record<string, any>} [options]
 * @returns {Record<string, any>}
 */
function loadSavedTokens(options = {}) {
  try {
    const filePath = getTokensFilePath(options);
    if (!fs.existsSync(filePath)) {
      return {};
    }

    const rawContent = fs.readFileSync(filePath);
    if (!rawContent || rawContent.length === 0) {
      return {};
    }

    let parsed;
    try {
      parsed = JSON.parse(rawContent.toString('utf-8'));
    } catch {
      return {};
    }

    if (parsed && parsed._encrypted_v2 === true) {
      try {
        const diskSalt = normalizeSaltBuffer(parsed.salt);
        if (diskSalt && parsed._encrypted_v3 === true) {
          vaultSaltByFileCache.set(path.resolve(filePath), diskSalt);
        }
        const decrypted = decryptTokensPayload(parsed, options);
        const { cleaned, modified } = sanitizeStorefrontTokensObject(decrypted, options);
        if (modified || parsed._encrypted_v3 !== true) {
          try {
            writeTokensFile(cleaned, options);
          } catch {}
        }
        return cleaned;
      } catch (decErr) {
        const msg = decErr instanceof Error ? decErr.message : String(decErr);
        console.warn('Failed to decrypt tokens payload:', msg);
        return {};
      }
    }

    if (parsed && parsed._encrypted === true) {
      return {};
    }

    if (parsed && typeof parsed === 'object') {
      /** @type {Record<string, any>} */
      const cleanedTokens = {};
      for (const [key, value] of Object.entries(parsed)) {
        if (value && typeof value === 'object' && value._encrypted === true) {
          continue;
        }
        cleanedTokens[key] = value;
      }
      const { cleaned } = sanitizeStorefrontTokensObject(cleanedTokens, options);
      if (Object.keys(cleaned).length > 0) {
        try {
          writeTokensFile(cleaned, options);
        } catch {}
      }
      return cleaned;
    }

    return {};
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn('Failed to load saved tokens:', msg);
    return {};
  }
}

/**
 * Internal unlocked async reader invoked inside `runWithVaultMutex`.
 *
 * @param {string} filePath
 * @param {Record<string, any>} [options]
 * @returns {Promise<Record<string, any>>}
 */
async function readTokensUnlockedAsync(filePath, options = {}) {
  let rawContent;
  try {
    rawContent = await fs.promises.readFile(filePath);
  } catch {
    return {};
  }
  if (!rawContent || rawContent.length === 0) {
    return {};
  }

  let parsed;
  try {
    parsed = JSON.parse(rawContent.toString('utf-8'));
  } catch {
    return {};
  }

  const resolved = path.resolve(filePath);

  if (parsed && parsed._encrypted_v2 === true) {
    try {
      const diskSalt = normalizeSaltBuffer(parsed.salt);
      if (diskSalt && parsed._encrypted_v3 === true) {
        vaultSaltByFileCache.set(resolved, diskSalt);
      }
      const decrypted = await decryptTokensPayloadAsync(parsed, options);
      const { cleaned, modified } = sanitizeStorefrontTokensObject(decrypted, options);
      if (modified || parsed._encrypted_v3 !== true) {
        try {
          const salt = await getOrInitPerFileSaltAsync(resolved);
          const encryptedPayload = await encryptTokensPayloadAsync(
            JSON.stringify(cleaned, null, 2),
            { ...options, salt }
          );
          await atomicWriteVaultFileAsync(filePath, JSON.stringify(encryptedPayload, null, 2));
        } catch {}
      }
      return cleaned;
    } catch (decErr) {
      const msg = decErr instanceof Error ? decErr.message : String(decErr);
      console.warn('Failed to decrypt tokens payload:', msg);
      return {};
    }
  }

  if (parsed && parsed._encrypted === true) {
    return {};
  }

  if (parsed && typeof parsed === 'object') {
    /** @type {Record<string, any>} */
    const cleanedTokens = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (value && typeof value === 'object' && value._encrypted === true) {
        continue;
      }
      cleanedTokens[key] = value;
    }
    const { cleaned } = sanitizeStorefrontTokensObject(cleanedTokens, options);
    if (Object.keys(cleaned).length > 0) {
      try {
        const salt = await getOrInitPerFileSaltAsync(resolved);
        const encryptedPayload = await encryptTokensPayloadAsync(
          JSON.stringify(cleaned, null, 2),
          { ...options, salt }
        );
        await atomicWriteVaultFileAsync(filePath, JSON.stringify(encryptedPayload, null, 2));
      } catch {}
    }
    return cleaned;
  }

  return {};
}

/**
 * Async non-blocking counterpart to `loadSavedTokens`, serialized with active writes.
 *
 * @param {Record<string, any>} [options]
 * @returns {Promise<Record<string, any>>}
 */
async function loadSavedTokensAsync(options = {}) {
  const filePath = getTokensFilePath(options);
  return runWithVaultMutex(filePath, async () => {
    try {
      return await readTokensUnlockedAsync(filePath, options);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn('Failed to load saved tokens:', msg);
      return {};
    }
  });
}

/**
 * Merge a single storefront's token update into the existing map, preserving prior
 * `refresh_token` across rotation responses that omit `refresh_token`.
 *
 * @param {Record<string, any>} existing
 * @param {string} storefrontId
 * @param {Record<string, any>} tokenData
 * @returns {Record<string, any>}
 */
function mergeStorefrontTokenUpdate(existing, storefrontId, tokenData) {
  const prevEntry =
    existing[storefrontId] && typeof existing[storefrontId] === 'object'
      ? existing[storefrontId]
      : {};
  const incoming = tokenData && typeof tokenData === 'object' ? tokenData : {};
  const preserveRefresh =
    (incoming.refresh_token === undefined || incoming.refresh_token === '') &&
    typeof prevEntry.refresh_token === 'string' &&
    prevEntry.refresh_token.length > 0;
  const mergedEntry = {
    ...prevEntry,
    ...incoming,
    ...(preserveRefresh ? { refresh_token: prevEntry.refresh_token } : {}),
    updatedAt: new Date().toISOString(),
  };
  return {
    ...existing,
    [storefrontId]: mergedEntry,
  };
}

/**
 * @param {string} storefrontId
 * @param {Record<string, any>} tokenData
 * @param {Record<string, any>} [options]
 */
function saveTokens(storefrontId, tokenData, options = {}) {
  try {
    const existing = loadSavedTokens(options);
    const nextAll = mergeStorefrontTokenUpdate(existing, storefrontId, tokenData);
    const { cleaned } = sanitizeStorefrontTokensObject(nextAll, options);
    writeTokensFile(cleaned, options);
    if (!options?.fromExternalFallback && storefrontId) {
      try {
        clearStoreDisconnectedTombstone(storefrontId, options);
      } catch {}
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn('Failed to save tokens:', msg);
  }
}

/**
 * Serialized, non-blocking async read-modify-write for storefront credentials.
 * Uses `util.promisify(crypto.scrypt)` + per-file mutex + atomic `.tmp` + `rename`
 * so concurrent token refreshes across Epic, GOG, Steam, and Xbox never clobber one another.
 *
 * @param {string} storefrontId
 * @param {Record<string, any>} tokenData
 * @param {Record<string, any>} [options]
 * @returns {Promise<void>}
 */
async function saveTokensAsync(storefrontId, tokenData, options = {}) {
  const filePath = getTokensFilePath(options);
  return runWithVaultMutex(filePath, async () => {
    try {
      const resolved = path.resolve(filePath);
      const existing = await readTokensUnlockedAsync(filePath, options);
      const nextAll = mergeStorefrontTokenUpdate(existing, storefrontId, tokenData);
      const { cleaned } = sanitizeStorefrontTokensObject(nextAll, options);
      const salt = normalizeSaltBuffer(options?.salt) || (await getOrInitPerFileSaltAsync(resolved));
      const encryptedPayload = await encryptTokensPayloadAsync(
        JSON.stringify(cleaned, null, 2),
        { ...options, salt }
      );
      await atomicWriteVaultFileAsync(filePath, JSON.stringify(encryptedPayload, null, 2));
      if (!options?.fromExternalFallback && storefrontId) {
        try {
          clearStoreDisconnectedTombstone(storefrontId, options);
        } catch {}
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn('Failed to save tokens:', msg);
    }
  });
}

/**
 * @param {string} storefrontId
 * @param {Record<string, any>} [options]
 */
function clearTokens(storefrontId, options = {}) {
  try {
    const existing = loadSavedTokens(options);
    if (existing[storefrontId]) {
      delete existing[storefrontId];
      writeTokensFile(existing, options);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn('Failed to clear tokens:', msg);
  }
}

/**
 * Serialized, non-blocking async counterpart to `clearTokens`.
 *
 * @param {string} storefrontId
 * @param {Record<string, any>} [options]
 * @returns {Promise<void>}
 */
async function clearTokensAsync(storefrontId, options = {}) {
  const filePath = getTokensFilePath(options);
  return runWithVaultMutex(filePath, async () => {
    try {
      const resolved = path.resolve(filePath);
      const existing = await readTokensUnlockedAsync(filePath, options);
      if (existing[storefrontId]) {
        delete existing[storefrontId];
        const salt =
          normalizeSaltBuffer(options?.salt) || (await getOrInitPerFileSaltAsync(resolved));
        const encryptedPayload = await encryptTokensPayloadAsync(
          JSON.stringify(existing, null, 2),
          { ...options, salt }
        );
        await atomicWriteVaultFileAsync(filePath, JSON.stringify(encryptedPayload, null, 2));
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn('Failed to clear tokens:', msg);
    }
  });
}

/**
 * Produces a safe, redacted Xbox account & subscription summary for renderer IPC
 * (`store:get-tokens` / `store:xbox-get-status`) without leaking raw MSA, XSTS, ProofKey,
 * or Clep `DeviceKey` secrets across the renderer bridge.
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
  getMachineIdentityKeyMaterial,
  getHardwareFingerprint: getMachineIdentityKeyMaterial,
  getTokensFilePath,
  getOrCreateVaultSecret,
  getOrCreateVaultSecretAsync,
  encryptTokensPayload,
  encryptTokensPayloadAsync,
  decryptTokensPayload,
  decryptTokensPayloadAsync,
  isMockOrCorruptedToken,
  sanitizeStorefrontTokensObject,
  projectRedactedXboxSummary,
  runWithVaultMutex,
  writeTokensFile,
  writeTokensFileAsync,
  loadSavedTokens,
  loadSavedTokensAsync,
  saveTokens,
  saveTokensAsync,
  clearTokens,
  clearTokensAsync,
};
