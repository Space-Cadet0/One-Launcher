// @ts-check
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const {
  toHostFilesystemPath,
  atomicWriteSecureFileSync,
  clearStoreDisconnectedTombstone,
} = require('../../launcher/securityAndPathUtils.cjs');
const {
  atomicWriteVaultFileAsync,
  runWithVaultMutex,
} = require('./vaultMutexAndAtomicIo.cjs');
const {
  LEGACY_AES256GCM_TOKEN_PREFIX,
  vaultSaltByFileCache,
  resolveSafeStorageBackend,
  isSafeStorageEncryptionActive,
  getMachineIdentityKeyMaterial,
  getMachineIdentityKeyMaterialAsync,
  peekCachedMachineIdentityKeyMaterial,
  getTokensFilePath,
  normalizeSaltBuffer,
  getOrInitPerFileSaltSync,
  getOrInitPerFileSaltAsync,
  scrubDerivedKeysForPath,
  scrubAllDerivedKeys,
} = require('./vaultKeyMaterial.cjs');
const {
  encryptTokensPayload,
  encryptTokensPayloadAsync,
  decryptTokensPayload,
  decryptTokensPayloadAsync,
  decryptLegacyV1StringSync,
  decryptLegacyV1StringAsync,
  sanitizeStorefrontTokensObject,
} = require('./vaultCrypto.cjs');

const MAX_VAULT_MEMORY_CACHE_ENTRIES = 64;

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
 * Bounded per-vault in-memory cache shared across sync and async callers so cross-storefront
 * mutations never clobber each other during `scryptAsync` and hot-path reads avoid redundant decryption.
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
 * @param {string} resolved
 * @param {VaultCacheEntry} entry
 */
function setBoundedVaultMemoryCache(resolved, entry) {
  if (vaultMemoryCache.has(resolved)) {
    vaultMemoryCache.delete(resolved);
  } else if (vaultMemoryCache.size >= MAX_VAULT_MEMORY_CACHE_ENTRIES) {
    for (const [candidateKey, candidateEntry] of vaultMemoryCache.entries()) {
      if (candidateEntry.pendingAsyncOps === 0) {
        vaultMemoryCache.delete(candidateKey);
        break;
      }
    }
  }
  vaultMemoryCache.set(resolved, entry);
}

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
 * Explicitly invalidates the in-memory vault cache (all paths or a single `tokens.json` path / options object),
 * wiping sensitive key material from `derivedKeyCache`.
 *
 * @param {string | Record<string, any>} [filePathOrOptions]
 */
function invalidateVaultMemoryCache(filePathOrOptions) {
  let targetPath = null;
  if (typeof filePathOrOptions === 'string' && filePathOrOptions.trim()) {
    targetPath = path.resolve(toHostFilesystemPath(filePathOrOptions.trim()));
  } else if (filePathOrOptions && typeof filePathOrOptions === 'object') {
    try {
      const resolvedFromOpts = getTokensFilePath(filePathOrOptions);
      if (resolvedFromOpts) {
        targetPath = path.resolve(toHostFilesystemPath(resolvedFromOpts));
      }
    } catch {}
  }

  if (targetPath) {
    vaultMemoryCache.delete(targetPath);
    scrubDerivedKeysForPath(targetPath);
    return;
  }

  scrubAllDerivedKeys();
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
 * @param {string} resolvedFilePath
 * @param {string} vaultKeyPath
 * @param {string} hwIdentity
 * @param {Record<string, any>} [options]
 * @returns {string}
 */
function buildVaultKeyContextDigest(resolvedFilePath, vaultKeyPath, hwIdentity, options = {}) {
  const secretOverride =
    options && typeof options.vaultSecretOverride === 'string' ? options.vaultSecretOverride : '';
  const ss = resolveSafeStorageBackend(options);
  const ssTag = !ss ? 'none' : isSafeStorageEncryptionActive(ss) ? 'avail' : 'unavail';
  return crypto
    .createHash('sha256')
    .update(`${resolvedFilePath}|${vaultKeyPath}|${hwIdentity}|${secretOverride}|${ssTag}`)
    .digest('hex');
}

/**
 * @param {string} resolvedFilePath
 * @param {string} vaultKeyPath
 * @param {Record<string, any>} [options]
 * @returns {string}
 */
function computeVaultKeyContextDigestSync(resolvedFilePath, vaultKeyPath, options = {}) {
  return buildVaultKeyContextDigest(
    resolvedFilePath,
    vaultKeyPath,
    getMachineIdentityKeyMaterial(options),
    options
  );
}

/**
 * @param {string} resolvedFilePath
 * @param {string} vaultKeyPath
 * @param {Record<string, any>} [options]
 * @returns {Promise<string>}
 */
async function computeVaultKeyContextDigestAsync(resolvedFilePath, vaultKeyPath, options = {}) {
  const hw = await getMachineIdentityKeyMaterialAsync(options);
  return buildVaultKeyContextDigest(resolvedFilePath, vaultKeyPath, hw, options);
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
  const keyContextDigest = computeVaultKeyContextDigestSync(resolved, vaultKeyPath, options);
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
  setBoundedVaultMemoryCache(resolved, entry);
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
      continue;
    }
    if (entry.generation > snapGen) {
      continue;
    }
    await atomicWriteVaultFileAsync(resolved, JSON.stringify(encryptedPayload, null, 2));
    entry.flushedGeneration = Math.max(entry.flushedGeneration, snapGen);
    await refreshEntryDiskStatsAsync(entry, resolved, vaultKeyPath);
  }
}

/**
 * Encrypt and atomically write OAuth tokens to disk with strict owner-only ACLs.
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
 * Async non-blocking counterpart to `writeTokensFile`.
 * Propagates disk write errors honestly and invalidates stale dirty cache on failure.
 *
 * @param {Record<string, any>} tokens
 * @param {Record<string, any>} [options]
 * @returns {Promise<void>}
 */
async function writeTokensFileAsync(tokens, options = {}) {
  const filePath = getTokensFilePath(options);
  const resolved = path.resolve(toHostFilesystemPath(filePath));
  const vaultKeyPath = path.join(path.dirname(resolved), 'vault.key');
  const cloned = cloneVaultDoc(tokens);
  const cachedHw = peekCachedMachineIdentityKeyMaterial(options);

  /** @type {VaultCacheEntry | null} */
  let optimisticEntry = null;

  if (cachedHw) {
    const syncKeyContextDigest = buildVaultKeyContextDigest(resolved, vaultKeyPath, cachedHw, options);
    const prev = vaultMemoryCache.get(resolved);
    const nextGen = prev ? prev.generation + 1 : 1;
    /** @type {VaultCacheEntry} */
    const entry = prev || {
      doc: cloned,
      hydrated: true,
      keyContextDigest: syncKeyContextDigest,
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
    entry.keyContextDigest = syncKeyContextDigest;
    entry.generation = nextGen;
    entry.pendingAsyncOps += 1;
    setBoundedVaultMemoryCache(resolved, entry);
    optimisticEntry = entry;
    emitVaultChange({ action: 'write', filePath: resolved, options });
  }

  try {
    await runWithVaultMutex(resolved, async () => {
      if (!optimisticEntry) {
        const keyContextDigest = await computeVaultKeyContextDigestAsync(
          resolved,
          vaultKeyPath,
          options
        );
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
        setBoundedVaultMemoryCache(resolved, entry);
        optimisticEntry = entry;
        emitVaultChange({ action: 'write', filePath: resolved, options });
      }
      await flushAuthoritativeVaultEntryAsync(resolved, optimisticEntry, options);
    });
  } catch (err) {
    if (
      optimisticEntry &&
      vaultMemoryCache.get(resolved) === optimisticEntry &&
      optimisticEntry.flushedGeneration < optimisticEntry.generation
    ) {
      vaultMemoryCache.delete(resolved);
    }
    throw err;
  } finally {
    if (optimisticEntry) {
      optimisticEntry.pendingAsyncOps = Math.max(0, optimisticEntry.pendingAsyncOps - 1);
    }
  }
}

/**
 * @param {Buffer} rawContent
 * @param {string} resolved
 * @param {Record<string, any>} options
 * @returns {{ success: boolean, tokens?: Record<string, any>, shouldPersist?: boolean, error?: any }}
 */
function tryDecryptVaultBufferSync(rawContent, resolved, options = {}) {
  if (!rawContent || rawContent.length === 0) {
    return { success: false };
  }

  const rawStr = rawContent.toString('utf-8').trim();
  if (rawStr.startsWith(LEGACY_AES256GCM_TOKEN_PREFIX)) {
    try {
      const dec = decryptLegacyV1StringSync(rawStr, options);
      const { cleaned } = sanitizeStorefrontTokensObject(dec, options);
      return { success: true, tokens: cleaned, shouldPersist: true };
    } catch (decErr) {
      return { success: false, error: decErr };
    }
  }

  let parsed;
  try {
    parsed = JSON.parse(rawStr);
  } catch (parseErr) {
    return { success: false, error: parseErr };
  }

  if (typeof parsed === 'string' && parsed.startsWith(LEGACY_AES256GCM_TOKEN_PREFIX)) {
    try {
      const dec = decryptLegacyV1StringSync(parsed, options);
      const { cleaned } = sanitizeStorefrontTokensObject(dec, options);
      return { success: true, tokens: cleaned, shouldPersist: true };
    } catch (decErr) {
      return { success: false, error: decErr };
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
      return {
        success: true,
        tokens: cleaned,
        shouldPersist: Boolean(modified || parsed._encrypted_v3 !== true),
      };
    } catch (decErr) {
      return { success: false, error: decErr };
    }
  }

  if (parsed && parsed._encrypted === true) {
    return { success: false, error: new Error('Unsupported legacy _encrypted format') };
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
    return {
      success: true,
      tokens: cleaned,
      shouldPersist: Boolean(Object.keys(cleaned).length > 0 || hadLegacyStoreCipher),
    };
  }

  return { success: false };
}

/**
 * @param {Buffer} rawContent
 * @param {string} resolved
 * @param {Record<string, any>} options
 * @returns {Promise<{ success: boolean, tokens?: Record<string, any>, shouldPersist?: boolean, error?: any }>}
 */
async function tryDecryptVaultBufferAsync(rawContent, resolved, options = {}) {
  if (!rawContent || rawContent.length === 0) {
    return { success: false };
  }

  const rawStr = rawContent.toString('utf-8').trim();
  if (rawStr.startsWith(LEGACY_AES256GCM_TOKEN_PREFIX)) {
    try {
      const dec = await decryptLegacyV1StringAsync(rawStr, options);
      const { cleaned } = sanitizeStorefrontTokensObject(dec, options);
      return { success: true, tokens: cleaned, shouldPersist: true };
    } catch (decErr) {
      return { success: false, error: decErr };
    }
  }

  let parsed;
  try {
    parsed = JSON.parse(rawStr);
  } catch (parseErr) {
    return { success: false, error: parseErr };
  }

  if (typeof parsed === 'string' && parsed.startsWith(LEGACY_AES256GCM_TOKEN_PREFIX)) {
    try {
      const dec = await decryptLegacyV1StringAsync(parsed, options);
      const { cleaned } = sanitizeStorefrontTokensObject(dec, options);
      return { success: true, tokens: cleaned, shouldPersist: true };
    } catch (decErr) {
      return { success: false, error: decErr };
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
      return {
        success: true,
        tokens: cleaned,
        shouldPersist: Boolean(modified || parsed._encrypted_v3 !== true),
      };
    } catch (decErr) {
      return { success: false, error: decErr };
    }
  }

  if (parsed && parsed._encrypted === true) {
    return { success: false, error: new Error('Unsupported legacy _encrypted format') };
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
    return {
      success: true,
      tokens: cleaned,
      shouldPersist: Boolean(Object.keys(cleaned).length > 0 || hadLegacyStoreCipher),
    };
  }

  return { success: false };
}

/**
 * Low-level synchronous disk reader with atomic secure `.bak` recovery fallback.
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
    setBoundedVaultMemoryCache(resolved, entry);
    return cloneVaultDoc(cloned);
  };

  const bakPath = `${resolved}.bak`;

  let primaryBuffer = null;
  if (fs.existsSync(resolved)) {
    try {
      primaryBuffer = fs.readFileSync(resolved);
    } catch {}
  }

  let result = primaryBuffer ? tryDecryptVaultBufferSync(primaryBuffer, resolved, options) : { success: false };

  if (!result.success) {
    if (result.error) {
      const msg = result.error instanceof Error ? result.error.message : String(result.error);
      console.warn('Failed to decrypt tokens payload:', msg);
    }
    if (fs.existsSync(bakPath)) {
      try {
        const bakStat = fs.statSync(bakPath);
        if (bakStat.isFile() && bakStat.size > 0) {
          const bakBuffer = fs.readFileSync(bakPath);
          const bakResult = tryDecryptVaultBufferSync(bakBuffer, resolved, options);
          if (bakResult.success && bakResult.tokens) {
            console.warn('Recovered vault tokens from .bak backup file');
            try {
              atomicWriteSecureFileSync(resolved, bakBuffer, { ...options, preserveBackup: false });
            } catch {
              try {
                persistTokensToDiskSync(resolved, bakResult.tokens, options);
              } catch {}
            }
            result = bakResult;
          }
        }
      } catch (bakErr) {
        const msg = bakErr instanceof Error ? bakErr.message : String(bakErr);
        console.warn('Failed to recover vault tokens from backup:', msg);
      }
    }
  }

  if (result.success && result.tokens) {
    if (result.shouldPersist) {
      try {
        persistTokensToDiskSync(resolved, result.tokens, options);
        return cloneVaultDoc(result.tokens);
      } catch {}
    }
    return storeCacheResult(result.tokens);
  }

  return storeCacheResult({});
}

/**
 * Load and decrypt saved storefront tokens.
 *
 * @param {Record<string, any>} [options]
 * @returns {Record<string, any>}
 */
function loadSavedTokens(options = {}) {
  try {
    const filePath = getTokensFilePath(options);
    const resolved = path.resolve(toHostFilesystemPath(filePath));
    const vaultKeyPath = path.join(path.dirname(resolved), 'vault.key');
    const keyContextDigest = computeVaultKeyContextDigestSync(resolved, vaultKeyPath, options);
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
 * Internal unlocked async reader invoked inside `runWithVaultMutex` with atomic `.bak` recovery.
 *
 * @param {string} filePath
 * @param {Record<string, any>} [options]
 * @returns {Promise<Record<string, any>>}
 */
async function readTokensUnlockedAsync(filePath, options = {}) {
  const resolved = path.resolve(toHostFilesystemPath(filePath));
  const vaultKeyPath = path.join(path.dirname(resolved), 'vault.key');
  const keyContextDigest = await computeVaultKeyContextDigestAsync(resolved, vaultKeyPath, options);

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
    const liveEntry = vaultMemoryCache.get(resolved);
    if (
      liveEntry &&
      liveEntry !== existingEntry &&
      liveEntry.hydrated &&
      liveEntry.keyContextDigest === keyContextDigest
    ) {
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
      setBoundedVaultMemoryCache(resolved, entry);
      await flushAuthoritativeVaultEntryAsync(resolved, entry, options);
    } else {
      entry.flushedGeneration = nextGen;
      await refreshEntryDiskStatsAsync(entry, resolved, vaultKeyPath);
      setBoundedVaultMemoryCache(resolved, entry);
    }
    return cloneVaultDoc(entry.doc);
  };

  const bakPath = `${resolved}.bak`;

  let primaryBuffer = null;
  try {
    primaryBuffer = await fs.promises.readFile(resolved);
  } catch {}

  let result = primaryBuffer
    ? await tryDecryptVaultBufferAsync(primaryBuffer, resolved, options)
    : { success: false };

  if (!result.success) {
    if (result.error) {
      const msg = result.error instanceof Error ? result.error.message : String(result.error);
      console.warn('Failed to decrypt tokens payload:', msg);
    }
    try {
      const bakStat = await fs.promises.stat(bakPath).catch(() => null);
      if (bakStat && bakStat.isFile() && bakStat.size > 0) {
        const bakBuffer = await fs.promises.readFile(bakPath);
        const bakResult = await tryDecryptVaultBufferAsync(bakBuffer, resolved, options);
        if (bakResult.success && bakResult.tokens) {
          console.warn('Recovered vault tokens from .bak backup file');
          try {
            await atomicWriteVaultFileAsync(resolved, bakBuffer, { preserveBackup: false });
          } catch {}
          result = bakResult;
        }
      }
    } catch (bakErr) {
      const msg = bakErr instanceof Error ? bakErr.message : String(bakErr);
      console.warn('Failed to recover vault tokens from backup:', msg);
    }
  }

  if (result.success && result.tokens) {
    return finalizeReadResultAsync(result.tokens, Boolean(result.shouldPersist));
  }

  return finalizeReadResultAsync({}, false);
}

/**
 * Async non-blocking counterpart to `loadSavedTokens`.
 *
 * @param {Record<string, any>} [options]
 * @returns {Promise<Record<string, any>>}
 */
async function loadSavedTokensAsync(options = {}) {
  const filePath = getTokensFilePath(options);
  const resolved = path.resolve(toHostFilesystemPath(filePath));
  const vaultKeyPath = path.join(path.dirname(resolved), 'vault.key');
  const keyContextDigest = await computeVaultKeyContextDigestAsync(resolved, vaultKeyPath, options);
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
 * Synchronously merge and persist storefront credentials, propagating disk write errors honestly.
 *
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
    throw err;
  }
}

/**
 * Serialized, non-blocking async read-modify-write for storefront credentials.
 * Propagates disk write errors honestly and invalidates stale dirty cache on failure.
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

  const cachedHw = peekCachedMachineIdentityKeyMaterial(options);
  let optimisticEntry = vaultMemoryCache.get(resolved);
  let appliedOptimistically = false;

  // Synchronous optimistic merge ONLY when machine identity is already in memory (zero `await`
  // before mutating `vaultMemoryCache`, so 50+ parallel callers merge cleanly without clobbering!).
  if (cachedHw) {
    const syncKeyContextDigest = buildVaultKeyContextDigest(resolved, vaultKeyPath, cachedHw, options);
    if (isVaultCacheEntryValidSync(optimisticEntry, resolved, vaultKeyPath, syncKeyContextDigest)) {
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
        keyContextDigest: syncKeyContextDigest,
        pendingAsyncOps: 1,
        generation: 1,
        flushedGeneration: 0,
        tokensExists: false,
        tokensMtimeMs: 0,
        tokensSize: 0,
        vaultKeyExists: false,
        vaultKeyMtimeMs: 0,
      };
      setBoundedVaultMemoryCache(resolved, createdEntry);
      optimisticEntry = createdEntry;
      appliedOptimistically = true;
      emitVaultChange({ action: 'save', storefrontId, filePath: resolved, options });
    }
  }

  try {
    await runWithVaultMutex(resolved, async () => {
      try {
        if (!appliedOptimistically) {
          const keyContextDigest = await computeVaultKeyContextDigestAsync(
            resolved,
            vaultKeyPath,
            options
          );
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
            setBoundedVaultMemoryCache(resolved, entry);
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
        if (optimisticEntry && optimisticEntry.flushedGeneration < optimisticEntry.generation) {
          vaultMemoryCache.delete(resolved);
        }
        const msg = err instanceof Error ? err.message : String(err);
        console.warn('Failed to save tokens:', msg);
        throw err;
      }
    });
  } finally {
    if (appliedOptimistically && optimisticEntry) {
      optimisticEntry.pendingAsyncOps = Math.max(0, optimisticEntry.pendingAsyncOps - 1);
    }
  }
}

/**
 * Synchronously clear credentials for a storefront, propagating disk write errors honestly.
 *
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
    throw err;
  }
}

/**
 * Serialized, non-blocking async counterpart to `clearTokens`.
 * Emits `vaultChange` at most once and propagates disk write errors honestly.
 *
 * @param {string} storefrontId
 * @param {Record<string, any>} [options]
 * @returns {Promise<void>}
 */
async function clearTokensAsync(storefrontId, options = {}) {
  const filePath = getTokensFilePath(options);
  const resolved = path.resolve(toHostFilesystemPath(filePath));
  const vaultKeyPath = path.join(path.dirname(resolved), 'vault.key');

  const cachedHw = peekCachedMachineIdentityKeyMaterial(options);
  let optimisticEntry = vaultMemoryCache.get(resolved);
  let appliedOptimistically = false;
  let emittedChange = false;
  if (cachedHw) {
    const syncKeyContextDigest = buildVaultKeyContextDigest(resolved, vaultKeyPath, cachedHw, options);
    if (isVaultCacheEntryValidSync(optimisticEntry, resolved, vaultKeyPath, syncKeyContextDigest)) {
      const entry = /** @type {VaultCacheEntry} */ (optimisticEntry);
      if (entry.doc[storefrontId]) {
        delete entry.doc[storefrontId];
        entry.generation += 1;
        entry.pendingAsyncOps += 1;
        appliedOptimistically = true;
      }
      emitVaultChange({ action: 'clear', storefrontId, filePath: resolved, options });
      emittedChange = true;
    }
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
          if (!emittedChange) {
            emitVaultChange({ action: 'clear', storefrontId, filePath: resolved, options });
            emittedChange = true;
          }
        }

        const activeEntry = vaultMemoryCache.get(resolved);
        if (activeEntry && activeEntry.flushedGeneration < activeEntry.generation) {
          await flushAuthoritativeVaultEntryAsync(resolved, activeEntry, options);
        }
      } catch (err) {
        if (optimisticEntry && optimisticEntry.flushedGeneration < optimisticEntry.generation) {
          vaultMemoryCache.delete(resolved);
        }
        const msg = err instanceof Error ? err.message : String(err);
        console.warn('Failed to clear tokens:', msg);
        throw err;
      }
    });
  } finally {
    if (appliedOptimistically && optimisticEntry) {
      optimisticEntry.pendingAsyncOps = Math.max(0, optimisticEntry.pendingAsyncOps - 1);
    }
  }
}

/**
 * Canonical contract interface: persists tokens for a specific store and accountId.
 *
 * @param {string} store
 * @param {string | Record<string, any>} [accountId]
 * @param {Record<string, any>} [tokenData]
 * @param {Record<string, any>} [options]
 * @returns {Promise<void>}
 */
async function storeToken(store, accountId, tokenData, options = {}) {
  let effectiveAccountId = accountId;
  let effectiveTokenData = tokenData;
  const effectiveOptions = options;
  if (accountId && typeof accountId === 'object' && tokenData === undefined) {
    effectiveTokenData = accountId;
    effectiveAccountId = undefined;
  }
  if (!store || typeof store !== 'string') {
    throw new TypeError('Store identifier must be a non-empty string');
  }
  const payload =
    effectiveAccountId && typeof effectiveAccountId === 'string'
      ? { ...(effectiveTokenData || {}), accountId: effectiveAccountId }
      : { ...(effectiveTokenData || {}) };
  await saveTokensAsync(store, payload, effectiveOptions);
}

/**
 * Canonical contract interface: retrieves saved tokens for a specific store and optional accountId.
 *
 * @param {string} store
 * @param {string | Record<string, any>} [accountId]
 * @param {Record<string, any>} [options]
 * @returns {Promise<Record<string, any> | null>}
 */
async function retrieveToken(store, accountId, options = {}) {
  let effectiveAccountId = accountId;
  let effectiveOptions = options;
  if (
    accountId &&
    typeof accountId === 'object' &&
    (!options || Object.keys(options).length === 0)
  ) {
    effectiveOptions = accountId;
    effectiveAccountId = undefined;
  }
  if (!store || typeof store !== 'string') return null;
  const allTokens = await loadSavedTokensAsync(effectiveOptions);
  if (!allTokens || typeof allTokens !== 'object') return null;
  const storeEntry = allTokens[store];
  if (!storeEntry || typeof storeEntry !== 'object') return null;
  if (effectiveAccountId && typeof effectiveAccountId === 'string') {
    if (storeEntry.accountId !== effectiveAccountId) {
      return null;
    }
  }
  return cloneVaultDoc(storeEntry);
}

/**
 * Canonical contract interface: deletes saved tokens for a specific store and optional accountId.
 *
 * @param {string} store
 * @param {string | Record<string, any>} [accountId]
 * @param {Record<string, any>} [options]
 * @returns {Promise<boolean>}
 */
async function deleteToken(store, accountId, options = {}) {
  let effectiveAccountId = accountId;
  let effectiveOptions = options;
  if (
    accountId &&
    typeof accountId === 'object' &&
    (!options || Object.keys(options).length === 0)
  ) {
    effectiveOptions = accountId;
    effectiveAccountId = undefined;
  }
  if (!store || typeof store !== 'string') return false;
  const allTokens = await loadSavedTokensAsync(effectiveOptions);
  if (!allTokens || typeof allTokens !== 'object' || !allTokens[store]) {
    return false;
  }
  if (effectiveAccountId && typeof effectiveAccountId === 'string') {
    const entry = allTokens[store];
    if (!entry || typeof entry !== 'object' || entry.accountId !== effectiveAccountId) {
      return false;
    }
  }
  await clearTokensAsync(store, effectiveOptions);
  return true;
}

module.exports = {
  onVaultChange,
  invalidateVaultMemoryCache,
  writeTokensFile,
  writeTokensFileAsync,
  loadSavedTokens,
  loadSavedTokensAsync,
  saveTokens,
  saveTokensAsync,
  clearTokens,
  clearTokensAsync,
  storeToken,
  retrieveToken,
  deleteToken,
};
