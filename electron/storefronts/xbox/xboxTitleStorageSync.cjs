'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { deriveDefaultScidFromTitleId } = require('./xboxConfigAndIds.cjs');
const { toHostFilesystemPath } = require('../../launcher/securityAndPathUtils.cjs');

const WINDOWS_EPOCH_OFFSET_MS = 11644473600000n;
const LARGE_ATOM_THRESHOLD_BYTES = 4 * 1024 * 1024; // 4 MiB
const DEFAULT_TITLE_STORAGE_ORIGIN = 'https://titlestorage.xboxlive.com';
const WGS_ATOM_SIDECAR_FILENAME = '.onelauncher-wgs-sync.json';
const XGS_SYNC_SIDECAR_FILENAME = '.onelauncher-xgs-sync.json';
const DEFAULT_TITLE_STORAGE_TIMEOUT_MS = 25_000;

const ALLOWED_BLOB_URI_HOST_SUFFIXES = [
  '.xboxlive.com',
  '.blob.core.windows.net',
  '.msecnd.net',
];

const ALLOWED_BLOB_URI_EXACT_HOSTS = new Set([
  'xboxlive.com',
  'blob.core.windows.net',
  'msecnd.net',
]);

function createTitleStorageFetchSignal(outerSignal, timeoutMs = DEFAULT_TITLE_STORAGE_TIMEOUT_MS) {
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  if (outerSignal && typeof AbortSignal.any === 'function') {
    return AbortSignal.any([outerSignal, timeoutSignal]);
  }
  return outerSignal || timeoutSignal;
}

/**
 * Validates Connected Storage `blobUri` URLs against `https:` and Microsoft/Xbox CDN/Blob hosts
 * (`*.xboxlive.com`, `*.blob.core.windows.net`, `*.msecnd.net`) to prevent SSRF / token exfiltration.
 * When a caller explicitly configures a loopback `allowedOrigin` (`http://127.0.0.1:<port>` or
 * `http://localhost:<port>`) for local testing, exact same-origin (`protocol + host + port`) URLs
 * on that loopback server are permitted while all other hosts/ports/protocols remain blocked.
 *
 * @param {string} rawBlobUri
 * @param {{ allowedLoopbackOrigin?: string }} [options]
 * @returns {string} Normalized validated URL string
 */
function validateTitleStorageBlobUri(rawBlobUri, options = {}) {
  const str = String(rawBlobUri || '').trim();
  if (!str) {
    throw new Error('Rejected empty TitleStorage blobUri');
  }
  let parsed;
  try {
    parsed = new URL(str);
  } catch {
    throw new Error(`Rejected malformed TitleStorage blobUri: "${str.slice(0, 120)}"`);
  }
  if (parsed.username || parsed.password) {
    throw new Error('Rejected TitleStorage blobUri containing embedded credentials');
  }
  if (options && options.allowedLoopbackOrigin && parsed.origin === options.allowedLoopbackOrigin) {
    return parsed.toString();
  }
  if (parsed.protocol !== 'https:') {
    throw new Error(
      `Rejected non-HTTPS TitleStorage blobUri protocol "${parsed.protocol}" (expected https:)`
    );
  }
  const host = parsed.hostname.toLowerCase().replace(/\.$/, '');
  const hostAllowed =
    ALLOWED_BLOB_URI_EXACT_HOSTS.has(host) ||
    ALLOWED_BLOB_URI_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix));
  if (!hostAllowed) {
    throw new Error(`Rejected untrusted TitleStorage blobUri host "${host}"`);
  }
  return parsed.toString();
}

// ---------------------------------------------------------------------------
// FILETIME, GUID & UTF-16LE Binary Helpers for Windows `wgs` Format
// ---------------------------------------------------------------------------

function dateToFileTimeBigInt(dateOrIso) {
  const ms =
    typeof dateOrIso === 'number'
      ? dateOrIso
      : dateOrIso
        ? Date.parse(String(dateOrIso))
        : Date.now();
  const safeMs = Number.isFinite(ms) ? Math.floor(ms) : Date.now();
  return (BigInt(safeMs) + WINDOWS_EPOCH_OFFSET_MS) * 10000n;
}

function fileTimeBigIntToIso(ftBigInt) {
  if (!ftBigInt || ftBigInt <= WINDOWS_EPOCH_OFFSET_MS * 10000n) {
    return new Date(0).toISOString();
  }
  const unixMs = Number(ftBigInt / 10000n - WINDOWS_EPOCH_OFFSET_MS);
  return new Date(unixMs).toISOString();
}

function readWinGuidHexUpper(buf, offset = 0) {
  if (offset + 16 > buf.length) {
    throw new RangeError('Buffer too short for 16-byte Windows GUID');
  }
  const d1 = buf.readUInt32LE(offset).toString(16).padStart(8, '0');
  const d2 = buf.readUInt16LE(offset + 4).toString(16).padStart(4, '0');
  const d3 = buf.readUInt16LE(offset + 6).toString(16).padStart(4, '0');
  const d4 = buf.subarray(offset + 8, offset + 16).toString('hex');
  return `${d1}${d2}${d3}${d4}`.toUpperCase();
}

function writeWinGuidHex(guidHexOrDashed, outBuf = Buffer.alloc(16), offset = 0) {
  const clean = String(guidHexOrDashed || '')
    .replace(/[{}-\s]/g, '')
    .toUpperCase();
  if (!/^[0-9A-F]{32}$/.test(clean)) {
    throw new Error(`Invalid GUID hex: "${guidHexOrDashed}"`);
  }
  outBuf.writeUInt32LE(parseInt(clean.slice(0, 8), 16) >>> 0, offset);
  outBuf.writeUInt16LE(parseInt(clean.slice(8, 12), 16) & 0xffff, offset + 4);
  outBuf.writeUInt16LE(parseInt(clean.slice(12, 16), 16) & 0xffff, offset + 6);
  Buffer.from(clean.slice(16, 32), 'hex').copy(outBuf, offset + 8);
  return outBuf;
}

function generateUpperGuidHex() {
  return crypto.randomUUID().replace(/-/g, '').toUpperCase();
}

function formatDashedUpperUuid(guidHex32) {
  const clean = String(guidHex32 || '')
    .replace(/-/g, '')
    .toUpperCase();
  if (clean.length !== 32) return crypto.randomUUID().toUpperCase();
  return `${clean.slice(0, 8)}-${clean.slice(8, 12)}-${clean.slice(12, 16)}-${clean.slice(16, 20)}-${clean.slice(20, 32)}`;
}

function readLengthPrefixedUtf16(buf, offset) {
  if (offset + 4 > buf.length) {
    throw new RangeError(`Truncated wgs UTF-16 string length at offset ${offset}`);
  }
  const charCount = buf.readInt32LE(offset);
  if (charCount < 0 || charCount > 65536 || offset + 4 + charCount * 2 > buf.length) {
    throw new RangeError(`Invalid wgs UTF-16 charCount ${charCount} at offset ${offset}`);
  }
  const value = buf.subarray(offset + 4, offset + 4 + charCount * 2).toString('utf16le');
  return { value, nextOffset: offset + 4 + charCount * 2 };
}

function encodeLengthPrefixedUtf16(str) {
  const s = String(str || '');
  const strBuf = Buffer.from(s, 'utf16le');
  const charCount = Math.floor(strBuf.length / 2);
  const out = Buffer.allocUnsafe(4 + strBuf.length);
  out.writeInt32LE(charCount, 0);
  strBuf.copy(out, 4);
  return out;
}

// ---------------------------------------------------------------------------
// Standard Windows `wgs` `containers.index` & `container.<n>` Parser + Writer
// ---------------------------------------------------------------------------

/**
 * Parses a Windows `SystemAppData\wgs\<HexXuid>_<Scid>\containers.index` binary buffer.
 */
function parseWgsContainersIndex(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 28) {
    throw new Error(`Invalid wgs containers.index buffer length: ${buf ? buf.length : 0}`);
  }

  let off = 0;
  const version = buf.readInt32LE(off);
  off += 4;
  const containerCount = buf.readInt32LE(off);
  off += 4;
  if (containerCount < 0 || containerCount > 65536) {
    throw new RangeError(`Unreasonable containerCount ${containerCount} in wgs containers.index`);
  }

  const pkgDisplayName = readLengthPrefixedUtf16(buf, off);
  off = pkgDisplayName.nextOffset;
  const storePkgAumid = readLengthPrefixedUtf16(buf, off);
  off = storePkgAumid.nextOffset;
  const creationFileTime = buf.readBigUInt64LE(off);
  off += 8;
  const headerFlags = buf.readInt32LE(off);
  off += 4;
  const syncMetadataId = readLengthPrefixedUtf16(buf, off);
  off = syncMetadataId.nextOffset;
  const headerUnknown = buf.readBigUInt64LE(off);
  off += 8;

  const containers = [];
  for (let i = 0; i < containerCount; i += 1) {
    const cName = readLengthPrefixedUtf16(buf, off);
    off = cName.nextOffset;
    const cDisplayName = readLengthPrefixedUtf16(buf, off);
    off = cDisplayName.nextOffset;
    const cTag = readLengthPrefixedUtf16(buf, off);
    off = cTag.nextOffset;

    if (off + 1 + 4 + 16 + 8 + 16 > buf.length) {
      throw new RangeError(`Truncated container record ${i} in wgs containers.index`);
    }

    const containerNum = buf.readUInt8(off);
    off += 1;
    const stateFlags = buf.readUInt32LE(off);
    off += 4;
    const folderGuid = readWinGuidHexUpper(buf, off);
    off += 16;
    const modifiedFileTime = buf.readBigUInt64LE(off);
    off += 8;
    const entryUnknown = buf.readBigUInt64LE(off);
    off += 8;
    const totalSize = Number(buf.readBigUInt64LE(off));
    off += 8;

    containers.push({
      name: cName.value,
      displayName: cDisplayName.value || cName.value,
      tag: cTag.value,
      containerNum,
      stateFlags,
      dirty: (stateFlags & 0x01) !== 0,
      folderGuid,
      modifiedFileTime,
      modifiedIso: fileTimeBigIntToIso(modifiedFileTime),
      entryUnknown,
      totalSize,
    });
  }

  return {
    version,
    pkgDisplayName: pkgDisplayName.value,
    storePkgAumid: storePkgAumid.value,
    creationFileTime,
    creationIso: fileTimeBigIntToIso(creationFileTime),
    headerFlags,
    syncMetadataId: syncMetadataId.value,
    headerUnknown,
    containers,
  };
}

/**
 * Serializes a structured model into a byte-exact Windows `wgs` `containers.index` buffer.
 */
function serializeWgsContainersIndex(model = {}) {
  const version = Number.isInteger(model.version) ? model.version : 14;
  const containers = Array.isArray(model.containers) ? model.containers : [];
  const parts = [];

  const hdrFixed = Buffer.allocUnsafe(8);
  hdrFixed.writeInt32LE(version, 0);
  hdrFixed.writeInt32LE(containers.length, 4);
  parts.push(hdrFixed);

  parts.push(encodeLengthPrefixedUtf16(model.pkgDisplayName || ''));
  parts.push(encodeLengthPrefixedUtf16(model.storePkgAumid || ''));

  const ftAndFlags = Buffer.allocUnsafe(12);
  const creationFt =
    typeof model.creationFileTime === 'bigint'
      ? model.creationFileTime
      : dateToFileTimeBigInt(model.creationIso || Date.now());
  ftAndFlags.writeBigUInt64LE(creationFt, 0);
  ftAndFlags.writeInt32LE(Number(model.headerFlags || 0), 8);
  parts.push(ftAndFlags);

  parts.push(encodeLengthPrefixedUtf16(model.syncMetadataId || ''));

  const hdrTail = Buffer.allocUnsafe(8);
  hdrTail.writeBigUInt64LE(BigInt(model.headerUnknown || 0), 0);
  parts.push(hdrTail);

  for (const c of containers) {
    parts.push(encodeLengthPrefixedUtf16(c.name || ''));
    parts.push(encodeLengthPrefixedUtf16(c.displayName !== undefined ? c.displayName : c.name || ''));
    parts.push(encodeLengthPrefixedUtf16(c.tag || ''));

    const fixed = Buffer.alloc(45);
    const num = Number.isInteger(c.containerNum) ? c.containerNum & 0xff : 1;
    const flags =
      c.stateFlags !== undefined ? c.stateFlags >>> 0 : c.dirty ? 1 : 0;
    fixed.writeUInt8(num, 0);
    fixed.writeUInt32LE(flags, 1);
    writeWinGuidHex(c.folderGuid || generateUpperGuidHex(), fixed, 5);
    const modFt =
      typeof c.modifiedFileTime === 'bigint'
        ? c.modifiedFileTime
        : dateToFileTimeBigInt(c.modifiedIso || Date.now());
    fixed.writeBigUInt64LE(modFt, 21);
    fixed.writeBigUInt64LE(BigInt(c.entryUnknown || 0), 29);
    fixed.writeBigUInt64LE(BigInt(Math.max(0, Number(c.totalSize || 0))), 37);
    parts.push(fixed);
  }

  return Buffer.concat(parts);
}

/**
 * Parses a Windows `wgs` `<FOLDER_GUID>\container.<N>` binary blob table (160-byte entries).
 */
function parseWgsContainerBlobIndex(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 8) {
    throw new Error(`Invalid wgs container.<N> buffer length: ${buf ? buf.length : 0}`);
  }
  const version = buf.readInt32LE(0);
  const blobCount = buf.readInt32LE(4);
  if (blobCount < 0 || 8 + blobCount * 160 > buf.length) {
    throw new RangeError(`Truncated wgs container.<N>: blobCount=${blobCount}, length=${buf.length}`);
  }

  const ZERO_GUID = '00000000000000000000000000000000';
  const blobs = [];

  for (let i = 0; i < blobCount; i += 1) {
    const recOff = 8 + i * 160;
    // Fixed 64-wchar (128-byte) UTF-16LE null-padded blob name
    let strEnd = recOff;
    while (strEnd + 1 < recOff + 128) {
      if (buf[strEnd] === 0 && buf[strEnd + 1] === 0) break;
      strEnd += 2;
    }
    const name = buf.subarray(recOff, strEnd).toString('utf16le');
    const blobGuidA = readWinGuidHexUpper(buf, recOff + 128);
    const blobGuidB = readWinGuidHexUpper(buf, recOff + 144);
    const hasDualDistinctGuids =
      blobGuidA !== ZERO_GUID && blobGuidB !== ZERO_GUID && blobGuidA !== blobGuidB;

    blobs.push({
      name,
      blobGuidA,
      blobGuidB,
      activeGuid: blobGuidA !== ZERO_GUID ? blobGuidA : blobGuidB,
      hasDualDistinctGuids,
    });
  }

  return { version, blobs };
}

/**
 * Serializes a Windows `wgs` `container.<N>` binary buffer (version = 4, 160-byte entries).
 */
function serializeWgsContainerBlobIndex(blobs = [], version = 4) {
  const out = Buffer.alloc(8 + blobs.length * 160, 0);
  out.writeInt32LE(version, 0);
  out.writeInt32LE(blobs.length, 4);

  for (let i = 0; i < blobs.length; i += 1) {
    const b = blobs[i];
    const recOff = 8 + i * 160;
    const nameUtf16 = Buffer.from(String(b.name || ''), 'utf16le');
    nameUtf16.copy(out, recOff, 0, Math.min(126, nameUtf16.length));

    const guidA = b.blobGuidA || b.activeGuid || generateUpperGuidHex();
    const guidB =
      b.blobGuidB || '00000000000000000000000000000000';
    writeWinGuidHex(guidA, out, recOff + 128);
    writeWinGuidHex(guidB, out, recOff + 144);
  }

  return out;
}

async function writeFileAtomic(targetPath, dataBuffer) {
  const hostTargetPath = toHostFilesystemPath(targetPath);
  await fs.promises.mkdir(path.dirname(hostTargetPath), { recursive: true });
  const tmpPath = `${hostTargetPath}.tmp.${process.pid}.${Date.now()}`;
  await fs.promises.writeFile(tmpPath, dataBuffer);
  await fs.promises.rename(tmpPath, hostTargetPath);
}

// ---------------------------------------------------------------------------
// Local `wgs` & `xgs` Workspace Reader / Writer
// ---------------------------------------------------------------------------

function formatWgsUserScidFolderName(xuid, scid) {
  const xuidBig = typeof xuid === 'bigint' ? xuid : BigInt(String(xuid || '0'));
  const hexXuid = xuidBig.toString(16).toUpperCase().padStart(16, '0');
  const normScid = String(scid || '').trim().toLowerCase();
  return `${hexXuid}_${normScid}`;
}

async function loadWgsSyncSidecar(wgsUserDir) {
  const hostWgsUserDir = toHostFilesystemPath(wgsUserDir);
  const sidecarPath = path.join(hostWgsUserDir, WGS_ATOM_SIDECAR_FILENAME);
  try {
    const raw = await fs.promises.readFile(sidecarPath, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') {
      return {
        containers: parsed.containers && typeof parsed.containers === 'object' ? parsed.containers : {},
        deletedContainers: Array.isArray(parsed.deletedContainers) ? parsed.deletedContainers : [],
      };
    }
  } catch {
    // Missing sidecar is normal on fresh or native Windows wgs directories
  }
  return { containers: {}, deletedContainers: [] };
}

async function saveWgsSyncSidecar(wgsUserDir, sidecar) {
  const hostWgsUserDir = toHostFilesystemPath(wgsUserDir);
  const sidecarPath = path.join(hostWgsUserDir, WGS_ATOM_SIDECAR_FILENAME);
  await writeFileAtomic(sidecarPath, Buffer.from(JSON.stringify(sidecar, null, 2), 'utf8'));
}

/**
 * Reads all containers and blob payloads from a local `wgs\<HexXuid>_<Scid>` directory.
 */
async function readLocalWgsWorkspace(wgsUserDir) {
  const hostWgsUserDir = toHostFilesystemPath(wgsUserDir);
  const indexPath = path.join(hostWgsUserDir, 'containers.index');
  const sidecar = await loadWgsSyncSidecar(hostWgsUserDir);

  let indexBuf;
  try {
    indexBuf = await fs.promises.readFile(indexPath);
  } catch (err) {
    if (err && err.code === 'ENOENT') {
      return {
        exists: false,
        index: null,
        containers: new Map(),
        sidecar,
      };
    }
    throw err;
  }

  const index = parseWgsContainersIndex(indexBuf);
  const containers = new Map();

  for (const cEntry of index.containers) {
    const containerDir = path.join(hostWgsUserDir, cEntry.folderGuid);
    const containerFile = path.join(containerDir, `container.${cEntry.containerNum}`);
    let blobRecords = [];
    try {
      const cBuf = await fs.promises.readFile(containerFile);
      blobRecords = parseWgsContainerBlobIndex(cBuf).blobs;
    } catch {
      blobRecords = [];
    }

    const sidecarContainer = sidecar.containers[cEntry.name] || {};
    const sidecarAtoms = sidecarContainer.atoms || {};
    const blobs = new Map();

    for (const bRec of blobRecords) {
      let chosenGuid = bRec.blobGuidA;
      let data = null;
      for (const candidate of [bRec.blobGuidA, bRec.blobGuidB]) {
        if (!candidate || candidate === '00000000000000000000000000000000') continue;
        try {
          data = await fs.promises.readFile(path.join(containerDir, candidate));
          chosenGuid = candidate;
          break;
        } catch {
          // Try alternate swap GUID
        }
      }
      if (!data) continue;
      const sha256 = crypto.createHash('sha256').update(data).digest('hex');
      const atomMeta = sidecarAtoms[bRec.name] || null;
      const unchangedAtom =
        atomMeta && atomMeta.sha256 === sha256 && atomMeta.atom ? atomMeta.atom : '';

      blobs.set(bRec.name, {
        name: bRec.name,
        blobGuid: chosenGuid,
        data,
        size: data.length,
        sha256,
        atom: unchangedAtom,
      });
    }

    containers.set(cEntry.name, {
      ...cEntry,
      remoteClientFileTime: sidecarContainer.remoteClientFileTime || '',
      etag: sidecarContainer.etag || cEntry.tag || '',
      blobs,
    });
  }

  return {
    exists: true,
    index,
    containers,
    sidecar,
  };
}

/**
 * Writes a full container/blob state atomically into `wgs\<HexXuid>_<Scid>\`
 * (`containers.index`, `<FOLDER_GUID>\container.<N>`, `<BLOB_GUID>`, and sync sidecar).
 */
async function writeLocalWgsWorkspace(wgsUserDir, options = {}) {
  const hostWgsUserDir = toHostFilesystemPath(wgsUserDir);
  const {
    containers = [],
    storePkgAumid = '',
    pkgDisplayName = '',
    syncMetadataId = '',
    deletedContainers = [],
  } = options;

  await fs.promises.mkdir(hostWgsUserDir, { recursive: true });
  const indexEntries = [];
  const sidecar = { containers: {}, deletedContainers: Array.from(new Set(deletedContainers)) };
  const activeFolderGuids = new Set();

  for (const c of containers) {
    const folderGuid = (c.folderGuid || generateUpperGuidHex()).toUpperCase();
    activeFolderGuids.add(folderGuid);
    const containerNum = Number.isInteger(c.containerNum) && c.containerNum > 0 ? c.containerNum : 1;
    const containerDir = path.join(hostWgsUserDir, folderGuid);
    await fs.promises.mkdir(containerDir, { recursive: true });

    const blobInputList =
      c.blobs instanceof Map ? Array.from(c.blobs.values()) : Array.isArray(c.blobs) ? c.blobs : [];
    const blobIndexEntries = [];
    const sidecarAtoms = {};
    let totalSize = 0;

    for (const b of blobInputList) {
      const buf = Buffer.isBuffer(b.data) ? b.data : Buffer.from(b.data || '');
      const blobGuid = (b.blobGuid || generateUpperGuidHex()).toUpperCase();
      await writeFileAtomic(path.join(containerDir, blobGuid), buf);

      blobIndexEntries.push({
        name: b.name,
        blobGuidA: blobGuid,
        blobGuidB: '00000000000000000000000000000000',
      });

      const sha256 = b.sha256 || crypto.createHash('sha256').update(buf).digest('hex');
      if (b.atom) {
        sidecarAtoms[b.name] = { atom: b.atom, sha256 };
      }
      totalSize += buf.length;
    }

    const containerNBytes = serializeWgsContainerBlobIndex(blobIndexEntries, 4);
    await writeFileAtomic(path.join(containerDir, `container.${containerNum}`), containerNBytes);

    const modifiedIso = c.modifiedIso || new Date().toISOString();
    indexEntries.push({
      name: c.name,
      displayName: c.displayName || c.name,
      tag: c.etag || c.tag || '',
      containerNum,
      stateFlags: c.dirty ? 1 : 0,
      dirty: Boolean(c.dirty),
      folderGuid,
      modifiedIso,
      totalSize,
    });

    sidecar.containers[c.name] = {
      remoteClientFileTime: c.remoteClientFileTime || '',
      etag: c.etag || c.tag || '',
      atoms: sidecarAtoms,
    };
  }

  const indexBytes = serializeWgsContainersIndex({
    version: 14,
    pkgDisplayName,
    storePkgAumid,
    syncMetadataId,
    containers: indexEntries,
  });

  await writeFileAtomic(path.join(hostWgsUserDir, 'containers.index'), indexBytes);
  await saveWgsSyncSidecar(hostWgsUserDir, sidecar);

  // Clean up orphaned container GUID directories removed during sync
  const entries = await fs.promises.readdir(hostWgsUserDir, { withFileTypes: true }).catch(() => []);
  for (const dirent of entries) {
    if (!dirent.isDirectory()) continue;
    if (/^[0-9A-F]{32}$/i.test(dirent.name) && !activeFolderGuids.has(dirent.name.toUpperCase())) {
      await fs.promises.rm(path.join(hostWgsUserDir, dirent.name), { recursive: true, force: true }).catch(() => {});
    }
  }
}

// ---------------------------------------------------------------------------
// `xgs` (XGameSaveFiles / PlayFabGameSave Folder Mode) <-> `wgs` Mirroring
// ---------------------------------------------------------------------------

const WGS_USER_SCID_DIR_RE =
  /^[0-9A-F]{16}_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const POISONED_USER_SCID_PREFIX_RE =
  /^([0-9A-F]{16}_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/(.+)$/i;

/**
 * Validates Connected Storage container names against Microsoft's `titlestorage.xboxlive.com` v107 grammar:
 * - Non-empty, <= 128 chars, no whitespace, control chars, or Windows-illegal characters.
 * - Never a `<HexXuid>_<Scid>` folder name or `<HexXuid>_<Scid>/...` poisoned path.
 * - Directory segments before `/` strictly require `[A-Za-z0-9_]+` (hyphens in path prefixes return HTTP 400 code 2000).
 */
function isValidTitleStorageContainerName(name) {
  if (typeof name !== 'string') return false;
  const normalized = name.replace(/\\/g, '/');
  if (!normalized || normalized.length > 128) return false;
  if (/[\x00-\x1f\x7f\s:*?"<>|]/.test(normalized)) return false;
  if (WGS_USER_SCID_DIR_RE.test(normalized) || POISONED_USER_SCID_PREFIX_RE.test(normalized)) {
    return false;
  }
  const parts = normalized.split('/');
  if (parts.some((p) => !p || p === '.' || p === '..')) return false;
  if (parts.length > 1) {
    for (let i = 0; i < parts.length - 1; i += 1) {
      if (!/^[A-Za-z0-9_]+$/.test(parts[i])) return false;
    }
  }
  return true;
}

/**
 * Validates `containerName` and encodes each `/` path segment individually so hierarchical
 * Connected Storage container names (`Settings/Graphics`, `Slot_01/SaveData`) preserve literal `/`
 * separators instead of mangling `/` into `%2F` (`HTTP 400 InvalidRequest`).
 *
 * @param {string} containerName
 * @returns {string}
 */
function encodeTitleStorageContainerPath(containerName) {
  const normalized = String(containerName || '').replace(/\\/g, '/');
  if (!isValidTitleStorageContainerName(normalized)) {
    throw new Error(`Invalid TitleStorage container name: "${String(containerName || '')}"`);
  }
  return normalized
    .split('/')
    .map((seg) => encodeURIComponent(seg))
    .join('/');
}

/**
 * Ensures `xgsUserDir` points to `.../SystemAppData/xgs/<HexXuid>_<Scid>` when `wgsUserDir`
 * is user-scoped (`.../SystemAppData/wgs/<HexXuid>_<Scid>`) and a caller mistakenly passed `.../SystemAppData/xgs`.
 */
function resolveEffectiveXgsUserDir(xgsUserDir, wgsUserDir) {
  if (!xgsUserDir) return null;
  const cleanXgs = String(xgsUserDir).trim();
  if (!cleanXgs) return null;
  if (wgsUserDir) {
    const wgsBase = path.basename(String(wgsUserDir).trim());
    const xgsBase = path.basename(cleanXgs);
    if (WGS_USER_SCID_DIR_RE.test(wgsBase) && xgsBase.toLowerCase() === 'xgs') {
      return path.join(cleanXgs, wgsBase);
    }
  }
  return cleanXgs;
}

/**
 * Self-heals `containers.index` workspaces that were previously poisoned by walking `SystemAppData/xgs`
 * instead of `SystemAppData/xgs/<HexXuid>_<Scid>`, producing `<HexXuid>_<Scid>/<containerName>` duplicates.
 */
function sanitizePoisonedWgsContainersMap(containersMap, pendingDeletionsSet = null) {
  let mutated = false;
  if (pendingDeletionsSet && typeof pendingDeletionsSet.values === 'function') {
    for (const delName of Array.from(pendingDeletionsSet.values())) {
      if (
        POISONED_USER_SCID_PREFIX_RE.test(String(delName)) ||
        !isValidTitleStorageContainerName(String(delName))
      ) {
        pendingDeletionsSet.delete(delName);
        mutated = true;
      }
    }
  }
  if (!containersMap || typeof containersMap.entries !== 'function') return mutated;

  for (const [cName, container] of Array.from(containersMap.entries())) {
    const poisonedMatch = POISONED_USER_SCID_PREFIX_RE.exec(String(cName));
    if (poisonedMatch) {
      const cleanName = poisonedMatch[2];
      containersMap.delete(cName);
      mutated = true;
      if (isValidTitleStorageContainerName(cleanName) && !containersMap.has(cleanName)) {
        containersMap.set(cleanName, {
          ...container,
          name: cleanName,
          displayName:
            container.displayName && container.displayName !== cName
              ? container.displayName
              : cleanName,
        });
      }
    }
  }
  return mutated;
}

async function cleanupStaleRootXgsDuplicates(effectiveXgsUserDir, containerNamesIterable) {
  if (!effectiveXgsUserDir) return;
  const userBase = path.basename(effectiveXgsUserDir);
  if (!WGS_USER_SCID_DIR_RE.test(userBase)) return;
  const parentDir = path.dirname(effectiveXgsUserDir);
  if (path.basename(parentDir).toLowerCase() !== 'xgs') return;

  const topSegments = new Set();
  for (const rawName of containerNamesIterable || []) {
    const clean = String(rawName || '').replace(/\\/g, '/').split('/')[0];
    if (clean && clean !== '.' && clean !== '..' && !WGS_USER_SCID_DIR_RE.test(clean)) {
      topSegments.add(clean);
    }
  }
  for (const seg of topSegments) {
    const staleRootCopy = path.join(parentDir, seg);
    const st = await fs.promises.lstat(staleRootCopy).catch(() => null);
    if (st && st.isDirectory() && !st.isSymbolicLink()) {
      await fs.promises.rm(staleRootCopy, { recursive: true, force: true }).catch(() => {});
    }
  }
}

async function loadXgsSyncSidecar(effectiveXgsUserDir) {
  if (!effectiveXgsUserDir) {
    return { exists: false, active: false, knownContainers: [], deletedContainers: [] };
  }
  const hostXgsDir = toHostFilesystemPath(effectiveXgsUserDir);
  const sidecarPath = path.join(hostXgsDir, XGS_SYNC_SIDECAR_FILENAME);
  try {
    const raw = await fs.promises.readFile(sidecarPath, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') {
      return {
        exists: true,
        active: Boolean(parsed.active),
        knownContainers: Array.isArray(parsed.knownContainers) ? parsed.knownContainers : [],
        deletedContainers: Array.isArray(parsed.deletedContainers) ? parsed.deletedContainers : [],
      };
    }
  } catch {
    // No sidecar yet
  }
  return { exists: false, active: false, knownContainers: [], deletedContainers: [] };
}

async function saveXgsSyncSidecar(effectiveXgsUserDir, meta) {
  if (!effectiveXgsUserDir) return;
  const hostXgsDir = toHostFilesystemPath(effectiveXgsUserDir);
  await fs.promises.mkdir(hostXgsDir, { recursive: true });
  const sidecarPath = path.join(hostXgsDir, XGS_SYNC_SIDECAR_FILENAME);
  const payload = {
    active: Boolean(meta.active),
    knownContainers: Array.from(new Set(meta.knownContainers || [])),
    deletedContainers: Array.from(new Set(meta.deletedContainers || [])),
    updatedAt: new Date().toISOString(),
  };
  await writeFileAtomic(sidecarPath, Buffer.from(JSON.stringify(payload, null, 2), 'utf8'));
}

async function discoverXgsContainersOnDisk(effectiveXgsUserDir) {
  const discovered = new Map(); // containerName -> Map<blobName, Buffer>
  const hostXgsDir = toHostFilesystemPath(effectiveXgsUserDir);
  const st = await fs.promises.stat(hostXgsDir).catch(() => null);
  if (!st || !st.isDirectory()) return discovered;

  const walk = async (curDir, relParts) => {
    const dirents = await fs.promises.readdir(curDir, { withFileTypes: true });
    for (const d of dirents) {
      if (d.name.startsWith('.')) continue;
      if (WGS_USER_SCID_DIR_RE.test(d.name)) continue;
      const full = path.join(curDir, d.name);
      if (d.isSymbolicLink()) continue;
      if (d.isDirectory()) {
        await walk(full, [...relParts, d.name]);
      } else if (d.isFile() && relParts.length > 0) {
        const containerName = relParts.join('/');
        if (!isValidTitleStorageContainerName(containerName)) continue;
        if (!discovered.has(containerName)) discovered.set(containerName, new Map());
        const fileData = await fs.promises.readFile(full);
        discovered.get(containerName).set(d.name, fileData);
      }
    }
  };

  await walk(hostXgsDir, []);
  return discovered;
}

async function exportWgsToXgsFolder(wgsUserDir, xgsUserDir, options = {}) {
  const rawEffectiveXgsUserDir = resolveEffectiveXgsUserDir(xgsUserDir, wgsUserDir);
  if (!rawEffectiveXgsUserDir) return;
  const effectiveXgsUserDir = toHostFilesystemPath(rawEffectiveXgsUserDir);
  const hostWgsUserDir = toHostFilesystemPath(wgsUserDir);
  const workspace = await readLocalWgsWorkspace(hostWgsUserDir);
  const xgsMeta = await loadXgsSyncSidecar(effectiveXgsUserDir);
  const existingOnDisk = await discoverXgsContainersOnDisk(effectiveXgsUserDir);

  await fs.promises.mkdir(effectiveXgsUserDir, { recursive: true });

  // D6.4: Only seed xgs/ from legacy wgs/ when xgs/ has zero existing sync metadata/history.
  // Once xgs/ is active, never copy deleted or legacy wgs/ containers back into xgs/!
  const isXgsAlreadyActive =
    xgsMeta.exists ||
    xgsMeta.active ||
    xgsMeta.knownContainers.length > 0 ||
    xgsMeta.deletedContainers.length > 0 ||
    existingOnDisk.size > 0;

  const tombstonedSet = new Set([
    ...(workspace.sidecar.deletedContainers || []),
    ...(xgsMeta.deletedContainers || []),
  ]);
  const knownSet = new Set([...xgsMeta.knownContainers, ...existingOnDisk.keys()]);
  const cloudPulledSet =
    options.cloudPulledContainerNames instanceof Set
      ? options.cloudPulledContainerNames
      : Array.isArray(options.cloudPulledContainerNames)
        ? new Set(options.cloudPulledContainerNames)
        : null;
  const remotelyPrunedSet =
    options.remotelyPrunedContainerNames instanceof Set
      ? options.remotelyPrunedContainerNames
      : Array.isArray(options.remotelyPrunedContainerNames)
        ? new Set(options.remotelyPrunedContainerNames)
        : null;

  if (remotelyPrunedSet && remotelyPrunedSet.size > 0) {
    for (const prunedName of remotelyPrunedSet) {
      const safeParts = String(prunedName || '')
        .replace(/\\/g, '/')
        .split('/')
        .filter((p) => p && p !== '.' && p !== '..');
      if (safeParts.length > 0) {
        const prunedDir = path.join(effectiveXgsUserDir, ...safeParts);
        await fs.promises.rm(prunedDir, { recursive: true, force: true }).catch(() => {});
      }
      knownSet.delete(prunedName);
      tombstonedSet.add(prunedName);
    }
  }

  if (!workspace.exists) {
    if (isXgsAlreadyActive) {
      await saveXgsSyncSidecar(effectiveXgsUserDir, {
        active: true,
        knownContainers: Array.from(knownSet),
        deletedContainers: Array.from(tombstonedSet),
      });
    }
    return;
  }

  let wroteAny = false;
  for (const container of workspace.containers.values()) {
    const rawName = String(container.name || '').replace(/\\/g, '/');
    if (!isValidTitleStorageContainerName(rawName)) continue;
    if (tombstonedSet.has(rawName)) continue;

    // When xgs/ is already active, ONLY materialize explicitly newly cloud-pulled containers
    if (isXgsAlreadyActive) {
      if (!cloudPulledSet || !cloudPulledSet.has(rawName)) {
        continue;
      }
    }

    const safeRelParts = rawName.split('/').filter((p) => p && p !== '.' && p !== '..');
    if (safeRelParts.length === 0) continue;
    const cDir = path.join(effectiveXgsUserDir, ...safeRelParts);
    await fs.promises.mkdir(cDir, { recursive: true });
    for (const blob of container.blobs.values()) {
      const safeBlobName = path.basename(String(blob.name || '').replace(/\\/g, '/'));
      if (!safeBlobName || safeBlobName === '.' || safeBlobName === '..') continue;
      await writeFileAtomic(path.join(cDir, safeBlobName), blob.data);
    }
    knownSet.add(rawName);
    wroteAny = true;
  }

  if (wroteAny || isXgsAlreadyActive || workspace.containers.size > 0) {
    await saveXgsSyncSidecar(effectiveXgsUserDir, {
      active: true,
      knownContainers: Array.from(knownSet),
      deletedContainers: Array.from(tombstonedSet),
    });
  }

  await cleanupStaleRootXgsDuplicates(effectiveXgsUserDir, workspace.containers.keys());
}

async function importXgsFolderIntoWgs(xgsUserDir, wgsUserDir, storePkgAumid = '') {
  const effectiveXgsUserDir = resolveEffectiveXgsUserDir(xgsUserDir, wgsUserDir);
  if (!effectiveXgsUserDir) return false;
  const st = await fs.promises.stat(effectiveXgsUserDir).catch(() => null);
  if (!st || !st.isDirectory()) return false;

  const workspace = await readLocalWgsWorkspace(wgsUserDir);
  const xgsMeta = await loadXgsSyncSidecar(effectiveXgsUserDir);
  const pendingDeletionsSet = new Set(workspace.sidecar.deletedContainers || []);
  const xgsKnownSet = new Set(xgsMeta.knownContainers || []);
  const xgsDeletedSet = new Set(xgsMeta.deletedContainers || []);
  let anyMutated = sanitizePoisonedWgsContainersMap(workspace.containers, pendingDeletionsSet);

  const discovered = await discoverXgsContainersOnDisk(effectiveXgsUserDir);
  const xgsHasHistory =
    xgsMeta.exists ||
    xgsMeta.active ||
    xgsKnownSet.size > 0 ||
    xgsDeletedSet.size > 0 ||
    discovered.size > 0;

  if (discovered.size === 0 && !workspace.exists && !xgsHasHistory) return false;

  const updatedContainers = [];
  let xgsMetaMutated = false;

  // Check existing containers for modifications or save-slot deletions in xgs/ (D6.4)
  for (const [cName, existing] of workspace.containers.entries()) {
    if (!discovered.has(cName)) {
      if (xgsKnownSet.has(cName) || xgsDeletedSet.has(cName)) {
        // Container was previously active in xgs/ and deleted on disk -> tombstone it!
        pendingDeletionsSet.add(cName);
        xgsDeletedSet.add(cName);
        xgsKnownSet.delete(cName);
        anyMutated = true;
        xgsMetaMutated = true;
        continue;
      }
      updatedContainers.push(existing);
      continue;
    }
    const diskBlobs = discovered.get(cName);
    discovered.delete(cName);
    if (!xgsKnownSet.has(cName)) {
      xgsKnownSet.add(cName);
      xgsMetaMutated = true;
    }
    if (xgsDeletedSet.delete(cName)) {
      xgsMetaMutated = true;
    }
    pendingDeletionsSet.delete(cName);

    let containerDirty = Boolean(existing.dirty);
    const mergedBlobs = [];

    if (diskBlobs.size !== existing.blobs.size) {
      containerDirty = true;
    }

    for (const [bName, data] of diskBlobs.entries()) {
      const sha256 = crypto.createHash('sha256').update(data).digest('hex');
      const prev = existing.blobs.get(bName);
      if (!prev || prev.sha256 !== sha256) {
        containerDirty = true;
        mergedBlobs.push({
          name: bName,
          blobGuid: prev?.blobGuid || generateUpperGuidHex(),
          data,
          sha256,
          atom: '',
        });
      } else {
        mergedBlobs.push(prev);
      }
    }

    if (containerDirty) anyMutated = true;
    updatedContainers.push({
      ...existing,
      dirty: containerDirty,
      modifiedIso: containerDirty ? new Date().toISOString() : existing.modifiedIso,
      blobs: mergedBlobs,
    });
  }

  // Add newly created xgs/ subfolders as dirty Connected Storage containers
  for (const [cName, diskBlobs] of discovered.entries()) {
    if (!isValidTitleStorageContainerName(cName)) continue;
    anyMutated = true;
    xgsMetaMutated = true;
    xgsKnownSet.add(cName);
    xgsDeletedSet.delete(cName);
    pendingDeletionsSet.delete(cName);

    const blobs = [];
    for (const [bName, data] of diskBlobs.entries()) {
      blobs.push({
        name: bName,
        blobGuid: generateUpperGuidHex(),
        data,
        sha256: crypto.createHash('sha256').update(data).digest('hex'),
        atom: '',
      });
    }
    updatedContainers.push({
      name: cName,
      displayName: cName,
      containerNum: 1,
      dirty: true,
      folderGuid: generateUpperGuidHex(),
      modifiedIso: new Date().toISOString(),
      blobs,
    });
  }

  const deletedContainers = Array.from(pendingDeletionsSet);

  if (anyMutated) {
    await writeLocalWgsWorkspace(wgsUserDir, {
      containers: updatedContainers,
      storePkgAumid: workspace.index?.storePkgAumid || storePkgAumid,
      deletedContainers,
    });
  }

  if (xgsMetaMutated || (discovered.size > 0 && !xgsMeta.active)) {
    await saveXgsSyncSidecar(effectiveXgsUserDir, {
      active: true,
      knownContainers: Array.from(xgsKnownSet),
      deletedContainers: Array.from(xgsDeletedSet),
    });
  }

  return anyMutated;
}

// ---------------------------------------------------------------------------
// Xbox Live Connected Storage (`titlestorage.xboxlive.com` v107) Sync Engine
// ---------------------------------------------------------------------------

function normalizeRemoteContainerItem(rawItem) {
  if (!rawItem || typeof rawItem !== 'object') return null;
  let name = String(rawItem.fileName || rawItem.name || '');
  if (/,savedgame$/i.test(name)) {
    name = name.replace(/,savedgame$/i, '');
  }
  if (!name) return null;
  return {
    name,
    displayName: String(rawItem.displayName || name),
    clientFileTime: String(rawItem.clientFileTime || ''),
    etag: String(rawItem.etag || ''),
    size: Number(rawItem.size || 0),
  };
}

function parseRemoteAtomsMap(containerJson) {
  const out = new Map();
  const atoms = containerJson?.atoms;
  if (Array.isArray(atoms)) {
    for (const item of atoms) {
      if (!item || !item.name) continue;
      if (item.blobUri) {
        out.set(String(item.name), validateTitleStorageBlobUri(item.blobUri));
      } else if (item.atom) {
        const atomStr = String(item.atom);
        if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(atomStr)) {
          out.set(String(item.name), validateTitleStorageBlobUri(atomStr));
        } else {
          out.set(String(item.name), /,binary$/i.test(atomStr) ? atomStr : `${atomStr},binary`);
        }
      }
    }
  } else if (atoms && typeof atoms === 'object') {
    for (const [blobName, atomVal] of Object.entries(atoms)) {
      if (!atomVal) continue;
      if (typeof atomVal === 'object' && atomVal.blobUri) {
        out.set(blobName, validateTitleStorageBlobUri(atomVal.blobUri));
      } else {
        const atomStr = String(atomVal);
        if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(atomStr)) {
          out.set(blobName, validateTitleStorageBlobUri(atomStr));
        } else {
          out.set(blobName, /,binary$/i.test(atomStr) ? atomStr : `${atomStr},binary`);
        }
      }
    }
  }
  return out;
}

/**
 * Creates a Connected Storage REST v107 client bound to an user XUID, SCID, PFN, and `authProvider`.
 */
function createTitleStorageHttpError(/** @type {string} */ message, /** @type {any} */ res) {
  let errJson = null;
  try {
    errJson = res.json();
  } catch {
    errJson = null;
  }
  const detail = errJson?.description || errJson?.message || '';
  /** @type {Error & { status?: number, xblCode?: any }} */
  const err = new Error(detail ? `${message} (${detail})` : message);
  err.status = res.status;
  if (errJson && (errJson.code !== undefined || errJson.errorCode !== undefined)) {
    const rawCode = errJson.code !== undefined ? errJson.code : errJson.errorCode;
    const numCode = Number(rawCode);
    err.xblCode = Number.isNaN(numCode) ? rawCode : numCode;
  }
  return err;
}

function createTitleStorageClient(options = {}) {
  const {
    xuid,
    scid,
    msaAppId = '',
    titleId = '',
    authProvider,
    authorizationHeader,
    fetchImpl = globalThis.fetch,
    friendlyName = 'OneLauncher',
  } = options;
  const packageFamilyName = options.packageFamilyName || options.pfn || '';
  const titleStorageOrigin =
    options.titleStorageOrigin || options.baseUrl || options.origin || DEFAULT_TITLE_STORAGE_ORIGIN;

  if (!xuid || !scid) {
    throw new Error('createTitleStorageClient requires both xuid and scid');
  }
  if (typeof fetchImpl !== 'function') {
    throw new Error('Global fetch is unavailable for createTitleStorageClient');
  }

  const baseUrl = `${String(titleStorageOrigin).replace(/\/+$/, '')}/connectedstorage/users/xuid(${xuid})/scids/${String(scid).toLowerCase()}`;
  let allowedLoopbackOrigin = '';
  try {
    const parsedOrigin = new URL(String(titleStorageOrigin));
    const h = parsedOrigin.hostname.toLowerCase();
    if (
      (parsedOrigin.protocol === 'http:' || parsedOrigin.protocol === 'https:') &&
      (h === '127.0.0.1' || h === 'localhost' || h === '::1' || h === '[::1]') &&
      parsedOrigin.port
    ) {
      allowedLoopbackOrigin = parsedOrigin.origin;
    }
  } catch {
    allowedLoopbackOrigin = '';
  }

  /**
   * @param {string} method
   * @param {string} subPath
   * @param {{ headers?: Record<string, string>, body?: any, signal?: AbortSignal }} [reqOpts]
   */
  async function signedRequest(method, subPath, { headers = {}, body = null, signal } = {}) {
    const url = subPath ? `${baseUrl}${subPath.startsWith('/') ? subPath : `/${subPath}`}` : baseUrl;
    /** @type {Record<string, string>} */
    const reqHeaders = {
      'x-xbl-contract-version': '107',
      ...(packageFamilyName ? { 'x-xbl-pfn': packageFamilyName } : {}),
      Connection: 'Keep-Alive',
      ...headers,
    };

    const hasBody = body !== null && body !== undefined;
    const bodyBuffer = !hasBody
      ? Buffer.alloc(0)
      : Buffer.isBuffer(body)
        ? body
        : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body), 'utf8');

    if (authProvider && typeof authProvider.getTokenAndSignatureForUrl === 'function') {
      const auth = await authProvider.getTokenAndSignatureForUrl({
        method,
        url,
        headers: reqHeaders,
        body: bodyBuffer,
        bodyBuffer,
        msaAppId,
        titleId,
      });
      const authTok = auth?.token || auth?.authorization;
      if (authTok) reqHeaders.Authorization = authTok;
      if (auth?.signature) reqHeaders.Signature = auth.signature;
    } else if (authorizationHeader) {
      reqHeaders.Authorization = authorizationHeader;
    }

    const resp = await fetchImpl(url, {
      method,
      headers: reqHeaders,
      body: hasBody ? bodyBuffer : undefined,
      signal: createTitleStorageFetchSignal(signal),
    });

    const ab = await resp.arrayBuffer();
    const respBuf = Buffer.from(ab);
    return {
      status: resp.status,
      ok: resp.status >= 200 && resp.status < 300,
      headers: resp.headers,
      buffer: respBuf,
      json() {
        return respBuf.length > 0 ? JSON.parse(respBuf.toString('utf8')) : {};
      },
    };
  }

  return {
    baseUrl,
    async acquireLock(signal) {
      const res = await signedRequest(
        'PUT',
        `/lock?friendlyName=${encodeURIComponent(friendlyName)}`,
        {
          headers: {
            'x-xbl-lock-ver': '1',
            'Content-Type': 'application/json',
          },
          signal,
        }
      );
      if (!res.ok) {
        throw createTitleStorageHttpError(`TitleStorage lock failed with HTTP ${res.status}`, res);
      }
      const data = res.json();
      const ownerChangeId = data.ownerChangeId || data.ownerChangedId || '';
      return {
        locked: true,
        quotaBytes: Number(data.quotaBytes || 256 * 1024 * 1024),
        ownerChangeId,
        ownerChangedId: ownerChangeId,
      };
    },

    async releaseLock(newSavesUploaded = false, signal) {
      await signedRequest(
        'DELETE',
        `/lock?newSavesUploaded=${newSavesUploaded ? 'true' : 'false'}`,
        { signal }
      ).catch(() => {});
    },

    async listContainers(signal) {
      const all = [];
      let continuationToken = null;
      do {
        const query = continuationToken
          ? `?continuationToken=${encodeURIComponent(continuationToken)}`
          : '';
        const res = await signedRequest('GET', query, {
          headers: { Accept: 'application/json' },
          signal,
        });
        if (res.status === 404) return [];
        if (!res.ok) {
          throw createTitleStorageHttpError(
            `TitleStorage listContainers failed with HTTP ${res.status}`,
            res
          );
        }
        const payload = res.json();
        for (const raw of payload.blobs || []) {
          const item = normalizeRemoteContainerItem(raw);
          if (item) all.push(item);
        }
        continuationToken = payload.pagingInfo?.continuationToken || null;
      } while (continuationToken);
      return all;
    },

    async getContainerAtoms(containerName, signal) {
      const enc = encodeTitleStorageContainerPath(containerName);
      let res = await signedRequest('GET', `/${enc},savedgame`, {
        headers: { Accept: 'application/json' },
        signal,
      });
      if (res.status === 404) {
        res = await signedRequest('GET', `/savedgames/${enc}`, {
          headers: { Accept: 'application/json' },
          signal,
        });
      }
      if (!res.ok) {
        throw createTitleStorageHttpError(
          `TitleStorage getContainerAtoms(${containerName}) failed with HTTP ${res.status}`,
          res
        );
      }
      return parseRemoteAtomsMap(res.json());
    },

    async downloadAtom(atomId, signal) {
      const rawAtomStr = String(atomId || '').trim();
      const fetchValidatedBlobUri = async (candidateBlobUri) => {
        const safeBlobUri = validateTitleStorageBlobUri(candidateBlobUri, {
          allowedLoopbackOrigin,
        });
        const blobRes = await fetchImpl(safeBlobUri, {
          method: 'GET',
          redirect: 'manual',
          signal: createTitleStorageFetchSignal(signal),
        });
        if (blobRes.status >= 300 && blobRes.status < 400) {
          const loc = blobRes.headers?.get?.('location') || '';
          const safeRedirect = validateTitleStorageBlobUri(loc, {
            allowedLoopbackOrigin,
          });
          const redirRes = await fetchImpl(safeRedirect, {
            method: 'GET',
            redirect: 'error',
            signal: createTitleStorageFetchSignal(signal),
          });
          if (redirRes.status < 200 || redirRes.status >= 300) {
            throw new Error(`TitleStorage blobUri redirect GET failed with HTTP ${redirRes.status}`);
          }
          return Buffer.from(await redirRes.arrayBuffer());
        }
        if (blobRes.status < 200 || blobRes.status >= 300) {
          throw new Error(`TitleStorage blobUri GET failed with HTTP ${blobRes.status}`);
        }
        return Buffer.from(await blobRes.arrayBuffer());
      };

      if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(rawAtomStr)) {
        return fetchValidatedBlobUri(rawAtomStr);
      }

      const cleanAtom = /,binary$/i.test(rawAtomStr) ? rawAtomStr : `${rawAtomStr},binary`;
      const res = await signedRequest('GET', `/${cleanAtom}`, { signal });
      if (!res.ok) {
        throw createTitleStorageHttpError(
          `TitleStorage downloadAtom(${cleanAtom}) failed with HTTP ${res.status}`,
          res
        );
      }

      const ct = String(res.headers?.get?.('content-type') || '').toLowerCase();
      if (ct.includes('application/json') && res.buffer.length > 0 && res.buffer.length <= 4096) {
        let maybeObj = null;
        try {
          maybeObj = res.json();
        } catch {
          maybeObj = null;
        }
        if (maybeObj && typeof maybeObj.blobUri === 'string' && maybeObj.blobUri) {
          return fetchValidatedBlobUri(maybeObj.blobUri);
        }
      }

      return res.buffer;
    },

    async uploadAtom(dataBuffer, signal) {
      const uuid36 = formatDashedUpperUuid(generateUpperGuidHex());
      const atomToken = `${uuid36},binary`;

      if (dataBuffer.length <= LARGE_ATOM_THRESHOLD_BYTES) {
        const res = await signedRequest('PUT', `/${atomToken}`, {
          headers: { 'Content-Type': 'application/octet-stream' },
          body: dataBuffer,
          signal,
        });
        if (!res.ok) {
          throw createTitleStorageHttpError(
            `TitleStorage direct atom PUT failed with HTTP ${res.status}`,
            res
          );
        }
        return atomToken;
      }

      // Large (> 4 MiB) block upload flow: POST /atoms/<uuid> -> PUT Azure blocks -> POST ?commit=true
      const allocRes = await signedRequest('POST', `/atoms/${uuid36}`, {
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify({ size: dataBuffer.length }),
        signal,
      });
      if (!allocRes.ok) {
        throw createTitleStorageHttpError(
          `TitleStorage large atom allocation failed with HTTP ${allocRes.status}`,
          allocRes
        );
      }
      const { blobUri } = allocRes.json();
      if (!blobUri) {
        throw new Error('TitleStorage large atom allocation omitted blobUri');
      }
      const safeBlobUri = validateTitleStorageBlobUri(blobUri, {
        allowedLoopbackOrigin,
      });

      const blockCount = Math.ceil(dataBuffer.length / LARGE_ATOM_THRESHOLD_BYTES);
      const blockIds = [];
      for (let i = 0; i < blockCount; i += 1) {
        const blockId = Buffer.from(String(i).padStart(8, '0'), 'ascii').toString('base64');
        blockIds.push(blockId);
        const slice = dataBuffer.subarray(
          i * LARGE_ATOM_THRESHOLD_BYTES,
          Math.min(dataBuffer.length, (i + 1) * LARGE_ATOM_THRESHOLD_BYTES)
        );
        const sep = safeBlobUri.includes('?') ? '&' : '?';
        const blockUrl = `${safeBlobUri}${sep}comp=block&blockid=${encodeURIComponent(blockId)}`;
        const putRes = await fetchImpl(blockUrl, {
          method: 'PUT',
          headers: {
            'x-ms-version': '2015-04-05',
            'Content-Length': String(slice.length),
          },
          body: slice,
          signal: createTitleStorageFetchSignal(signal),
        });
        if (putRes.status < 200 || putRes.status >= 300) {
          throw new Error(`Azure block upload ${i} failed with HTTP ${putRes.status}`);
        }
      }

      const commitRes = await signedRequest('POST', `/atoms/${uuid36}?commit=true`, {
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify({ blockIds, size: dataBuffer.length }),
        signal,
      });
      if (!commitRes.ok) {
        throw createTitleStorageHttpError(
          `TitleStorage large atom commit failed with HTTP ${commitRes.status}`,
          commitRes
        );
      }
      return atomToken;
    },

    async putContainerManifest(containerName, { displayName, clientFileTime, atomsObject }, signal) {
      const encName = encodeTitleStorageContainerPath(containerName);
      const encDisplay = encodeURIComponent(displayName || containerName);
      const iso = clientFileTime || new Date().toISOString();
      const res = await signedRequest(
        'PUT',
        `/${encName},savedgame?clientFileTime=${encodeURIComponent(iso)}&displayName=${encDisplay}`,
        {
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ atoms: atomsObject }),
          signal,
        }
      );
      if (!res.ok) {
        throw createTitleStorageHttpError(
          `TitleStorage putContainerManifest(${containerName}) failed with HTTP ${res.status}`,
          res
        );
      }
      return { clientFileTime: iso };
    },

    async deleteContainer(containerName, signal) {
      const encName = encodeTitleStorageContainerPath(containerName);
      const res = await signedRequest('DELETE', `/${encName},savedgame`, { signal });
      if (!res.ok && res.status !== 404) {
        throw createTitleStorageHttpError(
          `TitleStorage deleteContainer(${containerName}) failed with HTTP ${res.status}`,
          res
        );
      }
    },
  };
}

/**
 * Synchronizes a local `wgs\<HexXuid>_<Scid>` (and optional `xgs\<HexXuid>_<Scid>`) workspace
 * with Xbox Live Connected Storage (`titlestorage.xboxlive.com`, contract v107).
 *
 * Modes:
 * - `'pre_launch'`: Acquires lock, lists remote containers, pulls newer cloud blobs, uploads any offline dirty saves, exports `xgs/` view, optionally holds or releases lock.
 * - `'in_session'`: Pushes dirty local containers immediately to cloud.
 * - `'post_exit'`: Imports `xgs/` changes, pushes all dirty containers + deletions, releases session lock.
 */
async function syncXboxTitleStorage(options = {}) {
  const {
    mode = 'pre_launch',
    xgsUserDir = null,
    xuid,
    scid,
    msaAppId = '',
    titleId = '',
    storePkgAumid = '',
    authProvider,
    authorizationHeader,
    fetchImpl,
    keepLockHeld = false,
    alreadyLocked = false,
    signal,
  } = options;
  const wgsUserDir = options.wgsUserDir || options.wgsDir;
  const packageFamilyName = options.packageFamilyName || options.pfn || '';
  const titleStorageOrigin =
    options.titleStorageOrigin || options.baseUrl || options.origin;

  if (!wgsUserDir) {
    throw new Error('syncXboxTitleStorage requires wgsUserDir');
  }

  const normalizedScid = String(scid || '').trim().toLowerCase();
  const VALID_SCID_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  let candidateFallbackScid = '';
  if (options._isFallbackRetry !== true) {
    const explicitFallback = String(options.fallbackScid || '').trim().toLowerCase();
    const derivedFromTitleId = titleId ? deriveDefaultScidFromTitleId(titleId).toLowerCase() : '';
    if (VALID_SCID_UUID_RE.test(explicitFallback) && explicitFallback !== normalizedScid) {
      candidateFallbackScid = explicitFallback;
    } else if (
      VALID_SCID_UUID_RE.test(derivedFromTitleId) &&
      derivedFromTitleId !== normalizedScid
    ) {
      candidateFallbackScid = derivedFromTitleId;
    }
  }

  const effectiveXgsUserDir = resolveEffectiveXgsUserDir(xgsUserDir, wgsUserDir);

  const retryWithCandidateScid = async () => {
    let retryWgsUserDir = String(wgsUserDir);
    let retryXgsUserDir = effectiveXgsUserDir;
    const hasLocalWgsSaves =
      mode !== 'pre_launch' && fs.existsSync(path.join(retryWgsUserDir, 'containers.index'));
    if (
      options.preserveLocalWgsDirOnFallback !== true &&
      !hasLocalWgsSaves &&
      xuid &&
      normalizedScid &&
      candidateFallbackScid
    ) {
      try {
        const initialFolder = formatWgsUserScidFolderName(xuid, normalizedScid);
        const nextFolder = formatWgsUserScidFolderName(xuid, candidateFallbackScid);
        if (
          initialFolder &&
          nextFolder &&
          path.basename(retryWgsUserDir).toLowerCase() === initialFolder.toLowerCase()
        ) {
          retryWgsUserDir = path.join(path.dirname(retryWgsUserDir), nextFolder);
        }
        if (
          retryXgsUserDir &&
          initialFolder &&
          nextFolder &&
          path.basename(retryXgsUserDir).toLowerCase() === initialFolder.toLowerCase()
        ) {
          retryXgsUserDir = path.join(path.dirname(retryXgsUserDir), nextFolder);
        }
      } catch {}
    }
    return syncXboxTitleStorage({
      ...options,
      scid: candidateFallbackScid,
      fallbackScid: undefined,
      wgsUserDir: retryWgsUserDir,
      xgsUserDir: retryXgsUserDir,
      _isFallbackRetry: true,
    });
  };

  if (mode === 'post_exit' || mode === 'in_session') {
    await importXgsFolderIntoWgs(effectiveXgsUserDir, wgsUserDir, storePkgAumid);
  } else if (mode === 'pre_launch' && effectiveXgsUserDir) {
    // If xgs/ already has active sync history, import offline xgs/ edits & save-slot deletions first
    const preXgsMeta = await loadXgsSyncSidecar(effectiveXgsUserDir);
    if (
      preXgsMeta.exists ||
      preXgsMeta.active ||
      preXgsMeta.knownContainers.length > 0 ||
      preXgsMeta.deletedContainers.length > 0
    ) {
      await importXgsFolderIntoWgs(effectiveXgsUserDir, wgsUserDir, storePkgAumid);
    }
  }

  const client = createTitleStorageClient({
    xuid,
    scid: normalizedScid || scid,
    packageFamilyName,
    msaAppId,
    titleId,
    titleStorageOrigin,
    authProvider,
    authorizationHeader,
    fetchImpl,
  });

  let lockAcquired = Boolean(alreadyLocked);
  let readOnlyFallback = false;
  let uploadedContainers = 0;
  let downloadedContainers = 0;
  let deletedRemoteContainers = 0;
  let quotaBytes = 256 * 1024 * 1024;

  try {
    if (!lockAcquired) {
      try {
        const lockInfo = await client.acquireLock(signal);
        lockAcquired = lockInfo.locked;
        quotaBytes = lockInfo.quotaBytes;
      } catch (lockErr) {
        if (
          candidateFallbackScid &&
          (lockErr?.status === 404 ||
            (lockErr?.status === 403 && Number(lockErr?.xblCode) !== 2016))
        ) {
          return await retryWithCandidateScid();
        }
        if (
          lockErr?.status === 404 ||
          (lockErr?.status === 400 && Number(lockErr?.xblCode) === 2000)
        ) {
          return {
            synced: false,
            skipped: true,
            unsupportedForTitle: true,
            skippedReason: 'title_storage_not_provisioned',
            resolvedScid: normalizedScid,
            resolvedWgsUserDir: wgsUserDir,
            downloadedContainers: 0,
            uploadedContainers: 0,
            deletedRemoteContainers: 0,
          };
        }
        if (
          mode === 'pre_launch' &&
          lockErr?.status === 403 &&
          (lockErr?.xblCode === undefined || Number(lockErr?.xblCode) === 2016)
        ) {
          readOnlyFallback = true;
        } else {
          throw lockErr;
        }
      }
    }

    const workspace = await readLocalWgsWorkspace(wgsUserDir);
    const mergedContainers = new Map(workspace.containers);
    const pendingDeletions = new Set(workspace.sidecar.deletedContainers || []);
    sanitizePoisonedWgsContainersMap(mergedContainers, pendingDeletions);

    // Push pending container deletions first (only when session lock is held)
    if (!readOnlyFallback) {
      for (const delName of Array.from(pendingDeletions)) {
        if (!isValidTitleStorageContainerName(delName)) {
          pendingDeletions.delete(delName);
          mergedContainers.delete(delName);
          continue;
        }
        await client.deleteContainer(delName, signal);
        pendingDeletions.delete(delName);
        mergedContainers.delete(delName);
        deletedRemoteContainers += 1;
      }
    }

    const cloudPulledContainerNames = new Set();
    const remotelyPrunedContainerNames = new Set();

    if (mode === 'pre_launch') {
      let remoteList;
      try {
        remoteList = await client.listContainers(signal);
      } catch (listErr) {
        if (
          candidateFallbackScid &&
          (listErr?.status === 404 || listErr?.status === 403)
        ) {
          if (lockAcquired && !keepLockHeld) {
            await client.releaseLock(false, signal);
            lockAcquired = false;
          }
          return await retryWithCandidateScid();
        }
        if (
          listErr?.status === 404 ||
          (listErr?.status === 400 && Number(listErr?.xblCode) === 2000)
        ) {
          if (lockAcquired && !keepLockHeld) {
            await client.releaseLock(false, signal);
            lockAcquired = false;
          }
          return {
            synced: false,
            skipped: true,
            unsupportedForTitle: true,
            skippedReason: 'title_storage_not_provisioned',
            resolvedScid: normalizedScid,
            resolvedWgsUserDir: wgsUserDir,
            downloadedContainers: 0,
            uploadedContainers: 0,
            deletedRemoteContainers: 0,
          };
        }
        throw listErr;
      }
      const remoteByName = new Map(remoteList.map((r) => [r.name, r]));

      for (const remote of remoteList) {
        if (pendingDeletions.has(remote.name)) {
          continue;
        }
        const local = mergedContainers.get(remote.name);
        const remoteTimeMs = Date.parse(remote.clientFileTime || '') || 0;
        const localTimeMs = local ? Date.parse(local.modifiedIso || '') || 0 : 0;
        const remoteChanged = !local || local.remoteClientFileTime !== remote.clientFileTime;

        const shouldPullRemote =
          !local ||
          (remoteChanged && !local.dirty) ||
          (remoteChanged && local.dirty && remoteTimeMs > localTimeMs);

        if (shouldPullRemote) {
          const atomsMap = await client.getContainerAtoms(remote.name, signal);
          const downloadedBlobs = new Map();
          for (const [blobName, atomToken] of atomsMap.entries()) {
            const data = await client.downloadAtom(atomToken, signal);
            downloadedBlobs.set(blobName, {
              name: blobName,
              blobGuid: generateUpperGuidHex(),
              data,
              size: data.length,
              sha256: crypto.createHash('sha256').update(data).digest('hex'),
              atom: atomToken,
            });
          }

          mergedContainers.set(remote.name, {
            name: remote.name,
            displayName: remote.displayName || remote.name,
            etag: remote.etag || '',
            containerNum: local ? local.containerNum : 1,
            dirty: false,
            folderGuid: local ? local.folderGuid : generateUpperGuidHex(),
            modifiedIso: remote.clientFileTime || new Date().toISOString(),
            remoteClientFileTime: remote.clientFileTime || '',
            blobs: downloadedBlobs,
          });
          cloudPulledContainerNames.add(remote.name);
          downloadedContainers += 1;
        }
      }

      // Prune clean previously-synced local containers that were deleted remotely on another device
      for (const [cName, local] of Array.from(mergedContainers.entries())) {
        if (!local.dirty && local.remoteClientFileTime && !remoteByName.has(cName)) {
          mergedContainers.delete(cName);
          remotelyPrunedContainerNames.add(cName);
        }
      }
    }

    // Upload all dirty containers when write lock is held (fault-isolated per container)
    let firstUploadError = null;
    if (!readOnlyFallback) {
      for (const [cName, container] of Array.from(mergedContainers.entries())) {
        if (!container.dirty) continue;
        if (!isValidTitleStorageContainerName(cName)) {
          mergedContainers.delete(cName);
          continue;
        }

        try {
          const atomsObject = {};
          for (const [bName, blob] of container.blobs.entries()) {
            let atomToken = blob.atom;
            if (!atomToken) {
              atomToken = await client.uploadAtom(blob.data, signal);
              blob.atom = atomToken;
            }
            atomsObject[bName] = atomToken;
          }

          const isoNow = container.modifiedIso || new Date().toISOString();
          await client.putContainerManifest(
            cName,
            {
              displayName: container.displayName || cName,
              clientFileTime: isoNow,
              atomsObject,
            },
            signal
          );

          container.dirty = false;
          container.stateFlags = 0;
          container.remoteClientFileTime = isoNow;
          uploadedContainers += 1;
        } catch (uploadErr) {
          if (!firstUploadError) firstUploadError = uploadErr;
        }
      }
    }

    await writeLocalWgsWorkspace(wgsUserDir, {
      containers: Array.from(mergedContainers.values()),
      storePkgAumid: workspace.index?.storePkgAumid || storePkgAumid,
      pkgDisplayName: workspace.index?.pkgDisplayName || '',
      syncMetadataId: workspace.index?.syncMetadataId || '',
      deletedContainers: Array.from(pendingDeletions),
    });

    if (effectiveXgsUserDir) {
      if (mode === 'pre_launch') {
        await exportWgsToXgsFolder(wgsUserDir, effectiveXgsUserDir, {
          cloudPulledContainerNames,
          remotelyPrunedContainerNames,
        });
      } else {
        await cleanupStaleRootXgsDuplicates(effectiveXgsUserDir, mergedContainers.keys());
      }
    }

    if (firstUploadError) {
      throw firstUploadError;
    }

    if (lockAcquired && !keepLockHeld) {
      await client.releaseLock(uploadedContainers > 0 || deletedRemoteContainers > 0, signal);
      lockAcquired = false;
    }

    if (readOnlyFallback) {
      return {
        synced: true,
        mode,
        readOnlyFallback: true,
        resolvedScid: normalizedScid,
        resolvedWgsUserDir: wgsUserDir,
        quotaBytes,
        downloadedContainers,
        uploadedContainers: 0,
        deletedRemoteContainers: 0,
        containerCount: mergedContainers.size,
        lockHeld: false,
      };
    }

    return {
      synced: true,
      mode,
      resolvedScid: normalizedScid,
      resolvedWgsUserDir: wgsUserDir,
      quotaBytes,
      downloadedContainers,
      uploadedContainers,
      deletedRemoteContainers,
      containerCount: mergedContainers.size,
      lockHeld: lockAcquired,
    };
  } catch (err) {
    if (lockAcquired && !keepLockHeld) {
      await client.releaseLock(uploadedContainers > 0, signal);
    }
    throw err;
  }
}

module.exports = {
  LARGE_ATOM_THRESHOLD_BYTES,
  WGS_ATOM_SIDECAR_FILENAME,
  XGS_SYNC_SIDECAR_FILENAME,
  DEFAULT_TITLE_STORAGE_TIMEOUT_MS,
  validateTitleStorageBlobUri,
  dateToFileTimeBigInt,
  fileTimeBigIntToIso,
  readWinGuidHexUpper,
  writeWinGuidHex,
  formatWgsUserScidFolderName,
  isValidTitleStorageContainerName,
  encodeTitleStorageContainerPath,
  resolveEffectiveXgsUserDir,
  sanitizePoisonedWgsContainersMap,
  parseWgsContainersIndex,
  serializeWgsContainersIndex,
  parseWgsContainerBlobIndex,
  serializeWgsContainerBlobIndex,
  loadWgsSyncSidecar,
  saveWgsSyncSidecar,
  loadXgsSyncSidecar,
  saveXgsSyncSidecar,
  readLocalWgsWorkspace,
  writeLocalWgsWorkspace,
  exportWgsToXgsFolder,
  importXgsFolderIntoWgs,
  createTitleStorageClient,
  syncXboxTitleStorage,
};
