// @ts-check
'use strict';

const {
  unwrapCikWithDeviceKey,
  buildOpenSslXtsKey,
  decryptContiguousPageBuffer,
} = require('../xboxBoringSslCrypto.cjs');
const { normalizeContainerRelPath } = require('../xboxConfigAndIds.cjs');
const {
  XVD_PAGE_SIZE,
  XVC_INFO_HEADER_SIZE,
  XVC_REGION_HEADER_SIZE,
  SEGMENT_METADATA_MAGIC,
  KERNEL_ANTICHEAT_RULES,
  STRUCTURAL_XVC_DESCRIPTIONS,
  readSafeU64LE,
  bytesToPages,
  formatGuidLE,
  readNullTerminatedUtf16LE,
} = require('./xvdConstantsAndPrimitives.cjs');

/**
 * Parses `XvcInfo` (3496B) and trailing `XvcRegionHeader[]` (128B each).
 *
 * @param {Buffer} buf
 */
function parseXvcInfo(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < XVC_INFO_HEADER_SIZE) {
    return {
      contentId: '00000000-0000-0000-0000-000000000000',
      keyCount: 0,
      encryptionKeyIds: [],
      version: 0,
      regionCount: 0,
      flags: 0,
      initialPlayRegionId: 0,
      updateSegmentCount: 0,
      regions: [],
    };
  }

  const contentId = formatGuidLE(buf, 0x000);
  const version = buf.readUInt32LE(0xd10);
  const regionCount = buf.readUInt32LE(0xd14);
  const flags = buf.readUInt32LE(0xd18);
  const keyCount = Math.min(192, buf.readUInt16LE(0xd1e));
  const initialPlayRegionId = buf.readUInt32LE(0xd24);
  const initialPlayOffset = readSafeU64LE(buf, 0xd28, 'XvcInfo.initialPlayOffset');
  const updateSegmentCount = buf.readUInt32LE(0xd3c);

  const encryptionKeyIds = [];
  for (let i = 0; i < keyCount; i += 1) {
    const keyOff = 0x010 + i * 16;
    const rawKeyId = Buffer.from(buf.subarray(keyOff, keyOff + 16));
    const isZero = rawKeyId.every((b) => b === 0);
    encryptionKeyIds.push({
      index: i,
      raw: rawKeyId,
      hex: rawKeyId.toString('hex'),
      guid: formatGuidLE(rawKeyId, 0),
      isZero,
    });
  }

  const regions = [];
  for (let i = 0; i < regionCount; i += 1) {
    const rOff = XVC_INFO_HEADER_SIZE + i * XVC_REGION_HEADER_SIZE;
    if (rOff + XVC_REGION_HEADER_SIZE > buf.length) break;
    const id = buf.readUInt32LE(rOff + 0x00);
    const keyId = buf.readUInt16LE(rOff + 0x04);
    const regionFlags = buf.readUInt32LE(rOff + 0x08);
    const firstSegmentIndex = buf.readUInt32LE(rOff + 0x0c);
    const description = readNullTerminatedUtf16LE(buf, rOff + 0x10, 32);
    const offset = readSafeU64LE(buf, rOff + 0x50, 'XvcRegion.offset');
    const length = readSafeU64LE(buf, rOff + 0x58, 'XvcRegion.length');
    const hash = buf.readBigUInt64LE(rOff + 0x60);
    const isEncrypted = keyId !== 0xffff && keyId < 0xc0;

    regions.push({
      index: i,
      id,
      keyId,
      isEncrypted,
      keyGuid: isEncrypted && encryptionKeyIds[keyId] ? encryptionKeyIds[keyId].guid : null,
      keyHex: isEncrypted && encryptionKeyIds[keyId] ? encryptionKeyIds[keyId].hex : null,
      flags: regionFlags,
      firstSegmentIndex,
      description,
      offset,
      length,
      hash,
    });
  }

  return {
    contentId,
    keyCount,
    encryptionKeyIds,
    version,
    regionCount,
    flags,
    initialPlayRegionId,
    initialPlayOffset,
    updateSegmentCount,
    regions,
  };
}

/**
 * Parses `user_data` (`XvdUserDataHeader` + `PackageFiles` entries).
 * Note: `XvdUserDataPackageFileEntry.offset` is relative to `userDataStart + 16` (`sizeof(XvdUserDataHeader)`).
 *
 * @param {Buffer} buf
 */
function parseUserData(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 16) {
    return { header: null, packageFullName: '', files: new Map(), entries: [] };
  }

  const headerLength = buf.readUInt32LE(0);
  const version = buf.readUInt32LE(4);
  const type = buf.readUInt32LE(8);
  const unknown = buf.readUInt32LE(12);

  const header = { length: headerLength, version, type, unknown };
  const files = new Map();
  const entries = [];
  let packageFullName = '';

  if (type === 0 && headerLength >= 16 && buf.length >= headerLength + 528) {
    const pkgHdrOff = headerLength;
    const pkgHdrVersion = buf.readUInt32LE(pkgHdrOff);
    packageFullName = readNullTerminatedUtf16LE(buf, pkgHdrOff + 4, 260);
    const fileCount = buf.readUInt32LE(pkgHdrOff + 524);

    let entryOff = pkgHdrOff + 528;
    for (let i = 0; i < fileCount; i += 1) {
      if (entryOff + 528 > buf.length) break;
      const rawPath = readNullTerminatedUtf16LE(buf, entryOff, 260);
      const normPath = normalizeContainerRelPath(rawPath);
      const size = buf.readUInt32LE(entryOff + 520);
      const relOffset = buf.readUInt32LE(entryOff + 524);
      const dataStart = 16 + relOffset;
      const dataEnd = Math.min(buf.length, dataStart + size);
      const data =
        dataStart <= buf.length ? Buffer.from(buf.subarray(dataStart, dataEnd)) : Buffer.alloc(0);

      const entry = {
        path: normPath,
        rawPath,
        size,
        offset: relOffset,
        data,
        pkgHdrVersion,
      };
      entries.push(entry);
      if (normPath) {
        files.set(normPath.toLowerCase(), entry);
      }
      entryOff += 528;
    }
  }

  return { header, packageFullName, files, entries };
}

/**
 * Parses `SegmentMetadata.bin` (" PFX" header + 16-byte segment records + UTF-16LE path table).
 *
 * @param {Buffer} buf
 */
function parseSegmentMetadata(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 100) {
    throw new Error(`SegmentMetadata.bin buffer too small (${buf ? buf.length : 0} bytes)`);
  }
  const magic = buf.subarray(0, 4).toString('ascii');
  if (magic !== SEGMENT_METADATA_MAGIC) {
    throw new Error(
      `Invalid SegmentMetadata.bin magic: expected "${SEGMENT_METADATA_MAGIC}", got "${magic}"`
    );
  }

  const version0 = buf.readUInt32LE(0x04);
  const version1 = buf.readUInt32LE(0x08);
  const headerLength = buf.readUInt32LE(0x0c);
  const segmentCount = buf.readUInt32LE(0x10);
  const filePathsLength = buf.readUInt32LE(0x14);
  const pduid = formatGuidLE(buf, 0x18);

  const segmentsOffset = headerLength;
  const pathsTableOffset = segmentsOffset + segmentCount * 16;
  const segments = [];

  for (let i = 0; i < segmentCount; i += 1) {
    const recOff = segmentsOffset + i * 16;
    if (recOff + 16 > buf.length) break;
    const flags = buf.readUInt16LE(recOff + 0x00);
    const pathCodeUnits = buf.readUInt16LE(recOff + 0x02);
    const pathRelByteOffset = buf.readUInt32LE(recOff + 0x04);
    const fileSize = readSafeU64LE(buf, recOff + 0x08, 'SegmentMetadata.fileSize');

    const strStart = pathsTableOffset + pathRelByteOffset;
    const strEnd = Math.min(buf.length, strStart + pathCodeUnits * 2);
    const rawPath =
      strStart <= buf.length
        ? buf.subarray(strStart, strEnd).toString('utf16le').replace(/\0+$/g, '')
        : '';
    const relPath = normalizeContainerRelPath(rawPath);

    segments.push({
      index: i,
      flags,
      keepEncryptedFlag: Boolean(flags & 0x01),
      path: relPath,
      rawPath,
      fileSize,
      pageCount: fileSize === 0 ? 1 : bytesToPages(fileSize),
    });
  }

  return {
    magic,
    version0,
    version1,
    headerLength,
    segmentCount,
    filePathsLength,
    pduid,
    segments,
  };
}

/**
 * @param {any} region
 * @returns {boolean}
 */
function isStructuralXvcRegion(region) {
  const desc = String(region?.description || '').trim().toUpperCase();
  if (STRUCTURAL_XVC_DESCRIPTIONS.has(desc)) return true;
  const flags = Number(region?.flags || 0) >>> 0;
  if ((flags & 0x1) !== 0) return true; // XVC_REGION_FLAG_RESIDENT_METADATA
  const id = Number(region?.id || 0) >>> 0;
  // Note: 0x40000003 (unencrypted prefix file segment region, flags=0, keyId=0xffff)
  // holds segments[0..K] on real GDK packages; all other >= 0x40000000 IDs are structural.
  if (id >= 0x40000000 && id !== 0x40000003) return true;
  return false;
}

/**
 * Maps `SegmentMetadata.bin` segments onto physical `.msixvc` disk offsets & encryption regions.
 *
 * @param {any} segmentMetadata
 * @param {any} xvcInfo
 * @param {any} layout
 * @param {any} header
 */
function mapSegmentsToRegions(segmentMetadata, xvcInfo, layout, header) {
  const segments = Array.isArray(segmentMetadata)
    ? segmentMetadata
    : segmentMetadata?.segments || [];
  if (segments.length === 0) return [];

  const driveDataByteOffset = layout?.driveData?.byteOffset ?? 0;
  const encryptionDisabled = Boolean(header?.encryptionDisabled);
  const rawRegions = Array.isArray(xvcInfo) ? xvcInfo : xvcInfo?.regions || [];
  const regions = rawRegions.filter((r) => r.length > 0 && r.offset >= driveDataByteOffset);
  const candidatePayloadRegions = regions.filter((r) => !isStructuralXvcRegion(r));
  // If an explicit < 0x40000000 user region already claims firstSegmentIndex === 0, prefer it over a dummy 0x40000003
  const hasExplicitUserZeroStart = candidatePayloadRegions.some(
    (r) => (r.id >>> 0) < 0x40000000 && r.firstSegmentIndex === 0
  );
  const filteredPayloadRegions = hasExplicitUserZeroStart
    ? candidatePayloadRegions.filter(
        (r) => (r.id >>> 0) !== 0x40000003 || r.firstSegmentIndex !== 0
      )
    : candidatePayloadRegions;

  const activeRegions = (filteredPayloadRegions.length > 0 ? filteredPayloadRegions : regions)
    .filter((r) => r.firstSegmentIndex < segments.length)
    .slice()
    .sort((a, b) => a.firstSegmentIndex - b.firstSegmentIndex || a.offset - b.offset);

  const mappedByIndex = new Map();
  let nextUnmappedSegIdx = 0;

  for (let rIdx = 0; rIdx < activeRegions.length; rIdx += 1) {
    const region = activeRegions[rIdx];
    let segIdx =
      region.firstSegmentIndex > 0 || rIdx === 0 ? region.firstSegmentIndex : nextUnmappedSegIdx;
    if (segIdx >= segments.length) continue;

    // Never allow a preceding region to bleed past the next region's explicit firstSegmentIndex
    let segLimit = segments.length;
    for (let nextR = rIdx + 1; nextR < activeRegions.length; nextR += 1) {
      if (activeRegions[nextR].firstSegmentIndex > segIdx) {
        segLimit = Math.min(segments.length, activeRegions[nextR].firstSegmentIndex);
        break;
      }
    }

    let cursorByteOffset = region.offset;
    const regionEnd = region.offset + region.length;

    for (; segIdx < segLimit; segIdx += 1) {
      const seg = segments[segIdx];
      const pageCount = Number.isFinite(seg.pageCount)
        ? seg.pageCount
        : bytesToPages(seg.fileSize || 0);
      const alignedBytes = pageCount * XVD_PAGE_SIZE;
      if (cursorByteOffset + alignedBytes > regionEnd) break;
      mappedByIndex.set(segIdx, {
        ...seg,
        pageCount,
        diskOffset: cursorByteOffset,
        alignedByteLength: alignedBytes,
        regionId: region.id,
        keyId: region.keyId,
        keyGuid: region.keyGuid,
        keyHex: region.keyHex,
        isEncrypted: Boolean(region.isEncrypted && !encryptionDisabled),
      });
      cursorByteOffset += alignedBytes;
      if (segIdx + 1 > nextUnmappedSegIdx) {
        nextUnmappedSegIdx = segIdx + 1;
      }
    }
  }

  // Fallback for single-stream Fixed XVD images with no explicit segment regions
  if (mappedByIndex.size === 0 && segments.length > 0) {
    let cursorByteOffset = driveDataByteOffset;
    const defaultRegion = activeRegions[0] || regions[0] || rawRegions[0] || null;
    for (let i = 0; i < segments.length; i += 1) {
      const seg = segments[i];
      const pageCount = Number.isFinite(seg.pageCount)
        ? seg.pageCount
        : bytesToPages(seg.fileSize || 0);
      const alignedBytes = pageCount * XVD_PAGE_SIZE;
      mappedByIndex.set(seg.index ?? i, {
        ...seg,
        pageCount,
        diskOffset: cursorByteOffset,
        alignedByteLength: alignedBytes,
        regionId: defaultRegion ? defaultRegion.id : 0,
        keyId: defaultRegion ? defaultRegion.keyId : 0xffff,
        keyGuid: defaultRegion ? defaultRegion.keyGuid : null,
        keyHex: defaultRegion ? defaultRegion.keyHex : null,
        isEncrypted: Boolean(defaultRegion?.isEncrypted && !encryptionDisabled),
      });
      cursorByteOffset += alignedBytes;
    }
  }

  const ordered = [];
  for (let i = 0; i < segments.length; i += 1) {
    if (mappedByIndex.has(i)) ordered.push(mappedByIndex.get(i));
  }
  return ordered;
}

/**
 * Finds the XVC region covering `containerOffset` (preferring non-structural payload regions over structural regions).
 *
 * @param {any} xvcInfo
 * @param {number} containerOffset
 */
function findRegionForOffset(xvcInfo, containerOffset) {
  const regions = Array.isArray(xvcInfo) ? xvcInfo : xvcInfo?.regions;
  if (!Array.isArray(regions) || regions.length === 0 || !Number.isFinite(containerOffset)) {
    return null;
  }
  let fallbackMatch = null;
  for (const r of regions) {
    if (!r || !(r.length > 0)) continue;
    if (containerOffset >= r.offset && containerOffset < r.offset + r.length) {
      if (!isStructuralXvcRegion(r)) {
        return r;
      }
      if (!fallbackMatch) {
        fallbackMatch = r;
      }
    }
  }
  return fallbackMatch;
}

/**
 * Enriches NTFS data runs with container byte offsets and XVC region metadata, splitting any physical run
 * cleanly at XVC region boundaries if `[containerOffset, containerOffset + byteLength)` spans multiple regions.
 *
 * @param {Array<Record<string, any>>} runs
 * @param {any} xvcInfo
 * @param {any} header
 * @param {any} layout
 * @param {number} [clusterSize=0]
 */
function splitContainerRunsByXvcRegions(runs, xvcInfo, header, layout, clusterSize = 0) {
  if (!Array.isArray(runs) || runs.length === 0) return [];
  const driveDataOff = layout?.driveData?.byteOffset || 0;
  const enriched = [];

  for (const run of runs) {
    if (!run) continue;
    const baseContainerOffset = Number.isFinite(run.containerOffset)
      ? Number(run.containerOffset)
      : !run.sparse &&
          run.diskOffset !== null &&
          run.diskOffset !== undefined &&
          header?.xvdType === 0
        ? driveDataOff + Number(run.diskOffset)
        : null;
    const totalLen = Math.max(0, Number(run.byteLength || 0));

    if (run.sparse || baseContainerOffset === null || totalLen === 0) {
      enriched.push({
        ...run,
        sparse: Boolean(run.sparse),
        byteLength: totalLen,
        containerOffset: baseContainerOffset,
        regionId: 0,
        keyId: 0xffff,
        keyGuid: null,
        keyHex: null,
        isEncrypted: false,
      });
      continue;
    }

    const spanStart = baseContainerOffset;
    const spanEnd = baseContainerOffset + totalLen;
    /** @type {Set<number>} */
    const splitSet = new Set();
    for (const r of xvcInfo?.regions || []) {
      if (!r || !(r.length > 0)) continue;
      const rStart = r.offset;
      const rEnd = r.offset + r.length;
      if (rStart > spanStart && rStart < spanEnd) splitSet.add(rStart);
      if (rEnd > spanStart && rEnd < spanEnd) splitSet.add(rEnd);
    }
    const splitPoints = Array.from(splitSet).sort((a, b) => a - b);
    splitPoints.push(spanEnd);

    let subStart = spanStart;
    for (const subEnd of splitPoints) {
      const subLen = subEnd - subStart;
      if (subLen <= 0) continue;
      const reg = findRegionForOffset(xvcInfo, subStart);
      const isEncrypted = !header?.encryptionDisabled && Boolean(reg?.isEncrypted);
      const keyId = reg && Number.isFinite(reg.keyId) ? reg.keyId : 0xffff;
      const keyEntry =
        isEncrypted && xvcInfo?.encryptionKeyIds?.[keyId] ? xvcInfo.encryptionKeyIds[keyId] : null;
      const relOff = subStart - spanStart;

      enriched.push({
        ...run,
        ...(clusterSize > 0 && Number.isFinite(run.vcn) && relOff % clusterSize === 0
          ? {
              vcn: run.vcn + relOff / clusterSize,
              lcn:
                run.lcn !== null && run.lcn !== undefined ? run.lcn + relOff / clusterSize : null,
              clusterCount: subLen / clusterSize,
            }
          : {}),
        sparse: false,
        byteLength: subLen,
        diskOffset:
          run.diskOffset !== null && run.diskOffset !== undefined
            ? Number(run.diskOffset) + relOff
            : subStart - driveDataOff,
        containerOffset: subStart,
        regionId: reg ? reg.id : 0,
        keyId,
        keyGuid: isEncrypted ? (keyEntry ? keyEntry.guid : reg?.keyGuid || null) : null,
        keyHex: isEncrypted ? (keyEntry ? keyEntry.hex : reg?.keyHex || null) : null,
        isEncrypted,
      });
      subStart = subEnd;
    }
  }

  return enriched;
}

/**
 * Decrypts a contiguous 0x1000-page-aligned XVC region buffer using L0 `data_unit` tweaks and AES-128-XTS.
 *
 * @param {{
 *   rawBuffer: Buffer|Uint8Array,
 *   firstPageByteOffset?: number,
 *   pageCount: number,
 *   dataUnits: Uint32Array|number[],
 *   osslXtsKey: Buffer|Uint8Array,
 *   header: { regionIdInXts?: boolean, vduidLow8: Buffer },
 *   regionId: number,
 *   inPlace?: boolean,
 * }} params
 * @returns {Buffer}
 */
function decryptXvcRegionBuffer({
  rawBuffer,
  firstPageByteOffset,
  pageCount,
  dataUnits,
  osslXtsKey,
  header,
  regionId,
  inPlace = false,
}) {
  return decryptContiguousPageBuffer({
    rawBuffer,
    firstPageDiskOffset: firstPageByteOffset,
    pageCount,
    dataUnits,
    osslXtsKey,
    regionId: header?.regionIdInXts ? regionId : 0,
    vduidLow8: header.vduidLow8,
    inPlace,
  });
}

/**
 * @param {string[] | null | undefined} filePaths
 */
function detectAntiCheatSignals(filePaths) {
  const matched = new Map();
  for (const rawPath of filePaths || []) {
    const norm = normalizeContainerRelPath(rawPath);
    if (!norm) continue;
    for (const rule of KERNEL_ANTICHEAT_RULES) {
      if (rule.pattern.test(norm) && !matched.has(rule.id)) {
        matched.set(rule.id, {
          id: rule.id,
          label: rule.label,
          matchedPath: norm,
        });
      }
    }
  }
  return Array.from(matched.values());
}

/**
 * @param {string} relPath
 * @param {string} stripPrefix
 * @returns {string}
 */
function stripFlatRootPrefix(relPath, stripPrefix) {
  const norm = normalizeContainerRelPath(relPath);
  if (!stripPrefix) return norm;
  const lower = norm.toLowerCase();
  const pref = `${stripPrefix.toLowerCase()}/`;
  return lower.startsWith(pref) ? norm.slice(pref.length) : norm;
}

/**
 * @param {any} seg
 * @param {any} xvcInfo
 * @param {Record<string, any>} [options]
 * @returns {Buffer | null}
 */
function resolveOptionalSegmentOsslKey(seg, xvcInfo, options = {}) {
  const deviceKey = options.deviceKey || options.kek || null;
  /** @param {any} raw */
  const coerce = (raw) => {
    if (!raw) return null;
    let buf = Buffer.isBuffer(raw)
      ? raw
      : raw instanceof Uint8Array
        ? Buffer.from(raw)
        : /^[0-9a-fA-F]{64}$/.test(String(raw).trim()) ||
            /^[0-9a-fA-F]{80}$/.test(String(raw).trim())
          ? Buffer.from(String(raw).trim(), 'hex')
          : Buffer.from(String(raw).trim(), 'base64');
    if (buf.length === 40 && deviceKey) {
      buf = unwrapCikWithDeviceKey(buf, deviceKey);
    }
    return buf.length === 32 ? buildOpenSslXtsKey(buf) : null;
  };

  const rawCikCollection = options.cikMap || options.cikKeys;
  if (rawCikCollection && typeof rawCikCollection === 'object') {
    const map = new Map();
    if (Array.isArray(rawCikCollection)) {
      for (const item of rawCikCollection) {
        if (!item || typeof item !== 'object') continue;
        const kRaw = item.keyId ?? item.guid ?? item.id ?? '';
        const vRaw = item.cik ?? item.key ?? item.rawCik;
        const key = coerce(vRaw);
        if (kRaw && key) map.set(String(kRaw).toLowerCase().replace(/[{}]/g, ''), key);
        else if (key && map.size === 0) map.set('0', key);
      }
    } else {
      const entries =
        rawCikCollection instanceof Map
          ? Array.from(rawCikCollection.entries())
          : Object.entries(rawCikCollection);
      for (const [k, v] of entries) {
        const kNorm = String(k).toLowerCase().replace(/[{}]/g, '');
        const key = coerce(
          v && typeof v === 'object' && !Buffer.isBuffer(v) && !(v instanceof Uint8Array)
            ? v.cik ?? v.key ?? v.rawCik
            : v
        );
        if (key) map.set(kNorm, key);
      }
    }
    if (seg.keyGuid && map.has(seg.keyGuid.toLowerCase())) {
      return map.get(seg.keyGuid.toLowerCase());
    }
    if (seg.keyHex && map.has(seg.keyHex.toLowerCase())) {
      return map.get(seg.keyHex.toLowerCase());
    }
    if (map.has(String(seg.keyId))) return map.get(String(seg.keyId));
    const entry = xvcInfo?.encryptionKeyIds?.[seg.keyId];
    if (entry && map.has(entry.guid.toLowerCase())) return map.get(entry.guid.toLowerCase());
    if (map.size === 1) return map.values().next().value;
  }
  return coerce(options.cik);
}

module.exports = {
  parseXvcInfo,
  parseUserData,
  parseSegmentMetadata,
  isStructuralXvcRegion,
  mapSegmentsToRegions,
  findRegionForOffset,
  splitContainerRunsByXvcRegions,
  decryptXvcRegionBuffer,
  detectAntiCheatSignals,
  stripFlatRootPrefix,
  resolveOptionalSegmentOsslKey,
};
