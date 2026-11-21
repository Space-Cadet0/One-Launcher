// @ts-check
'use strict';

const { normalizeContainerRelPath } = require('../xboxConfigAndIds.cjs');
const {
  XVD_PAGE_SIZE,
  MAX_XVD_METADATA_ALLOC_BYTES,
  MAX_NTFS_READ_ALL_BYTES,
  readSafeU64LE,
} = require('./xvdConstantsAndPrimitives.cjs');
const { createLruBlockRangeReader } = require('./xvdRangeReaders.cjs');
const { splitContainerRunsByXvcRegions } = require('./xvdXvcAndSegments.cjs');

const MAX_SAFE_BIGINT = BigInt(Number.MAX_SAFE_INTEGER);
const MAX_NTFS_DATA_RUNS = 4096;
const MIN_NTFS_MFT_RECORD_SIZE = 512;
const MAX_NTFS_MFT_RECORD_SIZE = 65536;
const MIN_NTFS_MFT_SHIFT = 9; // 2^9 = 512
const MAX_NTFS_MFT_SHIFT = 16; // 2^16 = 65536
const MAX_NTFS_CLUSTER_SIZE = 2 * 1024 * 1024; // 2 MiB max NTFS cluster size

/**
 * @param {Buffer} recordBuf
 * @param {number} [sectorSize=512]
 * @returns {Buffer}
 */
function applyNtfsMultiSectorFixup(recordBuf, sectorSize = 512) {
  const buf = Buffer.from(recordBuf);
  if (buf.length < 48 || !Number.isSafeInteger(sectorSize) || sectorSize < 512) return buf;
  const usaOffset = buf.readUInt16LE(0x04);
  const usaCount = buf.readUInt16LE(0x06);
  if (usaCount < 2 || usaOffset + usaCount * 2 > buf.length) return buf;

  const usn = buf.readUInt16LE(usaOffset);
  for (let i = 1; i < usaCount; i += 1) {
    const sectorEndOff = i * sectorSize - 2;
    if (sectorEndOff < 0 || sectorEndOff + 2 > buf.length) break;
    if (buf.readUInt16LE(sectorEndOff) === usn) {
      buf.writeUInt16LE(buf.readUInt16LE(usaOffset + i * 2), sectorEndOff);
    }
  }
  return buf;
}

/**
 * Decodes NTFS non-resident `$DATA` runlists with strict `Number.isSafeInteger`,
 * non-negative LCN, and 8-byte / BigInt overflow bounds guards.
 *
 * @param {Buffer} buf
 * @param {number} startOffset
 * @param {number} clusterSize
 * @param {number} partitionByteOffset
 */
function decodeNtfsDataRuns(buf, startOffset, clusterSize, partitionByteOffset) {
  /** @type {Array<{ vcn: number, lcn: number | null, clusterCount: number, byteLength: number, diskOffset: number | null, sparse: boolean }>} */
  const runs = [];
  if (
    !Buffer.isBuffer(buf) ||
    !Number.isSafeInteger(startOffset) ||
    startOffset < 0 ||
    startOffset >= buf.length ||
    !Number.isSafeInteger(clusterSize) ||
    clusterSize <= 0 ||
    clusterSize > MAX_NTFS_CLUSTER_SIZE ||
    !Number.isSafeInteger(partitionByteOffset) ||
    partitionByteOffset < 0
  ) {
    return runs;
  }

  const clusterSizeBig = BigInt(clusterSize);
  const partitionOffBig = BigInt(partitionByteOffset);
  let off = startOffset;
  let currentLcn = 0n;
  let currentVcn = 0n;

  while (off < buf.length && runs.length < MAX_NTFS_DATA_RUNS) {
    const headerByte = buf[off];
    off += 1;
    if (headerByte === 0) break;

    const lenBytes = headerByte & 0x0f;
    const offBytes = (headerByte >> 4) & 0x0f;
    // NTFS length & offset fields are at most 8 bytes (64-bit); reject malformed >8-byte fields
    if (lenBytes === 0 || lenBytes > 8 || offBytes > 8 || off + lenBytes + offBytes > buf.length) {
      return [];
    }

    let clusterCount = 0n;
    for (let i = 0; i < lenBytes; i += 1) {
      clusterCount |= BigInt(buf[off + i]) << BigInt(i * 8);
    }
    off += lenBytes;

    if (clusterCount <= 0n || clusterCount > MAX_SAFE_BIGINT) {
      return [];
    }

    let sparse = false;
    if (offBytes === 0) {
      sparse = true;
    } else {
      let delta = 0n;
      for (let i = 0; i < offBytes; i += 1) {
        delta |= BigInt(buf[off + i]) << BigInt(i * 8);
      }
      const signBit = 1n << BigInt(offBytes * 8 - 1);
      if ((delta & signBit) !== 0n) {
        delta -= 1n << BigInt(offBytes * 8);
      }
      const nextLcn = currentLcn + delta;
      // Reject negative or unsafe LCNs that could seek before partition start or lose precision
      if (nextLcn < 0n || nextLcn > MAX_SAFE_BIGINT) {
        return [];
      }
      currentLcn = nextLcn;
      off += offBytes;
    }

    const nextVcn = currentVcn + clusterCount;
    const byteLengthBig = clusterCount * clusterSizeBig;
    if (nextVcn > MAX_SAFE_BIGINT || byteLengthBig <= 0n || byteLengthBig > MAX_SAFE_BIGINT) {
      return [];
    }

    /** @type {number | null} */
    let diskOffset = null;
    if (!sparse) {
      const diskOffsetBig = partitionOffBig + currentLcn * clusterSizeBig;
      if (diskOffsetBig < 0n || diskOffsetBig > MAX_SAFE_BIGINT) {
        return [];
      }
      diskOffset = Number(diskOffsetBig);
      if (!Number.isSafeInteger(diskOffset) || diskOffset < 0) {
        return [];
      }
    }

    const vcnNum = Number(currentVcn);
    const lcnNum = sparse ? null : Number(currentLcn);
    const clusterCountNum = Number(clusterCount);
    const byteLength = Number(byteLengthBig);

    if (
      !Number.isSafeInteger(vcnNum) ||
      !Number.isSafeInteger(clusterCountNum) ||
      !Number.isSafeInteger(byteLength) ||
      (lcnNum !== null && (!Number.isSafeInteger(lcnNum) || lcnNum < 0))
    ) {
      return [];
    }

    runs.push({
      vcn: vcnNum,
      lcn: lcnNum,
      clusterCount: clusterCountNum,
      byteLength,
      diskOffset,
      sparse,
    });
    currentVcn = nextVcn;
  }
  return runs;
}

/**
 * @param {any} driveReader
 * @param {Array<{ byteLength: number, diskOffset: number | null, sparse: boolean }>} runs
 * @param {number} logicalOffset
 * @param {number} byteLength
 * @param {AbortSignal} [signal]
 */
async function readFromNtfsRuns(driveReader, runs, logicalOffset, byteLength, signal) {
  if (byteLength <= 0) return Buffer.alloc(0);
  if (byteLength > MAX_XVD_METADATA_ALLOC_BYTES) {
    throw new RangeError(
      `NTFS run allocation (${byteLength} bytes) exceeds ${MAX_XVD_METADATA_ALLOC_BYTES} byte cap`
    );
  }
  const out = Buffer.alloc(byteLength);
  let remaining = byteLength;
  let outPos = 0;
  let streamCursor = 0;

  for (const run of runs) {
    const runStart = streamCursor;
    const runEnd = streamCursor + run.byteLength;
    streamCursor = runEnd;

    if (logicalOffset >= runEnd) continue;
    if (remaining <= 0) break;

    const relStart = Math.max(0, logicalOffset - runStart);
    const take = Math.min(remaining, run.byteLength - relStart);
    if (take <= 0) continue;

    if (!run.sparse && run.diskOffset !== null) {
      const readOffset = run.diskOffset + relStart;
      if (!Number.isSafeInteger(readOffset) || readOffset < 0) {
        throw new RangeError(`Unsafe NTFS disk offset: ${readOffset}`);
      }
      const chunk = await driveReader.readRange(readOffset, take, signal);
      chunk.copy(out, outPos, 0, Math.min(chunk.length, take));
    }
    outPos += take;
    logicalOffset += take;
    remaining -= take;
  }

  return out;
}

/**
 * @param {any} driveReader
 * @param {AbortSignal} [signal]
 * @returns {Promise<number | null>}
 */
async function locateNtfsPartitionOffset(driveReader, signal) {
  const head = await driveReader.readRange(0, 0x4000, signal);
  if (head.length >= 0x200 && head.subarray(0x03, 0x0b).toString('ascii') === 'NTFS    ') {
    return 0;
  }

  // Probe GPT at 512-byte LBA 1 (0x200) or 4096-byte LBA 1 (0x1000)
  for (const sectorSize of [512, 4096]) {
    if (head.length < sectorSize * 2) continue;
    const gptHdr = head.subarray(sectorSize, sectorSize + 92);
    if (gptHdr.subarray(0, 8).toString('ascii') === 'EFI PART') {
      const partEntryLba = readSafeU64LE(gptHdr, 72, 'GPT.partEntryLba');
      const numEntries = Math.min(128, gptHdr.readUInt32LE(80));
      const rawEntrySize = gptHdr.readUInt32LE(84) || 128;
      if (rawEntrySize < 64 || rawEntrySize > 4096) continue;
      const partTableByteOffset = partEntryLba * sectorSize;
      if (!Number.isSafeInteger(partTableByteOffset) || partTableByteOffset < 0) continue;

      const entriesBuf = await driveReader.readRange(
        partTableByteOffset,
        numEntries * rawEntrySize,
        signal
      );

      for (let i = 0; i < numEntries; i += 1) {
        const eOff = i * rawEntrySize;
        if (eOff + 64 > entriesBuf.length) break;
        const typeGuid = entriesBuf.subarray(eOff, eOff + 16);
        if (typeGuid.every((b) => b === 0)) continue;
        const firstLba = readSafeU64LE(entriesBuf, eOff + 32, 'GPT.firstLba');
        const candidateOffset = firstLba * sectorSize;
        if (!Number.isSafeInteger(candidateOffset) || candidateOffset < 0) continue;
        const vbr = await driveReader.readRange(candidateOffset, 512, signal);
        if (vbr.length >= 0x50 && vbr.subarray(0x03, 0x0b).toString('ascii') === 'NTFS    ') {
          return candidateOffset;
        }
      }
    }
  }

  // Probe MBR partition table at 0x1BE..0x1FE
  if (head.length >= 512 && head[0x1fe] === 0x55 && head[0x1ff] === 0xaa) {
    for (let i = 0; i < 4; i += 1) {
      const pOff = 0x1be + i * 16;
      const lbaStart = head.readUInt32LE(pOff + 8);
      if (lbaStart === 0) continue;
      for (const sectorSize of [512, 4096]) {
        const candidateOffset = lbaStart * sectorSize;
        if (!Number.isSafeInteger(candidateOffset) || candidateOffset < 0) continue;
        const vbr = await driveReader.readRange(candidateOffset, 512, signal);
        if (vbr.length >= 0x50 && vbr.subarray(0x03, 0x0b).toString('ascii') === 'NTFS    ') {
          return candidateOffset;
        }
      }
    }
  }

  return null;
}

/**
 * Safely decodes the NTFS VBR `clustersPerFileRecordSegment` signed int8 (`vbr[0x40]`)
 * without 32-bit shift overflow and clamped strictly to `[512, 65536]` bytes.
 *
 * @param {number} rawRecClusters Signed 8-bit integer from NTFS VBR offset `0x40`
 * @param {number} clusterSize
 * @returns {number | null}
 */
function resolveSafeNtfsMftRecordSize(rawRecClusters, clusterSize) {
  if (!Number.isSafeInteger(clusterSize) || clusterSize <= 0 || clusterSize > MAX_NTFS_CLUSTER_SIZE) {
    return null;
  }
  if (rawRecClusters < 0) {
    const shift = -rawRecClusters;
    if (!Number.isInteger(shift) || shift < MIN_NTFS_MFT_SHIFT || shift > MAX_NTFS_MFT_SHIFT) {
      return null;
    }
    return 1 << shift;
  }
  if (rawRecClusters === 0) {
    return null;
  }
  const size = rawRecClusters * clusterSize;
  if (!Number.isSafeInteger(size) || size < MIN_NTFS_MFT_RECORD_SIZE || size > MAX_NTFS_MFT_RECORD_SIZE) {
    return null;
  }
  return size;
}

/**
 * @param {Buffer} recordBuf
 * @param {number} clusterSize
 * @param {number} partitionByteOffset
 * @param {number} [sectorSize=512]
 */
function parseNtfsFileRecordAttributes(
  recordBuf,
  clusterSize,
  partitionByteOffset,
  sectorSize = 512
) {
  if (recordBuf.length < 48 || recordBuf.subarray(0, 4).toString('ascii') !== 'FILE') {
    return null;
  }
  const fixed = applyNtfsMultiSectorFixup(recordBuf, sectorSize);
  const flags = fixed.readUInt16LE(0x16);
  if ((flags & 0x01) === 0) return null; // Not in-use

  const isDirectory = Boolean(flags & 0x02);
  let attrOff = fixed.readUInt16LE(0x14);
  const names = [];
  let dataAttr = null;

  while (attrOff >= 0 && attrOff + 16 <= fixed.length) {
    const attrType = fixed.readUInt32LE(attrOff);
    if (attrType === 0xffffffff || attrType === 0) break;
    const attrLen = fixed.readUInt32LE(attrOff + 4);
    if (attrLen < 16 || attrOff + attrLen > fixed.length) break;

    const nonResident = fixed.readUInt8(attrOff + 8);
    const nameLen = fixed.readUInt8(attrOff + 9);

    if (attrType === 0x30 && nonResident === 0) {
      // $FILE_NAME
      const valLen = fixed.readUInt32LE(attrOff + 16);
      const valOff = attrOff + fixed.readUInt16LE(attrOff + 20);
      if (valOff + 66 <= fixed.length && valLen >= 66) {
        const parentRefLow = fixed.readUInt32LE(valOff);
        const parentRefHigh = fixed.readUInt16LE(valOff + 4);
        const parentRecordNumber = parentRefHigh * 0x100000000 + parentRefLow;
        const fnLen = fixed.readUInt8(valOff + 64);
        const fnNamespace = fixed.readUInt8(valOff + 65); // 0=POSIX, 1=Win32, 2=DOS, 3=Win32&DOS
        const fnEnd = Math.min(fixed.length, valOff + 66 + fnLen * 2);
        const fileName = fixed.subarray(valOff + 66, fnEnd).toString('utf16le');
        names.push({ parentRecordNumber, fileName, fnNamespace });
      }
    } else if (attrType === 0x80 && nameLen === 0) {
      // Unnamed default $DATA stream
      if (nonResident === 0) {
        const valLen = fixed.readUInt32LE(attrOff + 16);
        const valOff = attrOff + fixed.readUInt16LE(attrOff + 20);
        const inlineData = Buffer.from(
          fixed.subarray(valOff, Math.min(fixed.length, valOff + valLen))
        );
        dataAttr = {
          resident: true,
          fileSize: inlineData.length,
          residentData: inlineData,
          dataRuns: [],
        };
      } else if (attrOff + 64 <= fixed.length) {
        const runOff = attrOff + fixed.readUInt16LE(attrOff + 32);
        const realSize = readSafeU64LE(fixed, attrOff + 48, 'NTFS.realSize');
        const runs = decodeNtfsDataRuns(
          fixed.subarray(0, attrOff + attrLen),
          runOff,
          clusterSize,
          partitionByteOffset
        );
        dataAttr = {
          resident: false,
          fileSize: realSize,
          residentData: null,
          dataRuns: runs,
        };
      }
    }

    attrOff += attrLen;
  }

  // Prefer Win32 / Win32+DOS / POSIX filename over DOS 8.3 short name (namespace === 2)
  const chosenName =
    names.find((n) => n.fnNamespace === 1 || n.fnNamespace === 3) ||
    names.find((n) => n.fnNamespace !== 2) ||
    names[0] ||
    null;

  return {
    isDirectory,
    parentRecordNumber: chosenName ? chosenName.parentRecordNumber : null,
    fileName: chosenName ? chosenName.fileName : null,
    dataAttr,
  };
}

/**
 * Creates a virtual drive Range reader over `layout.driveData` (supporting both Fixed & Dynamic XVD).
 *
 * @param {any} containerReader
 * @param {any} header
 * @param {any} layout
 * @param {AbortSignal} [signal]
 */
async function createVirtualDriveRangeReader(containerReader, header, layout, signal) {
  /** @type {Buffer | null} */
  let batTable = null;
  if (header.xvdType === 1 && layout.dynamicHeader.byteLength > 0) {
    if (layout.dynamicHeader.byteLength > MAX_XVD_METADATA_ALLOC_BYTES) {
      throw new RangeError(
        `Dynamic XVD BAT header (${layout.dynamicHeader.byteLength} bytes) exceeds ${MAX_XVD_METADATA_ALLOC_BYTES} byte cap`
      );
    }
    batTable = await containerReader.readRange(
      layout.dynamicHeader.byteOffset,
      layout.dynamicHeader.byteLength,
      signal
    );
  }

  const rawDriveReader = {
    async getTotalSize() {
      return header.driveSize;
    },
    /**
     * @param {number} virtualOffset
     * @param {number} byteLength
     * @param {AbortSignal} [reqSignal]
     */
    async readRange(virtualOffset, byteLength, reqSignal) {
      const start = Math.max(0, Math.floor(Number(virtualOffset)));
      const len = Math.max(0, Math.floor(Number(byteLength)));
      if (len === 0 || start >= header.driveSize) return Buffer.alloc(0);
      const boundedLen = Math.min(len, header.driveSize - start);

      if (!batTable) {
        return containerReader.readRange(
          layout.driveData.byteOffset + start,
          boundedLen,
          reqSignal || signal
        );
      }

      // Dynamic XVD BAT resolution
      const blkSize = header.blockSize || 0xaa000;
      const out = Buffer.alloc(boundedLen);
      let pos = 0;
      while (pos < boundedLen) {
        const curVirt = start + pos;
        const blkIdx = Math.floor(curVirt / blkSize);
        const inBlkOff = curVirt % blkSize;
        const take = Math.min(boundedLen - pos, blkSize - inBlkOff);
        if (blkIdx * 4 + 4 <= batTable.length) {
          const physPage = batTable.readUInt32LE(blkIdx * 4);
          if (physPage !== 0xffffffff) {
            const physByte = layout.driveData.byteOffset + physPage * XVD_PAGE_SIZE + inBlkOff;
            if (!Number.isSafeInteger(physByte) || physByte < 0) {
              throw new RangeError(`Unsafe Dynamic XVD BAT physical byte offset: ${physByte}`);
            }
            const chunk = await containerReader.readRange(physByte, take, reqSignal || signal);
            chunk.copy(out, pos, 0, Math.min(chunk.length, take));
          }
        }
        pos += take;
      }
      return out;
    },
  };

  return createLruBlockRangeReader(rawDriveReader, {
    blockSize: 128 * 1024,
    maxCacheBytes: 4 * 1024 * 1024,
  });
}

/**
 * Walks unencrypted NTFS $MFT records via HTTP Range (backed by a 4 MiB LRU block cache)
 * to discover resident & non-resident prefix/bootstrap files omitted from `SegmentMetadata.bin`.
 *
 * @param {{
 *   rangeReader: any,
 *   header: any,
 *   layout: any,
 *   xvcInfo: any,
 *   maxMftRecords?: number,
 *   signal?: AbortSignal,
 * }} options
 */
async function walkUnencryptedNtfsFiles(options) {
  const {
    rangeReader,
    header,
    layout,
    xvcInfo,
    maxMftRecords = 4096,
    signal,
  } = options;

  if (!header || header.driveSize <= 0) return [];

  // Build list of encrypted container byte intervals so we never read ciphertext as NTFS metadata
  const encryptedIntervals = (xvcInfo?.regions || [])
    .filter((/** @type {any} */ r) => r.isEncrypted && !header.encryptionDisabled && r.length > 0)
    .map((/** @type {any} */ r) => [r.offset, r.offset + r.length]);

  /**
   * @param {number} containerByteStart
   * @param {number} byteLen
   */
  const isContainerRangePlaintext = (containerByteStart, byteLen) => {
    const end = containerByteStart + byteLen;
    for (const [eStart, eEnd] of encryptedIntervals) {
      if (containerByteStart < eEnd && end > eStart) return false;
    }
    return true;
  };

  // Verify VBR/GPT start of driveData is plaintext before probing
  if (!isContainerRangePlaintext(layout.driveData.byteOffset, Math.min(0x4000, header.driveSize))) {
    return [];
  }

  const driveReader = await createVirtualDriveRangeReader(rangeReader, header, layout, signal);
  const partitionOffset = await locateNtfsPartitionOffset(driveReader, signal);
  if (partitionOffset === null) return [];

  const vbr = await driveReader.readRange(partitionOffset, 512, signal);
  if (vbr.length < 0x50 || vbr.subarray(0x03, 0x0b).toString('ascii') !== 'NTFS    ') {
    return [];
  }

  const bytesPerSector = vbr.readUInt16LE(0x0b) || 512;
  // Valid NTFS bytesPerSector must be a power of 2 in [512, 4096]
  if (
    bytesPerSector < 512 ||
    bytesPerSector > 4096 ||
    (bytesPerSector & (bytesPerSector - 1)) !== 0
  ) {
    return [];
  }
  const sectorsPerCluster = vbr.readUInt8(0x0d) || 8;
  const clusterSize = bytesPerSector * sectorsPerCluster;
  if (!Number.isSafeInteger(clusterSize) || clusterSize <= 0 || clusterSize > MAX_NTFS_CLUSTER_SIZE) {
    return [];
  }

  const mftCluster = readSafeU64LE(vbr, 0x30, 'NTFS.mftCluster');
  const rawRecClusters = vbr.readInt8(0x40);
  const recordSize = resolveSafeNtfsMftRecordSize(rawRecClusters, clusterSize);
  if (recordSize === null) {
    return [];
  }

  const mftStartVirtOffset = partitionOffset + mftCluster * clusterSize;
  if (
    !Number.isSafeInteger(mftStartVirtOffset) ||
    mftStartVirtOffset < 0 ||
    mftStartVirtOffset + recordSize > header.driveSize
  ) {
    return [];
  }
  if (
    header.xvdType === 0 &&
    !isContainerRangePlaintext(layout.driveData.byteOffset + mftStartVirtOffset, recordSize)
  ) {
    return [];
  }

  const mftRecord0 = await driveReader.readRange(mftStartVirtOffset, recordSize, signal);
  const parsedMft0 = parseNtfsFileRecordAttributes(
    mftRecord0,
    clusterSize,
    partitionOffset,
    bytesPerSector
  );
  if (!parsedMft0 || !parsedMft0.dataAttr || parsedMft0.dataAttr.dataRuns.length === 0) {
    return [];
  }

  const mftRuns = parsedMft0.dataAttr.dataRuns;
  const totalMftRecords = Math.min(
    maxMftRecords,
    Math.floor(parsedMft0.dataAttr.fileSize / recordSize)
  );

  // Batch-read $MFT records in 64 KiB chunks for minimal Range round-trips
  const records = new Map();
  const batchRecords = Math.max(1, Math.floor((64 * 1024) / recordSize));

  for (let recIdx = 0; recIdx < totalMftRecords; recIdx += batchRecords) {
    const count = Math.min(batchRecords, totalMftRecords - recIdx);
    const byteOff = recIdx * recordSize;
    const byteLen = count * recordSize;
    const batchBuf = await readFromNtfsRuns(driveReader, mftRuns, byteOff, byteLen, signal);

    for (let j = 0; j < count; j += 1) {
      const rNum = recIdx + j;
      if (rNum < 5) continue; // Skip $MFT..$AttrDef system records (keep 5 = root ".")
      const slice = batchBuf.subarray(j * recordSize, (j + 1) * recordSize);
      if (slice.length < recordSize) break;
      const parsed = parseNtfsFileRecordAttributes(
        slice,
        clusterSize,
        partitionOffset,
        bytesPerSector
      );
      if (!parsed) continue;
      if (rNum > 5 && parsed.fileName && parsed.fileName.startsWith('$')) continue;
      records.set(rNum, parsed);
    }
  }

  // Reconstruct full paths relative to root record 5
  /** @param {number} recNum */
  const resolveRelPath = (recNum) => {
    /** @type {string[]} */
    const parts = [];
    /** @type {number | null} */
    let cur = recNum;
    let guard = 0;
    while (cur !== null && cur !== 5 && guard < 32) {
      guard += 1;
      const node = records.get(cur);
      if (!node || !node.fileName) return null;
      parts.push(node.fileName);
      cur = node.parentRecordNumber;
    }
    if (cur !== 5 || parts.length === 0) return null;
    parts.reverse();
    return normalizeContainerRelPath(parts.join('/'));
  };

  const results = [];
  for (const [recNum, node] of records.entries()) {
    if (recNum === 5 || node.isDirectory || !node.dataAttr) continue;
    const relPath = resolveRelPath(recNum);
    if (!relPath) continue;

    // Map virtual drive offsets to container offsets and enrich/split across XVC regions
    const containerDataRuns = splitContainerRunsByXvcRegions(
      node.dataAttr.dataRuns,
      xvcInfo,
      header,
      layout,
      clusterSize
    );

    const isPlaintextAccessible =
      node.dataAttr.resident ||
      containerDataRuns.every(
        (r) =>
          r.sparse ||
          (r.containerOffset !== null &&
            !r.isEncrypted &&
            isContainerRangePlaintext(r.containerOffset, r.byteLength)) ||
          (r.containerOffset === null && encryptedIntervals.length === 0)
      );

    results.push({
      fileRecordNumber: recNum,
      path: relPath,
      fileSize: node.dataAttr.fileSize,
      resident: node.dataAttr.resident,
      residentData: node.dataAttr.residentData,
      dataRuns: containerDataRuns,
      isPlaintextAccessible,
      /**
       * @param {number} logicalOffset
       * @param {number} byteLength
       * @param {AbortSignal} [reqSignal]
       */
      readRangeBytes: async (logicalOffset, byteLength, reqSignal) => {
        const start = Math.max(0, Math.floor(Number(logicalOffset) || 0));
        const maxAvail = Math.max(0, node.dataAttr.fileSize - start);
        const len = Math.min(maxAvail, Math.max(0, Math.floor(Number(byteLength) || 0)));
        if (len === 0) return Buffer.alloc(0);
        if (node.dataAttr.resident) {
          const resBuf = node.dataAttr.residentData || Buffer.alloc(0);
          return Buffer.from(resBuf.subarray(start, Math.min(resBuf.length, start + len)));
        }
        return readFromNtfsRuns(
          driveReader,
          node.dataAttr.dataRuns,
          start,
          len,
          reqSignal || signal
        );
      },
      /**
       * @param {AbortSignal} [reqSignal]
       * @param {number} [maxBytes]
       */
      readAllBytes: async (reqSignal, maxBytes = MAX_NTFS_READ_ALL_BYTES) => {
        if (node.dataAttr.fileSize > maxBytes) {
          throw new RangeError(
            `NTFS readAllBytes refused for "${relPath}": fileSize ${node.dataAttr.fileSize} exceeds ${maxBytes} byte cap`
          );
        }
        if (node.dataAttr.resident) {
          return Buffer.from(node.dataAttr.residentData || Buffer.alloc(0));
        }
        return readFromNtfsRuns(
          driveReader,
          node.dataAttr.dataRuns,
          0,
          node.dataAttr.fileSize,
          reqSignal || signal
        );
      },
    });
  }

  return results;
}

module.exports = {
  MIN_NTFS_MFT_RECORD_SIZE,
  MAX_NTFS_MFT_RECORD_SIZE,
  applyNtfsMultiSectorFixup,
  decodeNtfsDataRuns,
  resolveSafeNtfsMftRecordSize,
  readFromNtfsRuns,
  locateNtfsPartitionOffset,
  parseNtfsFileRecordAttributes,
  createVirtualDriveRangeReader,
  walkUnencryptedNtfsFiles,
};
