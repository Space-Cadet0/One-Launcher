// @ts-check
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const util = require('node:util');
const { execFileSync, execFile } = require('node:child_process');
const {
  toHostFilesystemPath,
  atomicWriteSecureFileSync,
} = require('../../launcher/securityAndPathUtils.cjs');
const { atomicWriteVaultFileAsync } = require('./vaultMutexAndAtomicIo.cjs');

/** @type {{ getPath?: (name: string) => string } | null} */
let electronApp = null;
try {
  const reqElectron = require('electron');
  if (reqElectron && typeof reqElectron === 'object' && reqElectron.app) {
    electronApp = reqElectron.app;
  }
} catch {
  // Pure Node / Vitest context without Electron runtime
}

const scryptAsync = util.promisify(crypto.scrypt);

const DERIVED_KEY_CACHE_MAX = 256;
const DPAPI_VAULT_KEY_PREFIX = 'dpapi:v1:';
const LEGACY_PLAIN_VAULT_KEY_PREFIX = 'v1:';
const LEGACY_AES256GCM_TOKEN_PREFIX = 'v1:aes256gcm:';

/** @type {string | null} */
let cachedMachineIdentity = null;
/** @type {Promise<string> | null} */
let inFlightMachineIdentityLookup = null;

/**
 * In-memory derived-key cache keyed by `salt.toString('hex')` (verified against a digest of
 * `keyMaterial` so differing machineId/vaultSecret overrides never collide on the same salt).
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
 * Resolves `electron.safeStorage` ONLY on Windows (`win32`, where DPAPI `CryptProtectData` is
 * 100% promptless) or when explicitly injected/enabled via `options.safeStorage` / `options.useSafeStorage`.
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
 * @param {string} hwId
 * @returns {string}
 */
function finalizeMachineIdentity(hwId) {
  const effectiveHwId = hwId || `${os.hostname()}:${os.platform()}:${os.arch()}`;
  let username = 'user';
  try {
    username = os.userInfo().username || 'user';
  } catch {}
  cachedMachineIdentity = `one-launcher-vault-v2:${effectiveHwId}:${username}`;
  return cachedMachineIdentity;
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

  return finalizeMachineIdentity(hwId);
}

/**
 * Non-blocking async counterpart to `getMachineIdentityKeyMaterial` so async vault operations
 * do not stall the Electron main thread on cold-boot `ioreg` / `reg query` spawns.
 *
 * @param {Record<string, any>} [options]
 * @returns {Promise<string>}
 */
async function getMachineIdentityKeyMaterialAsync(options = {}) {
  if (options && typeof options.machineIdOverride === 'string' && options.machineIdOverride) {
    return `one-launcher-vault-v2:${options.machineIdOverride}`;
  }
  if (cachedMachineIdentity) {
    return cachedMachineIdentity;
  }
  if (inFlightMachineIdentityLookup) {
    return inFlightMachineIdentityLookup;
  }

  inFlightMachineIdentityLookup = (async () => {
    let hwId = '';
    try {
      if (process.platform === 'darwin') {
        const out = await new Promise((resolve) => {
          try {
            execFile(
              '/usr/sbin/ioreg',
              ['-rd1', '-c', 'IOPlatformExpertDevice'],
              { encoding: 'utf8', timeout: 2000 },
              (err, stdout) => resolve(!err && stdout ? String(stdout) : '')
            );
          } catch {
            resolve('');
          }
        });
        const match = String(out).match(/"IOPlatformUUID"\s*=\s*"([^"]+)"/);
        if (match && match[1]) {
          hwId = match[1].trim();
        }
      } else if (process.platform === 'win32') {
        const out = await new Promise((resolve) => {
          try {
            execFile(
              'reg',
              ['query', 'HKLM\\SOFTWARE\\Microsoft\\Cryptography', '/v', 'MachineGuid'],
              { encoding: 'utf8', timeout: 2000, windowsHide: true },
              (err, stdout) => resolve(!err && stdout ? String(stdout) : '')
            );
          } catch {
            resolve('');
          }
        });
        const match = String(out).match(/MachineGuid\s+REG_SZ\s+([^\r\n]+)/i);
        if (match && match[1]) {
          hwId = match[1].trim();
        }
      } else {
        for (const idPath of ['/etc/machine-id', '/var/lib/dbus/machine-id']) {
          try {
            const raw = await fs.promises.readFile(idPath, 'utf8');
            if (raw && raw.trim()) {
              hwId = raw.trim();
              break;
            }
          } catch {}
        }
      }
    } catch {
      // Fallback below
    }
    return finalizeMachineIdentity(hwId);
  })().finally(() => {
    inFlightMachineIdentityLookup = null;
  });

  return inFlightMachineIdentityLookup;
}

/**
 * Resolve an absolute home directory for vault fallback without ever falling back to `'.'` or `process.cwd()`.
 *
 * @param {Record<string, any>} [options]
 * @returns {string}
 */
function resolveValidatedHomeDir(options = {}) {
  const candidates = [
    options && typeof options.homedir === 'string' ? options.homedir.trim() : '',
    (() => {
      try {
        return os.homedir();
      } catch {
        return '';
      }
    })(),
    typeof process.env.HOME === 'string' ? process.env.HOME.trim() : '',
    typeof process.env.USERPROFILE === 'string' ? process.env.USERPROFILE.trim() : '',
  ];
  for (const cand of candidates) {
    if (!cand || cand === '.' || cand === '..') continue;
    if (path.isAbsolute(cand) || /^[A-Za-z]:[\\/]/.test(cand)) {
      return toHostFilesystemPath(cand);
    }
  }
  return '';
}

/**
 * Resolve the path to `tokens.json` in `userData` (or explicit test override).
 * Fail-closed: NEVER falls back to `process.cwd()` or `'.'` if no secure userData/home path can be resolved.
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

  /** @type {string} */
  let userDataPath = '';
  try {
    if (electronApp && typeof electronApp.getPath === 'function') {
      const electronUserData = electronApp.getPath('userData');
      if (typeof electronUserData === 'string' && electronUserData.trim()) {
        userDataPath = toHostFilesystemPath(electronUserData.trim());
      }
    }
  } catch {
    // Fall through to validated home directory
  }

  if (!userDataPath) {
    const safeHome = resolveValidatedHomeDir(typeof options === 'object' ? options : {});
    if (!safeHome) {
      const err = /** @type {Error & { code?: string }} */ (
        new Error('Unable to resolve secure token vault directory (refusing process.cwd() fallback)')
      );
      err.code = 'ERR_VAULT_DIR_UNRESOLVED';
      throw err;
    }
    const defaultDir = path.join(safeHome, '.one-launcher');
    const legacyDir = path.join(safeHome, '.universal-game-library');
    userDataPath =
      fs.existsSync(legacyDir) && !fs.existsSync(defaultDir) ? legacyDir : defaultDir;
  }

  if (!fs.existsSync(userDataPath)) {
    fs.mkdirSync(userDataPath, { recursive: true, mode: 0o700 });
  }
  return path.join(userDataPath, 'tokens.json');
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
 * Resolve or generate a random 256-bit per-user vault secret stored in `vault.key`.
 *
 * @param {Record<string, any>} [options]
 * @param {boolean} [createIfMissing=true]
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
 * @param {boolean} [createIfMissing=true]
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
      const oldestEntry = derivedKeyCache.get(oldestKey);
      if (oldestEntry && Buffer.isBuffer(oldestEntry.key)) {
        try {
          oldestEntry.key.fill(0);
        } catch {}
      }
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
 * @param {string} targetPath
 */
function scrubDerivedKeysForPath(targetPath) {
  const cachedSalt = vaultSaltByFileCache.get(targetPath);
  if (cachedSalt) {
    const saltHex = cachedSalt.toString('hex');
    const entry = derivedKeyCache.get(saltHex);
    if (entry && Buffer.isBuffer(entry.key)) {
      try {
        entry.key.fill(0);
      } catch {}
    }
    derivedKeyCache.delete(saltHex);
    vaultSaltByFileCache.delete(targetPath);
  }
}

function scrubAllDerivedKeys() {
  for (const entry of derivedKeyCache.values()) {
    try {
      if (entry && Buffer.isBuffer(entry.key)) {
        entry.key.fill(0);
      }
    } catch {}
  }
  derivedKeyCache.clear();
  vaultSaltByFileCache.clear();
}

/**
 * Return cached machine identity (or explicit `machineIdOverride`) synchronously WITHOUT
 * spawning any subprocess, or `null` if not yet initialized.
 *
 * @param {Record<string, any>} [options]
 * @returns {string | null}
 */
function peekCachedMachineIdentityKeyMaterial(options = {}) {
  if (options && typeof options.machineIdOverride === 'string' && options.machineIdOverride) {
    return `one-launcher-vault-v2:${options.machineIdOverride}`;
  }
  return cachedMachineIdentity;
}

module.exports = {
  DPAPI_VAULT_KEY_PREFIX,
  LEGACY_PLAIN_VAULT_KEY_PREFIX,
  LEGACY_AES256GCM_TOKEN_PREFIX,
  vaultSaltByFileCache,
  resolveSafeStorageBackend,
  isSafeStorageEncryptionActive,
  getMachineIdentityKeyMaterial,
  getMachineIdentityKeyMaterialAsync,
  peekCachedMachineIdentityKeyMaterial,
  getTokensFilePath,
  encodeVaultSecretForDisk,
  decodeVaultSecretFromDisk,
  getOrCreateVaultSecret,
  getOrCreateVaultSecretAsync,
  deriveVaultKeySync,
  deriveVaultKeyAsync,
  normalizeSaltBuffer,
  getOrInitPerFileSaltSync,
  getOrInitPerFileSaltAsync,
  scrubDerivedKeysForPath,
  scrubAllDerivedKeys,
};
