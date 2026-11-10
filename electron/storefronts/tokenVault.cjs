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
  applyWindowsOwnerAclAsync,
  atomicWriteSecureFileSync,
  clearStoreDisconnectedTombstone,
} = require('../launcher/securityAndPathUtils.cjs');

const scryptAsync = util.promisify(crypto.scrypt);

const DERIVED_KEY_CACHE_MAX = 256;
const DPAPI_VAULT_KEY_PREFIX = 'dpapi:v1:';
const LEGACY_PLAIN_VAULT_KEY_PREFIX = 'v1:';
const LEGACY_AES256GCM_TOKEN_PREFIX = 'v1:aes256gcm:';

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
 * @typedef {{
 *   doc: Record<string, any>,
 *   hydrated: boolean,
 *   keyContextDigest: string,
 *   pendingAsyncOps: number,
 *   generation: number,
 *   flushedGeneration: number,
 *   tokensExists: boolean,
 *   tokensMtimeMs: number,
 *   tokensSize: number,
 *   vaultKeyExists: boolean,
 *   vaultKeyMtimeMs: number,
 * }} VaultCacheEntry
 */

/**
 * Authoritative per-vault in-memory cache shared across sync (`loadSavedTokens`, `saveTokens`,
 * `clearTokens`, `writeTokensFile`) and async (`loadSavedTokensAsync`, `saveTokensAsync`,
 * `clearTokensAsync`, `writeTokensFileAsync`) callers so cross-storefront mutations never clobber
 * each other during `scryptAsync` and hot-path reads avoid redundant decryption.
 *
 * @type {Map<string, VaultCacheEntry>}
 */
const vaultMemoryCache = new Map();

/**
 * Registered listeners notified whenever vault tokens are saved, overwritten, or cleared.
 *
 * @type {Set<(event: { action: 'save' | 'clear' | 'write', storefrontId?: string, filePath: string, options?: Record<string, any> }) => void>}
 */
const vaultChangeListeners = new Set();

/**
 * Register a callback invoked when credentials in the vault are modified or cleared.
 *
 * @param {(event: { action: 'save' | 'clear' | 'write', storefrontId?: string, filePath: string, options?: Record<string, any> }) => void} listener
 * @returns {() => void}
 */
function onVaultChange(listener) {
  if (typeof listener !== 'function') {
    return () => {};
  }
  vaultChangeListeners.add(listener);
  return () => {
    vaultChangeListeners.delete(listener);
  };
}

/**
 * @param {{ action: 'save' | 'clear' | 'write', storefrontId?: string, filePath: string, options?: Record<string, any> }} event
 */
function emitVaultChange(event) {
  for (const listener of vaultChangeListeners) {
    try {
      listener(event);
    } catch {}
  }
}

/**
 * Explicitly invalidates the in-memory vault cache (all paths or a single `tokens.json` path).
 *
 * @param {string} [filePath]
 */
function invalidateVaultMemoryCache(filePath) {
  if (typeof filePath === 'string' && filePath.trim()) {
    vaultMemoryCache.delete(path.resolve(toHostFilesystemPath(filePath.trim())));
    return;
  }
  vaultMemoryCache.clear();
}

/**
 * Deep-clones a plain JSON vault object so callers cannot mutate cached internal state.
 *
 * @param {Record<string, any> | null | undefined} doc
 * @returns {Record<string, any>}
 */
function cloneVaultDoc(doc) {
  if (!doc || typeof doc !== 'object') return {};
  try {
    return JSON.parse(JSON.stringify(doc));
  } catch {
    return { ...doc };
  }
}

/**
 * Resolves `electron.safeStorage` ONLY on Windows (`win32`, where DPAPI `CryptProtectData` is
 * 100% promptless) or when explicitly injected/enabled via `options.safeStorage` / `options.useSafeStorage`.
 * Never touches macOS Keychain (`darwin`) or Linux Secret Service by default.
 *
 * @param {Record<string, any>} [options]
 * @returns {{ isEncryptionAvailable: () => boolean, encryptString: (plainText: string) => Buffer, decryptString: (encrypted: Buffer) => string } | null}
 */
function resolveSafeStorageBackend(options = {}) {
  if (options && options.safeStorage && typeof options.safeStorage === 'object') {
    return options.safeStorage;
  }
  const effectivePlatform = (options && options.platform) || process.platform;
  const explicitlyEnabled = Boolean(options && options.useSafeStorage === true);
  if (effectivePlatform !== 'win32' && !explicitlyEnabled) {
    return null;
  }
  try {
    const reqElectron = require('electron');
    const ss = reqElectron && reqElectron.safeStorage;
    if (
      ss &&
      typeof ss.isEncryptionAvailable === 'function' &&
      typeof ss.encryptString === 'function' &&
      typeof ss.decryptString === 'function'
    ) {
      return ss;
    }
  } catch {}
  return null;
}

/**
 * @param {any} safeStorage
 * @returns {boolean}
 */
function isSafeStorageEncryptionActive(safeStorage) {
  if (!safeStorage || typeof safeStorage.isEncryptionAvailable !== 'function') {
    return false;
  }
  try {
    return (
      safeStorage.isEncryptionAvailable() === true &&
      typeof safeStorage.encryptString === 'function' &&
      typeof safeStorage.decryptString === 'function'
    );
  } catch {
    return false;
  }
}

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
 * @param {string} hexSecret
 * @param {any} safeStorage
 * @returns {string}
 */
function encodeVaultSecretForDisk(hexSecret, safeStorage) {
  if (isSafeStorageEncryptionActive(safeStorage)) {
    const encryptedBuf = safeStorage.encryptString(hexSecret);
    const buf = Buffer.isBuffer(encryptedBuf) ? encryptedBuf : Buffer.from(encryptedBuf);
    return `${DPAPI_VAULT_KEY_PREFIX}${buf.toString('base64')}`;
  }
  return hexSecret;
}

/**
 * @param {string} rawContent
 * @param {any} safeStorage
 * @returns {{ secret: string | null, needsMigration: boolean }}
 */
function decodeVaultSecretFromDisk(rawContent, safeStorage) {
  const trimmed = String(rawContent || '').trim();
  if (!trimmed) {
    return { secret: null, needsMigration: false };
  }
  if (trimmed.startsWith(DPAPI_VAULT_KEY_PREFIX)) {
    if (!isSafeStorageEncryptionActive(safeStorage)) {
      return { secret: null, needsMigration: false };
    }
    const b64 = trimmed.slice(DPAPI_VAULT_KEY_PREFIX.length).trim();
    if (!b64) {
      return { secret: null, needsMigration: false };
    }
    try {
      const unwrapped = String(safeStorage.decryptString(Buffer.from(b64, 'base64')) || '').trim();
      if (/^[0-9a-f]{64}$/i.test(unwrapped)) {
        return { secret: unwrapped.toLowerCase(), needsMigration: false };
      }
    } catch {}
    return { secret: null, needsMigration: false };
  }

  const candidate = trimmed.startsWith(LEGACY_PLAIN_VAULT_KEY_PREFIX)
    ? trimmed.slice(LEGACY_PLAIN_VAULT_KEY_PREFIX.length).trim()
    : trimmed;
  if (/^[0-9a-f]{64}$/i.test(candidate)) {
    return {
      secret: candidate.toLowerCase(),
      needsMigration: isSafeStorageEncryptionActive(safeStorage),
    };
  }
  return { secret: null, needsMigration: false };
}

/**
 * Resolve or generate a random 256-bit per-user vault secret stored in `vault.key` (`0o600` / user-SID ACL,
 * plus Win32 DPAPI `electron.safeStorage` envelope wrapping on Windows) adjacent to `tokens.json`.
 * Prevents any other local account on a shared workstation from deriving the vault key using
 * world-readable `IOPlatformUUID` / `MachineGuid` alone.
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
  const safeStorage = resolveSafeStorageBackend(options);

  try {
    if (fs.existsSync(vaultKeyPath)) {
      const existing = fs.readFileSync(vaultKeyPath, 'utf8');
      const decoded = decodeVaultSecretFromDisk(existing, safeStorage);
      if (decoded.secret) {
        if (decoded.needsMigration) {
          try {
            atomicWriteSecureFileSync(
              vaultKeyPath,
              encodeVaultSecretForDisk(decoded.secret, safeStorage)
            );
          } catch {}
        }
        return decoded.secret;
      }
      if (existing.trim().startsWith(DPAPI_VAULT_KEY_PREFIX)) {
        return null;
      }
    }
  } catch {}

  if (!createIfMissing) {
    return null;
  }

  const freshSecret = crypto.randomBytes(32).toString('hex');
  atomicWriteSecureFileSync(vaultKeyPath, encodeVaultSecretForDisk(freshSecret, safeStorage));
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
  const safeStorage = resolveSafeStorageBackend(options);

  try {
    const existing = await fs.promises.readFile(vaultKeyPath, 'utf8');
    const decoded = decodeVaultSecretFromDisk(existing, safeStorage);
    if (decoded.secret) {
      if (decoded.needsMigration) {
        try {
          await atomicWriteVaultFileAsync(
            vaultKeyPath,
            encodeVaultSecretForDisk(decoded.secret, safeStorage)
          );
        } catch {}
      }
      return decoded.secret;
    }
    if (existing.trim().startsWith(DPAPI_VAULT_KEY_PREFIX)) {
      return null;
    }
  } catch {}

  if (!createIfMissing) {
    return null;
  }

  const freshSecret = crypto.randomBytes(32).toString('hex');
  await atomicWriteVaultFileAsync(vaultKeyPath, encodeVaultSecretForDisk(freshSecret, safeStorage));
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
 * Parses and decrypts legacy `v1:aes256gcm:<salt>:<iv>:<tag>:<ciphertext>` string token payloads.
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

  const hwIdentity = getMachineIdentityKeyMaterial(options);
  const vaultSecret = await getOrCreateVaultSecretAsync(options, false);
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
 * Bounded Windows `EPERM` / `EBUSY` / `EACCES` retry for atomic `fs.promises.rename`.
 *
 * @param {string} tmpPath
 * @param {string} targetPath
 */
async function renameWithWindowsRetryAsync(tmpPath, targetPath) {
  const maxAttempts = 5;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      await fs.promises.rename(tmpPath, targetPath);
      return;
    } catch (err) {
      const code = err && typeof err === 'object' ? /** @type {any} */ (err).code : '';
      const retryable = code === 'EPERM' || code === 'EBUSY' || code === 'EACCES';
      if (!retryable || attempt >= maxAttempts) {
        throw err;
      }
      await new Promise((resolve) => setTimeout(resolve, 12 * attempt));
    }
  }
}

/**
 * Atomic async `.tmp` + `fh.datasync()` + `rename` write with `0o600` / Windows owner-SID ACLs.
 *
 * @param {string} filePath
 * @param {string} content
 */
async function atomicWriteVaultFileAsync(filePath, content) {
  const hostFilePath = toHostFilesystemPath(filePath);
  const dir = path.dirname(hostFilePath);
  await fs.promises.mkdir(dir, { recursive: true, mode: 0o700 });
  const tmpPath = `${hostFilePath}.${process.pid}.${Date.now()}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  /** @type {fs.promises.FileHandle | null} */
  let fh = null;
  try {
    fh = await fs.promises.open(tmpPath, 'wx', 0o600);
    await fh.writeFile(content, 'utf8');
    try {
      await fh.datasync();
    } catch {}
    await fh.close();
    fh = null;

    if (process.platform === 'win32') {
      try {
        await applyWindowsOwnerAclAsync(tmpPath);
      } catch {}
    } else {
      try {
        await fs.promises.chmod(tmpPath, 0o600);
      } catch {}
    }

    await renameWithWindowsRetryAsync(tmpPath, hostFilePath);

    if (process.platform !== 'win32') {
      try {
        await fs.promises.chmod(hostFilePath, 0o600);
      } catch {}
    }
  } catch {
    if (fh) {
      try {
        await fh.close();
      } catch {}
    }
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
  const key = path.resolve(toHostFilesystemPath(filePath));
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
 * @param {string} resolvedFilePath
 * @param {string} vaultKeyPath
 * @param {Record<string, any>} [options]
 * @returns {string}
 */
function computeVaultKeyContextDigest(resolvedFilePath, vaultKeyPath, options = {}) {
  const hw = getMachineIdentityKeyMaterial(options);
  const secretOverride =
    options && typeof options.vaultSecretOverride === 'string' ? options.vaultSecretOverride : '';
  const ss = resolveSafeStorageBackend(options);
  const ssTag = !ss ? 'none' : isSafeStorageEncryptionActive(ss) ? 'avail' : 'unavail';
  return crypto
    .createHash('sha256')
    .update(`${resolvedFilePath}|${vaultKeyPath}|${hw}|${secretOverride}|${ssTag}`)
    .digest('hex');
}

/**
 * @param {string} targetPath
 * @returns {{ exists: boolean, mtimeMs: number, size: number }}
 */
function statSnapshotSync(targetPath) {
  try {
    const st = fs.statSync(targetPath);
    return { exists: true, mtimeMs: st.mtimeMs, size: st.size };
  } catch {
    return { exists: false, mtimeMs: 0, size: 0 };
  }
}

/**
 * @param {string} targetPath
 * @returns {Promise<{ exists: boolean, mtimeMs: number, size: number }>}
 */
async function statSnapshotAsync(targetPath) {
  try {
    const st = await fs.promises.stat(targetPath);
    return { exists: true, mtimeMs: st.mtimeMs, size: st.size };
  } catch {
    return { exists: false, mtimeMs: 0, size: 0 };
  }
}

/**
 * @param {VaultCacheEntry | undefined} entry
 * @param {string} resolvedFilePath
 * @param {string} vaultKeyPath
 * @param {string} keyContextDigest
 * @returns {boolean}
 */
function isVaultCacheEntryValidSync(entry, resolvedFilePath, vaultKeyPath, keyContextDigest) {
  if (!entry || !entry.hydrated || entry.keyContextDigest !== keyContextDigest) {
    return false;
  }
  if (entry.pendingAsyncOps > 0) {
    return true;
  }
  const tokSnap = statSnapshotSync(resolvedFilePath);
  const keySnap = statSnapshotSync(vaultKeyPath);
  if (tokSnap.exists !== entry.tokensExists || keySnap.exists !== entry.vaultKeyExists) {
    return false;
  }
  if (tokSnap.exists && (tokSnap.mtimeMs !== entry.tokensMtimeMs || tokSnap.size !== entry.tokensSize)) {
    return false;
  }
  if (keySnap.exists && keySnap.mtimeMs !== entry.vaultKeyMtimeMs) {
    return false;
  }
  return true;
}

/**
 * @param {VaultCacheEntry | undefined} entry
 * @param {string} resolvedFilePath
 * @param {string} vaultKeyPath
 * @param {string} keyContextDigest
 * @returns {Promise<boolean>}
 */
async function isVaultCacheEntryValidAsync(entry, resolvedFilePath, vaultKeyPath, keyContextDigest) {
  if (!entry || !entry.hydrated || entry.keyContextDigest !== keyContextDigest) {
    return false;
  }
  if (entry.pendingAsyncOps > 0) {
    return true;
  }
  const [tokSnap, keySnap] = await Promise.all([
    statSnapshotAsync(resolvedFilePath),
    statSnapshotAsync(vaultKeyPath),
  ]);
  if (tokSnap.exists !== entry.tokensExists || keySnap.exists !== entry.vaultKeyExists) {
    return false;
  }
  if (tokSnap.exists && (tokSnap.mtimeMs !== entry.tokensMtimeMs || tokSnap.size !== entry.tokensSize)) {
    return false;
  }
  if (keySnap.exists && keySnap.mtimeMs !== entry.vaultKeyMtimeMs) {
    return false;
  }
  return true;
}

/**
 * Updates disk stat metadata on a cache entry after a read or flush.
 *
 * @param {VaultCacheEntry} entry
 * @param {string} resolvedFilePath
 * @param {string} vaultKeyPath
 */
function refreshEntryDiskStatsSync(entry, resolvedFilePath, vaultKeyPath) {
  const tokSnap = statSnapshotSync(resolvedFilePath);
  const keySnap = statSnapshotSync(vaultKeyPath);
  entry.tokensExists = tokSnap.exists;
  entry.tokensMtimeMs = tokSnap.mtimeMs;
  entry.tokensSize = tokSnap.size;
  entry.vaultKeyExists = keySnap.exists;
  entry.vaultKeyMtimeMs = keySnap.mtimeMs;
}

/**
 * @param {VaultCacheEntry} entry
 * @param {string} resolvedFilePath
 * @param {string} vaultKeyPath
 */
async function refreshEntryDiskStatsAsync(entry, resolvedFilePath, vaultKeyPath) {
  const [tokSnap, keySnap] = await Promise.all([
    statSnapshotAsync(resolvedFilePath),
    statSnapshotAsync(vaultKeyPath),
  ]);
  entry.tokensExists = tokSnap.exists;
  entry.tokensMtimeMs = tokSnap.mtimeMs;
  entry.tokensSize = tokSnap.size;
  entry.vaultKeyExists = keySnap.exists;
  entry.vaultKeyMtimeMs = keySnap.mtimeMs;
}

/**
 * Low-level synchronous disk encrypt + write (updates `vaultMemoryCache` synchronously).
 *
 * @param {string} filePath
 * @param {Record<string, any>} tokens
 * @param {Record<string, any>} [options]
 */
function persistTokensToDiskSync(filePath, tokens, options = {}) {
  const resolved = path.resolve(toHostFilesystemPath(filePath));
  const vaultKeyPath = path.join(path.dirname(resolved), 'vault.key');
  const keyContextDigest = computeVaultKeyContextDigest(resolved, vaultKeyPath, options);
  const salt = normalizeSaltBuffer(options?.salt) || getOrInitPerFileSaltSync(resolved);
  const cloned = cloneVaultDoc(tokens);
  const jsonStr = JSON.stringify(cloned, null, 2);
  const encryptedPayload = encryptTokensPayload(jsonStr, { ...options, salt });
  atomicWriteSecureFileSync(resolved, JSON.stringify(encryptedPayload, null, 2));

  const existingEntry = vaultMemoryCache.get(resolved);
  const nextGen = existingEntry ? existingEntry.generation + 1 : 1;
  /** @type {VaultCacheEntry} */
  const entry = existingEntry || {
    doc: cloned,
    hydrated: true,
    keyContextDigest,
    pendingAsyncOps: 0,
    generation: nextGen,
    flushedGeneration: nextGen,
    tokensExists: false,
    tokensMtimeMs: 0,
    tokensSize: 0,
    vaultKeyExists: false,
    vaultKeyMtimeMs: 0,
  };
  entry.doc = cloned;
  entry.hydrated = true;
  entry.keyContextDigest = keyContextDigest;
  entry.generation = nextGen;
  entry.flushedGeneration = nextGen;
  refreshEntryDiskStatsSync(entry, resolved, vaultKeyPath);
  vaultMemoryCache.set(resolved, entry);
}

/**
 * Flushes the latest authoritative `entry.doc` to disk inside `runWithVaultMutex`,
 * never clobbering a newer sync or async generation that arrived during `scryptAsync`.
 *
 * @param {string} filePath
 * @param {VaultCacheEntry} entry
 * @param {Record<string, any>} [options]
 */
async function flushAuthoritativeVaultEntryAsync(filePath, entry, options = {}) {
  const resolved = path.resolve(toHostFilesystemPath(filePath));
  const vaultKeyPath = path.join(path.dirname(resolved), 'vault.key');

  while (entry.flushedGeneration < entry.generation) {
    const snapGen = entry.generation;
    const snapDoc = cloneVaultDoc(entry.doc);
    const salt = normalizeSaltBuffer(options?.salt) || (await getOrInitPerFileSaltAsync(resolved));
    const encryptedPayload = await encryptTokensPayloadAsync(JSON.stringify(snapDoc, null, 2), {
      ...options,
      salt,
    });
    if (entry.flushedGeneration >= snapGen) {
      // A synchronous write already flushed >= snapGen while `scryptAsync` was running!
      continue;
    }
    if (entry.generation > snapGen) {
      // Another mutation arrived during `scryptAsync`; loop to encrypt the latest `entry.doc`!
      continue;
    }
    await atomicWriteVaultFileAsync(resolved, JSON.stringify(encryptedPayload, null, 2));
    entry.flushedGeneration = Math.max(entry.flushedGeneration, snapGen);
    await refreshEntryDiskStatsAsync(entry, resolved, vaultKeyPath);
  }
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
  const resolved = path.resolve(toHostFilesystemPath(filePath));
  persistTokensToDiskSync(resolved, tokens, options);
  emitVaultChange({ action: 'write', filePath: resolved, options });
}

/**
 * Async non-blocking counterpart to `writeTokensFile` using `crypto.scrypt` + atomic `.tmp` + `datasync` + `rename`.
 * Updates the authoritative in-memory vault cache immediately so concurrent sync/async callers see the write.
 *
 * @param {Record<string, any>} tokens
 * @param {Record<string, any>} [options]
 * @returns {Promise<void>}
 */
async function writeTokensFileAsync(tokens, options = {}) {
  const filePath = getTokensFilePath(options);
  const resolved = path.resolve(toHostFilesystemPath(filePath));
  const vaultKeyPath = path.join(path.dirname(resolved), 'vault.key');
  const keyContextDigest = computeVaultKeyContextDigest(resolved, vaultKeyPath, options);
  const cloned = cloneVaultDoc(tokens);

  const prev = vaultMemoryCache.get(resolved);
  const nextGen = prev ? prev.generation + 1 : 1;
  /** @type {VaultCacheEntry} */
  const entry = prev || {
    doc: cloned,
    hydrated: true,
    keyContextDigest,
    pendingAsyncOps: 0,
    generation: nextGen,
    flushedGeneration: 0,
    tokensExists: false,
    tokensMtimeMs: 0,
    tokensSize: 0,
    vaultKeyExists: false,
    vaultKeyMtimeMs: 0,
  };
  entry.doc = cloned;
  entry.hydrated = true;
  entry.keyContextDigest = keyContextDigest;
  entry.generation = nextGen;
  entry.pendingAsyncOps += 1;
  vaultMemoryCache.set(resolved, entry);
  emitVaultChange({ action: 'write', filePath: resolved, options });

  try {
    await runWithVaultMutex(resolved, async () => {
      await flushAuthoritativeVaultEntryAsync(resolved, entry, options);
    });
  } finally {
    entry.pendingAsyncOps = Math.max(0, entry.pendingAsyncOps - 1);
  }
}

/**
 * Low-level synchronous disk reader (populates `vaultMemoryCache`).
 *
 * @param {string} resolved
 * @param {string} vaultKeyPath
 * @param {string} keyContextDigest
 * @param {Record<string, any>} [options]
 * @returns {Record<string, any>}
 */
function readTokensFromDiskSync(resolved, vaultKeyPath, keyContextDigest, options = {}) {
  /**
   * @param {Record<string, any>} docObj
   * @returns {Record<string, any>}
   */
  const storeCacheResult = (docObj) => {
    const cloned = cloneVaultDoc(docObj);
    const prev = vaultMemoryCache.get(resolved);
    // Never clobber uncommitted in-memory async mutations
    if (prev && prev.pendingAsyncOps > 0 && prev.keyContextDigest === keyContextDigest) {
      return cloneVaultDoc(prev.doc);
    }
    const nextGen = prev ? prev.generation + 1 : 1;
    /** @type {VaultCacheEntry} */
    const entry = {
      doc: cloned,
      hydrated: true,
      keyContextDigest,
      pendingAsyncOps: 0,
      generation: nextGen,
      flushedGeneration: nextGen,
      tokensExists: false,
      tokensMtimeMs: 0,
      tokensSize: 0,
      vaultKeyExists: false,
      vaultKeyMtimeMs: 0,
    };
    refreshEntryDiskStatsSync(entry, resolved, vaultKeyPath);
    vaultMemoryCache.set(resolved, entry);
    return cloneVaultDoc(cloned);
  };

  if (!fs.existsSync(resolved)) {
    return storeCacheResult({});
  }

  const rawContent = fs.readFileSync(resolved);
  if (!rawContent || rawContent.length === 0) {
    return storeCacheResult({});
  }

  const rawStr = rawContent.toString('utf-8').trim();
  if (rawStr.startsWith(LEGACY_AES256GCM_TOKEN_PREFIX)) {
    try {
      const dec = decryptLegacyV1StringSync(rawStr, options);
      const { cleaned } = sanitizeStorefrontTokensObject(dec, options);
      try {
        persistTokensToDiskSync(resolved, cleaned, options);
      } catch {}
      return cloneVaultDoc(cleaned);
    } catch (decErr) {
      const msg = decErr instanceof Error ? decErr.message : String(decErr);
      console.warn('Failed to decrypt legacy v1 tokens payload:', msg);
      return storeCacheResult({});
    }
  }

  let parsed;
  try {
    parsed = JSON.parse(rawStr);
  } catch {
    return storeCacheResult({});
  }

  if (typeof parsed === 'string' && parsed.startsWith(LEGACY_AES256GCM_TOKEN_PREFIX)) {
    try {
      const dec = decryptLegacyV1StringSync(parsed, options);
      const { cleaned } = sanitizeStorefrontTokensObject(dec, options);
      try {
        persistTokensToDiskSync(resolved, cleaned, options);
      } catch {}
      return cloneVaultDoc(cleaned);
    } catch (decErr) {
      const msg = decErr instanceof Error ? decErr.message : String(decErr);
      console.warn('Failed to decrypt legacy v1 tokens payload:', msg);
      return storeCacheResult({});
    }
  }

  if (parsed && parsed._encrypted_v2 === true) {
    try {
      const diskSalt = normalizeSaltBuffer(parsed.salt);
      if (diskSalt && parsed._encrypted_v3 === true) {
        vaultSaltByFileCache.set(resolved, diskSalt);
      }
      const decrypted = decryptTokensPayload(parsed, options);
      const { cleaned, modified } = sanitizeStorefrontTokensObject(decrypted, options);
      if (modified || parsed._encrypted_v3 !== true) {
        try {
          persistTokensToDiskSync(resolved, cleaned, options);
          return cloneVaultDoc(cleaned);
        } catch {}
      }
      return storeCacheResult(cleaned);
    } catch (decErr) {
      const msg = decErr instanceof Error ? decErr.message : String(decErr);
      console.warn('Failed to decrypt tokens payload:', msg);
      return storeCacheResult({});
    }
  }

  if (parsed && parsed._encrypted === true) {
    return storeCacheResult({});
  }

  if (parsed && typeof parsed === 'object') {
    /** @type {Record<string, any>} */
    const cleanedTokens = {};
    let hadLegacyStoreCipher = false;
    for (const [key, value] of Object.entries(parsed)) {
      if (value && typeof value === 'object' && value._encrypted === true) {
        continue;
      }
      if (typeof value === 'string' && value.startsWith(LEGACY_AES256GCM_TOKEN_PREFIX)) {
        try {
          cleanedTokens[key] = decryptLegacyV1StringSync(value, options);
          hadLegacyStoreCipher = true;
        } catch {}
        continue;
      }
      cleanedTokens[key] = value;
    }
    const { cleaned } = sanitizeStorefrontTokensObject(cleanedTokens, options);
    if (Object.keys(cleaned).length > 0 || hadLegacyStoreCipher) {
      try {
        persistTokensToDiskSync(resolved, cleaned, options);
        return cloneVaultDoc(cleaned);
      } catch {}
    }
    return storeCacheResult(cleaned);
  }

  return storeCacheResult({});
}

/**
 * Load and decrypt saved storefront tokens, returning immediately from the authoritative
 * in-memory vault cache when disk stats and key context match (zero redundant `scryptSync`).
 *
 * @param {Record<string, any>} [options]
 * @returns {Record<string, any>}
 */
function loadSavedTokens(options = {}) {
  try {
    const filePath = getTokensFilePath(options);
    const resolved = path.resolve(toHostFilesystemPath(filePath));
    const vaultKeyPath = path.join(path.dirname(resolved), 'vault.key');
    const keyContextDigest = computeVaultKeyContextDigest(resolved, vaultKeyPath, options);
    const cachedEntry = vaultMemoryCache.get(resolved);
    if (isVaultCacheEntryValidSync(cachedEntry, resolved, vaultKeyPath, keyContextDigest)) {
      return cloneVaultDoc(/** @type {VaultCacheEntry} */ (cachedEntry).doc);
    }
    return readTokensFromDiskSync(resolved, vaultKeyPath, keyContextDigest, options);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn('Failed to load saved tokens:', msg);
    return {};
  }
}

/**
 * Internal unlocked async reader invoked inside `runWithVaultMutex`.
 * Populates `vaultMemoryCache` without clobbering concurrent sync/async mutations.
 *
 * @param {string} filePath
 * @param {Record<string, any>} [options]
 * @returns {Promise<Record<string, any>>}
 */
async function readTokensUnlockedAsync(filePath, options = {}) {
  const resolved = path.resolve(toHostFilesystemPath(filePath));
  const vaultKeyPath = path.join(path.dirname(resolved), 'vault.key');
  const keyContextDigest = computeVaultKeyContextDigest(resolved, vaultKeyPath, options);

  const existingEntry = vaultMemoryCache.get(resolved);
  if (await isVaultCacheEntryValidAsync(existingEntry, resolved, vaultKeyPath, keyContextDigest)) {
    return cloneVaultDoc(/** @type {VaultCacheEntry} */ (existingEntry).doc);
  }

  /**
   * @param {Record<string, any>} docObj
   * @param {boolean} [persistUpgrade]
   * @returns {Promise<Record<string, any>>}
   */
  const finalizeReadResultAsync = async (docObj, persistUpgrade = false) => {
    // Re-check whether a synchronous writer mutated `vaultMemoryCache` while async I/O / scrypt ran!
    const liveEntry = vaultMemoryCache.get(resolved);
    if (liveEntry && liveEntry !== existingEntry && liveEntry.hydrated && liveEntry.keyContextDigest === keyContextDigest) {
      return cloneVaultDoc(liveEntry.doc);
    }
    const cloned = cloneVaultDoc(docObj);
    const nextGen = liveEntry ? liveEntry.generation + 1 : 1;
    /** @type {VaultCacheEntry} */
    const entry = liveEntry || {
      doc: cloned,
      hydrated: true,
      keyContextDigest,
      pendingAsyncOps: 0,
      generation: nextGen,
      flushedGeneration: persistUpgrade ? 0 : nextGen,
      tokensExists: false,
      tokensMtimeMs: 0,
      tokensSize: 0,
      vaultKeyExists: false,
      vaultKeyMtimeMs: 0,
    };
    entry.doc = cloned;
    entry.hydrated = true;
    entry.keyContextDigest = keyContextDigest;
    entry.generation = nextGen;
    if (persistUpgrade) {
      vaultMemoryCache.set(resolved, entry);
      await flushAuthoritativeVaultEntryAsync(resolved, entry, options);
    } else {
      entry.flushedGeneration = nextGen;
      await refreshEntryDiskStatsAsync(entry, resolved, vaultKeyPath);
      vaultMemoryCache.set(resolved, entry);
    }
    return cloneVaultDoc(entry.doc);
  };

  let rawContent;
  try {
    rawContent = await fs.promises.readFile(resolved);
  } catch {
    return finalizeReadResultAsync({}, false);
  }
  if (!rawContent || rawContent.length === 0) {
    return finalizeReadResultAsync({}, false);
  }

  const rawStr = rawContent.toString('utf-8').trim();
  if (rawStr.startsWith(LEGACY_AES256GCM_TOKEN_PREFIX)) {
    try {
      const dec = await decryptLegacyV1StringAsync(rawStr, options);
      const { cleaned } = sanitizeStorefrontTokensObject(dec, options);
      return finalizeReadResultAsync(cleaned, true);
    } catch (decErr) {
      const msg = decErr instanceof Error ? decErr.message : String(decErr);
      console.warn('Failed to decrypt legacy v1 tokens payload:', msg);
      return finalizeReadResultAsync({}, false);
    }
  }

  let parsed;
  try {
    parsed = JSON.parse(rawStr);
  } catch {
    return finalizeReadResultAsync({}, false);
  }

  if (typeof parsed === 'string' && parsed.startsWith(LEGACY_AES256GCM_TOKEN_PREFIX)) {
    try {
      const dec = await decryptLegacyV1StringAsync(parsed, options);
      const { cleaned } = sanitizeStorefrontTokensObject(dec, options);
      return finalizeReadResultAsync(cleaned, true);
    } catch (decErr) {
      const msg = decErr instanceof Error ? decErr.message : String(decErr);
      console.warn('Failed to decrypt legacy v1 tokens payload:', msg);
      return finalizeReadResultAsync({}, false);
    }
  }

  if (parsed && parsed._encrypted_v2 === true) {
    try {
      const diskSalt = normalizeSaltBuffer(parsed.salt);
      if (diskSalt && parsed._encrypted_v3 === true) {
        vaultSaltByFileCache.set(resolved, diskSalt);
      }
      const decrypted = await decryptTokensPayloadAsync(parsed, options);
      const { cleaned, modified } = sanitizeStorefrontTokensObject(decrypted, options);
      return finalizeReadResultAsync(cleaned, Boolean(modified || parsed._encrypted_v3 !== true));
    } catch (decErr) {
      const msg = decErr instanceof Error ? decErr.message : String(decErr);
      console.warn('Failed to decrypt tokens payload:', msg);
      return finalizeReadResultAsync({}, false);
    }
  }

  if (parsed && parsed._encrypted === true) {
    return finalizeReadResultAsync({}, false);
  }

  if (parsed && typeof parsed === 'object') {
    /** @type {Record<string, any>} */
    const cleanedTokens = {};
    let hadLegacyStoreCipher = false;
    for (const [key, value] of Object.entries(parsed)) {
      if (value && typeof value === 'object' && value._encrypted === true) {
        continue;
      }
      if (typeof value === 'string' && value.startsWith(LEGACY_AES256GCM_TOKEN_PREFIX)) {
        try {
          cleanedTokens[key] = await decryptLegacyV1StringAsync(value, options);
          hadLegacyStoreCipher = true;
        } catch {}
        continue;
      }
      cleanedTokens[key] = value;
    }
    const { cleaned } = sanitizeStorefrontTokensObject(cleanedTokens, options);
    return finalizeReadResultAsync(
      cleaned,
      Boolean(Object.keys(cleaned).length > 0 || hadLegacyStoreCipher)
    );
  }

  return finalizeReadResultAsync({}, false);
}

/**
 * Async non-blocking counterpart to `loadSavedTokens`, backed by the authoritative in-memory cache
 * and serialized with active writes.
 *
 * @param {Record<string, any>} [options]
 * @returns {Promise<Record<string, any>>}
 */
async function loadSavedTokensAsync(options = {}) {
  const filePath = getTokensFilePath(options);
  const resolved = path.resolve(toHostFilesystemPath(filePath));
  const vaultKeyPath = path.join(path.dirname(resolved), 'vault.key');
  const keyContextDigest = computeVaultKeyContextDigest(resolved, vaultKeyPath, options);
  const cachedEntry = vaultMemoryCache.get(resolved);
  if (await isVaultCacheEntryValidAsync(cachedEntry, resolved, vaultKeyPath, keyContextDigest)) {
    return cloneVaultDoc(/** @type {VaultCacheEntry} */ (cachedEntry).doc);
  }
  return runWithVaultMutex(resolved, async () => {
    try {
      return await readTokensUnlockedAsync(resolved, options);
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
    const filePath = getTokensFilePath(options);
    const resolved = path.resolve(toHostFilesystemPath(filePath));
    const existing = loadSavedTokens(options);
    const nextAll = mergeStorefrontTokenUpdate(existing, storefrontId, tokenData);
    const { cleaned } = sanitizeStorefrontTokensObject(nextAll, options);
    persistTokensToDiskSync(resolved, cleaned, options);
    if (!options?.fromExternalFallback && storefrontId) {
      try {
        clearStoreDisconnectedTombstone(storefrontId, options);
      } catch {}
    }
    emitVaultChange({ action: 'save', storefrontId, filePath: resolved, options });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn('Failed to save tokens:', msg);
  }
}

/**
 * Serialized, non-blocking async read-modify-write for storefront credentials.
 * Shares the authoritative `vaultMemoryCache` with synchronous callers (`saveTokens`, `clearTokens`,
 * `loadSavedTokens`, `writeTokensFile`) so cross-storefront writes NEVER clobber one another
 * during `scryptAsync` worker execution.
 *
 * @param {string} storefrontId
 * @param {Record<string, any>} tokenData
 * @param {Record<string, any>} [options]
 * @returns {Promise<void>}
 */
async function saveTokensAsync(storefrontId, tokenData, options = {}) {
  const filePath = getTokensFilePath(options);
  const resolved = path.resolve(toHostFilesystemPath(filePath));
  const vaultKeyPath = path.join(path.dirname(resolved), 'vault.key');
  const keyContextDigest = computeVaultKeyContextDigest(resolved, vaultKeyPath, options);

  // Fast synchronous optimistic merge if the cache entry is already warm (or vault file does not exist yet)
  let optimisticEntry = vaultMemoryCache.get(resolved);
  let appliedOptimistically = false;
  if (isVaultCacheEntryValidSync(optimisticEntry, resolved, vaultKeyPath, keyContextDigest)) {
    const entry = /** @type {VaultCacheEntry} */ (optimisticEntry);
    const nextAll = mergeStorefrontTokenUpdate(entry.doc, storefrontId, tokenData);
    const { cleaned } = sanitizeStorefrontTokensObject(nextAll, options);
    entry.doc = cloneVaultDoc(cleaned);
    entry.generation += 1;
    entry.pendingAsyncOps += 1;
    appliedOptimistically = true;
    emitVaultChange({ action: 'save', storefrontId, filePath: resolved, options });
  } else if (!fs.existsSync(resolved)) {
    const nextAll = mergeStorefrontTokenUpdate({}, storefrontId, tokenData);
    const { cleaned } = sanitizeStorefrontTokensObject(nextAll, options);
    /** @type {VaultCacheEntry} */
    const createdEntry = {
      doc: cloneVaultDoc(cleaned),
      hydrated: true,
      keyContextDigest,
      pendingAsyncOps: 1,
      generation: 1,
      flushedGeneration: 0,
      tokensExists: false,
      tokensMtimeMs: 0,
      tokensSize: 0,
      vaultKeyExists: false,
      vaultKeyMtimeMs: 0,
    };
    vaultMemoryCache.set(resolved, createdEntry);
    optimisticEntry = createdEntry;
    appliedOptimistically = true;
    emitVaultChange({ action: 'save', storefrontId, filePath: resolved, options });
  }

  try {
    await runWithVaultMutex(resolved, async () => {
      try {
        if (!appliedOptimistically) {
          await readTokensUnlockedAsync(resolved, options);
          let entry = vaultMemoryCache.get(resolved);
          if (!entry || !entry.hydrated || entry.keyContextDigest !== keyContextDigest) {
            entry = {
              doc: {},
              hydrated: true,
              keyContextDigest,
              pendingAsyncOps: 0,
              generation: 0,
              flushedGeneration: 0,
              tokensExists: false,
              tokensMtimeMs: 0,
              tokensSize: 0,
              vaultKeyExists: false,
              vaultKeyMtimeMs: 0,
            };
            vaultMemoryCache.set(resolved, entry);
          }
          const nextAll = mergeStorefrontTokenUpdate(entry.doc, storefrontId, tokenData);
          const { cleaned } = sanitizeStorefrontTokensObject(nextAll, options);
          entry.doc = cloneVaultDoc(cleaned);
          entry.generation += 1;
          entry.pendingAsyncOps += 1;
          optimisticEntry = entry;
          appliedOptimistically = true;
          emitVaultChange({ action: 'save', storefrontId, filePath: resolved, options });
        }

        const activeEntry = vaultMemoryCache.get(resolved);
        if (activeEntry) {
          await flushAuthoritativeVaultEntryAsync(resolved, activeEntry, options);
        }
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
  } finally {
    if (appliedOptimistically && optimisticEntry) {
      optimisticEntry.pendingAsyncOps = Math.max(0, optimisticEntry.pendingAsyncOps - 1);
    }
  }
}

/**
 * @param {string} storefrontId
 * @param {Record<string, any>} [options]
 */
function clearTokens(storefrontId, options = {}) {
  try {
    const filePath = getTokensFilePath(options);
    const resolved = path.resolve(toHostFilesystemPath(filePath));
    const existing = loadSavedTokens(options);
    if (existing[storefrontId]) {
      delete existing[storefrontId];
      persistTokensToDiskSync(resolved, existing, options);
    }
    emitVaultChange({ action: 'clear', storefrontId, filePath: resolved, options });
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
  const resolved = path.resolve(toHostFilesystemPath(filePath));
  const vaultKeyPath = path.join(path.dirname(resolved), 'vault.key');
  const keyContextDigest = computeVaultKeyContextDigest(resolved, vaultKeyPath, options);

  let optimisticEntry = vaultMemoryCache.get(resolved);
  let appliedOptimistically = false;
  if (isVaultCacheEntryValidSync(optimisticEntry, resolved, vaultKeyPath, keyContextDigest)) {
    const entry = /** @type {VaultCacheEntry} */ (optimisticEntry);
    if (entry.doc[storefrontId]) {
      delete entry.doc[storefrontId];
      entry.generation += 1;
      entry.pendingAsyncOps += 1;
      appliedOptimistically = true;
    }
    emitVaultChange({ action: 'clear', storefrontId, filePath: resolved, options });
  }

  try {
    await runWithVaultMutex(resolved, async () => {
      try {
        if (!appliedOptimistically) {
          await readTokensUnlockedAsync(resolved, options);
          const entry = vaultMemoryCache.get(resolved);
          if (entry && entry.doc[storefrontId]) {
            delete entry.doc[storefrontId];
            entry.generation += 1;
            entry.pendingAsyncOps += 1;
            optimisticEntry = entry;
            appliedOptimistically = true;
          }
          emitVaultChange({ action: 'clear', storefrontId, filePath: resolved, options });
        }

        const activeEntry = vaultMemoryCache.get(resolved);
        if (activeEntry && activeEntry.flushedGeneration < activeEntry.generation) {
          await flushAuthoritativeVaultEntryAsync(resolved, activeEntry, options);
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn('Failed to clear tokens:', msg);
      }
    });
  } finally {
    if (appliedOptimistically && optimisticEntry) {
      optimisticEntry.pendingAsyncOps = Math.max(0, optimisticEntry.pendingAsyncOps - 1);
    }
  }
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
  onVaultChange,
  invalidateVaultMemoryCache,
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
