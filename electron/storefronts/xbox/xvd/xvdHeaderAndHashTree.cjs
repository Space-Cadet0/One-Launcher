// @ts-check
'use strict';

const crypto = require('node:crypto');
const {
  XVD_MAGIC,
  XVD_PAGE_SIZE,
  XVD_HEADER_PAGES,
  XVD_HEADER_SECTION_SIZE,
  XVD_HASH_ENTRIES_PER_PAGE,
  XVD_HASH_ENTRY_SIZE,
  XVD_L0_HASH_LENGTH,
  XVD_UPPER_HASH_LENGTH,
  XVD_ROOT_HASH_LENGTH,
  MAX_XVD_METADATA_ALLOC_BYTES,
  XVD_VOLUME_FLAGS,
  readSafeU64LE,
  bytesToPages,
  formatGuidLE,
  isAllZeroBuffer,
} = require('./xvdConstantsAndPrimitives.cjs');

const DEFAULT_MAX_CACHED_UPPER_HASH_PAGES = 2048;

/** @type {WeakMap<object, Map<string, ReturnType<typeof createXvdHashTreeVerifier>>>} */
const hashTreeVerifierCacheByReader = new WeakMap();

/**
 * Parses the XvdHeader from the first >= 0x478 (ideally 0x3000) bytes of an MSIXVC/XVD image.
 *
 * @param {Buffer} buf
 */
function parseXvdHeader(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 0x478) {
    throw new Error(`Invalid XVD header buffer length: ${buf ? buf.length : 0}`);
  }
  const magic = buf.subarray(0x200, 0x208).toString('ascii');
  if (magic !== XVD_MAGIC) {
    throw new Error(`Invalid XVD magic at 0x200: expected "${XVD_MAGIC}", got "${magic}"`);
  }

  const volumeFlags = buf.readUInt32LE(0x208);
  const formatVersion = buf.readUInt32LE(0x20c);
  const fileTimeCreated = buf.readBigUInt64LE(0x210);
  const driveSize = readSafeU64LE(buf, 0x218, 'XvdHeader.driveSize');
  const vduid = Buffer.from(buf.subarray(0x220, 0x230));
  const vduidLow8 = Buffer.from(buf.subarray(0x220, 0x228));
  const uduid = Buffer.from(buf.subarray(0x230, 0x240));
  const topHashBlockHash = Buffer.from(buf.subarray(0x240, 0x260));
  const originalXvcDataHash = Buffer.from(buf.subarray(0x260, 0x280));
  const xvdType = buf.readUInt32LE(0x280); // 0 = Fixed, 1 = Dynamic
  const xvdContentType = buf.readUInt32LE(0x284);
  const embeddedXvdLength = buf.readUInt32LE(0x288);
  const userDataLength = buf.readUInt32LE(0x28c);
  const xvcDataLength = buf.readUInt32LE(0x290);
  const dynamicHeaderLength = buf.readUInt32LE(0x294);
  if (userDataLength > MAX_XVD_METADATA_ALLOC_BYTES) {
    throw new RangeError(
      `XvdHeader.userDataLength (${userDataLength}) exceeds ${MAX_XVD_METADATA_ALLOC_BYTES} byte cap`
    );
  }
  if (xvcDataLength > MAX_XVD_METADATA_ALLOC_BYTES) {
    throw new RangeError(
      `XvdHeader.xvcDataLength (${xvcDataLength}) exceeds ${MAX_XVD_METADATA_ALLOC_BYTES} byte cap`
    );
  }
  if (dynamicHeaderLength > MAX_XVD_METADATA_ALLOC_BYTES) {
    throw new RangeError(
      `XvdHeader.dynamicHeaderLength (${dynamicHeaderLength}) exceeds ${MAX_XVD_METADATA_ALLOC_BYTES} byte cap`
    );
  }
  const blockSize = buf.readUInt32LE(0x298) || 0xaa000;
  const productId = formatGuidLE(buf, 0x39c);
  const pduid = formatGuidLE(buf, 0x3ac);
  const mutablePageCount = buf.readUInt8(0x470);

  return {
    magic,
    volumeFlags,
    readOnly: Boolean(volumeFlags & XVD_VOLUME_FLAGS.READ_ONLY),
    encryptionDisabled: Boolean(volumeFlags & XVD_VOLUME_FLAGS.ENCRYPTION_DISABLED),
    dataIntegrityDisabled: Boolean(volumeFlags & XVD_VOLUME_FLAGS.DATA_INTEGRITY_DISABLED),
    legacySectorSize: Boolean(volumeFlags & XVD_VOLUME_FLAGS.LEGACY_SECTOR_SIZE),
    resiliencyEnabled: Boolean(volumeFlags & XVD_VOLUME_FLAGS.RESILIENCY_ENABLED),
    regionIdInXts: Boolean(volumeFlags & XVD_VOLUME_FLAGS.REGION_ID_IN_XTS),
    formatVersion,
    fileTimeCreated,
    driveSize,
    vduid,
    vduidLow8,
    vduidGuid: formatGuidLE(vduid, 0),
    uduid,
    uduidGuid: formatGuidLE(uduid, 0),
    topHashBlockHash,
    originalXvcDataHash,
    xvdType,
    xvdContentType,
    embeddedXvdLength,
    userDataLength,
    xvcDataLength,
    dynamicHeaderLength,
    blockSize,
    productId,
    pduid,
    mutablePageCount,
  };
}

/**
 * Computes the 4-level XVD hash tree page layout (`[level3 | level2 | level1 | level0]`).
 *
 * @param {number} totalHashedPages
 * @param {boolean} [resiliencyEnabled=false]
 */
function computeHashTreeLayout(totalHashedPages, resiliencyEnabled = false) {
  const n = Math.max(0, Math.floor(Number(totalHashedPages || 0)));
  const mult = resiliencyEnabled ? 2 : 1;
  if (n === 0) {
    return {
      totalHashedPages: 0,
      resiliencyMultiplier: mult,
      level0Pages: 0,
      level1Pages: 0,
      level2Pages: 0,
      level3Pages: 0,
      level3OffsetPages: 0,
      level2OffsetPages: 0,
      level1OffsetPages: 0,
      level0OffsetPages: 0,
      topLevel: -1,
      totalPages: 0,
    };
  }

  /** @param {number} count */
  const storedHashes = (count) => (count <= 1 ? 0 : count);
  /** @param {number} count */
  const levelPages = (count) => {
    const s = storedHashes(count);
    return s === 0 ? 0 : Math.ceil(s / XVD_HASH_ENTRIES_PER_PAGE);
  };

  // Level 0 always occupies >= 1 page when totalHashedPages >= 1
  const level0Pages = Math.max(1, Math.ceil(n / XVD_HASH_ENTRIES_PER_PAGE));
  const level1Pages = levelPages(level0Pages);
  const level2Pages = levelPages(level1Pages);
  const level3Pages = levelPages(level2Pages);
  if (level3Pages > 1) {
    throw new RangeError(
      `XVD hash tree exceeds 4-level maximum depth (level3Pages=${level3Pages}, totalHashedPages=${n})`
    );
  }

  const level3OffsetPages = 0;
  const level2OffsetPages = level3Pages * mult;
  const level1OffsetPages = (level3Pages + level2Pages) * mult;
  const level0OffsetPages = (level3Pages + level2Pages + level1Pages) * mult;
  const totalPages = (level3Pages + level2Pages + level1Pages + level0Pages) * mult;
  const topLevel =
    level3Pages > 0 ? 3 : level2Pages > 0 ? 2 : level1Pages > 0 ? 1 : level0Pages > 0 ? 0 : -1;

  return {
    totalHashedPages: n,
    resiliencyMultiplier: mult,
    level0Pages,
    level1Pages,
    level2Pages,
    level3Pages,
    level3OffsetPages,
    level2OffsetPages,
    level1OffsetPages,
    level0OffsetPages,
    topLevel,
    totalPages,
  };
}

/**
 * Computes exact page & byte spans for every section of an XVD container.
 * Explicitly multiplies `userData.startPage * 0x1000` (fixing upstream xodus's page-vs-byte bug).
 *
 * @param {any} header
 */
function computeXvdLayout(header) {
  let cursorPage = 0;
  /**
   * @param {number} pageCount
   * @param {number} [exactByteLength]
   */
  const makeSpan = (pageCount, exactByteLength = pageCount * XVD_PAGE_SIZE) => {
    const startPage = cursorPage;
    const byteOffset = startPage * XVD_PAGE_SIZE;
    const alignedByteLength = pageCount * XVD_PAGE_SIZE;
    cursorPage += pageCount;
    return {
      startPage,
      endPage: cursorPage,
      pageCount,
      byteOffset,
      byteLength: exactByteLength,
      alignedByteLength,
    };
  };

  const headerSpan = makeSpan(XVD_HEADER_PAGES, XVD_HEADER_SECTION_SIZE);
  const embeddedXvdPages = bytesToPages(header.embeddedXvdLength);
  const embeddedXvdSpan = makeSpan(embeddedXvdPages, header.embeddedXvdLength);
  const mutableDataSpan = makeSpan(
    header.mutablePageCount,
    header.mutablePageCount * XVD_PAGE_SIZE
  );

  const userDataPages = bytesToPages(header.userDataLength);
  const xvcInfoPages = bytesToPages(header.xvcDataLength);
  const dynamicHeaderPages = bytesToPages(header.dynamicHeaderLength);
  const driveDataPages = bytesToPages(header.driveSize);
  const totalHashedPages = userDataPages + xvcInfoPages + dynamicHeaderPages + driveDataPages;

  const hashTreeDetails = header.dataIntegrityDisabled
    ? computeHashTreeLayout(0, header.resiliencyEnabled)
    : computeHashTreeLayout(totalHashedPages, header.resiliencyEnabled);

  const baseHashTreeSpan = makeSpan(
    hashTreeDetails.totalPages,
    hashTreeDetails.totalPages * XVD_PAGE_SIZE
  );
  const hashTreeStartPage = baseHashTreeSpan.startPage;
  const level3StartPage = hashTreeStartPage + hashTreeDetails.level3OffsetPages;
  const level2StartPage = hashTreeStartPage + hashTreeDetails.level2OffsetPages;
  const level1StartPage = hashTreeStartPage + hashTreeDetails.level1OffsetPages;
  const level0StartPage = hashTreeStartPage + hashTreeDetails.level0OffsetPages;

  const hashTreeSpan = {
    ...baseHashTreeSpan,
    ...hashTreeDetails,
    level3StartPage,
    level3ByteOffset: level3StartPage * XVD_PAGE_SIZE,
    level2StartPage,
    level2ByteOffset: level2StartPage * XVD_PAGE_SIZE,
    level1StartPage,
    level1ByteOffset: level1StartPage * XVD_PAGE_SIZE,
    level0StartPage,
    level0ByteOffset: level0StartPage * XVD_PAGE_SIZE,
  };

  const userDataSpan = makeSpan(userDataPages, header.userDataLength);
  const xvcInfoSpan = makeSpan(xvcInfoPages, header.xvcDataLength);
  const dynamicHeaderSpan = makeSpan(dynamicHeaderPages, header.dynamicHeaderLength);
  const driveDataSpan = makeSpan(driveDataPages, header.driveSize);

  return {
    pageSize: XVD_PAGE_SIZE,
    header: headerSpan,
    embeddedXvd: embeddedXvdSpan,
    mutableData: mutableDataSpan,
    hashTree: hashTreeSpan,
    userData: userDataSpan,
    xvcInfo: xvcInfoSpan,
    dynamicHeader: dynamicHeaderSpan,
    driveData: driveDataSpan,
    totalContainerPages: cursorPage,
    totalContainerBytes: cursorPage * XVD_PAGE_SIZE,
  };
}

/**
 * Computes the truncated XVD L0 SHA-256 digest (20 bytes for encrypted/XVC entries where `[20..24]`
 * holds `data_unit`, or up to 24 bytes when `hashByteLength = 24`) over a single `0x1000` (4096-byte)
 * on-disk XVD page (`D8.5`).
 *
 * @param {Buffer|Uint8Array} rawPageBuffer
 * @param {number} [hashByteLength=20]
 * @returns {Buffer}
 */
function computeXvdL0PageHash(rawPageBuffer, hashByteLength = XVD_L0_HASH_LENGTH) {
  const view = Buffer.isBuffer(rawPageBuffer) ? rawPageBuffer : Buffer.from(rawPageBuffer || []);
  let page4096 = view;
  if (view.length !== XVD_PAGE_SIZE) {
    page4096 = Buffer.alloc(XVD_PAGE_SIZE, 0);
    view.copy(page4096, 0, 0, Math.min(view.length, XVD_PAGE_SIZE));
  }
  const len = Math.max(1, Math.min(XVD_UPPER_HASH_LENGTH, Number(hashByteLength) || XVD_L0_HASH_LENGTH));
  const fullDigest = crypto.createHash('sha256').update(page4096).digest();
  return Buffer.from(fullDigest.subarray(0, len));
}

/**
 * Computes the SHA-256 hash of a 4096-byte XVD hash tree block:
 * - `hashByteLength = 24` for upper-level parent entries (`L0 -> L1`, `L1 -> L2`, `L2 -> L3`).
 * - `hashByteLength = 32` for the root top hash block compared against `header.topHashBlockHash`.
 *
 * @param {Buffer|Uint8Array} rawHashPageBuffer
 * @param {number} [hashByteLength=24]
 * @returns {Buffer}
 */
function computeXvdHashBlockHash(rawHashPageBuffer, hashByteLength = XVD_UPPER_HASH_LENGTH) {
  const view = Buffer.isBuffer(rawHashPageBuffer)
    ? rawHashPageBuffer
    : Buffer.from(rawHashPageBuffer || []);
  if (view.length < XVD_PAGE_SIZE) {
    throw new RangeError(
      `XVD hash tree block must be ${XVD_PAGE_SIZE} bytes (got ${view.length})`
    );
  }
  const page4096 = view.length === XVD_PAGE_SIZE ? view : view.subarray(0, XVD_PAGE_SIZE);
  const len = Math.max(1, Math.min(XVD_ROOT_HASH_LENGTH, Number(hashByteLength) || XVD_UPPER_HASH_LENGTH));
  const digest = crypto.createHash('sha256').update(page4096).digest();
  return len === XVD_ROOT_HASH_LENGTH ? digest : Buffer.from(digest.subarray(0, len));
}

/**
 * Verifies a single 4096-byte raw XVD page against an expected L0 hash entry or 20/24-byte SHA-256 prefix.
 *
 * @param {Buffer|Uint8Array} rawPageBuffer
 * @param {Buffer|Uint8Array} expectedHashOrEntry
 * @param {{ hashByteLength?: number, throwOnMismatch?: boolean, pageOffset?: number, full24Bytes?: boolean }} [options]
 * @returns {boolean}
 */
function verifyXvdL0PageHash(rawPageBuffer, expectedHashOrEntry, options = {}) {
  const expectedView = Buffer.isBuffer(expectedHashOrEntry)
    ? expectedHashOrEntry
    : Buffer.from(expectedHashOrEntry || []);
  const cmpLen = Math.max(
    1,
    Math.min(
      XVD_UPPER_HASH_LENGTH,
      Number(options.hashByteLength) ||
        (expectedView.length === XVD_UPPER_HASH_LENGTH && options.full24Bytes
          ? XVD_UPPER_HASH_LENGTH
          : XVD_L0_HASH_LENGTH)
    )
  );
  if (expectedView.length < cmpLen) {
    if (options.throwOnMismatch) {
      throw new Error(`Invalid XVD L0 hash entry length (${expectedView.length} < ${cmpLen})`);
    }
    return false;
  }
  const expectedSlice = expectedView.subarray(0, cmpLen);
  const actualSlice = computeXvdL0PageHash(rawPageBuffer, cmpLen);
  const ok = crypto.timingSafeEqual(actualSlice, expectedSlice);
  if (!ok && options.throwOnMismatch) {
    const offStr =
      typeof options.pageOffset === 'number' ? ` at offset 0x${options.pageOffset.toString(16)}` : '';
    throw new Error(`XVD HashTree L0 SHA-256 page integrity check failed${offStr}`);
  }
  return ok;
}

/**
 * Resolves the byte offset, logical page count, and top-level depth for any hash-tree level `0..3`.
 *
 * @param {any} layout
 */
function resolveHashTreeLevelMetrics(layout) {
  const ht = layout?.hashTree || {};
  const mult = Math.max(1, Number(ht.resiliencyMultiplier) || 1);
  const levelCounts = [
    Number(ht.level0Pages) || 0,
    Number(ht.level1Pages) || 0,
    Number(ht.level2Pages) || 0,
    Number(ht.level3Pages) || 0,
  ];
  const baseByteOffset = Number(ht.byteOffset) || 0;
  const level3OffsetPages = Number.isFinite(ht.level3OffsetPages) ? Number(ht.level3OffsetPages) : 0;
  const level2OffsetPages = Number.isFinite(ht.level2OffsetPages)
    ? Number(ht.level2OffsetPages)
    : levelCounts[3] * mult;
  const level1OffsetPages = Number.isFinite(ht.level1OffsetPages)
    ? Number(ht.level1OffsetPages)
    : (levelCounts[3] + levelCounts[2]) * mult;
  const level0OffsetPages = Number.isFinite(ht.level0OffsetPages)
    ? Number(ht.level0OffsetPages)
    : (levelCounts[3] + levelCounts[2] + levelCounts[1]) * mult;

  const levelByteOffsets = [
    Number.isFinite(ht.level0ByteOffset)
      ? Number(ht.level0ByteOffset)
      : baseByteOffset + level0OffsetPages * XVD_PAGE_SIZE,
    Number.isFinite(ht.level1ByteOffset)
      ? Number(ht.level1ByteOffset)
      : baseByteOffset + level1OffsetPages * XVD_PAGE_SIZE,
    Number.isFinite(ht.level2ByteOffset)
      ? Number(ht.level2ByteOffset)
      : baseByteOffset + level2OffsetPages * XVD_PAGE_SIZE,
    Number.isFinite(ht.level3ByteOffset)
      ? Number(ht.level3ByteOffset)
      : baseByteOffset + level3OffsetPages * XVD_PAGE_SIZE,
  ];

  const topLevel =
    typeof ht.topLevel === 'number'
      ? ht.topLevel
      : levelCounts[3] > 0
        ? 3
        : levelCounts[2] > 0
          ? 2
          : levelCounts[1] > 0
            ? 1
            : levelCounts[0] > 0
              ? 0
              : -1;

  return { mult, levelCounts, levelByteOffsets, topLevel };
}

/**
 * Creates a cached full-chain XVD HashTree Merkle verifier (`L0 -> L1 -> L2 -> L3 -> header.topHashBlockHash`)
 * with bounded LRU caching + in-flight coalescing for upper-level hash pages so sequential extraction
 * pays zero redundant CDN round-trips while cryptographically authenticating every L0 block to the
 * header's signed root hash (`P0-04`).
 *
 * @param {{
 *   rangeReader: any,
 *   layout: any,
 *   topHashBlockHash: Buffer | Uint8Array,
 *   maxCachedUpperPages?: number,
 * }} params
 */
function createXvdHashTreeVerifier({
  rangeReader,
  layout,
  topHashBlockHash,
  maxCachedUpperPages = DEFAULT_MAX_CACHED_UPPER_HASH_PAGES,
}) {
  const rootHash32 = Buffer.isBuffer(topHashBlockHash)
    ? topHashBlockHash
    : Buffer.from(topHashBlockHash || []);
  if (rootHash32.length !== XVD_ROOT_HASH_LENGTH || isAllZeroBuffer(rootHash32)) {
    throw new Error('createXvdHashTreeVerifier requires a non-zero 32-byte header.topHashBlockHash');
  }

  const metrics = resolveHashTreeLevelMetrics(layout);
  const maxCached = Math.max(16, Math.floor(Number(maxCachedUpperPages) || DEFAULT_MAX_CACHED_UPPER_HASH_PAGES));
  /** @type {Map<string, Buffer>} */
  const verifiedUpperPages = new Map();
  /** @type {Map<string, Promise<Buffer>>} */
  const inFlightUpperPages = new Map();
  let upperFetches = 0;
  let upperCacheHits = 0;
  let verifiedL0Count = 0;

  /**
   * Verifies a candidate 4096-byte page (and resilient mirror when `mult === 2`) against an expected
   * 24-byte parent hash or 32-byte root hash, returning the verified 4096-byte slice or `null`.
   *
   * @param {Buffer} rawSpan
   * @param {number} copyOffset
   * @param {Buffer} expectedHash
   * @param {number} expectedLen
   * @returns {Buffer | null}
   */
  function matchVerifiedPageWithResiliency(rawSpan, copyOffset, expectedHash, expectedLen) {
    for (let replica = 0; replica < metrics.mult; replica += 1) {
      const start = copyOffset + replica * XVD_PAGE_SIZE;
      if (start + XVD_PAGE_SIZE > rawSpan.length) break;
      const candidate = rawSpan.subarray(start, start + XVD_PAGE_SIZE);
      const actual = computeXvdHashBlockHash(candidate, expectedLen);
      if (crypto.timingSafeEqual(actual, expectedHash)) {
        return candidate;
      }
    }
    return null;
  }

  /**
   * Fetches and cryptographically authenticates upper hash block `(level, pageIdx)` all the way up
   * to `header.topHashBlockHash` (`level === topLevel`), caching the verified 4096-byte block in memory.
   *
   * @param {number} level
   * @param {number} pageIdx
   * @param {AbortSignal} [signal]
   * @returns {Promise<Buffer>}
   */
  async function getVerifiedUpperHashPage(level, pageIdx, signal) {
    if (level < 1 || level > 3 || level > metrics.topLevel) {
      throw new RangeError(`Invalid XVD HashTree upper level ${level} (topLevel=${metrics.topLevel})`);
    }
    const levelPageCount = metrics.levelCounts[level];
    if (!Number.isInteger(pageIdx) || pageIdx < 0 || pageIdx >= levelPageCount) {
      throw new RangeError(
        `XVD HashTree L${level} page index ${pageIdx} out of bounds (0..${Math.max(0, levelPageCount - 1)})`
      );
    }

    const cacheKey = `${level}:${pageIdx}`;
    const cached = verifiedUpperPages.get(cacheKey);
    if (cached) {
      verifiedUpperPages.delete(cacheKey);
      verifiedUpperPages.set(cacheKey, cached);
      upperCacheHits += 1;
      return cached;
    }

    const pending = inFlightUpperPages.get(cacheKey);
    if (pending) {
      return pending;
    }

    const workPromise = (async () => {
      const byteOff = metrics.levelByteOffsets[level] + pageIdx * metrics.mult * XVD_PAGE_SIZE;
      const readLen = metrics.mult * XVD_PAGE_SIZE;
      const rawSpan = await rangeReader.readRange(byteOff, readLen, signal);
      upperFetches += 1;
      if (!Buffer.isBuffer(rawSpan) || rawSpan.length < XVD_PAGE_SIZE) {
        throw new Error(
          `Truncated XVD HashTree L${level} page ${pageIdx} at 0x${byteOff.toString(16)}: got ${rawSpan ? rawSpan.length : 0} bytes`
        );
      }

      /** @type {Buffer | null} */
      let verifiedPage = null;

      if (level === metrics.topLevel) {
        if (pageIdx !== 0) {
          throw new Error(`XVD HashTree top level L${level} must address page 0 (got ${pageIdx})`);
        }
        verifiedPage = matchVerifiedPageWithResiliency(
          rawSpan,
          0,
          rootHash32,
          XVD_ROOT_HASH_LENGTH
        );
        if (!verifiedPage) {
          throw new Error(
            `XVD HashTree root integrity check failed: L${level} top hash block SHA-256 does not match header.topHashBlockHash`
          );
        }
      } else {
        const parentLevel = level + 1;
        const parentPageIdx = Math.floor(pageIdx / XVD_HASH_ENTRIES_PER_PAGE);
        const parentEntryIdx = pageIdx % XVD_HASH_ENTRIES_PER_PAGE;
        const parentPage = await getVerifiedUpperHashPage(parentLevel, parentPageIdx, signal);
        const entryOff = parentEntryIdx * XVD_HASH_ENTRY_SIZE;
        const expected24 = parentPage.subarray(entryOff, entryOff + XVD_UPPER_HASH_LENGTH);
        verifiedPage = matchVerifiedPageWithResiliency(
          rawSpan,
          0,
          expected24,
          XVD_UPPER_HASH_LENGTH
        );
        if (!verifiedPage) {
          throw new Error(
            `XVD HashTree L${level}->L${parentLevel} SHA-256 integrity check failed for L${level} page ${pageIdx}`
          );
        }
      }

      const stored = Buffer.from(verifiedPage);
      verifiedUpperPages.set(cacheKey, stored);
      while (verifiedUpperPages.size > maxCached) {
        const oldestKey = verifiedUpperPages.keys().next().value;
        if (oldestKey === undefined) break;
        verifiedUpperPages.delete(oldestKey);
      }
      return stored;
    })();

    inFlightUpperPages.set(cacheKey, workPromise);
    try {
      return await workPromise;
    } finally {
      if (inFlightUpperPages.get(cacheKey) === workPromise) {
        inFlightUpperPages.delete(cacheKey);
      }
    }
  }

  /**
   * Authenticates every logical L0 page in `l0SpanBuf` (`[firstL0LogicalPage .. firstL0LogicalPage + logicalPageCount - 1]`)
   * up to `header.topHashBlockHash`, returning the verified 4096-byte slice for each logical L0 page.
   *
   * @param {Buffer} l0SpanBuf
   * @param {number} firstL0LogicalPage
   * @param {number} logicalPageCount
   * @param {AbortSignal} [signal]
   * @returns {Promise<Buffer[]>}
   */
  async function verifyL0Span(l0SpanBuf, firstL0LogicalPage, logicalPageCount, signal) {
    if (metrics.topLevel < 0 || metrics.levelCounts[0] <= 0) {
      throw new Error('Cannot verify XVD HashTree L0 span when hash tree is empty/disabled');
    }
    /** @type {Buffer[]} */
    const verifiedPages = [];

    for (let i = 0; i < logicalPageCount; i += 1) {
      const l0PageIdx = firstL0LogicalPage + i;
      if (l0PageIdx < 0 || l0PageIdx >= metrics.levelCounts[0]) {
        throw new RangeError(
          `XVD HashTree L0 page index ${l0PageIdx} out of bounds (0..${Math.max(0, metrics.levelCounts[0] - 1)})`
        );
      }
      const copyOffset = i * metrics.mult * XVD_PAGE_SIZE;
      if (copyOffset + XVD_PAGE_SIZE > l0SpanBuf.length) {
        throw new Error(
          `Truncated XVD HashTree L0 page ${l0PageIdx}: buffer has ${l0SpanBuf.length} bytes, need ${copyOffset + XVD_PAGE_SIZE}`
        );
      }

      /** @type {Buffer | null} */
      let verifiedPage = null;
      if (metrics.topLevel === 0) {
        if (l0PageIdx !== 0) {
          throw new Error(`XVD HashTree top level L0 must address page 0 (got ${l0PageIdx})`);
        }
        verifiedPage = matchVerifiedPageWithResiliency(
          l0SpanBuf,
          copyOffset,
          rootHash32,
          XVD_ROOT_HASH_LENGTH
        );
        if (!verifiedPage) {
          throw new Error(
            'XVD HashTree root integrity check failed: L0 top hash block SHA-256 does not match header.topHashBlockHash'
          );
        }
      } else {
        const l1PageIdx = Math.floor(l0PageIdx / XVD_HASH_ENTRIES_PER_PAGE);
        const l1EntryIdx = l0PageIdx % XVD_HASH_ENTRIES_PER_PAGE;
        const l1Page = await getVerifiedUpperHashPage(1, l1PageIdx, signal);
        const entryOff = l1EntryIdx * XVD_HASH_ENTRY_SIZE;
        const expected24 = l1Page.subarray(entryOff, entryOff + XVD_UPPER_HASH_LENGTH);
        verifiedPage = matchVerifiedPageWithResiliency(
          l0SpanBuf,
          copyOffset,
          expected24,
          XVD_UPPER_HASH_LENGTH
        );
        if (!verifiedPage) {
          throw new Error(
            `XVD HashTree L0->L1 SHA-256 integrity check failed for L0 page ${l0PageIdx}`
          );
        }
      }

      verifiedPages.push(verifiedPage);
      verifiedL0Count += 1;
    }

    return verifiedPages;
  }

  return {
    topLevel: metrics.topLevel,
    getVerifiedUpperHashPage,
    verifyL0Span,
    clearCache() {
      verifiedUpperPages.clear();
    },
    getStats() {
      return {
        topLevel: metrics.topLevel,
        cachedUpperPages: verifiedUpperPages.size,
        upperFetches,
        upperCacheHits,
        verifiedL0Count,
      };
    },
  };
}

/**
 * Returns (or creates and caches) a per-`(rangeReader, layout, topHashBlockHash)` Merkle verifier
 * so sequential extraction reuses verified L1/L2/L3 hash blocks in memory.
 *
 * @param {any} rangeReader
 * @param {any} layout
 * @param {Buffer | Uint8Array} topHashBlockHash
 */
function getOrCreateHashTreeVerifier(rangeReader, layout, topHashBlockHash) {
  const rootBuf = Buffer.isBuffer(topHashBlockHash)
    ? topHashBlockHash
    : Buffer.from(topHashBlockHash || []);
  const key = `${layout?.hashTree?.byteOffset || 0}:${layout?.hashTree?.totalPages || 0}:${rootBuf.toString('hex')}`;
  if (rangeReader && typeof rangeReader === 'object') {
    let byKey = hashTreeVerifierCacheByReader.get(rangeReader);
    if (!byKey) {
      byKey = new Map();
      hashTreeVerifierCacheByReader.set(rangeReader, byKey);
    }
    let verifier = byKey.get(key);
    if (!verifier) {
      verifier = createXvdHashTreeVerifier({
        rangeReader,
        layout,
        topHashBlockHash: rootBuf,
      });
      if (byKey.size >= 8) {
        const oldest = byKey.keys().next().value;
        if (oldest !== undefined) byKey.delete(oldest);
      }
      byKey.set(key, verifier);
    }
    return verifier;
  }
  return createXvdHashTreeVerifier({
    rangeReader,
    layout,
    topHashBlockHash: rootBuf,
  });
}

/**
 * Verifies a buffer of L0 hash pages (`[firstL0LogicalPage .. firstL0LogicalPage + logicalPageCount - 1]`)
 * up the full Merkle chain (`L0 -> L1 -> L2 -> L3 -> header.topHashBlockHash`).
 *
 * @param {any} rangeReader
 * @param {any} layout
 * @param {Buffer | Uint8Array} topHashBlockHash
 * @param {number} firstL0LogicalPage
 * @param {Buffer} l0SpanBuf
 * @param {number} logicalPageCount
 * @param {AbortSignal} [signal]
 * @returns {Promise<Buffer[]>}
 */
async function verifyXvdHashTreeChainForL0Pages(
  rangeReader,
  layout,
  topHashBlockHash,
  firstL0LogicalPage,
  l0SpanBuf,
  logicalPageCount,
  signal
) {
  const verifier = getOrCreateHashTreeVerifier(rangeReader, layout, topHashBlockHash);
  return verifier.verifyL0Span(l0SpanBuf, firstL0LogicalPage, logicalPageCount, signal);
}

/**
 * Reads L0 hash tree entries (`hashes` 20B SHA-256 prefixes + `dataUnits` u32LE at `entry[20..24]`)
 * for a contiguous span of 0x1000 file pages (`D8.5`).
 *
 * When a non-zero 32-byte `topHashBlockHash` (or `header.topHashBlockHash`) is supplied via
 * `options`, cryptographically verifies every touched L0 page all the way up
 * `L0 -> L1 -> L2 -> L3 -> header.topHashBlockHash` using the cached per-reader Merkle verifier (`P0-04`).
 *
 * @param {any} rangeReader
 * @param {any} layout Result of computeXvdLayout()
 * @param {number} firstPageByteOffset Byte offset of first 0x1000 page (>= layout.userData.byteOffset)
 * @param {number} pageCount Number of 0x1000 pages
 * @param {AbortSignal | Record<string, any>} [signalOrOptions]
 * @param {{
 *   topHashBlockHash?: Buffer | Uint8Array | null,
 *   header?: { topHashBlockHash?: Buffer | Uint8Array | null } | null,
 *   verifyMerkleChain?: boolean,
 *   requireMerkleRoot?: boolean,
 *   hashTreeVerifier?: ReturnType<typeof createXvdHashTreeVerifier> | null,
 * }} [maybeOptions]
 */
async function readL0EntriesForPages(
  rangeReader,
  layout,
  firstPageByteOffset,
  pageCount,
  signalOrOptions,
  maybeOptions
) {
  /** @type {AbortSignal | undefined} */
  let signal;
  /** @type {Record<string, any>} */
  let opts = {};

  if (
    signalOrOptions &&
    typeof signalOrOptions === 'object' &&
    !('aborted' in signalOrOptions) &&
    maybeOptions === undefined
  ) {
    opts = signalOrOptions;
    signal = opts.signal;
  } else {
    signal = /** @type {AbortSignal | undefined} */ (signalOrOptions);
    opts = maybeOptions && typeof maybeOptions === 'object' ? maybeOptions : {};
  }

  const dataUnits = new Uint32Array(Math.max(0, pageCount));
  /** @type {Array<Buffer | null>} */
  const hashes = [];
  if (pageCount <= 0) {
    return { enabled: false, dataUnits, hashes, merkleVerified: false };
  }

  const firstHashedIdx = Math.floor(
    (firstPageByteOffset - layout.userData.byteOffset) / XVD_PAGE_SIZE
  );
  if (layout.hashTree.pageCount === 0 || firstHashedIdx < 0) {
    for (let i = 0; i < pageCount; i += 1) {
      dataUnits[i] = Math.max(0, firstHashedIdx + i);
    }
    return { enabled: false, dataUnits, hashes, merkleVerified: false };
  }

  const mult = layout.hashTree.resiliencyMultiplier || 1;
  const firstL0LogicalPage = Math.floor(firstHashedIdx / XVD_HASH_ENTRIES_PER_PAGE);
  const lastHashedIdx = firstHashedIdx + pageCount - 1;
  const lastL0LogicalPage = Math.floor(lastHashedIdx / XVD_HASH_ENTRIES_PER_PAGE);
  const logicalL0Count = lastL0LogicalPage - firstL0LogicalPage + 1;

  const l0StartByte = layout.hashTree.level0ByteOffset + firstL0LogicalPage * mult * XVD_PAGE_SIZE;
  const l0SpanPages = logicalL0Count * mult;
  const l0Buf = await rangeReader.readRange(l0StartByte, l0SpanPages * XVD_PAGE_SIZE, signal);

  const rawRootHash = opts.topHashBlockHash || opts.header?.topHashBlockHash || null;
  const rootHashBuf = rawRootHash
    ? Buffer.isBuffer(rawRootHash)
      ? rawRootHash
      : Buffer.from(rawRootHash)
    : null;
  const hasNonZeroRootHash = Boolean(
    rootHashBuf && rootHashBuf.length === XVD_ROOT_HASH_LENGTH && !isAllZeroBuffer(rootHashBuf)
  );

  if (opts.requireMerkleRoot === true && !hasNonZeroRootHash) {
    throw new Error(
      'XVD HashTree root integrity check failed: header.topHashBlockHash is missing or all-zero'
    );
  }

  /** @type {Buffer[] | null} */
  let verifiedL0Pages = null;
  let merkleVerified = false;
  if (hasNonZeroRootHash && opts.verifyMerkleChain !== false && rootHashBuf) {
    const verifier =
      opts.hashTreeVerifier || getOrCreateHashTreeVerifier(rangeReader, layout, rootHashBuf);
    verifiedL0Pages = await verifier.verifyL0Span(l0Buf, firstL0LogicalPage, logicalL0Count, signal);
    merkleVerified = true;
  }

  for (let i = 0; i < pageCount; i += 1) {
    const hashedIdx = firstHashedIdx + i;
    const logicalRelIdx = Math.floor(hashedIdx / XVD_HASH_ENTRIES_PER_PAGE) - firstL0LogicalPage;
    const entryIdx = hashedIdx % XVD_HASH_ENTRIES_PER_PAGE;
    const entryInPageOff = entryIdx * XVD_HASH_ENTRY_SIZE;

    if (verifiedL0Pages) {
      const l0PageBuf = verifiedL0Pages[logicalRelIdx];
      if (l0PageBuf && entryInPageOff + XVD_HASH_ENTRY_SIZE <= l0PageBuf.length) {
        hashes.push(Buffer.from(l0PageBuf.subarray(entryInPageOff, entryInPageOff + XVD_L0_HASH_LENGTH)));
        dataUnits[i] = l0PageBuf.readUInt32LE(entryInPageOff + XVD_L0_HASH_LENGTH);
      } else {
        hashes.push(null);
      }
    } else {
      const l0PageRel = logicalRelIdx * mult;
      const entryByteOff = l0PageRel * XVD_PAGE_SIZE + entryInPageOff;
      if (entryByteOff + XVD_HASH_ENTRY_SIZE <= l0Buf.length) {
        hashes.push(Buffer.from(l0Buf.subarray(entryByteOff, entryByteOff + XVD_L0_HASH_LENGTH)));
        dataUnits[i] = l0Buf.readUInt32LE(entryByteOff + XVD_L0_HASH_LENGTH);
      } else {
        hashes.push(null);
      }
    }
  }
  return { enabled: true, dataUnits, hashes, merkleVerified };
}

/**
 * Validates a contiguous buffer of on-disk `0x1000` XVD pages against L0 SHA-256 hash entries (`D8.5`).
 *
 * @param {Buffer|Uint8Array} rawPagesBuffer
 * @param {Array<Buffer|null>} l0Hashes
 * @param {{ firstPageByteOffset?: number, topHashBlockHash?: Buffer|Uint8Array|null }} [options]
 */
function verifyXvdContiguousPagesL0(rawPagesBuffer, l0Hashes, options = {}) {
  if (!Array.isArray(l0Hashes) || l0Hashes.length === 0) return true;
  const view = Buffer.isBuffer(rawPagesBuffer) ? rawPagesBuffer : Buffer.from(rawPagesBuffer || []);
  const firstOff = Number(options.firstPageByteOffset) || 0;
  const hasRootHash = Boolean(
    options.topHashBlockHash && !isAllZeroBuffer(options.topHashBlockHash)
  );

  for (let i = 0; i < l0Hashes.length; i += 1) {
    const expected = l0Hashes[i];
    const pageStart = i * XVD_PAGE_SIZE;
    if (!expected || expected.length < XVD_L0_HASH_LENGTH) {
      if (hasRootHash) {
        throw new Error(
          `XVD HashTree L0 SHA-256 page integrity check failed at offset 0x${(firstOff + pageStart).toString(16)}: missing L0 hash entry`
        );
      }
      continue;
    }
    // Unpopulated data_unit-only synthetic fixtures have zeroed topHashBlockHash AND zeroed 20B hash slot
    if (!hasRootHash && isAllZeroBuffer(expected)) continue;
    if (pageStart >= view.length) {
      if (hasRootHash) {
        throw new Error(
          `XVD HashTree L0 SHA-256 page integrity check failed at offset 0x${(firstOff + pageStart).toString(16)}: truncated page buffer`
        );
      }
      break;
    }
    const pageSlice = view.subarray(pageStart, Math.min(view.length, pageStart + XVD_PAGE_SIZE));
    verifyXvdL0PageHash(pageSlice, expected, {
      hashByteLength: XVD_L0_HASH_LENGTH,
      throwOnMismatch: true,
      pageOffset: firstOff + pageStart,
    });
  }
  return true;
}

/**
 * Reads L0 hash tree `data_unit` (u32LE at entry[20..24]) values for a contiguous span of file pages.
 *
 * @param {any} rangeReader
 * @param {any} layout Result of computeXvdLayout()
 * @param {number} firstPageByteOffset Byte offset of first 0x1000 page (>= layout.userData.byteOffset)
 * @param {number} pageCount Number of 0x1000 pages
 * @param {AbortSignal} [signal]
 * @param {Record<string, any>} [options]
 * @returns {Promise<Uint32Array>} Array of `data_unit` u32 values (or sequential fallback if integrity disabled)
 */
async function readL0DataUnitsForPages(
  rangeReader,
  layout,
  firstPageByteOffset,
  pageCount,
  signal,
  options
) {
  const { dataUnits } = await readL0EntriesForPages(
    rangeReader,
    layout,
    firstPageByteOffset,
    pageCount,
    signal,
    options
  );
  return dataUnits;
}

module.exports = {
  parseXvdHeader,
  computeHashTreeLayout,
  computeXvdLayout,
  computeXvdL0PageHash,
  computeXvdHashBlockHash,
  verifyXvdL0PageHash,
  createXvdHashTreeVerifier,
  verifyXvdHashTreeChainForL0Pages,
  readL0EntriesForPages,
  verifyXvdContiguousPagesL0,
  readL0DataUnitsForPages,
};
