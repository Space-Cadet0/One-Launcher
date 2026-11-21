// @ts-check
'use strict';

const crypto = require('node:crypto');

const WINDOWS_EPOCH_OFFSET_MS = 11644473600000n;
const MAX_UINT64_BIGINT = 0xffffffffffffffffn;

const VALID_SCID_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const VALID_XUID_DEC_RE = /^\d{1,20}$/;
const VALID_XUID_HEX_RE = /^0x[0-9a-f]{1,16}$/i;
const VALID_GUID_HEX32_RE = /^[0-9A-F]{32}$/i;

const WGS_USER_SCID_DIR_RE =
  /^[0-9A-F]{16}_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const POISONED_USER_SCID_PREFIX_RE =
  /^([0-9A-F]{16}_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/(.+)$/i;

/**
 * Validates and parses an Xbox User ID (XUID) into an unsigned 64-bit BigInt.
 * Rejects path traversal, whitespace, negative numbers, and non-numeric strings.
 *
 * @param {string | number | bigint} rawXuid
 * @returns {bigint}
 */
function parseAndValidateXuidBigInt(rawXuid) {
  let xuidBig;
  if (typeof rawXuid === 'bigint') {
    xuidBig = rawXuid;
  } else if (typeof rawXuid === 'number') {
    if (!Number.isSafeInteger(rawXuid) || rawXuid < 0) {
      throw Object.assign(new Error(`Rejected invalid numeric XUID: "${String(rawXuid)}"`), {
        hr: -2147024809,
      });
    }
    xuidBig = BigInt(rawXuid);
  } else if (typeof rawXuid === 'string') {
    const clean = rawXuid.trim();
    if (!clean || (!VALID_XUID_DEC_RE.test(clean) && !VALID_XUID_HEX_RE.test(clean))) {
      throw Object.assign(
        new Error(`Rejected invalid or unsafe XUID: "${clean.slice(0, 64)}"`),
        { hr: -2147024809 }
      );
    }
    xuidBig = BigInt(clean);
  } else {
    throw Object.assign(new Error('Rejected missing or non-scalar XUID'), {
      hr: -2147024809,
    });
  }

  if (xuidBig < 0n || xuidBig > MAX_UINT64_BIGINT) {
    throw Object.assign(new Error(`Rejected out-of-range XUID: "${String(rawXuid).slice(0, 64)}"`), {
      hr: -2147024809,
    });
  }
  return xuidBig;
}

/**
 * Validates a Service Configuration ID (SCID) against strict UUID format.
 *
 * @param {string} rawScid
 * @returns {string} Normalized lowercase UUID
 */
function validateTitleStorageScid(rawScid) {
  const clean = String(rawScid ?? '').trim().toLowerCase();
  if (!VALID_SCID_UUID_RE.test(clean)) {
    throw Object.assign(
      new Error(`Rejected invalid or non-UUID SCID: "${clean.slice(0, 64)}"`),
      { hr: -2147024809 }
    );
  }
  return clean;
}

/**
 * Validates a 32-hex GUID string (uppercase normalized).
 *
 * @param {string} rawGuid
 * @param {string} [label]
 * @returns {string}
 */
function validateGuidHex32(rawGuid, label = 'GUID') {
  const clean = String(rawGuid ?? '').trim().toUpperCase();
  if (!VALID_GUID_HEX32_RE.test(clean)) {
    throw new Error(`Invalid ${label} (expected 32 hex chars): "${clean.slice(0, 64)}"`);
  }
  return clean;
}

/**
 * Formats the Windows Gaming Services `<HexXuid>_<Scid>` folder name with strict
 * XUID uint64 and SCID UUID validation to prevent path traversal or poisoned folder names.
 *
 * @param {string | number | bigint} xuid
 * @param {string} scid
 * @returns {string}
 */
function formatWgsUserScidFolderName(xuid, scid) {
  const xuidBig = parseAndValidateXuidBigInt(xuid);
  const normScid = validateTitleStorageScid(scid);
  const hexXuid = xuidBig.toString(16).toUpperCase().padStart(16, '0');
  return `${hexXuid}_${normScid}`;
}

/**
 * @param {string | number | Date | null | undefined} dateOrIso
 * @returns {bigint}
 */
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

/**
 * @param {bigint} ftBigInt
 * @returns {string}
 */
function fileTimeBigIntToIso(ftBigInt) {
  if (!ftBigInt || ftBigInt <= WINDOWS_EPOCH_OFFSET_MS * 10000n) {
    return new Date(0).toISOString();
  }
  const unixMs = Number(ftBigInt / 10000n - WINDOWS_EPOCH_OFFSET_MS);
  return new Date(unixMs).toISOString();
}

/**
 * @param {Buffer} buf
 * @param {number} [offset]
 * @returns {string}
 */
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

/**
 * @param {string} guidHexOrDashed
 * @param {Buffer} [outBuf]
 * @param {number} [offset]
 * @returns {Buffer}
 */
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

/**
 * @returns {string}
 */
function generateUpperGuidHex() {
  return crypto.randomUUID().replace(/-/g, '').toUpperCase();
}

/**
 * @param {string} guidHex32
 * @returns {string}
 */
function formatDashedUpperUuid(guidHex32) {
  const clean = String(guidHex32 || '')
    .replace(/-/g, '')
    .toUpperCase();
  if (clean.length !== 32) return crypto.randomUUID().toUpperCase();
  return `${clean.slice(0, 8)}-${clean.slice(8, 12)}-${clean.slice(12, 16)}-${clean.slice(16, 20)}-${clean.slice(20, 32)}`;
}

/**
 * @param {Buffer} buf
 * @param {number} offset
 * @returns {{ value: string, nextOffset: number }}
 */
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

/**
 * @param {string} str
 * @returns {Buffer}
 */
function encodeLengthPrefixedUtf16(str) {
  const s = String(str || '');
  const strBuf = Buffer.from(s, 'utf16le');
  const charCount = Math.floor(strBuf.length / 2);
  const out = Buffer.allocUnsafe(4 + strBuf.length);
  out.writeInt32LE(charCount, 0);
  strBuf.copy(out, 4);
  return out;
}

/**
 * Parses a Windows `SystemAppData\wgs\<HexXuid>_<Scid>\containers.index` binary buffer.
 *
 * @param {Buffer} buf
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
 *
 * @param {Record<string, any>} [model]
 * @returns {Buffer}
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
    const flags = c.stateFlags !== undefined ? c.stateFlags >>> 0 : c.dirty ? 1 : 0;
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
 *
 * @param {Buffer} buf
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
 *
 * @param {Array<Record<string, any>>} [blobs]
 * @param {number} [version]
 * @returns {Buffer}
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
    const guidB = b.blobGuidB || '00000000000000000000000000000000';
    writeWinGuidHex(guidA, out, recOff + 128);
    writeWinGuidHex(guidB, out, recOff + 144);
  }

  return out;
}

/**
 * Validates Connected Storage container names against Microsoft's `titlestorage.xboxlive.com` v107 grammar:
 * - Non-empty, <= 128 chars, no whitespace, control chars, or Windows-illegal characters.
 * - Never a `<HexXuid>_<Scid>` folder name or `<HexXuid>_<Scid>/...` poisoned path.
 * - Directory segments before `/` strictly require `[A-Za-z0-9_]+`.
 *
 * @param {unknown} name
 * @returns {boolean}
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
 * Connected Storage container names preserve literal `/` separators.
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

module.exports = {
  WINDOWS_EPOCH_OFFSET_MS,
  VALID_SCID_UUID_RE,
  VALID_XUID_DEC_RE,
  VALID_XUID_HEX_RE,
  VALID_GUID_HEX32_RE,
  WGS_USER_SCID_DIR_RE,
  POISONED_USER_SCID_PREFIX_RE,
  parseAndValidateXuidBigInt,
  validateTitleStorageScid,
  validateGuidHex32,
  formatWgsUserScidFolderName,
  dateToFileTimeBigInt,
  fileTimeBigIntToIso,
  readWinGuidHexUpper,
  writeWinGuidHex,
  generateUpperGuidHex,
  formatDashedUpperUuid,
  readLengthPrefixedUtf16,
  encodeLengthPrefixedUtf16,
  parseWgsContainersIndex,
  serializeWgsContainersIndex,
  parseWgsContainerBlobIndex,
  serializeWgsContainerBlobIndex,
  isValidTitleStorageContainerName,
  encodeTitleStorageContainerPath,
};
