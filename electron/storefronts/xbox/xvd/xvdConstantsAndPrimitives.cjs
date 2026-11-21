// @ts-check
'use strict';

const XVD_MAGIC = 'msft-xvd';
const XVD_PAGE_SIZE = 0x1000; // 4096 bytes
const XVD_HEADER_PAGES = 3;
const XVD_HEADER_SECTION_SIZE = XVD_HEADER_PAGES * XVD_PAGE_SIZE; // 0x3000 (12,288 bytes)
const XVD_HASH_ENTRIES_PER_PAGE = 170; // 170 * 24 = 4080 bytes (+ 16 trailing bytes per 4096 page)
const XVD_HASH_ENTRY_SIZE = 24; // L0: 20B hash + 4B u32LE data_unit; L1-L3: 24B truncated SHA-256
const XVD_L0_HASH_LENGTH = 20;
const XVD_UPPER_HASH_LENGTH = 24;
const XVD_ROOT_HASH_LENGTH = 32;
const XVC_INFO_HEADER_SIZE = 0xda8; // 3496 bytes
const XVC_REGION_HEADER_SIZE = 0x80; // 128 bytes
const SEGMENT_METADATA_MAGIC = ' PFX';
const MAX_XVD_METADATA_ALLOC_BYTES = 64 * 1024 * 1024; // 64 MiB structural metadata cap
const MAX_NTFS_READ_ALL_BYTES = 16 * 1024 * 1024; // 16 MiB whole-file NTFS manifest cap

const XVD_VOLUME_FLAGS = Object.freeze({
  READ_ONLY: 1 << 0,
  ENCRYPTION_DISABLED: 1 << 1,
  DATA_INTEGRITY_DISABLED: 1 << 2,
  LEGACY_SECTOR_SIZE: 1 << 3,
  RESILIENCY_ENABLED: 1 << 4,
  SRA_READ_ONLY: 1 << 5,
  REGION_ID_IN_XTS: 1 << 6,
});

const KERNEL_ANTICHEAT_RULES = [
  {
    id: 'easy_anti_cheat_eos',
    label: 'Easy Anti-Cheat (EOS Kernel Driver)',
    pattern:
      /(?:^|\/)(?:easyanticheat_eos\.(?:exe|sys)|easyanticheat\.sys|start_protected_game\.exe)$/i,
  },
  {
    id: 'battleye',
    label: 'BattlEye Kernel Anti-Cheat',
    pattern: /(?:^|\/)(?:beservice(?:_x64)?\.exe|bedaisy\.sys)$/i,
  },
  {
    id: 'randgrid',
    label: 'Randgrid Kernel Anti-Cheat',
    pattern: /(?:^|\/)randgrid\.sys$/i,
  },
  {
    id: 'vanguard',
    label: 'Riot Vanguard (vgk.sys)',
    pattern: /(?:^|\/)vgk\.sys$/i,
  },
  {
    id: 'ea_anticheat',
    label: 'EA Javelin Kernel Anti-Cheat',
    pattern: /(?:^|\/)(?:eaanticheat\.gameservice\.exe|eaanticheat\.sys)$/i,
  },
];

const STRUCTURAL_XVC_DESCRIPTIONS = new Set([
  'XVC-HD',
  'FS-MD',
  'XVC-MD',
  'XVC-EXVD',
  'XVC-MDU',
]);

/**
 * Reads an unsigned 64-bit little-endian integer and throws `RangeError` if it exceeds
 * `Number.MAX_SAFE_INTEGER` (`2^53 - 1`), preventing silent IEEE-754 mantissa rounding.
 *
 * @param {Buffer} buf
 * @param {number} offset
 * @param {string} [label]
 * @returns {number}
 */
function readSafeU64LE(buf, offset, label = 'uint64') {
  if (!Buffer.isBuffer(buf) || offset < 0 || offset + 8 > buf.length) {
    throw new RangeError(`Out-of-bounds 64-bit read for ${label} at offset ${offset}`);
  }
  const raw = buf.readBigUInt64LE(offset);
  if (raw > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new RangeError(
      `Unsafe 64-bit integer overflow in ${label}: ${raw.toString()} exceeds Number.MAX_SAFE_INTEGER`
    );
  }
  return Number(raw);
}

/**
 * @param {number} byteLength
 * @returns {number}
 */
function bytesToPages(byteLength) {
  const n = Number(byteLength || 0);
  if (n <= 0) return 0;
  return Math.ceil(n / XVD_PAGE_SIZE);
}

/**
 * @param {number} byteLength
 * @returns {number}
 */
function pageAlignBytes(byteLength) {
  return bytesToPages(byteLength) * XVD_PAGE_SIZE;
}

/**
 * @param {Buffer} buf
 * @param {number} [offset=0]
 * @returns {string}
 */
function formatGuidLE(buf, offset = 0) {
  if (!Buffer.isBuffer(buf) || offset + 16 > buf.length) {
    return '00000000-0000-0000-0000-000000000000';
  }
  const d1 = buf.readUInt32LE(offset).toString(16).padStart(8, '0');
  const d2 = buf.readUInt16LE(offset + 4).toString(16).padStart(4, '0');
  const d3 = buf.readUInt16LE(offset + 6).toString(16).padStart(4, '0');
  const d4a = buf.subarray(offset + 8, offset + 10).toString('hex');
  const d4b = buf.subarray(offset + 10, offset + 16).toString('hex');
  return `${d1}-${d2}-${d3}-${d4a}-${d4b}`.toLowerCase();
}

/**
 * @param {string} guidStr
 * @param {Buffer} [targetBuf]
 * @param {number} [offset=0]
 * @returns {Buffer}
 */
function writeGuidLE(guidStr, targetBuf = Buffer.alloc(16), offset = 0) {
  const clean = String(guidStr || '').replace(/[{}-\s]/g, '');
  if (!/^[0-9a-fA-F]{32}$/.test(clean)) {
    throw new Error(`Invalid GUID string: ${guidStr}`);
  }
  targetBuf.writeUInt32LE(parseInt(clean.slice(0, 8), 16) >>> 0, offset);
  targetBuf.writeUInt16LE(parseInt(clean.slice(8, 12), 16) & 0xffff, offset + 4);
  targetBuf.writeUInt16LE(parseInt(clean.slice(12, 16), 16) & 0xffff, offset + 6);
  Buffer.from(clean.slice(16, 32), 'hex').copy(targetBuf, offset + 8);
  return targetBuf;
}

/**
 * @param {Buffer} buf
 * @param {number} offset
 * @param {number} maxCodeUnits
 * @returns {string}
 */
function readNullTerminatedUtf16LE(buf, offset, maxCodeUnits) {
  const endByte = Math.min(buf.length, offset + maxCodeUnits * 2);
  let byteEnd = offset;
  while (byteEnd + 1 < endByte) {
    if (buf[byteEnd] === 0 && buf[byteEnd + 1] === 0) break;
    byteEnd += 2;
  }
  return buf.subarray(offset, byteEnd).toString('utf16le');
}

/**
 * @param {Buffer | Uint8Array | null | undefined} buf
 * @returns {boolean}
 */
function isAllZeroBuffer(buf) {
  if (!buf || buf.length === 0) return true;
  for (let i = 0; i < buf.length; i += 1) {
    if (buf[i] !== 0) return false;
  }
  return true;
}

module.exports = {
  XVD_MAGIC,
  XVD_PAGE_SIZE,
  XVD_HEADER_PAGES,
  XVD_HEADER_SECTION_SIZE,
  XVD_HASH_ENTRIES_PER_PAGE,
  XVD_HASH_ENTRY_SIZE,
  XVD_L0_HASH_LENGTH,
  XVD_UPPER_HASH_LENGTH,
  XVD_ROOT_HASH_LENGTH,
  XVC_INFO_HEADER_SIZE,
  XVC_REGION_HEADER_SIZE,
  SEGMENT_METADATA_MAGIC,
  MAX_XVD_METADATA_ALLOC_BYTES,
  MAX_NTFS_READ_ALL_BYTES,
  XVD_VOLUME_FLAGS,
  KERNEL_ANTICHEAT_RULES,
  STRUCTURAL_XVC_DESCRIPTIONS,
  readSafeU64LE,
  bytesToPages,
  pageAlignBytes,
  formatGuidLE,
  writeGuidLE,
  readNullTerminatedUtf16LE,
  isAllZeroBuffer,
};
