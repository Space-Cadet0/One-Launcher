// @ts-check
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { sanitizeRendererIpcOptions } = require('../launcher/launchApprovalIpc.cjs');
const {
  atomicWriteFileSync,
  resolveEffectiveUserDataDir,
  toHostFilesystemPath,
} = require('../../launcher/securityAndPathUtils.cjs');

const MAX_USER_OVERRIDES_FILE_BYTES = 2 * 1024 * 1024;
const MAX_USER_TAG_LENGTH = 64;
const MAX_USER_TAGS_PER_ARRAY = 100;
const MAX_USER_TAG_PLATFORM_ALIASES = 50;
const MAX_USER_TAG_OVERRIDES_PAYLOAD_BYTES = 2 * 1024 * 1024;

/**
 * Deep-clone a JSON-safe override map so callers can never mutate cached in-memory state.
 *
 * @template T
 * @param {T} value
 * @returns {T}
 */
function deepCloneOverridesMap(value) {
  try {
    return structuredClone(value);
  } catch {
    return JSON.parse(JSON.stringify(value));
  }
}

/** @type {Map<string, { mtimeMs: number, size: number, overrides: Record<string, Record<string, any>> }>} */
const userOverridesMemoryCache = new Map();
/** @type {Map<string, Promise<any>>} */
const userOverridesWriteQueues = new Map();
let userOverridesTmpSeq = 0;

/**
 * @typedef {{
 *   gameId: string,
 *   platformAliases?: string[],
 *   addedTags: string[],
 *   removedTags: string[],
 *   updatedAt: string,
 * }} SanitizedUserTagOverrideRecord
 */

/** @type {Map<string, { mtimeMs: number, size: number, overrides: Record<string, SanitizedUserTagOverrideRecord> }>} */
const userTagOverridesMemoryCache = new Map();
/** @type {Map<string, Promise<any>>} */
const userTagOverridesWriteQueue = new Map();
let userTagOverridesTmpSeq = 0;

/**
 * Evict both in-memory user-override and user-tag-override caches (invoked on `perf:trim-memory`).
 */
function trimUserOverridesCache() {
  userOverridesMemoryCache.clear();
  userTagOverridesMemoryCache.clear();
}

/**
 * Resolve the atomic persistence path for `user_overrides.json`.
 * @param {any} offlineVaultService
 * @param {string | undefined} explicitUserDataDir
 * @returns {string}
 */
function resolveUserOverridesFilePath(offlineVaultService, explicitUserDataDir) {
  if (typeof explicitUserDataDir === 'string' && explicitUserDataDir.trim()) {
    return path.join(explicitUserDataDir.trim(), 'user_overrides.json');
  }
  if (typeof offlineVaultService?.userDataDir === 'string' && offlineVaultService.userDataDir.trim()) {
    return path.join(offlineVaultService.userDataDir.trim(), 'user_overrides.json');
  }
  if (typeof offlineVaultService?.vaultDir === 'string' && offlineVaultService.vaultDir.trim()) {
    return path.join(path.dirname(offlineVaultService.vaultDir.trim()), 'user_overrides.json');
  }
  return path.join(resolveEffectiveUserDataDir(), 'user_overrides.json');
}

/**
 * Validate a `gameId` key for user override storage.
 * @param {unknown} rawGameId
 * @returns {string}
 */
function normalizeSafeOverrideGameId(rawGameId) {
  if (typeof rawGameId !== 'string') return '';
  const trimmed = rawGameId.trim();
  if (
    !trimmed ||
    trimmed.length > 256 ||
    trimmed.includes('\0') ||
    trimmed === '__proto__' ||
    trimmed === 'constructor' ||
    trimmed === 'prototype'
  ) {
    return '';
  }
  return trimmed;
}

/**
 * Normalizes a `(platformId, platformGameId)` pair for cross-key override deduplication.
 * @param {unknown} rawPlatformId
 * @param {unknown} rawPlatformGameId
 * @returns {{ platformId: string, platformGameId: string } | null}
 */
function normalizeEntitlementPair(rawPlatformId, rawPlatformGameId) {
  const platformId = typeof rawPlatformId === 'string' ? rawPlatformId.trim().toLowerCase() : '';
  const rawPid =
    typeof rawPlatformGameId === 'string' || typeof rawPlatformGameId === 'number'
      ? String(rawPlatformGameId).trim()
      : '';
  if (!platformId || !rawPid) return null;
  const platformGameId =
    platformId === 'xbox' && /^[A-Z0-9]{12}$/i.test(rawPid) ? rawPid.toUpperCase() : rawPid;
  return { platformId, platformGameId };
}

/**
 * Extracts the underlying storefront `(platformId, platformGameId)` entitlement identity from
 * an override map key and record.
 *
 * @param {string} key
 * @param {Record<string, any> | null | undefined} ov
 * @returns {{ platformId: string, platformGameId: string } | null}
 */
function extractOverrideEntitlementPair(key, ov) {
  if (ov && typeof ov === 'object') {
    const explicit = normalizeEntitlementPair(ov.platformId, ov.platformGameId);
    if (explicit) return explicit;
  }

  const candidateIds = [key, typeof ov?.gameId === 'string' ? ov.gameId : ''];
  for (const cid of candidateIds) {
    if (!cid) continue;
    const nonSteamPrefix = cid.match(/^(gog|epic|xbox|ea|ubisoft|local)[:_-](.+)$/i);
    if (nonSteamPrefix) {
      const pair = normalizeEntitlementPair(nonSteamPrefix[1], nonSteamPrefix[2]);
      if (pair) return pair;
    }
  }

  if (ov && typeof ov === 'object') {
    const mStore = typeof ov.matchedStore === 'string' ? ov.matchedStore.trim().toLowerCase() : '';
    if (mStore && mStore !== 'steam' && ov.matchedId != null) {
      const legacyMatched = normalizeEntitlementPair(mStore, ov.matchedId);
      if (legacyMatched) return legacyMatched;
    }
  }

  for (const cid of candidateIds) {
    if (!cid) continue;
    const steamPrefix = cid.match(/^steam[:_-](\d+)$/i);
    if (steamPrefix) {
      return normalizeEntitlementPair('steam', steamPrefix[1]);
    }
  }

  return null;
}

/**
 * Adds a safe override key and its `:`, `-`, and `_` storefront separator variants to `targetSet`.
 * @param {Set<string>} targetSet
 * @param {unknown} rawKey
 */
function addOverrideKeyVariants(targetSet, rawKey) {
  const safe = normalizeSafeOverrideGameId(rawKey);
  if (!safe) return;
  targetSet.add(safe);
  const match = safe.match(/^(steam|gog|epic|xbox|ea|ubisoft|local)[:_-](.+)$/i);
  if (match) {
    const prefix = match[1].toLowerCase();
    const rest = match[2].trim();
    if (rest) {
      targetSet.add(`${prefix}:${rest}`);
      targetSet.add(`${prefix}-${rest}`);
      targetSet.add(`${prefix}_${rest}`);
      if (prefix === 'xbox' && /^[A-Z0-9]{12}$/i.test(rest)) {
        const up = rest.toUpperCase();
        const lo = rest.toLowerCase();
        targetSet.add(`xbox:${up}`);
        targetSet.add(`xbox:${lo}`);
        targetSet.add(`xbox-${up}`);
        targetSet.add(`xbox-${lo}`);
        targetSet.add(`xbox_${up}`);
        targetSet.add(`xbox_${lo}`);
      }
    }
  }
}

/**
 * Extracts positive numeric Steam App IDs referenced by an override key or record.
 * @param {string} key
 * @param {Record<string, any> | null | undefined} ov
 * @returns {number[]}
 */
function extractLinkedSteamAppIds(key, ov) {
  /** @type {Set<number>} */
  const ids = new Set();
  const addCandidate = (/** @type {unknown} */ val) => {
    if (typeof val === 'number' && Number.isInteger(val) && val > 0) {
      ids.add(val);
    } else if (typeof val === 'string' && /^\d+$/.test(val.trim())) {
      const parsed = parseInt(val.trim(), 10);
      if (parsed > 0) ids.add(parsed);
    }
  };

  const keyMatch = String(key || '').match(/^steam[:_-](\d+)$/i);
  if (keyMatch) addCandidate(keyMatch[1]);

  if (ov && typeof ov === 'object') {
    const gidMatch = String(ov.gameId || '').match(/^steam[:_-](\d+)$/i);
    if (gidMatch) addCandidate(gidMatch[1]);
    addCandidate(ov.steamAppId);
    if (String(ov.matchedStore || '').trim().toLowerCase() === 'steam') {
      addCandidate(ov.matchedId);
    }
  }

  return Array.from(ids);
}

/**
 * Parse and sanitize raw JSON text from `user_overrides.json` with a 2 MB byte cap.
 * @param {string} rawText
 * @returns {Record<string, Record<string, any>>}
 */
function parseSanitizedUserOverridesJson(rawText) {
  if (
    typeof rawText !== 'string' ||
    Buffer.byteLength(rawText, 'utf8') > MAX_USER_OVERRIDES_FILE_BYTES
  ) {
    return {};
  }
  const parsed = JSON.parse(rawText);
  const rawMap =
    parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed.overrides && typeof parsed.overrides === 'object' && !Array.isArray(parsed.overrides)
        ? parsed.overrides
        : parsed
      : {};
  /** @type {Record<string, Record<string, any>>} */
  const cleanMap = {};
  for (const [k, v] of Object.entries(rawMap)) {
    const safeKey = normalizeSafeOverrideGameId(k);
    if (!safeKey) continue;
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      cleanMap[safeKey] = sanitizeRendererIpcOptions(v);
    }
  }
  return cleanMap;
}

/**
 * Read durable user metadata/artwork overrides map synchronously from `userData/user_overrides.json`.
 * Enforces a 2 MB file size cap, `mtimeMs + size` cache validation, and deep-cloned returns.
 *
 * @param {string} filePath
 * @returns {Record<string, Record<string, any>>}
 */
function readUserOverridesFromDisk(filePath) {
  const hostFilePath = toHostFilesystemPath(filePath);
  try {
    if (!fs.existsSync(hostFilePath)) {
      userOverridesMemoryCache.delete(hostFilePath);
      return {};
    }
    const stat = fs.statSync(hostFilePath);
    if (!stat.isFile() || stat.size > MAX_USER_OVERRIDES_FILE_BYTES) {
      userOverridesMemoryCache.delete(hostFilePath);
      return {};
    }
    const cached = userOverridesMemoryCache.get(hostFilePath);
    if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
      return deepCloneOverridesMap(cached.overrides);
    }
    const cleanMap = parseSanitizedUserOverridesJson(fs.readFileSync(hostFilePath, 'utf8'));
    userOverridesMemoryCache.set(hostFilePath, {
      mtimeMs: stat.mtimeMs,
      size: stat.size,
      overrides: deepCloneOverridesMap(cleanMap),
    });
    return deepCloneOverridesMap(cleanMap);
  } catch {
    return {};
  }
}

/**
 * Read durable user metadata/artwork overrides map asynchronously with 2 MB cap,
 * `mtimeMs + size` cache validation, and deep-cloned returns.
 *
 * @param {string} filePath
 * @returns {Promise<Record<string, Record<string, any>>>}
 */
async function readUserOverridesAsync(filePath) {
  const hostFilePath = toHostFilesystemPath(filePath);
  try {
    let stat = null;
    try {
      stat = await fs.promises.stat(hostFilePath);
    } catch {
      stat = null;
    }
    if (!stat || !stat.isFile() || stat.size > MAX_USER_OVERRIDES_FILE_BYTES) {
      userOverridesMemoryCache.delete(hostFilePath);
      return {};
    }
    const cached = userOverridesMemoryCache.get(hostFilePath);
    if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
      return deepCloneOverridesMap(cached.overrides);
    }
    const rawText = await fs.promises.readFile(hostFilePath, 'utf8');
    const cleanMap = parseSanitizedUserOverridesJson(rawText);
    userOverridesMemoryCache.set(hostFilePath, {
      mtimeMs: stat.mtimeMs,
      size: stat.size,
      overrides: deepCloneOverridesMap(cleanMap),
    });
    return deepCloneOverridesMap(cleanMap);
  } catch {
    return {};
  }
}

/**
 * Enqueue a serialized async read/write task per resolved `user_overrides.json` path so concurrent
 * IPC mutations never race on `.tmp` files or clobber sibling keys.
 *
 * @template T
 * @param {string} filePath
 * @param {(hostFilePath: string) => Promise<T>} taskFn
 * @returns {Promise<T>}
 */
function enqueueUserOverridesTask(filePath, taskFn) {
  const hostFilePath = toHostFilesystemPath(filePath);
  const prev = userOverridesWriteQueues.get(hostFilePath) || Promise.resolve();
  const next = prev.catch(() => {}).then(() => taskFn(hostFilePath));
  const tracked = next.catch(() => {}).finally(() => {
    if (userOverridesWriteQueues.get(hostFilePath) === tracked) {
      userOverridesWriteQueues.delete(hostFilePath);
    }
  });
  userOverridesWriteQueues.set(hostFilePath, tracked);
  return next;
}

/**
 * Internal atomic async writer for `user_overrides.json` with 2 MB cap and bounded Windows
 * `EPERM`/`EACCES`/`EBUSY` rename retry backoff (`15ms -> 40ms -> 80ms`).
 *
 * @param {string} hostFilePath
 * @param {Record<string, Record<string, any>>} nextOverrides
 * @param {string} [updatedAt]
 * @returns {Promise<void>}
 */
async function performAtomicUserOverridesWriteAsync(hostFilePath, nextOverrides, updatedAt) {
  const effectiveUpdatedAt = updatedAt || new Date().toISOString();
  const serialized = JSON.stringify(
    { overrides: nextOverrides, updatedAt: effectiveUpdatedAt },
    null,
    2
  );
  if (Buffer.byteLength(serialized, 'utf8') > MAX_USER_OVERRIDES_FILE_BYTES) {
    throw new Error('User overrides payload exceeds 2 MB limit.');
  }
  const dir = path.dirname(hostFilePath);
  await fs.promises.mkdir(dir, { recursive: true });
  const tmpPath = `${hostFilePath}.${process.pid}.${++userOverridesTmpSeq}.tmp`;
  const retryDelaysMs = [15, 40, 80];

  try {
    await fs.promises.writeFile(tmpPath, serialized, 'utf8');
    let renamed = false;
    let lastRenameErr = null;
    for (let attempt = 0; attempt <= retryDelaysMs.length; attempt++) {
      try {
        await fs.promises.rename(tmpPath, hostFilePath);
        renamed = true;
        break;
      } catch (renErr) {
        lastRenameErr = renErr;
        const code = String(/** @type {any} */ (renErr)?.code || '').toUpperCase();
        const isRetryableLock = code === 'EPERM' || code === 'EACCES' || code === 'EBUSY';
        if (!isRetryableLock || attempt >= retryDelaysMs.length) {
          break;
        }
        const delayMs = retryDelaysMs[attempt];
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }
    if (!renamed) {
      throw lastRenameErr || new Error('Failed to rename user_overrides temporary file');
    }
  } catch (err) {
    try {
      await fs.promises.unlink(tmpPath);
    } catch {}
    if (
      err &&
      typeof err === 'object' &&
      String(/** @type {any} */ (err).message || '').includes('2 MB limit')
    ) {
      throw err;
    }
    atomicWriteFileSync(hostFilePath, serialized);
  }

  try {
    const postStat = await fs.promises.stat(hostFilePath);
    userOverridesMemoryCache.set(hostFilePath, {
      mtimeMs: postStat.mtimeMs,
      size: postStat.size,
      overrides: deepCloneOverridesMap(nextOverrides),
    });
  } catch {
    userOverridesMemoryCache.delete(hostFilePath);
  }
}

/**
 * Serialized async atomic writer for `user_overrides.json`.
 *
 * @param {string} filePath
 * @param {Record<string, Record<string, any>>} nextOverrides
 * @param {string} [updatedAt]
 * @returns {Promise<void>}
 */
function writeUserOverridesToDiskAsync(filePath, nextOverrides, updatedAt) {
  return enqueueUserOverridesTask(filePath, (hostFilePath) =>
    performAtomicUserOverridesWriteAsync(hostFilePath, nextOverrides, updatedAt)
  );
}

/**
 * Resolve the atomic persistence path for `user_tag_overrides.json`.
 *
 * @param {any} offlineVaultService
 * @param {string | undefined} explicitUserDataDir
 * @returns {string}
 */
function resolveUserTagOverridesFilePath(offlineVaultService, explicitUserDataDir) {
  if (typeof explicitUserDataDir === 'string' && explicitUserDataDir.trim()) {
    return path.join(explicitUserDataDir.trim(), 'user_tag_overrides.json');
  }
  if (typeof offlineVaultService?.userDataDir === 'string' && offlineVaultService.userDataDir.trim()) {
    return path.join(offlineVaultService.userDataDir.trim(), 'user_tag_overrides.json');
  }
  if (typeof offlineVaultService?.vaultDir === 'string' && offlineVaultService.vaultDir.trim()) {
    return path.join(path.dirname(offlineVaultService.vaultDir.trim()), 'user_tag_overrides.json');
  }
  return path.join(resolveEffectiveUserDataDir(), 'user_tag_overrides.json');
}

/**
 * Sanitize a single tag label: strip ASCII control chars, collapse whitespace, clamp to 64 chars.
 * @param {unknown} rawTag
 * @returns {string}
 */
function sanitizeUserTagValue(rawTag) {
  if (typeof rawTag !== 'string') return '';
  return rawTag
    .replace(/[\x00-\x1f\x7f]+/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_USER_TAG_LENGTH)
    .trim();
}

/**
 * Sanitize an array of tag labels (strings only, case-insensitive dedupe, capped at 100 entries).
 * @param {unknown} rawList
 * @returns {string[]}
 */
function sanitizeUserTagArray(rawList) {
  if (!Array.isArray(rawList)) return [];
  /** @type {string[]} */
  const out = [];
  /** @type {Set<string>} */
  const seen = new Set();
  for (const item of rawList) {
    if (out.length >= MAX_USER_TAGS_PER_ARRAY) break;
    const clean = sanitizeUserTagValue(item);
    if (!clean) continue;
    const key = clean.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(clean);
  }
  return out;
}

/**
 * Sanitize platform alias identifiers (`steam:<appId>`, `<platformId>:<platformGameId>`), capped at 50.
 * @param {unknown} rawAliases
 * @returns {string[]}
 */
function sanitizeUserTagAliases(rawAliases) {
  if (!Array.isArray(rawAliases)) return [];
  /** @type {string[]} */
  const out = [];
  /** @type {Set<string>} */
  const seen = new Set();
  for (const item of rawAliases) {
    if (out.length >= MAX_USER_TAG_PLATFORM_ALIASES) break;
    if (typeof item !== 'string') continue;
    const stripped = item.replace(/[\x00-\x1f\x7f]+/g, '').trim();
    const safeAlias = normalizeSafeOverrideGameId(stripped);
    if (!safeAlias || seen.has(safeAlias)) continue;
    seen.add(safeAlias);
    out.push(safeAlias);
  }
  return out;
}

/**
 * Validate and sanitize a `UserTagOverride` record.
 * @param {unknown} rawGameId
 * @param {any} rawRecord
 * @param {string} [fallbackIso]
 * @returns {SanitizedUserTagOverrideRecord | null}
 */
function sanitizeUserTagOverrideRecord(rawGameId, rawRecord, fallbackIso) {
  const gameId = normalizeSafeOverrideGameId(
    rawGameId || (rawRecord && typeof rawRecord === 'object' ? rawRecord.gameId : '')
  );
  if (!gameId || !rawRecord || typeof rawRecord !== 'object' || Array.isArray(rawRecord)) {
    return null;
  }
  const addedTags = sanitizeUserTagArray(rawRecord.addedTags);
  const addedKeys = new Set(addedTags.map((t) => t.toLowerCase()));
  const removedTags = sanitizeUserTagArray(rawRecord.removedTags).filter(
    (t) => !addedKeys.has(t.toLowerCase())
  );
  const platformAliases = sanitizeUserTagAliases(rawRecord.platformAliases);
  const rawUpdated = typeof rawRecord.updatedAt === 'string' ? rawRecord.updatedAt.trim() : '';
  const updatedAt = Number.isFinite(Date.parse(rawUpdated))
    ? rawUpdated
    : fallbackIso || new Date().toISOString();

  /** @type {SanitizedUserTagOverrideRecord} */
  return {
    gameId,
    ...(platformAliases.length > 0 ? { platformAliases } : {}),
    addedTags,
    removedTags,
    updatedAt,
  };
}

/**
 * Parse and sanitize raw JSON text from `user_tag_overrides.json`.
 * @param {string} rawText
 * @returns {Record<string, SanitizedUserTagOverrideRecord>}
 */
function parseSanitizedUserTagOverridesJson(rawText) {
  if (
    typeof rawText !== 'string' ||
    Buffer.byteLength(rawText, 'utf8') > MAX_USER_TAG_OVERRIDES_PAYLOAD_BYTES * 2
  ) {
    return {};
  }
  const parsed = JSON.parse(rawText);
  const rawMap =
    parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed.overrides && typeof parsed.overrides === 'object' && !Array.isArray(parsed.overrides)
        ? parsed.overrides
        : parsed
      : {};
  /** @type {Record<string, SanitizedUserTagOverrideRecord>} */
  const cleanMap = {};
  for (const [k, v] of Object.entries(rawMap)) {
    const safeKey = normalizeSafeOverrideGameId(k);
    if (!safeKey) continue;
    const sanitized = sanitizeUserTagOverrideRecord(safeKey, v);
    if (!sanitized) continue;
    if (sanitized.addedTags.length === 0 && sanitized.removedTags.length === 0) continue;
    cleanMap[safeKey] = sanitized;
  }
  return cleanMap;
}

/**
 * Read durable user tag overrides map synchronously from `userData/user_tag_overrides.json`.
 * @param {string} filePath
 * @returns {Record<string, SanitizedUserTagOverrideRecord>}
 */
function readUserTagOverridesFromDisk(filePath) {
  const hostFilePath = toHostFilesystemPath(filePath);
  try {
    if (!fs.existsSync(hostFilePath)) {
      userTagOverridesMemoryCache.delete(hostFilePath);
      return {};
    }
    const stat = fs.statSync(hostFilePath);
    if (!stat.isFile() || stat.size > MAX_USER_TAG_OVERRIDES_PAYLOAD_BYTES * 2) {
      userTagOverridesMemoryCache.delete(hostFilePath);
      return {};
    }
    const cached = userTagOverridesMemoryCache.get(hostFilePath);
    if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
      return deepCloneOverridesMap(cached.overrides);
    }
    const cleanMap = parseSanitizedUserTagOverridesJson(fs.readFileSync(hostFilePath, 'utf8'));
    userTagOverridesMemoryCache.set(hostFilePath, {
      mtimeMs: stat.mtimeMs,
      size: stat.size,
      overrides: deepCloneOverridesMap(cleanMap),
    });
    return deepCloneOverridesMap(cleanMap);
  } catch {
    return {};
  }
}

/**
 * Read durable user tag overrides map asynchronously with `mtimeMs + size` validation and deep clone.
 * @param {string} filePath
 * @returns {Promise<Record<string, SanitizedUserTagOverrideRecord>>}
 */
async function readUserTagOverridesAsync(filePath) {
  const hostFilePath = toHostFilesystemPath(filePath);
  try {
    let stat = null;
    try {
      stat = await fs.promises.stat(hostFilePath);
    } catch {
      stat = null;
    }
    if (!stat || !stat.isFile() || stat.size > MAX_USER_TAG_OVERRIDES_PAYLOAD_BYTES * 2) {
      userTagOverridesMemoryCache.delete(hostFilePath);
      return {};
    }
    const cached = userTagOverridesMemoryCache.get(hostFilePath);
    if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
      return deepCloneOverridesMap(cached.overrides);
    }
    const rawText = await fs.promises.readFile(hostFilePath, 'utf8');
    const cleanMap = parseSanitizedUserTagOverridesJson(rawText);
    userTagOverridesMemoryCache.set(hostFilePath, {
      mtimeMs: stat.mtimeMs,
      size: stat.size,
      overrides: deepCloneOverridesMap(cleanMap),
    });
    return deepCloneOverridesMap(cleanMap);
  } catch {
    return {};
  }
}

/**
 * Enqueue a serialized async read/write task per resolved `user_tag_overrides.json` path.
 *
 * @template T
 * @param {string} filePath
 * @param {(hostFilePath: string) => Promise<T>} taskFn
 * @returns {Promise<T>}
 */
function enqueueUserTagOverridesTask(filePath, taskFn) {
  const hostFilePath = toHostFilesystemPath(filePath);
  const prev = userTagOverridesWriteQueue.get(hostFilePath) || Promise.resolve();
  const next = prev.catch(() => {}).then(() => taskFn(hostFilePath));
  const tracked = next.catch(() => {}).finally(() => {
    if (userTagOverridesWriteQueue.get(hostFilePath) === tracked) {
      userTagOverridesWriteQueue.delete(hostFilePath);
    }
  });
  userTagOverridesWriteQueue.set(hostFilePath, tracked);
  return next;
}

/**
 * Internal atomic async writer for `user_tag_overrides.json` with strict 2 MB payload cap.
 *
 * @param {string} hostFilePath
 * @param {Record<string, SanitizedUserTagOverrideRecord>} nextOverrides
 * @param {string} [updatedAt]
 * @returns {Promise<void>}
 */
async function performAtomicUserTagOverridesWriteAsync(hostFilePath, nextOverrides, updatedAt) {
  const effectiveUpdatedAt = updatedAt || new Date().toISOString();
  const serialized = JSON.stringify(
    { overrides: nextOverrides, updatedAt: effectiveUpdatedAt },
    null,
    2
  );
  if (Buffer.byteLength(serialized, 'utf8') > MAX_USER_TAG_OVERRIDES_PAYLOAD_BYTES) {
    throw new Error('User tag overrides payload exceeds 2 MB limit.');
  }

  const dir = path.dirname(hostFilePath);
  await fs.promises.mkdir(dir, { recursive: true });
  const tmpPath = `${hostFilePath}.${process.pid}.${++userTagOverridesTmpSeq}.tmp`;
  const retryDelaysMs = [15, 40, 80];

  try {
    await fs.promises.writeFile(tmpPath, serialized, 'utf8');
    let renamed = false;
    let lastRenameErr = null;
    for (let attempt = 0; attempt <= retryDelaysMs.length; attempt++) {
      try {
        await fs.promises.rename(tmpPath, hostFilePath);
        renamed = true;
        break;
      } catch (renErr) {
        lastRenameErr = renErr;
        const code = String(/** @type {any} */ (renErr)?.code || '').toUpperCase();
        const isRetryableLock = code === 'EPERM' || code === 'EACCES' || code === 'EBUSY';
        if (!isRetryableLock || attempt >= retryDelaysMs.length) {
          break;
        }
        const delayMs = retryDelaysMs[attempt];
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }
    if (!renamed) {
      throw lastRenameErr || new Error('Failed to rename user_tag_overrides temporary file');
    }
  } catch (err) {
    try {
      await fs.promises.unlink(tmpPath);
    } catch {}
    if (
      err &&
      typeof err === 'object' &&
      String(/** @type {any} */ (err).message || '').includes('2 MB limit')
    ) {
      throw err;
    }
    atomicWriteFileSync(hostFilePath, serialized);
  }

  try {
    const postStat = await fs.promises.stat(hostFilePath);
    userTagOverridesMemoryCache.set(hostFilePath, {
      mtimeMs: postStat.mtimeMs,
      size: postStat.size,
      overrides: deepCloneOverridesMap(nextOverrides),
    });
  } catch {
    userTagOverridesMemoryCache.delete(hostFilePath);
  }
}

/**
 * Serialized async atomic writer for `user_tag_overrides.json`.
 *
 * @param {string} filePath
 * @param {Record<string, SanitizedUserTagOverrideRecord>} nextOverrides
 * @param {string} [updatedAt]
 * @returns {Promise<void>}
 */
function writeUserTagOverridesToDiskAsync(filePath, nextOverrides, updatedAt) {
  return enqueueUserTagOverridesTask(filePath, (hostFilePath) =>
    performAtomicUserTagOverridesWriteAsync(hostFilePath, nextOverrides, updatedAt)
  );
}

/**
 * Normalize a batch override payload (either `{ batchOverrides: Record<string, any> }`,
 * `{ batchOverrides: Array<any> }`, or a top-level `Array<any>`) into `[gameId, patch]` pairs.
 *
 * @param {unknown} rawArg
 * @returns {Array<[string, Record<string, any>]> | null}
 */
function extractBatchUserOverrideEntries(rawArg) {
  if (Array.isArray(rawArg)) {
    /** @type {Array<[string, Record<string, any>]>} */
    const entries = [];
    for (const item of rawArg) {
      if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
      const cleanItem = sanitizeRendererIpcOptions(item);
      const gid = normalizeSafeOverrideGameId(cleanItem.gameId || cleanItem.id);
      if (!gid) continue;
      const patch =
        cleanItem.override &&
        typeof cleanItem.override === 'object' &&
        !Array.isArray(cleanItem.override)
          ? {
              ...sanitizeRendererIpcOptions(cleanItem.override),
              ...(Array.isArray(cleanItem.purgeKeys) ? { purgeKeys: cleanItem.purgeKeys } : {}),
            }
          : cleanItem;
      entries.push([gid, patch]);
    }
    return entries;
  }

  if (rawArg && typeof rawArg === 'object' && !Array.isArray(rawArg)) {
    const batchRaw = /** @type {any} */ (rawArg).batchOverrides;
    if (Array.isArray(batchRaw)) {
      return extractBatchUserOverrideEntries(batchRaw);
    }
    if (batchRaw && typeof batchRaw === 'object') {
      const cleanBatch = sanitizeRendererIpcOptions(batchRaw);
      /** @type {Array<[string, Record<string, any>]>} */
      const entries = [];
      for (const [rawKey, rawPatch] of Object.entries(cleanBatch)) {
        const gid = normalizeSafeOverrideGameId(rawKey);
        if (!gid || !rawPatch || typeof rawPatch !== 'object' || Array.isArray(rawPatch)) continue;
        entries.push([gid, sanitizeRendererIpcOptions(rawPatch)]);
      }
      return entries;
    }
  }

  return null;
}

/**
 * Register user metadata override and decoupled user tag override IPC handlers.
 *
 * @param {{
 *   ipcMain: any,
 *   offlineVaultService: any,
 *   userDataDir?: string,
 * }} deps
 */
function registerUserOverridesIpcHandlers({ ipcMain, offlineVaultService, userDataDir }) {
  const handleGetUserOverrides = async () => {
    const filePath = resolveUserOverridesFilePath(offlineVaultService, userDataDir);
    const hostFilePath = toHostFilesystemPath(filePath);
    const pendingWrite = userOverridesWriteQueues.get(hostFilePath);
    if (pendingWrite) {
      try {
        await pendingWrite;
      } catch {}
    }
    return await readUserOverridesAsync(filePath);
  };

  const handleSaveUserOverride = async (
    /** @type {any} */ _event,
    /** @type {unknown} */ arg1,
    /** @type {unknown} */ arg2
  ) => {
    const batchEntries = extractBatchUserOverrideEntries(arg1);
    if (batchEntries !== null) {
      const filePath = resolveUserOverridesFilePath(offlineVaultService, userDataDir);

      const batchResult = await enqueueUserOverridesTask(filePath, async (hostFilePath) => {
        const current = await readUserOverridesAsync(hostFilePath);
        /** @type {Record<string, Record<string, any>>} */
        const nextOverrides = { ...current };
        /** @type {Map<string, [string, Record<string, any>, Set<string>]>} */
        const mergedByGameId = new Map();
        const nowIso = new Date().toISOString();

        for (const [batchGameId, rawPatch] of batchEntries) {
          const cleanPatch = sanitizeRendererIpcOptions(rawPatch);
          /** @type {string[]} */
          const batchPurgeKeys = Array.isArray(cleanPatch.purgeKeys)
            ? cleanPatch.purgeKeys
                .map((/** @type {unknown} */ k) => normalizeSafeOverrideGameId(k))
                .filter((/** @type {string} */ k) => Boolean(k) && k !== batchGameId)
            : [];
          delete cleanPatch.id;
          delete cleanPatch.purgeKeys;

          const existing = nextOverrides[batchGameId];
          const existingMs = Date.parse(String(existing?.updatedAt || ''));
          const rawPatchUpdatedStr =
            typeof cleanPatch.updatedAt === 'string' ? cleanPatch.updatedAt.trim() : '';
          const patchMs = Date.parse(rawPatchUpdatedStr);

          if (Number.isFinite(existingMs) && Number.isFinite(patchMs) && existingMs > patchMs) {
            continue;
          }

          const validPatchUpdatedAtIso = Number.isFinite(patchMs) ? rawPatchUpdatedStr : '';
          const mergedRecord = {
            ...(existing || {}),
            ...cleanPatch,
            gameId: batchGameId,
            updatedAt: validPatchUpdatedAtIso || nowIso,
          };
          delete /** @type {any} */ (mergedRecord).purgeKeys;

          /** @type {Set<string>} */
          const purgedForEntry = mergedByGameId.get(batchGameId)?.[2] || new Set();
          for (const pk of batchPurgeKeys) {
            delete nextOverrides[pk];
            purgedForEntry.add(pk);
          }

          const targetPair = extractOverrideEntitlementPair(batchGameId, mergedRecord);
          if (targetPair) {
            for (const [otherKey, otherOv] of Object.entries(nextOverrides)) {
              if (otherKey === batchGameId) continue;
              const otherPair = extractOverrideEntitlementPair(otherKey, otherOv);
              if (
                otherPair &&
                otherPair.platformId === targetPair.platformId &&
                otherPair.platformGameId === targetPair.platformGameId &&
                otherOv?.gameId !== batchGameId
              ) {
                delete nextOverrides[otherKey];
                purgedForEntry.add(otherKey);
              }
            }
          }

          nextOverrides[batchGameId] = mergedRecord;
          mergedByGameId.set(batchGameId, [batchGameId, mergedRecord, purgedForEntry]);
        }

        await performAtomicUserOverridesWriteAsync(hostFilePath, nextOverrides, nowIso);
        const mergedRecords = Array.from(mergedByGameId.values()).map(([id, rec, purgedSet]) => [
          id,
          rec,
          Array.from(purgedSet),
        ]);
        return {
          mergedRecords: /** @type {Array<[string, Record<string, any>, string[]]>} */ (
            mergedRecords
          ),
          nextOverrides,
        };
      });

      if (typeof offlineVaultService.saveUserOverridesBatch === 'function') {
        try {
          offlineVaultService.saveUserOverridesBatch(
            batchResult.mergedRecords.map(([id, rec, purgedKeys]) => ({
              gameId: id,
              record: rec,
              extraKeys: purgedKeys,
            }))
          );
        } catch {}
      } else if (typeof offlineVaultService.saveUserOverride === 'function') {
        for (const [id, rec, purgedKeys] of batchResult.mergedRecords) {
          try {
            offlineVaultService.saveUserOverride(id, rec, purgedKeys);
          } catch {}
        }
      }

      return {
        success: true,
        count: batchResult.mergedRecords.length,
        overrides: batchResult.nextOverrides,
      };
    }

    let gameId = '';
    /** @type {Record<string, any>} */
    let patch = {};
    /** @type {Set<string>} */
    const explicitPurgeKeys = new Set();

    if (typeof arg1 === 'string') {
      gameId = normalizeSafeOverrideGameId(arg1);
      patch = sanitizeRendererIpcOptions(arg2);
    } else if (arg1 && typeof arg1 === 'object' && !Array.isArray(arg1)) {
      const cleanObj = sanitizeRendererIpcOptions(arg1);
      gameId = normalizeSafeOverrideGameId(cleanObj.gameId || cleanObj.id);
      if (Array.isArray(cleanObj.purgeKeys)) {
        for (const rawPk of cleanObj.purgeKeys) {
          addOverrideKeyVariants(explicitPurgeKeys, rawPk);
        }
      }
      if (
        cleanObj.override &&
        typeof cleanObj.override === 'object' &&
        !Array.isArray(cleanObj.override)
      ) {
        patch = sanitizeRendererIpcOptions(cleanObj.override);
      } else {
        patch = { ...cleanObj };
        delete patch.id;
      }
    }

    if (Array.isArray(patch.purgeKeys)) {
      for (const rawPk of patch.purgeKeys) {
        addOverrideKeyVariants(explicitPurgeKeys, rawPk);
      }
    }
    delete patch.id;
    delete patch.purgeKeys;

    if (!gameId) {
      return { success: false, error: 'Invalid or missing gameId for user override.' };
    }
    explicitPurgeKeys.delete(gameId);

    const filePath = resolveUserOverridesFilePath(offlineVaultService, userDataDir);
    const { updatedRecord, nextOverrides, purgedKeys } = await enqueueUserOverridesTask(
      filePath,
      async (hostFilePath) => {
        const current = await readUserOverridesAsync(hostFilePath);
        const existing = current[gameId];
        const existingMs = Date.parse(String(existing?.updatedAt || ''));
        const rawPatchUpdatedStr =
          typeof patch.updatedAt === 'string' ? patch.updatedAt.trim() : '';
        const patchMs = Date.parse(rawPatchUpdatedStr);
        const nowIso = new Date().toISOString();

        if (Number.isFinite(existingMs) && Number.isFinite(patchMs) && existingMs > patchMs) {
          return {
            updatedRecord: existing,
            nextOverrides: current,
            purgedKeys: [],
          };
        }

        const effectiveUpdatedAt = Number.isFinite(patchMs) ? rawPatchUpdatedStr : nowIso;
        const rec = {
          ...(existing || {}),
          ...patch,
          gameId,
          updatedAt: effectiveUpdatedAt,
        };
        delete /** @type {any} */ (rec).purgeKeys;
        delete /** @type {any} */ (rec).id;

        /** @type {Record<string, Record<string, any>>} */
        const updatedMap = { ...current };
        /** @type {Set<string>} */
        const purgedSet = new Set();

        for (const pk of explicitPurgeKeys) {
          if (pk !== gameId) {
            if (Object.prototype.hasOwnProperty.call(updatedMap, pk)) {
              delete updatedMap[pk];
            }
            purgedSet.add(pk);
          }
        }

        const targetPair = extractOverrideEntitlementPair(gameId, rec);
        if (targetPair) {
          for (const [k, ov] of Object.entries(current)) {
            if (k === gameId) continue;
            const ovPair = extractOverrideEntitlementPair(k, ov);
            if (
              ovPair &&
              ovPair.platformId === targetPair.platformId &&
              ovPair.platformGameId === targetPair.platformGameId &&
              ov?.gameId !== gameId
            ) {
              delete updatedMap[k];
              purgedSet.add(k);
            }
          }
        }

        updatedMap[gameId] = rec;
        await performAtomicUserOverridesWriteAsync(hostFilePath, updatedMap, rec.updatedAt);
        return {
          updatedRecord: rec,
          nextOverrides: updatedMap,
          purgedKeys: Array.from(purgedSet),
        };
      }
    );

    if (typeof offlineVaultService.saveUserOverride === 'function') {
      try {
        offlineVaultService.saveUserOverride(gameId, updatedRecord, purgedKeys);
      } catch {}
    }

    return {
      success: true,
      gameId,
      override: updatedRecord,
      overrides: nextOverrides,
    };
  };

  const handleRemoveUserOverride = async (
    /** @type {any} */ _event,
    /** @type {unknown} */ rawArg
  ) => {
    const cleanObj =
      rawArg && typeof rawArg === 'object' && !Array.isArray(rawArg)
        ? sanitizeRendererIpcOptions(rawArg)
        : null;
    const rawId = typeof rawArg === 'string' ? rawArg : cleanObj ? cleanObj.gameId || cleanObj.id : '';
    const gameId = normalizeSafeOverrideGameId(rawId);
    if (!gameId) {
      return { success: false, error: 'Invalid or missing gameId for user override removal.' };
    }

    /** @type {Set<string>} */
    const keysToDelete = new Set();
    addOverrideKeyVariants(keysToDelete, gameId);

    /** @type {Array<{ platformId: string, platformGameId: string }>} */
    const targetPairs = [];
    const pushTargetPair = (/** @type {unknown} */ pid, /** @type {unknown} */ pgid) => {
      const norm = normalizeEntitlementPair(pid, pgid);
      if (!norm) return;
      if (
        !targetPairs.some(
          (p) => p.platformId === norm.platformId && p.platformGameId === norm.platformGameId
        )
      ) {
        targetPairs.push(norm);
      }
      addOverrideKeyVariants(keysToDelete, `${norm.platformId}:${norm.platformGameId}`);
    };

    const inferredFromGameId = extractOverrideEntitlementPair(gameId, null);
    if (inferredFromGameId && inferredFromGameId.platformId !== 'steam') {
      pushTargetPair(inferredFromGameId.platformId, inferredFromGameId.platformGameId);
    }

    /** @type {string[]} */
    const safeOrphanVaultGameIds = [];
    if (cleanObj) {
      const rawAliases = [
        ...(Array.isArray(cleanObj.aliasKeys) ? cleanObj.aliasKeys : []),
        ...(Array.isArray(cleanObj.aliases) ? cleanObj.aliases : []),
      ];
      for (const alias of rawAliases) {
        addOverrideKeyVariants(keysToDelete, alias);
      }
      if (cleanObj.platformId && cleanObj.platformGameId) {
        pushTargetPair(cleanObj.platformId, cleanObj.platformGameId);
      }
      if (Array.isArray(cleanObj.platforms)) {
        for (const p of cleanObj.platforms) {
          if (p && typeof p === 'object') {
            pushTargetPair(p.platformId, p.platformGameId);
          }
        }
      }
      if (Array.isArray(cleanObj.orphanVaultGameIds)) {
        const seenOrphans = new Set();
        for (const rawOrphan of cleanObj.orphanVaultGameIds) {
          const safeOrphan = normalizeSafeOverrideGameId(rawOrphan);
          if (safeOrphan && !seenOrphans.has(safeOrphan)) {
            seenOrphans.add(safeOrphan);
            safeOrphanVaultGameIds.push(safeOrphan);
          }
        }
      }
    }

    const matchesAnyTargetPair = (
      /** @type {{ platformId: string, platformGameId: string } | null} */ pair
    ) => {
      if (!pair) return false;
      return targetPairs.some(
        (tp) => tp.platformId === pair.platformId && tp.platformGameId === pair.platformGameId
      );
    };

    const filePath = resolveUserOverridesFilePath(offlineVaultService, userDataDir);
    const { nextOverrides, removedKeys } = await enqueueUserOverridesTask(
      filePath,
      async (hostFilePath) => {
        const current = await readUserOverridesAsync(hostFilePath);
        const updatedMap = { ...current };

        for (const [k, ov] of Object.entries(current)) {
          const ovGameId = typeof ov?.gameId === 'string' ? ov.gameId.trim() : '';
          const entryPair = extractOverrideEntitlementPair(k, ov);
          if (
            keysToDelete.has(k) ||
            (ovGameId && keysToDelete.has(ovGameId)) ||
            matchesAnyTargetPair(entryPair)
          ) {
            addOverrideKeyVariants(keysToDelete, k);
            if (ovGameId) addOverrideKeyVariants(keysToDelete, ovGameId);
            if (entryPair) {
              pushTargetPair(entryPair.platformId, entryPair.platformGameId);
            }
            for (const appId of extractLinkedSteamAppIds(k, ov)) {
              const steamKey = `steam-${appId}`;
              const existingSteamOv = current[steamKey];
              const existingSteamPair = existingSteamOv
                ? extractOverrideEntitlementPair(steamKey, existingSteamOv)
                : null;
              const belongsToUnrelatedEntitlement = Boolean(
                existingSteamPair &&
                  targetPairs.length > 0 &&
                  !matchesAnyTargetPair(existingSteamPair)
              );
              if (!belongsToUnrelatedEntitlement) {
                addOverrideKeyVariants(keysToDelete, steamKey);
              }
            }
          }
        }

        /** @type {Set<string>} */
        const removedSet = new Set(keysToDelete);
        for (const [k, ov] of Object.entries(current)) {
          const ovGameId = typeof ov?.gameId === 'string' ? ov.gameId.trim() : '';
          const entryPair = extractOverrideEntitlementPair(k, ov);
          if (
            keysToDelete.has(k) ||
            (ovGameId && keysToDelete.has(ovGameId)) ||
            matchesAnyTargetPair(entryPair)
          ) {
            delete updatedMap[k];
            removedSet.add(k);
            if (ovGameId) removedSet.add(ovGameId);
          }
        }

        await performAtomicUserOverridesWriteAsync(
          hostFilePath,
          updatedMap,
          new Date().toISOString()
        );
        return {
          nextOverrides: updatedMap,
          removedKeys: Array.from(removedSet),
        };
      }
    );

    if (typeof offlineVaultService.removeUserOverride === 'function') {
      try {
        offlineVaultService.removeUserOverride(gameId, removedKeys);
      } catch {}
    }

    if (
      safeOrphanVaultGameIds.length > 0 &&
      typeof offlineVaultService.deleteGames === 'function'
    ) {
      try {
        offlineVaultService.deleteGames(safeOrphanVaultGameIds);
      } catch {}
    }

    return {
      success: true,
      gameId,
      overrides: nextOverrides,
    };
  };

  ipcMain.handle('offlineVault:get-user-overrides', handleGetUserOverrides);
  ipcMain.handle('offlineVault:save-user-override', handleSaveUserOverride);
  ipcMain.handle('offlineVault:remove-user-override', handleRemoveUserOverride);

  const handleGetUserTagOverrides = async () => {
    const filePath = resolveUserTagOverridesFilePath(offlineVaultService, userDataDir);
    const hostFilePath = toHostFilesystemPath(filePath);
    const pendingWrite = userTagOverridesWriteQueue.get(hostFilePath);
    if (pendingWrite) {
      try {
        await pendingWrite;
      } catch {}
    }
    return await readUserTagOverridesAsync(filePath);
  };

  const handleSaveUserTagOverride = async (
    /** @type {any} */ _event,
    /** @type {unknown} */ arg1,
    /** @type {unknown} */ arg2
  ) => {
    try {
      const filePath = resolveUserTagOverridesFilePath(offlineVaultService, userDataDir);

      if (
        arg1 &&
        typeof arg1 === 'object' &&
        !Array.isArray(arg1) &&
        /** @type {any} */ (arg1).batchOverrides &&
        typeof /** @type {any} */ (arg1).batchOverrides === 'object' &&
        !Array.isArray(/** @type {any} */ (arg1).batchOverrides)
      ) {
        const cleanBatch = sanitizeRendererIpcOptions(/** @type {any} */ (arg1).batchOverrides);
        const batchResult = await enqueueUserTagOverridesTask(filePath, async (hostFilePath) => {
          const current = await readUserTagOverridesAsync(hostFilePath);
          /** @type {Record<string, SanitizedUserTagOverrideRecord>} */
          const nextOverrides = { ...current };
          const nowIso = new Date().toISOString();
          let appliedCount = 0;

          for (const [rawKey, rawPatch] of Object.entries(cleanBatch)) {
            const batchGameId = normalizeSafeOverrideGameId(rawKey);
            if (!batchGameId || !rawPatch || typeof rawPatch !== 'object' || Array.isArray(rawPatch)) {
              continue;
            }
            const cleanPatch = sanitizeRendererIpcOptions(rawPatch);
            const existing = nextOverrides[batchGameId];
            const existingMs = Date.parse(String(existing?.updatedAt || ''));
            const rawPatchUpdatedStr =
              typeof cleanPatch.updatedAt === 'string' ? cleanPatch.updatedAt.trim() : '';
            const patchMs = Date.parse(rawPatchUpdatedStr);

            if (Number.isFinite(existingMs) && Number.isFinite(patchMs) && existingMs > patchMs) {
              continue;
            }

            const candidateRaw = {
              gameId: batchGameId,
              addedTags: Array.isArray(cleanPatch.addedTags)
                ? cleanPatch.addedTags
                : existing?.addedTags || [],
              removedTags: Array.isArray(cleanPatch.removedTags)
                ? cleanPatch.removedTags
                : existing?.removedTags || [],
              platformAliases: Array.isArray(cleanPatch.platformAliases)
                ? cleanPatch.platformAliases
                : existing?.platformAliases,
              updatedAt: Number.isFinite(patchMs) ? rawPatchUpdatedStr : nowIso,
            };
            const sanitized = sanitizeUserTagOverrideRecord(batchGameId, candidateRaw, nowIso);
            if (!sanitized) continue;

            if (Array.isArray(cleanPatch.purgeKeys)) {
              for (const rawPk of cleanPatch.purgeKeys) {
                const pk = normalizeSafeOverrideGameId(rawPk);
                if (pk && pk !== batchGameId) {
                  delete nextOverrides[pk];
                }
              }
            }

            if (sanitized.addedTags.length === 0 && sanitized.removedTags.length === 0) {
              delete nextOverrides[batchGameId];
            } else {
              nextOverrides[batchGameId] = sanitized;
            }
            appliedCount += 1;
          }

          await performAtomicUserTagOverridesWriteAsync(hostFilePath, nextOverrides, nowIso);
          return {
            appliedCount,
            nextOverrides,
          };
        });

        return {
          success: true,
          count: batchResult.appliedCount,
          overrides: batchResult.nextOverrides,
        };
      }

      let gameId = '';
      /** @type {Record<string, any>} */
      let patch = {};
      /** @type {Set<string>} */
      const explicitPurgeKeys = new Set();

      if (typeof arg1 === 'string') {
        gameId = normalizeSafeOverrideGameId(arg1);
        patch = sanitizeRendererIpcOptions(arg2);
      } else if (arg1 && typeof arg1 === 'object' && !Array.isArray(arg1)) {
        const cleanObj = sanitizeRendererIpcOptions(arg1);
        gameId = normalizeSafeOverrideGameId(cleanObj.gameId || cleanObj.id);
        if (Array.isArray(cleanObj.purgeKeys)) {
          for (const rawPk of cleanObj.purgeKeys) {
            const safePk = normalizeSafeOverrideGameId(rawPk);
            if (safePk && safePk !== gameId) explicitPurgeKeys.add(safePk);
          }
        }
        if (
          cleanObj.override &&
          typeof cleanObj.override === 'object' &&
          !Array.isArray(cleanObj.override)
        ) {
          patch = sanitizeRendererIpcOptions(cleanObj.override);
        } else {
          patch = { ...cleanObj };
        }
      }

      if (Array.isArray(patch.purgeKeys)) {
        for (const rawPk of patch.purgeKeys) {
          const safePk = normalizeSafeOverrideGameId(rawPk);
          if (safePk && safePk !== gameId) explicitPurgeKeys.add(safePk);
        }
      }

      if (!gameId) {
        return { success: false, error: 'Invalid or missing gameId for user tag override.' };
      }

      const result = await enqueueUserTagOverridesTask(filePath, async (hostFilePath) => {
        const current = await readUserTagOverridesAsync(hostFilePath);
        const existing = current[gameId];
        const existingMs = Date.parse(String(existing?.updatedAt || ''));
        const rawPatchUpdatedStr =
          typeof patch.updatedAt === 'string' ? patch.updatedAt.trim() : '';
        const patchMs = Date.parse(rawPatchUpdatedStr);
        const nowIso = new Date().toISOString();

        if (Number.isFinite(existingMs) && Number.isFinite(patchMs) && existingMs > patchMs) {
          return {
            updatedRecord: existing,
            nextOverrides: current,
          };
        }

        const effectiveUpdatedAt = Number.isFinite(patchMs) ? rawPatchUpdatedStr : nowIso;
        const sanitized = sanitizeUserTagOverrideRecord(
          gameId,
          {
            gameId,
            addedTags: Array.isArray(patch.addedTags)
              ? patch.addedTags
              : existing?.addedTags || [],
            removedTags: Array.isArray(patch.removedTags)
              ? patch.removedTags
              : existing?.removedTags || [],
            platformAliases: Array.isArray(patch.platformAliases)
              ? patch.platformAliases
              : existing?.platformAliases,
            updatedAt: effectiveUpdatedAt,
          },
          nowIso
        );

        if (!sanitized) {
          return {
            updatedRecord: undefined,
            nextOverrides: current,
          };
        }

        /** @type {Record<string, SanitizedUserTagOverrideRecord>} */
        const updatedMap = { ...current };
        for (const pk of explicitPurgeKeys) {
          if (pk !== gameId) {
            delete updatedMap[pk];
          }
        }

        if (sanitized.addedTags.length === 0 && sanitized.removedTags.length === 0) {
          delete updatedMap[gameId];
          await performAtomicUserTagOverridesWriteAsync(
            hostFilePath,
            updatedMap,
            effectiveUpdatedAt
          );
          return {
            updatedRecord: undefined,
            nextOverrides: updatedMap,
          };
        }

        updatedMap[gameId] = sanitized;
        await performAtomicUserTagOverridesWriteAsync(
          hostFilePath,
          updatedMap,
          sanitized.updatedAt
        );
        return {
          updatedRecord: sanitized,
          nextOverrides: updatedMap,
        };
      });

      return {
        success: true,
        gameId,
        ...(result.updatedRecord ? { override: result.updatedRecord } : {}),
        overrides: result.nextOverrides,
      };
    } catch (err) {
      return {
        success: false,
        error:
          err && typeof err === 'object' && 'message' in err
            ? String(/** @type {any} */ (err).message)
            : 'Failed to save user tag override.',
      };
    }
  };

  const handleRemoveUserTagOverride = async (
    /** @type {any} */ _event,
    /** @type {unknown} */ rawArg
  ) => {
    try {
      const cleanObj =
        rawArg && typeof rawArg === 'object' && !Array.isArray(rawArg)
          ? sanitizeRendererIpcOptions(rawArg)
          : null;
      const rawId =
        typeof rawArg === 'string' ? rawArg : cleanObj ? cleanObj.gameId || cleanObj.id : '';
      const gameId = normalizeSafeOverrideGameId(rawId);
      if (!gameId) {
        return { success: false, error: 'Invalid or missing gameId for user tag override removal.' };
      }

      /** @type {Set<string>} */
      const keysToDelete = new Set([gameId]);
      if (cleanObj) {
        const rawExtraKeys = [
          ...(Array.isArray(cleanObj.aliasKeys) ? cleanObj.aliasKeys : []),
          ...(Array.isArray(cleanObj.aliases) ? cleanObj.aliases : []),
        ];
        for (const k of rawExtraKeys) {
          const safe = normalizeSafeOverrideGameId(k);
          if (safe) keysToDelete.add(safe);
        }
      }

      const filePath = resolveUserTagOverridesFilePath(offlineVaultService, userDataDir);
      const nextOverrides = await enqueueUserTagOverridesTask(filePath, async (hostFilePath) => {
        const current = await readUserTagOverridesAsync(hostFilePath);
        const updatedMap = { ...current };
        let changed = false;
        for (const key of keysToDelete) {
          if (Object.prototype.hasOwnProperty.call(updatedMap, key)) {
            delete updatedMap[key];
            changed = true;
          }
        }
        if (changed) {
          await performAtomicUserTagOverridesWriteAsync(
            hostFilePath,
            updatedMap,
            new Date().toISOString()
          );
        }
        return updatedMap;
      });

      return {
        success: true,
        gameId,
        overrides: nextOverrides,
      };
    } catch (err) {
      return {
        success: false,
        error:
          err && typeof err === 'object' && 'message' in err
            ? String(/** @type {any} */ (err).message)
            : 'Failed to remove user tag override.',
      };
    }
  };

  ipcMain.handle('offlineVault:get-user-tag-overrides', handleGetUserTagOverrides);
  ipcMain.handle('offlineVault:save-user-tag-override', handleSaveUserTagOverride);
  ipcMain.handle('offlineVault:remove-user-tag-override', handleRemoveUserTagOverride);
}

module.exports = {
  MAX_USER_OVERRIDES_FILE_BYTES,
  normalizeSafeOverrideGameId,
  trimUserOverridesCache,
  readUserOverridesFromDisk,
  readUserOverridesAsync,
  writeUserOverridesToDiskAsync,
  enqueueUserOverridesTask,
  readUserTagOverridesFromDisk,
  readUserTagOverridesAsync,
  writeUserTagOverridesToDiskAsync,
  sanitizeUserTagOverrideRecord,
  registerUserOverridesIpcHandlers,
};
