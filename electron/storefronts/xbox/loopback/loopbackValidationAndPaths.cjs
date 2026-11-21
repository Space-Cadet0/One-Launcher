// @ts-check
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const {
  isContainedWithinRoot,
  toHostFilesystemPath,
} = require('../../../launcher/securityAndPathUtils.cjs');
const { formatWgsUserScidFolderName } = require('../xboxTitleStorageSync.cjs');

const MAX_RPC_FRAME_BYTES = 16 * 1024 * 1024; // 16 MiB (authenticated sockets)
const MAX_UNAUTH_RPC_FRAME_BYTES = 4096; // 4 KiB strict limit until sessionToken/key verified
const MAX_HTTP_HEADER_BYTES = 8192; // 8 KiB strict limit for HTTP header pre-auth gate
const DEFAULT_UNAUTH_HANDSHAKE_TIMEOUT_MS = 5_000; // 5s strict pre-auth deadline
const MAX_CONCURRENT_SOCKETS = 16;
const DEFAULT_SOCKET_IDLE_TIMEOUT_MS = 60_000;
const DEFAULT_PRESENCE_HEARTBEAT_INTERVAL_MS = 4 * 60 * 1000; // 4 minutes
const MAX_PARSED_REQ_QUEUE = 64;
const MAX_BOUNDED_STATE_ENTRIES = 64;

const E_INVALIDARG_HR = -2147024809; // 0x80070057
const MAX_UINT64_BIGINT = 0xffffffffffffffffn;

const VALID_SCID_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const VALID_XUID_DEC_RE = /^\d{1,20}$/;
const VALID_XUID_HEX_RE = /^0x[0-9a-f]{1,16}$/i;
const VALID_HEX_XUID_SCID_RE =
  /^[0-9A-F]{16}_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const MINIMAL_1X1_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

/**
 * @param {string} message
 * @returns {Error & { hr: number }}
 */
function createInvalidArgError(message) {
  return Object.assign(new Error(message), { hr: E_INVALIDARG_HR });
}

/**
 * @param {unknown} candidateKey
 * @param {Buffer} expectedKeyBuf
 * @returns {boolean}
 */
function verifySessionKeyConstantTime(candidateKey, expectedKeyBuf) {
  if (typeof candidateKey !== 'string' || candidateKey.length !== 64) {
    return false;
  }
  const candBuf = Buffer.from(candidateKey, 'utf8');
  if (candBuf.length !== expectedKeyBuf.length) {
    return false;
  }
  return crypto.timingSafeEqual(candBuf, expectedKeyBuf);
}

/**
 * @param {unknown} rawPfn
 * @returns {string}
 */
function validateSafePackageFamilyName(rawPfn) {
  const clean = String(rawPfn ?? '').trim();
  if (!clean) return '';
  if (
    clean === '.' ||
    clean === '..' ||
    clean.includes('..') ||
    clean.includes('/') ||
    clean.includes('\\') ||
    !/^[A-Za-z0-9._-]{1,128}$/.test(clean)
  ) {
    throw createInvalidArgError(
      `Rejected unsafe or traversal packageFamilyName: ${clean.slice(0, 64)}`
    );
  }
  return clean;
}

/**
 * Validates an Xbox SCID strictly against UUID format (`VALID_SCID_UUID_RE`).
 *
 * @param {unknown} rawScid
 * @param {{ allowEmpty?: boolean }} [options]
 * @returns {string} Lowercase validated UUID (or `''` if `allowEmpty` is true)
 */
function validateSafeScid(rawScid, { allowEmpty = false } = {}) {
  const clean = String(rawScid ?? '').trim().toLowerCase();
  if (!clean) {
    if (allowEmpty) return '';
    throw createInvalidArgError('Rejected empty SCID (expected strict UUID)');
  }
  if (!VALID_SCID_UUID_RE.test(clean)) {
    throw createInvalidArgError(`Rejected invalid or non-UUID SCID: ${clean.slice(0, 64)}`);
  }
  return clean;
}

/**
 * Validates an Xbox XUID strictly against unsigned 64-bit decimal digits or `0x`-hex format.
 *
 * @param {unknown} rawXuid
 * @param {{ allowEmpty?: boolean }} [options]
 * @returns {string}
 */
function validateSafeXuid(rawXuid, { allowEmpty = false } = {}) {
  if (rawXuid === undefined || rawXuid === null || String(rawXuid).trim() === '') {
    if (allowEmpty) return '';
    throw createInvalidArgError('Rejected empty XUID');
  }
  const clean = String(rawXuid).trim();
  if (!VALID_XUID_DEC_RE.test(clean) && !VALID_XUID_HEX_RE.test(clean)) {
    throw createInvalidArgError(`Rejected invalid or unsafe XUID: ${clean.slice(0, 64)}`);
  }
  const big = BigInt(clean);
  if (big < 0n || big > MAX_UINT64_BIGINT) {
    throw createInvalidArgError(`Rejected out-of-range XUID: ${clean.slice(0, 64)}`);
  }
  return clean;
}

/**
 * Validates a `<HexXuid>_<Scid>` folder name strictly against `VALID_HEX_XUID_SCID_RE`.
 *
 * @param {unknown} rawHexXuidScid
 * @returns {string}
 */
function validateSafeHexXuidScid(rawHexXuidScid) {
  const clean = String(rawHexXuidScid ?? '').trim();
  if (!clean || !VALID_HEX_XUID_SCID_RE.test(clean)) {
    throw createInvalidArgError(
      `Rejected invalid or unsafe hexXuidScid folder name: ${clean.slice(0, 64)}`
    );
  }
  return clean;
}

/**
 * @param {unknown} rawTitleId
 * @param {{ preferHex?: boolean }} [options]
 * @returns {string}
 */
function normalizeLoopbackDecimalTitleId(rawTitleId, { preferHex = false } = {}) {
  const s = String(rawTitleId || '').trim();
  if (!s) return '';
  if (/^0x[0-9a-f]{1,8}$/i.test(s)) {
    return String(parseInt(s.slice(2), 16));
  }
  if (/^[0-9a-f]{1,8}$/i.test(s) && (preferHex || /[a-f]/i.test(s))) {
    return String(parseInt(s, 16));
  }
  if (/^\d+$/.test(s)) {
    return String(Number(s));
  }
  return '';
}

/**
 * @param {string} hostPath
 * @returns {string}
 */
function hostPathToWindowsPath(hostPath) {
  const raw = String(hostPath || '').trim();
  if (!raw) return '';
  if (/^[A-Za-z]:[\\/]/.test(raw)) {
    const win = raw.replace(/\//g, '\\');
    return win.length > 3 ? win.replace(/\\+$/, '') : win;
  }
  if (process.platform === 'win32') {
    const resolved = path.resolve(raw).replace(/\//g, '\\');
    return resolved.length > 3 ? resolved.replace(/\\+$/, '') : resolved;
  }
  const slashNorm = path.resolve(raw).replace(/\\/g, '/');
  const lower = slashNorm.toLowerCase();
  const driveCIdx = lower.lastIndexOf('/drive_c/');
  if (driveCIdx >= 0) {
    const rel = slashNorm.slice(driveCIdx + '/drive_c/'.length).replace(/\//g, '\\');
    return rel ? `C:\\${rel.replace(/\\+$/, '')}` : 'C:\\';
  }
  if (lower.endsWith('/drive_c')) {
    return 'C:\\';
  }
  const zRel = slashNorm.replace(/^\/+/, '').replace(/\//g, '\\');
  return zRel ? `Z:\\${zRel.replace(/\\+$/, '')}` : 'Z:\\';
}

/**
 * @param {any} payloadObj
 * @returns {Buffer}
 */
function encodeRpcFrame(payloadObj) {
  const jsonBuf = Buffer.from(JSON.stringify(payloadObj), 'utf8');
  const frame = Buffer.allocUnsafe(4 + jsonBuf.length);
  frame.writeUInt32LE(jsonBuf.length, 0);
  jsonBuf.copy(frame, 4);
  return frame;
}

/**
 * Idempotently resolves `{ wgsUserDir, xgsUserDir }` from either a `SystemAppData`
 * directory OR an already-appended `.../SystemAppData/wgs` directory (preventing `wgs/wgs`),
 * enforcing strict XUID/SCID validation and `isContainedWithinRoot` containment.
 *
 * @param {any} baseSaveDirInput
 * @param {string} [hexXuidScidInput]
 * @returns {{ wgsUserDir: string, xgsUserDir: string } | null}
 */
function resolveTitleSaveDirs(baseSaveDirInput, hexXuidScidInput) {
  let baseSaveDir = baseSaveDirInput;
  let hexXuidScid = hexXuidScidInput;
  if (baseSaveDirInput && typeof baseSaveDirInput === 'object') {
    baseSaveDir =
      baseSaveDirInput.baseSaveDir ||
      baseSaveDirInput.saveRootDir ||
      baseSaveDirInput.wgsRootDir ||
      '';
    if (baseSaveDirInput.hexXuidScid) {
      hexXuidScid = baseSaveDirInput.hexXuidScid;
    } else if (baseSaveDirInput.xuid || baseSaveDirInput.scid) {
      const safeXuid = validateSafeXuid(baseSaveDirInput.xuid);
      const safeScid = validateSafeScid(baseSaveDirInput.scid);
      hexXuidScid = formatWgsUserScidFolderName(safeXuid, safeScid);
    } else {
      hexXuidScid = '';
    }
  }
  if (!baseSaveDir || !hexXuidScid) return null;

  const safeHexXuidScid = validateSafeHexXuidScid(hexXuidScid);
  const cleanBase = path.resolve(String(baseSaveDir));
  const leaf = path.basename(cleanBase).toLowerCase();

  let wgsRoot;
  let xgsRoot;
  if (leaf === 'wgs') {
    wgsRoot = cleanBase;
    xgsRoot = path.join(path.dirname(cleanBase), 'xgs');
  } else if (leaf === 'xgs') {
    wgsRoot = path.join(path.dirname(cleanBase), 'wgs');
    xgsRoot = cleanBase;
  } else {
    wgsRoot = path.join(cleanBase, 'wgs');
    xgsRoot = path.join(cleanBase, 'xgs');
  }

  const wgsUserDir = path.resolve(wgsRoot, safeHexXuidScid);
  const xgsUserDir = path.resolve(xgsRoot, safeHexXuidScid);

  if (
    wgsUserDir === path.resolve(wgsRoot) ||
    !isContainedWithinRoot(path.resolve(wgsRoot), wgsUserDir) ||
    xgsUserDir === path.resolve(xgsRoot) ||
    !isContainedWithinRoot(path.resolve(xgsRoot), xgsUserDir)
  ) {
    throw createInvalidArgError('Rejected path traversal in TitleSave directory resolution');
  }

  return { wgsUserDir, xgsUserDir };
}

/**
 * @param {any} baseSaveDir
 * @param {string} [hexXuidScid]
 * @returns {string | null}
 */
function resolveTitleSaveRootDir(baseSaveDir, hexXuidScid) {
  const dirs = resolveTitleSaveDirs(baseSaveDir, hexXuidScid);
  return dirs ? dirs.wgsUserDir : null;
}

/**
 * Safely deletes a directory strictly contained within `rootDir` after verifying
 * `isContainedWithinRoot` and refusing symlinks.
 *
 * @param {string} rootDir
 * @param {string} targetDir
 * @returns {Promise<boolean>}
 */
async function safeRemoveContainedDir(rootDir, targetDir) {
  const resolvedRoot = path.resolve(toHostFilesystemPath(rootDir));
  const resolvedTarget = path.resolve(toHostFilesystemPath(targetDir));
  if (
    resolvedTarget === resolvedRoot ||
    !isContainedWithinRoot(resolvedRoot, resolvedTarget)
  ) {
    return false;
  }
  const st = await fs.promises.lstat(resolvedTarget).catch(() => null);
  if (!st || st.isSymbolicLink()) {
    return false;
  }
  await fs.promises.rm(resolvedTarget, { recursive: true, force: true }).catch(() => {});
  return true;
}

/**
 * Inserts/updates an entry in a bounded `Map`, evicting the oldest key if capacity is exceeded.
 *
 * @template K, V
 * @param {Map<K, V>} map
 * @param {K} key
 * @param {V} value
 * @param {number} [maxEntries]
 */
function setBoundedMapEntry(map, key, value, maxEntries = MAX_BOUNDED_STATE_ENTRIES) {
  if (map.has(key)) {
    map.delete(key);
  }
  map.set(key, value);
  while (map.size > maxEntries) {
    const oldestKey = map.keys().next().value;
    if (oldestKey === undefined) break;
    map.delete(oldestKey);
  }
}

/**
 * Inserts an entry into a bounded `Set`, evicting the oldest element if capacity is exceeded.
 *
 * @template T
 * @param {Set<T>} set
 * @param {T} value
 * @param {number} [maxEntries]
 */
function addBoundedSetEntry(set, value, maxEntries = MAX_BOUNDED_STATE_ENTRIES) {
  if (set.has(value)) {
    return;
  }
  set.add(value);
  while (set.size > maxEntries) {
    const oldestVal = set.values().next().value;
    if (oldestVal === undefined) break;
    set.delete(oldestVal);
  }
}

module.exports = {
  MAX_RPC_FRAME_BYTES,
  MAX_UNAUTH_RPC_FRAME_BYTES,
  MAX_HTTP_HEADER_BYTES,
  DEFAULT_UNAUTH_HANDSHAKE_TIMEOUT_MS,
  MAX_CONCURRENT_SOCKETS,
  DEFAULT_SOCKET_IDLE_TIMEOUT_MS,
  DEFAULT_PRESENCE_HEARTBEAT_INTERVAL_MS,
  MAX_PARSED_REQ_QUEUE,
  MAX_BOUNDED_STATE_ENTRIES,
  E_INVALIDARG_HR,
  VALID_SCID_UUID_RE,
  VALID_XUID_DEC_RE,
  VALID_XUID_HEX_RE,
  VALID_HEX_XUID_SCID_RE,
  MINIMAL_1X1_PNG_BASE64,
  createInvalidArgError,
  verifySessionKeyConstantTime,
  validateSafePackageFamilyName,
  validateSafeScid,
  validateSafeXuid,
  validateSafeHexXuidScid,
  normalizeLoopbackDecimalTitleId,
  hostPathToWindowsPath,
  encodeRpcFrame,
  resolveTitleSaveDirs,
  resolveTitleSaveRootDir,
  safeRemoveContainedDir,
  setBoundedMapEntry,
  addBoundedSetEntry,
};
